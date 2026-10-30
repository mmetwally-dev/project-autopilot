#!/usr/bin/env node
// Backlog #8: a claude login failure (api_error_status 401 / revoked or
// expired OAuth) is AUTH_REQUIRED — terminal for that CLI, never retried as
// a generic adapter error. Replays the three real result lines from the
// a real operator project's mission 002 runs 09-11, then proves the fixture relay
// escalates at once with the log-in instruction and spends no adapter budget.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import {adapterDriver} from "./adapter-drivers.mjs";
import {classifyObservedFailure, failure, recordFailureBudget} from "./failure-contract.mjs";
import {decideRoleFallback} from "./role-fallback.mjs";
import {decideEscalationName} from "./escalation-naming.mjs";
import {classifyStatus, failureClassText} from "./watch-report.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");
const fixtureDir = path.join(here, "test-fixtures");
const realLines = {
  run09: fs.readFileSync(path.join(fixtureDir, "claude-auth-401-result-line.json"), "utf8").trim(),
  run10: fs.readFileSync(path.join(fixtureDir, "claude-auth-oauth-expired-result-line.json"), "utf8").trim(),
  run11: fs.readFileSync(path.join(fixtureDir, "claude-auth-oauth-expired-result-line-2.json"), "utf8").trim(),
};

const claude = adapterDriver("claude");
const classifyEvents = (events, exitCode = 1) => classifyObservedFailure({
  exitCode, stdout: "", stderr: "", startError: null, timedOut: false, driverless: false,
  evidence: claude.observe(events, {}),
});

// ── Three real run 09-11 result lines => AUTH_REQUIRED, non-retryable ──────
for (const [name, line] of Object.entries(realLines)) {
  const event = JSON.parse(line);
  const observed = claude.observe([event], {});
  assert.ok(observed.some(o => o.type === "auth_required"), `${name}: driver emits auth_required`);
  const classified = classifyEvents([event]);
  assert.equal(classified?.class, "AUTH_REQUIRED", `${name}: classified AUTH_REQUIRED`);
  assert.equal(classified?.domain, "adapter", `${name}: adapter domain`);
  assert.equal(classified?.retryable, false, `${name}: not retryable`);
  assert.ok(classified?.evidence?.some(e => e?.reason === "api_error_status_401" || /OAuth session expired/i.test(e?.reason || "")),
    `${name}: evidence names the CLI's own reason`);
  console.log(`PASS ${name} real result line => AUTH_REQUIRED/non-retryable`);
}

// ── Model prose containing "log in again" is NOT an auth failure ──────────
{
  const proseEvents = [
    {type: "assistant", message: {role: "assistant", content: [{type: "text", text: "Please log in again if the session expires."}]}},
    {type: "result", subtype: "success", is_error: false, result: "The docs say: please log in again or contact your administrator."},
  ];
  assert.equal(claude.observe(proseEvents, {}).filter(o => o.type === "auth_required").length, 0,
    "assistant/successful-result prose never produces auth_required");
  assert.notEqual(classifyEvents(proseEvents)?.class, "AUTH_REQUIRED", "prose is not AUTH_REQUIRED");
  console.log("PASS model prose containing 'log in again' is not auth");
}

// ── A 429 remains RATE_LIMITED (Auth takes no precedence over it) ─────────
{
  const rate = {type: "api_error", api_error_status: 429};
  assert.ok(claude.observe([rate], {}).some(o => o.type === "rate_limited"), "429 still emits rate_limited");
  assert.equal(classifyEvents([rate])?.class, "RATE_LIMITED", "429 is still RATE_LIMITED");
  console.log("PASS 429 stays RATE_LIMITED");
}

// ── Budget: AUTH_REQUIRED escalates without consuming adapterRetryBudget ──
{
  const state = {};
  const policy = {failure_budgets: {adapterRetryBudget: 3}};
  const auth = failure("AUTH_REQUIRED", "adapter", false, [{type: "auth_required", adapter: "claude", reason: "OAuth token revoked"}]);
  const first = recordFailureBudget(state, policy, auth, "adapter:claude:implementer");
  assert.equal(first.allowed, false, "first AUTH_REQUIRED is denied (no same-adapter retry)");
  assert.equal(state.failureBudgets?.["adapterRetryBudget:adapter:claude:implementer"], undefined,
    "adapterRetryBudget key stays unset");
  console.log("PASS AUTH_REQUIRED spends no adapter retry budget");
}

// ── Fallback: only ANOTHER adapter is eligible; same adapter never retried ─
{
  const roleConfig = {
    adapter: "claude", model: "opus",
    fallbacks: [
      {adapter: "claude", model: "sonnet"},
      {adapter: "codex", model: "gpt-5"},
    ],
  };
  const switched = decideRoleFallback({role: "implementer", roleConfig, failureClass: "AUTH_REQUIRED"});
  assert.equal(switched.action, "switch", "another CLI fallback switches");
  assert.deepEqual(switched.next, {adapter: "codex", model: "gpt-5"}, "the same-adapter fallback is skipped");
  const sameOnly = decideRoleFallback({
    role: "implementer",
    roleConfig: {adapter: "claude", model: "opus", fallbacks: [{adapter: "claude", model: "sonnet"}]},
    failureClass: "AUTH_REQUIRED",
  });
  assert.equal(sameOnly.action, "escalate", "a same-adapter-only chain escalates instead of retrying claude");
  assert.match(sameOnly.reason, /AUTH_REQUIRED/);
  console.log("PASS fallback switches only to another adapter");
}

// ── Escalation naming: WATCH-REPORT step/detail tell the operator to log in ─
{
  const naming = decideEscalationName({
    failureClass: "AUTH_REQUIRED", retryable: false, used: 0, limit: 3, budget: "adapterRetryBudget",
    evidence: [{type: "auth_required", adapter: "claude", reason: "OAuth token revoked"}],
  });
  assert.equal(naming.step, "auth_required_escalation");
  assert.match(naming.detail, /claude is logged out \(OAuth token revoked\)/);
  assert.match(naming.detail, /run `claude` and log in, then `ap run`/);
  assert.ok(!/adapterRetryBudget_exhausted/.test(`${naming.step} ${naming.detail}`), "never names the budget");
  console.log("PASS escalation names AUTH_REQUIRED and the log-in instruction");
}

// ── WATCH-REPORT: the escalated line names auth, never a budget ───────────
{
  const info = classifyStatus({phase: "escalated", step: "auth_required_escalation", lastFailure: {class: "AUTH_REQUIRED", domain: "adapter"}});
  assert.equal(info.status, "ESCALATED");
  assert.match(info.stopLine, /auth_required_escalation/);
  assert.ok(!/adapterRetryBudget_exhausted/.test(info.stopLine), "WATCH-REPORT never shows budget exhaustion");
  assert.equal(failureClassText("AUTH_REQUIRED"), "authentication required (log in)");
  console.log("PASS WATCH-REPORT names AUTH_REQUIRED");
}

// ── Fixture relay: fake claude emits the real 401 line for the implementer ─
if (process.platform === "win32") {
  console.log("test-auth-required: fixture relay SKIP (requires Linux/WSL2 bubblewrap)");
  console.log("test-auth-required: ALL UNIT CHECKS PASSED");
  process.exit(0);
}

function git(cwd, args) {
  const r = spawnSync("git", args, {cwd, encoding: "utf8", stdio: "pipe", env: withoutOuterGitGuard(process.env), shell: false});
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout || "").trim();
}

const FAKE_CLAUDE_LAUNCHER = `#!/bin/sh
# real target: "claude.com"
set -eu
exec "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/claude.com" "$@"
`;

const FAKE_CLAUDE_TARGET = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("fake-claude-auth 1.0.0\\n"); process.exit(0); }
if (args.includes("auth") && args.includes("status")) { process.stdout.write("Logged in\\n"); process.exit(0); }

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => { stdin += c; });
process.stdin.on("end", () => {
  const roleLine = (stdin.trimStart().split(/\\r?\\n/, 1)[0] || "");
  const role = roleLine.startsWith("ROLE=") ? roleLine.slice("ROLE=".length) : "";
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
  const finishOk = (sessionId, text) => {
    emit({type: "system", subtype: "init", session_id: sessionId});
    emit({type: "assistant", message: {role: "assistant", content: [{type: "text", text}]}});
    emit({type: "result", subtype: "success", is_error: false, result: text, terminal_reason: "completed"});
    process.exit(0);
  };

  if (role === "implementer") {
    // The exact real result line from a real run 09 (401 / revoked OAuth).
    process.stdout.write(${JSON.stringify(realLines.run09 + "\n")});
    process.exit(1);
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

  const sentinel = "AUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: []});
  return finishOk("fake-" + role + "-session", sentinel);
});
`;

function makeBin() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-auth-bin-"));
  fs.writeFileSync(path.join(binDir, "claude"), FAKE_CLAUDE_LAUNCHER);
  fs.chmodSync(path.join(binDir, "claude"), 0o755);
  fs.writeFileSync(path.join(binDir, "claude.com"), FAKE_CLAUDE_TARGET);
  fs.chmodSync(path.join(binDir, "claude.com"), 0o755);
  return binDir;
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-auth-repo-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "auth-test@example.invalid"]);
  git(repo, ["config", "user.name", "Auth Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

function makeConfig() {
  const claudeRole = {adapter: "claude", model: "sonnet", reasoning: "low", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null};
  return {
    schema_version: "3.0",
    project: {repo: ".", planning_framework: "standalone", state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs"},
    roles: {planner: claudeRole, plan_reviewer: claudeRole, implementer: claudeRole, code_reviewer: claudeRole, verifier: claudeRole},
    workflow: {
      specReview: true, planReview: true, analysisAfterTasks: true, implementationReview: true, finalReview: true,
      autoApproveSpec: false, autoApprovePlan: false, parallelIndependentTasks: false, gsdPlanningReview: false,
      relaySafety: {block_git_commit_push: true, verify_read_only_by_snapshot: true, capture_touched_files: true, persist_role_sessions: true}
    },
    gates: {commands: [], env_allowlist: [], require_reviewer: true, network_isolation: true},
    policy: {
      max_plan_revisions: 3, retry_delay_ms: 0, checkpoint_after_task: true, checkpoint_after_phase: true,
      require_human_commit: true, fail_closed_on_relay_violation: true,
      failure_budgets: {implementationFailureBudget: 5, verificationFailureBudget: 5, adapterRetryBudget: 5, infrastructureRetryBudget: 2}
    },
    safety: {allow_git_commit: false, allow_git_push: false, allow_destructive_operations: false},
    planning: {
      speckit: {workflow_file: ".specify/workflows/speckit/workflow.yml", task_candidates: [".specify/tasks.md", "specs/*/tasks.md", "specs/*/tasks/*.md"]},
      gsd: {phase_root: ".planning/phases", run_plan_verify: false, run_state_validate: false, write_summary_artifacts: true, write_verification_artifacts: true, write_uat_artifact: true, use_gsd_tools_when_available: false, parallelization: {enabled: false, plan_level: false, task_level: false, max_concurrent_agents: 1, min_plans_for_parallel: 99}, planning_review: {enabled: false, review_after_each_stage: true, stages: ["discuss", "research", "plan", "plan-check"], max_revisions: 3, read_only_reviewer: true}}
    },
    capabilities: {project_defaults: [], role_requirements: {}, safety_denied: [], legacy_text_inference: false, verification: {browser: "native", require_browser: "when-task-requires"}}
  };
}

function readAllResults(root) {
  const results = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "result.json") results.push(JSON.parse(fs.readFileSync(full, "utf8")));
    }
  })(root);
  return results;
}

{
  const repo = makeRepo();
  const binDir = makeBin();
  try {
    fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
    fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), JSON.stringify(makeConfig(), null, 2));
    const base = withoutOuterGitGuard({...process.env});
    const env = {...base, PATH: `${binDir}:${base.PATH || ""}`};
    const run = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "autopilot.mjs"), "run", "add a fixture line to README.md", "--repo", repo], {
      cwd: repo, encoding: "utf8", env, timeout: 240000, stdio: ["ignore", "pipe", "pipe"], shell: false
    });
    const dump = () => ({status: run.status, timedOut: run.error?.code === "ETIMEDOUT", stdout: (run.stdout || "").slice(-1500), stderr: (run.stderr || "").slice(-1500)});
    assert.ok(run.status !== 0 && run.error?.code !== "ETIMEDOUT", `mission escalates without timing out ${JSON.stringify(dump())}`);
    assert.match(run.stderr || "", /claude is logged out/, `stderr names the logged-out CLI ${JSON.stringify(dump())}`);
    assert.match(run.stderr || "", /run `claude` and log in, then `ap run`/, `stderr carries the log-in instruction ${JSON.stringify(dump())}`);
    assert.ok(!/adapterRetryBudget_exhausted/.test(run.stderr || ""), "stderr never names a budget exhaustion");

    const implRuns = readAllResults(path.join(repo, ".autopilot"))
      .filter(r => r.role === "implementer")
      .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    assert.equal(implRuns.length, 1, `exactly one implementer attempt (no same-adapter retry) ${JSON.stringify(implRuns.map(r => r.failure))}`);
    assert.equal(implRuns[0].failure?.class, "AUTH_REQUIRED", "the attempt is AUTH_REQUIRED");
    assert.equal(implRuns[0].failure?.domain, "adapter", "domain is adapter");
    assert.equal(implRuns[0].failure?.retryable, false, "retryable is false");

    const persisted = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
    assert.equal(persisted.step, "auth_required_escalation", `WATCH-REPORT step names auth ${JSON.stringify(persisted.step)}`);
    assert.ok(!Object.keys(persisted.failureBudgets || {}).some(k => k.startsWith("adapterRetryBudget")),
      `no adapterRetryBudget key is written ${JSON.stringify(persisted.failureBudgets)}`);
    console.log("PASS fixture relay: real 401 line escalates at once, names log-in, spends no adapter budget");
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(binDir, {recursive: true, force: true});
  }
}

console.log("test-auth-required: ALL CHECKS PASSED");
