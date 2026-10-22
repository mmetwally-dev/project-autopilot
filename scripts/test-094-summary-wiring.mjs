#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { initRun, finalizeRun, updateRunModel, observe, updateRunUsage } from "./run-observability.mjs";
import { renderWatchReport } from "./run-history.mjs";
import { readSummary, summaryPath, rebuildSummary, peekSummary } from "./watch-summary.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
};

const observabilitySource = fs.readFileSync(new URL("./run-observability.mjs", import.meta.url), "utf8");
const autopilotSource = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
const historySource = fs.readFileSync(new URL("./run-history.mjs", import.meta.url), "utf8");

// ── source pins ──────────────────────────────────────────────────────────
check("wire: run-observability imports updateSummaryForRunDir",
  /import \{ updateSummaryForRunDir \} from "\.\/watch-summary\.mjs"/.test(observabilitySource));
check("wire: updateSummary wired into all 3 run-write points",
  (observabilitySource.match(/updateSummaryForRunDir\(dir\)/g) || []).length >= 3,
  (observabilitySource.match(/updateSummaryForRunDir\(dir\)/g) || []).length);
check("wire: autopilot imports watch-summary helpers",
  /import \{ updateSummary, updateSummaryForRunDir, scopeForRunDir \} from "\.\/watch-summary\.mjs"/.test(autopilotSource));
check("wire: autopilot calls updateSummaryForRunDir at model resolution",
  (autopilotSource.match(/updateSummaryForRunDir\(dir\)/g) || []).length >= 2,
  (autopilotSource.match(/updateSummaryForRunDir\(dir\)/g) || []).length);
check("wire: autopilot leaves a single summary call at exit",
  (autopilotSource.match(/try\{ updateSummaryForRunDir\(dir\); \}catch\{\}/g) || []).length >= 2);
check("wire: renderWatchReport uses peekSummary",
  /const summary = peekSummary\(repo, mission\)/.test(historySource));
check("wire: renderWatchReport uses summary runs",
  /const summaryRuns = Array\.isArray\(summary\?\.runs\) \? summary\.runs : \[\]/.test(historySource));
check("wire: renderWatchReport uses summary events tail",
  /Array\.isArray\(summary\?\.events\) \? summary\.events : null/.test(historySource));

// ── runtime: mission-shaped fixture ───────────────────────────────────────
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "094-wiring-"));
const mission = "wiring-mission";
const missionDir = path.join(repo, ".autopilot", "missions", mission);
const runsDir = path.join(missionDir, "runs");
fs.mkdirSync(runsDir, { recursive: true });
fs.mkdirSync(path.join(repo, ".autopilot"), { recursive: true });
fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
  currentPhase: { name: "Implementation" }, phase: 1, attempt: 1, step: "run", phaseIndex: 0,
}, null, 2));

const runDir = path.join(runsDir, "01-implementer-aaaa");
initRun(runDir, { role: "implementer", phase: "1", taskRef: "T1.1", runId: "r1", configuredModel: "claude-sonnet-4-5" });

check("wiring: initRun persisted a summary", fs.existsSync(summaryPath(repo, mission)));
check("wiring: summary has the new run", readSummary(repo, mission).runs.some((r) => r.id === "r1"));

// model resolution update lands in the cache without re-reading run dirs.
updateRunModel(runDir, { resolvedModel: "claude-opus-4-5", modelMismatch: true });
const afterModel = readSummary(repo, mission);
const modelRun = afterModel.runs.find((r) => r.id === "r1");
check("wiring: updateRunModel reached the cache (resolvedModel)", modelRun.resolvedModel === "claude-opus-4-5", modelRun.resolvedModel);
check("wiring: updateRunModel reached the cache (mismatch)", modelRun.modelMismatch === true, modelRun.modelMismatch);

// current run would read progress.log; cancel the mission so the render is
// strictly cache-only (matches the fast/cached acceptance contract).
const st = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
st.phase = "cancelled";
fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(st, null, 2));

// cached render must not re-read any run-dir status/result/progress file.
const originalRead = fs.readFileSync;
let runDirReads = 0;
fs.readFileSync = (...args) => {
  const p = String(args[0]);
  if (p.includes("/runs/") && /(status\.json|result\.json|progress\.log)$/.test(p)) runDirReads++;
  return originalRead(...args);
};
const cached = renderWatchReport(repo, mission);
fs.readFileSync = originalRead;
check("wiring: cached render reads no run-dir logs", runDirReads === 0, runDirReads);

// from-scratch fallback (deleted cache) produces byte-identical output.
fs.rmSync(summaryPath(repo, mission), { force: true });
const fromScratch = renderWatchReport(repo, mission);
check("wiring: from-scratch fallback matches cached render", cached === fromScratch);

// finalize updates status and the cache reflects it.
const statusBefore = JSON.parse(fs.readFileSync(path.join(runDir, "status.json"), "utf8"));
finalizeRun(runDir, { status: "completed", exitCode: 0, decision: "PASS", startedAt: statusBefore.started_at });
const afterFinalize = readSummary(repo, mission);
const finalRun = afterFinalize.runs.find((r) => r.id === "r1");
check("wiring: finalizeRun reached the cache (completed)", finalRun.status === "completed", finalRun.status);

// live-progress wiring: a running run updated via observe()/updateRunUsage keeps
// the cache current, and a subsequent peekSummary never re-reads run-dir logs.
const liveRepo = fs.mkdtempSync(path.join(os.tmpdir(), "094-wiring-live-"));
const liveMission = "live-mission";
const liveMissionDir = path.join(liveRepo, ".autopilot", "missions", liveMission);
const liveRunsDir = path.join(liveMissionDir, "runs");
fs.mkdirSync(liveRunsDir, { recursive: true });
fs.mkdirSync(path.join(liveRepo, ".autopilot"), { recursive: true });
fs.writeFileSync(path.join(liveRepo, ".autopilot", "state.json"), JSON.stringify({
  currentPhase: { name: "Implementation" }, phase: 1, attempt: 1, step: "run", phaseIndex: 0,
}, null, 2));
const liveRunDir = path.join(liveRunsDir, "01-implementer-bbbb");
initRun(liveRunDir, { role: "implementer", phase: "1", taskRef: "T1.1", runId: "live1", configuredModel: "claude-sonnet-4-5" });
observe(liveRunDir, { minIntervalMs: 0, last: "hello" });
updateRunUsage(liveRunDir, { turns: 5, input: 10, output: 2 });
const originalRead2 = fs.readFileSync;
let liveRunDirReads = 0;
fs.readFileSync = (...args) => {
  const p = String(args[0]);
  if (p.includes("/runs/")) liveRunDirReads++;
  return originalRead2(...args);
};
const liveSummary = peekSummary(liveRepo, liveMission);
fs.readFileSync = originalRead2;
const liveRunRecord = liveSummary.runs.find((r) => r.id === "live1");
check("wiring: live run observed into cache (running)", liveRunRecord && liveRunRecord.status === "running", liveRunRecord && liveRunRecord.status);
check("wiring: live run usage reached the cache", liveRunRecord && liveRunRecord.usage && liveRunRecord.usage.turns === 5, liveRunRecord && liveRunRecord.usage);
check("wiring: live-progress peek reads no run-dir logs", liveRunDirReads === 0, liveRunDirReads);
fs.rmSync(liveRepo, { recursive: true, force: true });

// result.json is written AFTER finalizeRun (runRelay order); a later run's
// update must not bless the stale cached record: peek must equal a rebuild.
{
  const rRepo = fs.mkdtempSync(path.join(os.tmpdir(), "094-wiring-late-"));
  const rMission = "late-mission";
  const rRuns = path.join(rRepo, ".autopilot", "missions", rMission, "runs");
  fs.mkdirSync(rRuns, { recursive: true });
  fs.writeFileSync(path.join(rRepo, ".autopilot", "state.json"), JSON.stringify({ phase: "cancelled" }));
  const d1 = path.join(rRuns, "01-reviewer-cccc");
  initRun(d1, { role: "reviewer", phase: "1", runId: "late1" });
  finalizeRun(d1, { status: "completed", exitCode: 0, decision: "FAIL", startedAt: new Date().toISOString() });
  const rp = path.join(d1, "result.json");
  fs.writeFileSync(rp, JSON.stringify({ review: { findings: ["F1 broken"] } }));
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(rp, future, future);
  const d2 = path.join(rRuns, "02-implementer-dddd");
  initRun(d2, { role: "implementer", phase: "1", runId: "late2" });
  const peeked = peekSummary(rRepo, rMission);
  const rebuilt = rebuildSummary(rRepo, rMission);
  const f = (x) => x.runs.find((r) => r.id === "late1")?.findings;
  check("wiring: late result.json findings survive the next run's update", JSON.stringify(f(peeked)) === JSON.stringify(["F1 broken"]), f(peeked));
  check("wiring: peekSummary equals rebuildSummary after late result.json", JSON.stringify(peeked.runs) === JSON.stringify(rebuilt.runs));
  fs.rmSync(rRepo, { recursive: true, force: true });
}

// Incremental: updating the running run's OWN dir on a 60-run mission must not
// trigger a full rebuild (each rebuild re-reads every run dir).
{
  const iRepo = fs.mkdtempSync(path.join(os.tmpdir(), "094-wiring-inc-"));
  const iMission = "inc-mission";
  const iRuns = path.join(iRepo, ".autopilot", "missions", iMission, "runs");
  fs.mkdirSync(iRuns, { recursive: true });
  fs.writeFileSync(path.join(iRepo, ".autopilot", "state.json"), JSON.stringify({ phase: "cancelled" }));
  for (let i = 0; i < 60; i++) {
    const d = path.join(iRuns, `${String(i + 1).padStart(2, "0")}-implementer-x${i}`);
    initRun(d, { role: "implementer", phase: "1", runId: `inc${i}` });
    finalizeRun(d, { status: "completed", exitCode: 0, decision: "PASS", startedAt: new Date().toISOString() });
  }
  const live = path.join(iRuns, "61-implementer-live");
  initRun(live, { role: "implementer", phase: "1", runId: "inclive" });
  const origRead = fs.readFileSync;
  let otherReads = 0;
  fs.readFileSync = (...a) => {
    const p = String(a[0]);
    if (p.includes("/runs/") && !p.includes("61-implementer-live") && /(status|result)\.json$/.test(p)) otherReads++;
    return origRead(...a);
  };
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 5; i++) updateRunUsage(live, { turns: (i + 1) * 3, input: 1, output: 1 }, { minTurns: 1, minIntervalMs: 0 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 5;
  fs.readFileSync = origRead;
  console.log(`incremental update on 61 runs: ${ms.toFixed(1)} ms`);
  check("wiring: own-dir update does not re-read other run dirs", otherReads === 0, otherReads);
  check("wiring: own-dir incremental update < 50 ms", ms < 50, ms);
  { const u = peekSummary(iRepo, iMission).runs.find((r) => r.id === "inclive")?.usage; check("wiring: incremental update applied", u?.turns === 15, u); }
  fs.rmSync(iRepo, { recursive: true, force: true });
}

fs.rmSync(repo, { recursive: true, force: true });

if (failures.length) { console.error(`${failures.length} wiring check(s) failed.`); process.exit(1); }
console.log("All summary-wiring checks passed.");
