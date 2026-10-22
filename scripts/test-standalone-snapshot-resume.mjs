#!/usr/bin/env node
// Phase 1 task 3 — caller-level standalone snapshot resume (end-to-end).
//
// Drives the CLI as a subprocess (`node scripts/autopilot.mjs run --repo <temp-repo>`)
// against a crafted `.autopilot/state.json` whose `s.phase` is an allowed value
// (`implementing`) and which carries a valid `pendingStandaloneCheckboxSnapshot`,
// with the mission's PLAN.md and TASKS.md present in the temp repo.
//
// Asserts:
//   (a) the run clears the snapshot and proceeds, with no
//       `Cannot read properties of undefined (reading 'map')` TypeError from
//       `runStandaloneImplementation` (the crash when validateStandaloneSnapshot
//       returned a bare `{ok:true}` with no `tasks`);
//   (b) a snapshot plus an appended extra checkbox escalates
//       (`standalone_appended_task_tampering`) rather than throwing.
//
// This subprocess route is the only one that exercises the crashing caller:
// `scripts/autopilot.mjs` runs `main()` at import, so the reconcile sequence
// cannot be imported and unit-tested, and a fixture that re-implements the
// caller would prove the fixture rather than the code.
//
// Fail-before property (established once by convention): revert the one-line
// validator fix (`tasks: snapshot.tasks` -> bare `{ok:true}`), observe this
// test fail (TypeError, snapshot never cleared), then restore it.
import fs from "node:fs";
import path from "node:path";
import {
  makeFixtureRepo, makeFixtureBin, writeConfig, setScenario,
  runAutopilot, readObservedEvents, cleanup
} from "./test-fixtures/workflow-order-harness.mjs";
import {ensureBaseline, sanitizeKeySegment} from "./implementation-baseline.mjs";
import * as standalone from "../adapters/standalone.mjs";

const REQUEST = "fixture request";
const TIMEOUT_MS = process.platform === "win32" ? 220000 : 90000;
const TYPE_ERROR = "Cannot read properties of undefined (reading 'map')";

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

function writeStandaloneMission(repo, mission, tasksContent) {
  const planFile = standalone.planPath(repo, mission);
  const tasksFile = standalone.tasksPath(repo, mission);
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

// (a) Valid snapshot resumes: cleared, no TypeError, mission proceeds.
{
  const mission = "001-snap-resume";
  const repo = makeFixtureRepo("snap-resume-valid");
  const binDir = makeFixtureBin("snap-resume-valid");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    setScenario(repo, "success");
    const tasksContent = "## Phase 1: General\n\n- [ ] Do the fixture task\n";
    const {tasksFile} = writeStandaloneMission(repo, mission, tasksContent);
    const tasks = [{file: tasksFile, line: 3, text: "Do the fixture task", done: false}];
    // Pre-create the mission baseline: with s.phase === "implementing" the
    // historical-baseline branch cannot safely create one (it requires
    // tasks_ready + all-undone + no-snapshot), so the fixture provides it —
    // the same idempotent ensureBaseline() the loop itself would reuse.
    ensureBaseline(repo, `mission-${sanitizeKeySegment(mission)}`, {mission, declaredPaths: []});
    writeState(repo, {
      version: 1, phase: "implementing", step: "implement",
      phaseIndex: 0, attempt: 1, mission, planningRequest: REQUEST,
      pendingStandaloneCheckboxSnapshot: {feature: null, mission, tasks, capturedAt: new Date().toISOString()}
    });
    const run = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: TIMEOUT_MS});
    const combined = `${run.stdout}\n${run.stderr}`;
    check("valid snapshot: no TypeError from runStandaloneImplementation", !combined.includes(TYPE_ERROR), combined.slice(-2000));
    let after = null;
    try { after = readState(repo); } catch (e) { check("valid snapshot: state.json readable after run", false, String(e)); }
    if (after) {
      check("valid snapshot: pending snapshot cleared", !Object.hasOwn(after, "pendingStandaloneCheckboxSnapshot"), Object.keys(after));
    }
    const events = readObservedEvents(repo);
    check("valid snapshot: implementer launched (run proceeded past reconcile)", events.some(e => e.role === "implementer"), events.map(e => e.role));
    // Full completion requires read-only containment (bubblewrap on Linux/WSL)
    // for code_reviewer/verifier; on plain Windows the run deterministically
    // stops there. Branch explicitly by platform so Linux/WSL must prove full
    // completion and cannot falsely pass on a containment error.
    if (process.platform !== "win32") {
      check("valid snapshot: run completed", run.status === 0, {status: run.status, stdoutTail: run.stdout.slice(-800), stderrTail: run.stderr.slice(-800)});
    } else {
      check("valid snapshot: Windows stops at read-only containment",
        run.status !== 0 && /READ_ONLY_CONTAINMENT_UNAVAILABLE|bubblewrap_requires_linux/.test(combined), {status: run.status, stderrTail: run.stderr.slice(-500)});
    }
  } finally { cleanup(repo, binDir); }
}

// (b) Snapshot + appended extra checkbox escalates rather than throwing.
{
  const mission = "001-snap-tamper";
  const repo = makeFixtureRepo("snap-resume-tamper");
  const binDir = makeFixtureBin("snap-resume-tamper");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    setScenario(repo, "success");
    const tasksContent = "## Phase 1: General\n\n- [ ] Do the fixture task\n- [ ] Appended sneaky task\n";
    const {tasksFile} = writeStandaloneMission(repo, mission, tasksContent);
    // Snapshot covers only the original task; the on-disk file carries one
    // extra checkbox appended after the snapshot was captured.
    const tasks = [{file: tasksFile, line: 3, text: "Do the fixture task", done: false}];
    ensureBaseline(repo, `mission-${sanitizeKeySegment(mission)}`, {mission, declaredPaths: []});
    writeState(repo, {
      version: 1, phase: "implementing", step: "implement",
      phaseIndex: 0, attempt: 1, mission, planningRequest: REQUEST,
      pendingStandaloneCheckboxSnapshot: {feature: null, mission, tasks, capturedAt: new Date().toISOString()}
    });
    const run = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: TIMEOUT_MS});
    const combined = `${run.stdout}\n${run.stderr}`;
    check("tamper: no TypeError (escalates instead of throwing)", !combined.includes(TYPE_ERROR), combined.slice(-2000));
    check("tamper: run did not succeed", run.status !== 0, run.status);
    check("tamper: appended-task tampering reported", /Appended task tampering detected/.test(combined), combined.slice(-2000));
    let after = null;
    try { after = readState(repo); } catch (e) { check("tamper: state.json readable after run", false, String(e)); }
    if (after) {
      check("tamper: escalated", after.phase === "escalated", after.phase);
      check("tamper: tampering step", after.step === "standalone_appended_task_tampering", after.step);
    }
  } finally { cleanup(repo, binDir); }
}

console.log(failures === 0 ? "\nAll snapshot-resume cases passed" : `\n${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
