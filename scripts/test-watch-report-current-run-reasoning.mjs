#!/usr/bin/env node
// Backlog #7: CURRENT RUN role line shows the run's reasoning level after the
// model ("· model X · reasoning high"); omitted when none; variant likewise.
import { buildReportModel, renderCurrentRun } from "./watch-report.mjs";
import { initRun } from "./run-observability.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
};

const state = { mission: "m", phase: "planning", step: "plan", phaseIndex: 0, attempt: 1 };
const base = {
  id: "01-planner-abc", dirName: "01-planner-abc", role: "planner", phase: "1", attempt: "0",
  taskRef: "speckit-planning-planner", status: "running", findings: [], decision: null,
  configuredModel: "deepseek-v4.1-flash-free", started_at: "2026-09-29T01:00:00+03:00",
};
const render = (extra) => {
  const model = buildReportModel({ state, runs: [{ ...base, ...extra }], phases: [{ number: 1, name: "P", tasks: [] }], policy: {}, now: "2026-09-29T01:05:00+03:00" });
  return renderCurrentRun(model);
};
const roleLine = (text) => text.split("\n").find((l) => l.startsWith("role:")) ?? "";

{
  const line = roleLine(render({ reasoning: "high" }));
  check("reasoning high shown after model", /· model deepseek-v4\.1-flash-free · reasoning high$/.test(line), line);
}
{
  const line = roleLine(render({ reasoning: null }));
  check("no reasoning: no reasoning part", !/reasoning/.test(line) && /· model deepseek-v4\.1-flash-free$/.test(line), line);
}
{
  const line = roleLine(render({}));
  check("older run without field renders as before", !/reasoning|variant/.test(line) && /task speckit-planning-planner · model deepseek-v4\.1-flash-free$/.test(line), line);
}
{
  const line = roleLine(render({ reasoning: "high", variant: "max" }));
  check("variant shown after reasoning", /· reasoning high · variant max$/.test(line), line);
}
// Disk path: status.json written by initRun carries reasoning into the report.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-reasoning-"));
  try {
    initRun(dir, { role: "planner", runId: "r1", configuredModel: "m1", reasoning: "medium" });
    const st = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8"));
    check("initRun persists reasoning", st.reasoning === "medium" && st.variant === null, st);
    const line = roleLine(render({ dir, configuredModel: "m1" }));
    check("report reads reasoning from status.json", /· model m1 · reasoning medium$/.test(line), line);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

if (failures.length) { console.error(`\n${failures.length} FAILED`); process.exit(1); }
console.log("\nAll passed");
