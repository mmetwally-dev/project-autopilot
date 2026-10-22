#!/usr/bin/env node
// Mission 094 Phase 3 task 3.1 — the compact watch-summary cache
// (`scripts/watch-summary.mjs`). Asserts:
//   - a rebuild from run dirs + watch-events carries one compact record per run
//     (with the report-model merge fields inline) and a watch-events index;
//   - a missing summary is rebuilt and persisted, and the persisted summary
//     reads back exactly as rebuilt;
//   - a stale summary (a run's status.json rewritten) is rebuilt;
//   - an incremental update persists and is then served without a rebuild.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  SUMMARY_VERSION,
  summaryPath,
  sourceStamp,
  rebuildSummary,
  readSummary,
  updateSummary,
} from "./watch-summary.mjs";
import { appendWatchEvent } from "./watch-events.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
};

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "094-summary-"));
const mission = "094-summary-fixture";
const missionDir = path.join(repo, ".autopilot", "missions", mission);
const runsDir = path.join(missionDir, "runs");
fs.mkdirSync(runsDir, { recursive: true });

function writeRun(name, status, result = null) {
  const dir = path.join(runsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status, null, 2));
  if (result) fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result, null, 2));
  return dir;
}

writeRun("01-implementer-aaaaaaaa", {
  status: "completed", run_id: "run-a", role: "implementer", phase: "1", attempt: 1,
  taskRef: "T1.1", started_at: "2026-01-01T00:00:01Z", model: "claude-sonnet-4-5",
});
writeRun("02-verifier-bbbbbbbb", {
  status: "completed", run_id: "run-b", role: "verifier", phase: "1", attempt: 1,
  taskRef: "T1.1", started_at: "2026-01-01T00:00:02Z", decision: "FAIL",
  carriedForwardTasks: ["T1.2"],
}, { review: { decision: "FAIL", findings: ["T1.1: missing regression"] } });
writeRun("03-planner-cccccccc", {
  status: "completed", run_id: "run-c", role: "planner", phase: "1", attempt: 0,
  taskRef: "standalone-planning-planner", started_at: "2026-01-01T00:00:03Z",
  resolvedModel: "claude-opus-4-5",
});

const events = [
  { type: "gate_start", at: "2026-01-01T00:00:04Z", phase: 1, command: "node scripts/run-tests.mjs" },
  { type: "gate_result", at: "2026-01-01T00:00:05Z", phase: 1, ok: true },
];
fs.writeFileSync(path.join(missionDir, "watch-events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");

// ── 1. rebuild from run dirs == written then read ───────────────────────────
const rebuilt = rebuildSummary(repo, mission);
check("rebuild: 3 runs", rebuilt.runs.length === 3, rebuilt.runs.length);
check("rebuild: version", rebuilt.version === SUMMARY_VERSION, rebuilt.version);
check("rebuild: oldest first", rebuilt.runs.map((r) => r.id).join(",") === "run-a,run-b,run-c", rebuilt.runs.map((r) => r.id));
const verifier = rebuilt.runs.find((r) => r.role === "verifier");
check("rebuild: verifier findings inline", Array.isArray(verifier.findings) && verifier.findings[0] === "T1.1: missing regression", verifier.findings);
check("rebuild: verifier carriedForward inline", JSON.stringify(verifier.carriedForwardTasks) === JSON.stringify(["T1.2"]), verifier.carriedForwardTasks);
const planner = rebuilt.runs.find((r) => r.role === "planner");
check("rebuild: planner resolvedModel inline", planner.resolvedModel === "claude-opus-4-5", planner.resolvedModel);
check("rebuild: events index count", rebuilt.eventsIndex.count === 2, rebuilt.eventsIndex);
check("rebuild: events index lastAt", rebuilt.eventsIndex.lastAt === "2026-01-01T00:00:05Z", rebuilt.eventsIndex.lastAt);
check("rebuild: source stamp positive", rebuilt.sourceMtimeMs > 0, rebuilt.sourceMtimeMs);

const file = summaryPath(repo, mission);
check("rebuild: does not persist", !fs.existsSync(file), fs.existsSync(file));

// missing summary -> rebuild + persist
const first = readSummary(repo, mission);
check("read: persists on rebuild", fs.existsSync(file));
assert.deepStrictEqual(first, rebuilt);
check("read: missing summary equals rebuild", true);

// cached read is served without a rebuild
const second = readSummary(repo, mission);
assert.deepStrictEqual(second, rebuilt);
check("read: cached equals rebuild", true);

// ── 2. stale summary (a run status.json was rewritten) triggers rebuild ─────
const implStatus = path.join(runsDir, "01-implementer-aaaaaaaa", "status.json");
const updated = JSON.parse(fs.readFileSync(implStatus, "utf8"));
updated.status = "capped";
updated.sessionNumber = 2;
fs.writeFileSync(implStatus, JSON.stringify(updated, null, 2));
const future = new Date(Date.now() + 60_000);
fs.utimesSync(implStatus, future, future);

check("stale: source stamp advanced", sourceStamp(repo, mission) > rebuilt.sourceMtimeMs, sourceStamp(repo, mission));
const afterStale = readSummary(repo, mission);
const implAfter = afterStale.runs.find((r) => r.id === "run-a");
check("stale: rebuilt reflects change", implAfter.status === "capped" && implAfter.sessionNumber === 2, implAfter);
check("stale: rebuilt summary differs", afterStale.sourceMtimeMs !== rebuilt.sourceMtimeMs, afterStale.sourceMtimeMs);

// ── 3. missing summary file triggers a rebuild ──────────────────────────────
fs.rmSync(file);
check("missing: file gone", !fs.existsSync(file));
const afterMissing = readSummary(repo, mission);
check("missing: recreated", fs.existsSync(file));
check("missing: records intact", afterMissing.runs.length === 3, afterMissing.runs.length);

// ── 4. incremental update persists and is served without a rebuild ──────────
const newRunDir = writeRun("04-code_reviewer-dddddddd", {
  status: "completed", run_id: "run-d", role: "code_reviewer", phase: "2", attempt: 1,
  taskRef: "T2.1", started_at: "2026-01-01T00:00:06Z", decision: "PASS",
});
const updated2 = updateSummary(repo, mission, { runDir: newRunDir, appendEvents: [{ type: "diff_stat", at: "2026-01-01T00:00:07Z", phase: 2, stat: "1 file changed, 2 insertions(+)" }] });
check("update: run upserted", updated2.runs.some((r) => r.id === "run-d"), updated2.runs.map((r) => r.id));
check("update: 4 runs", updated2.runs.length === 4, updated2.runs.length);
check("update: event appended", updated2.eventsIndex.count === 3, updated2.eventsIndex);
const served = readSummary(repo, mission);
check("update: served cached", served.sourceMtimeMs === updated2.sourceMtimeMs, [served.sourceMtimeMs, updated2.sourceMtimeMs]);
check("update: run-d served", served.runs.some((r) => r.id === "run-d"), served.runs.map((r) => r.id));

// ── 5. force rebuild ────────────────────────────────────────────────────────
const forced = readSummary(repo, mission, { force: true });
check("force: still 4 runs", forced.runs.length === 4, forced.runs.length);
check("force: matches persisted", JSON.stringify(forced) === JSON.stringify(readSummary(repo, mission)), null);

// ── 6. appendWatchEvent with no summary file (rebuiltBase guard) ────────────
// Regression test for the !rebuiltBase guard at updateSummary:286
// When appendWatchEvent is called with no summary file, the first appendEvents
// call should trigger a rebuild (not append), so no duplicate events occur.
const repo2 = fs.mkdtempSync(path.join(os.tmpdir(), "094-summary-append-"));
const mission2 = "094-summary-append-fixture";
const missionDir2 = path.join(repo2, ".autopilot", "missions", mission2);
fs.mkdirSync(missionDir2, { recursive: true });
const summaryFile2 = summaryPath(repo2, mission2);
check("append: no summary file initially", !fs.existsSync(summaryFile2), fs.existsSync(summaryFile2));

// Append first event (should trigger rebuild, not duplicate)
appendWatchEvent(missionDir2, { type: "phase_start", phase: 1 });
const eventsFile = path.join(missionDir2, "watch-events.jsonl");
const linesAfterFirst = fs.readFileSync(eventsFile, "utf8").split("\n").filter((l) => l.trim()).length;
const summaryAfterFirst = readSummary(repo2, mission2);
check("append: first event in jsonl", linesAfterFirst === 1, linesAfterFirst);
check("append: first event in summary", summaryAfterFirst.events.length === 1, summaryAfterFirst.events.length);
check("append: first eventsIndex.count", summaryAfterFirst.eventsIndex.count === 1, summaryAfterFirst.eventsIndex.count);

// Append second event
appendWatchEvent(missionDir2, { type: "phase_end", phase: 1 });
const linesAfterSecond = fs.readFileSync(eventsFile, "utf8").split("\n").filter((l) => l.trim()).length;
const summaryAfterSecond = readSummary(repo2, mission2);
check("append: second event in jsonl", linesAfterSecond === 2, linesAfterSecond);
check("append: second event in summary", summaryAfterSecond.events.length === 2, summaryAfterSecond.events.length);
check("append: second eventsIndex.count", summaryAfterSecond.eventsIndex.count === 2, summaryAfterSecond.eventsIndex.count);

fs.rmSync(repo, { recursive: true, force: true });
fs.rmSync(repo2, { recursive: true, force: true });

if (failures.length) { console.error(`${failures.length} summary check(s) failed.`); process.exit(1); }
console.log("All summary checks passed.");
