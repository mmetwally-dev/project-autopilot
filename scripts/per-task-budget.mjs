// TASK-8 "Per-task invocation budget" — pure limit derivation and detection
// helpers (TASK-19 Phase 5 task 14).
//
// Pure module: no filesystem, process, or network access, and no clock reads.
// The orchestrator owns time and passes elapsed values in. The turn count and
// the redundant-verification detector are deliberately pure so they are
// unit-testable without a relay or an adapter.
//
// Scope note (recorded, not hidden): this module lands the limit DERIVATION,
// the orchestrator-side TURN COUNT, the TOKEN-CEILING evaluator, the
// CONTINUATION-ALLOWANCE ledger, and the redundant-verification DETECTOR as
// pure functions, plus the per-task wall-clock deadline wiring. Mid-stream
// enforcement lives in autopilot.mjs runRelay(), which evaluates these
// helpers against the live stream once per second and kills the child on
// breach: the redundant re-run detector itself is still observe-only.

// A real per-task budget, not a hang backstop. Strictly below the call
// backstop default so the intentional per-task deadline fires first; 60
// minutes fits a full gate run (~60-70 min) instead of cutting it short.
export const PER_TASK_TIMEOUT_DEFAULT_MS = 60 * 60 * 1000;
// Operator decision 2026-09-29: the defaults live HERE (code), not in config
// files; policy.per_task_max_turns / per_task_max_tokens /
// continuation_allowance in config only override them per project.
// Backlog #59(b) (operator decision 2026-10-10, test mission 048: same frozen
// plan, implementer max_turns 22 vs 30 vs 40): 30 cost 23% less priced than
// 22 (1,106K vs 1,440K; 2 cuts vs 3 — each cut re-reads the files uncached),
// 40 only 4% less again. 22 stays the legacy value the migration rewrites.
// Backlog #111: the implementer cap for paid models is 40 (≈33% headroom over
// the 30-turn sizing target); 30 is the previous default the migration upgrades.
export const PER_TASK_MAX_TURNS_DEFAULT = 40;
export const PREVIOUS_MAX_TURNS_DEFAULT = 30;
export const LEGACY_MAX_TURNS_DEFAULT = 22;
// Backlog #111: planner/reviewer sizing TARGET (guidance, never a limit),
// independent of the caps. policy.task_size_target_turns overrides it.
export const TASK_SIZE_TARGET_TURNS_DEFAULT = 30;
export function resolveTaskSizeTargetTurns(policy) {
  const raw = Number(policy?.task_size_target_turns);
  return Number.isInteger(raw) && raw > 0 ? raw : TASK_SIZE_TARGET_TURNS_DEFAULT;
}
export const TASK_SIZE_ANNOTATION = "size: cannot split";
// Planner wording: the concrete size rule (like SpecKit's one-action tasks),
// the top rule "task size wins over phase count", and the background turn
// figure. Contains no semicolon-sensitive pins; keeps the legacy phrases.
export function taskSizingRuleText(target = TASK_SIZE_TARGET_TURNS_DEFAULT) {
  return `Size every task as ONE concrete action that edits about ONE file (plus its own test file), and name the exact file path(s) in the task line — for example "T012 Create Entity1 model in scripts/models/entity1.mjs". A task that names more than 3 distinct changes or more than 2 files to edit (its test file excluded) is too big: split it into additional tasks. Task size wins over phase count — when a task breaks this size rule, ADD tasks or an extra phase rather than enlarging the task. A task that only runs tests is forbidden. One task still fits one implementer session of about ${target} implementer turns, but that is only the background figure, never a substitute for the concrete size rule. A task that genuinely cannot be split carries the annotation \`${TASK_SIZE_ANNOTATION} — <reason>\` on its line.`;
}
// Reviewer wording: FAIL the concrete size rule by counting changes/files in
// the task line (no turn estimate needed), with a concrete split proposed.
export function taskSizeReviewText(target = TASK_SIZE_TARGET_TURNS_DEFAULT) {
  return `FAIL a task that breaks the concrete size rule: count the distinct changes and the files to edit named in the task line — more than 3 distinct changes or more than 2 files to edit (its test file excluded) is oversized, and the line must name the exact file path(s) it edits. Cite the task id and propose the concrete split into additional tasks. Do not FAIL a task whose line carries the annotation \`${TASK_SIZE_ANNOTATION} — <reason>\` (accept it). About ${target} implementer turns is only a background figure — never FAIL a task on a turn estimate alone, and never FAIL a small task for being small.`;
}
// Hard backstop for ONE role call (not a mission timeout): a call that runs
// past this is killed and resumed/failed. 200 minutes leaves room for the
// longest gate (the verifier's 180-minute session deadline stays below it).
export const RELAY_TIMEOUT_DEFAULT_MS = 200 * 60 * 1000;
// Backlog 003#15: default ceiling on the per-turn context size
// (maxSingleTurnContext per invocation). Sized from mission evidence as a
// single-turn context ceiling (~180K), not a cumulative total: well-behaved
// turns stay far below it, bloated turns exceed it.
export const PER_TASK_MAX_TOKENS_DEFAULT = 180_000;
// Backlog 003#17: default continuation allowance per task (generations of a
// rolled-over task), independent of every failure budget. 5 continuations =
// 6 sessions in total per task.
export const CONTINUATION_ALLOWANCE_DEFAULT = 5;
// Backlog 003#15: dead-ends list bounds (entries per task scope). Rollover
// handoff entries carry ONE per-entry char limit (HANDOFF_MAX_CHARS_DEFAULT,
// overridable via policy.handoff_max_chars) instead of the four stacked cuts
// that used to amputate the resume point (500-char text cut, 1000-char entry
// cut, 1200-char record backstop, 500-char prompt cut). Reconstruction cost
// stays far below the ceiling by construction.
export const DEAD_ENDS_MAX_ENTRIES = 5;
// Backlog #22 (TASK-32): the single per-entry handoff limit. The default
// lives HERE (code), not in config files; policy.handoff_max_chars in config
// only overrides it per project (same pattern as per_task_max_turns /
// per_task_max_tokens). Floor 500: below that the digest's protected
// sections ("Edits made", "Last agent text") cannot both survive.
export const HANDOFF_MAX_CHARS_DEFAULT = 2000;
export const HANDOFF_MIN_CHARS = 500;
// Backlog #26 Step A (TASK-33): hand-off note limit. One note per task
// (~60 lines, ~1K tokens): what the capped session LEARNED, not just what it
// read — the digest (TASK-32) lists activity, the note carries conclusions.
// The default lives HERE (code), not in config files;
// policy.handoff_note_max_chars in config only overrides it per project
// (same pattern as handoff_max_chars). Floor 1000: below that the four
// note sections (Done/Found/Next/Dead ends) cannot all fit.
export const HANDOFF_NOTE_MAX_CHARS_DEFAULT = 4000;
export const HANDOFF_NOTE_MIN_CHARS = 1000;
// Backlog #34c (mission 027 Phase 2 task 2.1): in-session hand-off note
// freshness window. A note counts as fresh only while it is newer than the
// last project edit AND recent (written within this window). Default 5 min:
// long enough to cover the cap/wrap-up trigger path, short enough that a
// note from an earlier generation never reads as current. Bounded above by
// HANDOFF_NOTE_FRESHNESS_WINDOW_MAX_MS so a caller cannot pass an unbounded
// window; invalid values fall back to the default (stale, never fresh, on
// bad input — same degrade-to-stale contract as the time checks below).
export const HANDOFF_NOTE_FRESHNESS_WINDOW_MS = 5 * 60 * 1000;
export const HANDOFF_NOTE_FRESHNESS_WINDOW_MAX_MS = 15 * 60 * 1000;

// Per-role cap defaults (mission 031 Phase 1 task 1.1; mission 044 Phase 1
// task 1.3: per-turn context ceilings, not cumulative totals).
// Each role gets its own turn/token/session limits; review roles share
// the same baseline but can be overridden via policy.caps in config.
export const PER_ROLE_CAPS_DEFAULT = {
  // Backlog #59(b): planner raised with the implementer (operator decision
  // 2026-10-10; rarely reaches the limit, and a cut re-reads uncached).
  planner: {maxTurns: 30, maxTokens: 200_000, extraSessions: 2},
  plan_reviewer: {maxTurns: 30, maxTokens: 150_000, extraSessions: 2},
  code_reviewer: {maxTurns: 22, maxTokens: 150_000, extraSessions: 2},
  // Backlog #59(b): the verifier was cut at 22 in test mission 048 trial 3
  // and re-ran in full (392K priced) — raised with the implementer.
  verifier: {maxTurns: 30, maxTokens: 150_000, extraSessions: 2},
};

// Per-role wrap-up token thresholds (mission 031 Phase 1 task 1.1; mission
// 044 Phase 1 task 1.3: per-turn values).
// Must be strictly below the role's maxTokens so wrap-up can fire before the cap.
// Non-planner review roles use 135K (~one turn headroom below 150K);
// planner uses 180K (~one turn headroom below 200K).
export const PER_ROLE_WRAPUP_TOKENS_DEFAULT = {
  planner: 180_000,
  plan_reviewer: 135_000,
  code_reviewer: 135_000,
  verifier: 135_000,
};

// Setup's policy.caps merge (mission 031 task 1.5), kept here so it is
// importable without running setup.mjs. Each review role gets the defaults
// in config (snake_case) form; operator-set fields win per field, and entries
// for any other key are kept untouched. Mission 044 Phase 1 task 1.4:
// values equal to the shipped cumulative defaults (planner 1M/950K, other
// review roles 500K/450K) are treated as untouched and rewritten to the new
// per-turn defaults; any other operator value is preserved.
const LEGACY_CUMULATIVE_CAPS = {
  planner: {max_tokens: 1_000_000, wrap_up_tokens_threshold: 950_000},
  plan_reviewer: {max_tokens: 500_000, wrap_up_tokens_threshold: 450_000},
  code_reviewer: {max_tokens: 500_000, wrap_up_tokens_threshold: 450_000},
  verifier: {max_tokens: 500_000, wrap_up_tokens_threshold: 450_000},
};
export function mergeRoleCaps(existingCaps = {}) {
  const caps = {...existingCaps};
  for (const [role, defaults] of Object.entries(PER_ROLE_CAPS_DEFAULT)) {
    const existing = {...(existingCaps[role] || {})};
    const legacy = LEGACY_CUMULATIVE_CAPS[role];
    if (legacy && existing.max_tokens === legacy.max_tokens) delete existing.max_tokens;
    if (legacy && existing.wrap_up_tokens_threshold === legacy.wrap_up_tokens_threshold) delete existing.wrap_up_tokens_threshold;
    // Backlog #59(b): a shipped 22 on a role whose default moved is untouched.
    if (existing.max_turns === LEGACY_MAX_TURNS_DEFAULT && defaults.maxTurns !== LEGACY_MAX_TURNS_DEFAULT) delete existing.max_turns;
    caps[role] = {
      max_turns: defaults.maxTurns,
      max_tokens: defaults.maxTokens,
      extra_sessions: defaults.extraSessions,
      wrap_up_tokens_threshold: PER_ROLE_WRAPUP_TOKENS_DEFAULT[role],
      ...existing
    };
  }
  return caps;
}

// Backlog #34c (mission 027 Phase 2 task 2.1): pure hand-off note freshness
// check. Pure by construction: no filesystem, process, network, or clock
// reads — the caller stats the note file and the project tree and passes the
// millisecond timestamps in. Returns {fresh, reason}: fresh is true ONLY for
// a non-empty note newer than the last project edit within the bounded
// staleness window; every missing/empty/unreadable/skewed input falls back
// to {fresh:false} with a stale reason, never a throw.
//
// Fields:
//   - noteText: note file content (null/undefined/non-string => stale).
//   - noteMtimeMs: note file mtime in epoch ms.
//   - lastProjectEditMtimeMs: newest project-file mtime in epoch ms
//     (null/undefined/non-finite => stale: freshness is undefined without it).
//   - nowMs: orchestrator clock in epoch ms.
//   - freshnessWindowMs: staleness window; absent/invalid falls back to the
//     default, oversized values clamp to the max (still bounded).
// Reasons: "fresh" | "missing_note" | "empty_note" | "missing_time" |
// "unreadable_time" | "clock_skew" | "note_not_newer_than_project_edit" |
// "stale_note".
export function isHandoffNoteFresh({
  noteText, noteMtimeMs, lastProjectEditMtimeMs, nowMs, freshnessWindowMs = HANDOFF_NOTE_FRESHNESS_WINDOW_MS,
} = {}) {
  if (noteText === null || noteText === undefined) return {fresh: false, reason: "missing_note"};
  if (typeof noteText !== "string") return {fresh: false, reason: "missing_note"};
  if (!noteText.trim()) return {fresh: false, reason: "empty_note"};
  if (noteMtimeMs === null || noteMtimeMs === undefined
    || lastProjectEditMtimeMs === null || lastProjectEditMtimeMs === undefined
    || nowMs === null || nowMs === undefined) {
    return {fresh: false, reason: "missing_time"};
  }
  const noteMtime = Number(noteMtimeMs);
  const lastEdit = Number(lastProjectEditMtimeMs);
  const now = Number(nowMs);
  if (!Number.isFinite(noteMtime) || !Number.isFinite(lastEdit) || !Number.isFinite(now)) {
    return {fresh: false, reason: "unreadable_time"};
  }
  let window = Number(freshnessWindowMs);
  if (!Number.isFinite(window) || window <= 0) window = HANDOFF_NOTE_FRESHNESS_WINDOW_MS;
  if (window > HANDOFF_NOTE_FRESHNESS_WINDOW_MAX_MS) window = HANDOFF_NOTE_FRESHNESS_WINDOW_MAX_MS;
  // Skewed clocks (or garbage epochs) can never read as fresh: a note or a
  // project edit dated after "now" means the timestamps are untrustworthy.
  if (noteMtime > now || lastEdit > now) return {fresh: false, reason: "clock_skew"};
  // The note must be strictly newer than the last project edit: an edit made
  // after the note was written invalidates whatever the note concluded.
  if (!(noteMtime > lastEdit)) return {fresh: false, reason: "note_not_newer_than_project_edit"};
  if (now - noteMtime > window) return {fresh: false, reason: "stale_note"};
  return {fresh: true, reason: "fresh"};
}
// Backlog #26 Step B (TASK-34): orchestrator-forced hand-off wrap-up. At a
// FIXED raw token threshold (same raw growing term `growingTerm()` the cap
// measures — cacheRead + input, NOT the price-weighted figure the watch
// report prices), the orchestrator stops the session and resumes the SAME
// session for one wrap-up turn that writes the note. Default 690K: ~one
// turn of headroom below the 750K cap. Operator decision 2026-09-29: a
// turn percentage is meaningless (690K can be 18, 20 or 24 turns), so the
// trigger is a fixed token count. Lives HERE (code);
// policy.handoff_wrapup_tokens only overrides it per project. Must be a
// positive integer strictly below the effective per-task token ceiling, or
// the wrap-up could never fire before the cap.
export const HANDOFF_WRAPUP_TOKENS_DEFAULT = 160_000;
// Wrap-up turn's own ceiling: exempt from the per-task cap, but bounded
// itself — max turns and wall-clock timeout for the resumed wrap-up relay.
export const WRAPUP_MAX_TURNS = 3;
export const WRAPUP_TIMEOUT_MS = 3 * 60 * 1000;
// Session stores hold full transcripts: warn in the run record above this.
export const SESSION_STORE_WARN_BYTES = 50 * 1024 * 1024;
// Backlog #41 (TASK-35): idle-hang watchdog. A session that produces no
// output, runs no child process, and writes no file for this long is a true
// hang (mission 024 runs 98/99 waited the full 60-min per-task timeout on a
// rate-limited opencode that retried silently). Default 10 min: long enough
// that a legitimately quiet stretch (model thinking between tool calls still
// emits stream events, so true silence is rare) never trips it, short enough
// to save ~50 min per hang. Lives HERE (code);
// policy.idle_hang_ms only overrides it per project. 0 disables the
// watchdog. Must be a non-negative integer strictly below the effective
// per-task deadline, or the deadline (not the watchdog) owns the session.
export const IDLE_HANG_MS_DEFAULT = 600_000;

// Backlog #41 (TASK-35): resolve the effective idle-hang limit. Absent or
// invalid means the code default, never "watchdog off by accident"; an
// explicit 0 is the only off switch. Defensive clamp: a value at or above
// the per-task deadline can never fire first, so it degrades to off rather
// than to a watchdog that silently never trips (config validation rejects
// such values at load; this covers hand-edited or programmatically built
// policies that bypass validation).
// First-output deadline: a run that has produced NO output at all since
// start (0 bytes stdout/stderr) is judged against this shorter limit instead
// of idleHangMs (mission 089: a silent opencode model burned 10 min twice).
// policy.first_output_ms overrides; 0 disables (idle_hang_ms alone applies).
// The result is clamped to idleHangMs (a longer first-output limit would be
// meaningless) and is 0 when the idle watchdog itself is off.
export const FIRST_OUTPUT_MS_DEFAULT = 180_000;

export function resolveFirstOutputMs(policy = {}, idleHangMs = IDLE_HANG_MS_DEFAULT) {
  const idle = Number(idleHangMs);
  if (!(idle > 0)) return 0;
  const raw = policy?.first_output_ms;
  if (raw == null) return Math.min(FIRST_OUTPUT_MS_DEFAULT, idle);
  const num = Number(raw);
  if (num === 0) return 0;
  if (!Number.isInteger(num) || num < 0) return Math.min(FIRST_OUTPUT_MS_DEFAULT, idle);
  return Math.min(num, idle);
}

// Backlog #104: absolute silence cap (no stream byte, no file write) that
// holds even while a tool child process is alive. policy.max_silence_ms
// overrides; 0 disables. Always at least idleHangMs; 0 when idle watch is off.
export const MAX_SILENCE_MS_DEFAULT = 900_000;

// The DEFAULT cap is never shorter than the role's own per-run deadline
// (deadlineMs): a read-only verifier legitimately running one long test
// (opencode emits tool_use only when the tool finishes) must not be killed
// before its deadline. An explicit policy.max_silence_ms is the operator's
// choice and is honored (floored at idleHangMs).
export function resolveMaxSilenceMs(policy = {}, idleHangMs = IDLE_HANG_MS_DEFAULT, deadlineMs = 0) {
  const idle = Number(idleHangMs);
  if (!(idle > 0)) return 0;
  const raw = policy?.max_silence_ms;
  const dflt = Math.max(MAX_SILENCE_MS_DEFAULT, idle, Number(deadlineMs) > 0 ? Number(deadlineMs) : 0);
  if (raw == null) return dflt;
  const num = Number(raw);
  if (num === 0) return 0;
  if (!Number.isInteger(num) || num < 0) return dflt;
  return Math.max(num, idle);
}

export function resolveIdleHangMs(policy = {}, perTaskTimeoutMs = PER_TASK_TIMEOUT_DEFAULT_MS) {
  const deadline = Number(perTaskTimeoutMs) > 0 ? Number(perTaskTimeoutMs) : PER_TASK_TIMEOUT_DEFAULT_MS;
  const raw = policy?.idle_hang_ms;
  if (raw == null) {
    const fit = Math.min(IDLE_HANG_MS_DEFAULT, deadline - 1);
    return fit > 0 ? fit : 0;
  }
  const num = Number(raw);
  if (num === 0) return 0;
  if (!Number.isInteger(num) || num < 0) return IDLE_HANG_MS_DEFAULT;
  if (num >= deadline) return 0;
  return num;
}

// The default is derived as min(PER_TASK_TIMEOUT_DEFAULT_MS, relayTimeoutMs - 1)
// rather than a bare constant, so a project that lowers relay_timeout_ms below
// the one-hour per-task default degrades to a slightly smaller per-task
// deadline instead of failing config load.
export function resolvePerTaskLimits(policy = {}, relayTimeoutMs = RELAY_TIMEOUT_DEFAULT_MS) {
  const relay = Number(relayTimeoutMs) > 0 ? Number(relayTimeoutMs) : RELAY_TIMEOUT_DEFAULT_MS;
  const rawTimeout = Number(policy?.per_task_timeout_ms);
  const perTaskTimeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0
    ? rawTimeout
    : Math.min(PER_TASK_TIMEOUT_DEFAULT_MS, relay - 1);
  const rawTurns = Number(policy?.per_task_max_turns);
  const perTaskMaxTurns = Number.isInteger(rawTurns) && rawTurns > 0
    ? rawTurns
    : PER_TASK_MAX_TURNS_DEFAULT;
  const rawTokens = Number(policy?.per_task_max_tokens);
  const perTaskMaxTokens = Number.isInteger(rawTokens) && rawTokens > 0
    ? rawTokens
    : PER_TASK_MAX_TOKENS_DEFAULT;
  return {perTaskTimeoutMs, perTaskMaxTurns, perTaskMaxTokens, relayTimeoutMs: relay};
}

// Orchestrator-side turn count from the event stream `adapter-drivers.mjs`
// already parses. One opencode `step_finish` is one turn; one claude
// `assistant` event is its equivalent; one agy `agent_response` step_update is
// one turn (distinct step_index, so ACTIVE text_delta fragments never each
// count), unless the terminal result carries num_turns — the CLI's own
// cumulative count, which is authoritative when present. Returns `null` for
// any adapter whose stream carries no per-turn event (codex today) or for a
// stream that emitted no turn at all — an absent measurement must never read
// as "zero turns", because that would silently disable the cap rather than
// leave the deadline as the only control.
export function countTurns(adapterId, events) {
  if (adapterId !== "opencode" && adapterId !== "claude" && adapterId !== "antigravity") return null;
  const list = Array.isArray(events) ? events : [];
  if (adapterId === "antigravity") return countAgyTurns(list);
  let turns = 0;
  for (const event of list) {
    const part = event?.part || {};
    const type = String(event?.type || part.type || "");
    if (adapterId === "opencode") {
      if (type === "step_finish" || type === "step-finish") turns += 1;
    } else if (event?.type === "assistant") {
      turns += 1;
    }
  }
  return turns;
}

// agy's terminal result event reports num_turns CUMULATIVE over the session
// (per the headless docs), so it supersedes the per-step count whenever it is
// present and positive. Without it, distinct agent_response step_index values
// are the count. Zero measured steps with no terminal result is an absent
// measurement: null, never 0.
function countAgyTurns(events) {
  let terminalTurns = null;
  const seenSteps = new Set();
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const result = event.result;
    if (result && typeof result === "object") {
      const num = Number(result.num_turns);
      if (Number.isFinite(num) && num > 0) terminalTurns = num;
    }
    const step = event.step_update;
    if (!step || typeof step !== "object" || String(step.step_type || "") !== "agent_response") continue;
    const key = step.step_index != null ? `step-${step.step_index}` : `anonymous-${seenSteps.size}`;
    seenSteps.add(key);
  }
  if (terminalTurns != null) return terminalTurns;
  return seenSteps.size > 0 ? seenSteps.size : null;
}

// Whether a per-turn cap is enforceable for this adapter at all. Kept explicit
// so callers can document the gap instead of implying a cap that does not
// apply.
export function supportsTurnCount(adapterId) {
  return adapterId === "opencode" || adapterId === "claude" || adapterId === "antigravity";
}

export function evaluateTaskBudget({adapterId, turns, maxTurns} = {}) {
  if (!supportsTurnCount(adapterId)) return {exceeded: false, enforceable: false, reason: "adapter_has_no_turn_event"};
  if (!Number.isInteger(turns)) return {exceeded: false, enforceable: false, reason: "turn_count_unavailable"};
  if (!Number.isInteger(maxTurns) || maxTurns <= 0) return {exceeded: false, enforceable: false, reason: "no_turn_limit_configured"};
  return {exceeded: turns > maxTurns, enforceable: true, turns, maxTurns};
}

// Backlog 003#15: the per-turn context size is maxSingleTurnContext (the
// largest single-turn input+cacheRead+cacheCreation). Output does not
// accumulate across turns (each turn's output is new), but every turn
// re-transmits the growing context as cache-read, so the per-turn context
// is the term that goes quadratic with turn count. `usage` is an
// accumulateUsage() result (or compatible shape); a null/absent usage is
// never a zero reading. When maxSingleTurnContext is absent (legacy usage
// shapes), fall back to cacheRead + input + cacheCreation (missing
// cacheCreation counts as 0).
export function growingTerm(usage) {
  if (!usage || typeof usage !== "object") return null;
  const perTurn = Number(usage.maxSingleTurnContext);
  if (Number.isFinite(perTurn)) return perTurn;
  const cacheRead = Number(usage.cacheRead);
  const input = Number(usage.input);
  if (!Number.isFinite(cacheRead) || !Number.isFinite(input)) return null;
  const rawCreation = usage.cacheCreation ?? usage.cache_creation ?? 0;
  const cacheCreation = Number(rawCreation);
  if (!Number.isFinite(cacheCreation)) return null;
  return cacheRead + input + cacheCreation;
}

export function evaluateTokenCeiling({usage, maxTokens} = {}) {
  const growing = growingTerm(usage);
  if (growing === null) return {exceeded: false, enforceable: false, reason: "usage_unavailable"};
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) return {exceeded: false, enforceable: false, reason: "no_token_limit_configured"};
  return {exceeded: growing > maxTokens, enforceable: true, growing, maxTokens};
}

// Backlog 003#15/003#16: the single breach decision runRelay()'s monitor
// evaluates (unit-testable here because runRelay itself runs main() on
// import and cannot be unit-driven). Turns are checked first: a runaway
// that also burns tokens reports the turn breach, which names the tighter
// of the two violated bounds. Returns the breach record or null.
export function checkCapBreach({usage, perTaskMaxTurns, perTaskMaxTokens} = {}) {
  if (!usage || typeof usage !== "object") return null;
  if (Number.isInteger(usage.turns) && Number.isInteger(perTaskMaxTurns) && perTaskMaxTurns > 0 && usage.turns > perTaskMaxTurns) {
    return {type: "turns", used: usage.turns, limit: perTaskMaxTurns, usage};
  }
  const ceiling = evaluateTokenCeiling({usage, maxTokens: perTaskMaxTokens});
  if (ceiling.exceeded) return {type: "tokens", used: ceiling.growing, limit: ceiling.maxTokens, usage};
  return null;
}

// Mission 093 Part 1 task 1.4: shared unit label for cap-breach log sites.
// Turns-cap breaches name turns; token caps and any other/unknown type name
// raw context tokens. Pure: string in, string out, no I/O.
export function capUnitLabel(type) {
  if (type === "turns") return "turns";
  return "raw context tokens";
}

// Backlog #34d (mission 027 Phase 3 task 3.1): end-of-task grace window.
// A cap breach while the session is demonstrably finishing (its linked task
// verify already passed, or it is writing the final task-result line) defers
// the kill for a small bounded window instead of capping mid-write. Bounds:
// at most CAP_GRACE_MAX_EXTRA_TURNS extra turns past the per-task turn cap
// and +10% tokens past the per-task token ceiling (CAP_GRACE_EXTRA_TOKEN_RATIO),
// one window per generation (the caller passes graceUsed and sets it once
// granted). Pure by construction: all inputs passed in, never throws —
// ambiguous input is ineligible, never granted.
export const CAP_GRACE_MAX_EXTRA_TURNS = 3;
export const CAP_GRACE_EXTRA_TOKEN_RATIO = 0.10;

// Grace token ceiling for a per-task token cap: ceil(max * 1.10). Returns
// null for an absent/invalid cap (the caller then reports no_cap_configured).
export function capGraceTokenCeiling(perTaskMaxTokens) {
  const max = Number(perTaskMaxTokens);
  if (!Number.isInteger(max) || max <= 0) return null;
  return Math.ceil(max * (1 + CAP_GRACE_EXTRA_TOKEN_RATIO));
}

// Grace decision. Fields:
//   - verifyPassed: strict boolean — the linked task verify already passed.
//   - writingFinalResult: strict boolean — the final task-result line is
//     being written now.
//   - graceUsed: strict boolean — a grace window already opened this
//     generation (one window per generation).
//   - turnsUsed / perTaskMaxTurns: integer turn count vs the per-task cap.
//   - tokensUsed / perTaskMaxTokens: raw growing-term tokens vs the cap.
// Returns {granted, reason, turnCeiling, tokenCeiling}. granted is true ONLY
// for positive finishing evidence within both bounds on a fresh window.
// Reasons: "finishing_within_grace" | "no_finishing_evidence" |
// "ambiguous_input" | "no_cap_configured" | "grace_already_used" |
// "grace_turns_exceeded" | "grace_tokens_exceeded".
export function evaluateCapGraceWindow({
  verifyPassed, writingFinalResult, graceUsed,
  turnsUsed, perTaskMaxTurns, tokensUsed, perTaskMaxTokens,
} = {}) {
  const maxTurns = Number(perTaskMaxTurns);
  const maxTokens = Number(perTaskMaxTokens);
  if (!Number.isInteger(maxTurns) || maxTurns <= 0 || !Number.isInteger(maxTokens) || maxTokens <= 0) {
    return {granted: false, reason: "no_cap_configured", turnCeiling: null, tokenCeiling: null};
  }
  const turns = Number(turnsUsed);
  const tokens = Number(tokensUsed);
  if (!Number.isInteger(turns) || turns < 0 || !Number.isFinite(tokens) || tokens < 0) {
    return {granted: false, reason: "ambiguous_input", turnCeiling: null, tokenCeiling: null};
  }
  // Positive finishing evidence requires a strict boolean true. Non-boolean,
  // non-nullish values (1, "yes", {}) are ambiguous — never evidence.
  const evidenceFields = [verifyPassed, writingFinalResult];
  for (const v of evidenceFields) {
    if (v !== undefined && v !== null && typeof v !== "boolean") {
      return {granted: false, reason: "ambiguous_input", turnCeiling: null, tokenCeiling: null};
    }
  }
  if (verifyPassed !== true && writingFinalResult !== true) {
    return {granted: false, reason: "no_finishing_evidence", turnCeiling: null, tokenCeiling: null};
  }
  if (graceUsed !== undefined && graceUsed !== null && typeof graceUsed !== "boolean") {
    return {granted: false, reason: "ambiguous_input", turnCeiling: null, tokenCeiling: null};
  }
  if (graceUsed === true) {
    return {granted: false, reason: "grace_already_used", turnCeiling: null, tokenCeiling: null};
  }
  const turnCeiling = maxTurns + CAP_GRACE_MAX_EXTRA_TURNS;
  const tokenCeiling = capGraceTokenCeiling(maxTokens);
  if (turns > turnCeiling) {
    return {granted: false, reason: "grace_turns_exceeded", turnCeiling, tokenCeiling};
  }
  if (tokens > tokenCeiling) {
    return {granted: false, reason: "grace_tokens_exceeded", turnCeiling, tokenCeiling};
  }
  return {granted: true, reason: "finishing_within_grace", turnCeiling, tokenCeiling};
}

// Backlog 003#17: continuation allowance, independent of every failure
// budget by construction — it lives in state.continuationBudgets, never in
// state.failureBudgets, so `ap reset`, stale-budget cleanup, and budget
// escalation can neither see nor touch it. One generation consumed per
// rolled-over relaunch; exhaustion escalates as "task not converging".
export function resolveContinuationAllowance(policy = {}) {
  const raw = Number(policy?.continuation_allowance);
  return Number.isInteger(raw) && raw > 0 ? raw : CONTINUATION_ALLOWANCE_DEFAULT;
}

// The continuation ledger key prefix. Exported so `ap reset` (TASK-33) can
// accept and resolve continuation targets with the same vocabulary the loops
// record: the full key, the scope without the prefix, or the bare task id.
export const CONTINUATION_BUDGET_KEY_PREFIX = "continuationAllowance:";
export function continuationBudgetKey(scope) {
  return `${CONTINUATION_BUDGET_KEY_PREFIX}${String(scope ?? "")}`;
}
function continuationKey(scope) {
  return continuationBudgetKey(scope);
}

// Mission 093 Part 1 task 2.3: the run scope's session number — its
// continuation-budget used count at launch + 1, so the first session of a
// scope is 1, the first continuation 2, and so on. Null when the run owns no
// continuation scope (never fabricated: a missing/non-integer ledger entry
// reads as used 0, never as a guess about other scopes).
export function resolveSessionNumber(state, scope) {
  if (typeof scope !== "string" || scope === "") return null;
  const budgets = state?.continuationBudgets;
  const raw = budgets && typeof budgets === "object" ? budgets[continuationBudgetKey(scope)] : undefined;
  const used = Number.isInteger(raw) && raw >= 0 ? raw : 0;
  return used + 1;
}

// Backlog #26 Step A (TASK-33): operator override for the hand-off note
// limit. Absent/invalid means the code default, never "unbounded".
export function resolveHandoffNoteMaxChars(policy = {}) {
  const raw = Number(policy?.handoff_note_max_chars);
  if (Number.isInteger(raw) && raw >= HANDOFF_NOTE_MIN_CHARS) return raw;
  return HANDOFF_NOTE_MAX_CHARS_DEFAULT;
}

// Backlog #26 Step B (TASK-34): operator override for the forced wrap-up
// token threshold. Absent/invalid means the code default. A value >= the
// effective token ceiling is rejected (returns the default) so the wrap-up
// can always fire before the cap; callers that need to distinguish
// "operator set an unusable value" use config validation instead.
export function resolveHandoffWrapupTokens(policy = {}, perTaskMaxTokens = PER_TASK_MAX_TOKENS_DEFAULT) {
  const ceiling = Number.isInteger(Number(perTaskMaxTokens)) && Number(perTaskMaxTokens) > 0
    ? Number(perTaskMaxTokens)
    : PER_TASK_MAX_TOKENS_DEFAULT;
  const raw = Number(policy?.handoff_wrapup_tokens);
  if (Number.isInteger(raw) && raw > 0 && raw < ceiling) return raw;
  return HANDOFF_WRAPUP_TOKENS_DEFAULT < ceiling ? HANDOFF_WRAPUP_TOKENS_DEFAULT : ceiling - 1;
}

// Mission 031 Phase 1 task 1.2: resolve per-role limits for turn/token/continuation/wrap-up.
// Uses PER_ROLE_CAPS_DEFAULT for review roles (planner, plan_reviewer, code_reviewer, verifier)
// and existing constants for implementer/unknown. Config overrides via policy.caps.<role>.
// For implementer, also honors policy.per_task_max_turns / per_task_max_tokens as fallbacks.
// wrapUpTokenThreshold from PER_ROLE_WRAPUP_TOKENS_DEFAULT or policy.caps.<role>.wrap_up_tokens_threshold.
import {isFreeModel} from "./free-model.mjs";
export const FREE_MODEL_TURNS_CAP_DEFAULT = 45;
// Backlog #101: policy.free_model_turns_cap (default 45; 0 or explicit null = off).
export function resolveFreeModelTurnsCap(policy = {}) {
  const raw = policy?.free_model_turns_cap;
  if (raw === undefined) return FREE_MODEL_TURNS_CAP_DEFAULT;
  const n = Number(raw);
  return raw !== null && Number.isInteger(n) && n > 0 ? n : 0;
}
// Turns cap for a run: an opencode *-free effective model gets max(normal, free cap).
export function applyFreeModelTurnsCap(normalCap, policy = {}, effective = {}) {
  // `effective` = {adapter, model, free_model_pattern} (pattern from the adapter's agents.json entry).
  if (!isFreeModel(effective, effective?.model)) return normalCap;
  return Math.max(normalCap, resolveFreeModelTurnsCap(policy));
}
export function resolvePerRoleLimits(roleName, policy = {}, effective = {}) {
  const role = String(roleName ?? "").toLowerCase();
  const caps = policy?.caps?.[role];
  const isReviewRole = ["planner", "plan_reviewer", "code_reviewer", "verifier"].includes(role);
  const isImplementer = role === "implementer";
  const defaultCaps = PER_ROLE_CAPS_DEFAULT[role] ?? {
    maxTurns: PER_TASK_MAX_TURNS_DEFAULT,
    maxTokens: PER_TASK_MAX_TOKENS_DEFAULT,
    extraSessions: CONTINUATION_ALLOWANCE_DEFAULT,
  };
  // For implementer, policy.per_task_max_turns / per_task_max_tokens are the primary
  // operator-facing overrides (same keys resolvePerTaskLimits uses). policy.caps.implementer
  // is not written by setup/migration, so fall back to the per-task keys when absent.
  // Coerce with Number() first (config values may be strings), like resolvePerTaskLimits does.
  const rawTurns = isImplementer ? Number(policy?.per_task_max_turns) : NaN;
  const rawTokens = isImplementer ? Number(policy?.per_task_max_tokens) : NaN;
  const policyTurns = isImplementer && Number.isInteger(rawTurns) && rawTurns > 0 ? rawTurns : undefined;
  const policyTokens = isImplementer && Number.isInteger(rawTokens) && rawTokens > 0 ? rawTokens : undefined;
  const baseTurns = (caps?.max_turns !== undefined && Number.isInteger(caps.max_turns) && caps.max_turns > 0)
    ? caps.max_turns
    : (policyTurns !== undefined ? policyTurns : defaultCaps.maxTurns);
  const maxTurns = applyFreeModelTurnsCap(baseTurns, policy, effective);
  const maxTokens = (caps?.max_tokens !== undefined && Number.isInteger(caps.max_tokens) && caps.max_tokens > 0)
    ? caps.max_tokens
    : (policyTokens !== undefined ? policyTokens : defaultCaps.maxTokens);
  const continuationAllowance = (caps?.extra_sessions !== undefined && Number.isInteger(caps.extra_sessions) && caps.extra_sessions >= 0)
    ? caps.extra_sessions
    : defaultCaps.extraSessions;
  const defaultWrapup = PER_ROLE_WRAPUP_TOKENS_DEFAULT[role] ?? HANDOFF_WRAPUP_TOKENS_DEFAULT;
  const wrapUpTokenThreshold = (caps?.wrap_up_tokens_threshold !== undefined && Number.isInteger(caps.wrap_up_tokens_threshold) && caps.wrap_up_tokens_threshold > 0 && caps.wrap_up_tokens_threshold < maxTokens)
    ? caps.wrap_up_tokens_threshold
    : (defaultWrapup < maxTokens ? defaultWrapup : maxTokens - 1);
  return {perTaskMaxTurns: maxTurns, perTaskMaxTokens: maxTokens, continuationAllowance, wrapUpTokenThreshold};
}

// Implementer fallback (not in PER_ROLE_CAPS_DEFAULT) — used when role is "implementer" or unknown.
// Handled directly in resolvePerRoleLimits using PER_TASK_* constants; not added to PER_ROLE_CAPS_DEFAULT.

// Backlog #26 Step B (TASK-34): the wrap-up trigger runRelay()'s monitor
// evaluates BEFORE the hard cap. Same raw measure the cap uses
// (`growingTerm()`: cacheRead + input — never the price-weighted figure):
//   - tokens: growing term reaches the wrap-up threshold (fixed 160K
//     default, ~one turn of headroom below the 180K cap);
//   - turns: a light session can hit the turn cap before 690K — then the
//     turn-cap breach itself is the wrap-up trigger (the wrap-up turn is
//     cap-exempt, so there is still room to write).
// Turns are checked first (same order as checkCapBreach). Returns the
// trigger record {type:'tokens'|'turns', used, limit} or null.
export function checkWrapupTrigger({usage, perTaskMaxTurns, perTaskMaxTokens, wrapupTokens} = {}) {
  if (!usage || typeof usage !== "object") return null;
  const maxTurns = Number.isInteger(perTaskMaxTurns) && perTaskMaxTurns > 0 ? perTaskMaxTurns : null;
  if (maxTurns !== null && Number.isInteger(usage.turns) && usage.turns > maxTurns) {
    return {type: "turns", used: usage.turns, limit: maxTurns};
  }
  const ceiling = Number.isInteger(Number(perTaskMaxTokens)) && Number(perTaskMaxTokens) > 0
    ? Number(perTaskMaxTokens)
    : PER_TASK_MAX_TOKENS_DEFAULT;
  const threshold = Number.isInteger(wrapupTokens) && wrapupTokens > 0 && wrapupTokens < ceiling
    ? wrapupTokens
    : (HANDOFF_WRAPUP_TOKENS_DEFAULT < ceiling ? HANDOFF_WRAPUP_TOKENS_DEFAULT : ceiling - 1);
  const growing = growingTerm(usage);
  if (growing === null) return null;
  if (growing >= threshold) return {type: "tokens", used: growing, limit: threshold};
  return null;
}

// Backlog #26 Step B (TASK-34): the wrap-up prompt. The ONLY message the
// resumed session receives: write the note now, do not continue the task,
// do not read more files. Fill path + limit at the call site.
export function buildWrapUpPrompt(noteRelPath, noteMaxChars) {
  const pathText = String(noteRelPath ?? "<note-path>");
  const limitText = String(noteMaxChars ?? HANDOFF_NOTE_MAX_CHARS_DEFAULT);
  return [
    "STOP — this session's budget is almost used up. Do NOT continue the task",
    `and do NOT read more files. Write your hand-off note NOW to ${pathText}`,
    `(overwrite it), max ${limitText} characters:`,
    "1. Done — files changed (names only).",
    "2. Found — facts the next session needs: exact file:line, function",
    "   names, how the code works there.",
    "3. Next — the exact next edit: file, line, what to change.",
    "4. Dead ends — what you tried that did not work, and why.",
    "Then stop.",
  ].join("\n");
}

// Backlog #26 Step B (TASK-34): persistent per-task session store.
// `.autopilot/missions/<mission>/sessions/<task-ref>/`, where <task-ref> is
// the task's display ref made filename-safe (same vocabulary as
// handoffNoteRelPath). Implementer relays only: the adapter's session store
// is bound here so it survives the relay process exit (today HOME is a
// tmpfs/scratch mount destroyed on exit). Under `.autopilot/` by
// construction, so the git snapshot/fingerprint exclusion (relay-guards.mjs:
// every `.autopilot/` path is filtered) covers it with no new rule.
export function sessionStoreRelDir(mission, taskRef) {
  const safe = String(taskRef ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "task";
  return `.autopilot/missions/${String(mission ?? "mission").replace(/\\/g, "/")}/sessions/${safe}`;
}

// Adapter session-store subpaths bound into the envelope (implementer
// only). Only the adapter's data dir is bound — never the whole HOME — so
// unrelated HOME contents (auth caches, other roles' sessions) stay out:
//   - opencode: ~/.local/share/opencode  (session store + prompt history)
//   - claude:   ~/.claude               (session store)
// Returns {sandboxSubpath} for the adapter, or null when the adapter has no
// persistent session store to bind (resume unsupported there anyway).
export function sessionStoreSandboxSubpath(adapterId) {
  if (adapterId === "opencode") return ".local/share/opencode";
  if (adapterId === "claude") return ".claude";
  return null;
}

// Backlog #26 Step A (TASK-33): one hand-off note per task.
// `.autopilot/missions/<mission>/handoff/<task-ref>.md`, where <task-ref> is
// the task's display ref (taskDisplayRef, e.g. T2.2), made filename-safe.
// One helper computes it; used by both per-task loops (read/delete the file)
// and the prompt builder (render the exact path). Repo-relative with forward
// slashes — the implementer runs with the repo root as cwd on every platform.
export function handoffNoteRelPath(mission, taskRef) {
  const safe = String(taskRef ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "task";
  return `.autopilot/missions/${String(mission ?? "mission").replace(/\\/g, "/")}/handoff/${safe}.md`;
}

// Backlog #22 (TASK-32): operator override for the single per-entry
// handoff limit. Absent/invalid means the code default, never "unbounded".
export function resolveHandoffMaxChars(policy = {}) {
  const raw = Number(policy?.handoff_max_chars);
  if (Number.isInteger(raw) && raw >= HANDOFF_MIN_CHARS) return raw;
  return HANDOFF_MAX_CHARS_DEFAULT;
}

export function consumeContinuation(state, policy, scope, continuationAllowance) {
  let limit;
  if (continuationAllowance !== undefined && continuationAllowance !== null) {
    if (typeof continuationAllowance === "number" && Number.isInteger(continuationAllowance) && continuationAllowance >= 0) {
      limit = continuationAllowance;
    } else if (typeof continuationAllowance === "string") {
      const roleLimits = resolvePerRoleLimits(continuationAllowance, policy);
      limit = roleLimits.continuationAllowance;
    } else {
      limit = resolveContinuationAllowance(policy);
    }
  } else {
    limit = resolveContinuationAllowance(policy);
  }
  const key = continuationKey(scope);
  state.continuationBudgets = state?.continuationBudgets && typeof state.continuationBudgets === "object"
    ? state.continuationBudgets
    : {};
  state.continuationBudgets[key] = (state.continuationBudgets[key] || 0) + 1;
  const used = state.continuationBudgets[key];
  return {allowed: used <= limit, used, limit, scope};
}

// Mission 031 Phase 1 task 1.2: resolve continuation allowance for a role.
// Review roles use their configured extraSessions (default 2), implementer/unknown uses the global default (5).
export function resolveContinuationAllowanceForRole(roleName, policy = {}) {
  const role = String(roleName ?? "").toLowerCase();
  const isReviewRole = ["planner", "plan_reviewer", "code_reviewer", "verifier"].includes(role);
  if (isReviewRole) {
    const roleLimits = resolvePerRoleLimits(role, policy);
    return roleLimits.continuationAllowance;
  }
  return resolveContinuationAllowance(policy);
}

export function clearTaskContinuation(state, scope) {
  clearNoProgress(state, scope);
  if (!state?.continuationBudgets || typeof state.continuationBudgets !== "object") return false;
  const key = continuationKey(scope);
  if (!(key in state.continuationBudgets)) return false;
  delete state.continuationBudgets[key];
  return true;
}

// Backlog #32: no-progress stop. A continuation generation that ends (capped
// or stopped early) without changing a single project file is a no-progress
// generation — the hand-off note/.autopilot writes do not count (they are not
// in the run's touchedFiles). N consecutive ones stop the task instead of
// burning the rest of the continuation allowance (mission 023 T2.3: 3 capped
// sessions, 0 edits, ~550K). Keyed like the continuation allowance; cleared
// with it (task completion, `ap reset` of the continuation).
export const NO_PROGRESS_GENERATIONS_DEFAULT = 2;
export function resolveNoProgressGenerations(policy = {}) {
  const raw = Number(policy?.no_progress_generations);
  if (Number.isInteger(raw) && raw >= 1) return raw;
  return NO_PROGRESS_GENERATIONS_DEFAULT;
}
// Mission 051 Phase 1 task 1.1: final-review fix rounds. A final-review FAIL
// spawns finding-fix tasks and re-reviews, up to this many fix rounds per
// mission run; exhaustion escalates instead of looping forever. Absent or
// invalid means the code default (2), never "no fix rounds".
export const FINAL_REVIEW_FIX_ROUNDS_DEFAULT = 2;
export function resolveFinalReviewFixRounds(policy = {}) {
  const raw = Number(policy?.final_review_fix_rounds);
  if (Number.isInteger(raw) && raw >= 1) return raw;
  return FINAL_REVIEW_FIX_ROUNDS_DEFAULT;
}
// Returns the consecutive no-progress count after recording this generation
// (0 when it edited). `touchedFiles` is the run's own list of changed project
// files.
export function recordGenerationProgress(state, scope, touchedFiles) {
  const key = continuationKey(scope);
  const edited = Array.isArray(touchedFiles) && touchedFiles.length > 0;
  state.noProgressGenerations = state?.noProgressGenerations && typeof state.noProgressGenerations === "object"
    ? state.noProgressGenerations
    : {};
  if (edited) { delete state.noProgressGenerations[key]; return 0; }
  state.noProgressGenerations[key] = (state.noProgressGenerations[key] || 0) + 1;
  return state.noProgressGenerations[key];
}
export function clearNoProgress(state, scope) {
  if (!state?.noProgressGenerations || typeof state.noProgressGenerations !== "object") return false;
  const key = continuationKey(scope);
  if (!(key in state.noProgressGenerations)) return false;
  delete state.noProgressGenerations[key];
  return true;
}

// Backlog #74 (mission 068 Phase 1 task 1.1): pure no-progress escalation
// helpers. stopOnNoProgress() in autopilot.mjs interpolated `task ${taskId}`
// directly, so every read-only site (taskId null: standalone/speckit
// reviewer, verifier, plan_reviewer) escalated as "task null". The display
// label below uses the real task id when present, else a phase/role label
// derived from taskRef — never "task null". Pure by construction: no role
// param, no filesystem/process/network/clock reads, never throws (ambiguous
// input degrades to a framework fallback label, never an empty throw).
//
// Label rules (first match wins):
//   - non-empty taskId (trimmed, stringified) => `task ${taskId}`.
//   - taskRef naming a planning scope (contains "planning", in either the
//     short 'standalone-planning-<role>' or the continuation-scope
//     'task:standalone:planning:<role>' form) => `Standalone planner` /
//     `Standalone plan reviewer` (plan_reviewer matched before planner; any
//     other planning ref => `Standalone planning`).
//   - taskRef with a range (contains "," or ">") => `tasks ${taskRef}`
//     (plural: a range names several tasks, e.g. "T1.1 > T1.3").
//   - single display ref (e.g. "T1.1") => `task ${taskRef}`.
//   - taskRef whose last ":" segment is a role slug (e.g.
//     "task:standalone:phase-1:code_reviewer") => `Standalone code reviewer`
//     (underscores/dashes become spaces).
//   - anything else non-empty => `tasks ${taskRef}` for multi-token refs,
//     else `task ${taskRef}`.
//   - missing/empty taskRef => `${Prefix} task` (framework fallback).
// Prefix is "SpecKit" for framework "speckit" (case-insensitive), else
// "Standalone".
export function noProgressDisplayLabel({taskId, taskRef, framework} = {}) {
  const prefix = String(framework ?? "").toLowerCase() === "speckit" ? "SpecKit" : "Standalone";
  const id = taskId === null || taskId === undefined ? "" : String(taskId).trim();
  if (id && id.toLowerCase() !== "null" && id.toLowerCase() !== "undefined") return `task ${id}`;
  const ref = taskRef === null || taskRef === undefined ? "" : String(taskRef).trim();
  if (!ref || ref.toLowerCase() === "null" || ref.toLowerCase() === "undefined") return `${prefix} task`;
  const lower = ref.toLowerCase();
  if (lower.includes("planning")) {
    if (lower.includes("plan_reviewer") || lower.includes("plan-reviewer")) return `${prefix} plan reviewer`;
    if (lower.includes("planner")) return `${prefix} planner`;
    return `${prefix} planning`;
  }
  if (ref.includes(",") || ref.includes(">")) return `tasks ${ref}`;
  if (/^T\d/i.test(ref)) return `task ${ref}`;
  if (ref.includes(":")) {
    const last = ref.split(":").pop().trim();
    if (!last) return `${prefix} task`;
    if (last.includes(",") || last.includes(">")) return `tasks ${last}`;
    if (/^T\d/i.test(last)) return `task ${last}`;
    const roleLabel = last.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
    if (roleLabel) return `${prefix} ${roleLabel}`;
    return `${prefix} task`;
  }
  if (/\s/.test(ref)) return `tasks ${ref}`;
  return `task ${ref}`;
}

// Trip predicate: fires when consecutive no-progress generations reach the
// limit. Non-integer/non-finite/negative consecutive, or a non-positive
// non-integer limit, never trips (ambiguous input degrades to false).
export function shouldStopOnNoProgress({consecutive, limit} = {}) {
  const c = Number(consecutive);
  const l = Number(limit);
  if (!Number.isInteger(c) || c < 0) return false;
  if (!Number.isInteger(l) || l <= 0) return false;
  return c >= l;
}

// Combined decision: {tripped, label}. Same inputs as the two helpers above.
export function evaluateNoProgressStop({consecutive, limit, taskId, taskRef, framework} = {}) {
  return {
    tripped: shouldStopOnNoProgress({consecutive, limit}),
    label: noProgressDisplayLabel({taskId, taskRef, framework}),
  };
}

// Backlog #32 + mission 026: quote the code a hand-off note cites, so the
// next generation edits from the quote instead of re-reading the file (each
// re-read re-sends ~45K raw tokens per turn and ends the session before the
// edit). Parses `path/file.ext:N` or `:N-M` citations — the note's "Next"
// section first, then the rest of the note — reads each through the injected
// `readFile(relPath)` (returns text or null; the caller confines it to the
// repo) and renders numbered excerpts with ~20 lines of context each side
// (~40-line window per ref). Bounded on every axis (at most 5 refs,
// 210 lines, 15000 chars); unreadable files, absolute paths and
// out-of-range lines are skipped, never thrown.
export const NOTE_EXCERPT_MAX_RANGES = 5;
export const NOTE_EXCERPT_CONTEXT = 20;
export const NOTE_EXCERPT_MAX_LINES = 210;
export const NOTE_EXCERPT_MAX_CHARS = 15000;
const FENCE = "```";
export function noteNextSection(note) {
  if (typeof note !== "string") return "";
  const lines = note.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*#*\s*(?:\d+\.\s*)?Next\b/i.test(l));
  if (start < 0) return "";
  const out = [lines[start].replace(/^\s*#*\s*(?:\d+\.\s*)?Next\b\s*[—:-]?\s*/i, "")];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*#+\s/.test(lines[i]) || /^\s*(?:\d+\.\s*)?Dead ends\b/i.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n").trim();
}
export function handoffNoteCitedExcerpts(note, readFile, {
  maxRanges = NOTE_EXCERPT_MAX_RANGES, context = NOTE_EXCERPT_CONTEXT,
  maxLines = NOTE_EXCERPT_MAX_LINES, maxChars = NOTE_EXCERPT_MAX_CHARS,
} = {}) {
  if (typeof note !== "string" || !note.trim() || typeof readFile !== "function") return "";
  const next = noteNextSection(note);
  // Whole-note scope, Next section first: refs the next session must act on
  // win the bounded slots; refs from the rest of the note fill the remainder.
  const scopes = next ? [next, note] : [note];
  const cites = [];
  const seen = new Set();
  for (const scope of scopes) {
    const re = /(?<![\w/.-])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+):~?(\d+)(?:-(\d+))?/g;
    for (const m of scope.matchAll(re)) {
      const file = m[1];
      if (file.startsWith("/") || file.split("/").includes("..")) continue;
      const a = Number(m[2]);
      const b = m[3] ? Number(m[3]) : a;
      const lo = Math.max(1, Math.min(a, b) - context);
      const hi = Math.max(a, b) + context;
      const k = `${file}:${lo}-${hi}`;
      if (seen.has(k)) continue;
      seen.add(k);
      cites.push({file, lo, hi});
      if (cites.length >= maxRanges) break;
    }
    if (cites.length >= maxRanges) break;
  }
  const blocks = [];
  let lines = 0;
  let chars = 0;
  const cache = new Map();
  for (const {file, lo, hi} of cites) {
    if (!cache.has(file)) {
      let text = null;
      try { text = readFile(file); } catch { text = null; }
      cache.set(file, typeof text === "string" ? text.split(/\r?\n/) : null);
    }
    const src = cache.get(file);
    if (!src || lo > src.length) continue;
    const end = Math.min(hi, src.length, lo + (maxLines - lines) - 1);
    if (end < lo) break;
    const body = [];
    for (let i = lo; i <= end; i += 1) body.push(`${i}: ${src[i - 1]}`);
    const block = `${file}:${lo}-${end}\n${FENCE}\n${body.join("\n")}\n${FENCE}`;
    if (chars + block.length > maxChars) break;
    blocks.push(block);
    lines += end - lo + 1;
    chars += block.length;
    if (lines >= maxLines) break;
  }
  return blocks.join("\n");
}

export function clearStaleStandaloneContinuations(state) {
  let cleared = 0;
  if (state?.continuationBudgets && typeof state.continuationBudgets === "object") {
    for (const k of Object.keys(state.continuationBudgets)) {
      if (k.includes(":task:standalone:")) { delete state.continuationBudgets[k]; cleared += 1; }
    }
  }
  if (state?.noProgressGenerations && typeof state.noProgressGenerations === "object") {
    for (const k of Object.keys(state.noProgressGenerations)) {
      if (k.includes(":task:standalone:")) delete state.noProgressGenerations[k];
    }
  }
  return cleared;
}

// Backlog 003#15: bounded dead-ends list ("tried X, failed because Y").
// Orchestrator-assembled from the killed run's own record, never free model
// prose. Bounded on both axes so reconstruction cost stays far below the
// ceiling by construction.
export function recordRolloverDeadEnd(state, scope, {generation, reason, used, limit, tail, maxChars = HANDOFF_MAX_CHARS_DEFAULT} = {}) {
  const key = continuationKey(scope);
  state.rolloverDeadEnds = state?.rolloverDeadEnds && typeof state.rolloverDeadEnds === "object"
    ? state.rolloverDeadEnds
    : {};
  const list = Array.isArray(state.rolloverDeadEnds[key]) ? state.rolloverDeadEnds[key] : [];
  // Backstop only: callers pass deadEndTail() output (already bounded, files
  // line first and always surviving). Single per-entry limit, bounded from
  // the FRONT so the files line is never amputated.
  const bound = Number.isInteger(maxChars) && maxChars >= HANDOFF_MIN_CHARS ? maxChars : HANDOFF_MAX_CHARS_DEFAULT;
  const cleanTail = String(tail ?? "").replace(/\s+/g, " ").trim().slice(0, bound);
  list.push({generation: Number.isInteger(generation) ? generation : null, reason: String(reason ?? ""), used: used ?? null, limit: limit ?? null, tail: cleanTail});
  while (list.length > DEAD_ENDS_MAX_ENTRIES) list.shift();
  state.rolloverDeadEnds[key] = list;
  return list;
}

export function readRolloverDeadEnds(state, scope) {
  const key = continuationKey(scope);
  const list = state?.rolloverDeadEnds?.[key];
  return Array.isArray(list) ? list : [];
}

// Backlog: dead-end tail assembly. Files-completed leads because that is the
// resume point the next generation actually needs; the handoff digest (for a
// killed run) or model summary (for a voluntary stop) follows as supporting
// detail. ONE bound per entry (maxChars, default HANDOFF_MAX_CHARS_DEFAULT,
// overridable via policy.handoff_max_chars): the joined text is bounded from
// the FRONT, never slice(-N), which amputates exactly the resume point.
export const DEAD_ENDS_MAX_FILES = 10;
export function deadEndTail({summary = "", files = [], outputTail = "", maxChars = HANDOFF_MAX_CHARS_DEFAULT} = {}) {
  const bound = Number.isInteger(maxChars) && maxChars >= HANDOFF_MIN_CHARS ? maxChars : HANDOFF_MAX_CHARS_DEFAULT;
  const parts = [];
  const list = Array.isArray(files) ? files.filter((f) => typeof f === "string" && f) : [];
  if (list.length) {
    const shown = list.slice(0, DEAD_ENDS_MAX_FILES);
    parts.push(`files completed this generation: ${shown.join(", ")}${list.length > shown.length ? ` (+${list.length - shown.length} more)` : ""}`);
  }
  const text = String(summary || outputTail || "").replace(/\s+/g, " ").trim();
  if (text) parts.push(text);
  return parts.join(" | ").slice(0, bound);
}

export function clearRolloverDeadEnds(state, scope) {
  if (!state?.rolloverDeadEnds || typeof state.rolloverDeadEnds !== "object") return false;
  const key = continuationKey(scope);
  if (!(key in state.rolloverDeadEnds)) return false;
  delete state.rolloverDeadEnds[key];
  return true;
}

function commandFromObservation(observation) {
  const state = observation?.event?.part?.state || {};
  const input = state.input || {};
  const item = observation?.event?.item || {};
  const command = input.command ?? item.command ?? observation?.command;
  return typeof command === "string" ? command : "";
}

// Redundant-verification detector (the observable half of task 9's
// single-verification contract). Requires POSITIVE success evidence and
// degrades to inert, never to aggressive: a repeat is counted only when the
// earlier identical command is known to have SUCCEEDED — a `command_attempted`
// with no corresponding `command_failed`, on an adapter whose observer emits
// `command_failed` at all (opencode today; codex/claude do not yet, so the
// detector does nothing there rather than killing a legitimate
// write-fix-retry loop on unobservable failure).
//
// A repeat that FOLLOWS a write is legitimate re-verification after a change
// and must not be counted; only a re-run over an unchanged tree is redundant.
// The detector flags the SECOND repeat (the command's third identical
// successful run with no intervening write).
export function detectRedundantVerification({adapterId, observations} = {}) {
  if (adapterId !== "opencode") return {redundant: false, reason: "adapter_has_no_command_failure_signal"};
  const list = Array.isArray(observations) ? observations : [];
  const typesByEvent = new Map();
  for (const observation of list) {
    if (!observation || typeof observation !== "object") continue;
    if (!typesByEvent.has(observation.event)) typesByEvent.set(observation.event, new Set());
    typesByEvent.get(observation.event).add(observation.type);
  }
  const counts = new Map();
  let currentCommand = null;
  for (const observation of list) {
    if (!observation || typeof observation !== "object") continue;
    const type = observation.type;
    if (type === "write_attempted" || type === "write_blocked" || type === "write_failed") {
      counts.clear();
      currentCommand = null;
      continue;
    }
    if (type !== "command_attempted") continue;
    const types = typesByEvent.get(observation.event) || new Set();
    if (types.has("command_failed")) {
      counts.clear();
      currentCommand = null;
      continue;
    }
    const command = commandFromObservation(observation);
    if (!command) continue;
    if (command !== currentCommand) {
      counts.clear();
      currentCommand = command;
    }
    const next = (counts.get(command) || 0) + 1;
    counts.set(command, next);
    if (next >= 3) {
      return {redundant: true, command, repeats: next - 1, reason: "redundant_verification"};
    }
  }
  return {redundant: false, reason: "no_redundant_repeat"};
}

// Backlog #22 (TASK-32): what-did-the-capped-session-actually-do digest.
//
// A capped session is usually killed mid-tool-calls with NO assistant `text`
// event, so finalAgentText() falls back to raw NDJSON stdout — and the old
// handoff kept the last 500 chars of that (a JSON-event tail:
// `zMvyoF","reason":"tool-calls","messageID":…`). The next session then
// started blind and re-read/re-ran everything. This builder reads the DECODED
// events only, never raw bytes, and returns a short bounded plain-text digest
// in a compact one-line-per-section shape:
//
//   edited: scripts/failure-contract.mjs
//   read: TASKS.md; scripts/autopilot.mjs:790-920,1140-1390
//   searched: "buildTaskPrompt|taskRetryFindings" in autopilot.mjs
//   ran: git status --short (ok); git diff --stat (ok) x3; node t.mjs (failed)
//   last: "classification done; next: wire warning into the retry prompt"
//
// Sections, in order: Edits made (path only, deduped), Files read
// (path or path:start-end from read offset/limit, deduped, repeats merged),
// Searches (pattern + path, each ~80 chars), Commands (each ~100 chars with
// ok/failed when the event says so, identical commands deduped with a count),
// Last agent text (the last assistant text part, if any, ~300 chars).
// Unknown adapter → "" (no decoded vocabulary to read).
// Total bounded to maxChars (default HANDOFF_MAX_CHARS_DEFAULT): the
// edited and last lines are protected (capped individually first), the middle
// sections share whatever remains, so "Files read" can never push out
// "Edits made" or "Last agent text".
const DIGEST_SEARCH_ITEM_CHARS = 80;
const DIGEST_COMMAND_ITEM_CHARS = 100;
const DIGEST_LAST_TEXT_CHARS = 300;
const DIGEST_EDITED_LINE_CHARS = 400;

// Backlog #15 part 3a: decode the common bash file-read forms into the same
// {path, from, to, wholeFile} vocabulary the read tool uses. Live missions
// read through bash (`sed -n '120,180p' f`, `cat f`, `head -n 50 f`,
// `grep -n x f`) and the digest used to report "no decoded file reads".
// Pure: string in, plain records out; never throws. Paths outside `repoRoot`
// and tokens that do not look like files are ignored. Chained commands are
// split on &&, ||, ;, | and newlines (quotes respected), so each segment is
// decoded independently (a leading `cd <repo> &&` simply contributes nothing).
function shellSegments(command) {
  const text = String(command ?? "");
  const out = [];
  let cur = "";
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = "";
      else if (ch === "\\" && quote === '"' && i + 1 < text.length) cur += text[++i];
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === "&" && text[i + 1] === "&") { out.push(cur); cur = ""; i += 1; continue; }
    if (ch === "|" && text[i + 1] === "|") { out.push(cur); cur = ""; i += 1; continue; }
    if (ch === "|" || ch === ";" || ch === "\n") { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function shellTokens(segment) {
  const out = [];
  let cur = "";
  let quote = "";
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) { quote = ""; continue; }
      if (ch === "\\" && quote === '"' && i + 1 < segment.length) { cur += segment[++i]; continue; }
      cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ""; }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function looksLikeFileToken(token) {
  const t = String(token ?? "").trim();
  if (!t || t.startsWith("-") || t === "." || t === "..") return false;
  if (/[*?[\]{}<>|&]/.test(t)) return false;
  const base = t.replace(/\/+$/, "").split("/").pop() || "";
  return base.includes(".") || t.includes("/");
}

function repoRelativeFile(raw, repoRoot) {
  const s = String(raw ?? "").replace(/\\/g, "/").trim();
  if (!s) return "";
  const root = String(repoRoot ?? "").replace(/\\/g, "/").replace(/\/+$/, "").trim();
  const absolute = s.startsWith("/") || /^[a-zA-Z]:\//.test(s);
  let rel = "";
  if (root) {
    const prefixes = [`${root}/`];
    const drive = root.match(/^([a-zA-Z]):\/(.*)$/);
    if (drive) prefixes.push(`/mnt/${drive[1].toLowerCase()}/${drive[2]}/`);
    const mount = root.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
    if (mount) prefixes.push(`${mount[1]}:/${mount[2]}/`);
    const lower = s.toLowerCase();
    for (const p of prefixes) {
      if (lower.startsWith(p.toLowerCase())) { rel = s.slice(p.length); break; }
    }
    if (!rel && absolute) {
      // The execution envelope mounts the repo at /workspace/repository; a
      // path there is a repo file even though it does not share repoRoot.
      if (/^\/workspace\/repository\//.test(s)) rel = s.replace(/^\/workspace\/repository\//, "");
      else return "";
    }
  } else if (absolute) {
    if (/^\/workspace\/repository\//.test(s)) rel = s.replace(/^\/workspace\/repository\//, "");
    else return "";
  }
  if (!rel) rel = s.replace(/^\.\//, "");
  if (!rel || rel.startsWith("/") || rel.split("/").includes("..")) return "";
  return rel;
}

function bashRead(path, from = null, to = null, wholeFile = false) {
  return {path, from, to, wholeFile};
}

function decodeBashSegment(segment, repoRoot) {
  const tokens = shellTokens(segment);
  if (!tokens.length) return [];
  const command = tokens[0].replace(/^.*\//, "");
  const fileFor = (token) => {
    if (!looksLikeFileToken(token)) return "";
    return repoRelativeFile(token, repoRoot);
  };
  const out = [];
  if (command === "cat") {
    let stop = false;
    for (const token of tokens.slice(1)) {
      if (stop) break;
      if (token === ">" || token === ">>" || token === "2>" || token === "2>>" || token === "&>") { stop = true; continue; }
      if (token.startsWith("-")) continue;
      const p = fileFor(token);
      if (p) out.push(bashRead(p, null, null, true));
    }
  } else if (command === "sed") {
    let pattern = "";
    const files = [];
    for (let i = 1; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token === "-e") { pattern = tokens[++i] || ""; continue; }
      if (token === "-n" || token.startsWith("-")) continue;
      if (!pattern) { pattern = token; continue; }
      const p = fileFor(token);
      if (p) files.push(p);
    }
    const m = /^(\d+),(\d+)p$/.exec(pattern.trim());
    if (!m) return [];
    const from = Math.max(1, Number(m[1]));
    const to = Math.max(from, Number(m[2]));
    for (const p of files) out.push(bashRead(p, from, to, false));
  } else if (command === "head" || command === "tail") {
    let count = 10;
    const files = [];
    for (let i = 1; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token === "-n") { const n = Number(tokens[++i]); if (Number.isFinite(n)) count = Math.max(0, Math.trunc(n)); continue; }
      if (token.startsWith("--lines=")) { const n = Number(token.slice(8)); if (Number.isFinite(n)) count = Math.max(0, Math.trunc(n)); continue; }
      if (/^-\d+$/.test(token)) { count = Math.max(0, Number(token.slice(1))); continue; }
      if (token.startsWith("-")) continue;
      const p = fileFor(token);
      if (p) files.push(p);
    }
    for (const p of files) {
      if (command === "tail") out.push(bashRead(p, null, null, true));
      else out.push(bashRead(p, 1, Math.max(1, count), false));
    }
  } else if (command === "nl") {
    for (const token of tokens.slice(1)) {
      if (token.startsWith("-")) continue;
      const p = fileFor(token);
      if (p) out.push(bashRead(p, null, null, true));
    }
  } else if (command === "awk") {
    let programSeen = false;
    for (let i = 1; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token === "-F" || token === "-v" || token === "-f") { i += 1; continue; }
      if (token.startsWith("-")) continue;
      if (!programSeen) { programSeen = true; continue; }
      const p = fileFor(token);
      if (p) out.push(bashRead(p, null, null, true));
    }
  } else if (command === "grep") {
    let recursive = false;
    const positional = [];
    for (let i = 1; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token === "-e" || token === "--regexp") { positional.push(tokens[++i] || ""); continue; }
      if (token === "-f" || token === "--file") { i += 1; continue; }
      if (token.startsWith("-")) {
        if (/^-[^-]*[rR]/.test(token) || token === "--recursive" || token === "--dereference-recursive") recursive = true;
        continue;
      }
      positional.push(token);
    }
    if (recursive || positional.length !== 2) return [];
    const p = fileFor(positional[1]);
    if (p) out.push(bashRead(p, null, null, false));
  }
  return out;
}

export function decodeBashFileReads(command, repoRoot) {
  try {
    const out = [];
    for (const segment of shellSegments(command)) {
      for (const read of decodeBashSegment(segment, repoRoot)) out.push(read);
    }
    return out;
  } catch {
    return [];
  }
}

// Backlog #15 part 3b: the paths THIS session edited/wrote according to its
// decoded edit/write tool calls (same adapter vocabulary as the digest).
// Used to keep the fallback note's changes section session-only. Pure.
export function sessionEditPaths(adapterId, events, repoRoot = "") {
  if (adapterId !== "opencode" && adapterId !== "claude") return [];
  const prefixes = repoPrefixes(repoRoot);
  const rel = (raw) => digestPath(raw, prefixes);
  const out = [];
  const seen = new Set();
  const note = (raw) => {
    const p = rel(raw);
    if (!p || seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };
  const list = Array.isArray(events) ? events : [];
  for (const event of list) {
    if (!event || typeof event !== "object") continue;
    if (adapterId === "opencode") {
      const part = event?.part || {};
      const type = String(event?.type || part.type || "");
      if (type !== "tool_use" && type !== "tool") continue;
      const tool = String(part.tool || event.tool || "").toLowerCase();
      if (tool !== "write" && tool !== "edit" && tool !== "patch" && tool !== "multiedit") continue;
      const input = (part.state && typeof part.state === "object" && part.state.input
        && typeof part.state.input === "object") ? part.state.input : {};
      note(input.filePath ?? input.file_path ?? input.path ?? input.file);
    } else if (event?.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (!block || typeof block !== "object" || block.type !== "tool_use") continue;
        const name = String(block.name || "").toLowerCase();
        if (name !== "edit" && name !== "write" && name !== "multiedit") continue;
        const input = block.input && typeof block.input === "object" ? block.input : {};
        note(input.file_path ?? input.path ?? input.file);
      }
    }
  }
  return out;
}

export function sessionWorkDigest(adapterId, events, {maxChars = HANDOFF_MAX_CHARS_DEFAULT, repoRoot = ""} = {}) {
  if (adapterId !== "opencode" && adapterId !== "claude") return "";
  const prefixes = repoPrefixes(repoRoot);
  const root = String(repoRoot ?? "");
  const rel = (raw) => digestPath(raw, prefixes);
  const bound = Number.isInteger(maxChars) && maxChars >= HANDOFF_MIN_CHARS ? maxChars : HANDOFF_MAX_CHARS_DEFAULT;
  const list = Array.isArray(events) ? events : [];
  const edits = [];
  const seenEdits = new Set();
  const readsByPath = new Map();
  const searches = [];
  const seenSearches = new Set();
  const commands = new Map();
  let lastText = "";

  const noteEdit = (raw) => {
    const p = rel(raw);
    if (!p || seenEdits.has(p)) return;
    seenEdits.add(p);
    edits.push(p);
  };
  const noteRead = (raw, offset, limit) => {
    const p = rel(raw);
    if (!p) return;
    const range = digestRange(offset, limit);
    if (!range) { readsByPath.set(p, null); return; }
    if (!readsByPath.has(p)) readsByPath.set(p, []);
    const ranges = readsByPath.get(p);
    if (ranges === null) return;
    if (!ranges.some((r) => r[0] === range[0] && r[1] === range[1])) ranges.push(range);
  };
  const noteDecodedRead = (read) => {
    const p = rel(read?.path);
    if (!p) return;
    if (read.wholeFile) { readsByPath.set(p, null); return; }
    const range = Number.isInteger(read?.from) && Number.isInteger(read?.to)
      ? [read.from, read.to] : null;
    if (!range) {
      if (!readsByPath.has(p)) readsByPath.set(p, []);
      return;
    }
    if (readsByPath.get(p) === null) return;
    if (!readsByPath.has(p)) readsByPath.set(p, []);
    const ranges = readsByPath.get(p);
    if (!ranges.some((r) => r[0] === range[0] && r[1] === range[1])) ranges.push(range);
  };
  const noteSearch = (pattern, scope) => {
    const pat = String(pattern ?? "").replace(/\s+/g, " ").trim();
    if (!pat) return;
    const key = `${pat}\0${scope || ""}`;
    if (seenSearches.has(key)) return;
    seenSearches.add(key);
    searches.push({pattern: pat, scope: scope || ""});
  };
  const noteCommand = (command, status) => {
    const cmd = String(command ?? "").replace(/\s+/g, " ").trim();
    if (!cmd) return;
    const key = `${cmd}\0${status || ""}`;
    const entry = commands.get(key) || {command: cmd, status: status || "", count: 0};
    entry.count += 1;
    commands.set(key, entry);
  };

  for (const event of list) {
    if (!event || typeof event !== "object") continue;
    if (adapterId === "opencode") {
      const part = event?.part || {};
      const type = String(event?.type || part.type || "");
      if (type === "text" && typeof part.text === "string" && part.text.trim()) {
        lastText = part.text;
        continue;
      }
      if (type !== "tool_use" && type !== "tool") continue;
      const tool = String(part.tool || event.tool || "").toLowerCase();
      const state = part.state || {};
      const input = state.input || {};
      const status = String(state.status || "");
      const exit = state.metadata && Number.isFinite(Number(state.metadata.exit)) ? Number(state.metadata.exit) : null;
      if (tool === "read") {
        noteRead(input.filePath ?? input.file_path ?? input.path ?? input.file, input.offset, input.limit);
      } else if (tool === "write" || tool === "edit" || tool === "patch" || tool === "multiedit") {
        noteEdit(input.filePath ?? input.file_path ?? input.path ?? input.file);
      } else if (tool === "bash") {
        for (const read of decodeBashFileReads(input.command, root)) noteDecodedRead(read);
        noteCommand(input.command, exit !== null ? (exit === 0 ? "ok" : "failed") : (status === "error" ? "failed" : status === "completed" ? "ok" : ""));
      } else if (tool === "grep" || tool === "search") {
        noteSearch(input.pattern ?? input.query ?? input.text, rel(input.path ?? input.filePath ?? input.file_path ?? input.dir ?? input.directory ?? ""));
      } else if (tool === "glob") {
        noteSearch(input.pattern ?? input.query ?? input.text, rel(input.path ?? input.dir ?? input.directory ?? ""));
      }
    } else {
      if (event?.type === "assistant" && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text" && typeof block.text === "string" && block.text.trim()) lastText = block.text;
          else if (block.type === "tool_use") {
            const name = String(block.name || "").toLowerCase();
            const input = block.input && typeof block.input === "object" ? block.input : {};
            if (name === "read") noteRead(input.file_path ?? input.path ?? input.file, input.offset, input.limit);
            else if (name === "edit" || name === "write" || name === "multiedit") noteEdit(input.file_path ?? input.path ?? input.file);
            else if (name === "bash" || name === "bashoutput") {
              for (const read of decodeBashFileReads(input.command, root)) noteDecodedRead(read);
              noteCommand(input.command, "");
            }
            else if (name === "grep" || name === "search") noteSearch(input.pattern ?? input.query ?? input.text, rel(input.path ?? ""));
            else if (name === "glob") noteSearch(input.pattern ?? input.query ?? input.text, rel(input.path ?? ""));
          }
        }
      } else if (event?.type === "result" && typeof event.result === "string" && event.result.trim()) {
        lastText = event.result;
      }
    }
  }

  const cut = (s, n) => (s.length > n ? s.slice(0, n) : s);
  let editedLine = edits.length ? `edited: ${edits.join("; ")}` : "";
  if (editedLine.length > DIGEST_EDITED_LINE_CHARS) {
    const kept = [];
    for (const p of edits) {
      const candidate = kept.length ? `edited: ${kept.join("; ")}; ${p}` : `edited: ${p}`;
      if (candidate.length > DIGEST_EDITED_LINE_CHARS - 12) break;
      kept.push(p);
    }
    editedLine = `edited: ${kept.join("; ")} (+${edits.length - kept.length} more)`;
  }
  const readLine = readsByPath.size
    ? `read: ${[...readsByPath.entries()].map(([p, ranges]) => (ranges === null || ranges.length === 0 ? p : `${p}:${digestMergeRanges(ranges)}`)).join("; ")}`
    : "";
  const searchLine = searches.length
    ? `searched: ${searches.map((s) => (s.scope ? `"${cut(s.pattern, DIGEST_SEARCH_ITEM_CHARS)}" in ${s.scope}` : `"${cut(s.pattern, DIGEST_SEARCH_ITEM_CHARS)}"`)).join("; ")}`
    : "";
  const ranLine = commands.size
    ? `ran: ${[...commands.values()].map((c) => `${cut(c.command, DIGEST_COMMAND_ITEM_CHARS)}${c.status ? ` (${c.status})` : ""}${c.count > 1 ? ` x${c.count}` : ""}`).join("; ")}`
    : "";
  const lastLine = lastText.replace(/\s+/g, " ").trim()
    ? `last: "${cut(lastText.replace(/\s+/g, " ").trim(), DIGEST_LAST_TEXT_CHARS)}"`
    : "";

  // Protected assembly: edited + last are capped individually above and
  // always survive; the middle sections share the remainder equally so no
  // one of them can push out the others. The bound holds by construction
  // (fixed lines + separators subtracted first); the trailing slice is a
  // no-op backstop, never the mechanism.
  const middle = [readLine, searchLine, ranLine].filter(Boolean);
  const fixed = [editedLine, lastLine].filter(Boolean);
  const separators = fixed.length + middle.length > 0 ? fixed.length + middle.length - 1 : 0;
  const middleBudget = Math.max(0, bound - fixed.reduce((n, l) => n + l.length, 0) - separators);
  let middleLines = middle;
  if (middle.length && middle.join("\n").length > middleBudget) {
    const share = Math.max(0, Math.floor(middleBudget / middle.length));
    middleLines = middle
      .map((line) => (line.length <= share ? line : share <= 1 ? "…".slice(0, share) : `${line.slice(0, share - 1)}…`))
      .filter((line) => line.length > 0);
  }
  const lines = [...(editedLine ? [editedLine] : []), ...middleLines, ...(lastLine ? [lastLine] : [])];
  return lines.join("\n").slice(0, bound);
}

// Repo-relative display: strip the WSL/container absolute prefixes the
// agents report; anything else passes through unchanged (best-effort — the
// digest never sees raw bytes, only these decoded input fields).
// The repo root in every form an agent may report it: as given, and — for a
// Windows drive path — its WSL mount (`D:/x` → `/mnt/d/x`). Without this a
// WSL agent's `/mnt/d/<repo>/scripts/a.mjs` kept a `<repo>/` prefix on
// every entry (live mission 022 replay).
function repoPrefixes(repoRoot) {
  const root = String(repoRoot ?? "").replace(/\\/g, "/").replace(/\/+$/, "").trim();
  if (!root) return [];
  const out = [`${root}/`];
  const drive = root.match(/^([a-zA-Z]):\/(.*)$/);
  if (drive) out.push(`/mnt/${drive[1].toLowerCase()}/${drive[2]}/`);
  const mount = root.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (mount) out.push(`${mount[1]}:/${mount[2]}/`);
  return out;
}

function digestPath(raw, prefixes = []) {
  let s = String(raw ?? "").replace(/\\/g, "/").trim();
  if (!s) return "";
  const lower = s.toLowerCase();
  for (const p of prefixes) {
    if (lower.startsWith(p.toLowerCase())) return s.slice(p.length);
  }
  s = s.replace(/^\/workspace\/repository\//, "");
  s = s.replace(/^\/mnt\/[a-zA-Z]\//, "");
  s = s.replace(/^\.\//, "");
  return s;
}

function digestRange(offset, limit) {
  const start = Number(offset);
  const len = Number(limit);
  if (!Number.isFinite(start) && !Number.isFinite(len)) return null;
  const from = Number.isFinite(start) ? Math.max(0, Math.trunc(start)) : 1;
  if (!Number.isFinite(len) || len <= 0) return [from, from];
  return [from, from + Math.trunc(len) - 1];
}

function digestMergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [from, to] of sorted) {
    const last = merged[merged.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged.map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`)).join(",");
}

// Mission 049 Phase 1 task 1.1: richer cut hand-off context. Pure helpers
// next to buildOrchestratorFallbackNote that derive the cut reason/point,
// the largest decoded read (path + whole-file vs range), and the next/avoid
// resume lines from decoded events + cap figures. Pure by construction: no
// filesystem, process, network, or clock reads — the caller passes events,
// the checkCapBreach-style capBreach record ({type, used, limit, usage,
// trigger?}) and the repo root in. Never throws — garbage input degrades to
// generic lines, the same degrade-never-throw contract as the rest of the
// module. Task 1.2 wires describeCutContext()/renderCutContextSection()
// into buildOrchestratorFallbackNote and the runRelay wrap-up call site
// (passing capBreach figures); tasks 1.3/1.4 render scratchHandoffNotePath()
// in role prompts.
export const CUT_CONTEXT_NEXT_TEXT_CHARS = 160;
export const CUT_CONTEXT_SECTION_MAX_CHARS = 1500;

function cutContextLastText(adapterId, events) {
  const list = Array.isArray(events) ? events : [];
  let last = "";
  for (const event of list) {
    if (!event || typeof event !== "object") continue;
    if (adapterId === "opencode") {
      const part = event?.part || {};
      const type = String(event?.type || part.type || "");
      if (type === "text" && typeof part.text === "string" && part.text.trim()) last = part.text;
    } else if (adapterId === "claude") {
      if (event?.type === "assistant" && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (block && typeof block === "object" && block.type === "text"
            && typeof block.text === "string" && block.text.trim()) last = block.text;
        }
      } else if (event?.type === "result" && typeof event.result === "string" && event.result.trim()) {
        last = event.result;
      }
    }
  }
  return last;
}

function cutContextReads(adapterId, events, prefixes, repoRoot = "") {
  const out = [];
  const list = Array.isArray(events) ? events : [];
  const pushBash = (command) => {
    for (const read of decodeBashFileReads(command, repoRoot)) {
      const p = digestPath(read.path, prefixes);
      if (!p) continue;
      out.push({path: p, wholeFile: read.wholeFile === true,
        range: Number.isInteger(read.from) && Number.isInteger(read.to) ? [read.from, read.to] : null});
    }
  };
  for (const event of list) {
    if (!event || typeof event !== "object") continue;
    if (adapterId === "opencode") {
      const part = event?.part || {};
      const type = String(event?.type || part.type || "");
      if (type !== "tool_use" && type !== "tool") continue;
      const tool = String(part.tool || event.tool || "").toLowerCase();
      const input = (part.state && typeof part.state === "object" && part.state.input
        && typeof part.state.input === "object") ? part.state.input : {};
      if (tool === "bash") { pushBash(input.command); continue; }
      if (tool !== "read") continue;
      const p = digestPath(input.filePath ?? input.file_path ?? input.path ?? input.file, prefixes);
      if (!p) continue;
      out.push({path: p, wholeFile: digestRange(input.offset, input.limit) === null,
        range: digestRange(input.offset, input.limit)});
    } else if (adapterId === "claude") {
      if (event?.type === "assistant" && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (!block || typeof block !== "object" || block.type !== "tool_use") continue;
          const name = String(block.name || "").toLowerCase();
          const input = block.input && typeof block.input === "object" ? block.input : {};
          if (name === "bash" || name === "bashoutput") { pushBash(input.command); continue; }
          if (name !== "read") continue;
          const p = digestPath(input.file_path ?? input.path ?? input.file, prefixes);
          if (!p) continue;
          out.push({path: p, wholeFile: digestRange(input.offset, input.limit) === null,
            range: digestRange(input.offset, input.limit)});
        }
      }
    }
  }
  return out;
}

function cutContextLargest(reads) {
  let best = null;
  let bestScore = -1;
  for (const r of reads) {
    const score = r.wholeFile ? 1e12 : (r.range ? (r.range[1] - r.range[0] + 1) : 0);
    if (score >= bestScore) { best = r; bestScore = score; }
  }
  return best;
}

// Describe the cut: {reasonLine, pointLine, largestReadLine, nextLine,
// avoidLine}. Every line is a plain string; unknown/unmeasurable inputs
// degrade to generic lines, never "" and never a throw.
export function describeCutContext(cutArgs) {
  try {
    const {adapterId, events, capBreach, repoRoot} =
      (cutArgs && typeof cutArgs === "object") ? cutArgs : {};
    const prefixes = repoPrefixes(String(repoRoot ?? ""));
    const breach = capBreach && typeof capBreach === "object" && !Array.isArray(capBreach) ? capBreach : null;
    const breachType = breach ? String(breach.type ?? breach.triggerType ?? "") : "";
    const usage = breach?.usage && typeof breach.usage === "object" ? breach.usage : null;
    let turns = null;
    if (usage && Number.isInteger(usage.turns)) turns = usage.turns;
    else {
      try {
        const counted = countTurns(adapterId, events);
        if (Number.isInteger(counted)) turns = counted;
      } catch { turns = null; }
    }
    const maxTurns = breachType === "turns" && Number.isInteger(breach?.limit) ? breach.limit : null;
    let growing = null;
    if (usage && Number.isFinite(Number(usage.maxSingleTurnContext))) growing = Number(usage.maxSingleTurnContext);
    else if (breachType === "tokens" && Number.isFinite(Number(breach?.used))) growing = Number(breach.used);
    const maxTokens = breachType === "tokens" && Number.isInteger(breach?.limit) ? breach.limit : null;
    const reads = cutContextReads(adapterId, events, prefixes, String(repoRoot ?? ""));
    const largest = cutContextLargest(reads);
    const trigger = breach && breach.trigger !== undefined && breach.trigger !== null
      ? String(breach.trigger).trim() : "";

    let reasonLine;
    if (breachType === "turns" && Number.isInteger(breach?.used) && Number.isInteger(breach?.limit)) {
      reasonLine = `Cut: turn cap — turn ${breach.used} of ${breach.limit}${trigger ? ` (trigger: ${trigger})` : ""}`;
    } else if (breachType === "tokens" && Number.isFinite(Number(breach?.used)) && Number.isInteger(breach?.limit)) {
      reasonLine = `Cut: token ceiling — largest single-turn context ${breach.used} of ${breach.limit}${trigger ? ` (trigger: ${trigger})` : ""}`;
      if (largest && largest.wholeFile) reasonLine += `; likely cause: whole-file read of ${largest.path}`;
    } else if (breach) {
      reasonLine = "Cut: cap or wrap-up stop — exact figures unavailable; see the digest below";
    } else {
      reasonLine = "Cut: unknown — no cap figures (session ended before the cap or figures unavailable)";
    }

    let pointLine;
    if (Number.isInteger(turns) && Number.isInteger(maxTurns)) {
      pointLine = `Point: turn ${turns} of ${maxTurns}`;
      if (Number.isFinite(growing)) pointLine += `; largest single-turn context ${growing}${Number.isInteger(maxTokens) ? ` of ${maxTokens}` : ""}`;
    } else if (Number.isInteger(turns)) {
      pointLine = `Point: turn ${turns} (turn limit unknown)`;
      if (Number.isFinite(growing)) pointLine += `; largest single-turn context ${growing}${Number.isInteger(maxTokens) ? ` of ${maxTokens}` : ""}`;
    } else if (Number.isFinite(growing)) {
      pointLine = `Point: turn unknown (no turn signal for this adapter); largest single-turn context ${growing}${Number.isInteger(maxTokens) ? ` of ${maxTokens}` : ""}`;
    } else {
      pointLine = "Point: unknown — no turn or token figures in the decoded events";
    }

    let largestReadLine;
    if (largest && largest.wholeFile) largestReadLine = `Largest read: ${largest.path} (whole file)`;
    else if (largest && largest.range) {
      const [from, to] = largest.range;
      largestReadLine = from === to
        ? `Largest read: ${largest.path}:${from} (range)`
        : `Largest read: ${largest.path}:${from}-${to} (range)`;
    } else if (largest) largestReadLine = `Largest read: ${largest.path} (no line range)`; else largestReadLine = "Largest read: (none: no decoded file reads)";

    const rawLast = cutContextLastText(adapterId, events).replace(/\s+/g, " ").trim();
    let nextLine;
    if (rawLast) {
      const cut = rawLast.length > CUT_CONTEXT_NEXT_TEXT_CHARS
        ? `${rawLast.slice(0, CUT_CONTEXT_NEXT_TEXT_CHARS - 1)}…` : rawLast;
      nextLine = `Next: ${cut}`;
    } else if (largest) {
      nextLine = `Next: continue from ${largest.path} without re-reading it in full`;
    } else {
      nextLine = "Next: continue from the session work digest below";
    }

    let avoidLine;
    if (largest && largest.wholeFile) {
      avoidLine = `Avoid: do not re-read ${largest.path} in full; read only the lines the next edit needs, and do not re-run commands shown as already run`;
    } else if (largest) {
      avoidLine = `Avoid: do not re-read ${largest.path} ranges already read in full; do not re-run commands shown as already run`;
    } else {
      avoidLine = "Avoid: do not re-run commands shown as already run";
    }
    return {reasonLine, pointLine, largestReadLine, nextLine, avoidLine};
  } catch {
    return {
      reasonLine: "Cut: unknown — no cap figures (session ended before the cap or figures unavailable)",
      pointLine: "Point: unknown — no turn or token figures in the decoded events",
      largestReadLine: "Largest read: (none: no decoded file reads)",
      nextLine: "Next: continue from the session work digest below",
      avoidLine: "Avoid: do not re-run commands shown as already run",
    };
  }
}

// Render describeCutContext() as the five-line block task 1.2 embeds in the
// orchestrator fallback note. Bounded (CUT_CONTEXT_SECTION_MAX_CHARS) with
// the reason + point lines protected: the next/avoid lines share whatever
// remains, so the cut figures always survive. Never throws.
export function renderCutContextSection(sectionArgs) {
  try {
    const d = describeCutContext(
      sectionArgs && typeof sectionArgs === "object" ? sectionArgs : {});
    const lines = [d.reasonLine, d.pointLine, d.largestReadLine, d.nextLine, d.avoidLine]
      .map((l) => String(l ?? "").trim()).filter(Boolean);
    const bound = CUT_CONTEXT_SECTION_MAX_CHARS;
    const joined = lines.join("\n");
    if (joined.length <= bound) return joined;
    const fixed = [lines[0] || "", lines[1] || "", lines[2] || ""].filter(Boolean);
    const tail = [lines[3] || "", lines[4] || ""].filter(Boolean);
    const separators = lines.length > 0 ? lines.length - 1 : 0;
    const tailBudget = Math.max(0, bound - fixed.reduce((n, l) => n + l.length, 0) - separators);
    const share = tail.length ? Math.max(0, Math.floor(tailBudget / tail.length)) : 0;
    const cutTail = tail
      .map((line) => (line.length <= share ? line : share <= 1 ? "…".slice(0, share) : `${line.slice(0, share - 1)}…`))
      .filter((line) => line.length > 0);
    return [...fixed, ...cutTail].join("\n").slice(0, bound);
  } catch {
    return [
      "Cut: unknown — no cap figures (session ended before the cap or figures unavailable)",
      "Point: unknown — no turn or token figures in the decoded events",
      "Largest read: (none: no decoded file reads)",
    ].join("\n");
  }
}

// Mission 049 Phase 1 task 1.1: writable scratch hand-off note path. Review
// roles (and the planner) run with the repo read-only, so their milestone
// note lives under the writable scratch bind, not the repo-relative
// handoffNoteRelPath. Pure path join: same filename-safe taskRef vocabulary
// as handoffNoteRelPath/sessionStoreRelDir; scratchDir is the prompt-visible
// form ("/workspace/scratch" inside the envelope, the host effectiveScratchDir
// outside it). Never throws — garbage input degrades to the default dir +
// "task.md". Task 1.2 reads this helper at effectiveScratchDir before the
// disposable workspace is cleaned up; tasks 1.3/1.4 render it in prompts.
export const SCRATCH_HANDOFF_NOTE_DEFAULT_DIR = "/workspace/scratch";
export function scratchHandoffNotePath(scratchDir, taskRef) {
  try {
    const base = String(scratchDir ?? SCRATCH_HANDOFF_NOTE_DEFAULT_DIR)
      .replace(/\\/g, "/").replace(/\/+$/, "").trim() || SCRATCH_HANDOFF_NOTE_DEFAULT_DIR;
    const safe = String(taskRef ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "task";
    return `${base}/${safe}.md`;
  } catch {
    return `${SCRATCH_HANDOFF_NOTE_DEFAULT_DIR}/task.md`;
  }
}

// Mission 049 Phase 1 task 1.1: pick the fresher of the repo note vs the
// scratch note. Pure by construction: the caller reads both files (repo note
// at handoffNoteRelPath, scratch note at scratchHandoffNotePath) and passes
// {text, mtimeMs} pairs in — no filesystem, process, network, or clock
// reads here. Returns {source: "repo"|"scratch"|"none", text, mtimeMs,
// reason}. Empty/missing text is never fresher; finite mtimes decide between
// two non-empty notes (ties prefer repo); a note with text but no usable
// mtime still beats an empty note. Never throws — garbage input degrades to
// "none", never to a guessed note.
export function pickFresherHandoffNote(noteArgs) {
  try {
    const {repoText, repoMtimeMs, scratchText, scratchMtimeMs} =
      (noteArgs && typeof noteArgs === "object") ? noteArgs : {};
    const repoHas = typeof repoText === "string" && repoText.trim().length > 0;
    const scratchHas = typeof scratchText === "string" && scratchText.trim().length > 0;
    if (!repoHas && !scratchHas) return {source: "none", text: "", mtimeMs: null, reason: "both_missing_or_empty"};
    const repoTime = Number(repoMtimeMs);
    const scratchTime = Number(scratchMtimeMs);
    const repoTimed = repoHas && Number.isFinite(repoTime);
    const scratchTimed = scratchHas && Number.isFinite(scratchTime);
    if (repoTimed && scratchTimed) {
      if (scratchTime > repoTime) return {source: "scratch", text: scratchText, mtimeMs: scratchTime, reason: "scratch_newer"};
      return {source: "repo", text: repoText, mtimeMs: repoTime,
        reason: repoTime > scratchTime ? "repo_newer" : "tie_prefers_repo"};
    }
    if (scratchTimed) return {source: "scratch", text: scratchText, mtimeMs: scratchTime, reason: "repo_time_unusable"};
    if (repoTimed) return {source: "repo", text: repoText, mtimeMs: repoTime, reason: "scratch_time_unusable"};
    if (repoHas) return {source: "repo", text: repoText, mtimeMs: null, reason: "mtime_unavailable_repo_only_text"};
    return {source: "scratch", text: scratchText, mtimeMs: null, reason: "mtime_unavailable_scratch_only_text"};
  } catch {
    return {source: "none", text: "", mtimeMs: null, reason: "ambiguous_input"};
  }
}

// Mission 045 (Backlog #46) Phase 1 task 1.1: the orchestrator fallback
// note. When the in-session hand-off note is missing or stale at the
// cap/wrap-up trigger, the orchestrator writes THIS note instead of resuming
// the capped session for an expensive model wrap-up turn (the wrap-up path
// in autopilot.mjs runWrapUp owns the write; this builder only renders the
// text). Pure by construction: the caller passes the decoded events, the
// precomputed `git diff --stat` output (empty string on failure), the repo
// root and — backlog #15 part 3b — optionally the paths THIS session changed
// (from its before/after snapshots); no filesystem, process, network or clock
// access here. Without sessionPaths the edit/write events are decoded, and an
// adapter with no decoded vocabulary keeps the raw diff it was handed.
// Bounded like the model-written note it replaces
// (HANDOFF_NOTE_MAX_CHARS_DEFAULT): the header and the diffStat block are
// fixed-budget, the digest renders with whatever room remains, and every cut
// is front-bounded with a marker so the task ref and the diff header always
// survive. Never throws — garbage input degrades to a shorter note, the
// same degrade-never-throw contract as the rest of the module.
export const FALLBACK_NOTE_DIFF_MAX_CHARS = 1200;

// Backlog #15 part 3b: keep only the diff-stat lines that belong to files this
// session changed. A line may be git's ` path | n +++` or the caller's
// ` path +N new` marker; both match a changed path exactly or by prefix
// (git abbreviates long paths with `...`). Never throws.
function filterDiffStatToPaths(diffStat, paths) {
  const lines = String(diffStat ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const wanted = paths.map((p) => String(p ?? "").replace(/\\/g, "/"));
  const isSummary = (line) => /^\d+ files? changed\b/.test(line);
  const fileLines = lines.filter((line) => !isSummary(line));
  const matched = fileLines.filter((line) => {
    const cleaned = line.replace(/^\s+/, "");
    return wanted.some((p) => cleaned === p || cleaned.startsWith(`${p} `)
      || cleaned.startsWith(`${p}|`) || cleaned.includes(` ${p} `)
      || cleaned.includes(` ${p} |`) || cleaned.includes(` ${p} +`)
      || cleaned.includes(` ${p} (new)`));
  });
  // Keep git's trailing summary only when every file line in the handed stat
  // was the session's own — otherwise its counts describe other sessions too.
  if (matched.length === fileLines.length) return [...matched, ...lines.filter(isSummary)];
  return matched;
}

export function buildOrchestratorFallbackNote(taskRef, events, adapterId, repoRoot, diffStat, capBreach = null, sessionPaths = null) {
  const ref = String(taskRef ?? "").replace(/\s+/g, " ").trim() || "<task-ref>";
  const bound = HANDOFF_NOTE_MAX_CHARS_DEFAULT;
  // Mission 049 Phase 1 task 1.2: cut context from the 1.1 helpers. The
  // runRelay wrap-up call site passes its capBreach record (figures); older
  // 5-arg callers degrade to the generic unknown-figures lines, never throw.
  let cutSection = "";
  try {
    cutSection = renderCutContextSection({adapterId, events, capBreach, repoRoot: String(repoRoot ?? "")});
  } catch { cutSection = ""; }
  if (!String(cutSection ?? "").trim()) {
    cutSection = [
      "Cut: unknown — no cap figures (session ended before the cap or figures unavailable)",
      "Point: unknown — no turn or token figures in the decoded events",
      "Largest read: (none: no decoded file reads)",
    ].join("\n");
  }
  // Backlog #15 part 3b: the changes section is session-only. When the caller
  // supplies the paths from the before/after snapshots, those win (they also
  // cover writes made through bash). Otherwise derive them from the decoded
  // edit/write events. An adapter with no decoded vocabulary keeps the raw
  // diff stat it was handed (legacy behaviour).
  let changedPaths = null;
  if (Array.isArray(sessionPaths)) changedPaths = sessionPaths.map((p) => String(p ?? "")).filter(Boolean);
  else if (adapterId === "opencode" || adapterId === "claude") {
    try { changedPaths = sessionEditPaths(adapterId, events, String(repoRoot ?? "")); } catch { changedPaths = []; }
  }
  const diffRaw = String(diffStat ?? "").replace(/\s+/g, " ").trim();
  let diffBody;
  if (changedPaths !== null) {
    if (changedPaths.length === 0) diffBody = "This session changed no files.";
    else {
      const kept = filterDiffStatToPaths(diffStat, changedPaths);
      diffBody = kept.length ? kept.join("\n") : changedPaths.map((p) => `${p} (changed)`).join("\n");
    }
  } else {
    diffBody = diffRaw || "(unavailable: git diff --stat failed or was empty)";
  }
  if (diffBody.length > FALLBACK_NOTE_DIFF_MAX_CHARS) {
    diffBody = `${diffBody.slice(0, FALLBACK_NOTE_DIFF_MAX_CHARS - 12)}… (truncated)`;
  }
  const header = [
    `# Handoff Note — ${ref} (orchestrator fallback)`,
    "",
    "This session was capped before it wrote a fresh hand-off note, so the",
    "orchestrator wrote this fallback instead of resuming the session for a",
    "model wrap-up turn. The changes this session made and the session work",
    "digest follow — read them before continuing the task.",
    "",
    "## Changes made in this session",
    "",
    "```text",
  ].join("\n");
  const cutHeading = [
    "```",
    "",
    "## Cut context",
    "",
  ].join("\n");
  const digestHeading = [
    "",
    "## Session work digest",
    "",
  ].join("\n");
  const tail = "\nNext session: continue the task from the digest above; commands it\nshows as already run must not be re-run.";
  const overhead = header.length + diffBody.length + cutHeading.length + cutSection.length + digestHeading.length + tail.length + 5;
  const digestMax = Math.max(HANDOFF_NOTE_MIN_CHARS, bound - overhead);
  const digest = sessionWorkDigest(adapterId, events, {maxChars: digestMax, repoRoot: String(repoRoot ?? "")});
  const digestBody = digest || "(none: this adapter exposes no decoded event vocabulary)";
  return [
    header,
    diffBody,
    cutHeading,
    cutSection,
    digestHeading,
    digestBody,
    tail,
  ].join("\n").slice(0, bound);
}

// Backlog #15 part 4: the two budget-checkpoint turns (85% and 95% of the
// per-task turn cap) at which a capped role is told to stop and refresh its
// hand-off note. Pure. Null for any `maxTurns` that is not a positive
// integer >= 4: a cap that small has no room between the checkpoints (and a
// non-integer or missing cap is not a cap at all).
export function handoffReminderTurns(maxTurns) {
  const n = Number(maxTurns);
  if (!Number.isInteger(n) || n < 4) return null;
  return {a: Math.floor(n * 0.85), b: Math.floor(n * 0.95)};
}

// The exact brief sentence appended to the "Keep a hand-off note at ..."
// milestone text for a capped role, or "" when no cap figure is available.
// Rendered from handoffReminderTurns so the two checkpoints and N can never
// drift apart.
export function handoffBudgetReminder(maxTurns) {
  const turns = handoffReminderTurns(maxTurns);
  if (!turns) return "";
  const n = Number(maxTurns);
  return `Budget checkpoints: at turn ${turns.a} and again at turn ${turns.b} of ${n}, stop and overwrite the hand-off note (Done / Found / Next / Dead ends) before anything else — your session ends at turn ${n} and anything not in the note is lost.`;
}

// Backlog #15 part 2: the orchestrator fallback note must never destroy a
// real (model-written) note left by an earlier session of the same task.
// The fallback text stays intact and first; a previous MODEL note is kept
// under this fixed heading. A previous note that is itself an orchestrator
// fallback is not nested again: only its own "Previous note (written by the
// model)" section (if any) is carried forward, so a real model note survives
// any number of consecutive fallbacks. The total is bounded to `maxChars` by
// trimming the PREVIOUS part (its beginning kept, `…(trimmed)` appended) —
// never the fallback part.
export const HANDOFF_PREVIOUS_NOTE_HEADING = "## Previous note (written by the model)";

function firstLineOfNote(text) {
  return String(text ?? "").split(/\r?\n/, 1)[0].trim();
}

// The builder's own heading shape: `# Handoff Note — <ref> (orchestrator
// fallback)`, and its failed-run variant `(orchestrator fallback, failed
// run)`. Anchored on the literal heading the builder emits, never a guess.
function isOrchestratorFallbackText(text) {
  const first = firstLineOfNote(text);
  return first.startsWith("# Handoff Note —") && first.includes("(orchestrator fallback");
}

function previousModelNoteSection(text) {
  const body = String(text ?? "");
  const at = body.indexOf(HANDOFF_PREVIOUS_NOTE_HEADING);
  if (at < 0) return "";
  return body.slice(at + HANDOFF_PREVIOUS_NOTE_HEADING.length).replace(/^\s*\n/, "").trim();
}

export function mergeFallbackWithPreviousNote(fallbackText, previousText, maxChars) {
  const bound = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : HANDOFF_NOTE_MAX_CHARS_DEFAULT;
  const fallback = String(fallbackText ?? "");
  const prev = String(previousText ?? "");
  const trimmedFallback = fallback.length > bound ? fallback.slice(0, bound) : fallback;
  let modelNote = "";
  if (prev.trim()) modelNote = isOrchestratorFallbackText(prev) ? previousModelNoteSection(prev) : prev.trim();
  if (!modelNote) return trimmedFallback;
  const heading = `\n\n${HANDOFF_PREVIOUS_NOTE_HEADING}\n`;
  const room = bound - trimmedFallback.length - heading.length;
  if (room <= 0) return trimmedFallback;
  if (modelNote.length <= room) return `${trimmedFallback}${heading}${modelNote}`;
  const marker = "…(trimmed)";
  if (room <= marker.length) return trimmedFallback;
  return `${trimmedFallback}${heading}${modelNote.slice(0, room - marker.length)}${marker}`;
}

// Mission 047 Phase 1 task 1.1: cumulative raw-token backstop. The per-turn
// cap (`growingTerm()` = maxSingleTurnContext) misses sessions that stay
// small every turn but burn tokens forever (30x35K = 1.05M cumulative, 35K
// max turn — no breach by construction). The backstop sums RAW cumulative
// tokens (input + cacheRead + cacheCreation + output, never the
// price-weighted figure) across the whole task and fires past a 6M default.
// Pure by construction: no filesystem, process, network, or clock reads —
// the caller passes usage objects and state in, never throws (ambiguous
// input is unenforceable / stale, never a breach).
export const BACKSTOP_RAW_TOKENS_DEFAULT = 6_000_000;
// Separate per-task firing ledger: lives in state.backstopFirings, NEVER in
// state.continuationBudgets, so `ap reset` of continuations, stale-budget
// cleanup, and continuation exhaustion can neither see nor touch it (and
// vice versa). Keyed with its own prefix via backstopLedgerKey().
export const BACKSTOP_FIRING_LEDGER_KEY_PREFIX = "backstopFirings:";
export const BACKSTOP_FIRING_LEDGER_MAX_ENTRIES = 10;
export function backstopLedgerKey(scope) {
  return `${BACKSTOP_FIRING_LEDGER_KEY_PREFIX}${String(scope ?? "")}`;
}
function backstopKey(scope) {
  return backstopLedgerKey(scope);
}

// Raw cumulative total of ONE accumulated usage object: input + cacheRead +
// cacheCreation + output. Null/absent/non-object usage is never a zero
// reading (returns null). Missing cacheCreation counts as 0 (legacy shapes);
// missing/non-finite input, cacheRead, or output means unmeasurable -> null.
export function rawTotalTokens(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = Number(usage.input);
  const cacheRead = Number(usage.cacheRead);
  const output = Number(usage.output);
  if (!Number.isFinite(input) || !Number.isFinite(cacheRead) || !Number.isFinite(output)) return null;
  const rawCreation = usage.cacheCreation ?? usage.cache_creation ?? 0;
  const cacheCreation = Number(rawCreation);
  if (!Number.isFinite(cacheCreation)) return null;
  return input + cacheRead + cacheCreation + output;
}

// Sum of rawTotalTokens() over an array of usage objects (e.g. one per
// generation, or one per session). Skips unmeasurable entries; returns null
// when NO entry is measurable (never 0 for an empty/unmeasured list).
export function cumulativeRawTotal(usages) {
  if (!Array.isArray(usages)) return null;
  let total = 0;
  let seen = false;
  for (const usage of usages) {
    const raw = rawTotalTokens(usage);
    if (raw === null) continue;
    total += raw;
    seen = true;
  }
  return seen ? total : null;
}

// Resolve the effective backstop limit. Absent/invalid means the code
// default (6M), never "unbounded". Precedence: per-role
// policy.caps.<role>.backstop_raw_tokens wins over the policy-level
// policy.backstop_raw_tokens. The implementer is configured ONLY through the
// policy-level key — policy.caps.implementer is rejected by
// validatePolicyConfig (the implementer has no caps entry), so the per-role
// read is skipped for it and a hand-edited caps.implementer is never honored.
export function resolveBackstopRawTokens(policy = {}, roleName) {
  const role = String(roleName ?? "").toLowerCase();
  const caps = role && role !== "implementer" ? policy?.caps?.[role] : undefined;
  const rawRole = caps ? Number(caps.backstop_raw_tokens) : NaN;
  if (Number.isInteger(rawRole) && rawRole > 0) return rawRole;
  const rawPolicy = Number(policy?.backstop_raw_tokens);
  if (Number.isInteger(rawPolicy) && rawPolicy > 0) return rawPolicy;
  return BACKSTOP_RAW_TOKENS_DEFAULT;
}

// Breach evaluator. Accepts either a precomputed totalRawTokens or a usage
// object (rawTotalTokens() derived). At the limit is NOT a breach (same
// at-cap contract as evaluateTokenCeiling). Returns
// {breached, enforceable, reason, total, limit}. Reasons: "breach" |
// "within_backstop" | "usage_unavailable" | "no_backstop_configured".
export function evaluateBackstopBreach({usage, totalRawTokens, limit, backstopLimit} = {}) {
  const rawLimit = limit !== undefined ? Number(limit) : Number(backstopLimit);
  if (!Number.isInteger(rawLimit) || rawLimit <= 0) {
    return {breached: false, enforceable: false, reason: "no_backstop_configured", total: null, limit: null};
  }
  let total = null;
  if (totalRawTokens !== undefined && totalRawTokens !== null) {
    const num = Number(totalRawTokens);
    total = Number.isFinite(num) && num >= 0 ? num : null;
  } else if (usage !== undefined) {
    total = rawTotalTokens(usage);
  }
  if (total === null) {
    return {breached: false, enforceable: false, reason: "usage_unavailable", total: null, limit: rawLimit};
  }
  if (total > rawLimit) {
    return {breached: true, enforceable: true, reason: "breach", total, limit: rawLimit};
  }
  return {breached: false, enforceable: true, reason: "within_backstop", total, limit: rawLimit};
}

// Record one backstop firing in the SEPARATE per-task ledger
// (state.backstopFirings — never state.continuationBudgets). firing carries
// whatever evidence the caller has ({generation, totalRawTokens, turns,
// maxSingleTurnContext}); garbage firing degrades to {}. Bounded to
// BACKSTOP_FIRING_LEDGER_MAX_ENTRIES entries (oldest dropped). Returns the
// task's firing list after recording.
export function recordBackstopFiring(state, scope, firing = {}) {
  const key = backstopKey(scope);
  if (!state || typeof state !== "object") return [];
  state.backstopFirings = state?.backstopFirings && typeof state.backstopFirings === "object"
    ? state.backstopFirings
    : {};
  const list = Array.isArray(state.backstopFirings[key]) ? state.backstopFirings[key] : [];
  const entry = firing && typeof firing === "object" && !Array.isArray(firing) ? {...firing} : {};
  list.push(entry);
  while (list.length > BACKSTOP_FIRING_LEDGER_MAX_ENTRIES) list.shift();
  state.backstopFirings[key] = list;
  return list;
}

export function readBackstopFirings(state, scope) {
  const key = backstopKey(scope);
  const list = state?.backstopFirings?.[key];
  return Array.isArray(list) ? list : [];
}

export function clearBackstopFirings(state, scope) {
  if (!state?.backstopFirings || typeof state.backstopFirings !== "object") return false;
  const key = backstopKey(scope);
  if (!(key in state.backstopFirings)) return false;
  delete state.backstopFirings[key];
  return true;
}

// Consecutive-firing escalation decision. The ledger is per-task and only
// appended on firing (cleared on task success), so two recorded firings ARE
// two consecutive firings — the second one escalates. Pure: takes the firing
// list (or {firings}), never state. Returns
// {escalate, reason, consecutiveFirings}. Reasons:
// "second_consecutive_firing" | "first_firing_no_escalation" | "no_firings" |
// "ambiguous_input".
export function evaluateBackstopEscalation(firings) {
  const list = Array.isArray(firings) ? firings : (firings && Array.isArray(firings.firings) ? firings.firings : null);
  if (list === null) return {escalate: false, reason: "ambiguous_input", consecutiveFirings: 0};
  if (list.length === 0) return {escalate: false, reason: "no_firings", consecutiveFirings: 0};
  if (list.length >= 2) return {escalate: true, reason: "second_consecutive_firing", consecutiveFirings: list.length};
  return {escalate: false, reason: "first_firing_no_escalation", consecutiveFirings: 1};
}

export function handleRoleBackstopFiring(state, scope, relayResult = {}) {
  const capped = relayResult?.capped || {};
  const usage = relayResult?.usage;
  const firings = recordBackstopFiring(state, scope, {
    generation: readBackstopFirings(state, scope).length + 1,
    totalRawTokens: capped.used,
    turns: Number.isInteger(usage?.turns) ? usage.turns : null,
    maxSingleTurnContext: Number.isFinite(Number(usage?.maxSingleTurnContext)) ? Number(usage.maxSingleTurnContext) : null,
  });
  const decision = evaluateBackstopEscalation(firings);
  return {escalate: decision.escalate, firings, last: firings[firings.length - 1] || {}};
}
