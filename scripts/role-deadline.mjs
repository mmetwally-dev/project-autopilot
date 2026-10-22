// TASK-26 (003#5 part b) — derive code_reviewer/verifier deadlines from
// measured run durations instead of the fixed relay_timeout_ms guess.
//
// Pure module in the style of per-task-budget.mjs: no process access and no
// clock reads. The filesystem is only read through an injected `io` reader
// (defaulting to a thin node:fs wrapper below); ordering uses the stored
// `started_at` strings, never the current time.
//
// Rule shipped (first cut): timeout = longest-of-last-10 × 2, clamped to a
// 10-minute floor and the relay ceiling. Recorded alternatives if live data
// shows the deadline running long on simple missions: p95 × 1.5, or
// longest + buffer.
import fs from "node:fs";
import path from "node:path";
import {RELAY_TIMEOUT_DEFAULT_MS} from "./per-task-budget.mjs";

export const ROLE_DEADLINE_FLOOR_MS = 10 * 60 * 1000;
export const ROLE_DEADLINE_MULTIPLIER = 2;
export const ROLE_DEADLINE_MAX_SAMPLES = 10;

const defaultIo = {
  listDirs(dir) {
    return fs.readdirSync(dir, {withFileTypes: true})
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  },
  readText(file) {
    try { return fs.readFileSync(file, "utf8"); }
    catch { return null; }
  },
};

// samplesMs: newest-first durations (ms) of COMPLETED runs of this role.
// Returns {timeoutMs, source, sampleCount, longestMs, lastMs} where source
// is one of "policy" | "breach-fallback" | "default" | "measured".
export function deriveRoleDeadline({samplesMs, relayTimeoutMs, floorMs, override, breached} = {}) {
  const relay = Number(relayTimeoutMs) > 0 ? Number(relayTimeoutMs) : RELAY_TIMEOUT_DEFAULT_MS;
  const floor = Number(floorMs) > 0 ? Number(floorMs) : ROLE_DEADLINE_FLOOR_MS;
  // Callers pass newest-first; only the newest 10 count.
  const samples = (Array.isArray(samplesMs) ? samplesMs : [])
    .filter((ms) => typeof ms === "number" && Number.isFinite(ms) && ms > 0)
    .slice(0, ROLE_DEADLINE_MAX_SAMPLES);
  const sampleCount = samples.length;
  const longestMs = sampleCount ? Math.max(...samples) : null;
  const lastMs = sampleCount ? samples[0] : null;
  // An override at or above the relay ceiling cannot lower the kill deadline
  // (and the shipped verifier default is exactly that). Treat it as absent so
  // it does not suppress the measured derivation.
  if (Number.isInteger(override) && override > 0 && override < relay) {
    return {timeoutMs: override, source: "policy", sampleCount, longestMs, lastMs};
  }
  if (breached === true) {
    return {timeoutMs: relay, source: "breach-fallback", sampleCount, longestMs, lastMs};
  }
  if (!sampleCount) {
    return {timeoutMs: relay, source: "default", sampleCount, longestMs, lastMs};
  }
  // longest × 2 is a first cut; recorded alternatives if live data shows
  // the deadline running long on simple missions: p95 × 1.5, longest + buffer.
  return {
    timeoutMs: Math.min(Math.max(longestMs * ROLE_DEADLINE_MULTIPLIER, floor), relay),
    source: "measured", sampleCount, longestMs, lastMs,
  };
}

function samplesFromDir(runsDir, role, io) {
  let names;
  try { names = io.listDirs(runsDir); }
  catch { return []; }
  const out = [];
  for (const name of names) {
    let raw;
    try { raw = io.readText(path.join(runsDir, name, "status.json")); }
    catch { continue; }
    if (raw == null) continue;
    let status;
    try { status = JSON.parse(raw); }
    catch { continue; }
    if (status?.role !== role) continue;
    if (status?.status !== "completed") continue;
    if (status?.exit_code !== 0) continue;
    // Timed-out, capped, failed and interrupted runs are never samples:
    // only a clean completed run with a positive measured duration counts.
    const ms = status?.duration_ms;
    if (typeof ms !== "number" || !(ms > 0)) continue;
    out.push({ms, at: status?.started_at ?? null});
  }
  out.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  return out;
}

// Newest-first duration_ms values for one role. `fallbackDirs` (repo-wide
// mission runs dirs) are only consulted when the primary directory — the
// current mission's runs dir — has no samples, so a heavy earlier mission
// never inflates a simple one. The fallback set is merged newest-first by
// started_at; with no samples anywhere the result is [], which derives the
// default (today's behaviour).
export function collectRoleSamples(runsDir, role, fallbackDirs = [], io = defaultIo) {
  const primary = samplesFromDir(runsDir, role, io);
  if (primary.length) return primary.map((sample) => sample.ms);
  const merged = [];
  for (const dir of Array.isArray(fallbackDirs) ? fallbackDirs : []) {
    merged.push(...samplesFromDir(dir, role, io));
  }
  merged.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  return merged.map((sample) => sample.ms);
}
