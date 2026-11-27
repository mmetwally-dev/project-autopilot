#!/usr/bin/env node
// Test for Backlog #3:
// Resuming an escalated mission with `ap run` clears state.phase="escalated"
// before launching the first role run.
// Asserts state.phase !== "escalated" and matches the active resumed stage
// ("planning" for planning-stage cases; "implementing" for implementation-stage cases).

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {
  makeFixtureRepo, makeFixtureBin, makeSpecKitPhaseFixture, makeClaudeMdBaseline,
  writeConfig, setScenario, runAutopilotUntilMarker, hangStarted, cleanup,
} from "./test-fixtures/workflow-order-harness.mjs";
import {ensureBaseline, scopedDelta, sanitizeKeySegment} from "./implementation-baseline.mjs";
import {phaseTaskDigest, deltaDigest, CHECKPOINT_STATE_KEY} from "./phase-stage-checkpoint.mjs";
import * as standalone from "../adapters/standalone.mjs";

const REQUEST = "fixture request";
const SPECKIT_REQUEST = "implement the fixture task";
const MISSION = "001-backlog-3-resume";
const KILL_TIMEOUT_MS = 20000;
const NEVER_MARKER = ".autopilot-test-never-appears";
const SINGLE_PHASE_TASKS = "## Phase 1: General\n\n- [ ] **1.1** Do the fixture task — accept: done ; verify: true\n";

function writeState(repo, state) {
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(state, null, 2));
}

function readState(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
}

console.log("Starting test-backlog-3-escalated-resume-phase...");

// ---------------------------------------------------------------------------
// Case 1: SpecKit planning-stage resume from escalated state
// (step: review-plan after PLAN_REVIEW_CAPPED_TWICE)
// ---------------------------------------------------------------------------
{
  const repo = makeFixtureRepo("b3-speckit-planning");
  const binDir = makeFixtureBin("b3-speckit-planning");
  try {
    makeSpecKitPhaseFixture(repo);
    writeConfig(repo, {planningFramework: "speckit"});
    setScenario(repo, "plan_reviewer_hang");

    const featureDir = path.join(repo, "specs", "001-fixture-feature");
    fs.mkdirSync(featureDir, {recursive: true});
    fs.writeFileSync(path.join(featureDir, "spec.md"), "# Spec\n\nFixture specification.\n");
    fs.writeFileSync(path.join(featureDir, "plan.md"), "# Plan\n\nFixture plan.\n");
    makeClaudeMdBaseline(repo);

    writeState(repo, {
      version: 1,
      phase: "escalated",
      step: "review-plan",
      planningStepIndex: 3,
      mission: "001-fixture-feature",
      speckitFeatureDir: "001-fixture-feature",
      planningRequest: SPECKIT_REQUEST,
      phaseCheckpointError: {
        code: "PLAN_REVIEW_CAPPED_TWICE",
        evidence: {role: "plan_reviewer", scope: "task:speckit:planning:plan_reviewer", sessions: 2}
      }
    });

    let observedPhaseAtLaunch = null;
    let observedStepAtLaunch = null;

    const run = await runAutopilotUntilMarker(repo, binDir, {
      request: "",
      markerFile: path.join(repo, NEVER_MARKER),
      readyWhen: () => {
        if (hangStarted(repo, "plan_reviewer", 1)) {
          const st = readState(repo);
          observedPhaseAtLaunch = st.phase;
          observedStepAtLaunch = st.step;
          return true;
        }
        return false;
      },
      timeoutMs: KILL_TIMEOUT_MS,
    });

    assert.equal(run.readyObserved, true, "plan_reviewer launch was observed while running");
    assert.notEqual(observedPhaseAtLaunch, "escalated", "state.phase is not 'escalated' when plan_reviewer launches");
    assert.equal(observedPhaseAtLaunch, "planning", "state.phase is 'planning' when plan_reviewer launches");
    assert.equal(observedStepAtLaunch, "review-plan", "state.step is the resumed stage step (review-plan)");
    console.log("PASS: Case 1 - SpecKit planning-stage resume sets phase='planning' before plan_reviewer launch");
  } finally {
    cleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------------
// Case 2: Standalone planning-stage resume from escalated state
// ---------------------------------------------------------------------------
{
  const repo = makeFixtureRepo("b3-standalone-planning");
  const binDir = makeFixtureBin("b3-standalone-planning");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    setScenario(repo, "plan_reviewer_hang");

    const planFile = standalone.planPath(repo, MISSION);
    const tasksFile = standalone.tasksPath(repo, MISSION);
    fs.mkdirSync(path.dirname(planFile), {recursive: true});
    fs.writeFileSync(planFile, "# Plan\n\nObjective: fixture task.\n");
    fs.writeFileSync(tasksFile, SINGLE_PHASE_TASKS);

    writeState(repo, {
      version: 1,
      phase: "escalated",
      step: "standalone_planning_not_converging",
      mission: MISSION,
      planningRequest: REQUEST,
      phaseCheckpointError: {
        code: "PLAN_REVIEW_CAPPED_TWICE",
        evidence: {role: "plan_reviewer"}
      }
    });

    let observedPhaseAtLaunch = null;

    const run = await runAutopilotUntilMarker(repo, binDir, {
      request: "",
      markerFile: path.join(repo, NEVER_MARKER),
      readyWhen: () => {
        if (hangStarted(repo, "plan_reviewer", 1)) {
          const st = readState(repo);
          observedPhaseAtLaunch = st.phase;
          return true;
        }
        return false;
      },
      timeoutMs: KILL_TIMEOUT_MS,
    });

    assert.equal(run.readyObserved, true, "plan_reviewer launch was observed while running");
    assert.notEqual(observedPhaseAtLaunch, "escalated", "state.phase is not 'escalated' when standalone plan_reviewer launches");
    assert.equal(observedPhaseAtLaunch, "planning", "state.phase is 'planning' when standalone plan_reviewer launches");
    console.log("PASS: Case 2 - Standalone planning-stage resume sets phase='planning' before plan_reviewer launch");
  } finally {
    cleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------------
// Case 3: Implementation-stage resume from escalated state
// (phase checkpoint at code_reviewer stage)
// ---------------------------------------------------------------------------
{
  const repo = makeFixtureRepo("b3-standalone-impl");
  const binDir = makeFixtureBin("b3-standalone-impl");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    setScenario(repo, "standalone_reviewer_hang");

    const planFile = standalone.planPath(repo, MISSION);
    const tasksFile = standalone.tasksPath(repo, MISSION);
    fs.mkdirSync(path.dirname(planFile), {recursive: true});
    fs.writeFileSync(planFile, "# Plan\n\nObjective: fixture task.\n");
    fs.writeFileSync(tasksFile, SINGLE_PHASE_TASKS);

    const phases = standalone.phases(repo, MISSION);
    const taskDigest = phaseTaskDigest({
      framework: "standalone",
      mission: MISSION,
      phaseIndex: 0,
      phaseName: phases[0].name,
      tasks: phases[0].tasks.map((t) => ({file: t.file, text: t.text})),
      repoRoot: repo,
    });
    const missionKey = `mission-${sanitizeKeySegment(MISSION)}`;
    const phase0Key = `${missionKey}-phase-0`;
    const declaredPaths = standalone.declaredDeliverables(repo, MISSION);
    ensureBaseline(repo, missionKey, {mission: MISSION, declaredPaths});
    ensureBaseline(repo, phase0Key, {mission: MISSION, declaredPaths: []});
    fs.mkdirSync(path.join(repo, "output"), {recursive: true});
    fs.writeFileSync(path.join(repo, "output", "task1.txt"), "task 1 output\n");
    const dDigest = deltaDigest(scopedDelta(repo, phase0Key, {mission: MISSION, declaredPaths: []}));

    writeState(repo, {
      version: 1,
      phase: "escalated",
      step: "code_review",
      phaseIndex: 0,
      attempt: 2,
      mission: MISSION,
      planningRequest: REQUEST,
      [CHECKPOINT_STATE_KEY]: {
        version: 1,
        framework: "standalone",
        mission: MISSION,
        phaseIndex: 0,
        phaseName: phases[0].name,
        phaseTaskDigest: taskDigest,
        revision: 1,
        nextStage: "code_reviewer",
        runningStage: null,
        attempts: {implementer: 1, code_reviewer: 1, verifier: 0},
        baselineKey: phase0Key,
        deltaDigest: dDigest,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    });

    let observedPhaseAtLaunch = null;
    let observedStepAtLaunch = null;

    const run = await runAutopilotUntilMarker(repo, binDir, {
      request: "",
      markerFile: path.join(repo, NEVER_MARKER),
      readyWhen: () => {
        if (hangStarted(repo, "code_reviewer", 1)) {
          const st = readState(repo);
          observedPhaseAtLaunch = st.phase;
          observedStepAtLaunch = st.step;
          return true;
        }
        return false;
      },
      timeoutMs: KILL_TIMEOUT_MS,
    });

    if (!run.readyObserved) {
      console.error("Case 3 failed:", {
        status: run.status,
        timedOut: run.timedOut,
        stdout: run.stdout,
        stderr: run.stderr,
        state: readState(repo),
      });
    }
    assert.equal(run.readyObserved, true, "code_reviewer launch was observed while running");
    assert.notEqual(observedPhaseAtLaunch, "escalated", "state.phase is not 'escalated' when code_reviewer launches");
    assert.equal(observedPhaseAtLaunch, "implementing", "state.phase is 'implementing' when code_reviewer launches");
    assert.equal(observedStepAtLaunch, "code_review", "state.step is the resumed stage step (code_review)");
    console.log("PASS: Case 3 - Implementation-stage resume sets phase='implementing' before code_reviewer launch");
  } finally {
    cleanup(repo, binDir);
  }
}

console.log("All test-backlog-3-escalated-resume-phase checks passed.");
