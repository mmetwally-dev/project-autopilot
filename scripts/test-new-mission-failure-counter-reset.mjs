#!/usr/bin/env node
// Mission 060 Phase 1 task 1.3: a new mission must not inherit the previous
// mission's spent failure counters, while a same-mission resume keeps them.
//
// Fixture-repo subprocess test (no model, no process.on("exit")). Each case
// seeds `failureBudgets` with a distinctive counter key, then runs the real
// `node scripts/autopilot.mjs run ...` subprocess against the fake workflow
// adapter (`plan_review_infra_retryable_always` scenario):
//   (a) new request after a completed mission -> seeded key absent + helper
//       line naming it,
//   (b) new request after a cancelled mission -> seeded key absent + helper
//       line naming it,
//   (c) new request while a mission is still open (takeover) -> seeded key
//       absent + helper line naming it (the new mission may record its OWN
//       counters, so `failureBudgets` need not be `{}` afterwards),
//   (d) same request against the open mission (resume) -> seeded value KEPT
//       and no helper line printed.
//
// The discriminating assertion in (a)-(c) is the seeded key's absence plus
// the printed `Failure counters cleared for the new mission: <key>` line;
// in (d) it is the seeded value surviving with the helper line absent.
import fs from "node:fs";
import path from "node:path";
import {
  makeFixtureRepo, makeFixtureBin, writeConfig, setScenario, runAutopilot, cleanup
} from "./test-fixtures/workflow-order-harness.mjs";

const OLD_REQUEST = "the old feature";
const NEW_REQUEST = "add a completely different health endpoint probe";
// A realistic budget key under a scope no fixture run records itself, and
// without ":task:standalone:" (which clearStaleStandaloneBudgets deletes).
const SEED_KEY = "implementationFailureBudget:seeded-old-scope";
const SEED_VALUE = 2;
const CONT_KEY = "continuationAllowance:task:seeded-old-scope:verifier";
const CONT_LINE = `Continuation allowances cleared for the new mission: ${CONT_KEY}`;
const HELPER_LINE = `Failure counters cleared for the new mission: ${SEED_KEY}`;
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

function seedTerminalState(repo, {phase, step}) {
  // Terminal mission with no mission directory on disk, so standalone
  // planning detection reports "missing" and the run takes the
  // post-complete/cancelled `if(isNewRequest)` branch.
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
    version: 1, mission: "001-done", missionSeq: "001", planningRequest: OLD_REQUEST,
    phase, step, attempt: 1,
    failureBudgets: {[SEED_KEY]: SEED_VALUE}, continuationBudgets: {[CONT_KEY]: 1},
  }, null, 2));
}

function seedOpenMission(repo) {
  const oldMission = "001-open-mission";
  const oldDir = path.join(repo, ".autopilot", "missions", oldMission);
  fs.mkdirSync(oldDir, {recursive: true});
  const oldTasks = path.join(oldDir, "TASKS.md");
  fs.writeFileSync(path.join(oldDir, "PLAN.md"), "# OPEN-MISSION-PLAN\n");
  fs.writeFileSync(oldTasks, "## Phase 1: OPEN-MISSION-PHASE\n\n- [ ] OPEN-MISSION-TASK\n");
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
    version: 1, mission: oldMission, missionSeq: "001", planningRequest: OLD_REQUEST,
    phase: "implementing", step: "code_review", phaseIndex: 0, attempt: 1,
    currentPhase: "OPEN-MISSION-PHASE", currentTask: "OPEN-MISSION-TASK",
    pendingStandaloneCheckboxSnapshot: {feature: null, mission: oldMission,
      tasks: [{file: oldTasks, line: 3, text: "OPEN-MISSION-TASK", done: false}],
      capturedAt: "2020-01-01T00:00:00.000Z"},
    failureBudgets: {[SEED_KEY]: SEED_VALUE}, continuationBudgets: {[CONT_KEY]: 1},
  }, null, 2));
}

function checkCleared({label, out, state}) {
  check(`${label}: seeded failure counter key is absent`,
    !(state.failureBudgets && SEED_KEY in state.failureBudgets), state.failureBudgets);
  check(`${label}: seeded continuation allowance is absent`,
    !(state.continuationBudgets && CONT_KEY in state.continuationBudgets), state.continuationBudgets);
  check(`${label}: continuation line names the key`, out.includes(CONT_LINE), out.slice(-600));
  check(`${label}: helper line names the seeded key`, out.includes(HELPER_LINE), out.slice(-600));
}

// (a) New request after a completed mission.
{
  const repo = makeFixtureRepo("fc-reset-post-complete");
  const binDir = makeFixtureBin("fc-reset-post-complete");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    seedTerminalState(repo, {phase: "complete", step: "human_commit"});
    setScenario(repo, "plan_review_infra_retryable_always");
    const run = runAutopilot(repo, binDir, {request: NEW_REQUEST, timeoutMs: MISSION_TIMEOUT_MS});
    const out = `${run.stdout || ""}${run.stderr || ""}`;
    const state = readState(repo);
    check("post-complete: run starts a new mission",
      out.includes("New request detected — starting a new mission."), out.slice(0, 500));
    checkCleared({label: "post-complete", out, state});
  } finally {
    cleanup(repo, binDir);
  }
}

// (b) New request after a cancelled mission.
{
  const repo = makeFixtureRepo("fc-reset-post-cancel");
  const binDir = makeFixtureBin("fc-reset-post-cancel");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    seedTerminalState(repo, {phase: "cancelled", step: "cancelled"});
    setScenario(repo, "plan_review_infra_retryable_always");
    const run = runAutopilot(repo, binDir, {request: NEW_REQUEST, timeoutMs: MISSION_TIMEOUT_MS});
    const out = `${run.stdout || ""}${run.stderr || ""}`;
    const state = readState(repo);
    check("post-cancel: run starts a new mission",
      out.includes("New request detected — starting a new mission."), out.slice(0, 500));
    checkCleared({label: "post-cancel", out, state});
  } finally {
    cleanup(repo, binDir);
  }
}

// (c) New (different) request while a mission is still open: takeover.
{
  const repo = makeFixtureRepo("fc-reset-takeover");
  const binDir = makeFixtureBin("fc-reset-takeover");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    seedOpenMission(repo);
    setScenario(repo, "plan_review_infra_retryable_always");
    const run = runAutopilot(repo, binDir, {request: NEW_REQUEST, timeoutMs: MISSION_TIMEOUT_MS});
    const out = `${run.stdout || ""}${run.stderr || ""}`;
    const state = readState(repo);
    check("takeover: the different request abandons the open mission",
      out.includes("NEW REQUEST DETECTED WHILE A PREVIOUS MISSION IS STILL OPEN"), out.slice(0, 500));
    checkCleared({label: "takeover", out, state});
  } finally {
    cleanup(repo, binDir);
  }
}

// (d) Same request against the open mission: resume keeps the counters.
{
  const repo = makeFixtureRepo("fc-reset-resume");
  const binDir = makeFixtureBin("fc-reset-resume");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    seedOpenMission(repo);
    setScenario(repo, "plan_review_infra_retryable_always");
    const run = runAutopilot(repo, binDir, {request: OLD_REQUEST, timeoutMs: MISSION_TIMEOUT_MS});
    const out = `${run.stdout || ""}${run.stderr || ""}`;
    const state = readState(repo);
    check("resume: same request does not start a new mission",
      !out.includes("NEW REQUEST DETECTED WHILE A PREVIOUS MISSION IS STILL OPEN")
      && !out.includes("New request detected — starting a new mission."), out.slice(0, 500));
    check("resume: no failure-counter clear line is printed",
      !out.includes("Failure counters cleared for the new mission:"), out.slice(-600));
    check("resume: continuation allowance kept and no clear line",
      state.continuationBudgets?.[CONT_KEY] === 1 && !out.includes("Continuation allowances cleared"), state.continuationBudgets);
    check("resume: seeded failure counter value is kept",
      state.failureBudgets?.[SEED_KEY] === SEED_VALUE, state.failureBudgets);
  } finally {
    cleanup(repo, binDir);
  }
}

if (failures) {
  console.error(`${failures} new-mission failure-counter-reset check(s) failed.`);
  process.exit(1);
}
console.log("test-new-mission-failure-counter-reset: ALL CHECKS PASSED");
