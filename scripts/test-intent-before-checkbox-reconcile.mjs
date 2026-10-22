#!/usr/bin/env node
// F9 — settle the INTENT before either crash-recovery reconcile validates a dead
// mission's debris.
//
// Both reconciles are fail-closed by design: a snapshot that EXISTS but is invalid
// (malformed, or bound to another mission/feature) stops the run for human
// intervention. Both also ran BEFORE the intent was settled — the SpecKit
// reconcile (`pendingCheckboxSnapshot`, at the top of runImplementation()) is the
// first thing a run does, and it is reached before the new-request decision ~80
// lines below it in the same function, for EVERY framework (standalone and GSD are
// only dispatched after it). So a supplied NEW request died on the ABANDONED
// mission's snapshot —
//   "…failed validation during crash recovery: … mission mismatch … STOP"
// — making a new mission impossible without hand-editing state.json.
//
// The fix (dropAbandonedMissionDebris) asks the same question the new-request
// decision asks — is the supplied request usable AND different from the recorded
// one? — before either reconcile, and drops the abandoned mission's owned state
// instead of validating it. Both directions are asserted here, at both sites:
//
//   NEW request  → debris dropped, no validation death, the run proceeds.
//   SAME request → the guard stays out of the way and the reconcile still fails
//                  closed, preserving the invalid snapshot for a human.
//
// Site note, because it decides which scenarios are load-bearing: the SpecKit
// call is the one that matters (it runs first for every framework), so S1/S2 are
// its real two directions. The standalone reconcile sits BEHIND planning for a new
// request (a new request always re-plans before that runner is dispatched), so S3
// tests the rule on the standalone framework while S4 is the guard's actual
// regression test at that site: debris + a resume must still stop the run.
import fs from "node:fs";
import path from "node:path";
import {
  makeFixtureRepo, makeFixtureBin, makeSpecKitUnrelatedFeatureFixture, makeClaudeMdBaseline,
  setScenario, writeConfig, runAutopilot, cleanup
} from "./test-fixtures/workflow-order-harness.mjs";
// Imported directly so the test can PROVE its seeded snapshots are genuinely
// invalid (would be rejected by the reconcile) instead of assuming it — a seed
// that happened to validate would make both directions pass with or without the
// guard.
import {validatePendingCheckboxSnapshot} from "./pending-checkbox-snapshot.mjs";
import {validateStandaloneSnapshot} from "./mission-naming.mjs";

const OLD_MISSION = "001-old-feature";
const OLD_REQUEST = "the old feature";
const NEW_REQUEST = "add a completely different health endpoint probe";
const FOREIGN_MISSION = "999-some-other-mission";
const TIMEOUT_MS = process.platform === "win32" ? 220000 : 120000;

// The guard's own line: pins that the debris was dropped by THIS rule rather than
// the run quietly getting lucky.
const GUARD_LINE = "the previous mission's crash-recovery debris is dropped, not validated";
const SPECKIT_DEATH = "failed validation during crash recovery";
const STANDALONE_DEATH = "Standalone checkbox snapshot validation failed";

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}
function readState(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
}
function writeState(repo, state) {
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(state, null, 2));
}
// An invalid-but-well-typed snapshot: every required field is present and the
// right type, and it is bound to a FOREIGN mission, so the reconcile's own
// validator rejects it (mission mismatch is checked before the task entries).
// This is what makes the difference between the two directions observable — a
// matching snapshot would reconcile instead of dying, and both directions would
// then pass whether or not the guard exists.
function foreignSpecKitSnapshot(repo) {
  return {
    feature: null, mission: FOREIGN_MISSION, capturedAt: "2020-01-01T00:00:00.000Z",
    tasks: [{file: path.join(repo, "specs", OLD_MISSION, "tasks.md"), line: 3, text: "OLD-TASK", done: false}]
  };
}
function foreignStandaloneSnapshot(repo) {
  return {
    feature: null, mission: FOREIGN_MISSION, capturedAt: "2020-01-01T00:00:00.000Z",
    tasks: [{file: path.join(repo, ".autopilot", "missions", OLD_MISSION, "TASKS.md"), line: 3, text: "OLD-TASK", done: false}]
  };
}

// ---------------------------------------------------------------------
// S1 — SpecKit site, NEW request: the dead mission's debris is dropped and
// the run is not judged by it.
// ---------------------------------------------------------------------
{
  const repo = makeFixtureRepo("f9-speckit-new");
  const binDir = makeFixtureBin("f9-speckit-new");
  try {
    makeSpecKitUnrelatedFeatureFixture(repo, "002-unrelated-feature");
    makeClaudeMdBaseline(repo);
    writeConfig(repo, {planningFramework: "speckit"});
    const seededSnapshot = foreignSpecKitSnapshot(repo);
    const seededVerdict = validatePendingCheckboxSnapshot(seededSnapshot, null, OLD_MISSION, repo);
    check("S1 speckit/NEW: the seed is genuinely invalid for the open mission (non-vacuity)",
      !seededVerdict.ok && /mismatch/.test(String(seededVerdict.reason)), seededVerdict);
    writeState(repo, {
      version: 1, mission: OLD_MISSION, missionSeq: "001", planningRequest: OLD_REQUEST,
      phase: "escalated", step: "plan_review_exhausted", phaseIndex: 0, attempt: 2,
      pendingCheckboxSnapshot: seededSnapshot
    });
    // Stops the NEW mission at its own plan review: fast and deterministic. The
    // guard under test runs before any relay is launched, so the assertion does
    // not depend on where the new mission later dies.
    setScenario(repo, "plan_review_infra_retryable_always");
    const run = runAutopilot(repo, binDir, {request: NEW_REQUEST, timeoutMs: TIMEOUT_MS});
    const out = `${run.stdout || ""}${run.stderr || ""}`;
    const state = readState(repo);

    check("S1 speckit/NEW: the guard dropped the debris instead of validating it",
      out.includes(GUARD_LINE), out.slice(0, 1200));
    check("S1 speckit/NEW: the run does NOT die on the abandoned mission's snapshot",
      !out.includes(SPECKIT_DEATH), out.slice(0, 1200));
    check("S1 speckit/NEW: the snapshot key does not survive into the new mission",
      !Object.hasOwn(state, "pendingCheckboxSnapshot"), Object.keys(state));
    check("S1 speckit/NEW: the new mission took over (identity moved on)",
      state.mission !== OLD_MISSION && state.planningIntent?.kind === "new",
      {mission: state.mission, intent: state.planningIntent});
  } finally {
    cleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// S2 — SpecKit site, SAME request: a genuine resume, so the guard must stay
// out of the way and the reconcile must still fail closed.
// ---------------------------------------------------------------------
{
  const repo = makeFixtureRepo("f9-speckit-resume");
  const binDir = makeFixtureBin("f9-speckit-resume");
  try {
    makeSpecKitUnrelatedFeatureFixture(repo, "002-unrelated-feature");
    makeClaudeMdBaseline(repo);
    writeConfig(repo, {planningFramework: "speckit"});
    writeState(repo, {
      version: 1, mission: OLD_MISSION, missionSeq: "001", planningRequest: OLD_REQUEST,
      phase: "escalated", step: "plan_review_exhausted", phaseIndex: 0, attempt: 2,
      pendingCheckboxSnapshot: foreignSpecKitSnapshot(repo)
    });
    const run = runAutopilot(repo, binDir, {request: OLD_REQUEST, timeoutMs: TIMEOUT_MS});
    const out = `${run.stdout || ""}${run.stderr || ""}`;
    const state = readState(repo);

    check("S2 speckit/SAME: the guard stayed out of the way on a resume",
      !out.includes(GUARD_LINE), out.slice(0, 900));
    check("S2 speckit/SAME: the reconcile still fails closed on the invalid snapshot",
      out.includes(SPECKIT_DEATH) && out.includes("STOP — human intervention required."), out.slice(0, 1200));
    check("S2 speckit/SAME: the invalid snapshot is PRESERVED for a human (never deleted on failure)",
      Object.hasOwn(state, "pendingCheckboxSnapshot"), Object.keys(state));
    check("S2 speckit/SAME: state records the fail-closed stop, not a new mission",
      state.phase === "escalated" && state.step === "task_snapshot_recovery_failed",
      {phase: state.phase, step: state.step});
    check("S2 speckit/SAME: the mission identity was not reset to a new mission",
      state.mission === OLD_MISSION, state.mission);
  } finally {
    cleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// S3 — standalone framework, NEW request: the same rule holds on the other
// reconcile's key (no validation death; the debris is gone before it can be
// judged, and the run goes on to the new mission).
// ---------------------------------------------------------------------
{
  const repo = makeFixtureRepo("f9-standalone-new");
  const binDir = makeFixtureBin("f9-standalone-new");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    const seededSnapshot3 = foreignStandaloneSnapshot(repo);
    const seededVerdict3 = validateStandaloneSnapshot(
      seededSnapshot3, OLD_MISSION, path.join(repo, ".autopilot", "missions", OLD_MISSION, "TASKS.md"));
    check("S3 standalone/NEW: the seed is genuinely invalid for the open mission (non-vacuity)",
      !seededVerdict3.ok && /mission mismatch/.test(String(seededVerdict3.reason)), seededVerdict3);
    writeState(repo, {
      version: 1, mission: OLD_MISSION, missionSeq: "001", planningRequest: OLD_REQUEST,
      phase: "escalated", step: "plan_review_exhausted", phaseIndex: 0, attempt: 2,
      pendingStandaloneCheckboxSnapshot: seededSnapshot3
    });
    // No scenario: a new request always re-plans before the standalone runner (and
    // therefore its reconcile) is reached, so the default happy-path planning is
    // what lets the run get far enough to exercise the rule.
    const run = runAutopilot(repo, binDir, {request: NEW_REQUEST, timeoutMs: TIMEOUT_MS});
    const out = `${run.stdout || ""}${run.stderr || ""}`;
    const state = readState(repo);

    check("S3 standalone/NEW: the guard dropped the debris on the standalone framework",
      out.includes(GUARD_LINE), out.slice(0, 1200));
    check("S3 standalone/NEW: no standalone snapshot validation death",
      !out.includes(STANDALONE_DEATH), out.slice(0, 1200));
    check("S3 standalone/NEW: the standalone snapshot key does not survive",
      !Object.hasOwn(state, "pendingStandaloneCheckboxSnapshot"), Object.keys(state));
    // Reaching the standalone runner at all requires planning to have passed, and
    // the runner's own next step after the reconcile is the mission baseline — so
    // its presence is what proves the run went PAST the reconcile rather than
    // dying on it.
    const baselineDir = path.join(repo, ".autopilot", "baseline");
    const baselines = fs.existsSync(baselineDir) ? fs.readdirSync(baselineDir) : [];
    check("S3 standalone/NEW: the run got past the reconcile into the new mission's implementation",
      baselines.length > 0, {baselines, tail: out.slice(-700)});
  } finally {
    cleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// S4 — standalone runner, SAME request: debris that survives to the standalone
// reconcile (phase already past planning, so its runner is reached directly)
// must still stop the run. This is the guard's regression test at that site.
// ---------------------------------------------------------------------
{
  const repo = makeFixtureRepo("f9-standalone-resume");
  const binDir = makeFixtureBin("f9-standalone-resume");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    writeState(repo, {
      version: 1, mission: OLD_MISSION, missionSeq: "001", planningRequest: OLD_REQUEST,
      phase: "implementing", step: "standalone-implement", phaseIndex: 0, attempt: 1,
      pendingStandaloneCheckboxSnapshot: foreignStandaloneSnapshot(repo)
    });
    const run = runAutopilot(repo, binDir, {request: OLD_REQUEST, timeoutMs: TIMEOUT_MS});
    const out = `${run.stdout || ""}${run.stderr || ""}`;
    const state = readState(repo);

    check("S4 standalone/SAME: the guard stayed out of the way on a resume",
      !out.includes(GUARD_LINE), out.slice(0, 900));
    check("S4 standalone/SAME: the standalone reconcile still fails closed on foreign debris",
      out.includes(STANDALONE_DEATH) && out.includes("mission mismatch"), out.slice(0, 1200));
    check("S4 standalone/SAME: state records the fail-closed stop",
      state.phase === "escalated" && state.step === "standalone_snapshot_validation_failed",
      {phase: state.phase, step: state.step});
    check("S4 standalone/SAME: the snapshot is preserved for a human",
      Object.hasOwn(state, "pendingStandaloneCheckboxSnapshot"), Object.keys(state));
  } finally {
    cleanup(repo, binDir);
  }
}

if (failures) {
  console.error(`${failures} intent-before-reconcile check(s) failed.`);
  process.exit(1);
}
console.log("test-intent-before-checkbox-reconcile: ALL CHECKS PASSED");
