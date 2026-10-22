// TASK-8 "Orchestrator-owned progress commits", "Invalidation", and "Crash
// ordering" — pure, testable evaluators (TASK-19 Phase 2, tasks 5-6).
//
// One per-task role invocation owns exactly one task, so the orchestrator
// already knows the only cursor that invocation can complete. This module
// turns that knowledge into pure decisions; it deliberately does **not** add a
// model-written progress source, a helper CLI, an environment channel, or a
// second reconciliation path beside TASK-7's checkpoint. There is exactly one
// progress authority, the persisted checkpoint under `CHECKPOINT_STATE_KEY`,
// and the caller persists what these functions return through the existing
// writer (`autopilot.mjs`'s `saveState()` -> `atomicWriteFileSync()`).
//
// Purity contract (same as `phase-stage-checkpoint.mjs`):
// - no filesystem, process, or network access;
// - no state writes — every function takes values in and returns values out;
// - no clock reads; callers own time.
//
// The six-step commit sequence is split across the exported functions:
//   1. `prepareTaskInvocation()` — persist running/role/revision/taskCursor/
//      currentTaskId plus the expected identities before launch (step 1).
//   2. `LAUNCH_CONTRACT` — the invariant that the model writes only its normal
//      role outputs and never orchestration state (step 2; asserted, not code).
//   3/4. `validateTaskResult()` — validate the normalized result against the
//      expected role/run/revision/task/order and the stage-appropriate digest
//      contract, and accept only bounded facts plus the role-specific result
//      (Implementer carries `taskLocalCheck`, never a verification verdict).
//   5. `commitTaskResult()` — atomically persist the accepted facts and
//      advance/clear the cursor in one returned value (step 5).
//   6. `evaluateCrashResume()` — a crash before that returned value is written
//      leaves the cursor un-advanced; resume repeats at most the current task.
//
// Invalidation (`evaluateRoleProgressReuse()`, `beginRevision()`,
// `resetRoleProgress()`) and crash ordering (`evaluateCrashResume()`,
// `completePhaseWidePass()`) are the TASK-8 sections of the same name.
import {
  INVALID_CODE, DRIFT_CODE, CHECKPOINT_STATE_KEY,
  ROLE_PROGRESS_ROLES, validateRoleProgress, emptyRoleProgress,
} from "./phase-stage-checkpoint.mjs";

// The only progress authority. Exposed so a test can pin it and so no caller
// can mistake a run log or result file for a second source of truth.
export const PROGRESS_AUTHORITY = CHECKPOINT_STATE_KEY;

// Step 2's invariant, as data: the launched model owns its role outputs only.
export const LAUNCH_CONTRACT = Object.freeze({
  modelWritesOrchestrationState: false,
  progressAuthority: CHECKPOINT_STATE_KEY,
  resume: false,
});

export const ROLE_STAGE = Object.freeze({
  implementer: "implementer",
  codeReviewer: "code_reviewer",
  verifier: "verifier",
});

export const ROLE_FACT_KEY = Object.freeze({
  implementer: "factsByTask",
  codeReviewer: "findingsByTask",
  verifier: "evidenceByTask",
});

// Roles whose progress additionally binds the frozen full phase-delta digest.
export const READ_ONLY_ROLES = Object.freeze(["codeReviewer", "verifier"]);

export const TASK_RESULT_COMPLETE = "completed";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fail(code, reason, evidence = {}) {
  return {ok: false, code, reason, evidence};
}

function validateProgressShape(progress) {
  return validateRoleProgress(progress);
}

function isReadOnly(role) {
  return READ_ONLY_ROLES.includes(role);
}

function isRole(role) {
  return ROLE_PROGRESS_ROLES.includes(role);
}

// ── Step 1: pre-launch persist ───────────────────────────────────────────
// Records `runningStage`'s role, revision, taskCursor, currentTaskId, and the
// expected identities before the child starts. Returns the progress to persist
// plus the `expected` descriptor steps 3-5 validate the result against.
//
// `taskIds` is the authoritative ordered phase task-ID list (from task 1's
// generator over the phase-task digest). Requiring `completedTaskIds` to equal
// the leading slice of `taskIds` binds progress to the stable task IDs: a
// reorder/edit/insert/removal changes the IDs and therefore fails closed here,
// even though the numeric cursor might happen to still line up.
export function prepareTaskInvocation({
  progress, role, runId, revision, phaseTaskDigest, deltaDigest = null, taskId, taskIds,
} = {}) {
  const shape = validateProgressShape(progress);
  if (!shape.ok) return shape;
  if (!isRole(role)) return fail(INVALID_CODE, `unknown role ${JSON.stringify(role)}`, {role});
  if (!Array.isArray(taskIds) || taskIds.length === 0 ||
      taskIds.some((id) => typeof id !== "string" || !id)) {
    return fail(INVALID_CODE, "taskIds must be a non-empty ordered array of stable task IDs", {taskIds});
  }
  if (typeof taskId !== "string" || !taskId) {
    return fail(INVALID_CODE, "taskId is required", {taskId});
  }
  const index = taskIds.indexOf(taskId);
  if (index === -1) return fail(INVALID_CODE, `unknown task ${JSON.stringify(taskId)}`, {taskId});
  if (typeof runId !== "string" || !runId) return fail(INVALID_CODE, "runId is required", {runId});
  if (!Number.isInteger(revision) || revision < 1) {
    return fail(INVALID_CODE, "revision must be a positive integer", {revision});
  }
  if (typeof phaseTaskDigest !== "string" || !phaseTaskDigest) {
    return fail(INVALID_CODE, "phaseTaskDigest is required", {phaseTaskDigest});
  }
  if (isReadOnly(role) && (typeof deltaDigest !== "string" || !deltaDigest)) {
    return fail(
      INVALID_CODE,
      `${role} progress binds the frozen full phase-delta digest; one is required before launch`,
      {role},
    );
  }
  const entry = progress[role];
  if (!entry) return fail(INVALID_CODE, `roleProgress.${role} is absent`, {role});
  if (entry.completedTaskIds.includes(taskId)) {
    return fail(INVALID_CODE, `task ${JSON.stringify(taskId)} is already completed`, {taskId});
  }
  if (entry.currentTaskId !== null && entry.currentTaskId !== undefined && entry.currentTaskId !== taskId) {
    return fail(
      INVALID_CODE,
      "another task is already in flight; refusing out-of-order cursor movement",
      {expected: entry.currentTaskId, observed: taskId},
    );
  }
  if (entry.taskCursor !== index) {
    return fail(
      INVALID_CODE,
      "out-of-order cursor movement",
      {expected: entry.taskCursor, observed: index, taskId},
    );
  }
  const expectedPrefix = taskIds.slice(0, index);
  if (JSON.stringify(entry.completedTaskIds) !== JSON.stringify(expectedPrefix)) {
    return fail(
      INVALID_CODE,
      "completed task IDs do not match the authoritative ordered task list",
      {expected: expectedPrefix, observed: entry.completedTaskIds},
    );
  }
  const next = clone(progress);
  next[role].status = "running";
  next[role].taskCursor = index;
  next[role].currentTaskId = taskId;
  const check = validateProgressShape(next);
  if (!check.ok) return check;
  return {
    ok: true,
    progress: next,
    expected: {
      role,
      runId,
      revision,
      phaseTaskDigest,
      deltaDigest: isReadOnly(role) ? deltaDigest : null,
      taskId,
      taskCursor: index,
      taskIds: [...taskIds],
    },
  };
}

// ── Steps 3-4: post-return validation ────────────────────────────────────
// The normalized result is validated against the expected role/run/revision/
// task/order and the stage-appropriate digest contract. For the Implementer
// the changing full delta is deliberately NOT compared; for Code Reviewer and
// Verifier the frozen full-delta digest must match. Bounded facts and the
// role-specific result are accepted only for a durable completion, and the
// Implementer's facts are re-checked by the schema validator so a
// verdict-shaped `taskLocalCheck` fails closed here too.
export function validateTaskResult(expected, result) {
  if (!isPlainObject(expected)) return fail(INVALID_CODE, "expected invocation descriptor is required", {});
  if (!isRole(expected.role)) {
    return fail(INVALID_CODE, `unknown expected role ${JSON.stringify(expected.role)}`, {role: expected.role});
  }
  if (!isPlainObject(result)) return fail(INVALID_CODE, "task result must be an object", {observed: result});
  if (result.role !== expected.role) {
    return fail(INVALID_CODE, "wrong-role result", {expected: expected.role, observed: result.role});
  }
  if (result.runId !== expected.runId) {
    return fail(INVALID_CODE, "wrong-run result", {expected: expected.runId, observed: result.runId});
  }
  if (result.revision !== expected.revision) {
    return fail(INVALID_CODE, "wrong-revision result", {expected: expected.revision, observed: result.revision});
  }
  if (result.phaseTaskDigest !== expected.phaseTaskDigest) {
    return fail(INVALID_CODE, "phase-task digest mismatch", {
      expected: expected.phaseTaskDigest, observed: result.phaseTaskDigest,
    });
  }
  if (result.taskId !== expected.taskId) {
    return fail(INVALID_CODE, "unknown-task result", {expected: expected.taskId, observed: result.taskId});
  }
  // Stage-appropriate digest contract. The Implementer's delta legitimately
  // changes with every task, so it is never compared; read-only roles bind the
  // frozen full-delta identity they reviewed.
  if (isReadOnly(expected.role) && result.deltaDigest !== expected.deltaDigest) {
    return fail(INVALID_CODE, "frozen full phase-delta digest mismatch", {
      expected: expected.deltaDigest, observed: result.deltaDigest,
    });
  }
  if (result.status !== TASK_RESULT_COMPLETE) {
    return fail(INVALID_CODE, `task result is not a durable completion (status ${JSON.stringify(result.status)})`, {
      status: result.status,
    });
  }
  if (!isPlainObject(result.facts)) {
    return fail(INVALID_CODE, "task result is missing bounded facts", {observed: result.facts});
  }
  if (isReadOnly(expected.role) && result.decision !== "PASS" && result.decision !== "FAIL" && result.decision !== "INCOMPLETE") {
    return fail(INVALID_CODE, `${expected.role} task result must carry a PASS/FAIL/INCOMPLETE decision`, {
      observed: result.decision ?? null,
    });
  }
  return {ok: true, role: expected.role, taskId: expected.taskId};
}

// ── Step 5: atomic persist-and-advance ───────────────────────────────────
// Produces the complete next progress value: the accepted task facts, the task
// appended to `completedTaskIds`, the cursor advanced, and `currentTaskId`
// cleared — all in one returned object the caller persists once. Nothing is
// written here, so a crash before the caller's write leaves the cursor exactly
// where step 1 put it.
export function commitTaskResult({progress, expected, result} = {}) {
  const shape = validateProgressShape(progress);
  if (!shape.ok) return shape;
  const valid = validateTaskResult(expected, result);
  if (!valid.ok) return valid;
  const role = expected.role;
  const entry = progress[role];
  if (!entry) return fail(INVALID_CODE, `roleProgress.${role} is absent`, {role});
  if (entry.currentTaskId !== expected.taskId) {
    return fail(
      INVALID_CODE,
      "task result does not match the in-flight currentTaskId",
      {expected: entry.currentTaskId, observed: expected.taskId},
    );
  }
  if (entry.taskCursor !== expected.taskCursor) {
    return fail(
      INVALID_CODE,
      "out-of-order cursor movement at commit",
      {expected: entry.taskCursor, observed: expected.taskCursor},
    );
  }
  if (entry.completedTaskIds.includes(expected.taskId)) {
    return fail(INVALID_CODE, `task ${JSON.stringify(expected.taskId)} is already completed`, {taskId: expected.taskId});
  }
  const next = clone(progress);
  const nextEntry = next[role];
  const completed = [...entry.completedTaskIds, expected.taskId];
  nextEntry.completedTaskIds = completed;
  nextEntry.taskCursor = expected.taskCursor + 1;
  nextEntry.currentTaskId = null;
  nextEntry.status = completed.length === expected.taskIds.length ? "complete" : "running";
  nextEntry[ROLE_FACT_KEY[role]] = {
    ...entry[ROLE_FACT_KEY[role]],
    [expected.taskId]: clone(result.facts),
  };
  const check = validateProgressShape(next);
  if (!check.ok) return check;
  return {
    ok: true,
    progress: next,
    role,
    taskId: expected.taskId,
    taskCursor: nextEntry.taskCursor,
    roleComplete: nextEntry.status === "complete",
  };
}

// ── Invalidation ─────────────────────────────────────────────────────────
// Identity binding is stage-sensitive. Implementer progress binds revision +
// phase-task digest + stable task cursor and deliberately ignores the changing
// full delta while its cursor is active. Code Reviewer/Verifier progress binds
// those three AND the frozen full phase-delta digest.
//
// `stored` and `observed` are `{revision, phaseTaskDigest, deltaDigest}`. A
// revision or phase-task-digest mismatch invalidates every role; a full-delta
// mismatch invalidates only the read-only roles and follows TASK-7's
// PHASE_CHECKPOINT_DRIFT posture. No progress is ever merged across any of the
// three identities.
export function evaluateRoleProgressReuse({progress, role, stored, observed} = {}) {
  const shape = validateProgressShape(progress);
  if (!shape.ok) return shape;
  if (!isRole(role)) return fail(INVALID_CODE, `unknown role ${JSON.stringify(role)}`, {role});
  if (!isPlainObject(stored) || !isPlainObject(observed)) {
    return fail(INVALID_CODE, "stored and observed identities are required", {});
  }
  if (stored.revision !== observed.revision) {
    return {
      ok: false, action: "invalidate", code: INVALID_CODE, reason: "revision mismatch",
      evidence: {field: "revision", expected: stored.revision, observed: observed.revision},
    };
  }
  if (stored.phaseTaskDigest !== observed.phaseTaskDigest) {
    return {
      ok: false, action: "invalidate", code: INVALID_CODE, reason: "phase-task digest mismatch",
      evidence: {field: "phaseTaskDigest", expected: stored.phaseTaskDigest, observed: observed.phaseTaskDigest},
    };
  }
  if (isReadOnly(role) && stored.deltaDigest !== observed.deltaDigest) {
    return {
      ok: false, action: "invalidate", code: DRIFT_CODE, reason: "full phase-delta drift",
      evidence: {field: "deltaDigest", expected: stored.deltaDigest, observed: observed.deltaDigest},
    };
  }
  return {ok: true, action: "reuse", code: "ROLE_PROGRESS_REUSABLE", evidence: {role}};
}

// Reset one role's progress to its empty shape. The other roles are untouched.
export function resetRoleProgress(progress, role) {
  const shape = validateProgressShape(progress);
  if (!shape.ok) return shape;
  if (!isRole(role)) return fail(INVALID_CODE, `unknown role ${JSON.stringify(role)}`, {role});
  const empty = emptyRoleProgress();
  return {ok: true, progress: {...clone(progress), [role]: empty[role]}, role};
}

// Functional FAIL (Reviewer/Verifier) returns to the Implementer and increments
// the revision. All role progress from the old revision is cleared — never
// merged forward — while the old Implementer facts are exposed as bounded,
// explicitly non-approval context for the repair prompt. The prompt assembler
// (task 9) decides whether to show that context; this evaluator's no-merge rule
// is the prohibition half.
//
// TASK-21 (carry forward) re-commits previous facts through commitTaskResult
// under the new revision (see carryDecision() in finding-task-locality.mjs),
// so no progress object is merged. Only facts are replayed, through the
// validated path.
export function beginRevision({progress} = {}) {
  const shape = validateProgressShape(progress);
  if (!shape.ok) return shape;
  const oldFacts = isPlainObject(progress.implementer?.factsByTask) ? clone(progress.implementer.factsByTask) : {};
  return {
    ok: true,
    code: "REVISION_RESET",
    progress: emptyRoleProgress(),
    context: {role: "implementer", factsByTask: oldFacts, approvals: false},
    evidence: {roles: [...ROLE_PROGRESS_ROLES]},
  };
}

// ── Crash ordering ───────────────────────────────────────────────────────
// `currentTaskId` is recorded before launch and `completedTaskIds` only after
// durable completion, so an interrupted role resumes at the first task it did
// not checkpoint — at most the current task, never the whole phase. Read-only
// roles that finished every task-local pass but not the whole-phase pass resume
// that pass.
export function evaluateCrashResume({progress, role, taskIds} = {}) {
  const shape = validateProgressShape(progress);
  if (!shape.ok) return shape;
  if (!isRole(role)) return fail(INVALID_CODE, `unknown role ${JSON.stringify(role)}`, {role});
  if (!Array.isArray(taskIds) || taskIds.length === 0) {
    return fail(INVALID_CODE, "taskIds is required", {taskIds});
  }
  const entry = progress[role];
  if (!entry) return fail(INVALID_CODE, `roleProgress.${role} is absent`, {role});
  const completed = entry.completedTaskIds;
  if (entry.currentTaskId !== null && entry.currentTaskId !== undefined && !completed.includes(entry.currentTaskId)) {
    return {ok: true, action: "resume", code: "RESUME_CURRENT_TASK", taskId: entry.currentTaskId};
  }
  const nextTask = taskIds.find((id) => !completed.includes(id));
  if (nextTask !== undefined) {
    return {ok: true, action: "resume", code: "RESUME_FIRST_UNCOMPLETED", taskId: nextTask};
  }
  if (isReadOnly(role) && entry.phaseWidePassComplete !== true) {
    return {ok: true, action: "phase_wide_pass", code: "RESUME_PHASE_WIDE_PASS", taskId: null};
  }
  return {ok: true, action: "complete", code: "ROLE_COMPLETE", taskId: null};
}

// Record the whole-phase integration pass for a read-only role. Only allowed
// once every task-local pass is durably complete.
export function completePhaseWidePass({progress, role} = {}) {
  const shape = validateProgressShape(progress);
  if (!shape.ok) return shape;
  if (!isReadOnly(role)) {
    return fail(INVALID_CODE, "a whole-phase pass applies only to Code Reviewer and Verifier", {role});
  }
  const entry = progress[role];
  if (!entry) return fail(INVALID_CODE, `roleProgress.${role} is absent`, {role});
  if (entry.status !== "complete") {
    return fail(INVALID_CODE, "whole-phase pass requires all task-local work to be complete", {status: entry.status});
  }
  const next = clone(progress);
  next[role].phaseWidePassComplete = true;
  const check = validateProgressShape(next);
  if (!check.ok) return check;
  return {ok: true, progress: next, role};
}
