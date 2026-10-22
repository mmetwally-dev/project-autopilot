#!/usr/bin/env node
// F3 — cross-mission state debris on a new request, and F7 — a supplied request
// must start a NEW mission instead of continuing the open one.
//
// The previous mission's state is seeded by hand with values tagged
// `OLD-MISSION-…`, then a DIFFERENT request is supplied. Everything that
// describes that dead mission (phase/task text, lastFailure, the failure-budget
// pointer, the policy violation, review feedback, the last review, the pending
// checkbox snapshot, a stale planning-review "passed", an unrecognised
// requirement token, the planning-review checkpoints) must not survive into the
// new mission's state.json — where it would surface in the watch report as if it
// belonged to the new mission, with a foreign phase and task text and a
// `lastFailure` that reads like a fresh silent stop.
//
// Content-based, not key-based: the new mission legitimately writes its own
// `lastFailure`/`feedback`/review keys, so the assertion is that NO value from
// the old mission survives anywhere, never that a key is merely absent.
//
// `failureBudgets` is deliberately excluded from the debris search because the
// old mission's seeded counter must be GONE afterwards: each new-mission start
// clears inherited failure counters via clearInheritedFailureCounters (asserted
// separately below by the seeded key's absence plus the helper line naming it).
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {
  makeFixtureRepo, makeFixtureBin, writeConfig, setScenario, runAutopilot, cleanup
} from "./test-fixtures/workflow-order-harness.mjs";
import {continuationBudgetKey, backstopLedgerKey} from "./per-task-budget.mjs";
import {hasSpentPlanningContinuations} from "./planning-continuation.mjs";

const AUTOPILOT_MJS = path.join(path.dirname(fileURLToPath(import.meta.url)), "autopilot.mjs");
const PLANNER_SCOPE = "task:standalone:planning:planner";
const REVIEWER_SCOPE = "task:standalone:planning:plan_reviewer";
const IMPL_SCOPE = "task:standalone:phase-1:T9.9";

function seedPlanningContinuationState(state) {
  state.continuationBudgets = {
    [continuationBudgetKey(PLANNER_SCOPE)]: 2,
    [continuationBudgetKey(REVIEWER_SCOPE)]: 1,
    [continuationBudgetKey(IMPL_SCOPE)]: 1,
  };
  state.noProgressGenerations = {[continuationBudgetKey(PLANNER_SCOPE)]: 1};
  state.rolloverDeadEnds = {[continuationBudgetKey(PLANNER_SCOPE)]: [{generation: 1, reason: "tokens"}]};
  state.planningProgressDigests = {[PLANNER_SCOPE]: "digest-old"};
  state.backstopFirings = {[backstopLedgerKey(PLANNER_SCOPE)]: [{generation: 1}]};
  state.lastContinuation = {key: continuationBudgetKey(PLANNER_SCOPE), scope: PLANNER_SCOPE, taskId: null};
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

const OLD = "OLD-MISSION";
const OLD_MISSION = "001-old-feature";
const NEW_REQUEST = "add a completely different health endpoint probe";
const MISSION_TIMEOUT_MS = process.platform === "win32" ? 180000 : 120000;

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

function readState(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
}

function seedOpenMissionWithDebris(repo) {
  const oldDir = path.join(repo, ".autopilot", "missions", OLD_MISSION);
  fs.mkdirSync(oldDir, {recursive: true});
  const oldTasks = path.join(oldDir, "TASKS.md");
  fs.writeFileSync(path.join(oldDir, "PLAN.md"), `# ${OLD}-PLAN\n`);
  fs.writeFileSync(oldTasks, `## Phase 1: ${OLD}-PHASE\n\n- [ ] ${OLD}-TASK\n`);
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
    version: 1,
    mission: OLD_MISSION, missionSeq: "001", planningRequest: "the old feature",
    phase: "escalated", step: "plan_review_exhausted", phaseIndex: 0, attempt: 2,
    planningStartedAt: "2020-01-01T00:00:00.000Z",
    currentPhase: `${OLD}-CURRENT-PHASE`, currentTask: `${OLD}-CURRENT-TASK`,
    feedback: `${OLD}-FEEDBACK`,
    lastFailure: {class: "PLANNING_REJECTED", domain: "planning", retryable: false,
      evidence: [{source: "attempt", message: `${OLD}-LAST-FAILURE`}]},
    lastFailureBudget: {budget: "implementationFailureBudget", scope: `${OLD}-SCOPE`, used: 2, limit: 3},
    relayPolicyViolation: `${OLD}-POLICY`,
    lastReview: {decision: "FAIL", findings: [{severity: "high", message: `${OLD}-LAST-REVIEW`}]},
    planningStateReview: {status: "passed", framework: "standalone", at: "2020-01-01T00:00:00.000Z"},
    // Valid shape for the standalone crash-recovery reconcile (mission-matching,
    // exact task text), so this fixture exercises the CLEAR, not the validator.
    pendingStandaloneCheckboxSnapshot: {feature: null, mission: OLD_MISSION,
      tasks: [{file: oldTasks, line: 3, text: `${OLD}-TASK`, done: false}],
      capturedAt: "2020-01-01T00:00:00.000Z"},
    unrecognisedRequirement: {token: `${OLD}-TOKEN`, role: "verifier"},
    phaseExecutionCheckpoint: {mission: `${OLD}-PHASE-CHECKPOINT`},
    standalonePlanningReviewCheckpoint: {mission: `${OLD}-REVIEW-CHECKPOINT`},
    failureBudgets: {[`${OLD}-BUDGET`]: 7}
  }, null, 2));
  // Mission 055 Phase 1 task 1.2: the dead mission also carries spent planner
  // continuation state (plus an implementer key that must survive the
  // takeover; failure counters are cleared separately for the new mission).
  {
    const seeded = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
    seedPlanningContinuationState(seeded);
    if (!seeded.failureBudgets) seeded.failureBudgets = {};
    fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(seeded, null, 2));
  }
}

const repo = makeFixtureRepo("f3-new-request");
const binDir = makeFixtureBin("f3-new-request");
try {
  writeConfig(repo, {planningFramework: "standalone"});
  seedOpenMissionWithDebris(repo);
  const seeded = readState(repo);
  check("setup: the fixture starts with a genuinely open mission carrying debris",
    seeded.phase === "escalated" && JSON.stringify(seeded).includes(`${OLD}-CURRENT-TASK`), seeded.phase);

  // The armed scenario stops the NEW mission at its own plan review — fast and
  // deterministic. The clear under test happens before any relay is launched, so
  // it does not depend on where the new mission later dies.
  setScenario(repo, "plan_review_infra_retryable_always");
  const run = runAutopilot(repo, binDir, {request: NEW_REQUEST, timeoutMs: MISSION_TIMEOUT_MS});
  const out = `${run.stdout || ""}${run.stderr || ""}`;
  const state = readState(repo);

  // F7 — the supplied, different request starts a new mission.
  check("F7: the supplied request is treated as a NEW mission, not a continuation",
    out.includes("NEW REQUEST DETECTED WHILE A PREVIOUS MISSION IS STILL OPEN")
    && out.includes("The open mission is being abandoned to start a new one."),
    out.slice(0, 900));
  check("F7: the old mission is abandoned (identity moved on)",
    state.mission !== OLD_MISSION && state.missionSeq !== "001",
    {mission: state.mission, missionSeq: state.missionSeq});
  check("F7: this run's planning intent is 'new', not 'resume'",
    state.planningIntent?.kind === "new", state.planningIntent);
  check("F7: the new request is recorded as the mission's request",
    String(state.planningRequest || "").includes("health endpoint"), state.planningRequest);

  // The loud takeover block: what is dropped, what survives, and the repair.
  check("notice: names the mission being abandoned, its position and its request",
    out.includes(`abandoning:  ${OLD_MISSION} (seq 001) — escalated/plan_review_exhausted`)
    && out.includes("its request: the old feature"), out.slice(0, 900));
  check("notice: echoes the new request that is taking over",
    out.includes(`new request: ${NEW_REQUEST}`), out.slice(0, 900));
  check("notice: says the mission directory and the files survive, nothing is reverted",
    out.includes("the abandoned mission's directory (audit record)")
    && out.includes("working tree is NOT reverted and nothing is deleted"), out.slice(0, 900));
  check("notice: lists spent counters as cleared below for the new mission",
    out.includes("cleared below for the new mission")
    && out.includes(`${OLD}-BUDGET = 7`), out.slice(0, 900));
  check("notice: prints the helper clear line naming the spent counter",
    out.includes("Failure counters cleared for the new mission:")
    && out.includes(`${OLD}-BUDGET`), out.slice(0, 2000));
  check("notice: banner never mentions carry-over",
    !out.includes("carry over"), out.slice(0, 2000));
  check("notice: points at ap cancel as the alternative",
    out.includes("alternative: ap cancel"), out.slice(0, 900));

  // F3 — no debris from the dead mission survives anywhere in state.json.
  // The search covers every key except `failureBudgets` (asserted separately
  // below: the seeded counter must be gone while the new mission may record
  // its own counters under the plan_review_infra_retryable_always scenario).
  const {failureBudgets: _clearedCounters, ...missionState} = state;
  const serialized = JSON.stringify(missionState);
  const leaked = [...new Set((serialized.match(new RegExp(`${OLD}[A-Z-]*`, "g")) || []))];
  check("F3: no OLD-MISSION debris survives in the new mission's state.json",
    leaked.length === 0, {leaked, tail: out.slice(-400)});

  // F3 — inherited failure counters are cleared for the new mission.
  check("F3: seeded failure counter is cleared for the new mission",
    !(state.failureBudgets && `${OLD}-BUDGET` in state.failureBudgets), state.failureBudgets);

  // Mission 055 Phase 1 task 1.2: the takeover clears spent planner
  // continuation state (banner lists it as cleared) while implementer keys
  // survive.
  check("055-1.2: new mission leaves no planning-scope continuation entries",
    planningDebrisLeft(state).length === 0, planningDebrisLeft(state));
  check("055-1.2: takeover banner lists planning continuation counters as cleared",
    out.includes("planning continuation counters cleared for the new mission")
    && out.includes(continuationBudgetKey(PLANNER_SCOPE)), out.slice(0, 1600));
  check("055-1.2: implementer continuation keys are cleared by the takeover (backlog #80)",
    state.continuationBudgets?.[continuationBudgetKey(IMPL_SCOPE)] === undefined, state.continuationBudgets);
  check("055-1.2: takeover prints the continuation allowances cleared line naming the implementer key",
    out.includes("Continuation allowances cleared for the new mission:")
    && out.includes(continuationBudgetKey(IMPL_SCOPE)), out.slice(0, 1600));
} finally {
  cleanup(repo, binDir);
}

// Same takeover, but with a clean failure budget: the notice must say so
// instead of printing a "still spent" list, and must never imply the new
// mission is at risk of an instant escalation it is not exposed to.
{
  const repo2 = makeFixtureRepo("f3-clean-budget");
  const binDir2 = makeFixtureBin("f3-clean-budget");
  try {
    writeConfig(repo2, {planningFramework: "standalone"});
    fs.writeFileSync(path.join(repo2, ".autopilot", "state.json"), JSON.stringify({
      version: 1, mission: "001-clean", missionSeq: "001", planningRequest: "the old feature",
      phase: "implementing", step: "code_review", attempt: 1
    }, null, 2));
    setScenario(repo2, "plan_review_infra_retryable_always");
    const run2 = runAutopilot(repo2, binDir2, {request: NEW_REQUEST, timeoutMs: MISSION_TIMEOUT_MS});
    const out2 = `${run2.stdout || ""}${run2.stderr || ""}`;
    check("notice: with no counters spent it says the budget is clean",
      out2.includes("none spent — the new mission starts with a clean failure budget."), out2.slice(0, 900));
    check("notice: and then never mentions carry-over",
      !out2.includes("carry over"), out2.slice(0, 900));
  } finally {
    cleanup(repo2, binDir2);
  }
}

// Mission 055 Phase 1 task 1.2: failure budget clean but planner
// continuations spent — the banner must list the planning counters as
// cleared and must NOT claim "none spent" (none-spent depends on both).
{
  const repo3 = makeFixtureRepo("f3-planning-spent");
  const binDir3 = makeFixtureBin("f3-planning-spent");
  try {
    writeConfig(repo3, {planningFramework: "standalone"});
    const seeded3 = {
      version: 1, mission: "001-planning-spent", missionSeq: "001", planningRequest: "the old feature",
      phase: "implementing", step: "code_review", attempt: 1,
      failureBudgets: {},
    };
    seedPlanningContinuationState(seeded3);
    delete seeded3.continuationBudgets[continuationBudgetKey(IMPL_SCOPE)];
    fs.writeFileSync(path.join(repo3, ".autopilot", "state.json"), JSON.stringify(seeded3, null, 2));
    check("setup: planning-spent fixture really is planning-spent",
      hasSpentPlanningContinuations(JSON.parse(fs.readFileSync(path.join(repo3, ".autopilot", "state.json"), "utf8"))));
    setScenario(repo3, "plan_review_infra_retryable_always");
    const run3 = runAutopilot(repo3, binDir3, {request: NEW_REQUEST, timeoutMs: MISSION_TIMEOUT_MS});
    const out3 = `${run3.stdout || ""}${run3.stderr || ""}`;
    const state3 = readState(repo3);
    check("055-1.2: banner lists planning continuation counters as cleared (failure budget clean)",
      out3.includes("planning continuation counters cleared for the new mission")
      && out3.includes(continuationBudgetKey(PLANNER_SCOPE)), out3.slice(0, 1600));
    check("055-1.2: 'none spent' is NOT claimed when planning continuations were spent",
      !out3.includes("none spent — the new mission starts with a clean failure budget."), out3.slice(0, 1600));
    check("055-1.2: new mission leaves no planning-scope continuation entries (failure-clean takeover)",
      planningDebrisLeft(state3).length === 0, planningDebrisLeft(state3));
  } finally {
    cleanup(repo3, binDir3);
  }
}

// Mission 055 Phase 1 task 1.2: `ap cancel` clears spent planner
// continuation state while implementer keys and failureBudgets survive.
{
  const repo4 = makeFixtureRepo("f3-cancel-planning");
  try {
    writeConfig(repo4, {planningFramework: "standalone"});
    const seeded4 = {
      version: 1, mission: "001-cancel-me", missionSeq: "001", planningRequest: "the cancellable feature",
      phase: "implementing", step: "code_review", attempt: 1,
      failureBudgets: {someCounter: 2},
    };
    seedPlanningContinuationState(seeded4);
    fs.writeFileSync(path.join(repo4, ".autopilot", "state.json"), JSON.stringify(seeded4, null, 2));
    const cancel = spawnSync(process.execPath, [AUTOPILOT_MJS, "cancel", "--yes", "--repo", repo4],
      {encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"]});
    check("055-1.2: ap cancel exits 0", cancel.status === 0, {status: cancel.status, stderr: (cancel.stderr || "").slice(0, 300)});
    const state4 = readState(repo4);
    check("055-1.2: cancel leaves no planning-scope continuation entries",
      planningDebrisLeft(state4).length === 0, planningDebrisLeft(state4));
    check("055-1.2: cancel keeps implementer continuation keys",
      state4.continuationBudgets?.[continuationBudgetKey(IMPL_SCOPE)] === 1, state4.continuationBudgets);
    check("055-1.2: cancel itself keeps failure counters (next new mission clears them)",
      state4.failureBudgets?.someCounter === 2, state4.failureBudgets);
    check("055-1.2: cancel still marks the mission cancelled",
      state4.phase === "cancelled" && state4.step === "cancelled", {phase: state4.phase, step: state4.step});
  } finally {
    cleanup(repo4);
  }
}

// Mission 093 task 1.3: a new mission carries no prior cancel line, reset
// record or escalation record — the takeover clears lastCancelled,
// lastReset and lastContinuation unconditionally (including an
// implementer-scope lastContinuation that clearPlanningContinuations keeps).
{
  const repo5 = makeFixtureRepo("f3-hygiene-093");
  const binDir5 = makeFixtureBin("f3-hygiene-093");
  try {
    writeConfig(repo5, {planningFramework: "standalone"});
    fs.writeFileSync(path.join(repo5, ".autopilot", "state.json"), JSON.stringify({
      version: 1, mission: "001-hygiene-old", missionSeq: "001", planningRequest: "the old feature",
      phase: "escalated", step: "plan_review_exhausted", attempt: 2,
      lastCancelled: {at: "2020-01-01T00:00:00.000Z", reason: "OLD-CANCEL-REASON",
        previousPhase: "escalated", previousStep: "implement", mission: "001-hygiene-old"},
      lastReset: {at: "2020-01-01T00:00:00.000Z", scope: "OLD-RESET-SCOPE",
        clearedUsed: 3, clearedLimit: 5, failure: null, role: null, adapter: null, appliedLive: false},
      lastContinuation: {key: continuationBudgetKey(IMPL_SCOPE), scope: IMPL_SCOPE,
        taskId: "T9.9", mission: "001-hygiene-old", taskRef: "T9.9", at: "2020-01-01T00:00:00.000Z"},
    }, null, 2));
    setScenario(repo5, "plan_review_infra_retryable_always");
    const run5 = runAutopilot(repo5, binDir5, {request: NEW_REQUEST, timeoutMs: MISSION_TIMEOUT_MS});
    const out5 = `${run5.stdout || ""}${run5.stderr || ""}`;
    const state5 = readState(repo5);
    check("093-1.3: takeover happened for the hygiene fixture",
      out5.includes("NEW REQUEST DETECTED WHILE A PREVIOUS MISSION IS STILL OPEN")
      && state5.mission !== "001-hygiene-old", {mission: state5.mission});
    check("093-1.3: new mission carries no prior cancel line",
      !("lastCancelled" in state5), state5.lastCancelled);
    check("093-1.3: new mission carries no prior reset record",
      !("lastReset" in state5), state5.lastReset);
    check("093-1.3: new mission carries no prior escalation record (implementer-scope continuation)",
      !("lastContinuation" in state5), state5.lastContinuation);
  } finally {
    cleanup(repo5, binDir5);
  }
}

if (failures) {
  console.error(`${failures} new-request isolation check(s) failed.`);
  process.exit(1);
}
console.log("test-new-request-state-isolation: ALL CHECKS PASSED");
