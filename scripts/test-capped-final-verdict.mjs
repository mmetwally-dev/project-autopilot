#!/usr/bin/env node
// Item 7: a plan_reviewer that emits its complete PASS verdict and only THEN
// spins past the cap must have that verdict accepted as the round outcome —
// not treated as an exhausted generation. continuation_allowance is 0, so
// the old behaviour (continue the capped reviewer) cannot succeed.
//
// Real subprocesses: the Planner uses the shared cursor fixture; the reviewer
// uses the cap fixture embedded in its executable (read-only roles are
// sandboxed and cannot see sibling fixture files).
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  makeFixtureRepo, makeFixtureBin, setScenario, writeConfig,
  runAutopilot, readObservedEvents, cleanup,
} from "./test-fixtures/workflow-order-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CAP_FIXTURE = path.join(here, "test-fixtures", "fake-cap-breach-adapter.mjs");
const MISSION = "001-capped-final-verdict";
const PLAN = "# Plan\n\nObjective: capped final verdict probe.\n";
const TASKS = "## Phase 1: General\n\n- [ ] Do the fixture task — accept: done ; verify: none\n";

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
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

const repo = makeFixtureRepo("capped-final-verdict");
const binDir = makeFixtureBin("capped-final-verdict");
try {
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
  config.roles.plan_reviewer.adapter = "opencode";
  config.policy = {
    ...config.policy,
    per_task_timeout_ms: 60000,
    per_task_max_turns: 30,
    caps: {plan_reviewer: {max_turns: 30, max_tokens: 150000, extra_sessions: 0}},
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  setScenario(repo, "cap_verdict");
  const missionDir = path.join(repo, ".autopilot", "missions", MISSION);
  fs.mkdirSync(missionDir, {recursive: true});
  fs.writeFileSync(path.join(missionDir, "PLAN.md"), PLAN);
  fs.writeFileSync(path.join(missionDir, "TASKS.md"), TASKS);
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
    version: 1, phase: "planning", step: "standalone_planning",
    mission: MISSION, planningRequest: "capped final verdict probe",
  }, null, 2));

  const run = runAutopilot(repo, binDir, {
    request: "capped final verdict probe",
    stage: "planning",
    timeoutMs: process.platform === "win32" ? 240000 : 180000,
  });
  const output = `${run.stdout}\n${run.stderr}`;
  const state = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
  const events = readObservedEvents(repo);
  const reviewerEvents = events.filter((e) => e.role === "plan_reviewer");
  const reviewerResults = walkResults(repo).filter((r) => r.role === "plan_reviewer");

  check("capped verdict: the mission completes planning without a continuation",
    run.status === 0 && state.phase === "tasks_ready", {status: run.status, phase: state.phase, tail: output.slice(-900)});
  check("capped verdict: the reviewer emitted PASS before the cap",
    reviewerEvents.length === 1 && reviewerEvents[0].decision === "PASS",
    reviewerEvents.map((e) => e.decision));
  check("capped verdict: the completed verdict is accepted and logged",
    output.includes("Standalone plan review hit the turns cap")
      && output.includes("after already returning its final PASS verdict; accepting it instead of continuing."),
    output.slice(-900));
  check("capped verdict: no continuation session was started for the reviewer",
    !output.includes("Plan reviewer hit the turns cap") && !output.includes("continuing as session"),
    output.slice(-900));
  check("capped verdict: the persisted run still records the cap and its PASS verdict",
    reviewerResults.length === 1 && reviewerResults[0].capped?.type === "turns"
      && reviewerResults[0].verdict?.decision === "PASS",
    reviewerResults.map((r) => ({capped: r.capped, decision: r.verdict?.decision})));
  check("capped verdict: no planning reviewer continuation budget is left spent",
    !state.continuationBudgets
      || Object.keys(state.continuationBudgets).every((k) => !k.includes(":planning:")),
    state.continuationBudgets);
} finally {
  cleanup(repo, binDir);
}

if (failures) {
  console.error(`${failures} capped final verdict check(s) failed.`);
  process.exit(1);
}
console.log("capped final verdict tests passed");
