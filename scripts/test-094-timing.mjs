#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { renderWatchReport } from "./run-history.mjs";
import { readSummary, summaryPath } from "./watch-summary.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
};

const RUN_COUNT = 60;
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "094-timing-"));
const mission = "timing-mission";
const missionDir = path.join(repo, ".autopilot", "missions", mission);
const runsDir = path.join(missionDir, "runs");
fs.mkdirSync(runsDir, { recursive: true });
fs.mkdirSync(path.join(repo, ".autopilot"), { recursive: true });
// Cancelled state => no current run, so the cached render never touches a
// progress.log and stays strictly cache-only.
fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
  currentPhase: { name: "Implementation" }, phase: "cancelled", phaseIndex: 0,
}, null, 2));

for (let i = 0; i < RUN_COUNT; i++) {
  const dir = path.join(runsDir, `${String(i + 1).padStart(2, "0")}-run-${String(i).padStart(4, "0")}-aaaaaaaa`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
    status: i % 5 === 0 ? "capped" : "completed",
    run_id: `run-${i}`,
    role: i % 3 === 0 ? "implementer" : (i % 3 === 1 ? "verifier" : "planner"),
    phase: String((i % 3) + 1),
    attempt: 1,
    taskRef: `T${(i % 3) + 1}.${(i % 7) + 1}`,
    started_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    model: "claude-sonnet-4-5",
    sessionNumber: i % 5 === 0 ? 2 : null,
    findings: [],
  }, null, 2));
  if (i % 2 === 0) {
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({
      review: { decision: i % 4 === 0 ? "FAIL" : "PASS", findings: [`finding ${i}`] },
      carriedForwardTasks: i % 4 === 0 ? [`T${(i % 3) + 1}.${(i % 7) + 2}`] : null,
    }, null, 2));
  }
  // A large progress.log per run that the cached render must NOT read.
  fs.writeFileSync(path.join(dir, "progress.log"), `line 1 of run ${i}\n`.repeat(2000));
}

const events = [
  { type: "gate_start", at: "2026-01-01T00:00:04Z", phase: 1, command: "node scripts/run-tests.mjs" },
  { type: "gate_result", at: "2026-01-01T00:00:05Z", phase: 1, ok: true },
  { type: "diff_stat", at: "2026-01-01T00:00:06Z", phase: 1, stat: "5 files changed, 10 insertions(+)" },
];
fs.writeFileSync(path.join(missionDir, "watch-events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");

// Build and persist the cache once (this is the slow, one-time path).
const summary = readSummary(repo, mission);
check("timing: summary has 50+ runs", summary.runs.length >= 50, summary.runs.length);
check("timing: summary persisted", fs.existsSync(summaryPath(repo, mission)));

// Instrument reads during the cached render.
const originalReadFileSync = fs.readFileSync;
let runDirReads = 0;
let readPaths = [];
fs.readFileSync = (...args) => {
  const p = String(args[0]);
  if (p.includes("/runs/")) { runDirReads++; readPaths.push(p); }
  return originalReadFileSync(...args);
};

const t0 = performance.now();
const rendered = renderWatchReport(repo, mission);
const elapsed = performance.now() - t0;

fs.readFileSync = originalReadFileSync;

check("timing: cached render under 1 s", elapsed < 1000, Number(elapsed.toFixed(2)));
check("timing: cached render reads no run-dir logs", runDirReads === 0, runDirReads);
check("timing: render produced output", typeof rendered === "string" && rendered.length > 0, rendered.length);

if (runDirReads > 0) {
  console.error("unexpected run-dir reads:");
  for (const p of readPaths) console.error("  " + p);
}

fs.rmSync(repo, { recursive: true, force: true });

if (failures.length) {
  console.error(`${failures.length} timing check(s) failed.`);
  process.exit(1);
}
console.log(`All timing checks passed (${RUN_COUNT} runs, ${elapsed.toFixed(2)} ms).`);
