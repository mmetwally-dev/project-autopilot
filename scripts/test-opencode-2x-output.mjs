#!/usr/bin/env node
// Backlog #4 part B: OpenCode 2.x output reading.
//
// Real 2.2.0 captures live in scripts/test-fixtures/opencode-2x-*:
// - a one-step reply is step_start + text with NO step_finish (usage unknown);
// - a tool run's final step has text but no step_finish (usage is a lower
//   bound), while its earlier tool-calls step does report one;
// - --print-logs has no `message=stream` model line, so the model falls back
//   to the configured one exactly like a 1.x stream that never reported it;
// - provider.no-route / "Model unavailable", "Agent not found" and the free
//   quota text must classify like their 1.x counterparts.
//
// The 1.x assertions at the bottom are the same shapes the existing driver and
// free-quota tests already pin, so this file also proves they did not move.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {adapterDriver, accumulateUsage, runModelPatch} from "./adapter-drivers.mjs";
import {resolveRunModel} from "./model-extract.mjs";
import {classifyObservedFailure} from "./failure-contract.mjs";
import {modelDisplay} from "./watch-report.mjs";
import {rateLimitLineInfo, createIdleWatch, noteIdleStderrText, evaluateIdleWatch} from "./idle-hang-watchdog.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "test-fixtures");
const read = name => fs.readFileSync(path.join(fixtures, name), "utf8");
const driver = adapterDriver("opencode");
const MODEL = "opencode/deepseek-v4.1-flash-free";
const probe = {readPath: "", productionWritePath: "", outsideWritePath: ""};

function eventsFrom(stdout, stderr = "") {
  return driver.decodeEvents(stdout, stderr);
}
function classify(events, exitCode = 1, stderr = "") {
  return classifyObservedFailure({
    exitCode,
    stdout: "",
    stderr,
    startError: null,
    timedOut: false,
    driverless: false,
    evidence: driver.observe(events, probe),
  });
}

// ── 1. 2.x one-step reply: text, no step_finish => partial, no invented tokens ──
{
  const events = eventsFrom(read("opencode-2x-run-json-standalone.ndjson"));
  const usage = accumulateUsage("opencode", events, {generation: "2"});
  assert.ok(usage, "a 2.x text reply must be marked partial, not omitted");
  assert.equal(usage.usage_partial, true, "2.x final step without step_finish is partial");
  assert.equal(usage.input, undefined, "no step_finish means no invented input tokens");
  assert.equal(usage.output, undefined, "no step_finish means no invented output tokens");
  assert.equal(usage.turns, undefined, "no step_finish means no invented turn count");
  console.log("PASS: 2.x text-only reply records usage_partial without token numbers");
}

// ── 2. 2.x tool run: sum the one real step_finish, flag the unmeasured last step ──
{
  const stdout = read("opencode-2x-run-tools.ndjson");
  const stderr = read("opencode-2x-run-tools.stderr.txt");
  const events = eventsFrom(stdout, stderr);
  const usage = accumulateUsage("opencode", events, {generation: "2"});
  assert.equal(usage?.turns, 1, "only the step_finish-bearing step is a measured turn");
  assert.equal(usage?.input, 115);
  assert.equal(usage?.output, 77);
  assert.equal(usage?.cacheRead, 7680);
  assert.equal(usage?.cacheCreation, 0);
  assert.equal(usage?.maxSingleTurnContext, 7795);
  assert.equal(usage?.usage_partial, true, "the final text step has no step_finish");
  assert.equal(usage?.priceWeighted, 1268);
  console.log("PASS: 2.x tool run sums every step_finish and flags partial usage");
}

// ── 3. Model confirmation: no message=stream on 2.x => configured fallback ──
{
  const stdout = read("opencode-2x-run-tools.ndjson");
  const stderr = read("opencode-2x-run-tools.stderr.txt");
  assert.doesNotMatch(stderr, /\bmessage=stream\b/, "2.x --print-logs has no model stream line");
  const events = eventsFrom(stdout, stderr);
  const patch = runModelPatch("opencode", events, MODEL);
  assert.deepEqual(patch, {configuredModel: MODEL, resolvedModel: null, modelMismatch: null});
  assert.deepEqual(resolveRunModel("opencode", events, MODEL), {resolvedModel: null, modelMismatch: null});
  assert.equal(
    modelDisplay({model: MODEL, configuredModel: MODEL, resolvedModel: null, modelMismatch: null}),
    "deepseek-v4.1-flash-free",
    "without an observed model the run keeps the configured model"
  );
  console.log("PASS: 2.x model falls back to configured with no mismatch");
}

// ── 4. 2.x stdout error events classify like the 1.x equivalents ──
{
  const badModel = eventsFrom(read("opencode-2x-run-bad-model.ndjson"));
  const badModelObs = driver.observe(badModel, probe);
  const providerHit = badModelObs.find(o => o.type === "provider_error");
  assert.equal(providerHit?.reason, "opencode_model_unavailable", JSON.stringify(badModelObs));
  const providerFailure = classify(badModel);
  assert.equal(providerFailure?.class, "PROVIDER_ERROR");
  assert.equal(providerFailure?.domain, "infrastructure");
  assert.equal(providerFailure?.retryable, true);
  assert.match(read("opencode-2x-run-bad-model.stderr.txt"), /ModelUnavailableError: Model unavailable/);
  console.log("PASS: 2.x provider.no-route / Model unavailable => PROVIDER_ERROR");

  const agentMissing = eventsFrom(read("opencode-2x-run-agent-without-standalone.ndjson"));
  const agentObs = driver.observe(agentMissing, probe);
  assert.ok(agentObs.some(o => o.type === "agent_not_found"), JSON.stringify(agentObs));
  const agentFailure = classify(agentMissing);
  assert.equal(agentFailure?.class, "INVOCATION_MISMATCH", JSON.stringify(agentFailure));
  assert.equal(agentFailure?.domain, "adapter");
  assert.equal(agentFailure?.retryable, false);
  assert.notEqual(agentFailure?.class, "IDLE_HANG", "agent-not-found must never become an idle hang");
  assert.match(JSON.stringify(agentFailure?.evidence), /Agent not found/);
  console.log("PASS: 2.x Agent not found => explicit INVOCATION_MISMATCH, not IDLE_HANG");
}

// ── 5. Free quota: 2.x stdout error event and 2.x stderr ERROR line ──
const QUOTA_TEXT = "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go";
{
  const quotaEvent = {type: "error", timestamp: 1793190617819, sessionID: "ses_2xquota", error: {type: "unknown", message: QUOTA_TEXT}};
  const obs = driver.observe([quotaEvent], probe);
  const hit = obs.find(o => o.type === "rate_limited");
  assert.equal(hit?.reason, "free_quota_exhausted", JSON.stringify(obs));
  assert.equal(classify([quotaEvent])?.class, "RATE_LIMITED");

  const stderr2x = `timestamp=2026-10-28T12:30:17.817Z level=ERROR run=8759b735 message="stream error" error.error="${QUOTA_TEXT}" role=server sessionID=ses_2xquota`;
  const stderrObs = driver.observe(eventsFrom("", stderr2x), probe);
  assert.equal(stderrObs.find(o => o.type === "rate_limited")?.reason, "free_quota_exhausted", JSON.stringify(stderrObs));
  assert.equal(classify(eventsFrom("", stderr2x), 1, stderr2x)?.class, "RATE_LIMITED");
  const info = rateLimitLineInfo(stderr2x);
  assert.equal(info?.reason, "free_quota_exhausted", JSON.stringify(info));

  const watch = createIdleWatch({idleHangMs: 10 * 60_000, pid: process.pid, adapter: "opencode", now: 0, startedAtMs: 0});
  noteIdleStderrText(watch, stderr2x, 1_000);
  assert.equal(evaluateIdleWatch(watch, {now: 62_000}).status, "rate_limited");
  console.log("PASS: 2.x free-quota text is RATE_LIMITED on stdout error and stderr ERROR");
}

// ── 6. Quota detection still trusts only engine channels, never prose/tool text ──
{
  const prose = `The provider said: ${QUOTA_TEXT}`;
  const proseEvents = [
    {type: "text", part: {type: "text", text: prose}},
    {type: "tool_use", part: {type: "tool", tool: "bash", state: {status: "completed", input: {}, output: prose}}},
  ];
  assert.ok(!driver.observe(proseEvents, probe).some(o => o.type === "rate_limited"));
  assert.notEqual(classify(proseEvents)?.class, "RATE_LIMITED");
  assert.equal(rateLimitLineInfo(JSON.stringify({type: "text", part: {type: "text", text: prose}})), null);
  console.log("PASS: model prose/tool text is never treated as quota");
}

// ── 7. 1.x behaviour is unchanged (same shapes as the existing tests) ──
{
  const stepFinish = tokens => ({type: "step_finish", part: {type: "step-finish", tokens}});
  const oneXEvents = [
    {type: "step_start", part: {type: "step-start"}},
    {type: "text", part: {type: "text", text: "working"}},
    stepFinish({input: 100, output: 20, reasoning: 5, cache: {read: 10, write: 0}}),
    {type: "text", part: {type: "text", text: "done"}},
    stepFinish({input: 50, output: 8, reasoning: 0, cache: {read: 0, write: 200}}),
  ];
  const plain = accumulateUsage("opencode", oneXEvents);
  assert.equal(plain?.turns, 2);
  assert.equal(plain?.input, 150);
  assert.equal(plain?.output, 33);
  assert.equal(plain?.cacheRead, 10);
  assert.equal(plain?.cacheCreation, 200);
  assert.equal(plain?.maxSingleTurnContext, 250);
  assert.equal(plain?.usage_partial, undefined, "1.x must not gain a partial flag");
  assert.deepEqual(accumulateUsage("opencode", oneXEvents, {generation: "1"}), plain);

  const oneXNoFinish = [{type: "step_start", part: {type: "step-start"}}, {type: "text", part: {type: "text", text: "no step_finish here"}}];
  assert.equal(accumulateUsage("opencode", oneXNoFinish), null);
  assert.equal(accumulateUsage("opencode", oneXNoFinish, {generation: "1"}), null);

  const oneXQuota = `timestamp=2026-10-28T00:00:50.996Z level=ERROR run=65c65963 message="stream error" providerID=opencode modelID=deepseek-v4.1-flash-free session.id=ses_1 small=false agent=build mode=primary error.error="AI_APICallError: ${QUOTA_TEXT}"`;
  assert.equal(driver.observe(eventsFrom("", oneXQuota), probe).find(o => o.type === "rate_limited")?.reason, "free_quota_exhausted");
  assert.equal(rateLimitLineInfo(oneXQuota)?.reason, "free_quota_exhausted");
  const oneXNoSource = `level=ERROR message="stream error" providerID=opencode modelID=free error.error="${QUOTA_TEXT}"`;
  assert.equal(rateLimitLineInfo(oneXNoSource), null, "1.x no-source line stays a non-hit");
  assert.ok(!driver.observe(eventsFrom("", oneXNoSource), probe).some(o => o.type === "rate_limited"));
  console.log("PASS: 1.x usage/model/quota results are byte-for-byte unchanged");
}

console.log("OpenCode 2.x output tests passed");
