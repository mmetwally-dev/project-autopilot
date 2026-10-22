#!/usr/bin/env node
// Behavioral proof (TASK 3) that a NEW SpecKit planning request is never
// attached to an unrelated existing feature merely because that feature
// already has complete spec/plan/tasks artifacts, that each planning
// stage may only write ITS OWN slice of the real speckit-specify/
// speckit-plan/speckit-tasks artifact contract (never a file that is
// merely "somewhere under the right feature directory" but wrong for the
// current stage, and never an implementation deliverable), that an
// interrupted matching resume continues the SAME feature, and that
// Implementation never starts before Plan Review PASS. Drives real
// `node scripts/autopilot.mjs run` subprocesses against disposable git
// fixture repos and the fake adapter CLI
// (scripts/test-fixtures/fake-workflow-adapter.sh, which emulates the real
// artifact contract: .specify/feature.json, specs/<feature>/{spec,plan,
// research,data-model,quickstart,tasks}.md, specs/<feature>/{checklists,
// contracts}/**, and the controlled CLAUDE.md marker section), then
// inspects OBSERVED filesystem state and the orchestrator's own
// result.json/state.json — never prompt wording.
import fs from "node:fs";
import path from "node:path";
import {
  makeFixtureRepo, makeFixtureBin, makeSpecKitUnrelatedFeatureFixture, makeClaudeMdBaseline,
  setScenario, writeConfig, runAutopilot, runAutopilotUntilMarker,
  readObservedEvents, cleanup
} from "./test-fixtures/workflow-order-harness.mjs";
import {CLAUDE_MD_MARKER_BEGIN, CLAUDE_MD_MARKER_END} from "./planning-boundary.mjs";

// Each full mission below is a real 7-phase SpecKit run where every
// read-only role (plan_reviewer/code_reviewer/verifier) launches inside the
// Windows disposable-copy compatibility bridge — a real, full filesystem
// copy of the repository per invocation, not a bind-mount — which costs
// materially more wall-clock time than WSL2's bubblewrap (see
// test-windows-disposable-plan-reviewer.mjs's own 220000ms budget for a
// single such mission). 90000ms is enough on Linux/WSL2; native Windows
// needs the same order-of-magnitude headroom as that established sibling.
const MISSION_TIMEOUT_MS = process.platform === "win32" ? 220000 : 90000;
// The speckit_resume interruption marker fires only after Spec and Spec
// Review have already completed (the Planner writes it right as the Plan
// step starts) — Spec Review alone is a full disposable-copy round trip on
// Windows, so the fixed 30s deadline that's plenty on Linux/WSL2 can run
// too close to the wire under real system load (observed flaking in a full
// sequential suite run even though it passed reliably in isolation).
const MARKER_WAIT_TIMEOUT_MS = process.platform === "win32" ? 90000 : 30000;

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

const UNRELATED = "002-dashboard-design-prototype";
const NEW_FEATURE = "999-smoke-test";

function setUp(prefix) {
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  const unrelatedDir = makeSpecKitUnrelatedFeatureFixture(repo, UNRELATED);
  makeClaudeMdBaseline(repo);
  writeConfig(repo, {planningFramework: "speckit"});
  return {repo, binDir, unrelatedDir};
}

// ---------------------------------------------------------------------
// 1. Unrelated existing feature is not reused for a new request, and the
//    full real artifact contract (feature.json, spec/checklists, plan +
//    research/data-model/quickstart/contracts, CLAUDE.md marker section,
//    tasks) is produced for the NEW feature only.
// ---------------------------------------------------------------------
{
  const {repo, binDir, unrelatedDir} = setUp("isolation-1");
  try {
    const beforeSpec = fs.readFileSync(path.join(unrelatedDir, "spec.md"), "utf8");
    const beforePlan = fs.readFileSync(path.join(unrelatedDir, "plan.md"), "utf8");
    const beforeTasks = fs.readFileSync(path.join(unrelatedDir, "tasks.md"), "utf8");
    setScenario(repo, "speckit_full_contract");
    const run = runAutopilot(repo, binDir, {request: "smoke test the health endpoint", timeoutMs: MISSION_TIMEOUT_MS});

    check("isolation: mission completed (exit 0)", run.status === 0);
    const featureDir = path.join(repo, "specs", NEW_FEATURE);
    check("isolation: spec.md + checklist created", fs.existsSync(path.join(featureDir, "spec.md")) && fs.existsSync(path.join(featureDir, "checklists", "requirements.md")));
    check("isolation: plan.md + research/data-model/quickstart + a contract created", ["plan.md", "research.md", "data-model.md", "quickstart.md", "contracts/health.md"].every(f => fs.existsSync(path.join(featureDir, f))));
    check("isolation: tasks.md created", fs.existsSync(path.join(featureDir, "tasks.md")));
    check("isolation: .specify/feature.json created with the exact expected schema (feature_directory only)", (() => {
      const raw = fs.readFileSync(path.join(repo, ".specify", "feature.json"), "utf8");
      const parsed = JSON.parse(raw);
      return Object.keys(parsed).length === 1 && parsed.feature_directory === `specs/${NEW_FEATURE}`;
    })());
    check("isolation: CLAUDE.md marker section was updated, rest unchanged", (() => {
      const content = fs.readFileSync(path.join(repo, "CLAUDE.md"), "utf8");
      return content.includes("Active feature: 999-smoke-test") && content.includes("Project instructions (outside the Autopilot-controlled section).") && content.includes(CLAUDE_MD_MARKER_BEGIN) && content.includes(CLAUDE_MD_MARKER_END);
    })());
    check("isolation: unrelated feature spec.md is byte-for-byte unchanged", fs.readFileSync(path.join(unrelatedDir, "spec.md"), "utf8") === beforeSpec);
    check("isolation: unrelated feature plan.md is byte-for-byte unchanged", fs.readFileSync(path.join(unrelatedDir, "plan.md"), "utf8") === beforePlan);
    check("isolation: unrelated feature tasks.md is byte-for-byte unchanged", fs.readFileSync(path.join(unrelatedDir, "tasks.md"), "utf8") === beforeTasks);

    const state = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
    check("isolation: planningIntent.kind recorded as 'new'", state.planningIntent?.kind === "new");
    check("isolation: resolved feature dir is the new feature, not the unrelated one", state.speckitFeatureDir === NEW_FEATURE);
  } finally {
    cleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// Negative-test helper: run one scenario that is expected to fail the
// planning stage, and assert the mission escalated with a boundary
// violation naming the given file/reason instead of silently proceeding.
// ---------------------------------------------------------------------
function expectBoundaryViolation({label, scenario, badPathFragment, expectedReasonFragment}) {
  const {repo, binDir} = setUp(label);
  try {
    setScenario(repo, scenario);
    const run = runAutopilot(repo, binDir, {request: "smoke test the health endpoint", timeoutMs: MISSION_TIMEOUT_MS});

    check(`${label}: mission did NOT complete (nonzero exit)`, run.status !== 0);
    check(`${label}: error names the write-boundary violation`, /planning-stage write boundary/i.test(run.stderr));
    if (badPathFragment) check(`${label}: violation names the offending path`, run.stderr.includes(badPathFragment));
    if (expectedReasonFragment) check(`${label}: violation reason is ${expectedReasonFragment}`, run.stderr.includes(expectedReasonFragment));

    const state = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
    check(`${label}: mission escalated rather than proceeding`, state.phase === "escalated");
    check(`${label}: step names the violation`, state.step === "planning-write-boundary-violation");
    check(`${label}: never reached tasks_ready/implementation`, state.phase !== "tasks_ready" && state.phase !== "implementing");

    const events = readObservedEvents(repo);
    check(`${label}: no implementer role ever ran`, !events.some(e => e.role === "implementer"));
    check(`${label}: no code_reviewer role ever ran`, !events.some(e => e.role === "code_reviewer"));
  } finally {
    cleanup(repo, binDir);
  }
}

// 2. A Planner implementation write during Spec fails the stage (the real
//    observed bug: docs/AUTOPILOT-SMOKE-TEST.md created outside specs/).
expectBoundaryViolation({
  label: "boundary-implementation-deliverable",
  scenario: "speckit_boundary_violation",
  badPathFragment: "docs/AUTOPILOT-SMOKE-TEST.md",
  expectedReasonFragment: "outside_allowed_paths"
});

// 6a. Negative test: a wrong-stage file INSIDE the correct feature
//     directory during specify (plan.md written too early).
expectBoundaryViolation({
  label: "wrong-stage-specify",
  scenario: "speckit_wrong_stage_specify",
  badPathFragment: `specs/${NEW_FEATURE}/plan.md`,
  expectedReasonFragment: "wrong_stage_artifact"
});

// 6b. Negative test: a wrong-stage file INSIDE the correct feature
//     directory during plan (tasks.md written too early).
expectBoundaryViolation({
  label: "wrong-stage-plan",
  scenario: "speckit_wrong_stage_plan",
  badPathFragment: `specs/${NEW_FEATURE}/tasks.md`,
  expectedReasonFragment: "wrong_stage_artifact"
});

// 6c. Negative test: an arbitrary file (implementation.js) INSIDE the
//     correct feature directory.
expectBoundaryViolation({
  label: "arbitrary-file",
  scenario: "speckit_arbitrary_file",
  badPathFragment: `specs/${NEW_FEATURE}/implementation.js`,
  expectedReasonFragment: "wrong_stage_artifact"
});

// 6d. Negative test: .specify/feature.json with the wrong schema.
expectBoundaryViolation({
  label: "bad-feature-json",
  scenario: "speckit_bad_feature_json",
  badPathFragment: ".specify/feature.json",
  expectedReasonFragment: "feature_json_unexpected_shape"
});

// 6e. Negative test: CLAUDE.md edited outside the controlled marker
//     section during plan.
expectBoundaryViolation({
  label: "claude-md-outside-marker",
  scenario: "speckit_claude_md_violation",
  badPathFragment: "CLAUDE.md",
  expectedReasonFragment: "claude_md_edit_outside_marker_section"
});

// ---------------------------------------------------------------------
// 3. Valid SpecKit planning-artifact writes proceed through review to
//    completion (Spec -> Plan Review -> ... -> Implementation).
// ---------------------------------------------------------------------
{
  const {repo, binDir} = setUp("isolation-3");
  try {
    setScenario(repo, "speckit_full_contract");
    const run = runAutopilot(repo, binDir, {request: "smoke test the health endpoint", timeoutMs: MISSION_TIMEOUT_MS});
    const events = readObservedEvents(repo);
    const order = events.map(e => `${e.role}:${e.decision || e.status}`);
    console.log(`observed order (valid writes): ${order.join(" -> ")}`);

    check("valid writes: mission completed (exit 0)", run.status === 0);
    const planReviewPassIndex = events.findIndex(e => e.role === "plan_reviewer" && e.decision === "PASS");
    const implementerIndex = events.findIndex(e => e.role === "implementer");
    check("valid writes: a plan_reviewer PASS was observed", planReviewPassIndex !== -1);
    check("valid writes: implementer ran only after a plan_reviewer PASS", implementerIndex !== -1 && implementerIndex > planReviewPassIndex);
    check("valid writes: new feature's spec/plan/tasks all exist", ["spec.md", "plan.md", "tasks.md"].every(f => fs.existsSync(path.join(repo, "specs", NEW_FEATURE, f))));
  } finally {
    cleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// 4. Matching interrupted work resumes correctly (continues the SAME
//    feature; does not restart Spec from scratch, does not reuse the
//    unrelated feature).
// ---------------------------------------------------------------------
{
  const {repo, binDir} = setUp("isolation-4");
  const request = "smoke test the health endpoint (resume case)";
  const markerFile = path.join(repo, ".autopilot-test-plan-started");
  try {
    setScenario(repo, "speckit_resume");

    const interrupted = await runAutopilotUntilMarker(repo, binDir, {request, markerFile, timeoutMs: MARKER_WAIT_TIMEOUT_MS});
    check("resume: the run was actually interrupted (marker observed, process killed)", interrupted.markerObserved && interrupted.killed);
    check("resume: the complete process tree is confirmed dead (no orphaned planner/descendant survives)",
      interrupted.terminationConfirmed === true && interrupted.terminationFailed !== true,
      {signal: interrupted.signal, status: interrupted.status, timedOut: interrupted.timedOut});
    check("resume: interruption was marker-triggered, not a deadline timeout", interrupted.timedOut !== true);
    check("resume: spec.md was created before interruption", fs.existsSync(path.join(repo, "specs", NEW_FEATURE, "spec.md")));
    check("resume: feature.json was created before interruption", fs.existsSync(path.join(repo, ".specify", "feature.json")));
    check("resume: plan.md does NOT exist yet — interruption landed before plan completed", !fs.existsSync(path.join(repo, "specs", NEW_FEATURE, "plan.md")));

    const midStateRaw = fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8");
    const midState = JSON.parse(midStateRaw);
    check("resume: mid-run state recorded the resolved feature dir", midState.speckitFeatureDir === NEW_FEATURE);
    check("resume: mid-run state recorded the preexisting-feature snapshot", Array.isArray(midState.planningPreexistingFeatureDirs) && midState.planningPreexistingFeatureDirs.includes(UNRELATED));
    check("resume: mid-run state recorded the CLAUDE.md baseline", typeof midState.planningClaudeMdBaseline === "string" && midState.planningClaudeMdBaseline.includes(CLAUDE_MD_MARKER_BEGIN));

    // Post-interruption stability proof (no sleeps — two point-in-time
    // observations across the natural assertion gap above): with the tree
    // confirmed dead, no killed descendant may create plan.md/tasks.md or
    // modify state.json before the resumed process starts.
    const stableArtifacts = {
      planExists: fs.existsSync(path.join(repo, "specs", NEW_FEATURE, "plan.md")),
      tasksExists: fs.existsSync(path.join(repo, "specs", NEW_FEATURE, "tasks.md")),
      markerExists: fs.existsSync(markerFile),
      stateBytes: fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8")
    };
    check("resume: artifacts and state stayed stable after the confirmed kill (no post-kill descendant writes)",
      stableArtifacts.planExists === false && stableArtifacts.tasksExists === false
        && stableArtifacts.markerExists === true && stableArtifacts.stateBytes === midStateRaw,
      stableArtifacts);

    // Re-invoke with the EXACT SAME request text — must classify as
    // "resume", not "new", and must continue the same feature.
    const resumed = runAutopilot(repo, binDir, {request, timeoutMs: MISSION_TIMEOUT_MS});
    const diagnoseResumedFailure = () => {
      let finalState = null;
      try { finalState = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8")); } catch { finalState = null; }
      return {
        status: resumed.status,
        stdoutTail: String(resumed.stdout || "").slice(-1500),
        stderrTail: String(resumed.stderr || "").slice(-1500),
        phase: finalState?.phase, step: finalState?.step, checkpoint: finalState?.checkpoint ?? null,
        planningIntent: finalState?.planningIntent ?? null,
        featureDir: finalState?.speckitFeatureDir ?? null,
        markerExists: fs.existsSync(markerFile),
        planExists: fs.existsSync(path.join(repo, "specs", NEW_FEATURE, "plan.md")),
        tasksExists: fs.existsSync(path.join(repo, "specs", NEW_FEATURE, "tasks.md"))
      };
    };
    check("resume: resumed mission completed (exit 0)", resumed.status === 0, resumed.status === 0 ? undefined : diagnoseResumedFailure());

    const finalState = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
    check("resume: planningIntent.kind was 'resume' on the continuing invocation", finalState.planningIntent?.kind === "resume");
    check("resume: still the same resolved feature dir after resuming", finalState.speckitFeatureDir === NEW_FEATURE);
    check("resume: plan.md and tasks.md now exist for the SAME feature", fs.existsSync(path.join(repo, "specs", NEW_FEATURE, "plan.md")) && fs.existsSync(path.join(repo, "specs", NEW_FEATURE, "tasks.md")), fs.existsSync(path.join(repo, "specs", NEW_FEATURE, "plan.md")) && fs.existsSync(path.join(repo, "specs", NEW_FEATURE, "tasks.md")) ? undefined : diagnoseResumedFailure());
    check("resume: CLAUDE.md marker section updated after resuming, rest intact", (() => {
      const content = fs.readFileSync(path.join(repo, "CLAUDE.md"), "utf8");
      return content.includes("Active feature: 999-smoke-test") && content.includes("Project instructions (outside the Autopilot-controlled section).");
    })());
    check("resume: no second/different new feature directory was created", !fs.readdirSync(path.join(repo, "specs")).some(d => d !== UNRELATED && d !== NEW_FEATURE));

    const events = readObservedEvents(repo);
    const specifyLikeCalls = events.filter(e => e.role === "planner").length;
    check("resume: the planner was not re-run from a fresh specify (at most 3 planner calls total: specify, plan, tasks)", specifyLikeCalls <= 3);
  } finally {
    cleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// 5. Implementation never starts before Plan Review PASS (run fresh here
//    so it is independently assertable).
// ---------------------------------------------------------------------
{
  const {repo, binDir} = setUp("isolation-5");
  try {
    setScenario(repo, "speckit_full_contract");
    const run = runAutopilot(repo, binDir, {request: "smoke test the health endpoint", timeoutMs: MISSION_TIMEOUT_MS});
    check("ordering: mission completed (exit 0)", run.status === 0);

    const events = readObservedEvents(repo);
    const firstPlanReviewPass = events.find(e => e.role === "plan_reviewer" && e.decision === "PASS");
    const anyImplementer = events.filter(e => e.role === "implementer");
    check("ordering: at least one plan_reviewer PASS occurred", !!firstPlanReviewPass);
    check("ordering: at least one implementer run occurred", anyImplementer.length > 0);
    const allImplementersAfterPass = anyImplementer.every(e => Date.parse(e.startedAt) >= Date.parse(firstPlanReviewPass.finishedAt));
    check("ordering: every implementer run started at/after the first Plan Review PASS finished", allImplementersAfterPass);
  } finally {
    cleanup(repo, binDir);
  }
}

if (failures) {
  console.error(`${failures} SpecKit new-request-isolation check(s) failed.`);
  process.exit(1);
}
console.log("SpecKit new-request isolation behavioral tests: PASS");
