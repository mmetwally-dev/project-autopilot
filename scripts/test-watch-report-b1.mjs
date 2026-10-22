#!/usr/bin/env node
// Backlog #35(a-i) and #38: watch-report fixes verified against small models.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildReportModel,
  parseGateLogProgress,
  renderCurrentRun,
  renderFindings,
  renderImplementationStage,
  renderPipelineState,
  renderReport,
} from "./watch-report.mjs";
import { readGateLogTail } from "./run-history.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
};

const run = (o) => ({ status: "completed", decision: null, findings: [], ...o });
const lines = (text) => String(text).split("\n");
const row = (text, needle) => lines(text).find((l) => l.includes(needle)) || "";

// ── #35e: no blank line between the section header and Phase 1 ──────────────
{
  const phases = [
    { number: 1, name: "Phase 1 — One", done: true, tasks: [{ text: "T1.1", done: true }] },
    { number: 2, name: "Phase 2 — Two", done: false, tasks: [{ text: "T2.1", done: false }] },
  ];
  const runs = [
    run({ id: "01-implementer-a", dirName: "01-implementer-a", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", started_at: "2026-10-19T10:00:00+00:00" }),
    run({ id: "02-implementer-b", dirName: "02-implementer-b", role: "implementer", phase: "2", attempt: "1", taskRef: "T1.1", started_at: "2026-10-19T10:05:00+00:00" }),
  ];
  const model = buildReportModel({ state: { phase: "implementing", phaseIndex: 1, attempt: 1 }, runs, events: [], phases, policy: {}, now: "2026-10-19T10:10:00+00:00" });
  const out = lines(renderImplementationStage(model));
  check("e: section header first", out[0] === "=== IMPLEMENTATION STAGE ===", out.slice(0, 2));
  check("e: phase 1 directly under the header", out[1].startsWith("  Phase 1/2"), out.slice(0, 2));
  const phase2 = out.findIndex((l) => l.startsWith("  Phase 2/2"));
  check("e: one blank line before phase 2", phase2 > 0 && out[phase2 - 1] === "" && out[phase2 - 2] !== "", out.slice(Math.max(0, phase2 - 2), phase2 + 1));
}

// ── #35g/#35f: attempt table and everything under it move two columns ───────
{
  const phases = [{ number: 1, name: "Phase 1 — Work", done: false, tasks: [{ text: "T1.1", done: false }, { text: "T1.2", done: false }] }];
  const runs = [
    run({ id: "01-implementer-a", dirName: "01-implementer-a", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", started_at: "2026-10-19T10:00:00+00:00" }),
    run({ id: "02-verifier-a", dirName: "02-verifier-a", role: "verifier", phase: "1", attempt: "1", taskRef: "T1.1", decision: "FAIL", findings: ["T1.1: one", "T1.2: two", "T1.2: three"], carriedForwardTasks: ["T1.2"], started_at: "2026-10-19T10:05:00+00:00" }),
    run({ id: "03-implementer-b", dirName: "03-implementer-b", role: "implementer", phase: "1", attempt: "2", taskRef: "T1.2", status: "running", started_at: "2026-10-19T10:10:00+00:00" }),
  ];
  const model = buildReportModel({ state: { phase: "implementing", step: "implement", phaseIndex: 0, attempt: 2 }, runs, events: [], phases, policy: { continuation_allowance: 5 }, now: "2026-10-19T10:20:00+00:00" });
  const impl = renderImplementationStage(model);
  const tableHeader = row(impl, "ROLE");
  check("g: attempt header stays at four", impl.includes("\n    Attempt 1  ✗ DENIED"), row(impl, "Attempt 1"));
  check("g: attempt table starts two deeper", tableHeader.startsWith("      ROLE"), tableHeader);
  check("g: running marker moves with the table", row(impl, "03-implementer-b").startsWith("    › 03-implementer-b"), row(impl, "03-implementer-b"));
  check("g: findings move with the table", row(impl, "findings →").startsWith("        findings →"), row(impl, "findings →"));
  check("g: second finding aligns under the first body", row(impl, "2. T1.2: two").startsWith(" ".repeat(19) + "2. T1.2: two"), row(impl, "2. T1.2: two"));
  check("f: overflow starts under 2.", row(impl, "+1 more →").startsWith(" ".repeat(19) + "+1 more →"), row(impl, "+1 more →"));
  check("g: carried forward moves with the table", row(impl, "carried forward →").startsWith("        carried forward →"), row(impl, "carried forward →"));
  const next = row(impl, "next:");
  check("g: next line moves with the table", next.startsWith("      next:"), next);
  const direct = renderFindings(["a", "b", "c", "d"]);
  check("f: default findings overflow sits under 2.", direct[2].startsWith(" ".repeat(17) + "+2 more →"), direct[2]);
}

// ── #35d/#35b: CURRENT RUN name and snapshot format ─────────────────────────
{
  const runs = [run({
    id: "0022b8e2-af81-4c8b-976a-3f3de23de7e6", dirName: "77-implementer-0022b8e2", role: "implementer",
    phase: "4", attempt: "1", taskRef: "T4.1", status: "running", pid: process.pid,
    started_at: "2026-10-19T10:00:00+00:00", snapshotBeforeAt: "2026-10-19T10:00:00.900Z",
    updated_at: "2026-10-19T10:01:00+00:00", usage: { priceWeighted: 1000, turns: 2 },
  })];
  const model = buildReportModel({ state: { phase: "implementing", step: "implement", phaseIndex: 3, attempt: 1 }, runs, events: [], phases: [{ number: 4, name: "Phase 4", done: false, tasks: [{ text: "T4.1" }] }], policy: {}, now: "2026-10-19T10:02:00+00:00" });
  const text = renderCurrentRun(model);
  check("d: run line uses the row name", text.includes("run:     77-implementer-0022b8e2"), row(text, "run:"));
  check("d: run line does not use the bare uuid", !text.includes("run:     0022b8e2-af81"), row(text, "run:"));
  check("b: sub-minute snapshot uses seconds", text.includes("(pre-run snapshot 0.9s)"), row(text, "started:"));
  const long = buildReportModel({
    state: { phase: "implementing", phaseIndex: 3, attempt: 1 },
    runs: [run({ id: "r", dirName: "78-implementer-x", role: "implementer", phase: "4", attempt: "1", taskRef: "T4.1", status: "running", pid: process.pid, started_at: "2026-10-19T10:00:00+00:00", snapshotBeforeAt: "2026-10-19T10:02:07+00:00", updated_at: "2026-10-19T10:03:00+00:00" })],
    events: [], phases: [{ number: 4, name: "Phase 4", done: false, tasks: [{ text: "T4.1" }] }], policy: {}, now: "2026-10-19T10:03:00+00:00",
  });
  check("b: minute snapshot keeps m:ss", renderCurrentRun(long).includes("(pre-run snapshot 2:07)"), row(renderCurrentRun(long), "started:"));
}

// ── #35h: gate progress comes from the log tail ─────────────────────────────
{
  const log = [
    "PASS     0.3s  test-a.mjs  [71/365]",
    "PASS     0.4s  test-b.mjs  [72/365]",
    "TEST FAILED: test-broken.mjs  [73/365]",
  ].join("\n");
  const parsed = parseGateLogProgress(log);
  check("h: parser reads file progress", parsed && parsed.total === 365 && parsed.passed === 72 && parsed.failed === 1, parsed);
  const model = buildReportModel({
    state: { phase: "implementing", step: "gate", phaseIndex: 0, attempt: 1 },
    runs: [], phases: [{ number: 1, name: "Phase 1", done: false, tasks: [{ text: "T1.1" }] }], policy: {},
    events: [{ type: "gate_start", phase: 1, command: "node scripts/test-all.mjs", at: "2026-10-19T10:00:00+00:00" }],
    gateLog: log, now: "2026-10-19T10:05:00+00:00",
  });
  const text = renderCurrentRun(model);
  check("h: CURRENT RUN prints files/passed/failed", text.includes("progress: 73/365 files · 72 passed · 1 failed"), row(text, "progress:"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-b1-gate-"));
  const gateDir = path.join(root, ".autopilot", "missions", "m", "gates");
  fs.mkdirSync(gateDir, { recursive: true });
  fs.writeFileSync(path.join(gateDir, "phase-1-old.log"), log);
  fs.writeFileSync(path.join(gateDir, "phase-1-new.log"), `${log}\nPASS 0.1s test-z.mjs [80/365]\n`);
  const tail = readGateLogTail(root, "m", 1);
  check("h: tail reader picks the newest phase log", typeof tail === "string" && tail.includes("[80/365]"), tail);
  check("h: tail reader only reads the tail", readGateLogTail(root, "m", 1, { bytes: 40 }).length <= 40, readGateLogTail(root, "m", 1, { bytes: 40 }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ── #35a: lasting killed reason and retry note ──────────────────────────────
{
  const phases = [{ number: 1, name: "Phase 1 — Work", done: false, tasks: [{ text: "T1.1" }] }];
  const runs = [
    run({ id: "75-implementer-a", dirName: "75-implementer-a", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", status: "interrupted", sessionNumber: 3, started_at: "2026-10-19T10:00:00+00:00", interrupted_at: "2026-10-19T10:05:00+00:00", interruption_reason: "received SIGTERM" }),
    run({ id: "76-implementer-b", dirName: "76-implementer-b", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", status: "capped", sessionNumber: 3, started_at: "2026-10-19T11:00:00+00:00" }),
    run({ id: "77-implementer-c", dirName: "77-implementer-c", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", status: "interrupted", sessionNumber: 4, started_at: "2026-10-19T12:00:00+00:00", interrupted_at: "2026-10-19T12:01:00+00:00" }),
    run({ id: "78-implementer-d", dirName: "78-implementer-d", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", status: "running", sessionNumber: 4, started_at: "2026-10-19T12:02:00+00:00" }),
  ];
  const events = [{ type: "orchestrator_exit", signal: "SIGTERM", at: "2026-10-19T12:00:30+00:00" }];
  const model = buildReportModel({ state: { phase: "implementing", step: "implement", phaseIndex: 0, attempt: 1, ownerAlive: true }, runs, events, phases, policy: {}, now: "2026-10-19T12:03:00+00:00" });
  const impl = renderImplementationStage(model);
  check("a: interrupted run keeps a lasting reason", row(impl, "75-implementer-a").includes("orchestrator killed"), row(impl, "75-implementer-a"));
  check("a: next same-session run reads retry", row(impl, "76-implementer-b").includes("retry"), row(impl, "76-implementer-b"));
  check("a: exit event is a lasting reason too", row(impl, "77-implementer-c").includes("orchestrator killed"), row(impl, "77-implementer-c"));
  check("a: first run of a new session is not a retry", !row(impl, "77-implementer-c").includes("retry"), row(impl, "77-implementer-c"));
}

// ── #35c: elapsed excludes the orchestration downtime ───────────────────────
{
  const runs = [
    run({ id: "01", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", status: "interrupted", started_at: "2026-10-19T10:00:00+00:00", interrupted_at: "2026-10-19T10:30:00+00:00", interruption_reason: "received SIGTERM" }),
    run({ id: "02", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", started_at: "2026-10-19T11:30:00+00:00" }),
  ];
  const state = { phase: "implementing", phaseIndex: 0, attempt: 1, planningStartedAt: "2026-10-19T10:00:00+00:00" };
  const phases = [{ number: 1, name: "Phase 1", done: false, tasks: [{ text: "T1.1" }] }];
  const model = buildReportModel({ state, runs, events: [], phases, policy: {}, now: "2026-10-19T12:00:00+00:00" });
  const line = row(renderPipelineState(model), "Total:");
  check("c: elapsed subtracts the downtime", line.includes("elapsed 01:00:00"), line);
  check("c: computed elapsed is not labelled wall", !line.includes("elapsed 01:00:00 wall"), line);
  const wall = buildReportModel({ state: { ...state, planningStartedAt: "2026-10-19T10:00:00+00:00" }, runs: [run({ id: "03", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", started_at: "2026-10-19T10:00:00+00:00" })], events: [], phases, policy: {}, now: "2026-10-19T12:00:00+00:00" });
  check("c: no interruption data says wall", row(renderPipelineState(wall), "Total:").includes("elapsed 02:00:00 wall"), row(renderPipelineState(wall), "Total:"));
}

// ── #35i: attempts count by budget, and a verify PASS closes the phase ──────
{
  const phases = [
    { number: 1, name: "Phase 1", done: true, tasks: [] },
    { number: 2, name: "Phase 2", done: true, tasks: [] },
    { number: 3, name: "Phase 3", done: true, tasks: [] },
    { number: 4, name: "Phase 4 — Work", done: false, tasks: [{ text: "T4.1" }] },
  ];
  const runs = [];
  for (let i = 1; i <= 14; i++) {
    runs.push(run({ id: `${i}-implementer-x`, dirName: `${i}-implementer-x`, role: "implementer", phase: "4", attempt: String(i), taskRef: "T4.1", started_at: `2026-10-20T00:${String(i).padStart(2, "0")}:00+00:00` }));
    if (i === 1 || i === 4) runs.push(run({ id: `${i}b-code_reviewer-x`, dirName: `${i}b-code_reviewer-x`, role: "code_reviewer", phase: "4", attempt: String(i), taskRef: "T4.1", decision: "FAIL", started_at: `2026-10-20T00:${String(i).padStart(2, "0")}:30+00:00` }));
    if (i === 7) runs.push(run({ id: "7b-verifier-x", dirName: "7b-verifier-x", role: "verifier", phase: "4", attempt: "7", taskRef: "T4.1", decision: "FAIL", started_at: "2026-10-20T00:07:30+00:00" }));
  }
  runs.push(run({ id: "13b-code_reviewer-x", dirName: "13b-code_reviewer-x", role: "code_reviewer", phase: "4", attempt: "13", taskRef: "T4.1", decision: "PASS", started_at: "2026-10-20T00:13:30+00:00" }));
  runs.push(run({ id: "14b-verifier-x", dirName: "14b-verifier-x", role: "verifier", phase: "4", attempt: "14", taskRef: "T4.1", decision: "PASS", started_at: "2026-10-20T00:14:30+00:00" }));
  const state = { phase: "implementing", step: "implement", phaseIndex: 3, attempt: 14, failureBudgets: { "implementationFailureBudget:task:standalone:phase-3": 2, "verificationFailureBudget:task:standalone:phase-3": 1 } };
  const policy = { failure_budgets: { implementationFailureBudget: 3, verificationFailureBudget: 3 } };
  const model = buildReportModel({ state, runs, events: [], phases, policy, now: "2026-10-20T00:20:00+00:00" });
  const report = renderReport(model, { stamp: "2026-10-20 00:20:00" });
  const impl = renderImplementationStage(model);
  check("i: phase is PASSED after verify approval", row(impl, "Phase 4/4").includes("✓ PASSED"), row(impl, "Phase 4/4"));
  check("i: recorded 14 collapses to four budget attempts", impl.includes("Attempt 4  ✓ PASSED") && !impl.includes("Attempt 14"), lines(impl).filter((l) => l.includes("Attempt")));
  check("i: header never says attempt 14 of 4", !report.includes("attempt 14 of 4"), row(report, "Stage:"));
  check("i: header shows attempt 4 of 4", row(report, "Stage:").includes("attempt 4 of 4"), row(report, "Stage:"));
}

// ── #38: budgets show the current scope plus earlier spend ──────────────────
{
  const state = {
    phase: "implementing", step: "implement", phaseIndex: 3, attempt: 1,
    failureBudgets: {
      "implementationFailureBudget:task:standalone:phase-0": 2,
      "implementationFailureBudget:task:standalone:phase-1": 2,
      "implementationFailureBudget:task:standalone:phase-2": 1,
      "verificationFailureBudget:task:standalone:phase-3": 1,
      "adapterRetryBudget:adapter:a:verifier": 1,
      "adapterRetryBudget:adapter:b:verifier": 2,
    },
  };
  const policy = { failure_budgets: { implementationFailureBudget: 3, verificationFailureBudget: 3, adapterRetryBudget: 2, infrastructureRetryBudget: 2 } };
  const model = buildReportModel({ state, runs: [], events: [], phases: [], policy });
  const line = row(renderPipelineState(model), "Budgets:");
  check("38: current phase spend only, earlier separately", line.includes("implementation=0/3 (5 in earlier phases)"), line);
  check("38: current verification scope is 1/3", line.includes("verification=1/3"), line);
  check("38: worst live adapter scope", line.includes("adapter=2/2"), line);
  check("38: adapter earlier spend is not summed", !line.includes("adapter=3/2"), line);
}

if (failures.length) { console.error(`${failures.length} B1 check(s) failed.`); process.exit(1); }
console.log("All B1 watch-report checks passed.");
