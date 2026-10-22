#!/usr/bin/env node
// TASK 15.6C CORRECTION — faithful behavioral proof of the REAL observed
// Native Windows incident: the Planner's OWN specify relay call touches
// BOTH a valid spec.md and an invented, invalid multi-field
// .specify/feature.json. This is caught by enforcePlanningWriteBoundary()
// (planning-boundary.mjs's content check on every TOUCHED
// .specify/feature.json) — NOT by the postcondition module — and the
// mission escalates through the real "planning-write-boundary-violation"
// path before any reviewer launches.
//
// This is a companion to, and deliberately separate from,
// test-speckit-planning-postcondition.mjs's "invented-schema" case, which
// proves the POSTCONDITION-only path (a pre-existing invalid feature.json
// the relay call never touches). Both are real, independently reachable
// failure shapes and neither replaces the other.
//
// Proves:
//   - the first attempt fails through enforcePlanningWriteBoundary, not the
//     postcondition module (state.step === "planning-write-boundary-
//     violation", a single violation naming .specify/feature.json /
//     feature_json_unexpected_shape) — before any reviewer launches;
//   - EXACTLY this violation shape (a sole content/schema violation on the
//     allowed .specify/feature.json path) additionally persists a
//     recoverable, same-stage "specify" checkpoint;
//   - a same-request retry resumes specify (not repo-wide detection),
//     receives the exact structured correction sentinel
//     ("AUTOPILOT_PLANNING_CORRECTION={...}") in its own persisted prompt
//     (brief.txt) — proven structurally, never via prose matching — and
//     only then overwrites the invalid JSON with the exact one-field
//     schema;
//   - Plan Reviewer launches only once BOTH the write boundary and the
//     postcondition pass;
//   - a MIXED violation (the same content defect alongside an unrelated
//     boundary violation in the same call) gets no checkpoint at all and
//     stays exactly as hard-escalated/non-recoverable as any other boundary
//     violation;
//   - unrelated pre-existing features are never touched.
//
// Drives real `node scripts/autopilot.mjs run` subprocesses against
// disposable git fixture repos and the hermetic fake adapter — on POSIX,
// scripts/test-fixtures/fake-workflow-adapter.sh; on Native Windows, its
// Node.js port scripts/test-fixtures/fake-workflow-adapter-win.mjs, which
// ports every scenario this file exercises
// (`speckit_write_boundary_invented_feature_json*`, `speckit_boundary_
// violation`, `speckit_claude_md_violation`, `speckit_wrong_stage_specify`)
// branch-for-branch against the POSIX reference. All read-only roles
// (plan_reviewer) run under the framework's own platform-appropriate
// containment: WSL2/Linux bubblewrap, or the Windows disposable-copy
// compatibility bridge (autopilot.mjs's useDisposableReviewerWorkspace,
// available for planning_framework "speckit" — exactly what this file uses).
import fs from "node:fs";
import path from "node:path";
import {
  makeFixtureRepo, makeFixtureBin, makeSpecKitUnrelatedFeatureFixture, makeClaudeMdBaseline,
  setScenario, writeConfig, runAutopilot, readObservedEvents, cleanup
} from "./test-fixtures/workflow-order-harness.mjs";

// Native Windows' disposable-copy read-only role is a real filesystem copy
// per launch (materially slower than WSL2 bubblewrap); bumped consistent
// with test-speckit-plan-review-resume.mjs/test-task14-speckit-task-marking.mjs.
const MISSION_TIMEOUT_MS = process.platform === "win32" ? 220000 : 90000;
const RETRY_TIMEOUT_MS = process.platform === "win32" ? 260000 : 120000;

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

const UNRELATED = "002-dashboard-design-prototype";
const NEW_FEATURE = "999-smoke-test";
const REQUEST = "smoke test the health endpoint";
const EXACT_CORRECTION_SENTINEL = 'AUTOPILOT_PLANNING_CORRECTION={"stage":"specify","artifact":".specify/feature.json","expected":".specify/feature.json","reason":"feature_json_unexpected_shape","detail":null}';

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

function briefFor(event) {
  return fs.readFileSync(path.join(path.dirname(event.file), "brief.txt"), "utf8");
}

// A + B. The real incident: single specify call touches both spec.md and
// the invented feature.json; first attempt fails via the write boundary
// with a recoverable checkpoint; same-request retry receives the exact
// structured sentinel and self-corrects; reviewer launches only afterward.
{
  const {repo, binDir, unrelatedDir} = setUp("wb-recoverable-real-incident");
  try {
    const unrelatedBefore = {
      spec: fs.readFileSync(path.join(unrelatedDir, "spec.md"), "utf8"),
      plan: fs.readFileSync(path.join(unrelatedDir, "plan.md"), "utf8"),
      tasks: fs.readFileSync(path.join(unrelatedDir, "tasks.md"), "utf8")
    };
    setScenario(repo, "speckit_write_boundary_invented_feature_json");
    const run1 = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: MISSION_TIMEOUT_MS});

    check("real-incident: first attempt did NOT complete (nonzero exit)", run1.status !== 0, run1.status);
    check("real-incident: error is the real write-boundary path", /planning-stage write boundary/i.test(run1.stderr), run1.stderr.slice(-800));
    check("real-incident: error names feature.json", run1.stderr.includes(".specify/feature.json"), run1.stderr.slice(-800));
    check("real-incident: error names the exact-schema reason", run1.stderr.includes("feature_json_unexpected_shape"), run1.stderr.slice(-800));
    check("real-incident: 'Spec ready' was NOT printed", !run1.stdout.includes("Spec ready"));

    const events1 = readObservedEvents(repo);
    check("real-incident: planner ran for specify", events1.some(e => e.role === "planner"));
    check("real-incident: Plan Reviewer was NEVER launched on first attempt", !reviewerLaunched(events1), events1.map(e => e.role));

    const state1 = readState(repo);
    check("real-incident: step names the real write-boundary-violation path", state1.step === "planning-write-boundary-violation", state1.step);
    check("real-incident: phase escalated", state1.phase === "escalated", state1.phase);
    check("real-incident: exactly one violation recorded", Array.isArray(state1.planningWriteBoundaryViolation?.violations) && state1.planningWriteBoundaryViolation.violations.length === 1, state1.planningWriteBoundaryViolation);
    check("real-incident: violation names feature.json / feature_json_unexpected_shape",
      state1.planningWriteBoundaryViolation?.violations?.[0]?.path === ".specify/feature.json" &&
      state1.planningWriteBoundaryViolation?.violations?.[0]?.reason === "feature_json_unexpected_shape",
      state1.planningWriteBoundaryViolation);
    check("real-incident: recoverable checkpoint persists for specify", state1.speckitPlanningCheckpoint?.step === "specify", state1.speckitPlanningCheckpoint);
    check("real-incident: checkpoint carries the write-boundary-content-violation reason",
      state1.speckitPlanningCheckpoint?.reason === "planning-write-boundary-content-violation", state1.speckitPlanningCheckpoint);
    check("real-incident: checkpoint's boundary sub-object names the exact artifact and reason",
      state1.speckitPlanningCheckpoint?.boundary?.path === ".specify/feature.json" &&
      state1.speckitPlanningCheckpoint?.boundary?.reason === "feature_json_unexpected_shape",
      state1.speckitPlanningCheckpoint?.boundary);
    check("real-incident: session feature identity locked despite the failure", state1.speckitFeatureDir === NEW_FEATURE, state1.speckitFeatureDir);
    check("real-incident: spec.md was written by the first (failed) attempt",
      fs.existsSync(path.join(repo, "specs", NEW_FEATURE, "spec.md")) && fs.readFileSync(path.join(repo, "specs", NEW_FEATURE, "spec.md"), "utf8").trim().length > 0);
    check("real-incident: the invented feature.json is still on disk, still invalid",
      Object.keys(JSON.parse(fs.readFileSync(path.join(repo, ".specify", "feature.json"), "utf8"))).length === 7);

    // Structured feedback proof: the FIRST attempt's own persisted prompt
    // carried no correction sentinel at all (nothing to correct yet).
    const firstSpecifyBrief = briefFor(events1.filter(e => e.role === "planner")[0]);
    check("real-incident: first attempt's prompt carried NO correction sentinel", !firstSpecifyBrief.includes("AUTOPILOT_PLANNING_CORRECTION="));

    setScenario(repo, "speckit_write_boundary_invented_feature_json");
    const run2 = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: RETRY_TIMEOUT_MS});
    check("real-incident: same-request retry completed (exit 0)", run2.status === 0, `stderr=${run2.stderr.slice(-1500)}`);
    check("real-incident: retry recorded a resume intent", readState(repo).planningIntent?.kind === "resume", readState(repo).planningIntent);

    const events2 = readObservedEvents(repo);
    const planners2 = events2.filter(e => e.role === "planner");
    check("real-incident: specify ran again before any reviewer",
      planners2.length >= 2 && events2[0].role === "planner" && events2[1].role === "planner" && !events2.slice(0, 2).some(e => e.role === "plan_reviewer"),
      events2.slice(0, 4).map(e => e.role));

    // Structured feedback proof: the SECOND attempt's own persisted prompt
    // carries the EXACT structured sentinel — a stable contract marker, not
    // prose — naming this precise stage, artifact, expected path, and
    // reason.
    const secondSpecifyBrief = briefFor(planners2[1]);
    check("real-incident: retry's persisted prompt carries the exact structured correction sentinel",
      secondSpecifyBrief.includes(EXACT_CORRECTION_SENTINEL), secondSpecifyBrief.slice(-1200));

    const featureJsonAfter = JSON.parse(fs.readFileSync(path.join(repo, ".specify", "feature.json"), "utf8"));
    check("real-incident: second attempt wrote the exact one-field schema",
      Object.keys(featureJsonAfter).length === 1 && featureJsonAfter.feature_directory === `specs/${NEW_FEATURE}`, featureJsonAfter);

    check("real-incident: reviewer launched only after boundary + postcondition both passed (workflow advanced)", reviewerLaunched(events2));
    check("real-incident: same feature identity resumed", readState(repo).speckitFeatureDir === NEW_FEATURE, readState(repo).speckitFeatureDir);
    check("real-incident: checkpoint cleared once specify passed", !readState(repo).speckitPlanningCheckpoint, readState(repo).speckitPlanningCheckpoint);

    check("real-incident: unrelated spec.md byte-for-byte unchanged", fs.readFileSync(path.join(unrelatedDir, "spec.md"), "utf8") === unrelatedBefore.spec);
    check("real-incident: unrelated plan.md byte-for-byte unchanged", fs.readFileSync(path.join(unrelatedDir, "plan.md"), "utf8") === unrelatedBefore.plan);
    check("real-incident: unrelated tasks.md byte-for-byte unchanged", fs.readFileSync(path.join(unrelatedDir, "tasks.md"), "utf8") === unrelatedBefore.tasks);
  } finally {
    cleanup(repo, binDir);
  }
}

// C. Negative control: mixing the SAME content violation with an unrelated
// boundary violation in one call must NOT qualify as recoverable — no
// checkpoint at all, exactly the pre-existing hard-escalation behavior.
{
  const {repo, binDir} = setUp("wb-recoverable-mixed-violation");
  try {
    setScenario(repo, "speckit_write_boundary_invented_feature_json_mixed");
    const run = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: MISSION_TIMEOUT_MS});

    check("mixed-violation: mission did NOT complete (nonzero exit)", run.status !== 0, run.status);
    check("mixed-violation: error is the real write-boundary path", /planning-stage write boundary/i.test(run.stderr), run.stderr.slice(-800));

    const state = readState(repo);
    check("mixed-violation: phase escalated", state.phase === "escalated", state.phase);
    check("mixed-violation: step names the write-boundary violation", state.step === "planning-write-boundary-violation", state.step);
    check("mixed-violation: two violations recorded (not a sole content violation)",
      Array.isArray(state.planningWriteBoundaryViolation?.violations) && state.planningWriteBoundaryViolation.violations.length === 2,
      state.planningWriteBoundaryViolation);
    check("mixed-violation: NO recoverable checkpoint was created", !state.speckitPlanningCheckpoint, state.speckitPlanningCheckpoint);

    const events = readObservedEvents(repo);
    check("mixed-violation: Plan Reviewer was never launched", !reviewerLaunched(events), events.map(e => e.role));
    check("mixed-violation: implementer never ran", !events.some(e => e.role === "implementer"));
  } finally {
    cleanup(repo, binDir);
  }
}

// D. Negative controls reusing EXISTING non-recoverable boundary-violation
// scenarios (test-speckit-new-request-isolation.mjs already proves these
// escalate; this only closes the gap of proving NO checkpoint is created
// for them either, i.e. they stay genuinely non-recoverable, not merely
// "escalated but secretly resumable").
for (const {label, scenario} of [
  {label: "outside-boundary-path", scenario: "speckit_boundary_violation"},
  {label: "claude-md-outside-marker", scenario: "speckit_claude_md_violation"},
  {label: "unrelated-wrong-stage-artifact", scenario: "speckit_wrong_stage_specify"}
]) {
  const {repo, binDir} = setUp(`wb-nonrecoverable-${label}`);
  try {
    setScenario(repo, scenario);
    const run = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: MISSION_TIMEOUT_MS});
    check(`${label}: mission did NOT complete (nonzero exit)`, run.status !== 0, run.status);
    const state = readState(repo);
    check(`${label}: escalated via the real write-boundary path`, state.step === "planning-write-boundary-violation", state.step);
    check(`${label}: NO recoverable checkpoint was created`, !state.speckitPlanningCheckpoint, state.speckitPlanningCheckpoint);
  } finally {
    cleanup(repo, binDir);
  }
}

if (failures) {
  console.error(`${failures} write-boundary-recoverable behavioral check(s) failed.`);
  process.exit(1);
}
console.log("test-speckit-write-boundary-recoverable: ALL CHECKS PASSED");
