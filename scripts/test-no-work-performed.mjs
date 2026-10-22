#!/usr/bin/env node
// Mission 071 Phase 1 task 1.1 — isNoWorkPerformed helper cases.
import fs from "node:fs";
import {isNoWorkPerformed, runFinalReviewFixRounds, FINAL_REVIEW_FIX_ROUNDS_STATE_KEY} from "./final-review-fix-rounds.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, evidence) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(String(evidence).slice(0, 500))}` : ""}`);
  failed += 1;
}

function neverThrows(fn, label) {
  try { return fn(); }
  catch (err) { check(`${label} never throws`, false, err?.message); return undefined; }
}

// Accept: true only when status==="completed" with empty touchedFiles array.
check("completed + [] is no work",
  neverThrows(() => isNoWorkPerformed({status: "completed", touchedFiles: []}), "completed+[]") === true);
check("completed + ['a'] is work",
  neverThrows(() => isNoWorkPerformed({status: "completed", touchedFiles: ["a"]}), "completed+file") === false);
check("non-completed + [] is not no-work",
  neverThrows(() => isNoWorkPerformed({status: "failed", touchedFiles: []}), "failed+[]") === false);
check("missing status is not no-work",
  neverThrows(() => isNoWorkPerformed({touchedFiles: []}), "missing-status") === false);
check("null is not no-work",
  neverThrows(() => isNoWorkPerformed(null), "null") === false);
check("undefined is not no-work",
  neverThrows(() => isNoWorkPerformed(undefined), "undefined") === false);
check("non-object is not no-work",
  neverThrows(() => isNoWorkPerformed("completed"), "string") === false);
check("null touchedFiles is not no-work",
  neverThrows(() => isNoWorkPerformed({status: "completed", touchedFiles: null}), "null-files") === false);
check("undefined touchedFiles is not no-work",
  neverThrows(() => isNoWorkPerformed({status: "completed"}), "missing-files") === false);
check("non-array touchedFiles is not no-work",
  neverThrows(() => isNoWorkPerformed({status: "completed", touchedFiles: "a"}), "string-files") === false);
check("object touchedFiles is not no-work",
  neverThrows(() => isNoWorkPerformed({status: "completed", touchedFiles: {}}), "object-files") === false);
check("alias filesTouched is not no-work",
  neverThrows(() => isNoWorkPerformed({status: "completed", filesTouched: []}), "alias") === false);
check("throwing getter never throws and is not no-work", (() => {
  const evil = {};
  Object.defineProperty(evil, "touchedFiles", {enumerable: true, get() { throw new Error("boom"); }});
  evil.status = "completed";
  const out = neverThrows(() => isNoWorkPerformed(evil), "throwing-getter");
  return out === false;
})());

// ── Loop wiring: fake runFixPass/runGate/runFinalReview ──
const LOOP_FAIL = {status: "completed", review: {decision: "FAIL", findings: ["finding one"]}};
const LOOP_PASS = {status: "completed", review: {decision: "PASS", findings: []}};
const summaryAbsentOrEmpty = (args) => args.summary === undefined || args.summary === "";

// Zero files: gate skipped, re-review gets the threaded summary, budget consumed.
{
  const state = {};
  let gateCalls = 0;
  let seen = null;
  const result = await runFinalReviewFixRounds({
    state, policy: {},
    initialReview: LOOP_FAIL,
    initialEvidenceRefusal: null,
    initialFindings: ["finding one"],
    saveState: () => {},
    deps: {
      runFixPass: async () => ({status: "completed", touchedFiles: [], finalMessage: "nothing to fix: rebuttal"}),
      runGate: async () => { gateCalls += 1; return "gate-evidence"; },
      runFinalReview: async (args) => { seen = {...args}; return LOOP_PASS; },
      checkEvidenceRefusal: () => null,
    },
  });
  check("loop: zero files skips the gate", gateCalls === 0, gateCalls);
  check("loop: zero files re-review receives the threaded summary",
    seen !== null && seen.summary === "nothing to fix: rebuttal", seen?.summary);
  check("loop: zero files re-review gate is null", seen !== null && seen.gate === null, seen?.gate);
  check("loop: zero files still consumes its budget round",
    state[FINAL_REVIEW_FIX_ROUNDS_STATE_KEY] === 1, JSON.stringify(state));
  check("loop: zero files pass-through passes", result.outcome === "passed", result.outcome);
}

// Zero files with non-string finalMessage: summary falls back to "".
{
  let seen = null;
  const result = await runFinalReviewFixRounds({
    state: {}, policy: {},
    initialReview: LOOP_FAIL,
    initialEvidenceRefusal: null,
    initialFindings: ["finding one"],
    saveState: () => {},
    deps: {
      runFixPass: async () => ({status: "completed", touchedFiles: [], finalMessage: 123}),
      runGate: async () => "gate-evidence",
      runFinalReview: async (args) => { seen = {...args}; return LOOP_PASS; },
      checkEvidenceRefusal: () => null,
    },
  });
  check("loop: non-string finalMessage threads empty summary",
    result.outcome === "passed" && seen !== null && seen.summary === "" && seen.gate === null,
    JSON.stringify({outcome: result.outcome, seen}));
}

// >=1 file: gate called as before, summary absent-or-empty.
{
  const state = {};
  let gateCalls = 0;
  let seen = null;
  const result = await runFinalReviewFixRounds({
    state, policy: {},
    initialReview: LOOP_FAIL,
    initialEvidenceRefusal: null,
    initialFindings: ["finding one"],
    saveState: () => {},
    deps: {
      runFixPass: async () => ({status: "completed", touchedFiles: ["a.js"], finalMessage: "did work"}),
      runGate: async () => { gateCalls += 1; return "gate-evidence"; },
      runFinalReview: async (args) => { seen = {...args}; return LOOP_PASS; },
      checkEvidenceRefusal: () => null,
    },
  });
  check("loop: changed files calls the gate as before", gateCalls === 1, gateCalls);
  check("loop: changed files re-review summary absent-or-empty",
    result.outcome === "passed" && seen !== null && summaryAbsentOrEmpty(seen), JSON.stringify(seen));
  check("loop: changed files re-review keeps gate evidence",
    seen !== null && seen.gate === "gate-evidence", seen?.gate);
}

// Malformed fix result: falls back to the old path (gate called, summary absent-or-empty).
{
  let gateCalls = 0;
  let seen = null;
  const result = await runFinalReviewFixRounds({
    state: {}, policy: {},
    initialReview: LOOP_FAIL,
    initialEvidenceRefusal: null,
    initialFindings: ["finding one"],
    saveState: () => {},
    deps: {
      runFixPass: async () => ({brief: null, findings: ["finding one"]}),
      runGate: async () => { gateCalls += 1; return "gate-evidence"; },
      runFinalReview: async (args) => { seen = {...args}; return LOOP_PASS; },
      checkEvidenceRefusal: () => null,
    },
  });
  check("loop: malformed result falls back to the old path",
    result.outcome === "passed" && gateCalls === 1 && seen !== null && summaryAbsentOrEmpty(seen),
    JSON.stringify({outcome: result.outcome, gateCalls, seen}));
}

// Repeated zero-file passes: every round skips the gate and escalates with step final_review.
{
  const state = {};
  let gateCalls = 0;
  const seenSummaries = [];
  const result = await runFinalReviewFixRounds({
    state, policy: {},
    initialReview: LOOP_FAIL,
    initialEvidenceRefusal: null,
    initialFindings: ["finding one"],
    saveState: () => {},
    deps: {
      runFixPass: async () => ({status: "completed", touchedFiles: [], finalMessage: "still nothing"}),
      runGate: async () => { gateCalls += 1; return "gate-evidence"; },
      runFinalReview: async (args) => { seenSummaries.push(args.summary); return LOOP_FAIL; },
      checkEvidenceRefusal: () => null,
    },
  });
  check("loop: repeated zero-file passes escalate with step final_review",
    result.outcome === "escalate" && result.step === "final_review", JSON.stringify({outcome: result.outcome, step: result.step}));
  check("loop: repeated zero-file passes never call the gate", gateCalls === 0, gateCalls);
  check("loop: repeated zero-file passes each thread the summary",
    seenSummaries.length === 2 && seenSummaries.every((s) => s === "still nothing"),
    JSON.stringify(seenSummaries));
  check("loop: repeated zero-file passes consume the full budget",
    state[FINAL_REVIEW_FIX_ROUNDS_STATE_KEY] === 2, JSON.stringify(state));
}

// ── Source pins: exact runFinalReview({round,used,limit,gate,brief,summary}) field ──
{
  const loopSrc = fs.readFileSync(new URL("./final-review-fix-rounds.mjs", import.meta.url), "utf8");
  check("pin: loop re-review threads the exact summary field",
    loopSrc.includes("runFinalReview({round, used, limit, gate, brief, summary: noWorkSummary})"), null);
  const autoSrc = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
  const driverAt = autoSrc.indexOf("async function runStandaloneFinalReviewFixRounds");
  const driverEnd = autoSrc.indexOf("async function runStandaloneImplementation", driverAt);
  const driverSlice = driverAt !== -1 ? autoSrc.slice(driverAt, driverEnd !== -1 ? driverEnd : driverAt + 4000) : "";
  check("pin: standalone runFinalReview dep takes the exact summary field",
    driverSlice.includes("runFinalReview:async({round,used,limit,gate,brief,summary})"), null);
  check("pin: standalone re-review threads the summary into the rebuilt handoff",
    driverSlice.includes("reviewOnce(typeof summary") && driverSlice.includes("implementationSummary:typeof summary"),
    driverSlice.slice(0, 200));
  check("pin: standalone re-review path passes no literal empty summary",
    !driverSlice.includes('implementationSummary:""'), null);
  check("pin: speckit runFinalReview dep takes the exact summary field",
    autoSrc.includes("runFinalReview:async({round,used,limit,gate,brief,summary})"), null);
  check("pin: speckit re-review gains the answer/rebuttal section only when summary is non-empty",
    autoSrc.includes("Implementer's answer/rebuttal") && autoSrc.includes('typeof summary==="string"&&summary!==""'), null);
}

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("no-work-performed helper tests passed");
