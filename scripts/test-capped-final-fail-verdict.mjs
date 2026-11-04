#!/usr/bin/env node
// Backlog #5: a plan_reviewer whose final FAIL verdict is accepted after hitting
// the cap must carry the verdict failure (PLANNING_REJECTED) instead of being
// unclassified, so planning review wiring lets it pass through to the planner
// revision loop rather than escalating as INTERNAL_CONTRACT_ERROR.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  makeFixtureRepo, makeFixtureBin, setScenario, writeConfig,
  runAutopilot, readObservedEvents, cleanup,
} from "./test-fixtures/workflow-order-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CAP_FIXTURE = path.join(here, "test-fixtures", "fake-cap-breach-adapter.mjs");
const MISSION = "001-capped-final-fail-verdict";
const PLAN = "# Plan\n\nObjective: capped final fail verdict probe.\n";
const TASKS = "## Phase 1: General\n\n- [ ] Do the fixture task — accept: done ; verify: none\n";

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}

const repo = makeFixtureRepo("capped-final-fail-verdict");
const binDir = makeFixtureBin("capped-final-fail-verdict");
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
  setScenario(repo, "cap_verdict_fail");
  const missionDir = path.join(repo, ".autopilot", "missions", MISSION);
  fs.mkdirSync(missionDir, {recursive: true});
  fs.writeFileSync(path.join(missionDir, "PLAN.md"), PLAN);
  fs.writeFileSync(path.join(missionDir, "TASKS.md"), TASKS);
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
    version: 1, phase: "planning", step: "standalone_planning",
    mission: MISSION, planningRequest: "capped final fail verdict probe",
  }, null, 2));

  const run = runAutopilot(repo, binDir, {
    request: "capped final fail verdict probe",
    stage: "planning",
    timeoutMs: process.platform === "win32" ? 240000 : 180000,
  });
  const output = `${run.stdout}\n${run.stderr}`;
  const state = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
  const events = readObservedEvents(repo);

  // Check a: output contains "after already returning its final FAIL verdict; accepting it instead of continuing."
  // The live cap no longer fires once the final verdict was printed: the
  // FAIL verdict is used directly (no cap line, no reviewer continuation).
  check("FAIL verdict printed before the cap is used without a cap",
    !/plan review(?:er)? hit the turns cap/i.test(output) && !output.includes("continuing as session"),
    output.slice(-900));

  // Check b: output does NOT contain "INTERNAL_CONTRACT_ERROR" and state.phase is not "escalated"
  check("output does not contain INTERNAL_CONTRACT_ERROR and state is not escalated",
    !output.includes("INTERNAL_CONTRACT_ERROR") && state.phase !== "escalated",
    {phase: state.phase, tail: output.slice(-900)});

  // Check c: a planner run happens AFTER the first plan_reviewer FAIL (readObservedEvents order: plan_reviewer FAIL, then planner)
  const firstFailIdx = events.findIndex((e) => e.role === "plan_reviewer" && e.decision === "FAIL");
  const laterPlannerIdx = events.findIndex((e, idx) => idx > firstFailIdx && e.role === "planner");
  check("planner run happens after the first plan_reviewer FAIL",
    firstFailIdx !== -1 && laterPlannerIdx > firstFailIdx,
    events.map((e) => ({role: e.role, decision: e.decision})));

  // Check d: the mission ends planning: run.status === 0 and state.phase === "tasks_ready"
  check("mission ends planning with status 0 and phase tasks_ready",
    run.status === 0 && state.phase === "tasks_ready",
    {status: run.status, phase: state.phase, tail: output.slice(-900)});
} finally {
  cleanup(repo, binDir);
}

if (failures) {
  console.error(`${failures} capped final fail verdict check(s) failed.`);
  process.exit(1);
}
console.log("capped final fail verdict tests passed");
