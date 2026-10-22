#!/usr/bin/env node
// Task 1.3: the agy driver's dispatch wiring, verified offline by replaying
// scripted fake-agy stream-json fixtures through the registered driver
// (decodeEvents -> observe -> accumulateUsage) plus the manifest declaration,
// the per-run allow-rule path, and the per-task turn counting. No real agy is
// spawned.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {adapterDriver, AGY_SETTINGS_RELATIVE_PATH, accumulateUsage} from "./adapter-drivers.mjs";
import {decodeAgyEvents, observeAgyEvents} from "./agy-events.mjs";
import {countTurns, supportsTurnCount, evaluateTaskBudget} from "./per-task-budget.mjs";
import {classifyObservedFailure} from "./failure-contract.mjs";

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
const agentResponse = (cid, index, usage, state = "DONE") => JSON.stringify({
  event: "step_update",
  step_update: {conversation_id: cid, step_index: index, state, step_type: "agent_response", text_delta: "done\n", duration_seconds: 1.1, usage}
});
const toolStep = (cid, index, state, tool_name, tool_info) => JSON.stringify({
  event: "step_update",
  step_update: {conversation_id: cid, step_index: index, state, step_type: "tool", tool_name, tool_info}
});
const resultLine = (cid, result) => JSON.stringify({event: "result", result: {conversation_id: cid, ...result}});

const USAGE_A = {input_tokens: 1000, output_tokens: 50, thinking_tokens: 10, cache_read_tokens: 200, total_tokens: 1260};
const USAGE_B = {input_tokens: 500, output_tokens: 20, thinking_tokens: 0, cache_read_tokens: 100, total_tokens: 620};

const normalStdout = [
  initLine,
  userInput(CID),
  agentResponse(CID, 1, USAGE_A),
  toolStep(CID, 2, "DONE", "run_command", {name: "run_command", parameters: {CommandLine: "ls -la"}, output: "ok"}),
  resultLine(CID, {status: "SUCCESS", response: "ok\n", duration_seconds: 3, num_turns: 1, usage: {input_tokens: 1500, output_tokens: 70, thinking_tokens: 10, cache_read_tokens: 300, total_tokens: 1880}})
].join("\n");

// ── 1. Driver dispatch is the task-1.2 helpers ──────────────────────────────
const driver = adapterDriver("antigravity");
assert.ok(driver, 'adapterDriver("antigravity") must resolve to a driver');
assert.equal(driver.contractVersion, 2, "agy driver must be contract version 2");
assert.equal(driver.decodeEvents, decodeAgyEvents, "driver.decodeEvents must be decodeAgyEvents");
assert.equal(driver.observe, observeAgyEvents, "driver.observe must be observeAgyEvents");
assert.equal(driver.structuredTransport, "event-stream", "agy transport must be event-stream NDJSON, not a sentinel scan");

// The manifest declaration must agree with the driver so admission billing and
// the transport monotonicity gate see one contract.
const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "adapters", "agents.json"), "utf8")).adapters;
assert.equal(
  manifest.antigravity.declared_capabilities["output.structuredTransport"],
  "event-stream",
  `adapters/agents.json antigravity must declare event-stream transport, got: ${manifest.antigravity.declared_capabilities["output.structuredTransport"]}`
);

// ── 2. Full dispatch: decode -> observe -> accumulateUsage ──────────────────
const events = driver.decodeEvents(normalStdout, "");
const usage = accumulateUsage("antigravity", events);
assert.ok(usage && typeof usage === "object", `agy usage must be an object, got: ${JSON.stringify(usage)}`);
assert.equal(usage.input, 1500, `terminal result usage is authoritative (cumulative), got: ${usage.input}`);
assert.equal(usage.output, 80, "thinking_tokens fold into output");
assert.equal(usage.cacheRead, 300, "cache read tokens from the terminal result");
assert.equal(usage.turns, 1, "turns come from the terminal result's num_turns");

// A write role's successful command/write tools must be observed, never dropped.
const observations = driver.observe(events, {readPath: "", productionWritePath: "", outsideWritePath: ""});
const types = new Set(observations.map(o => o.type));
assert.ok(types.has("command_attempted"), `a successful run_command must be observed, got: ${[...types].join(",")}`);

// ── 3. A write role with denied commands fails clearly ─────────────────────
const deniedStdout = [
  initLine,
  userInput(CID),
  agentResponse(CID, 1, USAGE_B),
  toolStep(CID, 2, "ERROR", "run_command", {
    name: "run_command",
    parameters: {CommandLine: "rm -rf /"},
    error: {type: "DENIED", message: "Permission denied: 1 tool call was denied (denied_actions: [command(rm -rf)])"}
  }),
  resultLine(CID, {
    status: "ERROR",
    response: "",
    error: "Permission denied: 1 tool call was denied (denied_actions: [command(rm -rf)])",
    denied_actions: ["command(rm -rf)"],
    duration_seconds: 2,
    num_turns: 1,
    usage: {input_tokens: 10, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 10}
  })
].join("\n");
const deniedEvents = driver.decodeEvents(deniedStdout, "");
const deniedObservations = driver.observe(deniedEvents, {readPath: "", productionWritePath: "", outsideWritePath: ""});
assert.ok(
  deniedObservations.some(o => o.type === "permission_denied"),
  `a denied run_command must surface as permission_denied, got: ${deniedObservations.map(o => o.type).join(",")}`
);
const classified = classifyObservedFailure({evidence: deniedObservations, exitCode: 0});
assert.equal(classified?.class, "PERMISSION_DENIED", `a denied agy command must classify as PERMISSION_DENIED, got: ${classified?.class}`);

// ── 4. Streams with no agy usage accumulate to null, never zeros ─────────────
// This is the pin scripts/test-opencode-driver.mjs:486-489 relies on: an
// absent agy usage measurement must never read as a free invocation.
const opencodeUsageEvents = [
  {type: "step_start"},
  {type: "text", part: {type: "text", text: "hello"}},
  {type: "step_finish", part: {type: "step-finish", tokens: {input: 10, output: 20, reasoning: 0, cache: {read: 0, write: 0}}}},
  {type: "result", subtype: "success", is_error: false, result: "done", num_turns: 1,
    usage: {input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0}}
];
assert.equal(accumulateUsage("antigravity", opencodeUsageEvents), null, "a non-agy stream must accumulate to null, never zeros");
assert.equal(accumulateUsage("antigravity", []), null, "an empty stream must accumulate to null, never zeros");
assert.equal(
  accumulateUsage("antigravity", driver.decodeEvents([initLine, userInput(CID)].join("\n"), "")),
  null,
  "a stream with no usage events must accumulate to null, never zeros"
);
assert.equal(accumulateUsage("codex", opencodeUsageEvents), null, "codex must still accumulate to null");

// ── 5. Per-task turn counting for antigravity ──────────────────────────────
assert.equal(supportsTurnCount("antigravity"), true, "agy agent_response steps make the turn cap enforceable");
assert.equal(supportsTurnCount("codex"), false, "codex must still have no per-turn event");

const streamingStdout = [
  initLine,
  userInput(CID),
  JSON.stringify({event: "step_update", step_update: {conversation_id: CID, step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "hel"}}),
  JSON.stringify({event: "step_update", step_update: {conversation_id: CID, step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "lo"}}),
  JSON.stringify({event: "step_update", step_update: {conversation_id: CID, step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "", usage: USAGE_A}}),
  agentResponse(CID, 2, USAGE_B)
].join("\n");
assert.equal(
  countTurns("antigravity", driver.decodeEvents(streamingStdout, "")),
  2,
  "one turn per distinct agent_response step_index (ACTIVE fragments must not each count)"
);
assert.equal(
  countTurns("antigravity", driver.decodeEvents(normalStdout, "")),
  1,
  "the terminal result's num_turns is authoritative when present"
);
assert.equal(
  countTurns("antigravity", driver.decodeEvents([initLine, userInput(CID)].join("\n"), "")),
  null,
  "an agy stream with no turn signal must count as null, never 0"
);
assert.equal(countTurns("codex", driver.decodeEvents(normalStdout, "")), null, "codex must still count turns as null");
assert.equal(
  evaluateTaskBudget({adapterId: "antigravity", turns: 41, maxTurns: 40}).exceeded,
  true,
  "the per-task turn cap must be enforceable for agy"
);

// ── 6. Per-run settings file, never a global one ────────────────────────────
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-wire-"));
const homeBackup = process.env.HOME;
try {
  const scratchDir = path.join(scratchRoot, "run-1");
  fs.mkdirSync(scratchDir, {recursive: true});
  const invocation = driver.buildInvocation({binary: "agy", mode: "write", model: "m", reasoning: "high", scratchDir, allowRules: ["command(git)"]});
  const joined = invocation.args.join(" ");
  assert.ok(!invocation.args.includes("--dangerously-skip-permissions"), "agy must never auto-approve permissions");
  assert.ok(!joined.includes("--dangerously-skip-permissions"), "agy must never auto-approve permissions");
  assert.equal(typeof invocation.settingsPath, "string", "a write run must carry a per-run settings path");
  const expected = path.join(scratchDir, AGY_SETTINGS_RELATIVE_PATH);
  assert.equal(invocation.settingsPath, expected, `the settings file must live in the run's own scratch dir, got: ${invocation.settingsPath}`);
  assert.ok(
    !invocation.settingsPath.startsWith(os.homedir()),
    `the operator's real HOME must never be written, got: ${invocation.settingsPath}`
  );
  const settings = JSON.parse(fs.readFileSync(invocation.settingsPath, "utf8"));
  assert.ok(
    Array.isArray(settings.permissions?.allow) && settings.permissions.allow.length > 0,
    `the per-run settings file must carry a permissions allow list, got: ${JSON.stringify(settings)}`
  );
  assert.ok(
    settings.permissions.allow.some(rule => String(rule).startsWith("command(")),
    `a write run's allow list must include its command grants, got: ${JSON.stringify(settings.permissions.allow)}`
  );

  const scratchInvocation = driver.buildInvocation({binary: "agy", mode: "scratch", scratchDir});
  assert.equal(scratchInvocation.settingsPath, path.join(scratchDir, AGY_SETTINGS_RELATIVE_PATH), "scratch runs get the per-run settings file too");
  const readOnlyInvocation = driver.buildInvocation({binary: "agy", mode: "read_only"});
  assert.equal(readOnlyInvocation.settingsPath, null, "read_only (plan) needs no permission grant and no settings file");
  const noScratchInvocation = driver.buildInvocation({binary: "agy", mode: "write"});
  assert.equal(noScratchInvocation.settingsPath, null, "no scratch dir means no settings file, never a global write");

  // A write role's allow-rule-only run must still surface a denied write.
  const deniedWriteStdout = [
    initLine,
    toolStep(CID, 1, "ERROR", "write_to_file", {
      name: "write_to_file",
      parameters: {TargetFile: "/repo/README.md"},
      error: {type: "DENIED", message: "permission denied by policy"}
    }),
    resultLine(CID, {status: "ERROR", response: "", error: "permission denied by policy", denied_actions: ["write_file(/repo/README.md)"], num_turns: 1, usage: USAGE_A})
  ].join("\n");
  const writeObservations = driver.observe(driver.decodeEvents(deniedWriteStdout, ""), {readPath: "", productionWritePath: "/repo/README.md", outsideWritePath: ""});
  const writeTypes = new Set(writeObservations.map(o => o.type));
  assert.ok(writeTypes.has("write_attempted"), "an attempted write must be observed");
  assert.ok(writeTypes.has("write_blocked") || writeTypes.has("permission_denied"), `a denied write must be blocked/denied, got: ${[...writeTypes].join(",")}`);
} finally {
  if (homeBackup == null) delete process.env.HOME; else process.env.HOME = homeBackup;
  fs.rmSync(scratchRoot, {recursive: true, force: true});
}

console.log("test-agy-wire: ALL CHECKS PASSED");
