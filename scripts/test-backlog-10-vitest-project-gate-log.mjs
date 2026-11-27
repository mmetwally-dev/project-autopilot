#!/usr/bin/env node
// Test backlog item #10: vitest gate log parser with project labels and gate command visibility.

import { parseVitestGateLog, buildReportModel, renderCurrentRun } from "./watch-report.mjs";

const failures = [];
function check(name, ok, details = "") {
  if (ok) {
    console.log(`PASS ${name}`);
  } else {
    console.error(`FAIL ${name}: ${details}`);
    failures.push({ name, details });
  }
}

// ── 1. parseVitestGateLog with project labels ────────────────────────────────
{
  const log = [
    " ✓  jsdom  apps/web/src/ExemptionsReportView.table.test.tsx (21 tests) 3901ms",
    " ✓  |node|  apps/web/src/ServerReport.test.ts (15 tests) 1200ms",
    " ✓  | worker | apps/web/src/WorkerTask.test.ts (8 tests) 450ms",
    " ❯  jsdom  apps/web/src/BrokenView.test.tsx (3 tests | 3 failed) 56ms",
    " ↓  |node|  apps/web/src/SkippedService.test.ts (2 tests | 2 skipped)",
    " ✓  apps/web/src/NoProjectLabel.test.tsx (5 tests) 100ms",
  ].join("\n");

  const parsed = parseVitestGateLog(log);
  check("parsed is non-null for project-style log", parsed !== null, parsed);
  check("parsed done count is 6", parsed?.done === 6, parsed?.done);
  check("parsed passed count is 4", parsed?.passed === 4, parsed?.passed);
  check("parsed failed count is 1", parsed?.failed === 1, parsed?.failed);
  check("parsed skipped count is 1", parsed?.skipped === 1, parsed?.skipped);
  check("failedFiles includes BrokenView", parsed?.failedFiles?.includes("apps/web/src/BrokenView.test.tsx") === true, parsed?.failedFiles);
  check("lastFile is NoProjectLabel", parsed?.lastFile === "apps/web/src/NoProjectLabel.test.tsx", parsed?.lastFile);
  check("lastMark is ✓", parsed?.lastMark === "✓", parsed?.lastMark);
  check("lastTests is 5", parsed?.lastTests === 5, parsed?.lastTests);
}

// ── 2. Count files once per project+path (multi-project runs) ────────────────
{
  const logWithDuplicatesAndCrossProject = [
    // Same file in two different projects -> counted twice (once per project+path)
    " ✓  jsdom  apps/web/src/SharedUtil.test.ts (10 tests) 500ms",
    " ✓  node   apps/web/src/SharedUtil.test.ts (10 tests) 400ms",
    // Streaming duplicate of the exact same project+path -> counted once
    " ✓  jsdom  apps/web/src/SharedUtil.test.ts (10 tests) 500ms",
    // Same file without project label -> counted once
    " ✓  apps/web/src/Standalone.test.ts (4 tests) 100ms",
    " ✓  apps/web/src/Standalone.test.ts (4 tests) 100ms",
  ].join("\n");

  const parsed = parseVitestGateLog(logWithDuplicatesAndCrossProject);
  check("cross-project same file counted once per project (total 3 distinct files)", parsed?.done === 3, parsed?.done);
  check("passed count is 3", parsed?.passed === 3, parsed?.passed);
}

// ── 3. Running gate CURRENT RUN shows command: even when gate_start has command: null ──
{
  const gateLog = [
    " ✓  jsdom  apps/web/src/ExemptionsReportView.table.test.tsx (21 tests) 3901ms",
    " ❯  jsdom  apps/web/src/BrokenView.test.tsx (3 tests | 3 failed) 56ms",
  ].join("\n");

  // Case A: layout provides tests.commands
  const modelWithLayout = buildReportModel({
    state: { phase: "implementing", step: "gate", phaseIndex: 0, attempt: 1 },
    runs: [],
    phases: [{ number: 1, name: "Phase 1", done: false, tasks: [{ text: "T1" }] }],
    layout: { tests: { commands: ["npx vitest run"] } },
    events: [{ type: "gate_start", phase: 1, command: null, at: "2026-11-16T21:05:00+00:00" }],
    gateLog,
    now: "2026-11-16T21:06:00+00:00",
  });

  const textA = renderCurrentRun(modelWithLayout);
  check("case A: CURRENT RUN has command line", textA.includes("command:        npx vitest run"), textA);
  check("case A: CURRENT RUN has progress line", textA.includes("progress:       2 test files done · 1 passed · 1 failed · 0 skipped (total unknown yet)"), textA);
  check("case A: CURRENT RUN has failed file", textA.includes("failed: × apps/web/src/BrokenView.test.tsx"), textA);

  // Case B: no layout provided; command falls back to (orchestrator gate)
  const modelNoLayout = buildReportModel({
    state: { phase: "implementing", step: "gate", phaseIndex: 0, attempt: 1 },
    runs: [],
    phases: [{ number: 1, name: "Phase 1", done: false, tasks: [{ text: "T1" }] }],
    events: [{ type: "gate_start", phase: 1, command: null, at: "2026-11-16T21:05:00+00:00" }],
    gateLog,
    now: "2026-11-16T21:06:00+00:00",
  });

  const textB = renderCurrentRun(modelNoLayout);
  check("case B: CURRENT RUN shows fallback command line", textB.includes("command:        (orchestrator gate)"), textB);
  check("case B: CURRENT RUN has progress line", textB.includes("progress:       2 test files done · 1 passed · 1 failed · 0 skipped (total unknown yet)"), textB);
}

// ── 4. Backward compatibility: existing no-project-label vitest logs ─────────
{
  const traditionalLog = [
    " ✓ apps/web/src/First.test.tsx (10 tests) 100ms",
    " × apps/web/src/Second.test.tsx (2 tests | 1 failed) 200ms",
    " ↓ apps/web/src/Third.test.tsx (1 test)",
  ].join("\n");

  const parsed = parseVitestGateLog(traditionalLog);
  check("traditional log parsed done count is 3", parsed?.done === 3, parsed?.done);
  check("traditional log passed count is 1", parsed?.passed === 1, parsed?.passed);
  check("traditional log failed count is 1", parsed?.failed === 1, parsed?.failed);
  check("traditional log skipped count is 1", parsed?.skipped === 1, parsed?.skipped);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nAll backlog #10 checks passed.");
