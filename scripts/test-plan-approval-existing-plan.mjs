#!/usr/bin/env node
// Mission 099 Phase 2 task 2.4 — plan-approval pause on the PRE-EXISTING
// complete-planning shortcut.
//
// A repo whose planning artifacts are already complete (standalone PLAN.md +
// fully checked TASKS.md, or a complete SpecKit feature) and whose config is
// an eligible `pause_for_plan_approval:true` must pause at `plan_approval` AFTER
// the existing-plan review, naming the files already on disk. The next `ap
// run` is the approval: it runs the implementer and completes without
// re-planning and without pausing again. `pause_for_plan_approval:false` skips the
// pause and completes in one pass. Behavioral: real `ap run` subprocesses
// against the shared fake-adapter fixture.
import fs from "node:fs";
import path from "node:path";
import {
  makeFixtureRepo, makeFixtureBin, makeSpecKitUnrelatedFeatureFixture,
  setScenario, writeConfig, runAutopilot, readObservedEvents, cleanup,
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

// The shared harness writes the legacy 3.0 fixture shape (migration maps it to
// old autoApprovePlan switch is ignored). Only a v4 `pause_for_plan_approval` arms the pause, so
// convert the same runtime shape to a complete v4 layout and set the switch.
function writePlanApprovalConfig(repo, planningFramework, pauseForPlanApproval) {
  writeConfig(repo, {planningFramework});
  const file = path.join(repo, ".autopilot", "config.json");
  const layout = toNewLayoutConfig(JSON.parse(fs.readFileSync(file, "utf8")));
  layout.schema_version = "4.0";
  layout.workflow.pause_for_plan_approval = pauseForPlanApproval;
  fs.writeFileSync(file, `${JSON.stringify(layout, null, 2)}\n`);
}

// A pre-seeded COMPLETE standalone mission (all TASKS.md boxes checked, which
// standalone.state() calls "complete") plus seeded state so a no-request
// `ap run --repo` takes the reviewExistingPlanning() shortcut. The pre-seeded
// baseline manifest is what a completed checkpointed mission would already
// have; without it the no-pending early path refuses to invent one.
function seedStandaloneComplete(repo) {
  const missionDir = path.join(repo, ".autopilot", "missions", "001-fixture-feature");
  fs.mkdirSync(missionDir, {recursive: true});
  fs.writeFileSync(path.join(missionDir, "PLAN.md"), "# Plan\n\nObjective: fixture task.\n");
  fs.writeFileSync(path.join(missionDir, "TASKS.md"),
    "## Phase 1: General\n\n- [x] Do the fixture task — accept: done ; verify: none\n");
  const baselineDir = path.join(repo, ".autopilot", "baseline", "mission-001-fixture-feature");
  fs.mkdirSync(baselineDir, {recursive: true});
  fs.writeFileSync(path.join(baselineDir, "manifest.json"),
    JSON.stringify({version: 2, declaredPaths: [], entries: {}, baseHead: null}, null, 2));
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
    version: 1, phase: "idle", step: "idle",
    planningRequest: "fixture request", mission: "001-fixture-feature", missionSeq: "001",
  }, null, 2));
}

// A complete pre-existing SpecKit feature plus the exact-schema
// .specify/feature.json every SpecKit implementation stage requires.
function seedSpeckitComplete(repo) {
  const featureDir = makeSpecKitUnrelatedFeatureFixture(repo, "002-fixture-feature");
  fs.mkdirSync(path.join(repo, ".specify"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".specify", "feature.json"),
    JSON.stringify({feature_directory: "specs/002-fixture-feature"}, null, 2));
  return featureDir;
}

function standaloneCounts(events) {
  return {
    planner: events.filter((e) => e.role === "planner").length,
    reviewer: events.filter((e) => e.role === "plan_reviewer").length,
    implementer: events.filter((e) => e.role === "implementer").length,
  };
}

// ---- 1. standalone: true pauses after the existing-plan review ----
{
  const repo = makeFixtureRepo("plan-approval-existing-standalone");
  const binDir = makeFixtureBin("plan-approval-existing-standalone");
  try {
    writePlanApprovalConfig(repo, "standalone", true);
    seedStandaloneComplete(repo);
    setScenario(repo, "success");

    const first = runAutopilot(repo, binDir, {request: ""});
    const paused = readState(repo);
    const firstEvents = readObservedEvents(repo);
    const firstCounts = standaloneCounts(firstEvents);

    check("standalone/true: first run exits 0", first.status === 0, {status: first.status, stderr: first.stderr});
    check("standalone/true: pauses at plan_approval", paused.phase === "plan_approval", paused.phase);
    check("standalone/true: planApproval is awaiting",
      paused.planApproval?.status === "awaiting" && paused.planApproval?.framework === "standalone",
      paused.planApproval);
    check("standalone/true: existing-plan review ran", firstCounts.reviewer >= 1, firstCounts);
    check("standalone/true: planner never ran", firstCounts.planner === 0, firstCounts);
    check("standalone/true: implementer never ran", firstCounts.implementer === 0, firstCounts);
    check("standalone/true: message names PLAN.md", first.stdout.includes("PLAN.md"), first.stdout);
    check("standalone/true: message names TASKS.md", first.stdout.includes("TASKS.md"), first.stdout);
    check("standalone/true: message names the approve command", first.stdout.includes("ap run"), first.stdout);

    // Second run on the same mission is the approval.
    const second = runAutopilot(repo, binDir, {request: ""});
    const done = readState(repo);
    const secondEvents = readObservedEvents(repo);
    const secondCounts = standaloneCounts(secondEvents);

    check("standalone/true: second run exits 0", second.status === 0, {status: second.status, stderr: second.stderr});
    check("standalone/true: second run logs the approval",
      second.stdout.includes("Plan approved by `ap run`"), second.stdout);
    check("standalone/true: second run never re-plans", secondCounts.planner === 0, secondCounts);
    check("standalone/true: second run never re-pauses", done.phase !== "plan_approval", done.phase);
    check("standalone/true: second run clears planApproval", !done.planApproval, done.planApproval);
    check("standalone/true: mission completes", done.phase === "complete", done.phase);
  } finally {
    cleanup(repo, binDir);
  }
}

// ---- 2. standalone: false skips the pause and completes in one pass ----
{
  const repo = makeFixtureRepo("plan-approval-existing-standalone-auto");
  const binDir = makeFixtureBin("plan-approval-existing-standalone-auto");
  try {
    writePlanApprovalConfig(repo, "standalone", false);
    seedStandaloneComplete(repo);
    setScenario(repo, "success");

    const run = runAutopilot(repo, binDir, {request: ""});
    const state = readState(repo);
    const counts = standaloneCounts(readObservedEvents(repo));

    check("standalone/false: run exits 0", run.status === 0, {status: run.status, stderr: run.stderr});
    check("standalone/false: never pauses", state.phase !== "plan_approval", state.phase);
    check("standalone/false: no planApproval state", !state.planApproval, state.planApproval);
    check("standalone/false: planner never ran", counts.planner === 0, counts);
    check("standalone/false: existing-plan review ran", counts.reviewer >= 1, counts);
    // The seeded TASKS.md is fully checked (that is what makes it
    // "complete"), so the auto path legitimately has nothing left to
    // implement: it must reach the terminal state without an implementer,
    // not pause.
    check("standalone/false: nothing left to implement", counts.implementer === 0, counts);
    check("standalone/false: mission completes in one pass", state.phase === "complete", state.phase);
  } finally {
    cleanup(repo, binDir);
  }
}

// ---- 3. SpecKit: true pauses after the existing-plan review ----
{
  const repo = makeFixtureRepo("plan-approval-existing-speckit");
  const binDir = makeFixtureBin("plan-approval-existing-speckit");
  try {
    seedSpeckitComplete(repo);
    writePlanApprovalConfig(repo, "speckit", true);
    setScenario(repo, "success");

    const first = runAutopilot(repo, binDir, {request: ""});
    const paused = readState(repo);
    const firstCounts = standaloneCounts(readObservedEvents(repo));

    check("speckit/true: first run exits 0", first.status === 0, {status: first.status, stderr: first.stderr});
    check("speckit/true: pauses at plan_approval", paused.phase === "plan_approval", paused.phase);
    check("speckit/true: planApproval is awaiting",
      paused.planApproval?.status === "awaiting" && paused.planApproval?.framework === "speckit",
      paused.planApproval);
    check("speckit/true: existing-plan review ran", firstCounts.reviewer >= 1, firstCounts);
    check("speckit/true: planner never ran", firstCounts.planner === 0, firstCounts);
    check("speckit/true: implementer never ran", firstCounts.implementer === 0, firstCounts);
    check("speckit/true: message names plan.md", first.stdout.includes("plan.md"), first.stdout);
    check("speckit/true: message names tasks.md", first.stdout.includes("tasks.md"), first.stdout);

    const second = runAutopilot(repo, binDir, {request: ""});
    const done = readState(repo);
    const secondCounts = standaloneCounts(readObservedEvents(repo));

    check("speckit/true: second run exits 0", second.status === 0, {status: second.status, stderr: second.stderr});
    check("speckit/true: second run runs the implementer",
      secondCounts.implementer >= 1, secondCounts);
    check("speckit/true: second run never re-plans", secondCounts.planner === 0, secondCounts);
    check("speckit/true: second run never re-pauses", done.phase !== "plan_approval", done.phase);
    check("speckit/true: second run clears planApproval", !done.planApproval, done.planApproval);
    check("speckit/true: mission completes", done.phase === "complete", done.phase);
  } finally {
    cleanup(repo, binDir);
  }
}

// ---- 4. SpecKit: false skips the pause and completes in one pass ----
{
  const repo = makeFixtureRepo("plan-approval-existing-speckit-auto");
  const binDir = makeFixtureBin("plan-approval-existing-speckit-auto");
  try {
    seedSpeckitComplete(repo);
    writePlanApprovalConfig(repo, "speckit", false);
    setScenario(repo, "success");

    const run = runAutopilot(repo, binDir, {request: ""});
    const state = readState(repo);
    const counts = standaloneCounts(readObservedEvents(repo));

    check("speckit/false: run exits 0", run.status === 0, {status: run.status, stderr: run.stderr});
    check("speckit/false: never pauses", state.phase !== "plan_approval", state.phase);
    check("speckit/false: no planApproval state", !state.planApproval, state.planApproval);
    check("speckit/false: planner never ran", counts.planner === 0, counts);
    check("speckit/false: implementer ran", counts.implementer >= 1, counts);
    check("speckit/false: mission completes in one pass", state.phase === "complete", state.phase);
  } finally {
    cleanup(repo, binDir);
  }
}

if (failures) {
  console.error(`${failures} plan-approval existing-plan check(s) failed.`);
  process.exit(1);
}
console.log("test-plan-approval-existing-plan: ok");
