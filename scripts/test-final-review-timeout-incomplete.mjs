#!/usr/bin/env node
// Mission 062 task 1.1 — timeout-only INCOMPLETE pure-helper test.
//
// Drives the pure helpers in scripts/final-review-fix-rounds.mjs with no
// autopilot import and no child processes: the strict timeout classifier,
// the gate-log PASS parser, and the gate-green predicate over a Set of
// green basenames.
import {
  isTimeoutOnlyFindings,
  parseGateGreenFiles,
  isTimeoutOnlyCoveredByGateGreen,
  runFinalReviewFixRounds,
} from "./final-review-fix-rounds.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, evidence) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(String(evidence).slice(0, 500))}` : ""}`);
  failed += 1;
}

// ── Classifier: every finding must be timeout/killed/did-not-complete on a named file ──
check("classifier: single timeout on a named file",
  isTimeoutOnlyFindings(["reviewer timed out running test-foo.mjs"]) === true);
check("classifier: killed on a named file",
  isTimeoutOnlyFindings(["run killed while running scripts/test-bar.mjs"]) === true);
check("classifier: did-not-complete on a named file",
  isTimeoutOnlyFindings(["did-not-complete running test-baz.mjs"]) === true);
check("classifier: did not complete (spaced) on a named file",
  isTimeoutOnlyFindings(["reviewer did not complete test-qux.mjs"]) === true);
check("classifier: multiple timeout findings all named",
  isTimeoutOnlyFindings(["timed out running test-a.mjs", "killed running test-b.mjs"]) === true);
check("classifier: empty findings never classify",
  isTimeoutOnlyFindings([]) === false);
check("classifier: non-array never classifies",
  isTimeoutOnlyFindings(null) === false && isTimeoutOnlyFindings("timed out test-a.mjs") === false);
check("classifier: timeout with no named file is false",
  isTimeoutOnlyFindings(["reviewer timed out running the test suite"]) === false);
check("classifier: code defect is false",
  isTimeoutOnlyFindings(["null dereference in scripts/app.mjs"]) === false);
check("classifier: one defect among timeouts is false",
  isTimeoutOnlyFindings(["timed out running test-a.mjs", "null dereference in scripts/app.mjs"]) === false);
check("classifier: non-string finding is false",
  isTimeoutOnlyFindings([null]) === false && isTimeoutOnlyFindings([42]) === false);

// ── Parser: green only on a PASS line with no TEST FAILED line ──
{
  const log = "PASS    7.2s  test-foo.mjs  1/2\nPASS    1.1s  test-bar.mjs  2/2\n";
  const green = parseGateGreenFiles(log);
  check("parser: PASS lines green their files",
    green instanceof Set && green.has("test-foo.mjs") && green.has("test-bar.mjs") && green.size === 2,
    JSON.stringify([...green]));
}
{
  const log = "PASS    7.2s  test-foo.mjs  1/2\nTEST FAILED: test-foo.mjs  1/2\n";
  check("parser: TEST FAILED line removes the green",
    parseGateGreenFiles(log).has("test-foo.mjs") === false);
}
{
  const log = "TEST FAILED: test-foo.mjs (signal SIGKILL)  1/1\n";
  check("parser: failure-only log greens nothing",
    parseGateGreenFiles(log).size === 0);
}
{
  const log = "PASS    7.2s  test-foo.mjs  1/2\nTEST FAILED: test-bar.mjs  2/2\n";
  const green = parseGateGreenFiles(log);
  check("parser: unrelated failure keeps the other green",
    green.has("test-foo.mjs") === true && green.has("test-bar.mjs") === false,
    JSON.stringify([...green]));
}
{
  const log = "PASS    2.0s  scripts/test-dir.mjs  1/1\n";
  check("parser: directory-prefixed PASS greens the basename",
    parseGateGreenFiles(log).has("test-dir.mjs") === true);
}
check("parser: non-string log yields an empty Set",
  parseGateGreenFiles(null) instanceof Set && parseGateGreenFiles(null).size === 0
  && parseGateGreenFiles("") instanceof Set && parseGateGreenFiles("").size === 0);

// ── Predicate: Set of green basenames covers every timeout finding ──
check("predicate: green gate covers the timeout file",
  isTimeoutOnlyCoveredByGateGreen(
    ["timed out running test-foo.mjs"], new Set(["test-foo.mjs"])) === true);
check("predicate: green gate covers every timeout file",
  isTimeoutOnlyCoveredByGateGreen(
    ["timed out running test-a.mjs", "killed running scripts/test-b.mjs"],
    new Set(["test-a.mjs", "test-b.mjs"])) === true);
check("predicate: missing green file is false",
  isTimeoutOnlyCoveredByGateGreen(
    ["timed out running test-a.mjs", "killed running test-b.mjs"],
    new Set(["test-a.mjs"])) === false);
check("predicate: no green evidence is false",
  isTimeoutOnlyCoveredByGateGreen(["timed out running test-a.mjs"], new Set()) === false);
check("predicate: non-Set green input is false",
  isTimeoutOnlyCoveredByGateGreen(["timed out running test-a.mjs"], ["test-a.mjs"]) === false
  && isTimeoutOnlyCoveredByGateGreen(["timed out running test-a.mjs"], null) === false);
check("predicate: mixed defect findings never covered",
  isTimeoutOnlyCoveredByGateGreen(
    ["timed out running test-a.mjs", "null dereference in scripts/app.mjs"],
    new Set(["test-a.mjs"])) === false);
check("predicate: empty findings never covered",
  isTimeoutOnlyCoveredByGateGreen([], new Set(["test-a.mjs"])) === false);

// ── Initial-review-only acceptance wiring (runFinalReviewFixRounds) ──
const TIMEOUT_FAIL = {status: "completed", review: {decision: "INCOMPLETE", findings: ["timed out running test-foo.mjs"]}};
async function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.join(" ")); };
  try { return {result: await fn(), lines}; }
  finally { console.log = original; }
}
{
  const state = {};
  let saves = 0, fix = 0, gate = 0, review = 0;
  const {result, lines} = await captureLog(() => runFinalReviewFixRounds({
    state, policy: {},
    initialReview: TIMEOUT_FAIL,
    initialFindings: ["timed out running test-foo.mjs"],
    gateGreenFiles: new Set(["test-foo.mjs"]),
    saveState: () => { saves += 1; },
    deps: {
      runFixPass: async () => { fix += 1; },
      runGate: async () => { gate += 1; return null; },
      runFinalReview: async () => { review += 1; return TIMEOUT_FAIL; },
      checkEvidenceRefusal: () => null,
    },
  }));
  check("acceptance: green-gate timeout-only initial returns passed",
    result.outcome === "passed" && result.review === TIMEOUT_FAIL, JSON.stringify(result.outcome));
  check("acceptance: no budget consumed and no fix/gate/review calls",
    result.roundsUsed === 0 && saves === 0 && fix === 0 && gate === 0 && review === 0
    && state["finalReviewFixRoundsUsed"] === undefined,
    JSON.stringify({roundsUsed: result.roundsUsed, saves, fix, gate, review}));
  check("acceptance: logs exactly one line naming the test",
    lines.length === 1 && lines[0].includes("test-foo.mjs"), JSON.stringify(lines));
}
{
  // No-green initial input uses the fix round.
  const state = {};
  let fix = 0;
  const FAIL = {status: "completed", review: {decision: "FAIL", findings: ["timed out running test-foo.mjs"]}};
  const PASS = {status: "completed", review: {decision: "PASS", findings: []}};
  const result = await runFinalReviewFixRounds({
    state, policy: {},
    initialReview: FAIL,
    initialFindings: ["timed out running test-foo.mjs"],
    gateGreenFiles: new Set(),
    saveState: () => {},
    deps: {
      runFixPass: async () => { fix += 1; },
      runGate: async () => null,
      runFinalReview: async () => PASS,
      checkEvidenceRefusal: () => null,
    },
  });
  check("acceptance: no-green timeout-only initial uses the fix round",
    result.outcome === "passed" && fix === 1, JSON.stringify({outcome: result.outcome, fix}));
}
{
  // Mixed-defect initial input uses the fix round even when the timeout file is green.
  const state = {};
  let fix = 0;
  const FAIL = {status: "completed", review: {decision: "FAIL", findings: ["x"]}};
  const PASS = {status: "completed", review: {decision: "PASS", findings: []}};
  const result = await runFinalReviewFixRounds({
    state, policy: {},
    initialReview: FAIL,
    initialFindings: ["timed out running test-a.mjs", "null dereference in scripts/app.mjs"],
    gateGreenFiles: new Set(["test-a.mjs"]),
    saveState: () => {},
    deps: {
      runFixPass: async () => { fix += 1; },
      runGate: async () => null,
      runFinalReview: async () => PASS,
      checkEvidenceRefusal: () => null,
    },
  });
  check("acceptance: mixed-defect initial uses the fix round",
    result.outcome === "passed" && fix === 1, JSON.stringify({outcome: result.outcome, fix}));
}
for (const [label, extra] of [
  ["policy-violation", {initialReview: {status: "completed", policyViolation: true, review: {decision: "INCOMPLETE", findings: ["timed out running test-foo.mjs"]}}}],
  ["policy-violation-string", {initialReview: {status: "completed", policyViolation: "read_only_violation", review: {decision: "INCOMPLETE", findings: ["timed out running test-foo.mjs"]}}}],
  ["evidence-refusal", {initialEvidenceRefusal: {refuse: true}}],
]) {
  const state = {};
  let fix = 0;
  const base = {
    state, policy: {},
    initialReview: TIMEOUT_FAIL,
    initialFindings: ["timed out running test-foo.mjs"],
    gateGreenFiles: new Set(["test-foo.mjs"]),
    saveState: () => {},
  };
  const {result, lines} = await captureLog(() => runFinalReviewFixRounds({
    ...base, ...extra,
    deps: {
      runFixPass: async () => { fix += 1; },
      runGate: async () => null,
      runFinalReview: async () => TIMEOUT_FAIL,
      checkEvidenceRefusal: () => null,
    },
  }));
  check(`acceptance: ${label} all-timeout initial still bypasses`,
    result.outcome === "bypass" && fix === 0, JSON.stringify({outcome: result.outcome, fix}));
  void lines;
}
{
  // Timeout-only re-review after a fix pass is never accepted: next round or escalate.
  const state = {};
  const DEFECT_FAIL = {status: "completed", review: {decision: "FAIL", findings: ["null dereference in scripts/app.mjs"]}};
  const TIMEOUT_REREVIEW = {status: "completed", review: {decision: "INCOMPLETE", findings: ["timed out running test-foo.mjs"]}};
  let reviews = 0;
  const {result, lines} = await captureLog(() => runFinalReviewFixRounds({
    state, policy: {},
    initialReview: DEFECT_FAIL,
    initialFindings: ["null dereference in scripts/app.mjs"],
    gateGreenFiles: new Set(["test-foo.mjs"]),
    saveState: () => {},
    deps: {
      runFixPass: async () => {},
      runGate: async () => null,
      runFinalReview: async () => { reviews += 1; return TIMEOUT_REREVIEW; },
      checkEvidenceRefusal: () => null,
    },
  }));
  check("acceptance: timeout-only re-review after a fix pass is never accepted",
    result.outcome === "escalate" && reviews === 2, JSON.stringify({outcome: result.outcome, reviews}));
  check("acceptance: re-review path logs no acceptance line",
    lines.every((line) => !/accepted via gate green/.test(line)), JSON.stringify(lines));
}

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("final-review timeout-incomplete helper tests passed");
