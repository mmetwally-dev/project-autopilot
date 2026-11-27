#!/usr/bin/env node
// Backlog sk5:
// (a) parseReviewContract: multiple valid sentinels with the same decision -> last wins;
//     conflicting decisions -> STRUCTURED_OUTPUT_INVALID; identical -> unchanged; trailing notes kept.
// (b) SpecKit gate: clean-exit unusable verdict gets ONE verdict-only retry; if still no verdict,
//     persisted reviewFeedback is NOT wiped, no finding count is recorded, console label does not
//     claim "budget is spent" when revisionsUsed < maxPlanRevisions, and escalation uses the
//     honest no-verdict message.
// (c) Resume safety: resuming at planner_revision with empty reviewFeedback falls back to the
//     last planReviewHistory round's findings.
// (d) speckitGateFindingCounts: each failed review round recorded exactly once (no [7,7,4,1]
//     first-round double-count).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseReviewContract } from "./failure-contract.mjs";
import {
  recordPlanReviewRound,
  recordSpeckitGateFindingCount,
  getSpeckitGateFindingCounts,
  resolveSpeckitResumeFindings,
  formatSpeckitGateFailLabel,
  formatSpeckitGateNoVerdictMessage,
  buildSpeckitVerdictOnlyRetryPrompt,
} from "./plan-review-rounds.mjs";
import { saveReviewFeedback, loadReviewFeedback } from "./review-feedback.mjs";
import {
  makeFixtureRepo,
  makeSpecKitWorkflowOnly,
  makeClaudeMdBaseline,
  writeConfig,
  runAutopilot,
  cleanup,
} from "./test-fixtures/workflow-order-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

let ok = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    ok += 1;
    console.log(`PASS ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

function readState(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
}

function readBriefsByRole(repo, role) {
  const runsRoot = path.join(repo, ".autopilot", "missions");
  const results = [];
  if (!fs.existsSync(runsRoot)) return results;
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === "brief.txt" && path.basename(path.dirname(full)).includes(`-${role}-`)) {
        results.push({ dir: path.basename(path.dirname(full)), text: fs.readFileSync(full, "utf8") });
      }
    }
  })(runsRoot);
  results.sort((a, b) => a.dir.localeCompare(b.dir, undefined, { numeric: true }));
  return results;
}

// Create a single self-contained Node cursor-agent binary (compatible with
// read-only bubblewrap sandboxes where only the binary file itself is bound).
function makeCustomAdapterBin(prefix, scriptBody) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), `ap-sk5-bin-${prefix}-`));
  const launcher = path.join(dir, "cursor-agent");
  fs.writeFileSync(launcher, `#!${process.execPath}\n${scriptBody}\n`, "utf8");
  fs.chmodSync(launcher, 0o755);
  return dir;
}

// ============================================================================
// 1. Parser cases: parseReviewContract
// ============================================================================
{
  const firstFail = 'AUTOPILOT_REVIEW={"decision":"FAIL","findings":[{"location":"plan.md:48","problem":"draft wording","correction":"fix draft"}],"notes":["draft note"]}';
  const secondFail = 'AUTOPILOT_REVIEW={"decision":"FAIL","findings":[{"location":"plan.md:48","problem":"final reworded problem","correction":"final correction"}],"notes":["final note"]}';
  const parsed = parseReviewContract(`Review body.\n\n${firstFail}\n\n${secondFail}`);
  check("1a: two reworded FAIL sentinels -> contract valid, decision FAIL",
    parsed.contract.status === "valid" && parsed.verdict.decision === "FAIL" && parsed.failure === null,
    parsed);
  check("1b: two reworded FAIL sentinels -> last sentinel's findings & notes win",
    parsed.verdict.findings.length === 1
      && parsed.verdict.findings[0].includes("final reworded problem")
      && !parsed.verdict.findings[0].includes("draft wording")
      && parsed.verdict.notes.length === 1
      && parsed.verdict.notes[0] === "final note",
    parsed.verdict);

  // Two reworded PASS sentinels -> last wins
  const pass1 = 'AUTOPILOT_REVIEW={"decision":"PASS","findings":[],"notes":["first pass note"]}';
  const pass2 = 'AUTOPILOT_REVIEW={"decision":"PASS","findings":[],"notes":["second pass note"]}';
  const parsedPass = parseReviewContract(`${pass1}\n${pass2}`);
  check("1c: two reworded PASS sentinels -> valid PASS with second sentinel's notes",
    parsedPass.contract.status === "valid"
      && parsedPass.verdict.decision === "PASS"
      && parsedPass.verdict.notes[0] === "second pass note",
    parsedPass);

  // Trailing prose after two same-decision sentinels -> kept as trailingNotes
  const withTrailing = parseReviewContract(`${firstFail}\n${secondFail}\nExtra prose note after final sentinel.`);
  check("1d: trailing prose after second same-decision sentinel kept in trailingNotes",
    withTrailing.contract.status === "valid"
      && withTrailing.verdict.decision === "FAIL"
      && withTrailing.contract.trailingNotes === "Extra prose note after final sentinel.",
    withTrailing);

  // Truncated sentinel after two same-decision sentinels -> invalid
  const withBadTail = parseReviewContract(`${firstFail}\n${secondFail}\nAUTOPILOT_REVIEW={"decision":`);
  check("1e: truncated sentinel after two same-decision sentinels still fails",
    withBadTail.contract.status === "invalid" && withBadTail.failure?.class === "STRUCTURED_OUTPUT_INVALID",
    withBadTail);

  // Conflicting decisions -> invalid with existing message
  const conflicting = parseReviewContract(`${firstFail}\n${pass2}`);
  check("1f: conflicting decisions (FAIL + PASS) -> STRUCTURED_OUTPUT_INVALID with existing message",
    conflicting.contract.status === "invalid"
      && conflicting.failure?.class === "STRUCTURED_OUTPUT_INVALID"
      && conflicting.contract.error === "Multiple review sentinels were observed.",
    conflicting);

  const conflictingInc = parseReviewContract(`${firstFail}\nAUTOPILOT_REVIEW={"decision":"INCOMPLETE","findings":[]}`);
  check("1g: conflicting decisions (FAIL + INCOMPLETE) -> STRUCTURED_OUTPUT_INVALID",
    conflictingInc.contract.status === "invalid"
      && conflictingInc.failure?.class === "STRUCTURED_OUTPUT_INVALID"
      && conflictingInc.contract.error === "Multiple review sentinels were observed.",
    conflictingInc);

  // Identical sentinels -> unchanged
  const identical = parseReviewContract(`${secondFail}\n${secondFail}`);
  check("1h: identical sentinels -> valid, last wins unchanged",
    identical.contract.status === "valid"
      && identical.verdict.decision === "FAIL"
      && identical.verdict.findings[0].includes("final reworded problem"),
    identical);

  // Valid + bad schema sentinel -> invalid
  const badSecond = parseReviewContract(`${firstFail}\nAUTOPILOT_REVIEW={"decision":"MAYBE","findings":[]}`);
  check("1i: valid sentinel + bad-schema sentinel -> STRUCTURED_OUTPUT_INVALID",
    badSecond.contract.status === "invalid" && badSecond.failure?.class === "STRUCTURED_OUTPUT_INVALID",
    badSecond);

  // Live SampleApp run 35 raw output check
  const run35Path = path.join(repoRoot, ".ref", "run35-result.json");
  if (fs.existsSync(run35Path)) {
    const run35 = JSON.parse(fs.readFileSync(run35Path, "utf8"));
    const parsed35 = parseReviewContract(run35.finalMessage);
    check("1j: live .ref/run35-result.json parses as valid FAIL with 2 findings from the second sentinel",
      parsed35.contract.status === "valid"
        && parsed35.verdict.decision === "FAIL"
        && parsed35.verdict.findings.length === 2
        && parsed35.verdict.notes.some((n) => n.startsWith("A tenant REINVITE that hits the row-7 budget 429")),
      { status: parsed35.contract.status, decision: parsed35.verdict.decision, count: parsed35.verdict.findings.length });
  }
}

// ============================================================================
// 2. Gate message & console label wording
// ============================================================================
{
  const noVerdictLabel = formatSpeckitGateFailLabel({
    label: "Plan Review",
    revisionAllowed: false,
    failedVerdict: false,
    revisionsUsed: 3,
    maxPlanRevisions: 10,
  });
  check("2a: unusable verdict label does NOT say 'budget is spent'",
    !noVerdictLabel.includes("budget is spent") && noVerdictLabel.includes("no usable verdict"),
    noVerdictLabel);

  const partialBudgetLabel = formatSpeckitGateFailLabel({
    label: "Plan Review",
    revisionAllowed: false,
    failedVerdict: true,
    revisionsUsed: 3,
    maxPlanRevisions: 10,
  });
  check("2b: partial budget label (3/10) does NOT say 'budget is spent'",
    !partialBudgetLabel.includes("budget is spent") && partialBudgetLabel.includes("3/10"),
    partialBudgetLabel);

  const spentBudgetLabel = formatSpeckitGateFailLabel({
    label: "Plan Review",
    revisionAllowed: false,
    failedVerdict: true,
    revisionsUsed: 10,
    maxPlanRevisions: 10,
  });
  check("2c: spent budget label (10/10) says 'plan revision budget is spent'",
    spentBudgetLabel === "  FAIL — Plan Review (plan revision budget is spent)",
    spentBudgetLabel);

  const zeroBudgetLabel = formatSpeckitGateFailLabel({
    label: "Plan Review",
    revisionAllowed: false,
    failedVerdict: true,
    revisionsUsed: 0,
    maxPlanRevisions: 0,
  });
  check("2d: zero budget label says 'plan revision budget is 0'",
    zeroBudgetLabel === "  FAIL — Plan Review (plan revision budget is 0)",
    zeroBudgetLabel);

  const msg = formatSpeckitGateNoVerdictMessage({
    stepId: "review-plan",
    result: {
      failure: {
        class: "STRUCTURED_OUTPUT_INVALID",
        evidence: [{ source: "relay", message: "Multiple review sentinels were observed." }],
      },
    },
    revisionsUsed: 3,
    maxPlanRevisions: 10,
  });
  check("2e: no-verdict escalation message matches required wording exactly",
    msg === "SpecKit gate review-plan failed: reviewer gave no usable verdict (STRUCTURED_OUTPUT_INVALID: Multiple review sentinels were observed.) after one retry. Plan revision budget 3/10 used.\nResume: ap run",
    msg);

  const retryPrompt = buildSpeckitVerdictOnlyRetryPrompt({
    stepId: "review-plan",
    failureClass: "STRUCTURED_OUTPUT_MISSING",
    evidenceMessage: "Review sentinel was not observed.",
  });
  check("2f: verdict-only retry prompt asks for exactly one AUTOPILOT_REVIEW line as last line",
    retryPrompt.includes("review-plan")
      && retryPrompt.includes("EXACTLY ONE AUTOPILOT_REVIEW")
      && retryPrompt.includes("LAST non-empty line"),
    retryPrompt);
}

// ============================================================================
// 3. Pure unit checks: resume fallback & single finding-count recording
// ============================================================================
{
  // 3a: Resume fallback (exact mission 009 shape)
  const s009 = {};
  const key = "speckit-stage:plan";
  recordPlanReviewRound(s009, key, ["r1-1", "r1-2", "r1-3", "r1-4", "r1-5", "r1-6", "r1-7"]);
  recordPlanReviewRound(s009, key, ["r2-1", "r2-2", "r2-3", "r2-4"]);
  recordPlanReviewRound(s009, key, ["r3-audit-model-finding"]);

  const resolvedWhenEmpty = resolveSpeckitResumeFindings(s009, key, loadReviewFeedback(s009, key));
  check("3a: empty reviewFeedback falls back to last planReviewHistory round",
    JSON.stringify(resolvedWhenEmpty) === JSON.stringify(["r3-audit-model-finding"]),
    resolvedWhenEmpty);

  saveReviewFeedback(s009, key, ["explicit-persisted-finding"]);
  const resolvedWhenPresent = resolveSpeckitResumeFindings(s009, key, loadReviewFeedback(s009, key));
  check("3b: non-empty reviewFeedback wins over planReviewHistory",
    JSON.stringify(resolvedWhenPresent) === JSON.stringify(["explicit-persisted-finding"]),
    resolvedWhenPresent);

  // 3c: Finding counts recorded once per round (calling recordSpeckitGateFindingCount before recordPlanReviewRound)
  const sCounts = {};
  for (const n of [7, 4, 1]) {
    const items = Array.from({ length: n }, (_, i) => `f-${n}-${i + 1}`);
    recordSpeckitGateFindingCount(sCounts, key, items.length);
    recordPlanReviewRound(sCounts, key, items);
  }
  const counts = getSpeckitGateFindingCounts(sCounts, key);
  check("3c: 3 rounds [7,4,1] record speckitGateFindingCounts as [7,4,1] (no first-round double count)",
    JSON.stringify(counts) === JSON.stringify([7, 4, 1]) && sCounts.planReviewHistory[key].length === 3,
    { counts, historyLen: sCounts.planReviewHistory[key].length });
}

// ============================================================================
// 4. Behavioural SpecKit gate test:
//    - Initial review FAILs with 3 findings -> counts recorded ONCE ([3])
//    - Re-review returns clean-exit missing sentinel -> ONE verdict-only retry
//    - Retry ALSO returns clean-exit missing sentinel -> escalates honestly,
//      does NOT wipe persisted reviewFeedback, does NOT record a 2nd count,
//      does NOT say "budget is spent" (1/5 used).
// ============================================================================
{
  const repo = makeFixtureRepo("sk5-noverdict-escalate");
  const binDir = makeCustomAdapterBin("noverdict", `
const fs = require("node:fs");
const path = require("node:path");

if (process.argv.includes("--version")) {
  console.log("fake-cursor-agent 1.0.0");
  process.exit(0);
}

const cwd = process.cwd();
const prompt = fs.readFileSync(0, "utf8");
const isReviewer = /^ROLE=plan_reviewer$/m.test(prompt)
  || prompt.includes("Review the current artifact state")
  || prompt.includes("Re-review the SpecKit gate")
  || prompt.includes("VERDICT-ONLY RETRY");

if (!isReviewer) {
  const featDir = path.join(cwd, "specs", "001-sk5-feature");
  fs.mkdirSync(featDir, { recursive: true });
  fs.mkdirSync(path.join(cwd, ".specify"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".specify", "feature.json"), JSON.stringify({ feature_directory: "specs/001-sk5-feature" }));
  const rev = prompt.includes("REJECTED") ? 2 : 1;
  fs.writeFileSync(path.join(featDir, "spec.md"), "# Spec\\n\\nRevision " + rev + "\\n");
  console.log("Wrote spec.md revision " + rev);
  process.exit(0);
}

if (prompt.includes("VERDICT-ONLY RETRY") || prompt.includes("Re-review the SpecKit gate")) {
  // Re-review AND its verdict-only retry: clean exit, no sentinel
  console.log("Finished reading the spec, looks interesting but forgot sentinel.");
  process.exit(0);
}
// Initial review: FAIL with 3 findings
console.log('Initial review failed.\\nAUTOPILOT_REVIEW={"decision":"FAIL","findings":["spec-f1: missing FR-1","spec-f2: missing FR-2","spec-f3: missing FR-3"]}');
process.exit(0);
`);

  try {
    makeSpecKitWorkflowOnly(repo);
    makeClaudeMdBaseline(repo);
    writeConfig(repo, { planningFramework: "speckit", maxPlanRevisions: 5 });
    const run = runAutopilot(repo, binDir, { request: "sk5 no verdict test", timeoutMs: 120000 });
    const combined = `${run.stdout || ""}\n${run.stderr || ""}`;
    const st = readState(repo);
    const reviewerBriefs = readBriefsByRole(repo, "plan_reviewer");

    check("4a: unusable verdict after one retry exits non-zero", run.status !== 0, { status: run.status });
    check("4b: reviewer ran 3 times (initial FAIL + re-review missing + ONE verdict-only retry)",
      reviewerBriefs.length === 3, { count: reviewerBriefs.length });
    check("4c: escalation message matches honest no-verdict format with 1/5 budget",
      combined.includes("SpecKit gate review-spec failed: reviewer gave no usable verdict (STRUCTURED_OUTPUT_MISSING: Review sentinel was not observed.) after one retry. Plan revision budget 1/5 used.")
        && combined.includes("Resume: ap run"),
      combined.slice(-800));
    check("4d: console label does NOT say 'plan revision budget is spent' when 1/5 used",
      !combined.includes("plan revision budget is spent")
        && combined.includes("reviewer gave no usable verdict"),
      combined.slice(-800));
    check("4e: persisted reviewFeedback is NOT wiped to [] on unusable verdict",
      Array.isArray(st.reviewFeedback?.["speckit-stage:specify"]?.findings)
        && st.reviewFeedback["speckit-stage:specify"].findings.length === 3
        && st.reviewFeedback["speckit-stage:specify"].findings[0].includes("spec-f1"),
      st.reviewFeedback);
    check("4f: speckitGateFindingCounts recorded round 1 exactly ONCE as [3] (no double-count, no count for unusable verdict)",
      JSON.stringify(st.speckitGateFindingCounts?.["speckit-stage:specify"]) === JSON.stringify([3]),
      st.speckitGateFindingCounts);
    check("4g: planReviewHistory has 1 round matching speckitGateFindingCounts",
      Array.isArray(st.planReviewHistory?.["speckit-stage:specify"])
        && st.planReviewHistory["speckit-stage:specify"].length === 1,
      st.planReviewHistory);
    check("4h: 3rd reviewer call received the VERDICT-ONLY RETRY brief",
      reviewerBriefs.length === 3 && reviewerBriefs[2].text.includes("VERDICT-ONLY RETRY"),
      reviewerBriefs.map((b) => b.text.slice(0, 120)));
  } finally {
    cleanup(repo, binDir);
  }
}

// ============================================================================
// 5. Behavioural SpecKit gate test:
//    - Initial review returns clean-exit missing sentinel -> ONE verdict-only
//      retry recovers with PASS -> gate continues normally!
// ============================================================================
{
  const repo = makeFixtureRepo("sk5-noverdict-recover");
  const binDir = makeCustomAdapterBin("recover", `
const fs = require("node:fs");
const path = require("node:path");

if (process.argv.includes("--version")) {
  console.log("fake-cursor-agent 1.0.0");
  process.exit(0);
}

const cwd = process.cwd();
const prompt = fs.readFileSync(0, "utf8");
const isReviewer = /^ROLE=plan_reviewer$/m.test(prompt)
  || prompt.includes("Review the current artifact state")
  || prompt.includes("Re-review the SpecKit gate")
  || prompt.includes("VERDICT-ONLY RETRY");

if (!isReviewer) {
  const featDir = path.join(cwd, "specs", "001-sk5-recover");
  fs.mkdirSync(featDir, { recursive: true });
  fs.mkdirSync(path.join(cwd, ".specify"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".specify", "feature.json"), JSON.stringify({ feature_directory: "specs/001-sk5-recover" }));
  if (prompt.includes("Planning phase: specify")) {
    fs.writeFileSync(path.join(featDir, "spec.md"), "# Spec\\n");
  } else if (prompt.includes("Planning phase: plan")) {
    fs.writeFileSync(path.join(featDir, "plan.md"), "# Plan\\n");
  } else if (prompt.includes("Planning phase: tasks")) {
    fs.writeFileSync(path.join(featDir, "tasks.md"), "## Phase 1\\n- [ ] T001 write hello.txt\\n");
  }
  console.log("Done.");
  process.exit(0);
}

if (prompt.includes('SpecKit gate "review-spec"') && !prompt.includes("VERDICT-ONLY RETRY")) {
  // Initial review on review-spec: clean exit, missing sentinel
  console.log("Reviewed spec.md, everything looks good (forgot sentinel).");
  process.exit(0);
}
// Verdict-only retry and all subsequent gates: PASS
console.log('AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}');
process.exit(0);
`);

  try {
    makeSpecKitWorkflowOnly(repo);
    makeClaudeMdBaseline(repo);
    writeConfig(repo, { planningFramework: "speckit", maxPlanRevisions: 5 });
    const cfgPath = path.join(repo, ".autopilot", "config.json");
    const cfgObj = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfgObj.workflow = { ...(cfgObj.workflow || {}), pauseForPlanApproval: true };
    fs.writeFileSync(cfgPath, JSON.stringify(cfgObj, null, 2));
    const run = runAutopilot(repo, binDir, { request: "sk5 recover on verdict-only retry", timeoutMs: 120000 });
    const combined = `${run.stdout || ""}\n${run.stderr || ""}`;
    const st = readState(repo);
    const reviewerBriefs = readBriefsByRole(repo, "plan_reviewer");

    check("5a: verdict-only retry recovers from initial missing sentinel and completes planning",
      run.status === 0 && (st.phase === "plan_approval" || st.phase === "tasks_ready"),
      { status: run.status, phase: st.phase, tail: combined.slice(-500) });
    check("5b: reviewer ran 4 times (spec miss + spec retry PASS + plan PASS + tasks PASS)",
      reviewerBriefs.length === 4 && reviewerBriefs[1].text.includes("VERDICT-ONLY RETRY"),
      { count: reviewerBriefs.length });
  } finally {
    cleanup(repo, binDir);
  }
}

// ============================================================================
// 6. Behavioural Resume Safety test (exact mission 009 shape):
//    checkpoint = planner_revision on review-plan, reviewFeedback missing for
//    speckit-stage:plan, planReviewHistory has 3 rounds [7, 4, 1].
//    On resume, Planner receives the last history round's finding!
// ============================================================================
{
  const repo = makeFixtureRepo("sk5-resume-history");
  const binDir = makeCustomAdapterBin("resume-history", `
const fs = require("node:fs");
const path = require("node:path");

if (process.argv.includes("--version")) {
  console.log("fake-cursor-agent 1.0.0");
  process.exit(0);
}

const cwd = process.cwd();
const prompt = fs.readFileSync(0, "utf8");
const isReviewer = /^ROLE=plan_reviewer$/m.test(prompt)
  || prompt.includes("Review the current artifact state")
  || prompt.includes("Re-review the SpecKit gate")
  || prompt.includes("VERDICT-ONLY RETRY");

if (!isReviewer) {
  const featDir = path.join(cwd, "specs", "009-cross-tenant");
  fs.mkdirSync(featDir, { recursive: true });
  if (prompt.includes("Planning phase: plan")) {
    fs.writeFileSync(path.join(featDir, "plan.md"), "# Plan (revised on resume)\\n");
  } else if (prompt.includes("Planning phase: tasks")) {
    fs.writeFileSync(path.join(featDir, "tasks.md"), "## Phase 1\\n- [ ] T001 do work\\n");
  }
  console.log("Revised.");
  process.exit(0);
}
console.log('AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}');
process.exit(0);
`);

  try {
    makeSpecKitWorkflowOnly(repo);
    makeClaudeMdBaseline(repo);
    writeConfig(repo, { planningFramework: "speckit", maxPlanRevisions: 10 });
    const cfgPath = path.join(repo, ".autopilot", "config.json");
    const cfgObj = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfgObj.workflow = { ...(cfgObj.workflow || {}), pauseForPlanApproval: true };
    fs.writeFileSync(cfgPath, JSON.stringify(cfgObj, null, 2));

    const featDir = path.join(repo, "specs", "009-cross-tenant");
    fs.mkdirSync(featDir, { recursive: true });
    fs.mkdirSync(path.join(repo, ".specify"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".specify", "feature.json"), JSON.stringify({ feature_directory: "specs/009-cross-tenant" }));
    fs.writeFileSync(path.join(featDir, "spec.md"), "# Spec 009\n");
    fs.writeFileSync(path.join(featDir, "plan.md"), "# Plan 009\n");

    const key = "speckit-stage:plan";
    const uniqueFinding = "AUDIT_MODEL_UNIQUE_ROUND3_FINDING: define one audit model with persisted audit_mode";
    const state = {
      version: 1,
      phase: "planning",
      step: "review-plan",
      planningStepIndex: 3,
      planningRequest: "resume mission 009 plan gate",
      mission: "009-cross-tenant",
      speckitFeatureDir: "009-cross-tenant",
      planReviewRevisions: { [key]: 3 },
      planReviewReviewerRounds: { [key]: 3 },
      speckitGateFindingCounts: { [key]: [7, 4, 1] },
      // reviewFeedback intentionally missing for speckit-stage:plan (exact 009 bug state)
      reviewFeedback: {},
      planReviewHistory: {
        [key]: [
          { round: 1, findings: ["r1-1", "r1-2", "r1-3", "r1-4", "r1-5", "r1-6", "r1-7"], previous: [] },
          { round: 2, findings: ["r2-1", "r2-2", "r2-3", "r2-4"], previous: [] },
          { round: 3, findings: [uniqueFinding], previous: [] },
        ],
      },
      speckitPlanningCheckpoint: { step: "review-plan", index: 3, failedAt: "2026-11-22T17:57:16.000Z" },
      speckitGateReviewCheckpoint: {
        version: 1,
        framework: "speckit",
        mission: "009-cross-tenant",
        feature: "009-cross-tenant",
        gate: "review-plan",
        gateIndex: 3,
        substage: "planner_revision",
        artifacts: ["specs/009-cross-tenant/spec.md", "specs/009-cross-tenant/plan.md"],
        artifactDigest: null,
        updatedAt: "2026-11-22T17:57:16.000Z",
      },
    };
    fs.mkdirSync(path.join(repo, ".autopilot"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(state, null, 2));

    const run = runAutopilot(repo, binDir, { request: "resume mission 009 plan gate", timeoutMs: 120000 });
    const combined = `${run.stdout || ""}\n${run.stderr || ""}`;
    const plannerBriefs = readBriefsByRole(repo, "planner");
    const planRevisionBrief = plannerBriefs.find((b) => b.text.includes("Planning phase: plan"));

    check("6a: resumed mission 009 completes planning cleanly",
      run.status === 0,
      { status: run.status, tail: combined.slice(-500) });
    check("6b: resumed planner revision brief includes the last history round's finding even though reviewFeedback was empty",
      Boolean(planRevisionBrief && planRevisionBrief.text.includes(uniqueFinding)),
      planRevisionBrief ? planRevisionBrief.text.slice(0, 600) : "no plan brief found");
  } finally {
    cleanup(repo, binDir);
  }
}

console.log(`\n${ok} passed, ${failed} failed.`);
if (failed) process.exit(1);
