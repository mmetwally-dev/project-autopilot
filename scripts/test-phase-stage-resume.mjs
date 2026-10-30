#!/usr/bin/env node
// TASK-11 Phases 4-5 — Standalone + SpecKit phase-stage resume (TASK-7
// cases 1-7 and 10, plus extras).
//
// Drives real `node scripts/autopilot.mjs run --repo <repo>` subprocesses
// the same way test-exact-resume-adapters.mjs:105 does — never by importing
// `autopilot.mjs` (it runs `main()` at import with no guard) — against the
// shared fake-adapter ecosystem (fake-workflow-adapter.sh, scenario-driven
// via a committed `.autopilot/.autopilot-test-scenario` file, plus
// workflow-order-harness.mjs's runAutopilotUntilMarker for crash injection).
// Every case asserts the observed role-launch sequence (never prompt
// wording) reconstructed from the orchestrator's own result.json files.
//
// Standalone cases (TASK-7 §Tests):
//   1. Implementer completes, process stops before review → resume launches
//      Code Reviewer first; Implementer launch count remains one.
//   2. Reviewer PASS, process stops before verification → resume launches
//      Verifier first; Implementer and Reviewer are not relaunched.
//   3. Verifier infrastructure failure → resume retries Verifier only.
//   4. Reviewer infrastructure failure → resume retries Reviewer only.
//   5. Reviewer functional FAIL → Implementer runs again with exact findings.
//   6. Verifier/gate functional FAIL → Implementer, then Reviewer, then
//      Verifier (both the verifier-FAIL and the gate-FAIL shapes).
//   7. Verifier PASS followed by a crash before task marking → resume marks
//      tasks with zero model launches for the already-approved revision.
//   8. Interrupted Implementer (extra): partial work in the tree resumes at
//      the Implementer with no drift escalation and no Code Reviewer launch.
//   9. All-checked mission (extra): a stale crafted checkpoint is cleared by
//      the no-pending path instead of surviving into a completed mission.
//  10. Attempts survive a process restart (double-kill proof).
//
// SpecKit cases (TASK-11 Phase 5, task 11 — the same stage-transition
// decision called identically from the SpecKit loop):
//  S1. Implementer completes, process stops before review → resume launches
//      Code Reviewer first; Implementer launch count remains one.
//  S2. Reviewer infrastructure failure → resume retries Reviewer only.
//  S3. Reviewer functional FAIL → Implementer runs again with exact findings.
//  S4. Verifier infrastructure failure → resume retries Verifier only.
//  S5. Verifier functional FAIL → Implementer, Reviewer, Verifier again.
//  S6. Interrupted Implementer (extra): partial work resumes at the
//      Implementer with continuation context and no drift escalation.
//  S7. Gate functional FAIL (extra): a file-writing gate's post-gate tree
//      is approved without drift via the shared post-gate digest refresh.
//  S8. Reviewer PASS, process stops before verification → resume launches
//      Verifier first; Implementer and Reviewer are not relaunched.
//  S9. Verifier PASS followed by a crash before task marking (extra):
//      resume marks tasks with zero model launches for the already-
//      approved revision (crafted checkpoint, no timing involved).
//
// Gate bypass confirmations (TASK-11 Phase 6, task 13 — one real run per
// evaluator action at the s.phase allowlist gate):
//  G1. Valid checkpoint + escalated phase resumes WITHOUT planning.
//  G2. Structurally invalid checkpoint escalates, never plans.
//  G3. Drifted approval-reuse checkpoint escalates at the gate.
//  G4. All-checked stale checkpoint plans (today's route) and completes.
//  G5. Checkpoint for a nonexistent phase escalates, never resumes.
//  G6. Foreign (mismatched or traversal-shaped) baseline key escalates
//      before any approval is reused.
//  G7. mark_tasks resume whose delta drifted escalates instead of marking
//      (both the in-loop mark gate and the allowlist-gate bypass).
//
// Read-only roles cannot drop crash-marker files under the bubblewrap
// envelope, so reviewer/verifier interruptions use slow roles (sleep). The
// harness kills the tree as soon as the orchestrator's own status.json shows
// the intended launch is in progress with no result.json yet (hangStarted);
// the killed run's dir persists without result.json, which is exactly what
// the fixture's hang-once logic keys off. Cases 8, 9, 11, 12 of TASK-7 are
// covered elsewhere: 8/9 by
// test-phase-stage-checkpoint.mjs, 11 by
// test-standalone-snapshot-resume.mjs, 12 by the suites re-run in Phase 7.
import fs from "node:fs";
import path from "node:path";
import {
  makeFixtureRepo, makeFixtureBin, makeSpecKitPhaseFixture, writeConfig, setScenario,
  runAutopilot, runAutopilotUntilMarker, readObservedEvents, hangStarted, cleanup,
} from "./test-fixtures/workflow-order-harness.mjs";
import {ensureBaseline, scopedDelta, sanitizeKeySegment} from "./implementation-baseline.mjs";
import {phases as speckitPhases} from "../adapters/speckit.mjs";
import {phaseTaskDigest, deltaDigest, CHECKPOINT_STATE_KEY} from "./phase-stage-checkpoint.mjs";
import * as standalone from "../adapters/standalone.mjs";

// Standalone sections run on all platforms. SpecKit sections require
// filesystem containment: on Linux/WSL2 that's the bubblewrap envelope;
// on native Windows the disposable-copy path (autopilot.mjs's
// useDisposableReviewerWorkspace) implements it. The speckit_* scenarios
// exist only in the POSIX fixture (fake-workflow-adapter.sh).

const REQUEST = "fixture request";
const MISSION = "001-stage-resume";
const MISSION_TIMEOUT_MS = 120000;
const KILL_TIMEOUT_MS = 20000;
const NEVER_MARKER = ".autopilot-test-never-appears";

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

function writeStandaloneMission(repo, tasksContent) {
  const planFile = standalone.planPath(repo, MISSION);
  const tasksFile = standalone.tasksPath(repo, MISSION);
  fs.mkdirSync(path.dirname(planFile), {recursive: true});
  fs.writeFileSync(planFile, "# Plan\n\nObjective: fixture task.\n");
  fs.writeFileSync(tasksFile, tasksContent);
  return {planFile, tasksFile};
}

function writeState(repo, state) {
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(state, null, 2));
}

function readState(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
}

function setupMission(prefix, scenario, tasksContent, configExtra = {}) {
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  writeConfig(repo, {planningFramework: "standalone", ...configExtra});
  setScenario(repo, scenario);
  writeStandaloneMission(repo, tasksContent);
  writeState(repo, {
    version: 1, phase: "tasks_ready", step: "tasks_ready",
    phaseIndex: 0, attempt: 1, mission: MISSION, planningRequest: REQUEST,
  });
  return {repo, binDir};
}

const SINGLE_PHASE_TASKS = "## Phase 1: General\n\n- [ ] Do the fixture task\n";

// ── SpecKit helpers (Phase 5) ──
// A SpecKit mission always starts fresh (no crafted state.json): planning
// runs through the fake adapter, which writes the single-phase
// single-task feature (specs/001-fixture-feature) for any request without
// "multi-task". The planner-created feature path is discovered from disk
// rather than assumed.
const SPECKIT_REQUEST = "implement the fixture task";
const SPECKIT_MISSION_TIMEOUT_MS = 180000;
// Safety-net deadline for the S1 reviewer hang: the run is normally killed
// as soon as the hanging launch is visible on disk (hangStarted), so this
// only bounds a scenario where that launch never appears. The hang sleeps
// 120s, so even the upper bound lands inside it for any plausible planning
// duration while the mission cannot complete before it.
const SPECKIT_KILL_TIMEOUT_MS = 60000;

function setupSpeckitMission(prefix, scenario, configExtra = {}) {
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  makeSpecKitPhaseFixture(repo);
  writeConfig(repo, {planningFramework: "speckit", ...configExtra});
  setScenario(repo, scenario);
  return {repo, binDir};
}

function speckitTasksFile(repo) {
  const specsDir = path.join(repo, "specs");
  const matches = [];
  for (const entry of fs.readdirSync(specsDir)) {
    const candidate = path.join(specsDir, entry, "tasks.md");
    if (fs.existsSync(candidate)) matches.push(candidate);
  }
  if (matches.length !== 1) throw new Error(`expected exactly one SpecKit tasks.md, found ${matches.length}: ${matches.join(", ")}`);
  return matches[0];
}

function speckitTasksText(repo) {
  return fs.readFileSync(speckitTasksFile(repo), "utf8");
}

function roleCounts(repo) {
  const counts = {};
  for (const e of readObservedEvents(repo)) counts[e.role] = (counts[e.role] || 0) + 1;
  return counts;
}

function eventsAfter(repo, isoTime) {
  const t = Date.parse(isoTime);
  return readObservedEvents(repo).filter((e) => Date.parse(e.startedAt) > t);
}

// Brief.txt sitting next to the Nth (0-based) result of one role.
function briefForRole(repo, role, occurrence) {
  const found = readObservedEvents(repo).filter((e) => e.role === role);
  if (occurrence >= found.length) return null;
  try {
    return fs.readFileSync(path.join(path.dirname(found[occurrence].file), "brief.txt"), "utf8");
  } catch {
    return null;
  }
}

function tasksText(repo) {
  return fs.readFileSync(standalone.tasksPath(repo, MISSION), "utf8");
}

// ── Case 1: implementer completes, stop before review → resume at Reviewer ──
{
  const {repo, binDir} = setupMission("stage-resume-c1", "standalone_reviewer_hang", SINGLE_PHASE_TASKS);
  try {
    const run1 = await runAutopilotUntilMarker(repo, binDir, {
      request: REQUEST, markerFile: path.join(repo, NEVER_MARKER),
      readyWhen: () => hangStarted(repo, "code_reviewer", 1), timeoutMs: KILL_TIMEOUT_MS,
    });
    check("c1: interrupted mid-review (ready observed, tree confirmed dead)",
      run1.readyObserved && run1.killed && run1.terminationConfirmed,
      {readyObserved: run1.readyObserved, killed: run1.killed, terminationConfirmed: run1.terminationConfirmed, timedOut: run1.timedOut});
    check("c1: implementer completed once before the kill", (roleCounts(repo).implementer || 0) === 1, roleCounts(repo));
    const s1 = readState(repo);
    check("c1: checkpoint waits at code_reviewer",
      s1[CHECKPOINT_STATE_KEY]?.nextStage === "code_reviewer" && s1[CHECKPOINT_STATE_KEY]?.runningStage === "code_reviewer", s1[CHECKPOINT_STATE_KEY]);
    check("c1: implementer attempt recorded", s1[CHECKPOINT_STATE_KEY]?.attempts?.implementer === 1, s1[CHECKPOINT_STATE_KEY]?.attempts);
    const boundary = new Date().toISOString();
    const run2 = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: MISSION_TIMEOUT_MS});
    check("c1: resume completed the mission", run2.status === 0, {status: run2.status, stderrTail: (run2.stderr || "").slice(-500)});
    const fresh = eventsAfter(repo, boundary);
    check("c1: resume launches Code Reviewer first", fresh.length > 0 && fresh[0].role === "code_reviewer", fresh.map((e) => e.role));
    check("c1: Implementer launch count remains one", (roleCounts(repo).implementer || 0) === 1, roleCounts(repo));
    check("c1: task marked complete", /^- \[x\] Do the fixture task/m.test(tasksText(repo)));
    check("c1: checkpoint cleared at completion", !Object.hasOwn(readState(repo), CHECKPOINT_STATE_KEY));
  } finally { cleanup(repo, binDir); }
}

// ── Case 2: reviewer PASS, stop before verification → resume at Verifier ──
{
  const {repo, binDir} = setupMission("stage-resume-c2", "standalone_verifier_hang", SINGLE_PHASE_TASKS);
  try {
    const run1 = await runAutopilotUntilMarker(repo, binDir, {
      request: REQUEST, markerFile: path.join(repo, NEVER_MARKER),
      readyWhen: () => hangStarted(repo, "verifier", 1), timeoutMs: KILL_TIMEOUT_MS,
    });
    check("c2: interrupted mid-verification (ready observed, tree confirmed dead)",
      run1.readyObserved && run1.killed && run1.terminationConfirmed,
      {readyObserved: run1.readyObserved, killed: run1.killed, terminationConfirmed: run1.terminationConfirmed, timedOut: run1.timedOut});
    const counts1 = roleCounts(repo);
    check("c2: implementer and reviewer completed once each", counts1.implementer === 1 && counts1.code_reviewer === 1, counts1);
    const s1 = readState(repo);
    check("c2: checkpoint waits at verifier",
      s1[CHECKPOINT_STATE_KEY]?.nextStage === "verifier" && s1[CHECKPOINT_STATE_KEY]?.runningStage === "verifier", s1[CHECKPOINT_STATE_KEY]);
    const boundary = new Date().toISOString();
    const run2 = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: MISSION_TIMEOUT_MS});
    check("c2: resume completed the mission", run2.status === 0, {status: run2.status, stderrTail: (run2.stderr || "").slice(-500)});
    const fresh = eventsAfter(repo, boundary);
    check("c2: resume launches Verifier first", fresh.length > 0 && fresh[0].role === "verifier", fresh.map((e) => e.role));
    const counts = roleCounts(repo);
    check("c2: implementer and reviewer not relaunched", counts.implementer === 1 && counts.code_reviewer === 2, counts);
    check("c2: task marked complete", /^- \[x\] Do the fixture task/m.test(tasksText(repo)));
  } finally { cleanup(repo, binDir); }
}

// ── Case 3: verifier infrastructure failure retries only the Verifier ──
{
  const {repo, binDir} = setupMission("stage-resume-c3", "standalone_verifier_infra_once", SINGLE_PHASE_TASKS);
  try {
    const run = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: MISSION_TIMEOUT_MS});
    check("c3: mission completed", run.status === 0, {status: run.status, stderrTail: (run.stderr || "").slice(-500)});
    const counts = roleCounts(repo);
    check("c3: verifier retried (two launches)", counts.verifier === 2, counts);
    check("c3: implementer and reviewer ran once each (phase level)",
      counts.implementer === 1 && counts.code_reviewer === 2, counts);
    check("c3: task marked complete", /^- \[x\] Do the fixture task/m.test(tasksText(repo)));
  } finally { cleanup(repo, binDir); }
}

// ── Case 4: reviewer infrastructure failure retries only the Reviewer ──
{
  const {repo, binDir} = setupMission("stage-resume-c4", "standalone_reviewer_infra_once", SINGLE_PHASE_TASKS);
  try {
    const run = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: MISSION_TIMEOUT_MS});
    check("c4: mission completed", run.status === 0, {status: run.status, stderrTail: (run.stderr || "").slice(-500)});
    const counts = roleCounts(repo);
    check("c4: reviewer retried at phase level", counts.code_reviewer === 3, counts);
    check("c4: implementer ran once, verifier ran once", counts.implementer === 1 && counts.verifier === 1, counts);
    check("c4: task marked complete", /^- \[x\] Do the fixture task/m.test(tasksText(repo)));
  } finally { cleanup(repo, binDir); }
}

// ── Case 5: reviewer functional FAIL returns to Implementer with findings ──
{
  const {repo, binDir} = setupMission("stage-resume-c5", "standalone_reviewer_fail_once", SINGLE_PHASE_TASKS);
  try {
    const run = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: MISSION_TIMEOUT_MS});
    check("c5: mission completed", run.status === 0, {status: run.status, stderrTail: (run.stderr || "").slice(-500)});
    const counts = roleCounts(repo);
    check("c5: implementer ran twice", counts.implementer === 2, counts);
    check("c5: reviewer ran twice at phase level", counts.code_reviewer === 3, counts);
    check("c5: verifier ran once", counts.verifier === 1, counts);
    check("c5: retried implementer received the exact findings",
      (briefForRole(repo, "implementer", 1) || "").includes("fix the widget alignment"),
      (briefForRole(repo, "implementer", 1) || "").slice(-300));
    check("c5: task marked complete", /^- \[x\] Do the fixture task/m.test(tasksText(repo)));
  } finally { cleanup(repo, binDir); }
}

// ── Case 6a: verifier functional FAIL runs Implementer, Reviewer, Verifier ──
{
  const {repo, binDir} = setupMission("stage-resume-c6a", "standalone_verifier_fail_once", SINGLE_PHASE_TASKS);
  try {
    const run = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: MISSION_TIMEOUT_MS});
    check("c6a: mission completed", run.status === 0, {status: run.status, stderrTail: (run.stderr || "").slice(-500)});
    const order = readObservedEvents(repo).map((e) => e.role);
    check("c6a: order is Implementer, Reviewer, Verifier, then again",
      JSON.stringify(order.slice(0, 6)) === JSON.stringify(["implementer", "code_reviewer", "verifier", "implementer", "code_reviewer", "verifier"]), order);
    check("c6a: retried implementer received the exact findings",
      (briefForRole(repo, "implementer", 1) || "").includes("coverage gap"));
    check("c6a: task marked complete", /^- \[x\] Do the fixture task/m.test(tasksText(repo)));
  } finally { cleanup(repo, binDir); }
}

// ── Case 6b: gate functional FAIL runs Implementer, Reviewer, Verifier ──
// The gate writes a Git-visible file (outside .autopilot/, which scoped
// deltas exclude) on its passing attempt: without the post-gate deltaDigest
// refresh in autopilot.mjs, the mark_tasks gate compares a pre-gate record
// against a post-gate tree and drift-escalates — this case fails when the
// refresh is removed.
{
  const gateCommand = `if [ ! -f .autopilot/.gate-count ]; then touch .autopilot/.gate-count; exit 1; fi; printf 'gate ran\n' > gate-output.txt`;
  const {repo, binDir} = setupMission("stage-resume-c6b", "success", SINGLE_PHASE_TASKS,
    {gatesCommands: [gateCommand], networkIsolation: false});
  try {
    const run = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: MISSION_TIMEOUT_MS});
    check("c6b: mission completed", run.status === 0, {status: run.status, stderrTail: (run.stderr || "").slice(-500)});
    const order = readObservedEvents(repo).map((e) => e.role);
    check("c6b: order is Implementer, Reviewer, Verifier, then again",
      JSON.stringify(order.slice(0, 6)) === JSON.stringify(["implementer", "code_reviewer", "verifier", "implementer", "code_reviewer", "verifier"]), order);
    check("c6b: retried implementer received the gate failure",
      (briefForRole(repo, "implementer", 1) || "").includes("Verification gate failed"),
      (briefForRole(repo, "implementer", 1) || "").slice(-300));
    check("c6b: gate wrote its Git-visible output", fs.readFileSync(path.join(repo, "gate-output.txt"), "utf8").includes("gate ran"));
    check("c6b: post-gate tree approved without drift", !`${run.stdout}\n${run.stderr}`.includes("standalone_checkpoint_drift"));
    check("c6b: task marked complete", /^- \[x\] Do the fixture task/m.test(tasksText(repo)));
  } finally { cleanup(repo, binDir); }
}

// ── Case 7: verifier PASS + crash before marking resumes at mark_tasks ──
// The crash is simulated by crafting the exact checkpoint a crash would
// leave: nextStage mark_tasks with digests matching the current tree. The
// run must mark phase 1 with zero model launches for that revision — the
// only launches in the whole run are phase 2's own Implementer, Reviewer,
// Verifier, plus the final review.
{
  const repo = makeFixtureRepo("stage-resume-c7");
  const binDir = makeFixtureBin("stage-resume-c7");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    setScenario(repo, "success");
    writeStandaloneMission(repo, "## Phase 1: General\n\n- [ ] Do the fixture task\n\n## Phase 2: Ship\n\n- [ ] Ship the fixture task\n");
    const missionKey = `mission-${sanitizeKeySegment(MISSION)}`;
    const phase0Key = `${missionKey}-phase-0`;
    const phase1Key = `${missionKey}-phase-1`;
    ensureBaseline(repo, missionKey, {mission: MISSION, declaredPaths: []});
    ensureBaseline(repo, phase0Key, {mission: MISSION, declaredPaths: []});
    ensureBaseline(repo, phase1Key, {mission: MISSION, declaredPaths: []});
    const phases = standalone.phases(repo, MISSION);
    const phase0Tasks = phases[0].tasks.map((t) => ({file: t.file, text: t.text}));
    const taskDigest = phaseTaskDigest({
      framework: "standalone", mission: MISSION, phaseIndex: 0,
      phaseName: phases[0].name, tasks: phase0Tasks, repoRoot: repo,
    });
    const fullDelta = scopedDelta(repo, phase0Key, {mission: MISSION, declaredPaths: []});
    writeState(repo, {
      version: 1, phase: "implementing", step: "verify",
      phaseIndex: 0, attempt: 2, mission: MISSION, planningRequest: REQUEST,
      [CHECKPOINT_STATE_KEY]: {
        version: 1, framework: "standalone", mission: MISSION, phaseIndex: 0,
        phaseName: phases[0].name, phaseTaskDigest: taskDigest, revision: 1,
        nextStage: "mark_tasks", runningStage: null,
        attempts: {implementer: 1, code_reviewer: 1, verifier: 1},
        baselineKey: phase0Key, deltaDigest: deltaDigest(fullDelta),
        implementer: {runId: null, summary: "crafted implementer report"},
        codeReviewer: {runId: null, decision: "PASS", findings: []},
        verifier: {runId: null, decision: "PASS", findings: []},
        updatedAt: new Date().toISOString(),
      },
    });
    const run = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: MISSION_TIMEOUT_MS});
    check("c7: mission completed", run.status === 0, {status: run.status, stderrTail: (run.stderr || "").slice(-500)});
    const text = tasksText(repo);
    check("c7: crashed phase marked without relaunch", /^- \[x\] Do the fixture task/m.test(text), text);
    check("c7: second phase completed normally", /^- \[x\] Ship the fixture task/m.test(text), text);
    const counts = roleCounts(repo);
    check("c7: zero model launches for the resumed revision (only phase 2 plus final review launched)",
      counts.implementer === 1 && counts.code_reviewer === 2 && counts.verifier === 1, counts);
    check("c7: checkpoint cleared at completion", !Object.hasOwn(readState(repo), CHECKPOINT_STATE_KEY));
  } finally { cleanup(repo, binDir); }
}

// ── Case 9 (extra): all-checked mission drops a stale crafted checkpoint ──
// A crash after the final setTaskCheckboxes() but before checkpoint
// deletion leaves every task checked with an active phase checkpoint still
// bound to the last phase. The no-pending early path must clear it (and
// finalizeMissionComplete deletes it defensively) so a completed mission
// never carries a checkpoint into a later mission's identity check.
{
  const repo = makeFixtureRepo("stage-resume-c9");
  const binDir = makeFixtureBin("stage-resume-c9");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    setScenario(repo, "success");
    writeStandaloneMission(repo, "## Phase 1: General\n\n- [x] Do the fixture task\n");
    const missionKey = `mission-${sanitizeKeySegment(MISSION)}`;
    ensureBaseline(repo, missionKey, {mission: MISSION, declaredPaths: []});
    const phases = standalone.phases(repo, MISSION);
    writeState(repo, {
      version: 1, phase: "implementing", step: "verify",
      phaseIndex: 0, attempt: 2, mission: MISSION, planningRequest: REQUEST,
      [CHECKPOINT_STATE_KEY]: {
        version: 1, framework: "standalone", mission: MISSION, phaseIndex: 0,
        phaseName: phases[0].name,
        phaseTaskDigest: phaseTaskDigest({
          framework: "standalone", mission: MISSION, phaseIndex: 0,
          phaseName: phases[0].name,
          tasks: phases[0].tasks.map((t) => ({file: t.file, text: t.text})),
          repoRoot: repo,
        }),
        revision: 1, nextStage: "mark_tasks", runningStage: null,
        attempts: {implementer: 1, code_reviewer: 1, verifier: 1},
        baselineKey: `${missionKey}-phase-0`, deltaDigest: deltaDigest(""),
        implementer: {runId: null, summary: "stale crafted report"},
        codeReviewer: {runId: null, decision: "PASS", findings: []},
        verifier: {runId: null, decision: "PASS", findings: []},
        updatedAt: new Date().toISOString(),
      },
    });
    const run = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: MISSION_TIMEOUT_MS});
    check("c9: all-checked mission completed", run.status === 0, {status: run.status, stderrTail: (run.stderr || "").slice(-500)});
    check("c9: stale checkpoint cleared", !Object.hasOwn(readState(repo), CHECKPOINT_STATE_KEY), Object.keys(readState(repo)));
    check("c9: task still marked complete", /^- \[x\] Do the fixture task/m.test(tasksText(repo)));
  } finally { cleanup(repo, binDir); }
}

// ── Case 8 (extra): interrupted Implementer resumes at Implementer ──
// Partial work stays in the tree; the resume must relaunch the Implementer
// (no digest comparison at that stage, no drift escalation) rather than
// skipping to Code Reviewer.
{
  const {repo, binDir} = setupMission("stage-resume-c8", "standalone_impl_interrupted", SINGLE_PHASE_TASKS);
  try {
    const run1 = await runAutopilotUntilMarker(repo, binDir, {
      request: REQUEST,
      markerFile: path.join(repo, ".autopilot", ".autopilot-test-impl-crash-marker"),
      timeoutMs: 30000,
    });
    check("c8: interrupted mid-implementer (marker kill)", run1.markerObserved && run1.killed, {markerObserved: run1.markerObserved, killed: run1.killed});
    check("c8: partial work present", fs.readFileSync(path.join(repo, "partial-work.txt"), "utf8").includes("partial implementation output"));
    const s1 = readState(repo);
    check("c8: checkpoint still waits at implementer",
      s1[CHECKPOINT_STATE_KEY]?.nextStage === "implementer", s1[CHECKPOINT_STATE_KEY]?.nextStage);
    check("c8: no drift escalation", s1.phase !== "escalated", {phase: s1.phase, step: s1.step});
    const boundary = new Date().toISOString();
    const run2 = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: MISSION_TIMEOUT_MS});
    check("c8: resume completed the mission", run2.status === 0, {status: run2.status, stderrTail: (run2.stderr || "").slice(-500)});
    const fresh = eventsAfter(repo, boundary);
    check("c8: resume relaunches the Implementer (not the Reviewer)", fresh.length > 0 && fresh[0].role === "implementer", fresh.map((e) => e.role));
    check("c8: resumed implementer received the continuation context",
      (briefForRole(repo, "implementer", 0) || "").includes("continue it rather than starting over"),
      (briefForRole(repo, "implementer", 0) || "").slice(-300));
    check("c8: partial work carried forward untouched",
      fs.readFileSync(path.join(repo, "partial-work.txt"), "utf8").includes("partial implementation output"));
    check("c8: no drift in the resumed run", !`${run2.stdout}\n${run2.stderr}`.includes("PHASE_CHECKPOINT_DRIFT"));
    check("c8: task marked complete", /^- \[x\] Do the fixture task/m.test(tasksText(repo)));
  } finally { cleanup(repo, binDir); }
}

// ── Case 10: attempts survive a process restart (double-kill proof) ──
// Run 1: reviewer infra-fails once, then hangs mid-retry → killed. The
// killed state must show attempts {implementer:1, code_reviewer:1}.
// Run 2: reviewer PASSes (attempts.reviewer 1→2 across the restart), then
// verifier hangs → killed. The killed state must show
// {implementer:1, code_reviewer:2, verifier:0} — the reviewer count
// recorded before kill #1 survived restart #1.
// Run 3: completes the mission.
{
  const {repo, binDir} = setupMission("stage-resume-c10", "standalone_attempts_survive", SINGLE_PHASE_TASKS);
  try {
    const run1 = await runAutopilotUntilMarker(repo, binDir, {
      request: REQUEST, markerFile: path.join(repo, NEVER_MARKER),
      readyWhen: () => hangStarted(repo, "code_reviewer", 2), timeoutMs: KILL_TIMEOUT_MS,
    });
    check("c10: first interruption mid-reviewer retry (ready observed, tree confirmed dead)",
      run1.readyObserved && run1.killed && run1.terminationConfirmed,
      {readyObserved: run1.readyObserved, killed: run1.killed, terminationConfirmed: run1.terminationConfirmed, timedOut: run1.timedOut});
    const s1 = readState(repo);
    check("c10: first kill lands mid-reviewer retry",
      s1[CHECKPOINT_STATE_KEY]?.runningStage === "code_reviewer", s1[CHECKPOINT_STATE_KEY]);
    check("c10: attempts recorded before the kill",
      s1[CHECKPOINT_STATE_KEY]?.attempts?.implementer === 1 && s1[CHECKPOINT_STATE_KEY]?.attempts?.code_reviewer === 1,
      s1[CHECKPOINT_STATE_KEY]?.attempts);
    const run2 = await runAutopilotUntilMarker(repo, binDir, {
      request: REQUEST, markerFile: path.join(repo, NEVER_MARKER),
      readyWhen: () => hangStarted(repo, "verifier", 1), timeoutMs: KILL_TIMEOUT_MS,
    });
    check("c10: second interruption mid-verifier (ready observed, tree confirmed dead)",
      run2.readyObserved && run2.killed && run2.terminationConfirmed,
      {readyObserved: run2.readyObserved, killed: run2.killed, terminationConfirmed: run2.terminationConfirmed, timedOut: run2.timedOut});
    const s2 = readState(repo);
    check("c10: second kill lands mid-verifier",
      s2[CHECKPOINT_STATE_KEY]?.runningStage === "verifier", s2[CHECKPOINT_STATE_KEY]);
    check("c10: reviewer attempts survived restart #1 (1→2) and implementer count persisted",
      s2[CHECKPOINT_STATE_KEY]?.attempts?.implementer === 1 &&
      s2[CHECKPOINT_STATE_KEY]?.attempts?.code_reviewer === 2 &&
      s2[CHECKPOINT_STATE_KEY]?.attempts?.verifier === 0,
      s2[CHECKPOINT_STATE_KEY]?.attempts);
    const run3 = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: MISSION_TIMEOUT_MS});
    check("c10: mission completed after resumes", run3.status === 0, {status: run3.status, stderrTail: (run3.stderr || "").slice(-500)});
    check("c10: task marked complete", /^- \[x\] Do the fixture task/m.test(tasksText(repo)));
  } finally { cleanup(repo, binDir); }
}

if (process.platform === "win32") {
  console.log("test-phase-stage-resume (SpecKit cases S1-S9): SKIP — the speckit_* scenarios exist only in the POSIX fixture (fake-workflow-adapter.sh).");
} else {

// ── S1 (SpecKit): implementer completes, stop before review → resume at Reviewer ──
{
  const {repo, binDir} = setupSpeckitMission("speckit-resume-s1", "speckit_reviewer_hang");
  try {
    const run1 = await runAutopilotUntilMarker(repo, binDir, {
      request: SPECKIT_REQUEST, markerFile: path.join(repo, NEVER_MARKER),
      readyWhen: () => hangStarted(repo, "code_reviewer", 1), timeoutMs: SPECKIT_KILL_TIMEOUT_MS,
    });
    check("s1: interrupted mid-review (ready observed, tree confirmed dead)",
      run1.readyObserved && run1.killed && run1.terminationConfirmed,
      {readyObserved: run1.readyObserved, killed: run1.killed, terminationConfirmed: run1.terminationConfirmed, timedOut: run1.timedOut});
    check("s1: implementer completed once before the kill", (roleCounts(repo).implementer || 0) === 1, roleCounts(repo));
    const s1 = readState(repo);
    check("s1: speckit checkpoint waits at code_reviewer",
      s1[CHECKPOINT_STATE_KEY]?.framework === "speckit" &&
      s1[CHECKPOINT_STATE_KEY]?.nextStage === "code_reviewer" && s1[CHECKPOINT_STATE_KEY]?.runningStage === "code_reviewer", s1[CHECKPOINT_STATE_KEY]);
    check("s1: implementer attempt recorded", s1[CHECKPOINT_STATE_KEY]?.attempts?.implementer === 1, s1[CHECKPOINT_STATE_KEY]?.attempts);
    const boundary = new Date().toISOString();
    const run2 = runAutopilot(repo, binDir, {request: SPECKIT_REQUEST, timeoutMs: SPECKIT_MISSION_TIMEOUT_MS});
    check("s1: resume completed the mission", run2.status === 0, {status: run2.status, stderrTail: (run2.stderr || "").slice(-500)});
    const fresh = eventsAfter(repo, boundary);
    check("s1: resume launches Code Reviewer first", fresh.length > 0 && fresh[0].role === "code_reviewer", fresh.map((e) => e.role));
    check("s1: Implementer launch count remains one", (roleCounts(repo).implementer || 0) === 1, roleCounts(repo));
    check("s1: task marked complete", /^- \[x\] Do the fixture task/m.test(speckitTasksText(repo)));
    check("s1: checkpoint cleared at completion", !Object.hasOwn(readState(repo), CHECKPOINT_STATE_KEY));
  } finally { cleanup(repo, binDir); }
}

// ── S2 (SpecKit): reviewer infrastructure failure retries only the Reviewer ──
{
  const {repo, binDir} = setupSpeckitMission("speckit-resume-s2", "speckit_reviewer_infra_once");
  try {
    const run = runAutopilot(repo, binDir, {request: SPECKIT_REQUEST, timeoutMs: SPECKIT_MISSION_TIMEOUT_MS});
    check("s2: mission completed", run.status === 0, {status: run.status, stderrTail: (run.stderr || "").slice(-500)});
    const counts = roleCounts(repo);
    check("s2: reviewer retried at phase level", counts.code_reviewer === 3, counts);
    check("s2: implementer ran once, verifier ran once", counts.implementer === 1 && counts.verifier === 1, counts);
    check("s2: task marked complete", /^- \[x\] Do the fixture task/m.test(speckitTasksText(repo)));
  } finally { cleanup(repo, binDir); }
}

// ── S3 (SpecKit): reviewer functional FAIL returns to Implementer with findings ──
{
  const {repo, binDir} = setupSpeckitMission("speckit-resume-s3", "speckit_reviewer_fail_once");
  try {
    const run = runAutopilot(repo, binDir, {request: SPECKIT_REQUEST, timeoutMs: SPECKIT_MISSION_TIMEOUT_MS});
    check("s3: mission completed", run.status === 0, {status: run.status, stderrTail: (run.stderr || "").slice(-500)});
    const counts = roleCounts(repo);
    check("s3: implementer ran twice", counts.implementer === 2, counts);
    check("s3: reviewer ran twice at phase level", counts.code_reviewer === 3, counts);
    check("s3: verifier ran once", counts.verifier === 1, counts);
    check("s3: retried implementer received the exact findings",
      (briefForRole(repo, "implementer", 1) || "").includes("realign the widget grid"),
      (briefForRole(repo, "implementer", 1) || "").slice(-300));
    check("s3: task marked complete", /^- \[x\] Do the fixture task/m.test(speckitTasksText(repo)));
  } finally { cleanup(repo, binDir); }
}

// ── S4 (SpecKit): verifier infrastructure failure retries only the Verifier ──
{
  const {repo, binDir} = setupSpeckitMission("speckit-resume-s4", "speckit_verifier_infra_once");
  try {
    const run = runAutopilot(repo, binDir, {request: SPECKIT_REQUEST, timeoutMs: SPECKIT_MISSION_TIMEOUT_MS});
    check("s4: mission completed", run.status === 0, {status: run.status, stderrTail: (run.stderr || "").slice(-500)});
    const counts = roleCounts(repo);
    check("s4: verifier retried (two launches)", counts.verifier === 2, counts);
    check("s4: implementer and reviewer ran once each (phase level)",
      counts.implementer === 1 && counts.code_reviewer === 2, counts);
    check("s4: task marked complete", /^- \[x\] Do the fixture task/m.test(speckitTasksText(repo)));
  } finally { cleanup(repo, binDir); }
}

// ── S5 (SpecKit): verifier functional FAIL runs Implementer, Reviewer, Verifier ──
{
  const {repo, binDir} = setupSpeckitMission("speckit-resume-s5", "speckit_verifier_fail_once");
  try {
    const run = runAutopilot(repo, binDir, {request: SPECKIT_REQUEST, timeoutMs: SPECKIT_MISSION_TIMEOUT_MS});
    check("s5: mission completed", run.status === 0, {status: run.status, stderrTail: (run.stderr || "").slice(-500)});
    // Planning launches (planner/plan_reviewer) precede implementation:
    // assert on the implementation subsequence (the trailing mission
    // final review adds one more code_reviewer after it).
    const order = readObservedEvents(repo).map((e) => e.role)
      .filter((r) => r === "implementer" || r === "code_reviewer" || r === "verifier");
    check("s5: order is Implementer, Reviewer, Verifier, then again",
      JSON.stringify(order.slice(0, 6)) === JSON.stringify(["implementer", "code_reviewer", "verifier", "implementer", "code_reviewer", "verifier"]), order);
    check("s5: retried implementer received the exact findings",
      (briefForRole(repo, "implementer", 1) || "").includes("coverage shortfall"));
    check("s5: task marked complete", /^- \[x\] Do the fixture task/m.test(speckitTasksText(repo)));
  } finally { cleanup(repo, binDir); }
}

// ── S6 (SpecKit extra): interrupted Implementer resumes at Implementer ──
// Partial work stays in the tree; the resume must relaunch the Implementer
// (no digest comparison at that stage, no drift escalation) with the
// continuation context rather than skipping to Code Reviewer.
{
  const {repo, binDir} = setupSpeckitMission("speckit-resume-s6", "speckit_impl_interrupted");
  try {
    const run1 = await runAutopilotUntilMarker(repo, binDir, {
      request: SPECKIT_REQUEST,
      markerFile: path.join(repo, ".autopilot", ".autopilot-test-impl-crash-marker"),
      timeoutMs: SPECKIT_KILL_TIMEOUT_MS,
    });
    check("s6: interrupted mid-implementer (marker kill)", run1.markerObserved && run1.killed, {markerObserved: run1.markerObserved, killed: run1.killed});
    check("s6: partial work present", fs.readFileSync(path.join(repo, "partial-work.txt"), "utf8").includes("partial implementation output"));
    const s1 = readState(repo);
    check("s6: checkpoint still waits at implementer",
      s1[CHECKPOINT_STATE_KEY]?.framework === "speckit" && s1[CHECKPOINT_STATE_KEY]?.nextStage === "implementer", s1[CHECKPOINT_STATE_KEY]?.nextStage);
    check("s6: no drift escalation", s1.phase !== "escalated", {phase: s1.phase, step: s1.step});
    const boundary = new Date().toISOString();
    const run2 = runAutopilot(repo, binDir, {request: SPECKIT_REQUEST, timeoutMs: SPECKIT_MISSION_TIMEOUT_MS});
    check("s6: resume completed the mission", run2.status === 0, {status: run2.status, stderrTail: (run2.stderr || "").slice(-500)});
    const fresh = eventsAfter(repo, boundary);
    check("s6: resume relaunches the Implementer (not the Reviewer)", fresh.length > 0 && fresh[0].role === "implementer", fresh.map((e) => e.role));
    check("s6: resumed implementer received the continuation context",
      (briefForRole(repo, "implementer", 0) || "").includes("continue it rather than starting over"),
      (briefForRole(repo, "implementer", 0) || "").slice(-300));
    check("s6: partial work carried forward untouched",
      fs.readFileSync(path.join(repo, "partial-work.txt"), "utf8").includes("partial implementation output"));
    check("s6: no drift in the resumed run", !`${run2.stdout}\n${run2.stderr}`.includes("PHASE_CHECKPOINT_DRIFT"));
    check("s6: task marked complete", /^- \[x\] Do the fixture task/m.test(speckitTasksText(repo)));
  } finally { cleanup(repo, binDir); }
}

// ── S7 (SpecKit extra): gate functional FAIL runs Implementer, Reviewer, Verifier ──
// The gate writes a Git-visible file (outside .autopilot/, which scoped
// deltas exclude) on its passing attempt: without the shared post-gate
// deltaDigest refresh, the mark_tasks gate compares a pre-gate record
// against a post-gate tree and drift-escalates — this case fails when the
// refresh is removed.
{
  const gateCommand = `if [ ! -f .autopilot/.gate-count ]; then touch .autopilot/.gate-count; exit 1; fi; printf 'gate ran\n' > gate-output.txt`;
  const {repo, binDir} = setupSpeckitMission("speckit-resume-s7", "success",
    {gatesCommands: [gateCommand], networkIsolation: false});
  try {
    const run = runAutopilot(repo, binDir, {request: SPECKIT_REQUEST, timeoutMs: SPECKIT_MISSION_TIMEOUT_MS});
    check("s7: mission completed", run.status === 0, {status: run.status, stderrTail: (run.stderr || "").slice(-500)});
    // Planning launches precede implementation — see s5.
    const order = readObservedEvents(repo).map((e) => e.role)
      .filter((r) => r === "implementer" || r === "code_reviewer" || r === "verifier");
    check("s7: order is Implementer, Reviewer, Verifier, then again",
      JSON.stringify(order.slice(0, 6)) === JSON.stringify(["implementer", "code_reviewer", "verifier", "implementer", "code_reviewer", "verifier"]), order);
    check("s7: retried implementer received the gate failure",
      (briefForRole(repo, "implementer", 1) || "").includes("Verification gate failed"),
      (briefForRole(repo, "implementer", 1) || "").slice(-300));
    check("s7: gate wrote its Git-visible output", fs.readFileSync(path.join(repo, "gate-output.txt"), "utf8").includes("gate ran"));
    check("s7: post-gate tree approved without drift", !`${run.stdout}\n${run.stderr}`.includes("speckit_checkpoint_drift"));
    check("s7: task marked complete", /^- \[x\] Do the fixture task/m.test(speckitTasksText(repo)));
  } finally { cleanup(repo, binDir); }
}

// ── S8 (SpecKit): reviewer PASS, stop before verification → resume at Verifier ──
// The harness kills the tree as soon as the verifier launch is visible on
// disk without a result; the 30s timeout remains only as a safety net for a
// launch that never appears (the 45s hang blocks completion).
{
  const {repo, binDir} = setupSpeckitMission("speckit-resume-s8", "speckit_verifier_hang");
  try {
    const run1 = await runAutopilotUntilMarker(repo, binDir, {
      request: SPECKIT_REQUEST, markerFile: path.join(repo, NEVER_MARKER),
      readyWhen: () => hangStarted(repo, "verifier", 1), timeoutMs: 30000,
    });
    check("s8: interrupted mid-verification (ready observed, tree confirmed dead)",
      run1.readyObserved && run1.killed && run1.terminationConfirmed,
      {readyObserved: run1.readyObserved, killed: run1.killed, terminationConfirmed: run1.terminationConfirmed, timedOut: run1.timedOut});
    const counts1 = roleCounts(repo);
    check("s8: implementer and reviewer completed once each", counts1.implementer === 1 && counts1.code_reviewer === 1, counts1);
    const s1 = readState(repo);
    check("s8: speckit checkpoint waits at verifier",
      s1[CHECKPOINT_STATE_KEY]?.framework === "speckit" &&
      s1[CHECKPOINT_STATE_KEY]?.nextStage === "verifier" && s1[CHECKPOINT_STATE_KEY]?.runningStage === "verifier", s1[CHECKPOINT_STATE_KEY]);
    const boundary = new Date().toISOString();
    const run2 = runAutopilot(repo, binDir, {request: SPECKIT_REQUEST, timeoutMs: SPECKIT_MISSION_TIMEOUT_MS});
    check("s8: resume completed the mission", run2.status === 0, {status: run2.status, stderrTail: (run2.stderr || "").slice(-500)});
    const fresh = eventsAfter(repo, boundary);
    check("s8: resume launches Verifier first", fresh.length > 0 && fresh[0].role === "verifier", fresh.map((e) => e.role));
    const counts = roleCounts(repo);
    check("s8: implementer and reviewer not relaunched", counts.implementer === 1 && counts.code_reviewer === 2, counts);
    check("s8: task marked complete", /^- \[x\] Do the fixture task/m.test(speckitTasksText(repo)));
  } finally { cleanup(repo, binDir); }
}

// ── S9 (SpecKit extra): verifier PASS + crash before marking resumes at mark_tasks ──
// The crash is simulated by crafting the exact checkpoint a crash would
// leave: nextStage mark_tasks with digests matching the current tree. The
// run must mark the phase with zero model launches for that revision —
// the only launch in the whole run is the mission final review.
{
  const repo = makeFixtureRepo("speckit-resume-s9");
  const binDir = makeFixtureBin("speckit-resume-s9");
  try {
    writeConfig(repo, {planningFramework: "speckit"});
    setScenario(repo, "success");
    const featureDir = path.join(repo, "specs", "001-fixture-feature");
    fs.mkdirSync(featureDir, {recursive: true});
    fs.writeFileSync(path.join(featureDir, "tasks.md"), "## Phase 1: General\n\n- [ ] Do the fixture task\n");
    const mission = "001-fixture-feature";
    const missionKey = `mission-${sanitizeKeySegment(mission)}`;
    const phase0Key = `${missionKey}-phase-0`;
    ensureBaseline(repo, missionKey, {mission, declaredPaths: []});
    ensureBaseline(repo, phase0Key, {mission, declaredPaths: []});
    const phases = speckitPhases(repo, ["specs/*/tasks.md"]);
    const phase0Tasks = phases[0].tasks.map((t) => ({file: t.file, text: t.text}));
    const taskDigest = phaseTaskDigest({
      framework: "speckit", mission, phaseIndex: 0,
      phaseName: phases[0].name, tasks: phase0Tasks, repoRoot: repo,
    });
    const fullDelta = scopedDelta(repo, phase0Key, {mission, declaredPaths: []});
    writeState(repo, {
      version: 1, phase: "implementing", step: "verify",
      phaseIndex: 0, attempt: 2, mission, planningRequest: SPECKIT_REQUEST,
      [CHECKPOINT_STATE_KEY]: {
        version: 1, framework: "speckit", mission, phaseIndex: 0,
        phaseName: phases[0].name, phaseTaskDigest: taskDigest, revision: 1,
        nextStage: "mark_tasks", runningStage: null,
        attempts: {implementer: 1, code_reviewer: 1, verifier: 1},
        baselineKey: phase0Key, deltaDigest: deltaDigest(fullDelta),
        implementer: {runId: null, summary: "crafted implementer report"},
        codeReviewer: {runId: null, decision: "PASS", findings: []},
        verifier: {runId: null, decision: "PASS", findings: []},
        updatedAt: new Date().toISOString(),
      },
    });
    const run = runAutopilot(repo, binDir, {request: SPECKIT_REQUEST, timeoutMs: SPECKIT_MISSION_TIMEOUT_MS});
    check("s9: mission completed", run.status === 0, {status: run.status, stderrTail: (run.stderr || "").slice(-500)});
    check("s9: crashed phase marked without relaunch", /^- \[x\] Do the fixture task/m.test(speckitTasksText(repo)), speckitTasksText(repo));
    const counts = roleCounts(repo);
    check("s9: zero model launches for the resumed revision (only the mission final review launched)",
      (counts.implementer || 0) === 0 && counts.code_reviewer === 1 && (counts.verifier || 0) === 0, counts);
    check("s9: checkpoint cleared at completion", !Object.hasOwn(readState(repo), CHECKPOINT_STATE_KEY));
  } finally { cleanup(repo, binDir); }
}

} // end SpecKit guard

// ── Gate bypass confirmations (TASK-11 Phase 6, task 13) ──
// One real run per evaluator action proving runImplementation calls the
// shared evaluator at the s.phase allowlist gate and honors the returned
// action. G1/G3 mirror the task14-B and c7 shapes through the GATE (a
// non-allowlisted s.phase) rather than the in-loop gate.
// ── G1: valid checkpoint + escalated phase resumes WITHOUT planning ──
if (process.platform !== "win32") {
  {
    const repo = makeFixtureRepo("gate-bypass-g1");
    const binDir = makeFixtureBin("gate-bypass-g1");
    try {
      makeSpecKitPhaseFixture(repo);
      writeConfig(repo, {planningFramework: "speckit", failureBudgets: {implementationFailureBudget: 1}});
      setScenario(repo, "task14_review_always_fail");
      const failedRun = runAutopilot(repo, binDir, {request: SPECKIT_REQUEST, timeoutMs: SPECKIT_MISSION_TIMEOUT_MS});
      check("g1: failing mission escalates", failedRun.status !== 0 && readState(repo).phase === "escalated");
      setScenario(repo, "success");
      const boundary = new Date().toISOString();
      const resumed = runAutopilot(repo, binDir, {request: "", timeoutMs: SPECKIT_MISSION_TIMEOUT_MS});
      check("g1: resumed mission completes", resumed.status === 0, {status: resumed.status, stderrTail: (resumed.stderr || "").slice(-500)});
      const fresh = eventsAfter(repo, boundary);
      check("g1: resume skipped planning (no planner/plan_reviewer launches)",
        !fresh.some((e) => e.role === "planner" || e.role === "plan_reviewer"), fresh.map((e) => e.role));
      check("g1: task marked complete", /^- \[x\] Do the fixture task/m.test(speckitTasksText(repo)));
      check("g1: mission reaches phase=complete", readState(repo).phase === "complete");
    } finally { cleanup(repo, binDir); }
  }
}

// ── G2: structurally invalid checkpoint escalates, never plans ──
{
  const {repo, binDir} = setupMission("gate-bypass-g2", "success", SINGLE_PHASE_TASKS);
  try {
    writeState(repo, {
      version: 1, phase: "escalated", step: "implement",
      phaseIndex: 0, attempt: 2, mission: MISSION, planningRequest: REQUEST,
      [CHECKPOINT_STATE_KEY]: {version: 99, framework: "standalone", mission: MISSION, phaseIndex: 0},
    });
    const boundary = new Date().toISOString();
    const run = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: MISSION_TIMEOUT_MS});
    check("g2: invalid checkpoint escalates", run.status !== 0, {status: run.status});
    check("g2: INVALID evidence recorded", readState(repo).phaseCheckpointError?.code === "PHASE_CHECKPOINT_INVALID", readState(repo).phaseCheckpointError);
    const fresh = eventsAfter(repo, boundary);
    check("g2: nothing launched (no planning, no roles)", fresh.length === 0, fresh.map((e) => e.role));
  } finally { cleanup(repo, binDir); }
}

// ── G3: drifted approval-reuse checkpoint escalates at the gate ──
// Valid structure with a task digest matching the tree but a delta digest
// that does not: the gate must refuse before any role launches.
{
  const repo = makeFixtureRepo("gate-bypass-g3");
  const binDir = makeFixtureBin("gate-bypass-g3");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    setScenario(repo, "success");
    writeStandaloneMission(repo, SINGLE_PHASE_TASKS);
    const missionKey = `mission-${sanitizeKeySegment(MISSION)}`;
    const phase0Key = `${missionKey}-phase-0`;
    ensureBaseline(repo, missionKey, {mission: MISSION, declaredPaths: []});
    ensureBaseline(repo, phase0Key, {mission: MISSION, declaredPaths: []});
    const phases = standalone.phases(repo, MISSION);
    const taskDigest = phaseTaskDigest({
      framework: "standalone", mission: MISSION, phaseIndex: 0,
      phaseName: phases[0].name,
      tasks: phases[0].tasks.map((t) => ({file: t.file, text: t.text})),
      repoRoot: repo,
    });
    writeState(repo, {
      version: 1, phase: "escalated", step: "implement",
      phaseIndex: 0, attempt: 2, mission: MISSION, planningRequest: REQUEST,
      [CHECKPOINT_STATE_KEY]: {
        version: 1, framework: "standalone", mission: MISSION, phaseIndex: 0,
        phaseName: phases[0].name, phaseTaskDigest: taskDigest, revision: 1,
        nextStage: "code_reviewer", runningStage: null,
        attempts: {implementer: 1, code_reviewer: 0, verifier: 0},
        baselineKey: phase0Key, deltaDigest: deltaDigest("drifted-tree"),
        implementer: {runId: null, summary: "stale implementer report"},
        codeReviewer: null, verifier: null,
        updatedAt: new Date().toISOString(),
      },
    });
    const boundary = new Date().toISOString();
    const run = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: MISSION_TIMEOUT_MS});
    check("g3: drifted checkpoint escalates", run.status !== 0, {status: run.status});
    check("g3: DRIFT evidence recorded", readState(repo).phaseCheckpointError?.code === "PHASE_CHECKPOINT_DRIFT", readState(repo).phaseCheckpointError);
    const fresh = eventsAfter(repo, boundary);
    check("g3: nothing launched (no planning, no roles)", fresh.length === 0, fresh.map((e) => e.role));
  } finally { cleanup(repo, binDir); }
}

// ── G4: all-checked stale checkpoint plans (today's route) and completes ──
// The gate returns plan — neither resume nor escalate — so the mission
// flows through planning as today, then the no-pending path marks nothing
// (already marked) and completes via final review.
{
  const repo = makeFixtureRepo("gate-bypass-g4");
  const binDir = makeFixtureBin("gate-bypass-g4");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    setScenario(repo, "success");
    writeStandaloneMission(repo, "## Phase 1: General\n\n- [x] Do the fixture task\n");
    const missionKey = `mission-${sanitizeKeySegment(MISSION)}`;
    ensureBaseline(repo, missionKey, {mission: MISSION, declaredPaths: []});
    const phases = standalone.phases(repo, MISSION);
    writeState(repo, {
      version: 1, phase: "escalated", step: "implement",
      phaseIndex: 0, attempt: 2, mission: MISSION, planningRequest: REQUEST,
      [CHECKPOINT_STATE_KEY]: {
        version: 1, framework: "standalone", mission: MISSION, phaseIndex: 0,
        phaseName: phases[0].name,
        phaseTaskDigest: phaseTaskDigest({
          framework: "standalone", mission: MISSION, phaseIndex: 0,
          phaseName: phases[0].name,
          tasks: phases[0].tasks.map((t) => ({file: t.file, text: t.text})),
          repoRoot: repo,
        }),
        revision: 1, nextStage: "mark_tasks", runningStage: null,
        attempts: {implementer: 1, code_reviewer: 1, verifier: 1},
        baselineKey: `${missionKey}-phase-0`, deltaDigest: deltaDigest(""),
        implementer: {runId: null, summary: "stale crafted report"},
        codeReviewer: {runId: null, decision: "PASS", findings: []},
        verifier: {runId: null, decision: "PASS", findings: []},
        updatedAt: new Date().toISOString(),
      },
    });
    const run = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: MISSION_TIMEOUT_MS});
    check("g4: all-checked mission completes via planning", run.status === 0, {status: run.status, stderrTail: (run.stderr || "").slice(-500)});
    check("g4: stale checkpoint cleared", !Object.hasOwn(readState(repo), CHECKPOINT_STATE_KEY), Object.keys(readState(repo)));
    check("g4: task still marked complete", /^- \[x\] Do the fixture task/m.test(tasksText(repo)));
  } finally { cleanup(repo, binDir); }
}

// ── G7: mark_tasks resume whose delta drifted escalates instead of marking ──
// A crafted post-Verifier checkpoint whose recorded delta no longer matches
// the tree (edits landed after the Verifier PASS). Both the in-loop mark
// gate (s.phase=implementing) and the allowlist-gate bypass (s.phase=
// escalated) must refuse with drift evidence, launch nothing, and leave
// the task unchecked.
{
  for (const [tag, phase] of [["in-loop", "implementing"], ["gate", "escalated"]]) {
    const repo = makeFixtureRepo(`gate-bypass-g7-${tag}`);
    const binDir = makeFixtureBin(`gate-bypass-g7-${tag}`);
    try {
      writeConfig(repo, {planningFramework: "standalone"});
      setScenario(repo, "success");
      writeStandaloneMission(repo, SINGLE_PHASE_TASKS);
      const missionKey = `mission-${sanitizeKeySegment(MISSION)}`;
      const phase0Key = `${missionKey}-phase-0`;
      ensureBaseline(repo, missionKey, {mission: MISSION, declaredPaths: []});
      ensureBaseline(repo, phase0Key, {mission: MISSION, declaredPaths: []});
      const phases = standalone.phases(repo, MISSION);
      writeState(repo, {
        version: 1, phase, step: "verify",
        phaseIndex: 0, attempt: 2, mission: MISSION, planningRequest: REQUEST,
        [CHECKPOINT_STATE_KEY]: {
          version: 1, framework: "standalone", mission: MISSION, phaseIndex: 0,
          phaseName: phases[0].name,
          phaseTaskDigest: phaseTaskDigest({
            framework: "standalone", mission: MISSION, phaseIndex: 0,
            phaseName: phases[0].name,
            tasks: phases[0].tasks.map((t) => ({file: t.file, text: t.text})),
            repoRoot: repo,
          }),
          revision: 1, nextStage: "mark_tasks", runningStage: null,
          attempts: {implementer: 1, code_reviewer: 1, verifier: 1},
          baselineKey: phase0Key, deltaDigest: deltaDigest("tampered-after-pass"),
          implementer: {runId: null, summary: "stale implementer report"},
          codeReviewer: {runId: null, decision: "PASS", findings: []},
          verifier: {runId: null, decision: "PASS", findings: []},
          updatedAt: new Date().toISOString(),
        },
      });
      const run = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: MISSION_TIMEOUT_MS});
      check(`g7(${tag}): drifted mark_tasks escalates`, run.status !== 0, {status: run.status});
      check(`g7(${tag}): DRIFT evidence recorded`, readState(repo).phaseCheckpointError?.code === "PHASE_CHECKPOINT_DRIFT", readState(repo).phaseCheckpointError);
      check(`g7(${tag}): task left unchecked (not marked)`, /^- \[ \] Do the fixture task/m.test(tasksText(repo)));
      const counts = roleCounts(repo);
      check(`g7(${tag}): nothing launched for the drifted revision`,
        (counts.implementer || 0) === 0 && (counts.code_reviewer || 0) === 0 && (counts.verifier || 0) === 0, counts);
    } finally { cleanup(repo, binDir); }
  }
}

// ── G5: checkpoint for a nonexistent phase escalates, never resumes ──
// A crafted checkpoint bound to phase 99 (one-phase mission) whose digest
// represents the empty task list is structurally valid — and both state
// and checkpoint are aligned on 99, so the pre-existing phase-mismatch
// check cannot fire. Without the phase-existence guard the gate would
// resume (the empty-list digest matches), the phase loop body would never
// execute for the out-of-range index, and the mission would complete with
// the task still unchecked. The gate must fail it closed first.
{
  const repo = makeFixtureRepo("gate-bypass-g5");
  const binDir = makeFixtureBin("gate-bypass-g5");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    setScenario(repo, "success");
    writeStandaloneMission(repo, SINGLE_PHASE_TASKS);
    const missionKey = `mission-${sanitizeKeySegment(MISSION)}`;
    // Baselines exist so that, without the existence guard, the run reaches
    // final review and completes with the task unchecked (the reported
    // defect) instead of dying earlier on a missing baseline.
    ensureBaseline(repo, missionKey, {mission: MISSION, declaredPaths: []});
    writeState(repo, {
      version: 1, phase: "escalated", step: "implement",
      phaseIndex: 99, attempt: 1, mission: MISSION, planningRequest: REQUEST,
      [CHECKPOINT_STATE_KEY]: {
        version: 1, framework: "standalone", mission: MISSION, phaseIndex: 99,
        phaseName: "Phase 99",
        phaseTaskDigest: phaseTaskDigest({
          framework: "standalone", mission: MISSION, phaseIndex: 99,
          phaseName: "Phase 99", tasks: [], repoRoot: repo,
        }),
        revision: 1, nextStage: "implementer", runningStage: null,
        attempts: {implementer: 0, code_reviewer: 0, verifier: 0},
        baselineKey: `${missionKey}-phase-99`, deltaDigest: null,
        implementer: null, codeReviewer: null, verifier: null,
        updatedAt: new Date().toISOString(),
      },
    });
    const boundary = new Date().toISOString();
    const run = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: MISSION_TIMEOUT_MS});
    check("g5: nonexistent-phase checkpoint escalates", run.status !== 0, {status: run.status});
    check("g5: INVALID evidence recorded", readState(repo).phaseCheckpointError?.code === "PHASE_CHECKPOINT_INVALID", readState(repo).phaseCheckpointError);
    check("g5: task still unchecked (no silent completion)", /^- \[ \] Do the fixture task/m.test(tasksText(repo)));
    const fresh = eventsAfter(repo, boundary);
    check("g5: nothing launched (no planning, no roles)", fresh.length === 0, fresh.map((e) => e.role));
  } finally { cleanup(repo, binDir); }
}

// ── G6: checkpoint baseline key must equal the authority-derived key ──
// The persisted key is comparison data only: a mismatch — including a
// traversal-shaped key — fails INVALID before any approval is reused, and
// the untrusted string never reaches the filesystem (the delta is computed
// against the derived key).
{
  for (const tag of ["mismatch", "traversal"]) {
    const repo = makeFixtureRepo(`gate-bypass-g6-${tag}`);
    const binDir = makeFixtureBin(`gate-bypass-g6-${tag}`);
    try {
      writeConfig(repo, {planningFramework: "standalone"});
      setScenario(repo, "success");
      writeStandaloneMission(repo, SINGLE_PHASE_TASKS);
      const missionKey = `mission-${sanitizeKeySegment(MISSION)}`;
      const phase0Key = `${missionKey}-phase-0`;
      ensureBaseline(repo, missionKey, {mission: MISSION, declaredPaths: []});
      ensureBaseline(repo, phase0Key, {mission: MISSION, declaredPaths: []});
      const evilKeys = {mismatch: `${missionKey}-phase-1`, traversal: "../../evil-baseline"};
      const evilKey = evilKeys[tag];
      const phases = standalone.phases(repo, MISSION);
      writeState(repo, {
        version: 1, phase: "escalated", step: "implement",
        phaseIndex: 0, attempt: 2, mission: MISSION, planningRequest: REQUEST,
        [CHECKPOINT_STATE_KEY]: {
          version: 1, framework: "standalone", mission: MISSION, phaseIndex: 0,
          phaseName: phases[0].name,
          phaseTaskDigest: phaseTaskDigest({
            framework: "standalone", mission: MISSION, phaseIndex: 0,
            phaseName: phases[0].name,
            tasks: phases[0].tasks.map((t) => ({file: t.file, text: t.text})),
            repoRoot: repo,
          }),
          revision: 1, nextStage: "code_reviewer", runningStage: null,
          attempts: {implementer: 1, code_reviewer: 0, verifier: 0},
          baselineKey: evilKey, deltaDigest: deltaDigest("recorded-delta"),
          implementer: {runId: null, summary: "stale implementer report"},
          codeReviewer: null, verifier: null,
          updatedAt: new Date().toISOString(),
        },
      });
      const boundary = new Date().toISOString();
      const run = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: MISSION_TIMEOUT_MS});
      check(`g6(${tag}): foreign baseline key escalates`, run.status !== 0, {status: run.status});
      check(`g6(${tag}): INVALID evidence recorded`, readState(repo).phaseCheckpointError?.code === "PHASE_CHECKPOINT_INVALID", readState(repo).phaseCheckpointError);
      const fresh = eventsAfter(repo, boundary);
      check(`g6(${tag}): nothing launched (no planning, no roles)`, fresh.length === 0, fresh.map((e) => e.role));
    } finally { cleanup(repo, binDir); }
  }
}

console.log(failures === 0 ? "\nAll phase-stage resume cases passed" : `\n${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
