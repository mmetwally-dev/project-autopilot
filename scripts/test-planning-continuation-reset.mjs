#!/usr/bin/env node
// Item 6: a completed planning role run resets THAT role scope's continuation
// allowance. Both the Planner and the plan_reviewer cap once per round under
// their per-role extra_sessions=1; without the per-scope reset the second
// round's cap would exhaust the allowance and escalate. Item 5 also makes the second
// review round possible (re-review FAIL -> Planner revision -> re-review).
//
// Real subprocesses: Planner + plan_reviewer run the cap fixture, everything
// else uses the shared cursor fixture. `--stage planning` stops before
// implementation.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  makeFixtureRepo, makeFixtureBin, setScenario, writeConfig,
  runAutopilot, readObservedEvents, cleanup,
} from "./test-fixtures/workflow-order-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CAP_FIXTURE = path.join(here, "test-fixtures", "fake-cap-breach-adapter.mjs");
const MISSION = "001-planning-continuation-reset";
const PLAN = "# Plan\n\nObjective: planning continuation reset probe.\n";
const TASKS = "## Phase 1: General\n\n- [ ] Do the fixture task — accept: done ; verify: none\n";

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}
function readState(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
}
function walkResults(repo) {
  const out = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "result.json") {
        try { out.push(JSON.parse(fs.readFileSync(full, "utf8"))); } catch { /* transient */ }
      }
    }
  })(path.join(repo, ".autopilot"));
  return out;
}

const repo = makeFixtureRepo("planning-cont-reset");
const binDir = makeFixtureBin("planning-cont-reset");
try {
  // The read-only role runs inside the execution envelope, which binds only
  // the adapter executable (not this source tree or sibling files). Embed the
  // fixture source in the executable itself so the sandbox can run it.
  const fixtureSource = fs.readFileSync(CAP_FIXTURE);
  const fixtureB64 = fixtureSource.toString("base64");
  const runnerPosix = `await import("data:text/javascript;base64,"+process.env.FIXTURE_B64)`;
  const runnerWin = `await import('data:text/javascript;base64,'+process.env.FIXTURE_B64)`;
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "opencode.cmd"),
      `@echo off\r\nset "FIXTURE_B64=${fixtureB64}"\r\n"${process.execPath}" --input-type=module -e "${runnerWin}" opencode %*\r\nexit /b %errorlevel%\r\n`);
  } else {
    const shim = path.join(binDir, "opencode");
    fs.writeFileSync(shim, `#!/bin/sh\nFIXTURE_B64='${fixtureB64}'\nexport FIXTURE_B64\nexec "${process.execPath}" --input-type=module -e '${runnerPosix}' opencode "$@"\n`);
    fs.chmodSync(shim, 0o755);
  }
  writeConfig(repo, {planningFramework: "standalone", maxPlanRevisions: 3});
  const configPath = path.join(repo, ".autopilot", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.roles.planner.adapter = "opencode";
  config.roles.plan_reviewer.adapter = "opencode";
  config.policy = {
    ...config.policy,
    per_task_timeout_ms: 60000,
    per_task_max_turns: 30,
    caps: {
      planner: {max_turns: 30, max_tokens: 200000, extra_sessions: 1},
      plan_reviewer: {max_turns: 30, max_tokens: 150000, extra_sessions: 1},
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  setScenario(repo, "plan_review_cap_rounds");
  const planFile = path.join(repo, ".autopilot", "missions", MISSION, "PLAN.md");
  const tasksFile = path.join(repo, ".autopilot", "missions", MISSION, "TASKS.md");
  fs.mkdirSync(path.dirname(planFile), {recursive: true});
  fs.writeFileSync(planFile, PLAN);
  fs.writeFileSync(tasksFile, TASKS);
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
    version: 1, phase: "planning", step: "standalone_planning",
    mission: MISSION, planningRequest: "planning continuation reset probe",
  }, null, 2));

  const run = runAutopilot(repo, binDir, {
    request: "planning continuation reset probe",
    stage: "planning",
    timeoutMs: process.platform === "win32" ? 240000 : 180000,
  });
  const output = `${run.stdout}\n${run.stderr}`;
  const state = readState(repo);
  const events = readObservedEvents(repo);
  const results = walkResults(repo);
  const plannerRuns = events.filter((e) => e.role === "planner").length;
  const reviewerRuns = events.filter((e) => e.role === "plan_reviewer").length;
  const plannerCaps = results.filter((r) => r.role === "planner" && r.capped).length;
  const reviewerCaps = results.filter((r) => r.role === "plan_reviewer" && r.capped).length;

  check("reset: the mission completes planning (second-round caps did not exhaust)",
    run.status === 0 && state.phase === "tasks_ready", {status: run.status, phase: state.phase, tail: output.slice(-900)});
  check("reset: the Planner ran one capped + one completed generation per stage/revision (four runs)",
    plannerRuns === 4, plannerRuns);
  check("reset: the Planner capped twice (initial and revision), both were continued",
    plannerCaps === 2, plannerCaps);
  check("reset: the reviewer ran a capped + completed generation in all three rounds (six runs)",
    reviewerRuns === 6, reviewerRuns);
  check("reset: the reviewer capped in all three rounds, each continued",
    reviewerCaps === 3, reviewerCaps);
  check("reset: no planning continuation budget remains spent after the completed runs",
    !state.continuationBudgets
      || Object.keys(state.continuationBudgets).every((k) => !k.includes(":planning:")),
    state.continuationBudgets);
  check("reset: no lastContinuation points at a planning scope",
    !state.lastContinuation || !String(state.lastContinuation.scope || "").includes(":planning:"),
    state.lastContinuation);
} finally {
  cleanup(repo, binDir);
}

if (failures) {
  console.error(`${failures} planning continuation reset check(s) failed.`);
  process.exit(1);
}
console.log("planning continuation reset tests passed");
