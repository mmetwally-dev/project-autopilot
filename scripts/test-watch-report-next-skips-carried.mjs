#!/usr/bin/env node
// Regression tests for backlog #9:
// In a fix round, next: line counts carried-forward tasks.
//
// Verifies:
// 1. In round 1 (nothing carried), implementer on T1 shows next: T2 (+4 more tasks).
// 2. In a fix round where T2, T3, T5 are carried:
//    - implementer on T1 shows next: T4 (+1 more task) -> ...
//    - implementer on T4 shows next: T6 -> ... (no +N when next is last)
//    - implementer on T6 shows next: phase review -> ... (straight to review)
// 3. Full report rendering via buildReportModel and renderReport.

import { buildReportModel, nextStepsLine, renderReport } from "./watch-report.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`);
  }
};

const syntheticPhase = {
  number: 1,
  name: "Phase 1 — Synthetic Demo",
  done: false,
  tasks: [
    { text: "T1 Task one", done: false },
    { text: "T2 Task two", done: false },
    { text: "T3 Task three", done: false },
    { text: "T4 Task four", done: false },
    { text: "T5 Task five", done: false },
    { text: "T6 Task six", done: false },
  ],
};

// ── 1. Direct nextStepsLine checks ──────────────────────────────────────────
{
  // Round 1: nothing carried forward, implementer on T1
  const attemptRound1 = { number: 1, runs: [], carriedForward: [] };
  const modelRound1 = {
    stage: "IMPLEMENTATION",
    current: { kind: "run", role: "implementer", taskRef: "T1" },
  };
  const lineR1 = nextStepsLine(modelRound1, syntheticPhase, attemptRound1);
  check(
    "round 1: next line names T2 (+4 more tasks) when implementer is on T1",
    lineR1 === "next: T2 (+4 more tasks) → phase review → full test suite → phase verify",
    lineR1
  );

  // Fix round: T2, T3, T5 carried forward
  const attemptFixRound = {
    number: 2,
    runs: [],
    carriedForward: ["T2", "T3", "T5"],
  };

  // Implementer on T1: next is T4, 1 more (T6)
  const modelFixOnT1 = {
    stage: "IMPLEMENTATION",
    current: { kind: "run", role: "implementer", taskRef: "T1" },
  };
  const lineFixT1 = nextStepsLine(modelFixOnT1, syntheticPhase, attemptFixRound);
  check(
    "fix round on T1: skips carried T2, T3 and names next: T4 (+1 more task)",
    lineFixT1 === "next: T4 (+1 more task) → phase review → full test suite → phase verify",
    lineFixT1
  );

  // Implementer on T4: next is T6 (last task to run, no +N)
  const modelFixOnT4 = {
    stage: "IMPLEMENTATION",
    current: { kind: "run", role: "implementer", taskRef: "T4" },
  };
  const lineFixT4 = nextStepsLine(modelFixOnT4, syntheticPhase, attemptFixRound);
  check(
    "fix round on T4: skips carried T5 and names next: T6 without +N",
    lineFixT4 === "next: T6 → phase review → full test suite → phase verify",
    lineFixT4
  );

  // Implementer on T6: no tasks left to run, goes straight to phase review
  const modelFixOnT6 = {
    stage: "IMPLEMENTATION",
    current: { kind: "run", role: "implementer", taskRef: "T6" },
  };
  const lineFixT6 = nextStepsLine(modelFixOnT6, syntheticPhase, attemptFixRound);
  check(
    "fix round on T6: no tasks left to run, goes straight to phase review",
    lineFixT6 === "next: phase review → full test suite → phase verify",
    lineFixT6
  );
}

// ── 2. End-to-end report rendering via buildReportModel and renderReport ────
{
  const runs = [
    // Round 1 implementation
    { id: "01-impl", dirName: "01-implementer", role: "implementer", phase: "1", attempt: 1, taskRef: "T1", status: "completed", started_at: "2026-11-16T10:00:00Z" },
    { id: "02-rev", dirName: "02-code_reviewer", role: "code_reviewer", phase: "1", attempt: 1, status: "completed", decision: "FAIL", findings: ["fix T1, T4, T6"], started_at: "2026-11-16T10:10:00Z" },
    // Round 2 implementation running on T1, carrying T2, T3, T5
    { id: "03-impl", dirName: "03-implementer", role: "implementer", phase: "1", attempt: 2, taskRef: "T1", status: "running", carriedForwardTasks: ["T2", "T3", "T5"], started_at: "2026-11-16T10:15:00Z" },
  ];
  const state = {
    phase: "implementing",
    phaseIndex: 0,
    attempt: 2,
    mission: "001-demo",
  };

  const modelOnT1 = buildReportModel({ state, runs, events: [], phases: [syntheticPhase], policy: {} });
  const textOnT1 = renderReport(modelOnT1, { stamp: "2026-11-16T10:16:00Z" });
  check(
    "renderReport on T1 in fix round: output contains next: T4 (+1 more task)",
    textOnT1.includes("next: T4 (+1 more task) → phase review → full test suite → phase verify"),
    textOnT1.split("\n").find((l) => l.includes("next:"))
  );

  // Advance to T4
  runs[2] = { id: "03-impl", dirName: "03-implementer", role: "implementer", phase: "1", attempt: 2, taskRef: "T1", status: "completed", carriedForwardTasks: ["T2", "T3", "T5"], started_at: "2026-11-16T10:15:00Z" };
  runs.push({ id: "04-impl", dirName: "04-implementer", role: "implementer", phase: "1", attempt: 2, taskRef: "T4", status: "running", carriedForwardTasks: ["T2", "T3", "T5"], started_at: "2026-11-16T10:20:00Z" });

  const modelOnT4 = buildReportModel({ state, runs, events: [], phases: [syntheticPhase], policy: {} });
  const textOnT4 = renderReport(modelOnT4, { stamp: "2026-11-16T10:21:00Z" });
  check(
    "renderReport on T4 in fix round: output contains next: T6 → phase review",
    textOnT4.includes("next: T6 → phase review → full test suite → phase verify"),
    textOnT4.split("\n").find((l) => l.includes("next:"))
  );

  // Advance to T6
  runs[3] = { id: "04-impl", dirName: "04-implementer", role: "implementer", phase: "1", attempt: 2, taskRef: "T4", status: "completed", carriedForwardTasks: ["T2", "T3", "T5"], started_at: "2026-11-16T10:20:00Z" };
  runs.push({ id: "05-impl", dirName: "05-implementer", role: "implementer", phase: "1", attempt: 2, taskRef: "T6", status: "running", carriedForwardTasks: ["T2", "T3", "T5"], started_at: "2026-11-16T10:25:00Z" });

  const modelOnT6 = buildReportModel({ state, runs, events: [], phases: [syntheticPhase], policy: {} });
  const textOnT6 = renderReport(modelOnT6, { stamp: "2026-11-16T10:26:00Z" });
  check(
    "renderReport on T6 in fix round: output goes straight to phase review",
    textOnT6.includes("next: phase review → full test suite → phase verify"),
    textOnT6.split("\n").find((l) => l.includes("next:"))
  );
}

// ── 3. Fix round with reviewFindingTasks in state (before carriedForwardTasks filled) ──
{
  const stateWithFindingTasks = {
    phase: "implementing",
    phaseIndex: 0,
    attempt: 2,
    mission: "001-demo",
    reviewFindingTasks: {
      "standalone-phase:0": {
        allMapped: true,
        affected: ["T1", "T4", "T6"],
      },
    },
  };
  const attemptNoCarried = {
    number: 2,
    runs: [],
    carriedForward: [],
  };

  // Current implementer on T1 and NO carriedForwardTasks on any run yet -> "next: T4 (+1 more task) → ..."
  const modelOnT1 = {
    stage: "IMPLEMENTATION",
    state: stateWithFindingTasks,
    current: { kind: "run", role: "implementer", taskRef: "T1" },
  };
  const lineT1 = nextStepsLine(modelOnT1, syntheticPhase, attemptNoCarried);
  check(
    "reviewFindingTasks on T1 with no carriedForwardTasks yet: next is T4 (+1 more task)",
    lineT1 === "next: T4 (+1 more task) → phase review → full test suite → phase verify",
    lineT1
  );

  // On T4 -> "next: T6 → ..."
  const modelOnT4 = {
    stage: "IMPLEMENTATION",
    state: stateWithFindingTasks,
    current: { kind: "run", role: "implementer", taskRef: "T4" },
  };
  const lineT4 = nextStepsLine(modelOnT4, syntheticPhase, attemptNoCarried);
  check(
    "reviewFindingTasks on T4: next is T6 without (+N)",
    lineT4 === "next: T6 → phase review → full test suite → phase verify",
    lineT4
  );

  // allMapped false -> falls back to carried-set logic (empty carried -> shows T2 (+4 more tasks))
  const stateAllMappedFalse = {
    ...stateWithFindingTasks,
    reviewFindingTasks: {
      "standalone-phase:0": {
        allMapped: false,
        affected: ["T1", "T4", "T6"],
      },
    },
  };
  const modelAllMappedFalse = {
    stage: "IMPLEMENTATION",
    state: stateAllMappedFalse,
    current: { kind: "run", role: "implementer", taskRef: "T1" },
  };
  const lineFallback = nextStepsLine(modelAllMappedFalse, syntheticPhase, attemptNoCarried);
  check(
    "reviewFindingTasks with allMapped: false falls back to carried-set logic",
    lineFallback === "next: T2 (+4 more tasks) → phase review → full test suite → phase verify",
    lineFallback
  );

  // Also verify with stable IDs in affected (e.g. speckit-phase:0)
  const stateWithStableIds = {
    phase: "implementing",
    phaseIndex: 0,
    attempt: 2,
    mission: "001-demo",
    reviewFindingTasks: {
      "speckit-phase:0": {
        allMapped: true,
        affected: [
          "speckit:P1:T0:f175e7355501",
          "speckit:P1:T3:f175e7355502",
          "speckit:P1:T5:f175e7355503",
        ],
      },
    },
  };
  const modelStableT1 = {
    stage: "IMPLEMENTATION",
    state: stateWithStableIds,
    current: { kind: "run", role: "implementer", taskRef: "T1" },
  };
  const lineStableT1 = nextStepsLine(modelStableT1, syntheticPhase, attemptNoCarried);
  check(
    "reviewFindingTasks with stable IDs on T1: next is T4 (+1 more task)",
    lineStableT1 === "next: T4 (+1 more task) → phase review → full test suite → phase verify",
    lineStableT1
  );
}

if (failures.length) {
  console.error(`${failures.length} check(s) failed in test-watch-report-next-skips-carried.mjs`);
  process.exit(1);
}
console.log("All watch-report-next-skips-carried checks passed.");
