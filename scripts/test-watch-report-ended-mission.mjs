#!/usr/bin/env node
// Backlog #4: Watch report after a cancel — clock stops, no "so far", scoped reset, mission name fallback
import {
  buildReportModel,
  renderReport,
  renderPipelineState,
  renderPlanningStage,
  totalText,
} from "./watch-report.mjs";
import { renderWatchReport } from "./run-history.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
};

const run = (o) => ({ status: "completed", decision: null, findings: [], ...o });

// ── Test 1: Cancelled mission rendered hours later — elapsed stops at cancel time ─────
{
  const state = {
    mission: "095-home-linux-projects",
    phase: "cancelled",
    step: "cancelled",
    lastCancelled: { mission: "095-home-linux-projects", at: "2026-10-17T12:50:47+03:00", reason: "operator" },
    planningStartedAt: "2026-10-17T12:45:22+03:00",
  };
  // Mission started at 12:45:22, cancelled at 12:50:47 → elapsed = 5m 25s
  // Now is hours later (18:50), but elapsed should still be 00:05:25
  const planner = run({
    id: "01-planner", dirName: "01-planner", role: "planner", phase: "1", attempt: "0",
    taskRef: "standalone-planning-planner", planRevision: 0, usage: { priceWeighted: 425000 },
  });
  const PH = [{ number: 1, name: "Phase 1 — Reproduce and locate", done: false, tasks: [{ text: "T1.1", done: false }] }];

  // Model with `now` at cancel time (original render)
  const modelAtCancel = buildReportModel({ state, runs: [planner], events: [], phases: PH, policy: {}, now: "2026-10-17T12:51:00+03:00" });
  const reportAtCancel = renderReport(modelAtCancel, { stamp: "2026-10-17 12:51:00" });

  // Model with `now` hours later (re-render)
  const modelHoursLater = buildReportModel({ state, runs: [planner], events: [], phases: PH, policy: {}, now: "2026-10-17T18:50:00+03:00" });
  const reportHoursLater = renderReport(modelHoursLater, { stamp: "2026-10-17 18:50:00" });

  // Elapsed should be the same in both (5m 25s), not 6 hours
  const totalLineAtCancel = reportAtCancel.split("\n").find(l => l.trim().startsWith("Total:"));
  const totalLineHoursLater = reportHoursLater.split("\n").find(l => l.trim().startsWith("Total:"));

  check("cancel: total line at cancel has elapsed 00:05:25", totalLineAtCancel?.includes("elapsed 00:05:25"), totalLineAtCancel);
  check("cancel: total line hours later has SAME elapsed 00:05:25", totalLineHoursLater?.includes("elapsed 00:05:25"), totalLineHoursLater);

  // No "so far" suffix in either
  check("cancel: no 'so far' at cancel", !totalLineAtCancel?.includes("so far"), totalLineAtCancel);
  check("cancel: no 'so far' hours later", !totalLineHoursLater?.includes("so far"), totalLineHoursLater);

  // Planning stage header should show CANCELLED, not IN PROGRESS
  check("cancel: planning header shows CANCELLED", reportHoursLater.includes("✗ CANCELLED"), reportHoursLater.split("\n").find(l => l.startsWith("=== PLANNING")));
  check("cancel: planning header no IN PROGRESS", !reportHoursLater.split("\n").find(l => l.startsWith("=== PLANNING"))?.includes("IN PROGRESS"), reportHoursLater.split("\n").find(l => l.startsWith("=== PLANNING")));

  // No CURRENT RUN section for ended mission
  check("cancel: no CURRENT RUN section", !reportHoursLater.includes("=== CURRENT RUN ==="), "CURRENT RUN should not appear");
}

// ── Test 2: Mission name fallback when state.mission is null ─────────────────────
{
  // After cancel, state.mission can become null; mission folder name should be used
  const state = {
    mission: null, // null after cancel
    phase: "cancelled",
    step: "cancelled",
    lastCancelled: { mission: "095-home-linux-projects", at: "2026-10-17T12:50:47+03:00", reason: "operator" },
    planningStartedAt: "2026-10-17T12:45:22+03:00",
  };
  const planner = run({
    id: "01-planner", dirName: "01-planner", role: "planner", phase: "1", attempt: "0",
    taskRef: "standalone-planning-planner", planRevision: 0, usage: { priceWeighted: 425000 },
  });
  const PH = [{ number: 1, name: "Phase 1 — Reproduce and locate", done: false, tasks: [{ text: "T1.1", done: false }] }];

  const model = buildReportModel({ state, runs: [planner], events: [], phases: PH, policy: {}, now: "2026-10-17T18:50:00+03:00", missionFallback: "095-home-linux-projects" });
  const report = renderReport(model, { stamp: "2026-10-17 18:50:00" });

  // Mission should show folder name, not "-"
  check("cancel: mission name falls back to folder", report.includes("Mission: 095-home-linux-projects"), report.split("\n").find(l => l.startsWith("Mission:")));
}

// ── Test 3: Reset event scoped to current mission ─────────────────────────────────
{
  // state.lastReset from a different mission should not appear in Events
  const state = {
    mission: "095-home-linux-projects",
    phase: "cancelled",
    step: "cancelled",
    lastCancelled: { mission: "095-home-linux-projects", at: "2026-10-17T12:50:47+03:00", reason: "operator" },
    planningStartedAt: "2026-10-17T12:45:22+03:00",
    // This reset belongs to mission 094, not 095
    lastReset: { scope: "continuationAllowance:standalone:phase-3:standalone:P4:T1", at: "2026-10-17T10:00:00+03:00", appliedLive: true },
  };
  const planner = run({
    id: "01-planner", dirName: "01-planner", role: "planner", phase: "1", attempt: "0",
    taskRef: "standalone-planning-planner", planRevision: 0, usage: { priceWeighted: 425000 },
  });
  const PH = [{ number: 1, name: "Phase 1 — Reproduce and locate", done: false, tasks: [{ text: "T1.1", done: false }] }];

  const model = buildReportModel({ state, runs: [planner], events: [], phases: PH, policy: {}, now: "2026-10-17T18:50:00+03:00" });
  const report = renderReport(model, { stamp: "2026-10-17 18:50:00" });

  // The reset event should NOT appear because it belongs to a different mission
  check("cancel: foreign reset event not shown", !report.includes("operator reset extra sessions"), report.split("\n").find(l => l.startsWith("Events:")));
}

// ── Test 4: Running mission — unchanged behavior (live elapsed, "so far") ─────────
{
  const state = {
    mission: "096-running-mission",
    phase: "implementing",
    step: "implement",
    phaseIndex: 1,
    attempt: 2,
    planningStartedAt: "2026-10-17T10:00:00+03:00",
  };
  const planner = run({
    id: "01-planner", dirName: "01-planner", role: "planner", phase: "1", attempt: "0",
    taskRef: "standalone-planning-planner", planRevision: 0, usage: { priceWeighted: 100000 },
  });
  const impl = run({
    id: "02-implementer", dirName: "02-implementer", role: "implementer", phase: "2", attempt: "1",
    taskRef: "T2.1", status: "running", pid: 12345, started_at: "2026-10-17T12:00:00+03:00", updated_at: "2026-10-17T12:30:00+03:00",
    usage: { priceWeighted: 500000 },
  });
  const PH = [
    { number: 1, name: "Phase 1", done: true, tasks: [{ text: "T1.1", done: true }] },
    { number: 2, name: "Phase 2", done: false, tasks: [{ text: "T2.1", done: false }] },
  ];
  const policy = { failure_budgets: { implementationFailureBudget: 3 }, caps: { implementer: { max_tokens: 500000 } } };

  // Now is during the run
  const model = buildReportModel({ state, runs: [planner, impl], events: [], phases: PH, policy, now: "2026-10-17T12:30:00+03:00" });
  const report = renderReport(model, { stamp: "2026-10-17 12:30:00" });

  // Running mission should still show "so far" and live elapsed
  const totalLine = report.split("\n").find(l => l.trim().startsWith("Total:"));
  check("running: total line has 'so far'", totalLine?.includes("so far"), totalLine);
  check("running: total line has elapsed (live)", totalLine?.includes("elapsed"), totalLine);
  check("running: CURRENT RUN section present", report.includes("=== CURRENT RUN ==="), "CURRENT RUN should appear");
  const planningHead = report.split("\n").find(l => l.startsWith("=== PLANNING"));
  check("running: planning not terminal", planningHead && !/CANCELLED|STOPPED|ESCALATED/.test(planningHead), planningHead);
}

// ── Test 5: COMPLETED mission — elapsed stops at completion ─────────────────────
{
  const state = {
    mission: "097-completed-mission",
    phase: "complete",
    step: "complete",
    planningStartedAt: "2026-10-17T10:00:00+03:00",
    // No explicit completion time; should use last run end time
  };
  const planner = run({
    id: "01-planner", dirName: "01-planner", role: "planner", phase: "1", attempt: "0",
    taskRef: "standalone-planning-planner", planRevision: 0, usage: { priceWeighted: 100000 },
    started_at: "2026-10-17T10:00:00+03:00",
  });
  const reviewer = run({
    id: "02-reviewer", dirName: "02-reviewer", role: "plan_reviewer", phase: "1", attempt: "0",
    taskRef: "standalone-planning-plan_reviewer", planRevision: 0, decision: "PASS", usage: { priceWeighted: 50000 },
    started_at: "2026-10-17T10:10:00+03:00",
    duration: "00:05:00",
  });
  const PH = [{ number: 1, name: "Phase 1", done: true, tasks: [{ text: "T1.1", done: true }] }];

  // Model with now at completion time
  const modelAtComplete = buildReportModel({ state, runs: [planner, reviewer], events: [], phases: PH, policy: {}, now: "2026-10-17T10:15:00+03:00" });
  const reportAtComplete = renderReport(modelAtComplete, { stamp: "2026-10-17 10:15:00" });

  // Model with now hours later
  const modelHoursLater = buildReportModel({ state, runs: [planner, reviewer], events: [], phases: PH, policy: {}, now: "2026-10-17T18:00:00+03:00" });
  const reportHoursLater = renderReport(modelHoursLater, { stamp: "2026-10-17 18:00:00" });

  const totalLineAtComplete = reportAtComplete.split("\n").find(l => l.trim().startsWith("Total:"));
  const totalLineHoursLater = reportHoursLater.split("\n").find(l => l.trim().startsWith("Total:"));

  // Elapsed should be the same (based on last run end)
  check("completed: total line at complete has elapsed", totalLineAtComplete?.includes("elapsed"), totalLineAtComplete);
  check("completed: total line hours later has SAME elapsed", totalLineHoursLater?.includes("elapsed"), totalLineHoursLater);
  check("completed: no 'so far' at complete", !totalLineAtComplete?.includes("so far"), totalLineAtComplete);
  check("completed: no 'so far' hours later", !totalLineHoursLater?.includes("so far"), totalLineHoursLater);
  check("completed: no CURRENT RUN", !reportHoursLater.includes("=== CURRENT RUN ==="));
}

// ── Test 6: STOPPED mission — elapsed stops at stop time ─────────────────────────
{
  const state = {
    mission: "098-stopped-mission",
    phase: "idle",
    step: "implement",
    phaseIndex: 0,
    attempt: 1,
    planningStartedAt: "2026-10-17T10:00:00+03:00",
  };
  const events = [
    { type: "operator", reason: "stop", scope: "mission", at: "2026-10-17T12:00:00+03:00" },
  ];
  const planner = run({
    id: "01-planner", dirName: "01-planner", role: "planner", phase: "1", attempt: "0",
    taskRef: "standalone-planning-planner", planRevision: 0, usage: { priceWeighted: 100000 },
    started_at: "2026-10-17T10:00:00+03:00",
  });
  const impl = run({
    id: "02-implementer", dirName: "02-implementer", role: "implementer", phase: "1", attempt: "1",
    taskRef: "T1.1", status: "interrupted", usage: { priceWeighted: 200000 },
    started_at: "2026-10-17T11:00:00+03:00",
    duration: "01:00:00",
  });
  const PH = [{ number: 1, name: "Phase 1", done: false, tasks: [{ text: "T1.1", done: false }] }];

  const modelAtStop = buildReportModel({ state, runs: [planner, impl], events, phases: PH, policy: {}, now: "2026-10-17T12:01:00+03:00" });
  const reportAtStop = renderReport(modelAtStop, { stamp: "2026-10-17 12:01:00" });

  const modelHoursLater = buildReportModel({ state, runs: [planner, impl], events, phases: PH, policy: {}, now: "2026-10-17T18:00:00+03:00" });
  const reportHoursLater = renderReport(modelHoursLater, { stamp: "2026-10-17 18:00:00" });

  const totalLineAtStop = reportAtStop.split("\n").find(l => l.trim().startsWith("Total:"));
  const totalLineHoursLater = reportHoursLater.split("\n").find(l => l.trim().startsWith("Total:"));

  check("stopped: total line at stop has elapsed", totalLineAtStop?.includes("elapsed"), totalLineAtStop);
  check("stopped: total line hours later has SAME elapsed", totalLineHoursLater?.includes("elapsed"), totalLineHoursLater);
  check("stopped: no 'so far' at stop", !totalLineAtStop?.includes("so far"), totalLineAtStop);
  check("stopped: no 'so far' hours later", !totalLineHoursLater?.includes("so far"), totalLineHoursLater);
  check("stopped: no CURRENT RUN", !reportHoursLater.includes("=== CURRENT RUN ==="));
}

// ── Test 7: ESCALATED mission — elapsed stops at escalation ──────────────────────
{
  const state = {
    mission: "099-escalated-mission",
    phase: "escalated",
    step: "standalone_task_no_progress",
    lastContinuation: { at: "2026-10-17T12:00:00+03:00" },
    planningStartedAt: "2026-10-17T10:00:00+03:00",
    planningDetection: { framework: "standalone" },
  };
  const planner = run({
    id: "01-planner", dirName: "01-planner", role: "planner", phase: "1", attempt: "0",
    taskRef: "standalone-planning-planner", planRevision: 0, usage: { priceWeighted: 100000 },
    started_at: "2026-10-17T10:00:00+03:00",
  });
  const reviewer = run({
    id: "02-reviewer", dirName: "02-reviewer", role: "code_reviewer", status: "interrupted", taskRef: null, usage: { priceWeighted: 8000 },
    started_at: "2026-10-17T11:30:00+03:00",
  });
  const PH = [{ number: 1, name: "Phase 1", done: false, tasks: [{ text: "T1.1", done: false }] }];

  const modelAtEscalation = buildReportModel({ state, runs: [planner, reviewer], events: [], phases: PH, policy: {}, now: "2026-10-17T12:01:00+03:00" });
  const reportAtEscalation = renderReport(modelAtEscalation, { stamp: "2026-10-17 12:01:00" });

  const modelHoursLater = buildReportModel({ state, runs: [planner, reviewer], events: [], phases: PH, policy: {}, now: "2026-10-17T18:00:00+03:00" });
  const reportHoursLater = renderReport(modelHoursLater, { stamp: "2026-10-17 18:00:00" });

  const totalLineAtEsc = reportAtEscalation.split("\n").find(l => l.trim().startsWith("Total:"));
  const totalLineHoursLater = reportHoursLater.split("\n").find(l => l.trim().startsWith("Total:"));

  check("escalated: total line at escalation has elapsed", totalLineAtEsc?.includes("elapsed"), totalLineAtEsc);
  check("escalated: total line hours later has SAME elapsed", totalLineHoursLater?.includes("elapsed"), totalLineHoursLater);
  check("escalated: no 'so far' at escalation", !totalLineAtEsc?.includes("so far"), totalLineAtEsc);
  check("escalated: no 'so far' hours later", !totalLineHoursLater?.includes("so far"), totalLineHoursLater);
  check("escalated: no CURRENT RUN", !reportHoursLater.includes("=== CURRENT RUN ==="));
}

// ── Test 8: end-to-end renderWatchReport with cancelled mission fixture ─────────
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-backlog4-"));
  const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

  const mission = "095-home-linux-projects";
  const missionDir = path.join(root, ".autopilot", "missions", mission);
  const runsDir = path.join(missionDir, "runs");

  // State with cancelled mission
  write(path.join(root, ".autopilot", "state.json"), JSON.stringify({
    phase: "cancelled", step: "cancelled", mission,
    lastCancelled: { mission, at: "2026-10-17T12:50:47+03:00", reason: "operator" },
    planningStartedAt: "2026-10-17T12:45:22+03:00",
    // Foreign reset from mission 094
    lastReset: { scope: "continuationAllowance:standalone:phase-3:standalone:P4:T1", at: "2026-10-17T10:00:00+03:00", appliedLive: true },
  }, null, 2));

  // Config
  write(path.join(root, ".autopilot", "config.json"), JSON.stringify({
    policy: { failure_budgets: { implementationFailureBudget: 3 }, caps: { planner: { max_tokens: 750000 } } },
  }, null, 2));

  // Planner run
  const plannerDir = path.join(runsDir, "01-planner-aaaaaaaa");
  fs.mkdirSync(plannerDir, { recursive: true });
  write(path.join(plannerDir, "status.json"), JSON.stringify({
    status: "completed", run_id: "aaaaaaaa-0000-0000-0000-000000000001",
    role: "planner", phase: "1", attempt: "0", taskRef: "standalone-planning-planner", planRevision: 0,
    started_at: "2026-10-17T12:45:22+03:00", updated_at: "2026-10-17T12:50:47+03:00",
    duration: "00:05:25", exit_code: 0,
    usage: { input: 1000, cacheRead: 400000, output: 1000, turns: 5, priceWeighted: 425000 },
  }, null, 2));

  // Watch events (empty)
  write(path.join(missionDir, "watch-events.jsonl"), "");

  // Render with now hours after cancel (simulating re-render)
  // We inject `now` to simulate a later render time
  const report = renderWatchReport(root, mission, { now: "2026-10-17T18:50:00+03:00", tail: 5 });

  check("e2e: mission name shows folder", report.includes("Mission: 095-home-linux-projects"), report.split("\n").find(l => l.startsWith("Mission:")));
  check("e2e: elapsed is 00:05:25 not 6 hours", report.includes("elapsed 00:05:25"), report.split("\n").find(l => l.trim().startsWith("Total:")));
  check("e2e: no 'so far'", !report.split("\n").find(l => l.trim().startsWith("Total:"))?.includes("so far"), report.split("\n").find(l => l.trim().startsWith("Total:")));
  check("e2e: no foreign reset event", !report.includes("operator reset extra sessions"), report.split("\n").find(l => l.startsWith("Events:")));
  check("e2e: no CURRENT RUN", !report.includes("=== CURRENT RUN ==="));
  check("e2e: status shows CANCELLED", report.includes("CANCELLED"), report.split("\n").find(l => l.startsWith("Status:")));

  fs.rmSync(root, { recursive: true, force: true });
}

// ── Test 9: end-to-end renderWatchReport with running mission (unchanged) ────────
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-backlog4-running-"));
  const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

  const mission = "096-running-mission";
  const missionDir = path.join(root, ".autopilot", "missions", mission);
  const runsDir = path.join(missionDir, "runs");

  write(path.join(root, ".autopilot", "state.json"), JSON.stringify({
    phase: "implementing", step: "implement", mission, phaseIndex: 1, attempt: 2,
    planningStartedAt: "2026-10-17T10:00:00+03:00",
  }, null, 2));

  write(path.join(root, ".autopilot", "config.json"), JSON.stringify({
    policy: { failure_budgets: { implementationFailureBudget: 3 }, caps: { implementer: { max_tokens: 500000 } } },
  }, null, 2));

  // Planner run (completed)
  const plannerDir = path.join(runsDir, "01-planner-bbbbbbbb");
  fs.mkdirSync(plannerDir, { recursive: true });
  write(path.join(plannerDir, "status.json"), JSON.stringify({
    status: "completed", run_id: "bbbbbbbb-0000-0000-0000-000000000002",
    role: "planner", phase: "1", attempt: "0", taskRef: "standalone-planning-planner", planRevision: 0,
    started_at: "2026-10-17T10:00:00+03:00", updated_at: "2026-10-17T10:10:00+03:00",
    duration: "00:10:00", exit_code: 0,
    usage: { input: 1000, cacheRead: 90000, output: 1000, turns: 4, priceWeighted: 100000 },
  }, null, 2));

  // Running implementer (current process pid so it's alive)
  const implDir = path.join(runsDir, "02-implementer-cccccccc");
  fs.mkdirSync(implDir, { recursive: true });
  write(path.join(implDir, "status.json"), JSON.stringify({
    status: "running", run_id: "cccccccc-0000-0000-0000-000000000003",
    role: "implementer", phase: "2", attempt: "1", taskRef: "T2.1",
    started_at: "2026-10-17T12:00:00+03:00", updated_at: "2026-10-17T12:30:00+03:00",
    pid: process.pid, last_action: "streaming",
    usage: { input: 1000, cacheRead: 400000, output: 1000, turns: 10, priceWeighted: 500000 },
  }, null, 2));
  write(path.join(implDir, "progress.log"), "2026-10-17T12:00:00  START | ROLE=implementer | PHASE=2 | TASK=T2.1 | ATTEMPT=1 | PID=1\n");

  write(path.join(missionDir, "watch-events.jsonl"), "");

  // Render with current now
  const report = renderWatchReport(root, mission, { now: "2026-10-17T12:30:00+03:00", tail: 5 });

  check("running e2e: mission name shows folder", report.includes("Mission: 096-running-mission"));
  check("running e2e: has 'so far'", report.split("\n").find(l => l.trim().startsWith("Total:"))?.includes("so far"));
  check("running e2e: has CURRENT RUN", report.includes("=== CURRENT RUN ==="));
  check("running e2e: status shows RUNNING", report.includes("Status:  RUNNING"));
  check("running e2e: has LIVE PROGRESS", report.includes("=== LIVE PROGRESS"));

  fs.rmSync(root, { recursive: true, force: true });
}

if (failures.length) { console.error(`${failures.length} check(s) failed.`); process.exit(1); }
console.log("All backlog-4 watch-report-ended checks passed.");