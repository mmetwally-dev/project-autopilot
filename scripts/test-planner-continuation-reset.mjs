#!/usr/bin/env node
// Mission 055 Phase 1 task 1.3: planner continuation state resets on mission
// boundaries. Seeds mission-A planner continuation state, then (case 1)
// starts mission B with a different request and (case 2) runs `ap cancel` —
// asserting a full planner allowance and empty dead-ends in both cases while
// implementer continuation keys survive in both cases and failureBudgets
// survive the `ap cancel` case only (takeover counter clearing is covered by
// scripts/test-new-mission-failure-counter-reset.mjs).
//
// Fails before the 1.1/1.2 fix (planning-scope entries leak across the
// boundary, so the allowance probe starts spent and dead-ends are non-empty);
// passes after.
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {
  makeFixtureRepo, makeFixtureBin, writeConfig, setScenario, runAutopilot, cleanup
} from "./test-fixtures/workflow-order-harness.mjs";
import {
  continuationBudgetKey, backstopLedgerKey, readRolloverDeadEnds,
  resolvePerRoleLimits, consumeContinuation,
} from "./per-task-budget.mjs";
import {hasSpentPlanningContinuations} from "./planning-continuation.mjs";

const AUTOPILOT_MJS = path.join(path.dirname(fileURLToPath(import.meta.url)), "autopilot.mjs");
const PLANNER_SCOPE = "task:standalone:planning:planner";
const REVIEWER_SCOPE = "task:standalone:planning:plan_reviewer";
const IMPL_SCOPE = "task:standalone:phase-1:T9.9";
const IMPL_BUDGET_VALUE = 1;
const FAILURE_COUNTER = "mission-a-counter";
const FAILURE_VALUE = 4;

const NEW_REQUEST = "add a completely different health endpoint probe";
const MISSION_TIMEOUT_MS = process.platform === "win32" ? 180000 : 120000;

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

function seedMissionAContinuationState(state) {
  state.continuationBudgets = {
    [continuationBudgetKey(PLANNER_SCOPE)]: 2,
    [continuationBudgetKey(REVIEWER_SCOPE)]: 1,
    [continuationBudgetKey(IMPL_SCOPE)]: IMPL_BUDGET_VALUE,
  };
  state.noProgressGenerations = {[continuationBudgetKey(PLANNER_SCOPE)]: 1};
  state.rolloverDeadEnds = {
    [continuationBudgetKey(PLANNER_SCOPE)]: [{generation: 2, reason: "tokens"}],
    [continuationBudgetKey(REVIEWER_SCOPE)]: [{generation: 1, reason: "incomplete"}],
  };
  state.planningProgressDigests = {[PLANNER_SCOPE]: "digest-mission-a"};
  state.backstopFirings = {[backstopLedgerKey(PLANNER_SCOPE)]: [{generation: 2}]};
  state.lastContinuation = {key: continuationBudgetKey(PLANNER_SCOPE), scope: PLANNER_SCOPE, taskId: null};
  state.failureBudgets = {[FAILURE_COUNTER]: FAILURE_VALUE};
  return state;
}

function planningDebrisLeft(state) {
  const left = [];
  for (const [map, keys] of [
    ["continuationBudgets", [continuationBudgetKey(PLANNER_SCOPE), continuationBudgetKey(REVIEWER_SCOPE)]],
    ["noProgressGenerations", [continuationBudgetKey(PLANNER_SCOPE), continuationBudgetKey(REVIEWER_SCOPE)]],
    ["rolloverDeadEnds", [continuationBudgetKey(PLANNER_SCOPE), continuationBudgetKey(REVIEWER_SCOPE)]],
  ]) {
    for (const key of keys) {
      if (state[map] && typeof state[map] === "object" && key in state[map]) left.push(`${map}:${key}`);
    }
  }
  for (const scope of [PLANNER_SCOPE, REVIEWER_SCOPE]) {
    if (state.planningProgressDigests && typeof state.planningProgressDigests === "object" && scope in state.planningProgressDigests) left.push(`planningProgressDigests:${scope}`);
    const ledger = backstopLedgerKey(scope);
    if (state.backstopFirings && typeof state.backstopFirings === "object" && ledger in state.backstopFirings) left.push(`backstopFirings:${ledger}`);
  }
  if (state.lastContinuation && typeof state.lastContinuation === "object"
    && [PLANNER_SCOPE, REVIEWER_SCOPE].includes(String(state.lastContinuation.scope || ""))) left.push(`lastContinuation:${state.lastContinuation.scope}`);
  return left;
}

function readState(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
}

// Full allowance + empty dead-ends for both planning scopes, with the
// implementer key surviving in both cases. Failure counters survive only the
// cancel boundary; the takeover boundary's counter clearing is covered by
// scripts/test-new-mission-failure-counter-reset.mjs.
function checkPlanningReset(state, label) {
  check(`${label}: no planning-scope continuation entries survive`, planningDebrisLeft(state).length === 0, planningDebrisLeft(state));
  check(`${label}: shared spent predicate is false`, hasSpentPlanningContinuations(state) === false);
  check(`${label}: planner dead-ends are empty`, readRolloverDeadEnds(state, PLANNER_SCOPE).length === 0, readRolloverDeadEnds(state, PLANNER_SCOPE));
  check(`${label}: plan_reviewer dead-ends are empty`, readRolloverDeadEnds(state, REVIEWER_SCOPE).length === 0, readRolloverDeadEnds(state, REVIEWER_SCOPE));
  // Full allowance: a fresh planner generation on a copy starts at used=1
  // within the role's allowance (the seeded used=2 would start at 3/refused).
  const allowance = resolvePerRoleLimits("planner", {}).continuationAllowance;
  const probe = consumeContinuation(JSON.parse(JSON.stringify(state)), {}, PLANNER_SCOPE, allowance);
  check(`${label}: planner starts with a full allowance (used=1, allowed)`,
    probe.used === 1 && probe.allowed === true && probe.limit === allowance, probe);
  const reviewerAllowance = resolvePerRoleLimits("plan_reviewer", {}).continuationAllowance;
  const reviewerProbe = consumeContinuation(JSON.parse(JSON.stringify(state)), {}, REVIEWER_SCOPE, reviewerAllowance);
  check(`${label}: plan_reviewer starts with a full allowance (used=1, allowed)`,
    reviewerProbe.used === 1 && reviewerProbe.allowed === true && reviewerProbe.limit === reviewerAllowance, reviewerProbe);
  // Backlog #80: a new mission (takeover) also clears every continuation
  // allowance; only the cancel boundary keeps the implementer key.
  const implKept = state.continuationBudgets?.[continuationBudgetKey(IMPL_SCOPE)] === IMPL_BUDGET_VALUE;
  if(label === "cancel") check(`${label}: implementer continuation key survives`, implKept, state.continuationBudgets);
  else check(`${label}: implementer continuation key is cleared (new mission)`, !implKept, state.continuationBudgets);
  // Failure-counter cross-mission ownership lives in
  // scripts/test-new-mission-failure-counter-reset.mjs: the takeover case no
  // longer asserts survival here; the cancel pin below stays.
  if(label === "cancel") {
    check(`${label}: failure budgets survive (pinned inheritance)`,
      state.failureBudgets?.[FAILURE_COUNTER] === FAILURE_VALUE, state.failureBudgets);
  }
}

// Case 1: mission A carries spent planner continuation state; a different
// request starts mission B, which must reset to a full planner allowance.
{
  const repo = makeFixtureRepo("planner-reset-takeover");
  const binDir = makeFixtureBin("planner-reset-takeover");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    const oldMission = "001-mission-a";
    const oldDir = path.join(repo, ".autopilot", "missions", oldMission);
    fs.mkdirSync(oldDir, {recursive: true});
    const oldTasks = path.join(oldDir, "TASKS.md");
    fs.writeFileSync(path.join(oldDir, "PLAN.md"), "# MISSION-A-PLAN\n");
    fs.writeFileSync(oldTasks, "## Phase 1: MISSION-A-PHASE\n\n- [ ] MISSION-A-TASK\n");
    const seeded = seedMissionAContinuationState({
      version: 1, mission: oldMission, missionSeq: "001", planningRequest: "the mission A feature",
      phase: "implementing", step: "code_review", phaseIndex: 0, attempt: 1,
      currentPhase: "MISSION-A-PHASE", currentTask: "MISSION-A-TASK",
      pendingStandaloneCheckboxSnapshot: {feature: null, mission: oldMission,
        tasks: [{file: oldTasks, line: 3, text: "MISSION-A-TASK", done: false}],
        capturedAt: "2020-01-01T00:00:00.000Z"},
    });
    fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(seeded, null, 2));
    check("takeover setup: mission A really carries spent planner state",
      hasSpentPlanningContinuations(readState(repo)) === true);

    setScenario(repo, "plan_review_infra_retryable_always");
    const run = runAutopilot(repo, binDir, {request: NEW_REQUEST, timeoutMs: MISSION_TIMEOUT_MS});
    const state = readState(repo);
    check("takeover: the supplied request starts mission B, not a continuation",
      state.mission !== oldMission && state.missionSeq !== "001",
      {mission: state.mission, missionSeq: state.missionSeq});
    checkPlanningReset(state, "takeover: mission B");
  } finally {
    cleanup(repo, binDir);
  }
}

// Case 2: `ap cancel` clears spent planner continuation state while the
// implementer key and failure counters survive.
{
  const repo = makeFixtureRepo("planner-reset-cancel");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    const seeded = seedMissionAContinuationState({
      version: 1, mission: "001-cancellable", missionSeq: "001", planningRequest: "the cancellable feature",
      phase: "implementing", step: "code_review", attempt: 1,
    });
    fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(seeded, null, 2));
    check("cancel setup: mission really carries spent planner state",
      hasSpentPlanningContinuations(readState(repo)) === true);

    const cancel = spawnSync(process.execPath, [AUTOPILOT_MJS, "cancel", "--yes", "--repo", repo],
      {encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"]});
    check("cancel: ap cancel exits 0", cancel.status === 0, {status: cancel.status, stderr: (cancel.stderr || "").slice(0, 300)});
    const state = readState(repo);
    checkPlanningReset(state, "cancel");
    check("cancel: still marks the mission cancelled",
      state.phase === "cancelled" && state.step === "cancelled", {phase: state.phase, step: state.step});
  } finally {
    cleanup(repo);
  }
}

if (failures) {
  console.error(`${failures} planner-continuation-reset check(s) failed.`);
  process.exit(1);
}
console.log("test-planner-continuation-reset: ALL CHECKS PASSED");
