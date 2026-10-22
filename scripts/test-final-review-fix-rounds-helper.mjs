#!/usr/bin/env node
// Mission 051 Phase 1 task 1.2 — final-review fix-round helper unit test.
//
// Drives scripts/final-review-fix-rounds.mjs with injected fakes (no
// autopilot import): budget enforcement from the durable counter, counter
// persistence across rounds, evidence-refusal/policy-violation bypass, fix
// brief + finding record wiring, gate-before-re-review order, and the
// preserved escalation message/step.
import {
  FINAL_REVIEW_FIX_ROUNDS_STATE_KEY,
  FINAL_REVIEW_ESCALATION_STEP,
  FINAL_REVIEW_ESCALATION_MESSAGE,
  readFinalReviewFixRoundsUsed,
  finalReviewFixRoundsRemaining,
  resetFinalReviewFixRoundsUsed,
  isFinalReviewBypass,
  consumeFinalReviewFixRound,
  buildFinalReviewFixBrief,
  runFinalReviewFixRounds,
} from "./final-review-fix-rounds.mjs";
import {resolveFinalReviewFixRounds} from "./per-task-budget.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, evidence) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(String(evidence).slice(0, 500))}` : ""}`);
  failed += 1;
}

const FAIL = {status: "completed", review: {decision: "FAIL", findings: ["finding one"]}};
const PASS = {status: "completed", review: {decision: "PASS", findings: []}};

// ── Counter + resolver ──
check("default budget resolves to 2", resolveFinalReviewFixRounds({}) === 2);
check("missing counter reads as 0",
  readFinalReviewFixRoundsUsed({}) === 0 && readFinalReviewFixRoundsUsed(null) === 0
  && readFinalReviewFixRoundsUsed({[FINAL_REVIEW_FIX_ROUNDS_STATE_KEY]: "x"}) === 0);
check("remaining degrades from the durable counter",
  finalReviewFixRoundsRemaining({}, {}) === 2
  && finalReviewFixRoundsRemaining({[FINAL_REVIEW_FIX_ROUNDS_STATE_KEY]: 1}, {}) === 1
  && finalReviewFixRoundsRemaining({[FINAL_REVIEW_FIX_ROUNDS_STATE_KEY]: 2}, {}) === 0
  && finalReviewFixRoundsRemaining({[FINAL_REVIEW_FIX_ROUNDS_STATE_KEY]: 9}, {}) === 0);

// ── Consume persists ──
{
  const state = {};
  let saves = 0;
  const r1 = consumeFinalReviewFixRound(state, {}, {saveState: () => { saves += 1; }});
  check("consume persists the counter and calls saveState",
    r1.used === 1 && r1.allowed === true && r1.limit === 2
    && state[FINAL_REVIEW_FIX_ROUNDS_STATE_KEY] === 1 && saves === 1, JSON.stringify(r1));
  const r2 = consumeFinalReviewFixRound(state, {}, {saveState: () => { saves += 1; }});
  check("second consume persists across rounds",
    r2.used === 2 && r2.allowed === true && state[FINAL_REVIEW_FIX_ROUNDS_STATE_KEY] === 2 && saves === 2);
  const r3 = consumeFinalReviewFixRound(state, {}, {});
  check("over-budget consume reports disallowed", r3.used === 3 && r3.allowed === false);
}

// ── Bypass ──
check("evidence refusal bypasses", isFinalReviewBypass({review: FAIL, evidenceRefusal: {refuse: true}}) === true);
check("policy violation bypasses", isFinalReviewBypass({review: {status: "completed", policyViolation: true}, evidenceRefusal: null}) === true);
check("policy violation reason string bypasses", isFinalReviewBypass({review: {status: "completed", policyViolation: "read_only_violation"}, evidenceRefusal: null}) === true);
check("plain FAIL does not bypass", isFinalReviewBypass({review: FAIL, evidenceRefusal: null}) === false);
check("ambiguous signals never bypass",
  isFinalReviewBypass({review: FAIL, evidenceRefusal: {refuse: 1}}) === false
  && isFinalReviewBypass({review: {policyViolation: 1}}) === false);

// ── Fix brief wrapper ──
{
  const lines = Array.from({length: 30}, (_, i) => `L${i + 1} body ${i + 1}`);
  const brief = buildFinalReviewFixBrief(["Fix scripts/a.mjs:5-7 now."], (rel) => (rel === "scripts/a.mjs" ? lines.join("\n") : null), {context: 0});
  check("brief cites the finding location plus the edit-first instruction",
    typeof brief === "string" && brief.includes("scripts/a.mjs") && brief.includes("edit these locations first"), brief?.slice(0, 200));
}

// ── FAIL-once-then-PASS completes without escalation ──
{
  const state = {};
  const order = [];
  const calls = {record: 0, brief: 0, fix: 0, gate: 0, review: 0};
  let reviews = 0;
  const result = await runFinalReviewFixRounds({
    state, policy: {},
    initialReview: FAIL,
    initialFindings: ["finding one"],
    recordArgs: {key: "k", phaseTaskDigest: "d", taskIds: [], factsByTask: {}, revision: 1, carryAllowed: false},
    saveState: () => {},
    deps: {
      recordFindingTasks: (s, key, args) => { calls.record += 1; order.push("record"); s.__rec = args; return {key}; },
      loadFindingTasks: () => null,
      buildFixBrief: (findings) => { calls.brief += 1; order.push("brief"); return `brief:${findings.join(",")}`; },
      runFixPass: async () => { calls.fix += 1; order.push("fix"); },
      runGate: async () => { calls.gate += 1; order.push("gate"); return {ok: true}; },
      runFinalReview: async () => { calls.review += 1; order.push("review"); reviews += 1; return reviews === 1 ? FAIL : PASS; },
      checkEvidenceRefusal: () => null,
    },
  });
  check("FAIL-once-then-PASS passes without escalation",
    result.outcome === "passed" && result.roundsUsed === 2 && result.limit === 2, JSON.stringify({outcome: result.outcome, roundsUsed: result.roundsUsed}));
  check("counter persisted across the loop rounds",
    state[FINAL_REVIEW_FIX_ROUNDS_STATE_KEY] === 2, JSON.stringify(state));
  check("finding record written once", calls.record === 1, JSON.stringify(calls));
  check("gate runs before the re-review",
    order.indexOf("gate") !== -1 && order.indexOf("review") !== -1 && order.indexOf("gate") < order.indexOf("review"), order.join(">"));
}

// ── Over-budget FAILs escalate with the preserved message/step ──
{
  const state = {};
  let reviews = 0;
  const result = await runFinalReviewFixRounds({
    state, policy: {},
    initialReview: FAIL,
    initialFindings: ["finding one"],
    saveState: () => {},
    deps: {
      runFixPass: async () => {},
      runGate: async () => ({ok: true}),
      runFinalReview: async () => { reviews += 1; return FAIL; },
      checkEvidenceRefusal: () => null,
    },
  });
  check("over-budget FAILs escalate",
    result.outcome === "escalate" && reviews === 2, JSON.stringify({outcome: result.outcome, reviews}));
  check("escalation keeps the message and step",
    result.step === FINAL_REVIEW_ESCALATION_STEP && result.step === "final_review"
    && result.message === FINAL_REVIEW_ESCALATION_MESSAGE && result.message === "Final review failed.",
    JSON.stringify({step: result.step, message: result.message}));
  check("counter stops at the budget", state[FINAL_REVIEW_FIX_ROUNDS_STATE_KEY] === 2, JSON.stringify(state));
}

// ── Pre-seeded counter shortens the loop (durability across runs) ──
{
  const state = {[FINAL_REVIEW_FIX_ROUNDS_STATE_KEY]: 1};
  let reviews = 0;
  const result = await runFinalReviewFixRounds({
    state, policy: {},
    initialReview: FAIL,
    initialFindings: ["finding one"],
    saveState: () => {},
    deps: {
      runFixPass: async () => {},
      runGate: async () => ({ok: true}),
      runFinalReview: async () => { reviews += 1; return FAIL; },
      checkEvidenceRefusal: () => null,
    },
  });
  check("pre-seeded counter leaves one round then escalates",
    result.outcome === "escalate" && reviews === 1 && state[FINAL_REVIEW_FIX_ROUNDS_STATE_KEY] === 2,
    JSON.stringify({outcome: result.outcome, reviews, state}));
}

// ── Initial bypass consumes nothing and calls nothing ──
for (const [label, extra] of [["evidence-refusal", {initialEvidenceRefusal: {refuse: true}}], ["policy-violation", {initialReview: {status: "completed", policyViolation: true, review: {decision: "FAIL"}}}], ["policy-violation-string", {initialReview: {status: "completed", policyViolation: "read_only_violation", review: {decision: "FAIL"}}}]]) {
  const state = {};
  let fixCalls = 0, gateCalls = 0, reviewCalls = 0;
  const base = {state, policy: {}, initialReview: FAIL, initialFindings: ["f"], saveState: () => {}};
  const result = await runFinalReviewFixRounds({
    ...base, ...extra,
    deps: {
      runFixPass: async () => { fixCalls += 1; },
      runGate: async () => { gateCalls += 1; return {ok: true}; },
      runFinalReview: async () => { reviewCalls += 1; return PASS; },
      checkEvidenceRefusal: () => null,
    },
  });
  check(`${label} initial bypass skips the loop`,
    result.outcome === "bypass" && fixCalls === 0 && gateCalls === 0 && reviewCalls === 0
    && readFinalReviewFixRoundsUsed(state) === 0, JSON.stringify({outcome: result.outcome, fixCalls, gateCalls, reviewCalls}));
}

// ── Mid-loop refusal bypasses instead of escalating ──
{
  const state = {};
  let reviews = 0;
  const result = await runFinalReviewFixRounds({
    state, policy: {},
    initialReview: FAIL,
    initialFindings: ["finding one"],
    saveState: () => {},
    deps: {
      runFixPass: async () => {},
      runGate: async () => ({ok: true}),
      runFinalReview: async () => { reviews += 1; return PASS; },
      checkEvidenceRefusal: () => ({refuse: true}),
    },
  });
  check("mid-loop refusal bypasses without consuming another round",
    result.outcome === "bypass" && reviews === 1 && state[FINAL_REVIEW_FIX_ROUNDS_STATE_KEY] === 1,
    JSON.stringify({outcome: result.outcome, reviews, state}));
}

// ── Mid-loop policy violation bypasses (true or a reason string) ──
for (const pv of [true, "read_only_violation"]) {
  const state = {};
  const result = await runFinalReviewFixRounds({
    state, policy: {},
    initialReview: FAIL,
    initialFindings: ["finding one"],
    saveState: () => {},
    deps: {
      runFixPass: async () => {},
      runGate: async () => ({ok: true}),
      runFinalReview: async () => ({status: "completed", policyViolation: pv, review: {decision: "FAIL"}}),
      checkEvidenceRefusal: () => null,
    },
  });
  check(`mid-loop policy violation bypasses (${pv})`, result.outcome === "bypass", result.outcome);
}

// ── Terminal reset clears the durable counter (mission-complete hygiene) ──
{
  const state = {[FINAL_REVIEW_FIX_ROUNDS_STATE_KEY]: 2, phase: "complete"};
  resetFinalReviewFixRoundsUsed(state);
  check("reset clears the counter for the next mission run",
    !(FINAL_REVIEW_FIX_ROUNDS_STATE_KEY in state) && readFinalReviewFixRoundsUsed(state) === 0
    && finalReviewFixRoundsRemaining(state, {}) === 2, JSON.stringify(state));
  const empty = {};
  resetFinalReviewFixRoundsUsed(empty);
  check("reset on a fresh state is a no-op",
    !(FINAL_REVIEW_FIX_ROUNDS_STATE_KEY in empty) && finalReviewFixRoundsRemaining(empty, {}) === 2);
  check("reset tolerates null state", resetFinalReviewFixRoundsUsed(null) === null);
}

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("final-review fix-round helper tests passed");
