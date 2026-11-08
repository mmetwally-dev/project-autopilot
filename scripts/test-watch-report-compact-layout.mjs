#!/usr/bin/env node
// Test backlog #8: compact layout
// (a) normalizeRunTaskRef collapsing consecutive tasks, expanding A > B, keeping 2-task runs comma-separated,
//     keeping external refs at the end, and returning full range on full phase.
// (b) runs table header has DURATION before STARTED, and row duration values sit under DURATION.
// (c) renderCurrentRun gate and run variants: every label: value line and every continuation line
//     start their value at the exact same column index.

import {
  buildReportModel,
  normalizeRunTaskRef,
  renderCurrentRun,
  renderReport,
} from "./watch-report.mjs";

const failures = [];
function check(name, ok, extra) {
  if (ok) {
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.error(`FAIL ${name}`, extra !== undefined ? extra : "");
  }
}

// ── (a) normalizeRunTaskRef collapse cases ───────────────────────────────────
{
  // 1. SpecKit example from backlog:
  // Phase order [T022, T022.0, T022.0a, T022.1a, T022.2, T022.2a, T023, T024]
  // Input: `T024, T022, T022.0, T022.0a, T022.1a, T022.2, T022.2a`
  // Target: `T022 > T022.2a, T024`
  const speckitPhase = [
    "T022",
    "T022.0",
    "T022.0a",
    "T022.1a",
    "T022.2",
    "T022.2a",
    "T023",
    "T024",
  ];
  const speckitRun = "T024, T022, T022.0, T022.0a, T022.1a, T022.2, T022.2a";
  const res1 = normalizeRunTaskRef(speckitRun, speckitPhase);
  check("speckit collapse matches target", res1 === "T022 > T022.2a, T024", res1);

  // 2. A list with an existing `A > B` part expanded and collapsed:
  const phaseWithRange = ["T020", "T020.1", "T020.2", "T020.3", "T020.4", "T020.5", "T021", "T022"];
  const res2 = normalizeRunTaskRef("T020, T020.1 > T020.3, T022", phaseWithRange);
  check("existing A > B part expanded and collapsed", res2 === "T020 > T020.3, T022", res2);

  // 3. A 2-task run stays comma-separated:
  const phase4 = ["T1", "T2", "T3", "T4"];
  const res3 = normalizeRunTaskRef("T1, T2", phase4);
  check("2-task run stays comma-separated", res3 === "T1, T2", res3);

  // 4. Refs outside the phase list kept at the end in original order:
  const res4 = normalizeRunTaskRef("EXTRA1, T3, T1, T2, EXTRA2", phase4);
  check("refs outside phase list kept at end", res4 === "T1 > T3, EXTRA1, EXTRA2", res4);

  // 5. Standalone ids T1.1 … T1.5 partial:
  const standalone = ["T1.1", "T1.2", "T1.3", "T1.4", "T1.5"];
  const res5 = normalizeRunTaskRef("T1.1, T1.2, T1.3, T1.5", standalone);
  check("standalone partial collapses 3+ consecutive", res5 === "T1.1 > T1.3, T1.5", res5);

  // 6. Full phase -> full range:
  const res6a = normalizeRunTaskRef("T1.1, T1.2, T1.3, T1.4, T1.5", standalone);
  check("full phase comma list -> full range", res6a === "T1.1 > T1.5", res6a);
  const res6b = normalizeRunTaskRef("T1.5, T1.3, T1.4, T1.1, T1.2", standalone);
  check("full phase out-of-order -> full range", res6b === "T1.1 > T1.5", res6b);
  const res6c = normalizeRunTaskRef("T1.1 > T1.5", standalone);
  check("full phase A > B -> full range", res6c === "T1.1 > T1.5", res6c);
}

// ── (b) Runs table header and cell column order ──────────────────────────────
{
  const state = {
    mission: "008-table-order",
    phase: "implementing",
    step: "implement",
    phaseIndex: 0,
    attempt: 1,
  };
  const phases = [
    { number: 1, name: "Phase 1", done: false, tasks: [{ text: "T1.1", done: false }] },
  ];
  const runs = [
    {
      id: "01-implementer-t",
      dirName: "01-implementer-t",
      role: "implementer",
      phase: "1",
      attempt: "1",
      taskRef: "T1.1",
      status: "completed",
      duration: "00:04:12",
      priceWeighted: 12000,
      started_at: "2026-11-08T01:00:00+03:00",
    },
  ];
  const model = buildReportModel({ state, runs, events: [], phases, policy: {} });
  const report = renderReport(model, { stamp: "2026-11-08 01:05:00" });

  const headerLine = report.split("\n").find((l) => l.trim().startsWith("ROLE") && l.includes("DURATION"));
  check("table header found", Boolean(headerLine), report);

  const durHeaderIdx = headerLine.indexOf("DURATION");
  const startedHeaderIdx = headerLine.indexOf("STARTED");
  const tokensHeaderIdx = headerLine.indexOf("TOKENS");
  const noteHeaderIdx = headerLine.indexOf("NOTE");

  check("TOKENS before DURATION", tokensHeaderIdx < durHeaderIdx, { tokensHeaderIdx, durHeaderIdx });
  check("DURATION before STARTED", durHeaderIdx < startedHeaderIdx, { durHeaderIdx, startedHeaderIdx });
  check("STARTED before NOTE", startedHeaderIdx < noteHeaderIdx, { startedHeaderIdx, noteHeaderIdx });

  // Check row value sits under DURATION
  const rowLine = report.split("\n").find((l) => l.includes("01-implementer-t"));
  check("row line found", Boolean(rowLine), report);
  const rowDurationIdx = rowLine.indexOf("00:04:12");
  check(
    "row duration value starts at DURATION column header offset",
    rowDurationIdx === durHeaderIdx,
    { rowDurationIdx, durHeaderIdx, rowLine }
  );
}

// ── (c) renderCurrentRun gate and run variants column alignment ──────────────
{
  // 1. Gate variant
  const gateModel = {
    current: {
      kind: "gate",
      command: "npx vitest run",
      pid: 12345,
      startedAt: "2026-11-08T01:41:10+03:00",
      progress: {
        unit: "test files",
        done: 112,
        expectedTotal: 188,
        expectedLabel: "phase 10",
        passed: 110,
        failed: 1,
        skipped: 1,
        lastFile: "apps/web/src/a.test.tsx",
        lastMark: "PASS",
        lastTests: 12,
        failedFiles: ["apps/web/src/b.test.tsx"],
      },
    },
    phases: [{ number: 12, name: "Phase 12 — Feature", done: false, tasks: [] }],
    phaseIndex: 11,
    attempt: 2,
    now: "2026-11-08T01:41:13+03:00",
  };

  const gateOutput = renderCurrentRun(gateModel);
  const gateLines = gateOutput.split("\n").filter((l) => l && l !== "=== CURRENT RUN ===");

  // Determine value start offset from each line
  const gateOffsets = gateLines.map((line) => {
    if (line.startsWith(" ")) {
      // Continuation line: leading spaces determine the column
      const match = line.match(/^(\s+)\S/);
      return match ? match[1].length : -1;
    }
    // Label line: label ends at colon, followed by spaces until first non-space
    const match = line.match(/^[^:]+:\s+/);
    return match ? match[0].length : -1;
  });

  const expectedColumn = gateOffsets[0];
  check(
    "gate variant has lines and valid expectedColumn",
    gateLines.length >= 6 && expectedColumn > 0,
    { lineCount: gateLines.length, expectedColumn }
  );
  check(
    "gate variant every line starts value at identical column",
    gateOffsets.every((off) => off === expectedColumn),
    { gateOffsets, gateLines }
  );

  // 2. Run variant
  const runModel = {
    current: {
      id: "17-implementer-db4d1811",
      dirName: "17-implementer-db4d1811",
      role: "implementer",
      taskRef: "T2.3",
      model: "muse-spark-1.3",
      session: "session 1 of 6",
      pid: 81234,
      startedAt: "2026-09-29T01:41:55+03:00",
      updatedAt: "2026-09-29T01:48:22+03:00",
      usage: {
        priceWeighted: 52000,
        contextWindow: 500000,
        peakContext: 27300,
        turns: 9,
      },
    },
    phases: [{ number: 2, name: "Phase 2 — Build", done: false, tasks: [] }],
    phaseIndex: 1,
    attempt: 2,
    now: "2026-09-29T01:48:30+03:00",
  };

  const runOutput = renderCurrentRun(runModel);
  const runLines = runOutput.split("\n").filter((l) => l && l !== "=== CURRENT RUN ===");

  const runOffsets = runLines.map((line) => {
    if (line.startsWith(" ")) {
      const match = line.match(/^(\s+)\S/);
      return match ? match[1].length : -1;
    }
    const match = line.match(/^[^:]+:\s+/);
    return match ? match[0].length : -1;
  });

  check(
    "run variant has all expected lines",
    runLines.length >= 7,
    { lineCount: runLines.length, runLines }
  );
  check(
    "run variant column matches gate variant column",
    runOffsets[0] === expectedColumn,
    { runCol: runOffsets[0], expectedColumn }
  );
  check(
    "run variant every line starts value at identical column",
    runOffsets.every((off) => off === expectedColumn),
    { runOffsets, runLines }
  );
}

// ── Summary ──────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\n${failures.length} compact-layout check(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll compact-layout checks passed.");
}
