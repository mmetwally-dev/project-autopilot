#!/usr/bin/env node
// Backlog #8:
// (a) Progress-aware stop: PLAN_REVIEW_CAPPED_TWICE / CODE_REVIEW_CAPPED_TWICE
//     fires only when session 2 made NO progress over session 1 (identical
//     carried scratch report, note, and workDigest). When session 2 made
//     progress, allow the next session (still bounded by extra_sessions).
// The 1.5x stage budget was removed: every plan reviewer session (spec,
// review-plan, review-tasks, standalone plan review) uses exactly
// caps.plan_reviewer.max_turns (1x).
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  resolvePerRoleLimits,
  reviewSessionProgress,
} from "./per-task-budget.mjs";
import {
  handleCappedPlanReviewerWithoutVerdict,
  handleCodeReviewerUnchangedNote,
} from "./autopilot.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  }
}

// ── 1. Plan reviews use exactly caps.plan_reviewer.max_turns (1x) ─────────
check("cap: review-plan and review-tasks use the configured plan_reviewer cap unchanged",
  resolvePerRoleLimits("plan_reviewer", {caps: {plan_reviewer: {max_turns: 30}}}).perTaskMaxTurns === 30 &&
  resolvePerRoleLimits("plan_reviewer", {caps: {plan_reviewer: {max_turns: 25}}}).perTaskMaxTurns === 25);

check("cap: spec review and standalone plan review use the same 1x plan_reviewer cap",
  resolvePerRoleLimits("plan_reviewer", {}).perTaskMaxTurns === 30 &&
  resolvePerRoleLimits("plan_reviewer", {caps: {plan_reviewer: {max_turns: 40}}}).perTaskMaxTurns === 40);

// ── 2. reviewSessionProgress (Part a: unit) ───────────────────────────────
check("progress: null prev returns true (first session)",
  reviewSessionProgress(null, {reportText: "r", noteText: "n", workDigest: "d"}) === true);

check("progress: identical carried report, note, and digest returns false",
  reviewSessionProgress(
    {reportText: "REPORT-FROM-RUN1", noteText: "1. Done — partial.\n2. Found — still reviewing.\n", workDigest: "read: TASKS.md"},
    {reportText: "REPORT-FROM-RUN1", noteText: "1. Done — partial.\n2. Found — still reviewing.\n", workDigest: "read: TASKS.md"}
  ) === false);

check("progress: new findings added in report text returns true",
  reviewSessionProgress(
    {reportText: "REPORT-FROM-RUN1", noteText: "note", workDigest: ""},
    {reportText: "REPORT-FROM-RUN1\n\n- Finding: Bug in auth module", noteText: "note", workDigest: ""}
  ) === true);

check("progress: new findings added in note returns true",
  reviewSessionProgress(
    {reportText: "REPORT-FROM-RUN1", noteText: "1. Done — partial.\n2. Found — still reviewing.\n", workDigest: ""},
    {reportText: "REPORT-FROM-RUN1", noteText: "## Found\n- auth.mjs:10 — missing token verification\n", workDigest: ""}
  ) === true);

check("progress: new files checked in note returns true",
  reviewSessionProgress(
    {reportText: "REPORT-FROM-RUN1", noteText: "1. Done — checked general.\n", workDigest: ""},
    {reportText: "REPORT-FROM-RUN1", noteText: "1. Done — checked general, auth.mjs, and db.mjs.\n", workDigest: ""}
  ) === true);

check("progress: two sessions with different workDigest but same findings/files returns false (no progress)",
  reviewSessionProgress(
    {reportText: "REPORT-FROM-RUN1", noteText: "note", workDigest: "read: TASKS.md"},
    {reportText: "REPORT-FROM-RUN1", noteText: "note", workDigest: "read: TASKS.md; read: auth.mjs"}
  ) === false);

check("progress: timestamps differing but same findings/files returns false",
  reviewSessionProgress(
    {reportText: "Checked at 2026-11-19T16:00:00 (run-1)", noteText: "1. Done.\n2. Found — still reviewing.\n"},
    {reportText: "Checked at 2026-11-19T16:05:00 (run-2)", noteText: "1. Done.\n2. Found — still reviewing.\n"}
  ) === false);

check("progress: reworded identical findings returns false",
  reviewSessionProgress(
    {reportText: "- Finding: Bug in auth module", noteText: ""},
    {reportText: "- Finding: bug in the auth module", noteText: ""}
  ) === false);

check("progress: same files listed again returns false",
  reviewSessionProgress(
    {reportText: "checked auth.mjs", noteText: ""},
    {reportText: "checked auth.mjs again", noteText: ""}
  ) === false);

// Fixture scenario mirroring: fake-plan-reviewer-carry-adapter.mjs
check("progress: double scenario (session 2 rewords Found status note without new report lines or files) returns false",
  reviewSessionProgress(
    {
      reportText: "REPORT-FROM-RUN1",
      noteText: "1. Done — partial checks.\n2. Found — still reviewing; more checks remain.\n3. Next — continue checking.\n4. Dead ends — none.\n",
    },
    {
      reportText: "REPORT-FROM-RUN1",
      noteText: "1. Done — still checking.\n2. Found — still reviewing; no verdict yet.\n3. Next — continue checking.\n4. Dead ends — none.\n",
    }
  ) === false);

check("progress: progress scenario (session 2 adds finding to report.md and names auth.mjs in note) returns true",
  reviewSessionProgress(
    {
      reportText: "REPORT-FROM-RUN1",
      noteText: "1. Done — checked the gate.\n2. Found — REVIEW IN PROGRESS; report at /workspace/scratch/report.md.\n3. Next — finish the remaining checks.\n4. Dead ends — none.\n",
    },
    {
      reportText: "REPORT-FROM-RUN1\n\n- Finding: Bug in auth module",
      noteText: "1. Done — checked auth.mjs.\n2. Found — new findings in report.md.\n3. Next — continue checking.\n4. Dead ends — none.\n",
    }
  ) === true);

check("progress: hand-off note Found/Done/Next prose changes alone without new files never count as progress",
  reviewSessionProgress(
    {
      reportText: "REPORT-FROM-RUN1",
      noteText: "1. Done — checked nothing.\n2. Found — still reviewing; more checks remain.\n3. Next — continue checking.\n4. Dead ends — none.\n",
    },
    {
      reportText: "REPORT-FROM-RUN1",
      noteText: "1. Done — still checking.\n2. Found — completely different text but no file path.\n3. Next — finish soon.\n4. Dead ends — none.\n",
    }
  ) === false);

// ── 3. handleCappedPlanReviewerWithoutVerdict (Part a: behavioral) ─────────
const testFatal = (msg) => { throw new Error(msg); };

// Scenario: two capped sessions with identical carried report -> stop
{
  const s = {mission: "001-test", planReviewCappedNoVerdict: {}, planReviewCappedArtifacts: {}};
  const contScope = "task:speckit:planning:plan_reviewer";
  let died = false;
  let dieMsg = "";

  // Run 1: caps
  handleCappedPlanReviewerWithoutVerdict({
    s,
    framework: "speckit",
    result: {capped: {type: "turns", used: 30, limit: 30}, workDigest: "read: TASKS.md"},
    subject: "SpecKit plan reviewer",
    contScope,
    taskRef: "speckit-plan_reviewer",
    mission: "001-test",
    fatal: testFatal,
  });
  check("plan_reviewer: session 1 records streak 1 without escalation",
    s.phase !== "escalated" && s.planReviewCappedNoVerdict[contScope] === 1,
    {phase: s.phase, streak: s.planReviewCappedNoVerdict[contScope]});

  // Run 2: caps with identical artifacts (no progress) -> stops with PLAN_REVIEW_CAPPED_TWICE
  try {
    handleCappedPlanReviewerWithoutVerdict({
      s,
      framework: "speckit",
      result: {capped: {type: "turns", used: 30, limit: 30}, workDigest: "read: TASKS.md"},
      subject: "SpecKit plan reviewer",
      contScope,
      taskRef: "speckit-plan_reviewer",
      mission: "001-test",
      fatal: testFatal,
    });
  } catch (e) {
    died = true;
    dieMsg = e.message;
  }
  check("plan_reviewer: two capped sessions with identical artifacts stops (PLAN_REVIEW_CAPPED_TWICE)",
    died && s.phase === "escalated" && s.phaseCheckpointError?.code === "PLAN_REVIEW_CAPPED_TWICE",
    {died, phase: s.phase, err: s.phaseCheckpointError});
}

// Scenario: two capped sessions where second added new findings -> third session starts
{
  const s = {mission: "002-test", planReviewCappedNoVerdict: {}, planReviewCappedArtifacts: {}};
  const contScope = "task:speckit:planning:plan_reviewer";
  let diedRun2 = false;

  // Run 1: caps
  handleCappedPlanReviewerWithoutVerdict({
    s,
    framework: "speckit",
    result: {capped: {type: "turns", used: 30, limit: 30}, reportText: "REPORT-FROM-RUN1", workDigest: "read: TASKS.md"},
    subject: "SpecKit plan reviewer",
    contScope,
    taskRef: "speckit-plan_reviewer",
    mission: "002-test",
    fatal: testFatal,
  });

  // Run 2: caps but added new findings in carried report
  try {
    handleCappedPlanReviewerWithoutVerdict({
      s,
      framework: "speckit",
      result: {capped: {type: "turns", used: 30, limit: 30}, reportText: "REPORT-FROM-RUN1\n\n- Finding: Bug in auth module", workDigest: "read: TASKS.md; read: src/auth.mjs; read: src/db.mjs"},
      subject: "SpecKit plan reviewer",
      contScope,
      taskRef: "speckit-plan_reviewer",
      mission: "002-test",
      fatal: testFatal,
    });
  } catch (e) {
    diedRun2 = true;
  }
  check("plan_reviewer: session 2 with progress does NOT stop; streak stays 1 so third session starts",
    !diedRun2 && s.phase !== "escalated" && s.planReviewCappedNoVerdict[contScope] === 1,
    {diedRun2, phase: s.phase, streak: s.planReviewCappedNoVerdict[contScope]});

  // Run 3: caps with identical artifacts to Run 2 -> now stops
  let diedRun3 = false;
  try {
    handleCappedPlanReviewerWithoutVerdict({
      s,
      framework: "speckit",
      result: {capped: {type: "turns", used: 30, limit: 30}, reportText: "REPORT-FROM-RUN1\n\n- Finding: Bug in auth module", workDigest: "read: TASKS.md; read: src/auth.mjs; read: src/db.mjs"},
      subject: "SpecKit plan reviewer",
      contScope,
      taskRef: "speckit-plan_reviewer",
      mission: "002-test",
      fatal: testFatal,
    });
  } catch (e) {
    diedRun3 = true;
  }
  check("plan_reviewer: session 3 with no progress over session 2 stops (PLAN_REVIEW_CAPPED_TWICE)",
    diedRun3 && s.phase === "escalated" && s.phaseCheckpointError?.code === "PLAN_REVIEW_CAPPED_TWICE",
    {diedRun3, phase: s.phase, err: s.phaseCheckpointError});
}

// ── 4. handleCodeReviewerUnchangedNote (Part a: consistency) ───────────────
// Scenario: two capped code review sessions with no progress -> stops with CODE_REVIEW_CAPPED_TWICE
{
  const s = {codeReviewUnchangedNoteStreak: {}, codeReviewCappedArtifacts: {}};
  const contScope = "task:code_review:phase-1";
  let died = false;

  // Run 1: caps
  handleCodeReviewerUnchangedNote({
    s,
    rv: {capped: {type: "turns", used: 22, limit: 22}, workDigest: "diff checked"},
    prevNote: "previous note",
    nextNote: "fallback note",
    contScope,
    subject: "Phase 1 code review",
    step: "task_not_converging",
    fatal: testFatal,
  });
  check("code_reviewer: session 1 records streak 1 without escalation",
    s.phase !== "escalated" && s.codeReviewUnchangedNoteStreak[contScope] === 1,
    {phase: s.phase, streak: s.codeReviewUnchangedNoteStreak[contScope]});

  // Run 2: caps with identical note & digest -> stops
  try {
    handleCodeReviewerUnchangedNote({
      s,
      rv: {capped: {type: "turns", used: 22, limit: 22}, workDigest: "diff checked"},
      prevNote: "fallback note",
      nextNote: "fallback note",
      contScope,
      subject: "Phase 1 code review",
      step: "task_not_converging",
      fatal: testFatal,
    });
  } catch (e) {
    died = true;
  }
  check("code_reviewer: session 2 with identical note and digest stops (CODE_REVIEW_CAPPED_TWICE)",
    died && s.phase === "escalated" && s.phaseCheckpointError?.code === "CODE_REVIEW_CAPPED_TWICE",
    {died, phase: s.phase, err: s.phaseCheckpointError});
}

// Scenario: two capped code review sessions where session 2 checked new files -> allows next session
{
  const s = {codeReviewUnchangedNoteStreak: {}, codeReviewCappedArtifacts: {}};
  const contScope = "task:code_review:phase-2";
  let diedRun2 = false;

  // Run 1: caps
  handleCodeReviewerUnchangedNote({
    s,
    rv: {capped: {type: "turns", used: 22, limit: 22}, workDigest: "read: file1.mjs"},
    prevNote: "note",
    nextNote: "1. Done — checked file1.mjs.\n",
    contScope,
    subject: "Phase 2 code review",
    step: "task_not_converging",
    fatal: testFatal,
  });

  // Run 2: checked new files in note
  try {
    handleCodeReviewerUnchangedNote({
      s,
      rv: {capped: {type: "turns", used: 22, limit: 22}, workDigest: "read: file1.mjs; read: file2.mjs"},
      prevNote: "1. Done — checked file1.mjs.\n",
      nextNote: "1. Done — checked file1.mjs and file2.mjs.\n",
      contScope,
      subject: "Phase 2 code review",
      step: "task_not_converging",
      fatal: testFatal,
    });
  } catch (e) {
    diedRun2 = true;
  }
  check("code_reviewer: session 2 with new findings/files does NOT stop; third session allowed",
    !diedRun2 && s.phase !== "escalated" && s.codeReviewUnchangedNoteStreak[contScope] === 1,
    {diedRun2, phase: s.phase, streak: s.codeReviewUnchangedNoteStreak[contScope]});
}

// ── 5. Source wiring checks ───────────────────────────────────────────────
{
  const autopilotSrc = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
  check("wire: autopilot has no plan-review stage multiplier (1x cap everywhere)",
    !autopilotSrc.includes("withPlanReviewStageCap") &&
    !autopilotSrc.includes("resolvePlanReviewMaxTurns") &&
    !autopilotSrc.includes("PLAN_REVIEW_STAGE_BUDGET_FACTOR") &&
    !autopilotSrc.includes("stageConfig"));

  check("wire: autopilot still imports the progress-aware review stop helper",
    autopilotSrc.includes("reviewSessionProgress") &&
    autopilotSrc.includes("readCarriedScratchReportText"));

  check("wire: plan review calls pass the config unchanged into withPlanReviewVerdictOnlyCap",
    (autopilotSrc.match(/withPlanReviewVerdictOnlyCap\(c,/g) ?? []).length >= 4);

  const configDoc = fs.readFileSync(path.join(here, "..", "docs", "configuration.md"), "utf8");
  check("docs: docs/configuration.md has no 1.5x plan-review stage budget",
    !configDoc.includes("1.5x") && !configDoc.includes("1.5×"));

  check("docs: docs/configuration.md plan_reviewer.max_turns keeps the generic per-role wording",
    configDoc.includes("Most model turns this role may use in one session; at the limit the role stops and hands off, then extra_sessions decides whether a new session may continue.") &&
    !configDoc.includes("Review-plan and review-tasks plan-review sessions get"));
}

if (failures) {
  console.error(`\n${failures} backlog-8 test(s) failed.`);
  process.exit(1);
}
console.log("\nbacklog-8 plan-reviewer 1x cap & progress-aware stop tests passed.");
