#!/usr/bin/env node
// Replays the real 2026-10-13 opencode rate-limit lines.
// Incident A root cause: the implementer's log base was the (private,
// empty) bound session store, but an unsandboxed adapter logs to the real
// HOME ~/.local/share/opencode, so the tail found no file and never fired.
// Incident B: a structured stdout error event (statusCode 429 / "Endpoint is
// unavailable") was not classified as RATE_LIMITED.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createIdleWatch, evaluateIdleWatch, noteIdleSessionId, noteIdleOutput, extractSessionIdFromChunk, rateLimitLineInfo} from "./idle-hang-watchdog.mjs";
import {adapterDriver} from "./adapter-drivers.mjs";
import {classifyObservedFailure} from "./failure-contract.mjs";

const SID = "ses_ecce1dd83ffe9oCPNL94jwGvFL";
const TS = "2026-10-13T02:52:36.935Z";
const L = {
  funds: `timestamp=2026-10-13T02:36:18.749Z level=ERROR run=5e736505 message="stream error" providerID=opencode modelID=gpt-5.4-nano session.id=${SID} small=true agent=title mode=primary error.error="AI_APICallError: Upstream request failed: Insufficient account funds"`,
  endpoint: `timestamp=2026-10-13T02:36:32.832Z level=ERROR run=5e736505 message="stream error" providerID=opencode modelID=step-5-preview-free session.id=${SID} small=false agent=build mode=primary error.error="AI_APICallError: Upstream request failed: Endpoint is unavailable."`,
  rate: `timestamp=${TS} level=ERROR run=5e736505 message="stream error" providerID=opencode modelID=step-5-preview-free session.id=${SID} small=false agent=build mode=primary error.error="AI_APICallError: Rate limit exceeded. Please try again later."`,
  foreign: `timestamp=2026-10-13T02:52:40.000Z level=ERROR run=1a159370 message="stream error" providerID=opencode modelID=step-5-preview-free session.id=ses_ece01b290ffezZEWiI1LBltSS6 small=false agent=build mode=primary error.error="AI_APICallError: Rate limit exceeded. Please try again later."`,
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-real-"));
let n = 0;
function setup({logPrivate = true, history = "x\n"} = {}) {
  const dir = path.join(tmp, String(n++));
  const priv = path.join(dir, "store");          // empty bound session store
  const home = path.join(dir, "home", ".local", "share", "opencode");
  fs.mkdirSync(priv, {recursive: true});
  fs.mkdirSync(path.join(home, "log"), {recursive: true});
  const log = path.join(home, "log", "opencode.log");
  fs.writeFileSync(log, history);
  const startedAtMs = Date.parse("2026-10-13T02:36:00Z");
  const watch = createIdleWatch({idleHangMs: 600_000, pid: null, adapter: "opencode", opencodeLogBase: priv, opencodeLogFallbackBase: home, logPrivate, now: startedAtMs, startedAtMs});
  return {watch, log, startedAtMs};
}
const t0 = Date.parse(TS);

// A1: pre-fix shape (no fallback) never sees the line: proves the cause.
{
  const {log, startedAtMs} = setup();
  const priv = path.join(path.dirname(path.dirname(path.dirname(log))), "..", "store");
  const old = createIdleWatch({idleHangMs: 600_000, adapter: "opencode", opencodeLogBase: path.resolve(priv), logPrivate: true, now: startedAtMs, startedAtMs});
  noteIdleSessionId(old, SID);
  fs.appendFileSync(log, L.rate + "\n");
  assert.equal(evaluateIdleWatch(old, {now: t0}).status, "ok");
  assert.equal(evaluateIdleWatch(old, {now: t0 + 120_000}).status, "ok");
  console.log("PASS A1 private-only base (old wiring) never detects");
}
// A2: with the real-HOME fallback, one hit fires after 60 s of silence.
{
  const {watch, log} = setup();
  assert.equal(extractSessionIdFromChunk(`{"type":"step_start","sessionID":"${SID}"}`), SID);
  noteIdleSessionId(watch, SID);
  fs.appendFileSync(log, L.rate + "\n");
  assert.equal(evaluateIdleWatch(watch, {now: t0}).status, "ok");
  assert.equal(evaluateIdleWatch(watch, {now: t0 + 30_000}).status, "ok");
  const v = evaluateIdleWatch(watch, {now: t0 + 61_000});
  assert.equal(v.status, "rate_limited");
  assert.equal(v.provider, "opencode");
  assert.equal(v.model, "step-5-preview-free");
  console.log("PASS A2 single rate-limit line, own session, fires after 60 s");
}
// A3: Endpoint-unavailable / insufficient-funds only.
// Backlog #107: the "funds" line is the small title model (small=true
// agent=title); its failure says nothing about the role's model, so it is
// ignored (asserted in the loop below as "ok").
for (const [name, line, expected] of [["endpoint", L.endpoint, "rate_limited"], ["funds (title model, ignored)", L.funds, "ok"]]) {
  const {watch, log} = setup();
  noteIdleSessionId(watch, SID);
  const lineNow = line.replace(/timestamp=\S+/, `timestamp=${TS}`);
  fs.appendFileSync(log, lineNow + "\n");
  evaluateIdleWatch(watch, {now: t0});
  assert.equal(evaluateIdleWatch(watch, {now: t0 + 61_000}).status, expected);
  console.log(`PASS A3 ${name} => ${expected}`);
}
// A4: foreign session ignored; unattributed ignored on shared log.
{
  const {watch, log} = setup();
  noteIdleSessionId(watch, SID);
  fs.appendFileSync(log, L.foreign + "\n" + L.rate.replace(` session.id=${SID}`, "") + "\n");
  evaluateIdleWatch(watch, {now: t0});
  assert.equal(evaluateIdleWatch(watch, {now: t0 + 120_000}).status, "ok");
  console.log("PASS A4 foreign/unattributed lines on shared log do not fire");
}
// A5: output after a single hit clears it.
{
  const {watch, log} = setup();
  noteIdleSessionId(watch, SID);
  fs.appendFileSync(log, L.rate + "\n");
  evaluateIdleWatch(watch, {now: t0});
  noteIdleOutput(watch, t0 + 20_000);
  assert.equal(evaluateIdleWatch(watch, {now: t0 + 90_000}).status, "ok");
  console.log("PASS A5 normal output clears a pending hit");
}
// A6: unknown session id: nothing counts.
{
  const {watch, log} = setup();
  fs.appendFileSync(log, L.rate + "\n");
  evaluateIdleWatch(watch, {now: t0});
  assert.equal(evaluateIdleWatch(watch, {now: t0 + 120_000}).status, "ok");
  console.log("PASS A6 no session id yet: ignored");
}
// A7: non-engine prose is not a hit.
assert.equal(rateLimitLineInfo("the user asked about Endpoint is unavailable handling"), null);
console.log("PASS A7 prose without engine error source is not a hit");

// B: stdout error events.
const observe = events => adapterDriver("opencode").observe(events, {});
const classify = events => classifyObservedFailure({exitCode: 1, stdout: "", stderr: "", startError: null, timedOut: false, driverless: false, evidence: observe(events)});
const ev = (message, statusCode) => ({type: "error", error: {name: "APIError", data: {message, ...(statusCode ? {statusCode} : {}), isRetryable: true}}});
assert.equal(classify([ev("Upstream request failed: Endpoint is unavailable.", 429)])?.class, "RATE_LIMITED");
assert.equal(classify([ev("Something odd", 429)])?.class, "RATE_LIMITED");
assert.equal(classify([ev("Upstream request failed: Endpoint is unavailable.")])?.class, "RATE_LIMITED");
assert.equal(classify([ev("Upstream request failed: Insufficient account funds")])?.class, "RATE_LIMITED");
assert.equal(classify([ev("Rate limit exceeded. Please try again later.")])?.class, "RATE_LIMITED");
assert.notEqual(classify([ev("Invalid model", 400)])?.class, "RATE_LIMITED");
assert.notEqual(classify([{type: "text", part: {type: "text", text: "Endpoint is unavailable, rate limit exceeded, 429"}}])?.class, "RATE_LIMITED");
console.log("PASS B stdout error events: 429 / Endpoint unavailable / funds / rate limit => RATE_LIMITED; unrelated and prose do not");

fs.rmSync(tmp, {recursive: true, force: true});
console.log("ALL PASS test-rate-limit-detection-real-lines");
