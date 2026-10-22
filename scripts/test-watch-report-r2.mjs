#!/usr/bin/env node
// Mission R2 follow-ups: three report bugs plus workspace-neutral backlog items.
//   a) only the LAST attempt of a still-running phase carries the mission's
//      terminal marker; an earlier attempt that ended normally reads
//      `→ fixes done` (never the mission STOPPED/CANCELLED/ESCALATED).
//   b) an attempt's verdict follows the LAST review in time order (a PASS after
//      an earlier FAIL is a PASS).
//   c) each run's `findings →` block sits directly under its own row.
//   #8 the Implementation stage names the mission's real phases (TASKS.md).
//   #9 exactly one `next:` line under the running phase's table.
//   #7 nothing renders before it starts (no PENDING rows, no NOT STARTED, no
//      stage header before the stage begins).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildReportModel, renderImplementationStage, renderReport } from "./watch-report.mjs";
import { writeWatchReportFile } from "./run-history.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
};

const run = (o) => ({ status: "completed", decision: null, findings: [], ...o });

// ── a. terminal marker only on the last attempt of a running phase ───────────
{
  const state = { mission: "r2-a", phase: "idle", step: "implement", phaseIndex: 0, attempt: 2, planningDetection: { framework: "standalone" } };
  const phases = [{ number: 1, name: "Phase 1 — Work", done: false, tasks: [{ text: "T1.1", done: false }, { text: "T1.2", done: false }] }];
  const runs = [
    run({ id: "01-implementer-a", dirName: "01-implementer-a", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", started_at: "2026-10-19T10:00:00+00:00", usage: { priceWeighted: 50000 } }),
    run({ id: "01b-verifier-a", dirName: "01b-verifier-a", role: "verifier", phase: "1", attempt: "1", taskRef: "T1.1", decision: "FAIL", started_at: "2026-10-19T10:05:00+00:00" }),
    run({ id: "02-implementer-b", dirName: "02-implementer-b", role: "implementer", phase: "1", attempt: "2", taskRef: "T1.2", status: "interrupted", started_at: "2026-10-19T10:10:00+00:00", usage: { priceWeighted: 30000 } }),
  ];
  const model = buildReportModel({ state, runs, events: [], phases, policy: {}, now: "2026-10-19T10:20:00+00:00" });
  check("a: mission STOPPED", model.status === "STOPPED", model.status);
  const impl = renderImplementationStage(model);
  check("a: earlier attempt reads DENIED", /\n    Attempt 1  ✗ DENIED by verifier · 50K/.test(impl), impl.split("\n").find((l) => l.includes("Attempt 1")));
  check("a: earlier attempt not STOPPED", !/Attempt 1  ■ STOPPED/.test(impl), impl);
  check("a: last attempt reads STOPPED", /\n    Attempt 2  ■ STOPPED · 30K \(resumable\)/.test(impl), impl.split("\n").find((l) => l.includes("Attempt 2")));
}

// ── b. the last review in time order decides the attempt ─────────────────────
{
  const state = { mission: "r2-b", phase: "implementing", step: "implement", phaseIndex: 0, attempt: 1, planningDetection: { framework: "standalone" } };
  const phases = [{ number: 1, name: "Phase 1 — Work", done: false, tasks: [{ text: "T1.1", done: false }] }];
  const runs = [
    run({ id: "48-implementer-0", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", started_at: "2026-10-19T09:55:00+00:00", usage: { priceWeighted: 5000 } }),
    run({ id: "48b-verifier-0", role: "verifier", phase: "1", attempt: "1", taskRef: "T1.1", decision: "FAIL", started_at: "2026-10-19T09:58:00+00:00" }),
    run({ id: "49-code_reviewer-a", role: "code_reviewer", phase: "1", attempt: "2", taskRef: "T1.1", decision: "PASS", started_at: "2026-10-19T10:00:00+00:00", usage: { priceWeighted: 10000 } }),
    run({ id: "50-verifier-b", role: "verifier", phase: "1", attempt: "2", taskRef: "T1.1", decision: "FAIL", findings: ["T1.1: still broken"], started_at: "2026-10-19T10:05:00+00:00", usage: { priceWeighted: 10000 } }),
    run({ id: "51-verifier-c", role: "verifier", phase: "1", attempt: "2", taskRef: "T1.1", decision: "PASS", started_at: "2026-10-19T10:10:00+00:00", usage: { priceWeighted: 10000 } }),
  ];
  const model = buildReportModel({ state, runs, events: [], phases, policy: {}, now: "2026-10-19T10:20:00+00:00" });
  check("b: attempt result follows the last review", model.phases[0].attempts[1].result === "PASS", model.phases[0].attempts[1].result);
  const impl = renderImplementationStage(model);
  check("b: attempt header reads PASSED", /\n    Attempt 2  ✓ PASSED · 30K/.test(impl), impl.split("\n").find((l) => l.includes("Attempt 2")));
  check("b: attempt not DENIED", !/Attempt 2  ✗ DENIED/.test(impl), impl.split("\n").find((l) => l.includes("Attempt 2")));
  // The mirror case: a FAIL after a PASS is still DENIED.
  const flip = buildReportModel({
    state, phases, events: [], policy: {}, now: "2026-10-19T10:20:00+00:00",
    runs: [
      run({ id: "49b", role: "verifier", phase: "1", attempt: "1", taskRef: "T1.1", decision: "PASS", started_at: "2026-10-19T10:00:00+00:00" }),
      run({ id: "50b", role: "verifier", phase: "1", attempt: "1", taskRef: "T1.1", decision: "FAIL", started_at: "2026-10-19T10:05:00+00:00" }),
    ],
  });
  check("b: later FAIL is DENIED", flip.phases[0].attempts[0].result === "DENIED", flip.phases[0].attempts[0].result);
}

// ── c. findings sit under their own run row ──────────────────────────────────
{
  const state = { mission: "r2-c", phase: "implementing", step: "implement", phaseIndex: 0, attempt: 1, planningDetection: { framework: "standalone" } };
  const phases = [{ number: 1, name: "Phase 1 — Work", done: false, tasks: [{ text: "T1.1", done: false }, { text: "T1.2", done: false }] }];
  const runs = [
    run({ id: "01-implementer-a", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", started_at: "2026-10-19T10:00:00+00:00" }),
    run({ id: "02-verifier-b", role: "verifier", phase: "1", attempt: "1", taskRef: "T1.1 > T1.2", decision: "FAIL", findings: ["T1.2: missing fixture"], started_at: "2026-10-19T10:05:00+00:00" }),
    run({ id: "03-implementer-c", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.2", started_at: "2026-10-19T10:10:00+00:00" }),
  ];
  const model = buildReportModel({ state, runs, events: [], phases, policy: {}, now: "2026-10-19T10:20:00+00:00" });
  const impl = renderImplementationStage(model);
  const rowB = impl.indexOf("02-verifier-b");
  const finding = impl.indexOf("findings → 1. T1.2: missing fixture");
  const rowC = impl.indexOf("03-implementer-c");
  check("c: findings after their own row", rowB >= 0 && finding > rowB, { rowB, finding });
  check("c: findings before the next row", finding > 0 && rowC > finding, { finding, rowC });
}

// ── #8/#9/#7 through writeWatchReportFile with a 4-phase TASKS.md ────────────
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-r2-"));
  const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
  const mission = "500-r2-layout";

  write(path.join(root, ".autopilot", "state.json"), JSON.stringify({
    phase: "implementing", step: "implement", mission, phaseIndex: 0, attempt: 1,
    planningDetection: { framework: "standalone", status: "complete" },
  }, null, 2));
  write(path.join(root, ".autopilot", "config.json"), JSON.stringify({
    policy: { failure_budgets: { implementationFailureBudget: 3 }, caps: { implementer: { max_tokens: 500000 } } },
  }, null, 2));
  write(path.join(root, ".autopilot", "missions", mission, "TASKS.md"), [
    "## Phase 1: New format — layout and schema",
    "- [ ] **1.1** Build the layout",
    "- [ ] **1.2** Wire the reader",
    "- [ ] **1.3** Test the migration",
    "",
    "## Phase 2: Reader compatibility",
    "- [ ] **2.1** Old names",
    "",
    "## Phase 3: Validation",
    "- [ ] **3.1** Validate",
    "",
    "## Phase 4: Docs",
    "- [ ] **4.1** Document",
  ].join("\n") + "\n");
  const runDir = path.join(root, ".autopilot", "missions", mission, "runs", "01-implementer-r2");
  fs.mkdirSync(runDir, { recursive: true });
  write(path.join(runDir, "status.json"), JSON.stringify({
    status: "running", run_id: "00000000-0000-0000-0000-000000000001", role: "implementer",
    phase: "1", attempt: "1", taskRef: "T1.1", pid: process.pid, started_at: "2026-10-19T10:00:00+00:00",
    updated_at: "2026-10-19T10:05:00+00:00", usage: { priceWeighted: 12345, turns: 3 },
  }, null, 2));
  write(path.join(root, ".autopilot", "missions", mission, "watch-events.jsonl"), "");

  const outFile = writeWatchReportFile(root, mission, { outFile: path.join(root, "report.txt") });
  const report = fs.readFileSync(outFile, "utf8");

  // #8: the real phase list, named and totalled.
  check("8: phase named from TASKS.md", report.includes("  Phase 1/4 — New format — layout and schema"), report.split("\n").find((l) => l.includes("Phase 1/4")));
  check("8: later phase not shown", !report.includes("Phase 4/4"), report.split("\n").find((l) => l.includes("Phase 4")));

  // #9: one next: line naming the next task, one blank line either side.
  check("9: next line names the next task", report.includes("next: T1.2 (+1 more task) → phase review → full test suite → phase verify"), report.split("\n").find((l) => l.includes("next:")));
  check("9: one blank line before next", /\n\n    next: T1\.2/.test(report), report);
  check("9: exactly one next line", (report.match(/^    next:/gm) || []).length === 1, report);

  // #7: nothing before it starts.
  check("7: no PENDING rows", !report.includes("PENDING"), report);
  check("7: no NOT STARTED marker", !report.includes("○ NOT STARTED"), report);
  check("7: no Final review header", !report.includes("FINAL REVIEW STAGE"), report);
  check("7: no Planning header", !report.includes("PLANNING STAGE"), report);

  fs.rmSync(root, { recursive: true, force: true });
}

// ── #7: a planning-only model renders no later-stage headers ─────────────────
{
  const model = buildReportModel({
    state: { mission: "r2-plan", phase: "planning", step: "plan", phaseIndex: 0, attempt: 1, planningDetection: { framework: "standalone" } },
    runs: [], events: [], phases: [{ number: 1, name: "Phase 1", tasks: [{ text: "T1.1", done: false }] }], policy: {},
  });
  const report = renderReport(model, { stamp: "2026-10-19 10:00:00" });
  check("7: planning-only has no Implementation header", !report.includes("IMPLEMENTATION STAGE"), report);
  check("7: planning-only has no Final review header", !report.includes("FINAL REVIEW STAGE"), report);
  check("7: planning-only has no NOT STARTED", !report.includes("NOT STARTED"), report);
}

if (failures.length) { console.error(`${failures.length} R2 check(s) failed.`); process.exit(1); }
console.log("All R2 watch-report checks passed.");
