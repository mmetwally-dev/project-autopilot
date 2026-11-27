#!/usr/bin/env node
// Backlog wr6: keep the WATCH-REPORT TASK column compact by formatting
// cross-phase-file refs, non-consecutive multi-task review lists, SpecKit
// internal task ids, and capping any remaining long TASK cell at 32 chars.
import { buildReportModel, renderReport } from "./watch-report.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
};

const run = (o) => ({ status: "completed", decision: null, findings: [], ...o });

const phase6Tasks = [
  "T063", "T064", "T064a", "T064b", "T065", "T066", "T066a", "T067", "T068", "T068b", "T069", "T070",
  "T077", "T078", "T081", "T082", "T083", "T083a", "T084", "T085", "T086",
].map((id) => ({ text: `${id} implement feature`, done: true }));

const phases = [
  { number: 6, name: "Phase 6 — API", done: false, tasks: phase6Tasks },
  { number: 7, name: "Phase 7 — Range", done: false, tasks: [{ text: "T113 wire", done: true }, { text: "T114 test", done: true }] },
];

const runs = [
  // (A) cross-phase-file implementer run
  run({
    id: "01-implementer-aaaaaaaa", dirName: "01-implementer-aaaaaaaa",
    role: "implementer", phase: "6", attempt: "1",
    taskRef: "cross-phase-file:apps/web/src/app/api/v1/users/[id]/put.test.ts",
    resolvedModel: "muse-spark-1.3", duration: "00:01:00", started_at: "2026-10-26T09:00:00+00:00",
  }),
  // (B) 5 non-consecutive tasks
  run({
    id: "02-code_reviewer-bbbbbbbb", dirName: "02-code_reviewer-bbbbbbbb",
    role: "code_reviewer", phase: "6", attempt: "1",
    taskRef: "T077, T081, T083, T084, T086",
    decision: "PASS", resolvedModel: "opus-5.5", duration: "00:01:00", started_at: "2026-10-26T09:05:00+00:00",
  }),
  // (B) 7 non-consecutive tasks
  run({
    id: "03-verifier-cccccccc", dirName: "03-verifier-cccccccc",
    role: "verifier", phase: "6", attempt: "1",
    taskRef: "T063, T064a, T065, T066a, T067, T068b, T069",
    decision: "FAIL", resolvedModel: "nemotron-3", duration: "00:01:00", started_at: "2026-10-26T09:10:00+00:00",
  }),
  // (C) SpecKit internal id mapped through phase 6 task list (ordinal 7 -> T067)
  run({
    id: "04-implementer-dddddddd", dirName: "04-implementer-dddddddd",
    role: "implementer", phase: "6", attempt: "2",
    taskRef: "speckit:P6:T7:333fe007b95b",
    resolvedModel: "muse-spark-1.3", duration: "00:01:00", started_at: "2026-10-26T09:15:00+00:00",
  }),
  // Unchanged: single task, 2-task list, consecutive range
  run({
    id: "05-implementer-eeeeeeee", dirName: "05-implementer-eeeeeeee",
    role: "implementer", phase: "6", attempt: "2",
    taskRef: "T113",
    resolvedModel: "muse-spark-1.3", duration: "00:01:00", started_at: "2026-10-26T09:20:00+00:00",
  }),
  run({
    id: "06-verifier-11111111", dirName: "06-verifier-11111111",
    role: "verifier", phase: "6", attempt: "2",
    taskRef: "T077, T081",
    decision: "PASS", resolvedModel: "nemotron-3", duration: "00:01:00", started_at: "2026-10-26T09:25:00+00:00",
  }),
  run({
    id: "07-code_reviewer-ffffffff", dirName: "07-code_reviewer-ffffffff",
    role: "code_reviewer", phase: "7", attempt: "1",
    taskRef: "T113 > T114",
    decision: "PASS", resolvedModel: "opus-5.5", duration: "00:01:00", started_at: "2026-10-26T09:30:00+00:00",
  }),
  // (C) SpecKit internal id with no phase task at ordinal 9 -> P7 T9 fallback
  run({
    id: "08-implementer-22222222", dirName: "08-implementer-22222222",
    role: "implementer", phase: "7", attempt: "1",
    taskRef: "speckit:P7:T9:deadbeef1234",
    resolvedModel: "muse-spark-1.3", duration: "00:01:00", started_at: "2026-10-26T09:35:00+00:00",
  }),
  // (C) SpecKit internal id whose phase number is not in model.phases while a different current phase exists -> P9 T0
  run({
    id: "09-implementer-33333333", dirName: "09-implementer-33333333",
    role: "implementer", phase: "6", attempt: "2",
    taskRef: "speckit:P9:T0:cafebabe5678",
    resolvedModel: "muse-spark-1.3", duration: "00:01:00", started_at: "2026-10-26T09:38:00+00:00",
  }),
];

const state = {
  mission: "wr6-task-width", phase: "implementing", step: "implement", phaseIndex: 1, attempt: 1,
  planningStartedAt: "2026-10-26T08:55:00+00:00", planningDetection: { framework: "speckit" },
};

const model = buildReportModel({ state, runs, events: [], phases, policy: {}, now: "2026-10-26T09:40:00+00:00" });
const report = renderReport(model, { stamp: "2026-10-26 09:40:00" });
const lines = report.split("\n");

const header = lines.find((line) => line.trim().startsWith("ROLE") && line.includes("TASK") && line.includes("STATUS"));
check("report has table header", Boolean(header), report);

const taskWidth = header.indexOf("STATUS") - header.indexOf("TASK") - 2;
check("TASK column width <= 18", taskWidth <= 18, { taskWidth, header });

const rowInfo = (rolePrefix) => {
  const idx = lines.findIndex((line) => line.includes(rolePrefix));
  if (idx === -1) return null;
  let hdrIdx = idx - 1;
  while (hdrIdx >= 0 && !(lines[hdrIdx].trim().startsWith("ROLE") && lines[hdrIdx].includes("TASK"))) hdrIdx--;
  const hdr = lines[hdrIdx];
  const line = lines[idx];
  return {
    line,
    task: line.slice(hdr.indexOf("TASK"), hdr.indexOf("STATUS") - 2).trim(),
    note: line.slice(hdr.indexOf("NOTE")).trim(),
  };
};

const rowA = rowInfo("01-implementer");
check("(A) cross-phase-file TASK cell", rowA?.task === "xfile:put.test.ts", rowA);
check("(A) cross-phase-file NOTE has full path", rowA?.note === "cross-phase file apps/web/src/app/api/v1/users/[id]/put.test.ts", rowA);

const rowB5 = rowInfo("02-code_reviewer");
check("(B) 5-task list TASK cell", rowB5?.task === "T077 … +3 … T086", rowB5);
check("(B) 5-task list NOTE has full list", rowB5?.note === "phase review · tasks T077, T081, T083, T084, T086", rowB5);

const rowB7 = rowInfo("03-verifier");
check("(B) 7-task list TASK cell", rowB7?.task === "T063 … +5 … T069", rowB7);
check("(B) 7-task list NOTE has full list", rowB7?.note === "phase verify · tasks T063, T064a, T065, T066a, T067, T068b, T069", rowB7);

const rowC = rowInfo("04-implementer");
check("(C) mapped SpecKit id TASK cell", rowC?.task === "T067", rowC);

const rowSingle = rowInfo("05-implementer");
check("single task T113 unchanged", rowSingle?.task === "T113", rowSingle);

const rowTwo = rowInfo("06-verifier");
check("2-task list T077, T081 unchanged", rowTwo?.task === "T077, T081", rowTwo);

const rowRange = rowInfo("07-code_reviewer");
check("consecutive range T113 > T114 unchanged", rowRange?.task === "T113 > T114", rowRange);

const rowCFallback = rowInfo("08-implementer");
check("(C) unmapped SpecKit id falls back to P7 T9", rowCFallback?.task === "P7 T9", rowCFallback);

const rowCMissingPhase = rowInfo("09-implementer");
check("(C) SpecKit id for missing phase falls back to P9 T0", rowCMissingPhase?.task === "P9 T0", rowCMissingPhase);

// Safety cap: any TASK cell > 32 chars is cut to 31 chars + "…"
const capRuns = [
  run({
    id: "01-implementer-cap11111", dirName: "01-implementer-cap11111",
    role: "implementer", phase: "7", attempt: "1",
    taskRef: "cross-phase-file:apps/web/src/very-long-component-filename-exceeding-limit.test.ts",
    resolvedModel: "muse-spark-1.3", duration: "00:01:00", started_at: "2026-10-26T09:00:00+00:00",
  }),
];
const capModel = buildReportModel({ state: { ...state, phaseIndex: 1 }, runs: capRuns, events: [], phases, policy: {}, now: "2026-10-26T09:05:00+00:00" });
const capLines = renderReport(capModel, { stamp: "2026-10-26 09:05:00" }).split("\n");
const capHeader = capLines.find((line) => line.trim().startsWith("ROLE") && line.includes("TASK") && line.includes("STATUS"));
const capRow = capLines.find((line) => line.includes("01-implementer"));
const capTaskWidth = capHeader.indexOf("STATUS") - capHeader.indexOf("TASK") - 2;
const capCell = capRow.slice(capHeader.indexOf("TASK"), capHeader.indexOf("STATUS") - 2).trim();
check("safety cap truncates TASK cell to 31 chars + ellipsis", capCell.length === 32 && capCell.endsWith("…") && capCell === "xfile:very-long-component-filen…", capCell);
check("safety cap keeps TASK column width <= 32", capTaskWidth === 32, capTaskWidth);

if (failures.length) {
  console.error(`${failures.length} task-width check(s) failed.`);
  process.exit(1);
}
console.log("All task-width checks passed.");
