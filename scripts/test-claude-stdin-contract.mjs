#!/usr/bin/env node
// Real-relay behavioral proof for the Claude stdin-format contract fix.
//
// Runs a REAL `node scripts/autopilot.mjs run` mission (production relay
// path: runRelay -> buildRelayArgs (agents.json claude.read_only) ->
// assembleAdapterLaunchPlan -> buildExecutionEnvelope -> bubblewrap spawn)
// with the plan_reviewer role bound to the real "claude" adapter, backed
// by a disposable fake `claude` executable (scripts/test-fixtures/
// fake-claude-launcher.sh + fake-claude-target.mjs).
//
// The fake executable fails closed exactly the way the real Claude Code
// CLI failed in production ("Error parsing streaming input line
// (type=unknown, 18 chars): SyntaxError") whenever it is launched with
// --input-format stream-json while stdin is plain text, or whenever
// stdin does not look like the plain-text mission prompt Autopilot
// actually sends. So a passing mission here is a live proof that:
//   - the real Claude invocation declares --input-format text;
//   - --input-format stream-json is never sent;
//   - stdin is delivered as the plain-text prompt (never JSON-encoded);
//   - the Plan Reviewer relay can still produce a valid PASS decision.
//
// Requires Linux/WSL (bubblewrap filesystem containment for the
// read-only plan_reviewer role). Fails closed, not skip, on Windows.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${detail ? ` :: ${detail}` : ""}`); }
};

if (process.platform === "win32") {
  console.log("test-claude-stdin-contract: SKIP — platform prerequisite not met: requires Linux/WSL2 with bubblewrap (bwrap) for the plan_reviewer role's read-only filesystem containment, which does not exist on native Windows (see docs on Windows disposable-copy isolation vs WSL2 bubblewrap containment as separate, platform-specific mechanisms).");
  process.exit(0);
}

function git(cwd, args) {
  const r = spawnSync("git", args, {cwd, encoding: "utf8", stdio: "pipe", env: withoutOuterGitGuard(process.env), shell: false});
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout || "").trim();
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-claude-stdin-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "claude-stdin-test@example.invalid"]);
  git(repo, ["config", "user.name", "Claude Stdin Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

function makeConfig(repo) {
  const config = {
    schema_version: "3.0",
    project: {repo: ".", planning_framework: "standalone", state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs"},
    roles: {
      planner: {adapter: "cursor", model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null},
      // The role under test: real "claude" adapter/driver, matching the
      // real failing invocation (sonnet/low, permission-mode plan).
      plan_reviewer: {adapter: "claude", model: "sonnet", reasoning: "low", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null},
      implementer: {adapter: "cursor", model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null},
      code_reviewer: {adapter: "cursor", model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null},
      verifier: {adapter: "cursor", model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null}
    },
    workflow: {
      specReview: true, planReview: true, analysisAfterTasks: true, implementationReview: true, finalReview: true,
      autoApproveSpec: false, autoApprovePlan: false, parallelIndependentTasks: false, gsdPlanningReview: false,
      relaySafety: {block_git_commit_push: true, verify_read_only_by_snapshot: true, capture_touched_files: true, persist_role_sessions: true}
    },
    gates: {commands: [], env_allowlist: [], require_reviewer: true, network_isolation: true},
    policy: {
      max_plan_revisions: 3, retry_delay_ms: 0, checkpoint_after_task: true, checkpoint_after_phase: true,
      require_human_commit: true, fail_closed_on_relay_violation: true,
      failure_budgets: {implementationFailureBudget: 5, verificationFailureBudget: 5, adapterRetryBudget: 5, infrastructureRetryBudget: 5}
    },
    safety: {allow_git_commit: false, allow_git_push: false, allow_destructive_operations: false},
    planning: {
      speckit: {workflow_file: ".specify/workflows/speckit/workflow.yml", task_candidates: [".specify/tasks.md", "specs/*/tasks.md", "specs/*/tasks/*.md"]},
      gsd: {phase_root: ".planning/phases", run_plan_verify: true, run_state_validate: true, write_summary_artifacts: true, write_verification_artifacts: true, write_uat_artifact: true, use_gsd_tools_when_available: false, parallelization: {enabled: false, plan_level: false, task_level: false, max_concurrent_agents: 1, min_plans_for_parallel: 99}, planning_review: {enabled: false, review_after_each_stage: true, stages: ["discuss", "research", "plan", "plan-check"], max_revisions: 3, read_only_reviewer: true}}
    },
    capabilities: {project_defaults: [], role_requirements: {}, safety_denied: [], legacy_text_inference: false, verification: {browser: "native", require_browser: "when-task-requires"}}
  };
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), JSON.stringify(config, null, 2));
}

function makeBin() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-claude-stdin-bin-"));

  // "cursor-agent": reuse the existing standalone-planning probe adapter
  // (handles planner/implementer, PASS-sentinels everything else).
  const cursorAgentPath = path.join(binDir, "cursor-agent");
  fs.copyFileSync(path.join(here, "test-fixtures", "relay-scratch-probe-adapter.sh"), cursorAgentPath);
  fs.chmodSync(cursorAgentPath, 0o755);

  // "claude": a two-hop shim (launcher -> claude.com) so that
  // resolveClaudeBinary()'s npm-shim-chasing logic resolves to a real,
  // admissible file rather than a synthetic-missing Windows PE.
  const claudeLauncherPath = path.join(binDir, "claude");
  fs.copyFileSync(path.join(here, "test-fixtures", "fake-claude-launcher.sh"), claudeLauncherPath);
  fs.chmodSync(claudeLauncherPath, 0o755);
  const claudeTargetPath = path.join(binDir, "claude.com");
  fs.copyFileSync(path.join(here, "test-fixtures", "fake-claude-target.mjs"), claudeTargetPath);
  fs.chmodSync(claudeTargetPath, 0o755);

  return binDir;
}

function runMission(repo, binDir) {
  const delimiter = process.platform === "win32" ? ";" : ":";
  // Strip any outer mission/gate git guard (PATH shim + hooks): the
  // nested mission installs its own, and every git call through both ran
  // the mission several times slower under the orchestrator gate.
  const base = withoutOuterGitGuard({...process.env});
  const env = {...base, PATH: `${binDir}${delimiter}${base.PATH || ""}`};
  return spawnSync(process.execPath, [path.join(skillRoot, "scripts", "autopilot.mjs"), "run", "add a fixture line to README.md", "--repo", repo], {
    cwd: repo, encoding: "utf8", env, timeout: 180000, stdio: ["ignore", "pipe", "pipe"], shell: false
  });
}

function readAllResults(root) {
  const files = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "result.json") files.push(full);
    }
  })(root);
  return files;
}

function findRole(root, role) {
  const files = readAllResults(root);
  for (const f of files) {
    const r = JSON.parse(fs.readFileSync(f, "utf8"));
    if (r.role === role) return {file: f, result: r};
  }
  return null;
}

{
  const repo = makeRepo();
  const binDir = makeBin();
  try {
    makeConfig(repo);
    const run = runMission(repo, binDir);

    const pr = findRole(path.join(repo, ".autopilot"), "plan_reviewer");
    check("plan_reviewer relay produced a result.json", pr != null,
      `run.status=${run.status} stdout=${(run.stdout || "").slice(-2000)} stderr=${(run.stderr || "").slice(-2000)}`);

    if (pr) {
      check("plan_reviewer ran inside the read-only envelope", pr.result.executionPlaneSafety?.envelopeApplied === true);
      check("plan_reviewer completed", pr.result.status === "completed",
        JSON.stringify(pr.result).slice(0, 2000));
      check("plan_reviewer decision is PASS", pr.result.verdict?.decision === "PASS",
        JSON.stringify(pr.result.verdict));
      check("plan_reviewer had no policy violation", pr.result.policy?.violation === null);

      const findingsText = (pr.result.review?.findings || pr.result.verdict?.findings || []).join(" ");
      const reportMatch = /(\{.*\})/.exec(findingsText);
      const report = reportMatch ? (() => { try { return JSON.parse(reportMatch[1]); } catch { return {}; } })() : {};

      check("fake claude observed --input-format text",
        Array.isArray(report.argv) && report.argv.includes("--input-format") && report.argv[report.argv.indexOf("--input-format") + 1] === "text",
        JSON.stringify(report.argv));
      check("fake claude never observed --input-format stream-json",
        !(Array.isArray(report.argv) && report.argv.includes("--input-format") && report.argv[report.argv.indexOf("--input-format") + 1] === "stream-json"),
        JSON.stringify(report.argv));
      check("fake claude observed --output-format stream-json",
        Array.isArray(report.argv) && report.argv.includes("--output-format") && report.argv[report.argv.indexOf("--output-format") + 1] === "stream-json",
        JSON.stringify(report.argv));
      check("fake claude observed --verbose", Array.isArray(report.argv) && report.argv.includes("--verbose"), JSON.stringify(report.argv));
      check("fake claude observed --permission-mode plan",
        Array.isArray(report.argv) && report.argv.includes("--permission-mode") && report.argv[report.argv.indexOf("--permission-mode") + 1] === "plan",
        JSON.stringify(report.argv));
      check("fake claude observed --model sonnet",
        Array.isArray(report.argv) && report.argv.includes("--model") && report.argv[report.argv.indexOf("--model") + 1] === "sonnet",
        JSON.stringify(report.argv));
      check("fake claude observed --effort low",
        Array.isArray(report.argv) && report.argv.includes("--effort") && report.argv[report.argv.indexOf("--effort") + 1] === "low",
        JSON.stringify(report.argv));
      check("fake claude received plain-text stdin starting with ROLE=plan_reviewer",
        report.stdinFirstLine === "ROLE=plan_reviewer", JSON.stringify(report.stdinFirstLine));
      check("fake claude received non-empty stdin", Number(report.stdinLength) > 0, JSON.stringify(report.stdinLength));
    }
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(binDir, {recursive: true, force: true});
  }
}

if (failures) {
  console.error(`${failures} claude stdin-contract check(s) failed.`);
  process.exit(1);
}
console.log("test-claude-stdin-contract: ALL CHECKS PASSED");
