#!/usr/bin/env node
// Backlog #4: Review-role hand-off notes, continuation briefs, ap.* skills line,
// Checked-and-clear progress rule, and FAIL-with-findings instead of escalation.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  buildWrapUpPrompt,
  handoffBudgetReminder,
  reviewSessionProgress,
  extractCheckedAndClearSection,
  extractBlockingFindingsFromReviewNote,
  scratchHandoffNotePath,
  SCRATCH_HANDOFF_NOTE_DEFAULT_DIR,
} from "./per-task-budget.mjs";
import {
  readOnlyHandoffNoteReminder,
  buildTaskPrompt,
} from "./role-progress-prompt.mjs";
import {emptyRoleProgress} from "./phase-stage-checkpoint.mjs";
import {
  REVIEW_CONTINUATION_LINE,
  PLAN_REVIEW_CONFIRMATION_LINE,
  formatReviewBriefForContinuation,
} from "./plan-review-rounds.mjs";
import {
  REVIEWER_NO_AP_SKILLS_LINE,
  assembleReviewBriefForTests,
  readOnlyContinuationNoteForTests,
  handleCappedPlanReviewerWithoutVerdictForTests,
  handleCodeReviewerUnchangedNoteForTests,
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

// ── 1. Review-role note format vs implementer format unchanged ──────────────
{
  const planWrap = buildWrapUpPrompt("/workspace/scratch/speckit-plan_reviewer.md", 4000, {role: "plan_reviewer"});
  const codeWrap = buildWrapUpPrompt("/workspace/scratch/T1.md", 4000, {role: "code_reviewer"});
  const implWrap = buildWrapUpPrompt(".autopilot/missions/m1/handoff/T1.md", 4000);

  for (const [label, text] of [["plan_reviewer", planWrap], ["code_reviewer", codeWrap]]) {
    check(`wrap-up (${label}): has Checked and clear / Findings (final) / Remaining / Dead ends`,
      text.includes("1. Checked and clear — file:line ranges + topics reviewed and found OK.")
      && text.includes("2. Findings (final) — each BLOCKING/minor finding with file:line evidence.")
      && text.includes("3. Remaining — concrete files/sections still to review.")
      && text.includes("4. Dead ends")
      && !text.includes("1. Done — files changed"),
      text);
  }

  check("wrap-up (implementer): keeps Done / Found / Next / Dead ends unchanged",
    implWrap.includes("1. Done — files changed (names only).")
    && implWrap.includes("2. Found — facts the next session needs")
    && implWrap.includes("3. Next — the exact next edit")
    && implWrap.includes("4. Dead ends")
    && !implWrap.includes("Checked and clear"),
    implWrap);

  const planReminder = handoffBudgetReminder(30, {role: "plan_reviewer"});
  const codeReminder = handoffBudgetReminder(30, {role: "code_reviewer"});
  const implReminder = handoffBudgetReminder(30);

  check("budget reminder (plan_reviewer): uses review note sections",
    planReminder.includes("Checked and clear / Findings (final) / Remaining / Dead ends")
    && !planReminder.includes("Done / Found / Next / Dead ends"),
    planReminder);
  check("budget reminder (code_reviewer): uses review note sections",
    codeReminder.includes("Checked and clear / Findings (final) / Remaining / Dead ends")
    && !codeReminder.includes("Done / Found / Next / Dead ends"),
    codeReminder);
  check("budget reminder (implementer): keeps Done / Found / Next / Dead ends unchanged",
    implReminder.includes("Done / Found / Next / Dead ends")
    && !implReminder.includes("Checked and clear"),
    implReminder);

  const roMilestone = readOnlyHandoffNoteReminder({mission: "008-test", ref: "T1.1", noteLimit: 4000});
  check("readOnlyHandoffNoteReminder (code_reviewer / verifier / final review): uses review note format",
    roMilestone.includes("1. Checked and clear — file:line ranges + topics reviewed and found OK.")
    && roMilestone.includes("2. Findings (final) — each BLOCKING/minor finding with file:line evidence.")
    && roMilestone.includes("3. Remaining — concrete files/sections still to review.")
    && roMilestone.includes("4. Dead ends")
    && !roMilestone.includes("Done/Found/Next/Dead ends"),
    roMilestone);

  const implProgress = emptyRoleProgress();
  implProgress.implementer.status = "running";
  implProgress.implementer.currentTaskId = "standalone:P1:T0:aaaa";
  const implTaskPrompt = buildTaskPrompt({
    framework: "standalone",
    role: "implementer",
    mission: "008-test",
    phaseName: "Phase 1",
    revision: 1,
    phaseTaskDigest: "sha256:" + "d".repeat(64),
    currentTaskId: "standalone:P1:T0:aaaa",
    taskIds: ["standalone:P1:T0:aaaa"],
    tasks: [{id: "standalone:P1:T0:aaaa", text: "Edit src/a.mjs", file: "src/a.mjs", line: 10}],
    roleProgress: implProgress,
    handoffPerTaskMaxTurns: 30,
  });
  check("buildTaskPrompt (implementer): keeps Done/Found/Next/Dead ends unchanged",
    implTaskPrompt.ok
    && implTaskPrompt.text.includes("Done/Found/Next/Dead ends")
    && implTaskPrompt.text.includes("1. Done — files changed")
    && !implTaskPrompt.text.includes("Checked and clear"),
    implTaskPrompt.ok ? implTaskPrompt.text.slice(0, 600) : implTaskPrompt);

  const codeProgress = emptyRoleProgress();
  codeProgress.implementer.status = "complete";
  codeProgress.implementer.completedTaskIds = ["standalone:P1:T0:aaaa"];
  codeProgress.implementer.taskCursor = 1;
  codeProgress.codeReviewer.status = "running";
  codeProgress.codeReviewer.currentTaskId = "standalone:P1:T0:aaaa";
  const codeTaskPrompt = buildTaskPrompt({
    framework: "standalone",
    role: "codeReviewer",
    mission: "008-test",
    phaseName: "Phase 1",
    revision: 1,
    phaseTaskDigest: "sha256:" + "d".repeat(64),
    currentTaskId: "standalone:P1:T0:aaaa",
    taskIds: ["standalone:P1:T0:aaaa"],
    tasks: [{id: "standalone:P1:T0:aaaa", text: "Edit src/a.mjs", file: "src/a.mjs", line: 10}],
    roleProgress: codeProgress,
    deltaDigest: "sha256:" + "e".repeat(64),
    deltaChunks: [],
  });
  check("buildTaskPrompt (codeReviewer): uses review note format",
    codeTaskPrompt.ok
    && codeTaskPrompt.text.includes("1. Checked and clear")
    && codeTaskPrompt.text.includes("2. Findings (final)")
    && codeTaskPrompt.text.includes("3. Remaining")
    && !codeTaskPrompt.text.includes("Done/Found/Next/Dead ends"),
    codeTaskPrompt.ok ? codeTaskPrompt.text.slice(0, 600) : codeTaskPrompt);
}

// ── 2. Continuation brief: one note path + do-not-reopen / carry / Remaining ─
{
  const ref = "speckit-plan_reviewer";
  const expectedOnePath = scratchHandoffNotePath(`${SCRATCH_HANDOFF_NOTE_DEFAULT_DIR}/previous-session`, ref);
  const noteBody = [
    "1. Checked and clear — specs/008/plan.md:1-120 (routing + schema).",
    "2. Findings (final) — BLOCKING: src/service.ts:44 missing tenant check.",
    "3. Remaining — specs/008/tasks.md phase 3.",
    "4. Dead ends — none.",
  ].join("\n");

  const contBlock = readOnlyContinuationNoteForTests(noteBody, "/nonexistent-repo", "008-test", ref, "reviewer");
  check("continuation block: names the ONE carried note path",
    contBlock.includes(expectedOnePath)
    && contBlock.includes("read this one note path:"),
    contBlock);
  check("continuation block: instructs not to reopen Checked and clear, carry Findings, review only Remaining",
    contBlock.includes("do not reopen files/sections listed under Checked and clear")
    && contBlock.includes("carry the Findings without re-verifying them")
    && contBlock.includes("review only Remaining"),
    contBlock);

  const confirmationTask = [
    `Review the current artifact state at the SpecKit gate "review-plan" as a confirmation full review after a scoped re-review PASS. No previous findings are listed, so review the whole artifact again from scratch; do not limit this to earlier findings or recent changes.`,
    PLAN_REVIEW_CONFIRMATION_LINE,
    contBlock,
  ].join("\n\n");
  const formatted = formatReviewBriefForContinuation(confirmationTask);
  check("continuation brief: replaces from-scratch with REVIEW_CONTINUATION_LINE and preserves one path + rules",
    formatted.includes(REVIEW_CONTINUATION_LINE)
    && !formatted.includes("from scratch")
    && formatted.includes(expectedOnePath)
    && formatted.includes("do not reopen files/sections listed under Checked and clear")
    && formatted.includes("carry the Findings without re-verifying them")
    && formatted.includes("review only Remaining"),
    formatted);

  // Planner continuation block does not inject review-only wording
  const plannerCont = readOnlyContinuationNoteForTests("1. Done — plan.md", "/nonexistent-repo", "008-test", "speckit-planner", "planner");
  check("continuation block (planner): unchanged, no review-only Checked and clear rule",
    plannerCont.includes("Prior planner handoff note")
    && !plannerCont.includes("Checked and clear"),
    plannerCont);
}

// ── 3. ap.* line in review briefs ──────────────────────────────────────────
{
  const expectedLine = "You are the reviewer: do not load .agents/skills/ap.* skills and do not run `ap` (not available here).";
  check("REVIEWER_NO_AP_SKILLS_LINE matches exact wording",
    REVIEWER_NO_AP_SKILLS_LINE === expectedLine, REVIEWER_NO_AP_SKILLS_LINE);

  for (const roleName of ["plan_reviewer", "code_reviewer", "verifier"]) {
    const brief = assembleReviewBriefForTests({roleName, adapter: "claude", task: "Review the artifact."});
    check(`review brief (${roleName}): includes ap.* no-load / no-run line`,
      brief.includes(expectedLine), brief);
  }

  const autopilotSrc = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
  check("runRelay wiring: readOnly branch injects REVIEWER_NO_AP_SKILLS_LINE",
    autopilotSrc.includes("readOnly\n      ? REVIEWER_NO_AP_SKILLS_LINE\n      : null"),
    "missing REVIEWER_NO_AP_SKILLS_LINE in runRelay");
}

// ── 4. Progress rule: Checked-and-clear growth only (workDigest not progress) ─
{
  const noteS1 = [
    "1. Checked and clear",
    "- specs/008/plan.md:1-100 (API routes)",
    "- src/tenants/service.ts:1-80 (queries)",
    "2. Findings (final)",
    "- BLOCKING: src/tenants/service.ts:95 missing tenant scope",
    "3. Remaining",
    "- specs/008/tasks.md",
    "4. Dead ends",
    "- none",
  ].join("\n");

  const noteS2GrewNewFile = [
    "1. Checked and clear",
    "- specs/008/plan.md:1-100 (API routes)",
    "- src/tenants/service.ts:1-80 (queries)",
    "- prisma/schema.prisma:1-140 (models)",
    "2. Findings (final)",
    "- BLOCKING: src/tenants/service.ts:95 missing tenant scope",
    "3. Remaining",
    "- specs/008/tasks.md",
    "4. Dead ends",
    "- none",
  ].join("\n");

  const noteS2GrewNewRange = [
    "1. Checked and clear",
    "- specs/008/plan.md:1-100 (API routes)",
    "- specs/008/plan.md:101-220 (error handling)",
    "- src/tenants/service.ts:1-80 (queries)",
    "2. Findings (final)",
    "- BLOCKING: src/tenants/service.ts:95 missing tenant scope",
    "3. Remaining",
    "- specs/008/tasks.md",
    "4. Dead ends",
    "- none",
  ].join("\n");

  const noteS2SameCheckedDifferentDigest = [
    "1. Checked and clear",
    "- specs/008/plan.md:1-100 (API routes)",
    "- src/tenants/service.ts:1-80 (queries)",
    "2. Findings (final)",
    "- BLOCKING: src/tenants/service.ts:95 missing tenant scope",
    "3. Remaining",
    "- specs/008/tasks.md (re-listed)",
    "4. Dead ends",
    "- tried running ap plan-review",
  ].join("\n");

  check("extractCheckedAndClearSection parses items cleanly",
    extractCheckedAndClearSection(noteS1).present === true
    && extractCheckedAndClearSection(noteS1).items.length === 2,
    extractCheckedAndClearSection(noteS1));

  check("progress: Checked and clear grew with new file -> true (continue)",
    reviewSessionProgress(
      {reportText: "", noteText: noteS1, workDigest: "read: plan.md"},
      {reportText: "", noteText: noteS2GrewNewFile, workDigest: "read: plan.md; read: schema.prisma"}
    ) === true);

  check("progress: Checked and clear grew with new file:line range -> true (continue)",
    reviewSessionProgress(
      {reportText: "", noteText: noteS1, workDigest: "read: plan.md"},
      {reportText: "", noteText: noteS2GrewNewRange, workDigest: "read: plan.md"}
    ) === true);

  check("progress: Checked and clear unchanged despite different workDigest/Remaining/Dead ends -> false (stop)",
    reviewSessionProgress(
      {reportText: "", noteText: noteS1, workDigest: "read: plan.md"},
      {reportText: "", noteText: noteS2SameCheckedDifferentDigest, workDigest: "read: plan.md; read: route-inventory-check.ts; read: schema.prisma"}
    ) === false);
}

// ── 5. No-progress stop with BLOCKING findings -> FAIL verdict, not escalation ─
{
  const testFatal = (msg) => { throw new Error(msg); };
  const noteWithBlocking = [
    "1. Checked and clear",
    "- specs/008/plan.md:1-100 (routing)",
    "2. Findings (final)",
    "- BLOCKING: specs/008/plan.md:140 — tenant access guard omits suspended tenants; add status check.",
    "- MINOR: specs/008/plan.md:12 — typo in heading.",
    "3. Remaining",
    "- specs/008/tasks.md",
    "4. Dead ends",
    "- none",
  ].join("\n");

  const noteMinorOnly = [
    "1. Checked and clear",
    "- specs/008/plan.md:1-100 (routing)",
    "2. Findings (final)",
    "- MINOR: specs/008/plan.md:12 — typo in heading.",
    "3. Remaining",
    "- specs/008/tasks.md",
    "4. Dead ends",
    "- none",
  ].join("\n");

  const extracted = extractBlockingFindingsFromReviewNote(noteWithBlocking);
  check("extractBlockingFindingsFromReviewNote keeps BLOCKING and excludes MINOR",
    extracted.length === 1
    && extracted[0].includes("tenant access guard omits suspended tenants")
    && !extracted.some((f) => f.includes("typo")),
    extracted);

  check("extractBlockingFindingsFromReviewNote returns [] for MINOR-only note",
    extractBlockingFindingsFromReviewNote(noteMinorOnly).length === 0,
    extractBlockingFindingsFromReviewNote(noteMinorOnly));

  // 5a. Plan review — SpecKit: no-progress stop with BLOCKING findings -> FAIL verdict
  {
    const s = {mission: "008-speckit", framework: "speckit", planReviewCappedNoVerdict: {}, planReviewCappedArtifacts: {}};
    const contScope = "task:speckit:planning:plan_reviewer";
    const r1 = {capped: {type: "turns", used: 30, limit: 30}, workDigest: "read: plan.md"};
    handleCappedPlanReviewerWithoutVerdictForTests({
      s, framework: "speckit", result: r1, subject: "SpecKit gate review-plan plan reviewer",
      contScope, taskRef: "speckit-plan_reviewer", mission: "008-speckit",
      noteText: noteWithBlocking, fatal: testFatal,
    });
    const r2 = {capped: {type: "turns", used: 30, limit: 30}, workDigest: "read: plan.md; read: service.ts"};
    let died = false;
    let outcome = null;
    try {
      outcome = handleCappedPlanReviewerWithoutVerdictForTests({
        s, framework: "speckit", result: r2, subject: "SpecKit gate review-plan plan reviewer",
        contScope, taskRef: "speckit-plan_reviewer", mission: "008-speckit",
        noteText: noteWithBlocking, fatal: testFatal,
      });
    } catch { died = true; }
    check("plan_reviewer (SpecKit): no-progress stop with BLOCKING findings returns FAIL verdict, no escalation",
      !died
      && outcome?.convertedToFail === true
      && s.phase !== "escalated"
      && r2.capped === undefined
      && r2.status === "completed"
      && r2.review?.decision === "FAIL"
      && Array.isArray(r2.review?.findings)
      && r2.review.findings.length === 1
      && r2.review.findings[0].includes("tenant access guard omits suspended tenants"),
      {died, outcome, phase: s.phase, r2});
  }

  // 5b. Plan review — Standalone: no-progress stop with BLOCKING findings -> FAIL verdict
  {
    const s = {mission: "008-standalone", framework: "standalone", planReviewCappedNoVerdict: {}, planReviewCappedArtifacts: {}};
    const contScope = "task:standalone:planning:plan_reviewer";
    const r1 = {capped: {type: "turns", used: 30, limit: 30}, workDigest: "read: PLAN.md"};
    handleCappedPlanReviewerWithoutVerdictForTests({
      s, framework: "standalone", result: r1, subject: "Plan reviewer",
      contScope, taskRef: "standalone-planning-plan_reviewer", mission: "008-standalone",
      noteText: noteWithBlocking, fatal: testFatal,
    });
    const r2 = {capped: {type: "turns", used: 30, limit: 30}, workDigest: "read: PLAN.md; read: TASKS.md"};
    let died = false;
    let outcome = null;
    try {
      outcome = handleCappedPlanReviewerWithoutVerdictForTests({
        s, framework: "standalone", result: r2, subject: "Plan reviewer",
        contScope, taskRef: "standalone-planning-plan_reviewer", mission: "008-standalone",
        noteText: noteWithBlocking, fatal: testFatal,
      });
    } catch { died = true; }
    check("plan_reviewer (standalone): no-progress stop with BLOCKING findings returns FAIL verdict, no escalation",
      !died
      && outcome?.convertedToFail === true
      && s.phase !== "escalated"
      && r2.capped === undefined
      && r2.status === "completed"
      && r2.review?.decision === "FAIL"
      && r2.review.findings.length === 1
      && r2.review.findings[0].includes("tenant access guard omits suspended tenants"),
      {died, outcome, phase: s.phase, r2});
  }

  // 5c. Plan review with NO blocking findings -> keeps escalation (PLAN_REVIEW_CAPPED_TWICE)
  {
    const s = {mission: "008-no-findings", framework: "speckit", planReviewCappedNoVerdict: {}, planReviewCappedArtifacts: {}};
    const contScope = "task:speckit:planning:plan_reviewer";
    handleCappedPlanReviewerWithoutVerdictForTests({
      s, framework: "speckit", result: {capped: {type: "turns", used: 30, limit: 30}},
      subject: "SpecKit gate review-plan plan reviewer", contScope, taskRef: "speckit-plan_reviewer",
      mission: "008-no-findings", noteText: noteMinorOnly, fatal: testFatal,
    });
    let died = false;
    try {
      handleCappedPlanReviewerWithoutVerdictForTests({
        s, framework: "speckit", result: {capped: {type: "turns", used: 30, limit: 30}},
        subject: "SpecKit gate review-plan plan reviewer", contScope, taskRef: "speckit-plan_reviewer",
        mission: "008-no-findings", noteText: noteMinorOnly, fatal: testFatal,
      });
    } catch { died = true; }
    check("plan_reviewer: no-progress stop with no BLOCKING findings keeps PLAN_REVIEW_CAPPED_TWICE escalation",
      died && s.phase === "escalated" && s.phaseCheckpointError?.code === "PLAN_REVIEW_CAPPED_TWICE",
      {died, phase: s.phase, err: s.phaseCheckpointError});
  }

  // 5d. Code review: no-progress stop with BLOCKING findings -> FAIL verdict, not escalation
  {
    const s = {codeReviewUnchangedNoteStreak: {}, codeReviewCappedArtifacts: {}};
    const contScope = "task:speckit:phase-0:code_reviewer";
    handleCodeReviewerUnchangedNoteForTests({
      s, rv: {capped: {type: "turns", used: 22, limit: 22}, workDigest: "read: a.ts"},
      prevNote: noteWithBlocking, nextNote: noteWithBlocking,
      contScope, subject: "SpecKit code review", step: "speckit_task_not_converging",
      fatal: testFatal,
    });
    const rv2 = {capped: {type: "turns", used: 22, limit: 22}, workDigest: "read: a.ts; read: b.ts"};
    let died = false;
    let outcome = null;
    try {
      outcome = handleCodeReviewerUnchangedNoteForTests({
        s, rv: rv2, prevNote: noteWithBlocking, nextNote: noteWithBlocking,
        contScope, subject: "SpecKit code review", step: "speckit_task_not_converging",
        fatal: testFatal,
      });
    } catch { died = true; }
    check("code_reviewer: no-progress stop with BLOCKING findings returns FAIL verdict, no escalation",
      !died
      && outcome?.convertedToFail === true
      && s.phase !== "escalated"
      && rv2.capped === undefined
      && rv2.status === "completed"
      && rv2.review?.decision === "FAIL"
      && rv2.review.findings.length === 1
      && rv2.review.findings[0].includes("tenant access guard omits suspended tenants"),
      {died, outcome, phase: s.phase, rv2});
  }

  // 5e. Code review with NO blocking findings -> keeps escalation (CODE_REVIEW_CAPPED_TWICE)
  {
    const s = {codeReviewUnchangedNoteStreak: {}, codeReviewCappedArtifacts: {}};
    const contScope = "task:standalone:phase-0:code_reviewer";
    handleCodeReviewerUnchangedNoteForTests({
      s, rv: {capped: {type: "turns", used: 22, limit: 22}},
      prevNote: noteMinorOnly, nextNote: noteMinorOnly,
      contScope, subject: "Standalone code review", step: "standalone_task_not_converging",
      fatal: testFatal,
    });
    let died = false;
    try {
      handleCodeReviewerUnchangedNoteForTests({
        s, rv: {capped: {type: "turns", used: 22, limit: 22}},
        prevNote: noteMinorOnly, nextNote: noteMinorOnly,
        contScope, subject: "Standalone code review", step: "standalone_task_not_converging",
        fatal: testFatal,
      });
    } catch { died = true; }
    check("code_reviewer: no-progress stop with no BLOCKING findings keeps CODE_REVIEW_CAPPED_TWICE escalation",
      died && s.phase === "escalated" && s.phaseCheckpointError?.code === "CODE_REVIEW_CAPPED_TWICE",
      {died, phase: s.phase, err: s.phaseCheckpointError});
  }
}

if (failures) {
  console.error(`${failures} backlog-4 review-handoff check(s) failed.`);
  process.exit(1);
}
console.log("backlog-4 review-handoff tests passed");
