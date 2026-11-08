#!/usr/bin/env node
// Backlog #11: a SpecKit mission's final-review runs (recorded with a phase
// number past the last real phase, taskRef null, a stale `task` group) render
// under FINAL REVIEW, never as a fake extra phase, and show no task ref.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildReportModel, renderReport } from "./watch-report.mjs";
import { resolveMissionPhases } from "./run-history.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
};

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "speckit-final-review-"));
const feature = path.join(repo, "specs", "002-feature");
fs.mkdirSync(feature, { recursive: true });
let tasks = "# Tasks\n\n";
for (let p = 1; p <= 13; p++) {
  tasks += `## Phase ${p}: Work ${p}\n\n- [x] T${String(p).padStart(3, "0")} Do thing ${p}\n\n`;
}
fs.writeFileSync(path.join(feature, "tasks.md"), tasks);

const state = {
  mission: "002-feature", phase: "final_review", step: "final_review", phaseIndex: 12,
  planningDetection: { framework: "speckit" }, speckitFeatureDir: "002-feature",
};
const phases = resolveMissionPhases(repo, "002-feature", { project: { planning_framework: "speckit" } }, state);
check("fixture resolves 13 phases", phases.length === 13, phases.length);

const t = (n) => `2026-11-08T10:${String(n).padStart(2, "0")}:00.000Z`;
const runs = [];
for (let p = 1; p <= 13; p++) {
  runs.push({ id: `impl-${p}`, dirName: `${p}-implementer`, role: "implementer", status: "completed", phase: String(p), task: `T${String(p).padStart(3, "0")}`, taskRef: `T${String(p).padStart(3, "0")}`, attempt: 1, started_at: t(p), duration_ms: 1000 });
}
// Final review: phase "14", no taskRef, stale task group.
runs.push({ id: "fr-1", dirName: "659-code_reviewer", role: "code_reviewer", status: "completed", decision: "CHANGES_REQUESTED", phase: "14", task: "T037", taskRef: null, attempt: 1, started_at: t(20), duration_ms: 1000 });
runs.push({ id: "fr-2", dirName: "660-implementer", role: "implementer", status: "running", phase: "14", task: "T037", taskRef: null, attempt: 1, started_at: t(30) });

const model = buildReportModel({ state, runs, events: [], phases, policy: {} });
const text = renderReport(model, { stamp: "2026-11-08T11:00:00.000Z" });

check("no Phase 14 anywhere", !/Phase 14/.test(text), text.match(/.*Phase 14.*/)?.[0]);
check("real phases read Phase 13/13", /Phase 13\/13/.test(text) && !/\/14/.test(text));
check("model has 13 phases", model.phases.length === 13, model.phases.length);
check("final-review runs are in the final review", model.finalReview.runs.map((r) => r.id).sort().join() === "fr-1,fr-2", model.finalReview.runs.map((r) => r.id));
check("final-review section rendered", /=== FINAL REVIEW STAGE ===/.test(text));
check("no phase holds a final-review run", model.phases.every((p) => !p.runs.some((r) => r.id.startsWith("fr-"))));
check("final-review rows carry no task T037", !/T037/.test(text), text.match(/.*T037.*/)?.[0]);
check("current run shows no task ref", model.current?.role === "implementer" && model.current.taskRef == null, model.current);

// Standalone-style fixture: final review with no stale task keeps landing in FINAL REVIEW.
{
  const sPhases = [{ number: 1, name: "Phase 1 — Work", done: true, tasks: [{ text: "T1.1", done: true }] }];
  const sRuns = [
    { id: "a", role: "implementer", status: "completed", phase: "1", task: "T1.1", taskRef: "T1.1", attempt: 1, started_at: t(1), duration_ms: 1 },
    { id: "b", role: "code_reviewer", status: "completed", decision: "PASS", phase: "2", taskRef: null, attempt: 1, started_at: t(5), duration_ms: 1 },
  ];
  const m = buildReportModel({ state: { mission: "m", phase: "complete" }, runs: sRuns, events: [], phases: sPhases, policy: {} });
  check("standalone: 1 phase", m.phases.length === 1, m.phases.length);
  check("standalone: final review holds run b", m.finalReview.runs.map((r) => r.id).join() === "b");
  check("standalone: phase 1 keeps run a", m.phases[0].runs.map((r) => r.id).join() === "a");
}

// Escalated during the final review: phaseIndex (0-based) is past the last phase.
{
  const escState = { ...state, phase: "implementing", step: "implementing", status: "escalated", phaseIndex: 13 };
  const finished = runs.map((r) => (r.status === "running" ? { ...r, status: "failed" } : r));
  const m = buildReportModel({ state: escState, runs: finished, events: [], phases, policy: {} });
  const out = renderReport(m, { stamp: "2026-11-08T11:00:00.000Z" });
  const stageLine = out.split("\n").find((l) => /^Stage:/.test(l)) ?? "";
  check("escalated: stage is FINAL REVIEW", m.stage === "FINAL REVIEW", m.stage);
  check("escalated: Stage line says FINAL REVIEW", /FINAL REVIEW/.test(stageLine), stageLine);
  check("escalated: no Phase 14/13", !/Phase 14\/13/.test(out));
  check("escalated: no IMPLEMENTATION stage line", !/IMPLEMENTATION —/.test(stageLine), stageLine);

  // Same via the passed-phases rule (phaseIndex still inside the list).
  const m2 = buildReportModel({ state: { ...escState, phaseIndex: 12 }, runs: finished, events: [], phases, policy: {} });
  check("all real phases passed + final-review runs: FINAL REVIEW", m2.stage === "FINAL REVIEW", m2.stage);
}

// Regression (backlog #11 follow-up): phaseIndex >= phases.length with incomplete
// phase list (no final-review runs) must NOT classify as FINAL REVIEW.
{
  const partialPhases = [{ number: 2, name: "Phase 2", done: false, tasks: [], runs: [runs[1]], status: "in_progress" }];
  const m = buildReportModel({
    state: { mission: "002-feature", phase: "implementing", step: "implementing", phaseIndex: 1 },
    runs: [runs[1]],
    events: [],
    phases: partialPhases,
    policy: {},
  });
  check("incomplete phases without final review runs stays IMPLEMENTATION", m.stage === "IMPLEMENTATION", m.stage);
}

fs.rmSync(repo, { recursive: true, force: true });
if (failures.length) {
  console.error(`\nFAILED (${failures.length}): ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nAll checks passed.");
