import fs from "node:fs";
import path from "node:path";

import {
  listRunsOldestNewest,
  watchRunsDir,
  readWatchEvents,
  readRunMeta,
} from "./run-history.mjs";

// Mission 094 Phase 3 task 3.1 — the compact watch-summary cache.
//
// A watch report used to be rendered by re-reading every run's
// `status.json`/`result.json`/`progress.log`. That is the slow part of a render
// and it is what the launch path must not do synchronously. This module keeps a
// small per-mission cache: one compact record per run (the reader fields plus
// the fields the report model merges from disk) plus a watch-events index. A
// cached render then only needs `state.json` + this summary + the events.
//
// The module is deliberately small and side-effect-bounded:
//   - `rebuildSummary`  PURE: computes the summary from the run dirs + events.
//   - `readSummary`     reads the cache; a missing/stale cache rebuilds (and
//                       persists) so callers never see a stale report.
//   - `updateSummary`   applies an incremental patch (one run dir, events) and
//                       persists atomically.
//
// Staleness is a fingerprint: `sourceMtimeMs` is the max mtime of every source
// the summary was built from (the runs dir, each run dir's status/result file
// and the watch-events file). A summary is reused only when that fingerprint is
// unchanged, so a run that finishes (its status.json is rewritten) or a new
// event forces a rebuild.

export const SUMMARY_VERSION = 4;

// Mission-scoped cache path, with the flat legacy fallback used elsewhere in
// run-history.mjs (watchRunsDir).
export function summaryPath(repo, mission) {
  if (mission) return path.join(repo, ".autopilot", "missions", String(mission), "watch-summary.json");
  return path.join(repo, ".autopilot", "watch-summary.json");
}

function eventsPath(repo, mission) {
  if (!mission) return null;
  return path.join(repo, ".autopilot", "missions", String(mission), "watch-events.jsonl");
}

function statMtimeMs(file) {
  if (!file) return null;
  try {
    const st = fs.statSync(file);
    return Number.isFinite(st.mtimeMs) ? st.mtimeMs : null;
  } catch {
    return null;
  }
}

// The max source mtime the summary was built from. Cheap: it stats only (never
// reads) the runs dir, each run dir's status/result file and the events file.
// A missing source contributes nothing; no sources at all yields 0, which is
// itself a valid (stable) fingerprint for an empty mission.
export function sourceStamp(repo, mission) {
  const runsDir = watchRunsDir(repo, mission);
  let max = 0;
  const bump = (v) => { if (typeof v === "number" && Number.isFinite(v) && v > max) max = v; };
  bump(statMtimeMs(runsDir));
  bump(statMtimeMs(eventsPath(repo, mission)));
  let entries = [];
  try { entries = fs.readdirSync(runsDir, { withFileTypes: true }); } catch { /* missing runs dir is fine */ }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(runsDir, entry.name);
    bump(statMtimeMs(dir));
    bump(statMtimeMs(path.join(dir, "status.json")));
    bump(statMtimeMs(path.join(dir, "result.json")));
  }
  return max;
}

// Per-source fingerprint map {events, dirs:{name: max mtime}}. Lets an
// incremental update tell whether any run dir OTHER than the one it is about to
// re-read changed since the summary was stored.
export function sourceStampMap(repo, mission) {
  const runsDir = watchRunsDir(repo, mission);
  const dirs = {};
  let entries = [];
  try { entries = fs.readdirSync(runsDir, { withFileTypes: true }); } catch { /* missing runs dir is fine */ }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(runsDir, entry.name);
    dirs[entry.name] = Math.max(statMtimeMs(dir) ?? 0, statMtimeMs(path.join(dir, "status.json")) ?? 0, statMtimeMs(path.join(dir, "result.json")) ?? 0);
  }
  return { events: statMtimeMs(eventsPath(repo, mission)) ?? 0, dirs };
}

function stampMapFresh(stored, current, skipName, skipEvents) {
  if (!stored || typeof stored !== "object" || !stored.dirs || typeof stored.dirs !== "object") return false;
  if (!skipEvents && stored.events !== current.events) return false;
  const names = new Set([...Object.keys(stored.dirs), ...Object.keys(current.dirs)]);
  for (const n of names) {
    if (n === skipName) continue;
    if (stored.dirs[n] !== current.dirs[n]) return false;
  }
  return true;
}

// The extra per-run fields the report model's `enrichRun` merges from disk. The
// summary stores them inline so a cached render never opens a run dir again.
function readRunExtras(dir) {
  const extras = {
    findings: [],
    carriedForwardTasks: null,
    sessionNumber: null,
    resolvedModel: null,
    configuredModel: null,
    modelMismatch: null,
    snapshotBeforeStartedAt: null,
    snapshotBeforeAt: null,
    snapshotAfterStartedAt: null,
    snapshotAfterAt: null,
    planRevision: null,
    note: null,
    policyViolation: null,
    failureClass: null,
    escalated: false,
    interrupted_at: null,
    interruption_reason: null,
  };
  if (typeof dir !== "string" || !dir) return extras;
  try {
    const st = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8"));
    if (st && typeof st === "object") {
      if (st.sessionNumber !== undefined && st.sessionNumber !== null) extras.sessionNumber = st.sessionNumber;
      if (st.carriedForwardTasks !== undefined && st.carriedForwardTasks !== null) extras.carriedForwardTasks = st.carriedForwardTasks;
      if (st.configuredModel !== undefined && st.configuredModel !== null) extras.configuredModel = st.configuredModel;
      if (st.resolvedModel !== undefined && st.resolvedModel !== null) extras.resolvedModel = st.resolvedModel;
      if (st.modelMismatch !== undefined && st.modelMismatch !== null) extras.modelMismatch = st.modelMismatch;
      if (st.snapshotBeforeStartedAt !== undefined) extras.snapshotBeforeStartedAt = st.snapshotBeforeStartedAt;
      if (st.snapshotBeforeAt !== undefined) extras.snapshotBeforeAt = st.snapshotBeforeAt;
      if (st.snapshotAfterStartedAt !== undefined) extras.snapshotAfterStartedAt = st.snapshotAfterStartedAt;
      if (st.snapshotAfterAt !== undefined) extras.snapshotAfterAt = st.snapshotAfterAt;
      if (st.planRevision !== undefined) extras.planRevision = st.planRevision;
      if (st.note !== undefined) extras.note = st.note;
      if (st.interrupted_at !== undefined) extras.interrupted_at = st.interrupted_at;
      if (st.interruption_reason !== undefined) extras.interruption_reason = st.interruption_reason;
    }
  } catch { /* missing/invalid status.json is fine */ }
  try {
    const rs = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
    if (rs && typeof rs === "object") {
      if (Array.isArray(rs.review?.findings)) extras.findings = rs.review.findings.map(String);
      else if (Array.isArray(rs.findings)) extras.findings = rs.findings.map(String);
      if (extras.carriedForwardTasks == null && Array.isArray(rs.carriedForwardTasks)) extras.carriedForwardTasks = rs.carriedForwardTasks.slice();
      if (extras.resolvedModel == null && typeof rs.resolvedModel === "string") extras.resolvedModel = rs.resolvedModel;
      extras.policyViolation = (typeof rs.policyViolation === "string" && rs.policyViolation)
        || (typeof rs.policy?.violation === "string" && rs.policy.violation)
        || null;
      extras.failureClass = typeof rs.failure?.class === "string" ? rs.failure.class : null;
      extras.escalated = rs.escalated === true || rs.missionEscalated === true;
    }
  } catch { /* missing/invalid result.json is fine */ }
  return extras;
}

// A compact record = the reader record plus exactly the fields `enrichRun`
// would have merged from disk. Everything is normalized to an explicit value
// (never `undefined`) so a JSON round-trip preserves the object exactly.
function compactRun(run) {
  const base = run && typeof run === "object" ? run : {};
  const extras = readRunExtras(base.dir);
  return {
    ...base,
    findings: Array.isArray(base.findings) ? base.findings.map(String) : extras.findings,
    carriedForwardTasks: base.carriedForwardTasks !== undefined ? base.carriedForwardTasks : extras.carriedForwardTasks,
    sessionNumber: base.sessionNumber !== undefined ? base.sessionNumber : extras.sessionNumber,
    resolvedModel: base.resolvedModel !== undefined ? base.resolvedModel : extras.resolvedModel,
    configuredModel: base.configuredModel !== undefined ? base.configuredModel : extras.configuredModel,
    modelMismatch: base.modelMismatch !== undefined ? base.modelMismatch : extras.modelMismatch,
    snapshotBeforeStartedAt: base.snapshotBeforeStartedAt !== undefined ? base.snapshotBeforeStartedAt : extras.snapshotBeforeStartedAt,
    snapshotBeforeAt: base.snapshotBeforeAt !== undefined ? base.snapshotBeforeAt : extras.snapshotBeforeAt,
    snapshotAfterStartedAt: base.snapshotAfterStartedAt !== undefined ? base.snapshotAfterStartedAt : extras.snapshotAfterStartedAt,
    snapshotAfterAt: base.snapshotAfterAt !== undefined ? base.snapshotAfterAt : extras.snapshotAfterAt,
    planRevision: base.planRevision !== undefined ? base.planRevision : extras.planRevision,
    note: base.note !== undefined ? base.note : extras.note,
    policyViolation: base.policyViolation !== undefined ? base.policyViolation : extras.policyViolation,
    failureClass: base.failureClass !== undefined ? base.failureClass : extras.failureClass,
    escalated: base.escalated !== undefined ? base.escalated : extras.escalated,
    interrupted_at: base.interrupted_at !== undefined ? base.interrupted_at : extras.interrupted_at,
    interruption_reason: base.interruption_reason !== undefined ? base.interruption_reason : extras.interruption_reason,
  };
}

function normalizeRecord(record) {
  const r = compactRun(record);
  if (!Array.isArray(r.findings)) r.findings = [];
  if (r.carriedForwardTasks === undefined) r.carriedForwardTasks = null;
  if (r.sessionNumber === undefined) r.sessionNumber = null;
  if (r.resolvedModel === undefined) r.resolvedModel = null;
  if (r.configuredModel === undefined) r.configuredModel = null;
  if (r.modelMismatch === undefined) r.modelMismatch = null;
  if (r.snapshotBeforeStartedAt === undefined) r.snapshotBeforeStartedAt = null;
  if (r.snapshotBeforeAt === undefined) r.snapshotBeforeAt = null;
  if (r.snapshotAfterStartedAt === undefined) r.snapshotAfterStartedAt = null;
  if (r.snapshotAfterAt === undefined) r.snapshotAfterAt = null;
  if (r.planRevision === undefined) r.planRevision = null;
  if (r.note === undefined) r.note = null;
  if (r.policyViolation === undefined) r.policyViolation = null;
  if (r.failureClass === undefined) r.failureClass = null;
  if (r.escalated === undefined) r.escalated = false;
  if (r.interrupted_at === undefined) r.interrupted_at = null;
  if (r.interruption_reason === undefined) r.interruption_reason = null;
  return r;
}

// The same ordering `listRunsOldestNewest` uses (oldest started_at first, ties
// by id) so an incrementally updated summary keeps the rebuild ordering.
function sortRuns(runs) {
  return [...runs].sort((a, b) => {
    const ta = new Date(a.started_at).getTime() || 0;
    const tb = new Date(b.started_at).getTime() || 0;
    if (ta !== tb) return ta - tb;
    return String(a.id).localeCompare(String(b.id));
  });
}

// A compact index of the watch-events feed: where it lives, how many parsed
// events the summary carries and the newest event's timestamp. Never a full
// re-read of the file (the summary already carries the parsed events).
function buildEventsIndex(repo, mission, events) {
  const list = Array.isArray(events) ? events : [];
  const file = eventsPath(repo, mission);
  let bytes = null;
  let mtimeMs = null;
  if (file) {
    try {
      const st = fs.statSync(file);
      bytes = st.size;
      mtimeMs = Math.round(st.mtimeMs);
    } catch { /* missing events file is fine */ }
  }
  return {
    path: file,
    count: list.length,
    lastAt: list.length ? (list[list.length - 1]?.at ?? null) : null,
    bytes,
    mtimeMs,
  };
}

// Compute the summary from scratch. PURE with respect to the cache: it reads
// the sources but never writes.
export function rebuildSummary(repo, mission, { persist = false } = {}) {
  const runsDir = watchRunsDir(repo, mission);
  const runs = listRunsOldestNewest(runsDir).map(normalizeRecord);
  const events = readWatchEvents(repo, mission);
  const summary = {
    version: SUMMARY_VERSION,
    mission: mission ?? null,
    runsDir,
    sourceMtimeMs: sourceStamp(repo, mission),
    sourceStamps: sourceStampMap(repo, mission),
    runs: sortRuns(runs),
    events,
    eventsIndex: buildEventsIndex(repo, mission, events),
  };
  if (persist) writeSummaryFile(summaryPath(repo, mission), summary);
  return summary;
}

// Read the persisted cache, rebuilding (and persisting) when it is missing,
// unreadable, a different version, or stale vs the current source fingerprint.
export function readSummary(repo, mission, { force = false } = {}) {
  const file = summaryPath(repo, mission);
  const stamp = sourceStamp(repo, mission);
  if (!force) {
    const stored = readSummaryFile(file);
    if (stored && stored.sourceMtimeMs === stamp) return stored;
  }
  const rebuilt = rebuildSummary(repo, mission);
  writeSummaryFile(file, rebuilt);
  return rebuilt;
}

// A read-only variant of readSummary for the report renderer, which must stay
// free of cache side effects (the 094 renderer is documented as strictly
// read-only). Serve the persisted summary when it is fresh; otherwise rebuild
// in memory and return it WITHOUT persisting — the next incremental update
// (a run write point) persists it. Never throws.
export function peekSummary(repo, mission) {
  const stored = readSummaryFile(summaryPath(repo, mission));
  const stamp = sourceStamp(repo, mission);
  if (stored && stored.sourceMtimeMs === stamp) return stored;
  return rebuildSummary(repo, mission);
}

// Mission 094 Phase 3 task 3.2 — a write point (run-observability
// initRun/finalizeRun/updateRunModel, autopilot model resolution) only knows the
// run dir it just wrote. Resolve repo + mission from the run dir path
// (`<repo>/.autopilot/missions/<mission>/runs/<run>` or the flat legacy
// `<repo>/.autopilot/runs/<run>`) so the summary can be patched incrementally.
// Returns null for anything else (fixture/temp dirs, adhoc runs dirs).
export function scopeForRunDir(dir) {
  if (typeof dir !== "string" || !dir) return null;
  const runDir = path.resolve(dir);
  const runsDir = path.dirname(runDir);
  if (path.basename(runsDir) !== "runs") return null;
  const missionDir = path.dirname(runsDir);      // `.../missions/<mission>` or `.../.autopilot`
  const missionsDir = path.dirname(missionDir);  // `.../.autopilot/missions` or `...`
  if (path.basename(missionsDir) === "missions") {
    return { repo: path.dirname(path.dirname(missionsDir)), mission: path.basename(missionDir), runsDir, runDir };
  }
  if (path.basename(missionDir) === ".autopilot") {
    return { repo: path.dirname(missionDir), mission: null, runsDir, runDir };
  }
  return null;
}

// Best-effort incremental summary update for a just-written run dir. Returns the
// persisted summary, or null when the dir is not a recognisable run dir or the
// write fails — never throws into a run.
export function updateSummaryForRunDir(dir, patch = {}) {
  const scope = scopeForRunDir(dir);
  if (!scope) return null;
  try {
    return updateSummary(scope.repo, scope.mission, { ...patch, runDir: scope.runDir });
  } catch {
    return null;
  }
}

// Incremental update. Accepts either `(repo, mission, patch)` or a single
// `{ repo, mission, ...patch }` object (so a caller that already holds the run
// dir can pass it through). Recognised patch keys:
//   summary        full summary object to persist (else current/rebuild)
//   rebuild        force a from-scratch base
//   runs           replace the compact run records
//   runDir         upsert one run record read from that dir
//   removeRunDir   drop the record whose `dir` matches
//   events         replace the events
//   appendEvents   append events
// Returns the persisted summary.
export function updateSummary(repo, mission, patch = {}) {
  if (repo && typeof repo === "object" && !Array.isArray(repo)) {
    patch = repo;
    repo = patch.repo;
    mission = patch.mission;
  }
  const file = summaryPath(repo, mission);
  let base;
  let rebuiltBase = false;
  // Fingerprint BEFORE patching: a base is kept only if no source OTHER than
  // the run dir being patched (and the events file, unless events are being
  // appended) changed since it was stored. Otherwise it is rebuilt, so a patch
  // never blesses data it did not read (e.g. result.json written after the last
  // update), while a live update of one run stays incremental (no full rebuild).
  const stampsBefore = sourceStampMap(repo, mission);
  const patchedName = patch.runDir ? path.basename(patch.runDir) : null;
  if (patch.rebuild) base = null;
  else if (patch.summary && typeof patch.summary === "object") base = cloneSummary(patch.summary);
  else base = readSummaryFile(file);
  if (base && !stampMapFresh(base.sourceStamps, stampsBefore, patchedName, Array.isArray(patch.appendEvents) && patch.appendEvents.length > 0)) base = null;
  if (!base) { base = rebuildSummary(repo, mission); rebuiltBase = true; }
  else base = cloneSummary(base);

  if (Array.isArray(patch.runs)) base.runs = patch.runs.map(normalizeRecord);
  if (patch.runDir) base.runs = sortRuns(upsertRun(base.runs, patch.runDir));
  if (patch.removeRunDir) base.runs = base.runs.filter((r) => r.dir !== patch.removeRunDir);
  if (Array.isArray(patch.events)) base.events = patch.events.slice();
  if (Array.isArray(patch.appendEvents) && patch.appendEvents.length && !rebuiltBase) {
    base.events = [...(Array.isArray(base.events) ? base.events : []), ...patch.appendEvents];
  }

  base.version = SUMMARY_VERSION;
  base.mission = mission ?? null;
  base.runsDir = watchRunsDir(repo, mission);
  base.eventsIndex = buildEventsIndex(repo, mission, base.events);
  base.sourceMtimeMs = sourceStamp(repo, mission);
  base.sourceStamps = rebuiltBase ? sourceStampMap(repo, mission) : stampsBefore;
  writeSummaryFile(file, base);
  return base;
}

function upsertRun(runs, runDir) {
  const id = path.basename(runDir);
  const record = normalizeRecord(readRunMeta(runDir, id));
  const list = Array.isArray(runs) ? [...runs] : [];
  const idx = list.findIndex((r) => r && (r.dir === runDir || r.dirName === id));
  if (idx >= 0) list[idx] = record;
  else list.push(record);
  return list;
}

function cloneSummary(summary) {
  try { return JSON.parse(JSON.stringify(summary)); } catch { return summary; }
}

function readSummaryFile(file) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.version !== SUMMARY_VERSION) return null;
  if (!Array.isArray(parsed.runs)) return null;
  return parsed;
}

function writeSummaryFile(file, summary) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(summary), "utf8");
  fs.renameSync(tmp, file);
}
