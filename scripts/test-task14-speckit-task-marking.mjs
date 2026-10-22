#!/usr/bin/env node
// TASK 14 — behavioral + unit proof that Project Autopilot owns SpecKit
// task-checkbox completion state end to end: tasks.md checkboxes are only
// ever set "[x]" by Autopilot itself, only for the exact tasks in a phase
// that just passed Implementer -> Code Review PASS -> configured gates ->
// Verifier PASS, never earlier and never on a failed/rejected attempt; a
// premature Implementer edit is neutralized rather than trusted; the
// mission is never declared complete while any active-feature task is
// still unchecked; and only the exact target lines are ever touched —
// unrelated tasks, files, indentation, Unicode text, and CRLF line endings
// are all byte-for-byte preserved.
//
// Part 1 is fast, in-process unit coverage of the validated mutation
// helper itself (scripts/speckit-task-state.mjs). Part 2 drives real
// `node scripts/autopilot.mjs run` subprocesses against disposable SpecKit
// git fixtures and scripts/test-fixtures/fake-workflow-adapter.sh, then
// inspects the real on-disk tasks.md and .autopilot/state.json the
// orchestrator itself produced — never prompt text or source-string checks.
//
// ===========================================================================
// COVERAGE MAP — every invariant this file protects, and how.
//
// Runtime optimization pass: originally ~1988s on native Windows (40 real
// `autopilot.mjs` subprocess launches, most of them read-only-role missions
// paying the Windows disposable-copy compatibility bridge's per-invocation
// full-repo-copy cost — see MISSION_TIMEOUT_MS's own comment). Two changes
// bring that down without dropping a single invariant:
//   (a) DUPLICATE-WORKFLOW MERGE: "C(correction)" and the original
//       "10:valid-resume" drove the IDENTICAL real crash fixture a second
//       time to prove two different things about the SAME resume — merged
//       into one scenario, one crash+resume subprocess pair instead of two.
//   (b) DATA-DRIVEN IN-PROCESS CONVERSION: the pending-checkbox-snapshot
//       fail-closed validator (originally an in-line function in
//       autopilot.mjs) was extracted verbatim — same logic, same inputs
//       mapped the same way, `repo` made an explicit parameter instead of a
//       closed-over module variable — into scripts/pending-checkbox-snapshot.mjs,
//       specifically so its 11 corruption/falsy-value variants (Parts 4-5)
//       could be asserted directly against the REAL production function
//       in-process, with no subprocess. Exactly ONE corruption shape and
//       ONE falsy-value shape are kept as full real-subprocess E2E
//       scenarios — not to re-verify the validator's own logic (the
//       in-process cases already do that exhaustively) but because they are
//       the only proof that autopilot.mjs's real recovery code actually
//       calls this validator at the right point and honors its verdict
//       (escalates, preserves the snapshot, launches no relay role). A
//       wiring bug there would not vary by corruption shape, so one shape
//       suffices; see each Part's own header comment for the full
//       reasoning.
//
// | Scenario                          | Invariant / bug it protects                                                   | Coverage form (post-optimization) |
// |------------------------------------|--------------------------------------------------------------------------------|------------------------------------|
// | Part 1 (unit, ~15 checks)          | setTaskCheckboxes(): exact-line mutation, CRLF/Unicode preservation, idempotency, fail-closed on identity mismatch or missing file/line | in-process (unchanged) |
// | A+E+F(positive)                    | Full success marks exactly the right lines across phases, preserves unrelated files, completes only when every task is checked | full E2E (unchanged) |
// | F(negative)                        | A later phase that never passes verification blocks completion while an earlier genuinely-verified phase is still marked | full E2E (unchanged) |
// | B                                  | Code Review failure blocks marking; a later genuinely-successful attempt marks it | full E2E (unchanged) |
// | C                                  | Verifier failure blocks marking; a later genuinely-successful attempt marks it | full E2E (unchanged) |
// | D                                  | A premature Implementer checkbox edit is neutralized despite repeated tampering; resume re-attempts rather than skipping | full E2E (unchanged) |
// | A(correction)                      | A disobedient Implementer poisoning a FUTURE (not-yet-reached) phase's checkboxes is also neutralized; resume genuinely executes that phase (>=2 real verifier PASS events), never trusts the poisoned mark | full E2E (unchanged) |
// | B(correction)                      | Reconciliation of poisoned checkboxes runs BEFORE a detected policy violation kills the mission — no task left checked even when the process dies | full E2E (unchanged) |
// | C(correction)+10 (merged)          | A REAL kill (SIGKILL) before reconciliation persists a pending snapshot that resume reconciles automatically; a genuinely valid snapshot is never over-rejected by the strict gate; no phase skipped; unrelated already-complete phase untouched | full E2E (merged — see (a) above) |
// | D(correction)                      | Code Reviewer/Verifier never observe a premature "[x]"; marking only follows a clean PASS-only run | full E2E (unchanged) |
// | 1:tasks-is-string                  | validator rejects a non-array `tasks` | in-process (real validator) |
// | 2:tasks-empty                      | validator rejects an empty `tasks` array | in-process (real validator) |
// | 3:malformed-task-entry             | validator rejects a task entry with wrong-typed fields | in-process (real validator) |
// | 4:missing-feature-identity         | validator rejects a snapshot with no `feature` key at all (legacy-schema case) | in-process (real validator) |
// | 5:feature-mismatch                 | validator rejects a snapshot whose `feature` disagrees with the currently-active feature | in-process (real validator) |
// | 6:mission-mismatch                 | validator rejects a snapshot whose `mission` disagrees with the current mission identity | in-process (real validator) |
// | 7:task-path-outside-feature        | validator rejects a task path outside the active feature directory (but inside the repo) | in-process (real validator) |
// | 7b:task-path-traversal             | validator rejects a `../`-traversal task path escaping the repo entirely; PROVES the wiring: real crash, real corruption, real resume fails closed, escalates via task_snapshot_recovery_failed, preserves the snapshot, launches no relay role, leaves an outside file untouched | full E2E (kept as the one wiring proof) |
// | falsy-snapshot(null)               | the OUTER `Object.hasOwn` gate in autopilot.mjs fires on property PRESENCE, not truthiness — proven with a real crash + real resume (this half cannot be proven in-process; it is autopilot.mjs's own gate, not the validator's) | full E2E (kept as the one wiring proof) |
// | falsy-snapshot(false/zero/empty)   | the validator's own leading `!snapshot \|\| typeof snapshot!=="object"` check rejects every other falsy value the same way | in-process (real validator) |
// ===========================================================================
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {setTaskCheckboxes} from "./speckit-task-state.mjs";
import {validatePendingCheckboxSnapshot} from "./pending-checkbox-snapshot.mjs";
import {
  makeFixtureRepo, makeFixtureBin, makeSpecKitPhaseFixture, makeSpecKitMultiTaskFixture,
  makeSpecKitUnrelatedFeatureFixture, setScenario, writeConfig, runAutopilot, runAutopilotUntilMarker,
  readObservedEvents, cleanup
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
function check(name, condition) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
}

// Per-scenario wall-clock timing (requirement: measure each scenario
// separately, both before and after any restructuring). Purely additive
// instrumentation — wraps a scenario body with no change to its assertions
// or execution order.
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
function saveState(repo, state) {
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(state, null, 2));
}

// ===========================================================================
// Part 1 — unit coverage of scripts/speckit-task-state.mjs
// ===========================================================================
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-t14-unit-"));
  try {
    const file = path.join(dir, "tasks.md");
    const other = path.join(dir, "other.md");
    const content = [
      "## Phase 1: Widgets",
      "",
      "- [ ] Build the widget",
      "- [x] Already done task",
      "  - [ ] Nested-looking indented task",
      "- [ ] Task with ünïcödé and emoji 🎉 <!-- autopilot-requires: browser -->",
      ""
    ].join("\r\n");
    fs.writeFileSync(file, content);
    fs.writeFileSync(other, "unrelated file, must never be touched\n");
    const otherHashBefore = fs.readFileSync(other, "utf8");

    // --- mark one task complete: only that line's checkbox char changes ---
    const t1 = {file, line: 3, text: "Build the widget"};
    const r1 = setTaskCheckboxes([t1], true);
    check("unit: mark single task ok:true", r1.ok === true);
    check("unit: mark single task reports the changed line", r1.changed.length === 1 && r1.changed[0].line === 3);
    const afterMark = fs.readFileSync(file, "utf8");
    check("unit: target line now [x]", afterMark.split("\r\n")[2] === "- [x] Build the widget");
    check("unit: CRLF line endings preserved", afterMark.includes("\r\n") && !/[^\r]\n/.test(afterMark));
    check("unit: unrelated already-done line untouched", afterMark.split("\r\n")[3] === "- [x] Already done task");
    check("unit: indented/nested line untouched", afterMark.split("\r\n")[4] === "  - [ ] Nested-looking indented task");
    check("unit: unrelated file untouched", fs.readFileSync(other, "utf8") === otherHashBefore);

    // --- idempotent re-mark: calling again with the same desired state is a no-op ---
    const beforeSecond = fs.readFileSync(file, "utf8");
    const r2 = setTaskCheckboxes([t1], true);
    check("unit: idempotent re-mark ok:true", r2.ok === true);
    check("unit: idempotent re-mark reports no changes", r2.changed.length === 0);
    check("unit: idempotent re-mark leaves file byte-identical", fs.readFileSync(file, "utf8") === beforeSecond);

    // --- Unicode + inline-requirement-annotated task text survives identity check and marking ---
    const t2 = {file, line: 6, text: "Task with ünïcödé and emoji 🎉"};
    const r3 = setTaskCheckboxes([t2], true);
    check("unit: Unicode-text task identity validated and marked", r3.ok === true && r3.changed.length === 1);
    const afterUnicode = fs.readFileSync(file, "utf8").split("\r\n")[5];
    check("unit: Unicode task line marked, trailing annotation preserved verbatim", afterUnicode === "- [x] Task with ünïcödé and emoji 🎉 <!-- autopilot-requires: browser -->");

    // --- fail closed: text no longer matches the expected task -> no file touched ---
    const beforeMismatch = fs.readFileSync(file, "utf8");
    const badTask = {file, line: 3, text: "This text does not match the real line anymore"};
    const r4 = setTaskCheckboxes([badTask], false);
    check("unit: mismatched task identity returns ok:false", r4.ok === false);
    check("unit: mismatched task identity reports a reason", typeof r4.reason === "string" && r4.reason.length > 0);
    check("unit: mismatched task identity leaves file byte-identical (fail closed)", fs.readFileSync(file, "utf8") === beforeMismatch);

    // --- fail closed across a batch: one bad task blocks the WHOLE call, even good ones ---
    const goodTask = {file, line: 4, text: "Already done task"};
    const beforeBatch = fs.readFileSync(file, "utf8");
    const r5 = setTaskCheckboxes([goodTask, badTask], false);
    check("unit: batch with one mismatch returns ok:false", r5.ok === false);
    check("unit: batch with one mismatch touches NOTHING, not even the valid task", fs.readFileSync(file, "utf8") === beforeBatch);

    // --- unchecking (neutralization) works symmetrically ---
    const r6 = setTaskCheckboxes([t1], false);
    check("unit: uncheck (neutralize) ok:true", r6.ok === true && r6.changed.length === 1);
    check("unit: uncheck sets the checkbox back to [ ]", fs.readFileSync(file, "utf8").split("\r\n")[2] === "- [ ] Build the widget");

    // --- missing file / out-of-range line fail closed too ---
    const r7 = setTaskCheckboxes([{file: path.join(dir, "does-not-exist.md"), line: 1, text: "x"}], true);
    check("unit: missing file fails closed", r7.ok === false);
    const r8 = setTaskCheckboxes([{file, line: 999, text: "x"}], true);
    check("unit: out-of-range line fails closed", r8.ok === false);
  } finally {
    cleanup(dir);
  }
}

// ===========================================================================
// Part 2 — behavioral proof against real autopilot.mjs subprocesses
// ===========================================================================

// --- A + E + F(positive): full multi-phase success marks exactly the right
// tasks, preserves everything else, and only declares the mission complete
// once every task is checked. ---
await scenario("A+E+F(positive): full success", async () => {
  const repo = makeFixtureRepo("t14-success");
  const binDir = makeFixtureBin("t14-success");
  try {
    const featureDir = makeSpecKitMultiTaskFixture(repo);
    const unrelatedDir = makeSpecKitUnrelatedFeatureFixture(repo, "004-unrelated-feature");
    const unrelatedBefore = fs.readFileSync(path.join(unrelatedDir, "tasks.md"), "utf8");
    writeConfig(repo, {planningFramework: "speckit"});
    setScenario(repo, "success");
    const run = runAutopilot(repo, binDir, {request: "implement the multi-task fixture", timeoutMs: MISSION_TIMEOUT_MS});
    check("A: successful mission exits 0", run.status === 0);

    const state = loadState(repo);
    check("A: state reaches phase=complete", state.phase === "complete");
    check("F: mission completion requires step=human_commit", state.step === "human_commit");

    const tasksContent = fs.readFileSync(path.join(featureDir, "tasks.md"), "utf8");
    const lines = tasksContent.split("\r\n");
    check("A: already-complete Phase 1 task left byte-identical (idempotent, untouched)", lines[2] === "- [x] Pre-existing already completed task");
    check("A: Phase 2 first task marked complete", lines[6] === "- [x] Build the first widget");
    check("A: Phase 2 Unicode task marked complete, text preserved exactly", lines[7] === "- [x] Build the wídget with ünïcödé ✅");
    check("A: Phase 3 (later phase) task marked complete once the whole mission succeeds", lines[11] === "- [x] Ship the widgets");
    check("E: CRLF line endings preserved throughout tasks.md", tasksContent.includes("\r\n") && !/[^\r]\n/.test(tasksContent));

    const unrelatedAfter = fs.readFileSync(path.join(unrelatedDir, "tasks.md"), "utf8");
    check("E: unrelated feature's tasks.md is byte-for-byte unchanged", unrelatedAfter === unrelatedBefore);
  } finally {
    cleanup(repo, binDir);
  }
});

// --- F(negative): a later phase's task that never passes Verification
// blocks mission completion, while an earlier phase's genuinely-verified
// task still gets marked. ---
await scenario("F(negative): later-phase permanent verify failure", async () => {
  const repo = makeFixtureRepo("t14-phase-fail");
  const binDir = makeFixtureBin("t14-phase-fail");
  try {
    const featureDir = makeSpecKitMultiTaskFixture(repo);
    writeConfig(repo, {planningFramework: "speckit", failureBudgets: {verificationFailureBudget: 1}});
    setScenario(repo, "task14_phase_verify_fail");
    const run = runAutopilot(repo, binDir, {request: "implement the multi-task fixture", timeoutMs: MISSION_TIMEOUT_MS});
    check("F: mission with a permanently-failing later phase does NOT exit 0", run.status !== 0);

    const state = loadState(repo);
    check("F: mission never reaches phase=complete", state.phase !== "complete");
    check("F: mission never reaches step=human_commit", state.step !== "human_commit");

    const lines = fs.readFileSync(path.join(featureDir, "tasks.md"), "utf8").split("\r\n");
    check("F: earlier Phase 2 tasks (which DID pass verification) are marked complete", lines[6] === "- [x] Build the first widget" && lines[7] === "- [x] Build the wídget with ünïcödé ✅");
    check("F: later Phase 3 task (which never passes verification) remains unchecked", lines[11] === "- [ ] Ship the widgets");
  } finally {
    cleanup(repo, binDir);
  }
});

// --- B: Code Review failure leaves tasks unchecked; only a genuinely
// successful later attempt marks them. ---
await scenario("B: code-review failure blocks marking", async () => {
  const repo = makeFixtureRepo("t14-review-fail");
  const binDir = makeFixtureBin("t14-review-fail");
  try {
    makeSpecKitPhaseFixture(repo);
    const featureFile = path.join(repo, "specs", "001-fixture-feature", "tasks.md");
    writeConfig(repo, {planningFramework: "speckit", failureBudgets: {implementationFailureBudget: 1}});
    setScenario(repo, "task14_review_always_fail");
    const failedRun = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: MISSION_TIMEOUT_MS});
    check("B: permanently-failing Code Review does NOT exit 0", failedRun.status !== 0);
    check("B: mission escalates rather than completing", loadState(repo).phase === "escalated");
    check("B: task remains unchecked after Code Review failure", fs.readFileSync(featureFile, "utf8").includes("- [ ] Do the fixture task"));

    setScenario(repo, "success");
    const resumed = runAutopilot(repo, binDir, {request: "", timeoutMs: MISSION_TIMEOUT_MS});
    check("B: resumed mission (Code Review now passes) exits 0", resumed.status === 0);
    check("B: task becomes [x] only after the genuinely successful attempt", fs.readFileSync(featureFile, "utf8").includes("- [x] Do the fixture task"));
    check("B: mission reaches phase=complete after resume", loadState(repo).phase === "complete");
  } finally {
    cleanup(repo, binDir);
  }
});

// --- C: Verification failure leaves tasks unchecked; only a genuinely
// successful later attempt marks them. ---
await scenario("C: verification failure blocks marking", async () => {
  const repo = makeFixtureRepo("t14-verify-fail");
  const binDir = makeFixtureBin("t14-verify-fail");
  try {
    makeSpecKitPhaseFixture(repo);
    const featureFile = path.join(repo, "specs", "001-fixture-feature", "tasks.md");
    writeConfig(repo, {planningFramework: "speckit", failureBudgets: {verificationFailureBudget: 1}});
    setScenario(repo, "task14_verify_always_fail");
    const failedRun = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: MISSION_TIMEOUT_MS});
    check("C: permanently-failing Verifier does NOT exit 0", failedRun.status !== 0);
    check("C: mission escalates rather than completing", loadState(repo).phase === "escalated");
    check("C: task remains unchecked after Verification failure (Code Review PASSed)", fs.readFileSync(featureFile, "utf8").includes("- [ ] Do the fixture task"));

    setScenario(repo, "success");
    const resumed = runAutopilot(repo, binDir, {request: "", timeoutMs: MISSION_TIMEOUT_MS});
    check("C: resumed mission (Verification now passes) exits 0", resumed.status === 0);
    check("C: task becomes [x] only after the genuinely successful attempt", fs.readFileSync(featureFile, "utf8").includes("- [x] Do the fixture task"));
  } finally {
    cleanup(repo, binDir);
  }
});

// --- D: a premature Implementer checkbox edit is neutralized; a
// failed/rejected attempt leaves the task unchecked despite the
// Implementer's repeated tampering; resume does not skip it; only genuine
// success (via Autopilot itself) marks it. ---
await scenario("D: premature marking neutralized", async () => {
  const repo = makeFixtureRepo("t14-premature");
  const binDir = makeFixtureBin("t14-premature");
  try {
    makeSpecKitPhaseFixture(repo);
    const featureFile = path.join(repo, "specs", "001-fixture-feature", "tasks.md");
    writeConfig(repo, {planningFramework: "speckit", failureBudgets: {implementationFailureBudget: 1}});
    setScenario(repo, "task14_premature_checkbox_fail");
    const failedRun = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: MISSION_TIMEOUT_MS});
    check("D: mission with a premature-marking Implementer + always-failing review does NOT exit 0", failedRun.status !== 0);
    check("D: mission escalates rather than completing", loadState(repo).phase === "escalated");
    check(
      "D: despite the Implementer repeatedly marking it [x], the task is unchecked after Code Review never passes",
      fs.readFileSync(featureFile, "utf8").includes("- [ ] Do the fixture task")
    );

    setScenario(repo, "success");
    const resumed = runAutopilot(repo, binDir, {request: "", timeoutMs: MISSION_TIMEOUT_MS});
    check("D: resume does not skip the never-completed phase — it actually re-attempts and succeeds", resumed.status === 0);
    check("D: after genuine success, Autopilot itself marks the task [x]", fs.readFileSync(featureFile, "utf8").includes("- [x] Do the fixture task"));
    check("D: mission reaches phase=complete only after genuine success", loadState(repo).phase === "complete");
  } finally {
    cleanup(repo, binDir);
  }
});

// ===========================================================================
// Part 3 — TASK 14 CORRECTION: a disobedient Implementer poisoning a
// FUTURE phase's checkboxes (not just the current phase's) must never
// survive a Code Review failure, a policy violation, or a process crash —
// proven with the feature-wide pendingCheckboxSnapshot/reconcile added to
// scripts/autopilot.mjs and scripts/speckit-task-state.mjs's
// applyTaskCheckboxStates().
// ===========================================================================

// --- A(correction): future-phase poisoning. A disobedient Implementer
// marks BOTH the current phase's tasks AND a later, not-yet-reached
// phase's tasks. Code Review permanently fails. Both current and future
// tasks must be unchecked afterward. Resume (Code Review now passes) must
// genuinely execute the later phase — not skip it because its checkbox was
// once poisoned — and only THEN mark it. ---
await scenario("A(correction): future-phase poisoning neutralized", async () => {
  const repo = makeFixtureRepo("t14c-future-poison");
  const binDir = makeFixtureBin("t14c-future-poison");
  try {
    const featureDir = makeSpecKitMultiTaskFixture(repo);
    writeConfig(repo, {planningFramework: "speckit", failureBudgets: {implementationFailureBudget: 1}});
    setScenario(repo, "task14_premature_checkbox_fail");
    const failedRun = runAutopilot(repo, binDir, {request: "implement the multi-task fixture", timeoutMs: MISSION_TIMEOUT_MS});
    check("A(correction): mission with a future-phase-poisoning Implementer + always-failing review does NOT exit 0", failedRun.status !== 0);
    check("A(correction): mission escalates rather than completing", loadState(repo).phase === "escalated");

    const linesAfterFailure = fs.readFileSync(path.join(featureDir, "tasks.md"), "utf8").split("\r\n");
    check("A(correction): current Phase 2 tasks remain unchecked after Code Review failure", linesAfterFailure[6] === "- [ ] Build the first widget" && linesAfterFailure[7] === "- [ ] Build the wídget with ünïcödé ✅");
    check("A(correction): FUTURE Phase 3 task also remains unchecked despite the Implementer poisoning it", linesAfterFailure[11] === "- [ ] Ship the widgets");
    check("A(correction): the already-legitimately-complete Phase 1 task is untouched", linesAfterFailure[2] === "- [x] Pre-existing already completed task");

    setScenario(repo, "success");
    const resumed = runAutopilot(repo, binDir, {request: "", timeoutMs: MISSION_TIMEOUT_MS});
    check("A(correction): resumed mission (Code Review now passes) exits 0", resumed.status === 0);
    check("A(correction): mission reaches phase=complete after resume", loadState(repo).phase === "complete");

    const linesAfterResume = fs.readFileSync(path.join(featureDir, "tasks.md"), "utf8").split("\r\n");
    check("A(correction): Phase 2 tasks are now genuinely marked [x]", linesAfterResume[6] === "- [x] Build the first widget" && linesAfterResume[7] === "- [x] Build the wídget with ünïcödé ✅");
    check("A(correction): Phase 3 (the previously-poisoned future phase) is now genuinely marked [x]", linesAfterResume[11] === "- [x] Ship the widgets");

    // Not skipped: a genuinely-executed phase means a REAL verifier PASS
    // was observed for it, not just a checkbox flip. Two DISTINCT phases
    // (2 and 3) each successfully completing means at least two verifier
    // PASS events exist across this repo's whole run history.
    const verifierPasses = readObservedEvents(repo).filter(e => e.role === "verifier" && e.decision === "PASS");
    check("A(correction): at least two DISTINCT phases were genuinely verified (Phase 3 was executed for real, not skipped)", verifierPasses.length >= 2);
  } finally {
    cleanup(repo, binDir);
  }
});

// --- B(correction): a disobedient Implementer marks checkboxes (current
// AND future) AND triggers a real, detected Git policy violation in the
// SAME attempt. Reconciliation must still run and clear the poisoned
// checkboxes BEFORE the policy-violation check causes the mission to die,
// so no task — current or future — is left checked. ---
await scenario("B(correction): reconciliation before policy-violation death", async () => {
  const repo = makeFixtureRepo("t14c-policy-violation");
  const binDir = makeFixtureBin("t14c-policy-violation");
  try {
    const featureDir = makeSpecKitMultiTaskFixture(repo);
    writeConfig(repo, {planningFramework: "speckit"});
    setScenario(repo, "task14_policy_violation_with_marking");
    const run = runAutopilot(repo, binDir, {request: "implement the multi-task fixture", timeoutMs: MISSION_TIMEOUT_MS});
    check("B(correction): mission with a policy-violating, checkbox-marking Implementer does NOT exit 0", run.status !== 0);

    const state = loadState(repo);
    check("B(correction): mission escalates via relay_policy_violation, not silent success", state.phase === "escalated" && state.step === "relay_policy_violation");
    check("B(correction): the pending checkbox snapshot was cleared (reconciliation completed) even though the mission then died", !state.pendingCheckboxSnapshot);

    const lines = fs.readFileSync(path.join(featureDir, "tasks.md"), "utf8").split("\r\n");
    check("B(correction): current Phase 2 tasks remain unchecked after the policy violation", lines[6] === "- [ ] Build the first widget" && lines[7] === "- [ ] Build the wídget with ünïcödé ✅");
    check("B(correction): FUTURE Phase 3 task also remains unchecked after the policy violation", lines[11] === "- [ ] Ship the widgets");
    check("B(correction): the already-legitimately-complete Phase 1 task is untouched", lines[2] === "- [x] Pre-existing already completed task");
  } finally {
    cleanup(repo, binDir);
  }
});

// --- C(correction)+10 (DUPLICATE-WORKFLOW MERGE — see coverage map):
// crash/resume, valid case. The Implementer writes a premature checkbox
// edit, then the real `autopilot.mjs` process is killed (SIGKILL) BEFORE it
// gets to run its normal post-relay reconciliation. On resume, with no
// manual edits to state.json or tasks.md, the pending snapshot Autopilot
// itself persisted before the crash must be reconciled automatically, and
// no phase may be skipped as a result of the crash. This scenario was
// originally duplicated as a separate "10:valid-resume" scenario further
// below, driving the IDENTICAL crash fixture a second time purely to prove
// TASK 14 CORRECTION 2's fail-closed gate doesn't also reject a genuinely
// valid, uncorrupted snapshot — merged here (one crash+resume subprocess
// pair instead of two); every assertion from both original scenarios is
// still present below. ---
await scenario("C(correction)+10: real crash + valid resume reconciliation", async () => {
  const repo = makeFixtureRepo("t14c-crash-resume");
  const binDir = makeFixtureBin("t14c-crash-resume");
  try {
    const featureDir = makeSpecKitMultiTaskFixture(repo);
    writeConfig(repo, {planningFramework: "speckit"});
    setScenario(repo, "task14_crash_before_reconcile");
    const marker = path.join(repo, ".autopilot-test-crash-marker");
    const killed = await runAutopilotUntilMarker(repo, binDir, {request: "implement the multi-task fixture", markerFile: marker, timeoutMs: MARKER_WAIT_TIMEOUT_MS});
    check("C(correction): the marker was observed (the Implementer reached the crash point)", killed.markerObserved);
    check("C(correction): the real autopilot.mjs process was actually killed before it could reconcile", killed.killed);

    const stateAfterCrash = loadState(repo);
    check("C(correction): a pending checkbox snapshot survived the crash, persisted before the Implementer ran", Array.isArray(stateAfterCrash.pendingCheckboxSnapshot?.tasks) && stateAfterCrash.pendingCheckboxSnapshot.tasks.length > 0);
    check("10:valid-resume: the pending snapshot is well-formed and correctly bound (feature+mission identity present)",
      typeof stateAfterCrash.pendingCheckboxSnapshot.feature !== "undefined" && typeof stateAfterCrash.pendingCheckboxSnapshot.mission === "string");

    const linesRightAfterCrash = fs.readFileSync(path.join(featureDir, "tasks.md"), "utf8").split("\r\n");
    check("C(correction): tasks.md shows the RAW poisoned state right after the crash (proves reconciliation genuinely never ran in that process)",
      linesRightAfterCrash[6] === "- [x] Build the first widget" && linesRightAfterCrash[11] === "- [x] Ship the widgets");

    setScenario(repo, "success");
    const resumed = runAutopilot(repo, binDir, {request: "", timeoutMs: MISSION_TIMEOUT_MS});
    check("C(correction): resumed mission exits 0 with no manual repair", resumed.status === 0);
    check("C(correction): the pending snapshot was reconciled and cleared on resume", !loadState(repo).pendingCheckboxSnapshot);
    check("10:valid-resume: mission reaches phase=complete with step=human_commit", loadState(repo).phase === "complete" && loadState(repo).step === "human_commit");

    const linesAfterResume = fs.readFileSync(path.join(featureDir, "tasks.md"), "utf8").split("\r\n");
    check("C(correction): Phase 2 and Phase 3 both end up genuinely [x] after resume", linesAfterResume[6] === "- [x] Build the first widget" && linesAfterResume[11] === "- [x] Ship the widgets");
    check("10:valid-resume: the already-legitimately-complete Phase 1 task is untouched", linesAfterResume[2] === "- [x] Pre-existing already completed task");

    // Not skipped: at least two distinct phases (2 and 3) must each have
    // been genuinely verified after resume, not fast-forwarded past
    // because their checkbox already read "[x]" from the crash artifact.
    const verifierPasses = readObservedEvents(repo).filter(e => e.role === "verifier" && e.decision === "PASS");
    check("C(correction): at least two DISTINCT phases were genuinely verified after resume (no phase was skipped)", verifierPasses.length >= 2);
  } finally {
    cleanup(repo, binDir);
  }
});

// --- D(correction): ordering, proven by real observation rather than
// prompt text. Code Reviewer and Verifier each independently read the
// REAL tasks.md content at the moment they run and FAIL if they ever see
// the task already checked. In correct behavior neither ever does, so a
// clean PASS-only run is itself the proof that both roles observed the
// task unchecked, and that marking only happens after Verifier PASS. ---
await scenario("D(correction): observed ordering, no premature checkbox visibility", async () => {
  const repo = makeFixtureRepo("t14c-ordering");
  const binDir = makeFixtureBin("t14c-ordering");
  try {
    makeSpecKitPhaseFixture(repo);
    const featureFile = path.join(repo, "specs", "001-fixture-feature", "tasks.md");
    writeConfig(repo, {planningFramework: "speckit"});
    setScenario(repo, "task14_observe_unchecked");
    const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: MISSION_TIMEOUT_MS});
    check("D(correction): mission exits 0", run.status === 0);

    const events = readObservedEvents(repo);
    check("D(correction): Code Reviewer never observed the task already checked (no FAIL decision at all)", !events.some(e => e.role === "code_reviewer" && e.decision === "FAIL"));
    check("D(correction): Verifier never observed the task already checked (no FAIL decision at all)", !events.some(e => e.role === "verifier" && e.decision === "FAIL"));
    check("D(correction): a real Code Reviewer PASS was observed", events.some(e => e.role === "code_reviewer" && e.decision === "PASS"));
    check("D(correction): a real Verifier PASS was observed", events.some(e => e.role === "verifier" && e.decision === "PASS"));
    check("D(correction): the task ends up [x] only once the whole (observably clean) mission succeeded", fs.readFileSync(featureFile, "utf8").includes("- [x] Do the fixture task"));
  } finally {
    cleanup(repo, binDir);
  }
});

// ===========================================================================
// Part 4 — TASK 14 CORRECTION 2: the pending checkbox snapshot recovery
// path must FAIL CLOSED whenever the persisted snapshot is invalid,
// malformed, or bound to a different feature/mission than the one active
// right now — never silently ignore it and trust whatever is on disk
// (which is exactly the original fail-open bug: it let poisoned "[x]"
// values survive a crash and reach a false "ALL WORK COMPLETE").
//
// Split in two, by what each half actually needs a real subprocess to
// prove:
//
// - ONE full E2E scenario (7b, below) reproduces a REAL interrupted process
//   (the task14_crash_before_reconcile marker+sleep fixture) to get a
//   genuine, correctly-shaped pending snapshot on disk, corrupts it exactly
//   the way an attacker/bug would, and resumes with a real subprocess —
//   proving Autopilot's OWN recovery code at scripts/autopilot.mjs actually
//   calls the validator at the right point and honors its verdict (fails
//   closed, escalates via task_snapshot_recovery_failed, preserves the
//   invalid snapshot, launches no relay role). One corruption shape
//   suffices to prove this wiring; the wiring itself does not vary by shape.
// - The remaining corruption shapes (1-7) are pure value variants of the
//   SAME validator's OWN internal logic (scripts/pending-checkbox-snapshot.mjs,
//   extracted verbatim from autopilot.mjs with no behavior change — see
//   that file's header). That function does zero filesystem/process I/O,
//   so each shape is proven in-process, synchronously, directly against the
//   real production function — not a reimplementation, not a source-string
//   check. This is the "convert corruption cases into data-driven,
//   in-process tests using real production functions" half of the
//   optimization; see the coverage map at the top of this file for exactly
//   which original scenario each in-process case replaces.
// ===========================================================================

async function setupCrashedSnapshot(prefix) {
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  const featureDir = makeSpecKitMultiTaskFixture(repo);
  writeConfig(repo, {planningFramework: "speckit"});
  setScenario(repo, "task14_crash_before_reconcile");
  const marker = path.join(repo, ".autopilot-test-crash-marker");
  const killed = await runAutopilotUntilMarker(repo, binDir, {request: "implement the multi-task fixture", markerFile: marker, timeoutMs: MARKER_WAIT_TIMEOUT_MS});
  return {repo, binDir, featureDir, killed};
}

// Runs the "corrupt the pending snapshot, then try to resume" shape via a
// REAL crash+resume subprocess pair: crash for real, apply `corrupt(state)`
// to the persisted state.json in place, switch the scenario to "success"
// (so nothing BUT the recovery gate itself could cause a failure), attempt
// a real resume, and assert the universal fail-closed contract. Kept for
// exactly one corruption shape (7b, the E2E wiring proof) — the other
// shapes are covered in-process, directly against the real validator (see
// the coverage map at the top of this file).
async function expectRecoveryRejects(name, prefix, corrupt) {
  const t0 = Date.now();
  const {repo, binDir, featureDir, killed} = await setupCrashedSnapshot(prefix);
  try {
    check(`${name}: the crash marker was observed (setup reached the intended interruption point)`, killed.markerObserved && killed.killed);
    const stateAfterCrash = loadState(repo);
    check(`${name}: setup produced a real, well-formed pending snapshot before corruption`, Array.isArray(stateAfterCrash.pendingCheckboxSnapshot?.tasks) && stateAfterCrash.pendingCheckboxSnapshot.tasks.length > 0);
    const eventsBefore = readObservedEvents(repo).length;
    const outsideFile = path.join(repo, "outside-secret.txt");
    fs.writeFileSync(outsideFile, "must never be touched\n");
    const outsideBefore = fs.readFileSync(outsideFile, "utf8");

    corrupt(stateAfterCrash, {repo, featureDir});
    saveState(repo, stateAfterCrash);

    setScenario(repo, "success");
    const resumed = runAutopilot(repo, binDir, {request: "", timeoutMs: MISSION_TIMEOUT_MS});
    check(`${name}: resume with a corrupted pending snapshot exits nonzero (fails closed)`, resumed.status !== 0);

    const stateAfterResume = loadState(repo);
    check(`${name}: mission escalates via task_snapshot_recovery_failed`, stateAfterResume.phase === "escalated" && stateAfterResume.step === "task_snapshot_recovery_failed");
    check(`${name}: the invalid snapshot is preserved, never silently deleted`, stateAfterResume.pendingCheckboxSnapshot != null);
    check(`${name}: never reaches phase=complete / step=human_commit`, stateAfterResume.phase !== "complete" && stateAfterResume.step !== "human_commit");

    const eventsAfter = readObservedEvents(repo).length;
    check(`${name}: invalid recovery launched NO role (Implementer/Code Reviewer/Verifier/final review) — no new relay events at all`, eventsAfter === eventsBefore);
    check(`${name}: a file outside the active feature named by the (possibly-tampered) snapshot is untouched`, fs.readFileSync(outsideFile, "utf8") === outsideBefore);
  } finally {
    cleanup(repo, binDir);
    console.log(`[timing] ${name}: ${Date.now() - t0}ms`);
  }
}

// Full E2E wiring proof (real crash, real corruption, real resume) — the
// most security-relevant shape (a real path-traversal attack string), and
// the only one of the eight original corruption scenarios kept as a real
// subprocess pair. See the coverage map for why one shape suffices here.
await expectRecoveryRejects("7b:task-path-traversal", "t14c2-path-traversal", (state, {featureDir}) => {
  state.pendingCheckboxSnapshot.tasks[0].file = path.join(featureDir, "..", "..", "..", "outside-secret.txt");
});

// In-process, data-driven coverage for the other seven corruption shapes
// (scenarios 1-7 from the original file) — the real production validator
// (scripts/pending-checkbox-snapshot.mjs's validatePendingCheckboxSnapshot,
// extracted from autopilot.mjs with no behavior change), called directly
// with a synthetic-but-realistic snapshot. No subprocess, no real crash: the
// validator's own contract is pure (no fs/process I/O — confirmed by
// reading its source), so this is genuine coverage of the real function,
// not a reimplementation or a source-string assertion.
{
  const t0 = Date.now();
  const VALIDATE_REPO = path.resolve(os.tmpdir(), "ap-t14-validate-fixture");
  const VALIDATE_FEATURE = "specs/003-multi-task-feature";
  const VALIDATE_MISSION = "003-multi-task-feature";
  function validSnapshot() {
    return {
      capturedAt: "2026-01-01T00:00:00.000Z",
      feature: VALIDATE_FEATURE,
      mission: VALIDATE_MISSION,
      tasks: [{file: path.join(VALIDATE_REPO, VALIDATE_FEATURE, "tasks.md"), line: 6, text: "Build the first widget", done: true}]
    };
  }

  // Positive control: the fixture itself must be genuinely well-formed, or
  // every rejection below would be meaningless (rejected for the wrong
  // reason, or by coincidence).
  check("in-process baseline: a genuinely well-formed snapshot validates ok", validatePendingCheckboxSnapshot(validSnapshot(), VALIDATE_FEATURE, VALIDATE_MISSION, VALIDATE_REPO).ok === true);

  const cases = [
    {name: "1:tasks-is-string", mutate: s => { s.tasks = "not-an-array"; }, reasonIncludes: "tasks is not a non-empty array"},
    {name: "2:tasks-empty", mutate: s => { s.tasks = []; }, reasonIncludes: "tasks is not a non-empty array"},
    {name: "3:malformed-task-entry", mutate: s => { s.tasks[0] = {file: 123, line: "not-a-number", text: "", done: "yes"}; }, reasonIncludes: "invalid file"},
    {name: "4:missing-feature-identity", mutate: s => { delete s.feature; }, reasonIncludes: "missing a valid feature identity"},
    {name: "6:mission-mismatch", mutate: () => {}, missionOverride: "999-a-completely-different-mission", reasonIncludes: "mission mismatch"},
    {name: "7:task-path-outside-feature", mutate: s => { s.tasks[0].file = path.join(VALIDATE_REPO, "outside-secret.txt"); }, reasonIncludes: "escapes the active feature"}
  ];
  for (const {name, mutate, reasonIncludes, missionOverride} of cases) {
    const snapshot = validSnapshot();
    mutate(snapshot);
    const result = validatePendingCheckboxSnapshot(snapshot, VALIDATE_FEATURE, missionOverride || VALIDATE_MISSION, VALIDATE_REPO);
    check(`${name}: the real validator rejects it (ok:false)`, result.ok === false);
    check(`${name}: the rejection reason names the actual defect ("${reasonIncludes}")`, typeof result.reason === "string" && result.reason.includes(reasonIncludes));
  }

  // 5:feature-mismatch — the original scenario corrupts the ACTIVE feature
  // identity (.specify/feature.json), not the snapshot itself; simulated
  // here by passing a currentFeatureDir that disagrees with a valid
  // snapshot's own (unmodified) feature.
  {
    const snapshot = validSnapshot();
    const result = validatePendingCheckboxSnapshot(snapshot, "specs/999-different-feature", VALIDATE_MISSION, VALIDATE_REPO);
    check("5:feature-mismatch: the real validator rejects it (ok:false)", result.ok === false);
    check("5:feature-mismatch: the rejection reason names a feature mismatch", typeof result.reason === "string" && result.reason.includes("feature mismatch"));
  }
  console.log(`[timing] in-process corruption-shape checks (1,2,3,4,5,6,7): ${Date.now() - t0}ms`);
}

// ===========================================================================
// Part 5 — TASK 14 CORRECTION 3: the recovery gate must trigger on
// PROPERTY PRESENCE, not truthiness. `false`/`null`/`0`/`""` are all
// legitimate JSON values a corrupted state.json could hold for
// pendingCheckboxSnapshot, and `if (s.pendingCheckboxSnapshot)` treats
// every one of them as "nothing pending" — skipping validation entirely
// and trusting whatever poisoned checkboxes an interrupted Implementer
// left on disk.
//
// This invariant has two genuinely separate halves (see
// scripts/autopilot.mjs's own comment right above its
// `Object.hasOwn(s,"pendingCheckboxSnapshot")` gate): (1) the OUTER gate in
// autopilot.mjs must key off property PRESENCE, not truthiness — logic that
// lives in autopilot.mjs itself, not in the extracted validator, so it can
// only be proven by a real subprocess; (2) the validator's OWN leading
// `!snapshot || typeof snapshot!=="object"` check must then reject every
// falsy value it's handed. Half (1) is value-agnostic (Object.hasOwn does
// not inspect the value at all), so ONE real falsy value (null, the most
// realistic real-world corruption) proves it for all four; half (2) is
// proven for the other three values in-process, directly against the real
// validator, immediately below.
// ===========================================================================

const FALSY_SNAPSHOT_CASES = [
  {label: "null", value: null}
];

// In-process coverage for the other three falsy shapes (false/zero/empty-
// string) — the real validator's own leading type check, called directly.
{
  const t0 = Date.now();
  const VALIDATE_REPO = path.resolve(os.tmpdir(), "ap-t14-validate-fixture");
  const VALIDATE_FEATURE = "specs/003-multi-task-feature";
  const VALIDATE_MISSION = "003-multi-task-feature";
  for (const {label, value} of [{label: "false", value: false}, {label: "zero", value: 0}, {label: "empty-string", value: ""}]) {
    const result = validatePendingCheckboxSnapshot(value, VALIDATE_FEATURE, VALIDATE_MISSION, VALIDATE_REPO);
    check(`in-process falsy-snapshot(${label}): the real validator rejects it (ok:false)`, result.ok === false);
    check(`in-process falsy-snapshot(${label}): rejected by the exact leading check a falsy value hits ("is not an object")`, result.reason === "pending checkbox snapshot is not an object");
  }
  console.log(`[timing] in-process falsy-snapshot checks (false, zero, empty-string): ${Date.now() - t0}ms`);
}

for (const {label, value} of FALSY_SNAPSHOT_CASES) {
  const name = `falsy-snapshot(${label})`;
  const t0 = Date.now();
  const {repo, binDir, featureDir, killed} = await setupCrashedSnapshot(`t14c3-${label}`);
  try {
    check(`${name}: the crash marker was observed (setup reached the intended interruption point)`, killed.markerObserved && killed.killed);
    const stateAfterCrash = loadState(repo);
    check(`${name}: setup produced a real, well-formed pending snapshot before corruption`, Array.isArray(stateAfterCrash.pendingCheckboxSnapshot?.tasks) && stateAfterCrash.pendingCheckboxSnapshot.tasks.length > 0);
    const eventsBefore = readObservedEvents(repo).length;

    // tasks.md right now holds the RAW poisoned state (every checkbox in
    // every phase forced to "[x]" by the crash-scenario Implementer,
    // before this process ever got to reconcile) — captured so we can
    // prove afterward it was never trusted as genuinely-completed work.
    const poisonedLines = fs.readFileSync(path.join(featureDir, "tasks.md"), "utf8").split("\r\n");
    check(`${name}: tasks.md shows the raw poisoned (all-checked) state right after the crash`, poisonedLines[6] === "- [x] Build the first widget" && poisonedLines[11] === "- [x] Ship the widgets");

    // Replace the whole property with the falsy value under test — this
    // is the exact shape a corrupted/hand-edited state.json would have,
    // property present, value falsy — not a missing key.
    stateAfterCrash.pendingCheckboxSnapshot = value;
    saveState(repo, stateAfterCrash);
    check(`${name}: the property is present in state.json (not absent) right before resume`, Object.hasOwn(loadState(repo), "pendingCheckboxSnapshot"));

    setScenario(repo, "success");
    const resumed = runAutopilot(repo, binDir, {request: "", timeoutMs: MISSION_TIMEOUT_MS});
    check(`${name}: resume exits nonzero (fails closed instead of trusting the falsy value as \"nothing pending\")`, resumed.status !== 0);

    const stateAfterResume = loadState(repo);
    check(`${name}: mission escalates via task_snapshot_recovery_failed`, stateAfterResume.phase === "escalated" && stateAfterResume.step === "task_snapshot_recovery_failed");
    check(`${name}: the property still exists in state.json`, Object.hasOwn(stateAfterResume, "pendingCheckboxSnapshot"));
    check(`${name}: the EXACT falsy value is preserved, unchanged`, Object.is(stateAfterResume.pendingCheckboxSnapshot, value));
    check(`${name}: never reaches phase=complete / step=human_commit`, stateAfterResume.phase !== "complete" && stateAfterResume.step !== "human_commit");

    const eventsAfter = readObservedEvents(repo).length;
    check(`${name}: invalid recovery launched NO role (Implementer/Code Reviewer/Verifier/final review) — no new relay events at all`, eventsAfter === eventsBefore);

    const linesAfterFailedResume = fs.readFileSync(path.join(featureDir, "tasks.md"), "utf8").split("\r\n");
    check(`${name}: tasks.md is untouched by the failed resume (still exactly the pre-resume content, poisoned or not — never further mutated)`, linesAfterFailedResume.join("\r\n") === poisonedLines.join("\r\n"));
  } finally {
    cleanup(repo, binDir);
    console.log(`[timing] ${name}: ${Date.now() - t0}ms`);
  }
}

if (failures) {
  console.error(`${failures} TASK 14 check(s) failed.`);
  process.exit(1);
}
console.log("TASK 14 SpecKit task-checkbox synchronization test passed");
