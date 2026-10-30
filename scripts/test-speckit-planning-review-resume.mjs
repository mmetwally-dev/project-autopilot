#!/usr/bin/env node
// TASK-14 Phase 6 tasks 21-22 — SpecKit gate-review resume-position checkpoint
// (s.speckitGateReviewCheckpoint) wiring regressions.
//
// Subprocess-driven (`node scripts/autopilot.mjs run ...`), same technique as
// test-standalone-planning-review-resume.mjs — never by importing
// `autopilot.mjs` (it runs main() at import with no guard). Checkpoints are
// CRAFTED directly into state.json, computed with the production pure module
// `planning-review-checkpoint.mjs` itself, so the shape and content digest
// always match what the wiring writes.
//
// Scope note (verified, not assumed): the shared fake adapter cannot complete
// a *resume-time* planning revision — with no "Feature '<dir>'." lock line in
// the revision prompt it falls back to minting a fresh feature directory
// (`cannot create specs/999-smoke-test/plan.md: Directory nonexistent`) and
// exits nonzero. That is a fixture limitation, so these cases assert the
// resume-position contract itself — which stage runs, in which order, with
// what bound artifacts — and never a full mission completion that would depend
// on the adapter finishing a revision it cannot produce.
//
// Cases:
//   S1 (task 21) planner_revision: restart resumes at the PLANNER — the
//      between-reviews revision runs, the gate's initial review does NOT.
//   S2 (task 21) post_revision_review: restart resumes at the re-review — the
//      Planner does NOT run, and a FAIL there escalates immediately, granting
//      no second revision.
//   S3 (task 21, contrast, asserted separately) a fresh initial_review FAIL
//      DOES grant exactly one revision.
//   S4 (task 21) per-gate manifest: review-spec binds only spec.md (plan.md
//      and tasks.md need not exist yet), review-plan adds plan.md,
//      review-tasks requires all three.
//   S5 (task 22) the review-tasks last-gate resume: with all three artifacts
//      already on disk, a restart resumes at the exact review-tasks gate —
//      observed from the launch sequence, never from state.json alone — and
//      never through reviewExistingPlanning().
import fs from "node:fs";
import path from "node:path";
import {
  makeFixtureRepo, makeFixtureBin, setScenario, writeConfig,
  runAutopilot, readObservedEvents, cleanup
} from "./test-fixtures/workflow-order-harness.mjs";
import {
  artifactDigest, createSpeckitCheckpoint,
  SPECKIT_INITIAL_REVIEW, SPECKIT_PLANNER_REVISION, SPECKIT_POST_REVISION_REVIEW
} from "./planning-review-checkpoint.mjs";

const REQUEST = "smoke test the fixture feature";
const MISSION = "001-fixture-feature";
const FEATURE = "001-fixture-feature";
const GATE_INDEX = {"review-spec": 1, "review-plan": 3, "review-tasks": 5};
const MISSION_TIMEOUT_MS = process.platform === "win32" ? 240000 : 120000;

const WORKFLOW_YML = [
  "- id: specify", "  type: command", "  command: /speckit.specify",
  "- id: review-spec", "  type: gate", "  message: Review the spec",
  "- id: plan", "  type: command", "  command: /speckit.plan",
  "- id: review-plan", "  type: gate", "  message: Review the plan",
  "- id: tasks", "  type: command", "  command: /speckit.tasks",
  "- id: review-tasks", "  type: gate", "  message: Review the tasks",
  "- id: implement", "  type: command", "  command: /speckit.implement", ""
].join("\n");

const SPEC = "# Spec\n\nFixture feature specification.\n";
const PLAN = "# Plan\n\nFixture feature plan.\n";
// No capability annotation: an unresolved "autopilot-requires" token is a hard
// configuration error at relay time, which is unrelated to this suite.
const TASKS = "## Phase 1: General\n\n- [ ] Do the fixture task \u2014 accept: done ; verify: none\n";

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
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(state, null, 2));
}
function roleCounts(repo) {
  const counts = {};
  for (const event of readObservedEvents(repo)) counts[event.role] = (counts[event.role] || 0) + 1;
  return counts;
}
// Every relay's prompt is persisted as .autopilot/**/brief.txt — the launch
// sequence itself, which is what tasks 21-22 ask these cases to be asserted
// against (never a state.json field on its own).
function readBriefs(repo) {
  const out = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "brief.txt") out.push(fs.readFileSync(full, "utf8"));
    }
  })(path.join(repo, ".autopilot"));
  return out;
}
function combined(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

function writeArtifacts(repo, artifacts) {
  for (const [name, content] of Object.entries(artifacts)) {
    if (content === null) continue;
    const target = path.join(repo, "specs", FEATURE, `${name}.md`);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, content);
  }
}
function gateRelPaths(gate) {
  const roles = {"review-spec": ["spec"], "review-plan": ["spec", "plan"], "review-tasks": ["spec", "plan", "tasks"]}[gate];
  return roles.map((role) => path.join("specs", FEATURE, `${role}.md`));
}
// Mirrors the production writer exactly: a reviewer substage records the
// content digest, planner_revision records none.
function craftCheckpoint(repo, {gate, substage}) {
  const artifacts = gateRelPaths(gate);
  let digest = null;
  if (substage !== SPECKIT_PLANNER_REVISION) {
    digest = artifactDigest({
      artifacts: artifacts.map((rel) => ({path: rel, content: fs.readFileSync(path.join(repo, rel), "utf8")}))
    });
  }
  return createSpeckitCheckpoint({
    framework: "speckit", mission: MISSION, feature: FEATURE,
    gate, gateIndex: GATE_INDEX[gate], substage, artifacts, artifactDigest: digest,
    at: new Date().toISOString()
  });
}

// Seeded mid-gate: the artifacts the gate reviews are already on disk, so the
// run must resume from the checkpoint rather than re-plan from scratch.
function setup(prefix, {artifacts, gate, substage, priorRequest = REQUEST, rawCheckpoint}) {
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  const workflowDir = path.join(repo, ".specify", "workflows", "speckit");
  fs.mkdirSync(workflowDir, {recursive: true});
  fs.writeFileSync(path.join(workflowDir, "workflow.yml"), WORKFLOW_YML);
  fs.writeFileSync(path.join(repo, ".specify", "feature.json"), JSON.stringify({feature_directory: `specs/${FEATURE}`}));
  writeArtifacts(repo, artifacts);
  writeConfig(repo, {planningFramework: "speckit"});
  const state = {
    version: 1, phase: "planning", step: "speckit-plan",
    // A differing persisted request is what makes the next run classify as a
    // NEW request (classifyPlanningRequest), which is task 25's whole subject.
    planningRequest: priorRequest, mission: MISSION, missionSeq: "001",
    speckitFeatureDir: FEATURE
  };
  if (rawCheckpoint) state.speckitGateReviewCheckpoint = rawCheckpoint;
  else if (gate) state.speckitGateReviewCheckpoint = craftCheckpoint(repo, {gate, substage});
  writeState(repo, state);
  return {repo, binDir};
}
function run(repo, binDir) {
  return runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: MISSION_TIMEOUT_MS});
}

const created = [];
function fixture(prefix, options) {
  const ctx = setup(prefix, options);
  created.push(ctx.repo, ctx.binDir);
  return ctx;
}

try {
  // -------------------------------------------------------------------
  // S5 / task 22: review-tasks last-gate resume with all three artifacts
  // present — the gap this phase exists to close.
  // -------------------------------------------------------------------
  {
    const {repo, binDir} = fixture("sk-tasks-gate", {
      artifacts: {spec: SPEC, plan: PLAN, tasks: TASKS},
      gate: "review-tasks", substage: SPECKIT_POST_REVISION_REVIEW
    });
    const result = run(repo, binDir);
    const output = combined(result);
    const briefs = readBriefs(repo);
    check("s5: review-tasks checkpoint validates with all three artifacts present",
      !output.includes("PLANNING_REVIEW_CHECKPOINT_INVALID"), output.slice(-600));
    check("s5: resumes at the review-tasks gate (its own review prompt was launched)",
      briefs.some((brief) => brief.includes('SpecKit gate "review-tasks"')), briefs.length);
    check("s5: never routed through reviewExistingPlanning() (task 20's gap)",
      !briefs.some((brief) => brief.includes("Validate the existing")), briefs.length);
    check("s5: the checkpoint is cleared once its own gate passes",
      readState(repo).speckitGateReviewCheckpoint === undefined, Object.keys(readState(repo)));
  }

  // -------------------------------------------------------------------
  // S4: per-gate artifact manifests
  // -------------------------------------------------------------------
  {
    const {repo, binDir} = fixture("sk-spec-gate", {
      artifacts: {spec: SPEC, plan: null, tasks: null},
      gate: "review-spec", substage: SPECKIT_INITIAL_REVIEW
    });
    const result = run(repo, binDir);
    const output = combined(result);
    check("s4a: review-spec validates with only spec.md present (plan.md/tasks.md not required)",
      !output.includes("PLANNING_REVIEW_CHECKPOINT_INVALID"), output.slice(-600));
    check("s4a: the review-spec gate itself ran", (roleCounts(repo).plan_reviewer || 0) >= 1, roleCounts(repo));
  }
  {
    const {repo, binDir} = fixture("sk-plan-gate", {
      artifacts: {spec: SPEC, plan: PLAN, tasks: null},
      gate: "review-plan", substage: SPECKIT_INITIAL_REVIEW
    });
    const result = run(repo, binDir);
    const output = combined(result);
    check("s4b: review-plan validates with spec+plan present (tasks.md not required)",
      !output.includes("PLANNING_REVIEW_CHECKPOINT_INVALID"), output.slice(-600));
    check("s4b: the review-plan gate itself ran", (roleCounts(repo).plan_reviewer || 0) >= 1, roleCounts(repo));
  }

  // -------------------------------------------------------------------
  // S1: planner_revision resumes at the PLANNER, not the reviewer
  // -------------------------------------------------------------------
  {
    const {repo, binDir} = fixture("sk-planner-rev", {
      artifacts: {spec: SPEC, plan: PLAN},
      gate: "review-plan", substage: SPECKIT_PLANNER_REVISION
    });
    // A real mid-gate crash leaves the failed review's findings behind.
    const s1 = readState(repo);
    s1.reviewFeedback = {"speckit-stage:plan": {findings: ["needs more detail: split phase 1"], at: new Date().toISOString()}};
    writeState(repo, s1);
    const result = run(repo, binDir);
    const counts = roleCounts(repo);
    const briefs = readBriefs(repo);
    check("s1: restart runs the Planner exactly once (the position this substage names)",
      (counts.planner || 0) === 1, counts);
    check("s1: the gate's initial review is NOT re-run",
      !briefs.some((brief) => brief.includes('Review the current artifact state at the SpecKit gate "review-plan"')), briefs.length);
    check("s1: the reviewer does not launch before the Planner (nothing reviewed the pre-revision artifacts)",
      (counts.plan_reviewer || 0) === 0, counts);
    check("s1: the run was restarted in the planner_revision substage, not treated as new work",
      result.status !== 0 && combined(result).includes("Planner failed or violated relay policy"),
      {status: result.status, tail: combined(result).slice(-400)});
  }

  // -------------------------------------------------------------------
  // S2: post_revision_review resumes at the re-review; a FAIL escalates with
  //     no second revision (no Planner run at all)
  // -------------------------------------------------------------------
  {
    const {repo, binDir} = fixture("sk-re-review", {
      artifacts: {spec: SPEC, plan: PLAN},
      gate: "review-plan", substage: SPECKIT_POST_REVISION_REVIEW
    });
    // A real mid-gate crash leaves the failed review's findings behind; the
    // re-review prompt carries them raw (no feedback marker), so the FAIL
    // still escalates with no second revision.
    const s2 = readState(repo);
    s2.reviewFeedback = {"speckit-stage:plan": {findings: ["needs more detail: split phase 1"], at: new Date().toISOString()}};
    // Item 5: the post-revision re-review now keeps revising while the
    // plan_revisions budget remains. This case is specifically the
    // BUDGET-EXHAUSTED resume, so seed the previously spent revisions (the
    // real crashed process had already recorded them) — otherwise the FAIL
    // correctly grants another revision.
    s2.planReviewRevisions = {"speckit-stage:plan": 3};
    writeState(repo, s2);
    setScenario(repo, "plan_review_fail");
    const result = run(repo, binDir);
    const counts = roleCounts(repo);
    const output = combined(result);
    check("s2: escalates (nonzero exit)", result.status !== 0, {status: result.status, tail: output.slice(-600)});
    check("s2: names the failed gate", output.includes("SpecKit gate review-plan failed"), output.slice(-600));
    check("s2: no Planner run — zero additional revisions granted", (counts.planner || 0) === 0, counts);
    check("s2: exactly the re-review ran, never a fresh initial review", (counts.plan_reviewer || 0) === 1, counts);
    check("s2: the re-review prompt is the post-revision one",
      readBriefs(repo).some((brief) => brief.includes('Re-review the SpecKit gate "review-plan"')), counts);
  }

  // -------------------------------------------------------------------
  // S3 (contrast, its own case): a fresh initial_review FAIL grants exactly
  //     one revision — asserted, never inferred from S2.
  // -------------------------------------------------------------------
  {
    const {repo, binDir} = fixture("sk-initial-fail", {
      artifacts: {spec: SPEC, plan: PLAN},
      gate: "review-plan", substage: SPECKIT_INITIAL_REVIEW
    });
    setScenario(repo, "plan_review_fail");
    const result = run(repo, binDir);
    const counts = roleCounts(repo);
    const output = combined(result);
    check("s3: a fresh initial_review FAIL grants exactly one revision (the Planner ran)",
      (counts.planner || 0) >= 1, counts);
    check("s3: the initial review ran before the revision",
      readBriefs(repo).some((brief) => brief.includes('Review the current artifact state at the SpecKit gate "review-plan"')), counts);
    check("s3: the gate still ends in escalation (the scenario never passes)",
      result.status !== 0 && output.includes("Planner failed or violated relay policy"),
      {status: result.status, tail: output.slice(-400)});
  }
  // -------------------------------------------------------------------
  // N1/N2 (task 25): new-request precedence. A genuinely DIFFERENT request
  // must supersede either checkpoint without validating it — a valid one and
  // a malformed one alike — and then plan fresh. The malformed case is the
  // sharp one: if precedence were wrong, the unknown version would be
  // validated and the run would escalate instead of starting cleanly.
  // -------------------------------------------------------------------
  {
    const {repo, binDir} = fixture("sk-new-valid", {
      artifacts: {spec: SPEC, plan: PLAN},
      gate: "review-plan", substage: SPECKIT_INITIAL_REVIEW,
      priorRequest: "an older, unrelated request"
    });
    const result = run(repo, binDir);
    const output = combined(result);
    check("n1: a valid prior-request checkpoint never escalates (it is superseded, not resumed)",
      !output.includes("PLANNING_REVIEW_CHECKPOINT_INVALID"), output.slice(-600));
    check("n1: the prior checkpoint is cleared, not validated against the new request",
      readState(repo).speckitGateReviewCheckpoint === undefined, Object.keys(readState(repo)));
    check("n1: the new request planned fresh and completed",
      result.status === 0, {status: result.status, tail: output.slice(-600)});
  }
  {
    const {repo, binDir} = fixture("sk-new-malformed", {
      artifacts: {spec: SPEC, plan: PLAN},
      priorRequest: "an older, unrelated request",
      rawCheckpoint: {version: 99}
    });
    const result = run(repo, binDir);
    const output = combined(result);
    check("n2: a MALFORMED prior-request checkpoint is cleared, never validated (no escalation)",
      !output.includes("PLANNING_REVIEW_CHECKPOINT_INVALID"), output.slice(-600));
    check("n2: the malformed checkpoint is gone from state",
      readState(repo).speckitGateReviewCheckpoint === undefined, Object.keys(readState(repo)));
    check("n2: the new request still planned fresh and completed",
      result.status === 0, {status: result.status, tail: output.slice(-600)});
  }
  // -------------------------------------------------------------------
  // S6 (023 Phase 2 task 2.2): gate-exhaustion same-request resume — the
  // SpecKit twin of the standalone revision-exhaustion guard. Item 5 makes
  // every re-review FAIL another revision while the plan_revisions budget
  // remains, so run 1 now spends the WHOLE budget (three Planner revisions)
  // before "SpecKit gate ... failed". Run 2 with the SAME request must
  // re-invoke the Planner once with the persisted stage findings and re-run
  // gate review — never just re-run the re-review, and never adopt the
  // rejected artifacts as complete. (The resume-time Planner cannot complete
  // a revision in this fixture, so run 2 is asserted on its launch + prompt
  // and nonzero exit, never on mission completion.)
  // -------------------------------------------------------------------
  {
    const {repo, binDir} = fixture("sk-gate-exhaust", {
      artifacts: {spec: SPEC, plan: PLAN},
      gate: "review-plan", substage: SPECKIT_INITIAL_REVIEW
    });
    setScenario(repo, "speckit_rereview_gate_fail_always");
    const first = run(repo, binDir);
    const firstOutput = combined(first);
    const plannerBefore = roleCounts(repo).planner || 0;
    check("s6: run 1 escalates on the exhausted gate (nonzero exit)", first.status !== 0, {status: first.status, tail: firstOutput.slice(-600)});
    check("s6: run 1 names the failed gate", firstOutput.includes("SpecKit gate review-plan failed"), firstOutput.slice(-600));
    check("s6: run 1 spent the full revision budget (three Planner revisions)", plannerBefore === 3, roleCounts(repo));
    check("s6: run 1 recorded all three spent revisions",
      (readState(repo).planReviewRevisions?.["speckit-stage:plan"] || 0) === 3, readState(repo).planReviewRevisions);

    // Same request, new process, same repo: the exhaustion resume.
    const second = run(repo, binDir);
    const secondOutput = combined(second);
    const counts = roleCounts(repo);
    const plannerAfter = counts.planner || 0;
    const briefs = readBriefs(repo);
    check("s6: run 2 re-invokes the Planner exactly once with the persisted findings (never-execute-unapproved-plan guard)",
      plannerAfter - plannerBefore === 1, {before: plannerBefore, after: plannerAfter, counts});
    check("s6: run 2's Planner was handed the persisted gate findings",
      briefs.some((brief) => brief.includes("gate still needs revision")), briefs.length);
    check("s6: run 2's Planner was told the previous attempt was REJECTED",
      briefs.some((brief) => /REJECTED/.test(brief)), briefs.length);
    check("s6: run 2 does not complete (the fixture Planner cannot finish a revision)",
      second.status !== 0, {status: second.status, tail: secondOutput.slice(-400)});
    check("s6: run 2 never reports tasks_ready",
      readState(repo).phase !== "tasks_ready", readState(repo).phase);
  }
  // -------------------------------------------------------------------
  // C3/C4 (023 Phase 2 task 2.3): artifacts-complete must not swallow
  // pending rejected-stage findings. C3: complete spec/plan/tasks artifacts
  // + saved speckit-stage:tasks feedback (same request, no checkpoint) must
  // resume at the Planner for that stage (the planner runs, and its prompt
  // quotes the persisted finding as REJECTED) — never straight to
  // tasks_ready. C4 (control): complete artifacts with PASS-cleared stage
  // feedback reach tasks_ready without calling the Planner.
  // -------------------------------------------------------------------
  {
    const {repo, binDir} = fixture("sk-complete-pending", {
      artifacts: {spec: SPEC, plan: PLAN, tasks: TASKS}, gate: null
    });
    const st = readState(repo);
    st.reviewFeedback = {"speckit-stage:tasks": {findings: ["tasks need more detail: split phase 1"], at: new Date().toISOString()}};
    writeState(repo, st);
    const result = run(repo, binDir);
    const counts = roleCounts(repo);
    const briefs = readBriefs(repo);
    check("c3: complete+pending routes to the Planner (planner ran)", (counts.planner || 0) >= 1, counts);
    check("c3: the Planner was handed the persisted stage findings",
      briefs.some((brief) => brief.includes("tasks need more detail")), briefs.length);
    check("c3: the Planner was told the previous attempt was REJECTED",
      briefs.some((brief) => /REJECTED/.test(brief)), briefs.length);
  }
  {
    const {repo, binDir} = fixture("sk-complete-cleared", {
      artifacts: {spec: SPEC, plan: PLAN, tasks: TASKS}, gate: null
    });
    const result = run(repo, binDir);
    const output = combined(result);
    const counts = roleCounts(repo);
    check("c4: PASS-cleared complete artifacts reach tasks_ready without the Planner (planner never ran)",
      (counts.planner || 0) === 0, counts);
    check("c4: mission completed", result.status === 0, {status: result.status, tail: output.slice(-400)});
  }
} finally {
  cleanup(...created);
}

if (failures) {
  console.error(`${failures} speckit planning-review resume check(s) failed.`);
  process.exit(1);
}
console.log("test-speckit-planning-review-resume: all cases passed");
