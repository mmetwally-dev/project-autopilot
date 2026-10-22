// Plan-review round discipline (backlog #100). No hard round limit: instead
// round 1 must be exhaustive, later rounds verify fixes and raise new findings
// only when the revision introduced them or they would break execution, and the
// planner revision brief carries the cumulative findings of EVERY earlier round
// so a fix for one finding does not reopen another. Pure text/state helpers.
import { normalizeFindings } from "./review-feedback.mjs";
import { normalizePreviousStatuses } from "./code-review-rounds.mjs";

const STATE_KEY = "planReviewHistory";
const MAX_CUMULATIVE_CHARS = 16000;

export const PLAN_REVIEW_EXHAUSTIVE_LINE =
  "This is review round 1 — make it EXHAUSTIVE: report every problem you can find in this first review, across all categories you check, not one batch at a time. Later rounds will only verify the fixes and the changes made, so anything you leave out now will not be looked for again.";

export const PLAN_REVIEW_VERIFY_LINE =
  'This is a later review round. First verify each previous finding listed below was fixed (go through them one by one) and report the outcome in the final sentinel as "previous":[{"finding":"<the previous finding text, shortened>","status":"fixed"|"not_fixed"}] (one entry per previous finding; keep a not_fixed one in "findings" too). Raise NEW findings only if this revision introduced them, or if they would actually break execution; do not raise new style, preference or nice-to-have findings about content that was already reviewed.';

function slot(state, key) {
  const list = state?.[STATE_KEY]?.[key];
  return Array.isArray(list) ? list : [];
}

export function planReviewRoundCount(state, key) { return slot(state, key).length; }

// Append one failed round's findings (bounded, normalized). Empty -> no-op.
export function recordPlanReviewRound(state, key, findings, previous = []) {
  if (!state || typeof state !== "object" || !key) return 0;
  const normalized = normalizeFindings(findings);
  if (!normalized.length) return planReviewRoundCount(state, key);
  if (!state[STATE_KEY] || typeof state[STATE_KEY] !== "object") state[STATE_KEY] = {};
  const list = slot(state, key).slice();
  list.push({ round: list.length + 1, findings: normalized, previous: normalizePreviousStatuses(previous) });
  state[STATE_KEY][key] = list;
  return list.length;
}

// Resume from older state that has current findings but no history yet.
export function seedPlanReviewHistory(state, key, findings) {
  if (planReviewRoundCount(state, key) === 0) recordPlanReviewRound(state, key, findings);
}

export function clearPlanReviewHistory(state, key) {
  if (!state?.[STATE_KEY] || typeof state[STATE_KEY] !== "object") return;
  if (key) delete state[STATE_KEY][key]; else delete state[STATE_KEY];
  if (state[STATE_KEY] && !Object.keys(state[STATE_KEY]).length) delete state[STATE_KEY];
}

function render(rounds) {
  const blocks = rounds.map(r => `Round ${r.round}:\n${(Array.isArray(r.findings) ? r.findings : []).map((f, i) => `${i + 1}. ${f}`).join("\n")}`);
  // Bounded: drop the oldest rounds first.
  while (blocks.length > 1 && blocks.join("\n\n").length > MAX_CUMULATIVE_CHARS) blocks.shift();
  return blocks.join("\n\n");
}

// Reviewer brief lines for the NEXT review (rounds already recorded = previous).
export function planReviewerRoundLines(state, key) {
  const rounds = slot(state, key);
  if (!rounds.length) return [PLAN_REVIEW_EXHAUSTIVE_LINE];
  return [PLAN_REVIEW_VERIFY_LINE, `Previous findings from all earlier review rounds (verify each):\n${render(rounds)}`];
}

// Planner revision brief: findings of all rounds BEFORE the latest (the latest
// is already quoted as the feedback that must be addressed).
export function plannerEarlierRoundsText(state, key) {
  const rounds = slot(state, key).slice(0, -1);
  if (!rounds.length) return "";
  return `Findings from ALL earlier review rounds (already addressed once — keep them fixed; your fixes for the current findings must not reopen any of them):\n${render(rounds)}`;
}
