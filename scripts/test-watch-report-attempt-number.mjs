#!/usr/bin/env node
// Backlog #9: WATCH-REPORT attempt number consistency.
// The table's attempt number (review/verify cycles of the phase) must be shown
// in the phase header and in the CURRENT RUN stage line, and budget resets must
// appear next to the budget they belong to, not as "attempt N (limit L, reset by operator)".
import {
  buildReportModel,
  renderReport,
  renderImplementationStage,
  renderCurrentRun,
  currentStageText,
} from "./watch-report.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`);
  }
};

const run = (o) => ({ status: "completed", decision: null, findings: [], ...o });

// ── 1. Phase with 6 attempt groups, state.attempt=11, and operator budget reset ─
{
  const phases = [
    { number: 1, name: "Phase 1 — Core work", done: false, tasks: [{ text: "T1.1", done: false }] },
  ];

  // 6 attempt groups: attempts 1-5 DENIED by verifier, attempt 6 running
  const runs = [
    run({ id: "01-impl", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", started_at: "2026-11-08T01:00:00+03:00", duration: "00:01:00" }),
    run({ id: "02-verif", role: "verifier", phase: "1", attempt: "1", taskRef: "T1.1", decision: "FAIL", started_at: "2026-11-08T01:02:00+03:00", duration: "00:01:00" }),

    run({ id: "03-impl", role: "implementer", phase: "1", attempt: "2", taskRef: "T1.1", started_at: "2026-11-08T01:04:00+03:00", duration: "00:01:00" }),
    run({ id: "04-verif", role: "verifier", phase: "1", attempt: "2", taskRef: "T1.1", decision: "FAIL", started_at: "2026-11-08T01:06:00+03:00", duration: "00:01:00" }),

    run({ id: "05-impl", role: "implementer", phase: "1", attempt: "3", taskRef: "T1.1", started_at: "2026-11-08T01:08:00+03:00", duration: "00:01:00" }),
    run({ id: "06-verif", role: "verifier", phase: "1", attempt: "3", taskRef: "T1.1", decision: "FAIL", started_at: "2026-11-08T01:10:00+03:00", duration: "00:01:00" }),

    run({ id: "07-impl", role: "implementer", phase: "1", attempt: "4", taskRef: "T1.1", started_at: "2026-11-08T01:12:00+03:00", duration: "00:01:00" }),
    run({ id: "08-verif", role: "verifier", phase: "1", attempt: "4", taskRef: "T1.1", decision: "FAIL", started_at: "2026-11-08T01:14:00+03:00", duration: "00:01:00" }),

    run({ id: "09-impl", role: "implementer", phase: "1", attempt: "5", taskRef: "T1.1", started_at: "2026-11-08T01:16:00+03:00", duration: "00:01:00" }),
    run({ id: "10-verif", role: "verifier", phase: "1", attempt: "5", taskRef: "T1.1", decision: "FAIL", started_at: "2026-11-08T01:18:00+03:00", duration: "00:01:00" }),

    run({ id: "11-impl", role: "implementer", phase: "1", attempt: "11", taskRef: "T1.1", status: "running", started_at: "2026-11-08T01:20:00+03:00" }),
  ];

  const state = {
    mission: "attempt-number-fix",
    phase: "implementing",
    step: "implement",
    phaseIndex: 0,
    attempt: 11, // recorded counter from implementer relaunches / restarts
    failureBudgets: { implementationFailureBudget: 5, verificationFailureBudget: 5 },
  };

  const events = [
    { type: "operator", reason: "reset", scope: "failure-budget", key: "implementationFailureBudget", at: "2026-11-08T01:15:00+03:00" },
    { type: "operator", reason: "reset", scope: "failure-budget", key: "verificationFailureBudget", at: "2026-11-08T01:15:00+03:00" },
  ];

  const policy = {
    failure_budgets: { implementationFailureBudget: 4, verificationFailureBudget: 4 },
  };

  const model = buildReportModel({ state, runs, events, phases, policy, now: "2026-11-08T01:21:00+03:00" });
  const report = renderReport(model, { stamp: "2026-11-08 01:21:00" });
  const impl = renderImplementationStage(model);
  const current = renderCurrentRun(model);

  // Model attempt matches the table attempt count (6 groups)
  check("model attempt is 6", model.attempt === 6, model.attempt);

  // Phase header shows attempt 6 without "of 5" (and not attempt 11)
  const phaseHeaderLine = impl.split("\n").find((l) => l.includes("Phase 1/1"));
  check("header shows attempt 6 without of 5", phaseHeaderLine && phaseHeaderLine.includes("● IN PROGRESS (attempt 6) ·") && !phaseHeaderLine.includes("of 5"), phaseHeaderLine);
  check("header does not show attempt 11", phaseHeaderLine && !phaseHeaderLine.includes("attempt 11"), phaseHeaderLine);

  // CURRENT RUN stage line shows attempt 6
  const stageHelper = currentStageText(model);
  check("currentStageText shows attempt 6", stageHelper === "IMPLEMENTATION · Phase 1/1 · attempt 6", stageHelper);
  const currentStageLine = current.split("\n").find((l) => l.startsWith("stage:"));
  check("CURRENT RUN stage line shows attempt 6", currentStageLine && currentStageLine.includes("IMPLEMENTATION · Phase 1/1 · attempt 6"), currentStageLine);

  // Pipeline stage line shows attempt 6 without "of 5"
  const pipelineStageLine = report.split("\n").find((l) => l.startsWith("Stage:"));
  check("pipeline Stage line shows attempt 6 without of 5", pipelineStageLine && pipelineStageLine.includes("attempt 6") && !pipelineStageLine.includes("of 5"), pipelineStageLine);

  // No "limit 5" text next to the attempt
  check("no limit 5 text next to attempt in header", phaseHeaderLine && !phaseHeaderLine.includes("limit 5"), phaseHeaderLine);
  check("no limit 5 text in currentStageText", !stageHelper.includes("limit 5"), stageHelper);
  check("no 'limit 5, reset by operator' in report next to attempt", !report.includes("attempt 11 (limit 5") && !report.includes("attempt 6 (limit 5"), report);

  // The budget line still shows the reset
  const retriesLine = report.split("\n").find((l) => l.startsWith("Retries:"));
  check("budget line still shows reset", retriesLine && retriesLine.includes("implementation=5 (limit 4, reset by operator)"), retriesLine);

  // Attempt header shows reset with the budget it belongs to
  const attempt6Line = impl.split("\n").find((l) => l.includes("Attempt 6"));
  check("attempt 6 header shows budget with reset", attempt6Line && attempt6Line.includes("verification budget 5/4 (reset by operator)"), attempt6Line);
}

// ── 2. Phase without resets keeps its normal text ───────────────────────────
{
  const phases = [
    { number: 1, name: "Phase 1 — Normal", done: false, tasks: [{ text: "T1.1", done: false }] },
  ];

  const runs = [
    run({ id: "01-impl", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", started_at: "2026-11-08T02:00:00+03:00", duration: "00:01:00" }),
    run({ id: "02-verif", role: "verifier", phase: "1", attempt: "1", taskRef: "T1.1", decision: "FAIL", started_at: "2026-11-08T02:02:00+03:00", duration: "00:01:00" }),
    run({ id: "03-impl", role: "implementer", phase: "1", attempt: "2", taskRef: "T1.1", status: "running", started_at: "2026-11-08T02:04:00+03:00" }),
  ];

  const state = {
    mission: "normal-phase",
    phase: "implementing",
    step: "implement",
    phaseIndex: 0,
    attempt: 2,
    failureBudgets: { implementationFailureBudget: 1, verificationFailureBudget: 1 },
  };

  const policy = {
    failure_budgets: { implementationFailureBudget: 4, verificationFailureBudget: 4 },
  };

  const model = buildReportModel({ state, runs, events: [], phases, policy, now: "2026-11-08T02:05:00+03:00" });
  const report = renderReport(model, { stamp: "2026-11-08 02:05:00" });
  const impl = renderImplementationStage(model);
  const current = renderCurrentRun(model);

  check("normal model attempt is 2", model.attempt === 2, model.attempt);

  const phaseHeaderLine = impl.split("\n").find((l) => l.includes("Phase 1/1"));
  check("normal header shows attempt 2 of 5", phaseHeaderLine && phaseHeaderLine.includes("● IN PROGRESS (attempt 2 of 5)"), phaseHeaderLine);

  const stageHelper = currentStageText(model);
  check("normal currentStageText shows attempt 2", stageHelper === "IMPLEMENTATION · Phase 1/1 · attempt 2", stageHelper);

  const currentStageLine = current.split("\n").find((l) => l.startsWith("stage:"));
  check("normal CURRENT RUN stage shows attempt 2", currentStageLine && currentStageLine.includes("IMPLEMENTATION · Phase 1/1 · attempt 2"), currentStageLine);

  const retriesLine = report.split("\n").find((l) => l.startsWith("Retries:"));
  check("normal budget line shows 1/4 without reset text", retriesLine && retriesLine.includes("implementation=1/4") && !retriesLine.includes("reset by operator"), retriesLine);

  check("no reset text anywhere in normal report", !report.includes("reset by operator"), report);
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
} else {
  console.log("\nAll watch-report attempt number checks passed.");
}
