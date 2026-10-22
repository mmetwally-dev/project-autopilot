// Code-review round discipline (backlog #118), the code_reviewer twin of
// plan-review-rounds.mjs (#100). No round limit: round 1 is exhaustive; later
// rounds verify each previous finding (structured fixed / not_fixed record in
// the AUTOPILOT_REVIEW "previous" field) and raise new findings only if the fix
// introduced them or they break execution; the implementer fix brief carries
// the findings of EVERY earlier round. History is per review scope
// (s.codeReviewHistory[key]: "phase:<n>" or "final:<site>"), cleared on PASS
// and at a new mission. The fixed/not_fixed record is stored, not acted on
// (it feeds Pending #22).
import { normalizeFindings } from "./review-feedback.mjs";

const STATE_KEY = "codeReviewHistory";
const MAX_CUMULATIVE_CHARS = 16000;

export const CODE_REVIEW_EXHAUSTIVE_LINE =
  "This is review round 1 — make it EXHAUSTIVE: report every problem you can find in this first review, across all categories you check (correctness, regressions, missing or weak tests, wiring, edge cases), not one batch at a time. Later rounds will only verify the fixes and the changes made, so anything you leave out now will not be looked for again.";

export const CODE_REVIEW_VERIFY_LINE =
  'This is a later review round. First verify each previous finding listed below against the CURRENT code, one by one, and report the outcome in the final sentinel as "previous":[{"finding":"<the previous finding text, shortened>","status":"fixed"|"not_fixed"}] (one entry per previous finding; keep a not_fixed one in "findings" too). Raise NEW findings only if the fix introduced them, or if they would actually break execution; do not raise new style, preference or nice-to-have findings about code that was already reviewed.';

// Tolerant parse of the optional "previous" field. Anything unusable is dropped.
export function normalizePreviousStatuses(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const text = String(entry.finding ?? entry.problem ?? entry.text ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
    const st = String(entry.status ?? "").toLowerCase().replace(/[\s-]+/g, "_");
    const status = st === "fixed" ? "fixed" : (st === "not_fixed" || st === "notfixed" || st === "unfixed") ? "not_fixed" : null;
    if (text && status) out.push({ finding: text, status });
    if (out.length >= 40) break;
  }
  return out;
}

export function codeReviewScopeKey(kind, id) { return `${kind}:${id}`; }

function slot(state, key) {
  const list = state?.[STATE_KEY]?.[key];
  return Array.isArray(list) ? list : [];
}

export function codeReviewRoundCount(state, key) { return slot(state, key).length; }

export function codeReviewRounds(state, key) { return slot(state, key).slice(); }

// Append one failed round: its findings plus the reviewer's fixed/not_fixed
// statuses for the PREVIOUS round's findings. Empty findings -> no-op.
export function recordCodeReviewRound(state, key, findings, previous = []) {
  if (!state || typeof state !== "object" || !key) return 0;
  const normalized = normalizeFindings(findings);
  if (!normalized.length) return codeReviewRoundCount(state, key);
  if (!state[STATE_KEY] || typeof state[STATE_KEY] !== "object") state[STATE_KEY] = {};
  const list = slot(state, key).slice();
  list.push({ round: list.length + 1, findings: normalized, previous: normalizePreviousStatuses(previous) });
  state[STATE_KEY][key] = list;
  return list.length;
}

export function clearCodeReviewHistory(state, key) {
  if (!state?.[STATE_KEY] || typeof state[STATE_KEY] !== "object") return;
  if (key) delete state[STATE_KEY][key]; else delete state[STATE_KEY];
  if (state[STATE_KEY] && !Object.keys(state[STATE_KEY]).length) delete state[STATE_KEY];
}

function render(rounds) {
  const blocks = rounds.map(r => `Round ${r.round}:\n${(Array.isArray(r.findings) ? r.findings : []).map((f, i) => `${i + 1}. ${f}`).join("\n")}`);
  while (blocks.length > 1 && blocks.join("\n\n").length > MAX_CUMULATIVE_CHARS) blocks.shift();
  return blocks.join("\n\n");
}

// Reviewer brief lines for the NEXT review (recorded rounds = previous rounds).
export function codeReviewerRoundLines(state, key) {
  const rounds = slot(state, key);
  if (!rounds.length) return [CODE_REVIEW_EXHAUSTIVE_LINE];
  return [CODE_REVIEW_VERIFY_LINE, `Previous findings from all earlier review rounds (verify each):\n${render(rounds)}`];
}

// Implementer fix brief: findings of all rounds BEFORE the latest (the latest
// is already quoted as the feedback to address).
export function implementerEarlierRoundsText(state, key) {
  const rounds = slot(state, key).slice(0, -1);
  if (!rounds.length) return "";
  return `Findings from ALL earlier code-review rounds (already addressed once — keep them fixed; your fixes for the current findings must not reopen any of them):\n${render(rounds)}`;
}
