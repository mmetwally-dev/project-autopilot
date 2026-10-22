#!/usr/bin/env node
// TASK-38 pin: a plan must never use an excluded test as a task's verify.
// Covers config validation/migration, the deterministic denylist gate, the
// planner/reviewer prompt wording, the E2E revision path, and the SpecKit
// no-per-task-verify twin-loop finding.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {validatePlanningConfig, validateConfigForSave} from "./config-validation.mjs";
import {migrateConfig} from "./config-migration.mjs";
import {toRuntimeConfig} from "./config-layout.mjs";
import {tasks as speckitTasks} from "../adapters/speckit.mjs";
import {verifyDenylistFindings, effectiveVerifyDenylist, speckitTaskDenylistFindings} from "./verify-denylist.mjs";
import {makeFixtureRepo, makeFixtureBin, makeSpecKitPhaseFixture, setScenario, writeConfig, runAutopilot, readObservedEvents, cleanup} from "./test-fixtures/workflow-order-harness.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

if (process.platform === "win32") {
  console.log("test-verify-denylist: SKIP — standalone read-only roles this file drives need Linux/WSL2 bubblewrap (same prerequisite as test-workflow-order-standalone.mjs).");
  process.exit(0);
}

const MISSION_TIMEOUT_MS = 90000;

// ---- 1. Config: validation + migration default.
{
  check("config: [] validates", validatePlanningConfig({verify_denylist: []}).valid);
  check("config: list of strings validates", validatePlanningConfig({verify_denylist: ["a.mjs", "b.mjs"]}).valid);
  check("config: absent key validates", validatePlanningConfig({}).valid);
  check("config: non-array rejected", !validatePlanningConfig({verify_denylist: "a.mjs"}).valid);
  check("config: empty string entry rejected", !validatePlanningConfig({verify_denylist: [""]}).valid && validatePlanningConfig({verify_denylist: [""]}).errors[0].includes("non-empty"));
  check("config: non-string entry rejected", !validatePlanningConfig({verify_denylist: [42]}).valid);
  const migrated = toRuntimeConfig(migrateConfig({schema_version: "3.0", project: {planning_framework: "standalone"}, roles: {}}).config);
  check("migration: planning.verify_denylist defaults to []", Array.isArray(migrated.planning?.verify_denylist) && migrated.planning.verify_denylist.length === 0, migrated.planning);
  const migratedKept = toRuntimeConfig(migrateConfig({schema_version: "3.0", project: {planning_framework: "standalone"}, roles: {}, planning: {verify_denylist: ["x.mjs"]}}).config);
  check("migration: operator value preserved", migratedKept.planning.verify_denylist.join() === "x.mjs");
}

// ---- 1b. Unit: effective denylist adds test-all.mjs + gates.commands.
{
  const c = {planning: {verify_denylist: []}, gates: {commands: ["npm test"]}};
  const effective = effectiveVerifyDenylist(c);
  check("effective: adds test-all.mjs even when config denylist is empty", effective.includes("test-all.mjs"), effective);
  check("effective: adds gates.commands entries", effective.includes("npm test"), effective);
  const fullSuiteHits = verifyDenylistFindings([
    {taskLabel: "1.1", verify: "node scripts/test-all.mjs"},
    {taskLabel: "1.2", verify: "npm test"},
  ], effective);
  check("effective: task running test-all.mjs is flagged", fullSuiteHits.some(f => f.location.includes("1.1") && f.problem.includes("test-all.mjs")), fullSuiteHits);
  check("effective: task running a gates.commands entry is flagged", fullSuiteHits.some(f => f.location.includes("1.2") && f.problem.includes("npm test")), fullSuiteHits);
  check("effective: full-suite hits carry full-suite correction text",
    fullSuiteHits.every(f => f.correction.includes("full suite") && f.correction !== "pick a verify that runs in this project's suite"), fullSuiteHits);
  const configHit = verifyDenylistFindings(
    [{taskLabel: "2.1", verify: "node scripts/test-execution-plane-safety.mjs"}],
    effectiveVerifyDenylist({planning: {verify_denylist: ["test-execution-plane-safety.mjs"]}, gates: {commands: []}}));
  check("effective: configured denylist entry still flagged", configHit.length === 1, configHit);
  check("effective: configured entry keeps the generic correction", configHit[0]?.correction === "pick a verify that runs in this project's suite", configHit);
  const clean = verifyDenylistFindings(
    [{taskLabel: "3.1", verify: "node scripts/test-config-validation.mjs"}],
    effective);
  check("effective: clean task verify yields no findings", clean.length === 0, clean);
}

// ---- 1c. Unit: speckitTaskDenylistFindings scans task-line text.
{
  const denylist = ["test-all.mjs", "npm test"];
  const positive = speckitTaskDenylistFindings(
    "## Phase 1: X\n\n- [ ] T001 Run the full test suite with npm test\n",
    denylist);
  check("speckit-text: task line with forbidden command is flagged", positive.length === 1, positive);
  check("speckit-text: finding cites the phase heading",
    positive.length === 1 && positive[0].location.includes("Phase 1: X") && positive[0].problem.includes("npm test"), positive);
  const negated = speckitTaskDenylistFindings(
    "## Phase 1: X\n\n- [ ] T002 Do not run npm test, use the linked test instead\n",
    denylist);
  check("speckit-text: negated prose is not flagged", negated.length === 0, negated);
  const testAll = speckitTaskDenylistFindings(
    "## Phase 2: Y\n\n- [ ] T003 Verify with node scripts/test-all.mjs\n",
    denylist);
  check("speckit-text: test-all.mjs span is flagged", testAll.length === 1 && testAll[0].location.includes("Phase 2: Y"), testAll);
}

// ---- 2. Unit: SpecKit task lines carry NO per-task verify field.
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-speckit-tasks-"));
  try {
    fs.mkdirSync(path.join(repo, "specs", "001-x"), {recursive: true});
    fs.writeFileSync(path.join(repo, "specs", "001-x", "tasks.md"),
      "## Phase 1: X\n\n- [ ] Do the thing\n");
    const parsed = speckitTasks(repo, ["specs/001-x/tasks.md"]);
    check("speckit: parse yields tasks", parsed.length === 1, parsed);
    check("speckit: task objects carry no verify field (no per-task verify to check)",
      parsed.every(t => !("verify" in t)));
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
}

// ---- 3. E2E standalone: round-1 denied verify → reviewer NOT launched for
//         that round; planner's 2nd prompt carries the finding; revision
//         left as 1; no adapter budget (no reviewer/adapter ran that round).
{
  const repo = makeFixtureRepo("denylist");
  const binDir = makeFixtureBin("denylist");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    const configPath = path.join(repo, ".autopilot", "config.json");
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    cfg.planning = {verify_denylist: ["test-execution-plane-safety.mjs"]};
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    setScenario(repo, "verify_denylist");
    const run = runAutopilot(repo, binDir, {request: "fixture request", timeoutMs: MISSION_TIMEOUT_MS});

    check("e2e: mission completed", run.status === 0, `stderr=${run.stderr.slice(-800)}`);
    const events = readObservedEvents(repo);
    const planners = events.filter(e => e.role === "planner");
    const reviewers = events.filter(e => e.role === "plan_reviewer");
    check("e2e: planner ran twice (one revision)", planners.length === 2, planners.length);
    check("e2e: plan reviewer ran exactly once — never for the denied round", reviewers.length === 1, reviewers.length);
    check("e2e: no reviewer before the second planner", events[0].role === "planner" && events[1].role === "planner" && events[2].role === "plan_reviewer", events.slice(0, 4).map(e => e.role));
    const brief2 = fs.readFileSync(path.join(path.dirname(planners[1].file), "brief.txt"), "utf8");
    check("e2e: second planner prompt carries the denied entry", brief2.includes("test-execution-plane-safety.mjs"), brief2.slice(-1500));
    check("e2e: second planner prompt carries the denylist correction", brief2.includes("pick a verify that runs in this project's suite") || brief2.includes("DENYLIST") , brief2.slice(-1200));
    check("e2e: brief names the VERIFY DENYLIST rule", brief2.includes("VERIFY DENYLIST"), brief2.slice(-800));
    const state = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
    check("e2e: no adapter budget spent (no lastFailure)", state.lastFailure === undefined, state.lastFailure);
  } finally { cleanup(repo, binDir); }
}

// ---- 4. Prompt: with an empty configured denylist the planner/reviewer
//         prompts still carry the effective full-suite note (Mission 038
//         task 1.2: effectiveVerifyDenylist always lists test-all.mjs plus
//         every gates.commands entry), mentioning ONLY those implicit
//         entries — never an operator-configured entry, of which there is
//         none here.
{
  const repo = makeFixtureRepo("denylist-empty");
  const binDir = makeFixtureBin("denylist-empty");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    setScenario(repo, "success");
    const run = runAutopilot(repo, binDir, {request: "fixture request", timeoutMs: MISSION_TIMEOUT_MS});
    check("e2e empty denylist: mission completed", run.status === 0, run.stderr.slice(-800));
    const events = readObservedEvents(repo);
    const planners = events.filter(e => e.role === "planner");
    const reviewers = events.filter(e => e.role === "plan_reviewer");
    const brief1 = fs.readFileSync(path.join(path.dirname(planners[0].file), "brief.txt"), "utf8");
    const briefR = fs.readFileSync(path.join(path.dirname(reviewers[0].file), "brief.txt"), "utf8");
    check("e2e empty denylist: planner brief still lists test-all.mjs", brief1.includes("test-all.mjs"), brief1.split("\n").filter(l => /verify.?denylist/i.test(l)));
    check("e2e empty denylist: planner brief names the VERIFY DENYLIST rule", brief1.includes("VERIFY DENYLIST"), brief1.split("\n").filter(l => /DENYLIST/.test(l)));
    check("e2e empty denylist: planner brief mentions no configured entry", !brief1.includes("test-execution-plane-safety.mjs"), brief1.split("\n").filter(l => /verify.?denylist/i.test(l)));
    check("e2e empty denylist: reviewer brief still lists test-all.mjs", briefR.includes("test-all.mjs"), briefR.split("\n").filter(l => /verify.?denylist/i.test(l)));
    check("e2e empty denylist: reviewer brief mentions no configured entry", !briefR.includes("test-execution-plane-safety.mjs"), briefR.split("\n").filter(l => /verify.?denylist/i.test(l)));
  } finally { cleanup(repo, binDir); }
}

// ---- 5. E2E standalone full-suite: empty planning.verify_denylist, but the
//         harness configures writeConfig gatesCommands ['npm test'], so the
//         effective denylist is ['test-all.mjs', 'npm test']. Round 1 ships
//         tasks whose verify runs the full suite → the deterministic gate
//         rejects WITHOUT launching the reviewer; the planner's 2nd prompt
//         carries findings citing the task IDs; round 2 is clean.
{
  const repo = makeFixtureRepo("denylist-full-suite");
  const binDir = makeFixtureBin("denylist-full-suite");
  try {
    writeConfig(repo, {planningFramework: "standalone", gatesCommands: ["npm test"]});
    // The phase gate runs `npm test` in the fixture repo after plan approval,
    // so the fixture needs a passing test script (committed via setScenario's
    // `git add -A` below); without it the gate fails with ENOENT/package.json.
    fs.writeFileSync(path.join(repo, "package.json"),
      JSON.stringify({name: "fixture", version: "1.0.0", scripts: {test: "exit 0"}}));
    setScenario(repo, "standalone_full_suite_verify");
    const run = runAutopilot(repo, binDir, {request: "fixture request", timeoutMs: MISSION_TIMEOUT_MS});

    check("e2e full-suite: mission completed", run.status === 0, `stderr=${run.stderr.slice(-800)}`);
    const events = readObservedEvents(repo);
    const planners = events.filter(e => e.role === "planner");
    const reviewers = events.filter(e => e.role === "plan_reviewer");
    check("e2e full-suite: planner ran twice (one revision)", planners.length === 2, planners.length);
    check("e2e full-suite: plan reviewer ran exactly once — never for the denied round", reviewers.length === 1, reviewers.length);
    check("e2e full-suite: no reviewer before the second planner", events[0].role === "planner" && events[1].role === "planner" && events[2].role === "plan_reviewer", events.slice(0, 4).map(e => e.role));
    const brief1 = fs.readFileSync(path.join(path.dirname(planners[0].file), "brief.txt"), "utf8");
    check("e2e full-suite: first planner prompt lists the gates.commands entry", brief1.includes("npm test"), brief1.slice(-1500));
    check("e2e full-suite: first planner prompt lists test-all.mjs", brief1.includes("test-all.mjs"), brief1.slice(-1500));
    const brief2 = fs.readFileSync(path.join(path.dirname(planners[1].file), "brief.txt"), "utf8");
    check("e2e full-suite: second planner prompt carries the test-all.mjs finding", brief2.includes("test-all.mjs"), brief2.slice(-1500));
    check("e2e full-suite: second planner prompt carries the gates.commands finding", brief2.includes("npm test"), brief2.slice(-1500));
    check("e2e full-suite: second planner prompt cites the task ID", brief2.includes("1.1") || brief2.includes("1.2"), brief2.slice(-1500));
    check("e2e full-suite: second planner prompt carries the full-suite correction", brief2.includes("full suite"), brief2.slice(-1200));
    check("e2e full-suite: findings mention only test-all.mjs and gates.commands entries",
      !brief2.includes("test-execution-plane-safety.mjs"), brief2.slice(-1500));
    const state = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
    check("e2e full-suite: no adapter budget spent (no lastFailure)", state.lastFailure === undefined, state.lastFailure);
  } finally { cleanup(repo, binDir); }
}

// ---- 6. E2E speckit tasks-text: round-1 task line runs the full suite via
//         the gates.commands entry 'npm test' → the deterministic tasks gate
//         rejects WITHOUT launching the reviewer for that round; the
//         revision planner's prompt quotes the REJECTED findings; the
//         revision ships a clean task line.
{
  const repo = makeFixtureRepo("denylist-speckit-task-text");
  const binDir = makeFixtureBin("denylist-speckit-task-text");
  try {
    makeSpecKitPhaseFixture(repo);
    writeConfig(repo, {planningFramework: "speckit", gatesCommands: ["npm test"]});
    // The phase gate runs `npm test` in the fixture repo after approval, so
    // the fixture needs a passing test script (same reason as §5); without
    // it the gate fails with ENOENT/package.json.
    fs.writeFileSync(path.join(repo, "package.json"),
      JSON.stringify({name: "fixture", version: "1.0.0", scripts: {test: "exit 0"}}));
    setScenario(repo, "speckit_full_suite_task_text");
    const run = runAutopilot(repo, binDir, {request: "fixture request", timeoutMs: MISSION_TIMEOUT_MS});

    check("e2e speckit task-text: mission completed", run.status === 0, `stderr=${run.stderr.slice(-800)}`);
    const events = readObservedEvents(repo);
    const planners = events.filter(e => e.role === "planner");
    const reviewers = events.filter(e => e.role === "plan_reviewer");
    const taskPlanners = planners.filter(e => {
      try { return fs.readFileSync(path.join(path.dirname(e.file), "brief.txt"), "utf8").includes("Planning phase: tasks"); }
      catch { return false; }
    });
    check("e2e speckit task-text: tasks planner ran twice (one revision)", taskPlanners.length === 2, planners.length);
    // Spec + plan gates each launch the reviewer once; the denied tasks
    // round launches none, and the post-revision re-review launches one.
    check("e2e speckit task-text: plan reviewer ran 3 times (spec, plan, tasks re-review)", reviewers.length === 3, reviewers.length);
    const firstTasksIdx = events.indexOf(taskPlanners[0]);
    const secondTasksIdx = events.indexOf(taskPlanners[1]);
    const reviewersBetween = events.slice(firstTasksIdx + 1, secondTasksIdx).filter(e => e.role === "plan_reviewer");
    check("e2e speckit task-text: no reviewer between the two tasks planners", reviewersBetween.length === 0, reviewersBetween.length);
    const brief2 = fs.readFileSync(path.join(path.dirname(taskPlanners[1].file), "brief.txt"), "utf8");
    check("e2e speckit task-text: revision prompt quotes the rejection", brief2.includes("The plan reviewer REJECTED the previous attempt at this stage"), brief2.slice(-1500));
    check("e2e speckit task-text: revision prompt carries the denied entry", brief2.includes("npm test"), brief2.slice(-1500));
    const postRevisionReviewers = events.slice(secondTasksIdx + 1).filter(e => e.role === "plan_reviewer");
    check("e2e speckit task-text: a re-review ran after the revision", postRevisionReviewers.length >= 1, postRevisionReviewers.length);
    const reReviewBrief = fs.readFileSync(path.join(path.dirname(postRevisionReviewers[0].file), "brief.txt"), "utf8");
    check("e2e speckit task-text: re-review prompt names the denied entry", reReviewBrief.includes("npm test"), reReviewBrief.slice(-1500));
    check("e2e speckit task-text: re-review prompt carries no stringified objects", !reReviewBrief.includes("[object Object]"), reReviewBrief.slice(-500));
    const tasksFiles = fs.readdirSync(path.join(repo, "specs")).flatMap(d => {
      const f = path.join(repo, "specs", d, "tasks.md");
      return fs.existsSync(f) ? [f] : [];
    });
    check("e2e speckit task-text: a tasks.md was written", tasksFiles.length >= 1, tasksFiles);
    const finalTasks = tasksFiles.length ? fs.readFileSync(tasksFiles[0], "utf8") : "";
    check("e2e speckit task-text: revised tasks.md no longer runs the full suite", !finalTasks.includes("npm test"), finalTasks);
    check("e2e speckit task-text: revised tasks.md keeps the clean task line", finalTasks.includes("T001"), finalTasks);
  } finally { cleanup(repo, binDir); }
}

console.log(failures ? `${failures} check(s) failed.` : "verify-denylist tests passed");
process.exit(failures ? 1 : 0);
