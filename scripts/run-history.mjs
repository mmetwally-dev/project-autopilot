import fs from "node:fs";
import path from "node:path";
import {loadAndMigrateConfig} from "./config-migration.mjs";

import { peekSummary } from "./watch-summary.mjs";

import { defaultIsPidAlive } from "./run-recovery.mjs";
import { growingTerm } from "./per-task-budget.mjs";
import { readOwnerPid, ownerPidAlive } from "./owner-pid.mjs";
import { buildReportModel, renderReport } from "./watch-report.mjs";
import { phases as standalonePhases } from "../adapters/standalone.mjs";

// true = alive, false = provably gone, null = could not tell (no/invalid pid, or
// the probe itself failed). "Could not tell" is never reported as dead: a
// permissions quirk must not relabel a healthy run as KILLED.
export function pidLiveness(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return null;
  try {
    return defaultIsPidAlive(n) === true;
  } catch {
    return null;
  }
}

// The status a REPORT should show, reconciled against process liveness: a relay
// that was killed cannot rewrite its own status.json, so a stale
// `status: "running"` is the normal aftermath of any hard stop (a cut relay, a
// killed process group, a crash) and would otherwise report RUNNING forever and
// hold the CURRENT marker. Deliberately narrow — only a recorded pid that is
// provably dead flips the status; a run that recorded no pid, and a run whose pid
// is alive, are shown exactly as the last writer reported them. This is a
// display-level reconciliation: readRunMeta keeps the raw value so the recovery
// layer (isStaleRun) still recognises stale runs.
//
// Orchestrator liveness (`run.ownerAlive`, annotated by annotateOwnerLiveness
// from the mission owner pid file; true/false/undefined=unknown): a dead run pid
// with a LIVE orchestrator is the gap between roles, still running; a run whose
// orchestrator is known dead cannot be progressing (SIGKILL, shutdown) and is
// shown as interrupted whatever its own pid says. Unknown owner keeps the
// legacy dead-pid -> killed rule.
export function displayStatus(run, { isAlive = pidLiveness } = {}) {
  if (String(run?.status || "") !== "running") return run?.status;
  const live = isAlive(run.pid);
  if (live === true) return run.status;
  if (run.ownerAlive === true) return run.status;
  if (run.ownerAlive === false) return "interrupted";
  return live === false ? "killed" : run.status;
}

export const STALE_RUNNING_LABEL = "interrupted (orchestrator not running)";

// Text shown for a status cell: the long label for an orchestrator-dead run.
export function displayStatusLabel(run, opts) {
  const st = displayStatus(run, opts);
  return st === "interrupted" && String(run?.status || "") === "running" ? STALE_RUNNING_LABEL : st;
}

// Display-only: mark each run with whether the mission orchestrator is alive.
// Reads `.autopilot/owner.pid`; a missing/unreadable file leaves the flag unset
// (unknown). `isOwnerAlive` is injectable for tests. Never writes anything.
export function annotateOwnerLiveness(repo, runs, { isOwnerAlive = ownerPidAlive, readOwner = readOwnerPid } = {}) {
  let alive;
  try {
    const o = readOwner(repo);
    if (o && Number.isInteger(o.pid) && (o.platform == null || o.platform === process.platform)) alive = isOwnerAlive(o.pid) === true;
  } catch { /* unknown */ }
  if (alive === undefined) return runs;
  for (const r of runs) r.ownerAlive = alive;
  return runs;
}

export function abbrevId(id) {
  return String(id || "").slice(0, 8);
}

export function parseRunDirName(name) {
  const m = String(name || "").match(/^(\d+)-([a-zA-Z0-9_]+)-([0-9a-fA-F]{8})$/);
  return m ? { seq: m[1], role: m[2], shortId: m[3] } : null;
}

// Next available per-mission run sequence (max <seq>-<role>-<shortid> + 1).
// Shared with autopilot.mjs so the naming logic is testable in isolation.
// Only properly-formatted run dirs are counted — legacy UUID-only dirs (e.g.
// a full UUID that happens to start with digits) must not inflate the counter.
export function nextRunSeq(base) {
  let max = 0;
  try {
    for (const d of fs.readdirSync(base)) {
      const parsed = parseRunDirName(d);
      if (parsed) max = Math.max(max, parseInt(parsed.seq, 10));
    }
  } catch { /* empty or missing runs dir is fine */ }
  return max + 1;
}

export function normalizeStatus(s) {
  return String(s || "").toUpperCase() || "UNKNOWN";
}

// Normalize any timestamp to a single fixed-width "YYYY-MM-DD HH:MM:SS <ZONE>"
// so columns right-align in text reports. Critically, this must show the same
// CLOCK HOUR the source file already prints — status.json writes local wall
// time with an explicit offset (e.g. "...T15:18:22+03:00"), so an offset-
// bearing timestamp is reformatted directly from its own digits (no Date/UTC
// reprojection), instead of being shifted to a different hour than what a
// reader just saw in status.json. Only a naive ISO string (no timezone at
// all) is Date-parsed and treated as UTC, since it carries no clock of its
// own to preserve. Unparseable values pass through unchanged.
export function formatTimestamp(value) {
  if (value == null || value === "") return "-";
  const raw = String(value).trim();
  const offsetMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/);
  if (offsetMatch) {
    const [, y, mo, d, h, mi, s, tz] = offsetMatch;
    const zone = tz === "Z" ? "UTC" : tz.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
    return `${y}-${mo}-${d} ${h}:${mi}:${s} ${zone}`;
  }
  const isIso = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(raw);
  const date = isIso ? new Date(raw + "Z") : new Date(raw);
  if (Number.isNaN(date.getTime())) return String(value);
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())} ${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())} UTC`;
}

export function readRunMeta(dir, id) {
  const statusFile = path.join(dir, "status.json");
  const resultFile = path.join(dir, "result.json");
  let status = null;
  let result = null;
  try { status = JSON.parse(fs.readFileSync(statusFile, "utf8")); } catch {}
  try { result = JSON.parse(fs.readFileSync(resultFile, "utf8")); } catch {}

  let startedAt = status?.started_at || result?.startedAt || null;
  if (!startedAt) {
    try { startedAt = new Date(fs.statSync(dir).mtimeMs).toISOString(); } catch {}
  }

  const hasStatus = !!status;
  const hasResult = !!result;
  const runStatus = hasStatus
    ? status.status
    : hasResult
      ? result.status || "completed"
      : "unknown";
  // NOTE: the reported status is deliberately NOT reconciled against pid
  // liveness here. This reader must stay faithful to what was recorded, because
  // the stale-run recovery decision (run-recovery.mjs's isStaleRun, which has
  // its own *injectable* liveness probe and calls this function) keys off the
  // raw `status: "running"` marker — rewriting it here made the recovery layer
  // stop seeing stale runs entirely. The reconciliation for readers of the watch
  // report lives in displayStatus() below instead.

  const parsed = parseRunDirName(id);
  const role = status?.role || result?.role || parsed?.role || null;
  const exitCode = status?.exit_code ?? result?.process?.exitCode ?? null;
  const decision = status?.decision ?? result?.review?.decision ?? null;
  const pid = status?.pid ?? null;
  const duration = status?.duration ?? null;
  // TASK-26: expose the measured run duration for deadline derivation.
  // Additive — every existing field above is unchanged.
  const duration_ms = status?.duration_ms ?? null;
  // Watch-report PRICE/TURNS columns: the per-run token usage object
  // ({input, cacheCreation, cacheRead, output, turns, priceWeighted}).
  // status.json first; result.json fallback for runs whose status.json
  // predates the field. Additive — existing fields unchanged.
  const usage = status?.usage ?? result?.usage ?? null;
  // Per-role fallback active model actually used for this run:
  // status.json first; result.json fallback for runs whose status.json
  // predates the field (result.json carries top-level `model`). Additive.
  const model = status?.model ?? result?.model ?? null;
  const runId = status?.run_id || result?.run_id || id;

  return {
    id: runId,
    dir,
    dirName: id,
    seq: parsed?.seq ?? null,
    shortId: parsed?.shortId ?? null,
    role,
    status: runStatus,
    started_at: startedAt,
    exit_code: exitCode,
    decision,
    pid,
    duration,
    duration_ms,
    usage,
    model,
    last_action: status?.last_action ?? null,
    updated_at: status?.updated_at ?? null,
    phase: status?.phase ?? result?.phase ?? null,
    task: status?.taskGroup ?? result?.taskGroup ?? status?.task ?? result?.task ?? null,
    // The run's actual task scope ("T1.1", "T001 > T003", null when
    // phase-level or unknown). Read this, not `task`: `task` is grouping
    // only and may be stale or null (see observabilityMeta in
    // autopilot.mjs). result.json first (#110), status.json fallback for old runs.
    taskRef: result?.taskRef ?? status?.taskRef ?? null,
  attempt: status?.attempt ?? result?.attempt ?? null,
  // Backlog #26 Step B: wrap-up marker (status.json only). Renders as a
  // NOTE suffix on the run line; runs without it read null and render
  // exactly as before.
  note: status?.note ?? result?.note ?? null,
  // Backlog #35a/#35c: the lasting interruption reason and the moment the run
  // was stopped (the report derives the owner-down reason and downtime).
  interrupted_at: status?.interrupted_at ?? null,
  interruption_reason: status?.interruption_reason ?? null,
  hasStatusFile: hasStatus,
    hasResultFile: hasResult,
    hasProgress: fs.existsSync(path.join(dir, "progress.log")),
  };
}

export function listRunsOldestNewest(runsDir) {
  if (!fs.existsSync(runsDir)) return [];
  return fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => readRunMeta(path.join(runsDir, e.name), e.name))
    .sort((a, b) => {
      const ta = new Date(a.started_at).getTime() || 0;
      const tb = new Date(b.started_at).getTime() || 0;
      if (ta !== tb) return ta - tb;
      return String(a.id).localeCompare(String(b.id));
    });
}

// Rename every run dir under `base` to `<seq>-<role>-<shortid>` where seq is a
// zero-padded chronological index (01..N) — oldest run gets 01, newest gets the
// highest number, so the current (last) run is always the last entry when
// sorted. Roles come from status.json/result.json, then the dir name, then the
// run's own brief.txt (ROLE= line); a fallback label is used only when none
// are recoverable. Dirs that are not run dirs (e.g. `shell-*` scaffolding) are
// skipped. Returns the number of dirs renamed.
export function renumberRuns(base, { fallbackRole = "run", padTo = 2 } = {}) {
  if (!fs.existsSync(base)) return 0;
  const entries = fs
    .readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .filter((e) => !/^shell-/.test(e.name));

  const meta = entries.map((e) => {
    const dir = path.join(base, e.name);
    const m = readRunMeta(dir, e.name);
    let role = m.role || null;
    if (!role) {
      const brief = path.join(dir, "brief.txt");
      try {
        const bm = String(fs.readFileSync(brief, "utf8")).match(/ROLE=([A-Za-z0-9_]+)/);
        if (bm) role = bm[1];
      } catch {}
    }
    const shortId = abbrevId(m.id);
    return { dir, name: e.name, role: role || fallbackRole, shortId: shortId || abbrevId(e.name), startedAt: m.started_at };
  });

  const ordered = [...meta].sort((a, b) => {
    const ta = new Date(a.startedAt).getTime() || 0;
    const tb = new Date(b.startedAt).getTime() || 0;
    if (ta !== tb) return ta - tb;
    return String(a.name).localeCompare(String(b.name));
  });

  const width = Math.max(padTo, String(ordered.length).length);
  let renamed = 0;
  ordered.forEach((r, i) => {
    const seq = String(i + 1).padStart(width, "0");
    const role = String(r.role).replace(/[^A-Za-z0-9_]/g, "_") || fallbackRole;
    const target = `${seq}-${role}-${r.shortId}`;
    if (r.name === target) return;
    const dest = path.join(base, target);
    if (fs.existsSync(dest)) {
      throw new Error(`renumber collision: ${dest} already exists`);
    }
    fs.renameSync(r.dir, dest);
    renamed++;
  });
  return renamed;
}

export function detectCurrentRun(runs) {
  // A run reconciled to KILLED is the aftermath of a stop, not something
  // running, so it can never be CURRENT: pointing operators at a dead relay
  // while the newest real run goes unmarked is the defect being fixed here. The
  // liveness guard is kept alongside the status check so a caller that hands in
  // raw (unreconciled) statuses still cannot select a dead run.
  const running = runs.filter((r) => displayStatus(r) === "running");
  if (running.length) {
    running.sort((a, b) => (new Date(b.started_at).getTime() || 0) - (new Date(a.started_at).getTime() || 0));
    return running[0];
  }
  const real = runs.filter((r) => {
    const status = displayStatus(r);
    // A capped run was superseded by its continuation generation by design,
    // exactly like a killed run is the aftermath of a stop: neither is
    // running, so neither can ever be CURRENT.
    return status !== "unknown" && status !== "interrupted" && status !== "killed" && status !== "capped";
  });
  if (!real.length) return null;
  const sorted = [...real].sort((a, b) => (new Date(b.started_at).getTime() || 0) - (new Date(a.started_at).getTime() || 0));
  return sorted[0];
}

// A reviewer/verifier process can exit cleanly (status: completed) while its
// review verdict is FAIL — that is a rejection, not a no-op success, and a
// reader scanning only the status cell (without opening status.json/result.json)
// must not mistake it for an approved step. The cell therefore renders a FAIL
// verdict as DENIED rather than the raw decision string: the report is a human
// surface and leads with the operative meaning. The raw verdict vocabulary
// (PASS/FAIL, from AUTOPILOT_REVIEW) stays verbatim in status.json/result.json
// for grep-ability — only this display suffix is remapped, and PASS verdicts
// keep their raw form. Exported because the reader-level tests and the report
// both need the same status vocabulary.
export function statusCellText(run) {
  const raw = run.decision ? String(run.decision) : "";
  const shown = raw.toUpperCase() === "FAIL" ? "DENIED" : raw.toUpperCase();
  const decisionSuffix = raw ? ` (${shown})` : "";
  return `${normalizeStatus(displayStatusLabel(run))}${decisionSuffix}`;
}

// How long the role actually ran, taken from status.json's own `duration`
// (already HH:MM:SS from the process that measured it — not recomputed here,
// so a run whose status.json predates this field still renders "-" instead
// of a fabricated number).
export function durationCellText(run) {
  return run.duration ? String(run.duration) : "-";
}

// Compact price-weighted cost cell ("64.9K" for 64935.3): runs whose
// usage was never recorded (null usage, driverless adapters) render "-"
// instead of a fabricated number. A still-running run's figure is a live,
// accumulating total — never a final one — so it carries a "~" prefix
// ("~12.6K" live vs "12.6K" final). Raw recorded status only, never the
// liveness probe: this keeps the pure function pure (no per-cell
// process-table spawn). TURNS stays unprefixed — a turn count is an exact
// fact, not an accumulating estimate.
export function priceCellText(run) {
  const value = run.usage?.priceWeighted;
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  const text = value >= 1000 ? `${(value / 1000).toFixed(1)}K` : String(Math.round(value));
  return run?.status === "running" ? `~${text}` : text;
}

export function turnsCellText(run) {
  const value = run.usage?.turns;
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return String(Math.trunc(value));
}

// The model actually used for this run (per-role fallback aware):
// status.json `model` first, result.json `model` fallback (see readRunMeta).
// "-" whenever neither recorded one — never a fabricated value.
export function modelCellText(run) {
  const value = run?.model;
  if (value == null || value === "") return "-";
  return String(value);
}

// Backlog #26 Step B: raw growing-term cell (cacheRead + input — the SAME
// raw measure the cap enforces, never the price-weighted figure PRICE
// shows: run 13 showed 216K priced when the cap fired at 750,709 raw).
// Compact K-format like PRICE ("690K"); a still-running run's figure is a
// live accumulating total, so it carries the "~" prefix ("~690K" live vs
// "690K" final). "-" whenever usage was never recorded — never a
// fabricated number.
export function contextCellText(run) {
  const usage = run.usage;
  if (!usage || typeof usage !== "object") return "-";
  const cacheRead = Number(usage.cacheRead);
  const input = Number(usage.input);
  if (!Number.isFinite(cacheRead) || !Number.isFinite(input)) return "-";
  const value = cacheRead + input;
  const text = value >= 1000 ? `${(value / 1000).toFixed(1)}K` : String(Math.round(value));
  return run?.status === "running" ? `~${text}` : text;
}

export function renderCurrentDetail(run, progressTail = []) {
  const lines = [];
  lines.push(`stage: ${run.dirName || run.id}`);
  lines.push(`run_id: ${run.id}`);
  // The pid alone is not evidence of anything: a stopped mission leaves a dead
  // pid behind, so state the liveness verdict next to it rather than letting a
  // reader assume the number means "running".
  const liveness = run.pid != null ? pidLiveness(run.pid) : null;
  const pidNote = run.pid == null
    ? ""
    : liveness === true
      ? " (alive)"
      : liveness === false
        ? " (NOT RUNNING)"
        : " (liveness unknown)";
  lines.push(`role: ${run.role || "-"}  status: ${normalizeStatus(displayStatusLabel(run))}  pid: ${run.pid ?? "-"}${pidNote}`);
  // taskRef is the run's actual task scope ("T1.1", "T001 > T003"); task is
  // the grouping key and may be stale or null — both are shown so the
  // grouping stays auditable, but taskRef is the one to read.
  lines.push(`task: ${run.task ?? "-"}  taskRef: ${run.taskRef ?? "-"}`);
  lines.push(`started: ${formatTimestamp(run.started_at)}  last activity: ${formatTimestamp(run.updated_at)}  last_action: ${run.last_action || "-"}`);
  if (run.exit_code != null) lines.push(`exit_code: ${run.exit_code}  decision: ${run.decision || "-"}  duration: ${run.duration || "-"}  price: ${priceCellText(run)}  context: ${contextCellText(run)}  turns: ${turnsCellText(run)}`);
  // Backlog #26 Step B / 031 T8.3: watch report labels the raw growing term
  // explicitly (same RAW_TOKENS label as the CAP_BREACH/WRAP_UP observe
  // lines) — the CONTEXT column keeps its compact K-format above.
  {
    const __rawTerm = growingTerm(run.usage);
    let __raw = "-";
    if (__rawTerm !== null && __rawTerm !== undefined) __raw = String(__rawTerm);
    lines.push(`RAW_TOKENS=${__raw} (raw maxSingleTurnContext)`);
  }
  if (progressTail.length) {
    lines.push("--- LIVE PROGRESS ---");
    lines.push(...progressTail.map((l) => `  ${l}`));
  }
  return lines.join("\n");
}

export function progressTail(dir, maxLines = 40) {
  const file = path.join(dir, "progress.log");
  if (!fs.existsSync(file)) return [];
  try {
    const all = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
    return all.slice(-maxLines);
  } catch {
    return [];
  }
}

// Runs dir for a mission view: the mission-scoped runs bucket when it exists,
// otherwise the flat legacy runs bucket. Used by the watch report renderer.
export function watchRunsDir(repo, mission) {
  if (mission) {
    const missionRuns = path.join(repo, ".autopilot", "missions", String(mission), "runs");
    if (fs.existsSync(missionRuns)) return missionRuns;
  }
  return path.join(repo, ".autopilot", "runs");
}

// Best-effort JSON read: a missing or malformed file reads null, never throws.
function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

// Parsed per-mission `watch-events.jsonl` lines (gate start/progress/result,
// diff_stat, operator stop/reset/rebase, escalation), oldest first. A missing
// or malformed file degrades to [] so rendering never throws. Read-only.
export function readWatchEvents(repo, mission) {
  if (!mission) return [];
  const file = path.join(repo, ".autopilot", "missions", String(mission), "watch-events.jsonl");
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* skip a malformed line */ }
  }
  return events;
}

// Tail of the newest gate log for a phase (backlog #35h), read cheaply: only
// the last few KB, never the whole `--keep-going` suite log. `phase` null (a
// mission-final gate) picks the newest log of any phase. Returns null when no
// log exists so the gate CURRENT RUN keeps its event-based progress.
export function readGateLogTail(repo, mission, phase = null, { bytes = 8192 } = {}) {
  if (!mission) return null;
  const dir = path.join(repo, ".autopilot", "missions", String(mission), "gates");
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".log")); } catch { return null; }
  if (phase != null && phase !== "") {
    const prefix = `phase-${Number(phase)}-`;
    names = names.filter((n) => n.startsWith(prefix));
    if (!names.length) return null;
  }
  if (!names.length) return null;
  const newest = names
    .map((name) => {
      const file = path.join(dir, name);
      try { return { file, mtime: fs.statSync(file).mtimeMs }; } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)[0];
  if (!newest) return null;
  let fd;
  try {
    fd = fs.openSync(newest.file, "r");
    const size = fs.fstatSync(fd).size;
    const length = Math.max(0, Math.min(bytes, size));
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

// The old layout printed a standalone `Last reset:` line from `state.lastReset`;
// in the 094 layout an operator change shows on the `Events:` line, which the
// model builds from `operator` events. The CLI reset paths append such an event
// (watch-events.jsonl), but a reset applied IN-PROCESS (a queued request honored
// at the failure decision) records only `state.lastReset`. Synthesize the
// matching operator event here so a live reset is never invisible under the new
// layout — without re-recording any watch data. The event's shape mirrors what
// the CLI writes (watch-report.mjs buildOperatorEvents).
export function resetOperatorEvent(reset) {
  if (!reset || typeof reset !== "object") return null;
  const scope = String(reset.scope ?? "");
  const base = { type: "operator", reason: "reset", live: reset.appliedLive === true, at: reset.at ?? null };
  if (scope === "global") return { ...base, scope: "global" };
  if (scope === "standalone-plan-revision") return { ...base, scope: "plan-revision" };
  const contPrefix = "continuationAllowance:";
  if (scope.startsWith(contPrefix)) return { ...base, scope: "extra-sessions", contScope: scope.slice(contPrefix.length) };
  if (/^(implementationFailureBudget|verificationFailureBudget|adapterRetryBudget|infrastructureRetryBudget):/.test(scope)) {
    return { ...base, scope: "retries", key: scope };
  }
  // Unknown shape: the generic `operator reset <scope>` text stays truthful.
  return { ...base, scope };
}

// Same operator-reset identity (scope kind + key/contScope), so a synthesized
// event never duplicates one already in the feed.
function sameResetEvent(a, b) {
  return a?.scope === b?.scope
    && (a?.key ?? null) === (b?.key ?? null)
    && (a?.contScope ?? null) === (b?.contScope ?? null);
}

// Render the full watch report text in the 094 layout. Delegates the model +
// layout to scripts/watch-report.mjs (the single source of truth shared by the
// terminal watch command and the pipeline's direct file writes): a local
// clock-stamped PIPELINE STATE header, then PLANNING / IMPLEMENTATION / FINAL
// REVIEW stages, the live CURRENT RUN and the decoded LIVE PROGRESS.
// STRICTLY READ-ONLY: this renderer never mutates runs (no stale-run recovery,
// no status.json writes). Stale-run recovery is an orchestrator startup
// responsibility handled by autopilot.mjs, not by watch rendering.
//
// The reader layers it feeds the model are unchanged: runs come from
// listRunsOldestNewest, every run's displayed status is reconciled through the
// same displayStatusLabel the old layout used (a run left "running" by a dead
// orchestrator reads as the stale label, never RUNNING), and a cancelled
// mission has no current run. All optional inputs are injectable for tests.
export function renderWatchReport(repo, mission, { tail = 40, isOwnerAlive, isAlive, phases, policy, events, now, skill, gateLog } = {}) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const runsDir = watchRunsDir(repo, mission);
  const state = readJsonFile(path.join(repo, ".autopilot", "state.json"));
  const configResult = loadAndMigrateConfig(path.join(repo, ".autopilot", "config.json"), {persist: false});
  const config = configResult?.config ?? null;
  // Mission 094 Phase 3 task 3.2: serve the run list from the compact
  // watch-summary cache (rebuilt in memory on a miss/stale, never touching
  // every run dir's logs). Falls back to a from-scratch rebuild via peekSummary.
  const summary = peekSummary(repo, mission);
  const summaryRuns = Array.isArray(summary?.runs) ? summary.runs : [];
  const annotated = annotateOwnerLiveness(repo, summaryRuns, { isOwnerAlive });
  // Display-level reconciliation only: the recorded status stays verbatim on
  // disk (readers and the recovery layer see it raw), but the report rows show
  // the label displayStatusLabel computes — a dead-owner/dead-pid "running" run
  // becomes "interrupted (orchestrator not running)".
  const runs = annotated.map((r) => {
    const shown = displayStatusLabel(r, { isAlive: isAlive || pidLiveness });
    return shown === r.status ? r : { ...r, status: shown };
  });
  // A cancelled mission has no current run: without this, detection falls
  // back to the newest real run. Display-level only — detectCurrentRun itself
  // is untouched, so live reporting and recovery keep working.
  const current = state?.phase === "cancelled" ? null : detectCurrentRun(runs);
  const hasRunning = state?.phase !== "cancelled" && Array.isArray(runs) && runs.some((r) => displayStatus(r) === "running");
  let progressDir = null;
  if (hasRunning) {
    const runningSorted = runs.filter((r) => displayStatus(r) === "running").sort((a, b) => (Date.parse(b?.started_at ?? b?.startedAt) || 0) - (Date.parse(a?.started_at ?? a?.startedAt) || 0));
    progressDir = runningSorted.length ? runningSorted[0]?.dir : null;
  } else if (state?.phase !== "cancelled" && Array.isArray(runs) && runs.length) {
    const newest = [...runs].sort((a, b) => (Date.parse(b?.started_at ?? b?.startedAt) || 0) - (Date.parse(a?.started_at ?? a?.startedAt) || 0));
    progressDir = newest.length ? newest[0]?.dir : null;
  } else if (current) {
    progressDir = current.dir;
  }
  const progress = progressDir ? progressTail(progressDir, tail) : [];
  // TASK-39: a fixture-repo git block is an operator-visible warning. The 094
  // layout has no dedicated Warning: line, so the state flag is surfaced as a
  // WARN entry in the LIVE PROGRESS feed (the retired formatWatchReport used to
  // print a standalone warning line for it). Copied so the injectable `events`
  // array a caller passes is never mutated.
  const eventList = [...(events ?? (Array.isArray(summary?.events) ? summary.events : null) ?? readWatchEvents(repo, mission))];
  // A live reset is recorded in state.lastReset; surface it under Events: when
  // the feed does not already carry the matching operator reset event (the CLI
  // paths do). See resetOperatorEvent.
  // Only include the reset if it belongs to the current mission: its timestamp
  // must be at or after the mission start time (planningStartedAt or missionStartedAt).
  const resetEvent = resetOperatorEvent(state?.lastReset);
  const missionStart = state?.planningStartedAt ?? state?.missionStartedAt ?? state?.startedAt ?? state?.started_at ?? null;
  const resetBelongsToMission = resetEvent && (!missionStart || (resetEvent.at && Date.parse(resetEvent.at) >= Date.parse(missionStart)));
  if (resetBelongsToMission && !eventList.some((e) => e && e.type === "operator" && e.reason === "reset" && sameResetEvent(e, resetEvent))) {
    eventList.push(resetEvent);
  }
  if (state?.fixtureGitBlockWarning) {
    eventList.push({ type: "warn", at: null, text: "git calls in fixture repos were blocked; create them outside the project repo." });
  }
  if (state?.gitGuardWarning) {
    eventList.push({ type: "warn", at: null, text: "a git command was blocked and changed nothing; mission continued (warning, not a policy violation)." });
  }
  let ownerAlive = undefined;
  const withFlag = Array.isArray(runs) ? runs.find((r) => typeof r?.ownerAlive === "boolean") : null;
  if (withFlag) ownerAlive = withFlag.ownerAlive === true;
  // The open orchestrator gate's log tail is where live test-file progress is
  // written (backlog #35h); a gate_start without a later gate_result is open.
  let openGatePhase = null;
  let openGate = false;
  for (const e of eventList) {
    if (e?.type === "gate_start") { openGate = true; openGatePhase = e.phase ?? null; }
    else if (e?.type === "gate_result") { openGate = false; openGatePhase = null; }
  }
  const gateLogText = gateLog !== undefined
    ? gateLog
    : (openGate ? readGateLogTail(repo, mission, openGatePhase) : null);
  const model = buildReportModel({
    state,
    runs,
    events: eventList,
    phases: phases ?? [],
    policy: policy ?? (config && typeof config.policy === "object" ? config.policy : {}),
    layout: configResult?.layout ?? null,
    progress,
    gateLog: gateLogText,
    now: now ?? d.toISOString(),
    skill: skill ?? null,
    missionFallback: mission ?? null,
    ownerAlive,
  });
  return renderReport(model, { stamp });
}

// Direct-write the watch report file (same principle as progress.log: the
// pipeline writes it at event time, no polling process). Default path sits
// next to the mission REPORT.md; a .md target is wrapped in a fenced code
// block so the aligned columns keep their monospace layout in a Markdown
// preview. Atomic via temp file + rename so a reader never sees a
// half-written report. Returns the file path written.
export function writeWatchReportFile(repo, mission, { tail = 40, outFile } = {}) {
  const file = outFile || (mission
    ? path.join(repo, ".autopilot", "missions", String(mission), "WATCH-REPORT.md")
    : path.join(repo, ".autopilot", "WATCH-REPORT.md"));
  // Backlog #8: the file write gets the mission's real phase list (the same
  // standalone adapter parse the orchestrator uses) and policy, so the
  // Implementation stage names its phases and totals instead of counting runs.
  const configResult = loadAndMigrateConfig(path.join(repo, ".autopilot", "config.json"), {persist: false});
  const config = configResult?.config ?? null;
  let missionPhases = [];
  try { missionPhases = standalonePhases(repo, mission); } catch { missionPhases = []; }
  const text = renderWatchReport(repo, mission, {
    tail,
    phases: missionPhases,
    policy: config && typeof config.policy === "object" ? config.policy : {},
  });
  const body = /\.md$/i.test(file) ? `\`\`\`\n${text}\n\`\`\`\n` : `${text}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, file);
  return file;
}
// One-line note for `ap status`: how many runs read "running" but belong to a
// dead orchestrator. Display only; null when none.
export function staleRunningNote(repo, mission, { isOwnerAlive, isAlive } = {}) {
  const runs = annotateOwnerLiveness(repo, listRunsOldestNewest(watchRunsDir(repo, mission)), { isOwnerAlive });
  const n = runs.filter((r) => String(r.status || "") === "running" && displayStatus(r, { isAlive }) === "interrupted").length;
  return n ? `${n} run(s) recorded as running but ${STALE_RUNNING_LABEL}; the next \`ap run\` finalizes them.` : null;
}
