import fs from "node:fs";
import path from "node:path";

import { updateSummaryForRunDir } from "./watch-summary.mjs";

export function localIso(d = new Date()) {
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function formatDuration(ms) {
  if (ms == null || Number.isNaN(ms) || ms < 0) return "-";
  const total = Math.floor(ms / 1000);
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

const throttle = new Map();

// TASK-27: last persisted usage per run dir ({turns, at}), backing the
// live-totals cadence in updateRunUsage(). Memory only — a restart begins
// unpersisted, which is correct because status.json is re-read from disk.
const lastUsagePersist = new Map();

export function sanitizeSnippet(chunk, max = 600) {
  let s = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
  s = s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");      // strip ANSI CSI escapes
  s = s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ""); // strip OSC sequences
  s = s.replace(/\r\n|\r|\n/g, " ").replace(/\t/g, " ");
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > max) s = s.slice(0, Math.max(0, max - 1)) + "…";
  return s;
}

function appendProgress(dir, line) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "progress.log"), `${localIso()}  ${line}\n`);
}

// Backlog #6a: the input keys an adapter action carries its target under, in
// priority order (a shell command first, then a file path, then free text).
const ACTION_TARGET_KEYS = ["command", "CommandLine", "filePath", "file_path", "TargetFile", "File", "path", "target_file", "description", "pattern", "query"];

function actionTarget(input) {
  if (!input || typeof input !== "object") return "";
  for (const key of ACTION_TARGET_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

// A `read` tool's path plus the line window it asked for:
// `scripts/setup.mjs:1640-1719` (offset+limit-1). Null when the tool carries no
// offset/limit (a plain whole-file read keeps just its path).
const READ_TOOLS = new Set(["read", "read_file", "readfile", "readfiletool"]);
function readRangeText(input) {
  if (!input || typeof input !== "object") return null;
  const file = actionTarget(input);
  if (!file) return null;
  const offset = Number(input.offset);
  const limit = Number(input.limit);
  if (Number.isFinite(offset) && Number.isFinite(limit) && limit > 0) {
    return `${file}:${offset}-${offset + limit - 1}`;
  }
  return null;
}

function unescapeJsonText(value) {
  try { return JSON.parse(`"${value}"`); } catch { return value; }
}

// Normalize one decoded adapter event object into {kind, text}: the tool name
// (lowercased) plus its command/file target. Covers opencode
// (`{type:"tool_use",part:{type:"tool",tool,state:{input}}}`), claude
// stream-json tool_use content blocks, and agy `step_update` tool steps.
function actionFromEvent(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const part = obj.part && typeof obj.part === "object" ? obj.part : null;
  const topType = String(obj.type || "");
  const partType = part ? String(part.type || "") : "";
  let tool = "";
  let input = null;
  if (topType === "tool_use" || topType === "tool" || partType === "tool" || partType === "tool_use") {
    tool = String(part?.tool || obj.tool || "");
    input = part?.state?.input ?? obj.state?.input ?? obj.input ?? null;
  }
  if (!tool) {
    const blocks = [];
    if (obj.content_block && typeof obj.content_block === "object") blocks.push(obj.content_block);
    if (Array.isArray(obj.message?.content)) blocks.push(...obj.message.content);
    if (Array.isArray(obj.content)) blocks.push(...obj.content);
    for (const block of blocks) {
      if (block && typeof block === "object" && (block.type === "tool_use" || block.type === "tool")) {
        tool = String(block.name || block.tool || "");
        input = block.input ?? null;
        break;
      }
    }
  }
  const step = obj.step_update && typeof obj.step_update === "object" ? obj.step_update : null;
  if (!tool && step && String(step.step_type || "") === "tool") {
    tool = String(step.tool_name || step.tool_info?.name || "");
    input = step.tool_info?.parameters ?? step.tool_info?.input ?? null;
  }
  if (!tool) return null;
  const kind = tool.toLowerCase();
  const text = (READ_TOOLS.has(kind) && readRangeText(input)) || actionTarget(input);
  return { kind, text };
}

// Find the first real adapter action inside a raw chunk, BEFORE the ACTIVITY
// snippet is truncated (backlog #6a). Whole NDJSON lines are parsed; a chunk
// boundary that cut the event mid-line falls back to a field regex so a
// `tool`/`command` fragment still yields an action.
export function extractAction(chunk) {
  const raw = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
  if (!raw || raw.indexOf("{") < 0) return null;
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text[0] !== "{") continue;
    let obj = null;
    try { obj = JSON.parse(text); } catch { obj = null; }
    if (obj) {
      const action = actionFromEvent(obj);
      if (action) return action;
    }
  }
  if (/"type"\s*:\s*"tool(?:_use)?"/.test(raw)) {
    const tool = raw.match(/"(?:tool|name)"\s*:\s*"((?:[^"\\]|\\.)+)"/);
    if (tool) {
      const detail = raw.match(/"(?:command|filePath|file_path|path|description)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      return { kind: unescapeJsonText(tool[1]).toLowerCase(), text: detail ? unescapeJsonText(detail[1]) : "" };
    }
  }
  return null;
}

function updateStatus(dir, patch) {
  const file = path.join(dir, "status.json");
  try {
    const current = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...current, ...patch }, null, 2));
  } catch {
    // status bookkeeping must never break a run
  }
}

export function initRun(dir, meta = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const at = localIso();
  const status = {
    status: "running",
    run_id: meta.runId ?? null,
    started_at: at,
    updated_at: at,
    pid: meta.pid ?? null,
    role: meta.role ?? null,
    phase: meta.phase ?? null,
    taskGroup: meta.taskGroup ?? meta.task ?? null,
    // The run's actual task scope as display refs ("T1.1" for one task,
    // "T001 > T003" for a range, null when phase-level or unknown).
    // This is the field to read; `taskGroup` above is grouping-only (see
    // observabilityMeta in autopilot.mjs) and may be stale or null.
    taskRef: meta.taskRef ?? null,
    // SpecKit/GSD planning stage this run worked on (`spec`/`plan`/`tasks` or
    // `discuss`/`research`/`plan`/`plan-check`). Null for every other run and
    // for standalone planning, whose report label stays `plan/tasks`.
    planningStage: meta.planningStage ?? null,
    attempt: meta.attempt ?? null,
    // Backlog #26 Step B: wrap-up marker (`note: "wrap-up"` on the forced
    // hand-off run). Shown in the watch report so the extra run after a cap
    // reads as the note-writing turn, not another generation.
    note: meta.note ?? null,
    // Mission 093 Part 1 task 2.2: model actually used vs configured at
    // launch. configuredModel is the effective role model at launch (null
    // when the CLI chose its default); resolvedModel/modelMismatch are
    // null before the stream reports a model signal. Additive — the legacy
    // `model` field and every reader above are untouched.
    configuredModel: meta.configuredModel ?? null,
    resolvedModel: meta.resolvedModel ?? null,
    modelMismatch: meta.modelMismatch ?? null,
    // Backlog #7: reasoning level / opencode variant of the model actually
    // launched (the active fallback/escalation entry's own values, never the
    // primary's). Null when the CLI default applies. Additive.
    reasoning: meta.reasoning ?? null,
    variant: meta.variant ?? null,
    // Mission 093 Part 1 task 2.3: run-scoped layout fields. snapshotBeforeAt
    // and snapshotAfterAt are the end wall-clock times of the relay's safety
    // snapshots; the matching *StartedAt fields let the report print the
    // snapshots' own durations. sessionNumber is the run scope's
    // continuation-budget used count at launch + 1. All are null on runs that
    // own no snapshot/scope (never fabricated). Additive — every reader above
    // is untouched.
    snapshotBeforeStartedAt: meta.snapshotBeforeStartedAt ?? null,
    snapshotBeforeAt: meta.snapshotBeforeAt ?? null,
    snapshotAfterStartedAt: meta.snapshotAfterStartedAt ?? null,
    snapshotAfterAt: meta.snapshotAfterAt ?? null,
    sessionNumber: meta.sessionNumber ?? null,
    // Mission 093 Part 1 task 2.4: plan revision number on planning runs
    // (the standalone revision-loop generation this run belongs to, 0-based).
    // Null on runs that own no plan revision (never fabricated): callers pass
    // a finite integer >= 0 only for planning runs; anything else degrades to
    // null here. Additive — every reader above is untouched.
    planRevision: (Number.isInteger(meta.planRevision) && meta.planRevision >= 0 ? meta.planRevision : null),
    // Mission 093 Part 1 task 2.5: task ids carried forward into this attempt
    // by the implementer loop's carryDecision (TASK-21 step 2) before this
    // run launched — the loop's carry layout at attempt start. Null on
    // every other run (never fabricated): callers pass only a real carry
    // list; a non-list or empty list degrades to null here. Additive — every
    // reader above is untouched.
    carriedForwardTasks: (Array.isArray(meta.carriedForwardTasks) && meta.carriedForwardTasks.length > 0 ? meta.carriedForwardTasks : null),
    // The pre-run seed call defers the START line until the child process
    // actually exists (onStart re-inits with the real pid). Until then the
    // run is visibly PREPARING, never a fake START with PID=-.
    last_action: meta.last_action ?? (meta.deferStart === true ? "preparing" : "started"),
  };
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status, null, 2));
  if (meta.deferStart !== true) {
    appendProgress(dir, `START | ROLE=${meta.role ?? "-"} | PHASE=${meta.phase ?? "-"} | TASK=${meta.taskRef ?? "-"} | ATTEMPT=${meta.attempt ?? "-"} | PID=${meta.pid ?? "-"}`);
  } else {
    // Seed an empty progress.log so readers can tail it while the pre-run
    // steps write their PREPARE lines; no fake START with PID=-.
    const progressFile = path.join(dir, "progress.log");
    if (!fs.existsSync(progressFile)) fs.writeFileSync(progressFile, "");
  }
  // Mission 094 Phase 3 task 3.2: keep the compact watch-summary cache current
  // at the run-write points so a later render never re-reads every run dir.
  // Best-effort (a failed cache write must never break a run); a dir that is
  // not a mission run dir is a no-op.
  updateSummaryForRunDir(dir);
  return status;
}

// Mark a run as PREPARING (before its CLI exists) so status.json, and therefore
// the watch report, names the setup step that is running instead of showing a
// running run with pid null. Best-effort like every observability write.
export function setRunPreparing(dir, action) {
  const name = String(action || "").trim();
  if (!name) return false;
  updateStatus(dir, { updated_at: localIso(), last_action: `preparing: ${name}` });
  try { updateSummaryForRunDir(dir); } catch { /* ignore */ }
  return true;
}

// Append one `PREPARE | <action>[ (<detail>)] | DURATION=<h:mm:ss>` line for a
// completed pre-run step (git guard, snapshot-before, …). The START line stays
// the only line that names the real PID, and keeps its existing format.
export function prepareRun(dir, { action, detail = null, durationMs = null } = {}) {
  const name = String(action || "").trim();
  if (!name) return false;
  const suffix = detail ? ` (${detail})` : "";
  const duration = Number.isFinite(Number(durationMs)) && Number(durationMs) >= 0 ? ` | DURATION=${formatDuration(Number(durationMs))}` : "";
  appendProgress(dir, `PREPARE | ${name}${suffix}${duration}`);
  updateStatus(dir, { updated_at: localIso(), last_action: `preparing: ${name}` });
  try { updateSummaryForRunDir(dir); } catch { /* ignore */ }
  return true;
}

export function observe(dir, { stream = "stdout", bytes = 0, minIntervalMs = 1000, last } = {}) {
  // Backlog #6a: a chunk carrying a real tool action writes its OWN progress
  // line (tool + command/file, extracted before the ACTIVITY snippet is
  // truncated) immediately, bypassing the 1-per-second throttle.
  const action = extractAction(last);
  if (action) {
    const detail = action.text ? ` | ${sanitizeSnippet(action.text, 200)}` : "";
    appendProgress(dir, `ACTION | TOOL=${action.kind}${detail}`);
  }
  const now = Date.now();
  const prev = throttle.get(dir) || { lastWrite: 0 };
  if (now - prev.lastWrite < minIntervalMs) return;
  prev.lastWrite = now;
  throttle.set(dir, prev);
  const snippet = sanitizeSnippet(last);
  appendProgress(dir, `ACTIVITY | STREAM=${stream} | BYTES=${bytes}${snippet ? ` | LAST=${snippet}` : ""}`);
  updateStatus(dir, { updated_at: localIso(), last_action: "streaming" });
  // Mission 094 Phase 3 task 3.2: live progress rewrote status.json, so refresh
  // the compact summary cache for this run (best-effort, never breaks a run).
  try { updateSummaryForRunDir(dir); } catch { /* ignore */ }
}

// TASK-27: persist live per-invocation usage totals to a run's status.json
// ({usage, updated_at} via the existing safe updateStatus merge — a failed
// write degrades to no persist, never a broken run). Cadence: the first
// persist for a dir writes immediately (no prior baseline); afterwards a
// persist requires BOTH turns >= lastTurns + minTurns AND minIntervalMs
// since the last persist. Null/non-object usage — or usage without a finite
// turn count — never writes (driverless adapters such as codex stay "-",
// never a fabricated zero). Returns whether a persist was issued,
// so the caller can refresh the watch on the same tick.
export function updateRunUsage(dir, usage, { minTurns = 2, minIntervalMs = 10000 } = {}) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return false;
  const turns = usage.turns;
  if (typeof turns !== "number" || !Number.isFinite(turns)) return false;
  const step = Number.isFinite(minTurns) && minTurns > 0 ? minTurns : 2;
  const floor = Number.isFinite(minIntervalMs) && minIntervalMs >= 0 ? minIntervalMs : 10000;
  const now = Date.now();
  const prev = lastUsagePersist.get(dir);
  if (prev) {
    if (turns < prev.turns + step) return false;
    if (now - prev.at < floor) return false;
  }
  lastUsagePersist.set(dir, { turns, at: now });
  updateStatus(dir, { usage, updated_at: localIso() });
  // Mission 094 Phase 3 task 3.2: status.json changed, refresh the summary cache.
  try { updateSummaryForRunDir(dir); } catch { /* ignore */ }
  return true;
}

// Mission 093 Part 1 task 2.2: persist the model-resolution fields on a
// run's status.json ({configuredModel, resolvedModel, modelMismatch} via
// the existing safe updateStatus merge — a failed write degrades to no
// persist, never a broken run). Only keys present (not undefined) in patch
// are written, so a live stream tick can update resolvedModel/modelMismatch
// without clobbering the launch-time configuredModel. The legacy `model`
// field is never touched here.
export function updateRunModel(dir, patch = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return false;
  const next = {};
  for (const key of ["configuredModel", "resolvedModel", "modelMismatch"]) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  if (Object.keys(next).length === 0) return false;
  updateStatus(dir, { ...next, updated_at: localIso() });
  // Mission 094 Phase 3 task 3.2: the resolved model changed, so refresh the
  // compact summary cache for this run (best-effort; never breaks a run).
  updateSummaryForRunDir(dir);
  return true;
}

// Mission 093 Part 1 task 2.3: persist the run-scoped snapshot/session
// fields on a run's status.json via the existing safe updateStatus merge — a
// failed write degrades to no persist, never a broken run. Only keys present
// (not undefined) in patch are written, so the before-snapshot site can
// record its fields without touching the after fields, and vice versa.
// Unknown keys are ignored; an empty patch is a no-op returning false.
export function updateRunSnapshots(dir, patch = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return false;
  const next = {};
  for (const key of ["snapshotBeforeStartedAt", "snapshotBeforeAt", "snapshotAfterStartedAt", "snapshotAfterAt", "sessionNumber"]) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  if (Object.keys(next).length === 0) return false;
  updateStatus(dir, { ...next, updated_at: localIso() });
  // Mission 094 Phase 3 task 3.2: status.json changed, refresh the summary cache.
  try { updateSummaryForRunDir(dir); } catch { /* ignore */ }
  return true;
}

export function finalizeRun(dir, { status, exitCode, decision, startedAt, usage = null, timeoutMs = null } = {}) {
  const at = localIso();
  const durationMs = startedAt ? new Date(at).getTime() - new Date(startedAt).getTime() : null;
  const duration = formatDuration(durationMs);
  appendProgress(dir, `FINISHED | STATUS=${status} | EXIT_CODE=${exitCode ?? "-"} | DURATION=${duration} | DECISION=${decision ?? "-"}`);
  updateStatus(dir, {
    status,
    finished_at: at,
    exit_code: exitCode ?? null,
    decision: decision ?? null,
    duration,
    duration_ms: durationMs,
    // TASK-26: the kill deadline that governed this run (additive — readers
    // that predate it see null, never a fabricated value).
    timeout_ms: Number(timeoutMs) > 0 ? Number(timeoutMs) : null,
    // Absent (null), never a fabricated 0, when the adapter/event stream
    // carried no per-turn usage signal -- mirrors result.json's own usage
    // field (adapter-drivers.mjs's accumulateUsage()).
    usage: usage ?? null,
    last_action: "finished",
  });
  throttle.delete(dir);
  lastUsagePersist.delete(dir);
  // Mission 094 Phase 3 task 3.2: finalize changed this run's status, so
  // refresh the compact watch-summary cache (best-effort, never breaks a run).
  updateSummaryForRunDir(dir);
  return { duration, durationMs };
}