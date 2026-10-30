#!/usr/bin/env node
// Mission 093 Part 1 task 3.3: integration test for operator event emission via CLI commands.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ensureBaseline, sanitizeKeySegment } from "./implementation-baseline.mjs";
import { phaseTaskDigest, deltaDigest, CHECKPOINT_STATE_KEY } from "./phase-stage-checkpoint.mjs";
import * as standalone from "../adapters/standalone.mjs";
import { resolveAgentBinary } from "./agent-process.mjs";
import { makeFixtureRepo, makeFixtureBin, writeConfig, setScenario, runAutopilot, runAutopilotUntilMarker, cleanup } from "./test-fixtures/workflow-order-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const readLines = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
const parseLines = (file) => readLines(file).map(JSON.parse);

function findMissionDir(repo) {
  const missionsRoot = path.join(repo, ".autopilot", "missions");
  if (!fs.existsSync(missionsRoot)) return null;
  const dirs = fs.readdirSync(missionsRoot, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => path.join(missionsRoot, d.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return dirs[0] || null;
}

function runApCommand(repo, binDir, args) {
  const delimiter = process.platform === "win32" ? ";" : ":";
  const baseEnv = { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH || ""}` };
  return spawnSync(process.execPath, [
    path.join(skillRoot, "scripts", "autopilot.mjs"), ...args, "--repo", repo
  ], { cwd: repo, encoding: "utf8", env: baseEnv, timeout: 30000, shell: false });
}

async function runTest() {
  console.log("Test 1: ap stop emits operator stop event on live mission");

  const repo1 = makeFixtureRepo("ops-stop");
  const binDir1 = makeFixtureBin("ops-stop");
  try {
    writeConfig(repo1, { planningFramework: "standalone", gatesCommands: ["true"] });
    setScenario(repo1, "standalone_impl_interrupted"); // Creates marker and sleeps during implementer
    
    // Start a run that will pause at the marker
    const markerFile = path.join(repo1, ".autopilot", ".autopilot-test-impl-crash-marker");
    const runPromise = runAutopilotUntilMarker(repo1, binDir1, { 
      request: "implement the fixture task", 
      markerFile,
      timeoutMs: 60000 
    });
    
    // Wait (bounded) for the marker: the mission is then live mid-implementer.
    const markerDeadline = Date.now() + 45000;
    while (!fs.existsSync(markerFile)) {
      assert(Date.now() < markerDeadline, "implementer marker never appeared within 45s");
      await new Promise(r => setTimeout(r, 100));
    }
    console.log("  Marker observed, mission is live");
    
    // Now stop it
    const stopResult = runApCommand(repo1, binDir1, ["stop", "--yes"]);
    console.log(`  ap stop exit: ${stopResult.status}, stdout: ${stopResult.stdout?.slice(0,300)}`);
    assert(stopResult.status === 0, `ap stop should exit 0, got ${stopResult.status}: ${stopResult.stderr}`);
    
    // Wait for the run to fully terminate
    const runResult = await runPromise;
    console.log(`  run terminated: killed=${runResult.killed}, status=${runResult.status}`);
    
    const missionDir1 = findMissionDir(repo1);
    assert(missionDir1, "mission directory should exist");
    
    const watchEventsFile1 = path.join(missionDir1, "watch-events.jsonl");
    assert(fs.existsSync(watchEventsFile1), "watch-events.jsonl should exist");

    const lines1 = parseLines(watchEventsFile1);
    const operatorEvents1 = lines1.filter(e => e.type === "operator");
    const stopEvents = operatorEvents1.filter(e => e.reason === "stop");
    
    console.log(`  Found ${operatorEvents1.length} operator events, ${stopEvents.length} stop events`);
    assert(stopEvents.length >= 1, `should have at least 1 stop event, got ${stopEvents.length}`);
    
    const stopEvt = stopEvents[0];
    assert(stopEvt.type === "operator", `type should be operator`);
    assert(stopEvt.reason === "stop", `reason should be stop`);
    assert(stopEvt.scope === "mission", `scope should be mission`);
    assert(typeof stopEvt.at === "string" && stopEvt.at.length > 0, `should have timestamp`);

    const reportFile1 = path.join(missionDir1, "WATCH-REPORT.md");
    assert(fs.existsSync(reportFile1), "WATCH-REPORT.md should exist");
    const report1 = fs.readFileSync(reportFile1, "utf8");
    const statusLine1 = report1.split(/\r?\n/).find((line) => /Status:/.test(line)) || "";
    assert(/Status:\s+STOPPED/.test(report1), `final report should say STOPPED after ap stop, got: ${statusLine1}`);
    assert(!/Status:\s+RUNNING/.test(report1), `final report must not still say RUNNING, got: ${statusLine1}`);

    console.log("  PASS");
  } finally {
    cleanup(repo1, binDir1);
  }

  console.log("Test 2: ap reset --scope global (idle) emits operator reset event after failure");

  const repo2 = makeFixtureRepo("ops-reset-global");
  const binDir2 = makeFixtureBin("ops-reset-global");
  try {
    // Use a failing gate to spend the failure budget
    writeConfig(repo2, { 
      planningFramework: "standalone", 
      gatesCommands: ["false"],
      failureBudgets: { implementationFailureBudget: 1 }
    });
    setScenario(repo2, "standalone_basic");
    
    // Run a mission - it will fail and spend the budget
    const run2 = runAutopilot(repo2, binDir2, { request: "implement the fixture task", timeoutMs: 120000 });
    console.log(`  initial run exit: ${run2.status}`);

    // Reset global (idle, no live run) - should clear the spent budget
    const resetResult = runApCommand(repo2, binDir2, ["reset"]);
    console.log(`  ap reset exit: ${resetResult.status}, stdout: ${resetResult.stdout?.slice(0,300)}`);
    assert(resetResult.status === 0, `ap reset should exit 0, got ${resetResult.status}: ${resetResult.stderr}`);

    const missionDir2 = findMissionDir(repo2);
    assert(missionDir2, "mission directory should exist");
    
    const watchEventsFile2 = path.join(missionDir2, "watch-events.jsonl");
    assert(fs.existsSync(watchEventsFile2), "watch-events.jsonl should exist");

    const lines2 = parseLines(watchEventsFile2);
    const operatorEvents2 = lines2.filter(e => e.type === "operator");
    const resetEvents = operatorEvents2.filter(e => e.reason === "reset" && e.scope === "global" && e.live === false);
    
    console.log(`  Found ${operatorEvents2.length} operator events, ${resetEvents.length} global reset (idle) events`);
    assert(resetEvents.length >= 1, `should have at least 1 global reset (idle) event, got ${resetEvents.length}`);
    
    const resetEvt = resetEvents[0];
    assert(resetEvt.type === "operator", `type should be operator`);
    assert(resetEvt.reason === "reset", `reason should be reset`);
    assert(resetEvt.scope === "global", `scope should be global`);
    assert(resetEvt.live === false, `live should be false`);
    assert(typeof resetEvt.at === "string" && resetEvt.at.length > 0, `should have timestamp`);
    
    console.log("  PASS");
  } finally {
    cleanup(repo2, binDir2);
  }

  console.log("Test 3: ap rebase emits operator rebase event after a real delta-drift escalation");

  const repo3 = makeFixtureRepo("ops-rebase");
  const binDir3 = makeFixtureBin("ops-rebase");
  try {
    const MISSION3 = "001-ops-rebase";
    writeConfig(repo3, { planningFramework: "standalone" });
    setScenario(repo3, "success");
    fs.mkdirSync(path.dirname(standalone.planPath(repo3, MISSION3)), { recursive: true });
    fs.writeFileSync(standalone.planPath(repo3, MISSION3), "# Plan\n\nObjective: fixture task.\n");
    fs.writeFileSync(standalone.tasksPath(repo3, MISSION3), "## Phase 1: General\n\n- [ ] Do the fixture task\n");
    const missionKey = `mission-${sanitizeKeySegment(MISSION3)}`;
    const phase0Key = `${missionKey}-phase-0`;
    ensureBaseline(repo3, missionKey, { mission: MISSION3, declaredPaths: [] });
    ensureBaseline(repo3, phase0Key, { mission: MISSION3, declaredPaths: [] });
    const phases = standalone.phases(repo3, MISSION3);
    // Post-Verifier checkpoint whose recorded delta no longer matches the tree.
    fs.writeFileSync(path.join(repo3, ".autopilot", "state.json"), JSON.stringify({
      version: 1, phase: "escalated", step: "verify", phaseIndex: 0, attempt: 2,
      mission: MISSION3, planningRequest: "fixture request",
      [CHECKPOINT_STATE_KEY]: {
        version: 1, framework: "standalone", mission: MISSION3, phaseIndex: 0, phaseName: phases[0].name,
        phaseTaskDigest: phaseTaskDigest({
          framework: "standalone", mission: MISSION3, phaseIndex: 0, phaseName: phases[0].name,
          tasks: phases[0].tasks.map((t) => ({ file: t.file, text: t.text })), repoRoot: repo3,
        }),
        revision: 1, nextStage: "mark_tasks", runningStage: null,
        attempts: { implementer: 1, code_reviewer: 1, verifier: 1 },
        baselineKey: phase0Key, deltaDigest: deltaDigest("tampered-after-pass"),
        implementer: { runId: null, summary: "stale" },
        codeReviewer: { runId: null, decision: "PASS", findings: [] },
        verifier: { runId: null, decision: "PASS", findings: [] },
        updatedAt: new Date().toISOString(),
      },
    }, null, 2));

    const run3 = runAutopilot(repo3, binDir3, { request: "fixture request", timeoutMs: 60000 });
    assert(run3.status !== 0, "drifted run should escalate (non-zero exit)");
    const state3 = JSON.parse(fs.readFileSync(path.join(repo3, ".autopilot", "state.json"), "utf8"));
    assert(state3.phaseCheckpointError?.code === "PHASE_CHECKPOINT_DRIFT", `expected drift escalation, got ${JSON.stringify(state3.phaseCheckpointError)}`);

    const rebaseResult = runApCommand(repo3, binDir3, ["rebase", "--yes", "--note", "ops-note"]);
    assert(rebaseResult.status === 0, `ap rebase should exit 0, got ${rebaseResult.status}: ${rebaseResult.stdout?.slice(-300)} ${rebaseResult.stderr}`);

    const missionDir3 = path.join(repo3, ".autopilot", "missions", MISSION3);
    const watchEventsFile3 = path.join(missionDir3, "watch-events.jsonl");
    assert(fs.existsSync(watchEventsFile3), "watch-events.jsonl should exist");
    const rebaseEvents = parseLines(watchEventsFile3).filter(e => e.type === "operator" && e.reason === "rebase");
    assert(rebaseEvents.length === 1, `expected exactly 1 rebase event, got ${rebaseEvents.length}`);
    const rebaseEvt = rebaseEvents[0];
    assert(rebaseEvt.scope === "phase-checkpoint", `scope should be phase-checkpoint, got ${rebaseEvt.scope}`);
    assert(rebaseEvt.note === "ops-note", `note should be ops-note, got ${rebaseEvt.note}`);
    assert(typeof rebaseEvt.at === "string" && rebaseEvt.at.length > 0, `should have timestamp`);

    console.log("  PASS");
  } finally {
    cleanup(repo3, binDir3);
  }

  console.log("Test 4: ap resume emits operator resume event");

  const repo4 = makeFixtureRepo("ops-resume");
  const binDir4 = makeFixtureBin("ops-resume");
  try {
    writeConfig(repo4, { planningFramework: "standalone", gatesCommands: ["true"] });
    setScenario(repo4, "standalone_basic");
    
    // Run a mission first
    const run4 = runAutopilot(repo4, binDir4, { request: "implement the fixture task", timeoutMs: 60000 });
    assert(run4.status === 0);

    // Resume (which just continues the mission)
    const resumeResult = runApCommand(repo4, binDir4, ["resume"]);
    console.log(`  ap resume exit: ${resumeResult.status}, stdout: ${resumeResult.stdout?.slice(0,300)}`);
    // Resume will run the mission again - it might complete or escalate
    // The key is that the resume event is written at the start

    const missionDir4 = findMissionDir(repo4);
    assert(missionDir4, "mission directory should exist");
    
    const watchEventsFile4 = path.join(missionDir4, "watch-events.jsonl");
    assert(fs.existsSync(watchEventsFile4), "watch-events.jsonl should exist");

    const lines4 = parseLines(watchEventsFile4);
    const operatorEvents4 = lines4.filter(e => e.type === "operator");
    const resumeEvents = operatorEvents4.filter(e => e.reason === "resume");
    
    console.log(`  Found ${operatorEvents4.length} operator events, ${resumeEvents.length} resume events`);
    assert(resumeEvents.length >= 1, `should have at least 1 resume event, got ${resumeEvents.length}`);
    
    const resumeEvt = resumeEvents[0];
    assert(resumeEvt.type === "operator", `type should be operator`);
    assert(resumeEvt.reason === "resume", `reason should be resume`);
    assert(resumeEvt.scope === "mission", `scope should be mission`);
    assert(typeof resumeEvt.at === "string" && resumeEvt.at.length > 0, `should have timestamp`);
    
    console.log("  PASS");
  } finally {
    cleanup(repo4, binDir4);
  }

  console.log("Test 5: escalation event is emitted on a real not-converging escalation");

  // Hermetic opencode shim around the cap-breach fixture adapter (as in
  // test-cap-breach-rollover.mjs): a real installed opencode would outscore it.
  const CAP_FIXTURE = path.join(here, "test-fixtures", "fake-cap-breach-adapter.mjs");
  const repo5 = makeFixtureRepo("ops-escalation");
  const binDir5 = makeFixtureBin("ops-escalation");
  try {
    const MISSION5 = "001-ops-escalation";
    if (process.platform === "win32") {
      fs.writeFileSync(path.join(binDir5, "opencode.cmd"), `@echo off\r\n"${process.execPath}" "${CAP_FIXTURE}" %*\r\nexit /b %errorlevel%\r\n`);
    } else {
      const shim = path.join(binDir5, "opencode");
      fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${CAP_FIXTURE}" "$@"\n`);
      fs.chmodSync(shim, 0o755);
    }
    const savedPath = process.env.PATH || "";
    process.env.PATH = binDir5 + (process.platform === "win32" ? ";" : ":") + savedPath;
    let resolved = null;
    try { resolved = resolveAgentBinary("opencode"); } catch { resolved = null; }
    process.env.PATH = savedPath;
    assert(typeof resolved === "string" && path.resolve(resolved).toLowerCase().startsWith(path.resolve(binDir5).toLowerCase()),
      `opencode must resolve to the fixture shim (got ${resolved})`);

    writeConfig(repo5, { planningFramework: "standalone" });
    const configFile = path.join(repo5, ".autopilot", "config.json");
    const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
    config.roles.implementer.adapter = "opencode";
    config.policy = { ...config.policy, per_task_timeout_ms: 60000, per_task_max_turns: 5, continuation_allowance: 1 };
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    setScenario(repo5, "cap_always");
    const missionDir5 = path.join(repo5, ".autopilot", "missions", MISSION5);
    fs.mkdirSync(missionDir5, { recursive: true });
    fs.writeFileSync(path.join(missionDir5, "PLAN.md"), "# Plan\n\nObjective: cap-breach probe.\n");
    fs.writeFileSync(path.join(missionDir5, "TASKS.md"), "## Phase 1: General\n\n- [ ] Do the fixture task\n");
    fs.writeFileSync(path.join(repo5, ".autopilot", "state.json"), JSON.stringify({
      version: 1, phase: "tasks_ready", step: "tasks_ready", phaseIndex: 0, attempt: 1,
      mission: MISSION5, planningRequest: "cap probe",
    }, null, 2));

    const run5 = runAutopilot(repo5, binDir5, { request: "cap probe", timeoutMs: 100000 });
    assert(run5.status !== 0, "escalating run should exit non-zero");
    const state5 = JSON.parse(fs.readFileSync(path.join(repo5, ".autopilot", "state.json"), "utf8"));
    assert(state5.phase === "escalated" && state5.step === "standalone_task_not_converging",
      `expected not-converging escalation, got ${state5.phase}/${state5.step}`);

    const watchEventsFile5 = path.join(missionDir5, "watch-events.jsonl");
    assert(fs.existsSync(watchEventsFile5), "watch-events.jsonl should exist");
    const escalationEvents = parseLines(watchEventsFile5).filter(e => e.type === "operator" && e.reason === "escalation");
    assert(escalationEvents.length >= 1, `expected at least 1 escalation event, got ${escalationEvents.length}`);
    const escEvt = escalationEvents[0];
    assert(escEvt.scope === "continuation", `scope should be continuation, got ${escEvt.scope}`);
    assert(typeof escEvt.at === "string" && escEvt.at.length > 0, `should have timestamp`);
    assert(typeof escEvt.contScope === "string" && escEvt.contScope.startsWith("task:standalone:phase-0:"), `contScope unexpected: ${escEvt.contScope}`);
    assert(typeof escEvt.taskId === "string" && escEvt.taskId.length > 0, `taskId should be non-empty, got ${escEvt.taskId}`);
    assert(typeof escEvt.taskRef === "string" && escEvt.taskRef.length > 0, `taskRef should be non-empty, got ${escEvt.taskRef}`);

    console.log("  PASS");
  } finally {
    cleanup(repo5, binDir5);
  }

  console.log("Test 6: operator events land in the owning mission's directory only");

  const repo6 = makeFixtureRepo("ops-path");
  const binDir6 = makeFixtureBin("ops-path");
  try {
    writeConfig(repo6, { planningFramework: "standalone", gatesCommands: ["false"], failureBudgets: { implementationFailureBudget: 1 } });
    setScenario(repo6, "standalone_basic");
    runAutopilot(repo6, binDir6, { request: "implement the fixture task", timeoutMs: 120000 });
    const state6 = JSON.parse(fs.readFileSync(path.join(repo6, ".autopilot", "state.json"), "utf8"));
    assert(state6.mission, "state should name a mission");

    const resetResult = runApCommand(repo6, binDir6, ["reset"]);
    assert(resetResult.status === 0, `ap reset should exit 0, got ${resetResult.status}: ${resetResult.stderr}`);

    const expectedFile = path.join(repo6, ".autopilot", "missions", state6.mission, "watch-events.jsonl");
    assert(fs.existsSync(expectedFile), `watch-events.jsonl should exist at ${expectedFile}`);
    const resetEvents = parseLines(expectedFile).filter(e => e.type === "operator" && e.reason === "reset");
    assert(resetEvents.length >= 1, `reset event should be in the mission's events file, got ${resetEvents.length}`);

    // No other watch-events.jsonl anywhere under the repo's .autopilot tree.
    const found = [];
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.name === "watch-events.jsonl") found.push(full);
      }
    };
    walk(path.join(repo6, ".autopilot"));
    assert(found.length === 1 && found[0] === expectedFile, `expected only ${expectedFile}, found ${JSON.stringify(found)}`);

    console.log("  PASS");
  } finally {
    cleanup(repo6, binDir6);
  }

  console.log("\nAll operator event integration tests passed.");
}

runTest().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});