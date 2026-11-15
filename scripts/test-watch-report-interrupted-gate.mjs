#!/usr/bin/env node
import { buildReportModel, renderReport } from "./watch-report.mjs";

const failures = [];
const check = (name, cond, detail) => {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  }
};

const phases = [
  { number: 1, name: "Setup", tasks: [{ ref: "T1.1", text: "first task", done: true }], done: false },
];

// 1. start / start / result in one phase -> first gate INTERRUPTED without arrow, second PASS
{
  const model = buildReportModel({
    state: { mission: "001-demo", phase: "implement" },
    ownerAlive: true,
    phases,
    runs: [
      { id: "01", role: "implementer", phase: 1, attempt: 1, taskRef: "T1.1", status: "completed", started_at: "2026-11-14T10:00:00Z", finished_at: "2026-11-14T10:05:00Z" },
    ],
    events: [
      { type: "gate_start", phase: 1, command: "npm test", at: "2026-11-14T10:06:00Z" },
      { type: "gate_start", phase: 1, command: "npm test", at: "2026-11-14T10:30:00Z" },
      { type: "gate_result", phase: 1, ok: true, durationMs: 12000, at: "2026-11-14T10:30:12Z" },
    ],
    now: "2026-11-14T11:00:00Z",
  });
  const text = renderReport(model, { stamp: "2026-11-14 11:00:00" });
  const gateLines = text.split("\n").filter((l) => l.includes("GATE (orchestrator)"));
  check("start/start/result: two gate rows", gateLines.length === 2, gateLines);
  check("start/start/result: first gate is INTERRUPTED", gateLines[0]?.includes("INTERRUPTED"), gateLines[0]);
  check("start/start/result: first gate has no arrow", !/^\s*›/.test(gateLines[0] || ""), gateLines[0]);
  check("start/start/result: first gate has no live duration", !gateLines[0]?.includes("00:54:00"), gateLines[0]);
  check("start/start/result: second gate is PASS", gateLines[1]?.includes("PASS"), gateLines[1]);
}

// 2. start only + mission COMPLETED -> INTERRUPTED
{
  const model = buildReportModel({
    state: { mission: "001-demo", phase: "complete" },
    phases,
    runs: [
      { id: "01", role: "implementer", phase: 1, attempt: 1, taskRef: "T1.1", status: "completed", started_at: "2026-11-14T10:00:00Z", finished_at: "2026-11-14T10:05:00Z" },
    ],
    events: [
      { type: "gate_start", phase: 1, command: "npm test", at: "2026-11-14T10:06:00Z" },
    ],
    now: "2026-11-14T11:00:00Z",
  });
  const text = renderReport(model, { stamp: "2026-11-14 11:00:00" });
  const gateLines = text.split("\n").filter((l) => l.includes("GATE (orchestrator)"));
  check("completed mission: gate is INTERRUPTED", gateLines[0]?.includes("INTERRUPTED"), gateLines[0]);
  check("completed mission: gate has no arrow", !/^\s*›/.test(gateLines[0] || ""), gateLines[0]);
}

// 3. start only + dead owner -> INTERRUPTED and header not RUNNING
{
  const model = buildReportModel({
    state: { mission: "001-demo", phase: "implement" },
    ownerAlive: false,
    phases,
    runs: [
      { id: "01", role: "implementer", phase: 1, attempt: 1, taskRef: "T1.1", status: "completed", started_at: "2026-11-14T10:00:00Z", finished_at: "2026-11-14T10:05:00Z" },
    ],
    events: [
      { type: "gate_start", phase: 1, command: "npm test", at: "2026-11-14T10:06:00Z" },
    ],
    now: "2026-11-14T11:00:00Z",
  });
  const text = renderReport(model, { stamp: "2026-11-14 11:00:00" });
  const gateLines = text.split("\n").filter((l) => l.includes("GATE (orchestrator)"));
  check("dead owner: gate is INTERRUPTED", gateLines[0]?.includes("INTERRUPTED"), gateLines[0]);
  check("dead owner: header is STOPPED", /Status:\s+STOPPED/.test(text), text.slice(0, 300));
}

// 4. start only + owner alive + mission running -> RUNNING with arrow
{
  const model = buildReportModel({
    state: { mission: "001-demo", phase: "implement" },
    ownerAlive: true,
    phases,
    runs: [
      { id: "01", role: "implementer", phase: 1, attempt: 1, taskRef: "T1.1", status: "completed", started_at: "2026-11-14T10:00:00Z", finished_at: "2026-11-14T10:05:00Z" },
    ],
    events: [
      { type: "gate_start", phase: 1, command: "npm test", at: "2026-11-14T10:06:00Z" },
    ],
    now: "2026-11-14T10:16:00Z",
  });
  const text = renderReport(model, { stamp: "2026-11-14 10:16:00" });
  const gateLines = text.split("\n").filter((l) => l.includes("GATE (orchestrator)"));
  check("alive owner: gate is RUNNING", gateLines[0]?.includes("RUNNING"), gateLines[0]);
  check("alive owner: gate has arrow", /^\s*›/.test(gateLines[0] || ""), gateLines[0]);
  check("alive owner: gate shows live duration", gateLines[0]?.includes("00:10:00"), gateLines[0]);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
