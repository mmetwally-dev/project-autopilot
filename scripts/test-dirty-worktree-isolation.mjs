#!/usr/bin/env node
// TASK 13 / Problem B (+ correction pass) end-to-end behavioral proof: a
// real SpecKit implementation/review mission, run against a repository that
// already had unrelated dirty state BEFORE the mission started (a modified
// tracked file, a deleted tracked file, a staged change, and an untracked
// file — exactly the real observed shape), must never let Code Reviewer,
// Verifier, or the final SpecKit review see that pre-existing dirt; and two
// distinct missions in the same repository must never share a baseline.
//
// Correction-pass methodology change (requirement E): reviewer behavior is
// proven via OBSERVABLE PASS/FAIL DECISIONS from the fake code_reviewer/
// verifier, never by inspecting prompt prose out of band. Pre-existing
// dirty content is seeded with a literal "FORBIDDEN_BASELINE_MARKER" token;
// scripts/test-fixtures/fake-workflow-adapter.sh FAILs any reviewer/
// verifier call whose scoped-delta section (extracted using ONLY the
// stable, minimal prompt-contract delimiters scripts/implementation-
// baseline.mjs defines — never surrounding prose) contains that token. A
// PASS is therefore direct, observable proof the forbidden pre-existing
// content was excluded; if it had leaked, the mission would have failed.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {makeFixtureRepo, makeFixtureBin, makeSpecKitPhaseFixture, setScenario, writeConfig, runAutopilot, readObservedEvents, cleanup, withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import {scopedDelta, sanitizeKeySegment} from "./implementation-baseline.mjs";

// Each full mission below is a real 7-phase SpecKit run where every
// read-only role (plan_reviewer/code_reviewer/verifier) launches inside the
// Windows disposable-copy compatibility bridge — a real, full filesystem
// copy of the repository per invocation, not a bind-mount — which costs
// materially more wall-clock time than WSL2's bubblewrap (see
// test-windows-disposable-plan-reviewer.mjs's own 220000ms budget for a
// single such mission). 90000ms is enough on Linux/WSL2; native Windows
// needs the same order-of-magnitude headroom as that established sibling.
const MISSION_TIMEOUT_MS = process.platform === "win32" ? 220000 : 90000;

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${detail ? " -- " + detail : ""}`); }
}

function git(cwd, args) {
  const r = spawnSync("git", args, {cwd, encoding: "utf8", env: withoutOuterGitGuard(process.env), shell: false});
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout || "").trim();
}

const FORBIDDEN = "FORBIDDEN_BASELINE_MARKER";

// Seeds exactly the real observed pre-existing dirty shape: a modified
// tracked file, a deleted tracked file, a staged change, and an unrelated
// untracked file — all dirty BEFORE the mission is ever run. The FORBIDDEN
// token is seeded ONLY into the three files no scenario in this suite ever
// touches (deleted/staged/untracked) so any leak of THEIR content into a
// reviewer's scoped delta flips that reviewer's decision to FAIL (see
// fake-workflow-adapter.sh). existing-modified.txt deliberately does NOT
// carry the token: the "real change" scenario legitimately appends to that
// file, so its ORIGINAL line correctly reappears as ordinary unified-diff
// CONTEXT around the new addition — that is not a leak, and marking it
// forbidden would make a genuine, correctly-scoped diff look like one.
function seedDirtyWorktree(repo) {
  fs.writeFileSync(path.join(repo, "existing-modified.txt"), "committed\n");
  fs.writeFileSync(path.join(repo, "existing-deleted.txt"), "to be deleted\n");
  fs.writeFileSync(path.join(repo, "existing-staged.txt"), "committed\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "seed pre-existing tracked files"]);

  fs.writeFileSync(path.join(repo, "existing-modified.txt"), "committed\nmodified-before-mission\n");
  fs.unlinkSync(path.join(repo, "existing-deleted.txt"));
  fs.writeFileSync(path.join(repo, "existing-staged.txt"), `committed\n${FORBIDDEN}_staged\n`);
  git(repo, ["add", "existing-staged.txt"]);
  fs.writeFileSync(path.join(repo, "existing-untracked.txt"), `${FORBIDDEN}_untracked\n`);
}

function listBaselineKeys(repo) {
  const root = path.join(repo, ".autopilot", "baseline");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, {withFileTypes: true}).filter(e => e.isDirectory()).map(e => e.name).sort();
}
function readManifest(repo, key) {
  const p = path.join(repo, ".autopilot", "baseline", key, "manifest.json");
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
}

// ===========================================================================
// 1. A phase with ZERO implementation changes on a dirty worktree seeded
//    with the FORBIDDEN marker: Code Review/Verifier must still PASS (an
//    observable decision proving no forbidden pre-existing content leaked
//    into their scoped delta), pre-existing dirt must remain byte-for-byte
//    untouched, and the real scopedDelta() for the phase must be empty.
// ===========================================================================
{
  const repo = makeFixtureRepo("dirty-zero-change");
  const binDir = makeFixtureBin("dirty-zero-change");
  try {
    makeSpecKitPhaseFixture(repo);
    writeConfig(repo, {planningFramework: "speckit"});
    setScenario(repo, "dirty_worktree_zero_change");
    seedDirtyWorktree(repo);

    const before = {
      modified: fs.readFileSync(path.join(repo, "existing-modified.txt")),
      staged: fs.readFileSync(path.join(repo, "existing-staged.txt")),
      untracked: fs.readFileSync(path.join(repo, "existing-untracked.txt"))
    };

    const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: MISSION_TIMEOUT_MS});
    const events = readObservedEvents(repo);

    check("zero-change: mission completed (exit 0)", run.status === 0, `stderr=${run.stderr.slice(-800)}`);
    check("zero-change: code_reviewer PASSed (observable proof no forbidden marker leaked)", events.some(e => e.role === "code_reviewer" && e.decision === "PASS"));
    check("zero-change: verifier PASSed (observable proof no forbidden marker leaked)", events.some(e => e.role === "verifier" && e.decision === "PASS"));
    check("zero-change: no relay call FAILed due to the forbidden marker", !events.some(e => e.decision === "FAIL"));

    check("zero-change: existing-modified.txt is byte-for-byte unchanged", fs.readFileSync(path.join(repo, "existing-modified.txt")).equals(before.modified));
    check("zero-change: existing-staged.txt is byte-for-byte unchanged", fs.readFileSync(path.join(repo, "existing-staged.txt")).equals(before.staged));
    check("zero-change: existing-untracked.txt is byte-for-byte unchanged", fs.readFileSync(path.join(repo, "existing-untracked.txt")).equals(before.untracked));
    check("zero-change: existing-deleted.txt remains absent", !fs.existsSync(path.join(repo, "existing-deleted.txt")));

    const keys = listBaselineKeys(repo);
    const missionKey = keys.find(k => /^mission-/.test(k) && !/-phase-/.test(k));
    check("zero-change: a mission baseline key was created", !!missionKey, JSON.stringify(keys));
    if (missionKey) {
      // TASK 14: the Implementer made zero changes, but Project Autopilot
      // itself now writes the phase's own tasks.md checkbox edit after
      // Verification PASS (scripts/speckit-task-state.mjs) — a real,
      // intentional, in-scope mission change, not pre-existing dirt. So the
      // phase delta is no longer required to be literally empty; it must
      // still never contain the forbidden pre-existing content, and the
      // only path it may mention is tasks.md itself.
      const phaseDelta = scopedDelta(repo, `${missionKey}-phase-0`);
      check("zero-change: real scopedDelta() for the phase contains nothing but Autopilot's own task-completion checkbox edit",
        !phaseDelta.includes(FORBIDDEN)
        && !phaseDelta.includes("existing-modified.txt")
        && !phaseDelta.includes("existing-staged.txt")
        && !phaseDelta.includes("existing-untracked.txt")
        && !phaseDelta.includes("existing-deleted.txt")
        && (phaseDelta === "" || phaseDelta.includes("tasks.md")),
        phaseDelta);
      const rawManifest = readManifest(repo, missionKey);
      // v2 manifest: {version:2, declaredPaths:[], entries:{...}}; v1 compat: flat map
      const manifest = rawManifest && rawManifest.entries ? rawManifest.entries : rawManifest;
      const expectedKeys = ["existing-modified.txt", "existing-deleted.txt", "existing-staged.txt", "existing-untracked.txt"];
      // TASK 15.6B: a fresh mission always plans first, so the mission's
      // OWN new-feature planning artifacts (created by the planner during
      // this mission, after the seeded dirt) are legitimately captured too.
      // The manifest must contain exactly the pre-existing dirt plus those
      // planning products — nothing else.
      const expectedPlanningKeys = [".specify/feature.json", "specs/001-fixture-feature/plan.md", "specs/001-fixture-feature/spec.md", "specs/001-fixture-feature/tasks.md"];
      check("zero-change: mission baseline manifest captured exactly the pre-existing dirt plus the mission's own planning artifacts (nothing else)",
        manifest && expectedKeys.every(k => k in manifest) && expectedPlanningKeys.every(k => k in manifest)
        && Object.keys(manifest).length === expectedKeys.length + expectedPlanningKeys.length,
        JSON.stringify(rawManifest));
    }
  } finally {
    cleanup(repo, binDir);
  }
}

// ===========================================================================
// 2. A genuine implementation change made on top of the same FORBIDDEN
//    dirty worktree, with a Code Review FAIL-then-retry-then-PASS cycle:
//    proves the baseline survives the retry unchanged (never absorbs
//    attempt 1's changes), the delta shows ONLY the mission's own change,
//    unrelated pre-existing files remain untouched, a genuine defect still
//    causes Code Review FAIL, Verification uses the same scoped delta, and
//    the final review's delta is the mission's cumulative change — with the
//    forbidden marker excluded throughout (observable via PASS decisions).
// ===========================================================================
{
  const repo = makeFixtureRepo("dirty-real-change");
  const binDir = makeFixtureBin("dirty-real-change");
  try {
    makeSpecKitPhaseFixture(repo);
    writeConfig(repo, {planningFramework: "speckit"});
    setScenario(repo, "dirty_worktree_changes");
    seedDirtyWorktree(repo);

    const originalModifiedContent = fs.readFileSync(path.join(repo, "existing-modified.txt"), "utf8");
    const beforeStaged = fs.readFileSync(path.join(repo, "existing-staged.txt"));
    const beforeUntracked = fs.readFileSync(path.join(repo, "existing-untracked.txt"));

    const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: MISSION_TIMEOUT_MS});
    const events = readObservedEvents(repo);

    check("real change: mission completed (exit 0)", run.status === 0, `stderr=${run.stderr.slice(-800)}`);

    const codeReviews = events.filter(e => e.role === "code_reviewer");
    check("real change: a genuine implementation defect still caused a Code Review FAIL first", codeReviews[0]?.decision === "FAIL");
    check("real change: Code Review PASSed on retry (observable proof the forbidden marker never leaked)", codeReviews.some(e => e.decision === "PASS"));
    check("real change: Verifier PASSed (observable proof it used the same clean scoped delta)", events.some(e => e.role === "verifier" && e.decision === "PASS"));

    check("real change: existing-staged.txt is byte-for-byte unchanged", fs.readFileSync(path.join(repo, "existing-staged.txt")).equals(beforeStaged));
    check("real change: existing-untracked.txt is byte-for-byte unchanged", fs.readFileSync(path.join(repo, "existing-untracked.txt")).equals(beforeUntracked));
    check("real change: existing-deleted.txt remains absent (never recreated)", !fs.existsSync(path.join(repo, "existing-deleted.txt")));
    check("real change: existing-modified.txt's pre-existing content is preserved, only appended to",
      fs.readFileSync(path.join(repo, "existing-modified.txt"), "utf8").startsWith(originalModifiedContent));

    const keys = listBaselineKeys(repo);
    const missionKey = keys.find(k => /^mission-/.test(k) && !/-phase-/.test(k));
    check("real change: a mission baseline key was created", !!missionKey, JSON.stringify(keys));
    if (missionKey) {
      const phaseKey = `${missionKey}-phase-0`;
      const rawManifest = readManifest(repo, phaseKey);
      // v2 manifest: {version:2, declaredPaths:[], entries:{...}}; v1 compat: flat map
      const manifest = rawManifest && rawManifest.entries ? rawManifest.entries : rawManifest;
      check("real change: phase baseline snapshot of existing-modified.txt is the ORIGINAL pre-mission content (retry never re-captured it)",
        manifest?.["existing-modified.txt"]?.type === "file");
      const snapshotPath = path.join(repo, ".autopilot", "baseline", phaseKey, "files", "existing-modified.txt");
      check("real change: baseline snapshot file content equals the pre-mission content exactly",
        fs.existsSync(snapshotPath) && fs.readFileSync(snapshotPath, "utf8") === originalModifiedContent,
        fs.existsSync(snapshotPath) ? fs.readFileSync(snapshotPath, "utf8") : "(missing)");

      const finalDelta = scopedDelta(repo, missionKey);
      check("real change: final-review scoped delta shows the mission's own change", finalDelta.includes("mission-change") || finalDelta.includes("implementation output"), finalDelta);
      check("real change: final-review scoped delta never contains the forbidden marker", !finalDelta.includes(FORBIDDEN), finalDelta);
    }
  } finally {
    cleanup(repo, binDir);
  }
}

// ===========================================================================
// 3. Mission lifecycle (Defect 1): two distinct SpecKit missions run
//    sequentially in the SAME disposable repository must never share a
//    baseline. Mission 2 must capture its OWN fresh baseline (reflecting
//    the state after mission 1 completed, not mission 1's original dirt),
//    and mission 1's baseline must remain exactly as it was.
// ===========================================================================
{
  const repo = makeFixtureRepo("mission-lifecycle");
  const binDir = makeFixtureBin("mission-lifecycle");
  try {
    makeSpecKitPhaseFixture(repo);
    writeConfig(repo, {planningFramework: "speckit"});
    setScenario(repo, "dirty_worktree_zero_change");
    seedDirtyWorktree(repo);

    const run1 = runAutopilot(repo, binDir, {request: "implement the first fixture task", timeoutMs: MISSION_TIMEOUT_MS});
    check("mission lifecycle: mission 1 completed (exit 0)", run1.status === 0, `stderr=${run1.stderr.slice(-800)}`);

    const keysAfterMission1 = listBaselineKeys(repo);
    const mission1Key = keysAfterMission1.find(k => /^mission-/.test(k) && !/-phase-/.test(k));
    check("mission lifecycle: mission 1 captured a baseline", !!mission1Key, JSON.stringify(keysAfterMission1));
    const mission1ManifestBefore = mission1Key ? readManifest(repo, mission1Key) : null;

    // A second, distinct SpecKit feature — mission 2's own planning
    // artifacts, already complete, exactly like the harness's own
    // makeSpecKitPhaseFixture() shape but a different feature dir. Mission 2
    // is a NEW request, so its planner creates yet another NEW feature;
    // specKitPhases() then scopes implementation to that feature, and
    // feature 1's task is already fully checked off, so the only pending
    // work a second, independent mission request will find is its own.
    const feature2Dir = path.join(repo, "specs", "002-second-feature");
    fs.mkdirSync(feature2Dir, {recursive: true});
    fs.writeFileSync(path.join(feature2Dir, "spec.md"), "# Spec\n\nSecond fixture feature.\n");
    fs.writeFileSync(path.join(feature2Dir, "plan.md"), "# Plan\n\nSecond fixture plan.\n");
    fs.writeFileSync(path.join(feature2Dir, "tasks.md"), "## Phase 1: Do the second fixture task\n\n- [ ] Do the second fixture task\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "second speckit fixture feature"]);

    const run2 = runAutopilot(repo, binDir, {request: "implement the second, unrelated fixture task", timeoutMs: MISSION_TIMEOUT_MS});
    check("mission lifecycle: mission 2 completed (exit 0)", run2.status === 0, `stderr=${run2.stderr.slice(-800)}`);

    const keysAfterMission2 = listBaselineKeys(repo);
    const mission2Key = keysAfterMission2.find(k => /^mission-/.test(k) && !/-phase-/.test(k) && k !== mission1Key);
    check("mission lifecycle: mission 2 captured a DIFFERENT baseline key than mission 1", !!mission2Key && mission2Key !== mission1Key, JSON.stringify({mission1Key, keysAfterMission2}));
    check("mission lifecycle: mission 1's baseline directory still exists, untouched", fs.existsSync(path.join(repo, ".autopilot", "baseline", mission1Key)));
    check("mission lifecycle: mission 1's baseline manifest is byte-identical to what it was right after mission 1 (never deleted/recreated)",
      JSON.stringify(readManifest(repo, mission1Key)) === JSON.stringify(mission1ManifestBefore));

    if (mission2Key) {
      const mission2Manifest = readManifest(repo, mission2Key);
      // Mission 2 starts AFTER mission 1 already completed, so its own
      // baseline is a FRESH capture of whatever is dirty at THAT point —
      // it must never simply be mission 1's manifest reused verbatim.
      check("mission lifecycle: mission 2's baseline is a fresh capture, not mission 1's reused",
        JSON.stringify(mission2Manifest) !== JSON.stringify(mission1ManifestBefore), JSON.stringify(mission2Manifest));
    }

    const events = readObservedEvents(repo);
    check("mission lifecycle: mission 2's code_reviewer PASSed (no cross-mission leakage caused a false FAIL)",
      events.filter(e => e.role === "code_reviewer").some(e => e.decision === "PASS"));
  } finally {
    cleanup(repo, binDir);
  }
}

// ===========================================================================
// 4. Retry/resume within the SAME mission must retain its ORIGINAL baseline
//    — proven directly against real, imported production code by re-running
//    ensureBaseline-driven scopedDelta() a second time for the exact same
//    key used in test 2 above and confirming it is unaffected by the
//    already-completed retries (the phase's baseline manifest is identical
//    across repeated scopedDelta() calls, i.e. reading it is idempotent and
//    the underlying capture was never repeated).
// ===========================================================================
{
  // Reuses the "real change" repo from test 2 is not possible (already
  // cleaned up); this is intentionally a light, additional confirmation
  // that scopedDelta()/ensureBaseline() themselves are side-effect-free on
  // read, using a fresh minimal fixture rather than re-deriving test 2.
  const repo = makeFixtureRepo("retry-persistence");
  const binDir = makeFixtureBin("retry-persistence");
  try {
    makeSpecKitPhaseFixture(repo);
    writeConfig(repo, {planningFramework: "speckit"});
    setScenario(repo, "dirty_worktree_changes"); // fails once (attempt 1), passes on retry (attempt 2)
    seedDirtyWorktree(repo);
    const originalModifiedContent = fs.readFileSync(path.join(repo, "existing-modified.txt"), "utf8");

    const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: MISSION_TIMEOUT_MS});
    check("retry persistence: mission completed (exit 0)", run.status === 0, `stderr=${run.stderr.slice(-800)}`);

    const keys = listBaselineKeys(repo);
    const phaseKey = keys.find(k => /-phase-0$/.test(k));
    check("retry persistence: a phase baseline was captured", !!phaseKey, JSON.stringify(keys));
    if (phaseKey) {
      const snapshotPath = path.join(repo, ".autopilot", "baseline", phaseKey, "files", "existing-modified.txt");
      const snapshotContent = fs.existsSync(snapshotPath) ? fs.readFileSync(snapshotPath, "utf8") : null;
      check("retry persistence: the phase baseline snapshot is still the ORIGINAL pre-mission content after a retry (attempt 1 fail + attempt 2 pass)",
        snapshotContent === originalModifiedContent, snapshotContent);
      const deltaAgain = scopedDelta(repo, phaseKey);
      check("retry persistence: re-reading scopedDelta() afterward is stable (no hidden mutation on read)",
        deltaAgain === scopedDelta(repo, phaseKey));
    }
  } finally {
    cleanup(repo, binDir);
  }
}

if (failures) {
  console.error(`${failures} dirty-worktree isolation check(s) failed.`);
  process.exit(1);
}
console.log("dirty-worktree isolation behavioral tests passed");
