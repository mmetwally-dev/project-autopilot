#!/usr/bin/env node
// Mission 069 task 1.1 — verifier-continuation gate stash contract tests.
//
// Proves, with a fake gate runner: unchanged-digest reuse without calling
// the runner (ok:true and ok:false), changed-digest re-run, consume-once
// second-lookup re-run, and FAIL-transition-clear re-run. Source-pattern
// wiring assertions for the autopilot loops are NOT part of 1.1 (they land
// in 1.2/1.3).
import fs from "node:fs";
import {
  INVALID_CODE,
  createCheckpoint,
  deltaDigest,
  validateCheckpoint,
  recordContinuationGateResult,
  takeContinuationGateResult,
  clearContinuationGateResult,
  resolveContinuationGateResult,
} from "./phase-stage-checkpoint.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  failed += 1;
}

const baseInput = {
  framework: "standalone",
  mission: "069-fix-backlog-item",
  phaseIndex: 0,
  phaseName: "Verifier-continuation gate reuse",
  tasks: [{file: "TASKS.md", text: "task 1.1"}],
  repoRoot: ".",
  baselineKey: "mission-069-fix-backlog-item-phase-0",
};

function makeCheckpoint(overrides = {}) {
  const cp = createCheckpoint({...baseInput, at: "2026-01-01T00:00:00.000Z"});
  return {...cp, ...overrides};
}

function gateKey(deltaLabel, commandsLabel = '["cmd"]') {
  return `${deltaDigest(deltaLabel)}|${deltaDigest(commandsLabel)}`;
}

// ── Exports with exact names/signatures ──────────────────────────────────
{
  const mod = await import("./phase-stage-checkpoint.mjs");
  for (const name of [
    "recordContinuationGateResult",
    "takeContinuationGateResult",
    "clearContinuationGateResult",
    "resolveContinuationGateResult",
  ]) {
    check(`exports ${name}`, typeof mod[name] === "function");
  }
  check("signature recordContinuationGateResult(checkpoint,key,gateResult)",
    recordContinuationGateResult.length === 3, recordContinuationGateResult.length);
  check("signature takeContinuationGateResult(checkpoint,key)",
    takeContinuationGateResult.length === 2, takeContinuationGateResult.length);
  check("signature clearContinuationGateResult(checkpoint)",
    clearContinuationGateResult.length === 1, clearContinuationGateResult.length);
  check("signature resolveContinuationGateResult({checkpoint,key,runGate})",
    resolveContinuationGateResult.length <= 1, resolveContinuationGateResult.length);
}

// ── Validation: present-if-validated ─────────────────────────────────────
{
  check("validation: absent stash validates", validateCheckpoint(makeCheckpoint()).ok);
  check("validation: explicit null stash validates",
    validateCheckpoint({...makeCheckpoint(), continuationGate: null}).ok);

  const key = gateKey("delta-1");
  for (const [label, result] of [["ok:true", {ok: true, summary: "pass"}], ["ok:false", {ok: false, summary: "fail"}]]) {
    const cp = makeCheckpoint();
    recordContinuationGateResult(cp, key, result);
    const r = validateCheckpoint(cp);
    check(`validation: well-formed stash (${label}) passes`, r.ok, r);
  }

  const badCases = [
    ["non-object stash", "not-an-object"],
    ["array stash", []],
    ["missing key", {result: {ok: true}}],
    ["empty key", {key: "", result: {ok: true}}],
    ["non-string key", {key: 42, result: {ok: true}}],
    ["missing result", {key}],
    ["non-object result", {key, result: true}],
    ["result without boolean ok", {key, result: {summary: "no ok"}}],
    ["result with non-boolean ok", {key, result: {ok: "yes"}}],
  ];
  for (const [label, continuationGate] of badCases) {
    const r = validateCheckpoint({...makeCheckpoint(), continuationGate});
    check(`validation: invalid stash (${label}) rejected`,
      !r.ok && r.code === INVALID_CODE, r);
  }

  // JSON round-trip preserves a well-formed stash.
  const cp = makeCheckpoint();
  recordContinuationGateResult(cp, key, {ok: true, summary: "pass"});
  const roundTripped = JSON.parse(JSON.stringify(cp));
  check("validation: JSON round-trip preserves stash",
    roundTripped.continuationGate?.key === key &&
    roundTripped.continuationGate?.result?.ok === true &&
    validateCheckpoint(roundTripped).ok, roundTripped.continuationGate);
}

// ── record/take/clear unit semantics ─────────────────────────────────────
{
  const key = gateKey("delta-1");
  const result = {ok: true, summary: "pass"};

  const cp = makeCheckpoint();
  check("record: returns the checkpoint for chaining",
    recordContinuationGateResult(cp, key, result) === cp);
  check("take: key match returns the stashed result",
    takeContinuationGateResult(cp, key) === result, cp.continuationGate);

  const cp2 = makeCheckpoint();
  recordContinuationGateResult(cp2, key, result);
  takeContinuationGateResult(cp2, key);
  check("take: consume-once — stash cleared after hit",
    cp2.continuationGate === undefined);

  const cp3 = makeCheckpoint();
  recordContinuationGateResult(cp3, key, result);
  const miss = takeContinuationGateResult(cp3, gateKey("delta-2"));
  check("take: key mismatch returns null", miss === null, miss);
  check("take: mismatch still clears the stash",
    cp3.continuationGate === undefined, cp3.continuationGate);

  const cp4 = makeCheckpoint();
  recordContinuationGateResult(cp4, key, result);
  check("clear: clears the stash",
    clearContinuationGateResult(cp4) === cp4 && cp4.continuationGate === undefined);
  check("take: empty stash returns null",
    takeContinuationGateResult(makeCheckpoint(), key) === null);
}

// ── resolve: reuse vs re-run via a fake runner ──────────────────────────
function fakeRunner(returnValue, calls) {
  return () => { calls.count += 1; return returnValue; };
}

{
  // Unchanged digest reuses ok:true without calling the runner.
  const key = gateKey("delta-1");
  const cp = makeCheckpoint();
  recordContinuationGateResult(cp, key, {ok: true, summary: "gate pass"});
  const calls = {count: 0};
  const out = await resolveContinuationGateResult({
    checkpoint: cp, key, runGate: fakeRunner({ok: true, summary: "fresh"}, calls),
  });
  check("reuse: unchanged digest reuses ok:true without calling the runner",
    calls.count === 0 && out?.ok === true && out?.summary === "gate pass", {calls: calls.count, out});

  // Unchanged digest reuses ok:false without calling the runner.
  const cpF = makeCheckpoint();
  recordContinuationGateResult(cpF, key, {ok: false, summary: "gate fail"});
  const callsF = {count: 0};
  const outF = await resolveContinuationGateResult({
    checkpoint: cpF, key, runGate: fakeRunner({ok: true, summary: "fresh"}, callsF),
  });
  check("reuse: unchanged digest reuses ok:false without calling the runner",
    callsF.count === 0 && outF?.ok === false && outF?.summary === "gate fail", {calls: callsF.count, outF});
}

{
  // Changed digest re-runs.
  const cp = makeCheckpoint();
  recordContinuationGateResult(cp, gateKey("delta-1"), {ok: true, summary: "stale"});
  const calls = {count: 0};
  const fresh = {ok: true, summary: "fresh run"};
  const out = await resolveContinuationGateResult({
    checkpoint: cp, key: gateKey("delta-2"), runGate: fakeRunner(fresh, calls),
  });
  check("re-run: changed digest calls the runner and returns its result",
    calls.count === 1 && out === fresh, {calls: calls.count, out});
}

{
  // Consume-once: second lookup with the same key re-runs.
  const key = gateKey("delta-1");
  const cp = makeCheckpoint();
  recordContinuationGateResult(cp, key, {ok: true, summary: "stashed"});
  const calls = {count: 0};
  const fresh = {ok: true, summary: "fresh"};
  const first = await resolveContinuationGateResult({
    checkpoint: cp, key, runGate: fakeRunner(fresh, calls),
  });
  check("consume-once: first lookup hits the stash",
    calls.count === 0 && first?.summary === "stashed", {calls: calls.count, first});
  const second = await resolveContinuationGateResult({
    checkpoint: cp, key, runGate: fakeRunner(fresh, calls),
  });
  check("consume-once: second lookup re-runs (stash was consumed)",
    calls.count === 1 && second === fresh, {calls: calls.count, second});
}

{
  // FAIL-transition-clear: a functional rejection clears the stash, so the
  // next consult re-runs even with an unchanged digest.
  const key = gateKey("delta-1");
  const cp = makeCheckpoint();
  recordContinuationGateResult(cp, key, {ok: true, summary: "stashed"});
  clearContinuationGateResult(cp);
  const calls = {count: 0};
  const fresh = {ok: true, summary: "post-fail fresh"};
  const out = await resolveContinuationGateResult({
    checkpoint: cp, key, runGate: fakeRunner(fresh, calls),
  });
  check("transition-clear: cleared stash re-runs on unchanged digest",
    calls.count === 1 && out === fresh, {calls: calls.count, out});
}

// ── Mission 069 task 1.2: standalone verifier wiring (source patterns) ──
// autopilot.mjs runs main() on import, so the stash wiring is covered
// statically here (same pattern as test-cap-breach-wiring.mjs).
{
  const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
  const standalonePart = src.split("async function runImplementation(c){")[0];
  const countIn = (hay, needle) => hay.split(needle).length - 1;
  const GET_LINE = "getCachedGateResult(checkpoint,preGateCacheKey)";
  const SET_LINE = "setCachedGateResult(checkpoint,preGateCacheKey,g)";
  const TAKE = "takeContinuationGateResult(checkpoint,preGateCacheKey)";
  const RECORD = "recordContinuationGateResult(checkpoint,preGateCacheKey,g)";

  check("standalone wiring: gate block consults the stash",
    standalonePart.includes(TAKE));
  check("standalone wiring: stash lookup comes before the standalone getCachedGateResult line",
    standalonePart.includes(TAKE) && standalonePart.includes(GET_LINE) &&
    standalonePart.indexOf(TAKE) < standalonePart.indexOf(GET_LINE));
  check("standalone wiring: gateCache lines byte-identical (each literal still appears twice)",
    countIn(src, GET_LINE) === 2 && countIn(src, SET_LINE) === 2);
  check("standalone wiring: cap, incomplete and backstop sites record the stash (3 record sites)",
    countIn(standalonePart, RECORD) === 3, countIn(standalonePart, RECORD));
  // Each verifier continuation log in the standalone section is preceded by
  // a stash record: cap/incomplete records sit after the !cont.allowed block
  // just before the 'continuing as session' log; the backstop record is a
  // single short call just before the 'continuing as backstop session' log.
  const verifierRegion = standalonePart.slice(standalonePart.indexOf(TAKE));
  for (const [label, log] of [
    ["cap", "Verification hit the ${vv.capped.type} cap"],
    ["incomplete", "Verification stopped voluntarily as incomplete"],
    ["backstop", "continuing as backstop session ${backstop.firings.length+1}"],
  ]) {
    const logIdx = verifierRegion.indexOf(log);
    const recIdx = logIdx === -1 ? -1 : verifierRegion.lastIndexOf(RECORD, logIdx);
    check(`standalone wiring: ${label} continuation records before its log`,
      logIdx !== -1 && recIdx !== -1 && (logIdx - recIdx) < 500, {logIdx, recIdx});
  }
  check("standalone wiring: standalone applyCheckpointTransition clears the stash",
    standalonePart.includes("clearContinuationGateResult(checkpoint)"));
}

// ── Mission 069 task 1.3: SpecKit verifier wiring (source patterns) ──
{
  const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
  const speckitPart = src.split("async function runImplementation(c){")[1] ?? "";
  const countIn = (hay, needle) => hay.split(needle).length - 1;
  const GET_LINE = "getCachedGateResult(checkpoint,preGateCacheKey)";
  const SET_LINE = "setCachedGateResult(checkpoint,preGateCacheKey,g)";
  const TAKE = "takeContinuationGateResult(checkpoint,preGateCacheKey)";
  const RECORD = "recordContinuationGateResult(checkpoint,preGateCacheKey,g)";

  check("speckit wiring: gate block consults the stash",
    speckitPart.includes(TAKE));
  check("speckit wiring: stash lookup comes before the SpecKit getCachedGateResult line",
    speckitPart.includes(TAKE) && speckitPart.includes(GET_LINE) &&
    speckitPart.indexOf(TAKE) < speckitPart.indexOf(GET_LINE));
  check("speckit wiring: gateCache lines byte-identical (each literal still appears twice)",
    countIn(src, GET_LINE) === 2 && countIn(src, SET_LINE) === 2);
  check("speckit wiring: cap, incomplete and backstop sites record the stash (3 record sites)",
    countIn(speckitPart, RECORD) === 3, countIn(speckitPart, RECORD));
  const verifierRegion = speckitPart.slice(speckitPart.indexOf(TAKE));
  for (const [label, log] of [
    ["cap", "SpecKit verification hit the ${vv.capped.type} cap"],
    ["incomplete", "SpecKit verification stopped voluntarily as incomplete"],
    ["backstop", "continuing as backstop session ${backstop.firings.length+1}"],
  ]) {
    const logIdx = verifierRegion.indexOf(log);
    const recIdx = logIdx === -1 ? -1 : verifierRegion.lastIndexOf(RECORD, logIdx);
    check(`speckit wiring: ${label} continuation records before its log`,
      logIdx !== -1 && recIdx !== -1 && (logIdx - recIdx) < 500, {logIdx, recIdx});
  }
  check("speckit wiring: SpecKit applyCheckpointTransition clears the stash",
    speckitPart.includes("clearContinuationGateResult(checkpoint)"));
}

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
