#!/usr/bin/env node
// TASK 16.1 — Terminal and recovered state hygiene.
//
// Proves scripts/autopilot.mjs's state.json is truthful at the mission's
// terminal phase:"complete"/step:"human_commit" transition, and that a
// still-failed/escalated mission's real failure and recovery evidence is
// never touched. This complements (does not replace) the existing
// checkbox-ownership coverage in test-task14-speckit-task-marking.mjs.
//
// Root cause this guards against: scripts/speckit-task-state.mjs's
// setTaskCheckboxes()/applyTaskCheckboxStates() write the on-disk "[x]"
// but never mutate the in-memory task objects passed to them (they map to
// NEW spread objects). scripts/autopilot.mjs's phase/task loops stored
// those SAME pre-attempt objects directly on s.currentPhase/s.currentTask
// and never cleared or corrected them afterward — so a real, fully
// successful mission's state.json could keep reporting phase/task
// completion as done:false forever, including at the terminal
// phase:"complete" state a human reads to decide the mission is done.
//
// Scenario coverage (mandatory tests A-E from the TASK_16_1 brief):
//   A: genuine failure during an attempt -> automatic in-process retry ->
//      success. Stale s.lastFailure/s.lastFailureBudget must be cleared
//      once the mission reaches phase:"complete", while the historical
//      failure stays on disk in its own result.json (never rewritten).
//   B: a complete multi-phase SpecKit mission (tasks.md fully "[x]") must
//      never leave a false s.currentTask/s.currentPhase (done:false) or
//      any other in-progress pointer at the terminal state.
//   C: a permanently failing mission must escalate with its real failure
//      (s.lastFailure/s.lastFailureBudget) intact -- this suite must never
//      clear evidence just because SOME later run of a DIFFERENT mission
//      succeeded.
//   D: a crash that leaves a pending checkbox snapshot must still recover
//      correctly on resume (valid snapshot -> reconciled -> cleared only
//      after resume, AND the terminal state also has no leftover
//      currentTask/currentPhase); a corrupted snapshot must keep failing
//      closed and stay preserved on disk, exactly as before this task.
//   E: `ap status`/`ap inspect` must be a truthful passthrough of
//      state.json for a completed, a failed/escalated, and a
//      crash-preserved-and-blocked mission alike.
//
// ===========================================================================
// COVERAGE MAP — every invariant this file protects, and how.
//
// Runtime optimization pass (matching test-task14-speckit-task-marking.mjs's
// own): Part E originally ran as THREE MORE standalone full missions
// (t16-1-e-complete, t16-1-e-escalated, t16-1-e-crash), each existing
// purely to bolt an `ap status` truthfulness check onto an outcome (a
// completed / escalated / mid-crash mission) that a DIFFERENT scenario in
// this same file already produces for its own primary purpose — two of the
// three (C vs E/escalated, D1 vs E/crash) used a BYTE-IDENTICAL mission
// setup. `ap status`'s own implementation is a two-line, zero-transformation
// passthrough (scripts/autopilot.mjs's `status` command:
// `console.log(JSON.stringify(loadState(),null,2))` + a `git status
// --short` line) — there is no pure logic worth extracting; the only thing
// worth proving is that the REAL CLI subprocess reads the SAME file a real
// mission wrote, which a cheap `ap status` call appended to an
// ALREADY-RUNNING representative mission proves just as well as (and more
// realistically than) a fourth separate mission. No production file
// changed for this optimization — the merge is entirely test-file
// restructuring.
//
// | Scenario                                    | Invariant / bug it protects | Coverage form (post-optimization) |
// |-----------------------------------------------|-------------------------------|-------------------------------------|
// | A                                              | A genuine in-process retry clears stale lastFailure/lastFailureBudget at completion, while the historical FAIL survives untouched in its own result.json | full E2E (unchanged) — representative "recovers via retry" |
// | B (+ folded E/complete)                        | A fully complete mission leaves no false currentTask/currentPhase/pendingCheckboxSnapshot at the terminal state, keeps lastReview audit evidence; `ap status` truthfully passes through a completed state.json byte-for-byte | full E2E (merged) — representative Complete |
// | C (+ folded E/escalated)                       | A permanently failing mission escalates with real lastFailure/lastFailureBudget evidence intact, never cleared by an unrelated success; `ap status` truthfully reports the escalated state and preserved evidence | full E2E (merged) — representative Escalated |
// | D1 (+ folded E/crash)                          | A real crash before reconciliation persists a recoverable pending snapshot; `ap status` truthfully exposes it mid-recovery (never falsely reports complete); a valid resume reconciles it and leaves no leftover currentTask/currentPhase | full E2E (merged) — representative Crash/Resume (valid) |
// | D2                                             | A crash whose persisted snapshot is then corrupted (mission mismatch) fails closed on resume, escalates via task_snapshot_recovery_failed, and preserves the invalid snapshot on disk — kept distinct from D1 (opposite outcome, not a duplicate) and independent of test-task14's own exhaustive corruption-shape coverage, so this file keeps its own regression proof of "crash + corruption -> fail closed" | full E2E (unchanged) — representative Crash/Resume (fails closed) |
// ===========================================================================
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {
  skillRoot, makeFixtureRepo, makeFixtureBin, makeSpecKitPhaseFixture, makeSpecKitMultiTaskFixture,
  setScenario, writeConfig, runAutopilot, runAutopilotUntilMarker, readObservedEvents, cleanup, withoutOuterGitGuard
} from "./test-fixtures/workflow-order-harness.mjs";

// Each full mission below is a real SpecKit run where every read-only role
// (plan_reviewer/code_reviewer/verifier) launches inside the Windows
// disposable-copy compatibility bridge — a real, full filesystem copy of
// the repository per invocation, not a bind-mount — which costs materially
// more wall-clock time than WSL2's bubblewrap (see
// test-windows-disposable-plan-reviewer.mjs's own 220000ms budget for a
// single such mission). 90000ms is enough on Linux/WSL2; native Windows
// needs the same order-of-magnitude headroom as that established sibling.
const MISSION_TIMEOUT_MS = process.platform === "win32" ? 220000 : 90000;
// The task14_crash_before_reconcile marker fires only after Spec, Spec
// Review, Plan, Plan Review, Tasks, and Tasks Review have all already
// completed (the Implementer that writes the marker is the 7th phase) — on
// Windows that is effectively a full mission's worth of disposable-copy
// review overhead before the marker can even appear, so this needs the same
// headroom as MISSION_TIMEOUT_MS, not the short deadline that suffices on
// Linux/WSL2.
const MARKER_WAIT_TIMEOUT_MS = process.platform === "win32" ? 220000 : 30000;

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`); }
}

// Per-scenario wall-clock timing (measure each scenario separately, both
// before and after any restructuring). Purely additive instrumentation —
// wraps a scenario body with no change to its assertions or execution
// order. Same pattern as test-task14-speckit-task-marking.mjs's own.
async function scenario(label, fn) {
  const t0 = Date.now();
  try {
    await fn();
  } finally {
    console.log(`[timing] ${label}: ${Date.now() - t0}ms`);
  }
}
function loadState(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
}
function runStatus(repo) {
  const r = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "autopilot.mjs"), "status", "--repo", repo], {
    encoding: "utf8", env: withoutOuterGitGuard(process.env), shell: false
  });
  // "ap status" prints JSON.stringify(loadState(), null, 2) (a MULTI-LINE
  // pretty-printed object, closing brace flush left) followed by a second
  // line with `git status --short` output -- take every line up to and
  // including that flush-left closing brace, not just the first line.
  const lines = (r.stdout || "").split("\n");
  const closeIdx = lines.findIndex((line, i) => i > 0 && line === "}");
  const jsonBlock = closeIdx === -1 ? "" : lines.slice(0, closeIdx + 1).join("\n");
  let parsed = null;
  try { parsed = JSON.parse(jsonBlock); } catch { /* leave null on malformed output */ }
  return {status: r.status, parsed};
}

// A minimal pre-existing dirty worktree whose modified/deleted/staged and
// untracked files a naively-scoped diff would leak into review -- causes
// the fixture adapter's "dirty_worktree_changes" scenario to genuinely FAIL
// Code Review on attempt 1 (a real defect it can detect) and PASS on
// attempt 2, entirely within ONE `ap run` process (no manual resume).
function seedDirtyWorktree(repo) {
  const git = (args) => spawnSync("git", args, {cwd: repo, stdio: "ignore", env: withoutOuterGitGuard(process.env)});
  fs.writeFileSync(path.join(repo, "existing-modified.txt"), "committed\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "seed pre-existing tracked file"]);
  fs.writeFileSync(path.join(repo, "existing-modified.txt"), "committed\nmodified-before-mission\n");
}

// ===========================================================================
// A — genuine failure -> automatic in-process retry -> success. Stale
// failure/recovery fields cleared at completion; historical evidence kept.
// ===========================================================================
await scenario("A: genuine failure -> automatic retry -> success", async () => {
  const repo = makeFixtureRepo("t16-1-a");
  const binDir = makeFixtureBin("t16-1-a");
  try {
    makeSpecKitPhaseFixture(repo);
    writeConfig(repo, {planningFramework: "speckit"});
    setScenario(repo, "dirty_worktree_changes");
    seedDirtyWorktree(repo);

    const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: MISSION_TIMEOUT_MS});
    check("A: mission completed (exit 0) after failing once and retrying", run.status === 0, run.stderr.slice(-800));

    const events = readObservedEvents(repo);
    const codeReviews = events.filter(e => e.role === "code_reviewer");
    check("A: a genuine Code Review FAIL was recorded on attempt 1", codeReviews.some(e => e.decision === "FAIL"));
    check("A: a genuine Code Review PASS was recorded on the retry", codeReviews.some(e => e.decision === "PASS"));

    const state = loadState(repo);
    check("A: terminal phase=complete", state.phase === "complete");
    check("A: terminal step=human_commit", state.step === "human_commit");
    check("A: stale lastFailure is cleared (absent) after successful recovery", !Object.hasOwn(state, "lastFailure"));
    check("A: stale lastFailureBudget is cleared (absent) after successful recovery", !Object.hasOwn(state, "lastFailureBudget"));

    // The historical failure must survive in its OWN result.json on disk --
    // finalizing the mission must never rewrite or delete run history.
    const eventsAfterFinalize = readObservedEvents(repo);
    check("A: historical result.json FAIL evidence still on disk after mission completed",
      eventsAfterFinalize.some(e => e.role === "code_reviewer" && e.decision === "FAIL"));
    check("A: result.json event count unchanged by finalization (nothing deleted)",
      eventsAfterFinalize.length === events.length);
  } finally {
    cleanup(repo, binDir);
  }
});

// ===========================================================================
// B — a fully complete multi-phase SpecKit mission must never leave a false
// currentTask/currentPhase (or any other in-progress pointer) at the
// terminal phase:"complete" state, even though tasks.md is genuinely all
// "[x]".
// ===========================================================================
await scenario("B+E/complete: complete mission terminal hygiene + ap status passthrough", async () => {
  const repo = makeFixtureRepo("t16-1-b");
  const binDir = makeFixtureBin("t16-1-b");
  try {
    const featureDir = makeSpecKitMultiTaskFixture(repo);
    writeConfig(repo, {planningFramework: "speckit"});
    setScenario(repo, "success");
    const run = runAutopilot(repo, binDir, {request: "implement the multi-task fixture", timeoutMs: MISSION_TIMEOUT_MS});
    check("B: mission completed (exit 0)", run.status === 0, run.stderr.slice(-800));

    const tasksContent = fs.readFileSync(path.join(featureDir, "tasks.md"), "utf8");
    check("B: tasks.md is fully checked -- no remaining unchecked task boxes", !/^- \[ \]/m.test(tasksContent));

    const state = loadState(repo);
    check("B: terminal phase=complete", state.phase === "complete");
    check("B: terminal step=human_commit", state.step === "human_commit");
    check("B: terminal state has no currentTask (absent, not a false done:false)", !Object.hasOwn(state, "currentTask"));
    check("B: terminal state has no currentPhase (absent, not a false tasks[*].done:false)", !Object.hasOwn(state, "currentPhase"));
    check("B: terminal state has no pendingCheckboxSnapshot", !Object.hasOwn(state, "pendingCheckboxSnapshot"));
    check("B: terminal state keeps the final review decision (permanent audit evidence)", !!state.lastReview);

    // Folded in from the original separate "E/complete" scenario (DUPLICATE-
    // WORKFLOW MERGE — see coverage map): that scenario ran its own full
    // mission (a different fixture, but the identical "success" outcome)
    // purely to then call `ap status` and check it's a truthful passthrough
    // of state.json. B already has a real, freshly-completed mission's repo
    // right here — no need for a second one just to add a fast, cheap `ap
    // status` subprocess call on top.
    const {status: completeStatus, parsed: completeParsed} = runStatus(repo);
    check("E/complete: ap status exits 0", completeStatus === 0);
    check("E/complete: ap status reports phase=complete truthfully", completeParsed?.phase === "complete");
    check("E/complete: ap status reports step=human_commit truthfully", completeParsed?.step === "human_commit");
    check("E/complete: ap status has no currentTask/currentPhase (matches state.json)",
      !Object.hasOwn(completeParsed || {}, "currentTask") && !Object.hasOwn(completeParsed || {}, "currentPhase"));
    check("E/complete: ap status is a faithful passthrough of state.json", JSON.stringify(completeParsed) === JSON.stringify(loadState(repo)));
  } finally {
    cleanup(repo, binDir);
  }
});

// ===========================================================================
// F — TASK-14 Phase 7 task 26: the terminal transition removes a superseded
// planning-review checkpoint that no other code path on this run would.
//
// Seeded in the framework where the key is INERT: a standalone mission cannot
// consult `speckitGateReviewCheckpoint` (that consult is gated on
// `state.framework === "speckit"`), so if the key is gone at the terminal
// state, `finalizeMissionComplete()` is what removed it. The seed is also a
// SAME-REQUEST resume (`planningRequest` already equals this run's request),
// with an explicit assertion that the run really was classified that way —
// otherwise the assertion would pass for the wrong reason, proving Phase 7's
// new-request clear instead of task 24's delete.
//
// NOT COVERED BY THIS TASK (recorded in TASK-15's task 26): the mirror
// pairing — `standalonePlanningReviewCheckpoint` deletion — which needs a
// SpecKit run to keep that key inert, and is therefore left for a follow-up.
// ===========================================================================
await scenario("F: a superseded checkpoint is deleted at the terminal transition", async () => {
  const repo = makeFixtureRepo("t14-p7-f");
  const binDir = makeFixtureBin("t14-p7-f");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    setScenario(repo, "success");
    const request = "implement the fixture task";
    // A superseded, never-cleared checkpoint from an earlier planning attempt.
    // Deliberately malformed: nothing on this path validates it, so if the
    // terminal transition failed to delete it, it would survive exactly like
    // this into a state a human reads as finished.
    fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
    fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
      version: 1, phase: "planning", step: "standalone-plan",
      planningRequest: request,
      speckitGateReviewCheckpoint: {version: 99, framework: "speckit", mission: "001-fixture-feature"}
    }, null, 2));

    const seeded = loadState(repo);
    check("F: the superseded key really is in the seeded state (the seed took)",
      Object.hasOwn(seeded, "speckitGateReviewCheckpoint"), Object.keys(seeded));

    const run = runAutopilot(repo, binDir, {request, timeoutMs: MISSION_TIMEOUT_MS});
    check("F: mission completed (exit 0)", run.status === 0, run.stderr.slice(-800));

    const state = loadState(repo);
    check("F: terminal phase=complete", state.phase === "complete");
    check("F: the run was classified as a same-request resume, so the new-request clear never fired",
      state.planningIntent?.kind !== "new", state.planningIntent);
    check("F: the superseded speckitGateReviewCheckpoint is DELETED at the terminal state",
      !Object.hasOwn(state, "speckitGateReviewCheckpoint"), Object.keys(state));
  } finally {
    cleanup(repo, binDir);
  }
});

// ===========================================================================
// C — a permanently failing mission must escalate with its REAL failure and
// recovery evidence intact. This suite's own success-path cleanup must
// never run for (and must never be mistaken to apply to) a mission that
// never actually succeeded.
// ===========================================================================
await scenario("C+E/escalated: escalated mission evidence preservation + ap status passthrough", async () => {
  const repo = makeFixtureRepo("t16-1-c");
  const binDir = makeFixtureBin("t16-1-c");
  try {
    makeSpecKitPhaseFixture(repo);
    writeConfig(repo, {planningFramework: "speckit", failureBudgets: {implementationFailureBudget: 1}});
    setScenario(repo, "task14_review_always_fail");
    const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: MISSION_TIMEOUT_MS});
    check("C: permanently-failing mission does NOT exit 0", run.status !== 0);

    const state = loadState(repo);
    check("C: mission escalates rather than completing", state.phase === "escalated");
    check("C: never reaches step=human_commit", state.step !== "human_commit");
    check("C: real failure evidence (lastFailure) is preserved, not cleared",
      state.lastFailure && typeof state.lastFailure === "object");
    check("C: failure budget evidence (lastFailureBudget) is preserved",
      state.lastFailureBudget && typeof state.lastFailureBudget === "object");

    const events = readObservedEvents(repo);
    check("C: result.json failure evidence recorded on disk", events.some(e => e.role === "code_reviewer" && e.decision === "FAIL"));

    // Folded in from the original separate "E/escalated" scenario
    // (DUPLICATE-WORKFLOW MERGE — see coverage map): its mission setup
    // (same fixture, same failure budget, same scenario flag, same request)
    // was BYTE-IDENTICAL to C's own — a second full mission launch to prove
    // an unrelated fact about the SAME resulting state.json.
    const {status: escalatedStatus, parsed: escalatedParsed} = runStatus(repo);
    check("E/escalated: ap status exits 0 (reporting status never fails just because the mission is escalated)", escalatedStatus === 0);
    check("E/escalated: ap status truthfully reports phase=escalated", escalatedParsed?.phase === "escalated");
    check("E/escalated: ap status truthfully preserves lastFailure evidence", escalatedParsed?.lastFailure && typeof escalatedParsed.lastFailure === "object");
  } finally {
    cleanup(repo, binDir);
  }
});

// ===========================================================================
// D — crash with a pending checkbox snapshot. A VALID snapshot still
// recovers correctly on resume (reconciled and cleared only afterward,
// AND the eventual terminal state has no leftover currentTask/currentPhase
// either); an INVALID (corrupted/mismatched) snapshot still fails closed
// and stays preserved on disk -- exactly the pre-existing TASK 14
// guarantee, reaffirmed here alongside the new terminal-state fields.
// ===========================================================================
await scenario("D1+E/crash: valid crash/resume terminal hygiene + ap status passthrough", async () => {
  const repo = makeFixtureRepo("t16-1-d1");
  const binDir = makeFixtureBin("t16-1-d1");
  try {
    makeSpecKitMultiTaskFixture(repo);
    writeConfig(repo, {planningFramework: "speckit"});
    setScenario(repo, "task14_crash_before_reconcile");
    const marker = path.join(repo, ".autopilot-test-crash-marker");
    const killed = await runAutopilotUntilMarker(repo, binDir, {request: "implement the multi-task fixture", markerFile: marker, timeoutMs: MARKER_WAIT_TIMEOUT_MS});
    check("D1: the crash marker was observed (killed before reconciliation ran)", killed.markerObserved && killed.killed);

    const stateAfterCrash = loadState(repo);
    check("D1: a well-formed pending snapshot survived the crash",
      Array.isArray(stateAfterCrash.pendingCheckboxSnapshot?.tasks) && stateAfterCrash.pendingCheckboxSnapshot.tasks.length > 0);

    // Folded in from the original separate "E/crash" scenario
    // (DUPLICATE-WORKFLOW MERGE — see coverage map): its crash setup
    // (identical fixture, identical scenario flag, identical marker-wait)
    // was BYTE-IDENTICAL to D1's own crash setup, run purely to check `ap
    // status` at the same mid-crash-recovery-pending moment D1 is already
    // sitting at right here, before it resumes.
    const {status: crashStatus, parsed: crashParsed} = runStatus(repo);
    check("E/crash: ap status exits 0 even mid-crash-recovery-pending", crashStatus === 0);
    check("E/crash: ap status truthfully shows the pending checkbox snapshot (recoverable state)",
      Array.isArray(crashParsed?.pendingCheckboxSnapshot?.tasks) && crashParsed.pendingCheckboxSnapshot.tasks.length > 0);
    check("E/crash: ap status does NOT falsely report phase=complete while recovery is pending", crashParsed?.phase !== "complete");

    setScenario(repo, "success");
    const resumed = runAutopilot(repo, binDir, {request: "", timeoutMs: MISSION_TIMEOUT_MS});
    check("D1: resumed mission exits 0 with no manual repair", resumed.status === 0, resumed.stderr.slice(-800));

    const stateAfterResume = loadState(repo);
    check("D1: the pending snapshot was reconciled and cleared on resume", !Object.hasOwn(stateAfterResume, "pendingCheckboxSnapshot"));
    check("D1: mission reaches phase=complete after resume", stateAfterResume.phase === "complete");
    check("D1: terminal state also has no leftover currentTask", !Object.hasOwn(stateAfterResume, "currentTask"));
    check("D1: terminal state also has no leftover currentPhase", !Object.hasOwn(stateAfterResume, "currentPhase"));
  } finally {
    cleanup(repo, binDir);
  }
});
await scenario("D2: crash + corrupted snapshot fails closed", async () => {
  // D2 — crash, then the persisted snapshot is corrupted (bound to a
  // different mission) before resume: the mission must fail closed and the
  // snapshot must survive on disk, completely untouched.
  const repo = makeFixtureRepo("t16-1-d2");
  const binDir = makeFixtureBin("t16-1-d2");
  try {
    makeSpecKitMultiTaskFixture(repo);
    writeConfig(repo, {planningFramework: "speckit"});
    setScenario(repo, "task14_crash_before_reconcile");
    const marker = path.join(repo, ".autopilot-test-crash-marker");
    const killed = await runAutopilotUntilMarker(repo, binDir, {request: "implement the multi-task fixture", markerFile: marker, timeoutMs: MARKER_WAIT_TIMEOUT_MS});
    check("D2: the crash marker was observed", killed.markerObserved && killed.killed);

    const state = loadState(repo);
    check("D2: setup produced a real pending snapshot before corruption",
      Array.isArray(state.pendingCheckboxSnapshot?.tasks) && state.pendingCheckboxSnapshot.tasks.length > 0);
    state.pendingCheckboxSnapshot.mission = "999-completely-different-mission";
    fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(state, null, 2));

    setScenario(repo, "success");
    const resumed = runAutopilot(repo, binDir, {request: "", timeoutMs: MISSION_TIMEOUT_MS});
    check("D2: resume with a mismatched snapshot exits nonzero (fails closed)", resumed.status !== 0);

    const stateAfterResume = loadState(repo);
    check("D2: mission escalates via task_snapshot_recovery_failed", stateAfterResume.step === "task_snapshot_recovery_failed");
    check("D2: the invalid snapshot is preserved on disk, never silently deleted", stateAfterResume.pendingCheckboxSnapshot != null);
    check("D2: never reaches phase=complete/step=human_commit", stateAfterResume.phase !== "complete" && stateAfterResume.step !== "human_commit");
  } finally {
    cleanup(repo, binDir);
  }
});

// Part E ("`ap status` truthful passthrough") was originally three more
// standalone full-mission scenarios here (complete/escalated/crash) — see
// the coverage map at the top of this file for why they were folded
// directly into B, C, and D1 instead (each already runs the byte-identical
// or functionally-equivalent mission for its own primary purpose).

if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nTASK 16.1 terminal-and-recovered-state-hygiene test passed");
}
