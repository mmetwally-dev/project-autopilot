// Stale / interrupted Run recovery.
//
// A machine shutdown, power loss, WSL restart, terminal closure, or parent
// crash can leave a Run with status.json = RUNNING, no result.json, no
// FINISHED event, and a dead PID. Recovery detects exactly that signature and
// marks the Run INTERRUPTED — it never deletes data, never touches
// result.json / progress.log content, never consumes a mission attempt, and is
// idempotent.
//
// Recovery is an ORCHESTRATOR/STARTUP responsibility only. The pure detection
// helper `findStaleRuns` is safe to call from anywhere (watch rendering, CLI
// inspection) because it never writes; `recoverStaleRuns` is the only mutating
// entry point and must be invoked only by the orchestrator (e.g. at pipeline
// start). The watch report renderer is strictly read-only and must never call
// recovery — PID probes are unreliable across process namespaces (Windows PID
// checked from WSL, or a wrapper PID whose grandchild keeps streaming), so a
// healthy running Run could otherwise be falsely interrupted.
//
// Detection requires the FULL stale signature (all conditions must hold):
//   1. status.json says RUNNING
//   2. no result.json
//   3. no FINISHED event in progress.log
//   4. no recent activity: status.updated_at (bumped by every streamed chunk)
//      must be older than maxIdleMs (default 10 minutes). A Run that just
//      streamed output is definitionally alive even if the PID probe fails.
//   5. PID is confirmed dead or missing
//   6. outside the startup grace period (so a freshly spawned Run with a PID
//      that liveness cannot yet confirm is never interrupted)
//
// An actually active Run (live PID or recent activity) is never marked.
import fs from "node:fs";
import path from "node:path";
import { readRunMeta } from "./run-history.mjs";
import { localIso } from "./run-observability.mjs";
import { updateSummaryForRunDir } from "./watch-summary.mjs";

export const DEFAULT_GRACE_MS = 15_000;
export const DEFAULT_MAX_IDLE_MS = 10 * 60 * 1000; // 10 minutes
export const INTERRUPTED = "interrupted";

// Default PID liveness probe. Injectable for deterministic tests.
export function defaultIsPidAlive(pid) {
  if (pid == null || Number.isNaN(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    // EPERM = process exists but is owned by another user -> alive.
    return e?.code === "EPERM";
  }
}

// Pure decision: is this Run stale/dead per the full signature above?
export function isStaleRun(run, { isAlive = defaultIsPidAlive, now = Date.now(), graceMs = DEFAULT_GRACE_MS, maxIdleMs = DEFAULT_MAX_IDLE_MS } = {}) {
  if (!run) return false;
  if (String(run.status || "") !== "running") return false;          // 1
  if (run.hasResultFile) return false;                                // 2
  if (run.hasProgress && hasFinishedEvent(run.dir)) return false;     // 3
  const updated = new Date(run.updated_at || 0).getTime() || 0;       // 4
  if (updated && now - updated < maxIdleMs) return false;             // recent activity wins over unreliable PID probes
  if (isAlive(run.pid)) return false;                                 // 5
  const started = new Date(run.started_at || 0).getTime() || 0;       // 6
  if (!started) return false;                                         // cannot confirm age -> do not mark
  if (now - started < graceMs) return false;                          // 6
  return true;
}

// Pure scan: detect stale Runs without mutating anything. Safe to call from
// watch rendering / inspection. Returns { scanned, stale, unchanged }.
export function findStaleRuns(runsDir, { isAlive = defaultIsPidAlive, now = Date.now(), graceMs = DEFAULT_GRACE_MS, maxIdleMs = DEFAULT_MAX_IDLE_MS } = {}) {
  if (!fs.existsSync(runsDir)) return { scanned: 0, stale: [], unchanged: [] };
  const dirs = fs.readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  const stale = [];
  const unchanged = [];
  for (const e of dirs) {
    const dir = path.join(runsDir, e.name);
    const run = readRunMeta(dir, e.name);
    if (isStaleRun(run, { isAlive, now, graceMs, maxIdleMs })) {
      stale.push({ id: run.id, dir: e.name, role: run.role });
    } else {
      unchanged.push({ id: run.id, dir: e.name, status: run.status });
    }
  }
  return { scanned: dirs.length, stale, unchanged };
}

// Does progress.log contain a FINISHED event?
export function hasFinishedEvent(dir) {
  const file = path.join(dir, "progress.log");
  if (!fs.existsSync(file)) return false;
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).some((l) => l.includes("FINISHED |"));
  } catch {
    return false;
  }
}

// Mark a Run INTERRUPTED (idempotent). Only RUNNING status.json files are
// touched; result.json and existing progress.log content are never rewritten.
// Returns { marked: boolean, at?: string }.
export function markInterrupted(dir, { reason = "stale/dead process detected", at = localIso() } = {}) {
  const statusFile = path.join(dir, "status.json");
  let status = null;
  try { status = JSON.parse(fs.readFileSync(statusFile, "utf8")); } catch {}
  if (!status || String(status.status || "") !== "running") return { marked: false };
  const patch = {
    status: INTERRUPTED,
    interrupted_at: at,
    interruption_reason: reason,
    updated_at: at,
    last_action: "interrupted",
  };
  fs.writeFileSync(statusFile, JSON.stringify({ ...status, ...patch }, null, 2));
  try { updateSummaryForRunDir(dir); } catch { /* ignore */ }
  const progressFile = path.join(dir, "progress.log");
  if (fs.existsSync(progressFile)) {
    fs.appendFileSync(progressFile, `${localIso(new Date(at))}  INTERRUPTED | STATUS=interrupted | REASON=${reason} | AT=${at}\n`);
  }
  return { marked: true, at };
}

// Scan a runs directory and recover every stale RUNNING Run. Mutates only when
// explicitly called by the orchestrator (pipeline/startup). Detection is
// delegated to the pure findStaleRuns() so the two responsibilities stay
// separable. Never advances the run sequence and never writes mission state.
export function recoverStaleRuns(runsDir, { isAlive = defaultIsPidAlive, now = Date.now(), graceMs = DEFAULT_GRACE_MS, maxIdleMs = DEFAULT_MAX_IDLE_MS, reason = "stale/dead process detected" } = {}) {
  if (!fs.existsSync(runsDir)) return { scanned: 0, interrupted: [], unchanged: [] };
  const found = findStaleRuns(runsDir, { isAlive, now, graceMs, maxIdleMs });
  const interrupted = [];
  for (const s of found.stale) {
    const res = markInterrupted(path.join(runsDir, s.dir), { reason, at: localIso(new Date(now)) });
    if (res.marked) {
      interrupted.push({ id: s.id, dir: s.dir, role: s.role, interrupted_at: res.at });
    } else {
      found.unchanged.push({ id: s.id, dir: s.dir, status: "running" });
    }
  }
  return { scanned: found.scanned, interrupted, unchanged: found.unchanged };
}