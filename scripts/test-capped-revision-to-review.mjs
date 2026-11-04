#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  makeFixtureRepo, makeFixtureBin, makeSpecKitPhaseFixture, writeConfig,
  setScenario, runAutopilot, readObservedEvents, cleanup,
} from "./test-fixtures/workflow-order-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER_FILE = path.join(here, "test-fixtures", "fake-capped-revision-adapter.mjs");

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

function installFakeAdapter(binDir) {
  const shimPath = path.join(binDir, process.platform === "win32" ? "opencode.cmd" : "opencode");
  if (process.platform === "win32") {
    const fixtureCopy = path.join(binDir, "fake-adapter.mjs");
    fs.copyFileSync(ADAPTER_FILE, fixtureCopy);
    fs.writeFileSync(shimPath, `@echo off\r\n"${process.execPath}" "${fixtureCopy}" %*\r\nexit /b %errorlevel%\r\n`);
  } else {
    fs.copyFileSync(ADAPTER_FILE, shimPath);
    fs.chmodSync(shimPath, 0o755);

    // Provide a bwrap shim so read-only reviewer envelope tests can run inside sandboxed test runners
    const bwrapShim = path.join(binDir, "bwrap");
    fs.writeFileSync(bwrapShim, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "bubblewrap 0.8.0"
  exit 0
fi
HOST_BIN=""
SANDBOX_BIN=""
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
  if [ "$1" = "--ro-bind" ]; then
    shift
    if [ -f "$1" ]; then
      HOST_BIN="$1"
      shift
      SANDBOX_BIN="$1"
    fi
  fi
  shift
done
if [ "$1" = "--" ]; then
  shift
fi
CMD="$1"
shift
if [ -n "$HOST_BIN" ] && [ "$CMD" = "$SANDBOX_BIN" ]; then
  CMD="$HOST_BIN"
fi
exec "$CMD" "$@"
`);
    fs.chmodSync(bwrapShim, 0o755);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Case 1: SpecKit tasks stage, review FAIL then planner revision capped after editing tasks.md
// ────────────────────────────────────────────────────────────────────────────
{
  const repo = makeFixtureRepo("capped-rev-c1");
  const binDir = makeFixtureBin("capped-rev-c1");
  try {
    installFakeAdapter(binDir);
    makeSpecKitPhaseFixture(repo);
    writeConfig(repo, {planningFramework: "speckit", maxPlanRevisions: 2, networkIsolation: false});
    const configPath = path.join(repo, ".autopilot", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.roles.planner.adapter = "opencode";
    config.roles.plan_reviewer.adapter = "opencode";
    config.workflow.implementationReview = false;
    config.workflow.finalReview = false;
    config.policy = {
      ...config.policy,
      per_task_max_turns: 3,
      per_task_max_tokens: 10_000_000,
      per_task_timeout_ms: 60_000,
      continuation_allowance: 2,
      no_progress_generations: 5,
      caps: {
        planner: { max_turns: 3, extra_sessions: 2 },
        plan_reviewer: { max_turns: 3, extra_sessions: 2 },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    setScenario(repo, "case1_speckit_revision_capped_with_edit");

    const result = runAutopilot(repo, binDir, {request: "speckit test", stage: "planning", timeoutMs: 60_000});
    const runs = readObservedEvents(repo).map(e => ({role: e.role, status: e.status, ...JSON.parse(fs.readFileSync(e.file, "utf8"))}));

    const cappedPlannerIdx = runs.findIndex((r, idx) => r.role === "planner" && r.status === "capped" && runs.slice(0, idx).some(pr => pr.role === "plan_reviewer" && (pr.verdict?.decision === "FAIL" || pr.decision === "FAIL")));
    check("case 1: planner revision was capped", cappedPlannerIdx !== -1, runs.map(r => ({role: r.role, status: r.status, planRevision: r.planRevision})));

    const nextRun = runs[cappedPlannerIdx + 1];
    check("case 1: next run is plan_reviewer (sent to review instead of continuation)", nextRun?.role === "plan_reviewer", nextRun?.role);

    const out = `${result.stdout}\n${result.stderr}`;
    check("case 1: no 'continuing as session' line in output", !out.includes("continuing as session"), out.slice(-400));

    const state = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
    const deadEnds = state.rolloverDeadEnds?.["continuationAllowance:task:speckit:planning:planner"] || [];
    const allowanceConsumed = state.continuationBudgets?.["continuationAllowance:task:speckit:planning:planner"] || 0;
    check("case 1: continuation allowance unchanged", allowanceConsumed === 0 && deadEnds.length === 0, {allowanceConsumed, deadEnds});

    check("case 1: logged expected line sending revision to review",
      out.includes("hit the turns cap after editing") && out.includes("; sending the revision to review instead of another session."),
      out.slice(-500));
  } finally {
    cleanup(repo, binDir);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Case 2: Same as Case 1, but planner edited nothing
// ────────────────────────────────────────────────────────────────────────────
{
  const repo = makeFixtureRepo("capped-rev-c2");
  const binDir = makeFixtureBin("capped-rev-c2");
  try {
    installFakeAdapter(binDir);
    makeSpecKitPhaseFixture(repo);
    writeConfig(repo, {planningFramework: "speckit", maxPlanRevisions: 2, networkIsolation: false});
    const configPath = path.join(repo, ".autopilot", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.roles.planner.adapter = "opencode";
    config.roles.plan_reviewer.adapter = "opencode";
    config.workflow.implementationReview = false;
    config.workflow.finalReview = false;
    config.policy = {
      ...config.policy,
      per_task_max_turns: 3,
      per_task_max_tokens: 10_000_000,
      per_task_timeout_ms: 60_000,
      continuation_allowance: 2,
      no_progress_generations: 5,
      caps: {
        planner: { max_turns: 3, extra_sessions: 2 },
        plan_reviewer: { max_turns: 3, extra_sessions: 2 },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    setScenario(repo, "case2_speckit_revision_capped_no_edit");

    const result = runAutopilot(repo, binDir, {request: "speckit test", stage: "planning", timeoutMs: 60_000});
    const runs = readObservedEvents(repo).map(e => ({role: e.role, status: e.status, ...JSON.parse(fs.readFileSync(e.file, "utf8"))}));

    const cappedPlannerIdx = runs.findIndex((r, idx) => r.role === "planner" && r.status === "capped" && runs.slice(0, idx).some(pr => pr.role === "plan_reviewer" && (pr.verdict?.decision === "FAIL" || pr.decision === "FAIL")));
    check("case 2: planner revision was capped", cappedPlannerIdx !== -1, runs.map(r => ({role: r.role, status: r.status, planRevision: r.planRevision})));

    const nextRun = runs[cappedPlannerIdx + 1];
    check("case 2: next run is planner (existing continuation behaviour)", nextRun?.role === "planner", nextRun?.role);

    const out = `${result.stdout}\n${result.stderr}`;
    check("case 2: output includes 'continuing as session'", out.includes("continuing as session"), out.slice(-400));
  } finally {
    cleanup(repo, binDir);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Case 3: Standalone planning equivalent of Case 1
// ────────────────────────────────────────────────────────────────────────────
{
  const repo = makeFixtureRepo("capped-rev-c3");
  const binDir = makeFixtureBin("capped-rev-c3");
  try {
    installFakeAdapter(binDir);
    writeConfig(repo, {planningFramework: "standalone", maxPlanRevisions: 2, networkIsolation: false});
    const configPath = path.join(repo, ".autopilot", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.roles.planner.adapter = "opencode";
    config.roles.plan_reviewer.adapter = "opencode";
    config.workflow.implementationReview = false;
    config.workflow.finalReview = false;
    config.policy = {
      ...config.policy,
      per_task_max_turns: 3,
      per_task_max_tokens: 10_000_000,
      per_task_timeout_ms: 60_000,
      continuation_allowance: 2,
      no_progress_generations: 5,
      caps: {
        planner: { max_turns: 3, extra_sessions: 2 },
        plan_reviewer: { max_turns: 3, extra_sessions: 2 },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    setScenario(repo, "case3_standalone_revision_capped_with_edit");

    const result = runAutopilot(repo, binDir, {request: "standalone test", stage: "planning", timeoutMs: 60_000});
    const runs = readObservedEvents(repo).map(e => ({role: e.role, status: e.status, ...JSON.parse(fs.readFileSync(e.file, "utf8"))}));

    const cappedPlannerIdx = runs.findIndex((r, idx) => r.role === "planner" && r.status === "capped" && runs.slice(0, idx).some(pr => pr.role === "plan_reviewer" && (pr.verdict?.decision === "FAIL" || pr.decision === "FAIL")));
    check("case 3: standalone planner revision was capped", cappedPlannerIdx !== -1, runs.map(r => ({role: r.role, status: r.status, planRevision: r.planRevision})));

    const nextRun = runs[cappedPlannerIdx + 1];
    check("case 3: next run is plan_reviewer (sent to review instead of continuation)", nextRun?.role === "plan_reviewer", nextRun?.role);

    const out = `${result.stdout}\n${result.stderr}`;
    check("case 3: no 'continuing as session' line in output", !out.includes("continuing as session"), out.slice(-400));

    const state = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
    const deadEnds = state.rolloverDeadEnds?.["continuationAllowance:task:standalone:planning:planner"] || [];
    const allowanceConsumed = state.continuationBudgets?.["continuationAllowance:task:standalone:planning:planner"] || 0;
    check("case 3: continuation allowance unchanged", allowanceConsumed === 0 && deadEnds.length === 0, {allowanceConsumed, deadEnds});

    check("case 3: logged expected line sending revision to review",
      out.includes("hit the turns cap after editing") && out.includes("; sending the revision to review instead of another session."),
      out.slice(-500));
  } finally {
    cleanup(repo, binDir);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Case 4: First-attempt planner capped after editing → existing continuation
// ────────────────────────────────────────────────────────────────────────────
{
  const repo = makeFixtureRepo("capped-rev-c4");
  const binDir = makeFixtureBin("capped-rev-c4");
  try {
    installFakeAdapter(binDir);
    writeConfig(repo, {planningFramework: "standalone", maxPlanRevisions: 2, networkIsolation: false});
    const configPath = path.join(repo, ".autopilot", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.roles.planner.adapter = "opencode";
    config.roles.plan_reviewer.adapter = "opencode";
    config.workflow.implementationReview = false;
    config.workflow.finalReview = false;
    config.policy = {
      ...config.policy,
      per_task_max_turns: 3,
      per_task_max_tokens: 10_000_000,
      per_task_timeout_ms: 60_000,
      continuation_allowance: 2,
      no_progress_generations: 5,
      caps: {
        planner: { max_turns: 3, extra_sessions: 2 },
        plan_reviewer: { max_turns: 3, extra_sessions: 2 },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    setScenario(repo, "case4_first_attempt_capped_with_edit");

    const result = runAutopilot(repo, binDir, {request: "standalone test", stage: "planning", timeoutMs: 60_000});
    const runs = readObservedEvents(repo).map(e => ({role: e.role, status: e.status, ...JSON.parse(fs.readFileSync(e.file, "utf8"))}));

    const cappedPlannerIdx = runs.findIndex(r => r.role === "planner" && r.status === "capped");
    check("case 4: first-attempt planner was capped", cappedPlannerIdx !== -1, runs.map(r => ({role: r.role, status: r.status})));

    const nextRun = runs[cappedPlannerIdx + 1];
    check("case 4: next run is planner (existing continuation, not sent to review)", nextRun?.role === "planner", nextRun?.role);

    const out = `${result.stdout}\n${result.stderr}`;
    check("case 4: output includes 'continuing as session'", out.includes("continuing as session"), out.slice(-400));
  } finally {
    cleanup(repo, binDir);
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll capped-revision-to-review checks passed.");
