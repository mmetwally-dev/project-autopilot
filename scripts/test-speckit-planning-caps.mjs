#!/usr/bin/env node
// Behavioural coverage for SpecKit planning caps: every planner and
// plan_reviewer generation must be cap-enabled, a capped generation must
// continue (not fail), and the continuation prompt must carry the prior
// dead ends. Uses the real autopilot subprocess + opencode-shaped fixture so
// runRelay's cap monitor, handleCappedPlanningResult, and the continuation
// wiring are all exercised together.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  makeFixtureRepo, makeFixtureBin, makeSpecKitPhaseFixture, writeConfig,
  runAutopilot, readObservedEvents,
} from "./test-fixtures/workflow-order-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "test-fixtures", "fake-planning-cap-adapter.mjs");

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
};

const repo = makeFixtureRepo("speckit-planning-cap");
const binDir = makeFixtureBin("speckit-planning-cap");
makeSpecKitPhaseFixture(repo);
writeConfig(repo, {planningFramework: "speckit", maxPlanRevisions: 2});

// The reviewer runs inside the read-only sandbox, which binds the adapter
// executable itself (not sibling files in the skill checkout). Install the
// self-contained fixture as the opencode binary so no second path is needed.
const shimPath = path.join(binDir, process.platform === "win32" ? "opencode.cmd" : "opencode");
if (process.platform === "win32") {
  const fixtureCopy = path.join(binDir, "fake-planning-cap-adapter.mjs");
  fs.copyFileSync(FIXTURE, fixtureCopy);
  fs.writeFileSync(shimPath, `@echo off\r\n"${process.execPath}" "${fixtureCopy}" %*\r\nexit /b %errorlevel%\r\n`);
} else {
  fs.copyFileSync(FIXTURE, shimPath);
  fs.chmodSync(shimPath, 0o755);
}

const configPath = path.join(repo, ".autopilot", "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
config.roles.planner.adapter = "opencode";
config.roles.plan_reviewer.adapter = "opencode";
config.workflow.implementationReview = false;
config.workflow.finalReview = false;
config.policy = {
  ...config.policy,
  per_task_max_turns: 5,
  per_task_max_tokens: 10_000_000,
  per_task_timeout_ms: 60_000,
  continuation_allowance: 1,
  no_progress_generations: 10,
};
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

const result = runAutopilot(repo, binDir, {request: "planning-cap fixture", timeoutMs: 120_000});
const events = readObservedEvents(repo);
const runs = events
  .filter((e) => e.role === "planner" || e.role === "plan_reviewer")
  .map((e) => ({...e, data: JSON.parse(fs.readFileSync(e.file, "utf8"))}));
const planner = runs.filter((r) => r.role === "planner");
const reviewer = runs.filter((r) => r.role === "plan_reviewer");
const capped = (r) => r.data.status === "capped";
const completed = (r) => r.data.status === "completed";

check("mission did not time out", !result.timedOut);
check("planner ran a capped generation and a continuation", planner.length >= 2, planner.length);
check("plan_reviewer ran a capped generation and a continuation", reviewer.length >= 2, reviewer.length);
check("planner cap continued instead of failing", planner.filter(capped).length >= 1, planner.map((r) => r.data.status));
check("planner continuation completed", planner.filter(completed).length >= 1, planner.map((r) => r.data.status));
check("reviewer cap continued instead of failing", reviewer.filter(capped).length >= 1, reviewer.map((r) => r.data.status));
check("reviewer continuation completed", reviewer.filter(completed).length >= 1, reviewer.map((r) => r.data.status));
check("every capped planning run is a turn cap", [...planner, ...reviewer].filter(capped).every((r) => r.data.capType === "turns"));
const state = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
check("completed planning roles leave no spent continuation debris", (() => {
  const dead = state.rolloverDeadEnds || {};
  const entries = (scope) => Object.entries(dead)
    .filter(([key]) => key.includes(scope))
    .reduce((n, [, list]) => n + (Array.isArray(list) ? list.length : 0), 0);
  return entries("task:speckit:planning:planner") === 0
    && entries("task:speckit:planning:plan_reviewer") === 0;
})());
check("capped planner hand-off note reached the continuation session", (() => {
  const found = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "brief.txt") found.push(fs.readFileSync(full, "utf8"));
    }
  })(path.join(repo, ".autopilot"));
  return found.some((text) => text.includes("CAP-PLANNER-NOTE"));
})());
check("planner hand-off note cleared after the planner completed (backlog #7)",
  !fs.existsSync(path.join(repo, ".autopilot", "missions", state.mission, "handoff", "speckit-planning-planner.md")));
check("planning reached tasks_ready or implementation", (() => {
  return state.phase === "tasks_ready" || state.phase === "implementation" || state.phase === "complete" || state.phase === "review";
})(), result.stdout.slice(-500));
if (failures) {
  console.error(`\n${failures} speckit-planning-cap check(s) failed.`);
  process.exit(1);
}
console.log("\nspeckit-planning-cap tests passed");
