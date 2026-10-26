#!/usr/bin/env node
// Mission 099 Phase 2 task 2.6 — same-process `ap full` / `ap do` guard.
//
// These commands plan and implement in one process, so the second invocation
// must consume a stored plan-approval pause BEFORE runSpec: it runs no
// planning (no planner, no "PLANNING STATE RESOLVED" line), runs the
// implementer, and completes. The first invocation must pause after planning
// exactly like `ap run`. Behavioral: real subprocesses against the shared
// fake-adapter fixture.
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {
  makeFixtureRepo, makeFixtureBin, setScenario, writeConfig, readObservedEvents,
  cleanup, skillRoot, withoutOuterGitGuard,
} from "./test-fixtures/workflow-order-harness.mjs";
import {toNewLayoutConfig} from "./config-layout.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

function readState(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
}

// Only a v4 `pause_for_plan_approval:true` arms the pause (see
// test-plan-approval-standalone.mjs for the migration rationale).
function writePlanApprovalConfig(repo) {
  writeConfig(repo, {planningFramework: "standalone"});
  const file = path.join(repo, ".autopilot", "config.json");
  const layout = toNewLayoutConfig(JSON.parse(fs.readFileSync(file, "utf8")));
  layout.schema_version = "4.0";
  layout.workflow.pause_for_plan_approval = true;
  fs.writeFileSync(file, `${JSON.stringify(layout, null, 2)}\n`);
}

// The shared runAutopilot helper only runs `run`; `full` needs AUTOPILOT_SPEC
// in the ORCHESTRATOR environment (it does not parse argv as a request).
function runCli(repo, binDir, command, args, extraEnv = {}) {
  const delimiter = process.platform === "win32" ? ";" : ":";
  const base = withoutOuterGitGuard(process.env);
  const env = {
    ...base,
    ...extraEnv,
    PATH: `${binDir}${delimiter}${base.PATH || ""}`,
  };
  const result = spawnSync(
    process.execPath,
    [path.join(skillRoot, "scripts", "autopilot.mjs"), command, ...args, "--repo", repo],
    {cwd: repo, encoding: "utf8", env, timeout: 60000, stdio: ["ignore", "pipe", "pipe"], shell: false},
  );
  return {status: result.status, stdout: result.stdout || "", stderr: result.stderr || ""};
}

const request = "implement the fixture task";
const plannerCount = (events) => events.filter((e) => e.role === "planner").length;
const implementerRan = (events) => events.some((e) => e.role === "implementer");

// ---- 1. ap full pauses after planning, second ap full consumes it ----
{
  const repo = makeFixtureRepo("plan-approval-full");
  const binDir = makeFixtureBin("plan-approval-full");
  try {
    writePlanApprovalConfig(repo);
    setScenario(repo, "success");

    const first = runCli(repo, binDir, "full", [], {AUTOPILOT_SPEC: request});
    const paused = readState(repo);
    const firstEvents = readObservedEvents(repo);
    check("full pause: exits 0", first.status === 0, {status: first.status, stderr: first.stderr});
    check("full pause: stops at plan_approval", paused.phase === "plan_approval", paused.phase);
    check("full pause: planApproval awaiting", paused.planApproval?.status === "awaiting", paused.planApproval);
    check("full pause: planner ran", plannerCount(firstEvents) === 1, plannerCount(firstEvents));
    check("full pause: no implementer", !implementerRan(firstEvents));
    check("full pause: prints the approve-plan message", first.stdout.includes("PLAN APPROVAL REQUIRED"), first.stdout);
    check("full pause: no PLANNING STATE RESOLVED line", !first.stdout.includes("PLANNING STATE RESOLVED"), first.stdout);

    const second = runCli(repo, binDir, "full", [], {AUTOPILOT_SPEC: request});
    const state = readState(repo);
    const events = readObservedEvents(repo);
    check("full resume: exits 0", second.status === 0, {status: second.status, stderr: second.stderr});
    check("full resume: logs the approval", second.stdout.includes("Plan approved by `ap full`"), second.stdout);
    check("full resume: no PLANNING STATE RESOLVED line", !second.stdout.includes("PLANNING STATE RESOLVED"), second.stdout);
    check("full resume: runs the implementer", implementerRan(events));
    check("full resume: does not re-plan", plannerCount(events) === 1, plannerCount(events));
    check("full resume: never re-pauses", state.phase !== "plan_approval", state.phase);
    check("full resume: clears planApproval", !state.planApproval, state.planApproval);
    check("full resume: completes the mission", state.phase === "complete", state.phase);
  } finally {
    cleanup(repo, binDir);
  }
}

// ---- 2. ap do pauses after planning, second ap do consumes it ----
{
  const repo = makeFixtureRepo("plan-approval-do");
  const binDir = makeFixtureBin("plan-approval-do");
  try {
    writePlanApprovalConfig(repo);
    setScenario(repo, "success");

    const first = runCli(repo, binDir, "do", [request]);
    const paused = readState(repo);
    const firstEvents = readObservedEvents(repo);
    check("do pause: exits 0", first.status === 0, {status: first.status, stderr: first.stderr});
    check("do pause: stops at plan_approval", paused.phase === "plan_approval", paused.phase);
    check("do pause: planApproval awaiting", paused.planApproval?.status === "awaiting", paused.planApproval);
    check("do pause: planner ran", plannerCount(firstEvents) === 1, plannerCount(firstEvents));
    check("do pause: no implementer", !implementerRan(firstEvents));
    check("do pause: prints the approve-plan message", first.stdout.includes("PLAN APPROVAL REQUIRED"), first.stdout);
    check("do pause: no PLANNING STATE RESOLVED line", !first.stdout.includes("PLANNING STATE RESOLVED"), first.stdout);

    const second = runCli(repo, binDir, "do", [request]);
    const state = readState(repo);
    const events = readObservedEvents(repo);
    check("do resume: exits 0", second.status === 0, {status: second.status, stderr: second.stderr});
    check("do resume: logs the approval", second.stdout.includes("Plan approved by `ap do`"), second.stdout);
    check("do resume: no PLANNING STATE RESOLVED line", !second.stdout.includes("PLANNING STATE RESOLVED"), second.stdout);
    check("do resume: runs the implementer", implementerRan(events));
    check("do resume: does not re-plan", plannerCount(events) === 1, plannerCount(events));
    check("do resume: never re-pauses", state.phase !== "plan_approval", state.phase);
    check("do resume: clears planApproval", !state.planApproval, state.planApproval);
    check("do resume: completes the mission", state.phase === "complete", state.phase);
  } finally {
    cleanup(repo, binDir);
  }
}

// ---- 3. a DIFFERENT request does not consume the paused mission's approval ----
// A supplied request that differs from the paused mission's request starts a
// NEW mission in runImplementation's takeover, so the same-process guard must
// not log an approval for the mission it is about to abandon.
{
  const repo = makeFixtureRepo("plan-approval-different-request");
  const binDir = makeFixtureBin("plan-approval-different-request");
  try {
    writePlanApprovalConfig(repo);
    setScenario(repo, "success");
    const differentRequest = "implement a completely different fixture task";

    const first = runCli(repo, binDir, "do", [request]);
    check("different request: first do pauses", readState(repo).phase === "plan_approval", readState(repo).phase);

    const second = runCli(repo, binDir, "do", [differentRequest]);
    const paused = readState(repo);
    const events = readObservedEvents(repo);
    check("different request: exits 0", second.status === 0, {status: second.status, stderr: second.stderr});
    check("different request: never logs an approval", !second.stdout.includes("Plan approved by"), second.stdout);
    check("different request: no implementer on the abandoned mission", !implementerRan(events));
    check("different request: the new mission re-plans", plannerCount(events) === 2, plannerCount(events));
    check("different request: new mission pauses for its own approval", paused.phase === "plan_approval", paused.phase);
    check("different request: new mission records the new request", String(paused.planningRequest || "").startsWith(differentRequest), paused.planningRequest);

    const third = runCli(repo, binDir, "do", [differentRequest]);
    const state = readState(repo);
    check("different request: same new request consumes its pause", third.stdout.includes("Plan approved by `ap do`"), third.stdout);
    check("different request: new mission completes", state.phase === "complete", state.phase);
  } finally {
    cleanup(repo, binDir);
  }
}

if (failures) {
  console.error(`${failures} plan-approval full/do check(s) failed.`);
  process.exit(1);
}
console.log("test-plan-approval-full: ok");
