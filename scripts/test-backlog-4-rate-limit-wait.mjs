#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseRateLimitResetMs,
  formatLocalHHMM,
  shouldWaitRateLimitReset,
  __rateLimitWaitHooks,
  defaultInterruptibleSleep,
} from "./rate-limit-wait.mjs";
import { buildReportModel, renderReport, classifyStatus } from "./watch-report.mjs";
import { escalateIfRateLimited } from "./planning-review-wiring.mjs";
import { adapterDriver } from "./adapter-drivers.mjs";
import { toNewLayoutConfig } from "./config-layout.mjs";
import { withoutOuterGitGuard } from "./test-fixtures/workflow-order-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");

const BASE_NOW = 1795185000000; // a fixed reference timestamp (epoch ms)

// ── 1. Observation parsing: Claude rate_limit_event resetsAt & Codex retryAt ─
{
  const claudeEvents = [
    {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        rateLimitType: "five_hour",
        resetsAt: 1795186200, // epoch seconds (20 min after base)
      },
    },
  ];
  const observations = adapterDriver("claude").observe(claudeEvents);
  assert.equal(observations.length, 1, "exactly one rate_limited observation");
  assert.equal(observations[0].type, "rate_limited");
  assert.equal(observations[0].resetsAt, 1795186200, "observation carries resetsAt epoch seconds");

  const resetMs = parseRateLimitResetMs(observations);
  assert.equal(resetMs, 1795186200000, "parseRateLimitResetMs converts epoch seconds to ms");

  const codexEvidence = [
    {
      type: "rate_limited",
      reason: "codex_usage_limit",
      retryAt: "2026-11-20T17:50:00.000Z",
    },
  ];
  const codexResetMs = parseRateLimitResetMs(codexEvidence);
  assert.equal(codexResetMs, Date.parse("2026-11-20T17:50:00.000Z"), "parseRateLimitResetMs parses ISO retryAt");
  console.log("PASS 1: observation parsing carries resetsAt and retryAt");
}

// ── 3. Reset beyond window → escalates (pure-function check) ────────────────
{
  const nowMs = BASE_NOW;
  const resetMs = nowMs + 90 * 60_000; // 90 minutes away, window is 60

  const rateLimitedResult = {
    status: "failed",
    sessionId: "sess-123",
    failure: {
      class: "RATE_LIMITED",
      domain: "infrastructure",
      retryable: false,
      evidence: [
        {
          type: "rate_limited",
          resetsAt: resetMs / 1000,
        },
      ],
    },
  };

  const config = {
    advanced: { rate_limit_wait_max_minutes: 60 },
  };

  let sleepCalled = false;
  __rateLimitWaitHooks.sleep = async () => { sleepCalled = true; };

  const decision = shouldWaitRateLimitReset(rateLimitedResult, [], config, nowMs);
  assert.equal(decision, null, "decision must be null when reset is beyond max wait window");
  assert.equal(sleepCalled, false, "sleep must not be called");

  const state = { mission: "002-beyond-window", phase: "planning", step: "spec" };
  let fatalMessage = null;
  const escalated = escalateIfRateLimited(config, state, "speckit-gate-review", rateLimitedResult, {
    fatal: (m) => { fatalMessage = m; },
    saveState: () => {},
    escalatePrefix: "SpecKit planner spec",
  });
  assert.equal(escalated, true, "escalateIfRateLimited escalates");
  assert.equal(state.step, "rate_limited_escalation", "persists rate_limited_escalation step");
  assert.ok(fatalMessage && fatalMessage.includes("RATE_LIMITED is not retryable"), "fatal message names non-retryable rate limit");
  console.log("PASS 3: reset beyond window escalates without waiting");
}

// ── 4. Window 0 → escalates (pure-function check) ───────────────────────────
{
  const nowMs = BASE_NOW;
  const resetMs = nowMs + 2 * 60_000; // 2 minutes away, but window is 0 (disabled)

  const rateLimitedResult = {
    status: "failed",
    sessionId: "sess-123",
    failure: {
      class: "RATE_LIMITED",
      domain: "infrastructure",
      retryable: false,
      evidence: [
        {
          type: "rate_limited",
          resetsAt: resetMs / 1000,
        },
      ],
    },
  };

  const config = {
    advanced: { rate_limit_wait_max_minutes: 0 },
  };

  let sleepCalled = false;
  __rateLimitWaitHooks.sleep = async () => { sleepCalled = true; };

  const decision = shouldWaitRateLimitReset(rateLimitedResult, [], config, nowMs);
  assert.equal(decision, null, "decision must be null when window is 0 (off)");
  assert.equal(sleepCalled, false, "sleep must not be called");

  const state = { mission: "003-window-zero", phase: "planning", step: "spec" };
  const escalated = escalateIfRateLimited(config, state, "speckit-gate-review", rateLimitedResult, {
    fatal: () => {},
    saveState: () => {},
  });
  assert.equal(escalated, true, "window 0 escalates immediately");
  assert.equal(state.step, "rate_limited_escalation");
  console.log("PASS 4: window 0 escalates without waiting");
}

// ── 5. Stop during wait & watch-report display (pure-function check) ────────
{
  const nowMs = BASE_NOW;
  const resetMs = nowMs + 120_000;
  const timeStr = formatLocalHHMM(resetMs);

  const rateLimitedResult = {
    status: "failed",
    sessionId: "sess-123",
    failure: {
      class: "RATE_LIMITED",
      domain: "infrastructure",
      retryable: false,
      evidence: [{ type: "rate_limited", resetsAt: resetMs / 1000 }],
    },
  };

  const config = { advanced: { rate_limit_wait_max_minutes: 60 } };
  const state = { mission: "004-stop-during-wait", phase: "planning", step: "spec" };

  const waitDecision = shouldWaitRateLimitReset(rateLimitedResult, [], config, nowMs);
  assert.ok(waitDecision, "decision must be to wait");
  assert.equal(waitDecision.resetMs, resetMs, "resetMs matches");
  assert.equal(waitDecision.waitMs, 180_000, "waitMs is reset + 60s when test cap is unset");
  assert.equal(waitDecision.timeStr, timeStr, "timeStr matches HH:MM format");

  state.rateLimitWait = { resetAt: new Date(waitDecision.resetMs).toISOString(), time: waitDecision.timeStr };
  const model = buildReportModel({ state, runs: [], events: [], phases: [] });
  const report = renderReport(model, { stamp: "2026-11-20 17:48:00" });
  assert.ok(
    report.includes(`waiting for rate limit reset at ${timeStr}`),
    `watch report must include "waiting for rate limit reset at ${timeStr}"`
  );

  delete state.rateLimitWait;
  const statusInfo = classifyStatus(state, { ownerAlive: false });
  assert.equal(statusInfo.status, "STOPPED", "mission status is STOPPED on ap stop");
  console.log("PASS 5: watch-report display during wait & stopped status");
}

// Reset hooks to defaults before real-sleep and e2e tests
__rateLimitWaitHooks.now = () => Date.now();
__rateLimitWaitHooks.sleep = defaultInterruptibleSleep;

// ── 6. defaultInterruptibleSleep keeps event loop alive & cleans up signals ─
{
  const moduleUrl = new URL("./rate-limit-wait.mjs", import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { defaultInterruptibleSleep } from ${JSON.stringify(moduleUrl)}; await defaultInterruptibleSleep(300); console.log("DONE");`,
    ],
    { encoding: "utf8", timeout: 10000, shell: false }
  );
  assert.equal(child.status, 0, `child must exit 0 (stderr=${child.stderr})`);
  assert.equal(
    (child.stdout || "").trim(),
    "DONE",
    "defaultInterruptibleSleep must keep the event loop alive until the timer completes"
  );

  // Timer path: both SIGINT and SIGTERM listeners removed on completion
  const sigintBefore = process.listenerCount("SIGINT");
  const sigtermBefore = process.listenerCount("SIGTERM");
  await defaultInterruptibleSleep(20);
  assert.equal(process.listenerCount("SIGINT"), sigintBefore, "SIGINT listener removed after timer completes");
  assert.equal(process.listenerCount("SIGTERM"), sigtermBefore, "SIGTERM listener removed after timer completes");

  // Signal path: both SIGINT and SIGTERM listeners removed when interrupted by signal
  const pending = defaultInterruptibleSleep(5000);
  assert.equal(process.listenerCount("SIGINT"), sigintBefore + 1, "SIGINT listener attached during sleep");
  assert.equal(process.listenerCount("SIGTERM"), sigtermBefore + 1, "SIGTERM listener attached during sleep");
  process.emit("SIGINT");
  await pending;
  assert.equal(process.listenerCount("SIGINT"), sigintBefore, "SIGINT listener removed on SIGINT");
  assert.equal(process.listenerCount("SIGTERM"), sigtermBefore, "SIGTERM listener removed on SIGINT");
  console.log("PASS 6: defaultInterruptibleSleep keeps event loop alive and cleans up both signal listeners");
}

// ── 2 & 7. Real-path e2e tests driving autopilot.mjs runRelay() ─────────────
if (process.platform === "win32") {
  console.log("test-backlog-4-rate-limit-wait: real-path e2e SKIP — requires Linux/WSL2 (bubblewrap) for the \"claude\" adapter.");
  console.log("ALL test-backlog-4-rate-limit-wait UNIT CHECKS PASSED");
  process.exit(0);
}

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: "pipe", env: withoutOuterGitGuard(process.env), shell: false });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout || "").trim();
}

const FAKE_CLAUDE_LAUNCHER = `#!/bin/sh
# Disposable fake claude launcher, generated at test runtime by
# test-backlog-4-rate-limit-wait.mjs (not a committed fixture).
# real target: "claude.com"
set -eu
exec "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/claude.com" "$@"
`;

const FAKE_CLAUDE_TARGET = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("fake-claude-rate-limit-wait 1.0.0\\n"); process.exit(0); }

function countPriorRoleResults(targetRole) {
  let count = 0;
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "result.json") {
        try {
          const parsed = JSON.parse(fs.readFileSync(full, "utf8"));
          if (parsed && parsed.role === targetRole) count += 1;
        } catch {}
      }
    }
  }
  walk(".autopilot");
  return count;
}

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => { stdin += c; });
process.stdin.on("end", () => {
  const roleLine = (stdin.trimStart().split(/\\r?\\n/, 1)[0] || "");
  const role = roleLine.startsWith("ROLE=") ? roleLine.slice("ROLE=".length) : "";
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
  const finishOk = (sessionId, text) => {
    emit({ type: "system", subtype: "init", session_id: sessionId });
    emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
    emit({ type: "result", subtype: "success", is_error: false, result: text, terminal_reason: "completed" });
    process.exit(0);
  };

  if (role === "plan_reviewer") {
    const prior = countPriorRoleResults("plan_reviewer");
    if (prior === 0) {
      const resetsAt = Math.floor(Date.now() / 1000) + 60;
      emit({ type: "system", subtype: "init", session_id: "fake-plan-reviewer-session" });
      emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt } });
      process.stderr.write("fake-claude: rate limited\\n");
      process.exit(1);
    }
    const sentinel = "AUTOPILOT_REVIEW=" + JSON.stringify({ decision: "PASS", findings: [] });
    return finishOk("fake-plan-reviewer-session", sentinel);
  }

  if (role === "planner") {
    const planMatch = stdin.match(/Write the (?:narrative )?plan to exactly:\\s*(.*)/);
    const tasksMatch = stdin.match(/Write the phased checklist to exactly:\\s*(.*)/);
    const legacyMatch = !planMatch ? stdin.match(/Write the plan to exactly:\\s*(.*)/) : null;
    if (planMatch || legacyMatch) {
      const planPath = planMatch ? planMatch[1].trim() : legacyMatch[1].trim();
      if (tasksMatch) {
        fs.writeFileSync(planPath, "# Plan\\n\\nObjective: add a fixture line to README.md\\n");
        fs.writeFileSync(tasksMatch[1].trim(), "## Phase 1: General\\n\\n- [ ] 1. Add a fixture line to README.md\\n");
      } else if (planMatch) {
        fs.writeFileSync(planPath, "# Plan\\n\\nObjective: add a fixture line to README.md\\n");
        fs.writeFileSync(planPath.replace(/PLAN\\.md$/, "TASKS.md"), "## Phase 1: General\\n\\n- [ ] 1. Add a fixture line to README.md\\n");
      } else {
        fs.writeFileSync(planPath, "# Plan\\n\\n## Checklist\\n\\n- [ ] 1. Add a fixture line to README.md\\n\\nVerification: manual.\\n");
      }
      return finishOk("fake-planner-session", "Wrote the plan.");
    }
    return finishOk("fake-planner-session", "Wrote the plan.");
  }

  if (role === "implementer") {
    try { fs.appendFileSync("README.md", "implementer change\\n"); } catch {}
    const taskResult = "AUTOPILOT_TASK_RESULT=" + JSON.stringify({
      summary: "Added a fixture line to README.md.",
      taskLocalCheck: { command: "check", status: "passed", exitCode: 0, summary: "fixture check passed" },
    });
    return finishOk("fake-implementer-session", "Implemented the task.\\n" + taskResult);
  }

  const sentinel = "AUTOPILOT_REVIEW=" + JSON.stringify({ decision: "PASS", findings: [] });
  return finishOk("fake-" + role + "-session", sentinel);
});
`;

function makeBin() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-rl-wait-bin-"));
  const claudeLauncherPath = path.join(binDir, "claude");
  fs.writeFileSync(claudeLauncherPath, FAKE_CLAUDE_LAUNCHER);
  fs.chmodSync(claudeLauncherPath, 0o755);
  const claudeTargetPath = path.join(binDir, "claude.com");
  fs.writeFileSync(claudeTargetPath, FAKE_CLAUDE_TARGET);
  fs.chmodSync(claudeTargetPath, 0o755);
  return binDir;
}

function makeConfig(rateLimitWaitMaxMinutes) {
  const claudeRole = {
    adapter: "claude",
    model: "sonnet",
    reasoning: "low",
    variant: "",
    resume: false,
    model_source: "default",
    model_verified_at: null,
    capabilities_verified_at: null,
  };
  const runtimeCfg = {
    schema_version: "3.0",
    project: { repo: ".", planning_framework: "standalone", state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs" },
    roles: { planner: claudeRole, plan_reviewer: claudeRole, implementer: claudeRole, code_reviewer: claudeRole, verifier: claudeRole },
    workflow: {
      specReview: true,
      planReview: true,
      analysisAfterTasks: true,
      implementationReview: true,
      finalReview: true,
      autoApproveSpec: false,
      autoApprovePlan: false,
      parallelIndependentTasks: false,
      gsdPlanningReview: false,
      standaloneSpec: false,
      relaySafety: { block_git_commit_push: true, verify_read_only_by_snapshot: true, capture_touched_files: true, persist_role_sessions: true },
    },
    gates: { commands: [], env_allowlist: [], require_reviewer: true, network_isolation: true },
    policy: {
      max_plan_revisions: 3,
      retry_delay_ms: 0,
      checkpoint_after_task: true,
      checkpoint_after_phase: true,
      require_human_commit: true,
      fail_closed_on_relay_violation: true,
      rate_limit_wait_max_minutes: rateLimitWaitMaxMinutes,
      failure_budgets: { implementationFailureBudget: 5, verificationFailureBudget: 5, adapterRetryBudget: 5, infrastructureRetryBudget: 2 },
    },
    safety: { allow_git_commit: false, allow_git_push: false, allow_destructive_operations: false },
    planning: {
      speckit: { workflow_file: ".specify/workflows/speckit/workflow.yml", task_candidates: [".specify/tasks.md", "specs/*/tasks.md", "specs/*/tasks/*.md"] },
      gsd: {
        phase_root: ".planning/phases",
        run_plan_verify: false,
        run_state_validate: false,
        write_summary_artifacts: true,
        write_verification_artifacts: true,
        write_uat_artifact: true,
        use_gsd_tools_when_available: false,
        parallelization: { enabled: false, plan_level: false, task_level: false, max_concurrent_agents: 1, min_plans_for_parallel: 99 },
        planning_review: { enabled: false, review_after_each_stage: true, stages: ["discuss", "research", "plan", "plan-check"], max_revisions: 3, read_only_reviewer: true },
      },
    },
    capabilities: { project_defaults: [], role_requirements: {}, safety_denied: [], legacy_text_inference: false, verification: { browser: "native", require_browser: "when-task-requires" } },
  };
  const v4 = toNewLayoutConfig(runtimeCfg);
  v4.advanced = { ...(v4.advanced || {}), rate_limit_wait_max_minutes: rateLimitWaitMaxMinutes };
  return v4;
}

function makeRepo(prefix) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `ap-rl-wait-${prefix}-`));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "rate-limit-wait-test@example.invalid"]);
  git(repo, ["config", "user.name", "Rate Limit Wait Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

function runMission(repo, binDir, request, extraEnv = {}, timeoutMs = 300000) {
  const base = withoutOuterGitGuard({ ...process.env });
  const env = { ...base, PATH: `${binDir}:${base.PATH || ""}`, ...extraEnv };
  return spawnSync(process.execPath, [path.join(skillRoot, "scripts", "autopilot.mjs"), "run", request, "--repo", repo], {
    cwd: repo,
    encoding: "utf8",
    env,
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
}

function readAllResults(root) {
  const results = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "result.json") results.push(JSON.parse(fs.readFileSync(full, "utf8")));
    }
  })(root);
  return results;
}

// ── 2. Real-path e2e: plan_reviewer hits RATE_LIMITED with resetsAt=now+60s ─
//    advanced.rate_limit_wait_max_minutes=60 + AUTOPILOT_TEST_RATE_LIMIT_WAIT_MS=50
//    → waits, re-runs plan_reviewer, second call PASSes, no escalation,
//    console/log has "waiting for rate limit reset at", state.rateLimitWait removed.
{
  const repo = makeRepo("real-wait");
  const binDir = makeBin();
  try {
    fs.mkdirSync(path.join(repo, ".autopilot"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), JSON.stringify(makeConfig(60), null, 2));

    const run = runMission(repo, binDir, "add a fixture line to README.md", {
      AUTOPILOT_TEST_RATE_LIMIT_WAIT_MS: "50",
    });
    const combinedOutput = `${run.stdout || ""}\n${run.stderr || ""}`;
    assert.equal(run.error?.code, undefined, `mission must not time out or spawn-error: ${run.error}`);
    assert.equal(
      run.status,
      0,
      `mission must complete with exit 0 (no escalation); got status=${run.status}\nSTDOUT:\n${(run.stdout || "").slice(-1500)}\nSTDERR:\n${(run.stderr || "").slice(-1500)}`
    );
    assert.ok(
      combinedOutput.includes("waiting for rate limit reset at"),
      `console/log must contain "waiting for rate limit reset at"; got:\n${combinedOutput.slice(-1500)}`
    );

    const results = readAllResults(path.join(repo, ".autopilot"));
    const planReviewerRuns = results
      .filter((r) => r.role === "plan_reviewer")
      .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    assert.equal(
      planReviewerRuns.length,
      2,
      `expected exactly 2 plan_reviewer runs, got ${planReviewerRuns.length}: ${JSON.stringify(planReviewerRuns.map((r) => ({ status: r.status, failure: r.failure?.class })))}`
    );
    assert.equal(planReviewerRuns[0].status, "failed", "first plan_reviewer run failed");
    assert.equal(planReviewerRuns[0].failure?.class, "RATE_LIMITED", "first plan_reviewer run classified RATE_LIMITED");
    assert.equal(planReviewerRuns[1].status, "completed", "second plan_reviewer run completed");

    const state = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
    assert.notEqual(state.phase, "escalated", "mission must not be escalated");
    assert.notEqual(state.step, "rate_limited_escalation", "mission step must not be rate_limited_escalation");
    assert.equal(state.rateLimitWait, undefined, "state.rateLimitWait must be removed after wait");
    console.log("PASS 2: real-path runRelay waits for rate-limit reset, re-runs plan_reviewer, completes without escalation");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  }
}

// ── 7. Real-path e2e: window 0 → escalates RATE_LIMITED without waiting ────
{
  const repo = makeRepo("real-window-zero");
  const binDir = makeBin();
  try {
    fs.mkdirSync(path.join(repo, ".autopilot"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), JSON.stringify(makeConfig(0), null, 2));

    const run = runMission(repo, binDir, "add a fixture line to README.md", {
      AUTOPILOT_TEST_RATE_LIMIT_WAIT_MS: "50",
    });
    const combinedOutput = `${run.stdout || ""}\n${run.stderr || ""}`;
    assert.equal(run.error?.code, undefined, `mission must not time out or spawn-error: ${run.error}`);
    assert.notEqual(run.status, 0, "window 0 must escalate with non-zero exit");
    assert.ok(
      /RATE_LIMITED is not retryable/.test(run.stderr || ""),
      `stderr must name RATE_LIMITED as not retryable; got:\n${(run.stderr || "").slice(-1500)}`
    );
    assert.ok(
      !combinedOutput.includes("waiting for rate limit reset at"),
      "window 0 must not log waiting for rate limit reset"
    );

    const results = readAllResults(path.join(repo, ".autopilot"));
    const planReviewerRuns = results
      .filter((r) => r.role === "plan_reviewer")
      .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    assert.equal(
      planReviewerRuns.length,
      1,
      `expected exactly 1 plan_reviewer run when window is 0, got ${planReviewerRuns.length}`
    );
    assert.equal(planReviewerRuns[0].failure?.class, "RATE_LIMITED", "plan_reviewer run classified RATE_LIMITED");

    const state = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
    assert.equal(state.phase, "escalated", "window 0 escalates mission phase");
    assert.equal(state.step, "rate_limited_escalation", "window 0 persists rate_limited_escalation step");
    assert.equal(state.rateLimitWait, undefined, "state.rateLimitWait must not remain set");
    console.log("PASS 7: real-path window 0 escalates RATE_LIMITED immediately without waiting");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  }
}

console.log("ALL test-backlog-4-rate-limit-wait CHECKS PASSED");
