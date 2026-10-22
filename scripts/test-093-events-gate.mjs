#!/usr/bin/env node
// Mission 093 Part 1 task 3.2: integration test for gate event emission via gates() wiring.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeFixtureRepo, makeFixtureBin, writeConfig, setScenario, runAutopilot, cleanup } from "./test-fixtures/workflow-order-harness.mjs";

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

async function runTest() {
  console.log("Test 1: gates() emits gate_start, gate_progress, gate_result on success");

  const repo = makeFixtureRepo("gate-success");
  const binDir = makeFixtureBin("gate-success");
  try {
    // Config with a simple passing gate command
    writeConfig(repo, { 
      planningFramework: "standalone", 
      gatesCommands: ["true"] 
    });
    // Use a scenario that just passes through
    setScenario(repo, "standalone_basic");
    
    const run = runAutopilot(repo, binDir, { request: "implement the fixture task", timeoutMs: 60000 });
    console.log(`  autopilot exit: ${run.status}, stdout: ${run.stdout?.slice(0,200)}, stderr: ${run.stderr?.slice(0,200)}`);
    assert(run.status === 0, `autopilot should exit 0, got ${run.status}`);

    const missionDir = findMissionDir(repo);
    assert(missionDir, "mission directory should exist");
    
    const watchEventsFile = path.join(missionDir, "watch-events.jsonl");
    assert(fs.existsSync(watchEventsFile), "watch-events.jsonl should exist");

    const lines = parseLines(watchEventsFile);
    const gateEvents = lines.filter(e => e.type && e.type.startsWith("gate_"));
    
    console.log(`  Found ${gateEvents.length} gate events:`, gateEvents.map(e => e.type));
    
    // Should have gate_start, gate_progress, gate_result
    const startEvents = gateEvents.filter(e => e.type === "gate_start");
    const progressEvents = gateEvents.filter(e => e.type === "gate_progress");
    const resultEvents = gateEvents.filter(e => e.type === "gate_result");
    
    assert(startEvents.length >= 1, `should have at least 1 gate_start, got ${startEvents.length}`);
    assert(progressEvents.length >= 1, `should have at least 1 gate_progress, got ${progressEvents.length}`);
    assert(resultEvents.length >= 1, `should have at least 1 gate_result, got ${resultEvents.length}`);
    
    // Check event structure
    const start = startEvents[0];
    assert(start.phase === 1, `gate_start phase should be 1, got ${start.phase}`);
    assert(start.command === null, `gate_start command should be null`);
    assert(start.durationMs === null, `gate_start durationMs should be null`);
    assert(start.ok === null, `gate_start ok should be null`);
    assert(typeof start.at === "string" && start.at.length > 0, `gate_start should have timestamp`);
    
    const progress = progressEvents[0];
    assert(progress.phase === 1, `gate_progress phase should be 1, got ${progress.phase}`);
    assert(progress.command === "true", `gate_progress command should be "true", got ${progress.command}`);
    assert(typeof progress.durationMs === "number" && progress.durationMs >= 0, `gate_progress durationMs should be number`);
    assert(progress.ok === true, `gate_progress ok should be true`);
    assert(typeof progress.at === "string" && progress.at.length > 0, `gate_progress should have timestamp`);
    
    const result = resultEvents[0];
    assert(result.phase === 1, `gate_result phase should be 1, got ${result.phase}`);
    assert(result.command === null, `gate_result command should be null`);
    assert(typeof result.durationMs === "number" && result.durationMs >= 0, `gate_result durationMs should be number`);
    assert(result.ok === true, `gate_result ok should be true`);
    assert(typeof result.at === "string" && result.at.length > 0, `gate_result should have timestamp`);
    
    console.log("  PASS");
  } finally {
    cleanup(repo, binDir);
  }

  console.log("Test 2: gates() emits gate_start, gate_progress, gate_result on failure");
  const repo2 = makeFixtureRepo("gate-fail");
  const binDir2 = makeFixtureBin("gate-fail");
  try {
    // Config with a failing gate command
    writeConfig(repo2, { 
      planningFramework: "standalone", 
      gatesCommands: ["false"] 
    });
    setScenario(repo2, "standalone_basic");
    
    const run2 = runAutopilot(repo2, binDir2, { request: "implement the fixture task", timeoutMs: 60000 });
    // Gate failure should cause the phase to fail, but autopilot might still exit 0 if it handles it
    // The key is that gate events are still written
    
    const missionDir2 = findMissionDir(repo2);
    assert(missionDir2, "mission directory should exist");
    
    const watchEventsFile2 = path.join(missionDir2, "watch-events.jsonl");
    assert(fs.existsSync(watchEventsFile2), "watch-events.jsonl should exist");

    const lines2 = parseLines(watchEventsFile2);
    const gateEvents2 = lines2.filter(e => e.type && e.type.startsWith("gate_"));
    
    console.log(`  Found ${gateEvents2.length} gate events:`, gateEvents2.map(e => e.type));
    
    const startEvents2 = gateEvents2.filter(e => e.type === "gate_start");
    const progressEvents2 = gateEvents2.filter(e => e.type === "gate_progress");
    const resultEvents2 = gateEvents2.filter(e => e.type === "gate_result");
    
    assert(startEvents2.length >= 1, `should have at least 1 gate_start`);
    assert(progressEvents2.length >= 1, `should have at least 1 gate_progress`);
    assert(resultEvents2.length >= 1, `should have at least 1 gate_result`);
    
    const result2 = resultEvents2[0];
    assert(result2.ok === false, `gate_result ok should be false on failure`);
    assert(typeof result2.durationMs === "number" && result2.durationMs >= 0, `gate_result durationMs should be number`);
    
    console.log("  PASS");
  } finally {
    cleanup(repo2, binDir2);
  }

  console.log("Test 3: multiple gate commands each emit gate_progress");
  const repo3 = makeFixtureRepo("gate-multi");
  const binDir3 = makeFixtureBin("gate-multi");
  try {
    writeConfig(repo3, { 
      planningFramework: "standalone", 
      gatesCommands: ["true", "echo hello", "true"] 
    });
    setScenario(repo3, "standalone_basic");
    
    const run3 = runAutopilot(repo3, binDir3, { request: "implement the fixture task", timeoutMs: 60000 });
    assert(run3.status === 0, `autopilot should exit 0`);
    
    const missionDir3 = findMissionDir(repo3);
    const watchEventsFile3 = path.join(missionDir3, "watch-events.jsonl");
    const lines3 = parseLines(watchEventsFile3);
    const gateEvents3 = lines3.filter(e => e.type && e.type.startsWith("gate_"));
    const progressEvents3 = gateEvents3.filter(e => e.type === "gate_progress");
    
    console.log(`  Found ${progressEvents3.length} gate_progress events`);
    assert(progressEvents3.length === 3, `should have 3 gate_progress events for 3 commands, got ${progressEvents3.length}`);
    
    // Check commands match
    const commands = progressEvents3.map(e => e.command).sort();
    assert(commands.includes("true"), `should have "true" command`);
    assert(commands.includes("echo hello"), `should have "echo hello" command`);
    
    console.log("  PASS");
  } finally {
    cleanup(repo3, binDir3);
  }

  console.log("Test 4: phase is tracked correctly");
  const repo4 = makeFixtureRepo("gate-phase");
  const binDir4 = makeFixtureBin("gate-phase");
  try {
    writeConfig(repo4, { 
      planningFramework: "standalone", 
      gatesCommands: ["true"] 
    });
    setScenario(repo4, "standalone_basic");
    
    const run4 = runAutopilot(repo4, binDir4, { request: "implement the fixture task", timeoutMs: 60000 });
    assert(run4.status === 0);
    
    const missionDir4 = findMissionDir(repo4);
    const watchEventsFile4 = path.join(missionDir4, "watch-events.jsonl");
    const lines4 = parseLines(watchEventsFile4);
    const gateEvents4 = lines4.filter(e => e.type && e.type.startsWith("gate_"));
    
    // All gate events should have phase 1 (first phase)
    for (const evt of gateEvents4) {
      assert(evt.phase === 1, `all gate events should have phase 1, got ${evt.phase} for ${evt.type}`);
    }
    
    console.log("  PASS");
  } finally {
    cleanup(repo4, binDir4);
  }

  console.log("Test 5: events are appended in order (start, progress*, result)");
  const repo5 = makeFixtureRepo("gate-order");
  const binDir5 = makeFixtureBin("gate-order");
  try {
    writeConfig(repo5, { 
      planningFramework: "standalone", 
      gatesCommands: ["true", "true"] 
    });
    setScenario(repo5, "standalone_basic");
    
    const run5 = runAutopilot(repo5, binDir5, { request: "implement the fixture task", timeoutMs: 60000 });
    assert(run5.status === 0);
    
    const missionDir5 = findMissionDir(repo5);
    const watchEventsFile5 = path.join(missionDir5, "watch-events.jsonl");
    const lines5 = parseLines(watchEventsFile5);
    const gateEvents5 = lines5.filter(e => e.type && e.type.startsWith("gate_"));
    
    // Check order: start, progress, progress, result
    const types = gateEvents5.map(e => e.type);
    assert(types[0] === "gate_start", `first gate event should be gate_start, got ${types[0]}`);
    assert(types[1] === "gate_progress", `second gate event should be gate_progress, got ${types[1]}`);
    assert(types[2] === "gate_progress", `third gate event should be gate_progress, got ${types[2]}`);
    assert(types[3] === "gate_result", `fourth gate event should be gate_result, got ${types[3]}`);
    
    console.log("  PASS");
  } finally {
    cleanup(repo5, binDir5);
  }

  console.log("Test 6: watch events written to correct mission directory");
  const repo6 = makeFixtureRepo("gate-path");
  const binDir6 = makeFixtureBin("gate-path");
  try {
    writeConfig(repo6, { 
      planningFramework: "standalone", 
      gatesCommands: ["true"] 
    });
    setScenario(repo6, "standalone_basic");
    
    const run6 = runAutopilot(repo6, binDir6, { request: "implement the fixture task", timeoutMs: 60000 });
    assert(run6.status === 0);
    
    const missionDir6 = findMissionDir(repo6);
    const watchEventsFile6 = path.join(missionDir6, "watch-events.jsonl");
    
    // Verify it's in .autopilot/missions/<mission>/watch-events.jsonl
    assert(watchEventsFile6.includes(".autopilot/missions/"), `watch-events should be in .autopilot/missions/`);
    assert(fs.existsSync(watchEventsFile6), `watch-events.jsonl should exist at ${watchEventsFile6}`);
    
    // Verify it's NOT in the repo root or runs directory
    assert(!watchEventsFile6.includes(".autopilot/runs/"), `watch-events should not be in runs directory`);
    
    console.log("  PASS");
  } finally {
    cleanup(repo6, binDir6);
  }

  console.log("\nAll gate event integration tests passed.");
}

runTest().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});