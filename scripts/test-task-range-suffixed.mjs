#!/usr/bin/env node
// Regression tests for backlog #8:
// Phase-wide run's TASK range breaks on letter-suffixed tasks and is shown out of order.

import { taskRefRange, allPhaseTaskRef } from "./role-progress-prompt.mjs";
import {
  buildReportModel,
  normalizeRunTaskRef,
  phaseTaskRefs,
  renderReport,
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

// ── Synthetic phase with letter suffixes: T1, T2, T3a, T3b, T4, T5 ──────────
const all = ["T1", "T2", "T3a", "T3b", "T4", "T5"];

// (a) taskRefRange over all of them in plan order -> "T1 > T5"
{
  const res = taskRefRange(all, all);
  check("taskRefRange over all suffixed tasks in plan order yields single range", res === "T1 > T5", res);
}

// (b) normalizeRunTaskRef over old fragmented record covering the whole phase -> "T1 > T5"
{
  const oldRecord = "T1 > T2, T3a, T3b, T4 > T5";
  const res = normalizeRunTaskRef(oldRecord, all);
  check("normalizeRunTaskRef collapses fragmented full-phase record to single range", res === "T1 > T5", res);
}

// (c) Partial set stays in plan order with gaps listed
{
  const partial = ["T1", "T3a", "T5"];
  const resRange = taskRefRange(partial, all);
  check("taskRefRange: partial set with gaps stays listed", resRange === "T1, T3a, T5", resRange);

  const resNorm = normalizeRunTaskRef("T1, T3a, T5", all);
  check("normalizeRunTaskRef: partial set with gaps stays listed in plan order", resNorm === "T1, T3a, T5", resNorm);

  const outOfOrder = normalizeRunTaskRef("T5, T1, T3a", all);
  check("normalizeRunTaskRef: out-of-order partial set sorted in plan order", outOfOrder === "T1, T3a, T5", outOfOrder);

  const partialRun = normalizeRunTaskRef("T1, T2, T3a, T5", all);
  check("normalizeRunTaskRef: partial contiguous run collapses and lists gap", partialRun === "T1 > T3a, T5", partialRun);
}

// (d) allPhaseTaskRef with synthetic phase containing suffixed tasks
{
  const phaseTasks = [
    { text: "T1 First task" },
    { text: "T2 Second task" },
    { text: "T3a Third task a" },
    { text: "T3b Third task b" },
    { text: "T4 Fourth task" },
    { text: "T5 Fifth task" },
  ];
  const res = allPhaseTaskRef(phaseTasks);
  check("allPhaseTaskRef yields compact range for suffixed phase tasks", res === "T1 > T5", res);
}

// (e) Existing behavior without suffixes unchanged
{
  check("single ref unchanged", taskRefRange(["T2.1"]) === "T2.1");
  check("dotted plan range unchanged", taskRefRange(["T1.1", "T1.2", "T1.3"]) === "T1.1 > T1.3");
  check("dotted plan gap unchanged", taskRefRange(["T1.1", "T1.3"]) === "T1.1, T1.3");
  check("dotted plan with gap and run unchanged", taskRefRange(["T1.1", "T1.2", "T1.4"]) === "T1.1 > T1.2, T1.4");
  check("owned ids unchanged", taskRefRange(["T001", "T002", "T004"]) === "T001 > T002, T004");
  check("owned ids consecutive unchanged", taskRefRange(["T009", "T010"]) === "T009 > T010");
  check("empty returns null", taskRefRange([]) === null);
  check("null returns null", taskRefRange(null) === null);
}

// (f) Incomplete allRefs preserves recorded order (does not split phase-first/non-phase-last)
{
  const resIncomplete = normalizeRunTaskRef("T1 > T2, T3a, T3b, T4 > T5", ["T5"]);
  check(
    "normalizeRunTaskRef keeps recorded order when allRefs is incomplete",
    resIncomplete === "T1 > T2, T3a, T3b, T4 > T5",
    resIncomplete
  );

  // A phase with no tasks list, one implementer run "T5" and a verifier run whose taskRef is "T1 > T2, T3a, T3b, T4 > T5"
  const phaseNoTasks = {
    number: 1,
    name: "Phase 1 — Empty Task Descriptor",
    tasks: [],
    runs: [
      {
        id: "01-impl",
        dirName: "01-implementer",
        role: "implementer",
        phase: 1,
        taskRef: "T5",
        status: "completed",
        started_at: "2026-11-16T10:00:00Z",
      },
      {
        id: "02-verif",
        dirName: "02-verifier",
        role: "verifier",
        phase: 1,
        taskRef: "T1 > T2, T3a, T3b, T4 > T5",
        status: "completed",
        decision: "PASS",
        started_at: "2026-11-16T10:10:00Z",
      },
    ],
  };

  const model = buildReportModel({
    state: { phase: "passed", phaseIndex: 0, mission: "demo-empty-tasks" },
    runs: phaseNoTasks.runs,
    phases: [phaseNoTasks],
  });
  const rendered = renderReport(model, { stamp: "2026-11-16T10:15:00Z" });
  check(
    "phase with no tasks list: verifier TASK cell keeps recorded order (never T5, ...)",
    rendered.includes("T1 > T2, T3a, T3b, T4 > T5") && !rendered.includes("T5, T1"),
    rendered
  );
}

// (g) phaseTaskRefs fallback: natural task order, unparsed after parsed in start-time order
{
  const phaseWithUnsortedRuns = {
    number: 1,
    name: "Phase 1",
    tasks: [],
    runs: [
      { role: "implementer", taskRef: "T038", started_at: "2026-11-16T10:00:00Z" },
      { role: "implementer", taskRef: "T029", started_at: "2026-11-16T10:05:00Z" },
      { role: "implementer", taskRef: "T036b", started_at: "2026-11-16T10:10:00Z" },
      { role: "implementer", taskRef: "T035", started_at: "2026-11-16T10:15:00Z" },
      { role: "implementer", taskRef: "T036a", started_at: "2026-11-16T10:20:00Z" },
      { role: "implementer", taskRef: "T037", started_at: "2026-11-16T10:25:00Z" },
      { role: "implementer", taskRef: "T3.10", started_at: "2026-11-16T10:30:00Z" },
      { role: "implementer", taskRef: "T3.2", started_at: "2026-11-16T10:35:00Z" },
      { role: "implementer", taskRef: "unparsed-setup", started_at: "2026-11-16T10:40:00Z" },
      { role: "implementer", taskRef: "unparsed-teardown", started_at: "2026-11-16T10:45:00Z" },
    ],
  };

  const refs = phaseTaskRefs(phaseWithUnsortedRuns);
  const expected = [
    "T3.2",
    "T3.10",
    "T029",
    "T035",
    "T036a",
    "T036b",
    "T037",
    "T038",
    "unparsed-setup",
    "unparsed-teardown",
  ];
  check(
    "phaseTaskRefs fallback: orders run refs by natural task order and unparsed by start time",
    JSON.stringify(refs) === JSON.stringify(expected),
    refs
  );
}

if (failures.length) {
  console.error(`${failures.length} check(s) failed in test-task-range-suffixed.mjs`);
  process.exit(1);
}
console.log("All task-range-suffixed checks passed.");
