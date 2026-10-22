#!/usr/bin/env node
// TASK-19 Phase 2 task 7 — commit-mechanics / invalidation / crash-ordering
// unit tests for `scripts/role-progress-commit.mjs` (tasks 5-6).
//
// Fake normalized results only: no subprocess, no adapter, no filesystem state.
// Every fail-closed case from task 5 and task 6 is asserted as its own case,
// never inferred from another. Implementer progress is shown surviving an
// expected delta change while still failing closed on revision / phase-task
// digest / task-ID mismatch; Code Reviewer/Verifier progress refuses reuse on
// full-delta drift specifically, isolated from the revision and phase-task
// digest cases.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  PROGRESS_AUTHORITY, LAUNCH_CONTRACT, ROLE_STAGE, READ_ONLY_ROLES, TASK_RESULT_COMPLETE,
  prepareTaskInvocation, validateTaskResult, commitTaskResult,
  evaluateRoleProgressReuse, resetRoleProgress, beginRevision,
  evaluateCrashResume, completePhaseWidePass,
} from "./role-progress-commit.mjs";
import {
  INVALID_CODE, DRIFT_CODE, ROLE_PROGRESS_ROLES, ROLE_PROGRESS_MAX_FILES,
  emptyRoleProgress, validateRoleProgress,
} from "./phase-stage-checkpoint.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, evidence) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(evidence)}` : ""}`);
  failed += 1;
}
function rejects(name, result) {
  check(name, result && !result.ok && result.code === INVALID_CODE, result);
}
function invalidates(name, result, code) {
  check(name, result && !result.ok && result.action === "invalidate" && result.code === code, result);
}

const here = path.dirname(fileURLToPath(import.meta.url));

// ── Fixtures ─────────────────────────────────────────────────────────────
const T0 = "standalone:P1:T0:aaaaaaaaaaaa";
const T1 = "standalone:P1:T1:bbbbbbbbbbbb";
const T2 = "standalone:P1:T2:cccccccccccc";
const TASKS = [T0, T1, T2];
const RUN = "run-1";
const REV = 1;
const TASK_DIGEST = "sha256:" + "a".repeat(64);
const DELTA = "sha256:" + "b".repeat(64);
const DELTA_DRIFT = "sha256:" + "c".repeat(64);

function defaultFacts(role, taskId) {
  if (role === "implementer") {
    return {
      summary: `implemented ${taskId}`,
      files: ["scripts/a.mjs"],
      taskLocalCheck: {command: "node --check scripts/a.mjs", status: "passed", exitCode: 0, summary: "ok"},
    };
  }
  if (role === "codeReviewer") return {summary: `reviewed ${taskId}`, findings: []};
  return {summary: `verified ${taskId}`, evidence: []};
}

function runTask(progress, role, taskId, opts = {}) {
  return prepareTaskInvocation({
    progress, role,
    runId: opts.runId ?? RUN,
    revision: opts.revision ?? REV,
    phaseTaskDigest: opts.phaseTaskDigest ?? TASK_DIGEST,
    deltaDigest: "deltaDigest" in opts ? opts.deltaDigest : DELTA,
    taskId,
    taskIds: opts.taskIds ?? TASKS,
  });
}

function taskResult(role, taskId, expected, overrides = {}) {
  return {
    role,
    runId: expected.runId,
    revision: expected.revision,
    phaseTaskDigest: expected.phaseTaskDigest,
    taskId,
    status: TASK_RESULT_COMPLETE,
    facts: defaultFacts(role, taskId),
    ...(role === "implementer" ? {} : {deltaDigest: expected.deltaDigest, decision: "PASS"}),
    ...overrides,
  };
}

// Prepare + commit one task in one step; returns the commit result.
function commitOne(progress, role, taskId, opts = {}) {
  const prep = runTask(progress, role, taskId, opts);
  if (!prep.ok) return {prep};
  const result = taskResult(role, taskId, prep.expected, opts.resultOverrides ?? {});
  return {prep, result, commit: commitTaskResult({progress: prep.progress, expected: prep.expected, result})};
}

// A progress block with the first `count` tasks already committed for a role.
function progressAfter(role, count) {
  let progress = emptyRoleProgress();
  for (let i = 0; i < count; i += 1) {
    const out = commitOne(progress, role, TASKS[i]);
    if (!out.commit?.ok) throw new Error(`fixture failed to commit ${TASKS[i]}: ${JSON.stringify(out.commit)}`);
    progress = out.commit.progress;
  }
  return progress;
}

// ── Exports, constants, and the single progress authority ────────────────
for (const fn of [
  "prepareTaskInvocation", "validateTaskResult", "commitTaskResult",
  "evaluateRoleProgressReuse", "resetRoleProgress", "beginRevision",
  "evaluateCrashResume", "completePhaseWidePass",
]) {
  const mod = await import("./role-progress-commit.mjs");
  check(`exports ${fn}`, typeof mod[fn] === "function");
}
check("constants: one progress authority, no second source", PROGRESS_AUTHORITY === "phaseExecutionCheckpoint", PROGRESS_AUTHORITY);
check("constants: launch contract forbids model-written orchestration state",
  LAUNCH_CONTRACT.modelWritesOrchestrationState === false &&
  LAUNCH_CONTRACT.progressAuthority === "phaseExecutionCheckpoint" &&
  LAUNCH_CONTRACT.resume === false, LAUNCH_CONTRACT);
check("constants: stage mapping for all three roles",
  ROLE_STAGE.implementer === "implementer" &&
  ROLE_STAGE.codeReviewer === "code_reviewer" &&
  ROLE_STAGE.verifier === "verifier", ROLE_STAGE);
check("constants: read-only roles are Code Reviewer and Verifier",
  JSON.stringify([...READ_ONLY_ROLES]) === JSON.stringify(["codeReviewer", "verifier"]), READ_ONLY_ROLES);

// ── Purity: no filesystem/process/network, and no second progress channel ─
{
  const source = fs.readFileSync(path.join(here, "role-progress-commit.mjs"), "utf8");
  for (const token of [
    "node:fs", "node:child_process", "node:net", "node:http", "node:https",
    "process.env", "process.", "new Date(", "writeFileSync", "readFileSync",
    "renameSync", "spawnSync", "execSync", "fetch(", "XMLHttpRequest",
    "journal", "state.json",
  ]) {
    check(`commit module pure/no second channel: no ${token}`, !source.includes(token), token);
  }
}

// ── Step 1: pre-launch persist records cursor before launch ──────────────
{
  const prep = runTask(emptyRoleProgress(), "implementer", T0);
  check("prepare: valid launch is accepted", prep.ok, prep);
  check("prepare: currentTaskId is recorded before launch", prep.progress.implementer.currentTaskId === T0);
  check("prepare: status becomes running", prep.progress.implementer.status === "running");
  check("prepare: cursor points at the current task", prep.progress.implementer.taskCursor === 0);
  check("prepare: expected descriptor carries the task list", JSON.stringify(prep.expected.taskIds) === JSON.stringify(TASKS));

  // Pre-launch persist must not itself be an approval.
  check("prepare: nothing is added to completedTaskIds before the result",
    prep.progress.implementer.completedTaskIds.length === 0);
}

// ── Steps 3-5: normal flow commits facts and advances the cursor ─────────
{
  let progress = emptyRoleProgress();
  const c0 = commitOne(progress, "implementer", T0);
  check("commit: first task commits", c0.commit.ok, c0.commit);
  progress = c0.commit.progress;
  check("commit: completedTaskIds gains the task", JSON.stringify(progress.implementer.completedTaskIds) === JSON.stringify([T0]));
  check("commit: cursor advances", progress.implementer.taskCursor === 1);
  check("commit: currentTaskId is cleared atomically", progress.implementer.currentTaskId === null);
  check("commit: bounded facts are stored under the task ID",
    progress.implementer.factsByTask[T0]?.taskLocalCheck?.status === "passed");
  check("commit: role is not complete while tasks remain", c0.commit.roleComplete === false);

  const c1 = commitOne(progress, "implementer", T1);
  check("commit: second task commits", c1.commit.ok, c1.commit);
  const c2 = commitOne(c1.commit.progress, "implementer", T2);
  check("commit: final task completes the role", c2.commit.ok && c2.commit.roleComplete === true, c2.commit);
  check("commit: role status is complete only after the last task",
    c2.commit.progress.implementer.status === "complete");
  check("commit: committed progress is schema-valid", validateRoleProgress(c2.commit.progress).ok);

  // Read-only roles carry a decision and their own fact key.
  const r0 = commitOne(emptyRoleProgress(), "codeReviewer", T0);
  check("commit: Code Reviewer task result commits findings",
    r0.commit.ok && Array.isArray(r0.commit.progress.codeReviewer.findingsByTask[T0].findings), r0.commit);
  const v0 = commitOne(emptyRoleProgress(), "verifier", T0);
  check("commit: Verifier task result commits evidence",
    v0.commit.ok && Array.isArray(v0.commit.progress.verifier.evidenceByTask[T0].evidence), v0.commit);
}

// ── Task 5 fail-closed cases, each asserted independently ────────────────
{
  const prep = runTask(emptyRoleProgress(), "implementer", T0);
  const base = taskResult("implementer", T0, prep.expected);

  rejects("fail-closed: non-object result rejected", commitTaskResult({progress: prep.progress, expected: prep.expected, result: null}));
  rejects("fail-closed: string result rejected", commitTaskResult({progress: prep.progress, expected: prep.expected, result: "done"}));

  rejects("fail-closed: wrong-role result rejected",
    commitTaskResult({progress: prep.progress, expected: prep.expected, result: {...base, role: "verifier"}}));
  rejects("fail-closed: wrong-run result rejected",
    commitTaskResult({progress: prep.progress, expected: prep.expected, result: {...base, runId: "run-2"}}));
  rejects("fail-closed: wrong-revision result rejected",
    commitTaskResult({progress: prep.progress, expected: prep.expected, result: {...base, revision: 2}}));
  rejects("fail-closed: phase-task digest mismatch rejected",
    commitTaskResult({progress: prep.progress, expected: prep.expected, result: {...base, phaseTaskDigest: DELTA_DRIFT}}));
  rejects("fail-closed: unknown-task result rejected",
    commitTaskResult({progress: prep.progress, expected: prep.expected, result: {...base, taskId: T1}}));
  rejects("fail-closed: unknown task in prepare rejected", runTask(emptyRoleProgress(), "implementer", "standalone:P1:T9:ffff"));
  rejects("fail-closed: incomplete result is not a commit",
    commitTaskResult({progress: prep.progress, expected: prep.expected, result: {...base, status: "running"}}));
  rejects("fail-closed: missing bounded facts rejected",
    commitTaskResult({progress: prep.progress, expected: prep.expected, result: {...base, facts: null}}));
  rejects("fail-closed: verdict-shaped taskLocalCheck rejected",
    commitTaskResult({
      progress: prep.progress, expected: prep.expected,
      result: {...base, facts: {...base.facts, taskLocalCheck: {command: "npm test", status: "passed", verified: true}}},
    }));
  rejects("fail-closed: bounded fact beyond the file cap rejected",
    commitTaskResult({
      progress: prep.progress, expected: prep.expected,
      result: {...base, facts: {...base.facts, files: Array.from({length: ROLE_PROGRESS_MAX_FILES + 1}, (_, i) => `f-${i}.mjs`)}},
    }));

  // Out-of-order cursor movement: the expected task is not the cursor's task.
  const prepAtT1 = runTask(progressAfter("implementer", 1), "implementer", T0);
  rejects("fail-closed: out-of-order task (already completed) rejected", prepAtT1);
  const prepSkip = runTask(emptyRoleProgress(), "implementer", T1);
  rejects("fail-closed: skipped-ahead cursor movement rejected", prepSkip);
  const inflight = runTask(emptyRoleProgress(), "implementer", T0);
  rejects("fail-closed: a second task cannot launch while one is in flight",
    runTask(inflight.progress, "implementer", T1));

  // Stage-appropriate digest contract, asserted on both sides.
  const roPrep = runTask(emptyRoleProgress(), "codeReviewer", T0);
  const roBase = taskResult("codeReviewer", T0, roPrep.expected);
  rejects("fail-closed: frozen full-delta mismatch rejected for Code Reviewer",
    commitTaskResult({progress: roPrep.progress, expected: roPrep.expected, result: {...roBase, deltaDigest: DELTA_DRIFT}}));
  rejects("fail-closed: frozen full-delta mismatch rejected for Verifier",
    (() => {
      const p = runTask(emptyRoleProgress(), "verifier", T0);
      return commitTaskResult({progress: p.progress, expected: p.expected, result: {...taskResult("verifier", T0, p.expected), deltaDigest: DELTA_DRIFT}});
    })());
  rejects("fail-closed: read-only result without a PASS/FAIL decision rejected",
    commitTaskResult({progress: roPrep.progress, expected: roPrep.expected, result: {...roBase, decision: undefined}}));
  rejects("fail-closed: read-only prepare without a frozen delta rejected",
    runTask(emptyRoleProgress(), "codeReviewer", T0, {deltaDigest: null}));

  // The affirmative half: the Implementer's changing delta is deliberately not
  // compared, so an expected per-task delta change still commits.
  const implDelta = commitTaskResult({
    progress: prep.progress, expected: prep.expected,
    result: {...base, deltaDigest: DELTA_DRIFT},
  });
  check("must-pass: Implementer result with a changed delta still commits (delta not bound)",
    implDelta.ok, implDelta);
}

// ── Task 6: identity-bound reuse, isolated per identity ──────────────────
{
  const progress = emptyRoleProgress();
  const stored = {revision: REV, phaseTaskDigest: TASK_DIGEST, deltaDigest: DELTA};

  // Implementer: revision + task digest + stable cursor; delta ignored.
  const implReuse = evaluateRoleProgressReuse({
    progress, role: "implementer", stored,
    observed: {revision: REV, phaseTaskDigest: TASK_DIGEST, deltaDigest: DELTA_DRIFT},
  });
  check("reuse: Implementer progress survives the expected delta change", implReuse.action === "reuse", implReuse);
  invalidates("reuse: Implementer progress invalidated on revision mismatch",
    evaluateRoleProgressReuse({progress, role: "implementer", stored, observed: {...stored, revision: 2}}), INVALID_CODE);
  invalidates("reuse: Implementer progress invalidated on phase-task digest mismatch",
    evaluateRoleProgressReuse({progress, role: "implementer", stored, observed: {...stored, phaseTaskDigest: DELTA_DRIFT}}), INVALID_CODE);

  // Code Reviewer: all three must match; delta drift isolated from the others.
  check("reuse: Code Reviewer progress reusable when all identities match",
    evaluateRoleProgressReuse({progress, role: "codeReviewer", stored, observed: {...stored}}).action === "reuse");
  const reviewerDelta = evaluateRoleProgressReuse({
    progress, role: "codeReviewer", stored, observed: {...stored, deltaDigest: DELTA_DRIFT},
  });
  invalidates("reuse: Code Reviewer progress refuses full-delta drift (isolated)",
    reviewerDelta, DRIFT_CODE);
  check("reuse: Code Reviewer delta-drift evidence names the deltaDigest field",
    reviewerDelta.evidence?.field === "deltaDigest", reviewerDelta);
  invalidates("reuse: Code Reviewer progress invalidated on revision mismatch",
    evaluateRoleProgressReuse({progress, role: "codeReviewer", stored, observed: {...stored, revision: 2}}), INVALID_CODE);
  invalidates("reuse: Code Reviewer progress invalidated on phase-task digest mismatch",
    evaluateRoleProgressReuse({progress, role: "codeReviewer", stored, observed: {...stored, phaseTaskDigest: DELTA_DRIFT}}), INVALID_CODE);

  // Verifier: same rules, asserted independently.
  check("reuse: Verifier progress reusable when all identities match",
    evaluateRoleProgressReuse({progress, role: "verifier", stored, observed: {...stored}}).action === "reuse");
  invalidates("reuse: Verifier progress refuses full-delta drift (isolated)",
    evaluateRoleProgressReuse({progress, role: "verifier", stored, observed: {...stored, deltaDigest: DELTA_DRIFT}}), DRIFT_CODE);
  invalidates("reuse: Verifier progress invalidated on revision mismatch",
    evaluateRoleProgressReuse({progress, role: "verifier", stored, observed: {...stored, revision: 2}}), INVALID_CODE);
  invalidates("reuse: Verifier progress invalidated on phase-task digest mismatch",
    evaluateRoleProgressReuse({progress, role: "verifier", stored, observed: {...stored, phaseTaskDigest: DELTA_DRIFT}}), INVALID_CODE);

  rejects("reuse: unknown role rejected",
    evaluateRoleProgressReuse({progress, role: "planner", stored, observed: {...stored}}));
}

// ── Invalidation: no progress is merged across a revision ────────────────
{
  const progress = progressAfter("implementer", 2);
  const reviewer = commitOne(progress, "codeReviewer", T0);
  const withReviewer = reviewer.commit.progress;
  const before = JSON.stringify(withReviewer);

  const next = beginRevision({progress: withReviewer});
  check("revision: beginRevision succeeds", next.ok, next);
  check("revision: all role cursors are cleared, never merged forward",
    next.progress.implementer.completedTaskIds.length === 0 &&
    next.progress.codeReviewer.completedTaskIds.length === 0 &&
    next.progress.verifier.completedTaskIds.length === 0, next.progress);
  check("revision: old implementation facts are absent from the new progress",
    Object.keys(next.progress.implementer.factsByTask).length === 0);
  check("revision: old implementation facts are exposed as non-approval context",
    next.context?.approvals === false && next.context?.factsByTask?.[T0] !== undefined, next.context);
  check("revision: beginRevision is pure (input unchanged)", JSON.stringify(withReviewer) === before);

  const reset = resetRoleProgress(withReviewer, "codeReviewer");
  check("revision: resetRoleProgress clears only the named role",
    reset.ok &&
    reset.progress.codeReviewer.completedTaskIds.length === 0 &&
    reset.progress.implementer.completedTaskIds.length === 2, reset);
  rejects("revision: resetRoleProgress rejects an unknown role", resetRoleProgress(withReviewer, "planner"));
}

// ── Crash ordering: at most the current task repeats ─────────────────────
{
  // Crash before completion checkpoint: currentTaskId is set, not completed.
  const prepared = runTask(emptyRoleProgress(), "implementer", T0);
  const crashed = evaluateCrashResume({progress: prepared.progress, role: "implementer", taskIds: TASKS});
  check("crash: pre-completion crash resumes the current task",
    crashed.ok && crashed.action === "resume" && crashed.taskId === T0, crashed);

  // Crash after the role returned but before the state update: identical
  // observable state, so it resumes the same task and repeats nothing else.
  const afterReturn = evaluateCrashResume({progress: prepared.progress, role: "implementer", taskIds: TASKS});
  check("crash: crash after return/before state update repeats only the current task",
    afterReturn.taskId === T0 && prepared.progress.implementer.completedTaskIds.length === 0, afterReturn);

  // Mid-phase crash: T0/T1 committed, T2 in flight.
  const mid = commitOne(progressAfter("implementer", 2), "implementer", T2);
  const midCrash = evaluateCrashResume({progress: mid.prep.progress, role: "implementer", taskIds: TASKS});
  check("crash: mid-phase crash resumes the in-flight task, not earlier tasks",
    midCrash.action === "resume" && midCrash.taskId === T2, midCrash);

  // Crash between tasks: no currentTaskId, first uncompleted resumes.
  const between = evaluateCrashResume({progress: progressAfter("implementer", 1), role: "implementer", taskIds: TASKS});
  check("crash: between-tasks crash resumes the first uncompleted task",
    between.action === "resume" && between.taskId === T1, between);

  // Commit is pure: a crash before the caller persists leaves the input as-is.
  const prep = runTask(progressAfter("implementer", 1), "implementer", T1);
  const snapshot = JSON.stringify(prep.progress);
  const committed = commitTaskResult({progress: prep.progress, expected: prep.expected, result: taskResult("implementer", T1, prep.expected)});
  check("crash: commit returns a new value and never mutates the input",
    committed.ok && JSON.stringify(prep.progress) === snapshot &&
    prep.progress.implementer.completedTaskIds.length === 1, {snapshot});

  // Read-only role finished every task-local pass: resume the whole-phase pass.
  const reviewerDone = progressAfter("codeReviewer", TASKS.length);
  const needPass = evaluateCrashResume({progress: reviewerDone, role: "codeReviewer", taskIds: TASKS});
  check("crash: read-only role resumes the whole-phase pass, not a task",
    needPass.action === "phase_wide_pass" && needPass.taskId === null, needPass);
  const passed = completePhaseWidePass({progress: reviewerDone, role: "codeReviewer"});
  check("crash: whole-phase pass can be recorded once task-local work is complete",
    passed.ok && passed.progress.codeReviewer.phaseWidePassComplete === true, passed);
  const done = evaluateCrashResume({progress: passed.progress, role: "codeReviewer", taskIds: TASKS});
  check("crash: after the whole-phase pass the read-only role is complete",
    done.action === "complete", done);

  // Implementer has no whole-phase pass.
  const implDone = progressAfter("implementer", TASKS.length);
  check("crash: Implementer completes with the last task",
    evaluateCrashResume({progress: implDone, role: "implementer", taskIds: TASKS}).action === "complete");
  rejects("crash: whole-phase pass on Implementer rejected", completePhaseWidePass({progress: implDone, role: "implementer"}));
  rejects("crash: whole-phase pass before all tasks complete rejected",
    completePhaseWidePass({progress: progressAfter("codeReviewer", 1), role: "codeReviewer"}));
  rejects("crash: crash resume rejects an unknown role",
    evaluateCrashResume({progress: emptyRoleProgress(), role: "planner", taskIds: TASKS}));
}

// ── Discovery (task 8) ───────────────────────────────────────────────────
{
  const runner = fs.readFileSync(path.join(here, "test-all.mjs"), "utf8");
  check("discovery: test-role-progress-commit.mjs matches the runner discovery regex",
    /^test-.*\.mjs$/.test("test-role-progress-commit.mjs"));
  check("discovery: role-progress-commit.mjs is not a runner candidate",
    !/^test-.*\.mjs$/.test("role-progress-commit.mjs"));
  check("discovery: test-role-progress-commit.mjs absent from both test-all exclusion sets",
    !runner.includes("test-role-progress-commit.mjs"));
}

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
