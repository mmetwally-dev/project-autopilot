// TASK-20 step 1 — which task(s) does each review finding concern?
//
// A FAIL verdict today tells the retry "what is wrong" but never "which of the
// phase's unfinished tasks it is about", so step 2 (keep finished tasks on
// FAIL) and step 3 (inject findings only into the named tasks) have nothing to
// act on. This module builds that mapping and owns the persisted record
// (`state.reviewFindingTasks[key]`).
//
// Step 1 was deliberately record-only. Step 2 (TASK-21) reads the record
// back in the implementation loops via `carryDecision()`: the
// `roleProgress` wipe, the `retryFindings` injection, and the resume cursor
// stay untouched — unflagged tasks are replayed through the normal
// `commitTaskResult` path instead of re-running.
//
// Pure module, in the style of the `role-progress-*.mjs` family: no
// filesystem, process, or state-file access. `saveFindingTasks`/
// `loadFindingTasks`/`clearFindingTasks*` take the already-loaded state
// object, exactly like review-feedback.mjs's own helpers do.
//
// One naming trap worth stating once, here, where both halves live:
//
//   * `taskLabel(index)` is 1-BASED — a reviewer reads "T1" as "the first task
//     in the list I was shown".
//   * a stable task ID's `T` segment (`standalone:P1:T0:<hash>`) is 0-BASED,
//     because it is the array ordinal.
//
// So label "T1" ↔ ordinal 0 ↔ the ID at `taskIds[0]`. The conversion exists in
// exactly two functions (`taskLabel`, `labelToIndex`); every call site uses
// them and none re-derives the offset inline.
import {
  normalizeFindingsWithSource,
  loadReviewFeedback,
} from "./review-feedback.mjs";
import {
  handoffNoteCitedExcerpts,
} from "./per-task-budget.mjs";
import {
  ROLE_PROGRESS_SUMMARY_MAX_CHARS,
  ROLE_PROGRESS_MAX_FILES,
} from "./phase-stage-checkpoint.mjs";

// Same state key review-feedback.mjs uses for its own slot, so the two records
// are addressed by the same caller-chosen key and can never drift apart.
export const FINDING_TASKS_STATE_KEY = "reviewFindingTasks";

const SOURCES = Object.freeze(["declared", "file", "phase", "none"]);

// Sources that attribute a finding to named tasks. Anything else —
// `"phase"`, `"none"`, and any future source — fails `allMapped` closed in
// `affectedTaskIds`, so a finding that is not mapped to a task can never
// silently narrow the retry to a subset of tasks.
const MAPPED_SOURCES = Object.freeze(["declared", "file"]);

// "T<index+1>". The index is a 0-based position in the reviewer's task list.
export function taskLabel(index) {
  if (!Number.isInteger(index) || index < 0) {
    throw new TypeError(`task label requires a non-negative integer index (received ${JSON.stringify(index)})`);
  }
  return `T${index + 1}`;
}

// Inverse of taskLabel(). Accepts the bare label ("T3", "t3") and the bracketed
// form a reviewer actually sees in the task list ("[T3]"); anything else —
// including a full stable task ID and the 0-based `T0` — resolves to -1 so the
// caller drops it instead of guessing.
export function labelToIndex(label) {
  if (typeof label !== "string") return -1;
  // Balanced brackets only: `[T3]` and `T3` are the two forms a reviewer
  // actually writes, while `[T3` / `T3]` are half-formatted text and must
  // not be silently accepted as a task reference.
  const match = /^(?:\[T(\d+)\]|T(\d+))$/i.exec(label.trim());
  if (!match) return -1;
  const n = Number(match[1] ?? match[2]);
  if (!Number.isInteger(n) || n < 1) return -1;
  return n - 1;
}

// The location fields renderFinding() reads, in the same order. Deliberately
// the SAME rule for strings as for objects: a plain-string finding carries its
// whole message in one field, so there is no reliable path to extract from it
// and guessing one would attribute the finding to the wrong task.
function findingLocation(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  const value = raw.location ?? raw.file ?? raw.path ?? "";
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

// Repository-relative comparison form: forward slashes, no trailing `:line` /
// `:line:col`, no leading `./` or `/`. Applied to BOTH sides of the match, so
// a Windows-authored `src\a.js:12:4` finding still equals the
// `src/a.js` fact recorded by the attribution map.
function comparablePath(value) {
  let text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) return "";
  text = text.replace(/\\/g, "/");
  text = text.replace(/:\d+(:\d+)?$/, "");
  text = text.replace(/^\.\/+/, "").replace(/^\/+/, "");
  return text;
}

// Resolution step 1 — declared. The finding names the tasks itself, either as
// reviewer labels ("T2") or as full stable IDs. Unknown values are dropped
// silently (a reviewer that invented "T9" must not fail the mapping); the
// ONE surviving match is the FIRST in taskIds order, so the result does not
// depend on the order the reviewer happened to write them in — every finding
// resolves to exactly one owner.
function declaredTaskIds(raw, taskIds) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  if (!Array.isArray(raw.tasks)) return [];
  const chosen = new Set();
  for (const value of raw.tasks) {
    if (typeof value !== "string") continue;
    if (taskIds.includes(value)) { chosen.add(value); continue; }
    const index = labelToIndex(value);
    if (index >= 0 && index < taskIds.length) chosen.add(taskIds[index]);
  }
  return taskIds.filter(id => chosen.has(id)).slice(0, 1);
}

// Resolution step 2 — file. Exact match only: a location that does not name a
// file some completed task actually owns maps to nothing (step 3), because a
// wrong attribution is worse than none. When several tasks own the cited file
// the FIRST in taskIds order owns the finding, exactly like the declared path.
function fileTaskIds(raw, taskIds, factsByTask) {
  const file = comparablePath(findingLocation(raw));
  if (!file) return [];
  return taskIds.filter(id => {
    const files = factsByTask?.[id]?.files;
    if (!Array.isArray(files)) return false;
    return files.some(owned => comparablePath(owned) === file);
  }).slice(0, 1);
}

// Resolution per finding: declared → file → phase → none, first hit wins, and
// exactly ONE owner at most. The order is the contract step 3/step 2 rely on:
// a reviewer that both tags a finding and gives its location must never be
// second-guessed by the file heuristic, so a non-empty `tasks` array still
// wins outright. An explicit phase-wide answer (`tasks: []`) does NOT: a cited
// file some task owns is evidence about that task, so the empty tag is only
// consulted AFTER the file branch and the finding stays `"phase"` solely when
// there is no location or no task owns the cited file.
// A non-empty `tasks` array with only unknown labels counts as absent (the
// existing `declaredTaskIds` drops unknown values silently), so it still
// falls through to the file fallback and then to `"none"`.
function resolveFinding(raw, taskIds, factsByTask) {
  const declared = declaredTaskIds(raw, taskIds);
  if (declared.length) return {taskIds: declared, source: "declared"};
  const byFile = fileTaskIds(raw, taskIds, factsByTask);
  if (byFile.length) return {taskIds: byFile, source: "file"};
  if (raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray(raw.tasks) && raw.tasks.length === 0) {
    return {taskIds: [], source: "phase"};
  }
  return {taskIds: [], source: "none"};
}

// The mapping, aligned 1:1 with normalizeFindings(findings) — same entries
// kept, same entries dropped, same order. Alignment is obtained by iterating
// normalizeFindingsWithSource()'s output rather than by re-implementing the
// drop/cap rules here, so a finding that normalization throws away (no problem
// statement) or the list it truncates (MAX_FINDINGS / MAX_TOTAL_CHARS) can
// never shift the indices the two functions disagree about.
//
// `factsByTask` must be the PRE-WIPE
// `checkpoint.roleProgress.implementer.factsByTask`: by the time
// applyCheckpointTransition() runs on a FAIL, that map is empty.
export function mapFindingsToTasks({findings, taskIds, factsByTask} = {}) {
  const ids = (Array.isArray(taskIds) ? taskIds : []).filter(id => typeof id === "string" && id);
  const facts = factsByTask && typeof factsByTask === "object" ? factsByTask : {};
  return normalizeFindingsWithSource(findings).map(({raw}) => resolveFinding(raw, ids, facts));
}

// The union of every mapped task, in `taskIds` order (never in finding order,
// so the record is stable while a reviewer reorders its findings), plus
// `allMapped`.
//
// `allMapped` is the fail-closed signal step 2 will read:
//   * false as soon as ANY entry is not a non-empty `MAPPED_SOURCES` entry —
//     a finding we could not attribute to a task (`"none"`), an explicitly
//     phase-wide finding (`"phase"`), or anything malformed must not
//     silently narrow the retry to a subset of tasks;
//   * false for an EMPTY entry list too. "No findings recorded" carries no
//     locality information at all, so it must mean "redo everything" (today's
//     behaviour) rather than "redo nothing". That is also exactly what the
//     verifier gate failure with no findings stores.
export function affectedTaskIds(entries, taskIds) {
  const ids = (Array.isArray(taskIds) ? taskIds : []).filter(id => typeof id === "string" && id);
  const list = Array.isArray(entries) ? entries : [];
  const chosen = new Set();
  let allMapped = list.length > 0;
  for (const entry of list) {
    // mapped only if: MAPPED_SOURCES.includes(entry.source) && entry.taskIds.length > 0
    if (!entry || typeof entry !== "object" || !Array.isArray(entry.taskIds) ||
        !(MAPPED_SOURCES.includes(entry.source) && entry.taskIds.length > 0)) {
      allMapped = false;
      continue;
    }
    for (const id of entry.taskIds) if (typeof id === "string") chosen.add(id);
  }
  return {taskIds: ids.filter(id => chosen.has(id)), allMapped};
}

// Compute the mapping from the RAW verdict findings (never the rendered
// strings — task tags are flattened away by renderFinding()) and persist it
// under the same key saveReviewFeedback() just used. Call this immediately
// after saveReviewFeedback() and BEFORE applyCheckpointTransition(), while
// factsByTask still holds the pre-wipe file ownership.
//
// TASK-21 step 2 (carry forward): the record additionally snapshots what a
// retry may replay without re-running. `revision` is the checkpoint's
// revision AT FAIL TIME (the FAIL sites call before the transition, so this
// is the old revision N); the retry at revision N+1 replays from it.
// `carryAllowed` is true at every code-review and verifier FAIL site
// (TASK-21 step 2, c-gap 2): a red gate command is only evidence that the
// phase is not done, while the findings recorded with it name the tasks, so
// the unaffected ones may be carried. The fail-closed rule stays with
// `allMapped` — an empty entry list (a gate failure with no findings) or any
// unmapped/phase-wide finding records an EMPTY carry, i.e. "redo everything".
// `carry` holds the
// `factsByTask[id]` of every task in `taskIds` NOT in `affected`, filled
// only when `allMapped === true`, `carryAllowed === true`, and the task has
// a facts entry; otherwise `{}` (redo everything, today's behaviour).
export function recordFindingTasks(state, key, {phaseTaskDigest, findings, taskIds, factsByTask, revision, carryAllowed} = {}) {
  if (!state || typeof state !== "object" || !key) return null;
  const ids = (Array.isArray(taskIds) ? taskIds : []).filter(id => typeof id === "string" && id);
  const entries = mapFindingsToTasks({findings, taskIds: ids, factsByTask});
  const {taskIds: affected, allMapped} = affectedTaskIds(entries, ids);
  const rev = Number.isInteger(revision) && revision >= 1 ? revision : null;
  const carry = {};
  if (allMapped && carryAllowed === true && rev !== null) {
    const facts = factsByTask && typeof factsByTask === "object" && !Array.isArray(factsByTask) ? factsByTask : {};
    const affectedSet = new Set(affected);
    for (const id of ids) {
      if (affectedSet.has(id)) continue;
      const entry = facts[id];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      carry[id] = JSON.parse(JSON.stringify(entry));
    }
  }
  const record = {
    phaseTaskDigest: typeof phaseTaskDigest === "string" ? phaseTaskDigest : null,
    taskIds: ids,
    entries,
    affected,
    allMapped,
    revision: rev,
    carry,
    at: new Date().toISOString(),
  };
  if (!state[FINDING_TASKS_STATE_KEY] || typeof state[FINDING_TASKS_STATE_KEY] !== "object") {
    state[FINDING_TASKS_STATE_KEY] = {};
  }
  state[FINDING_TASKS_STATE_KEY][key] = record;
  return record;
}

// Fail-closed on LOAD, not only on save — the same posture loadReviewFeedback()
// takes. state.json is user-editable, may predate this code, and is never
// trusted blindly: a missing or malformed slot, a digest that no longer
// describes the phase the record was taken from, or an entry list that is not
// index-for-index aligned with the findings still stored for that key all
// return null (nothing to act on) rather than a repaired guess. Nothing in the
// implementation loops consumes this yet — step 2 will.
export function loadFindingTasks(state, key, {phaseTaskDigest} = {}) {
  const slot = state?.[FINDING_TASKS_STATE_KEY]?.[key];
  if (!slot || typeof slot !== "object" || Array.isArray(slot)) return null;
  if (!Array.isArray(slot.taskIds) || !Array.isArray(slot.entries) || !Array.isArray(slot.affected)) return null;
  if (typeof slot.allMapped !== "boolean") return null;
  if (typeof slot.phaseTaskDigest !== "string" || typeof phaseTaskDigest !== "string") return null;
  if (slot.phaseTaskDigest !== phaseTaskDigest) return null;
  if (slot.taskIds.some(id => typeof id !== "string" || !id)) return null;
  if (slot.affected.some(id => !slot.taskIds.includes(id))) return null;
  for (const entry of slot.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    if (!SOURCES.includes(entry.source) || !Array.isArray(entry.taskIds)) return null;
    if (entry.taskIds.some(id => !slot.taskIds.includes(id))) return null;
  }
  // TASK-21: the carry record is only usable by the revision the FAIL
  // created (N+1 reads N's record). A missing or non-positive revision —
  // including every record written before this field existed — fails closed
  // to null, never to a guess.
  if (!Number.isInteger(slot.revision) || slot.revision < 1) return null;
  // TASK-21: a malformed `carry` fails closed to `{}` (redo everything),
  // never to null and never to a repaired guess. Each entry must carry a
  // string summary within the same bound validateFactEntry enforces, a
  // string-array files within the same bound, and a key inside `taskIds`
  // but outside `affected`.
  let carry = {};
  const rawCarry = slot.carry;
  if (rawCarry !== undefined && rawCarry !== null) {
    let valid = rawCarry && typeof rawCarry === "object" && !Array.isArray(rawCarry);
    const idsSet = valid ? new Set(slot.taskIds) : null;
    const affectedSet = valid ? new Set(slot.affected) : null;
    if (valid) {
      for (const [id, entry] of Object.entries(rawCarry)) {
        if (!idsSet.has(id) || affectedSet.has(id)) { valid = false; break; }
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) { valid = false; break; }
        if (typeof entry.summary !== "string" || entry.summary.length > ROLE_PROGRESS_SUMMARY_MAX_CHARS) { valid = false; break; }
        const files = entry.files ?? [];
        if (!Array.isArray(files) || files.length > ROLE_PROGRESS_MAX_FILES) { valid = false; break; }
        if (files.some(f => typeof f !== "string" || f.length > ROLE_PROGRESS_SUMMARY_MAX_CHARS)) { valid = false; break; }
      }
    }
    if (valid) carry = JSON.parse(JSON.stringify(rawCarry));
  }
  // The record is only meaningful while it describes the findings that are
  // still stored for the same key.
  if (slot.entries.length !== loadReviewFeedback(state, key).length) return null;
  // TASK-22: never trust the stored `allMapped`/`affected` as-is — recompute
  // both from the loaded entries and fail closed to null on disagreement, so
  // a hand-edited or older state.json cannot claim `true` next to a
  // `"phase"`/`"none"` entry and smuggle a carry through. Placed after all
  // the shape checks above, so the recompute only ever sees validated
  // arrays (`affectedTaskIds` guards every input and cannot throw); the safe
  // fallback is null, and `carryDecision` answers `no-record` on null, which
  // means redo everything.
  const recomputed = affectedTaskIds(slot.entries, slot.taskIds);
  if (recomputed.allMapped !== slot.allMapped ||
      JSON.stringify(recomputed.taskIds) !== JSON.stringify(slot.affected)) {
    return null;
  }
  return {
    phaseTaskDigest: slot.phaseTaskDigest,
    taskIds: [...slot.taskIds],
    entries: slot.entries.map(entry => ({taskIds: [...entry.taskIds], source: entry.source})),
    affected: [...slot.affected],
    allMapped: slot.allMapped,
    revision: slot.revision,
    carry,
    at: typeof slot.at === "string" ? slot.at : null,
  };
}

// TASK-24 step 4 — which findings does ONE re-run task's brief get?
//
// `findings` is the `loadReviewFeedback` output (rendered strings, in
// order); `record.entries[i]` is index-aligned with `findings[i]`
// (TASK-20 guarantees it). Returns `{own, phaseWide, unlinked,
// handled, fallback}`.
//
// The groups are separate on purpose, each with its own comment
// below, so a later change (for example, re-asking the reviewer to tag
// `none` findings) touches only `unlinked`:
//
// - `own`: `declared`/`file` findings that name this task.
// - `phaseWide`: `source:"phase"`. The reviewer intentionally said the
//   finding concerns the whole phase (`tasks: []`). It reaches every
//   re-run task because it genuinely applies to all of them.
// - `unlinked`: `source:"none"`, or any unknown future source. The tag
//   was missing (a reviewer mistake) and no file matched. It reaches
//   every re-run task as a fail-safe, because we can't tell who it's
//   about. This is not the same as phase-wide, and must never be
//   described as phase-wide.
// - `handled`: `declared`/`file` findings whose ONE owner is another
//   task (mission 052 (a)). Read-only context only — the finding is
//   already owned and must not be fixed here, so it never reaches
//   `fixPassBriefExcerpts`. Each entry is `{taskLabel, finding}`, with
//   the owner's 1-based label from its position in `record.taskIds`.
//
// Fallback (today's behaviour: return all `findings` in `own` with
// `fallback: true`) when the record cannot be trusted for this task:
// `record` is null, `revision !== record.revision + 1`, or
// `record.entries.length !== findings.length`. Otherwise each
// `findings[i]` is sorted by explicit checks; a mapped finding for
// another task is read-only context, never work. Order within each
// group is the original finding order; finding text is never invented
// or rewritten.
export function findingsForTask({findings, record, taskId, revision} = {}) {
  const list = Array.isArray(findings) ? [...findings] : [];
  const fallbackResult = () => ({own: [...list], phaseWide: [], unlinked: [], handled: [], fallback: true});
  if (!record || typeof record !== "object" || Array.isArray(record)) return fallbackResult();
  if (!Number.isInteger(revision) || !Number.isInteger(record.revision) || revision !== record.revision + 1) {
    return fallbackResult();
  }
  if (!Array.isArray(record.entries) || record.entries.length !== list.length) return fallbackResult();
  // `own`: declared/file findings that name this task.
  const own = [];
  // `phaseWide`: source "phase" — intentionally whole-phase, delivered to
  // every re-run task because it genuinely applies to all of them.
  const phaseWide = [];
  // `unlinked`: source "none" or any unknown future source — a fail-safe
  // delivered to every re-run task because we cannot tell who it is
  // about. Fail-open towards delivering it; never describe as phase-wide.
  const unlinked = [];
  // `handled`: mapped findings owned by ANOTHER task — read-only
  // context, never work for this task (mission 052 (a)).
  const handled = [];
  // The 1-based label of every owner named by one entry. The record's
  // `taskIds` array stays the source of truth for the ordinal, so the
  // label a reviewer sees and the label the brief shows can never drift.
  // A legacy record may hold SEVERAL ids per entry (the per-entry array
  // is the stored schema); all of their labels are joined rather than
  // trusting a single owner.
  const ownerLabels = (taskIds) => {
    const known = Array.isArray(record.taskIds) ? record.taskIds : [];
    const labels = [];
    for (const id of taskIds) {
      if (typeof id !== "string" || !id) continue;
      const index = known.indexOf(id);
      if (index < 0) { labels.push(id); continue; }
      labels.push(taskLabel(index));
    }
    return labels.join(", ");
  };
  for (let i = 0; i < list.length; i += 1) {
    const entry = record.entries[i];
    const source = entry && typeof entry === "object" ? entry.source : undefined;
    const taskIds = entry && typeof entry === "object" && Array.isArray(entry.taskIds) ? entry.taskIds : [];
    if (MAPPED_SOURCES.includes(source)) {
      if (typeof taskId === "string" && taskId && taskIds.includes(taskId)) own.push(list[i]);
      // Another task owns this finding: it belongs to that task's brief
      // and to nobody else's work. It is kept as read-only context so
      // the implementer can see the whole picture without redoing it.
      else handled.push({taskLabel: ownerLabels(taskIds), finding: list[i]});
    } else if (source === "phase") {
      phaseWide.push(list[i]);
    } else {
      unlinked.push(list[i]);
    }
  }
  return {own, phaseWide, unlinked, handled, fallback: false};
}

// The read-only section text for a `handled` group. Pure string work:
// the group is `{taskLabel, finding}` pairs straight out of
// `findingsForTask`, and the text names the owning task and says the
// finding must NOT be fixed here — an implementer that redoes another
// task's fix duplicates the change and breaks the review.
// Returns "" for an empty (or entirely malformed) group, so a caller can
// append it unconditionally.
export const HANDLED_FINDINGS_HEADING =
  "Findings already handled by another task in this phase (read-only — do not fix them here):";
export function renderHandledFindings(handled) {
  if (!Array.isArray(handled)) return "";
  const lines = [];
  for (const entry of handled) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const finding = typeof entry.finding === "string" ? entry.finding.trim() : "";
    if (!finding) continue;
    const label = typeof entry.taskLabel === "string" ? entry.taskLabel.trim() : "";
    lines.push(label ? `- Already handled by ${label} — do not fix it here: ${finding}` : `- ${finding}`);
  }
  if (!lines.length) return "";
  return `${HANDLED_FINDINGS_HEADING}\n${lines.join("\n")}`;
}

// TASK-21 step 2 — one pure carry/re-run decision per task on a retry.
//
// Returns `{carry: boolean, facts?, reason}`. `carry: true` ONLY when all of
// these hold (`reason` names the first check that fails):
//  1. `record` is non-null (the caller loads it via `loadFindingTasks`,
//     which already rejects a foreign digest and a stale or unaligned
//     record) and still describes this phase's task list.
//  2. `revision === record.revision + 1` — the record may only be used by
//     the revision the FAIL created. An older record must never carry.
//  3. `record.carry[taskId]` exists (carry only ever holds tasks outside
//     `affected`, so a named task fails here), AND its
//     `taskLocalCheck?.status` is not `"failed"` — a task whose own local
//     check failed was not actually fine, so re-run it instead of carrying
//     a known failure forward.
//  4. Overlap rule: no task in `record.affected` already completed in the
//     current revision (`progress.implementer.completedTaskIds`) has current
//     `factsByTask[A].files` intersecting `record.carry[taskId].files`
//     (compared via `comparablePath`, so `:line` and backslashes
//     normalize). Meaning: if the redone fix touched a file this task
//     owns, redo this task too.
//     Known limit (documented, not fixed): an affected task that comes
//     LATER in the plan hasn't run yet when an earlier task is carried.
//     The scoped code re-review (TASK-23) is the backstop: any change the
//     fix makes to a carried task's files is in the fix diff it reviews.
//
// `facts` is a deep copy of `record.carry[taskId]`, so the caller can
// commit it without aliasing the persisted record.
export function carryDecision({record, taskId, progress, revision, phaseTaskDigest} = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return {carry: false, reason: "no-record"};
  }
  if (typeof phaseTaskDigest === "string" && record.phaseTaskDigest !== phaseTaskDigest) {
    return {carry: false, reason: "digest-mismatch"};
  }
  if (!Number.isInteger(revision) || !Number.isInteger(record.revision) || revision !== record.revision + 1) {
    return {carry: false, reason: "revision-mismatch"};
  }
  if (typeof taskId !== "string" || !taskId) {
    return {carry: false, reason: "bad-task"};
  }
  if (Array.isArray(record.affected) && record.affected.includes(taskId)) {
    return {carry: false, reason: "affected"};
  }
  const entry = record.carry && typeof record.carry === "object" ? record.carry[taskId] : undefined;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return {carry: false, reason: "no-carry-entry"};
  }
  if (entry.taskLocalCheck && typeof entry.taskLocalCheck === "object" && entry.taskLocalCheck.status === "failed") {
    return {carry: false, reason: "local-check-failed"};
  }
  const implementer = progress && typeof progress === "object" ? progress.implementer : undefined;
  if (!implementer || typeof implementer !== "object" || !Array.isArray(implementer.completedTaskIds)) {
    return {carry: false, reason: "bad-progress"};
  }
  const currentFacts = implementer.factsByTask && typeof implementer.factsByTask === "object" ? implementer.factsByTask : {};
  const owned = new Set(
    (Array.isArray(entry.files) ? entry.files : []).map(comparablePath).filter(Boolean),
  );
  if (owned.size > 0) {
    const overlapTaskIds = [];
    const overlapFiles = [];
    const seenOverlapFiles = new Set();
    for (const affectedId of (Array.isArray(record.affected) ? record.affected : [])) {
      if (!implementer.completedTaskIds.includes(affectedId)) continue;
      const current = currentFacts[affectedId];
      const currentFiles = current && Array.isArray(current.files) ? current.files : [];
      for (const file of currentFiles) {
        const normalized = comparablePath(file);
        if (normalized && owned.has(normalized)) {
          if (!overlapTaskIds.includes(affectedId)) overlapTaskIds.push(affectedId);
          if (!seenOverlapFiles.has(normalized)) {
            seenOverlapFiles.add(normalized);
            overlapFiles.push(typeof file === "string" ? file : normalized);
          }
        }
      }
    }
    if (overlapTaskIds.length > 0) {
      return {carry: false, reason: "overlap", overlap: {taskIds: [...overlapTaskIds], files: [...overlapFiles]}};
    }
  }
  return {carry: true, facts: JSON.parse(JSON.stringify(entry)), reason: "carry"};
}

// A record that outlives its findings is the bug class this codebase has
// already paid for, so every clear of a review-feedback slot clears the record
// under the SAME key in the same breath.
export function clearFindingTasks(state, key) {
  if (state?.[FINDING_TASKS_STATE_KEY] && typeof state[FINDING_TASKS_STATE_KEY] === "object") {
    delete state[FINDING_TASKS_STATE_KEY][key];
  }
}

export function clearFindingTasksByPrefix(state, prefix) {
  const slots = state?.[FINDING_TASKS_STATE_KEY];
  if (!slots || typeof slots !== "object") return;
  if (!prefix || typeof prefix !== "string") return;
  for (const k of Object.keys(slots)) {
    if (k.startsWith(prefix)) delete slots[k];
  }
}

// Mission 050 Phase 1 task 1.1 — pure fix-pass block renderer.
//
// Findings plus readFile in; excerpts plus edit-first instruction out.
// Reuses handoffNoteCitedExcerpts (scripts/per-task-budget.mjs), which
// already parses `path/N:N` / `path:N-M` / `path:~N`, and extends it with
// ONLY two extra spellings, normalizing each to the colon form before
// delegating: the space-tilde form `path ~N` / `path ~N-M` (e.g.
// `scripts/a.mjs ~10-20`) and the parenthesised line form
// `path (line N)` / `path (lines N-M)` (e.g.
// `scripts/autopilot.mjs finalizeMissionComplete (line 103)`).
// The parenthesised form tolerates symbol/prose words between the path and
// the `(line …)` marker — but never a colon (so a finding citing both
// `path:N` and `path (line M)` keeps the colon reference and is never
// normalized twice) and never a second path-like token (`[\w.-]+\.[A-Za-z0-9]+`,
// negative lookahead inside the gap), so `See scripts/a.mjs and the helper
// in scripts/b.mjs (line 50).` attaches the line to `scripts/b.mjs` — the
// path nearest the marker — instead of pointing the fix pass at `scripts/a.mjs`. Bounds (maxRanges / maxLines / maxChars / context)
// and skip-unreadable behaviour are inherited from the delegate, never
// re-implemented here.
//
// `findings` is the rendered-finding string list (loadReviewFeedback /
// findingsForTask output); a bare string or an array is accepted, and
// non-string entries contribute their location/file/path/message text so
// object-form findings still cite. Returns the excerpts followed by the
// single edit-first instruction; when nothing is citable the excerpts
// are empty and only the instruction is returned. Never throws on a bad
// reader — the delegate degrades to no excerpts.
export const FIX_PASS_EDIT_FIRST_INSTRUCTION =
  "edit these locations first; read other code only if the fix needs it";
// Space-tilde `path ~N` / `path ~N-M` and parenthesised
// `path (line N)` / `path (lines N-M)` both normalize to the colon form
// the delegate already understands.
const FIX_PASS_SPACE_TILDE_REF = /(?<![\w/.-])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+)\s+~(\d+(?:-\d+)?)/g;
const FIX_PASS_PAREN_LINE_REF = /(?<![\w/.-])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+)(?:(?![\w.-]+\.[A-Za-z0-9]+)[^():\r\n]){0,120}?\(\s*lines?\s+(\d+)(?:\s*-\s*(\d+))?\s*\)/g;
export function fixPassBriefExcerpts(findings, readFile, options = {}) {
  const parts = Array.isArray(findings)
    ? findings.map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          return [entry.location, entry.file, entry.path, entry.message, entry.problem, entry.text]
            .filter((v) => typeof v === "string" && v)
            .join(" ");
        }
        return "";
      })
    : [typeof findings === "string" ? findings : ""];
  const text = parts.filter(Boolean).join("\n");
  const normalized = text
    .replace(FIX_PASS_SPACE_TILDE_REF, "$1:$2")
    .replace(
      FIX_PASS_PAREN_LINE_REF,
      (match, file, from, to) => `${file}:${from}${to ? `-${to}` : ""}`,
    );
  const excerpts = typeof readFile === "function"
    ? handoffNoteCitedExcerpts(normalized, readFile, options)
    : "";
  return excerpts
    ? `${excerpts}\n${FIX_PASS_EDIT_FIRST_INSTRUCTION}`
    : FIX_PASS_EDIT_FIRST_INSTRUCTION;
}
