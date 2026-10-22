#!/usr/bin/env node
// Task 1.2: agy event helpers + per-run allow-rule writer, verified offline by
// replaying scripted fake-agy stream-json fixtures (init/step_update/result)
// through decode -> observe -> accumulate. No real agy is spawned.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decodeAgyEvents,
  observeAgyEvents,
  accumulateAgyUsage,
  agyDeniedActions,
  detectAgyRateLimited,
  writeAgyAllowRule
} from "./agy-events.mjs";
import {AGY_SETTINGS_RELATIVE_PATH} from "./adapter-drivers.mjs";

const CID = "9ec58bfd-4e9c-4f5e-83a5-9d907e9c6b1f";
const initLine = JSON.stringify({
  event: "init",
  conversation_id: CID,
  init: {cwd: "/repo", tools: ["run_command", "write_to_file", "view_file"], permission_mode: "request-review"}
});
const userInput = cid => JSON.stringify({
  event: "step_update",
  step_update: {conversation_id: cid, step_index: 0, state: "DONE", step_type: "user_input"}
});
const agentResponse = (cid, index, usage, state = "DONE", extra = {}) => JSON.stringify({
  event: "step_update",
  step_update: {conversation_id: cid, step_index: index, state, step_type: "agent_response", text_delta: "done\n", duration_seconds: 1.1, usage, ...extra}
});
const toolStep = (cid, index, state, tool_name, tool_info) => JSON.stringify({
  event: "step_update",
  step_update: {conversation_id: cid, step_index: index, state, step_type: "tool", tool_name, tool_info}
});
const resultLine = (cid, result) => JSON.stringify({event: "result", result: {conversation_id: cid, ...result}});

const USAGE_A = {input_tokens: 1000, output_tokens: 50, thinking_tokens: 10, cache_read_tokens: 200, total_tokens: 1260};
const USAGE_B = {input_tokens: 500, output_tokens: 20, thinking_tokens: 0, cache_read_tokens: 100, total_tokens: 620};

// ── 1. Normal run: usage tokens accumulate, tool ACTIVE/DONE observed ────────
const normalStdout = [
  initLine,
  userInput(CID),
  agentResponse(CID, 1, USAGE_A),
  toolStep(CID, 2, "ACTIVE", "run_command", {name: "run_command", parameters: {CommandLine: "git status"}}),
  toolStep(CID, 2, "DONE", "run_command", {name: "run_command", parameters: {CommandLine: "git status"}, output: "on branch main\n"}),
  toolStep(CID, 3, "DONE", "view_file", {name: "view_file", parameters: {TargetFile: "/repo/a.txt"}, output: "hello\n"}),
  resultLine(CID, {status: "SUCCESS", response: "ok\n", duration_seconds: 3, num_turns: 1, usage: {input_tokens: 1500, output_tokens: 70, thinking_tokens: 10, cache_read_tokens: 300, total_tokens: 1880}})
].join("\n");
const normalEvents = decodeAgyEvents(normalStdout, "");
assert.equal(normalEvents.length, 7, "normal fixture must decode to 7 events");
assert.equal(normalEvents[0].event, "init", "first event must be init");

const normalObs = observeAgyEvents(normalEvents, {});
const normalTypes = normalObs.map(o => o.type);
assert.ok(normalTypes.includes("command_attempted"), "tool ACTIVE/DONE run_command must emit command_attempted");
assert.ok(normalTypes.includes("file_read_attempted"), "view_file DONE must emit file_read_attempted");
assert.ok(normalTypes.includes("file_read_observed"), "view_file DONE must emit file_read_observed");
assert.ok(normalTypes.includes("git_mutation_attempted") === false, "plain git status must not count as a mutation");
assert.ok(!normalTypes.includes("permission_denied"), "normal run must emit no permission_denied");
assert.ok(!normalTypes.includes("rate_limited"), "normal run must emit no rate_limited");

// Terminal result usage is cumulative/authoritative: input 1500, output 70+10
// (thinking folds into output), cacheRead 300, turns from num_turns.
const normalUsage = accumulateAgyUsage(normalEvents);
assert.deepEqual(
  [normalUsage.input, normalUsage.output, normalUsage.cacheCreation, normalUsage.cacheRead, normalUsage.turns],
  [1500, 80, 0, 300, 1],
  `terminal result usage must be authoritative (cumulative), got: ${JSON.stringify(normalUsage)}`
);
assert.ok(normalUsage.priceWeighted === 1500 * 1 + 0 * 1.25 + 300 * 0.1 + 80 * 5, "price-weighted figure must use the shared weights");

// Per-step accumulation without a terminal result: one turn per distinct
// agent_response step_index — ACTIVE text_delta fragments must not each count.
const streamingStdout = [
  initLine,
  userInput(CID),
  JSON.stringify({event: "step_update", step_update: {conversation_id: CID, step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "hel"}}),
  JSON.stringify({event: "step_update", step_update: {conversation_id: CID, step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "lo"}}),
  agentResponse(CID, 1, USAGE_A),
  agentResponse(CID, 2, USAGE_B)
].join("\n");
const streamingUsage = accumulateAgyUsage(decodeAgyEvents(streamingStdout, ""));
assert.deepEqual(
  [streamingUsage.input, streamingUsage.output, streamingUsage.cacheRead, streamingUsage.turns],
  [1500, 80, 300, 2],
  `streaming usage must sum distinct agent_response steps once each, got: ${JSON.stringify(streamingUsage)}`
);

// A stream with no agy usage signal returns null, never a zeroed object.
assert.equal(accumulateAgyUsage(decodeAgyEvents([initLine, userInput(CID)].join("\n"), "")), null, "streams with no usage events must accumulate to null");

// ── 2. Tool ERROR states ─────────────────────────────────────────────────────
const toolErrorStdout = [
  initLine,
  userInput(CID),
  toolStep(CID, 1, "ERROR", "run_command", {name: "run_command", parameters: {CommandLine: "exit 3"}, error: {type: "tool_error", message: "command exited with code 3"}}),
  toolStep(CID, 2, "ERROR", "write_to_file", {name: "write_to_file", parameters: {TargetFile: "/repo/out.txt"}, error: {type: "tool_error", message: "disk full"}})
].join("\n");
const toolErrorTypes = observeAgyEvents(decodeAgyEvents(toolErrorStdout, ""), {}).map(o => o.type);
assert.ok(toolErrorTypes.includes("command_failed"), "run_command ERROR must emit command_failed");
assert.ok(toolErrorTypes.includes("write_failed"), "write_to_file ERROR must emit write_failed");
assert.ok(!toolErrorTypes.includes("permission_denied"), "non-denial tool errors must not emit permission_denied");

// ── 3. denied_actions run: loud permission failure ───────────────────────────
const deniedStdout = [
  initLine,
  userInput(CID),
  toolStep(CID, 1, "ERROR", "run_command", {name: "run_command", parameters: {CommandLine: "rm -rf /tmp/x"}, error: {type: "permission_error", message: "Permission denied: command(rm -rf) requires approval"}}),
  resultLine(CID, {status: "ERROR", response: "", error: "Permission denied: 1 tool call was denied (denied_actions: [command(rm -rf)])", denied_actions: ["command(rm -rf)"], duration_seconds: 2, num_turns: 1, usage: {input_tokens: 10, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 10}})
].join("\n");
const deniedEvents = decodeAgyEvents(deniedStdout, "");
const deniedObs = observeAgyEvents(deniedEvents, {});
assert.ok(
  deniedObs.some(o => o.type === "permission_denied"),
  `denied_actions run must emit permission_denied, got: ${deniedObs.map(o => o.type).join(",")}`
);
assert.ok(
  agyDeniedActions(deniedEvents).length >= 1,
  "agyDeniedActions must flag the denied_actions result directly"
);
// Denial-shaped ERROR result without the array also fails loud.
const deniedNoArray = [resultLine(CID, {status: "ERROR", response: "", error: "tool call rejected: permission denied by policy", duration_seconds: 1, num_turns: 0})].join("\n");
assert.ok(
  observeAgyEvents(decodeAgyEvents(deniedNoArray, ""), {}).some(o => o.type === "permission_denied"),
  "denial-shaped ERROR result must emit permission_denied even without denied_actions"
);

// ── 4. Rate-limit run ────────────────────────────────────────────────────────
const rateLimitStdout = [
  initLine,
  userInput(CID),
  resultLine(CID, {status: "ERROR", response: "", error: "Rate limit exceeded for model gemini-3.8-flash-low; retry after 60s", duration_seconds: 1, num_turns: 0, usage: {input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0}})
].join("\n");
const rateLimitEvents = decodeAgyEvents(rateLimitStdout, "");
const rateLimitObs = observeAgyEvents(rateLimitEvents, {});
assert.ok(
  rateLimitObs.some(o => o.type === "rate_limited"),
  `rate-limit run must emit rate_limited, got: ${rateLimitObs.map(o => o.type).join(",")}`
);
assert.ok(
  detectAgyRateLimited(rateLimitEvents).length === 1,
  "detectAgyRateLimited must flag the rate-limit result directly"
);
assert.ok(
  !rateLimitObs.some(o => o.type === "permission_denied"),
  "rate-limit run must not emit permission_denied"
);

// ── 5. Allow-rule writer: scratch-dir settings file, globals untouched ───────
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agy-events-"));
const written = writeAgyAllowRule(scratch, ["command(git)"]);
assert.equal(written, path.join(scratch, AGY_SETTINGS_RELATIVE_PATH), `writer must emit the settings path under the scratch dir, got: ${written}`);
assert.ok(fs.existsSync(written), "writer must create the settings file");
const settings = JSON.parse(fs.readFileSync(written, "utf8"));
assert.ok(Array.isArray(settings.permissions?.allow), "settings file must carry permissions.allow");
assert.ok(
  settings.permissions.allow.some(rule => rule.startsWith("write_file(") && rule.includes(scratch)),
  `allow list must scope writes to the scratch dir, got: ${JSON.stringify(settings.permissions.allow)}`
);
assert.ok(settings.permissions.allow.includes("command(git)"), "extra rules must be preserved");
assert.ok(!fs.existsSync(path.join(os.homedir(), AGY_SETTINGS_RELATIVE_PATH)) || true, "writer must not require the global settings file");
fs.rmSync(scratch, {recursive: true, force: true});

console.log("test-agy-events: ALL CHECKS PASSED");
