#!/usr/bin/env node
// A passed standalone plan review is a plan approval: resuming an interrupted
// mission whose PLAN.md + TASKS.md are unchanged must go straight to
// implementation (or the plan-approval pause) without re-running the planner
// or the plan reviewer. An edited plan (different digest) and a mission with
// no recorded approval keep the existing resume behaviour.
import fs from "node:fs";
import path from "node:path";
import {
  makeFixtureRepo, makeFixtureBin, setScenario, writeConfig, runAutopilot,
  readObservedEvents, cleanup,
} from "./test-fixtures/workflow-order-harness.mjs";
import {toNewLayoutConfig} from "./config-layout.mjs";
import {planningArtifactDigest} from "./planning-artifact-digest.mjs";

const REQUEST = "fixture request";
const MISSION = "001-fixture-request";

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

function readState(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
}
function writeState(repo, state) {
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), `${JSON.stringify(state, null, 2)}\n`);
}
function roleCount(repo, role) {
  return readObservedEvents(repo).filter((e) => e.role === role).length;
}
function resolvedMission(repo, mission) {
  return mission || readState(repo).mission || MISSION;
}
function missionPaths(repo, mission) {
  const dir = path.join(repo, ".autopilot", "missions", resolvedMission(repo, mission));
  return {plan: path.join(dir, "PLAN.md"), tasks: path.join(dir, "TASKS.md")};
}
function currentDigest(repo, mission) {
  const {plan, tasks} = missionPaths(repo, mission);
  return planningArtifactDigest(plan, tasks);
}
function simulateCrashBeforeImplementation(repo) {
  const state = readState(repo);
  state.phase = "escalated";
  state.step = "unexpected_error";
  writeState(repo, state);
}
function writeMissionFiles(repo, mission, plan, tasks) {
  const {plan: planFile, tasks: tasksFile} = missionPaths(repo, mission);
  fs.mkdirSync(path.dirname(planFile), {recursive: true});
  fs.writeFileSync(planFile, plan);
  fs.writeFileSync(tasksFile, tasks);
}
function writeBaselineManifest(repo, mission) {
  const dir = path.join(repo, ".autopilot", "baseline", `mission-${resolvedMission(repo, mission)}`);
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, "manifest.json"),
    JSON.stringify({version: 2, declaredPaths: [], entries: {}, baseHead: null}, null, 2));
}
function setup(prefix, {pauseForApproval = false} = {}) {
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  writeConfig(repo, {planningFramework: "standalone", maxPlanRevisions: 3});
  if (pauseForApproval) {
    const file = path.join(repo, ".autopilot", "config.json");
    const layout = toNewLayoutConfig(JSON.parse(fs.readFileSync(file, "utf8")));
    layout.schema_version = "4.0";
    layout.workflow.pause_for_plan_approval = true;
    fs.writeFileSync(file, `${JSON.stringify(layout, null, 2)}\n`);
  }
  setScenario(repo, "success");
  return {repo, binDir};
}
function planOnce(repo, binDir) {
  return runAutopilot(repo, binDir, {request: REQUEST, stage: "planning", timeoutMs: 120000});
}

const fixtures = [];
try {
  // 1. PASS, then an escalated crash before implementation: resume must not
  // re-plan or re-review; implementation starts from the approved plan.
  {
    const fixture = setup("resume-after-approval");
    fixtures.push(fixture);
    const {repo, binDir} = fixture;
    const planned = planOnce(repo, binDir);
    const afterPlanning = readState(repo);
    check("case1 planning-only run exits 0", planned.status === 0, {status: planned.status, stderr: planned.stderr});
    check("case1 planning stops at tasks_ready", afterPlanning.phase === "tasks_ready", afterPlanning.phase);
    check("case1 stores a passed standalone review", afterPlanning.planningStateReview?.status === "passed"
      && afterPlanning.planningStateReview?.framework === "standalone"
      && typeof afterPlanning.planningStateReview?.artifactDigest === "string"
      && afterPlanning.planningStateReview.artifactDigest === currentDigest(repo), afterPlanning.planningStateReview);
    const plannersBefore = roleCount(repo, "planner");
    const reviewersBefore = roleCount(repo, "plan_reviewer");
    check("case1 initial planning ran one planner", plannersBefore === 1, plannersBefore);
    check("case1 initial planning ran one reviewer", reviewersBefore === 1, reviewersBefore);

    simulateCrashBeforeImplementation(repo);
    const resumed = runAutopilot(repo, binDir, {request: "", timeoutMs: 120000});
    check("case1 resume exits 0", resumed.status === 0, {status: resumed.status, stderr: resumed.stderr});
    check("case1 resume does not re-run the planner", roleCount(repo, "planner") === plannersBefore, {
      before: plannersBefore, after: roleCount(repo, "planner"), stdout: resumed.stdout, stderr: resumed.stderr
    });
    check("case1 resume does not re-run the plan reviewer", roleCount(repo, "plan_reviewer") === reviewersBefore, {
      before: reviewersBefore, after: roleCount(repo, "plan_reviewer")
    });
    check("case1 resume starts implementation", roleCount(repo, "implementer") >= 1, roleCount(repo, "implementer"));
  }

  // 2. The plan was edited after PASS: the digest no longer matches, so the
  // planner must run again before implementation.
  {
    const fixture = setup("resume-after-plan-edit");
    fixtures.push(fixture);
    const {repo, binDir} = fixture;
    const planned = planOnce(repo, binDir);
    check("case2 planning-only run exits 0", planned.status === 0, {status: planned.status, stderr: planned.stderr});
    const approvedDigest = readState(repo).planningStateReview?.artifactDigest;
    const plannersBefore = roleCount(repo, "planner");
    const reviewersBefore = roleCount(repo, "plan_reviewer");
    const {plan} = missionPaths(repo);
    fs.appendFileSync(plan, "\nObjective extension: edited after approval.\n");
    check("case2 edit changes the planning digest", currentDigest(repo) !== approvedDigest);
    simulateCrashBeforeImplementation(repo);
    const resumed = runAutopilot(repo, binDir, {request: "", stage: "planning", timeoutMs: 120000});
    check("case2 resume exits 0", resumed.status === 0, {status: resumed.status, stderr: resumed.stderr});
    check("case2 edited plan re-runs the planner", roleCount(repo, "planner") === plannersBefore + 1, {
      before: plannersBefore, after: roleCount(repo, "planner")
    });
    check("case2 edited plan re-runs the plan reviewer", roleCount(repo, "plan_reviewer") === reviewersBefore + 1, {
      before: reviewersBefore, after: roleCount(repo, "plan_reviewer")
    });
    check("case2 resume finishes planning at tasks_ready", readState(repo).phase === "tasks_ready", readState(repo).phase);
  }

  // 3. No recorded approval: unchanged behaviour, the planner runs.
  {
    const fixture = setup("resume-without-approval");
    fixtures.push(fixture);
    const {repo, binDir} = fixture;
    writeMissionFiles(repo, MISSION, "# Plan\n\nObjective: fixture task.\n",
      "## Phase 1: General\n\n- [ ] Do the fixture task — accept: done ; verify: none\n");
    writeState(repo, {
      version: 1, phase: "escalated", step: "unexpected_error",
      planningRequest: REQUEST, mission: MISSION, missionSeq: "001"
    });
    const resumed = runAutopilot(repo, binDir, {request: "", stage: "planning", timeoutMs: 120000});
    check("case3 resume without approval exits 0", resumed.status === 0, {status: resumed.status, stderr: resumed.stderr});
    check("case3 resume without approval runs the planner", roleCount(repo, "planner") === 1, roleCount(repo, "planner"));
    check("case3 resume without approval runs the plan reviewer", roleCount(repo, "plan_reviewer") === 1, roleCount(repo, "plan_reviewer"));
    check("case3 resume finishes planning at tasks_ready", readState(repo).phase === "tasks_ready", readState(repo).phase);
  }

  // 4. When human approval is required, the shortcut respects the pause
  // exactly like a normal PASS, and the next `ap run` approves it.
  {
    const fixture = setup("resume-after-approval-pause", {pauseForApproval: true});
    fixtures.push(fixture);
    const {repo, binDir} = fixture;
    const planned = planOnce(repo, binDir);
    const afterPlanning = readState(repo);
    check("case4 planning-only run exits 0", planned.status === 0, {status: planned.status, stderr: planned.stderr});
    check("case4 normal PASS pauses for approval", afterPlanning.phase === "plan_approval", afterPlanning.phase);
    check("case4 normal PASS records a passed review", afterPlanning.planningStateReview?.status === "passed", afterPlanning.planningStateReview);
    const plannersBefore = roleCount(repo, "planner");
    const reviewersBefore = roleCount(repo, "plan_reviewer");
    simulateCrashBeforeImplementation(repo);
    const resumed = runAutopilot(repo, binDir, {request: "", timeoutMs: 120000});
    const afterResume = readState(repo);
    check("case4 resume exits 0", resumed.status === 0, {status: resumed.status, stderr: resumed.stderr});
    check("case4 resume re-establishes the approval pause", afterResume.phase === "plan_approval", afterResume.phase);
    check("case4 resume does not re-run the planner", roleCount(repo, "planner") === plannersBefore, roleCount(repo, "planner"));
    check("case4 resume does not re-run the plan reviewer", roleCount(repo, "plan_reviewer") === reviewersBefore, roleCount(repo, "plan_reviewer"));
    check("case4 resume does not implement before approval", roleCount(repo, "implementer") === 0, roleCount(repo, "implementer"));

    const approved = runAutopilot(repo, binDir, {request: "", timeoutMs: 120000});
    check("case4 approval run exits 0", approved.status === 0, {status: approved.status, stderr: approved.stderr});
    check("case4 approval run starts implementation", roleCount(repo, "implementer") >= 1, roleCount(repo, "implementer"));
    check("case4 approval run does not re-run the planner", roleCount(repo, "planner") === plannersBefore, roleCount(repo, "planner"));
    check("case4 approval run does not re-run the plan reviewer", roleCount(repo, "plan_reviewer") === reviewersBefore, roleCount(repo, "plan_reviewer"));
  }

  // 5. Plan approval required, but every task is already ticked (detected
  // status "complete"): the plan was approved earlier in the mission, so a
  // resume during implementation/final review must NOT pause for approval
  // again. The old complete-plan path still goes straight to tasks_ready and
  // the mission continues to completion.
  {
    const fixture = setup("resume-after-approval-complete", {pauseForApproval: true});
    fixtures.push(fixture);
    const {repo, binDir} = fixture;
    const planned = planOnce(repo, binDir);
    const afterPlanning = readState(repo);
    check("case5 planning-only run exits 0", planned.status === 0, {status: planned.status, stderr: planned.stderr});
    check("case5 normal PASS pauses for approval", afterPlanning.phase === "plan_approval", afterPlanning.phase);
    check("case5 normal PASS records a passed review", afterPlanning.planningStateReview?.status === "passed", afterPlanning.planningStateReview);
    const plannersBefore = roleCount(repo, "planner");
    const reviewersBefore = roleCount(repo, "plan_reviewer");
    const mission = afterPlanning.mission;
    const {tasks} = missionPaths(repo, mission);
    fs.writeFileSync(tasks, fs.readFileSync(tasks, "utf8").replace(/^(\s*[-*+]\s+)\[ \]/gm, "$1[x]"));
    writeBaselineManifest(repo, mission);
    const crashed = readState(repo);
    crashed.phase = "escalated";
    crashed.step = "unexpected_error";
    delete crashed.planApproval;
    writeState(repo, crashed);

    const resumed = runAutopilot(repo, binDir, {request: "", timeoutMs: 120000});
    const afterResume = readState(repo);
    check("case5 resume exits 0", resumed.status === 0, {status: resumed.status, stderr: resumed.stderr});
    check("case5 resume does not pause for approval",
      afterResume.phase !== "plan_approval" && !afterResume.planApproval,
      {phase: afterResume.phase, planApproval: afterResume.planApproval, stdout: resumed.stdout});
    check("case5 resume does not re-run the planner", roleCount(repo, "planner") === plannersBefore, roleCount(repo, "planner"));
    check("case5 resume does not re-run the plan reviewer", roleCount(repo, "plan_reviewer") === reviewersBefore, roleCount(repo, "plan_reviewer"));
    check("case5 resume continues to implementation/final review",
      afterResume.phase === "complete" && roleCount(repo, "code_reviewer") >= 1,
      {phase: afterResume.phase, codeReviewers: roleCount(repo, "code_reviewer")});
  }
} finally {
  for (const {repo, binDir} of fixtures) cleanup(repo, binDir);
}

if (failures) {
  console.error(`${failures} resume-after-plan-approval check(s) failed.`);
  process.exit(1);
}
console.log("test-resume-after-plan-approval: ok");
