#!/usr/bin/env node
// Regression tests for backlog item 6:
// SpecKit phase brief remains stale after the approved tasks file is re-phased.
//
// Verifies:
// 1. Brief regeneration from exact approved tasks.md after approval or task re-phasing.
// 2. Stale brief detection on implementation start and resume (phase count, task IDs, digest).
// 3. Watch Report uses authoritative SpecKit phase count and task map (Phase 1/13, not 1/1).
// 4. Standalone-compatible nextStepsLine format with exact next task cursor and (+N more tasks) count
//    for an 11-task phase while T001 is current, advancing correctly through T005.1a and T005.3.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildPhaseBrief,
  ensurePhaseBrief,
  ensurePhaseBriefForCheckpoint,
  readPhaseBriefHeader,
  phaseBriefPath,
  phaseBriefDigest,
  validatePhaseBrief,
  regenerateAllPhaseBriefs,
  validateAndReconcilePhaseBriefs
} from "./role-progress-brief.mjs";
import { buildReportModel, renderReport } from "./watch-report.mjs";
import { writeWatchReportFile, renderWatchReport, resolveMissionPhases } from "./run-history.mjs";
import { phases as speckitPhases } from "../adapters/speckit.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`);
  }
};

const PH_1_TASK_TEXTS_11 = [
  "T001 Set up database schema",
  "T002 Create service repository",
  "T003 Add service validation",
  "T003.1 Add shop validation",
  "T003.2 Add appointment validation",
  "T004 Implement billing calculation",
  "T005 Implement notification service",
  "T005.1 Implement email dispatcher",
  "T005.1a Add shop orders endpoint",
  "T005.2 Implement sms dispatcher",
  "T005.3 Implement webhook callback"
];

const PH_1_TASK_TEXTS_16 = [
  "T001 Set up database schema",
  "T002 Create service repository",
  "T003 Add service validation",
  "T004 Implement billing calculation",
  "T005 Implement notification service",
  "T006 Old moved task six",
  "T007 Old moved task seven",
  "T008 Old moved task eight",
  "T009 Old moved task nine",
  "T010 Old moved task ten",
  "T011 Old moved task eleven",
  "T012 Old moved task twelve",
  "T013 Old moved task thirteen",
  "T014 Old moved task fourteen",
  "T015 Old moved task fifteen",
  "T016 Old moved task sixteen"
];

function makeTasksMd(phaseCount, phase1TaskTexts) {
  const lines = [
    `## Phase 1: Foundation`,
    ...phase1TaskTexts.map(t => `- [ ] ${t}`)
  ];
  for (let p = 2; p <= phaseCount; p++) {
    lines.push("", `## Phase ${p}: Phase ${p} Work`, `- [ ] T${p}01 Implement phase ${p} service`);
  }
  return lines.join("\n") + "\n";
}

// ── 1. Re-phasing from 7 phases / 16 Phase-1 tasks to 13 phases / 11 Phase-1 tasks ──
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-rephase-"));
  const mission = "002-dynamic-shop-orders";
  const featureDir = "specs/010-dynamic-shop-orders";
  fs.mkdirSync(path.join(root, featureDir), { recursive: true });

  // Initial: 7 phases, 16 tasks in Phase 1
  const tasksMd7 = makeTasksMd(7, PH_1_TASK_TEXTS_16);
  const tasksFile = path.join(root, featureDir, "tasks.md");
  fs.writeFileSync(tasksFile, tasksMd7, "utf8");

  const phases7 = speckitPhases(root, [path.join(featureDir, "tasks.md")]);
  check("rephase: parsed 7 initial phases", phases7.length === 7);
  check("rephase: parsed 16 initial Phase-1 tasks", phases7[0].tasks.length === 16);

  // Generate initial phase briefs (simulating earlier planning round)
  const genInitial = regenerateAllPhaseBriefs({
    repo: root,
    mission,
    framework: "speckit",
    phases: phases7,
    tasksFile,
    revision: 1
  });
  check("rephase: generated 7 initial phase briefs", genInitial.ok && genInitial.regenerated.length === 7);

  const initialBrief1 = fs.readFileSync(phaseBriefPath(root, mission, 1), "utf8");
  check("rephase: initial brief has Phase 1/7", initialBrief1.includes("Phase: 1/7 \"Phase 1 — Foundation\"") || initialBrief1.includes("Phase: 1/7"));
  check("rephase: initial brief has 16 tasks in map", (initialBrief1.match(/^- T\d+:/gm) || []).length === 16);

  // Approved revision re-phases tasks.md to 13 phases and 11 Phase-1 tasks
  const tasksMd13 = makeTasksMd(13, PH_1_TASK_TEXTS_11);
  fs.writeFileSync(tasksFile, tasksMd13, "utf8");

  const phases13 = speckitPhases(root, [path.join(featureDir, "tasks.md")]);
  check("rephase: parsed 13 phases after revision", phases13.length === 13);
  check("rephase: parsed 11 Phase-1 tasks after revision", phases13[0].tasks.length === 11);

  // Before regeneration, validatePhaseBrief detects phase count mismatch, task mismatch, and digest mismatch
  const staleVal = validatePhaseBrief(root, mission, 1, {
    revision: 1,
    phaseTotal: 13,
    taskIds: phases13[0].tasks.map(t => t.ref)
  });
  check("rephase: validate detects stale brief", staleVal.ok === false);
  check("rephase: detects phase_count_mismatch", staleVal.reason === "phase_count_mismatch" || staleVal.reason === "digest_mismatch");

  // Regenerate briefs from the approved 13-phase plan
  const genRephased = regenerateAllPhaseBriefs({
    repo: root,
    mission,
    framework: "speckit",
    phases: phases13,
    tasksFile,
    revision: 1
  });
  check("rephase: regenerated all 13 briefs", genRephased.ok && genRephased.regenerated.length === 13);

  const newBrief1 = fs.readFileSync(phaseBriefPath(root, mission, 1), "utf8");
  check("rephase: new brief has Phase 1/13", newBrief1.includes("Phase: 1/13 \"Phase 1 — Foundation\"") || newBrief1.includes("Phase: 1/13"));
  check("rephase: new brief has exactly 11 tasks in map", (newBrief1.match(/^- T[^:]+:/gm) || []).length === 11);
  check("rephase: new brief includes T005.1a", newBrief1.includes("- T005.1a:"));

  // Check that briefs for phases 8..13 exist
  check("rephase: phase-13.md exists", fs.existsSync(phaseBriefPath(root, mission, 13)));

  fs.rmSync(root, { recursive: true, force: true });
}

// ── 2. Stale brief detection and reconciliation on implementation start and resume ──
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-reconcile-"));
  const mission = "002-dynamic-shop-orders";
  const featureDir = "specs/010-dynamic-shop-orders";
  fs.mkdirSync(path.join(root, featureDir), { recursive: true });

  const tasksMd13 = makeTasksMd(13, PH_1_TASK_TEXTS_11);
  const tasksFile = path.join(root, featureDir, "tasks.md");
  fs.writeFileSync(tasksFile, tasksMd13, "utf8");
  const phases13 = speckitPhases(root, [path.join(featureDir, "tasks.md")]);

  // Deliberately write a stale phase-1.md with Phase 1/7 and 16 tasks (simulating the incident)
  const staleBriefText = [
    `<!-- autopilot-phase-brief revision=1 digest=sha256:stale7phase -->`,
    `# Phase brief — Foundation`,
    ``,
    `Framework: speckit`,
    `Mission: ${mission}`,
    `Phase: 1/7 "Foundation"`,
    `Revision: 1`,
    ``,
    `## Phase task map (titles only)`,
    ...PH_1_TASK_TEXTS_16.map((t, i) => `- T${String(i + 1).padStart(3, "0")}: ${t}`),
    ``,
    `## Plan context`,
    `(none provided)`
  ].join("\n") + "\n";

  const phase1File = phaseBriefPath(root, mission, 1);
  fs.mkdirSync(path.dirname(phase1File), { recursive: true });
  fs.writeFileSync(phase1File, staleBriefText, "utf8");

  // Verify validatePhaseBrief flags it
  const checkStale = validatePhaseBrief(root, mission, 1, {
    revision: 1,
    phaseTotal: 13,
    taskIds: phases13[0].tasks.map(t => t.ref)
  });
  check("stale: detected stale phase 1 brief", checkStale.ok === false);

  // Implementation start / resume reconciles and rebuilds stale briefs
  const reconcile = validateAndReconcilePhaseBriefs({
    repo: root,
    mission,
    framework: "speckit",
    phases: phases13,
    tasksFile,
    revision: 1
  });
  check("stale: reconcile succeeded", reconcile.ok === true);
  check("stale: rebuilt phase 1 brief", reconcile.rebuilt.some(r => r.phaseNumber === 1));

  const reconciledBrief1 = fs.readFileSync(phase1File, "utf8");
  check("stale: rebuilt brief has Phase 1/13", reconciledBrief1.includes("Phase: 1/13"));
  check("stale: rebuilt brief has 11 tasks", (reconciledBrief1.match(/^- T[^:]+:/gm) || []).length === 11);
  check("stale: rebuilt brief includes T005.1a", reconciledBrief1.includes("- T005.1a:"));

  // Idempotence: a second reconcile re-checks and does NOT rebuild
  const secondReconcile = validateAndReconcilePhaseBriefs({
    repo: root,
    mission,
    framework: "speckit",
    phases: phases13,
    tasksFile,
    revision: 1
  });
  check("stale: second reconcile is idempotent (0 rebuilt)", secondReconcile.ok === true && secondReconcile.rebuilt.length === 0);

  fs.rmSync(root, { recursive: true, force: true });
}

// ── 3. Watch Report uses authoritative SpecKit phase count and exact next cursor/count ──
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-watch-"));
  const mission = "002-dynamic-shop-orders";
  const featureDir = "specs/010-dynamic-shop-orders";
  fs.mkdirSync(path.join(root, featureDir), { recursive: true });

  const tasksMd13 = makeTasksMd(13, PH_1_TASK_TEXTS_11);
  fs.writeFileSync(path.join(root, featureDir, "tasks.md"), tasksMd13, "utf8");

  // Write state.json with speckitFeatureDir
  fs.mkdirSync(path.join(root, ".autopilot"), { recursive: true });
  fs.writeFileSync(path.join(root, ".autopilot", "state.json"), JSON.stringify({
    phase: "implementing",
    step: "implement",
    mission,
    phaseIndex: 0,
    attempt: 1,
    speckitFeatureDir: "010-dynamic-shop-orders",
    planningDetection: { framework: "speckit", status: "complete" }
  }, null, 2));

  fs.writeFileSync(path.join(root, ".autopilot", "config.json"), JSON.stringify({
    project: { planning_framework: "speckit" },
    policy: { failure_budgets: { implementationFailureBudget: 3 } }
  }, null, 2));

  // Write runs directory for mission
  const runsDir = path.join(root, ".autopilot", "missions", mission, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(path.join(root, ".autopilot", "missions", mission, "watch-events.jsonl"), "");

  // Helper to simulate an active implementer run with a specific taskRef
  function createRun(id, taskRef, status = "running", startSec = 10) {
    const dir = path.join(runsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const secStr = String(startSec).padStart(2, "0");
    fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
      status,
      run_id: id,
      role: "implementer",
      phase: "1",
      attempt: "1",
      taskRef,
      pid: process.pid,
      started_at: `2026-11-05T00:${secStr}:00+03:00`,
      updated_at: `2026-11-05T00:${secStr}:30+03:00`
    }, null, 2));
  }

  // (A) While T001 is current in Phase 1 (11 tasks total)
  createRun("157-implementer-c22564f8", "T001", "running", 10);
  const reportPath1 = writeWatchReportFile(root, mission, { outFile: path.join(root, "watch1.txt") });
  const report1 = fs.readFileSync(reportPath1, "utf8");

  check("watch: authoritative SpecKit phase count (Phase 1/13, not 1/1)", report1.includes("Phase 1/13"), report1.split("\n").find(l => l.includes("Phase 1/")));
  check("watch: not reporting Phase 1/1", !report1.includes("Phase 1/1 "), report1);

  // Exact next line format: next: T002 (+9 more tasks) → phase review → full test suite → phase verify
  const expectedNext1 = "next: T002 (+9 more tasks) → phase review → full test suite → phase verify";
  check("watch: next line names T002 (+9 more tasks) while T001 is current", report1.includes(expectedNext1), report1.split("\n").find(l => l.includes("next:")));

  // (B) Advance to T002: T001 completed, T002 running -> next: T003 (+8 more tasks)
  fs.writeFileSync(path.join(runsDir, "157-implementer-c22564f8", "status.json"), JSON.stringify({
    status: "completed", role: "implementer", phase: "1", attempt: "1", taskRef: "T001", started_at: "2026-11-05T00:10:00+03:00", finished_at: "2026-11-05T00:12:00+03:00"
  }, null, 2));
  createRun("158-implementer-d471197a", "T002", "running", 13);

  const reportPath2 = writeWatchReportFile(root, mission, { outFile: path.join(root, "watch2.txt") });
  const report2 = fs.readFileSync(reportPath2, "utf8");
  const expectedNext2 = "next: T003 (+8 more tasks) → phase review → full test suite → phase verify";
  check("watch: next line advances to T003 (+8 more tasks) on T002", report2.includes(expectedNext2), report2.split("\n").find(l => l.includes("next:")));

  // (C) Advance to T005.1a (alphanumeric task ref): next: T005.2 (+1 more task)
  fs.writeFileSync(path.join(runsDir, "158-implementer-d471197a", "status.json"), JSON.stringify({
    status: "completed", role: "implementer", phase: "1", attempt: "1", taskRef: "T002", started_at: "2026-11-05T00:13:00+03:00", finished_at: "2026-11-05T00:14:00+03:00"
  }, null, 2));
  createRun("159-implementer-e1234567", "T005.1a", "running", 15);
  const reportPath3 = writeWatchReportFile(root, mission, { outFile: path.join(root, "watch3.txt") });
  const report3 = fs.readFileSync(reportPath3, "utf8");
  const expectedNext3 = "next: T005.2 (+1 more task) → phase review → full test suite → phase verify";
  check("watch: alphanumeric T005.1a resolves next: T005.2 (+1 more task)", report3.includes(expectedNext3), report3.split("\n").find(l => l.includes("next:")));

  // (D) Advance to T005.2 (penultimate task): next: T005.3 without "+more"
  fs.writeFileSync(path.join(runsDir, "159-implementer-e1234567", "status.json"), JSON.stringify({
    status: "completed", role: "implementer", phase: "1", attempt: "1", taskRef: "T005.1a", started_at: "2026-11-05T00:15:00+03:00", finished_at: "2026-11-05T00:16:00+03:00"
  }, null, 2));
  createRun("160-implementer-f2345678", "T005.2", "running", 17);
  const reportPath4 = writeWatchReportFile(root, mission, { outFile: path.join(root, "watch4.txt") });
  const report4 = fs.readFileSync(reportPath4, "utf8");
  const expectedNext4 = "next: T005.3 → phase review → full test suite → phase verify";
  check("watch: penultimate T005.2 yields single next task T005.3", report4.includes(expectedNext4), report4.split("\n").find(l => l.includes("next:")));

  // (E) Advance to T005.3 (last implementation task): no remaining task segment
  fs.writeFileSync(path.join(runsDir, "160-implementer-f2345678", "status.json"), JSON.stringify({
    status: "completed", role: "implementer", phase: "1", attempt: "1", taskRef: "T005.2", started_at: "2026-11-05T00:17:00+03:00", finished_at: "2026-11-05T00:18:00+03:00"
  }, null, 2));
  createRun("161-implementer-a3456789", "T005.3", "running", 19);
  const reportPath5 = writeWatchReportFile(root, mission, { outFile: path.join(root, "watch5.txt") });
  const report5 = fs.readFileSync(reportPath5, "utf8");
  const expectedNext5 = "next: phase review → full test suite → phase verify";
  check("watch: final task T005.3 omits task segment", report5.includes(expectedNext5), report5.split("\n").find(l => l.includes("next:")));

  fs.rmSync(root, { recursive: true, force: true });
}

// ── 4. Standalone loop parity (Both loops rule) ──
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-standalone-"));
  const mission = "501-standalone-parity";
  fs.mkdirSync(path.join(root, ".autopilot", "missions", mission), { recursive: true });

  const tasksMd = makeTasksMd(4, ["1.1 Task one", "1.2 Task two", "1.3 Task three"]);
  fs.writeFileSync(path.join(root, ".autopilot", "missions", mission, "TASKS.md"), tasksMd, "utf8");

  fs.writeFileSync(path.join(root, ".autopilot", "state.json"), JSON.stringify({
    phase: "implementing",
    step: "implement",
    mission,
    phaseIndex: 0,
    attempt: 1,
    planningDetection: { framework: "standalone", status: "complete" }
  }, null, 2));

  fs.writeFileSync(path.join(root, ".autopilot", "config.json"), JSON.stringify({
    project: { planning_framework: "standalone" }
  }, null, 2));

  const resolved = resolveMissionPhases(root, mission, null, null);
  check("standalone: resolves standalone phases", resolved.length === 4);
  check("standalone: resolves phase 1 tasks", resolved[0].tasks.length === 3);

  fs.rmSync(root, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll SpecKit phase brief re-phase regression tests passed.");
