// Plan-review round discipline (backlog #100). No hard round limit: instead
// round 1 must be exhaustive, later rounds verify fixes and raise new findings
// only when the revision introduced them or they would break execution, and the
// planner revision brief carries the cumulative findings of EVERY earlier round
// so a fix for one finding does not reopen another. Pure text/state helpers.
import { normalizeFindings } from "./review-feedback.mjs";
import { normalizePreviousStatuses } from "./code-review-rounds.mjs";

const STATE_KEY = "planReviewHistory";
const NOTES_KEY = "planReviewNotes";
const MAX_CUMULATIVE_CHARS = 16000;

// The operator's severity split (backlog #8): only a problem that would make
// the plan wrong or unexecutable may FAIL a review. Everything cosmetic or
// optional is recorded as a note, so a fresh full read cannot keep looping on
// line anchors and wording nits. Shared by every plan-review brief below.
export const PLAN_REVIEW_SEVERITY_LINE =
  'Classify every problem by severity. BLOCKING = wrong behaviour or logic, a missing or contradictory requirement, a wrong API or data contract, an unsafe data or permission path, a requirement or task that cannot be tested or executed, or a test the change will break that the plan does not list. MINOR = line-number anchors, wording or precision, cross-reference nits, style, and nice-to-have extra tests or coverage. Put only BLOCKING problems in "findings"; return FAIL only when there is at least one. List MINOR ones in a separate "notes" array of strings in the final sentinel — they do not fail the review.';

export const PLAN_REVIEW_EXHAUSTIVE_LINE =
  `This is review round 1 — make it EXHAUSTIVE: report every problem you can find in this first review, across all categories you check, not one batch at a time. Later rounds will only verify the fixes and the changes made, so anything you leave out now will not be looked for again. ${PLAN_REVIEW_SEVERITY_LINE}`;

export const PLAN_REVIEW_VERIFY_LINE =
  `This is a later review round. First verify each previous finding listed below was fixed (go through them one by one) and report the outcome in the final sentinel as "previous":[{"finding":"<the previous finding text, shortened>","status":"fixed"|"not_fixed"}] (one entry per previous finding; keep a not_fixed one in "findings" too). Raise NEW findings only if this revision introduced them, or if they would actually break execution; do not raise new style, preference or nice-to-have findings about content that was already reviewed. ${PLAN_REVIEW_SEVERITY_LINE}`;

export const PLAN_REVIEW_FULL_LINE =
  `Review the whole plan again from scratch. Report every problem you can find in the current revision, across all categories you check, not just whether the previously reported ones were fixed. Earlier fixes stay in scope: a regression or a newly visible problem anywhere in the plan is a valid finding. ${PLAN_REVIEW_SEVERITY_LINE}`;

// A scoped PASS only verified the earlier findings and the changes made since.
// Before it is accepted, one fresh FULL review must run with no previous
// findings in its brief — marked so logs/run notes can identify it as the
// confirmation round. It reviews everything again, but only BLOCKING problems
// may fail it; minor points are notes, so the confirmation cannot loop on
// line anchors or wording nits.
export const PLAN_REVIEW_CONFIRMATION_LINE =
  `This is a confirmation full review after a scoped re-review PASS: no previous findings are listed, so review the whole plan again from scratch, across all categories you check, not one batch at a time. ${PLAN_REVIEW_SEVERITY_LINE}`;

const CONFIRMATION_KEY = "planReviewConfirmation";
const REVISIONS_KEY = "planReviewRevisions";
const REVIEWER_ROUNDS_KEY = "planReviewReviewerRounds";

function slot(state, key) {
  const list = state?.[STATE_KEY]?.[key];
  return Array.isArray(list) ? list : [];
}

export function planReviewRoundCount(state, key) { return slot(state, key).length; }

// Rounds the plan reviewer actually ran. A deterministic verify-denylist
// rejection records findings (the planner must fix them) but the reviewer
// never saw the plan, so that round is NOT a full review: the next reviewer
// call is effectively the first full review and its PASS needs no
// confirmation. Kept separate from the findings history so that history can
// still carry every earlier round to the planner/reviewer.
export function planReviewReviewerRoundCount(state, key) {
  const used = state?.[REVIEWER_ROUNDS_KEY]?.[key];
  return Number.isInteger(used) && used >= 0 ? used : 0;
}

function recordPlanReviewReviewerRound(state, key) {
  if (!state || typeof state !== "object" || !key) return 0;
  const used = planReviewReviewerRoundCount(state, key) + 1;
  if (!state[REVIEWER_ROUNDS_KEY] || typeof state[REVIEWER_ROUNDS_KEY] !== "object") state[REVIEWER_ROUNDS_KEY] = {};
  state[REVIEWER_ROUNDS_KEY][key] = used;
  return used;
}

// Append one failed round's findings (bounded, normalized). Empty -> no-op.
// `reviewer:false` records a deterministic rejection (the reviewer did not
// run), which must not count towards the confirmation decision nor turn the
// next reviewer round into a scoped re-review.
export function recordPlanReviewRound(state, key, findings, previous = [], {reviewer = true} = {}) {
  if (!state || typeof state !== "object" || !key) return 0;
  // The reviewer ran even when it returned no findings: that still counts
  // for the confirmation decision (a later scoped PASS follows a real full
  // review). Only the findings history is a no-op when empty.
  if (reviewer) recordPlanReviewReviewerRound(state, key);
  const normalized = normalizeFindings(findings);
  if (!normalized.length) return planReviewRoundCount(state, key);
  if (!state[STATE_KEY] || typeof state[STATE_KEY] !== "object") state[STATE_KEY] = {};
  const list = slot(state, key).slice();
  list.push({ round: list.length + 1, findings: normalized, previous: normalizePreviousStatuses(previous) });
  state[STATE_KEY][key] = list;
  return list.length;
}

// Resume from older state that has current findings but no history yet.
// Nothing to seed (no findings) must not look like a reviewer round.
export function seedPlanReviewHistory(state, key, findings) {
  if (planReviewRoundCount(state, key) === 0 && normalizeFindings(findings).length) recordPlanReviewRound(state, key, findings);
}

export function clearPlanReviewHistory(state, key) {
  if (state?.[STATE_KEY] && typeof state[STATE_KEY] === "object") {
    if (key) delete state[STATE_KEY][key]; else delete state[STATE_KEY];
    if (!Object.keys(state[STATE_KEY]).length) delete state[STATE_KEY];
  }
  if (state?.[REVIEWER_ROUNDS_KEY] && typeof state[REVIEWER_ROUNDS_KEY] === "object") {
    if (key) delete state[REVIEWER_ROUNDS_KEY][key]; else delete state[REVIEWER_ROUNDS_KEY];
    if (!Object.keys(state[REVIEWER_ROUNDS_KEY]).length) delete state[REVIEWER_ROUNDS_KEY];
  }
  clearPlanReviewNotes(state, key);
}

// Minor notes from the latest plan-review verdict (backlog #8). Bounded and
// fail-closed like findings: non-strings and unusable entries are dropped.
export function normalizePlanReviewNotes(raw) {
  return normalizeFindings(Array.isArray(raw) ? raw.filter(note => typeof note === "string") : []);
}

export function planReviewNotes(state, key) {
  const list = state?.[NOTES_KEY]?.[key];
  return Array.isArray(list) ? list : [];
}

// A REVIEW that returned no notes clears the slot, so a later revision never
// inherits notes from an older, superseded review.
export function recordPlanReviewNotes(state, key, notes) {
  if (!state || typeof state !== "object" || !key) return [];
  const normalized = normalizePlanReviewNotes(notes);
  if (!state[NOTES_KEY] || typeof state[NOTES_KEY] !== "object") state[NOTES_KEY] = {};
  if (normalized.length) state[NOTES_KEY][key] = normalized;
  else delete state[NOTES_KEY][key];
  if (!Object.keys(state[NOTES_KEY]).length) delete state[NOTES_KEY];
  return normalized;
}

export function planReviewNotesText(state, key) {
  const notes = planReviewNotes(state, key);
  if (!notes.length) return "";
  return `Minor notes (optional, fix if cheap):\n${notes.map((note, i) => `${i + 1}. ${note}`).join("\n")}`;
}

export function clearPlanReviewNotes(state, key) {
  if (!state?.[NOTES_KEY] || typeof state[NOTES_KEY] !== "object") return;
  if (key) delete state[NOTES_KEY][key]; else delete state[NOTES_KEY];
  if (state[NOTES_KEY] && !Object.keys(state[NOTES_KEY]).length) delete state[NOTES_KEY];
}

// A PASS that only came after earlier FULL reviewer rounds is a SCOPED
// re-review: it verified the fixes, it did not look at the rest of the plan
// again. Such a PASS needs the one full confirmation review below before it
// is accepted. A deterministic (denylist) rejection is not a full reviewer
// round — the reviewer never ran — so the next reviewer PASS is simply the
// first full review and is accepted without confirmation. With convergence
// disabled every round is already a full re-review, so no confirmation round
// is added there.
export function planReviewPassNeedsConfirmation(state, key, converge = true) {
  return converge !== false && planReviewReviewerRoundCount(state, key) > 0;
}

// Persisted "the next review is the confirmation full review" marker. It must
// survive a kill during the confirmation call: on resume the loop reads it and
// re-runs the full confirmation review instead of accepting the scoped PASS.
export function planReviewConfirmationPending(state, key) {
  return Boolean(state?.[CONFIRMATION_KEY]?.[key] === true);
}

export function markPlanReviewConfirmationPending(state, key) {
  if (!state || typeof state !== "object" || !key) return;
  if (!state[CONFIRMATION_KEY] || typeof state[CONFIRMATION_KEY] !== "object") state[CONFIRMATION_KEY] = {};
  state[CONFIRMATION_KEY][key] = true;
}

export function clearPlanReviewConfirmation(state, key) {
  if (!state?.[CONFIRMATION_KEY] || typeof state[CONFIRMATION_KEY] !== "object") return;
  if (key) delete state[CONFIRMATION_KEY][key]; else delete state[CONFIRMATION_KEY];
  if (state[CONFIRMATION_KEY] && !Object.keys(state[CONFIRMATION_KEY]).length) delete state[CONFIRMATION_KEY];
}

// Revision counter for the SpecKit gate loops (standalone keeps its own
// `standalonePlanReview.revision`). A review FAIL that actually leads to a
// Planner revision consumes one; a FAIL that escalates (no revision follows)
// consumes none, and a PASS never consumes one.
export function planReviewRevisionCount(state, key) {
  const used = state?.[REVISIONS_KEY]?.[key];
  return Number.isInteger(used) && used >= 0 ? used : 0;
}

export function recordPlanReviewRevision(state, key) {
  const used = planReviewRevisionCount(state, key) + 1;
  if (!state || typeof state !== "object" || !key) return used;
  if (!state[REVISIONS_KEY] || typeof state[REVISIONS_KEY] !== "object") state[REVISIONS_KEY] = {};
  state[REVISIONS_KEY][key] = used;
  return used;
}

export function clearPlanReviewRevisions(state, key) {
  if (!state?.[REVISIONS_KEY] || typeof state[REVISIONS_KEY] !== "object") return;
  if (key) delete state[REVISIONS_KEY][key]; else delete state[REVISIONS_KEY];
  if (state[REVISIONS_KEY] && !Object.keys(state[REVISIONS_KEY]).length) delete state[REVISIONS_KEY];
}

function render(rounds) {
  const blocks = rounds.map(r => `Round ${r.round}:\n${(Array.isArray(r.findings) ? r.findings : []).map((f, i) => `${i + 1}. ${f}`).join("\n")}`);
  // Bounded: drop the oldest rounds first.
  while (blocks.length > 1 && blocks.join("\n\n").length > MAX_CUMULATIVE_CHARS) blocks.shift();
  return blocks.join("\n\n");
}

// Reviewer brief lines for the NEXT review (rounds already recorded = previous).
// With convergence disabled every round is a full-plan re-review.
export function planReviewerRoundLines(state, key, converge = true) {
  if (converge === false) return [PLAN_REVIEW_FULL_LINE];
  // The next review is the confirmation full review: no previous findings.
  if (planReviewConfirmationPending(state, key)) return planReviewerConfirmationLines();
  const rounds = slot(state, key);
  // History exists but the plan reviewer has never run (only deterministic
  // denylist rejections): this next call IS the first full review, so give it
  // the exhaustive first-round brief rather than a scoped verification brief.
  if (!rounds.length || planReviewReviewerRoundCount(state, key) === 0) return [PLAN_REVIEW_EXHAUSTIVE_LINE];
  return [PLAN_REVIEW_VERIFY_LINE, `Previous findings from all earlier review rounds (verify each):\n${render(rounds)}`];
}

// The confirmation round's reviewer brief: a fresh exhaustive full review with
// NO previous findings listed. Never call planReviewerRoundLines() for it, or
// it would become another scoped verification round.
export function planReviewerConfirmationLines() {
  return [PLAN_REVIEW_CONFIRMATION_LINE];
}

// Planner revision brief: findings of all rounds BEFORE the latest (the latest
// is already quoted as the feedback that must be addressed).
export function plannerEarlierRoundsText(state, key, converge = true) {
  if (converge === false) return "";
  const rounds = slot(state, key).slice(0, -1);
  if (!rounds.length) return "";
  return `Findings from ALL earlier review rounds (already addressed once — keep them fixed; your fixes for the current findings must not reopen any of them):\n${render(rounds)}`;
}
