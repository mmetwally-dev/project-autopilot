#!/usr/bin/env node
// Mission 099 Phase 2 task 2.3 — consuming the standalone plan-approval pause.
//
// The first `ap run` pauses at `plan_approval`; the second `ap run` on the
// SAME mission is the approval: it must run the implementer and complete the
// mission without re-planning and without pausing again. Behavioral: drives
// real `ap run` subprocesses against the shared fake-adapter fixture.
import fs from "node:fs";
import path from "node:path";
import {
  makeFixtureRepo, makeFixtureBin, setScenario, writeConfig, runAutopilot,
  readObservedEvents, cleanup,
} from "./test-fixtures/workflow-order-harness.mjs";
import {toNewLayoutConfig} from "./config-layout.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

function readState(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
}

// Only a v4 `pause_for_plan_approval:true` arms the pause (see
// test-plan-approval-standalone.mjs for the migration rationale).
function writePlanApprovalConfig(repo) {
  writeConfig(repo, {planningFramework: "standalone"});
  const file = path.join(repo, ".autopilot", "config.json");
  const layout = toNewLayoutConfig(JSON.parse(fs.readFileSync(file, "utf8")));
  layout.schema_version = "4.0";
  layout.workflow.pause_for_plan_approval = true;
  fs.writeFileSync(file, `${JSON.stringify(layout, null, 2)}\n`);
}

const request = "implement the fixture task";
const repo = makeFixtureRepo("plan-approval-resume");
const binDir = makeFixtureBin("plan-approval-resume");
try {
  writePlanApprovalConfig(repo);
  setScenario(repo, "success");

  // ---- 1. first run pauses ----
  const first = runAutopilot(repo, binDir, {request});
  const paused = readState(repo);
  check("first run exits 0", first.status === 0, {status: first.status, stderr: first.stderr});
  check("first run pauses at plan_approval", paused.phase === "plan_approval", paused.phase);
  check("first run never runs the implementer",
    !readObservedEvents(repo).some((e) => e.role === "implementer"));
  const plannerRunsAfterFirst = readObservedEvents(repo).filter((e) => e.role === "planner").length;
  check("first run planned once", plannerRunsAfterFirst === 1, plannerRunsAfterFirst);

  // ---- 1b. `--stage planning` does NOT approve a paused mission ----
  // It promises to stop after planning, so it must re-print the pause and
  // leave the mission paused rather than silently consuming the approval.
  const planningStage = runAutopilot(repo, binDir, {request, stage: "planning"});
  const afterPlanningStage = readState(repo);
  check("--stage planning exits 0", planningStage.status === 0,
    {status: planningStage.status, stderr: planningStage.stderr});
  check("--stage planning re-prints the pause",
    planningStage.stdout.includes("PLAN APPROVAL REQUIRED"), planningStage.stdout);
  check("--stage planning does not log an approval",
    !planningStage.stdout.includes("Plan approved by"), planningStage.stdout);
  check("--stage planning leaves the mission paused",
    afterPlanningStage.phase === "plan_approval", afterPlanningStage.phase);
  check("--stage planning keeps planApproval",
    afterPlanningStage.planApproval?.status === "awaiting", afterPlanningStage.planApproval);
  check("--stage planning never runs the implementer",
    !readObservedEvents(repo).some((e) => e.role === "implementer"));

  // ---- 2. second run on the same mission consumes the pause ----
  const second = runAutopilot(repo, binDir, {request});
  const state = readState(repo);
  const events = readObservedEvents(repo);

  check("second run exits 0", second.status === 0, {status: second.status, stderr: second.stderr});
  check("second run logs the approval", second.stdout.includes("Plan approved by `ap run`"), second.stdout);
  check("second run runs the implementer", events.some((e) => e.role === "implementer"));
  check("second run does not re-plan",
    events.filter((e) => e.role === "planner").length === plannerRunsAfterFirst,
    events.filter((e) => e.role === "planner").length);
  check("second run never re-pauses", state.phase !== "plan_approval", state.phase);
  check("second run clears planApproval", !state.planApproval, state.planApproval);
  check("second run completes the mission", state.phase === "complete", state.phase);

  // ---- 3. `--stage implement` on a paused mission IS the approval ----
  const secondRequest = "implement the second fixture task";
  const planSecond = runAutopilot(repo, binDir, {request: secondRequest, stage: "planning"});
  const pausedAgain = readState(repo);
  check("second mission planned by --stage planning exits 0", planSecond.status === 0,
    {status: planSecond.status, stderr: planSecond.stderr});
  check("second mission pauses at plan_approval", pausedAgain.phase === "plan_approval", pausedAgain.phase);

  const implementersBefore = readObservedEvents(repo).filter((e) => e.role === "implementer").length;
  // Bare `--stage implement` (no request): the stored mission is resumed.
  const stageImplement = runAutopilot(repo, binDir, {request: "", stage: "implement"});
  const afterImplement = readState(repo);
  check("--stage implement exits 0", stageImplement.status === 0,
    {status: stageImplement.status, stderr: stageImplement.stderr});
  check("--stage implement logs the approval",
    stageImplement.stdout.includes("Plan approved by `ap run`"), stageImplement.stdout);
  check("--stage implement runs the implementer",
    readObservedEvents(repo).filter((e) => e.role === "implementer").length === implementersBefore + 1);
  check("--stage implement leaves plan_approval", afterImplement.phase !== "plan_approval", afterImplement.phase);
  check("--stage implement clears planApproval", !afterImplement.planApproval, afterImplement.planApproval);
} finally {
  cleanup(repo, binDir);
}

if (failures) {
  console.error(`${failures} plan-approval resume check(s) failed.`);
  process.exit(1);
}
console.log("test-plan-approval-resume: ok");
