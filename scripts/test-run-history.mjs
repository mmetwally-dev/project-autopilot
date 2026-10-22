#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { abbrevId, normalizeStatus, formatTimestamp, readRunMeta, listRunsOldestNewest, detectCurrentRun, displayStatus, displayStatusLabel, statusCellText, priceCellText, contextCellText, turnsCellText, progressTail, renderCurrentDetail, renderWatchReport, writeWatchReportFile, readWatchEvents, renumberRuns, nextRunSeq, parseRunDirName, annotateOwnerLiveness, staleRunningNote, STALE_RUNNING_LABEL, watchRunsDir } from "./run-history.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-run-history-"));
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const runsDir = path.join(root, "runs");

// Legacy run: no status.json, no progress.log — only result.json + mtime.
const legacy = path.join(runsDir, "legacy-run-1");
fs.mkdirSync(legacy, { recursive: true });
const legacyDate = new Date("2026-08-10T10:00:00Z");
write(path.join(legacy, "result.json"), JSON.stringify({
  status: "completed", role: "implementer", startedAt: "2026-08-10T10:00:00.000Z",
  review: { decision: "PASS" }, process: { exitCode: 0 },
}, null, 2));
fs.utimesSync(legacy, legacyDate, legacyDate);

// Modern completed run (status.json + progress.log).
const modern = path.join(runsDir, "modern-run-2");
fs.mkdirSync(modern, { recursive: true });
write(path.join(modern, "status.json"), JSON.stringify({
  status: "completed", started_at: "2026-08-11T10:00:00", updated_at: "2026-08-11T11:00:00",
  pid: 555, role: "reviewer", exit_code: 0, decision: "FAIL", duration: "01:00:00", last_action: "finished",
  taskRef: "T001 > T003",
  usage: {input: 1000, cacheCreation: 0, cacheRead: 500000, output: 2000, turns: 8, priceWeighted: 64935.3},
}, null, 2));
const lines = [];
for (let i = 0; i < 50; i++) lines.push(`2026-08-11T10:00:${String(i).padStart(2, "0")}  ACTIVITY | STREAM=stdout | BYTES=1`);
write(path.join(modern, "progress.log"), lines.join("\n"));

// Running run (current).
const running = path.join(runsDir, "running-run-3");
fs.mkdirSync(running, { recursive: true });
write(path.join(running, "status.json"), JSON.stringify({
  status: "running", started_at: "2026-08-12T10:00:00", updated_at: "2026-08-12T10:30:00",
  // A LIVE pid on purpose: "running" is reconciled against process liveness, so
  // a hardcoded pid such as 777 is dead on most machines and this fixture would
  // silently turn into the KILLED case instead of the current-run case.
  pid: process.pid, role: "implementer", last_action: "streaming",
}, null, 2));

// Interrupted legacy run: no status.json, no result.json (process died before finalize).
const interrupted = path.join(runsDir, "interrupted-run-4");
fs.mkdirSync(interrupted, { recursive: true });
fs.writeFileSync(path.join(interrupted, "brief.txt"), "ROLE=implementer");
fs.utimesSync(interrupted, new Date("2026-08-13T10:00:00Z"), new Date("2026-08-13T10:00:00Z"));

// New-format run: <seq>-<role>-<shortid>/ folder, full UUID kept in status.json run_id.
const newFmt = path.join(runsDir, "01-implementer-abcdef12");
fs.mkdirSync(newFmt, { recursive: true });
write(path.join(newFmt, "status.json"), JSON.stringify({
  status: "completed", run_id: "abcdef12-3456-7890-abcd-ef1234567890",
  started_at: "2026-08-14T10:00:00", updated_at: "2026-08-14T11:00:00",
  pid: 888, role: "implementer", exit_code: 0, decision: "PASS", duration: "01:00:00", last_action: "finished",
}, null, 2));

// New-format interrupted run: only brief.txt — role must fall back to the dir name.
const newInt = path.join(runsDir, "05-verifier-bbbbbbbb");
fs.mkdirSync(newInt, { recursive: true });
fs.writeFileSync(path.join(newInt, "brief.txt"), "ROLE=verifier");
fs.utimesSync(newInt, new Date("2026-08-15T10:00:00Z"), new Date("2026-08-15T10:00:00Z"));

// --- F5: a killed relay must not keep reporting RUNNING or hold CURRENT ------
// The mission-004 case, reproduced: `02-plan_reviewer` was cut, so it never
// rewrote its own status.json and left `status: "running"` next to a dead pid,
// while `CURRENT` stayed pinned to it and a newer live run went unmarked.
// These fixtures live in their own runs dir so they cannot add or reorder
// anything the assertions above and below make about `runsDir`.
const liveDir = path.join(root, "runs-liveness");
// A provably dead pid: spawn and reap a child, then use the pid it had. This
// never depends on which pids the machine happens to have in use.
const reapedPid = spawnSync(process.execPath, ["-e", ""]).pid;
assert(Number.isInteger(reapedPid) && reapedPid > 0, "the reaped child should have a pid");

const f5Cut = path.join(liveDir, "02-plan_reviewer-deadbeef");
fs.mkdirSync(f5Cut, { recursive: true });
write(path.join(f5Cut, "status.json"), JSON.stringify({
  status: "running", started_at: "2026-08-20T23:13:00", updated_at: "2026-08-20T23:13:47",
  pid: reapedPid, role: "plan_reviewer", last_action: "streaming",
}, null, 2));

const f5Live = path.join(liveDir, "04-implementer-abcdef99");
fs.mkdirSync(f5Live, { recursive: true });
write(path.join(f5Live, "status.json"), JSON.stringify({
  status: "running", started_at: "2026-08-20T23:40:00", updated_at: "2026-08-20T23:45:00",
  pid: process.pid, role: "implementer", last_action: "streaming",
}, null, 2));

const liveRuns = listRunsOldestNewest(liveDir);
const cutMeta = liveRuns.find((r) => r.dirName === "02-plan_reviewer-deadbeef");
const liveMeta = liveRuns.find((r) => r.dirName === "04-implementer-abcdef99");
assert(cutMeta && liveMeta, "both liveness fixtures should be listed");
// The raw value must stay "running": run-recovery's isStaleRun reads this marker
// (with its own injectable probe) to decide that a run is stale, so rewriting it
// here would make the recovery layer blind. The reconciliation belongs to the
// report, and that is what statusCellText is asserted on below.
assert(cutMeta.status === "running", `readRunMeta must report the recorded status verbatim, got ${cutMeta.status}`);
assert(statusCellText(cutMeta) === "KILLED", `the report cell for a dead running relay must read KILLED, got ${statusCellText(cutMeta)}`);
assert(statusCellText(liveMeta) === "RUNNING", "a live run's cell must still read RUNNING");
assert(liveMeta.status === "running", "running + live pid must stay running");
assert(cutMeta.pid === reapedPid && liveMeta.pid === process.pid, "the recorded pids must still be reported verbatim");

const f5Current = detectCurrentRun(liveRuns);
assert(f5Current && f5Current.dirName === "04-implementer-abcdef99", `CURRENT must be the newest live run, got ${f5Current && f5Current.dirName}`);
assert(detectCurrentRun([cutMeta]) === null, "a killed run must never become CURRENT, not even on its own");
const f5Finished = { ...liveMeta, status: "completed", decision: "PASS", exit_code: 0, pid: reapedPid };
const f5AfterStop = detectCurrentRun([cutMeta, f5Finished]);
assert(f5AfterStop && f5AfterStop.dirName === "04-implementer-abcdef99", "with no live run, CURRENT falls to the newest real run and never to the killed one");

// --- Capped run (backlog 003#15): continued, never failed ---
// A cap-breach generation finalizes status.json as "capped" while its
// result.json keeps the true terminal state (failed + capped marker). The
// report must prefer the run's own status file, and a capped run must never
// become CURRENT — it was superseded by its continuation generation.
const cappedDir = path.join(runsDir, "06-implementer-ccccdddd");
fs.mkdirSync(cappedDir, { recursive: true });
write(path.join(cappedDir, "status.json"), JSON.stringify({
  status: "capped", started_at: "2026-08-16T10:00:00", updated_at: "2026-08-16T10:05:00",
  pid: 999, role: "implementer", exit_code: null, duration: "00:05:00", last_action: "finished",
}, null, 2));
write(path.join(cappedDir, "result.json"), JSON.stringify({
  status: "failed", role: "implementer", startedAt: "2026-08-16T10:00:00.000Z",
  capped: {type: "turns", used: 41, limit: 40},
}, null, 2));
const cappedMeta = readRunMeta(cappedDir, "06-implementer-ccccdddd");
assert(cappedMeta.status === "capped", `status.json capped must win over result.json failed, got ${cappedMeta.status}`);
assert(statusCellText(cappedMeta) === "CAPPED", `capped run cell must read CAPPED, got ${statusCellText(cappedMeta)}`);
assert(detectCurrentRun([cappedMeta]) === null, "a capped run must never become CURRENT, not even on its own");
const olderReal = {dirName: "old-real", status: "completed", started_at: "2026-08-10T10:00:00"};
assert(detectCurrentRun([cappedMeta, olderReal]) === olderReal, "CURRENT must skip a newer capped run for the older real one");

// abbrevId / normalizeStatus.
assert(abbrevId("modern-run-2") === "modern-r", "abbrevId should take first 8 chars");
assert(abbrevId(null) === "", "abbrevId(null) should be empty");
assert(normalizeStatus("running") === "RUNNING", "normalizeStatus should uppercase");
assert(normalizeStatus(null) === "UNKNOWN", "normalizeStatus(null) should be UNKNOWN");

// formatTimestamp: single fixed-width UTC format, right-align friendly.
assert(formatTimestamp("2026-08-11T10:00:00") === "2026-08-11 10:00:00 UTC", "naive ISO should be treated as UTC");
assert(formatTimestamp("2026-08-15T16:05:31.348Z") === "2026-08-15 16:05:31 UTC", "Z-suffixed ISO should format in UTC");
assert(formatTimestamp("2026-08-18T08:58:47+03:00") === "2026-08-18 08:58:47 +03:00", "offset ISO should keep its own source clock/hour, not shift to UTC");
assert(formatTimestamp(null) === "-", "formatTimestamp(null) should be -");
assert(formatTimestamp("not-a-date") === "not-a-date", "unparseable timestamps should pass through");
assert(formatTimestamp("2026-08-11 10:00:00") === "2026-08-11 10:00:00 UTC", "space-separated naive ISO should parse too");

// readRunMeta for legacy fallback.
const lm = readRunMeta(legacy, "legacy-run-1");
assert(lm.status === "completed", "legacy run should derive status from result.json");
assert(lm.role === "implementer", "legacy run should derive role from result.json");
assert(lm.hasStatusFile === false && lm.hasResultFile === true, "legacy run detection flags");
assert(lm.hasProgress === false, "legacy run should not have progress.log");
assert(lm.started_at === "2026-08-10T10:00:00.000Z", "legacy run should use result.startedAt");
assert(lm.exit_code === 0 && lm.decision === "PASS", "legacy run should derive exit/decision from result.json");

// readRunMeta for modern run.
const mm = readRunMeta(modern, "modern-run-2");
assert(mm.hasStatusFile === true && mm.hasProgress === true, "modern run flags");
assert(mm.pid === 555 && mm.duration === "01:00:00", "modern run should carry pid/duration");

// readRunMeta for interrupted legacy run (no files beyond brief.txt).
const im = readRunMeta(interrupted, "interrupted-run-4");
assert(im.status === "unknown", "file-less legacy dir should be UNKNOWN, not running");
assert(im.hasStatusFile === false && im.hasResultFile === false, "interrupted legacy flags");
assert(im.started_at === "2026-08-13T10:00:00.000Z", "file-less legacy run should use dir mtime as started_at");

// readRunMeta for new-format run: id comes from status.run_id, folder name preserved.
const nf = readRunMeta(newFmt, "01-implementer-abcdef12");
assert(nf.id === "abcdef12-3456-7890-abcd-ef1234567890", "new-format run should expose full run_id");
assert(nf.dirName === "01-implementer-abcdef12", "new-format run should keep dir name");
assert(nf.seq === "01" && nf.shortId === "abcdef12", "new-format run should parse seq/shortId");
assert(abbrevId(nf.id) === "abcdef12", "abbrevId(run_id) should equal the folder short id");
assert(nf.role === "implementer" && nf.status === "completed", "new-format run role/status");

// readRunMeta for new-format interrupted run: role falls back to the folder name.
const ni = readRunMeta(newInt, "05-verifier-bbbbbbbb");
assert(ni.status === "unknown", "file-less new-format dir should be UNKNOWN");
assert(ni.role === "verifier", "new-format dir should derive role from folder name");

// Oldest -> newest ordering.
const list = listRunsOldestNewest(runsDir);
assert(list.length === 7, `should list 7 runs (got ${list.length})`);
assert(list[0].id === "legacy-run-1" && list[1].id === "modern-run-2" && list[2].id === "running-run-3" && list[3].id === "interrupted-run-4" && list[4].id === "abcdef12-3456-7890-abcd-ef1234567890" && list[5].id === "05-verifier-bbbbbbbb" && list[6].id === "06-implementer-ccccdddd", "ordering should be oldest -> newest by started_at");

// CURRENT RUN detection: running wins.
const cur = detectCurrentRun(list);
assert(cur && cur.id === "running-run-3", "CURRENT should be the running run");

// CURRENT RUN detection: no running -> newest REAL run (unknown/interrupted excluded).
const cur2 = detectCurrentRun(list.filter((r) => r.id !== "running-run-3"));
assert(cur2 && cur2.id === "abcdef12-3456-7890-abcd-ef1234567890", "without running, CURRENT should be newest real run, skipping interrupted");

// CURRENT RUN detection: only interrupted/unknown runs -> null.
assert(detectCurrentRun(list.filter((r) => r.id === "interrupted-run-4")) === null, "only-unknown runs -> CURRENT null");

// CURRENT RUN detection: empty.
assert(detectCurrentRun([]) === null, "no runs -> CURRENT null");

// PRICE/TURNS cells: compact K-format for the weighted price, plain integer
// for turns, "-" whenever usage was never recorded (null usage,
// driverless adapters, non-finite values) — never a fabricated number.
assert(priceCellText({usage: {priceWeighted: 64935.3}}) === "64.9K", "price 64935.3 renders 64.9K");
assert(priceCellText({usage: {priceWeighted: 999.4}}) === "999", "sub-1000 price rounds to an integer");
assert(priceCellText({usage: {priceWeighted: 1000}}) === "1.0K", "exactly-1000 price takes the K form");
assert(priceCellText({}) === "-", "missing usage renders -");
assert(priceCellText({usage: null}) === "-", "null usage renders -");
assert(priceCellText({usage: {priceWeighted: NaN}}) === "-", "non-finite price renders -");
assert(turnsCellText({usage: {turns: 8}}) === "8", "turns render as-is");
assert(turnsCellText({}) === "-", "missing turns render -");
assert(turnsCellText({usage: {turns: null}}) === "-", "null turns render -");

// CONTEXT cell (Backlog #26 Step B): the RAW growing term (cacheRead +
// input — the cap's own measure), never the price-weighted figure. Same
// K-format as PRICE, "~" prefix while running, "-" when unmeasured.
assert(contextCellText({usage: {input: 1000, cacheRead: 500000}}) === "501.0K", "context is the raw growing term in K-format");
assert(contextCellText({usage: {input: 10, cacheRead: 20}}) === "30", "sub-1000 context rounds to an integer");
assert(contextCellText({status: "running", usage: {input: 1000, cacheRead: 500000}}) === "~501.0K", "running context carries the live ~ prefix");
assert(contextCellText({}) === "-", "missing usage renders -");
assert(contextCellText({usage: null}) === "-", "null usage renders -");
assert(contextCellText({usage: {cacheRead: 5}}) === "-", "missing parts render -");
assert(contextCellText(mm) === "501.0K", `mm context must be 501.0K, got ${contextCellText(mm)}`);

// readRunMeta exposes usage from status.json; legacy runs without it read null.
assert(mm.usage?.turns === 8 && mm.usage?.priceWeighted === 64935.3, `readRunMeta must surface usage from status.json, got ${JSON.stringify(mm.usage)}`);
assert(lm.usage === null, `runs without usage must read null, got ${JSON.stringify(lm.usage)}`);
// result.json fallback (own runs dir so it cannot reorder the shared list):
// status.json without usage, result.json with usage.
const fbRoot = path.join(root, "runs-usage-fallback");
const fbDir = path.join(fbRoot, "07-verifier-dddd1111");
write(path.join(fbDir, "status.json"), JSON.stringify({
  status: "completed", started_at: "2026-08-17T10:00:00", updated_at: "2026-08-17T10:01:00",
  role: "verifier", exit_code: 0, duration: "00:01:00", last_action: "finished",
}, null, 2));
write(path.join(fbDir, "result.json"), JSON.stringify({
  status: "completed", role: "verifier",
  usage: {input: 1, cacheCreation: 0, cacheRead: 0, output: 1, turns: 3, priceWeighted: 1234.5},
}, null, 2));
const fb = readRunMeta(fbDir, "07-verifier-dddd1111");
assert(fb.usage?.turns === 3 && fb.usage?.priceWeighted === 1234.5, `readRunMeta must fall back to result.json usage, got ${JSON.stringify(fb.usage)}`);
assert(priceCellText(fb) === "1.2K" && turnsCellText(fb) === "3", "fallback usage renders in the cells");
assert(contextCellText(fb) === "1", "fallback context renders the raw growing term (1+0)");

// taskRef: the run's actual task scope rides status.json (result.json never
// carried it) and renders in the CURRENT RUN detail next to the grouping-only
// task key. Runs without it read null and render "-".
assert(mm.taskRef === "T001 > T003", `readRunMeta must surface taskRef from status.json, got ${mm.taskRef}`);
assert(lm.taskRef === null, `runs without taskRef must read null, got ${lm.taskRef}`);
const mmDetail = renderCurrentDetail(mm, []);
assert(mmDetail.includes("taskRef: T001 > T003"), `CURRENT RUN detail must show the task scope: ${mmDetail}`);
assert(mmDetail.includes("task: -"), `CURRENT RUN detail keeps the grouping key visible alongside taskRef: ${mmDetail}`);
const lmDetail = renderCurrentDetail(lm, []);
assert(lmDetail.includes("taskRef: -"), `CURRENT RUN detail without taskRef must show "-": ${lmDetail}`);
// taskGroup-first grouping (093 1.2): new runs write taskGroup only, legacy
// dirs with task only must group exactly as before without crash.
const tgRoot = path.join(root, "runs-task-group");
const tgDir = path.join(tgRoot, "01-implementer-abcdef99");
write(path.join(tgDir, "status.json"), JSON.stringify({
  status: "completed", started_at: "2026-08-17T10:00:00", updated_at: "2026-08-17T10:01:00",
  role: "implementer", taskGroup: "T006",
}, null, 2));
const tg = readRunMeta(tgDir, "01-implementer-abcdef99");
assert(tg.task === "T006", `readRunMeta must surface taskGroup as the grouping key, got ${tg.task}`);
assert(renderCurrentDetail(tg, []).includes("task: T006"), "CURRENT RUN detail must show the taskGroup T-label under the task: label");
const legacyTaskDir = path.join(tgRoot, "02-implementer-bbcdef99");
write(path.join(legacyTaskDir, "status.json"), JSON.stringify({
  status: "completed", started_at: "2026-08-17T10:02:00", updated_at: "2026-08-17T10:03:00",
  role: "implementer", task: "T006",
}, null, 2));
const legacyTask = readRunMeta(legacyTaskDir, "02-implementer-bbcdef99");
assert(legacyTask.task === "T006", `legacy task-only dirs must keep grouping, got ${legacyTask.task}`);
// CURRENT RUN detail carries price/turns on the exit_code line; runs
// without usage show "-" there too.
assert(mmDetail.includes("price: 64.9K") && mmDetail.includes("turns: 8"), `CURRENT RUN detail must show price/turns: ${mmDetail}`);
assert(mmDetail.includes("context: 501.0K"), `CURRENT RUN detail must show the raw context next to price: ${mmDetail}`);
assert(lmDetail.includes("price: -") && lmDetail.includes("turns: -"), `CURRENT RUN detail without usage must show "-": ${lmDetail}`);

// progressTail.
const tail = progressTail(modern, 5);
assert(tail.length === 5, "progressTail should return last N lines");
const tailAll = progressTail(modern, 100);
assert(tailAll.length === 50, "progressTail should return all lines when maxLines exceeds count");
assert(progressTail(legacy, 5).length === 0, "legacy run should have empty progress tail");

// annotateOwnerLiveness / displayStatus: the reader-level reconciliation the new
// renderer relies on. A run left "running" by a dead orchestrator reads as the
// stale label; a live run / live owner stays running; other-platform owner files
// leave liveness unknown (never relabelled).
const deadOwner = () => false, liveOwner = () => true;
assert(displayStatus({status: "running", ownerAlive: false}, {isAlive: deadOwner}) === "interrupted", "dead owner + dead pid -> interrupted");
assert(displayStatusLabel({status: "running", ownerAlive: false}, {isAlive: deadOwner}) === STALE_RUNNING_LABEL, "dead owner -> stale label");
assert(displayStatus({status: "running", ownerAlive: false}, {isAlive: liveOwner}) === "running", "live pid beats dead owner");
assert(displayStatus({status: "running", ownerAlive: true}, {isAlive: deadOwner}) === "running", "dead pid + live owner is between roles");
assert(displayStatus({status: "completed"}, {isAlive: deadOwner}) === "completed", "non-running status passes through");
const ann = annotateOwnerLiveness("/x", [{status: "running"}], {readOwner: () => ({pid: 7}), isOwnerAlive: deadOwner});
assert(ann[0].ownerAlive === false, "annotateOwnerLiveness marks ownerAlive");
assert(annotateOwnerLiveness("/x", [{status: "running"}], {readOwner: () => null})[0].ownerAlive === undefined, "no owner file -> unknown");

// --- New 094 layout via renderWatchReport / writeWatchReportFile -------------
// The renderer now delegates to scripts/watch-report.mjs. Only the run readers
// above are unchanged; these assertions pin the new layout and its inputs.
const layoutRoot = path.join(root, "layout");
const layoutRuns = path.join(layoutRoot, ".autopilot", "missions", "004-layout", "runs");
write(path.join(layoutRoot, ".autopilot", "state.json"), JSON.stringify({
  phase: "implementing", step: "implement", mission: "004-layout", missionSeq: "004",
  phaseIndex: 1, attempt: 1, failureBudgets: {},
}, null, 2));
write(path.join(layoutRoot, ".autopilot", "config.json"), JSON.stringify({
  policy: {
    failure_budgets: {implementationFailureBudget: 3, verificationFailureBudget: 3, adapterRetryBudget: 2, infrastructureRetryBudget: 2},
    caps: {implementer: {max_tokens: 200000}, code_reviewer: {max_tokens: 100000}},
  },
}, null, 2));
const layoutWrite = (name, s) => {
  const dir = path.join(layoutRuns, name);
  write(path.join(dir, "status.json"), JSON.stringify({ status: "completed", run_id: `${name.slice(-8)}-0000-0000-0000-0000000000aa`, ...s }, null, 2));
};
layoutWrite("01-implementer-aaaa0001", {
  role: "implementer", phase: "1", taskRef: "T1.1", attempt: 1,
  started_at: "2026-09-01T10:00:00", updated_at: "2026-09-01T10:05:00", duration: "00:05:00",
  exit_code: 0, decision: "PASS",
  configuredModel: "claude-sonnet-4-5", resolvedModel: "claude-opus-4-5", modelMismatch: true,
  usage: {input: 100, cacheRead: 500000, turns: 4, priceWeighted: 1234.5},
});
layoutWrite("02-code_reviewer-bbbb0002", {
  role: "code_reviewer", phase: "1", taskRef: "T1.1", attempt: 1,
  started_at: "2026-09-01T10:10:00", updated_at: "2026-09-01T10:12:00", duration: "00:02:00",
  exit_code: 0, decision: "PASS",
});
// A LIVE current run (this process's pid) so CURRENT RUN and LIVE PROGRESS render.
layoutWrite("03-implementer-cccc0003", {
  status: "running", role: "implementer", phase: "2", taskRef: "T2.1", attempt: 1,
  started_at: "2026-09-01T11:00:00", updated_at: "2026-09-01T11:05:00",
  pid: process.pid, last_action: "streaming",
});
write(path.join(layoutRuns, "03-implementer-cccc0003", "progress.log"),
  "2026-09-01T11:00:00  START | ROLE=implementer | PHASE=2 | TASK=T2.1 | ATTEMPT=1 | PID=1\n");
// Gate start/result for phase 1 -> a GATE (orchestrator) row.
write(path.join(layoutRoot, ".autopilot", "missions", "004-layout", "watch-events.jsonl"), [
  JSON.stringify({type: "gate_start", phase: 1, command: "true", at: "2026-09-01T10:15:00"}),
  JSON.stringify({type: "gate_result", phase: 1, ok: true, at: "2026-09-01T10:16:00", progress: {total: 12, passed: 12, failed: 0}}),
].join("\n") + "\n");

const layout = renderWatchReport(layoutRoot, "004-layout", { tail: 5 });
// Clock-stamped title once, then the watcher.md sections in order.
assert(/^=== \d{2}:\d{2}:\d{2} — PIPELINE STATE ===$/m.test(layout), `watch render should print the clock-stamped title once: ${layout.slice(0, 200)}`);
assert((layout.match(/PIPELINE STATE ===/g) || []).length === 1, "the clock title must appear exactly once (no duplicate)");
assert(layout.includes("Mission: 004-layout"), "PIPELINE STATE names the mission");
assert(layout.includes("Status:") && layout.includes("Stage:"), "PIPELINE STATE has the Status/Stage lines");
// Backlog #7: a stage that has not started renders nothing. This fixture has an
// implementation run and no planner runs, so only IMPLEMENTATION appears.
assert(!layout.includes("=== PLANNING STAGE ==="), "watch render omits the not-started PLANNING STAGE");
assert(layout.includes("=== IMPLEMENTATION STAGE ==="), "watch render includes IMPLEMENTATION STAGE");
assert(!layout.includes("=== FINAL REVIEW STAGE ==="), "watch render omits the not-started FINAL REVIEW STAGE");
assert(layout.includes("GATE (orchestrator)"), "gate events render a GATE (orchestrator) row");
assert(layout.includes("12/12 runs passed"), "the gate row carries its passed/total progress");
assert(layout.includes("01-implementer-aaaa0001") && layout.includes("02-code_reviewer-bbbb0002"), "implementation run rows render");
assert(layout.includes("T1.1"), "run rows carry their taskRef");
assert(layout.includes("opus-4.5"), "MODEL cell shows the shortened resolved model");
assert(layout.includes("=== CURRENT RUN ==="), "a live run renders the CURRENT RUN section");
assert(layout.includes("› "), "the live run row carries the › running marker");
assert(!layout.includes("<- CURRENT"), "the retired <- CURRENT marker is gone");
assert(layout.includes("=== LIVE PROGRESS"), "decoded LIVE PROGRESS renders for a live run");
assert(layout.includes("START"), "LIVE PROGRESS decodes the START entry");
const layoutRunsList = listRunsOldestNewest(layoutRuns);
assert(detectCurrentRun(layoutRunsList)?.dirName === "03-implementer-cccc0003", "detectCurrentRun is unchanged and still finds the live run");

// writeWatchReportFile: mission WATCH-REPORT.md, fenced, atomically replaced.
const outFile = writeWatchReportFile(layoutRoot, "004-layout", { tail: 5 });
assert(outFile === path.join(layoutRoot, ".autopilot", "missions", "004-layout", "WATCH-REPORT.md"), "watch file should sit next to the mission REPORT.md");
assert(fs.existsSync(outFile), "watch file should exist after write");
const fileContent = fs.readFileSync(outFile, "utf8");
assert(fileContent.startsWith("```\n") && fileContent.trimEnd().endsWith("```"), "watch .md file should be wrapped in a fenced code block");
assert(fileContent.includes("01-implementer-aaaa0001") && fileContent.includes("=== IMPLEMENTATION STAGE ==="), "watch file should contain the new layout");
assert(!fileContent.includes(".tmp."), "watch file should be atomically replaced (no leftover tmp marker)");

// A cancelled mission: Status: CANCELLED and no CURRENT RUN section at all.
write(path.join(layoutRoot, ".autopilot", "state.json"), JSON.stringify({
  phase: "cancelled", step: "cancelled", mission: "004-layout", missionSeq: "004",
  lastCancelled: {at: "2026-09-01T12:00:00", reason: "operator", previousPhase: "implementing", previousStep: "implement", mission: "004-layout"},
}, null, 2));
const cancelledLayout = renderWatchReport(layoutRoot, "004-layout", { tail: 5 });
assert(!cancelledLayout.includes("=== CURRENT RUN ==="), "cancelled mission must not render a CURRENT RUN section");
assert(cancelledLayout.includes("CANCELLED") && cancelledLayout.includes("reason: operator"), `cancelled status carries its reason: ${cancelledLayout.slice(0, 300)}`);

// The renderer is STRICTLY read-only: rendering a stale-looking RUNNING run must
// NOT mutate its status.json or append to progress.log. Stale-run recovery is an
// orchestrator startup responsibility — watch rendering never recovers.
const staleRoot = path.join(root, "stale");
const staleRun = path.join(staleRoot, ".autopilot", "runs", "01-implementer-aaaaaaaa");
write(path.join(staleRun, "status.json"), JSON.stringify({
  status: "running", role: "implementer", pid: 2147483646,
  started_at: "2026-09-01T09:00:00", updated_at: "2026-09-01T09:00:00",
}, null, 2));
write(path.join(staleRoot, ".autopilot", "owner.pid"), JSON.stringify({pid: 2147483645}));
const staleStatusBefore = fs.readFileSync(path.join(staleRun, "status.json"), "utf8");
const staleReport = renderWatchReport(staleRoot, null, { isOwnerAlive: deadOwner });
const staleRow = staleReport.split("\n").find((l) => l.includes("01-implementer-aaaaaaaa"));
assert(staleRow && staleRow.includes("INTERRUPTED") && !staleRow.includes("RUNNING"), "the stale row's STATUS cell reads the bare word INTERRUPTED, never RUNNING");
assert(staleRow && staleRow.includes("orchestrator not running"), "the stale row's NOTE carries the orchestrator-not-running reason");
assert(staleRow && !staleRow.includes("INTERRUPTED (ORCHESTRATOR NOT RUNNING)"), "the stale row's STATUS cell is not widened by the parenthesised reason");
assert(!staleReport.includes("=== CURRENT RUN ==="), "a stale run is never CURRENT");
assert(fs.readFileSync(path.join(staleRun, "status.json"), "utf8") === staleStatusBefore, "watch render must NOT mutate a stale-looking RUNNING status.json");
const liveReport = renderWatchReport(staleRoot, null, { isOwnerAlive: liveOwner });
assert(/01-implementer-aaaaaaaa/.test(liveReport) && liveReport.includes("=== CURRENT RUN ==="), "a live owner keeps the run RUNNING and CURRENT");

// watchRunsDir / readWatchEvents: mission-scoped paths, malformed lines skipped.
assert(watchRunsDir(layoutRoot, "004-layout") === layoutRuns, "watchRunsDir resolves the mission runs bucket");
assert(watchRunsDir(layoutRoot, null) === path.join(layoutRoot, ".autopilot", "runs"), "watchRunsDir falls back to the flat bucket");
assert(readWatchEvents(layoutRoot, "004-layout").length === 2, "readWatchEvents parses the mission events file");
assert(readWatchEvents(layoutRoot, "no-such-mission").length === 0, "missing events file -> []");

// staleRunningNote (used by `ap status`) is unchanged.
assert(staleRunningNote(staleRoot, null, { isOwnerAlive: deadOwner })?.includes("interrupted (orchestrator not running)"), "staleRunningNote reports a dead-owner running run");
assert(staleRunningNote(staleRoot, null, { isOwnerAlive: liveOwner }) === null, "no stale running run -> null note");

// renumberRuns: renames legacy UUID dirs chronologically to <seq>-<role>-<shortid>.
const renDir = path.join(root, "renumber");
fs.mkdirSync(renDir, { recursive: true });
write(path.join(renDir, "90623502-9b6c-43af-96f9-c7ecf88a51d3", "status.json"), JSON.stringify({ status: "interrupted", run_id: "9b6c43af-0000-4000-8000-000000000001", role: "verifier", started_at: "2026-08-19T02:00:00" }));
write(path.join(renDir, "1418dbdd-a10b-482a-81c2-cd4688a3f404", "result.json"), JSON.stringify({ status: "completed", role: "implementer", startedAt: "2026-08-18T10:00:00Z" }));
write(path.join(renDir, "9cf595e8-4c74-42a0-bc6c-feeadfebbc51", "brief.txt"), "ROLE=verifier\nTASK: something");
fs.mkdirSync(path.join(renDir, "shell-abc123", "git-guard"), { recursive: true });
fs.writeFileSync(path.join(renDir, "shell-abc123", "git-guard", "git"), "");
const renamed = renumberRuns(renDir, { fallbackRole: "run" });
assert(renamed === 3, `renumberRuns should rename 3 run dirs, got ${renamed}`);
const renNames = fs.readdirSync(renDir).sort();
assert(renNames.length === 4, `renumber dir should have 4 entries incl shell-*, got ${renNames.length}`);
assert(renNames.includes("shell-abc123"), "shell-* scaffolding must be left unchanged");
assert(renNames[0] === "01-implementer-1418dbdd", `oldest run should be 01-implementer-1418dbdd, got ${renNames[0]}`);
assert(renNames[1] === "02-verifier-9b6c43af", `status.json role should win, got ${renNames[1]}`);
assert(renNames[2] === "03-verifier-9cf595e8", `brief.txt role should recover verifier, got ${renNames[2]}`);
assert(nextRunSeq(renDir) === 4, `nextRunSeq after renumber should be 4, got ${nextRunSeq(renDir)}`);

// nextRunSeq must NOT count legacy UUID-only dirs that start with digits.
const seqDir = path.join(root, "seq");
fs.mkdirSync(seqDir, { recursive: true });
fs.mkdirSync(path.join(seqDir, "90623502-9b6c-43af-96f9-c7ecf88a51d3"), { recursive: true });
fs.mkdirSync(path.join(seqDir, "02-implementer-abcdef12"), { recursive: true });
assert(nextRunSeq(seqDir) === 3, `nextRunSeq should ignore legacy UUID dirs, got ${nextRunSeq(seqDir)}`);
assert(parseRunDirName("90623502-9b6c-43af-96f9-c7ecf88a51d3") === null, "legacy UUID dir must not parse as a run dir");

fs.rmSync(root, { recursive: true, force: true });
console.log("run-history: 1/1 PASS");
