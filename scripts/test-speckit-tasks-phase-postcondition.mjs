#!/usr/bin/env node
// TASK 15.6E — behavioral proof for the executable-phase tasks contract.
//
// The real Native Windows incident: the Planner produced a tasks.md with 5
// unchecked loose checkboxes and NO recognized `## Phase N` heading. The
// tasks-stage postcondition (flat-checkbox rule) accepted it, Tasks Review
// passed, and Implementation died before the Implementer with
// "No unchecked SpecKit tasks found" — production executes PHASES
// (adapters/speckit.mjs phases()), not loose checkboxes.
//
// Drives real `node scripts/autopilot.mjs run` subprocesses against
// disposable git fixture repos and the hermetic fake adapter
// (scripts/test-fixtures/fake-workflow-adapter.sh,
// `speckit_postcondition_orphan_tasks` scenario), then inspects OBSERVED
// process outcome, stdout/stderr, result.json roles launched, brief.txt
// correction sentinels, state.json, and filesystem state — never prompt
// prose or internal helper call counts.
//
//   A. New planning: orphan tasks rejected at the tasks command itself — no
//      "Tasks ready", no Tasks Review, no Implementer; same-request retry
//      receives the structured AUTOPILOT_PLANNING_CORRECTION sentinel,
//      corrects tasks.md, then review/implement/verify run in order.
//   B. Legacy tasks_ready: a hand-seeded tasks_ready mission holding the
//      exact incident tasks.md returns to Tasks correction instead of dying
//      at Implementation; same mission and feature preserved; review and
//      implementation run only after correction.
//   C. Covered by test-speckit-tasks-executable-phases.mjs (unit): valid
//      multi-phase/CRLF/unicode formats, done/future classification, and
//      byte-for-byte non-mutation.
//
// Requires a POSIX environment (the fake adapter is a shell script;
// read-only roles use bubblewrap). Runs in the WSL suite. Windows coverage
// of the identical Mission A (new-planning reject + structured correction)
// and Mission B (legacy tasks_ready recovery) contract lives in
// test-windows-tasks-phase-recovery.mjs (a standalone Windows-native test
// with its own real `bin/ap.cjs` entrypoint drive and fake adapter — not a
// missing fixture branch here, a genuine duplicate-platform proof).
import fs from "node:fs";
import path from "node:path";
import {
  makeFixtureRepo, makeFixtureBin, makeSpecKitWorkflowOnly, makeClaudeMdBaseline,
  setScenario, writeConfig, runAutopilot, readObservedEvents, cleanup
} from "./test-fixtures/workflow-order-harness.mjs";

if (process.platform === "win32") {
  console.log("test-speckit-tasks-phase-postcondition: SKIP — platform prerequisite not met: requires a POSIX environment (the fake adapter is a shell script; read-only roles need Linux/WSL2 bubblewrap). Windows coverage of the same Mission A/B contract lives in test-windows-tasks-phase-recovery.mjs.");
  process.exit(0);
}

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

const NEW_FEATURE = "999-smoke-test";
const REQUEST = "smoke test the orphan tasks contract";

function setUp(prefix) {
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  makeSpecKitWorkflowOnly(repo);
  makeClaudeMdBaseline(repo);
  writeConfig(repo, {planningFramework: "speckit"});
  return {repo, binDir};
}

function readState(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
}

function readBriefs(repo) {
  const root = path.join(repo, ".autopilot");
  const out = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === "brief.txt") out.push(fs.readFileSync(full, "utf8"));
    }
  })(root);
  return out;
}

function tasksCorrectionBriefs(repo) {
  return readBriefs(repo).filter(b =>
    b.includes("Planning phase: tasks.") &&
    b.includes("AUTOPILOT_PLANNING_CORRECTION=") &&
    b.includes('"reason":"tasks_no_executable_phases"'));
}

function missionDirs(repo) {
  const dir = path.join(repo, ".autopilot", "missions");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(d => fs.statSync(path.join(dir, d)).isDirectory()).sort();
}

// ── A. orphan tasks rejected at the tasks command, then corrected ─────────
{
  const {repo, binDir} = setUp("tasks-phases-new");
  try {
    setScenario(repo, "speckit_postcondition_orphan_tasks");
    const run1 = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: 90000});

    check("orphan-new: mission did NOT complete (nonzero exit)", run1.status !== 0, run1.status);
    check("orphan-new: error names the tasks postcondition with the precise reason",
      /planning postcondition failed/i.test(run1.stderr) && run1.stderr.includes("'tasks'") && run1.stderr.includes("tasks_no_executable_phases"),
      run1.stderr.slice(-800));
    check("orphan-new: error is NOT the old implementation death",
      !run1.stderr.includes("No unchecked SpecKit tasks found"), run1.stderr.slice(-400));
    check("orphan-new: 'Tasks ready' was NOT printed", !run1.stdout.includes("Tasks ready"));

    const events1 = readObservedEvents(repo);
    const reviewers1 = events1.filter(e => e.role === "plan_reviewer");
    check("orphan-new: spec+plan gates launched (valid stages pass)", reviewers1.length === 2, events1.map(e => e.role));
    check("orphan-new: Tasks Review NEVER launched for the invalid tasks", reviewers1.length === 2, reviewers1);
    check("orphan-new: implementer never ran", !events1.some(e => e.role === "implementer"), events1.map(e => e.role));
    check("orphan-new: code_reviewer never ran", !events1.some(e => e.role === "code_reviewer"));
    check("orphan-new: verifier never ran", !events1.some(e => e.role === "verifier"));

    const state1 = readState(repo);
    check("orphan-new: checkpoint persists for tasks", state1.speckitPlanningCheckpoint?.step === "tasks", state1.speckitPlanningCheckpoint);
    check("orphan-new: checkpoint carries the postcondition reason",
      state1.speckitPlanningCheckpoint?.reason === "planning-stage-postcondition" &&
      state1.speckitPlanningCheckpoint?.postcondition?.reason === "tasks_no_executable_phases",
      state1.speckitPlanningCheckpoint);
    check("orphan-new: checkpoint carries the failing artifact path",
      state1.speckitPlanningCheckpoint?.postcondition?.artifact === "tasks.md" &&
      state1.speckitPlanningCheckpoint?.postcondition?.expected === `specs/${NEW_FEATURE}/tasks.md`,
      state1.speckitPlanningCheckpoint?.postcondition);
    check("orphan-new: session feature identity preserved", state1.speckitFeatureDir === NEW_FEATURE, state1.speckitFeatureDir);
    check("orphan-new: never reached tasks_ready/implementation", state1.phase !== "tasks_ready" && state1.phase !== "implementing", state1.phase);
    check("orphan-new: invalid tasks.md left untouched (still phaseless)",
      !/^## Phase /m.test(fs.readFileSync(path.join(repo, "specs", NEW_FEATURE, "tasks.md"), "utf8")));
    check("orphan-new: first tasks brief carried NO correction sentinel (nothing to correct yet)",
      tasksCorrectionBriefs(repo).length === 0);

    // Same-request retry: the fake planner self-corrects ONLY on the exact
    // structured sentinel, then the workflow continues in order.
    const run2 = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: 120000});
    check("orphan-new: same-request retry completed (exit 0)", run2.status === 0, `stderr=${run2.stderr.slice(-1500)}`);
    check("orphan-new: retry recorded a resume intent", readState(repo).planningIntent?.kind === "resume", readState(repo).planningIntent);

    const corrected = fs.readFileSync(path.join(repo, "specs", NEW_FEATURE, "tasks.md"), "utf8");
    check("orphan-new: retry wrote phased tasks.md", /^## Phase 1/m.test(corrected), corrected.slice(0, 200));
    check("orphan-new: retry tasks brief carried the structured correction sentinel",
      tasksCorrectionBriefs(repo).length >= 1, tasksCorrectionBriefs(repo).length);

    const events2 = readObservedEvents(repo);
    const implIdx = events2.findIndex(e => e.role === "implementer");
    check("orphan-new: implementation began after correction (implementer ran)", implIdx !== -1, events2.map(e => e.role));
    const reviewersBeforeImpl = implIdx === -1 ? [] : events2.slice(0, implIdx).filter(e => e.role === "plan_reviewer");
    check("orphan-new: Tasks Review ran only after corrected tasks (3 gates before implementer)",
      reviewersBeforeImpl.length >= 3, events2.map(e => e.role));
    check("orphan-new: code review ran", events2.some(e => e.role === "code_reviewer"));
    check("orphan-new: verifier ran", events2.some(e => e.role === "verifier"));
    const state2 = readState(repo);
    check("orphan-new: mission finished human_commit", state2.phase === "complete" && state2.step === "human_commit", {phase: state2.phase, step: state2.step});
    check("orphan-new: same feature preserved end to end", state2.speckitFeatureDir === NEW_FEATURE, state2.speckitFeatureDir);
    check("orphan-new: checkpoint cleared once tasks passed", !state2.speckitPlanningCheckpoint, state2.speckitPlanningCheckpoint);
    check("orphan-new: corrected tasks marked [x] only after verification",
      /- \[x\] Do the smoke test task/.test(fs.readFileSync(path.join(repo, "specs", NEW_FEATURE, "tasks.md"), "utf8")));
  } finally {
    cleanup(repo, binDir);
  }
}

// ── B. legacy tasks_ready with incident tasks.md recovers to Tasks ────────
{
  const {repo, binDir} = setUp("tasks-phases-legacy");
  try {
    // Seed the exact incident shape as already-persisted mission state.
    const featureDir = path.join(repo, "specs", NEW_FEATURE);
    fs.mkdirSync(featureDir, {recursive: true});
    fs.writeFileSync(path.join(featureDir, "spec.md"), "# Spec\n\nLegacy feature.\n");
    fs.writeFileSync(path.join(featureDir, "plan.md"), "# Plan\n\nLegacy plan.\n");
    fs.writeFileSync(path.join(featureDir, "tasks.md"), "# Tasks: legacy tasks\n\n## Tasks\n\n- [ ] Do the first orphan task\n\n- [ ] Do the second orphan task\n");
    fs.writeFileSync(path.join(repo, ".specify", "feature.json"), JSON.stringify({feature_directory: `specs/${NEW_FEATURE}`}));
    // setScenario commits everything above (spec/plan/tasks/feature.json
    // plus the scenario selector) — no second commit: there would be
    // nothing left to commit and `git commit` would fail closed.
    setScenario(repo, "speckit_postcondition_orphan_tasks");
    const startedAt = new Date().toISOString();
    fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
    fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
      version: 1, phase: "tasks_ready", step: "tasks_ready",
      taskIndex: 0, phaseIndex: 0, attempt: 0,
      mission: "002-smoke-test", missionSeq: "002",
      planningStartedAt: startedAt, planningRequest: REQUEST,
      planningStepIndex: 4, planningPreexistingFeatureDirs: [],
      speckitFeatureDir: NEW_FEATURE, sessions: {}
    }, null, 2));

    const run1 = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: 90000});
    check("legacy: mission did NOT complete (nonzero exit)", run1.status !== 0, run1.status);
    check("legacy: error is the recoverable tasks postcondition, not the old death",
      /planning postcondition failed/i.test(run1.stderr) && run1.stderr.includes("tasks_no_executable_phases") &&
      !run1.stderr.includes("No unchecked SpecKit tasks found"),
      run1.stderr.slice(-800));

    const events1 = readObservedEvents(repo);
    check("legacy: Implementer NEVER launched (blocked before implementation)", !events1.some(e => e.role === "implementer"), events1.map(e => e.role));
    check("legacy: code_reviewer never ran", !events1.some(e => e.role === "code_reviewer"));
    check("legacy: verifier never ran", !events1.some(e => e.role === "verifier"));

    const state1 = readState(repo);
    check("legacy: recoverable tasks checkpoint persisted",
      state1.speckitPlanningCheckpoint?.step === "tasks" &&
      state1.speckitPlanningCheckpoint?.reason === "planning-stage-postcondition" &&
      state1.speckitPlanningCheckpoint?.postcondition?.reason === "tasks_no_executable_phases",
      state1.speckitPlanningCheckpoint);
    check("legacy: same mission preserved", state1.mission === "002-smoke-test", state1.mission);
    check("legacy: same feature preserved", state1.speckitFeatureDir === NEW_FEATURE, state1.speckitFeatureDir);
    check("legacy: routed back to planning/tasks (not left tasks_ready to die again)",
      state1.phase === "planning" && state1.step === "tasks", {phase: state1.phase, step: state1.step});
    check("legacy: invalid tasks.md NOT silently rewritten by Autopilot",
      !/^## Phase /m.test(fs.readFileSync(path.join(repo, "specs", NEW_FEATURE, "tasks.md"), "utf8")));

    // Same-request retry resumes the same mission/feature at Tasks.
    const run2 = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: 120000});
    check("legacy: same-request retry completed (exit 0)", run2.status === 0, `stderr=${run2.stderr.slice(-1500)}`);
    const state2 = readState(repo);
    check("legacy: retry recorded a resume intent", state2.planningIntent?.kind === "resume", state2.planningIntent);
    check("legacy: same mission preserved through recovery", state2.mission === "002-smoke-test", state2.mission);
    check("legacy: same feature preserved through recovery", state2.speckitFeatureDir === NEW_FEATURE, state2.speckitFeatureDir);
    check("legacy: single mission folder (no mission fork)", missionDirs(repo).length === 1 && missionDirs(repo)[0] === "002-smoke-test", missionDirs(repo));
    check("legacy: retry tasks brief carried the structured correction sentinel",
      tasksCorrectionBriefs(repo).length >= 1, tasksCorrectionBriefs(repo).length);

    const events2 = readObservedEvents(repo);
    const implIdx2 = events2.findIndex(e => e.role === "implementer");
    check("legacy: implementation started only after correction", implIdx2 !== -1, events2.map(e => e.role));
    const reviewersBeforeImpl2 = implIdx2 === -1 ? [] : events2.slice(0, implIdx2).filter(e => e.role === "plan_reviewer");
    check("legacy: Tasks Review ran after corrected tasks (gate before implementer)",
      reviewersBeforeImpl2.length >= 1, events2.map(e => e.role));
    check("legacy: mission finished human_commit", state2.phase === "complete" && state2.step === "human_commit", {phase: state2.phase, step: state2.step});
    check("legacy: corrected tasks marked [x] only after verification",
      /- \[x\] Do the smoke test task/.test(fs.readFileSync(path.join(repo, "specs", NEW_FEATURE, "tasks.md"), "utf8")));
  } finally {
    cleanup(repo, binDir);
  }
}

if (failures) {
  console.error(`${failures} tasks-phase-postcondition behavioral check(s) failed.`);
  process.exit(1);
}
console.log("test-speckit-tasks-phase-postcondition: ALL CHECKS PASSED");
