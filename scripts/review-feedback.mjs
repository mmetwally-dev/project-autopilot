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

import {splitManualCheckFindings} from "./task-requirements.mjs";

export const MAX_FINDINGS = 20;
export const MAX_FINDING_CHARS = 1000;
export const MAX_CORRECTION_CHARS = 700;
export const MAX_TOTAL_CHARS = 10000;

// Backlog #9 / #8: defect pattern instruction for reviewer/verifier and implementer
export const REVIEW_DEFECT_PATTERN_INSTRUCTION =
  "When you find a defect, search the phase's changed files for the same pattern and list EVERY location as its own finding in this verdict; if the defect is a weak rule in a check (such as an arbitrary size, length, or file-type limit that lets bad input through), report the root flaw and every boundary of it in ONE finding with the correction for the whole rule rather than one edge case per round";
export const DEFECT_PATTERN_REVIEW_INSTRUCTION = REVIEW_DEFECT_PATTERN_INSTRUCTION;

export const DEFECT_PATTERN_FIX_INSTRUCTION =
  "fix this pattern everywhere it occurs in the phase's files, not only at the cited line, and fix the underlying rule rather than adding another limit that only covers the named case";
export const IMPLEMENTER_DEFECT_PATTERN_INSTRUCTION = DEFECT_PATTERN_FIX_INSTRUCTION;

// Backlog #11: root-flaw rule and matching fix rule for plan/spec reviews
export {
  PLAN_REVIEW_DEFECT_PATTERN_INSTRUCTION,
  PLAN_REVIEW_ROOT_FLAW_INSTRUCTION,
  DEFECT_PATTERN_PLAN_REVIEW_INSTRUCTION,
  PLAN_REVIEW_DEFECT_PATTERN_FIX_INSTRUCTION,
  PLAN_DEFECT_PATTERN_FIX_INSTRUCTION,
  PLAN_REVIEW_ROOT_FLAW_FIX_INSTRUCTION,
  PLANNER_DEFECT_PATTERN_FIX_INSTRUCTION,
  PLANNER_ROOT_FLAW_FIX_INSTRUCTION,
} from "./plan-review-rounds.mjs";

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
  const {implementationFindings} = splitManualCheckFindings(raw);
  const out = [];
  let total = 0;
  for (const entry of implementationFindings) {
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

// ── Backlog item #4: Still-open findings tracking across review rounds ──

export const OPEN_FINDINGS_STATE_KEY = "reviewOpenFindings";

function normMatchText(text) {
  return String(text || "")
    .replace(/^\s*\d+\.\s+/, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.。]+$/g, "")
    .trim();
}

function matchTokens(text) {
  return normMatchText(text)
    .split(/[^a-z0-9_./:-]+/)
    .filter(t => t.length >= 3 || t.includes("/") || t.includes(".") || t.includes("_"));
}

function sameOrOverlappingFinding(listedText, prevText, allowTokenOverlap = false) {
  const a = normMatchText(listedText);
  const b = normMatchText(prevText);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  if (!allowTokenOverlap) return false;
  const ta = new Set(matchTokens(listedText));
  const tb = matchTokens(prevText);
  if (!ta.size || !tb.length) return false;
  let shared = 0;
  for (const t of tb) if (ta.has(t)) shared++;
  const needed = tb.length === 1 ? 1 : Math.max(2, Math.ceil(tb.length * 0.5));
  return shared >= needed;
}

function normalizePreviousEntries(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const text = String(entry.finding ?? entry.problem ?? entry.text ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
    const st = String(entry.status ?? "").toLowerCase().replace(/[\s-]+/g, "_");
    const status = st === "fixed"
      ? "fixed"
      : (st === "not_fixed" || st === "notfixed" || st === "unfixed")
        ? "not_fixed"
        : (st === "needs_run" || st === "needsrun")
          ? "needs_run"
          : null;
    if (text && status) out.push({ finding: text, status });
    if (out.length >= 40) break;
  }
  return out;
}

// Normalized location: problem key used for deduplicating re-raised findings.
export function normalizeFindingKey(f) {
  if (!f) return "";
  if (typeof f === "object" && !Array.isArray(f)) {
    const loc = String(f.location ?? f.file ?? f.path ?? "").replace(/\s+/g, " ").trim();
    const text = String(f.text ?? f.problem ?? f.issue ?? f.message ?? f.finding ?? "").replace(/\s+/g, " ").trim();
    let combined = "";
    if (loc && text) {
      combined = text.startsWith(loc) ? text : `${loc}: ${text}`;
    } else {
      combined = loc || text;
    }
    const s = combined.replace(/\s+/g, " ").trim();
    const markerIdx = s.indexOf(CORRECTION_MARKER);
    if (markerIdx !== -1) {
      const head = s.slice(0, markerIdx).trim();
      if (head) return head;
    }
    return s;
  }
  const s = String(f).replace(/\s+/g, " ").trim();
  const markerIdx = s.indexOf(CORRECTION_MARKER);
  if (markerIdx !== -1) {
    const head = s.slice(0, markerIdx).trim();
    if (head) return head;
  }
  return s;
}

export function loadReviewOpenFindings(state, key) {
  const slot = state?.[OPEN_FINDINGS_STATE_KEY]?.[key];
  if (!Array.isArray(slot)) return [];
  return slot.filter(e => e && typeof e === "object" && typeof e.id === "string" && typeof e.text === "string");
}

export function saveReviewOpenFindings(state, key, findings) {
  if (!state || typeof state !== "object" || !key) return [];
  if (!Array.isArray(findings) || !findings.length) {
    clearReviewOpenFindings(state, key);
    return [];
  }
  if (!state[OPEN_FINDINGS_STATE_KEY] || typeof state[OPEN_FINDINGS_STATE_KEY] !== "object") {
    state[OPEN_FINDINGS_STATE_KEY] = {};
  }
  state[OPEN_FINDINGS_STATE_KEY][key] = findings;
  return findings;
}

export function clearReviewOpenFindings(state, key) {
  if (state?.[OPEN_FINDINGS_STATE_KEY] && typeof state[OPEN_FINDINGS_STATE_KEY] === "object") {
    if (key) delete state[OPEN_FINDINGS_STATE_KEY][key];
    else delete state[OPEN_FINDINGS_STATE_KEY];
    if (state[OPEN_FINDINGS_STATE_KEY] && !Object.keys(state[OPEN_FINDINGS_STATE_KEY]).length) {
      delete state[OPEN_FINDINGS_STATE_KEY];
    }
  }
}

export function clearReviewOpenFindingsByPrefix(state, prefix) {
  if (!state?.[OPEN_FINDINGS_STATE_KEY] || typeof state[OPEN_FINDINGS_STATE_KEY] !== "object") return;
  if (!prefix || typeof prefix !== "string") return;
  for (const k of Object.keys(state[OPEN_FINDINGS_STATE_KEY])) {
    if (k.startsWith(prefix)) delete state[OPEN_FINDINGS_STATE_KEY][k];
  }
  if (state[OPEN_FINDINGS_STATE_KEY] && !Object.keys(state[OPEN_FINDINGS_STATE_KEY]).length) {
    delete state[OPEN_FINDINGS_STATE_KEY];
  }
}

// Deduplication check: match a new finding against an earlier open finding
// either by explicit finding ID or identical location+problem.
export function matchFinding(newItem, existing) {
  if (!newItem || !existing) return false;
  const newRaw = typeof newItem === "object" && "raw" in newItem ? newItem.raw : newItem;
  const newText = typeof newItem === "object" && "text" in newItem ? newItem.text : String(newItem || "");

  // 1. Same ID: explicit citation in text or raw
  const exId = String(existing.id || "").trim();
  if (exId) {
    if (typeof newRaw === "object" && newRaw && String(newRaw.id || "").trim().toUpperCase() === exId.toUpperCase()) {
      return true;
    }
    const idRegex = new RegExp(`(^|[\\[\\s(])${exId}([\\]\\s:)-]|$)`, "i");
    if (idRegex.test(newText) || (typeof newRaw === "string" && idRegex.test(newRaw))) {
      return true;
    }
  }

  // 2. Identical location + problem
  const kNew = normalizeFindingKey(newRaw || newText);
  const kEx = normalizeFindingKey(existing.raw || existing.text);
  if (kNew && kEx && kNew === kEx) {
    return true;
  }

  return false;
}

// Compute the merged open findings after a review round driven by reviewer's "previous" statuses:
// On FAIL:
// - dropped if reviewer's "previous" marks it fixed (or needs_run).
// - carried (kept in openFindings) if marked not_fixed OR missing from "previous".
// - re-raised duplicates in newFindings deduplicate with existing entries.
export function updateReviewOpenFindings(state, key, { newFindings = [], previous = [] } = {}) {
  const earlierOpen = loadReviewOpenFindings(state, key);
  const normalizedPrev = normalizePreviousEntries(previous);

  const matchedPrevIdx = new Set();
  const dropped = [];
  const remainingEarlier = [];

  for (let i = 0; i < earlierOpen.length; i++) {
    const ef = earlierOpen[i];
    let matchedEntry = null;

    // Pass 1: exact, ID, location+problem, or substring match
    for (let j = 0; j < normalizedPrev.length; j++) {
      if (matchedPrevIdx.has(j)) continue;
      const prev = normalizedPrev[j];
      const pText = String(prev.finding || "").trim();
      const exId = String(ef.id || "").trim();
      const efText = String(ef.text || "").trim();
      const efFull = exId ? `${exId}: ${efText}` : efText;

      let hit = false;
      if (exId) {
        if (pText.toUpperCase() === exId.toUpperCase()) hit = true;
        else {
          const idRegex = new RegExp(`(^|[\\[\\s(])${exId}([\\]\\s:)-]|$)`, "i");
          if (idRegex.test(pText)) hit = true;
        }
      }
      if (!hit && matchFinding(pText, ef)) hit = true;
      if (!hit && sameOrOverlappingFinding(efText, pText, false)) hit = true;
      if (!hit && sameOrOverlappingFinding(efFull, pText, false)) hit = true;

      if (hit) {
        matchedPrevIdx.add(j);
        matchedEntry = prev;
        break;
      }
    }

    // Pass 2: token overlap for shortened/paraphrased text
    if (!matchedEntry) {
      for (let j = 0; j < normalizedPrev.length; j++) {
        if (matchedPrevIdx.has(j)) continue;
        const prev = normalizedPrev[j];
        const pText = String(prev.finding || "").trim();
        const efText = String(ef.text || "").trim();
        const efFull = ef.id ? `${ef.id}: ${efText}` : efText;

        if (sameOrOverlappingFinding(efText, pText, true) || sameOrOverlappingFinding(efFull, pText, true)) {
          matchedPrevIdx.add(j);
          matchedEntry = prev;
          break;
        }
      }
    }

    // Pass 3: positional fallback when lengths match
    if (!matchedEntry && i < normalizedPrev.length && !matchedPrevIdx.has(i)) {
      matchedPrevIdx.add(i);
      matchedEntry = normalizedPrev[i];
    }

    if (matchedEntry && (matchedEntry.status === "fixed" || matchedEntry.status === "needs_run")) {
      dropped.push(ef);
    } else {
      // not_fixed or missing -> CARRIED
      remainingEarlier.push(ef);
    }
  }

  const normalizedNew = normalizeFindingsWithSource(newFindings);

  let maxSeq = 0;
  for (const f of earlierOpen) {
    const m = String(f.id || "").match(/^F(\d+)$/i);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
    }
  }

  const reRaised = [];
  const newlyAdded = [];
  const updatedOpen = [...remainingEarlier];

  for (const item of normalizedNew) {
    const rendered = item.text;
    const raw = (item.raw && typeof item.raw === "object") ? JSON.parse(JSON.stringify(item.raw)) : item.raw;
    const matchIdx = updatedOpen.findIndex(ef => matchFinding(item, ef));
    if (matchIdx !== -1) {
      const existing = updatedOpen[matchIdx];
      const tasks = (Array.isArray(raw?.tasks) && raw.tasks.length)
        ? raw.tasks.map(String)
        : ((Array.isArray(raw?.taskIds) && raw.taskIds.length) ? raw.taskIds.map(String) : existing.tasks || []);
      const updated = {
        ...existing,
        text: rendered,
        raw: (raw && typeof raw === "object") ? { ...raw, tasks } : raw,
        tasks,
      };
      updatedOpen[matchIdx] = updated;
      reRaised.push(updated);
    } else {
      maxSeq += 1;
      const id = `F${maxSeq}`;
      const tasks = (Array.isArray(raw?.tasks) && raw.tasks.length)
        ? raw.tasks.map(String)
        : ((Array.isArray(raw?.taskIds) && raw.taskIds.length) ? raw.taskIds.map(String) : []);
      const newEntry = {
        id,
        text: rendered,
        raw: (raw && typeof raw === "object") ? { ...raw, tasks } : raw,
        tasks,
      };
      updatedOpen.push(newEntry);
      newlyAdded.push(newEntry);
    }
  }

  saveReviewOpenFindings(state, key, updatedOpen);

  return {
    openFindings: updatedOpen,
    dropped,
    remainingEarlier,
    reRaised,
    newlyAdded,
  };
}

// Format still-open findings for re-review briefs with short stable IDs.
// Capped at max (default 20) with a count of the rest to prevent unbounded prompts.
export function formatReviewOpenFindingsBrief(openFindings, { max = 20 } = {}) {
  if (!Array.isArray(openFindings) || !openFindings.length) return "";
  const shown = openFindings.slice(0, max);
  const remainingCount = openFindings.length - shown.length;
  const lines = [
    'Still-open findings from earlier review rounds (for each, verify if fixed; report in "previous" with status "fixed", "not_fixed", or "needs_run"):',
    ...shown.map(f => `${f.id}: ${f.text}`),
  ];
  if (remainingCount > 0) {
    lines.push(`(...and ${remainingCount} more earlier open finding(s))`);
  }
  return lines.join("\n");
}


