// TASK-8 "Prompt contract" — the per-task prompt assembler (TASK-19 Phase 3,
// task 9).
//
// Pure text assembly over caller-supplied values: it never launches a role,
// never reads git, and never touches the filesystem. It produces the normal
// contract for every fresh task invocation (not only a crash resume): a
// titles-only phase map, the current task's full contract, bounded
// completed-task facts, current-tree access, stage-appropriate identities, and
// — for Code Reviewer/Verifier only — the frozen full-delta identity and a
// per-task slice of the delta.
//
// Two exclusions are structural rather than prose:
// - prior transcripts / chat histories / unbounded historical diffs are
//   rejected outright if a caller tries to pass them (`ROLE_PROMPT_FORBIDDEN_INPUT`),
//   and are never rendered from any other field;
// - later tasks' full text is never rendered — only their titles appear in the
//   phase map, so "titles are context, not authorization" is enforced by
//   construction, not by asking the model to obey.
//
// Per-task delta slicing (task 9's decided half): a per-task Code
// Reviewer/Verifier prompt inlines ONLY the scoped-delta chunks whose path is
// in the Implementer's `factsByTask[<taskId>].files`. The frozen full-delta
// DIGEST is still emitted verbatim, so slicing touches inlined text only and
// never weakens identity. A chunk matching no task's file list is never
// dropped silently: it is simply absent from every per-task prompt and present
// in the whole-phase pass, which alone receives the complete delta.
import {validateRoleProgress} from "./phase-stage-checkpoint.mjs";
import {HANDOFF_MAX_CHARS_DEFAULT, HANDOFF_NOTE_MAX_CHARS_DEFAULT, handoffNoteRelPath, handoffBudgetReminder, SCRATCH_HANDOFF_NOTE_DEFAULT_DIR, scratchHandoffNotePath} from "./per-task-budget.mjs";
import {taskLabel, FINDING_TASKS_STATE_KEY} from "./finding-task-locality.mjs";

export const ROLE_LABEL = Object.freeze({
  implementer: "Implementer",
  codeReviewer: "Code Reviewer",
  verifier: "Verifier",
});

export const READ_ONLY_ROLES = Object.freeze(["codeReviewer", "verifier"]);

export const ROLE_FACT_KEY = Object.freeze({
  implementer: "factsByTask",
  codeReviewer: "findingsByTask",
  verifier: "evidenceByTask",
});

const ROLE_ITEM_KEY = Object.freeze({
  implementer: "files",
  codeReviewer: "findings",
  verifier: "evidence",
});

export const SUPPORTED_FRAMEWORKS = Object.freeze(["standalone", "speckit"]);

// Bound on the inlined delta text of one prompt. Small fixtures never reach it;
// a large phase delta is truncated with an in-prompt notice instead of growing
// the prompt without limit.
export const TASK_DELTA_BUDGET = 60000;
export const TITLE_MAX_CHARS = 160;
export const SUMMARY_MAX_CHARS = 2000;

export const FORBIDDEN_INPUT_CODE = "ROLE_PROMPT_FORBIDDEN_INPUT";
export const INVALID_INPUT_CODE = "ROLE_PROMPT_INVALID";

// Stable section markers. Tests assert these, never the surrounding prose.
export const SECTION = Object.freeze({
  freshSession: "Fresh-session contract",
  currentTaskOnly: "Current-task-only boundary",
  phaseMap: "Phase map (titles only; later tasks are context, not authorization)",
  currentTask: "Current task contract (the only task this invocation may execute)",
  completedFacts: "Completed-task facts (bounded; never transcripts)",
  handoffNotePrev: "Hand-off note from the previous session",
  handoffNoteCode: "Code the hand-off note cites",
  firstSessionEditEarly: "First-session edit-early rule",
  handoffNote: "Hand-off note (keep it current)",
  milestoneNote: "Milestone note-keeping reminder",
  deadEnds: "Dead ends from capped generations (do not retry blindly)",
  worktree: "Worktree access",
  identities: "Identity binding",
  delta: "Frozen full phase-delta",
  deltaSlice: "Per-task delta slice (this task's files only)",
  brief: "Optional phase brief",
  repeat: "Do not repeat completed work",
  checkpoint: "Checkpoint only on durable completion",
  singleVerification: "Single-verification contract",
  noCheckboxes: "Checkbox ownership",
  taskResult: "Task-result contract",
});

const FORBIDDEN_INPUT_KEYS = Object.freeze([
  "priorTranscript", "priorTranscripts", "priorChatHistory", "chatHistory",
  "historicalDiffs", "priorTaskDiffs", "transcripts",
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(code, reason, evidence = {}) {
  return {ok: false, code, reason, evidence};
}

function normalizeRelPath(value) {
  return String(value ?? "").replace(/\\/g, "/").trim().replace(/^\.\//, "");
}

// Display ref for one task in run records (status.json/progress.log/watch
// report). Three shapes, in extraction order:
//   1. owned ID: a leading T-prefixed token ("T001 Do the thing" → T001,
//      dotted form included: "T1.2 Do x" → T1.2, never a truncated "T1"),
//      used verbatim — it matches the operator's vocabulary in tasks.md;
//   2. plan number: a leading dotted number ("**1.1** …" → T1.1);
//   3. position fallback: the dotless 1-based label (T1), which can never
//      collide textually with a dotted plan ref (owned T001 keeps its zeros,
//      so it stays distinct from a T1 fallback too).
// Total: returns null rather than throwing, so observability can never break
// a run.
const OWNED_ID_PATTERN = /^T(\d+(?:\.\d+)?)\b/;
const PLAN_NUMBER_PATTERN = /^\*{0,2}(\d+\.\d+)\b/;
function firstContentLine(task) {
  const text = String(task?.text ?? task?.title ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  return (text.split("\n").map((line) => line.trim()).find((line) => line) ?? "").replace(/\s+/g, " ");
}
export function taskDisplayRef(task, index) {
  const firstLine = firstContentLine(task);
  const owned = OWNED_ID_PATTERN.exec(firstLine);
  if (owned) return `T${owned[1]}`;
  const plan = PLAN_NUMBER_PATTERN.exec(firstLine);
  if (plan) return `T${plan[1]}`;
  if (!Number.isInteger(index) || index < 0) return null;
  try {
    return taskLabel(index);
  } catch {
    return null;
  }
}

// Parse a ref back into comparable parts for adjacency. Three distinct kinds
// that never merge with each other: dotted plan refs (T1.1), owned IDs (T001
// — the leading zero is what marks them as owned rather than positional), and
// dotless position fallbacks (T1). A bare T0 matches nothing and therefore
// never ranges: it is neither a valid position (labels start at T1) nor a
// plausible owned ID.
function parseRef(ref) {
  let m = /^T(\d+)\.(\d+)$/.exec(ref);
  if (m) return {kind: "plan", major: Number(m[1]), minor: Number(m[2])};
  m = /^T(0\d+)$/.exec(ref);
  if (m) return {kind: "owned", major: 0, minor: Number(m[1])};
  m = /^T([1-9]\d*)$/.exec(ref);
  if (m) return {kind: "pos", major: 0, minor: Number(m[1])};
  return null;
}
function refsAdjacent(a, b) {
  const pa = parseRef(a);
  const pb = parseRef(b);
  return !!pa && !!pb && pa.kind === pb.kind && pa.major === pb.major && pb.minor === pa.minor + 1;
}

// A run's task scope as one string. Maximal consecutive runs compress to
// first > last ("T1.1 > T1.3"); gaps stay listed ("T1.1, T1.3";
// "T1.1 > T1.2, T1.4") so a range never implies skipped tasks are included.
// A single ref stands alone. Null when the scope is unknown — callers record
// null, never a guess. Input must be in phase order.
export function taskRefRange(refs) {
  const list = [...new Set((Array.isArray(refs) ? refs : []).filter(Boolean))];
  if (!list.length) return null;
  const parts = [];
  let runStart = 0;
  for (let i = 1; i <= list.length; i++) {
    if (i < list.length && refsAdjacent(list[i - 1], list[i])) continue;
    const run = list.slice(runStart, i);
    parts.push(run.length === 1 ? run[0] : `${run[0]} > ${run[run.length - 1]}`);
    runStart = i;
  }
  return parts.join(", ");
}

// Display scope for a review run. Round 1 — or any round whose FAIL record is
// unusable — covers the whole phase; a genuine re-review (isRereview: the
// previous revision's snapshot exists, so the review really is scoped) covers
// the tasks that re-ran in this attempt: the previous FAIL's affected tasks
// plus the tasks after them that were re-run (they had no carry entry, so the
// retry ran them too). Tasks the retry carried are excluded. It narrows only
// when the record is fully mapped (allMapped false means the untagged FAIL
// re-ran everything). Display only: anything unusable fails open to the wider
// whole-phase scope, never to a narrower guess.
export function reviewTaskRef(s, key, phaseTasks, phaseTaskIds, revision, isRereview) {
  const tasks = Array.isArray(phaseTasks) ? phaseTasks : [];
  const ids = Array.isArray(phaseTaskIds) && phaseTaskIds.length === tasks.length
    ? phaseTaskIds : tasks.map((_, i) => i);
  const slot = s?.[FINDING_TASKS_STATE_KEY]?.[key];
  const usable = !!isRereview && slot && typeof slot === "object" && !Array.isArray(slot) &&
    Number.isInteger(slot.revision) && slot.revision === revision - 1 &&
    slot.allMapped === true &&
    Array.isArray(slot.affected) && slot.affected.length > 0;
  let finalIds = ids;
  if (usable) {
    const affected = new Set(slot.affected);
    const carry = slot.carry && typeof slot.carry === "object" && !Array.isArray(slot.carry)
      ? slot.carry : null;
    if (carry) {
      // `carry` holds every task the retry was eligible to skip; a task
      // outside it (or with a failed local check) re-ran.
      finalIds = ids.filter((id) => affected.has(id) ||
        !Object.prototype.hasOwnProperty.call(carry, id) ||
        carry[id]?.taskLocalCheck?.status === "failed");
    } else {
      // Older record without a carry map: fall back to the tasks from the
      // first affected one onward (the retry's minimum re-run suffix).
      const first = ids.findIndex((id) => affected.has(id));
      if (first >= 0) finalIds = ids.slice(first);
    }
  }
  return taskRefRange(finalIds.map((id) => {
    const i = ids.indexOf(id);
    return taskDisplayRef(tasks[i], i);
  }));
}
// Whole-phase scope ("T1.1 > T1.3", or the single ref, or null). The
// verifier always covers the full phase, even after a fix.
export function allPhaseTaskRef(phaseTasks) {
  const tasks = Array.isArray(phaseTasks) ? phaseTasks : [];
  return taskRefRange(tasks.map((t, i) => taskDisplayRef(t, i)));
}

// First non-empty line of a task's text, whitespace-collapsed and bounded. Used
// only for the titles-only phase map.
export function taskTitle(task) {
  const text = String(task?.text ?? task?.title ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  const firstLine = text.split("\n").map((line) => line.trim()).find((line) => line) ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ");
  if (!collapsed) return "(untitled task)";
  return collapsed.length > TITLE_MAX_CHARS
    ? `${collapsed.slice(0, TITLE_MAX_CHARS - 3).trimEnd()}...`
    : collapsed;
}

// Filter scoped-delta chunks down to a task's own files. Exported so the
// slicing rule is testable in isolation, not only through an assembled prompt.
export function sliceDeltaChunks(deltaChunks, taskFiles) {
  const wanted = new Set((Array.isArray(taskFiles) ? taskFiles : []).map(normalizeRelPath).filter(Boolean));
  return (Array.isArray(deltaChunks) ? deltaChunks : [])
    .filter((chunk) => wanted.has(normalizeRelPath(chunk?.path)));
}

// The Implementer's own reported file set for one task — the load-bearing
// evidence task 12 verifies against the tree, and the selector task 9 slices on.
export function taskFilesFromProgress(progress, taskId) {
  const files = progress?.implementer?.factsByTask?.[taskId]?.files;
  return Array.isArray(files) ? files : [];
}

function boundedSummary(raw) {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= SUMMARY_MAX_CHARS) return text;
  return `${text.slice(0, SUMMARY_MAX_CHARS - 3).trimEnd()}...`;
}

function renderChunks(chunks) {
  return chunks.map((chunk) => `--- ${normalizeRelPath(chunk.path)} ---\n${String(chunk.text ?? "").trim()}`).join("\n");
}

function boundedDelta(chunks, budget) {
  const originalChars = chunks.reduce((n, c) => n + String(c.text ?? "").length, 0);
  const body = renderChunks(chunks);
  if (body.length <= budget) {
    return {body: body || "(empty — no repository changes in scope)", truncated: false, originalChars, includedFiles: chunks.map((c) => normalizeRelPath(c.path))};
  }
  // Keep whole chunks from the front until the budget is reached; never emit a
  // partial hunk, and always announce the omission.
  const kept = [];
  let used = 0;
  for (const chunk of chunks) {
    const piece = renderChunks([chunk]);
    if (used + piece.length + 1 > budget) break;
    kept.push(chunk);
    used += piece.length + 1;
  }
  const omitted = chunks.slice(kept.length);
  const notice = `\nTRUNCATED: omitted ${omitted.length} file diff(s): ${omitted.map((c) => normalizeRelPath(c.path)).join(", ")}. Inspect them directly in the worktree.`;
  const text = `${renderChunks(kept)}${notice}`;
  return {
    body: text,
    truncated: true,
    originalChars,
    includedFiles: kept.map((c) => normalizeRelPath(c.path)),
    omittedFiles: omitted.map((c) => normalizeRelPath(c.path)),
  };
}

function renderFacts(role, progress, completedTaskIds) {
  const factKey = ROLE_FACT_KEY[role];
  const itemKey = ROLE_ITEM_KEY[role];
  const facts = progress[role][factKey] ?? {};
  const lines = [];
  for (const taskId of completedTaskIds) {
    const entry = facts[taskId];
    if (!entry) continue;
    const references = Array.isArray(entry[itemKey]) ? entry[itemKey] : [];
    lines.push(`- ${taskId}: ${boundedSummary(entry.summary)}`);
    if (references.length) lines.push(`  ${itemKey}: ${references.map((r) => boundedSummary(r)).join("; ")}`);
    if (role === "implementer" && entry.taskLocalCheck) {
      const check = entry.taskLocalCheck;
      lines.push(`  taskLocalCheck: status=${check.status} exitCode=${check.exitCode ?? "null"} command=${boundedSummary(check.command)}`);
    }
  }
  return lines.length ? lines.join("\n") : "(none yet)";
}

// Assemble one per-task prompt. Returns `{ok, text, meta}` on success and a
// fail-closed `{ok:false, code, reason, evidence}` otherwise.
export function readOnlyHandoffNoteReminder({mission, ref, noteLimit}) {
  const scratchPath = scratchHandoffNotePath(SCRATCH_HANDOFF_NOTE_DEFAULT_DIR, ref);
  const repoPath = handoffNoteRelPath(mission, ref);
  return `\n## ${SECTION.milestoneNote}\nAt each milestone — after every important finding and after the task verify — OVERWRITE your hand-off note at ${scratchPath} (never append), max ${noteLimit} characters (Done/Found/Next/Dead ends). The repo note at ${repoPath} is read-only for this role: do not write it. If your session is stopped, the next session starts from the scratch note.`;
}

export function buildTaskPrompt(opts = {}) {
  for (const key of FORBIDDEN_INPUT_KEYS) {
    if (key in opts) {
      return fail(FORBIDDEN_INPUT_CODE, `prompt input ${JSON.stringify(key)} is forbidden: prior transcripts and unbounded historical diffs are never inlined`, {key});
    }
  }
  const framework = String(opts.framework ?? "");
  if (!SUPPORTED_FRAMEWORKS.includes(framework)) {
    return fail(INVALID_INPUT_CODE, `unsupported framework ${JSON.stringify(opts.framework)}`, {framework: opts.framework ?? null});
  }
  const role = String(opts.role ?? "");
  if (!Object.prototype.hasOwnProperty.call(ROLE_LABEL, role)) {
    return fail(INVALID_INPUT_CODE, `unknown role ${JSON.stringify(opts.role)}`, {role: opts.role ?? null});
  }
  const mission = String(opts.mission ?? "");
  const phaseName = String(opts.phaseName ?? "");
  if (!mission || !phaseName) return fail(INVALID_INPUT_CODE, "mission and phaseName are required", {});
  if (!Number.isInteger(opts.revision) || opts.revision < 1) {
    return fail(INVALID_INPUT_CODE, "revision must be a positive integer", {revision: opts.revision});
  }
  if (typeof opts.phaseTaskDigest !== "string" || !opts.phaseTaskDigest) {
    return fail(INVALID_INPUT_CODE, "phaseTaskDigest is required", {});
  }
  const progress = validateRoleProgress(opts.roleProgress);
  if (!progress.ok) return progress;
  // validateRoleProgress() deliberately permits a role's entry to be absent
  // (no per-task progress yet). A prompt for a role that has no entry cannot be
  // assembled, and must fail closed rather than throw — this is reachable as
  // soon as per-task dispatch starts persisting partial roleProgress.
  if (!isPlainObject(opts.roleProgress[role])) {
    return fail(INVALID_INPUT_CODE, `roleProgress.${role} is absent; cannot assemble a prompt for a role that has not started`, {role});
  }
  const taskIds = opts.taskIds;
  const tasks = opts.tasks;
  if (!Array.isArray(taskIds) || !Array.isArray(tasks) || taskIds.length !== tasks.length || taskIds.length === 0) {
    return fail(INVALID_INPUT_CODE, "taskIds and tasks must be equal-length non-empty arrays", {});
  }
  const isReadOnly = READ_ONLY_ROLES.includes(role);
  const wholePhasePass = opts.wholePhasePass === true;
  const completedTaskIds = opts.roleProgress[role].completedTaskIds ?? [];
  let currentTaskId = opts.currentTaskId ?? null;
  if (!wholePhasePass) {
    if (typeof currentTaskId !== "string" || !taskIds.includes(currentTaskId)) {
      return fail(INVALID_INPUT_CODE, "currentTaskId must name a task in taskIds", {currentTaskId});
    }
  } else {
    currentTaskId = null;
  }
  if (isReadOnly && (typeof opts.deltaDigest !== "string" || !opts.deltaDigest)) {
    return fail(INVALID_INPUT_CODE, `${role} prompts bind the frozen full phase-delta digest`, {role});
  }

  const currentIndex = currentTaskId === null ? -1 : taskIds.indexOf(currentTaskId);
  if (opts.handoffNoteMaxChars !== undefined && (!Number.isInteger(opts.handoffNoteMaxChars) || opts.handoffNoteMaxChars <= 0)) {
    return fail(INVALID_INPUT_CODE, "handoffNoteMaxChars must be a positive integer", {handoffNoteMaxChars: opts.handoffNoteMaxChars});
  }
  const handoffNoteLimit = opts.handoffNoteMaxChars ?? HANDOFF_NOTE_MAX_CHARS_DEFAULT;
  const parts = [];
  const header = wholePhasePass
    ? `${ROLE_LABEL[role]} whole-phase integration pass for ${framework} mission ${mission}, phase ${opts.phaseIndex + 1}/${opts.phaseTotal} "${phaseName}", revision ${opts.revision}.`
    : `${ROLE_LABEL[role]} per-task invocation for ${framework} mission ${mission}, phase ${opts.phaseIndex + 1}/${opts.phaseTotal} "${phaseName}", revision ${opts.revision}.`;
  parts.push(header);

  parts.push(`\n## ${SECTION.freshSession}\nThis is a fresh session (resume:false). No prior task transcript, chat history, or adapter session is loaded or required; inspect durable output on disk instead.`);
  parts.push(`\n## ${SECTION.currentTaskOnly}\n${wholePhasePass ? "This invocation is the single whole-phase integration pass: review the phase as a whole for cross-task interactions." : `You may execute ONLY the current task below. Every later task is a context boundary, not authorization to implement or review it.`}`);

  const mapLines = tasks.map((task, i) => {
    const id = taskIds[i];
    const status = completedTaskIds.includes(id) ? "completed" : id === currentTaskId ? "current" : "later";
    return `- [${status}] ${id}: ${taskTitle(task)}`;
  });
  parts.push(`\n## ${SECTION.phaseMap}\n${mapLines.join("\n")}`);

  if (!wholePhasePass) {
    const task = tasks[currentIndex];
    const fileLine = task?.file ? `\nFile: ${normalizeRelPath(task.file)}${task.line ? `:${task.line}` : ""}` : "";
    const accept = task?.accept ? `\nAcceptance: ${String(task.accept)}` : "";
    const verify = task?.verify ? `\nVerify: ${String(task.verify)}` : "";
    parts.push(`\n## ${SECTION.currentTask}\nTask ID: ${currentTaskId}${fileLine}\nTitle: ${taskTitle(task)}\n\n${String(task?.text ?? "").trim()}${accept}${verify}`);
  } else {
    parts.push(`\n## ${SECTION.currentTask}\nWhole-phase pass over: ${taskIds.join(", ")}`);
  }

  // Mission 049 Phase 1 task 1.3: milestone note-keeping reminder adjacent
  // to the current-task contract (not only in the keep-current section
  // below). The implementer writes the repo note at handoffNoteRelPath;
  // read-only roles (verifier, code reviewer) cannot write the repo, so
  // theirs renders the shared 1.1 scratch-note helper path under
  // /workspace/scratch and names the repo path as read-only for them.
  // Whole-phase passes have no current task, so no milestone reminder.
  // Mission 049 Phase 1 task 1.2 fix: read-only review runs (code reviewer,
  // verifier) execute under a range taskRef (reviewTaskRef/allPhaseTaskRef,
  // e.g. "T1.1 > T1.3") while taskDisplayRef names a single task — so the
  // wrap-up's scratchHandoffNotePath(effectiveScratchDir,taskRef) would never
  // find a note named after the single task. Callers may pass handoffNoteRef
  // (the same range ref the relay runs under) to name both paths from it;
  // absent, the single-task milestoneRef is used as before.
  if (!wholePhasePass) {
    const derivedRef = taskDisplayRef(tasks[currentIndex], currentIndex);
    const explicitRef = typeof opts.handoffNoteRef === "string" && opts.handoffNoteRef.trim()
      ? opts.handoffNoteRef.trim() : null;
    const milestoneRef = explicitRef ?? derivedRef;
    const milestoneRepoPath = milestoneRef ? handoffNoteRelPath(mission, milestoneRef) : null;
    const milestoneScratchPath = milestoneRef
      ? scratchHandoffNotePath(SCRATCH_HANDOFF_NOTE_DEFAULT_DIR, milestoneRef)
      : null;
    if (milestoneRef && milestoneRepoPath && milestoneScratchPath) {
      if (role === "implementer") {
        const budgetReminder = handoffBudgetReminder(opts.handoffPerTaskMaxTurns);
        parts.push(`\n## ${SECTION.milestoneNote}\nAt each milestone — after every important finding, before every edit, and after the task verify — OVERWRITE your hand-off note at ${milestoneRepoPath} (never append), max ${handoffNoteLimit} characters (Done/Found/Next/Dead ends). If your session is stopped, the next session starts from this note.${budgetReminder ? ` ${budgetReminder}` : ""}`);
      } else if (isReadOnly) {
        parts.push(readOnlyHandoffNoteReminder({mission, ref: milestoneRef, noteLimit: handoffNoteLimit}));
      }
    }
  }

  parts.push(`\n## ${SECTION.completedFacts}\n${renderFacts(role, opts.roleProgress, completedTaskIds)}`);
  // Backlog #26 Step A: the previous session's hand-off note (conclusions,
  // not just activity) renders ABOVE the dead-ends digest. Orchestrator-read
  // from the task's note file at prompt build, never model prose. Bounded to
  // the note limit, HEAD kept (sections 1-3 come first). A missing/empty note
  // renders nothing — the digest below still appears.
  if (opts.handoffNote !== undefined && opts.handoffNote !== null) {
    if (typeof opts.handoffNote !== "string") return fail(INVALID_INPUT_CODE, "handoffNote must be a string", {});
    const note = opts.handoffNote.trim().slice(0, handoffNoteLimit);
    if (note) {
      parts.push(`\n## ${SECTION.handoffNotePrev}\n${note}\nTrust this note. Do not re-read what it already explains; read only what you need to make the next edit.\nEDIT FIRST: if the note's "Next" names an edit, make that edit before any other read or search, then run the verify. Earlier sessions that re-read the cited code "to confirm" ran out of budget with no edit, and the task is stopped after consecutive sessions with no file change.`);
    }
  }
  // Backlog #32 + mission 026: orchestrator-quoted code the prior hand-off
  // note cites (continuation only: rendered when a prior generation's note
  // exists, omitted for first generations). Whole-note scope, Next section
  // first, ~40-line window per ref (±20 context), bounded (at most 5 refs,
  // 210 lines, 15000 chars); missing/unreadable/out-of-range refs skipped.
  // Edit from these inlined lines instead of re-reading the file.
  if (opts.handoffNoteExcerpts !== undefined && opts.handoffNoteExcerpts !== null) {
    if (typeof opts.handoffNoteExcerpts !== "string") return fail(INVALID_INPUT_CODE, "handoffNoteExcerpts must be a string", {});
    const excerpts = opts.handoffNoteExcerpts.trim();
    if (excerpts) parts.push(`\n## ${SECTION.handoffNoteCode}\nContinuation-only quotes: current file content at the lines the prior hand-off note cites, re-read from the repo at this prompt build (~40-line window per ref, ±20 lines of context; Next section first, then the rest; at most 5 refs, 210 lines, 15000 chars; missing/unreadable/out-of-range refs skipped). Rendered only when a prior generation's hand-off note exists — first generations omit this section. Edit from these inlined lines first; do not re-read them. Stale numbers are today's content where the file still has them, skipped where it moved on.\n${excerpts}`);
  }
  // Backlog 003#15: dead-ends transfer. Orchestrator-assembled records from
  // earlier generations of THIS task (never free model prose, never another
  // task's content, never transcripts): the relaunch routes around them
  // instead of re-trying failures. Bounded at record time; omitted entirely
  // when there are none so first generations stay clean. The normalization
  // paragraph below is load-bearing, not encouragement: a generation that
  // stops early to "conserve budget" has seen this section, which exists
  // precisely because stopping gains nothing — an unfinished task relaunches
  // automatically and every relaunch consumes continuation allowance.
  if (opts.deadEnds !== undefined && opts.deadEnds !== null) {
    if (!Array.isArray(opts.deadEnds)) return fail(INVALID_INPUT_CODE, "deadEnds must be an array", {deadEnds: opts.deadEnds});
    const entries = opts.deadEnds.filter(e => e && typeof e === "object").slice(-5);
    if (entries.length > 0) {
      const lines = entries.map(e => {
        const tail = String(e.tail ?? "").replace(/\s+/g, " ").trim().slice(0, HANDOFF_MAX_CHARS_DEFAULT);
        const cause = e.reason === "incomplete"
          ? "stopped voluntarily with work still remaining"
          : `hit the ${e.reason ?? "?"} cap`;
        return `- Generation ${e.generation ?? "?"} ${cause} (${e.used ?? "?"}${e.limit != null ? `/${e.limit}` : ""}): ${tail || "(no output captured)"}`;
      });
      parts.push(`\n## ${SECTION.deadEnds}\nThe previous generation(s) of THIS task were stopped by an orchestrator cap or stopped voluntarily short of completion — never by failure, and never as an ending. Do not retry the approaches below blindly — route around them. Stopping early to conserve budget gains nothing: an unfinished task relaunches automatically, and every relaunch consumes continuation allowance whether the stop was a cap or voluntary. Only a fully complete task ends the loop — report attempted with a precise resume point (what is done, what is next) and keep the work sound; the next generation continues from the worktree, never from zero. Files and ranges listed as read were already read by the previous session — do not re-read them in full; read only what you need to make the edit.\n${lines.join("\n")}`);
    }
  }
  parts.push(`\n## ${SECTION.worktree}\nInspect the current worktree/tree directly for earlier tasks' durable output; do not ask for copies of earlier conversations. If a git diff shows whole-file churn, re-run it EOL-normalized (git diff --ignore-cr-at-eol or git -c core.autocrlf=input diff) and trust the normalized stat.`);
  // Backlog #26 Step A: every implementer session (not only after a cap) is
  // told to keep the task's hand-off note current at its exact path. The path
  // comes from the same helper the loops use to read/delete the file, so the
  // brief can never name a path the orchestrator does not look at.
  if (role === "implementer" && !wholePhasePass) {
    const noteRef = taskDisplayRef(tasks[currentIndex], currentIndex);
    const notePath = noteRef ? handoffNoteRelPath(mission, noteRef) : null;
    if (notePath) {
      parts.push(`\n## ${SECTION.handoffNote}\nKeep a hand-off note at ${notePath}. OVERWRITE it (never append) at each milestone — after every important finding, before every edit, and after the task verify — max ${handoffNoteLimit} characters:\n1. Done — files changed (names only; details are in the worktree).\n2. Found — facts the next session needs: exact file:line, function names, how the code works there.\n3. Next — the exact next edit: file, line, what to change.\n4. Dead ends — what you tried that did not work, and why.\nIf your session is stopped, the next session starts from this note.`);
    }
  }
  // First-session edit-early rule (first generation only): the implementer's
  // opening session edits early instead of surveying. Rendered only when the
  // role is implementer, this is not a whole-phase pass, opts.handoffNote is
  // empty after trimming, and there are no deadEnds entries — continuation
  // prompts keep their existing text with no duplication.
  if (role === "implementer" && !wholePhasePass) {
    const handoffEmpty = opts.handoffNote === undefined || opts.handoffNote === null ||
      (typeof opts.handoffNote === "string" && opts.handoffNote.trim() === "");
    const hasDeadEnds = Array.isArray(opts.deadEnds) &&
      opts.deadEnds.filter((e) => e && typeof e === "object").length > 0;
    if (handoffEmpty && !hasDeadEnds) {
      parts.push(`\n## ${SECTION.firstSessionEditEarly}\nFirst session: edit early. Use targeted grep and line-range reads, edit within the first few tool calls, no whole-file surveys, and no zero-edit sessions.`);
    }
  }
  parts.push(`\n## ${SECTION.identities}\nrevision: ${opts.revision}\nphaseTaskDigest: ${opts.phaseTaskDigest}\n${wholePhasePass ? "" : `currentTaskId: ${currentTaskId}\ntaskCursor: ${currentIndex}`}`);

  let deltaMeta = null;
  let taskFiles = [];
  if (isReadOnly) {
    parts.push(`\n## ${SECTION.delta}\nIdentity digest (frozen; the slice below is text only and this digest is unchanged by it): ${opts.deltaDigest}`);
    const allChunks = Array.isArray(opts.deltaChunks) ? opts.deltaChunks : [];
    taskFiles = wholePhasePass ? [] : taskFilesFromProgress(opts.roleProgress, currentTaskId);
    const selected = wholePhasePass ? allChunks : sliceDeltaChunks(allChunks, taskFiles);
    const bounded = boundedDelta(selected, opts.maxDeltaChars ?? TASK_DELTA_BUDGET);
    const label = wholePhasePass ? SECTION.delta : SECTION.deltaSlice;
    parts.push(`\n## ${label}\n${bounded.body}`);
    deltaMeta = bounded;
  } else {
    parts.push(`\n## ${SECTION.delta}\nThis is the writable Implementer stage: the changing implementation delta is NOT an approval or drift signal for this invocation, and is never treated as one.`);
  }

  parts.push(`\n## ${SECTION.brief}\n${opts.phaseBriefPath ? `Wider phase context (optional reading, not required): ${normalizeRelPath(opts.phaseBriefPath)}` : "No phase brief is configured for this phase."}`);
  parts.push(`\n## ${SECTION.repeat}\nDo not repeat a completed task unless a quick inspection proves its saved work or evidence is missing.`);
  parts.push(`\n## ${SECTION.checkpoint}\nCheckpoint only after the task-specific work is durably complete.`);
  parts.push(`\n## ${SECTION.singleVerification}\nRun the current task's verify command once. A passing result ends the task; do not re-run a suite that already passed unless a file changed since it passed. If the verify fails for a reason that is not this task's change, report it in the task result as a pre-existing failure with the failing output; never stash, checkout, restore or otherwise revert the tree to get a baseline.${role === "implementer" ? " Prefer the focused task check; leave slow/sharded files to the gate." : ""}${role === "implementer" ? "\nRun only this task's verify command and the few tests your change touches; never run scripts/test-all.mjs or the whole test suite — the orchestrator runs it as the phase gate after the review." : ""}`);
  parts.push(`\n## ${SECTION.noCheckboxes}\nDo not mark task-file checkboxes; only the orchestrator marks them after phase-level approval.`);
  if (role === "implementer") {
    parts.push(`\n## Fixture repositories\nTests that need a git repo must create it under \`$TMPDIR\`, outside the project repo.`);
    parts.push(`\n## Keep the tree clean\nPut scratch/debug scripts under the run's scratch dir, never in the project repo, and delete every temporary file you create (\`debug-*\`, \`tmp-*\`, \`scratch-*\`, \`*.tmp\`, scratch dot-folders). Never leave stray untracked files in the repo.`);
  }
  if (opts.fixtureGitBlockWarning) {
    parts.push(`\n## Fixture repositories warning\ngit calls in fixture repos were blocked; create them outside the project repo.`);
  }
  if (opts.gitGuardWarning) {
    parts.push(`\n## Git guard warning\nA git command was blocked and changed nothing; the mission continued. Use \`git show HEAD:<path>\` or \`git diff\` to read committed versions — never create worktrees, branches, stashes, commits or tags.`);
  }
  if (role === "implementer" && !wholePhasePass) {
    parts.push(`\n## ${SECTION.taskResult}\nEnd your response with exactly one line:\nAUTOPILOT_TASK_RESULT={"summary":"<concise bounded summary>","taskLocalCheck":{"command":"<the task verify command>","status":"attempted|passed|failed","exitCode":<integer or null>,"summary":"<concise outcome>"}}\nDo not list changed files — the orchestrator derives them from the tree.`); 
  }

  const text = parts.join("\n");
  const meta = {
    role,
    framework,
    revision: opts.revision,
    currentTaskId,
    wholePhasePass,
    phaseBriefPath: opts.phaseBriefPath ?? null,
    promptChars: text.length,
    delta: deltaMeta,
    taskFiles,
  };
  return {ok: true, text, meta};
}
