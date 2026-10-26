#!/usr/bin/env node
// Mission 099 Phase 2 task 2.5 — SpecKit plan-approval pause wiring.
//
// A v4 `workflow.pause_for_plan_approval:true` SpecKit run must stop at
// `plan_approval` after the planning gates PASS, print the approve-plan
// message naming specs/<feature>/plan.md and specs/<feature>/tasks.md, and
// never launch the implementer. A following `ap run` resumes the paused
// mission to completion. A `false` run completes in one pass.
import fs from "node:fs";
import path from "node:path";
import {
  makeFixtureRepo, makeFixtureBin, makeSpecKitPhaseFixture, setScenario,
  writeConfig, runAutopilot, readObservedEvents, cleanup,
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

function writePlanApprovalConfig(repo, pauseForPlanApproval) {
  writeConfig(repo, {planningFramework: "speckit", networkIsolation: process.platform !== "win32"});
  const file = path.join(repo, ".autopilot", "config.json");
  const legacy = JSON.parse(fs.readFileSync(file, "utf8"));
  const layout = toNewLayoutConfig(legacy);
  layout.schema_version = "4.0";
  layout.workflow.pause_for_plan_approval = pauseForPlanApproval;
  fs.writeFileSync(file, `${JSON.stringify(layout, null, 2)}\n`);
}

// ---- 1. pause_for_plan_approval:true pauses after the planning gates ----
{
  const repo = makeFixtureRepo("plan-approval-speckit-pause");
  const binDir = makeFixtureBin("plan-approval-speckit-pause");
  try {
    makeSpecKitPhaseFixture(repo);
    writePlanApprovalConfig(repo, true);
    setScenario(repo, "success");
    const run = runAutopilot(repo, binDir, {request: "implement the fixture task"});
    const state = readState(repo);
    const events = readObservedEvents(repo);
    const feature = state.speckitFeatureDir || "001-fixture-feature";

    check("pause: run exits 0", run.status === 0, {status: run.status, stderr: run.stderr});
    check("pause: state stops at plan_approval", state.phase === "plan_approval", state.phase);
    check("pause: planApproval is awaiting", state.planApproval?.status === "awaiting", state.planApproval);
    check("pause: pause framework is speckit", state.planApproval?.framework === "speckit", state.planApproval);
    check("pause: planner ran", events.some((e) => e.role === "planner"));
    check("pause: all three planning gates PASSed",
      events.filter((e) => e.role === "plan_reviewer" && e.decision === "PASS").length >= 3,
      events.filter((e) => e.role === "plan_reviewer"));
    check("pause: no implementer ran", !events.some((e) => e.role === "implementer"));
    check("pause: message names plan.md", run.stdout.includes(`specs/${feature}/plan.md`), feature);
    check("pause: message names tasks.md", run.stdout.includes(`specs/${feature}/tasks.md`), feature);
    check("pause: message names the approve command", run.stdout.includes("ap run"));
    check("pause: watch report refreshed",
      fs.existsSync(path.join(repo, ".autopilot", "missions", state.mission, "WATCH-REPORT.md")), state.mission);

    // ---- 2. a following `ap run` resumes the approved plan to completion ----
    const resume = runAutopilot(repo, binDir, {request: "implement the fixture task"});
    const resumed = readState(repo);
    const resumedEvents = readObservedEvents(repo);

    check("resume: run exits 0", resume.status === 0, {status: resume.status, stderr: resume.stderr});
    check("resume: no longer paused", resumed.phase !== "plan_approval", resumed.phase);
    check("resume: pause state consumed", !resumed.planApproval);
    check("resume: mission completed", resumed.phase === "complete", resumed.phase);
    check("resume: implementer ran", resumedEvents.some((e) => e.role === "implementer"));
    check("resume: no re-planning", !resume.stdout.includes("PLAN APPROVAL REQUIRED"));
  } finally {
    cleanup(repo, binDir);
  }
}

// ---- 3. pause_for_plan_approval:false completes in one pass ----
{
  const repo = makeFixtureRepo("plan-approval-speckit-auto");
  const binDir = makeFixtureBin("plan-approval-speckit-auto");
  try {
    makeSpecKitPhaseFixture(repo);
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
  console.error(`${failures} plan-approval SpecKit check(s) failed.`);
  process.exit(1);
}
console.log("test-plan-approval-speckit: ok");
