#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildReportModel, renderReport, renderImplementationStage } from "./watch-report.mjs";
import { writeWatchReportFile, renderWatchReport } from "./run-history.mjs";
import { toNewLayoutConfig } from "./config-layout.mjs";
import { initRun } from "./run-observability.mjs";
import { rebuildSummary } from "./watch-summary.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
};

const run = (o) => ({ status: "completed", decision: null, findings: [], ...o });

function mkRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-f1-"));
  return repo;
}

function writeState(repo, mission, extra = {}) {
  const dir = path.join(repo, ".autopilot");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "missions", mission, "runs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({
    mission, phase: "implementing", step: "implement", phaseIndex: 0, attempt: 1,
    planningStartedAt: "2026-09-28T23:38:26+03:00", planningDetection: { framework: "standalone" },
    ...extra,
  }, null, 2));
}

function writeRuns(repo, mission) {
  const runsDir = path.join(repo, ".autopilot", "missions", mission, "runs");
  const pDir = path.join(runsDir, "01-planner-aaaaaaaa");
  fs.mkdirSync(pDir, { recursive: true });
  fs.writeFileSync(path.join(pDir, "status.json"), JSON.stringify({
    status: "completed", run_id: "p1", role: "planner", phase: null, taskRef: "plan/tasks",
    attempt: null, started_at: "2026-09-29T00:00:00+03:00", updated_at: "2026-09-29T00:01:00+03:00",
    planRevision: 1, resolvedModel: "muse", usage: { priceWeighted: 1000, turns: 1, peakContext: 1000 },
  }, null, 2));
  const iDir = path.join(runsDir, "02-implementer-bbbbbbbb");
  fs.mkdirSync(iDir, { recursive: true });
  fs.writeFileSync(path.join(iDir, "status.json"), JSON.stringify({
    status: "completed", run_id: "i1", role: "implementer", phase: "1", taskRef: "T1.1",
    attempt: 1, started_at: "2026-09-29T00:02:00+03:00", updated_at: "2026-09-29T00:03:00+03:00",
    sessionNumber: 1, resolvedModel: "muse", usage: { priceWeighted: 2000, turns: 2, peakContext: 2000 },
  }, null, 2));
}

const runtimeConfig = {
  roles: { planner: { adapter: "", model: "", reasoning: "", variant: "", resume: true } },
  policy: {
    max_plan_revisions: 8,
    continuation_allowance: 5,
    caps: {
      planner: { max_tokens: 200000, wrap_up_tokens_threshold: 180000 },
      plan_reviewer: { max_tokens: 150000, wrap_up_tokens_threshold: 135000 },
      code_reviewer: { max_tokens: 150000, wrap_up_tokens_threshold: 135000 },
      verifier: { max_tokens: 150000, wrap_up_tokens_threshold: 135000 },
    },
  },
};

const mission = "cfg-mission";

// --- v4 config fixture ---
const repoV4 = mkRepo();
writeState(repoV4, mission);
writeRuns(repoV4, mission);
const configPathV4 = path.join(repoV4, ".autopilot", "config.json");
const layout = toNewLayoutConfig(runtimeConfig);
fs.writeFileSync(configPathV4, JSON.stringify(layout, null, 2) + "\n");
const beforeV4 = fs.readFileSync(configPathV4, "utf8");
const outFileV4 = writeWatchReportFile(repoV4, mission);
const afterV4 = fs.readFileSync(configPathV4, "utf8");
check("v4: config bytes unchanged", beforeV4 === afterV4);
const textV4 = fs.readFileSync(outFileV4, "utf8");
check("v4: caps line", textV4.includes("Caps:"));
check("v4: of 8", textV4.includes("of 8"));
check("v4: session 1 of 6", textV4.includes("session 1 of 6"));

// --- 3.x config fixture ---
const repo3 = mkRepo();
writeState(repo3, mission);
writeRuns(repo3, mission);
const configPath3 = path.join(repo3, ".autopilot", "config.json");
fs.writeFileSync(configPath3, JSON.stringify({ schema_version: "3.0", ...runtimeConfig }, null, 2) + "\n");
const outFile3 = writeWatchReportFile(repo3, mission);
const text3 = fs.readFileSync(outFile3, "utf8");
// The header carries the render time (=== HH:MM:SS) and live elapsed values;
// drop the clock line so two renders a second apart still compare equal.
const stable = (t) => t.replace(/^=== \d{2}:\d{2}:\d{2} — /m, "=== — ").replace(/elapsed \d+:\d{2}:\d{2}/g, "elapsed -");
check("3.x: same output as v4", stable(textV4) === stable(text3));

// --- stop event + newer running run ---
const repoStop = mkRepo();
const missionStop = "stop-mission";
writeState(repoStop, missionStop, { phaseIndex: 0, attempt: 1 });
const runsDirStop = path.join(repoStop, ".autopilot", "missions", missionStop, "runs");
const oldRun = path.join(runsDirStop, "01-implementer-old");
fs.mkdirSync(oldRun, { recursive: true });
fs.writeFileSync(path.join(oldRun, "status.json"), JSON.stringify({
  status: "completed", run_id: "old", role: "implementer", phase: "1", taskRef: "T1.1",
  attempt: 1, started_at: "2026-09-29T01:20:00+03:00", updated_at: "2026-09-29T01:25:00+03:00",
  usage: { priceWeighted: 1000, turns: 1, peakContext: 1000 },
}, null, 2));
const newRun = path.join(runsDirStop, "02-implementer-new");
fs.mkdirSync(newRun, { recursive: true });
fs.writeFileSync(path.join(newRun, "status.json"), JSON.stringify({
  status: "running", run_id: "new", role: "implementer", phase: "1", taskRef: "T1.1",
  attempt: 1, started_at: "2026-09-29T01:40:00+03:00", updated_at: "2026-09-29T01:45:00+03:00",
  pid: process.pid, usage: { priceWeighted: 2000, turns: 2, peakContext: 2000 },
}, null, 2));
const eventsStop = path.join(repoStop, ".autopilot", "missions", missionStop, "watch-events.jsonl");
fs.writeFileSync(eventsStop, JSON.stringify({ type: "operator", reason: "stop", scope: "mission", at: "2026-09-29T01:30:00+03:00" }) + "\n");
fs.writeFileSync(path.join(repoStop, ".autopilot", "config.json"), JSON.stringify({ schema_version: "4.0", $schema: "./config.schema.json" }, null, 2));
const textStop = renderWatchReport(repoStop, missionStop);
check("stop+resume: Status RUNNING", /Status:\s+RUNNING/.test(textStop), textStop.split("\n").find(l => /Status:/.test(l)));
check("stop+resume: phase IN PROGRESS", textStop.includes("● IN PROGRESS"));
check("stop+resume: next: line", textStop.includes("next:"));
check("stop+resume: CURRENT RUN section", textStop.includes("=== CURRENT RUN ==="));

// --- stop event with no later run ---
const repoStop2 = mkRepo();
const missionStop2 = "stop-mission2";
writeState(repoStop2, missionStop2, { phaseIndex: 0, attempt: 1 });
const runsDirStop2 = path.join(repoStop2, ".autopilot", "missions", missionStop2, "runs");
const run2 = path.join(runsDirStop2, "01-implementer-old2");
fs.mkdirSync(run2, { recursive: true });
fs.writeFileSync(path.join(run2, "status.json"), JSON.stringify({
  status: "completed", run_id: "old2", role: "implementer", phase: "1", taskRef: "T1.1",
  attempt: 1, started_at: "2026-09-29T01:20:00+03:00", updated_at: "2026-09-29T01:25:00+03:00",
  usage: { priceWeighted: 1000, turns: 1, peakContext: 1000 },
}, null, 2));
const eventsStop2 = path.join(repoStop2, ".autopilot", "missions", missionStop2, "watch-events.jsonl");
fs.writeFileSync(eventsStop2, JSON.stringify({ type: "operator", reason: "stop", scope: "mission", at: "2026-09-29T01:30:00+03:00" }) + "\n");
fs.writeFileSync(path.join(repoStop2, ".autopilot", "config.json"), JSON.stringify({ schema_version: "4.0", $schema: "./config.schema.json" }, null, 2));
const textStop2 = renderWatchReport(repoStop2, missionStop2);
check("stop-only: Status STOPPED", /Status:\s+STOPPED/.test(textStop2), textStop2.split("\n").find(l => /Status:/.test(l)));
check("stop-only: no CURRENT RUN", !textStop2.includes("=== CURRENT RUN ==="));

// --- diff_stat events => no changed files text ---
const phases = [{ number: 1, name: "Phase 1", done: false, tasks: [{ text: "T1.1", done: false }] }];
const state = { mission: "m", phase: "implementing", step: "implement", phaseIndex: 0, attempt: 1, planningDetection: { framework: "standalone" } };
const runsArr = [run({ id: "01-implementer-x", dirName: "01-implementer-x", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", status: "running", sessionNumber: 1, resolvedModel: "muse", started_at: "2026-09-29T01:41:55+03:00", usage: { priceWeighted: 52000, turns: 9, peakContext: 27300 } })];
const eventsArr = [{ type: "diff_stat", phase: 1, attempt: 1, stat: " scripts/a.mjs | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)", at: "2026-09-29T01:42:00+03:00" }];
const model = buildReportModel({ state, runs: runsArr, events: eventsArr, phases, policy: { continuation_allowance: 5, caps: { implementer: { max_tokens: 500000 } } }, now: "2026-09-29T01:48:30+03:00" });
const reportDiff = renderReport(model, { stamp: "2026-09-29 01:48:30" });
check("diff_stat: no changed files text", !reportDiff.includes("changed files"));
const stageDiff = renderImplementationStage(model);
check("diff_stat: next is last in phase block", stageDiff.trim().endsWith("next: phase review → full test suite → phase verify"), stageDiff);

// --- 2-phase model: one empty line before each phase header ---
const phases2 = [
  { number: 1, name: "Phase 1", done: true, tasks: [{ text: "T1.1", done: true }] },
  { number: 2, name: "Phase 2", done: false, tasks: [{ text: "T2.1", done: false }] },
];
const state2 = { mission: "m2", phase: "implementing", step: "implement", phaseIndex: 1, attempt: 1, planningDetection: { framework: "standalone" } };
const runs2 = [
  run({ id: "01-implementer-a", dirName: "01-implementer-a", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", resolvedModel: "muse", started_at: "2026-09-29T00:02:45+03:00", usage: { priceWeighted: 1000, turns: 1, peakContext: 1000 } }),
  run({ id: "02-implementer-b", dirName: "02-implementer-b", role: "implementer", phase: "2", attempt: "1", taskRef: "T2.1", status: "running", resolvedModel: "muse", started_at: "2026-09-29T00:10:00+03:00", usage: { priceWeighted: 2000, turns: 2, peakContext: 2000 } }),
];
const model2 = buildReportModel({ state: state2, runs: runs2, events: [], phases: phases2, policy: { continuation_allowance: 5, caps: { implementer: { max_tokens: 500000 } } }, now: "2026-09-29T00:20:00+03:00" });
const stage2 = renderImplementationStage(model2);
check("2-phase: no triple blank lines", !stage2.includes("\n\n\n"));
const lines2 = stage2.split("\n");
const headerIdx = lines2.map((l, i) => (/^\s*Phase \d+\/\d+ —/.test(l) ? i : -1)).filter(i => i >= 0);
check("2-phase: two headers", headerIdx.length === 2, headerIdx.length);
check("2-phase: first header follows the section header", headerIdx[0] === 1 && lines2[0] === "=== IMPLEMENTATION STAGE ===", lines2.slice(0, 2));
check("2-phase: blank before later headers", headerIdx.slice(1).every(i => i > 0 && lines2[i - 1] === ""), headerIdx.map(i => lines2[i-1]));
check("2-phase: no double blank before header", headerIdx.every(i => i < 2 || lines2[i - 2] !== ""), headerIdx.map(i => lines2[i-2]));

// --- F1b: owner liveness drives Status ---
const phasesO = [{ number: 1, name: "Phase 1", done: false, tasks: [{ text: "T1.1", done: false }] }];
const stateO = { mission: "m", phase: "implementing", step: "implement", phaseIndex: 0, attempt: 1, planningDetection: { framework: "standalone" } };
const runDead = run({ id: "01-implementer-dead", dirName: "01-implementer-dead", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", status: "running", ownerAlive: false, resolvedModel: "muse", started_at: "2026-09-29T01:40:00+03:00", usage: { priceWeighted: 2000, turns: 2, peakContext: 2000 } });
const modelDead = buildReportModel({ state: stateO, runs: [runDead], events: [], phases: phasesO, policy: { continuation_allowance: 5, caps: { implementer: { max_tokens: 500000 } } }, now: "2026-09-29T01:48:30+03:00", ownerAlive: false });
const reportDead = renderReport(modelDead, { stamp: "2026-09-29 01:48:30" });
check("F1b owner dead: status", reportDead.includes("STOPPED · orchestrator not running"), reportDead.split("\n").find(l => /Status:/.test(l)));
check("F1b owner dead: no CURRENT RUN", !reportDead.includes("=== CURRENT RUN ==="));

const runAlive = run({ id: "01-implementer-alive", dirName: "01-implementer-alive", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", status: "running", ownerAlive: true, resolvedModel: "muse", started_at: "2026-09-29T01:40:00+03:00", usage: { priceWeighted: 2000, turns: 2, peakContext: 2000 } });
const modelAlive = buildReportModel({ state: stateO, runs: [runAlive], events: [], phases: phasesO, policy: { continuation_allowance: 5, caps: { implementer: { max_tokens: 500000 } } }, now: "2026-09-29T01:48:30+03:00", ownerAlive: true });
const reportAlive = renderReport(modelAlive, { stamp: "2026-09-29 01:48:30" });
check("F1b owner alive: Status RUNNING", /Status:\s+RUNNING/.test(reportAlive));
check("F1b owner alive: CURRENT RUN", reportAlive.includes("=== CURRENT RUN ==="));

// --- F1b: no live run -> LIVE PROGRESS uses newest run's progress.log ---
const repoLP = fs.mkdtempSync(path.join(os.tmpdir(), "ap-f1-lp-"));
const missionLP = "lp-mission";
fs.mkdirSync(path.join(repoLP, ".autopilot", "missions", missionLP, "runs", "01-implementer-lp"), { recursive: true });
fs.writeFileSync(path.join(repoLP, ".autopilot", "state.json"), JSON.stringify({ mission: missionLP, phase: "implementing", step: "implement", phaseIndex: 0, attempt: 1, planningDetection: { framework: "standalone" } }, null, 2));
fs.writeFileSync(path.join(repoLP, ".autopilot", "missions", missionLP, "runs", "01-implementer-lp", "status.json"), JSON.stringify({ status: "completed", run_id: "lp1", role: "implementer", phase: "1", taskRef: "T1.1", attempt: 1, started_at: "2026-09-29T01:40:00+03:00", updated_at: "2026-09-29T01:45:00+03:00", usage: { priceWeighted: 2000, turns: 2, peakContext: 2000 } }, null, 2));
fs.writeFileSync(path.join(repoLP, ".autopilot", "missions", missionLP, "runs", "01-implementer-lp", "progress.log"), "2026-09-29T01:44:00  START | ROLE=implementer | PHASE=1 | TASK=T999 | ATTEMPT=1 | PID=1\n");
fs.writeFileSync(path.join(repoLP, ".autopilot", "config.json"), JSON.stringify({ schema_version: "4.0", $schema: "./config.schema.json" }, null, 2));
const reportLP = renderWatchReport(repoLP, missionLP);
check("F1b no-live: LIVE PROGRESS shows newest run", reportLP.includes("T999"), reportLP);

if (failures.length) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
} else {
  console.log("\nAll F1 tests passed");
}
