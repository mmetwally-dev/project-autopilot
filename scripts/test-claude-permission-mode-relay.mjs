#!/usr/bin/env node
// TASK 15.6A — behavioral fake-Claude relay test for permission modes.
//
// Runs a REAL `node scripts/autopilot.mjs run` mission (production relay
// path: runRelay -> buildRelayArgs (agents.json claude.write /
// claude.read_only) -> assembleAdapterLaunchPlan -> buildExecutionEnvelope
// -> spawn) with ALL FIVE roles bound to the real "claude" adapter, backed
// by a disposable fake `claude` executable (scripts/test-fixtures/
// fake-claude-launcher.sh + fake-claude-permission-target.mjs).
//
// The fake executable REFUSES (non-zero exit) write roles unless they arrive
// with exactly `--permission-mode acceptEdits`, and read-only roles unless
// they arrive with exactly `--permission-mode plan`. A passing mission is
// therefore a live proof that the Planner and Implementer are launched
// write-capable non-interactively (the real 15.6A Native Windows failure was
// a Planner with NO permission mode: exit 0, no artifacts), while reviewers
// stay on least-privilege `plan` — with no dangerous bypass flag anywhere.
//
// Requires Linux/WSL (bubblewrap filesystem containment for the read-only
// roles). Fails closed, not skip, on Windows.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");

const tempDirs = new Set();
process.on("exit", () => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* best-effort */ }
  }
});

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${detail ? ` :: ${detail}` : ""}`); }
};

function git(cwd, args) {
  const r = spawnSync("git", args, {cwd, encoding: "utf8", stdio: "pipe", env: withoutOuterGitGuard(process.env), shell: false});
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout || "").trim();
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-claude-perm-"));
  tempDirs.add(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "claude-perm-test@example.invalid"]);
  git(repo, ["config", "user.name", "Claude Perm Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

function claudeRole(model = "sonnet", reasoning = "low") {
  return {adapter: "claude", model, reasoning, variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null};
}

function makeConfig(repo) {
  const config = {
    schema_version: "3.0",
    project: {repo: ".", planning_framework: "standalone", state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs"},
    roles: {
      planner: claudeRole(),
      plan_reviewer: claudeRole(),
      implementer: claudeRole(),
      code_reviewer: claudeRole(),
      verifier: claudeRole()
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
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-claude-perm-bin-"));
  tempDirs.add(binDir);
  // "claude": the same two-hop shim shape the production resolver expects
  // (launcher -> claude.com), backed by the permission-enforcing target.
  const claudeLauncherPath = path.join(binDir, "claude");
  fs.copyFileSync(path.join(here, "test-fixtures", "fake-claude-launcher.sh"), claudeLauncherPath);
  fs.chmodSync(claudeLauncherPath, 0o755);
  const claudeTargetPath = path.join(binDir, "claude.com");
  fs.copyFileSync(path.join(here, "test-fixtures", "fake-claude-permission-target.mjs"), claudeTargetPath);
  fs.chmodSync(claudeTargetPath, 0o755);
  return {binDir, claudeTargetPath};
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
  for (const f of readAllResults(root)) {
    const r = JSON.parse(fs.readFileSync(f, "utf8"));
    if (r.role === role) return {file: f, result: r};
  }
  return null;
}

function reportOf(reviewResult) {
  const findings = reviewResult.review?.findings || reviewResult.verdict?.findings || [];
  for (const f of findings) {
    try {
      const parsed = JSON.parse(f);
      if (parsed && Array.isArray(parsed.argv)) return parsed;
    } catch { /* not the observation finding */ }
  }
  return null;
}

function checkObservedArgv(label, report, {expectedMode, expectedRole}) {
  check(`${label}: fake observed exactly one --permission-mode ${expectedMode}`,
    Array.isArray(report?.argv) &&
    report.argv.filter(a => a === "--permission-mode").length === 1 &&
    report.argv[report.argv.indexOf("--permission-mode") + 1] === expectedMode,
    JSON.stringify(report?.argv));
  check(`${label}: stdin was the plain-text prompt for ${expectedRole}`,
    report?.stdinFirstLine === `ROLE=${expectedRole}`, JSON.stringify(report?.stdinFirstLine));
  check(`${label}: --input-format text preserved`,
    report?.argv.includes("--input-format") && report.argv[report.argv.indexOf("--input-format") + 1] === "text",
    JSON.stringify(report?.argv));
  check(`${label}: --output-format stream-json preserved`,
    report?.argv.includes("--output-format") && report.argv[report.argv.indexOf("--output-format") + 1] === "stream-json",
    JSON.stringify(report?.argv));
  check(`${label}: --model sonnet preserved`,
    report?.argv.includes("--model") && report.argv[report.argv.indexOf("--model") + 1] === "sonnet",
    JSON.stringify(report?.argv));
  check(`${label}: --effort low preserved`,
    report?.argv.includes("--effort") && report.argv[report.argv.indexOf("--effort") + 1] === "low",
    JSON.stringify(report?.argv));
  check(`${label}: no dangerous bypass flag observed`,
    Array.isArray(report?.argv) && !report.argv.some(a => /dangerously-skip-permissions|bypasspermissions|bypass-permissions/i.test(String(a))),
    JSON.stringify(report?.argv));
}

// ── Direct refusal checks against the fake target (no mission) ──────────────
function directCheck(claudeTargetPath, cwd) {
  const invoke = (argv, stdinText) => spawnSync(process.execPath, [claudeTargetPath, ...argv], {
    cwd, encoding: "utf8", input: stdinText, timeout: 30000, stdio: ["pipe", "pipe", "pipe"], shell: false
  });
  // Write role with the wrong mode / missing mode / duplicated mode: refuse.
  check("direct: planner + plan is REFUSED",
    invoke(["-p", "--permission-mode", "plan"], "ROLE=planner\ntask\n").status !== 0);
  check("direct: planner with NO permission mode is REFUSED (the 15.6A failure)",
    invoke(["-p"], "ROLE=planner\ntask\n").status !== 0);
  check("direct: planner with DUPLICATE permission mode is REFUSED",
    invoke(["-p", "--permission-mode", "acceptEdits", "--permission-mode", "acceptEdits"], "ROLE=planner\ntask\n").status !== 0);
  check("direct: plan_reviewer + acceptEdits is REFUSED",
    invoke(["-p", "--permission-mode", "acceptEdits"], "ROLE=plan_reviewer\ntask\n").status !== 0);
  // Correct combinations: accepted.
  check("direct: planner + acceptEdits is ACCEPTED",
    invoke(["-p", "--permission-mode", "acceptEdits"], "ROLE=planner\ntask\n").status === 0);
  check("direct: plan_reviewer + plan is ACCEPTED",
    invoke(["-p", "--permission-mode", "plan"], "ROLE=plan_reviewer\ntask\n").status === 0);
}

// The direct-refusal checks below invoke the fake Claude target script
// directly via `node <script>` (never through the "claude" binary / PATH
// resolution the full relay mission needs), so they exercise the same
// permission-mode argv-assembly contract as the 15.6A regression
// (a write role launched with no/duplicate/wrong --permission-mode) on
// every platform, including native Windows, with zero platform-specific
// fixture work.
{
  const {claudeTargetPath} = makeBin();
  const directCwd = fs.mkdtempSync(path.join(os.tmpdir(), "ap-claude-perm-direct-"));
  tempDirs.add(directCwd);
  try {
    directCheck(claudeTargetPath, directCwd);
  } finally {
    fs.rmSync(directCwd, {recursive: true, force: true});
  }
}

// The end-to-end relay mission below runs on all platforms (bubblewrap on
// Linux/WSL2, the Windows disposable copy for standalone).
const repo = makeRepo();
const {binDir} = makeBin();
try {
  makeConfig(repo);
  const run = runMission(repo, binDir);
  const autoRoot = path.join(repo, ".autopilot");

  const planner = findRole(autoRoot, "planner");
  check("planner relay produced a result.json", planner != null,
    `run.status=${run.status} stdout=${(run.stdout || "").slice(-2000)} stderr=${(run.stderr || "").slice(-2000)}`);
  if (planner) {
    check("planner completed", planner.result.status === "completed", JSON.stringify(planner.result).slice(0, 1000));
    check("planner had no policy violation", planner.result.policy?.violation === null);
  }

  const implementer = findRole(autoRoot, "implementer");
  check("implementer relay produced a result.json", implementer != null);
  if (implementer) {
    check("implementer completed", implementer.result.status === "completed");
    check("implementer had no policy violation", implementer.result.policy?.violation === null);
  }

  // Write-role observations land in the disposable repo scratch area.
  const obsFile = path.join(repo, ".autopilot", "permission-mode-observations.jsonl");
  const observations = fs.existsSync(obsFile)
    ? fs.readFileSync(obsFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line))
    : [];
  for (const [role, expectedMode] of [["planner", "acceptEdits"], ["implementer", "acceptEdits"]]) {
    const report = observations.find(o => o.role === role);
    check(`${role} observation recorded through the real relay`, report != null);
    if (report) checkObservedArgv(`${role} (relay-observed)`, report, {expectedMode, expectedRole: role});
  }

  for (const [role, expectedMode] of [["plan_reviewer", "plan"], ["code_reviewer", "plan"], ["verifier", "plan"]]) {
    const found = findRole(autoRoot, role);
    check(`${role} relay produced a result.json`, found != null);
    if (found) {
      check(`${role} completed`, found.result.status === "completed");
      check(`${role} decision is PASS`, found.result.verdict?.decision === "PASS", JSON.stringify(found.result.verdict));
      check(`${role} had no policy violation`, found.result.policy?.violation === null);
      const report = reportOf(found.result);
      check(`${role} embedded an argv observation in its findings`, report != null);
      if (report) checkObservedArgv(`${role} (relay-observed)`, report, {expectedMode, expectedRole: role});
    }
  }

  // No tracked file may have been modified by the mission.
  const porcelain = git(repo, ["status", "--porcelain"]);
  const modifiedTracked = porcelain.split("\n").filter(line => line && !line.startsWith("??"));
  check("mission modified no tracked files", modifiedTracked.length === 0, porcelain);
  check("mission completed (exit 0)", run.status === 0,
    `stdout=${(run.stdout || "").slice(-1500)} stderr=${(run.stderr || "").slice(-1500)}`);
} finally {
  fs.rmSync(repo, {recursive: true, force: true});
  fs.rmSync(binDir, {recursive: true, force: true});
}

if (failures) {
  console.error(`${failures} claude permission-mode relay check(s) failed.`);
  process.exit(1);
}
console.log("test-claude-permission-mode-relay: ALL CHECKS PASSED");
