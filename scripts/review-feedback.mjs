// Bounded, self-contained review feedback that survives a process restart.
//
// Reviewer findings are the ONLY channel that tells a retried Planner or
// Implementer what to correct. Two independent defects made that channel
// unreliable, both observed together in one real mission:
//
//   1. Findings were persisted to state.json (s.feedback,
//      s.standalonePlanReview) but never read back, so every loop restarted
//      its feedback from "" after a stop/crash. The retried role then had to
//      REDISCOVER the review by reading runs/ logs. One observed planner
//      spent 22 of its 50 tool calls grepping a 138KB spilled tool-result
//      file for findings it should simply have been handed — 3,160,278
//      cached input tokens for a single plan revision.
//
//   2. Findings were bare one-line summaries ("X is hard-coded to a
//      nonexistent repository path.") carrying no location and no required
//      correction, so even when they WERE delivered the role still went
//      looking for the detail behind them.
//
// The bounding here is deliberate and is the whole point: handing back the
// reviewer's entire final message or stdout would remove the searching but
// reintroduce exactly the bloat that searching caused. Findings are capped
// per item, in count, and in total.
//
// Everything is re-validated fail-closed on LOAD, not only on save:
// state.json is user-editable, may have been written by an older version,
// and is never trusted blindly — the same posture
// sanitizedPostconditionFeedback() already takes for SpecKit checkpoints.
// Anything malformed is dropped rather than repaired or fabricated, because
// a wrong correction instruction is worse than none.

export const MAX_FINDINGS = 20;
export const MAX_FINDING_CHARS = 1000;
export const MAX_CORRECTION_CHARS = 700;
export const MAX_TOTAL_CHARS = 10000;

const STATE_KEY = "reviewFeedback";

// A finding may arrive as a plain string (the long-standing contract) or as
// a structured {location, problem, correction} object (what reviewers are
// now asked to produce). Both normalize to one line so every consumer —
// prompt text, state.json, tests — sees a single stable shape.
//
// `clamped` is deliberately opt-out. The length budget exists to stop
// feedback being re-injected into prompts and persisted unboundedly; it must
// NOT apply to the parsed verdict itself, because findings are also used as
// a verbatim data channel — the Playwright verifier returns its entire
// sandbox probe as a single base64 "PW_PROBE_B64:..." finding, and clamping
// that truncates evidence the caller then cannot decode.
const CORRECTION_MARKER = "Required correction:";
const CORRECTION_SEP_WITH_HEAD = " Required correction: ";
const CORRECTION_SEP_BARE = "Required correction: ";

export function renderFinding(finding, {clamped = true} = {}) {
  if (typeof finding === "string") {
    const collapsed = collapse(finding);
    if (!clamped) return collapsed;
    return clampFindingString(collapsed);
  }
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) return "";
  const location = collapse(finding.location ?? finding.file ?? finding.path ?? "");
  const problem = collapse(finding.problem ?? finding.issue ?? finding.message ?? "");
  const correction = collapse(finding.correction ?? finding.fix ?? finding.required ?? "");
  // A finding with no problem statement says nothing actionable at all; a
  // location or a correction alone cannot be acted on either.
  if (!problem) return "";
  const parts = [];
  if (location) parts.push(`${location}: ${problem}`);
  else parts.push(problem);
  if (correction) parts.push(`Required correction: ${correction}`);
  const full = parts.join(" ");
  if (!clamped) return full;
  if (!correction) return clamp(full);
  const head = location ? `${location}: ${problem}` : problem;
  return clampWithCorrection(head, correction);
}

// Bounded, fail-closed normalization WITH the original entry kept alongside
// each rendered string. This is the single place the drop/cap rules live:
// normalizeFindings() is this function with the `raw` half thrown away, and
// finding-task-locality.mjs's mapFindingsToTasks() iterates this one too — so
// a task tag read from a finding can never be index-shifted against the list
// of strings that actually survives.
//
// Non-arrays yield [], unusable entries are dropped, and both the per-finding
// and whole-list budgets are enforced here so no caller can bypass them.
export function normalizeFindingsWithSource(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  let total = 0;
  for (const entry of raw) {
    if (out.length >= MAX_FINDINGS) break;
    const rendered = renderFinding(entry);
    if (!rendered) continue;
    if (total + rendered.length > MAX_TOTAL_CHARS) break;
    total += rendered.length;
    out.push({text: rendered, raw: entry});
  }
  return out;
}

// Bounded, fail-closed normalization. Byte-identical output to the original
// hand-rolled loop — the rules above are unchanged, only hoisted.
export function normalizeFindings(raw) {
  return normalizeFindingsWithSource(raw).map(entry => entry.text);
}

// Persist findings for one retry loop, addressed by a caller-chosen key
// (e.g. "standalone-plan", `standalone-task:${line}`). Storing an empty or
// unusable set clears the slot rather than leaving a stale one behind — a
// PASS must never leave the previous FAIL's findings readable.
export function saveReviewFeedback(state, key, findings) {
  if (!state || typeof state !== "object" || !key) return [];
  const normalized = normalizeFindings(findings);
  if (!normalized.length) { clearReviewFeedback(state, key); return []; }
  if (!state[STATE_KEY] || typeof state[STATE_KEY] !== "object") state[STATE_KEY] = {};
  state[STATE_KEY][key] = {findings: normalized, at: new Date().toISOString()};
  return normalized;
}

// Re-validated on the way out: a hand-edited, truncated, or older-format
// entry yields [] (start fresh) instead of a malformed instruction.
export function loadReviewFeedback(state, key) {
  const slot = state?.[STATE_KEY]?.[key];
  if (!slot || typeof slot !== "object") return [];
  return normalizeFindings(slot.findings);
}

export function clearReviewFeedback(state, key) {
  if (state?.[STATE_KEY] && typeof state[STATE_KEY] === "object") delete state[STATE_KEY][key];
}

export function clearReviewFeedbackByPrefix(state, prefix) {
  if (!state?.[STATE_KEY] || typeof state[STATE_KEY] !== "object") return;
  if (!prefix || typeof prefix !== "string") return;
  for (const k of Object.keys(state[STATE_KEY])) {
    if (k.startsWith(prefix)) delete state[STATE_KEY][k];
  }
}

// Prompt-ready text. Empty string when there is nothing to say, so call
// sites can keep using `feedback ? ... : ""` unchanged.
export function feedbackText(findings) {
  const normalized = normalizeFindings(findings);
  if (!normalized.length) return "";
  return normalized.map((f, i) => `${i + 1}. ${f}`).join("\n");
}

function collapse(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function clamp(text) {
  if (text.length <= MAX_FINDING_CHARS) return text;
  return `${text.slice(0, MAX_FINDING_CHARS - 1).trimEnd()}…`;
}

// Split a collapsed plain-string finding at the first correction marker.
// Returns {head, correction}; when there is no marker the whole string is
// the head and correction is "".
function splitStringFinding(text) {
  const idx = text.indexOf(CORRECTION_MARKER);
  if (idx === -1) return {head: text, correction: ""};
  return {head: text.slice(0, idx).trimEnd(), correction: text.slice(idx + CORRECTION_MARKER.length).trim()};
}

function capCorrection(correction) {
  if (correction.length <= MAX_CORRECTION_CHARS) return correction;
  return `${correction.slice(0, MAX_CORRECTION_CHARS - 1).trimEnd()}…`;
}

// Clamped path that keeps the required correction whole: the correction is
// capped on its own tail first, then — if the joined text still exceeds the
// per-finding budget — only the head is shortened. Idempotent: a second pass
// over the output returns it unchanged, which loadReviewFeedback() relies on
// (it re-runs normalizeFindings() on strings already saved in state.json).
function clampWithCorrection(head, correction) {
  const capped = capCorrection(correction);
  const sep = head ? CORRECTION_SEP_WITH_HEAD : CORRECTION_SEP_BARE;
  const full = `${head}${sep}${capped}`;
  if (full.length <= MAX_FINDING_CHARS) return full;
  // Correction alone (+ marker) always fits: capped <= 700, sep <= 22, so the
  // head budget is >= 278. Only the head is shortened, ending with ….
  const headBudget = MAX_FINDING_CHARS - sep.length - capped.length;
  const truncatedHead = `${head.slice(0, Math.max(0, headBudget - 1)).trimEnd()}…`;
  return `${truncatedHead}${sep}${capped}`;
}

function clampFindingString(collapsed) {
  if (collapsed.length <= MAX_FINDING_CHARS) {
    // Still enforce the standalone correction cap so an over-long correction
    // cannot ride along inside a short-headed string; otherwise pass through
    // byte-identical (including odd spacing) to preserve current behavior.
    const {head, correction} = splitStringFinding(collapsed);
    if (!correction) return collapsed;
    const capped = capCorrection(correction);
    if (capped === correction) return collapsed;
    const sep = head ? CORRECTION_SEP_WITH_HEAD : CORRECTION_SEP_BARE;
    return `${head}${sep}${capped}`;
  }
  const {head, correction} = splitStringFinding(collapsed);
  // No correction marker: historical behavior — keep the start, end with ….
  if (!correction) return clamp(collapsed);
  if (!head) {
    // Bare "Required correction: ..." never exceeds the budget once the
    // correction is capped (21 + 700 < 1000), so just cap the correction.
    const sep = CORRECTION_SEP_BARE;
    const capped = capCorrection(correction);
    const full = `${sep}${capped}`;
    if (full.length <= MAX_FINDING_CHARS) return full;
    return clamp(full);
  }
  return clampWithCorrection(head, correction);
}
