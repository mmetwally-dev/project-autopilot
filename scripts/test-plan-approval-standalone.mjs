#!/usr/bin/env node
// Mission 099 Phase 2 task 2.2 — standalone plan-approval pause wiring.
//
// A v4 `workflow.pause_for_plan_approval:true` run must stop at `plan_approval`
// after plan-review PASS, print the approve-plan message naming PLAN.md and
// TASKS.md, and never launch the implementer. A `false` run completes in one
// pass. Behavioral: drives real `ap run` subprocesses against the shared
// fake-adapter fixture.
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

// The shared harness writes the legacy 3.0 fixture shape (whose old
// autoApprovePlan switch is ignored). Only a v4 `pause_for_plan_approval`
// arms the pause, so convert the same runtime shape to a complete v4 layout
// and set the switch.
function writePlanApprovalConfig(repo, pauseForPlanApproval) {
  writeConfig(repo, {planningFramework: "standalone"});
  const file = path.join(repo, ".autopilot", "config.json");
  const legacy = JSON.parse(fs.readFileSync(file, "utf8"));
  const layout = toNewLayoutConfig(legacy);
  layout.schema_version = "4.0";
  layout.workflow.pause_for_plan_approval = pauseForPlanApproval;
  fs.writeFileSync(file, `${JSON.stringify(layout, null, 2)}\n`);
}

// ---- 1. pause_for_plan_approval:true pauses after plan-review PASS ----
{
  const repo = makeFixtureRepo("plan-approval-pause");
  const binDir = makeFixtureBin("plan-approval-pause");
  try {
    writePlanApprovalConfig(repo, true);
    setScenario(repo, "success");
    const run = runAutopilot(repo, binDir, {request: "implement the fixture task"});
    const state = readState(repo);
    const events = readObservedEvents(repo);

    check("pause: run exits 0", run.status === 0, {status: run.status, stderr: run.stderr});
    check("pause: state stops at plan_approval", state.phase === "plan_approval", state.phase);
    check("pause: planApproval is awaiting", state.planApproval?.status === "awaiting", state.planApproval);
    check("pause: planner ran", events.some((e) => e.role === "planner"));
    check("pause: plan_reviewer PASSed", events.some((e) => e.role === "plan_reviewer" && e.decision === "PASS"));
    check("pause: no implementer ran", !events.some((e) => e.role === "implementer"));
    check("pause: message names PLAN.md", run.stdout.includes("PLAN.md"));
    check("pause: message names TASKS.md", run.stdout.includes("TASKS.md"));
    check("pause: message names the approve command", run.stdout.includes("ap run"));

    // The pause must refresh the watch report AFTER saving the paused state,
    // so an operator watching the mission sees the stop immediately.
    const reportPath = path.join(repo, ".autopilot", "missions", state.mission, "WATCH-REPORT.md");
    const statePath = path.join(repo, ".autopilot", "state.json");
    check("pause: watch report refreshed", fs.existsSync(reportPath), reportPath);
    check("pause: watch report written after the paused state",
      fs.existsSync(reportPath) && fs.statSync(reportPath).mtimeMs >= fs.statSync(statePath).mtimeMs,
      {report: fs.existsSync(reportPath) ? fs.statSync(reportPath).mtimeMs : null,
        state: fs.statSync(statePath).mtimeMs});
  } finally {
    cleanup(repo, binDir);
  }
}

// ---- 3. a DIFFERENT request on a paused mission is a new mission ----
// Running the command is the approval only for the mission that was paused; a
// genuinely different request must start a new mission and must NOT inherit
// the old mission's awaiting-approval record.
{
  const repo = makeFixtureRepo("plan-approval-new-request");
  const binDir = makeFixtureBin("plan-approval-new-request");
  try {
    writePlanApprovalConfig(repo, true);
    setScenario(repo, "success");

    const first = runAutopilot(repo, binDir, {request: "implement the fixture task"});
    const paused = readState(repo);
    const pausedMission = paused.mission;
    const plannerRunsAfterPause = readObservedEvents(repo).filter((e) => e.role === "planner").length;
    check("new-request: first run pauses", first.status === 0 && paused.phase === "plan_approval",
      {status: first.status, phase: paused.phase, stderr: first.stderr});

    const second = runAutopilot(repo, binDir, {request: "implement a DIFFERENT fixture task"});
    const fresh = readState(repo);
    const events = readObservedEvents(repo);

    check("new-request: second run does not log an approval",
      !second.stdout.includes("Plan approved by"), second.stdout);
    check("new-request: second run starts a new mission", fresh.mission !== pausedMission,
      {was: pausedMission, now: fresh.mission});
    check("new-request: new mission clears the old planApproval",
      (fresh.planApproval?.artifacts || []).join("|") !== (paused.planApproval?.artifacts || []).join("|"),
      {old: paused.planApproval, now: fresh.planApproval});
    check("new-request: new mission re-plans",
      events.filter((e) => e.role === "planner").length > plannerRunsAfterPause,
      events.filter((e) => e.role === "planner").length);
    check("new-request: new mission must be approved on its own terms",
      fresh.phase === "plan_approval", fresh.phase);
    check("new-request: the old plan is not implemented",
      !events.some((e) => e.role === "implementer"), events.filter((e) => e.role === "implementer"));
  } finally {
    cleanup(repo, binDir);
  }
}

// ---- 2. pause_for_plan_approval:false completes in one pass ----
{
  const repo = makeFixtureRepo("plan-approval-auto");
  const binDir = makeFixtureBin("plan-approval-auto");
  try {
    writePlanApprovalConfig(repo, false);
    setScenario(repo, "success");
    const run = runAutopilot(repo, binDir, {request: "implement the fixture task"});
    const state = readState(repo);
    const events = readObservedEvents(repo);

    check("auto: run exits 0", run.status === 0, {status: run.status, stderr: run.stderr});
    check("auto: implementer ran", events.some((e) => e.role === "implementer"));
    check("auto: never pauses at plan_approval", state.phase !== "plan_approval", state.phase);
    check("auto: no planApproval state", !state.planApproval);
    check("auto: mission completed", state.phase === "complete", state.phase);
  } finally {
    cleanup(repo, binDir);
  }
}

if (failures) {
  console.error(`${failures} plan-approval standalone check(s) failed.`);
  process.exit(1);
}
console.log("test-plan-approval-standalone: ok");
