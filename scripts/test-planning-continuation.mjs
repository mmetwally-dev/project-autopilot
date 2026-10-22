#!/usr/bin/env node
// Mission 031 Phase 6 task 6.1: unit tests for handlePlanningContinuation
// in isolation (no autopilot import) for both triggers.
import {
  handlePlanningContinuation,
  clearPlanningContinuations,
  hasSpentPlanningContinuations,
  isPlanningContinuationScope,
} from "./planning-continuation.mjs";
import {
  readRolloverDeadEnds,
  resolvePerRoleLimits,
  continuationBudgetKey,
  backstopLedgerKey,
} from "./per-task-budget.mjs";

let ok = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`PASS ${name}`); ok++; return; }
  console.error(`FAIL ${name}${detail ? ` :: ${JSON.stringify(detail)}` : ""}`);
  failed++;
}

// --- capped trigger consumes continuationAllowance and records dead end ---
{
  const s = {};
  const relayResult = {capped: {type: "tokens", used: 500001, limit: 500000}};
  const cont = handlePlanningContinuation(s, "planner", relayResult, "task:standalone:planning:planner", {}, "capped");
  const expected = resolvePerRoleLimits("planner", {}).continuationAllowance;
  check("capped: returns continuation decision (allowed, used=1)", cont !== null && cont.allowed === true && cont.used === 1, cont);
  check("capped: continuationAllowance consumed from resolvePerRoleLimits", cont !== null && cont.limit === expected && expected === 2, {cont, expected});
  const ends = readRolloverDeadEnds(s, "task:standalone:planning:planner");
  check("capped: dead end recorded with cap reason", ends.length === 1 && ends[0].reason === "tokens" && ends[0].generation === 1, ends);
}

// --- capped trigger without a breach consumes nothing ---
{
  const s = {};
  const cont = handlePlanningContinuation(s, "planner", {status: "completed"}, "task:standalone:planning:planner", {}, "capped");
  check("capped: no breach returns null", cont === null, cont);
  check("capped: no breach consumes no allowance", !s.continuationBudgets || Object.keys(s.continuationBudgets).length === 0, s.continuationBudgets);
  check("capped: no breach records no dead end", readRolloverDeadEnds(s, "task:standalone:planning:planner").length === 0);
}

// --- incomplete trigger consumes continuationAllowance and records dead end ---
{
  const s = {};
  const cont = handlePlanningContinuation(s, "planner", {status: "completed"}, "task:standalone:planning:planner", {}, "incomplete");
  const expected = resolvePerRoleLimits("planner", {}).continuationAllowance;
  check("incomplete: returns continuation decision (allowed, used=1)", cont !== null && cont.allowed === true && cont.used === 1, cont);
  check("incomplete: continuationAllowance consumed from resolvePerRoleLimits", cont !== null && cont.limit === expected && expected === 2, {cont, expected});
  const ends = readRolloverDeadEnds(s, "task:standalone:planning:planner");
  check("incomplete: dead end recorded with reason incomplete", ends.length === 1 && ends[0].reason === "incomplete" && ends[0].generation === 1, ends);
}

// --- exhaustion: 3rd generation refused by default allowance (2) for both triggers ---
{
  const s = {};
  const cap = {capped: {type: "turns", used: 23, limit: 22}};
  handlePlanningContinuation(s, "plan_reviewer", cap, "task:standalone:planning:plan_reviewer", {}, "capped");
  handlePlanningContinuation(s, "plan_reviewer", cap, "task:standalone:planning:plan_reviewer", {}, "capped");
  const third = handlePlanningContinuation(s, "plan_reviewer", cap, "task:standalone:planning:plan_reviewer", {}, "capped");
  check("capped: 3rd consume refused at default allowance 2", third.allowed === false && third.used === 3 && third.limit === 2, third);

  const s2 = {};
  handlePlanningContinuation(s2, "planner", {}, "task:standalone:planning:planner", {}, "incomplete");
  handlePlanningContinuation(s2, "planner", {}, "task:standalone:planning:planner", {}, "incomplete");
  const third2 = handlePlanningContinuation(s2, "planner", {}, "task:standalone:planning:planner", {}, "incomplete");
  check("incomplete: 3rd consume refused at default allowance 2", third2.allowed === false && third2.used === 3 && third2.limit === 2, third2);
}

// --- policy override flows through to the consumed allowance ---
{
  const s = {};
  const policy = {caps: {planner: {max_turns: 22, max_tokens: 500000, extra_sessions: 1}}};
  const first = handlePlanningContinuation(s, "planner", {}, "task:standalone:planning:planner", policy, "incomplete");
  check("override: custom extra_sessions=1 honored", first.limit === 1 && first.allowed === true, first);
  const second = handlePlanningContinuation(s, "planner", {}, "task:standalone:planning:planner", policy, "incomplete");
  check("override: 2nd consume refused at allowance 1", second.allowed === false && second.used === 2, second);
}

// --- invalid trigger rejected ---
{
  let code = null;
  try { handlePlanningContinuation({}, "planner", {}, "scope", {}, "bogus"); }
  catch (e) { code = e?.code; }
  check("invalid trigger throws INVALID_PLANNING_TRIGGER", code === "INVALID_PLANNING_TRIGGER", code);
}

// --- Mission 055 task 1.1: clearPlanningContinuations drops planning keys, keeps implementer + failureBudgets ---
{
  const plannerScope = "task:standalone:planning:planner";
  const reviewerScope = "task:standalone:planning:plan_reviewer";
  const implScope = "task:standalone:phase-1:T1.1";
  const s = {
    continuationBudgets: {
      [continuationBudgetKey(plannerScope)]: 2,
      [continuationBudgetKey(reviewerScope)]: 1,
      [continuationBudgetKey(implScope)]: 3,
    },
    noProgressGenerations: {
      [continuationBudgetKey(plannerScope)]: 1,
      [continuationBudgetKey(implScope)]: 2,
    },
    rolloverDeadEnds: {
      [continuationBudgetKey(plannerScope)]: [{generation: 1, reason: "tokens"}],
      [continuationBudgetKey(reviewerScope)]: [{generation: 1, reason: "incomplete"}],
      [continuationBudgetKey(implScope)]: [{generation: 3, reason: "turns"}],
    },
    planningProgressDigests: {
      [plannerScope]: "digest-a",
      [reviewerScope]: "digest-b",
    },
    backstopFirings: {
      [backstopLedgerKey(plannerScope)]: [{generation: 1}],
      [backstopLedgerKey(reviewerScope)]: [{generation: 2}],
      [backstopLedgerKey(implScope)]: [{generation: 1}],
    },
    lastContinuation: {key: continuationBudgetKey(plannerScope), scope: plannerScope, taskId: null},
    failureBudgets: {"task:standalone:phase-1:T1.1": 2},
  };
  check("clear: spent predicate true before clear", hasSpentPlanningContinuations(s) === true, s);
  const cleared = clearPlanningContinuations(s);
  check("clear: drops 10 planning entries (2 budgets + 1 noProgress + 2 deadEnds + 2 digests + 2 backstop + lastContinuation)", cleared === 10, cleared);
  check("clear: planning continuationBudgets dropped", !(continuationBudgetKey(plannerScope) in s.continuationBudgets) && !(continuationBudgetKey(reviewerScope) in s.continuationBudgets), s.continuationBudgets);
  check("clear: implementer continuationBudget survives", s.continuationBudgets[continuationBudgetKey(implScope)] === 3, s.continuationBudgets);
  check("clear: planning noProgress dropped, implementer survives", !(continuationBudgetKey(plannerScope) in s.noProgressGenerations) && s.noProgressGenerations[continuationBudgetKey(implScope)] === 2, s.noProgressGenerations);
  check("clear: planning deadEnds dropped, implementer survives", !(continuationBudgetKey(plannerScope) in s.rolloverDeadEnds) && !(continuationBudgetKey(reviewerScope) in s.rolloverDeadEnds) && Array.isArray(s.rolloverDeadEnds[continuationBudgetKey(implScope)]), s.rolloverDeadEnds);
  check("clear: planning digests dropped", Object.keys(s.planningProgressDigests).length === 0, s.planningProgressDigests);
  check("clear: planning backstop ledgers dropped, implementer survives", !(backstopLedgerKey(plannerScope) in s.backstopFirings) && !(backstopLedgerKey(reviewerScope) in s.backstopFirings) && Array.isArray(s.backstopFirings[backstopLedgerKey(implScope)]), s.backstopFirings);
  check("clear: planning lastContinuation dropped", s.lastContinuation === undefined, s.lastContinuation);
  check("clear: failureBudgets untouched", s.failureBudgets["task:standalone:phase-1:T1.1"] === 2, s.failureBudgets);
  check("clear: spent predicate false after clear", hasSpentPlanningContinuations(s) === false, s);
  check("clear: second clear drops nothing", clearPlanningContinuations(s) === 0, null);
}

// --- Mission 055 task 1.1: lastContinuation with non-planning scope survives ---
{
  const implScope = "task:standalone:phase-1:T1.1";
  const s = {lastContinuation: {key: continuationBudgetKey(implScope), scope: implScope, taskId: "T1.1"}};
  check("clear: non-planning lastContinuation survives", clearPlanningContinuations(s) === 0 && s.lastContinuation?.scope === implScope, s);
  check("clear: spent predicate false for implementer-only state", hasSpentPlanningContinuations(s) === false, s);
  check("scope predicate: planner/reviewer true, implementer false",
    isPlanningContinuationScope("task:standalone:planning:planner") === true
    && isPlanningContinuationScope("task:standalone:planning:plan_reviewer") === true
    && isPlanningContinuationScope(implScope) === false
    && isPlanningContinuationScope(null) === false, null);
}

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
