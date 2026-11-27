#!/usr/bin/env node
// Backlog sk #4: SpecKit gate carry-forward when plan-revision budget is spent
// with <= 2 BLOCKING findings and a decreasing finding count over the last rounds,
// clean escalation with `ap reset --scope speckit-stage:<stage>` hint otherwise,
// tasks gate never carrying, write-boundary allowance for carried earlier-stage
// edits, `ap reset --scope speckit-stage:<stage>` clearing only that counter,
// and resume safety for the SampleApp-009 state shape.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  recordPlanReviewRound,
  recordSpeckitGateFindingCount,
  getSpeckitGateFindingCounts,
  clearSpeckitGateFindingCounts,
  isFindingCountDecreasing,
  canCarryForwardSpeckitGate,
  evaluateSpeckitGateExhaustion,
  recordSpeckitCarriedFindings,
  getSpeckitCarriedFindings,
  clearSpeckitCarriedFindings,
  speckitCarriedFindingsPlannerNote,
  speckitCarriedFindingsReviewerNote,
} from "./plan-review-rounds.mjs";
import { evaluatePlanningWriteBoundary } from "./planning-boundary.mjs";
import {
  makeFixtureRepo, writeConfig, withoutOuterGitGuard, cleanup
} from "./test-fixtures/workflow-order-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const AUTOPILOT = path.join(here, "autopilot.mjs");
const ENV = withoutOuterGitGuard(process.env);

let ok = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    ok++;
    console.log(`PASS ${name}`);
    return;
  }
  failed++;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

const statePath = (repo) => path.join(repo, ".autopilot", "state.json");
const readState = (repo) => JSON.parse(fs.readFileSync(statePath(repo), "utf8"));
const writeState = (repo, s) => fs.writeFileSync(statePath(repo), JSON.stringify(s, null, 2));

function runReset(repo, args = []) {
  return spawnSync(process.execPath, [AUTOPILOT, "reset", ...args, "--yes", "--repo", repo], {
    cwd: repo,
    encoding: "utf8",
    env: ENV,
    timeout: 60000,
    shell: false,
  });
}

// ── 1. Carry when <= 2 BLOCKING findings and decreasing (specify & plan) ─────
{
  const s = {};
  const key = "speckit-stage:specify";
  for (const n of [5, 3, 2]) recordSpeckitGateFindingCount(s, key, n);
  const findings = [
    "[SEC] /export endpoint lacks tenant auth check",
    "[CONTRACT] FR-012 missing 409 error code",
  ];
  const decision = evaluateSpeckitGateExhaustion({
    state: s,
    stepId: "review-spec",
    gateStage: "specify",
    gateKey: key,
    findings,
    maxPlanRevisions: 10,
    revisionsUsed: 10,
    failedVerdict: true,
  });
  check("1a: specify gate carries with 2 findings and decreasing counts [5,3,2]",
    decision.action === "carry" && decision.nextStage === "plan" && decision.findings.length === 2,
    decision);

  const sPlan = {};
  const planKey = "speckit-stage:plan";
  for (const n of [4, 2, 1]) recordSpeckitGateFindingCount(sPlan, planKey, n);
  const planDecision = evaluateSpeckitGateExhaustion({
    state: sPlan,
    stepId: "review-plan",
    gateStage: "plan",
    gateKey: planKey,
    findings: ["[ARCH] migration rollback path missing in plan.md"],
    maxPlanRevisions: 10,
    revisionsUsed: 10,
    failedVerdict: true,
  });
  check("1b: plan gate carries with 1 finding and decreasing counts [4,2,1]",
    planDecision.action === "carry" && planDecision.nextStage === "tasks" && planDecision.findings.length === 1,
    planDecision);
}

// ── 2. Escalate cleanly when 3+ findings or not decreasing ───────────────────
{
  // 2a: 3 findings (even though strictly decreasing 6 -> 4 -> 3)
  const s3 = {};
  const key = "speckit-stage:specify";
  for (const n of [6, 4, 3]) recordSpeckitGateFindingCount(s3, key, n);
  const d3 = evaluateSpeckitGateExhaustion({
    state: s3,
    stepId: "review-spec",
    gateStage: "specify",
    gateKey: key,
    findings: ["f1", "f2", "f3"],
    maxPlanRevisions: 10,
    revisionsUsed: 10,
    failedVerdict: true,
  });
  check("2a: 3 findings escalates instead of carrying",
    d3.action === "escalate", d3);
  check("2a: escalation message names gate (preserving 'SpecKit gate <id> failed.'), open count, and exact reset+run commands",
    d3.message.includes("SpecKit gate review-spec failed.")
      && d3.message.includes("3 open findings")
      && d3.message.includes("ap reset --scope speckit-stage:specify")
      && d3.message.includes("ap run"),
    d3.message);

  // 2b: not decreasing — flat [1, 1]
  const sFlat = {};
  for (const n of [1, 1]) recordSpeckitGateFindingCount(sFlat, key, n);
  const dFlat = evaluateSpeckitGateExhaustion({
    state: sFlat,
    stepId: "review-spec",
    gateStage: "specify",
    gateKey: key,
    findings: ["still broken"],
    maxPlanRevisions: 1,
    revisionsUsed: 1,
    failedVerdict: true,
  });
  check("2b: flat counts [1,1] escalate instead of carrying",
    dFlat.action === "escalate" && dFlat.message.includes("1 open finding"), dFlat);

  // 2c: not decreasing — plateau [5, 2, 2, 2]
  check("2c: plateau [5,2,2,2] is not decreasing",
    isFindingCountDecreasing([5, 2, 2, 2]) === false, isFindingCountDecreasing([5, 2, 2, 2]));

  // 2d: not decreasing — uptick on last round [4, 1, 2]
  check("2d: uptick [4,1,2] is not decreasing",
    isFindingCountDecreasing([4, 1, 2]) === false, isFindingCountDecreasing([4, 1, 2]));

  // 2e: single round [1] (e.g. max_plan_revisions = 0)
  check("2e: single round [1] is not decreasing",
    isFindingCountDecreasing([1]) === false, isFindingCountDecreasing([1]));

  // 2f: maxPlanRevisions = 0 never carries
  const sZero = {};
  for (const n of [4, 1]) recordSpeckitGateFindingCount(sZero, key, n);
  check("2f: maxPlanRevisions=0 never carries",
    canCarryForwardSpeckitGate(sZero, "specify", key, ["one"], 0) === false);

  // 2g: non-FAIL verdict (output-contract/infra) never carries
  const sNoVerdict = {};
  for (const n of [4, 1]) recordSpeckitGateFindingCount(sNoVerdict, key, n);
  const dNoVerdict = evaluateSpeckitGateExhaustion({
    state: sNoVerdict,
    stepId: "review-spec",
    gateStage: "specify",
    gateKey: key,
    findings: ["one"],
    maxPlanRevisions: 3,
    revisionsUsed: 3,
    failedVerdict: false,
  });
  check("2g: failedVerdict=false escalates with 'SpecKit gate review-spec failed.' (R3 output-contract pin)",
    dNoVerdict.action === "escalate" && dNoVerdict.message.includes("SpecKit gate review-spec failed."),
    dNoVerdict);
}

// ── 3. Tasks gate NEVER carries ──────────────────────────────────────────────
{
  const s = {};
  const key = "speckit-stage:tasks";
  for (const n of [6, 3, 1]) recordSpeckitGateFindingCount(s, key, n);
  const decision = evaluateSpeckitGateExhaustion({
    state: s,
    stepId: "review-tasks",
    gateStage: "tasks",
    gateKey: key,
    findings: ["[RULE] T004 missing test file in verify"],
    maxPlanRevisions: 10,
    revisionsUsed: 10,
    failedVerdict: true,
  });
  check("3a: tasks gate never carries even with 1 finding and decreasing [6,3,1]",
    decision.action === "escalate", decision);
  check("3b: tasks gate escalation names review-tasks and ap reset --scope speckit-stage:tasks",
    decision.message.includes("SpecKit gate review-tasks failed")
      && decision.message.includes("1 open finding")
      && decision.message.includes("ap reset --scope speckit-stage:tasks")
      && decision.message.includes("ap run"),
    decision.message);
}

// ── 4. Next planner brief, next reviewer brief (BLOCKING), and write boundary ─
{
  const s = {};
  const specCarried = ["[SEC] require role check on /api/export"];
  recordSpeckitCarriedFindings(s, "specify", specCarried);

  check("4a: carried findings persisted under s.speckitCarriedFindings.specify",
    JSON.stringify(getSpeckitCarriedFindings(s, "specify")) === JSON.stringify(specCarried),
    s.speckitCarriedFindings);

  const planPlannerBrief = speckitCarriedFindingsPlannerNote(s, "plan");
  check("4b: plan planner brief names spec review, spec.md, and carried finding",
    planPlannerBrief.includes("The spec review ran out of revisions with these findings still open — fix them in spec.md as part of this round")
      && planPlannerBrief.includes(specCarried[0]),
    planPlannerBrief);

  const planReviewerBrief = speckitCarriedFindingsReviewerNote(s, "plan");
  check("4c: review-plan reviewer brief lists carried findings as BLOCKING and requires FAIL if still present",
    planReviewerBrief.includes("BLOCKING")
      && planReviewerBrief.includes("confirm")
      && planReviewerBrief.includes("FAIL")
      && planReviewerBrief.includes(specCarried[0]),
    planReviewerBrief);

  // Plan stage carrying forward to tasks stage
  const planCarried = ["[ARCH] add index on audit_log(tenant_id, created_at)"];
  recordSpeckitCarriedFindings(s, "plan", planCarried);
  const tasksPlannerBrief = speckitCarriedFindingsPlannerNote(s, "tasks");
  const tasksReviewerBrief = speckitCarriedFindingsReviewerNote(s, "tasks");
  check("4d: tasks planner brief names plan review, plan.md, and carried finding",
    tasksPlannerBrief.includes("The plan review ran out of revisions with these findings still open — fix them in plan.md as part of this round")
      && tasksPlannerBrief.includes(planCarried[0]),
    tasksPlannerBrief);
  check("4e: review-tasks reviewer brief lists plan carried findings as BLOCKING",
    tasksReviewerBrief.includes("BLOCKING")
      && tasksReviewerBrief.includes("FAIL")
      && tasksReviewerBrief.includes(planCarried[0]),
    tasksReviewerBrief);

  // Clearing specify carried findings leaves plan carried findings intact
  clearSpeckitCarriedFindings(s, "specify");
  check("4f: clearing specify carried findings removes plan note but keeps plan->tasks carried findings",
    speckitCarriedFindingsPlannerNote(s, "plan") === ""
      && getSpeckitCarriedFindings(s, "plan").length === 1,
    s.speckitCarriedFindings);

  // Write boundary: plan stage allows spec.md ONLY when allowCarriedEarlierStage=true (or revision=true)
  const planWithCarry = evaluatePlanningWriteBoundary({
    stage: "plan",
    touchedFiles: ["specs/009-sprint15/plan.md", "specs/009-sprint15/spec.md"],
    preexistingFeatureDirs: [],
    resolvedFeatureDir: "009-sprint15",
    revision: false,
    allowCarriedEarlierStage: true,
  });
  check("4g: plan write boundary allows spec.md when allowCarriedEarlierStage=true",
    planWithCarry.ok === true, planWithCarry);

  const planWithoutCarry = evaluatePlanningWriteBoundary({
    stage: "plan",
    touchedFiles: ["specs/009-sprint15/plan.md", "specs/009-sprint15/spec.md"],
    preexistingFeatureDirs: [],
    resolvedFeatureDir: "009-sprint15",
    revision: false,
    allowCarriedEarlierStage: false,
  });
  check("4h: plan write boundary still rejects spec.md when allowCarriedEarlierStage=false and revision=false",
    planWithoutCarry.ok === false, planWithoutCarry);

  const tasksWithCarry = evaluatePlanningWriteBoundary({
    stage: "tasks",
    touchedFiles: ["specs/009-sprint15/tasks.md", "specs/009-sprint15/plan.md"],
    preexistingFeatureDirs: [],
    resolvedFeatureDir: "009-sprint15",
    revision: false,
    allowCarriedEarlierStage: true,
  });
  check("4i: tasks write boundary allows plan.md when allowCarriedEarlierStage=true",
    tasksWithCarry.ok === true, tasksWithCarry);
}

// ── 5. Resume safety: exact SampleApp-009 state shape ────────────────────────
{
  const key = "speckit-stage:specify";
  const counts009 = [11, 7, 5, 4, 2, 2, 1, 2, 1];
  const state009 = {
    version: 1,
    phase: "planning",
    step: "specify",
    planningStepIndex: 1,
    speckitFeatureDir: "009-sprint-15",
    planReviewRevisions: { [key]: 10 },
    planReviewConfirmationFailed: { [key]: true },
    reviewFeedback: {
      [key]: {
        findings: ["[SEC] missing authorization check on bulk export endpoint"],
      },
    },
    speckitPlanningCheckpoint: { step: "review-spec", index: 1, failedAt: "2026-11-22T10:00:00.000Z" },
    speckitGateReviewCheckpoint: {
      version: 1,
      framework: "speckit",
      gate: "review-spec",
      gateIndex: 1,
      substage: "planner_revision",
    },
  };
  // Populate planReviewHistory with the exact 009 finding counts (NO speckitGateFindingCounts
  // field yet, matching a state.json written before this change).
  for (let r = 0; r < counts009.length; r++) {
    const fsRound = Array.from({ length: counts009[r] }, (_, i) => `r${r + 1}-f${i + 1}`);
    recordPlanReviewRound(state009, key, fsRound, [], { reviewer: true });
  }

  const derivedCounts = getSpeckitGateFindingCounts(state009, key);
  check("5a: SampleApp-009 state derives finding counts from planReviewHistory fallback",
    JSON.stringify(derivedCounts) === JSON.stringify(counts009), derivedCounts);

  const resumeDecision = evaluateSpeckitGateExhaustion({
    state: state009,
    stepId: "review-spec",
    gateStage: "specify",
    gateKey: key,
    findings: state009.reviewFeedback[key].findings,
    maxPlanRevisions: 10,
    revisionsUsed: state009.planReviewRevisions[key],
    failedVerdict: true,
  });
  check("5b: SampleApp-009 state shape takes carry-forward path to plan stage",
    resumeDecision.action === "carry"
      && resumeDecision.nextStage === "plan"
      && resumeDecision.findings.length === 1
      && resumeDecision.findings[0].includes("bulk export"),
    resumeDecision);

  // Also check when the final full re-check FAIL (1 finding) was also appended to history (10th entry)
  recordPlanReviewRound(state009, key, state009.reviewFeedback[key].findings, [], { reviewer: true });
  const resumeDecisionWith10th = evaluateSpeckitGateExhaustion({
    state: state009,
    stepId: "review-spec",
    gateStage: "specify",
    gateKey: key,
    findings: state009.reviewFeedback[key].findings,
    maxPlanRevisions: 10,
    revisionsUsed: state009.planReviewRevisions[key],
    failedVerdict: true,
  });
  check("5c: SampleApp-009 state shape with 10th full-recheck FAIL appended [...,2,1,1] still carries forward",
    resumeDecisionWith10th.action === "carry" && resumeDecisionWith10th.nextStage === "plan",
    resumeDecisionWith10th);

  clearSpeckitGateFindingCounts(state009, key);
}

// ── 6. Real CLI subprocess: `ap reset --scope speckit-stage:specify` ─────────
{
  const repo = makeFixtureRepo("sk4-reset-scope");
  try {
    writeConfig(repo, { planningFramework: "speckit" });
    const initialState = {
      version: 1,
      phase: "planning",
      step: "review-spec",
      planningStepIndex: 1,
      planReviewRevisions: {
        "speckit-stage:specify": 10,
        "speckit-stage:plan": 3,
      },
      reviewFeedback: {
        "speckit-stage:specify": { findings: ["[SEC] missing auth check"] },
      },
      speckitGateFindingCounts: {
        "speckit-stage:specify": [11, 7, 5, 4, 2, 2, 1, 2, 1],
      },
      speckitCarriedFindings: {
        specify: ["carried item"],
      },
    };
    writeState(repo, initialState);

    // 6a: dry-run leaves state untouched
    const dry = runReset(repo, ["--scope", "speckit-stage:specify", "--dry-run"]);
    check("6a: --dry-run exits 0 and reports would clear",
      dry.status === 0 && dry.stdout.includes("would clear planReviewRevisions:speckit-stage:specify=10"),
      { status: dry.status, stdout: dry.stdout, stderr: dry.stderr });
    check("6a: --dry-run does not mutate state.json",
      readState(repo).planReviewRevisions?.["speckit-stage:specify"] === 10,
      readState(repo).planReviewRevisions);

    // 6b: real reset clears ONLY speckit-stage:specify
    const res = runReset(repo, ["--scope", "speckit-stage:specify"]);
    check("6b: ap reset --scope speckit-stage:specify exits 0",
      res.status === 0, { status: res.status, stdout: res.stdout, stderr: res.stderr });
    check("6b: output confirms cleared planReviewRevisions:speckit-stage:specify=10",
      res.stdout.includes("cleared planReviewRevisions:speckit-stage:specify=10"), res.stdout);

    const after = readState(repo);
    check("6b: speckit-stage:specify counter cleared",
      after.planReviewRevisions?.["speckit-stage:specify"] === undefined, after.planReviewRevisions);
    check("6b: speckit-stage:plan counter untouched",
      after.planReviewRevisions?.["speckit-stage:plan"] === 3, after.planReviewRevisions);
    check("6b: reviewFeedback untouched",
      JSON.stringify(after.reviewFeedback) === JSON.stringify(initialState.reviewFeedback), after.reviewFeedback);
    check("6b: speckitGateFindingCounts untouched",
      JSON.stringify(after.speckitGateFindingCounts) === JSON.stringify(initialState.speckitGateFindingCounts),
      after.speckitGateFindingCounts);
    check("6b: speckitCarriedFindings untouched",
      JSON.stringify(after.speckitCarriedFindings) === JSON.stringify(initialState.speckitCarriedFindings),
      after.speckitCarriedFindings);
    check("6b: phase, step, planningStepIndex untouched",
      after.phase === "planning" && after.step === "review-spec" && after.planningStepIndex === 1,
      { phase: after.phase, step: after.step, planningStepIndex: after.planningStepIndex });

    // 6c: resetting a stage with no counter exits 1
    const miss = runReset(repo, ["--scope", "speckit-stage:tasks"]);
    check("6c: ap reset --scope speckit-stage:tasks exits 1 when no counter exists",
      miss.status === 1 && miss.stderr.includes("no recorded plan-review revision counter"),
      { status: miss.status, stderr: miss.stderr });
  } finally {
    cleanup(repo);
  }
}

// ── 7. Autopilot wiring verification ─────────────────────────────────────────
{
  const src = fs.readFileSync(AUTOPILOT, "utf8");
  const evalCalls = (src.match(/evaluateSpeckitGateExhaustion\(/g) || []).length;
  check("7a: autopilot.mjs calls evaluateSpeckitGateExhaustion at all 3 sites (resume-entry, non-rereview, rereview)",
    evalCalls === 3, { evalCalls });
  check("7b: autopilot.mjs wires speckitCarriedFindingsPlannerNote into runPlanningPhase",
    src.includes("speckitCarriedFindingsPlannerNote(s,step)"));
  check("7c: autopilot.mjs wires speckitCarriedFindingsReviewerNote into runSpecKitPlanning",
    src.includes("speckitCarriedFindingsReviewerNote(s,gateStage)"));
  check("7d: autopilot.mjs passes allowCarriedEarlierStage to enforcePlanningWriteBoundary",
    src.includes("allowCarriedEarlierStage:hasCarriedFindings"));
  check("7e: autopilot.mjs wires resetPlanReviewRevisionsScopeCommand for speckit-stage:",
    src.includes('scopeArg.startsWith("speckit-stage:")') && src.includes("resetPlanReviewRevisionsScopeCommand(s,scopeArg"));
}

if (failed > 0) {
  console.error(`\nFAILED: ${failed} check(s) failed (${ok} passed)`);
  process.exit(1);
}
console.log(`\nALL CHECKS PASSED (${ok}/${ok})`);
