#!/usr/bin/env node
// Backlog #28 (Mission 025 final review): when the orchestrator refuses a
// reviewer/verifier PASS because a linked verify/tool result failed, the
// refused result must be charged to the normal retry budget and the
// phase checkpoint must route back to the Implementer — NOT
// INTERNAL_CONTRACT_ERROR → immediate escalation (the first refused PASS
// used to kill the mission).
//
// e2e at the relay level (real `node scripts/autopilot.mjs run` + fake
// adapters). Standalone framework covered; SpecKit refusal sites use the
// same constructed failure object (speckit refusal e2e not vendored here).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn, spawnSync} from "node:child_process";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import {fileURLToPath} from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${detail ? ` :: ${JSON.stringify(detail).slice(0, 2000)}` : ""}`); }
};

if (process.platform === "win32") {
  console.log("test-pass-refusal-retry: SKIP — POSIX-oriented (bubblewrap envelope).");
  process.exit(0);
}

function git(cwd, args, env) {
  const r = spawnSync("git", args, {cwd, encoding: "utf8", stdio: "pipe", env: withoutOuterGitGuard(env || process.env), shell: false});
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout || "").trim();
}

function makeRepo(prefix) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const env = withoutOuterGitGuard(process.env);
  git(repo, ["init", "-q"], env);
  git(repo, ["config", "user.email", "pass-refusal-retry@example.invalid"], env);
  git(repo, ["config", "user.name", "PRR"], env);
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  // The cursor fixture probe (relay-scratch-probe-adapter.sh) reads this in
  // its verifier scenario, so fixture repos must provide it.
  fs.writeFileSync(path.join(repo, "tracked.txt"), "tracked\n");
  git(repo, ["add", "-A"], env);
  git(repo, ["commit", "-q", "-m", "init"], env);
  return repo;
}

function makeBin(mode) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-pass-refusal-bin-"));
  const cursorAgentPath = path.join(binDir, "cursor-agent");
  fs.copyFileSync(path.join(here, "test-fixtures", "relay-scratch-probe-adapter.sh"), cursorAgentPath);
  fs.chmodSync(cursorAgentPath, 0o755);
  const claudeLauncherPath = path.join(binDir, "claude");
  fs.copyFileSync(path.join(here, "test-fixtures", "fake-claude-launcher.sh"), claudeLauncherPath);
  fs.chmodSync(claudeLauncherPath, 0o755);
  const lj = path.join(binDir, "claude.com");
  const modeParts = mode === "none" ? null : mode.split("/"); // [role, once|always]
  let text = fs.readFileSync(path.join(here, "test-fixtures", "fake-claude-refusal-target.mjs"), "utf8");
  if (modeParts) text = text
    .replace("%REFUSE_ROLE%", JSON.stringify(modeParts[0]))
    .replace("%REFUSE_FOREVER%", modeParts[1] === "always" ? "true" : "false")
    .replace("%LINKED_COMMAND%", JSON.stringify("true"));
  else text = "process.stdout.write(JSON.stringify({type:\"agent_message\",text:\"AUTOPILOT_REVIEW=\"+JSON.stringify({decision:\"PASS\",findings:[]})})+\"\\n\");process.exit(0);\n";
  fs.writeFileSync(lj, text);
  fs.chmodSync(lj, 0o755);
  return binDir;
}

function makeConfig(repo, {implBudget = 5, verBudget = 5, reviewerAdapter = "cursor", verifierAdapter = "cursor", codeReviewerAdapter = reviewerAdapter} = {}) {
  const config = {
    schema_version: "3.0",
    project: {repo: ".", planning_framework: "standalone", state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs"},
    roles: {
      planner: {adapter: "cursor", model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null},
      plan_reviewer: Object.assign({adapter: reviewerAdapter, model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null}, reviewerAdapter === "claude" ? {model: "sonnet", reasoning: "low"} : {}),
      implementer: {adapter: "cursor", model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null},
      code_reviewer: Object.assign({adapter: codeReviewerAdapter, model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null}, codeReviewerAdapter === "claude" ? {model: "sonnet", reasoning: "low"} : {}),
      verifier: Object.assign({adapter: verifierAdapter, model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null}, verifierAdapter === "claude" ? {model: "sonnet", reasoning: "low"} : {})
    },
    workflow: {
      specReview: true, planReview: true, analysisAfterTasks: true, implementationReview: true, finalReview: true,
      autoApproveSpec: false, autoApprovePlan: false, parallelIndependentTasks: false, gsdPlanningReview: false,
      relaySafety: {block_git_commit_push: true, verify_read_only_by_snapshot: true, capture_touched_files: true, persist_role_sessions: true}
    },
    gates: {commands: ["true"], require_reviewer: true, network_isolation: true},
    policy: {
      max_plan_revisions: 3, retry_delay_ms: 0, checkpoint_after_task: true, checkpoint_after_phase: true,
      require_human_commit: true, fail_closed_on_relay_violation: true,
      failure_budgets: {implementationFailureBudget: implBudget, verificationFailureBudget: verBudget, adapterRetryBudget: 5, infrastructureRetryBudget: 5}
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

function runMission(repo, binDir, extraEnv = {}) {
  const base = withoutOuterGitGuard({...process.env});
  const env = {...base, ...extraEnv, PATH: `${binDir}${process.platform === "win32" ? ";" : ":"}${base.PATH || ""}`};
  return spawnSync(process.execPath, [path.join(skillRoot, "scripts", "autopilot.mjs"), "run", "add a fixture line to README.md", "--repo", repo], {
    cwd: repo, encoding: "utf8", env, timeout: 600000, stdio: ["ignore", "pipe", "pipe"], shell: false
  });
}

// Stops as soon as the mission exits (isDone), after one last read, so a
// mission that dies before reaching the expected state fails fast instead of
// polling out the full timeout.
async function pollStateUntil(repo, condition, isDone, timeoutMs = 600000) {
  const statePath = path.join(repo, ".autopilot", "state.json");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const finished = isDone();
    try {
      const s = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (condition(s)) return s;
    } catch {}
    if (finished) return null;
    await new Promise(r => setTimeout(r, 200));
  }
  return null;
}

async function runMissionParallel(repo, binDir, extraEnv, expectedCondition) {
  const base = withoutOuterGitGuard({...process.env});
  const env = {...base, ...extraEnv, PATH: `${binDir}${process.platform === "win32" ? ";" : ":"}${base.PATH || ""}`};
  const child = spawn(process.execPath, [path.join(skillRoot, "scripts", "autopilot.mjs"), "run", "add a fixture line to README.md", "--repo", repo], {
    cwd: repo, env, stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", d => { stdout += d; });
  child.stderr.on("data", d => { stderr += d; });
  // Subscribe to "close" before polling: a mission that exits while we poll
  // would otherwise emit it unheard and leave this await pending forever.
  let done = false;
  const closed = new Promise(res => child.on("close", code => { done = true; res(code); }));
  const snapshot = expectedCondition ? await pollStateUntil(repo, expectedCondition, () => done) : null;
  const status = await closed;
  return {status, stdout, stderr, captured: snapshot};
}

// Run the mission in the background while polling state.json for the exact
// checkpoint the refusal flow must produce: a recorded refusal failure
// (retryable, normal budget allowed, not escalated) where the next stage to
// run is the Implementer. That state is transient (it is cleared when the
// mission finally completes), so snapshot it while the Implementer relaunch
// still owns the checkpoint.

function readAllResults(root) {
  const out = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "result.json") out.push(full);
    }
  })(root);
  return out;
}

function roleRunCount(root, role) {
  return readAllResults(root).filter(f => {
    try { return JSON.parse(fs.readFileSync(f, "utf8"))?.role === role; } catch { return false; }
  }).length;
}

function stateJson(repo) {
  const p = path.join(repo, ".autopilot", "state.json");
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
}

// == Run A: standalone code_reviewer PASS refused; retry returns to the
// Implementer instead of dying, and the mission later completes (budget 5).
{
  const repo = makeRepo("ap-prr-reviewer-");
  const binDir = makeBin("code_reviewer/once");
  try {
    makeConfig(repo, {reviewerAdapter: "cursor", codeReviewerAdapter: "claude", verifierAdapter: "cursor"});
    const awaited = await runMissionParallel(repo, binDir, {}, (s) => s?.lastFailure?.class === "IMPLEMENTATION_REJECTED" && s?.phaseExecutionCheckpoint?.nextStage === "implementer" && s?.lastFailureBudget?.allowed === true && s?.phase !== "escalated");
    const runStatus = awaited.status;
    const implRuns = roleRunCount(path.join(repo, ".autopilot"), "implementer");
    check("A: mission did not die on the refused reviewer PASS", runStatus === 0, {status: runStatus, stderr: (awaited.stderr || "").slice(-800)});
    check("A: refused reviewer PASS relaunched the Implementer", implRuns >= 2, {implRuns});
    check("A: captured failure class IMPLEMENTATION_REJECTED", awaited.captured?.lastFailure?.class === "IMPLEMENTATION_REJECTED", awaited.captured?.lastFailure?.class);
    check("A: captured failure retryable", awaited.captured?.lastFailure?.retryable === true, awaited.captured?.lastFailure?.retryable);
    check("A: captured normal budget allowed", awaited.captured?.lastFailureBudget?.allowed === true, awaited.captured?.lastFailureBudget);
    check("A: captured checkpoint nextStage is the Implementer", awaited.captured?.phaseExecutionCheckpoint?.nextStage === "implementer", awaited.captured?.phaseExecutionCheckpoint?.nextStage);
    check("A: no escalation", !awaited.captured || awaited.captured.phase !== "escalated", awaited.captured?.phase);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
  }
}

// == Run B: always-refuse reviewer PASS with budget 2: the SECOND refusal
// exhausts the normal IMPLEMENTATION budget and the mission escalates with
// the verdict class name (not INTERNAL_CONTRACT_ERROR → non_retryable_failure).
{
  const repo = makeRepo("ap-prr-reviewer2-");
  const binDir = makeBin("code_reviewer/always");
  try {
    makeConfig(repo, {implBudget: 2, reviewerAdapter: "cursor", codeReviewerAdapter: "claude", verifierAdapter: "cursor"});
    const run = runMission(repo, binDir, {});
    const state = stateJson(repo);
    check("B: always-refuse reviewer PASS escalates (exit nonzero)", run.status !== 0, {status: run.status});
    check("B: recorded failure class is IMPLEMENTATION_REJECTED", state?.lastFailure?.class === "IMPLEMENTATION_REJECTED", state?.lastFailure?.class);
    check("B: recorded failure is retryable", state?.lastFailure?.retryable === true, state?.lastFailure?.retryable);
    check("B: budget exhausted escalation name (not INT.CONTRACT_ERROR)", state?.step === "implementationFailureBudget_exhausted", state?.step);
    check("B: not the bug's non_retryable_failure state", state?.step !== "non_retryable_failure", state?.step);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
  }
}

// == Run C: standalone verifier PASS refused once → retry completes.
{
  const repo = makeRepo("ap-prr-verifier-");
  const binDir = makeBin("verifier/once");
  try {
    makeConfig(repo, {reviewerAdapter: "cursor", codeReviewerAdapter: "cursor", verifierAdapter: "claude"});
    const awaited = await runMissionParallel(repo, binDir, {}, (s) => s?.lastFailure?.class === "VERIFICATION_REJECTED" && s?.phaseExecutionCheckpoint?.nextStage === "implementer" && s?.lastFailureBudget?.allowed === true && s?.phase !== "escalated");
    const runStatus = awaited.status;
    const implRuns = roleRunCount(path.join(repo, ".autopilot"), "implementer");
    check("C: mission did not die on the refused verifier PASS", runStatus === 0, {status: runStatus, stderr: (awaited.stderr || "").slice(-800)});
    check("C: refused verifier PASS relaunched the Implementer", implRuns >= 2, {implRuns});
    check("C: captured failure class VERIFICATION_REJECTED", awaited.captured?.lastFailure?.class === "VERIFICATION_REJECTED", awaited.captured?.lastFailure?.class);
    check("C: captured failure retryable", awaited.captured?.lastFailure?.retryable === true, awaited.captured?.lastFailure?.retryable);
    check("C: captured normal budget allowed", awaited.captured?.lastFailureBudget?.allowed === true, awaited.captured?.lastFailureBudget);
    check("C: captured checkpoint nextStage is the Implementer", awaited.captured?.phaseExecutionCheckpoint?.nextStage === "implementer", awaited.captured?.phaseExecutionCheckpoint?.nextStage);
    check("C: no escalation", !awaited.captured || awaited.captured.phase !== "escalated", awaited.captured?.phase);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
  }
}

// == Run D: always-refuse verifier PASS with budget 2 → normal exhaustion.
{
  const repo = makeRepo("ap-prr-verifier2-");
  const binDir = makeBin("verifier/always");
  try {
    makeConfig(repo, {verBudget: 2, reviewerAdapter: "cursor", codeReviewerAdapter: "cursor", verifierAdapter: "claude"});
    const run = runMission(repo, binDir, {});
    const state = stateJson(repo);
    check("D: always-refuse verifier PASS escalates", run.status !== 0, {status: run.status});
    check("D: recorded failure class is VERIFICATION_REJECTED", state?.lastFailure?.class === "VERIFICATION_REJECTED", state?.lastFailure?.class);
    check("D: budget exhausted escalation name", state?.step === "verificationFailureBudget_exhausted", state?.step);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
  }
}

console.log(failures === 0 ? "test-pass-refusal-retry: OK" : `test-pass-refusal-retry: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
