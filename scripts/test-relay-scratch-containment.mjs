#!/usr/bin/env node
// Real-relay scratch containment behavioral proof.
//
// Runs REAL `node scripts/autopilot.mjs run` missions (production relay
// path: runRelay -> assembleAdapterLaunchPlan -> buildExecutionEnvelope ->
// bubblewrap spawn) with a probe adapter whose VERIFIER role runs a Node
// probe INSIDE the actual read-only envelope.
//
// Scenario "benign":
//   1. scratch writes succeed;
//   2. repository writes fail (EROFS);
//   3. the REAL central run dir (the verifier's own run dir containing
//      brief.txt/result.json) cannot be modified (EROFS/EACCES, not ENOENT);
//   4. verifier completes PASS with NO policy violation.
//
// Scenario "malicious":
//   all of the above, plus:
//   5. a git commit attempt is blocked by the git guard (exit 97);
//   6. the guard event is recorded and the guard log lands in the exact
//      nested scratch dir (writable);
//   7. the repository remains unchanged.
//
// This is NOT a direct buildExecutionEnvelope() call: the envelope is
// assembled and spawned by the production relay path itself.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");
const probeAdapterSource = path.join(here, "test-fixtures", "relay-scratch-probe-adapter.sh");
const probeAdapterPath = fs.readFileSync(probeAdapterSource, "utf8");

let failures = 0;
const check = (name, condition) => {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
};

// This is a real-relay proof of the actual bubblewrap read-only envelope
// (buildExecutionEnvelope() -> bwrap spawn) via a POSIX shell probe adapter
// (test-fixtures/relay-scratch-probe-adapter.sh) — it requires Linux/WSL2
// (bwrap) and does not exist on native Windows. The equivalent Windows
// disposable-copy verifier coverage lives in
// test-windows-disposable-verifier.mjs.
if (process.platform === "win32") {
  console.log("test-relay-scratch-containment: SKIP — platform prerequisite not met: requires Linux/WSL2 with bubblewrap (bwrap) for the real read-only envelope this test proves; the fixture adapter is a POSIX shell script. Windows-side coverage lives in test-windows-disposable-verifier.mjs.");
  process.exit(0);
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-relay-scratch-"));
  const git = (args) => spawnSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe", env: withoutOuterGitGuard(process.env), shell: false });
  assert.equal(git(["init", "-q"]).status, 0);
  assert.equal(git(["config", "user.email", "relay-test@example.invalid"]).status, 0);
  assert.equal(git(["config", "user.name", "Relay Test"]).status, 0);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "one");
  assert.equal(git(["add", "tracked.txt"]).status, 0);
  assert.equal(git(["commit", "-q", "-m", "init"]).status, 0);
  return {repo, git};
}

function makeConfig(repo) {
  const config = {
    schema_version: "3.0",
    project: { repo: ".", planning_framework: "standalone", state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs" },
    roles: Object.fromEntries(["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"].map(role => [
      role, { adapter: "cursor", model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null }
    ])),
    workflow: {
      specReview: true, planReview: true, analysisAfterTasks: true, implementationReview: true, finalReview: true,
      autoApproveSpec: false, autoApprovePlan: false, parallelIndependentTasks: false, gsdPlanningReview: false,
      relaySafety: { block_git_commit_push: true, verify_read_only_by_snapshot: true, capture_touched_files: true, persist_role_sessions: true }
    },
    gates: { commands: [], env_allowlist: [], require_reviewer: true, network_isolation: true },
    policy: {
      max_plan_revisions: 3, retry_delay_ms: 0, checkpoint_after_task: true, checkpoint_after_phase: true,
      require_human_commit: true, fail_closed_on_relay_violation: true,
      failure_budgets: { implementationFailureBudget: 5, verificationFailureBudget: 5, adapterRetryBudget: 5, infrastructureRetryBudget: 5 }
    },
    safety: { allow_git_commit: false, allow_git_push: false, allow_destructive_operations: false },
    planning: {
      speckit: { workflow_file: ".specify/workflows/speckit/workflow.yml", task_candidates: [".specify/tasks.md", "specs/*/tasks.md", "specs/*/tasks/*.md"] },
      gsd: { phase_root: ".planning/phases", run_plan_verify: true, run_state_validate: true, write_summary_artifacts: true, write_verification_artifacts: true, write_uat_artifact: true, use_gsd_tools_when_available: false, parallelization: { enabled: false, plan_level: false, task_level: false, max_concurrent_agents: 1, min_plans_for_parallel: 99 }, planning_review: { enabled: false, review_after_each_stage: true, stages: ["discuss", "research", "plan", "plan-check"], max_revisions: 3, read_only_reviewer: true } }
    },
    capabilities: { project_defaults: [], role_requirements: {}, safety_denied: [], legacy_text_inference: false, verification: { browser: "native", require_browser: "when-task-requires" } }
  };
  fs.mkdirSync(path.join(repo, ".autopilot"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), JSON.stringify(config, null, 2));
}

function makeBin() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-relay-bin-"));
  const adapterPath = path.join(binDir, "cursor-agent");
  fs.writeFileSync(adapterPath, probeAdapterPath);
  fs.chmodSync(adapterPath, 0o755);
  return binDir;
}

function runMission(repo, binDir, scenario) {
  // Commit the scenario selector (the relay filters the child env; a
  // committed repo file is the only channel that reaches the sandbox).
  const git = (args) => spawnSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe", env: withoutOuterGitGuard(process.env), shell: false });
  fs.writeFileSync(path.join(repo, ".autopilot-test-scenario"), scenario);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", `scenario ${scenario}`]);
  const delimiter = process.platform === "win32" ? ";" : ":";
  // Strip any outer mission/gate git guard (PATH shim + hooks): the
  // nested mission installs its own, and every git call through both
  // ran the mission several times slower under the orchestrator gate.
  const base = withoutOuterGitGuard({...process.env});
  const env = { ...base, PATH: `${binDir}${delimiter}${base.PATH || ""}` };
  return spawnSync(process.execPath, [path.join(skillRoot, "scripts", "autopilot.mjs"), "run", "implement the fixture task", "--repo", repo], {
    cwd: repo, encoding: "utf8", env, timeout: 180000, stdio: ["ignore", "pipe", "pipe"], shell: false
  });
}

function readAllResults(root) {
  const files = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "result.json") files.push(full);
    }
  })(root);
  return files;
}

function findVerifier(root) {
  const files = readAllResults(root);
  for (const f of files) {
    const r = JSON.parse(fs.readFileSync(f, "utf8"));
    if (r.role === "verifier") return {file: f, result: r};
  }
  return null;
}

// ---- Scenario BENIGN: verifier completes PASS, no violation ----
{
  const {repo, git} = makeRepo();
  const binDir = makeBin();
  try {
    makeConfig(repo);
    runMission(repo, binDir, "benign");
    const v = findVerifier(path.join(repo, ".autopilot"));
    check("benign: verifier ran inside the read-only envelope", v && v.result.executionPlaneSafety?.envelopeApplied === true);
    check("benign: verifier completed PASS", v && v.result.status === "completed" && v.result.verdict?.decision === "PASS");
    check("benign: no policy violation", v && v.result.policy?.violation === null);

    const findingsText = (v.result.review?.findings || v.result.verdict?.findings || []).join(" ");
    const probeMatch = /(\{.*\})/.exec(findingsText);
    const probe = probeMatch ? (() => { try { return JSON.parse(probeMatch[1]); } catch { return {}; } })() : {};
    check("benign: scratch write succeeded", probe.scratchWrite === "SUCCEEDED");
    check("benign: repository write denied (EROFS)", /^DENIED:EROFS$/.test(probe.repoWrite || ""));
    check("benign: repository contents unchanged", probe.repoContents === "one");
    check("benign: central run path located", typeof probe.centralRunPath === "string" && probe.centralRunPath.includes("/runs/"));
    check("benign: central brief.txt write denied (EROFS/EACCES)",
      /^DENIED:(EROFS|EACCES)$/.test(probe.centralRunWrite || ""));
    check("benign: central brief.txt readable (exists in bind)",
      probe.centralBriefReadable === true);

    // Central run files live OUTSIDE scratch.
    const runDir = path.dirname(v.file);
    check("benign: brief.txt is NOT inside writable scratch", !fs.existsSync(path.join(runDir, "scratch", "brief.txt")));
    check("benign: result.json is NOT inside writable scratch", !fs.existsSync(path.join(runDir, "scratch", "result.json")));
    check("benign: host repository file unchanged", fs.readFileSync(path.join(repo, "tracked.txt"), "utf8") === "one");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  }
}

// ---- Scenario MALICIOUS: git commit blocked, guard log in scratch ----
{
  const {repo, git} = makeRepo();
  const binDir = makeBin();
  try {
    makeConfig(repo);
    runMission(repo, binDir, "malicious");
    const v = findVerifier(path.join(repo, ".autopilot"));
    check("malicious: verifier ran inside the read-only envelope", v && v.result.executionPlaneSafety?.envelopeApplied === true);
    check("malicious: relay recorded git_mutation_blocked", v && v.result.policy?.violation === "git_mutation_blocked");
    check("malicious: guard event recorded", v && Array.isArray(v.result.gitGuardEvents) && v.result.gitGuardEvents.length >= 1
      && v.result.gitGuardEvents[0].subcommand === "commit");

    const findingsText = (v.result.review?.findings || v.result.verdict?.findings || []).join(" ");
    const probeMatch = /(\{.*\})/.exec(findingsText);
    const probe = probeMatch ? (() => { try { return JSON.parse(probeMatch[1]); } catch { return {}; } })() : {};
    check("malicious: scratch write succeeded", probe.scratchWrite === "SUCCEEDED");
    check("malicious: repository write denied (EROFS)", /^DENIED:EROFS$/.test(probe.repoWrite || ""));
    check("malicious: git commit blocked by guard (exit 97)", /^BLOCKED:guard$/.test(probe.gitCommit || ""));
    check("malicious: central brief.txt write denied (EROFS/EACCES)",
      /^DENIED:(EROFS|EACCES)$/.test(probe.centralRunWrite || ""));

    // Guard log lands inside the exact nested scratch dir (writable).
    const runDir = path.dirname(v.file);
    const scratchDir = path.join(runDir, "scratch");
    const guardLog = path.join(scratchDir, "git-guard", "blocked.log");
    check("malicious: git guard log landed inside nested scratch dir",
      fs.existsSync(guardLog) && fs.readFileSync(guardLog, "utf8").length > 0);
    check("malicious: host repository file unchanged", fs.readFileSync(path.join(repo, "tracked.txt"), "utf8") === "one");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  }
}

if (failures) {
  console.error(`${failures} relay scratch-containment check(s) failed.`);
  process.exit(1);
}
console.log("real-relay scratch containment PASS (benign + malicious)");