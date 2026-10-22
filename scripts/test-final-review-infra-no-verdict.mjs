#!/usr/bin/env node
// Backlog #86 — a final review with no verdict (timeout / api_retry / failed
// status) or a FAIL with zero findings is a REVIEWER failure: the reviewer is
// retried on the infrastructure budget and no implementer fix pass runs.
import {runFinalReviewFixRounds, isReviewerNoVerdict} from "./final-review-fix-rounds.mjs";
import {failure, recordFailureBudget} from "./failure-contract.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, evidence) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(String(evidence).slice(0, 500))}` : ""}`);
  failed += 1;
}

const TIMED_OUT = {status: "failed", exitCode: null, review: null, failure: failure("TIMEOUT", "infrastructure", true, [])};
const PASS = {status: "completed", review: {decision: "PASS", findings: []}};
const EMPTY_FAIL = {status: "completed", review: {decision: "FAIL", findings: []}};

// Fake driver mirroring recordFinalReviewerFailure: records on the real
// infrastructure budget (scope `mission`), escalates when it disallows.
function harness(reviews, budget = 3) {
  const state = {};
  const policy = {failure_budgets: {infrastructureRetryBudget: budget}};
  const calls = {fix: 0, reviewer: 0, recorded: 0};
  const deps = {
    runFixPass: async () => { calls.fix += 1; return {status: "completed", touchedFiles: ["a.mjs"]}; },
    runGate: async () => null,
    runFinalReview: async () => { calls.reviewer += 1; return reviews.shift() ?? TIMED_OUT; },
    recordReviewerFailure: async ({review}) => {
      calls.recorded += 1;
      const b = recordFailureBudget(state, policy, review.failure, "mission");
      return b.allowed ? {allowed: true} : {allowed: false, step: "infra_escalated", message: `infra ${b.used}/${b.limit}`};
    },
  };
  return {state, policy, calls, deps};
}

check("classifier: failed status and missing decision are no-verdict",
  isReviewerNoVerdict(TIMED_OUT) && isReviewerNoVerdict({status: "completed"})
  && !isReviewerNoVerdict(PASS) && !isReviewerNoVerdict(null));

// Timeout then PASS: reviewer retried, budget consumed once, no fix pass.
{
  const h = harness([PASS]);
  const r = await runFinalReviewFixRounds({state: h.state, policy: h.policy, initialReview: TIMED_OUT, initialFindings: [], deps: h.deps});
  check("timeout then PASS passes", r.outcome === "passed", JSON.stringify(r));
  check("no implementer fix pass on reviewer timeout", h.calls.fix === 0, h.calls.fix);
  check("reviewer retried once", h.calls.reviewer === 1 && h.calls.recorded === 1, JSON.stringify(h.calls));
  check("infrastructure budget consumed", h.state.failureBudgets?.["infrastructureRetryBudget:mission"] === 1, JSON.stringify(h.state.failureBudgets));
  check("no fix round consumed", !h.state.finalReviewFixRoundsUsed);
}

// Reviewer keeps timing out: escalates once the infra budget is exhausted.
{
  const h = harness([], 2);
  const r = await runFinalReviewFixRounds({state: h.state, policy: h.policy, initialReview: TIMED_OUT, initialFindings: [], deps: h.deps});
  check("exhausted infra budget escalates", r.outcome === "escalate" && r.step === "infra_escalated", JSON.stringify(r));
  check("exhausted: still no fix pass", h.calls.fix === 0);
  check("exhausted: reviewer retried budget-1 times", h.calls.reviewer === 1 && h.calls.recorded === 2, JSON.stringify(h.calls));
}

// FAIL with zero findings: treated as a reviewer failure, never a fix round.
{
  const h = harness([PASS]);
  const r = await runFinalReviewFixRounds({state: h.state, policy: h.policy, initialReview: EMPTY_FAIL, initialFindings: [], deps: {
    ...h.deps,
    recordReviewerFailure: async () => { h.calls.recorded += 1; return {allowed: true}; },
  }});
  check("zero-findings FAIL never dispatches a fix pass", h.calls.fix === 0 && r.outcome === "passed", JSON.stringify({calls: h.calls, r}));
  check("zero-findings FAIL re-runs the reviewer", h.calls.reviewer === 1 && h.calls.recorded === 1);
}

// Zero-findings FAIL with no recorder wired escalates (still no fix pass).
{
  const h = harness([]);
  const {recordReviewerFailure, ...deps} = h.deps;
  const r = await runFinalReviewFixRounds({state: h.state, policy: h.policy, initialReview: EMPTY_FAIL, initialFindings: [], deps});
  check("no recorder: escalate, no fix pass", r.outcome === "escalate" && h.calls.fix === 0 && h.calls.reviewer === 0, JSON.stringify(r));
}

// Real FAIL with findings still runs the fix pass (regression guard).
{
  const h = harness([PASS]);
  const r = await runFinalReviewFixRounds({state: h.state, policy: h.policy, initialReview: {status: "completed", review: {decision: "FAIL", findings: ["x"]}}, initialFindings: ["x"], deps: h.deps});
  check("FAIL with findings still dispatches the fix pass", h.calls.fix === 1 && r.outcome === "passed", JSON.stringify(h.calls));
}

console.log(`${ok} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("final-review infra no-verdict tests passed");
