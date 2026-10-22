// Atomic state-file write (TASK-7 / TASK-11 Phase 3).
//
// `saveState()` in `scripts/autopilot.mjs` — the CLI entry, which runs
// `main()` at import with `saveState` as a module-local `const` — calls this
// helper so the crash/rename behavior is importable and testable without
// executing the CLI (a test-only hook inside `autopilot.mjs` is not
// acceptable). The shared `write()` helper is untouched: it also produces
// per-run `brief.txt`/`stdout.log`/`result.json` and the GSD artifacts, and
// only `state.json` is read back as a whole document that must never be
// observed truncated.
//
// Protocol (same precedent as `scripts/config-migration.mjs`):
// serialize first, write a sibling temp file, fsync it, rename over the
// destination, fsync the parent directory. A crash leaves either the old
// complete state or the new complete state, never truncated JSON — readers
// only ever open the destination path, and partial bytes only ever land in
// the sibling temp file.
//
// Four deliberate deviations from that precedent:
// - Exact bytes are preserved: the precedent appends a trailing newline,
//   whereas `state.json` has none, so nothing is appended here.
// - Durability is fsync-backed, not just rename-atomic: the temp file is
//   fsynced before the rename and the parent directory entry is fsynced
//   after it (best-effort — some platforms cannot fsync directories), so a
//   power loss cannot leave a truncated destination that `loadState()`'s
//   unguarded `JSON.parse` could never resume from. Rename-atomicity alone
//   only covers process kill.
// - A rename that throws is retried with escalating backoff
//   (`RENAME_RETRY_DELAYS_MS`). Back-to-back renames land in the same
//   transient lock window (AV/indexer holds on Native Windows), so each
//   retry waits first — and the temp is rewritten before re-renaming, since
//   the previous temp may have been removed out from under us (a
//   cross-namespace reaper, AV quarantine) and re-renaming a deleted path
//   would fail ENOENT. Content is deterministic so rewriting is always safe.
//   A persistently failing rename is rethrown as a hard error — never a
//   silent fallback to a non-atomic direct write. (That hard error still
//   propagates to `main().catch` like any other `saveState()` I/O failure,
//   bypassing in-flow escalation guidance; the retries exist to make that
//   outcome rare rather than to re-route it.)
// - Close errors never mask the original failure: if the temp write fails,
//   the close attempt's error (if any) is swallowed and the write error
//   propagates, so a disk-full abort is diagnosed as ENOSPC rather than a
//   follow-on close error.
//
// Crash debris: every crash that wins the temp-write race but loses the
// rename race leaves `state.json.tmp-<pid>` behind. After each successful
// write this module best-effort reaps sibling temps that are both stale
// (older than `ORPHAN_TEMP_MAX_AGE_MS`) and either pid-dead or
// pid-unparseable. Both conditions are load-bearing: pid numberspaces differ
// across OS instances sharing one file (WSL2 and Windows write the same
// physical `state.json`), so ESRCH alone cannot prove a temp is abandoned —
// but a live writer's temp is always seconds old, while a crashed writer's
// temp ages indefinitely. A temp whose liveness cannot be disproven, or
// whose age cannot be read, is always kept: a concurrent writer's temp is
// never removed.
import fs from "node:fs";
import path from "node:path";

// Escalating backoff between rename attempts (initial try, then one retry
// per entry). Total worst-case added latency applies only to the persistent
// failure path; successful writes pay nothing.
export const RENAME_RETRY_DELAYS_MS = Object.freeze([200, 1000]);

// A sibling temp older than this cannot belong to an in-flight write (a
// temp exists only for the milliseconds of one call) and is reap-eligible
// once its pid is also dead or unparseable.
export const ORPHAN_TEMP_MAX_AGE_MS = 3_600_000;

// Sibling temp path for a destination. Pure string mapping, exported so
// tests can plant crashed-process temp files without hooks.
export function siblingTempPath(destPath) {
  return `${destPath}.tmp-${process.pid}`;
}

// Synchronous sleep for the rename backoff (`atomicWriteFileSync` is a sync
// API, so no timer queue can be used). `Atomics.wait` parks the thread
// instead of spinning.
function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Fail-safe pid liveness: only a definitive ESRCH means dead. Anything else
// (unparseable pid, self, EPERM, unknown errors) counts as alive so the temp
// is kept.
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code !== "ESRCH";
  }
}

// Best-effort reap of abandoned sibling temps. Never throws. A temp is
// reaped only when it is BOTH stale by age (a live writer's temp is always
// seconds old, even across pid namespaces) AND not owned by a live pid.
// Anything uncertain is kept.
function reapOrphanTemps(io, destPath, currentTmpPath) {
  let entries;
  try {
    entries = io.readdirSync(path.dirname(destPath));
  } catch {
    return;
  }
  const prefix = `${path.basename(destPath)}.tmp-`;
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const full = path.join(path.dirname(destPath), name);
    if (full === currentTmpPath) continue;
    const pid = Number(name.slice(prefix.length));
    if (Number.isInteger(pid) && pid > 0 && (pid === process.pid || isPidAlive(pid))) continue;
    let ageMs;
    try {
      ageMs = Date.now() - Number(io.statSync(full).mtimeMs);
    } catch {
      continue;
    }
    if (!(ageMs > ORPHAN_TEMP_MAX_AGE_MS)) continue;
    try {
      io.unlinkSync(full);
    } catch { /* best-effort */ }
  }
}

// Best-effort parent-directory fsync so the rename itself survives power
// loss. Never throws: some platforms cannot open directories for fsync.
function fsyncParentDir(io, destPath) {
  try {
    const fd = io.openSync(path.dirname(destPath), "r");
    try {
      io.fsyncSync(fd);
    } finally {
      io.closeSync(fd);
    }
  } catch { /* best-effort */ }
}

// Write + fsync + close the temp. A close error never masks the original
// write/fsync error (a `closed` flag keeps the follow-on close to a single
// attempt), and a failed temp is removed best-effort.
function writeTempFile(io, tmpPath, content) {
  const fd = io.openSync(tmpPath, "w");
  let closed = false;
  const closeOnce = () => {
    if (closed) return;
    closed = true;
    io.closeSync(fd);
  };
  try {
    io.writeFileSync(fd, content);
    io.fsyncSync(fd);
    closeOnce();
  } catch (e) {
    try { closeOnce(); } catch { /* preserve the original error */ }
    try { io.unlinkSync(tmpPath); } catch { /* best-effort temp cleanup */ }
    throw e;
  }
}

// Atomically replace `destPath` with exactly `content` (a string; no
// trailing newline is added). Creates parent directories like `write()`.
// Throws on any failure — including a persistently failing rename — and
// never falls back to a non-atomic write.
//
// The optional `{io, sleep, retryDelaysMs}` seams (defaulting to the real
// `fs`, a parked-thread sleep, and `RENAME_RETRY_DELAYS_MS`) exist so the
// mechanism is deterministically testable: ES module namespace bindings
// cannot be monkey-patched across module boundaries, so tests inject a
// recording/flaky filesystem boundary here instead of reaching into this
// module's `fs` binding. Production callers omit all three.
export function atomicWriteFileSync(destPath, content, {io = fs, sleep = defaultSleep, retryDelaysMs = RENAME_RETRY_DELAYS_MS} = {}) {
  if (typeof destPath !== "string" || !destPath) {
    throw new TypeError("atomicWriteFileSync requires a non-empty destination path string");
  }
  if (typeof content !== "string") {
    throw new TypeError(`atomicWriteFileSync requires string content, received ${content === null ? "null" : typeof content}`);
  }
  io.mkdirSync(path.dirname(destPath), {recursive: true});
  const tmpPath = siblingTempPath(destPath);
  writeTempFile(io, tmpPath, content);
  // Every iteration is one full publish attempt: rewrite the temp (past the
  // first), then rename it. The rewrite lives INSIDE the iteration's try so
  // its failure consumes that iteration's budget and falls through to the
  // remaining retries — a rewrite failure (the same AV hold that failed the
  // rename) must never discard the rest of the budget. Rewriting
  // unconditionally (rather than only when the temp is missing) also covers
  // a temp removed out from under us; content is deterministic so this is
  // always safe. On exhaustion the last attempt's error surfaces, caused by
  // the first, so no failure in the chain is hidden.
  let firstError = null;
  for (let attempt = 0; ; attempt += 1) {
    try {
      if (attempt > 0) writeTempFile(io, tmpPath, content);
      io.renameSync(tmpPath, destPath);
      break;
    } catch (e) {
      firstError ??= e;
      if (attempt >= retryDelaysMs.length) {
        try { io.unlinkSync(tmpPath); } catch { /* best-effort temp cleanup */ }
        if (e !== firstError) e.cause ??= firstError;
        throw e;
      }
      // Back off before retrying: a back-to-back rename lands in the same
      // transient lock window that failed this attempt.
      sleep(retryDelaysMs[attempt]);
    }
  }
  fsyncParentDir(io, destPath);
  reapOrphanTemps(io, destPath, tmpPath);
}
