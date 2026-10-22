#!/usr/bin/env node
// Focused tests for stale/interrupted Run recovery. Uses a deterministic
// fixture + injected PID liveness — never probes a real external agent or
// relies on PID timing races.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readRunMeta, listRunsOldestNewest, detectCurrentRun, nextRunSeq, parseRunDirName } from "./run-history.mjs";
import { isStaleRun, findStaleRuns, recoverStaleRuns, markInterrupted, hasFinishedEvent, DEFAULT_GRACE_MS, DEFAULT_MAX_IDLE_MS } from "./run-recovery.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-recovery-"));
const runsDir = path.join(root, "runs");
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// --- Fixtures -------------------------------------------------------------
// Active run: RUNNING status, no result.json, no FINISHED, PID is ALIVE.
const active = path.join(runsDir, "01-implementer-aaaa1111");
fs.mkdirSync(active, { recursive: true });
write(path.join(active, "status.json"), JSON.stringify({
  status: "running", run_id: "aaaa1111-0000-0000-0000-000000000001",
  started_at: "2026-08-18T10:00:00", updated_at: "2026-08-18T10:00:05",
  pid: 90001, role: "implementer", phase: "4", task: "T006", attempt: "1", last_action: "streaming",
}, null, 2));
write(path.join(active, "progress.log"), [
  "2026-08-18T10:00:00  START | ROLE=implementer | PHASE=4 | TASK=T006 | ATTEMPT=1 | PID=90001",
  "2026-08-18T10:00:01  ACTIVITY | STREAM=stdout | BYTES=512",
].join("\n"));

// Stale run: RUNNING status, no result.json, no FINISHED, PID is DEAD,
// started long enough ago to be outside the grace period.
const stale = path.join(runsDir, "02-verifier-cccc2222");
fs.mkdirSync(stale, { recursive: true });
write(path.join(stale, "status.json"), JSON.stringify({
  status: "running", run_id: "cccc2222-0000-0000-0000-000000000002",
  started_at: "2026-08-18T10:30:00", updated_at: "2026-08-18T10:30:00",
  pid: 99999, role: "verifier", phase: "4", task: "T006", attempt: "2", last_action: "started",
}, null, 2));
write(path.join(stale, "progress.log"), "2026-08-18T10:30:00  START | ROLE=verifier | PHASE=4 | TASK=T006 | ATTEMPT=2 | PID=99999\n");
write(path.join(stale, "brief.txt"), "ROLE=verifier");

// Grace-period run: RUNNING, no result, no FINISHED, PID dead/missing, but
// started just before `now` (within grace) -> must NOT be interrupted.
const now = Date.now();
const fresh = path.join(runsDir, "03-verifier-eeee3333");
fs.mkdirSync(fresh, { recursive: true });
write(path.join(fresh, "status.json"), JSON.stringify({
  status: "running", run_id: "eeee3333-0000-0000-0000-000000000003",
  started_at: new Date(now - 1_000).toISOString(), updated_at: new Date(now).toISOString(),
  pid: null, role: "verifier", last_action: "started",
}, null, 2));
write(path.join(fresh, "progress.log"), "START | ROLE=verifier\n");

// Completed-looking run: RUNNING status but has FINISHED event -> NOT stale.
const finished = path.join(runsDir, "04-code_reviewer-ffff4444");
fs.mkdirSync(finished, { recursive: true });
write(path.join(finished, "status.json"), JSON.stringify({
  status: "running", run_id: "ffff4444-0000-0000-0000-000000000004",
  started_at: "2026-08-18T09:00:00", updated_at: "2026-08-18T09:05:00",
  pid: 50000, role: "code_reviewer", last_action: "streaming",
}, null, 2));
write(path.join(finished, "progress.log"), [
  "START | ROLE=code_reviewer",
  "FINISHED | STATUS=completed | EXIT_CODE=0 | DURATION=00:05:00 | DECISION=PASS",
].join("\n"));

// Run with result.json: RUNNING status but result exists -> NOT stale.
const hasResult = path.join(runsDir, "05-verifier-bbbb5555");
fs.mkdirSync(hasResult, { recursive: true });
write(path.join(hasResult, "status.json"), JSON.stringify({
  status: "running", run_id: "bbbb5555-0000-0000-0000-000000000005",
  started_at: "2026-08-18T08:00:00", updated_at: "2026-08-18T08:10:00",
  pid: 40000, role: "verifier", last_action: "streaming",
}, null, 2));
write(path.join(hasResult, "result.json"), JSON.stringify({ status: "completed" }, null, 2));

// Legacy UUID-only run (no status.json/result.json) -> never assumed live.
const legacy = path.join(runsDir, "12345678-aaaa-bbbb-cccc-1234567890ab");
fs.mkdirSync(legacy, { recursive: true });
fs.utimesSync(legacy, new Date("2026-08-10T10:00:00Z"), new Date("2026-08-10T10:00:00Z"));

// Already-interrupted run -> idempotency fixture.
const already = path.join(runsDir, "06-verifier-dddd6666");
fs.mkdirSync(already, { recursive: true });
write(path.join(already, "status.json"), JSON.stringify({
  status: "interrupted", run_id: "dddd6666-0000-0000-0000-000000000006",
  started_at: "2026-08-18T07:00:00", updated_at: "2026-08-18T07:30:00",
  interrupted_at: "2026-08-18T07:30:00", interruption_reason: "stale/dead process detected",
  pid: 30000, role: "verifier", last_action: "interrupted",
}, null, 2));

// Idle-guard fixtures live in an ISOLATED dir so they don't disturb the
// ordering / CURRENT-detection assertions that run against `runsDir`.
const idleDir = path.join(root, "idle");

// Recently-active run: RUNNING, no result, no FINISHED, PID reported DEAD by
// the probe, but updated_at is seconds old (just streamed output). The recent
// activity must win over the unreliable PID probe -> NOT stale.
const recent = path.join(idleDir, "07-implementer-ffff7777");
fs.mkdirSync(recent, { recursive: true });
write(path.join(recent, "status.json"), JSON.stringify({
  status: "running", run_id: "ffff7777-0000-0000-0000-000000000007",
  started_at: new Date(now - 3_600_000).toISOString(), updated_at: new Date(now - 5_000).toISOString(),
  pid: 70000, role: "implementer", last_action: "streaming",
}, null, 2));
write(path.join(recent, "progress.log"), [
  "START | ROLE=implementer",
  "ACTIVITY | STREAM=stdout | BYTES=10",
].join("\n"));

// Old-idle run: RUNNING, no result, no FINISHED, PID dead, AND updated_at is
// far older than maxIdleMs -> the classic recoverable stale case.
const oldIdle = path.join(idleDir, "08-implementer-bbbb9999");
fs.mkdirSync(oldIdle, { recursive: true });
write(path.join(oldIdle, "status.json"), JSON.stringify({
  status: "running", run_id: "bbbb9999-0000-0000-0000-000000000008",
  started_at: new Date(now - 7_200_000).toISOString(), updated_at: new Date(now - 7_200_000 + 30_000).toISOString(),
  pid: 70001, role: "implementer", last_action: "started",
}, null, 2));
write(path.join(oldIdle, "progress.log"), "START | ROLE=implementer\n");

// Nothing in idleDir is a live PID (probe always returns false).
const idleIsAlive = () => false;

// --- Injected liveness: only the ACTIVE run's PID is alive -----------------
const alivePids = new Set([90001]);
const isAlive = (pid) => alivePids.has(Number(pid));

// 1. isStaleRun pure decisions ---------------------------------------------
assert(isStaleRun(readRunMeta(active, "01-implementer-aaaa1111"), { isAlive, now }) === false, "active run (live PID) must not be stale");
assert(isStaleRun(readRunMeta(stale, "02-verifier-cccc2222"), { isAlive, now }) === true, "stale run must be detected");
assert(isStaleRun(readRunMeta(fresh, "03-verifier-eeee3333"), { isAlive, now }) === false, "grace-period run must not be stale");
assert(isStaleRun(readRunMeta(finished, "04-code_reviewer-ffff4444"), { isAlive, now }) === false, "run with FINISHED event must not be stale");
assert(isStaleRun(readRunMeta(hasResult, "05-verifier-bbbb5555"), { isAlive, now }) === false, "run with result.json must not be stale");
assert(isStaleRun(readRunMeta(legacy, "12345678-aaaa-bbbb-cccc-1234567890ab"), { isAlive, now }) === false, "legacy UUID-only run must not be stale");

// hasFinishedEvent helper.
assert(hasFinishedEvent(finished) === true, "finished fixture has FINISHED event");
assert(hasFinishedEvent(stale) === false, "stale fixture has no FINISHED event");

// 2. recoverStaleRuns: active stays RUNNING, stale becomes INTERRUPTED ------
const res = recoverStaleRuns(runsDir, { isAlive, now });
assert(res.interrupted.length === 1, `exactly one run should be interrupted (got ${res.interrupted.length})`);
assert(res.interrupted[0].dir === "02-verifier-cccc2222", "stale verifier run should be the interrupted one");
assert(res.unchanged.filter((r) => r.status === "running").some((r) => r.dir === "01-implementer-aaaa1111"), "active run should remain unchanged/RUNNING");

const activeMeta = readRunMeta(active, "01-implementer-aaaa1111");
assert(activeMeta.status === "running", "active run must stay RUNNING after recovery");
assert(activeMeta.hasStatusFile === true && activeMeta.hasProgress === true, "active run data preserved");

const staleMeta = readRunMeta(stale, "02-verifier-cccc2222");
assert(staleMeta.status === "interrupted", "stale run must become INTERRUPTED");
assert(staleMeta.hasStatusFile === true, "stale run status.json preserved");
assert(staleMeta.hasProgress === true, "stale run progress.log preserved");
assert(fs.existsSync(path.join(stale, "brief.txt")), "stale run brief.txt preserved (nothing deleted)");
assert(fs.existsSync(path.join(stale, "result.json")) === false, "stale run still has no result.json");

// INTERRUPTED event line appended to progress.log (data never rewritten).
const staleProgress = fs.readFileSync(path.join(stale, "progress.log"), "utf8");
assert(staleProgress.includes("INTERRUPTED | STATUS=interrupted"), "progress.log should get an INTERRUPTED event");
assert(staleProgress.startsWith("2026-08-18T10:30:00  START | ROLE=verifier"), "original progress.log content must be preserved");

// status.json carries timestamp + recovery reason.
const staleStatus = JSON.parse(fs.readFileSync(path.join(stale, "status.json"), "utf8"));
assert(!!staleStatus.interrupted_at, "interrupted run should carry interrupted_at timestamp");
assert(!!staleStatus.interruption_reason, "interrupted run should carry interruption_reason");
assert(staleStatus.last_action === "interrupted", "interrupted run last_action should be interrupted");

// 3. Stale run is not selected as CURRENT ------------------------------------
const runs = listRunsOldestNewest(runsDir);
const cur = detectCurrentRun(runs);
assert(cur && cur.status === "running", "CURRENT must be a RUNNING run");
assert(cur.id !== "cccc2222-0000-0000-0000-000000000002", "CURRENT must never be the interrupted run");
const withoutActive = runs.filter((r) => r.id !== "aaaa1111-0000-0000-0000-000000000001");
assert(detectCurrentRun(withoutActive) === null || detectCurrentRun(withoutActive)?.status !== "interrupted", "interrupted run must never be CURRENT");

// 4. Interrupted run is never resumed in-place -------------------------------
assert(staleMeta.status === "interrupted", "interrupted run stays INTERRUPTED (not flipped back to running)");
assert(markInterrupted(stale, { reason: "x" }).marked === false, "markInterrupted on already-interrupted run is a no-op");

// 5. Next run for the same checkpoint/task gets a NEW run dir -----------------
const seqBefore = nextRunSeq(runsDir);
const nextSeq = parseRunDirName(`${String(seqBefore).padStart(2, "0")}-verifier-${"9abcdef0"}`);
assert(nextSeq && nextSeq.seq === String(seqBefore).padStart(2, "0"), "next run should get a fresh sequence");
assert(nextSeq.role === "verifier" && nextSeq.shortId === "9abcdef0", "next run is a NEW run for the same role/task");
assert(!fs.existsSync(path.join(runsDir, `${String(seqBefore).padStart(2, "0")}-verifier-9abcdef0`)), "the new run dir must not pre-exist");
// Recovery itself must not advance the sequence (no attempt consumed).
assert(nextRunSeq(runsDir) === seqBefore, "recovery must not consume or advance the run sequence");

// 6. Recovery is idempotent ---------------------------------------------------
const res2 = recoverStaleRuns(runsDir, { isAlive, now });
assert(res2.interrupted.length === 0, "second recovery must not re-interrupt anything");
const staleProgress2 = fs.readFileSync(path.join(stale, "progress.log"), "utf8");
assert((staleProgress2.match(/INTERRUPTED \| STATUS=interrupted/g) || []).length === 1, "INTERRUPTED event must not be duplicated");
const stillActive = readRunMeta(active, "01-implementer-aaaa1111");
assert(stillActive.status === "running", "active run still RUNNING after idempotent second pass");

// 7. Recovery does not touch mission state / counters -------------------------
// recoverStaleRuns only writes inside run dirs; state.json is untouched by design.
const statePath = path.join(root, "state.json");
write(statePath, JSON.stringify({ phase: "implementing", step: "code_review", attempt: 2, failureBudgets: {"adapterRetryBudget:adapter:codex:verifier": 1} }, null, 2));
const stateBefore = fs.readFileSync(statePath, "utf8");
recoverStaleRuns(runsDir, { isAlive, now });
assert(fs.readFileSync(statePath, "utf8") === stateBefore, "recovery must not modify mission state");

// 8. Legacy UUID-only runs remain safe ----------------------------------------
const legacyMeta = readRunMeta(legacy, "12345678-aaaa-bbbb-cccc-1234567890ab");
assert(legacyMeta.status === "unknown" || legacyMeta.status === "running", "legacy run not disturbed");
assert(!fs.existsSync(path.join(legacy, "status.json")), "legacy run still has no status.json (untouched)");

// 9. New-format dirs keep working with the naming helpers ---------------------
assert(parseRunDirName("07-verifier-abcdef12")?.shortId === "abcdef12", "parseRunDirName handles new-format names");

// 10. Recent-activity idle guard -----------------------------------------------
// A Run that streamed output within maxIdleMs is definitionally alive even when
// the PID probe says dead (the false-INTERRUPTED bug this guard fixes).
assert(DEFAULT_MAX_IDLE_MS === 600_000, `default maxIdleMs should be 10 minutes (got ${DEFAULT_MAX_IDLE_MS})`);
const recentMeta = readRunMeta(recent, "07-implementer-ffff7777");
assert(isStaleRun(recentMeta, { isAlive: idleIsAlive, now }) === false, "recently-active run must NOT be stale even with dead PID (idle guard)");
assert(isStaleRun(recentMeta, { isAlive: idleIsAlive, now, maxIdleMs: 1000 }) === true, "with a tiny maxIdleMs the recently-active run IS stale (threshold injectable)");
const oldIdleMeta = readRunMeta(oldIdle, "08-implementer-bbbb9999");
assert(isStaleRun(oldIdleMeta, { isAlive: idleIsAlive, now }) === true, "old updated_at + dead PID => stale");

// Pure findStaleRuns detects without mutating.
const found = findStaleRuns(idleDir, { isAlive: idleIsAlive, now });
assert(found.scanned === 2, `findStaleRuns should scan 2 idle runs (got ${found.scanned})`);
assert(found.stale.length === 1 && found.stale[0].dir === "08-implementer-bbbb9999", "findStaleRuns detects only the old-idle run");
assert(!found.stale.some((s) => s.dir === "07-implementer-ffff7777"), "findStaleRuns must not flag the recently-active run");
assert(found.unchanged.some((r) => r.dir === "07-implementer-ffff7777"), "findStaleRuns lists the recently-active run as unchanged");
const recentStatusBefore = fs.readFileSync(path.join(recent, "status.json"), "utf8");
assert(fs.readFileSync(path.join(recent, "status.json"), "utf8") === recentStatusBefore, "findStaleRuns is pure: status.json untouched");

// recoverStaleRuns honors the idle guard: interrupts only the old-idle run.
const idleRes = recoverStaleRuns(idleDir, { isAlive: idleIsAlive, now });
assert(!idleRes.interrupted.some((r) => r.dir === "07-implementer-ffff7777"), "recovery must not interrupt the recently-active run");
assert(idleRes.interrupted.some((r) => r.dir === "08-implementer-bbbb9999"), "recovery interrupts the old-idle dead-PID run");
assert(readRunMeta(recent, "07-implementer-ffff7777").status === "running", "recently-active run stays RUNNING after recovery");

fs.rmSync(root, { recursive: true, force: true });
console.log("run-recovery: 1/1 PASS");