#!/usr/bin/env node
// TASK 15.6B — behavioral proof that a SpecKit planning stage with an
// exit-zero Planner but missing/invalid on-disk artifacts fails IMMEDIATELY
// at the planning command itself: no "<stage> ready", no workflow advance,
// no Plan Reviewer launch, nonzero exit naming stage/artifact/expected path,
// a retryable same-stage checkpoint, and safe same-request resume.
//
// Companion to scripts/test-speckit-planning-postconditions.mjs (unit):
// that file proves the validator's exact reason matrix on disposable
// directories; THIS file proves mission-level behavior through the real
// public entrypoint — immediate stage failure, no reviewer launch, no
// "ready" message, same-stage checkpoint, and safe same-request resume.
// Neither file duplicates the other: unit asserts validator reasons,
// missions assert process outcome, roles launched, and filesystem state.
//
// Drives real `node scripts/autopilot.mjs run` subprocesses against
// disposable git fixture repos and the hermetic fake adapter — on POSIX,
// scripts/test-fixtures/fake-workflow-adapter.sh; on Native Windows, its
// Node.js port scripts/test-fixtures/fake-workflow-adapter-win.mjs, which
// ports every `speckit_postcondition_*` scenario this file exercises
// branch-for-branch against the POSIX reference (added by the 16.3E
// CORRECTION pass — a missing Windows fixture branch is not a valid platform
// prerequisite). Inspects OBSERVED process outcome, stdout/stderr,
// result.json roles launched, state.json, and filesystem state — never
// prompt prose or internal helper call counts. All read-only roles
// (plan_reviewer) run under the framework's own platform-appropriate
// containment: WSL2/Linux bubblewrap, or the Windows disposable-copy
// compatibility bridge (available for planning_framework "speckit" — exactly
// what this file uses).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  makeFixtureRepo, makeFixtureBin, makeSpecKitUnrelatedFeatureFixture, makeSpecKitWorkflowOnly, makeClaudeMdBaseline,
  makeInventedFeatureJsonFixture, setScenario, writeConfig, runAutopilot, readObservedEvents, cleanup
} from "./test-fixtures/workflow-order-harness.mjs";

// Native Windows' disposable-copy read-only role is a real filesystem copy
// per launch (materially slower than WSL2 bubblewrap); bumped consistent
// with test-speckit-plan-review-resume.mjs/test-task14-speckit-task-marking.mjs.
const MISSION_TIMEOUT_MS = process.platform === "win32" ? 220000 : 90000;
const RETRY_TIMEOUT_MS = process.platform === "win32" ? 260000 : 120000;

// TASK 16.3E CORRECTION: real runtime capability probe (never a platform
// assumption) for section H's symlink-escape fixture. POSIX `ln -s` needs no
// special privilege, so this is always true there. On Windows,
// fs.symlinkSync's 'file'/'dir' types need SeCreateSymbolicLinkPrivilege
// (Developer Mode/elevation) and are genuinely unavailable on a default
// install — but a directory junction ('junction' type) proves the identical
// production contract (see fake-workflow-adapter-win.mjs's
// writeSymlinkEscapeSpec) and needs no elevated privilege at all, so this
// probes THAT capability, not the unrelated symlink privilege.
const junctionCapable = (() => {
  if (process.platform !== "win32") return true;
  let probeDir = null;
  let targetDir = null;
  try {
    probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-junction-probe-"));
    targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-junction-target-"));
    fs.symlinkSync(targetDir, path.join(probeDir, "link"), "junction");
    return true;
  } catch {
    return false;
  } finally {
    if (probeDir) fs.rmSync(probeDir, {recursive: true, force: true});
    if (targetDir) fs.rmSync(targetDir, {recursive: true, force: true});
  }
})();

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

const UNRELATED = "002-dashboard-design-prototype";
const NEW_FEATURE = "999-smoke-test";
const REQUEST = "smoke test the health endpoint";

function setUp(prefix, {withUnrelated = true} = {}) {
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  let unrelatedDir = null;
  if (withUnrelated) unrelatedDir = makeSpecKitUnrelatedFeatureFixture(repo, UNRELATED);
  makeClaudeMdBaseline(repo);
  writeConfig(repo, {planningFramework: "speckit"});
  return {repo, binDir, unrelatedDir};
}

function readState(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
}

function reviewerLaunched(events) {
  return events.some(e => e.role === "plan_reviewer");
}

// A. Exit-zero planner, zero artifacts (the exact 15.6B incident).
{
  const {repo, binDir, unrelatedDir} = setUp("postcond-no-output");
  try {
    const beforeSpec = fs.readFileSync(path.join(unrelatedDir, "spec.md"), "utf8");
    setScenario(repo, "speckit_postcondition_no_output");
    const run = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: MISSION_TIMEOUT_MS});

    check("no-output: mission did NOT complete (nonzero exit)", run.status !== 0, run.status);
    check("no-output: error names the postcondition failure", /planning postcondition failed/i.test(run.stderr), run.stderr.slice(-800));
    check("no-output: error names the specify stage", run.stderr.includes("'specify'"), run.stderr.slice(-800));
    check("no-output: error names the expected feature.json path", run.stderr.includes(".specify/feature.json"), run.stderr.slice(-800));
    check("no-output: 'Spec ready' was NOT printed", !run.stdout.includes("Spec ready"), run.stdout.slice(-800));

    const events = readObservedEvents(repo);
    check("no-output: planner ran for specify", events.some(e => e.role === "planner"));
    check("no-output: Plan Reviewer was NEVER launched", !reviewerLaunched(events), events.map(e => e.role));
    check("no-output: implementer never ran", !events.some(e => e.role === "implementer"));
    check("no-output: code_reviewer never ran", !events.some(e => e.role === "code_reviewer"));

    const state = readState(repo);
    check("no-output: checkpoint persists for the same stage", state.speckitPlanningCheckpoint?.step === "specify", state.speckitPlanningCheckpoint);
    check("no-output: checkpoint carries the postcondition reason", state.speckitPlanningCheckpoint?.reason === "planning-stage-postcondition");
    check("no-output: workflow did not advance past specify", state.step === "specify", state.step);
    check("no-output: never reached tasks_ready/implementation", state.phase !== "tasks_ready" && state.phase !== "implementing", state.phase);
    check("no-output: unrelated feature spec.md byte-for-byte unchanged", fs.readFileSync(path.join(unrelatedDir, "spec.md"), "utf8") === beforeSpec);
    check("no-output: no feature.json was fabricated", !fs.existsSync(path.join(repo, ".specify", "feature.json")));
    check("no-output: no new spec.md was fabricated", !fs.existsSync(path.join(repo, "specs", NEW_FEATURE, "spec.md")));
  } finally {
    cleanup(repo, binDir);
  }
}

// B. Valid feature.json but empty spec.md.
{
  const {repo, binDir} = setUp("postcond-empty-spec");
  try {
    setScenario(repo, "speckit_postcondition_empty_spec");
    const run = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: MISSION_TIMEOUT_MS});

    check("empty-spec: mission did NOT complete (nonzero exit)", run.status !== 0, run.status);
    check("empty-spec: error names the specify stage and spec.md", /planning postcondition failed/i.test(run.stderr) && run.stderr.includes("'specify'") && run.stderr.includes("spec.md"), run.stderr.slice(-800));
    check("empty-spec: error names the expected spec path", run.stderr.includes(`specs/${NEW_FEATURE}/spec.md`), run.stderr.slice(-800));
    check("empty-spec: 'Spec ready' was NOT printed", !run.stdout.includes("Spec ready"));

    const events = readObservedEvents(repo);
    check("empty-spec: Plan Reviewer was NEVER launched", !reviewerLaunched(events), events.map(e => e.role));

    const state = readState(repo);
    check("empty-spec: checkpoint persists for specify", state.speckitPlanningCheckpoint?.step === "specify");
    check("empty-spec: session feature identity preserved", state.speckitFeatureDir === NEW_FEATURE, state.speckitFeatureDir);
  } finally {
    cleanup(repo, binDir);
  }
}

// C. Valid specify, empty plan.md: specify passes (reviewer launches), plan fails.
{
  const {repo, binDir} = setUp("postcond-empty-plan");
  try {
    setScenario(repo, "speckit_postcondition_empty_plan");
    const run = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: MISSION_TIMEOUT_MS});

    check("empty-plan: mission did NOT complete (nonzero exit)", run.status !== 0, run.status);
    check("empty-plan: error names the plan stage and plan.md", /planning postcondition failed/i.test(run.stderr) && run.stderr.includes("'plan'") && run.stderr.includes("plan.md"), run.stderr.slice(-800));
    check("empty-plan: error names the expected plan path", run.stderr.includes(`specs/${NEW_FEATURE}/plan.md`), run.stderr.slice(-800));
    check("empty-plan: 'Spec ready' WAS printed (valid specify passes)", run.stdout.includes("Spec ready"), run.stdout.slice(-800));
    check("empty-plan: 'Plan ready' was NOT printed", !run.stdout.includes("Plan ready"));

    const events = readObservedEvents(repo);
    const reviewerRuns = events.filter(e => e.role === "plan_reviewer");
    check("empty-plan: review-spec gate launched after valid specify (reviewer may launch)", reviewerRuns.length >= 1, events.map(e => e.role));
    check("empty-plan: code_reviewer never ran", !events.some(e => e.role === "code_reviewer"));

    const state = readState(repo);
    check("empty-plan: checkpoint persists for plan", state.speckitPlanningCheckpoint?.step === "plan", state.speckitPlanningCheckpoint);
  } finally {
    cleanup(repo, binDir);
  }
}

// D. Valid specify+plan, checked-only tasks.md: fails at tasks, never implements.
{
  const {repo, binDir} = setUp("postcond-checked-tasks");
  try {
    setScenario(repo, "speckit_postcondition_checked_tasks");
    const run = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: MISSION_TIMEOUT_MS});

    check("checked-tasks: mission did NOT complete (nonzero exit)", run.status !== 0, run.status);
    check("checked-tasks: error names tasks with no unchecked actionable tasks", /planning postcondition failed/i.test(run.stderr) && run.stderr.includes("'tasks'") && /no_unchecked_actionable_tasks|tasks\.md/.test(run.stderr), run.stderr.slice(-800));
    check("checked-tasks: 'Tasks ready' was NOT printed", !run.stdout.includes("Tasks ready"));

    const events = readObservedEvents(repo);
    const reviewerRuns = events.filter(e => e.role === "plan_reviewer");
    check("checked-tasks: review-spec and review-plan gates launched (valid plan passes)", reviewerRuns.length >= 2, events.map(e => `${e.role}:${e.decision}`));
    check("checked-tasks: implementer never ran (valid tasks required first)", !events.some(e => e.role === "implementer"), events.map(e => e.role));

    const state = readState(repo);
    check("checked-tasks: checkpoint persists for tasks", state.speckitPlanningCheckpoint?.step === "tasks", state.speckitPlanningCheckpoint);
    check("checked-tasks: never reached tasks_ready/implementation", state.phase !== "tasks_ready" && state.phase !== "implementing", state.phase);
  } finally {
    cleanup(repo, binDir);
  }
}

// E. Valid specify+plan, tasks.md never written at all.
{
  const {repo, binDir} = setUp("postcond-missing-tasks");
  try {
    setScenario(repo, "speckit_postcondition_missing_tasks");
    const run = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: MISSION_TIMEOUT_MS});

    check("missing-tasks: mission did NOT complete (nonzero exit)", run.status !== 0, run.status);
    check("missing-tasks: error names the missing tasks.md", /planning postcondition failed/i.test(run.stderr) && run.stderr.includes("'tasks'") && run.stderr.includes(`specs/${NEW_FEATURE}/tasks.md`), run.stderr.slice(-800));

    const events = readObservedEvents(repo);
    check("missing-tasks: implementer never ran", !events.some(e => e.role === "implementer"), events.map(e => e.role));
  } finally {
    cleanup(repo, binDir);
  }
}

// F. Same-request rerun resumes the failed specify stage and completes.
{
  const {repo, binDir} = setUp("postcond-resume", {withUnrelated: false});
  try {
    makeSpecKitWorkflowOnly(repo);
    setScenario(repo, "speckit_postcondition_no_output");
    const run1 = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: MISSION_TIMEOUT_MS});
    check("resume: first run failed at specify", run1.status !== 0);
    const state1 = readState(repo);
    check("resume: first run checkpointed specify", state1.speckitPlanningCheckpoint?.step === "specify");

    setScenario(repo, "speckit_full_contract");
    const run2 = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: RETRY_TIMEOUT_MS});
    check("resume: same-request rerun completed (exit 0)", run2.status === 0, `stderr=${run2.stderr.slice(-1500)}`);
    check("resume: rerun recorded a resume intent", readState(repo).planningIntent?.kind === "resume", readState(repo).planningIntent);

    const specFile = path.join(repo, "specs", NEW_FEATURE, "spec.md");
    check("resume: spec.md now exists with content", fs.existsSync(specFile) && fs.readFileSync(specFile, "utf8").trim().length > 0);
    check("resume: plan.md now exists with content", fs.existsSync(path.join(repo, "specs", NEW_FEATURE, "plan.md")));
    const tasksFile = path.join(repo, "specs", NEW_FEATURE, "tasks.md");
    // By mission end the tasks are legitimately marked [x] (Autopilot owns
    // checkbox state); what matters is that a valid tasks.md was produced.
    check("resume: tasks.md now exists with parseable tasks", fs.existsSync(tasksFile) && /-\s*\[[ xX]\]/.test(fs.readFileSync(tasksFile, "utf8")));

    const events = readObservedEvents(repo);
    const planners = events.filter(e => e.role === "planner");
    check("resume: planner re-ran the failed specify stage", planners.length >= 4, events.map(e => e.role));
    check("resume: reviewer launched after the resumed specify", reviewerLaunched(events));
    check("resume: implementation began after valid tasks (implementer ran)", events.some(e => e.role === "implementer"), events.map(e => e.role));
  } finally {
    cleanup(repo, binDir);
  }
}

// G. Exit-zero planner writes ONLY spec.md, never feature.json: the lock
// alone satisfies nothing — specify must fail naming feature.json.
{
  const {repo, binDir} = setUp("postcond-no-feature-json");
  try {
    setScenario(repo, "speckit_postcondition_spec_without_feature_json");
    const run = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: MISSION_TIMEOUT_MS});

    check("no-feature-json: mission did NOT complete (nonzero exit)", run.status !== 0, run.status);
    check("no-feature-json: error names feature.json, not the spec", /planning postcondition failed/i.test(run.stderr) && run.stderr.includes("'specify'") && run.stderr.includes(".specify/feature.json"), run.stderr.slice(-800));
    check("no-feature-json: 'Spec ready' was NOT printed", !run.stdout.includes("Spec ready"));

    const events = readObservedEvents(repo);
    check("no-feature-json: Plan Reviewer was NEVER launched", !reviewerLaunched(events), events.map(e => e.role));
    check("no-feature-json: no feature.json was fabricated", !fs.existsSync(path.join(repo, ".specify", "feature.json")));
  } finally {
    cleanup(repo, binDir);
  }
}

// H. Exit-zero planner smuggles a symlink as spec.md: rejected before review.
// On Windows this uses a directory junction (see junctionCapable above) —
// the real, privilege-free Windows equivalent of a POSIX symlink escape,
// not an approximation; only self-skipped if junction creation itself is
// genuinely unavailable on this host.
// TASK 16.3E CORRECTION 2: this literal must match SYMLINK_ESCAPE_TARGET_
// DIRNAME in fake-workflow-adapter-win.mjs exactly — the two files share no
// module boundary (the fixture runs as a separately-spawned child process),
// so the name is duplicated rather than imported. The target directory lives
// under binDir (genuinely outside repo, and already owned/cleaned up by this
// test's own cleanup(repo, binDir) call below) instead of a bare os.tmpdir()
// mkdtemp, which the fixture process could never clean up itself.
const SYMLINK_ESCAPE_TARGET_DIRNAME = "symlink-escape-target";

if (!junctionCapable) {
  console.log("SKIP symlink-escape: platform prerequisite not met — this host cannot create a Windows directory junction (fs.symlinkSync 'junction' probe failed), the privilege-free equivalent this scenario needs on Windows.");
} else {
  const {repo, binDir} = setUp("postcond-symlink-escape");
  const junctionTarget = path.join(binDir, SYMLINK_ESCAPE_TARGET_DIRNAME);
  try {
    setScenario(repo, "speckit_postcondition_symlink_escape");
    const run = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: MISSION_TIMEOUT_MS});

    check("symlink-escape: mission did NOT complete (nonzero exit)", run.status !== 0, run.status);
    check("symlink-escape: error names the symlinked spec.md", /planning postcondition failed/i.test(run.stderr) && run.stderr.includes("'specify'") && /symlink_rejected|path_escape/.test(run.stderr), run.stderr.slice(-800));
    check("symlink-escape: 'Spec ready' was NOT printed", !run.stdout.includes("Spec ready"));

    const events = readObservedEvents(repo);
    check("symlink-escape: Plan Reviewer was NEVER launched", !reviewerLaunched(events), events.map(e => e.role));

    const state = readState(repo);
    check("symlink-escape: checkpoint persists for specify", state.speckitPlanningCheckpoint?.step === "specify", state.speckitPlanningCheckpoint);

    // Cleanup-correctness proof (TASK 16.3E CORRECTION 2): Windows-only —
    // the Windows fixture (fake-workflow-adapter-win.mjs's
    // writeSymlinkEscapeSpec) creates an owned junction-target directory
    // under binDir specifically because a bare os.tmpdir() mkdtemp used to
    // leak (the bug this correction fixes). POSIX's fake-workflow-
    // adapter.sh instead `ln -s /etc/hostname "$FEATURE_DIR/spec.md"` — a
    // real absolute-path symlink to an existing system file, with no owned
    // target directory of its own and nothing to leak, so this assertion
    // does not apply there (confirmed: asserting it unconditionally broke
    // WSL2 — the target path never exists on POSIX in the first place).
    if (process.platform === "win32") {
      check("symlink-escape: junction target was created at the exact test-owned path", fs.existsSync(junctionTarget) && fs.statSync(junctionTarget).isDirectory(), junctionTarget);
    }
  } finally {
    cleanup(repo, binDir);
  }
  // Windows-only (see above). The junction target lives under binDir, so
  // cleanup(repo, binDir)'s removal of binDir must have taken it with it —
  // proving no orphan is left behind, on PASS, FAIL, or an exception
  // unwinding through finally.
  if (process.platform === "win32") {
    check("symlink-escape: junction target is gone after cleanup (no Temp leak)", !fs.existsSync(junctionTarget), junctionTarget);
  }
}

// I. Same-request rerun after a specify postcondition failure must resume
// specify even when repository-wide detection reports "complete" from an
// UNRELATED completed feature — and must never adopt that feature.
{
  const {repo, binDir, unrelatedDir} = setUp("postcond-resume-unrelated");
  try {
    const unrelatedBefore = {
      spec: fs.readFileSync(path.join(unrelatedDir, "spec.md"), "utf8"),
      plan: fs.readFileSync(path.join(unrelatedDir, "plan.md"), "utf8"),
      tasks: fs.readFileSync(path.join(unrelatedDir, "tasks.md"), "utf8")
    };
    setScenario(repo, "speckit_postcondition_no_output");
    const run1 = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: MISSION_TIMEOUT_MS});
    check("resume-unrelated: first run failed at specify", run1.status !== 0);
    const state1 = readState(repo);
    check("resume-unrelated: first run checkpointed specify", state1.speckitPlanningCheckpoint?.step === "specify");
    check("resume-unrelated: no session feature was resolved", state1.speckitFeatureDir == null, state1.speckitFeatureDir);

    setScenario(repo, "speckit_full_contract");
    const run2 = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: RETRY_TIMEOUT_MS});
    check("resume-unrelated: same-request rerun completed (exit 0)", run2.status === 0, `stderr=${run2.stderr.slice(-1500)}`);

    const events = readObservedEvents(repo);
    check("resume-unrelated: specify ran again before any reviewer",
      events.length >= 2 && events[0].role === "planner" && events[1].role === "planner" && !events.slice(0, 2).some(e => e.role === "plan_reviewer"),
      events.slice(0, 4).map(e => e.role));
    check("resume-unrelated: unrelated feature was never adopted", readState(repo).speckitFeatureDir === NEW_FEATURE, readState(repo).speckitFeatureDir);
    check("resume-unrelated: unrelated spec.md byte-for-byte unchanged", fs.readFileSync(path.join(unrelatedDir, "spec.md"), "utf8") === unrelatedBefore.spec);
    check("resume-unrelated: unrelated plan.md byte-for-byte unchanged", fs.readFileSync(path.join(unrelatedDir, "plan.md"), "utf8") === unrelatedBefore.plan);
    check("resume-unrelated: unrelated tasks.md byte-for-byte unchanged", fs.readFileSync(path.join(unrelatedDir, "tasks.md"), "utf8") === unrelatedBefore.tasks);
    check("resume-unrelated: session feature.json points at the new feature",
      fs.existsSync(path.join(repo, ".specify", "feature.json")) &&
      JSON.parse(fs.readFileSync(path.join(repo, ".specify", "feature.json"), "utf8")).feature_directory === `specs/${NEW_FEATURE}`);
    check("resume-unrelated: new spec.md exists with content",
      fs.existsSync(path.join(repo, "specs", NEW_FEATURE, "spec.md")) && fs.readFileSync(path.join(repo, "specs", NEW_FEATURE, "spec.md"), "utf8").trim().length > 0);
  } finally {
    cleanup(repo, binDir);
  }
}

// J. TASK 15.6C — the real observed incident: an exit-zero Planner's specify
// call writes a valid spec.md but leaves in place a pre-existing INVENTED
// multi-field .specify/feature.json (never touched this call, so the
// write-boundary check cannot see it). The postcondition must reject it
// before any reviewer launches and checkpoint exactly this stage; a
// same-request retry must receive the persisted failure as structured
// correction context (asserted only via the validator's own stable reason
// code and paths, never prompt prose) and the Planner must self-correct.
{
  const {repo, binDir, unrelatedDir} = setUp("postcond-invented-schema");
  try {
    const unrelatedBefore = {
      spec: fs.readFileSync(path.join(unrelatedDir, "spec.md"), "utf8"),
      plan: fs.readFileSync(path.join(unrelatedDir, "plan.md"), "utf8"),
      tasks: fs.readFileSync(path.join(unrelatedDir, "tasks.md"), "utf8")
    };
    makeInventedFeatureJsonFixture(repo, `specs/${NEW_FEATURE}`);
    setScenario(repo, "speckit_postcondition_invented_feature_json_schema");
    const run1 = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: MISSION_TIMEOUT_MS});

    check("invented-schema: first attempt did NOT complete (nonzero exit)", run1.status !== 0, run1.status);
    check("invented-schema: error names specify and feature.json", /planning postcondition failed/i.test(run1.stderr) && run1.stderr.includes("'specify'") && run1.stderr.includes(".specify/feature.json"), run1.stderr.slice(-800));
    check("invented-schema: 'Spec ready' was NOT printed", !run1.stdout.includes("Spec ready"));

    const events1 = readObservedEvents(repo);
    check("invented-schema: planner ran for specify", events1.some(e => e.role === "planner"));
    check("invented-schema: Plan Reviewer was NEVER launched on first attempt", !reviewerLaunched(events1), events1.map(e => e.role));

    const state1 = readState(repo);
    check("invented-schema: checkpoint persists for specify", state1.speckitPlanningCheckpoint?.step === "specify", state1.speckitPlanningCheckpoint);
    check("invented-schema: checkpoint carries the postcondition reason", state1.speckitPlanningCheckpoint?.reason === "planning-stage-postcondition");
    check("invented-schema: checkpoint carries the exact-schema failure reason code",
      state1.speckitPlanningCheckpoint?.postcondition?.reason === "feature_json_unexpected_shape", state1.speckitPlanningCheckpoint?.postcondition);
    check("invented-schema: checkpoint carries the failing artifact path",
      state1.speckitPlanningCheckpoint?.postcondition?.artifact === ".specify/feature.json", state1.speckitPlanningCheckpoint?.postcondition);
    check("invented-schema: checkpoint carries the expected path",
      state1.speckitPlanningCheckpoint?.postcondition?.expected === ".specify/feature.json", state1.speckitPlanningCheckpoint?.postcondition);
    check("invented-schema: the invented feature.json was left on disk untouched (still invalid)",
      JSON.parse(fs.readFileSync(path.join(repo, ".specify", "feature.json"), "utf8")).feature_name === "smoke-test");

    setScenario(repo, "speckit_postcondition_invented_feature_json_schema");
    const run2 = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: RETRY_TIMEOUT_MS});
    check("invented-schema: same-request retry completed (exit 0)", run2.status === 0, `stderr=${run2.stderr.slice(-1500)}`);
    check("invented-schema: retry recorded a resume intent", readState(repo).planningIntent?.kind === "resume", readState(repo).planningIntent);

    const featureJsonAfter = JSON.parse(fs.readFileSync(path.join(repo, ".specify", "feature.json"), "utf8"));
    check("invented-schema: second attempt wrote the exact one-field schema",
      Object.keys(featureJsonAfter).length === 1 && featureJsonAfter.feature_directory === `specs/${NEW_FEATURE}`, featureJsonAfter);

    const events2 = readObservedEvents(repo);
    const planners2 = events2.filter(e => e.role === "planner");
    check("invented-schema: specify ran again before any reviewer",
      planners2.length >= 2 && events2[0].role === "planner" && events2[1].role === "planner" && !events2.slice(0, 2).some(e => e.role === "plan_reviewer"),
      events2.slice(0, 4).map(e => e.role));
    check("invented-schema: reviewer launched after the resumed specify (workflow advanced)", reviewerLaunched(events2));
    check("invented-schema: same feature identity resumed", readState(repo).speckitFeatureDir === NEW_FEATURE, readState(repo).speckitFeatureDir);
    check("invented-schema: checkpoint cleared once specify passed", !readState(repo).speckitPlanningCheckpoint, readState(repo).speckitPlanningCheckpoint);

    check("invented-schema: unrelated spec.md byte-for-byte unchanged", fs.readFileSync(path.join(unrelatedDir, "spec.md"), "utf8") === unrelatedBefore.spec);
    check("invented-schema: unrelated plan.md byte-for-byte unchanged", fs.readFileSync(path.join(unrelatedDir, "plan.md"), "utf8") === unrelatedBefore.plan);
    check("invented-schema: unrelated tasks.md byte-for-byte unchanged", fs.readFileSync(path.join(unrelatedDir, "tasks.md"), "utf8") === unrelatedBefore.tasks);
  } finally {
    cleanup(repo, binDir);
  }
}

if (failures) {
  console.error(`${failures} planning-postcondition behavioral check(s) failed.`);
  process.exit(1);
}
console.log("test-speckit-planning-postcondition: ALL CHECKS PASSED");
