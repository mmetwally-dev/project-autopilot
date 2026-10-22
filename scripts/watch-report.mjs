import fs from "node:fs";
import path from "node:path";

// Mission 094 Phase 1 task 1.1 — the core report model.
//
// `buildReportModel` normalizes the three live data sources of a watch report
// into a single stage/phase/attempt/taskRef tree:
//   - `state`  : parsed `.autopilot/state.json`
//   - `runs`   : run metas produced by `run-history.mjs` readers
//                (`readRunMeta`/`listRunsOldestNewest`), optionally already
//                carrying the extra per-run fields
//   - `events` : parsed `<mission>/watch-events.jsonl` lines (optional here)
// plus an optional `phases` descriptor list (adapter `phases()` output or a
// simple `{number,name,tasks}` list).
//
// The module is PURE apart from a defensive, best-effort read of each run's
// `status.json`/`result.json` for fields the run-history reader does not
// expose (findings, carriedForwardTasks, sessionNumber, resolved model). It
// never writes, never probes liveness and never throws on malformed input.
//
// A legacy run record (a plain `task` field, no `taskRef`, no events) is
// bucketed with its `task` used as the display ref and never crashes.

const PLANNING_ROLES = new Set(["planner", "plan_reviewer"]);
const REVIEW_ROLES = new Set(["code_reviewer", "verifier"]);
const IMPLEMENTATION_ROLES = new Set(["implementer"]);

function roleOf(run) {
  return typeof run?.role === "string" ? run.role : "";
}

// The display ref of a run: `taskRef` first (the run's actual scope), then the
// legacy `task` grouping field, else null. Never a fabricated value.
export function runRef(run) {
  if (typeof run?.taskRef === "string" && run.taskRef) return run.taskRef;
  if (typeof run?.task === "string" && run.task) return run.task;
  return null;
}

function phaseNumberOf(run) {
  const p = run?.phase;
  if (p == null || p === "") return null;
  const n = Number(p);
  return Number.isFinite(n) ? n : null;
}

function attemptNumberOf(run) {
  const a = run?.attempt;
  if (a == null || a === "") return null;
  const n = Number(a);
  return Number.isFinite(n) ? n : null;
}

// A failed reviewer/verifier records its findings on result.json under
// `review.findings` (falling back to a top-level `findings`).
function readRunExtras(dir) {
  const extras = {
    findings: [],
    carriedForwardTasks: null,
    sessionNumber: null,
    configuredModel: null,
    resolvedModel: null,
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
      if (st.sessionNumber !== undefined) extras.sessionNumber = st.sessionNumber;
      if (st.carriedForwardTasks !== undefined) extras.carriedForwardTasks = st.carriedForwardTasks;
      if (st.configuredModel !== undefined) extras.configuredModel = st.configuredModel;
      if (st.resolvedModel !== undefined) extras.resolvedModel = st.resolvedModel;
      if (st.modelMismatch !== undefined) extras.modelMismatch = st.modelMismatch;
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

// Merge the reader-provided run with the extra fields the reader drops. An
// inline value wins when present, so tests stay hermetic and watch-summary's
// reader stays authoritative; a field the reader omitted (the summary never
// carries `planRevision`, the snapshot timestamps or `note`) comes from the run
// dir. The dir is always read when known - gating on a single inline field
// (e.g. `resolvedModel`) silently dropped those extras (backlog #4).
const RUN_EXTRA_KEYS = [
  "carriedForwardTasks", "sessionNumber", "resolvedModel", "configuredModel",
  "modelMismatch", "snapshotBeforeStartedAt", "snapshotBeforeAt", "snapshotAfterStartedAt", "snapshotAfterAt", "planRevision", "note",
  "policyViolation", "failureClass", "escalated", "interrupted_at", "interruption_reason",
];
function enrichRun(run) {
  const enriched = { ...run };
  const inlineComplete = RUN_EXTRA_KEYS.every((key) => enriched[key] !== undefined);
  const extras = typeof run?.dir === "string" && (!inlineComplete || !Array.isArray(enriched.findings))
    ? readRunExtras(run.dir)
    : null;
  enriched.findings = Array.isArray(enriched.findings)
    ? enriched.findings.map(String)
    : (extras ? extras.findings : []);
  for (const key of RUN_EXTRA_KEYS) {
    if (enriched[key] === undefined) enriched[key] = extras ? extras[key] : null;
  }
  return enriched;
}

// The task ref a display row can use: an explicit ref/id, else the leading
// `T…` token of the task text (standalone/speckit task lists carry it there).
function taskRefFromText(text) {
  const m = String(text ?? "").match(/\bT\d+(?:\.\d+)?\b/);
  return m ? m[0] : null;
}

function normalizeTask(task) {
  if (task == null) return { ref: null, text: "", done: false };
  const text = typeof task.text === "string" ? task.text : "";
  const ref = typeof task.ref === "string" && task.ref
    ? task.ref
    : (typeof task.id === "string" && task.id ? task.id : taskRefFromText(text));
  return { ref, text, done: task.done === true };
}

// Accept either an adapter `phases()` list (`{name,number,tasks,done}`) or a
// simple `{index,name,tasks}` list. Phase numbers are always 1-based.
export function normalizePhases(phases) {
  const list = Array.isArray(phases) ? phases : [];
  return list.map((p, i) => {
    let number;
    if (p?.number != null && Number.isFinite(Number(p.number))) number = Number(p.number);
    else if (p?.index != null && Number.isFinite(Number(p.index))) number = Number(p.index) + 1;
    else number = i + 1;
    const name = typeof p?.name === "string" && p.name ? p.name : `Phase ${number}`;
    const tasks = Array.isArray(p?.tasks) ? p.tasks.map(normalizeTask) : [];
    const done = p?.done === true || (tasks.length > 0 && tasks.every((t) => t.done));
    return { number, name, tasks, done };
  });
}

function isDecision(run, value) {
  return String(run?.decision || "").toUpperCase() === value;
}

function isRunning(run) {
  return String(run?.status || "") === "running";
}

// A mission-level terminal status carried into the stage/phase/attempt headers
// (backlog #5): a CANCELLED/STOPPED/ESCALATED mission whose stage never passed
// must not keep reading `● IN PROGRESS`. Returns the stage-status token for a
// terminal mission status, else null (a live/complete run keeps its own
// in_progress/passed logic untouched).
const TERMINAL_STAGE_STATUS = { CANCELLED: "cancelled", STOPPED: "stopped", ESCALATED: "escalated" };
function terminalStageStatus(missionStatus) {
  return TERMINAL_STAGE_STATUS[String(missionStatus || "").toUpperCase()] || null;
}

const TERMINAL_MISSION_STATUS = new Set(["CANCELLED", "COMPLETED", "ESCALATED", "STOPPED"]);
function isMissionEnded(status) {
  return TERMINAL_MISSION_STATUS.has(String(status || "").toUpperCase());
}

// `<marker> · <price>[(resumable)]` for a terminal (cancelled/stopped/
// escalated) stage header; null for every other status so the passed/
// in-progress/not-started branches stay in charge.
export function terminalStageMarker(status, price) {
  const token = terminalStageStatus(status) || (["cancelled", "stopped", "escalated"].includes(status) ? status : null);
  if (!token) return null;
  const tokens = ` · ${formatTokens(price)}`;
  if (token === "cancelled") return { marker: "✗ CANCELLED", detail: tokens };
  if (token === "stopped") return { marker: "■ STOPPED", detail: `${tokens} (resumable)` };
  return { marker: "✗ ESCALATED", detail: tokens };
}

// Group runs by their display ref while preserving first-seen order.
function groupByRef(runs) {
  const groups = [];
  const index = new Map();
  for (const run of runs) {
    const ref = runRef(run);
    const key = ref == null ? "\u0000*" : ref;
    if (!index.has(key)) {
      const group = { taskRef: ref, runs: [] };
      index.set(key, group);
      groups.push(group);
    }
    index.get(key).runs.push(run);
  }
  return groups;
}

function aggregateFindings(runs) {
  const findings = [];
  for (const run of runs) {
    for (const text of run.findings || []) findings.push({ run: run.id ?? run.dirName ?? null, text: String(text) });
  }
  return findings;
}

function aggregateCarriedForward(runs) {
  const carried = [];
  for (const run of runs) {
    if (Array.isArray(run.carriedForwardTasks)) {
      for (const t of run.carriedForwardTasks) if (!carried.includes(t)) carried.push(t);
    }
  }
  return carried;
}

// Every task ref of a phase, in phase order: the phase task list first, else
// the implementation runs' refs ordered by their start (the runtime truth when
// the adapter's descriptor has no refs).
function phaseTaskRefs(phase) {
  const fromDef = (phase?.tasks || []).map((t) => t.ref).filter(Boolean);
  const defRefs = [...new Set(fromDef)];
  if (defRefs.length) return defRefs;
  const ordered = (phase?.runs || [])
    .filter((r) => IMPLEMENTATION_ROLES.has(roleOf(r)))
    .map((r) => ({ ref: runRef(r), at: Date.parse(r.started_at ?? r.startedAt) || 0 }))
    .filter((r) => r.ref)
    .sort((a, b) => a.at - b.at);
  return [...new Set(ordered.map((r) => r.ref))];
}

function taskRange(refs) {
  const list = Array.isArray(refs) ? refs : [];
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  return `${list[0]} > ${list[list.length - 1]}`;
}

// The TASK cell of a review/verify row. A run that covers every task of the
// phase is shown as the first-to-last range; a run that covers only some tasks
// keeps its comma list (`T1.1, T1.3, T1.5`); a single contiguous range already
// recorded stays as it is. A long `>` chain (never produced by a real run) is
// reduced to its endpoints.
function normalizeRunTaskRef(ref, allRefs) {
  const text = String(ref ?? "").trim();
  if (!text) return null;
  const all = Array.isArray(allRefs) ? allRefs : [];
  const allSet = new Set(all);
  const tokens = text.split(/[>,]/).map((t) => t.trim()).filter(Boolean);
  const unique = [...new Set(tokens)];
  const coversAll = all.length > 0 && unique.length === all.length && unique.every((t) => allSet.has(t));
  if (coversAll) return taskRange(all);
  if (text.includes(",")) return text.split(",").map((t) => t.trim()).filter(Boolean).join(", ");
  const gtCount = (text.match(/>/g) || []).length;
  if (gtCount > 1) return `${tokens[0]} > ${tokens[tokens.length - 1]}`;
  return text;
}

// A carried-forward entry is recorded as the internal stable id
// (`standalone:P1:T0:4ab4c18bb44b`). Show the task id instead: resolve the
// phase's ordinal to its display ref, falling back to `T<phase>.<ordinal+1>`.
function displayCarriedTask(value, phase) {
  return String(value ?? "").split(",").map((part) => {
    const text = part.trim();
    const m = text.match(/^[^:]+:P(\d+):T(\d+):[0-9a-f]+$/);
    if (!m) return text;
    const phaseNumber = Number(m[1]);
    const ordinal = Number(m[2]);
    const refs = phaseTaskRefs(phase);
    if (refs[ordinal]) return refs[ordinal];
    return `T${phaseNumber}.${ordinal + 1}`;
  }).filter(Boolean).join(", ");
}

// The attempt whose time window contains a gate START. An attempt's window
// begins at its earliest row; after a verifier DENIED ends an attempt it ends
// there, so the next attempt's window starts with the hand-fix/reset and a
// gate that runs before that attempt's first recorded run still belongs to it.
// A gate after a review but before any terminal verifier stays with that
// review's attempt.
function attemptForGateStart(gate, attempts) {
  const list = Array.isArray(attempts) ? attempts : [];
  if (!list.length) return null;
  const at = Date.parse(gate?.at ?? gate?.resultAt);
  if (!Number.isFinite(at)) return list[list.length - 1].number;
  const starts = [];
  const runs = [];
  for (const attempt of list) {
    let first = Infinity;
    for (const run of attempt.runs || []) {
      const t = Date.parse(run.started_at ?? run.startedAt);
      if (!Number.isFinite(t)) continue;
      if (t < first) first = t;
      runs.push({ t, attempt: attempt.number, role: roleOf(run), run });
    }
    if (Number.isFinite(first)) starts.push({ t: first, attempt: attempt.number });
  }
  if (!starts.length) return list[0].number;
  starts.sort((a, b) => a.t - b.t);
  runs.sort((a, b) => a.t - b.t);
  let chosen = starts[0].attempt;
  for (const s of starts) if (s.t <= at) chosen = s.attempt;
  const next = runs.find((r) => r.t >= at);
  if (next && next.attempt > chosen) {
    const denied = runs.some((r) => r.t < at && r.attempt === chosen
      && r.role === "verifier" && isDecision(r.run, "FAIL"));
    if (denied) chosen = next.attempt;
  }
  return chosen;
}

// The attempt's verdict is decided by the LAST review run in time order: a
// PASS after an earlier FAIL is a PASS (a phase-2 attempt runs 49 APPROVED,
// 50 DENIED, 51 APPROVED - the attempt follows the last word, not any FAIL).
function attemptResult(runs) {
  if (runs.some(isRunning)) return "IN_PROGRESS";
  const reviews = runs
    .map((r, i) => ({ r, i, t: Date.parse(r?.started_at ?? r?.startedAt) }))
    .filter((x) => REVIEW_ROLES.has(roleOf(x.r)) && (isDecision(x.r, "FAIL") || isDecision(x.r, "PASS")))
    .sort((a, b) => (((Number.isFinite(a.t) ? a.t : 0) - (Number.isFinite(b.t) ? b.t : 0)) || (a.i - b.i)));
  if (!reviews.length) return null;
  return isDecision(reviews[reviews.length - 1].r, "FAIL") ? "DENIED" : "PASS";
}

// Build the attempt groups of one phase. The recorded `attempt` is bumped by
// every stage re-entry (a stop/resume or crash restart included), so it cannot
// be displayed directly: count attempts the way the failure budget does, by
// opening a new display attempt only after the previous one was DENIED. A
// restart or a later review in the same budget attempt merges into it.
function buildAttempts(runs) {
  const byNumber = new Map();
  for (const run of runs) {
    const n = attemptNumberOf(run) ?? 1;
    if (!byNumber.has(n)) byNumber.set(n, []);
    byNumber.get(n).push(run);
  }
  const groups = [];
  for (const n of [...byNumber.keys()].sort((a, b) => a - b)) {
    const attemptRuns = byNumber.get(n);
    const prev = groups[groups.length - 1];
    if (prev && prev.result !== "DENIED") {
      prev.runs.push(...attemptRuns);
      prev.rawNumbers.add(n);
    } else {
      groups.push({ runs: [...attemptRuns], rawNumbers: new Set([n]) });
    }
    const group = groups[groups.length - 1];
    group.result = attemptResult(group.runs);
    group.findings = aggregateFindings(group.runs);
    group.carriedForward = aggregateCarriedForward(group.runs);
    group.tasks = groupByRef(group.runs);
  }
  return groups.map((group, i) => ({
    number: i + 1,
    result: group.result,
    findings: group.findings,
    carriedForward: group.carriedForward,
    tasks: group.tasks,
    runs: group.runs,
    rawNumbers: [...group.rawNumbers],
  }));
}

function phaseHasPassReview(runs) {
  return runs.some((r) => REVIEW_ROLES.has(roleOf(r)) && isDecision(r, "PASS"));
}

// A phase is PASSED once its verifier approved: the later phase-completion
// checks in TASKS.md/state may not have run yet (backlog #35i).
function phaseHasVerifyPass(runs) {
  const verifiers = (runs || []).filter((r) => roleOf(r) === "verifier");
  return verifiers.length > 0 && isDecision(verifiers[verifiers.length - 1], "PASS");
}

function phaseStatus(def, runs, { state, phaseIndex, status: missionStatus } = {}) {
  const terminal = terminalStageStatus(missionStatus);
  if (runs.some(isRunning) && !terminal) return "in_progress";
  if (def.done) return "passed";
  if (phaseHasVerifyPass(runs)) return "passed";
  // GSD phases carry no checklist in the descriptor: a completed phase review
  // PASS is the completion signal there.
  if (def.tasks.length === 0 && runs.length > 0 && phaseHasPassReview(runs)) return "passed";
  if (runs.length > 0) return terminal || "in_progress";
  if (phaseIndex != null && Number.isFinite(Number(phaseIndex)) && def.number === Number(phaseIndex) + 1
      && typeof state?.phase === "string" && /implement|verif|review/i.test(state.phase)) {
    return terminal || "in_progress";
  }
  return "not_started";
}

// Planning rounds: each planner run opens a new round; the plan_reviewer runs
// that follow (until the next planner) belong to it. `revision` is the
// planner's recorded planRevision (the generation being reviewed).
function buildPlanningRuns(runs, { status: missionStatus } = {}) {
  const rounds = [];
  let current = null;
  for (const run of runs) {
    if (current == null || roleOf(run) === "planner") {
      current = {
        number: rounds.length + 1,
        revision: run.planRevision ?? null,
        runs: [],
        findings: [],
      };
      rounds.push(current);
    }
    current.runs.push(run);
    for (const f of run.findings || []) current.findings.push({ run: run.id ?? run.dirName ?? null, text: String(f) });
  }
  const terminal = terminalStageStatus(missionStatus);
  let status;
  if (!runs.length) status = "not_started";
  else if (runs.some(isRunning) && !terminal) status = "in_progress";
  else {
    const reviewers = runs.filter((r) => roleOf(r) === "plan_reviewer");
    const passed = reviewers.length && isDecision(reviewers[reviewers.length - 1], "PASS");
    if (passed) status = "passed";
    else if (terminal) status = terminal;
    else status = "in_progress";
  }
  return {
    status,
    rounds,
    runs,
    findings: aggregateFindings(runs),
    revision: runs.reduce((max, r) => (typeof r.planRevision === "number" && (max == null || r.planRevision > max) ? r.planRevision : max), null),
  };
}

// Final review rounds: each code_reviewer/verifier opens a round; fix-pass
// implementer runs between reviews belong to the preceding round.
function buildFinalReview(runs, { status: missionStatus } = {}) {
  const rounds = [];
  let current = null;
  for (const run of runs) {
    const reviewer = REVIEW_ROLES.has(roleOf(run));
    if (current == null || reviewer) {
      current = { number: rounds.length + 1, runs: [], findings: [] };
      rounds.push(current);
    }
    current.runs.push(run);
    for (const f of run.findings || []) current.findings.push({ run: run.id ?? run.dirName ?? null, text: String(f) });
  }
  const terminal = terminalStageStatus(missionStatus);
  let status;
  if (!runs.length) status = "not_started";
  else if (runs.some(isRunning) && !terminal) status = "in_progress";
  else {
    const reviewers = runs.filter((r) => REVIEW_ROLES.has(roleOf(r)));
    const passed = reviewers.length && isDecision(reviewers[reviewers.length - 1], "PASS");
    if (passed) status = "passed";
    else if (terminal) status = terminal;
    else status = "in_progress";
  }
  const fixRoundsUsed = rounds.filter((r) => (r.runs || []).some((x) => IMPLEMENTATION_ROLES.has(roleOf(x)))).length;
  return { status, rounds, runs, findings: aggregateFindings(runs), fixRoundsUsed };
}

// A run is the FINAL REVIEW (never a phase review) when it is a pipeline role,
// carries no phase taskRef (phase reviews/verifies always carry a range), and
// does not map to a known phase number. The final review's fix-pass implementer
// runs (no mapped phase, no taskRef) belong to it too.
function isFinalReviewRun(run, phaseCount) {
  const role = roleOf(run);
  if (!REVIEW_ROLES.has(role) && !IMPLEMENTATION_ROLES.has(role)) return false;
  if (runRef(run) != null) return false;
  const p = phaseNumberOf(run);
  if (phaseCount > 0 && p != null && p >= 1 && p <= phaseCount) return false;
  return true;
}

function classifyStage(state, planning, phases, finalReview) {
  const statePhase = typeof state?.phase === "string" ? state.phase : "";
  // The recorded state wins when it names a stage: a report rendered after a
  // final review run finished must still read IMPLEMENTATION while the mission
  // is still implementing.
  if (statePhase === "final_review") return "FINAL REVIEW";
  if (statePhase === "planning" || /planning/.test(String(state?.step || ""))) return "PLANNING";
  if (statePhase === "implementing" || statePhase === "verifying" || statePhase === "tasks_ready") return "IMPLEMENTATION";
  if (finalReview.runs.length > 0 && (finalReview.status === "in_progress" || finalReview.status === "passed")) return "FINAL REVIEW";
  const anyImpl = phases.some((p) => p.runs.length > 0);
  if (!anyImpl && planning.runs.length > 0) return "PLANNING";
  return "IMPLEMENTATION";
}

// ── Mission 094 task 1.2 — enrichment helpers ───────────────────────────────
// Everything below is PURE: it only reads the already-parsed `events`/`runs`/
// `state` handed to `buildReportModel` and never touches disk or the clock.

// One fixed date format everywhere (watcher.md rule 1): "YYYY-MM-DD HH:MM:SS".
// An offset-bearing timestamp is reformatted from its OWN digits (the clock the
// source printed). A Z-suffixed (UTC) timestamp is converted to LOCAL time.
// A naive ISO string (no timezone) is treated as UTC and converted to local.
// Unparseable input passes through unchanged.
export function formatStamp(value) {
  if (value == null || value === "") return "-";
  const raw = String(value).trim();
  const off = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/);
  if (off) {
    const tz = off[7];
    if (tz === "Z") {
      // UTC timestamp: convert to local time
      const date = new Date(raw);
      if (Number.isNaN(date.getTime())) return String(value);
      const p = (n) => String(n).padStart(2, "0");
      return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
    }
    // Offset-bearing timestamp (e.g., +03:00): keep source clock
    return `${off[1]}-${off[2]}-${off[3]} ${off[4]}:${off[5]}:${off[6]}`;
  }
  // Naive ISO (no timezone): treat as UTC, convert to local
  const date = new Date(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(raw) ? raw + "Z" : raw);
  if (Number.isNaN(date.getTime())) return String(value);
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

// Shorten a raw model id to the watcher.md MODEL cell vocabulary: drop a
// provider prefix and date/latest suffixes, drop the `claude-`/`anthropic-`
// vendor prefixes, and render a numeric version pair as `major.minor`
// (`claude-opus-4-5` -> `opus-4.5`). Empty input is never fabricated.
export function shortenModel(name) {
  if (name == null || name === "") return "-";
  let s = String(name).trim();
  const slash = s.lastIndexOf("/");
  if (slash >= 0) s = s.slice(slash + 1);
  s = s.replace(/@.*$/, "").replace(/-\d{8}$/, "").replace(/-latest$/, "");
  s = s.replace(/^(?:claude|anthropic)-/, "");
  s = s.replace(/-(\d+)-(\d+)$/, "-$1.$2");
  return s || "-";
}

// The MODEL cell for a run: the shortened resolved model once the stream has
// reported one, falling back to the configured/active model until then. A
// resolved model that differs from the configured one is flagged
// `configured→resolved !` (watch report brief; watcher.md MODEL column).
export function modelDisplay(run) {
  if (!run || typeof run !== "object") return "-";
  const resolved = run.resolvedModel;
  const configured = run.configuredModel ?? run.model ?? null;
  if (resolved != null && resolved !== "") {
    const short = shortenModel(resolved);
    if (run.modelMismatch === true && configured != null && configured !== "") {
      return `${shortenModel(configured)}→${short} !`;
    }
    return short;
  }
  if (configured != null && configured !== "") return shortenModel(configured);
  return "-";
}

// Provider-trouble detection (watcher.md rule 11): the ⚠ NOTE suffix and the
// WARN live-progress line. Returns the matched label or null; model prose alone
// never matches.
export function providerTroubleLabel(text) {
  const s = String(text ?? "");
  if (/ProviderHeaderTimeout/.test(s)) return "ProviderHeaderTimeout";
  if (/Rate limit exceeded/i.test(s) || /rate_limit_exceeded/.test(s)) return "Rate limit exceeded";
  const silent = s.match(/silent\s+(\d+)\s*m[,\s]+no child process/i);
  if (silent) return `silent ${silent[1]}m, no child process`;
  return null;
}

// Parse `git diff --stat` text (watcher.md rule 13) into per-file rows plus the
// summary totals. For each `path | N ++--` line the bar's `+`/`-` glyphs are
// counted; when git scaled the bar the split is proportionally redistributed
// over N. A summary-only or empty stat yields no files.
export function parseDiffStat(stat) {
  const result = { files: [], fileCount: 0, insertions: 0, deletions: 0, text: null };
  if (typeof stat !== "string" || !stat.trim()) return result;
  for (const line of stat.split(/\r?\n/)) {
    const summary = line.match(/(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/);
    if (summary) {
      result.fileCount = Number(summary[1]);
      result.insertions = Number(summary[2] ?? 0);
      result.deletions = Number(summary[3] ?? 0);
      continue;
    }
    const addedNew = line.match(/^\s*(.+?)\s+\+(\d+)\s+new\s*$/);
    if (addedNew) {
      const filePath = addedNew[1].trim();
      const added = Number(addedNew[2]);
      result.files.push({ path: filePath, changes: added, added, removed: 0, isNew: true });
      continue;
    }
    const m = line.match(/^\s*(.+?)\s*\|\s*(\d+)\s*([+\-]*)\s*$/);
    if (!m) continue;
    const filePath = m[1].trim();
    const changes = Number(m[2]);
    const bar = m[3] || "";
    let added = (bar.match(/\+/g) || []).length;
    let removed = (bar.match(/-/g) || []).length;
    if (added + removed === 0) { added = changes; removed = 0; }
    else if (added + removed !== changes) {
      added = Math.round((changes * added) / (added + removed));
      removed = changes - added;
    }
    result.files.push({ path: filePath, changes, added, removed, isNew: false });
  }
  if (!result.fileCount) result.fileCount = result.files.length;
  if (result.files.length) {
    const parts = result.files.map((f) => (f.isNew ? `${f.path} +${f.added} new` : `${f.path} +${f.added}/−${f.removed}`));
    result.text = `changed files → ${parts.join(" · ")} (${result.fileCount} file${result.fileCount === 1 ? "" : "s"})`;
  }
  return result;
}

// Full status/stop-line classification (task 1.2). The base status drives the
// header; `stopLine` is the single stop/resume line. A cancel record belonging
// to a different mission is never carried (watcher.md rule 8).
function statusStopLine(info) {
  switch (info.status) {
    case "COMPLETED": return "COMPLETED";
    case "CANCELLED": return `CANCELLED${info.at ? ` at ${formatStamp(info.at)}` : ""}${info.reason ? ` — reason: ${info.reason}` : ""}`;
    case "ESCALATED": return `ESCALATED${info.at ? ` at ${formatStamp(info.at)}` : ""}${info.failureClass ? ` — ${info.failureClass}` : ""}${info.cause ? ` (${info.cause})` : ""} — human intervention required`;
    case "STOPPED": return info.orchestratorNotRunning
      ? `STOPPED · orchestrator not running (resumable)`
      : `STOPPED${info.at ? ` at ${formatStamp(info.at)}` : ""}`;
    default: return null;
  }
}

export function classifyStatus(state, { operatorEvents = [], runs = [], ownerAlive } = {}) {
  const phase = String(state?.phase || "");
  const mission = state?.mission ?? null;
  const info = { status: "RUNNING", at: null, reason: null, failureClass: null, cause: null, humanRequired: false, stopLine: null, orchestratorNotRunning: false };
  if (phase === "complete") {
    info.status = "COMPLETED";
  } else if (phase === "cancelled") {
    info.status = "CANCELLED";
    const c = state?.lastCancelled;
    if (c && (c.mission == null || mission == null || c.mission === mission)) {
      info.at = c.at ?? null;
      info.reason = c.reason ?? null;
    }
  } else if (phase === "escalated") {
    info.status = "ESCALATED";
    info.humanRequired = true;
    const failure = state?.lastFailure;
    info.failureClass = (typeof state?.step === "string" && state.step) ? state.step : (failure?.class ?? null);
    info.cause = failure?.code ?? failure?.message ?? state?.phaseCheckpointError?.code ?? null;
    info.at = state?.lastContinuation?.at ?? null;
  } else if (phase === "idle") {
    info.status = "STOPPED";
  } else {
    // Owner liveness takes precedence when known.
    let oa = ownerAlive;
    if (oa === undefined) {
      const withFlag = (Array.isArray(runs) ? runs : []).find((r) => typeof r?.ownerAlive === "boolean");
      if (withFlag) oa = withFlag.ownerAlive === true;
    }
    if (oa === true) {
      info.status = "RUNNING";
    } else if (oa === false) {
      info.status = "STOPPED";
      info.orchestratorNotRunning = true;
      info.at = null;
    } else {
      const last = operatorEvents[operatorEvents.length - 1];
      if (last && last.reason === "stop") {
        const stopTime = Date.parse(last.at ?? "");
        const resumed = Array.isArray(runs) && runs.some((r) => {
          const started = Date.parse(r?.started_at ?? r?.startedAt ?? "");
          return Number.isFinite(started) && Number.isFinite(stopTime) && started > stopTime;
        });
        if (!resumed) { info.status = "STOPPED"; info.at = last.at ?? null; }
      }
    }
  }
  info.stopLine = statusStopLine(info);
  return info;
}

// Human `Events:` lines from `operator` events (watcher.md rule 12).
const OPERATOR_RESET_LABELS = {
  global: "operator reset global",
  "plan-revision": "operator reset plan revision counter",
  "extra-sessions": "operator reset extra sessions",
  "continuation": "operator reset extra sessions",
  retries: "operator reset retries",
  "failure-budget": "operator reset retries",
};

export function buildOperatorEvents(events) {
  const list = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || e.type !== "operator") continue;
    const at = e.at ?? null;
    const reason = String(e.reason || "");
    let text;
    if (reason === "stop") text = `STOPPED${at ? ` ${formatStamp(at)}` : ""} (ap stop)`;
    else if (reason === "resume") text = `RESUMED${at ? ` ${formatStamp(at)}` : ""} (ap run)`;
    else if (reason === "reset") {
      let label = OPERATOR_RESET_LABELS[e.scope] || `operator reset ${e.scope || "global"}`;
      if ((e.scope === "extra-sessions" || e.scope === "continuation") && e.contScope) label += ` (${e.contScope})`;
      if ((e.scope === "retries" || e.scope === "failure-budget") && e.key) label += ` (${e.key})`;
      text = label;
    } else if (reason === "rebase") text = `operator rebase phase checkpoint${e.note ? ` — ${e.note}` : ""}`;
    else if (reason === "escalation") text = `ESCALATED${at ? ` ${formatStamp(at)}` : ""} — operator escalation`;
    else text = `operator ${reason || "event"}${e.scope ? ` ${e.scope}` : ""}`;
    list.push({ at, reason, scope: e.scope ?? null, key: e.key ?? null, live: e.live === true, note: e.note ?? null, text });
  }
  return list;
}

// Failure budgets the operator reset during this mission: a targeted
// `failure-budget`/`retries` reset names the budget key; a global reset clears every
// counter. Used only to explain a used/limit figure that now exceeds its limit
// (`4 (limit 3, reset by operator)`), never to invent one.
function operatorResetDomains(events) {
  const domains = new Set();
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || e.type !== "operator" || e.reason !== "reset") continue;
    if (e.scope === "global") {
      for (const [domain] of BUDGET_DOMAINS) domains.add(domain);
      continue;
    }
    if (e.scope !== "failure-budget" && e.scope !== "retries") continue;
    const key = String(e.key ?? "");
    for (const [domain, name] of BUDGET_DOMAINS) {
      if (key === name || key.startsWith(`${name}:`)) domains.add(domain);
    }
  }
  return domains;
}

// Gate rows from gate_start/gate_progress/gate_result (watcher.md rule 10).
// Each gate_start opens an entry; the following gate_progress/result events
// fill it in. `startIndex`/`resultIndex` retain event order for callers that
// need it; attempt placement uses the gate's START time.
export function buildGateEntries(events) {
  const list = [];
  let open = null;
  const list0 = Array.isArray(events) ? events : [];
  for (let i = 0; i < list0.length; i++) {
    const e = list0[i];
    if (!e) continue;
    if (e.type === "gate_start") {
      open = {
        kind: "gate", phase: e.phase ?? null, status: "running", ok: null, command: e.command ?? null,
        durationMs: null, reused: e.reused === true, at: e.at ?? null, resultAt: null, pid: e.pid ?? null,
        progress: { total: null, passed: null, failed: null }, startIndex: i, resultIndex: null, attempt: null,
      };
      list.push(open);
    } else if (e.type === "gate_progress" && open) {
      if (e.command != null) open.command = e.command;
      if (e.durationMs != null) open.durationMs = e.durationMs;
      if (e.ok != null) open.ok = e.ok;
      const p = e.progress && typeof e.progress === "object" ? e.progress : {};
      open.progress = {
        total: e.total ?? p.total ?? open.progress.total,
        passed: e.passed ?? p.passed ?? open.progress.passed,
        failed: e.failed ?? p.failed ?? open.progress.failed,
      };
    } else if (e.type === "gate_result" && open) {
      open.status = "completed";
      open.ok = e.ok === true;
      if (e.durationMs != null) open.durationMs = e.durationMs;
      open.resultAt = e.at ?? null;
      open.resultIndex = i;
      const p = e.progress && typeof e.progress === "object" ? e.progress : {};
      open.progress = {
        total: e.total ?? p.total ?? open.progress.total,
        passed: e.passed ?? p.passed ?? open.progress.passed,
        failed: e.failed ?? p.failed ?? open.progress.failed,
      };
      open = null;
    }
  }
  return list;
}

export function gateStatusText(gate) {
  if (!gate) return "-";
  if (gate.status === "running") return "RUNNING";
  if (gate.status === "completed") return gate.ok === false ? "FAIL" : "PASS";
  return "-";
}

const WATCH_EVENT_PROGRESS_KINDS = { prep: "PREP", prep_start: "PREP", start: "START", warn: "WARN" };

function fieldMapOf(text) {
  const map = {};
  for (const part of String(text ?? "").split("|")) {
    const i = part.indexOf("=");
    if (i > 0) map[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return map;
}

// Decode one `progress.log` ACTIVITY JSON snippet: a tool call becomes its
// `<tool> <first arg line>`, a genuine provider error becomes WARN, and every
// streaming-noise part (step_start/text/reasoning/…) is dropped (rule 6).
function decodeActivityJson(raw) {
  // opencode stderr `message=loop … step=N`: a heartbeat that proves the run is
  // alive even when every sampled chunk is streaming noise (backlog #6b).
  const loop = String(raw ?? "").match(/message="?loop"?\b[\s\S]*?\bstep=(\d+)/);
  if (loop) return { kind: "STEP", text: `step ${loop[1]}` };
  const trouble = providerTroubleLabel(raw);
  let obj = null;
  try { obj = JSON.parse(raw); } catch { return trouble ? { kind: "WARN", text: `⚠ ${trouble}` } : null; }
  const part = obj && typeof obj === "object" ? obj.part : null;
  if (trouble && (!part || part.type !== "tool")) return { kind: "WARN", text: `⚠ ${trouble}` };
  if (!part || typeof part !== "object") return null;
  if (part.type === "tool" && part.tool) {
    const input = part.state?.input || {};
    const detail = input.command || input.filePath || input.description || "";
    return { kind: String(part.tool).toLowerCase(), text: detail ? String(detail).split("\n")[0] : String(part.tool) };
  }
  return null;
}

function decodeProgressEntry(raw) {
  if (raw && typeof raw === "object") {
    if (typeof raw.kind === "string" && typeof raw.text === "string") return { at: raw.at ?? null, kind: raw.kind.toUpperCase(), text: raw.text };
    if (typeof raw.line === "string") raw = raw.line;
    else return null;
  }
  if (typeof raw !== "string") return null;
  const line = raw.trim();
  if (!line) return null;
  const ts = line.match(/^(\S+)\s\s?(.*)$/);
  const at = ts ? ts[1] : null;
  const rest = ts ? ts[2] : line;
  if (/^START \|/.test(rest)) {
    const f = fieldMapOf(rest.slice(rest.indexOf("|") + 1));
    return { at, kind: "START", text: `role=${f.ROLE ?? "-"} · phase=${f.PHASE ?? "-"} · TASK=${f.TASK ?? "-"} · attempt=${f.ATTEMPT ?? "-"} · pid=${f.PID ?? "-"}` };
  }
  if (/^FINISHED \|/.test(rest)) return { at, kind: "FINISHED", text: "run finished" };
  if (/^ACTIVITY \|/.test(rest)) {
    const m = rest.match(/LAST=([\s\S]*)$/);
    if (!m) return null;
    const decoded = decodeActivityJson(m[1]);
    return decoded ? { at, kind: decoded.kind, text: decoded.text } : null;
  }
  // A relay-written per-action line (backlog #6a): `ACTION | TOOL=<tool> |
  // <command or file>`. The detail is written last so a command containing `|`
  // survives; it is already single-line-sanitized by the relay.
  if (/^ACTION \|/.test(rest)) {
    const m = rest.match(/^ACTION \| TOOL=(\S+)(?:\s*\|\s*([\s\S]*))?$/);
    if (!m) return null;
    const kind = m[1].toLowerCase();
    const text = String(m[2] ?? "").split("\n")[0].trim();
    return { at, kind, text: text || m[1] };
  }
  const prep = rest.match(/^PREP\b\s*(.*)$/);
  if (prep) return { at, kind: "PREP", text: prep[1] || "pre-run snapshot started" };
  const warn = rest.match(/^WARN\b\s*(.*)$/);
  if (warn) return { at, kind: "WARN", text: warn[1] || "provider trouble" };
  return null;
}

// The LIVE PROGRESS feed (watcher.md rule 6): decoded `progress.log` lines plus
// the per-mission watch-events (PREP/START/WARN, gate lines). Noise and raw
// JSON never survive; the newest `limit` (default 10) entries are returned.
export function decodeLiveProgress({ events = [], progress = [], gateCommand = null, limit = 10 } = {}) {
  const out = [];
  for (const raw of Array.isArray(progress) ? progress : []) {
    const entry = decodeProgressEntry(raw);
    if (entry) out.push(entry);
  }
  for (const e of Array.isArray(events) ? events : []) {
    if (!e) continue;
    if (WATCH_EVENT_PROGRESS_KINDS[e.type]) {
      const kind = WATCH_EVENT_PROGRESS_KINDS[e.type];
      const text = e.text || e.summary || e.message
        || (kind === "PREP"
          ? `role=${e.role ?? "-"} · phase=${e.phase ?? "-"} · TASK=${e.taskRef ?? "-"} · attempt=${e.attempt ?? "-"} · pre-run snapshot started`
          : kind === "START"
            ? `role=${e.role ?? "-"} · phase=${e.phase ?? "-"} · TASK=${e.taskRef ?? "-"} · attempt=${e.attempt ?? "-"} · pid=${e.pid ?? "-"}`
            : "provider trouble");
      out.push({ at: e.at ?? null, kind, text });
    } else if (e.type === "gate_start") {
      const cmd = e.command || gateCommand;
      const scripts = e.scripts ?? e.scriptCount ?? null;
      const runs = e.runs ?? e.runCount ?? e.total ?? null;
      const scope = scripts != null && runs != null ? ` · ${scripts} scripts in ${runs} runs` : "";
      out.push({ at: e.at ?? null, kind: "GATE", text: `orchestrator started the full test suite${cmd ? ` · ${cmd}` : ""}${scope}` });
    } else if (e.type === "gate_progress") {
      const p = e.progress && typeof e.progress === "object" ? e.progress : {};
      const total = e.total ?? p.total;
      const passed = e.passed ?? p.passed;
      const failed = e.failed ?? p.failed ?? 0;
      const body = total != null && passed != null ? `${passed}/${total} runs · ${failed} failed` : (e.command || gateCommand || "progress");
      out.push({ at: e.at ?? null, kind: "GATE", text: `full test suite ${body}` });
    } else if (e.type === "gate_result") {
      out.push({ at: e.at ?? null, kind: "GATE", text: e.ok === false ? "full test suite failed" : "full test suite passed" });
    }
  }
  out.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  return out.slice(-limit);
}

// Parse the live progress of the gate from the tail of its test log (backlog
// #35h). A gate can run the whole suite as one command, so `gate_progress`
// events never arrive mid-run; the log prints one line per test file with the
// running position (`PASS … file.mjs [73/365]`, `TEST FAILED: … [n/total]`).
// The LAST bracket wins (some PASS lines carry two), and failures are the
// distinct `TEST FAILED` files still visible in the tail. Returns null when no
// progress line is present so the event-based figure can stay in charge.
export function parseGateLogProgress(text) {
  let position = null;
  let total = null;
  const failed = new Set();
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const brackets = [...line.matchAll(/\[(\d+)\/(\d+)\]/g)];
    if (brackets.length) {
      const last = brackets[brackets.length - 1];
      position = Number(last[1]);
      total = Number(last[2]);
    }
    const fail = line.match(/^TEST FAILED:?\s*(.+?)(?:\s+\[.*\]|\s*$)/);
    if (fail) failed.add(fail[1].trim());
  }
  if (!Number.isFinite(position) || !Number.isFinite(total) || total <= 0) return null;
  const failedCount = failed.size;
  const passed = Math.max(0, Math.min(position, total) - failedCount);
  return { position, total, passed, failed: failedCount };
}

// The single live CURRENT RUN (watcher.md): the open orchestrator gate wins
// while it runs, else the newest run recorded `running`. Nothing is current
// once the mission is finished/cancelled/escalated or stopped.
export function detectCurrent({ runs = [], gates = [], status = "RUNNING", gateLog = null } = {}) {
  if (status !== "RUNNING") return null;
  const openGate = [...gates].reverse().find((g) => g.status === "running");
  if (openGate) {
    const logProgress = parseGateLogProgress(gateLog);
    return {
      kind: "gate",
      phase: openGate.phase,
      command: openGate.command,
      status: "running",
      startedAt: openGate.at,
      pid: openGate.pid ?? null,
      progress: logProgress ? { ...logProgress, unit: "files" } : { ...openGate.progress },
    };
  }
  const running = runs.filter((r) => String(r?.status || "") === "running");
  if (!running.length) return null;
  running.sort((a, b) => (new Date(b.started_at).getTime() || 0) - (new Date(a.started_at).getTime() || 0));
  const r = running[0];
  return {
    kind: "run",
    id: r.id ?? r.dirName ?? null,
    dirName: r.dirName ?? null,
    role: roleOf(r) || null,
    taskRef: runRef(r),
    phase: phaseNumberOf(r),
    attempt: attemptNumberOf(r),
    status: "running",
    model: r.displayModel ?? modelDisplay(r),
    sessionNumber: r.sessionNumber ?? null,
    session: r.sessionLabel ?? null,
    pid: r.pid ?? null,
    startedAt: r.started_at ?? null,
    updatedAt: r.updated_at ?? r.updatedAt ?? null,
    snapshotBeforeAt: r.snapshotBeforeAt ?? null,
    snapshotAfterAt: r.snapshotAfterAt ?? null,
    usage: r.usage ?? null,
    note: r.note ?? null,
  };
}

// ── Mission 094 task 1.3 — budget/state facts the PIPELINE STATE needs ──────

// The four failure budgets of the pipeline, in the fixed order the report
// prints them, mapped to the `state.failureBudgets` key prefix and the
// `policy.failure_budgets` limit key (scripts/failure-contract.mjs).
// v4 layout maps: retries.implementation -> implementationFailureBudget,
// retries.verification -> verificationFailureBudget, retries.cli_errors -> adapterRetryBudget,
// retries.infrastructure -> infrastructureRetryBudget.
const BUDGET_DOMAINS = [
  ["implementation", "implementationFailureBudget", "implementation"],
  ["verification", "verificationFailureBudget", "verification"],
  ["adapter", "adapterRetryBudget", "cli_errors"],
  ["infrastructure", "infrastructureRetryBudget", "infrastructure"],
];
const DEFAULT_BUDGET_LIMITS = {
  implementationFailureBudget: 4,
  verificationFailureBudget: 4,
  adapterRetryBudget: 3,
  infrastructureRetryBudget: 3,
};

// The role whose adapter budget is live right now, from the recorded step and
// phase (the adapter is bound per role; `state.step` names the stage).
function currentRoleOf(state) {
  const step = String(state?.step || "").toLowerCase();
  const phase = String(state?.phase || "").toLowerCase();
  if (/plan_review|planreview/.test(step) || (phase === "planning" && /review/.test(step))) return "plan_reviewer";
  if (phase === "planning" || /planning/.test(step)) return "planner";
  if (/review/.test(step) || phase === "final_review") return "code_reviewer";
  if (/verif|gate/.test(step) || phase === "verifying") return "verifier";
  if (/implement|fix|task/.test(step) || /implement/.test(phase)) return "implementer";
  return null;
}

// Split a domain's spent counters into `{scope, used}` entries; a bare
// `<budgetName>` key is the mission-wide scope ("").
function budgetScopes(spent, budgetKey) {
  const out = [];
  for (const [key, value] of Object.entries(spent)) {
    if (key !== budgetKey && !key.startsWith(`${budgetKey}:`)) continue;
    out.push({ scope: key === budgetKey ? "" : key.slice(budgetKey.length + 1), used: Number(value) || 0 });
  }
  return out;
}

function sumUsed(scopes) {
  return scopes.reduce((sum, s) => sum + s.used, 0);
}

// Sum `state.failureBudgets` entries (`<budgetName>:<scope>`) per domain and
// pair each with its `policy.failure_budgets` limit (legacy) or `layout.retries.*` (v4).
// Backlog #38: `used` is the CURRENT scope's spend (current phase for the task
// budgets, current role's adapter for the adapter budget), and `earlier` is
// everything the same domain spent in other scopes. Pure; a missing/malformed
// state or policy degrades to 0/limit-default rather than throwing.
export function buildBudgetEntries(state, policy, layout = null) {
  const spent = state && typeof state.failureBudgets === "object" && state.failureBudgets
    ? state.failureBudgets
    : {};
  const configuredLegacy = policy?.failure_budgets && typeof policy.failure_budgets === "object"
    ? policy.failure_budgets
    : {};
  const configuredLayout = layout?.retries && typeof layout.retries === "object"
    ? layout.retries
    : {};
  const phaseIndex = Number.isFinite(Number(state?.phaseIndex)) ? Number(state.phaseIndex) : null;
  const currentRole = currentRoleOf(state);
  return BUDGET_DOMAINS.map(([domain, legacyKey, layoutKey]) => {
    const scopes = budgetScopes(spent, legacyKey);
    const total = sumUsed(scopes);
    let used = total;
    let earlier = 0;
    if (domain === "implementation" || domain === "verification") {
      const phaseScopes = phaseIndex == null
        ? []
        : scopes.filter((s) => new RegExp(`(^|:)phase-${phaseIndex}(:|$)`).test(s.scope));
      let current = null;
      if (phaseScopes.length) current = phaseScopes;
      else if (scopes.length === 1) current = scopes;
      else if (phaseIndex == null) current = scopes.filter((s) => s.scope === "");
      if (current) {
        used = sumUsed(current);
        earlier = total - used;
      } else {
        used = 0;
        earlier = total;
      }
    } else if (domain === "adapter") {
      const roleScopes = currentRole
        ? scopes.filter((s) => s.scope.endsWith(`:${currentRole}`))
        : [];
      const pool = roleScopes.length ? roleScopes : scopes;
      if (pool.length) {
        // Several live adapter scopes: show the worst (most spent), never
        // their sum against one role's limit.
        used = pool.reduce((worst, s) => {
          if (!worst) return s;
          if (s.used !== worst.used) return s.used > worst.used ? s : worst;
          return s;
        }, null).used;
      } else {
        used = 0;
      }
      earlier = 0;
    }
    let limit = configuredLayout[layoutKey];
    if (limit === undefined || limit === null) {
      const raw = Number(configuredLegacy[legacyKey]);
      limit = Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_BUDGET_LIMITS[legacyKey];
    }
    return { domain, used, limit, earlier };
  });
}

// The mission's wall-clock start (for the `Total: … elapsed …` figure): the
// recorded planning start, else a generic start field, else the earliest run.
function missionStartedAt(state, runs) {
  const candidate = state?.planningStartedAt
    ?? state?.missionStartedAt
    ?? state?.startedAt
    ?? state?.started_at
    ?? null;
  if (candidate) return candidate;
  let earliest = null;
  for (const run of Array.isArray(runs) ? runs : []) {
    const at = run?.started_at ?? run?.startedAt ?? null;
    if (!at) continue;
    if (earliest == null || (Date.parse(at) || Infinity) < (Date.parse(earliest) || Infinity)) earliest = at;
  }
  return earliest;
}

export function buildReportModel({ state = null, runs = [], events = [], phases = [], policy = {}, layout = null, progress = [], gateLog = null, now = null, skill = null, missionFallback = null, ownerAlive } = {}) {
  const eventList = Array.isArray(events) ? events : [];
  const progressList = Array.isArray(progress) ? progress : [];
  const phaseDefs = normalizePhases(phases);

  // Enrich every run once: disk extras, display model, provider trouble and
  // the "session k of N" scope label.
  const allowance = Number.isFinite(Number(policy?.continuation_allowance)) && Number(policy.continuation_allowance) > 0
    ? Number(policy.continuation_allowance)
    : null;
  const enrichedRuns = (Array.isArray(runs) ? runs : []).map((raw) => {
    const run = enrichRun(raw);
    run.displayModel = modelDisplay(run);
    run.providerTrouble = providerTroubleLabel(run.note);
    const k = Number(run.sessionNumber);
    run.sessionLabel = Number.isInteger(k) && k > 0 ? (allowance ? `session ${k} of ${allowance + 1}` : `session ${k}`) : null;
    return run;
  });

  const escalationKey = (run) => `${roleOf(run)}|${run?.taskRef ?? ""}|${phaseNumberOf(run) ?? ""}|${run?.sessionNumber ?? ""}`;
  const escalated = new Set();
  const chronological = [...enrichedRuns].sort((a, b) => (Date.parse(a?.started_at ?? a?.startedAt) || 0) - (Date.parse(b?.started_at ?? b?.startedAt) || 0));
  for (const run of chronological) {
    const key = escalationKey(run);
    const cappedEscalation = String(run?.status || "") === "capped"
      && (Boolean(run?.policyViolation) || run?.escalated === true || /GIT_MUTATION_BLOCKED|^POLICY/i.test(String(run?.failureClass || "")));
    if (cappedEscalation) escalated.add(key);
    else if (escalated.has(key)) run.retryAfterEscalation = true;
  }

  const planningRuns = [];
  const implementationRuns = [];
  const finalReviewRuns = [];
  const unclassified = [];
  for (const run of enrichedRuns) {
    const role = roleOf(run);
    if (PLANNING_ROLES.has(role)) planningRuns.push(run);
    else if (isFinalReviewRun(run, phaseDefs.length)) finalReviewRuns.push(run);
    else if (IMPLEMENTATION_ROLES.has(role) || REVIEW_ROLES.has(role)) implementationRuns.push(run);
    else unclassified.push(run);
  }

  let resolvedOwnerAlive = ownerAlive;
  if (resolvedOwnerAlive === undefined) {
    const withFlag = (Array.isArray(enrichedRuns) ? enrichedRuns : []).find((r) => typeof r?.ownerAlive === "boolean");
    if (withFlag) resolvedOwnerAlive = withFlag.ownerAlive === true;
  }
  const operatorEvents = buildOperatorEvents(eventList);
  const statusInfo = classifyStatus(state, { operatorEvents, runs: enrichedRuns, ownerAlive: resolvedOwnerAlive });
  const gates = buildGateEntries(eventList);
  const gateCommand = gates.map((g) => g.command).filter(Boolean).pop() ?? null;
  const operatorResetBudgetDomains = operatorResetDomains(eventList);

  // Parsed diff_stat rows (watcher.md rule 13), each keeping its source index
  // and recorded attempt.
  const changedFiles = [];
  eventList.forEach((e, index) => {
    if (!e || e.type !== "diff_stat") return;
    const parsed = parseDiffStat(e.stat);
    changedFiles.push({
      ...parsed,
      index,
      phase: e.phase ?? null,
      attempt: Number.isFinite(Number(e.attempt)) ? Number(e.attempt) : null,
      taskRef: e.taskRef ?? null,
      at: e.at ?? null,
    });
  });

  const phaseIndex = Number.isFinite(Number(state?.phaseIndex)) ? Number(state.phaseIndex) : null;

  // Every phase gets a definition + its runs (runs whose phase number matches).
  const phaseNumbersWithRuns = new Set(implementationRuns.map(phaseNumberOf).filter((n) => n != null));
  const defs = [...phaseDefs];
  const known = new Set(defs.map((d) => d.number));
  for (const n of [...phaseNumbersWithRuns].sort((a, b) => a - b)) {
    if (!known.has(n)) {
      known.add(n);
      defs.push({ number: n, name: `Phase ${n}`, tasks: [], done: false });
    }
  }
  defs.sort((a, b) => a.number - b.number);

  const phasesOut = defs.map((def) => {
    const phaseRuns = implementationRuns.filter((r) => phaseNumberOf(r) === def.number);
    const attempts = buildAttempts(phaseRuns);
    return {
      number: def.number,
      name: def.name,
      tasks: def.tasks,
      done: def.done,
      status: phaseStatus(def, phaseRuns, { state, phaseIndex, status: statusInfo.status }),
      attempts,
      runs: phaseRuns,
    };
  });

  // Place each gate in the attempt whose time window contains its START. Runs
  // keep their recorded attempt and every row in an attempt is ordered by its
  // start time (renderer). Then hang the gate and changed-file rows off each
  // attempt.
  for (const phase of phasesOut) {
    const phaseGates = gates.filter((g) => g.phase === phase.number);
    const phaseChanged = changedFiles.filter((d) => d.phase === phase.number);
    for (const g of phaseGates) g.attempt = attemptForGateStart(g, phase.attempts);
    phase.gates = phaseGates;
    phase.changedFiles = phaseChanged;
    phase.changedFilesText = phaseChanged.length ? phaseChanged[phaseChanged.length - 1].text : null;
    for (const attempt of phase.attempts) {
      attempt.carriedForward = (attempt.carriedForward || []).map((t) => displayCarriedTask(t, phase));
      attempt.changedFiles = phaseChanged.filter((d) => (attempt.rawNumbers || [attempt.number]).includes(d.attempt));
      attempt.changedFilesText = attempt.changedFiles.length ? attempt.changedFiles[attempt.changedFiles.length - 1].text : null;
      attempt.gates = phaseGates.filter((g) => g.attempt === attempt.number);
    }
  }

  const planning = buildPlanningRuns(planningRuns, { status: statusInfo.status });
  const finalReview = buildFinalReview(finalReviewRuns, { status: statusInfo.status });

  const mission = typeof state?.mission === "string" && state.mission ? state.mission : null;
  const framework = state?.planningDetection?.framework ?? null;

  // For ended missions, compute the end time from statusInfo.at (cancel/stop/escalation)
  // or from the last run's end time for COMPLETED missions.
  let missionEndedAt = null;
  if (isMissionEnded(statusInfo.status)) {
    if (statusInfo.at) {
      missionEndedAt = statusInfo.at;
    } else if (statusInfo.status === "COMPLETED") {
      // For COMPLETED, use the latest run end time
      const runEnds = enrichedRuns
        .map((r) => runEndAt(r))
        .filter(Boolean)
        .map((stamp) => Date.parse(stamp))
        .filter(Number.isFinite);
      if (runEnds.length) {
        const latest = new Date(Math.max(...runEnds)).toISOString();
        missionEndedAt = latest;
      }
    }
  }

  // Display attempt: the budget-shaped attempt count of the current phase
  // (one attempt per denial plus the live one), never the recorded counter that
  // also advances on every stop/resume. An operator reset keeps its explicit
  // past-the-limit number (rule 17).
  const rawAttempt = Number(state?.attempt);
  const currentAttempts = phaseIndex != null ? phasesOut[phaseIndex]?.attempts?.length : null;
  const implementationLimitRaw = Number(policy?.failure_budgets?.implementationFailureBudget);
  const implementationLimit = Number.isInteger(implementationLimitRaw) && implementationLimitRaw >= 0 ? implementationLimitRaw + 1 : 4;
  const resetAttempt = operatorResetBudgetDomains.has("implementation") && Number.isFinite(rawAttempt) && rawAttempt > implementationLimit;
  // Always show the budget-shaped count of the current phase: the recorded
  // counter also advances on every stop/resume or crash restart, which is NOT
  // a new attempt. Fall back to the recorded number only when no phase runs
  // exist; an operator reset keeps its explicit past-the-limit number.
  const displayAttempt = resetAttempt
    ? rawAttempt
    : (Number.isInteger(currentAttempts) && currentAttempts > 0 ? currentAttempts : (Number.isFinite(rawAttempt) ? rawAttempt : null));

  return {
    mission,
    framework,
    status: statusInfo.status,
    statusInfo,
    stopLine: statusInfo.stopLine,
    stage: classifyStage(state, planning, phasesOut, finalReview),
    phaseIndex,
    phaseNumber: phaseIndex != null ? phaseIndex + 1 : null,
    phaseName: phaseIndex != null ? (phasesOut[phaseIndex]?.name ?? null) : null,
    attempt: displayAttempt,
    policy: policy && typeof policy === "object" ? policy : {},
    layout: layout && typeof layout === "object" ? layout : null,
    budgets: buildBudgetEntries(state, policy, layout),
    operatorResetBudgets: [...operatorResetBudgetDomains],
    now: now ?? null,
    missionStartedAt: missionStartedAt(state, enrichedRuns),
    missionEndedAt,
    missionFallback,
    skill: skill && typeof skill === "object" ? skill : null,
    continuationAllowance: allowance,
    gateCommand,
    gates,
    changedFiles,
    operatorEvents,
    eventsLine: operatorEvents.length ? operatorEvents.map((e) => e.text).join(" → ") : null,
    providerTrouble: enrichedRuns
      .filter((r) => r.providerTrouble)
      .map((r) => ({ run: r.id ?? r.dirName ?? null, label: r.providerTrouble })),
    liveProgress: decodeLiveProgress({ events: eventList, progress: progressList, gateCommand, limit: 10 }),
    current: detectCurrent({ runs: enrichedRuns, gates, status: statusInfo.status, gateLog }),
    planning,
    phases: phasesOut,
    finalReview,
    unclassified,
    runs: enrichedRuns,
    events: eventList,
  };
}

// ── Mission 094 task 1.3 — PIPELINE STATE + PLANNING STAGE rendering ────────
// Everything below is PURE: it reads only the already-built `model` and returns
// text. No disk, no clock, no mutation of the model. Task 1.4/1.5 append the
// IMPLEMENTATION/FINAL REVIEW/CURRENT RUN/LIVE PROGRESS renderers and extend
// `renderReport`; the pipeline + planning output here is final.

// Compact token figure used by PRICE/CONTEXT/Caps/Total (watcher.md example):
// 270300 -> "270.3K", 750000 -> "750K", 1564100 -> "1.56M". Non-finite -> "-".
export function formatTokens(value) {
  if (value == null || value === "") return "-";
  const v = Number(value);
  if (!Number.isFinite(v)) return "-";
  const trim = (s) => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);
  if (Math.abs(v) >= 1e6) return `${trim((v / 1e6).toFixed(2))}M`;
  if (Math.abs(v) >= 1000) return `${trim((v / 1000).toFixed(1))}K`;
  return String(Math.round(v));
}

// The compact token figure used by the run-row PRICE/CONTEXT cells. Unlike the
// header `formatTokens`, a whole-thousand value keeps one decimal (`24.0K`) to
// match the table chrome.
export function formatCellTokens(value) {
  if (value == null || value === "") return "-";
  const v = Number(value);
  if (!Number.isFinite(v)) return "-";
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}K`;
  return String(Math.round(v));
}

// `HH:MM:SS` from a millisecond count (mission elapsed / summed run duration).
export function formatClock(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v < 0) return "-";
  const total = Math.floor(v / 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(Math.floor(total / 3600))}:${p(Math.floor((total % 3600) / 60))}:${p(total % 60)}`;
}

function parseClock(text) {
  const m = String(text ?? "").match(/^(\d+):(\d{2}):(\d{2})$/);
  if (!m) return null;
  return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000;
}

// A run's measured working time in ms: the recorded `duration_ms` first, else
// parsed from the recorded `duration` ("HH:MM:SS"), else null (never fabricated).
export function runDurationMs(run) {
  if (run && run.duration_ms != null && Number.isFinite(Number(run.duration_ms))) return Number(run.duration_ms);
  if (run && typeof run.duration === "string") return parseClock(run.duration);
  return null;
}

// Add `ms` to a timestamp string while preserving its own UTC offset, so the
// rendered "end" keeps the clock the source wrote (never shifted to UTC).
function addMsToStamp(started, ms) {
  const m = String(started ?? "").match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/);
  if (!m) {
    const t = Date.parse(started);
    return Number.isFinite(t) ? new Date(t + ms).toISOString() : null;
  }
  const epoch = Date.parse(started);
  if (!Number.isFinite(epoch)) return null;
  const offset = m[7];
  let offMin = 0;
  if (offset !== "Z") {
    const sign = offset[0] === "-" ? -1 : 1;
    const digits = offset.slice(1).replace(":", "");
    offMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
  }
  const d = new Date(epoch + ms + offMin * 60000);
  const p = (n) => String(n).padStart(2, "0");
  const body = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  return `${body}${offset}`;
}

// The wall-clock a run ended (its STARTED + measured DURATION), preserving the
// run's own clock; `ended_at`/`updated_at` is used when no duration was recorded.
export function runEndAt(run) {
  if (!run) return null;
  const start = run.started_at ?? run.startedAt ?? null;
  const ms = runDurationMs(run);
  if (start && ms != null) {
    const computed = addMsToStamp(start, ms);
    if (computed) return computed;
  }
  return run.ended_at ?? run.updated_at ?? start ?? null;
}

function runPrice(run) {
  const value = run?.usage?.priceWeighted;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sumPrice(runs) {
  return (Array.isArray(runs) ? runs : []).reduce((sum, r) => sum + runPrice(r), 0);
}

function sumDurationMs(runs) {
  return (Array.isArray(runs) ? runs : []).reduce((sum, r) => sum + (runDurationMs(r) || 0), 0);
}

// FINAL REVIEW's wall-clock span: first run start to last run end (the reviews
// and their fix passes are one continuous stretch), falling back to the summed
// agent time when the timestamps are missing.
function stageSpanClock(runs) {
  const list = Array.isArray(runs) ? runs : [];
  const starts = list.map((r) => Date.parse(r?.started_at ?? r?.startedAt)).filter(Number.isFinite);
  const ends = list.map((r) => Date.parse(runEndAt(r))).filter(Number.isFinite);
  if (starts.length && ends.length) {
    const ms = Math.max(...ends) - Math.min(...starts);
    if (Number.isFinite(ms) && ms >= 0) return formatClock(ms);
  }
  return formatClock(sumDurationMs(list));
}

// PRICE cell: compact price-weighted tokens, `~`-prefixed while running.
export function priceCell(run) {
  const value = run?.usage?.priceWeighted;
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  const text = formatCellTokens(value);
  return run?.status === "running" ? `~${text}` : text;
}

// CONTEXT cell: peak single-turn context when recorded, else the raw
// cacheRead+input term; `~`-prefixed while running.
export function contextCell(run) {
  const usage = run?.usage;
  if (!usage || typeof usage !== "object") return "-";
  let value = null;
  for (const key of ["peakContext", "maxSingleTurnContext"]) {
    const n = Number(usage[key]);
    if (Number.isFinite(n) && n > 0) { value = n; break; }
  }
  if (value == null) {
    const cacheRead = Number(usage.cacheRead);
    const input = Number(usage.input);
    if (Number.isFinite(cacheRead) && Number.isFinite(input)) value = cacheRead + input;
  }
  if (value == null) return "-";
  const text = formatCellTokens(value);
  return run?.status === "running" ? `~${text}` : text;
}

export function turnsCell(run) {
  const value = run?.usage?.turns;
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return String(Math.trunc(value));
}

// The STATUS cell for a planning/implementation/final-review run row. A run
// that finished normally shows: the verdict (APPROVED/DENIED/INCOMPLETE) for
// plan_reviewer/code_reviewer/verifier, else COMPLETED. Any other run keeps its
// run status for every role - never a verdict on an unfinished run.
const VERDICT_ROLES = new Set(["plan_reviewer", "code_reviewer", "verifier"]);

// Split a displayed status label into its bare status word and an optional
// parenthesised reason: `interrupted (orchestrator not running)` ->
// `{status: "interrupted", reason: "orchestrator not running"}`. The STATUS
// cell keeps only the bare word (so a long reason never widens the column);
// the reason moves to the NOTE (backlog #29b).
export function splitStatusLabel(label) {
  const s = String(label ?? "");
  const m = s.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (m) {
    const status = m[1].trim();
    const reason = m[2].trim();
    return { status: status || null, reason: reason || null };
  }
  const bare = s.trim();
  return { status: bare || null, reason: null };
}

// The parenthesised reason a run's displayed status carries, lowercased
// (`orchestrator not running`), else null. Reads the reconciled `run.status`
// (renderWatchReport stores the long display label there).
export function statusReason(run) {
  const { reason } = splitStatusLabel(run?.status);
  return reason ? reason.toLowerCase() : null;
}

export function runStatusCell(run) {
  const { status: bare } = splitStatusLabel(run?.status);
  const status = String(bare ?? "");
  if (status === "running") return "RUNNING";
  if (status === "capped") {
    const cap = run?.cap;
    if (cap && Number.isFinite(Number(cap.used)) && Number.isFinite(Number(cap.limit))) {
      return `CAPPED (${Number(cap.used)}/${Number(cap.limit)})`;
    }
    return "CAPPED";
  }
  if (status === "completed") {
    const raw = String(run?.decision ?? "").toUpperCase();
    if (VERDICT_ROLES.has(roleOf(run)) && raw) {
      return raw === "PASS" ? "APPROVED" : raw === "FAIL" ? "DENIED" : raw;
    }
    return "COMPLETED";
  }
  return status === "interrupted" ? "INTERRUPTED"
    : status === "failed" ? "FAILED"
      : status ? status.toUpperCase() : "-";
}

// Backlog #31/#35b: snapshot durations share one format everywhere. Under one
// minute show seconds with one decimal (`0.9s`) so a sub-second snapshot never
// reads as `0:00`; from one minute up keep `m:ss`.
export function snapshotSpanText(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v < 0) return "-";
  if (v < 60000) return `${(v / 1000).toFixed(1)}s`;
  const total = Math.floor(v / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function snapshotCell(run) {
  if (run && typeof run.snapshot === "string" && run.snapshot) return run.snapshot;
  const beforeStart = run?.snapshotBeforeStartedAt ?? null;
  const beforeEnd = run?.snapshotBeforeAt ?? null;
  const afterStart = run?.snapshotAfterStartedAt ?? null;
  const afterEnd = run?.snapshotAfterAt ?? null;
  const fmt = (start, end) => {
    if (!start || !end) return "-";
    return snapshotSpanText(Date.parse(end) - Date.parse(start));
  };
  if (!beforeStart && !beforeEnd && !afterStart && !afterEnd) return "-";
  return `${fmt(beforeStart, beforeEnd)}/${fmt(afterStart, afterEnd)}`;
}

// A running row's DURATION is measured live against the report clock (the same
// `now` CURRENT RUN uses); a finished row keeps its recorded duration.
function durationCell(run, now = null) {
  if (isRunning(run) && now) {
    const ms = Date.parse(now) - Date.parse(run?.started_at ?? run?.startedAt);
    if (Number.isFinite(ms) && ms >= 0) return formatClock(ms);
  }
  if (run && run.duration) return String(run.duration);
  const ms = runDurationMs(run);
  return ms != null ? formatClock(ms) : "-";
}

function startedCell(run) {
  const at = run?.started_at ?? run?.startedAt ?? null;
  return at ? formatStamp(at) : "-";
}

// The NOTE cell a planning row carries. A recorded `note` wins; a
// plan_reviewer otherwise states its finding count; a FAILED/KILLED/
// INTERRUPTED run also carries its failure reason (backlog #29).
function planningNote(run, model) {
  const parts = [];
  if (run && typeof run.note === "string" && run.note) {
    parts.push(run.note);
  } else if (roleOf(run) === "plan_reviewer") {
    const n = Array.isArray(run.findings) ? run.findings.length : 0;
    parts.push(`${n} finding${n === 1 ? "" : "s"}`);
  }
  const failureReason = failureReasonText(run, model?.runs);
  if (failureReason) parts.push(failureReason);
  const staleReason = statusReason(run);
  if (staleReason) parts.push(staleReason);
  return parts.join(" · ");
}

// The single table column order shared by planning, implementation and final
// review (watcher.md Table columns): ROLE MODEL TASK STATUS DURATION SNAPSHOT
// PRICE CONTEXT TURNS STARTED NOTE.
const TABLE_COLUMNS = [
  { header: "ROLE", cell: (r) => r.role ?? "-" },
  { header: "MODEL", cell: (r) => r.model ?? "-" },
  { header: "TASK", cell: (r) => r.task ?? "-" },
  { header: "STATUS", cell: (r) => r.status ?? "-" },
  { header: "DURATION", cell: (r) => r.duration ?? "-" },
  { header: "SNAPSHOT", cell: (r) => r.snapshot ?? "-" },
  { header: "PRICE", cell: (r) => r.price ?? "-" },
  { header: "CONTEXT", cell: (r) => r.context ?? "-" },
  { header: "TURNS", cell: (r) => r.turns ?? "-" },
  { header: "STARTED", cell: (r) => r.started ?? "-" },
  { header: "NOTE", cell: (r) => r.note ?? "" },
];

// One aligned table for every stage: the header row repeated above the data
// rows (rule 2), a leading `›` in the left margin of every running row, and no
// trailing spaces on the last column.
function renderRows(rows, { indent = "    " } = {}) {
  const pad = typeof indent === "number" ? " ".repeat(Math.max(0, indent)) : String(indent);
  const cells = rows.map((row) => TABLE_COLUMNS.map((c) => String(c.cell(row) ?? "")));
  const widths = TABLE_COLUMNS.map((c, i) => Math.max(c.header.length, ...cells.map((row) => row[i].length)));
  const join = (row) => row.map((cell, i) => (i === TABLE_COLUMNS.length - 1 ? cell : cell.padEnd(widths[i]))).join("  ");
  const lines = [`${pad}${join(TABLE_COLUMNS.map((c) => c.header))}`];
  rows.forEach((row, i) => {
    // The running marker sits in the row's own left margin, two columns wide
    // before `› `, so it aligns with the table whatever its indent (rule 9).
    const prefix = row.running ? `${" ".repeat(Math.max(0, pad.length - 2))}› ` : pad;
    lines.push(`${prefix}${join(cells[i])}`.replace(/\s+$/, ""));
  });
  return lines;
}

// A planning run as a shared-table row: both planning roles write and review
// PLAN.md + TASKS.md, so their TASK is always `plan/tasks`.
function planningRow(run, model) {
  return {
    running: isRunning(run),
    role: run?.dirName || run?.id || "-",
    model: run?.displayModel ?? modelDisplay(run),
    task: "plan/tasks",
    status: runStatusCell(run),
    duration: durationCell(run, model?.now ?? null),
    snapshot: snapshotCell(run),
    price: priceCell(run),
    context: contextCell(run),
    turns: turnsCell(run),
    started: startedCell(run),
    note: planningNote(run, model),
  };
}

// The capped `findings →` block under a failed reviewer row (rule 3).
export const FINDING_MAX_CHARS = 90;
export function shortenFinding(text, max = FINDING_MAX_CHARS) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  const body = (space > Math.floor(max / 2) ? cut.slice(0, space) : cut).replace(/[\s,;:.\-]+$/, "");
  return `${body}…`;
}

export function renderFindings(findings, { runId = null, indent = "      " } = {}) {
  const pad = typeof indent === "number" ? " ".repeat(Math.max(0, indent)) : String(indent);
  const bodyPad = " ".repeat(pad.length + "findings → ".length);
  const list = (Array.isArray(findings) ? findings : []).map(String);
  const lines = [];
  list.slice(0, 2).forEach((finding, i) => {
    const body = `${i + 1}. ${shortenFinding(finding)}`;
    lines.push(i === 0 ? `${pad}findings → ${body}` : `${bodyPad}${body}`);
  });
  if (list.length > 2) {
    const dir = runId || "<run>";
    // Backlog #35f: the overflow line starts under `2.`, which keeps it part
    // of the numbered findings block instead of looking like a new label.
    lines.push(`${bodyPad}+${list.length - 2} more → runs/${dir}/result.json`);
  }
  return lines;
}

// `=== PLANNING STAGE ===  ✓ PASSED at <time> · <price> · <time> (N review
// rounds, R revision of M)`; one `Round N` block per review round, each with
// its own table and the reviewer's findings under the reviewer row.
export function renderPlanningStage(model) {
  const planning = model?.planning || { status: "not_started", rounds: [], runs: [], revision: null };
  const runs = Array.isArray(planning.runs) ? planning.runs : [];
  const rounds = Array.isArray(planning.rounds) ? planning.rounds : [];
  const price = sumPrice(runs);
  const duration = sumDurationMs(runs);
  const roundsCount = rounds.length;
  const revision = typeof planning.revision === "number" ? planning.revision : 0;
  const maxRevisions = Number(model?.policy?.max_plan_revisions);

  // Rule 7 (backlog #7): nothing is shown before it starts - a planning stage
  // with no runs renders nothing, so no `○ NOT STARTED` placeholder.
  if (planning.status === "not_started" && !runs.length) return "";

  let marker;
  let atText = "";
  let detail = "";
  if (planning.status === "passed") {
    marker = "✓ PASSED";
    const ends = runs
      .map((run) => runEndAt(run))
      .filter(Boolean)
      .map((stamp) => ({ stamp, at: Date.parse(stamp) }))
      .filter((e) => Number.isFinite(e.at));
    if (ends.length) {
      const last = ends.reduce((max, e) => (e.at > max.at ? e : max), ends[0]);
      atText = ` at ${formatStamp(last.stamp)}`;
    }
    detail = ` · ${formatTokens(price)} · ${formatClock(duration)}`;
  } else if (planning.status === "in_progress") {
    marker = "● IN PROGRESS";
    detail = ` · ${formatTokens(price)} so far`;
  } else {
    const terminal = terminalStageMarker(planning.status, price);
    if (terminal) {
      marker = terminal.marker;
      detail = terminal.detail;
    } else {
      marker = "○ NOT STARTED";
    }
  }

  let counts = "";
  if (planning.status !== "not_started") {
    const roundLabel = `${roundsCount} review round${roundsCount === 1 ? "" : "s"}`;
    const revisionLabel = Number.isFinite(maxRevisions)
      ? `${revision} revision${revision === 1 ? "" : "s"} of ${maxRevisions}`
      : `${revision} revision${revision === 1 ? "" : "s"}`;
    counts = ` (${roundLabel}, ${revisionLabel})`;
  }

  const roundApproved = (round) => (round.runs || []).some((run) => roleOf(run) === "plan_reviewer" && isDecision(run, "PASS"));
  const out = [`=== PLANNING STAGE ===  ${marker}${atText}${detail}${counts}`];
  rounds.forEach((round, i) => {
    let header = `  Round ${round.number}`;
    if (typeof round.revision === "number" && round.revision > 0) {
      const max = Number.isFinite(maxRevisions) ? ` of ${maxRevisions}` : "";
      header += ` (revision ${round.revision}${max})`;
    }
    out.push(header);
    out.push(...renderRows((round.runs || []).map((run) => planningRow(run, model))));
    const passed = planning.status === "passed" || rounds.slice(i + 1).some(roundApproved);
    if (passed) return;
    for (const run of round.runs || []) {
      if (Array.isArray(run.findings) && run.findings.length) {
        out.push(...renderFindings(run.findings, { runId: run.dirName || run.id }));
      }
    }
  });
  return out.join("\n");
}

function label(text) {
  return `${text}:`.padEnd(8) + " ";
}

function statusText(model) {
  if (model?.status && model.status !== "RUNNING") return model.stopLine || model.status;
  return model?.status || "RUNNING";
}

// Phase names may carry a `Phase N — ` prefix; the Stage/`Total:` lines quote
// only the descriptive remainder.
function stripPhasePrefix(name) {
  if (typeof name !== "string" || !name) return null;
  // Accept both the em dash ("Phase 2 — Wiring") and the standalone planning
  // adapter's TASKS.md heading form ("Phase 2: Wiring").
  const stripped = name.replace(/^Phase\s+\S+\s*[—–:-]\s*/, "").trim();
  return stripped || name;
}

// Total attempts a phase allows = one more than the implementation failure
// budget (the first attempt plus `budget` retries), default 4.
function attemptLimit(model) {
  const raw = Number(model?.policy?.failure_budgets?.implementationFailureBudget);
  if (Number.isInteger(raw) && raw >= 0) return raw + 1;
  return 4;
}

function operatorResetBudget(model, domain) {
  return Array.isArray(model?.operatorResetBudgets) && model.operatorResetBudgets.includes(domain);
}

// `attempt 2 of 4`, or after an operator reset pushed the counter past the
// limit: `attempt 5 (limit 4, reset by operator)`.
function attemptText(attempt, model) {
  const limit = attemptLimit(model);
  if (operatorResetBudget(model, "implementation") && Number(attempt) > limit) {
    return `attempt ${attempt} (limit ${limit}, reset by operator)`;
  }
  return `attempt ${attempt} of ${limit}`;
}

export function stageText(model) {
  // Backlog #43: a finished mission has no current stage — the PIPELINE
  // STATE line reads `Stage: done` (never a stale phase/attempt or a
  // fix-round counter).
  const status = String(model?.status ?? "").toUpperCase();
  if (status === "COMPLETED" || status === "CANCELLED") return "done";
  const stage = model?.stage;
  if (stage === "PLANNING") return "PLANNING";
  if (stage === "FINAL REVIEW") {
    const limit = Number(model?.policy?.final_review_fix_rounds);
    const used = Number(model?.finalReview?.fixRoundsUsed);
    if (Number.isFinite(limit) && limit > 0 && Number.isFinite(used) && used > 0) {
      return `FINAL REVIEW · fix round ${used} of ${limit}`;
    }
    return "FINAL REVIEW";
  }
  const phase = model?.phaseNumber;
  const total = Array.isArray(model?.phases) ? model.phases.length : 0;
  const name = stripPhasePrefix(model?.phaseName);
  let text = "IMPLEMENTATION";
  if (phase != null && total > 0) {
    text += ` — Phase ${phase}/${total}${name ? ` "${name}"` : ""}`;
  }
  const attempt = model?.attempt;
  if (attempt != null) text += ` · ${attemptText(attempt, model)}`;
  return text;
}

function budgetsText(model) {
  const budgets = Array.isArray(model?.budgets) ? model.budgets : [];
  if (!budgets.length) return "-";
  return budgets.map((b) => {
    const base = b.used > b.limit && operatorResetBudget(model, b.domain)
      ? `${b.domain}=${b.used} (limit ${b.limit}, reset by operator)`
      : `${b.domain}=${b.used}/${b.limit}`;
    return b.earlier > 0 ? `${base} (${b.earlier} in earlier phases)` : base;
  }).join("  ");
}

// Time the mission spent with no live orchestrator (backlog #35c): every
// recorded interruption or `orchestrator_exit` opens a gap that closes at the
// next run's start. Overlapping records (an exit event and the run's own
// interruption stamp) are merged so the same downtime is never subtracted
// twice. Returns null when the data cannot tell us (no stamps at all).
function missionDowntimeMs(model, start, end) {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const runs = Array.isArray(model?.runs) ? model.runs : [];
  const starts = runs
    .map((r) => Date.parse(r?.started_at ?? r?.startedAt))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const nextStartAfter = (at) => starts.find((t) => t > at) ?? null;
  const interruptions = [];
  for (const run of runs) {
    const at = Date.parse(run?.interrupted_at);
    if (Number.isFinite(at)) interruptions.push(at);
  }
  for (const e of Array.isArray(model?.events) ? model.events : []) {
    if (e?.type !== "orchestrator_exit") continue;
    const at = Date.parse(e.at);
    if (Number.isFinite(at)) interruptions.push(at);
  }
  if (!interruptions.length) return null;
  const gaps = [];
  for (const at of interruptions.sort((a, b) => a - b)) {
    const resume = nextStartAfter(at);
    if (resume == null) continue;
    const from = Math.max(startMs, at);
    const to = Math.min(endMs, resume);
    if (to > from) gaps.push([from, to]);
  }
  gaps.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cursor = null;
  for (const [from, to] of gaps) {
    if (cursor == null || from > cursor.end) {
      total += to - from;
      cursor = { end: to };
    } else if (to > cursor.end) {
      total += to - cursor.end;
      cursor.end = to;
    }
  }
  return total;
}

function elapsedText(model) {
  const start = model?.missionStartedAt;
  if (!start) return null;
  // For ended missions, use the mission end time; for running missions, use now.
  const end = model?.missionEndedAt ?? model?.now;
  if (!end) return null;
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const downtime = missionDowntimeMs(model, start, end);
  // No interruption data: the wall-clock figure is all we have, and says so.
  if (downtime == null) return `${formatClock(ms)} wall`;
  return formatClock(Math.max(0, ms - downtime));
}

// `Retries: plan_revisions=8 · implementation=4 · verification=4 · final_review_fix_rounds=2 · cli_errors=3 · infrastructure=3 · no_progress_sessions=3 · extra_sessions_per_task=1`
// from `layout.retries.*` (v4) with legacy `policy.*` fallback.
const RETRY_KEYS = ["plan_revisions", "implementation", "verification", "final_review_fix_rounds", "cli_errors", "infrastructure", "no_progress_sessions", "extra_sessions_per_task"];
const LEGACY_RETRY_READERS = {
  plan_revisions: (p) => p.max_plan_revisions,
  implementation: (p) => p.failure_budgets?.implementationFailureBudget,
  verification: (p) => p.failure_budgets?.verificationFailureBudget,
  final_review_fix_rounds: (p) => p.final_review_fix_rounds,
  cli_errors: (p) => p.failure_budgets?.adapterRetryBudget,
  infrastructure: (p) => p.failure_budgets?.infrastructureRetryBudget,
  no_progress_sessions: (p) => p.no_progress_generations,
  extra_sessions_per_task: (p) => p.continuation_allowance,
};
function retriesText(model) {
  const layoutRetries = model?.layout?.retries && typeof model.layout.retries === "object" ? model.layout.retries : null;
  const policy = model?.policy && typeof model.policy === "object" ? model.policy : {};
  const parts = [];
  for (const key of RETRY_KEYS) {
    const value = layoutRetries?.[key] ?? LEGACY_RETRY_READERS[key](policy);
    if (value !== undefined && value !== null) parts.push(`${key}=${value}`);
  }
  return parts.length ? parts.join(" · ") : "-";
}

function splitPart(name, runs, inProgress) {
  return `${name} ${formatTokens(sumPrice(runs))}${inProgress ? " so far" : ""}`;
}

// `Total: <price> · elapsed <time> (call backstop <mins>m) (planning <p> · phase N <p> · final review <p>)`
// One-role-call backstop from `layout.time_limits.call_backstop_minutes` (v4,
// old `mission_timeout_minutes` still read) or `policy.relay_timeout_ms` (legacy).
export function totalText(model) {
  const allRuns = Array.isArray(model?.runs) ? model.runs : [];
  const parts = [];
  const ended = isMissionEnded(model?.status);
  const planningRuns = model?.planning?.runs || [];
  if (planningRuns.length) parts.push(splitPart("planning", planningRuns, !ended && model?.stage === "PLANNING"));
  for (const phase of model?.phases || []) {
    if ((phase.runs || []).length) {
      const current = !ended && model?.stage === "IMPLEMENTATION" && phase.number === model?.phaseNumber;
      parts.push(splitPart(`phase ${phase.number}`, phase.runs, current));
    }
  }
  const finalRuns = model?.finalReview?.runs || [];
  if (finalRuns.length) {
    const finalInProgress = !ended && model?.stage === "FINAL REVIEW" && model?.finalReview?.status !== "passed";
    parts.push(splitPart("final review", finalRuns, finalInProgress));
  }

  let line = formatTokens(sumPrice(allRuns));
  const elapsed = elapsedText(model);
  if (elapsed) line += ` · elapsed ${elapsed}`;

  // One-role-call backstop (never a whole-mission limit).
  const layoutTimeLimits = model?.layout?.time_limits && typeof model.layout.time_limits === "object" ? model.layout.time_limits : null;
  const policy = model?.policy && typeof model.policy === "object" ? model.policy : {};
  let callBackstopMins = layoutTimeLimits?.call_backstop_minutes ?? layoutTimeLimits?.mission_timeout_minutes;
  if (callBackstopMins === undefined || callBackstopMins === null) {
    if (policy.relay_timeout_ms != null && Number.isFinite(policy.relay_timeout_ms)) {
      callBackstopMins = Math.round(policy.relay_timeout_ms / 60000);
    }
  }
  if (callBackstopMins != null && Number.isFinite(callBackstopMins) && callBackstopMins > 0) {
    line += ` (call backstop ${callBackstopMins}m)`;
  }

  if (parts.length) line += ` (${parts.join(" · ")})`;
  return line;
}

// `Caps: planner 750K/40t/2s · plan_reviewer 300K/30t/1s · … (tokens/turns/sessions per session)` from
// `layout.caps.<role>.max_tokens/max_turns/extra_sessions` (v4) with legacy `policy.caps` fallback.
const CAP_ROLE_ORDER = ["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"];
export function capsText(model) {
  const layoutCaps = model?.layout?.caps && typeof model.layout.caps === "object" ? model.layout.caps : null;
  const legacyCaps = model?.policy?.caps && typeof model.policy.caps === "object" ? model.policy.caps : {};
  const freeModelMaxTurns = model?.layout?.roles?.free_models?.max_turns ?? model?.policy?.free_model_turns_cap ?? null;

  function getCap(role, key) {
    const v4 = layoutCaps?.[role]?.[key];
    if (v4 !== undefined && v4 !== null) return v4;
    const legacyKey = key === "max_turns" ? "max_turns" : key === "max_tokens" ? "max_tokens" : key === "extra_sessions" ? "extra_sessions" : key;
    return legacyCaps[role]?.[legacyKey] ?? legacyCaps[role]?.[key.replace("_", "")] ?? null;
  }

  const known = CAP_ROLE_ORDER.filter((role) => layoutCaps?.[role] || legacyCaps[role]);
  const extra = [...new Set([...Object.keys(layoutCaps || {}), ...Object.keys(legacyCaps)])].filter((role) => !CAP_ROLE_ORDER.includes(role) && role !== "implementer" && role !== "task_size_target_turns" && role !== "mission_token_backstop");
  const roles = [...known, ...extra];
  if (!roles.length && freeModelMaxTurns == null) return "-";

  const parts = roles.map((role) => {
    const maxTokens = getCap(role, "max_tokens");
    const maxTurns = getCap(role, "max_turns");
    const extraSessions = getCap(role, "extra_sessions");
    const tokensStr = maxTokens != null ? formatTokens(maxTokens) : "?";
    const turnsStr = maxTurns != null ? `${maxTurns}t` : "?t";
    const sessionsStr = extraSessions != null ? `${extraSessions}s` : "?s";
    return `${role} ${tokensStr}/${turnsStr}/${sessionsStr}`;
  });

  let result = `${parts.join(" · ")} (tokens/turns/sessions per session)`;
  if (freeModelMaxTurns != null) {
    result += ` · free-model max turns: ${freeModelMaxTurns}`;
  }
  return result;
}

// `Skill:` names the skill copy the orchestrator runs. No skill-copy/sync value
// is recorded anywhere (PLAN.md:50), so this degrades to a best-effort value:
// the passed `model.skill` when available, else an explicit not-recorded label.
export function skillText(model) {
  const skill = model?.skill;
  if (skill && (skill.mode || skill.path)) {
    const mode = skill.mode || "production";
    const at = skill.syncedAt ? formatStamp(skill.syncedAt).slice(0, 16) : null;
    return `${mode} · ${skill.path || "-"}${at ? ` (synced ${at})` : ""}`;
  }
  return "unknown · skill copy location not recorded";
}

// `=== [<stamp> — ]PIPELINE STATE ===` block (watcher.md Sections): mission,
// status, stage, budgets used/limit, retries, totals, caps, skill copy and the Events
// line. No current-run detail leaks in here.
export function renderPipelineState(model, { stamp = null } = {}) {
  const head = stamp ? `=== ${stamp} — PIPELINE STATE ===` : "=== PIPELINE STATE ===";
  const missionName = model?.mission ?? model?.missionFallback ?? "-";
  const lines = [
    head,
    `Mission: ${missionName}`,
    label("Status") + statusText(model),
    label("Stage") + stageText(model),
    label("Budgets") + budgetsText(model),
    label("Retries") + retriesText(model),
    label("Total") + totalText(model),
    label("Caps") + capsText(model),
    label("Skill") + skillText(model),
  ];
  if (model?.eventsLine) lines.push(label("Events") + model.eventsLine);
  return lines.join("\n");
}

// ── Mission 094 task 1.4 — IMPLEMENTATION STAGE + FINAL REVIEW STAGE ────────
// Still PURE: reads the built model only and returns text.

// Rule 15: a run row at ≥70% of its role's `policy.caps.<role>` cap gets
// `⚠ high usage (<used> of <cap> cap)`. Never fabricated when no cap exists.
function highUsageText(run, model) {
  const caps = model?.policy?.caps && typeof model.policy.caps === "object" ? model.policy.caps : {};
  const cap = caps[roleOf(run)] || {};
  const limit = Number(cap.max_tokens ?? cap.maxTokens);
  const used = Number(run?.usage?.priceWeighted);
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(used)) return null;
  if (used / limit < 0.7) return null;
  return `⚠ high usage (${formatTokens(used)} of ${formatTokens(limit)} cap)`;
}

// Failure classes in plain lower words for the run NOTE (backlog #29). The
// map covers every class the pipeline records (scripts/failure-contract.mjs
// FAILURE_CLASSES plus the orchestrator's `class:` literals); a class not
// listed falls back to its name lowercased with `_` -> space. Never fabricated.
const FAILURE_CLASS_LABELS = {
  CLI_UNAVAILABLE: "cli unavailable",
  PROCESS_START_FAILED: "process start failed",
  PROCESS_EXIT_NONZERO: "process exited nonzero",
  TIMEOUT: "timed out",
  PERMISSION_DENIED: "permission denied",
  PATH_UNSUPPORTED: "unsupported path",
  INVOCATION_MISMATCH: "invocation mismatch",
  STRUCTURED_OUTPUT_MISSING: "structured output missing",
  STRUCTURED_OUTPUT_INVALID: "structured output invalid",
  READ_ONLY_VIOLATION: "read-only violation",
  GIT_MUTATION_BLOCKED: "git mutation blocked",
  GIT_COMMIT_DETECTED: "git commit detected",
  COMMAND_FAILED: "command failed",
  SERVER_UNAVAILABLE: "server unavailable",
  RATE_LIMITED: "rate limited",
  PROVIDER_ERROR: "provider error",
  IDLE_HANG: "idle hang",
  IMPLEMENTATION_REJECTED: "implementation rejected",
  VERIFICATION_REJECTED: "verification rejected",
  PLANNING_REJECTED: "planning rejected",
  INTERNAL_CONTRACT_ERROR: "internal contract error",
  ORCHESTRATOR_FATAL: "orchestrator fatal",
  UNEXPECTED_ERROR: "unexpected error",
};

// `RATE_LIMITED` -> `rate limited`; an unknown class -> its lowercased name
// with `_` -> space. Null/empty input is never fabricated.
export function failureClassText(cls) {
  const s = String(cls ?? "").trim();
  if (!s) return null;
  const known = FAILURE_CLASS_LABELS[s.toUpperCase()];
  if (known) return known;
  return s.toLowerCase().replace(/_/g, " ");
}

// The next run of the same role and task after `run`, by start time. Used to
// name the fallback model the orchestrator switched to after a failure
// (backlog #29). Returns null when there is no such run. The task scope must be
// known (`taskRef`), so a run without one is never matched across tasks.
function nextRunOf(run, runs) {
  const taskRef = runRef(run);
  if (taskRef == null) return null;
  const role = roleOf(run);
  const start = Date.parse(run?.started_at ?? run?.startedAt);
  const phase = phaseNumberOf(run);
  const candidates = (Array.isArray(runs) ? runs : [])
    .filter((r) => r && r !== run)
    .filter((r) => roleOf(r) === role && runRef(r) === taskRef)
    .filter((r) => phase == null || phaseNumberOf(r) == null || phaseNumberOf(r) === phase)
    .map((r) => ({ r, at: Date.parse(r.started_at ?? r.startedAt) }))
    .filter((x) => Number.isFinite(x.at) && (!Number.isFinite(start) || x.at > start));
  candidates.sort((a, b) => a.at - b.at);
  return candidates.length ? candidates[0].r : null;
}

// The failure reason a FAILED/KILLED/INTERRUPTED row carries in its NOTE
// (backlog #29): the failure class in plain lower words, plus `→ <model>` only
// when the NEXT run of the same role and task uses a different model. Returns
// null for any other status or when result.json carries no failure class.
export function failureReasonText(run, runs) {
  const label = failureClassText(run?.failureClass);
  if (!label) return null;
  const status = String(run?.status || "").toLowerCase();
  if (!["failed", "killed", "interrupted"].includes(status)) return null;
  const next = nextRunOf(run, runs);
  const nextModel = next ? modelDisplay(next) : null;
  const ownModel = modelDisplay(run);
  if (nextModel && nextModel !== "-" && nextModel !== ownModel) return `${label} → ${nextModel}`;
  return label;
}

// Backlog #35a: a run stopped by a dying orchestrator keeps a lasting reason
// even after a new orchestrator is alive (the live `orchestrator not running`
// label only exists while the owner is dead). SIGTERM/stale-process records and
// an `orchestrator_exit` event in the run's window all mean the same thing.
function orchestratorKilledText(run, model) {
  const status = String(splitStatusLabel(run?.status).status || "").toLowerCase();
  if (!["interrupted", "killed"].includes(status)) return null;
  const reason = String(run?.interruption_reason ?? "");
  if (/sigterm|sigkill|stale|dead process|killed|orchestrat/i.test(reason)) return "orchestrator killed";
  const start = Date.parse(run?.started_at ?? run?.startedAt);
  const end = Date.parse(run?.interrupted_at);
  const next = nextRunOf(run, model?.runs);
  const nextStart = Date.parse(next?.started_at ?? next?.startedAt);
  if (Number.isFinite(start)) {
    for (const e of Array.isArray(model?.events) ? model.events : []) {
      if (e?.type !== "orchestrator_exit") continue;
      const at = Date.parse(e.at);
      if (!Number.isFinite(at) || at < start) continue;
      if (Number.isFinite(end) && at > end + 60000) continue;
      if (!Number.isFinite(end) && Number.isFinite(nextStart) && at > nextStart) continue;
      return "orchestrator killed";
    }
  }
  return null;
}

function sameRunScope(a, b) {
  return roleOf(a) === roleOf(b)
    && runRef(a) === runRef(b)
    && phaseNumberOf(a) === phaseNumberOf(b)
    && String(a?.sessionNumber ?? "") === String(b?.sessionNumber ?? "");
}

// Backlog #35a: the first run of the same role/task/session after an
// orchestrator-killed interruption is its `retry` (otherwise the two rows look
// like a duplicate).
function retryText(run, model) {
  const start = Date.parse(run?.started_at ?? run?.startedAt);
  if (!Number.isFinite(start)) return null;
  const prior = (Array.isArray(model?.runs) ? model.runs : [])
    .filter((r) => r && r !== run && sameRunScope(r, run))
    .map((r) => ({ r, at: Date.parse(r.started_at ?? r.startedAt) }))
    .filter((x) => Number.isFinite(x.at) && x.at < start)
    .sort((a, b) => b.at - a.at);
  if (!prior.length) return null;
  const last = prior[0].r;
  return ["interrupted", "killed"].includes(String(splitStatusLabel(last?.status).status || "").toLowerCase())
    && orchestratorKilledText(last, model)
    ? "retry"
    : null;
}

// The NOTE cell of an implementation/phase-review row: the role hint, the
// finding count, the recorded note, the `session k of N` scope, the failure
// reason (backlog #29), the high-usage ⚠ (rule 15) and the provider-trouble ⚠
// (rule 11).
function implementationNote(run, model, noteHint = null) {
  const parts = [];
  const role = roleOf(run);
  const findingsCount = Array.isArray(run?.findings) ? run.findings.length : 0;
  if (noteHint === "final review") {
    parts.push("final review");
    parts.push(`${findingsCount} finding${findingsCount === 1 ? "" : "s"}`);
  } else {
    if (role === "code_reviewer") parts.push("phase review");
    else if (role === "verifier") parts.push("phase verify");
    if (findingsCount > 0) parts.push(`${findingsCount} finding${findingsCount === 1 ? "" : "s"}`);
  }
  const noteText = typeof run?.note === "string" ? run.note.trim() : "";
  const label = run?.providerTrouble ?? null;
  if (noteText) {
    if (label && !noteText.includes(label) && !noteText.includes("⚠")) { parts.push(noteText); parts.push(`⚠ ${label}`); }
    else if (label && noteText.includes(label) && !noteText.includes("⚠")) parts.push(`⚠ ${label}`);
    else parts.push(noteText);
  } else if (label) {
    parts.push(`⚠ ${label}`);
  }
  const cappedEscalation = String(run?.status || "") === "capped"
    && (Boolean(run?.policyViolation) || run?.escalated === true || /GIT_MUTATION_BLOCKED|^POLICY/i.test(String(run?.failureClass || "")));
  if (cappedEscalation) {
    const reason = run.policyViolation || run.failureClass || "escalated";
    parts.push(`capped · escalated (${String(reason).replace(/_/g, " ").toLowerCase()})`);
  }
  if (run?.sessionLabel) parts.push(run.sessionLabel);
  const staleReason = statusReason(run);
  if (staleReason) parts.push(staleReason);
  const killedReason = orchestratorKilledText(run, model);
  // While the owner-dead label already says `orchestrator not running`, do not
  // repeat the same fact; the lasting reason takes over once it is alive.
  if (killedReason && killedReason !== staleReason && !/orchestrat/i.test(staleReason || "")) parts.push(killedReason);
  const failureReason = failureReasonText(run, model?.runs);
  if (failureReason) parts.push(failureReason);
  const retry = retryText(run, model);
  if (retry) parts.push(retry);
  if (run?.retryAfterEscalation) parts.push("retry after escalation");
  const high = highUsageText(run, model);
  if (high) parts.push(high);
  return parts.join(" · ");
}

// A run row of an implementation/final-review table; `task` overrides the
// display ref (final review uses the mission-wide task range).
function implementationRow(run, model, { task = undefined, noteHint = null } = {}) {
  return {
    running: String(run?.status || "") === "running",
    task: task !== undefined ? task : (runRef(run) ?? "-"),
    role: run?.dirName || run?.id || "-",
    model: run?.displayModel ?? modelDisplay(run),
    status: runStatusCell(run),
    duration: durationCell(run, model?.now ?? null),
    snapshot: snapshotCell(run),
    price: priceCell(run),
    context: contextCell(run),
    turns: turnsCell(run),
    started: startedCell(run),
    note: implementationNote(run, model, noteHint),
  };
}

// A `GATE (orchestrator)` row (rule 10): no model/price/context/turns; the
// command and `passed/total` runs come from the gate events. STARTED is when
// the gate started (DURATION is its measured run time).
function gateRow(gate, model, task) {
  const running = gate.status === "running";
  const p = gate.progress || {};
  const cmd = gate.command ? ` (${gate.command})` : "";
  let note;
  if (gate.status === "completed") {
    const passed = p.passed ?? "-";
    const total = p.total ?? "-";
    if (gate.ok === false) {
      note = `full test suite${cmd} · ${passed}/${total} runs · ${p.failed ?? "?"} failed`;
      if (gate.failingFile) note += ` · ${gate.failingFile}`;
    } else {
      note = `full test suite${cmd} · ${passed}/${total} runs passed`;
    }
  } else if (running) {
    note = p.total != null
      ? `full test suite${cmd} · ${p.passed ?? 0}/${p.total} runs · running`
      : `full test suite${cmd} · running`;
  } else {
    note = `full test suite${cmd} · runs before verify`;
  }
  let duration = gate.durationMs != null ? formatClock(gate.durationMs) : "-";
  if (running && model?.now && gate.at) {
    const live = durationCell({ status: "running", started_at: gate.at }, model.now);
    if (live !== "-") duration = live;
  }
  return {
    running,
    task: task ?? "-",
    role: "GATE (orchestrator)",
    model: "-",
    status: gateStatusText(gate),
    duration,
    snapshot: "-", price: "-", context: "-", turns: "-",
    started: gate.at ? formatStamp(gate.at) : (gate.resultAt ? formatStamp(gate.resultAt) : "-"),
    note,
  };
}

// The implementation rows of one attempt: its runs and its gate rows merged by
// start time, each in the attempt whose window contains that start. Each entry
// carries its own run's findings so the renderer can hang the `findings →`
// block directly under the row that produced it (bug c).
function attemptRows(attempt, model, phase) {
  const allRefs = phaseTaskRefs(phase);
  const range = taskRange(allRefs);
  const entries = [];
  for (const run of attempt.runs || []) {
    let task;
    if (IMPLEMENTATION_ROLES.has(roleOf(run))) task = runRef(run) ?? "-";
    else task = normalizeRunTaskRef(runRef(run), allRefs) ?? range ?? "-";
    entries.push({ ts: Date.parse(run.started_at ?? run.startedAt) || 0, seq: entries.length, row: implementationRow(run, model, { task }), findings: run.findings || [], runId: run.dirName || run.id || null });
  }
  for (const g of attempt.gates || []) {
    entries.push({ ts: Date.parse(g.at ?? g.resultAt) || 0, seq: entries.length, row: gateRow(g, model, range ?? "-"), findings: [] });
  }
  entries.sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq));
  return entries;
}

// The phase's task refs in display order. The standalone adapter's TASKS.md
// keeps the ref in the item text ("**4.2** …"), so fall back to that number.
function phaseTaskDisplayRefs(phase) {
  return (phase?.tasks || []).map((t, i) => {
    if (typeof t.ref === "string" && t.ref) return t.ref;
    const fromText = taskRefFromText(t.text);
    if (fromText) return fromText;
    const m = String(t.text ?? "").match(/^\*{0,2}\s*(\d+(?:\.\d+)?)/);
    if (m) return `T${m[1]}`;
    return `T${phase.number}.${i + 1}`;
  });
}

// The single `next:` line under the running phase's table (backlog #9): the
// next implementation task, then the still-missing attempt steps in order
// (phase review -> full test suite -> phase verify). Nothing is shown during
// the final verify (nothing is left), and the line is dropped for a stopped
// phase (its status is terminal, not in_progress).
function nextStepsLine(model, phase, attempt) {
  if (model?.stage !== "IMPLEMENTATION") return null;
  const current = model?.current;
  if (!current) return null;
  if (current.role === "verifier") return null;
  const parts = [];
  if (current.kind === "run" && current.role === "implementer" && current.taskRef) {
    const refs = phaseTaskDisplayRefs(phase);
    const i = refs.indexOf(String(current.taskRef));
    if (i >= 0 && i < refs.length - 1) {
      const next = refs[i + 1];
      const more = refs.length - (i + 2);
      parts.push(`${next}${more > 0 ? ` (+${more} more task${more === 1 ? "" : "s"})` : ""}`);
    }
  }
  const runs = attempt?.runs || [];
  if (!runs.some((r) => roleOf(r) === "code_reviewer")) parts.push("phase review");
  if (!(attempt?.gates || []).length) parts.push("full test suite");
  if (!runs.some((r) => roleOf(r) === "verifier")) parts.push("phase verify");
  if (!parts.length) return null;
  return `next: ${parts.join(" → ")}`;
}

// The mission-wide task refs in phase order (final-review task range).
function missionTaskRefs(model) {
  const refs = [];
  for (const phase of model?.phases || []) {
    for (const ref of phaseTaskRefs(phase)) if (!refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

function missionTaskRange(model) {
  return taskRange(missionTaskRefs(model));
}

// `  Phase N/M — <name>  ✓ PASSED · <price> · <time>` / `● IN PROGRESS
// (attempt k of L) · <price> so far` / `○ NOT STARTED`.
function phaseHeader(phase, model) {
  const total = Array.isArray(model?.phases) ? model.phases.length : 0;
  const name = stripPhasePrefix(phase.name);
  const head = `  Phase ${phase.number}/${total}${name ? ` — ${name}` : ""}`;
  if (phase.status === "passed") {
    if (!(phase.runs || []).length) return `${head}  ✓ PASSED`;
    return `${head}  ✓ PASSED · ${formatTokens(sumPrice(phase.runs))} · ${formatClock(sumDurationMs(phase.runs))}`;
  }
  const terminal = terminalStageMarker(phase.status, sumPrice(phase.runs));
  if (terminal) return `${head}  ${terminal.marker}${terminal.detail}`;
  if (phase.status === "in_progress") {
    let extra = "";
    if (model.stage === "IMPLEMENTATION" && phase.number === model.phaseNumber && model.attempt != null) {
      extra = ` (${attemptText(model.attempt, model)})`;
    }
    return `${head}  ● IN PROGRESS${extra} · ${formatTokens(sumPrice(phase.runs))} so far`;
  }
  return `${head}  ○ NOT STARTED`;
}

// `✗ DENIED by verifier · <price>` / `● IN PROGRESS (after verifier DENIED ·
// verification budget u/l) · <price> so far` / `✓ PASSED · <price>` /
// `→ fixes done · <price>` for an earlier attempt that ended without a verdict.
// Only the LAST attempt of a phase that is still running may carry the mission's
// terminal marker (bug a): an earlier attempt that ended normally is the fix
// round that closed the previous denial, never the mission status.
function attemptHeader(attempt, phase, index, model, isLast = false) {
  const price = sumPrice(attempt.runs || []);
  if (attempt.result === "DENIED") {
    return `✗ DENIED by ${denyingRole(attempt.runs)} · ${formatTokens(price)}`;
  }
  if (attempt.result === "PASS") return `✓ PASSED · ${formatTokens(price)}`;
  const terminal = isLast ? terminalStageMarker(model?.status, price) : null;
  if (terminal) return `${terminal.marker}${terminal.detail}`;
  if (!isLast) return `→ fixes done · ${formatTokens(price)}`;
  let paren = "";
  const prev = phase.attempts[index - 1];
  if (prev && prev.result === "DENIED") {
    const by = denyingRole(prev.runs);
    const domain = by === "verifier" ? "verification" : "implementation";
    const budget = (model?.budgets || []).find((b) => b.domain === domain);
    const detail = budget ? ` · ${domain} budget ${budget.used}/${budget.limit}` : "";
    paren = ` (after ${by} DENIED${detail})`;
  }
  return `● IN PROGRESS${paren} · ${formatTokens(price)} so far`;
}

function denyingRole(runs) {
  const deniers = (runs || [])
    .map((r, i) => ({ r, i, t: Date.parse(r?.started_at ?? r?.startedAt) }))
    .filter((x) => REVIEW_ROLES.has(roleOf(x.r)) && isDecision(x.r, "FAIL"))
    .sort((a, b) => (((Number.isFinite(a.t) ? a.t : 0) - (Number.isFinite(b.t) ? b.t : 0)) || (a.i - b.i)));
  return deniers.length ? roleOf(deniers[deniers.length - 1].r) : "review";
}

// `=== IMPLEMENTATION STAGE ===` with one block per phase: a `✓/●/○` header
// with the phase totals, one table per attempt (with its result when a phase
// has more than one), the DENIED attempt's findings + carried-forward +
// changed-files lines, CAPPED `session k of N`, and GATE rows. Rows appear
// only once they have started; each sits in the attempt containing its start.
export function renderImplementationStage(model) {
  // Rule 7 (backlog #7): nothing is shown before it starts - a phase with no
  // runs is omitted entirely, so no `○ NOT STARTED` header and no section while
  // the mission is still planning.
  const started = (model?.phases || []).filter((p) => p.status !== "not_started" && (p.runs || []).length > 0);
  if (!started.length) return "";
  const out = ["=== IMPLEMENTATION STAGE ==="];
  started.forEach((phase, phaseIndex) => {
    // Backlog #35e: the first phase header follows the section header with no
    // blank line; the blank line separates later phases from their predecessor.
    if (phaseIndex > 0) out.push("");
    out.push(phaseHeader(phase, model));
    const attempts = phase.attempts || [];
    const showAttemptHeaders = attempts.length > 1;
    // Backlog #211: the table sits one level deeper only when an `Attempt N`
    // header actually exists above it. With a single attempt there is no
    // header, so the table stays at four and its findings/carried-forward
    // lines at six (and `next:` aligns with the table either way).
    const tableIndent = showAttemptHeaders ? "      " : "    ";
    const detailIndent = showAttemptHeaders ? "        " : "      ";
    const passIndex = attempts.findIndex((a) => a.result === "PASS");
    attempts.forEach((attempt, i) => {
      const isLast = i === attempts.length - 1;
      const findingsPassed = phase.status === "passed" || (passIndex !== -1 && i <= passIndex);
      const runningAttempt = model?.stage === "IMPLEMENTATION"
        && phase.number === model?.phaseNumber
        && phase.status === "in_progress"
        && isLast;
      if (showAttemptHeaders) out.push(`    Attempt ${attempt.number}  ${attemptHeader(attempt, phase, i, model, isLast)}`);
      const entries = attemptRows(attempt, model, phase);
      if (entries.length) {
        const lines = renderRows(entries.map((e) => e.row), { indent: tableIndent });
        out.push(lines[0]);
        entries.forEach((entry, j) => {
          out.push(lines[j + 1]);
          // Bug c: a run's findings sit directly under its own row, one level
          // deeper than the attempt's table (backlog #35g).
          if (!findingsPassed && Array.isArray(entry.findings) && entry.findings.length) {
            out.push(...renderFindings(entry.findings.map((f) => String(f.text ?? f)), { runId: entry.runId, indent: detailIndent }));
          }
        });
      }
      if (!findingsPassed && Array.isArray(attempt.carriedForward) && attempt.carriedForward.length) {
        const findingText = entries.flatMap((e) => e.findings || []).map((f) => String(f.text ?? f)).join(" ");
        // Backlog #212: named tasks first, then the unnamed group with ONE
        // note at its end, instead of repeating the note after every task.
        const named = [];
        const unnamed = [];
        for (const task of attempt.carriedForward) {
          const ref = String(task);
          (findingText.includes(ref) ? named : unnamed).push(ref);
        }
        const groups = [];
        if (named.length) groups.push(named.join(", "));
        if (unnamed.length) groups.push(`${unnamed.join(", ")} (not named by the findings)`);
        if (groups.length) out.push(`${detailIndent}carried forward → ${groups.join(" · ")}`);
      }
      if (runningAttempt) {
        const nextLine = nextStepsLine(model, phase, attempt);
        if (nextLine) {
          // Table -> one blank line -> `next:` (last line under the running phase).
          out.push("");
          out.push(`${tableIndent}${nextLine}`);
          return;
        }
      }
    });
  });
  return out.join("\n");
}

// `=== FINAL REVIEW STAGE ===` (rule 16; never `Phase N`): result line with
// fix rounds, then one `Round N` block per review (a denied review's fix pass
// under `Fix round k of N` with its gate + changed-files lines).
export function renderFinalReviewStage(model) {
  const fr = model?.finalReview || { status: "not_started", rounds: [], runs: [] };
  const limitRaw = Number(model?.policy?.final_review_fix_rounds);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : null;
  const runs = fr.runs || [];
  // Rule 7 (backlog #7): the final-review section does not exist until the
  // stage starts - no `○ NOT STARTED` placeholder while implementation runs.
  if (fr.status === "not_started" && !runs.length) return "";

  const fixRoundsUsed = (fr.rounds || []).filter((r) => (r.runs || []).some((x) => IMPLEMENTATION_ROLES.has(roleOf(x)))).length;
  let head;
  if (fr.status === "passed") {
    const ends = runs
      .map((run) => runEndAt(run))
      .filter(Boolean)
      .map((stamp) => ({ stamp, at: Date.parse(stamp) }))
      .filter((e) => Number.isFinite(e.at));
    let atText = "";
    if (ends.length) {
      const last = ends.reduce((max, e) => (e.at > max.at ? e : max), ends[0]);
      atText = ` at ${formatStamp(last.stamp)}`;
    }
    const fixText = limit ? ` (fix rounds ${fixRoundsUsed} of ${limit})` : ` (fix rounds ${fixRoundsUsed})`;
    head = `=== FINAL REVIEW STAGE ===  ✓ PASSED${atText} · ${formatTokens(sumPrice(runs))} · ${stageSpanClock(runs)}${fixText}`;
  } else {
    const terminal = terminalStageMarker(fr.status, sumPrice(runs));
    if (terminal) {
      head = `=== FINAL REVIEW STAGE ===  ${terminal.marker}${terminal.detail}`;
    } else if (fr.status === "in_progress" || runs.some(isRunning)) {
      head = `=== FINAL REVIEW STAGE ===  ● IN PROGRESS · ${formatTokens(sumPrice(runs))} so far`;
    } else {
      head = "=== FINAL REVIEW STAGE ===  ○ NOT STARTED";
    }
  }

  const range = missionTaskRange(model);
  const allRefs = missionTaskRefs(model);
  const finalGates = (model?.gates || []).filter((g) => g.phase == null);
  const scopeOf = (run) => (runRef(run) ? (normalizeRunTaskRef(runRef(run), allRefs) ?? (range ?? "-")) : (range ?? "-"));
  const roundApproved = (round) => (round.runs || []).some((r) => REVIEW_ROLES.has(roleOf(r)) && isDecision(r, "PASS"));
  const out = [head];
  let fix = 0;
  (fr.rounds || []).forEach((round, roundIndex) => {
    const reviewers = (round.runs || []).filter((r) => REVIEW_ROLES.has(roleOf(r)));
    const implRuns = (round.runs || []).filter((r) => IMPLEMENTATION_ROLES.has(roleOf(r)));
    out.push(`  Round ${round.number}`);
    out.push(...renderRows(reviewers.map((r) => implementationRow(r, model, { task: scopeOf(r), noteHint: "final review" }))));
    const findingsPassed = fr.status === "passed" || (fr.rounds || []).slice(roundIndex + 1).some(roundApproved);
    if (!findingsPassed) {
      for (const r of reviewers) {
        if (Array.isArray(r.findings) && r.findings.length) {
          out.push(...renderFindings(r.findings.map((f) => String(f.text ?? f)), { runId: r.dirName || r.id || null }));
        }
      }
    }
    if (implRuns.length) {
      fix += 1;
      out.push(limit ? `  Fix round ${fix} of ${limit}` : `  Fix round ${fix}`);
      const entries = [
        ...implRuns.map((r) => ({ ts: Date.parse(r.started_at ?? r.startedAt) || 0, seq: 0, row: implementationRow(r, model, { task: scopeOf(r) }) })),
        ...finalGates.map((g) => ({ ts: Date.parse(g.at ?? g.resultAt) || 0, seq: 1, row: gateRow(g, model, range ?? "-") })),
      ];
      entries.sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq));
      out.push(...renderRows(entries.map((e) => e.row)));
    }
  });
  return out.join("\n");
}

// ── Mission 094 task 1.5 — CURRENT RUN + LIVE PROGRESS rendering ────────────
// Still PURE: reads the built model only and returns text.

// The per-role token cap (`policy.caps.<role>.max_tokens`) for a current run.
function capForRole(model, role) {
  const caps = model?.policy?.caps && typeof model.policy.caps === "object" ? model.policy.caps : {};
  const cap = role ? caps[role] : null;
  if (!cap) return null;
  const raw = cap.max_tokens ?? cap.maxTokens;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// The compact CURRENT RUN stage line: `IMPLEMENTATION · Phase 2/3 · attempt 2`
// (no phase name, no attempt limit — the PIPELINE STATE `Stage:` line carries
// those). FINAL REVIEW may add its fix round; PLANNING is bare.
export function currentStageText(model) {
  const stage = model?.stage;
  if (stage === "PLANNING") return "PLANNING";
  if (stage === "FINAL REVIEW") {
    const limit = Number(model?.policy?.final_review_fix_rounds);
    const used = Number(model?.finalReview?.fixRoundsUsed);
    let text = "FINAL REVIEW";
    if (Number.isFinite(limit) && limit > 0 && Number.isFinite(used) && used > 0) text += ` · fix round ${used} of ${limit}`;
    return text;
  }
  const phase = model?.phaseNumber;
  const total = Array.isArray(model?.phases) ? model.phases.length : 0;
  let text = "IMPLEMENTATION";
  if (phase != null && total > 0) text += ` · Phase ${phase}/${total}`;
  if (model?.attempt != null) text += ` · attempt ${model.attempt}`;
  return text;
}

// `HH:MM:SS` wall time from `startedAt` to the report clock (`now`).
function elapsedSince(startedAt, now) {
  if (!startedAt || !now) return null;
  const ms = Date.parse(now) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return formatClock(ms);
}

// The pre-run snapshot duration, in the SNAPSHOT column's format
// (`snapshotBeforeAt - started_at`; backlog #35b).
function prepSnapshotClock(current) {
  const before = current?.snapshotBeforeAt;
  const start = current?.startedAt;
  if (!before || !start) return null;
  const ms = Date.parse(before) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return snapshotSpanText(ms);
}

// `(8s ago)` / `(2m ago)` relative to the report clock.
function agoText(at, now) {
  if (!at || !now) return null;
  const ms = Date.parse(now) - Date.parse(at);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
}

// `=== CURRENT RUN ===` (watcher.md Sections, rule 5): details of the one live
// run only; nothing is printed when no run is current. The orchestrator gate
// variant shows the command and `N/M runs · N passed · F failed`. Its numbers
// match the run's table row.
export function renderCurrentRun(model) {
  const current = model?.current;
  if (!current) return "";
  const now = model?.now ?? null;
  const out = ["=== CURRENT RUN ==="];

  if (current.kind === "gate") {
    out.push(label("stage") + currentStageText(model));
    out.push(label("run") + "GATE (orchestrator full suite, no agent)");
    if (current.command) out.push(label("command") + current.command);
    let status = "RUNNING";
    if (current.pid != null) status += ` · pid ${current.pid} (alive)`;
    out.push(label("status") + status);
    const started = current.startedAt ? formatStamp(current.startedAt) : null;
    const elapsed = elapsedSince(current.startedAt, now);
    out.push(label("started") + (started || "-") + (elapsed ? ` · elapsed ${elapsed}` : ""));
    const p = current.progress || {};
    if (Number.isFinite(Number(p.total)) && Number.isFinite(Number(p.passed))) {
      const failed = Number.isFinite(Number(p.failed)) ? Number(p.failed) : 0;
      out.push(label("progress") + `${Number(p.position ?? p.passed)}/${Number(p.total)} ${p.unit === "files" ? "files" : "runs"} · ${Number(p.passed)} passed · ${failed} failed`);
    }
    return out.join("\n");
  }

  out.push(label("stage") + currentStageText(model));
  // Backlog #35d: use the run's table/folder name, never the bare uuid.
  out.push(label("run") + (current.dirName ?? current.id ?? "-"));
  const roleParts = [];
  if (current.role) roleParts.push(current.role);
  if (current.taskRef) roleParts.push(`task ${current.taskRef}`);
  if (current.model && current.model !== "-") roleParts.push(`model ${current.model}`);
  if (current.session) roleParts.push(current.session);
  if (roleParts.length) out.push(label("role") + roleParts.join(" · "));

  let status = "RUNNING";
  if (current.pid != null) {
    status += ` · pid ${current.pid} (alive)`;
  } else {
    const silenceMs = current.updatedAt && now ? Date.parse(now) - Date.parse(current.updatedAt) : null;
    if (Number.isFinite(silenceMs) && silenceMs >= 10 * 60 * 1000) {
      status += ` · ⚠ silent ${Math.floor(silenceMs / 60000)}m, no child process`;
    }
  }
  out.push(label("status") + status);

  const started = current.startedAt ? formatStamp(current.startedAt) : null;
  const elapsed = elapsedSince(current.startedAt, now);
  const prep = prepSnapshotClock(current);
  out.push(label("started") + (started || "-") + (elapsed ? ` · elapsed ${elapsed}` : "") + (prep ? ` (pre-run snapshot ${prep})` : ""));

  if (current.updatedAt) {
    const ago = agoText(current.updatedAt, now);
    out.push(label("last activity") + formatStamp(current.updatedAt) + (ago ? ` (${ago})` : ""));
  }

  const usageParts = [];
  const price = priceCell(current);
  const cap = capForRole(model, current.role);
  if (price && price !== "-") usageParts.push(`${price}${cap ? ` of ${formatTokens(cap)} cap` : ""}`);
  const context = contextCell(current);
  if (context && context !== "-") usageParts.push(`context ${context}`);
  const turns = turnsCell(current);
  if (turns && turns !== "-") usageParts.push(`${turns} turns`);
  out.push(label("usage so far") + (usageParts.length ? usageParts.join(" · ") : "usage not recorded"));
  return out.join("\n");
}

// `=== LIVE PROGRESS (last 10 actions) ===` (watcher.md rule 6): one decoded
// `<stamp>  <KIND>  <summary>` line each; raw JSON and streaming noise never
// appear (dropped in `decodeLiveProgress`). Omitted when there is no feed.
export function renderLiveProgress(model) {
  const entries = Array.isArray(model?.liveProgress) ? model.liveProgress : [];
  // While a run is live the section is always shown (backlog #6c): an empty
  // feed reads "waiting for the first action" rather than being omitted.
  const live = model?.status === "RUNNING" && Boolean(model?.current);
  if (!entries.length && !live) return "";
  const out = ["=== LIVE PROGRESS (last 10 actions) ==="];
  if (!entries.length) {
    out.push("waiting for the first action");
    return out.join("\n");
  }
  const kindWidth = Math.max(8, ...entries.map((e) => String(e.kind ?? "").length + 1));
  for (const e of entries) {
    const stamp = e.at ? formatStamp(e.at) : "-";
    const kind = String(e.kind ?? "").padEnd(kindWidth);
    out.push(`${stamp}  ${kind}${e.text ?? ""}`);
  }
  return out.join("\n");
}

// The whole report. Tasks 1.5 append the current-run and live-progress sections.
export function renderReport(model, { stamp = null } = {}) {
  // Rule 7 (backlog #7): a stage section that has not started renders nothing
  // and is omitted, so a planning-stage report carries no IMPLEMENTATION or
  // FINAL REVIEW header.
  const stages = [
    renderPipelineState(model, { stamp }),
    renderPlanningStage(model),
    renderImplementationStage(model),
    renderFinalReviewStage(model),
  ].filter((section) => section && section.trim());
  const sections = [stages.join("\n\n")];
  const current = renderCurrentRun(model);
  if (current) sections.push("", current);
  const progress = renderLiveProgress(model);
  if (progress) sections.push("", progress);
  return sections.join("\n");
}
