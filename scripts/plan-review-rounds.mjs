// Plan-review round discipline (backlog #100). No hard round limit: instead
// round 1 must be exhaustive, later rounds verify fixes and raise new findings
// only when the revision introduced them or they would break execution, and the
// planner revision brief carries the cumulative findings of EVERY earlier round
// so a fix for one finding does not reopen another. Pure text/state helpers.
import crypto from "node:crypto";
import { normalizeFindings } from "./review-feedback.mjs";
import { normalizePreviousStatuses, dedupeEarlierRounds, EARLIER_ROUNDS_RECHECK_LINE, scopeReviewRounds } from "./code-review-rounds.mjs";

export { dedupeEarlierRounds, EARLIER_ROUNDS_RECHECK_LINE, scopeReviewRounds };

const STATE_KEY = "planReviewHistory";
const NOTES_KEY = "planReviewNotes";
const PASS_NOTES_KEY = "planPassNotes";
const PASS_NOTE_STATUS_KEY = "planPassNoteStatus";
const TASK_HASHES_KEY = "planReviewTaskHashes";
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

export const REVIEW_CONTINUATION_LINE =
  "This session continues a review that was stopped by the turn cap: start from the hand-off note above, do not repeat the reads or commands it lists, carry over the findings it records, and review only what is left.";

export const PLAN_REVIEW_CONFIRMATION_CONTINUATION_LINE =
  `This is a confirmation full review after a scoped re-review PASS: ${REVIEW_CONTINUATION_LINE} ${PLAN_REVIEW_SEVERITY_LINE}`;

export function hasReviewContinuationSignal(text) {
  return typeof text === "string" && text.includes("Prior reviewer handoff note (continuation context");
}

export function replaceReviewContinuationWording(text) {
  if (typeof text !== "string") return text;
  let out = text;
  out = out.replace(
    /No previous findings are listed, so review the whole artifact again from scratch; do not limit this to earlier findings or recent changes\./g,
    REVIEW_CONTINUATION_LINE
  );
  out = out.replace(
    /no previous findings are listed, so review the whole plan again from scratch, across all categories you check, not one batch at a time\./g,
    REVIEW_CONTINUATION_LINE
  );
  out = out.replace(
    /Review the whole plan again from scratch\./g,
    REVIEW_CONTINUATION_LINE
  );
  while (out.includes(`${REVIEW_CONTINUATION_LINE}\n${REVIEW_CONTINUATION_LINE}`)) {
    out = out.replace(`${REVIEW_CONTINUATION_LINE}\n${REVIEW_CONTINUATION_LINE}`, REVIEW_CONTINUATION_LINE);
  }
  while (out.includes(`${REVIEW_CONTINUATION_LINE} ${REVIEW_CONTINUATION_LINE}`)) {
    out = out.replace(`${REVIEW_CONTINUATION_LINE} ${REVIEW_CONTINUATION_LINE}`, REVIEW_CONTINUATION_LINE);
  }
  return out;
}

export function formatReviewBriefForContinuation(text) {
  if (!hasReviewContinuationSignal(text)) return text;
  return replaceReviewContinuationWording(text);
}

// Backlog #8: SpecKit-analyze-style cross-check for the standalone plan
// review when SPEC.md is on; used only in full review rounds.
export const STANDALONE_SPEC_ANALYZE_LINE =
  "Cross-check SPEC.md, PLAN.md and TASKS.md together like SpecKit's analyze step: (1) coverage — every FR has a task that really implements it and every task maps to an FR or is clearly setup/wiring/docs; every user story's acceptance scenarios and every success criterion are reachable by some task's accept/verify; (2) consistency — the same entity, field, route, file or term is named the same way in all three files, and PLAN.md's scope, constraints and phase boundaries match TASKS.md; (3) ambiguity — vague words with no measurable criterion (fast, secure, robust, intuitive) or placeholders left in any file; (4) underspecification — a task whose accept/verify cannot tell done from not done, or an FR with no testable outcome; (5) duplication — FRs or tasks that say the same thing; (6) conflicts — anything that contradicts the request or a source document it names. Apply the severity rule above: a gap that leaves a requirement unbuilt, untestable or contradictory is BLOCKING (finding); terminology drift, wording and duplicates that don't change behaviour are MINOR (notes).";

export function isFullPlanReviewRound(lines) {
  return Array.isArray(lines) && lines[0] !== PLAN_REVIEW_VERIFY_LINE;
}

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
  clearPlanReviewTaskHashes(state, key);
}

export function recordPlanReviewTaskHashes(state, key, hashes) {
  if (!state || typeof state !== "object" || !key || !hashes || typeof hashes !== "object") return;
  if (!state[TASK_HASHES_KEY] || typeof state[TASK_HASHES_KEY] !== "object") state[TASK_HASHES_KEY] = {};
  state[TASK_HASHES_KEY][key] = { ...hashes };
}

export function getPlanReviewTaskHashes(state, key) {
  const map = state?.[TASK_HASHES_KEY]?.[key];
  return map && typeof map === "object" ? { ...map } : {};
}


export function clearPlanReviewTaskHashes(state, key) {
  if (!state?.[TASK_HASHES_KEY] || typeof state[TASK_HASHES_KEY] !== "object") return;
  if (key) delete state[TASK_HASHES_KEY][key]; else delete state[TASK_HASHES_KEY];
  if (state[TASK_HASHES_KEY] && !Object.keys(state[TASK_HASHES_KEY]).length) delete state[TASK_HASHES_KEY];
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

// Minor notes preserved from the PASSing plan-review round (backlog #4).
// Kept in a separate slot from planReviewNotes so a PASS keeps its notes
// for the implementer and final report, while FAIL-round notes continue
// to reach only the planner revision.
export function planPassNotes(state, key) {
  if (!state || typeof state !== "object" || !state[PASS_NOTES_KEY]) return [];
  const list = state[PASS_NOTES_KEY][key];
  return Array.isArray(list) ? list : [];
}

export function allPlanPassNotes(state, keyFilter = null) {
  const container = state?.[PASS_NOTES_KEY];
  if (!container || typeof container !== "object") return [];
  const all = [];
  for (const [key, list] of Object.entries(container)) {
    if (typeof keyFilter === "function" && !keyFilter(key)) continue;
    if (Array.isArray(list)) {
      for (const note of list) {
        if (typeof note === "string" && note && !all.includes(note)) all.push(note);
      }
    }
  }
  return all;
}

export function recordPlanPassNotes(state, key, notes) {
  if (!state || typeof state !== "object" || !key) return [];
  const normalized = normalizePlanReviewNotes(notes);
  if (!state[PASS_NOTES_KEY] || typeof state[PASS_NOTES_KEY] !== "object") state[PASS_NOTES_KEY] = {};
  if (normalized.length) state[PASS_NOTES_KEY][key] = normalized;
  else delete state[PASS_NOTES_KEY][key];
  if (!Object.keys(state[PASS_NOTES_KEY]).length) delete state[PASS_NOTES_KEY];
  return normalized;
}

export function clearPlanPassNotes(state, key) {
  if (!state || typeof state !== "object") return;
  if (!state[PASS_NOTES_KEY] || typeof state[PASS_NOTES_KEY] !== "object") {
    delete state[PASS_NOTE_STATUS_KEY];
    return;
  }
  if (key) delete state[PASS_NOTES_KEY][key]; else delete state[PASS_NOTES_KEY];
  if (!state[PASS_NOTES_KEY] || !Object.keys(state[PASS_NOTES_KEY]).length) {
    delete state[PASS_NOTES_KEY];
    delete state[PASS_NOTE_STATUS_KEY];
  } else if (!key) {
    delete state[PASS_NOTE_STATUS_KEY];
  }
}

export function planPassNoteEntries(state, keyFilter = null) {
  const notes = allPlanPassNotes(state);
  const statusMap = (state && typeof state === "object" && state[PASS_NOTE_STATUS_KEY] && typeof state[PASS_NOTE_STATUS_KEY] === "object")
    ? state[PASS_NOTE_STATUS_KEY]
    : {};
  const filtered = keyFilter ? new Set(allPlanPassNotes(state, keyFilter)) : null;
  const entries = [];
  for (let i = 0; i < notes.length; i++) {
    const text = notes[i];
    if (filtered && !filtered.has(text)) continue;
    const n = i + 1;
    const record = statusMap[n] || statusMap[String(n)];
    const status = (record?.status === "done" || record?.status === "skipped") ? record.status : "open";
    const entry = { n, text, status };
    if (record?.phase !== undefined && record?.phase !== null) entry.phase = record.phase;
    if (record?.reason) entry.reason = record.reason;
    entries.push(entry);
  }
  return entries;
}

export function markPlanPassNote(state, n, { status, phase, reason } = {}) {
  if (!state || typeof state !== "object") return null;
  const num = Number(n);
  const notes = allPlanPassNotes(state);
  if (!Number.isInteger(num) || num < 1 || num > notes.length) return null;
  if (status !== "done" && status !== "skipped") return null;
  if (status === "skipped" && (!reason || typeof reason !== "string" || !reason.trim())) return null;

  if (!state[PASS_NOTE_STATUS_KEY] || typeof state[PASS_NOTE_STATUS_KEY] !== "object") {
    state[PASS_NOTE_STATUS_KEY] = {};
  }
  const entry = { status };
  if (phase !== undefined && phase !== null) entry.phase = phase;
  if (status === "skipped" && reason) entry.reason = reason.trim();
  state[PASS_NOTE_STATUS_KEY][num] = entry;
  return entry;
}

export function parsePlanPassNoteMarks(text) {
  if (typeof text !== "string" || !text) return [];
  const lines = text.split(/\r?\n/);
  const marks = [];
  const appliedRe = /^\s*`?\s*PASS-NOTE\s+(\d+)\s*:\s*applied\s*`?\s*$/i;
  const skippedRe = /^\s*`?\s*PASS-NOTE\s+(\d+)\s*:\s*skipped\s*(?:[\u2014\u2013\-:])\s*(.+?)\s*`?\s*$/i;
  for (const line of lines) {
    const appliedMatch = line.match(appliedRe);
    if (appliedMatch) {
      marks.push({ n: parseInt(appliedMatch[1], 10), status: "done" });
      continue;
    }
    const skippedMatch = line.match(skippedRe);
    if (skippedMatch) {
      const reason = skippedMatch[2].trim();
      if (reason) {
        marks.push({ n: parseInt(skippedMatch[1], 10), status: "skipped", reason });
      }
    }
  }
  return marks;
}

export function applyPlanPassNoteMarks(state, result, { phase, allowSkip = true } = {}) {
  const rawNotes = result?.review?.notes;
  const notes = Array.isArray(rawNotes) ? rawNotes : (rawNotes ? [rawNotes] : []);
  const text = [result?.finalMessage, result?.output, ...notes].filter(Boolean).join("\n");
  let applied = 0;
  for (const mark of parsePlanPassNoteMarks(text)) {
    if (mark.status === "done") {
      if (markPlanPassNote(state, mark.n, { status: "done", phase })) applied += 1;
    } else if (mark.status === "skipped" && mark.reason && allowSkip) {
      if (markPlanPassNote(state, mark.n, { status: "skipped", reason: mark.reason })) applied += 1;
    }
  }
  return applied;
}

export function planPassNotesText(state, keyFilter = null) {
  const openEntries = planPassNoteEntries(state, keyFilter).filter((e) => e.status === "open");
  if (!openEntries.length) return "";
  return `Plan-review notes (optional — consider them only when they touch your task):\n${openEntries.map((e) => `${e.n}. ${e.text}`).join("\n")}\nIf your change applies a note, the code reviewer will record it.`;
}

export function phaseCodeReviewPassNotesText(state) {
  const openNotes = planPassNoteEntries(state).filter((e) => e.status === "open");
  if (!openNotes.length) return "";
  return `Plan-review notes:\n${openNotes.map((e) => `${e.n}. ${e.text}`).join("\n")}\n\nFor each note the phase delta applies, add a line \`PASS-NOTE <n>: applied\` to your review text.`;
}

export function finalReviewPassNotesText(state) {
  const openNotes = planPassNoteEntries(state).filter((e) => e.status === "open");
  if (!openNotes.length) return "";
  return `Plan-review notes:\n${openNotes.map((e) => `${e.n}. ${e.text}`).join("\n")}\n\nDecide every open note: \`PASS-NOTE <n>: applied\` if the code already does it, else \`PASS-NOTE <n>: skipped — <reason>\`.`;
}

export function formatPlanPassNotesLines(entries) {
  const open = [];
  const done = [];
  const skipped = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const norm = typeof e === "string" ? { n: i + 1, text: e, status: "open" } : e;
    if (norm.status === "done") {
      const p = norm.phase != null ? `, Phase ${norm.phase}` : "";
      done.push(`✓ ${norm.n}. ${norm.text} (done${p})`);
    } else if (norm.status === "skipped") {
      const r = norm.reason ? ` — ${norm.reason}` : "";
      skipped.push(`– ${norm.n}. ${norm.text} (skipped${r})`);
    } else {
      open.push(`${norm.n}. ${norm.text}`);
    }
  }
  return [...open, ...done, ...skipped];
}

// Pass notes for the first implementer brief of a phase.
export function firstTaskPassNotes(state, { taskIndex, attempts, completedTaskIds } = {}) {
  const isFirst = taskIndex === 0 && (attempts ?? 0) === 0 && (!completedTaskIds || !completedTaskIds.length);
  return isFirst ? planPassNotesText(state) : "";
}

// Pass notes for the first GSD unit brief of a phase.
export function firstGsdUnitPassNotes(state, phase, { isFirstOfPhase, attempt } = {}) {
  const isFirst = Boolean(isFirstOfPhase) && attempt === 1;
  return isFirst ? planPassNotesText(state, (key) => key.endsWith(`:${phase}`)) : "";
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

function render(rounds, extraLen = 0) {
  const blocks = rounds.map(r => `Round ${r.round}:\n${(Array.isArray(r.findings) ? r.findings : []).map((f, i) => `${i + 1}. ${f}`).join("\n")}`);
  // Bounded: drop the oldest rounds first.
  while (blocks.length > 1 && (blocks.join("\n\n").length + extraLen) > MAX_CUMULATIVE_CHARS) blocks.shift();
  return blocks.join("\n\n");
}

// Reviewer brief lines for the NEXT review (rounds already recorded = previous).
// With convergence disabled every round is a full-plan re-review.
export function planReviewerRoundLines(state, key, converge = true, taskSizeLine = null) {
  if (converge === false) return [PLAN_REVIEW_FULL_LINE];
  // The next review is the confirmation full review: no previous findings.
  if (planReviewConfirmationPending(state, key)) return planReviewerConfirmationLines(false, taskSizeLine);
  const rounds = slot(state, key);
  // History exists but the plan reviewer has never run (only deterministic
  // denylist rejections): this next call IS the first full review, so give it
  // the exhaustive first-round brief rather than a scoped verification brief.
  if (!rounds.length || planReviewReviewerRoundCount(state, key) === 0) return [PLAN_REVIEW_EXHAUSTIVE_LINE];
  if (rounds.length === 1) {
    return [PLAN_REVIEW_VERIFY_LINE, `Previous findings from all earlier review rounds (verify each):\n${render(rounds)}`];
  }
  const { rounds: scoped, fixedLine = "" } = scopeReviewRounds(rounds);
  const fixedLen = fixedLine ? fixedLine.length + 2 : 0;
  const rendered = render(scoped, fixedLen);
  const body = [fixedLine, rendered].filter(Boolean).join("\n\n");
  return [PLAN_REVIEW_VERIFY_LINE, `Previous findings from all earlier review rounds (verify each):\n${body}`];
}

// The confirmation round's reviewer brief: a fresh exhaustive full review with
// NO previous findings listed. Never call planReviewerRoundLines() for it, or
// it would become another scoped verification round.
export function planReviewerConfirmationLines(isContinuation = false, taskSizeLine = null) {
  const lines = [isContinuation ? PLAN_REVIEW_CONFIRMATION_CONTINUATION_LINE : PLAN_REVIEW_CONFIRMATION_LINE];
  if (taskSizeLine && typeof taskSizeLine === "string") lines.push(taskSizeLine);
  return lines;
}

// Planner revision brief: findings of all rounds BEFORE the latest (the latest
// is already quoted as the feedback that must be addressed).
export function plannerEarlierRoundsText(state, key, converge = true) {
  if (converge === false) return "";
  const allRounds = slot(state, key);
  const rounds = dedupeEarlierRounds(allRounds);
  if (!rounds.length) return "";
  const rendered = render(rounds);
  if (!rendered) return "";
  return `Findings from ALL earlier review rounds (already addressed once — keep them fixed; your fixes for the current findings must not reopen any of them):\n${rendered}\n${EARLIER_ROUNDS_RECHECK_LINE}`;
}

// Backlog #5: demote [MEDIUM] and [LOW] findings to notes.
export function demoteLowSeverityFindings(review) {
  if (!review || typeof review !== "object" || !Array.isArray(review.findings)) {
    return { review, moved: 0 };
  }
  const kept = [];
  const movedList = [];
  for (const f of review.findings) {
    let text = "";
    if (typeof f === "string") {
      text = f;
    } else if (f && typeof f === "object") {
      const p = typeof f.problem === "string" ? f.problem.trim() : (f.problem != null ? String(f.problem).trim() : "");
      const loc = typeof f.location === "string" ? f.location.trim() : (f.location != null ? String(f.location).trim() : "");
      text = p || loc;
    }
    const trimmed = String(text).trim().toLowerCase();
    if (trimmed.startsWith("[medium]") || trimmed.startsWith("[low]")) {
      movedList.push(f);
    } else {
      kept.push(f);
    }
  }
  const next = { ...review, findings: kept };
  if (movedList.length > 0) {
    const existingNotes = Array.isArray(review.notes) ? review.notes : [];
    next.notes = [...existingNotes, ...movedList];
  } else if (Array.isArray(review.notes)) {
    next.notes = [...review.notes];
  }
  if (next.decision === "FAIL" && kept.length === 0 && movedList.length > 0) {
    next.decision = "PASS";
  }
  return { review: next, moved: movedList.length };
}

// Backlog #8: parse task blocks from tasks.md into taskId -> hash map.
// A task block runs from its task line until the next task line or heading.
export function parseTaskBlocks(tasksText) {
  if (typeof tasksText !== "string") return {};
  const lines = tasksText.split(/\r?\n/);
  const hashes = {};
  let currentTaskId = null;
  let currentBlockLines = [];
  let inFence = false;

  function commit() {
    if (currentTaskId && currentBlockLines.length) {
      const blockText = currentBlockLines.join("\n").replace(/\r\n/g, "\n").trim();
      const hash = crypto.createHash("sha256").update(blockText).digest("hex").slice(0, 16);
      hashes[currentTaskId] = hash;
    }
    currentTaskId = null;
    currentBlockLines = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      if (currentTaskId) currentBlockLines.push(line);
      continue;
    }
    if (inFence) {
      if (currentTaskId) currentBlockLines.push(line);
      continue;
    }
    if (/^\s*#{1,6}\s+/.test(line)) {
      commit();
      continue;
    }
    const m = line.match(/^\s*-\s*\[\s*[xX ]?\s*\]\s+(.*)$/);
    if (m) {
      commit();
      const rest = m[1].trim();
      const idMatch = rest.match(/^(?:(T\d+(?:\.[a-zA-Z0-9]+)?|\*{0,2}\d+\.\d+\*{0,2}|T\d+[a-zA-Z0-9_.-]*))\b/i);
      if (idMatch) {
        currentTaskId = idMatch[1].replace(/^\*{0,2}|\*{0,2}$/g, "");
      }
      currentBlockLines = [line];
      continue;
    }
    if (currentTaskId) {
      currentBlockLines.push(line);
    }
  }
  commit();
  return hashes;
}


// Backlog #8: tasks in newHashes that are absent or changed compared to oldHashes.
export function changedTaskIds(oldHashes = {}, newHashes = {}) {
  const old = oldHashes && typeof oldHashes === "object" ? oldHashes : {};
  const curr = newHashes && typeof newHashes === "object" ? newHashes : {};
  const changed = [];
  for (const id of Object.keys(curr)) {
    if (!Object.prototype.hasOwnProperty.call(old, id) || old[id] !== curr[id]) {
      changed.push(id);
    }
  }
  return changed;
}

// Backlog #8: confirmation line text scoping task-size review to changed tasks.
export function taskSizeConfirmationLine(changedIds) {
  const idsList = Array.isArray(changedIds) && changedIds.length > 0
    ? changedIds.join(", ")
    : "none";
  return `Task-size rule in this confirmation review: raise a [RULE: task size] finding only for tasks changed since the last full review: ${idsList}. Put a size concern about any other task in notes.`;
}

// Extract cited task IDs: from object "tasks" array if present, else Tn ids from text.
export function extractCitedTaskIds(f) {
  if (f && typeof f === "object" && Array.isArray(f.tasks) && f.tasks.length > 0) {
    return f.tasks.map(id => String(id).trim()).filter(Boolean);
  }
  let text = "";
  if (typeof f === "string") {
    text = f;
  } else if (f && typeof f === "object") {
    const p = typeof f.problem === "string" ? f.problem.trim() : (f.problem != null ? String(f.problem).trim() : "");
    const loc = typeof f.location === "string" ? f.location.trim() : (f.location != null ? String(f.location).trim() : "");
    text = p || loc;
  }
  const matches = String(text).match(/\bT\d+(?:\.[a-zA-Z0-9]+)?\b/gi);
  return matches ? [...matches] : [];
}

// Backlog #8: demote [RULE: task size] findings to notes if all cited IDs are unchanged.
export function demoteUnchangedTaskSizeFindings(review, changedIds) {
  if (!review || typeof review !== "object" || !Array.isArray(review.findings)) {
    return { review, moved: 0 };
  }
  const changedNormSet = new Set((Array.isArray(changedIds) ? changedIds : []).map(id => String(id).trim().toUpperCase()));
  const kept = [];
  const movedList = [];

  for (const f of review.findings) {
    let text = "";
    if (typeof f === "string") {
      text = f;
    } else if (f && typeof f === "object") {
      const p = typeof f.problem === "string" ? f.problem.trim() : (f.problem != null ? String(f.problem).trim() : "");
      const loc = typeof f.location === "string" ? f.location.trim() : (f.location != null ? String(f.location).trim() : "");
      text = p || loc;
    }
    const trimmed = String(text).trim().toLowerCase();
    const isSize = trimmed.startsWith("[rule: task size]") || trimmed.startsWith("[rule: task-size]");
    if (!isSize) {
      kept.push(f);
      continue;
    }
    const cited = extractCitedTaskIds(f);
    if (!cited.length) {
      // Finding cites no id -> stays
      kept.push(f);
      continue;
    }
    const anyChanged = cited.some(id => {
      const upper = String(id).trim().toUpperCase();
      if (changedNormSet.has(upper)) return true;
      if (upper.startsWith("T") && changedNormSet.has(upper.slice(1))) return true;
      if (!upper.startsWith("T") && changedNormSet.has("T" + upper)) return true;
      return false;
    });

    if (!anyChanged) {
      movedList.push(f);
    } else {
      kept.push(f);
    }
  }

  const next = { ...review, findings: kept };
  if (movedList.length > 0) {
    const existingNotes = Array.isArray(review.notes) ? review.notes : [];
    next.notes = [...existingNotes, ...movedList];
  } else if (Array.isArray(review.notes)) {
    next.notes = [...review.notes];
  }
  if (next.decision === "FAIL" && kept.length === 0 && movedList.length > 0) {
    next.decision = "PASS";
  }
  return { review: next, moved: movedList.length };
}
