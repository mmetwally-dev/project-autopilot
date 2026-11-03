#!/usr/bin/env node
// Backlog #7 — standalone spec stage: planner explores the code, writes SPEC.md + CODEMAP.md, own review loop, then PLAN/TASKS
import fs from "node:fs";
import path from "node:path";
import {specContentFindings, specCoverageFindings} from "./verify-denylist.mjs";
import {resolveSpecRevisionBudget} from "./plan-revision-budget.mjs";
import {toRuntimeConfig, DEFAULTS} from "./config-layout.mjs";
import {
  makeFixtureRepo,
  makeFixtureBin,
  setScenario,
  writeConfig,
  runAutopilot,
  readObservedEvents,
  cleanup
} from "./test-fixtures/workflow-order-harness.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS ${name}`);
  else {
    failures += 1;
    console.error(`FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

// ---- Unit: resolveSpecRevisionBudget & config mapping ----
{
  check("unit: resolveSpecRevisionBudget({}) === 3",
    resolveSpecRevisionBudget({}) === 3,
    resolveSpecRevisionBudget({}));
  check("unit: resolveSpecRevisionBudget({max_spec_revisions:0}) === 0",
    resolveSpecRevisionBudget({max_spec_revisions: 0}) === 0,
    resolveSpecRevisionBudget({max_spec_revisions: 0}));
  check("unit: resolveSpecRevisionBudget({max_spec_revisions:5}) === 5",
    resolveSpecRevisionBudget({max_spec_revisions: 5}) === 5,
    resolveSpecRevisionBudget({max_spec_revisions: 5}));
  check("unit: resolveSpecRevisionBudget({max_spec_revisions:-1}) === 3",
    resolveSpecRevisionBudget({max_spec_revisions: -1}) === 3,
    resolveSpecRevisionBudget({max_spec_revisions: -1}));

  const rtMapped = toRuntimeConfig({retries: {spec_revisions: 2}});
  check("unit: toRuntimeConfig maps retries.spec_revisions: 2 -> policy.max_spec_revisions === 2",
    rtMapped.policy?.max_spec_revisions === 2,
    rtMapped.policy);

  const rtDefaults = toRuntimeConfig(DEFAULTS);
  check("unit: DEFAULTS gives policy.max_spec_revisions === 3",
    rtDefaults.policy?.max_spec_revisions === 3,
    rtDefaults.policy);
}

// ---- Unit: specContentFindings ----
{
  const missing = specContentFindings("");
  check("unit: specContentFindings('') returns SPEC.md missing finding",
    missing.length === 1 && missing[0].location === "SPEC.md" && missing[0].problem.includes("missing"),
    missing);

  const clarify = specContentFindings("## Requirements\n- **FR-001**: System MUST do X [NEEDS CLARIFICATION: detail]\n");
  check("unit: specContentFindings returns NEEDS CLARIFICATION finding when marker present",
    clarify.length === 1 && clarify[0].location === "SPEC.md" && clarify[0].problem.includes("[NEEDS CLARIFICATION]"),
    clarify);

  const clean = specContentFindings("## Requirements\n- **FR-001**: System MUST do X\n");
  check("unit: specContentFindings returns [] for a spec with one FR",
    clean.length === 0,
    clean);

  const coverageUnchanged = specCoverageFindings(
    "## Requirements\n- **FR-001**: System MUST do 1\n- **FR-002**: System MUST do 2\n",
    "## Phase 1: Setup\n- [ ] **1.1** Task (FR-001) ; verify: test.mjs\n"
  );
  check("unit: specCoverageFindings still reports uncovered FR-002",
    coverageUnchanged.length === 1 && coverageUnchanged[0].location === "SPEC.md FR-002",
    coverageUnchanged);
}

// ---- Integration: spec on ----
{
  const repo = makeFixtureRepo("backlog7-spec-on");
  const binDir = makeFixtureBin("backlog7-spec-on");
  try {
    writeConfig(repo, {planningFramework: "standalone", maxPlanRevisions: 1});
    const cfgPath = path.join(repo, ".autopilot", "config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.workflow.standaloneSpec = true;
    cfg.workflow.standalone_spec = true;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    setScenario(repo, "success");
    const run = runAutopilot(repo, binDir, {request: "implement the fixture task", stage: "planning", timeoutMs: 120000});
    const events = readObservedEvents(repo);
    const state = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
    const missionDir = path.join(repo, ".autopilot", "missions", state.mission);
    const specFile = path.join(missionDir, "SPEC.md");
    const codemapFile = path.join(missionDir, "CODEMAP.md");

    check("integration (spec on): planning run exits 0", run.status === 0, {status: run.status, stderr: run.stderr});
    check("integration (spec on): SPEC.md exists in mission folder", fs.existsSync(specFile), specFile);
    check("integration (spec on): CODEMAP.md exists in mission folder", fs.existsSync(codemapFile), codemapFile);

    const firstFourRoles = events.slice(0, 4).map(e => e.role);
    check("integration (spec on): role order of first four events is planner, plan_reviewer, planner, plan_reviewer",
      JSON.stringify(firstFourRoles) === JSON.stringify(["planner", "plan_reviewer", "planner", "plan_reviewer"]),
      firstFourRoles);

    const plannerEvents = events.filter(e => e.role === "planner");
    const firstPlannerPrompt = plannerEvents[0]
      ? fs.readFileSync(path.join(path.dirname(plannerEvents[0].file), "brief.txt"), "utf8")
      : "";
    const secondPlannerPrompt = plannerEvents[1]
      ? fs.readFileSync(path.join(path.dirname(plannerEvents[1].file), "brief.txt"), "utf8")
      : "";

    check("integration (spec on): first planner prompt contains 'Write the feature specification for this request to exactly:' and NOT 'Write the narrative plan to exactly:'",
      firstPlannerPrompt.includes("Write the feature specification for this request to exactly:")
      && !firstPlannerPrompt.includes("Write the narrative plan to exactly:"),
      firstPlannerPrompt.slice(0, 400));

    check("integration (spec on): second planner prompt contains CODEMAP.md path and 'Read both in full first'",
      secondPlannerPrompt.includes(codemapFile)
      && secondPlannerPrompt.includes("Read both in full first"),
      secondPlannerPrompt.slice(0, 400));

    check("integration (spec on): state.json has standaloneSpecReview.approved === true",
      state.standaloneSpecReview?.approved === true,
      state.standaloneSpecReview);

    // Backlog #4 / #5: standalone spec stage runs record planningStage "spec/codemap",
    // while standalone plan stage runs keep planningStage null.
    const runStatusFiles = events.map(e => path.join(path.dirname(e.file), "status.json")).filter(f => fs.existsSync(f));
    const runStatuses = runStatusFiles.map(f => JSON.parse(fs.readFileSync(f, "utf8")));
    const specPlannerStatus = runStatuses.find(s => s.taskRef === "standalone-spec-planner");
    const specReviewerStatus = runStatuses.find(s => s.taskRef === "standalone-spec-plan_reviewer");
    const planPlannerStatus = runStatuses.find(s => s.role === "planner" && s.taskRef !== "standalone-spec-planner");
    check("integration (planningStage): standalone-spec-planner records planningStage 'spec/codemap'",
      specPlannerStatus?.planningStage === "spec/codemap",
      specPlannerStatus?.planningStage);
    check("integration (planningStage): standalone-spec-plan_reviewer records planningStage 'spec/codemap'",
      specReviewerStatus?.planningStage === "spec/codemap",
      specReviewerStatus?.planningStage);
    check("integration (planningStage): standalone PLAN/TASKS planner records null planningStage",
      planPlannerStatus?.planningStage === null,
      planPlannerStatus?.planningStage);
  } finally {
    cleanup(repo, binDir);
  }
}

// ---- Integration: resume at the spec reviewer ----
{
  const repo = makeFixtureRepo("backlog7-spec-resume");
  const binDir = makeFixtureBin("backlog7-spec-resume");
  try {
    writeConfig(repo, {planningFramework: "standalone", maxPlanRevisions: 1});
    const cfgPath = path.join(repo, ".autopilot", "config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.workflow.standaloneSpec = true;
    cfg.workflow.standalone_spec = true;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    const request = "implement the fixture task";
    const mission = "001-implement-fixture-task";
    const missionDir = path.join(repo, ".autopilot", "missions", mission);
    fs.mkdirSync(missionDir, {recursive: true});
    fs.writeFileSync(path.join(missionDir, "SPEC.md"), "# Spec\n\n## Requirements\n\n- **FR-001**: System MUST do the fixture task.\n");
    fs.writeFileSync(path.join(missionDir, "CODEMAP.md"), "# Code map\n\nfixture.\n");
    fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
      version: 1,
      phase: "planning",
      step: "standalone-plan",
      planningRequest: request,
      mission,
      missionSeq: "001",
      standaloneSpecReview: {revision: 0, position: "reviewer"}
    }, null, 2));

    setScenario(repo, "success");
    const run = runAutopilot(repo, binDir, {request, stage: "planning", timeoutMs: 120000});
    const events = readObservedEvents(repo);
    check("integration (resume at spec reviewer): planning run exits 0", run.status === 0, {status: run.status, stderr: run.stderr});
    check("integration (resume at spec reviewer): first event is plan_reviewer, not planner",
      events.length > 0 && events[0].role === "plan_reviewer",
      events.map(e => e.role));
  } finally {
    cleanup(repo, binDir);
  }
}

// ---- Integration: spec off (harness default) ----
{
  const repo = makeFixtureRepo("backlog7-spec-off");
  const binDir = makeFixtureBin("backlog7-spec-off");
  try {
    writeConfig(repo, {planningFramework: "standalone", maxPlanRevisions: 1});
    setScenario(repo, "success");
    const run = runAutopilot(repo, binDir, {request: "implement the fixture task", stage: "planning", timeoutMs: 120000});
    const events = readObservedEvents(repo);
    const prompts = events.map(e => fs.readFileSync(path.join(path.dirname(e.file), "brief.txt"), "utf8"));
    const anyHasSpecStageLine = prompts.some(p => p.includes("Write the feature specification for this request"));
    check("integration (spec off): planning run exits 0", run.status === 0, {status: run.status, stderr: run.stderr});
    check("integration (spec off): no prompt contains 'Write the feature specification for this request'",
      events.length > 0 && !anyHasSpecStageLine,
      events.map(e => e.role));
  } finally {
    cleanup(repo, binDir);
  }
}

// ---- Integration: legacy CONTEXT.md fallback on resume ----
{
  const repo = makeFixtureRepo("backlog7-legacy-context-fallback");
  const binDir = makeFixtureBin("backlog7-legacy-context-fallback");
  try {
    writeConfig(repo, {planningFramework: "standalone", maxPlanRevisions: 1});
    const cfgPath = path.join(repo, ".autopilot", "config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.workflow.standaloneSpec = true;
    cfg.workflow.standalone_spec = true;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    const request = "implement the fixture task";
    const mission = "001-implement-fixture-task";
    const missionDir = path.join(repo, ".autopilot", "missions", mission);
    fs.mkdirSync(missionDir, {recursive: true});
    fs.writeFileSync(path.join(missionDir, "SPEC.md"), "# Spec\n\n## Requirements\n\n- **FR-001**: System MUST do the fixture task.\n");
    const legacyContextFile = path.join(missionDir, "CONTEXT.md");
    fs.writeFileSync(legacyContextFile, "# Legacy Context\n\nfixture.\n");
    fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
      version: 1,
      phase: "planning",
      step: "standalone-plan",
      planningRequest: request,
      mission,
      missionSeq: "001",
      standaloneSpecReview: {revision: 0, position: "reviewer", approved: true}
    }, null, 2));

    setScenario(repo, "success");
    const run = runAutopilot(repo, binDir, {request, stage: "planning", timeoutMs: 120000});
    const events = readObservedEvents(repo);
    check("integration (legacy context fallback): planning run exits 0", run.status === 0, {status: run.status, stderr: run.stderr});

    const plannerEvents = events.filter(e => e.role === "planner");
    const plannerPrompt = plannerEvents[0]
      ? fs.readFileSync(path.join(path.dirname(plannerEvents[0].file), "brief.txt"), "utf8")
      : "";
    check("integration (legacy context fallback): planner prompt cites legacy CONTEXT.md path",
      plannerPrompt.includes(legacyContextFile),
      plannerPrompt.slice(0, 1000));
  } finally {
    cleanup(repo, binDir);
  }
}

if (failures) {
  console.error(`${failures} standalone spec-stage check(s) failed.`);
  process.exit(1);
}
console.log("standalone spec-stage tests passed");

