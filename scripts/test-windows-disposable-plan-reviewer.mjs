#!/usr/bin/env node
// Task 15.3 (+ correction pass) behavioral proof: Native Windows SpecKit
// Plan Reviewer running against the disposable reviewer-workspace copy
// (scripts/reviewer-workspace.mjs) instead of failing closed with
// READ_ONLY_CONTAINMENT_UNAVAILABLE.
//
// Runs the REAL production `node scripts/autopilot.mjs run ... --repo
// <repo>` subprocess path (never an isolated reimplementation of
// scripts/autopilot.mjs's runRelay) against disposable Git fixture
// repositories, using a fake "cursor" adapter CLI (a Windows .cmd
// trampoline around a Node script — the "cursor" adapter has no registered
// driver in scripts/adapter-drivers.mjs, so the orchestrator sends/receives
// plain text, matching the existing test-fixtures/fake-workflow-adapter.sh
// convention used on other platforms).
//
// Runtime strategy: every fixture repository is seeded with an ALREADY
// "complete" SpecKit feature (spec.md + plan.md + tasks.md all present, no
// prior state.json) and NO explicit CLI request text. This makes
// scripts/autopilot.mjs's ensurePlanningReady() take the cheap
// "reviewExistingPlanning()" path (autopilot.mjs) — exactly ONE read-only
// plan_reviewer call — instead of running the full multi-step SpecKit
// specify/plan/tasks gate loop. Every scenario therefore costs at most two
// real adapter subprocess spawns (plan_reviewer, then implementer for the
// PASS scenario), not a full mission from scratch.
//
// Windows-only: this whole file is a no-op PASS on any other platform (the
// production condition it exercises is itself gated to process.platform===
// "win32"). The equivalent WSL/Linux bubblewrap coverage already exists in
// test-relay-scratch-containment.mjs and friends and is untouched by this
// task; see the task report for the WSL verification commands run instead.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import {runWindowsProcessTreeBounded} from "./test-fixtures/windows-process-tree-runner.mjs";
import {ensureStandaloneSplit} from "./mission-naming.mjs";
import {ensureBaseline, sanitizeKeySegment} from "./implementation-baseline.mjs";
import {declaredDeliverables} from "../adapters/standalone.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");
const CANONICAL_AUTOPILOT = path.join(skillRoot, "scripts", "autopilot.mjs");

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  return false;
};

if (process.platform !== "win32") {
  console.log("SKIP: task 15.3 Native Windows disposable-copy Plan Reviewer coverage — not running on win32.");
  process.exit(0);
}

// ---------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function git(cwd, args) {
  const r = spawnSync("git", args, {cwd, encoding: "utf8", stdio: "pipe", env: withoutOuterGitGuard(process.env), shell: false});
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout || "").trim();
}

// Autopilot's own bookkeeping directory (.autopilot/state.json, runs/,
// missions/, ...) is EXPECTED to gain new untracked entries as a mission
// runs — that is normal, ignored-by-design tool state (relay-guards.mjs's
// gitSnapshot() itself excludes it for the same reason), never a sign the
// official repository's reviewable content changed. Filtered out here so
// the official-repository-unchanged checks below compare only real content.
function repoStatusExcludingAutopilot(repo) {
  return git(repo, ["status", "--porcelain"]).split("\n").filter(line => line && !line.includes(".autopilot")).sort().join("\n");
}

function cleanup(...targets) {
  for (const dir of targets) {
    if (!dir) continue;
    try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* best-effort */ }
  }
}

// Task 15.4A correction: the bounded Windows process-tree spawn used to
// drive the real `node scripts/autopilot.mjs run` subprocess now lives in
// the shared, independently-regression-tested
// scripts/test-fixtures/windows-process-tree-runner.mjs (see
// test-windows-process-tree-runner.mjs) — this file no longer carries its
// own copy. The previous local copy called `taskkill` on deadline but never
// actually bounded the wait for it to take effect, so a `taskkill` failure
// or a child whose "close" event never arrived could leave the returned
// Promise pending forever; the shared helper fixes that with a
// deterministic backstop.
//
// assertCleanRun() is the required "never report a timed-out, output-
// overflowed, or termination-failed process as a successful scenario" gate
// (task 15.4A correction, part B) — called immediately after every
// runMission() before any scenario-specific assertion is made.
function assertCleanRun(label, result) {
  return check(`${label}: process completed cleanly (no timeout, output overflow, or termination failure)`,
    !result.timedOut && !result.outputLimitExceeded && !result.terminationFailed,
    {timedOut: result.timedOut, outputLimitExceeded: result.outputLimitExceeded, terminationFailed: result.terminationFailed, stdoutTail: (result.stdout || "").slice(-1000), stderrTail: (result.stderr || "").slice(-1000)});
}

// ---------------------------------------------------------------------
// Disposable skill-tree copy for the negative control (correction #2): the
// negative control must NEVER edit, rename, or replace any canonical
// production file, even temporarily. Instead, the entire scripts/ +
// adapters/ subtree (everything scripts/autopilot.mjs actually needs at
// runtime — see scripts/paths.mjs's skillRoot resolution) is copied into a
// fresh temp directory, and ONLY that copy's autopilot.mjs is patched.
// Running `node <copy>/scripts/autopilot.mjs` resolves its own skillRoot
// relative to itself, so it runs entirely against the copy.
// ---------------------------------------------------------------------
function makeDisposableSkillCopy() {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "ap-win-skillcopy-"));
  fs.cpSync(path.join(skillRoot, "scripts"), path.join(dest, "scripts"), {recursive: true});
  fs.cpSync(path.join(skillRoot, "adapters"), path.join(dest, "adapters"), {recursive: true});
  return dest;
}

// ---------------------------------------------------------------------
// Fixture repository: an ALREADY-complete SpecKit feature (so
// ensurePlanningReady() takes the cheap reviewExistingPlanning() path —
// exactly one plan_reviewer call — instead of the full specify/plan/tasks
// gate loop), plus modified-tracked/untracked/ignored files so a single
// plan_reviewer invocation can prove disposable-copy file visibility in one
// shot (requirements A.5-A.7).
// ---------------------------------------------------------------------
const WORKFLOW_YML = [
  "- id: specify",
  "  type: command",
  "  command: /speckit.specify",
  "- id: review-spec",
  "  type: gate",
  "  message: Review the spec",
  "- id: plan",
  "  type: command",
  "  command: /speckit.plan",
  "- id: review-plan",
  "  type: gate",
  "  message: Review the plan",
  "- id: tasks",
  "  type: command",
  "  command: /speckit.tasks",
  "- id: review-tasks",
  "  type: gate",
  "  message: Review the tasks",
  "- id: implement",
  "  type: command",
  "  command: /speckit.implement",
  ""
].join("\n");

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-win-disposable-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "windows-disposable-test@example.invalid"]);
  git(repo, ["config", "user.name", "Windows Disposable Test"]);

  fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "original-tracked-content\n");

  const workflowDir = path.join(repo, ".specify", "workflows", "speckit");
  fs.mkdirSync(workflowDir, {recursive: true});
  fs.writeFileSync(path.join(workflowDir, "workflow.yml"), WORKFLOW_YML);

  const featureDir = path.join(repo, "specs", "900-win-checkpoint");
  fs.mkdirSync(featureDir, {recursive: true});
  fs.writeFileSync(path.join(repo, ".specify", "feature.json"), JSON.stringify({feature_directory: "specs/900-win-checkpoint"}));
  fs.writeFileSync(path.join(featureDir, "spec.md"), "# Spec\n\nWindows checkpoint fixture feature.\n");
  fs.writeFileSync(path.join(featureDir, "plan.md"), "# Plan\n\nWindows checkpoint fixture plan.\n");
  fs.writeFileSync(path.join(featureDir, "tasks.md"), "## Phase 1: Do the windows checkpoint task\n\n- [ ] Do the windows checkpoint task\n");

  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init: complete speckit fixture at the plan-review checkpoint"]);

  // Left uncommitted/untracked on purpose, AFTER the commit — the disposable
  // copy must reflect CURRENT on-disk bytes, not last-commit bytes (A.5),
  // and must show an untracked-but-not-ignored file (A.6) while excluding
  // an ignored one (A.7).
  fs.writeFileSync(path.join(repo, "tracked.txt"), "modified-tracked-content\n");
  fs.writeFileSync(path.join(repo, "untracked.txt"), "untracked-content\n");
  fs.writeFileSync(path.join(repo, "ignored.txt"), "ignored-content\n");
  return repo;
}

function setScenario(repo, scenario) {
  fs.writeFileSync(path.join(repo, ".autopilot-test-scenario"), scenario);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", `test scenario: ${scenario}`]);
}

function writeConfig(repo) {
  const config = {
    schema_version: "3.0",
    project: {repo: ".", planning_framework: "speckit", state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs"},
    roles: Object.fromEntries(["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"].map(role => [
      role, {adapter: "cursor", model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null}
    ])),
    workflow: {
      specReview: true, planReview: true, analysisAfterTasks: false, implementationReview: true, finalReview: true,
      autoApproveSpec: false, autoApprovePlan: false, parallelIndependentTasks: false, gsdPlanningReview: false,
      relaySafety: {block_git_commit_push: true, verify_read_only_by_snapshot: true, capture_touched_files: true, persist_role_sessions: true}
    },
    gates: {commands: [], env_allowlist: [], require_reviewer: true, network_isolation: true},
    policy: {
      max_plan_revisions: 1, retry_delay_ms: 0, checkpoint_after_task: true, checkpoint_after_phase: true,
      require_human_commit: true, fail_closed_on_relay_violation: true,
      failure_budgets: {implementationFailureBudget: 1, verificationFailureBudget: 1, adapterRetryBudget: 1, infrastructureRetryBudget: 1}
    },
    safety: {allow_git_commit: false, allow_git_push: false, allow_destructive_operations: false},
    planning: {
      speckit: {workflow_file: ".specify/workflows/speckit/workflow.yml", task_candidates: [".specify/tasks.md", "specs/*/tasks.md", "specs/*/tasks/*.md"]},
      gsd: {
        phase_root: ".planning/phases", run_plan_verify: true, run_state_validate: true, write_summary_artifacts: true,
        write_verification_artifacts: true, write_uat_artifact: true, use_gsd_tools_when_available: false,
        parallelization: {enabled: false, plan_level: false, task_level: false, max_concurrent_agents: 1, min_plans_for_parallel: 99},
        planning_review: {enabled: false, review_after_each_stage: true, stages: ["discuss", "research", "plan", "plan-check"], max_revisions: 3, read_only_reviewer: true}
      }
    },
    capabilities: {project_defaults: [], role_requirements: {}, safety_denied: [], legacy_text_inference: false, verification: {browser: "native", require_browser: "when-task-requires"}}
  };
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), JSON.stringify(config, null, 2));
}

function writeStandaloneConfig(repo) {
  const config = {
    schema_version: "3.0",
    project: {repo: ".", planning_framework: "standalone", state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs"},
    roles: Object.fromEntries(["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"].map(role => [
      role, {adapter: "cursor", model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null}
    ])),
    workflow: {
      specReview: true, planReview: true, analysisAfterTasks: false, implementationReview: true, finalReview: true,
      autoApproveSpec: false, autoApprovePlan: false, parallelIndependentTasks: false, gsdPlanningReview: false,
      relaySafety: {block_git_commit_push: true, verify_read_only_by_snapshot: true, capture_touched_files: true, persist_role_sessions: true}
    },
    gates: {commands: [], env_allowlist: [], require_reviewer: true, network_isolation: true},
    policy: {
      max_plan_revisions: 1, retry_delay_ms: 0, checkpoint_after_task: true, checkpoint_after_phase: true,
      require_human_commit: true, fail_closed_on_relay_violation: true,
      failure_budgets: {implementationFailureBudget: 1, verificationFailureBudget: 1, adapterRetryBudget: 1, infrastructureRetryBudget: 1}
    },
    safety: {allow_git_commit: false, allow_git_push: false, allow_destructive_operations: false},
    planning: {
      speckit: {workflow_file: ".specify/workflows/speckit/workflow.yml", task_candidates: [".specify/tasks.md", "specs/*/tasks.md", "specs/*/tasks/*.md"]},
      gsd: {
        phase_root: ".planning/phases", run_plan_verify: true, run_state_validate: true, write_summary_artifacts: true,
        write_verification_artifacts: true, write_uat_artifact: true, use_gsd_tools_when_available: false,
        parallelization: {enabled: false, plan_level: false, task_level: false, max_concurrent_agents: 1, min_plans_for_parallel: 99},
        planning_review: {enabled: false, review_after_each_stage: true, stages: ["discuss", "research", "plan", "plan-check"], max_revisions: 3, read_only_reviewer: true}
      }
    },
    capabilities: {project_defaults: [], role_requirements: {}, safety_denied: [], legacy_text_inference: false, verification: {browser: "native", require_browser: "when-task-requires"}}
  };
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), JSON.stringify(config, null, 2));
}

// ---------------------------------------------------------------------
// Fake "cursor" adapter CLI: a Windows .cmd trampoline around a Node
// script. scripts/agent-process.mjs's resolveWindowsBinary()/
// winShimInvocation() is the REAL production path that resolves an
// extension-less adapter binary ("cursor-agent") on native Windows via a
// .cmd/.bat shim run through cmd.exe /d /s /c — mirroring how a real
// npm-installed CLI shim is found and launched. One shared binDir is reused
// across every scenario in this file (only the committed
// .autopilot-test-scenario file in each fixture repo differs), minimizing
// setup cost and antivirus first-scan overhead.
//
// Structural fields only: this script asserts/emits observable behavior
// (cwd, env vars, file visibility, write success/failure) — never prompt
// prose.
// ---------------------------------------------------------------------
// Mission name seeded by seedStandalonePlanReviewState and probed by the fake adapter.
const STANDALONE_PLAN_REVIEW_MISSION = "001-standalone-plan-review";

const ADAPTER_SCRIPT = `
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("fake-windows-cursor-agent 1.0.0");
  process.exit(0);
}

const PROMPT = await readStdin();
const firstLine = PROMPT.split(/\\r?\\n/, 1)[0] || "";
const role = firstLine.startsWith("ROLE=") ? firstLine.slice("ROLE=".length) : "";

function extractLine(prefix) {
  const re = new RegExp("^" + prefix + "(.*)$", "m");
  const m = PROMPT.match(re);
  return m ? m[1] : null;
}

if (role === "implementer") {
  console.log("implementer ok");
  // TASK-19 Phase 4 (task 12): a per-task Implementer invocation must end with
  // the AUTOPILOT_TASK_RESULT sentinel (scripts/task-result-contract.mjs) as the
  // final non-empty line, or the SpecKit loop escalates with
  // STRUCTURED_OUTPUT_MISSING and the mission never proceeds past
  // Implementation to the Plan Reviewer path this file proves.
  console.log("AUTOPILOT_TASK_RESULT=" + JSON.stringify({summary: "implementer ok", taskLocalCheck: {command: "true", status: "passed", exitCode: 0, summary: "fixture"}}));
  process.exit(0);
}

// Task 15.4A gave Code Reviewer, and task 15.4B1 gave Verifier, the same
// disposable-copy compatibility path on Native Windows that this file proves
// in full for Plan Reviewer. Both must therefore actually complete (not error
// out on an unknown ROLE) for the mission to proceed past Implementation and
// run to completion, which is what Section C now observes. Full behavioral
// proof for those two roles lives in their own sibling files
// (test-windows-disposable-code-reviewer.mjs,
// test-windows-disposable-verifier.mjs) and is not duplicated here.
if (role === "code_reviewer" || role === "verifier") {
  console.log("AUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: []}));
  process.exit(0);
}

if (role === "plan_reviewer") {
  const cwdAtStart = process.cwd();
  const workspaceRoot = path.dirname(cwdAtStart);
  let scenario = "pass";
  try { scenario = fs.readFileSync(path.join(cwdAtStart, ".autopilot-test-scenario"), "utf8").trim(); } catch {}

  const repository = extractLine("REPOSITORY=");
  const scratchMatch = PROMPT.match(/sanctioned scratch directory: (.*?) \\(/);
  const scratchPath = scratchMatch ? scratchMatch[1] : null;

  if (scenario === "cleanup-failure") {
    // Simulate a compromised/tampered workspace root: replace it with a
    // junction pointing at a dedicated, disposable EXTERNAL fixture
    // directory (never the official repository). Junctions do not require
    // the elevated privilege plain symlinks need on Windows.
    //
    // The substitution CANNOT happen synchronously from this process (or
    // from the cmd.exe wrapper that launched it, see agent-process.mjs's
    // winShimInvocation): Windows refuses to remove a directory that is any
    // live process's current working directory, and that cmd.exe wrapper's
    // OWN cwd is workspaceRoot/repository for as long as it is alive
    // (i.e. for as long as THIS node process — its child — is still
    // running). A plain in-process chdir()+rmSync() here always fails with
    // EPERM on the root itself, regardless of retries, because the lock is
    // held by the ancestor, not by this process.
    //
    // So the actual substitution is delegated to a fully DETACHED
    // grandchild (its own process group, cwd outside the workspace, no
    // stdio pipes to wait on) that retries in a loop until the cmd.exe
    // wrapper has exited (releasing the lock) and only then performs the
    // removal + junction creation. This process exits immediately after
    // launching it, ending the cmd.exe wrapper and releasing that lock.
    const externalFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-win-cleanupfixture-"));
    fs.writeFileSync(path.join(externalFixtureDir, "external-marker.txt"), "external-fixture-content");
    const probe = {cwd: cwdAtStart, workspaceRoot, externalFixtureDir, repositoryFromPrompt: repository};

    const watcherCode = [
      "const fs=require('fs');",
      "const target=" + JSON.stringify(workspaceRoot) + ";",
      "const linkTo=" + JSON.stringify(externalFixtureDir) + ";",
      "const deadline=Date.now()+15000;",
      "function sleepSync(ms){try{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);}catch{}}",
      "let removed=false;",
      "while(Date.now()<deadline){try{fs.rmSync(target,{recursive:true,force:true});removed=true;break;}catch(e){sleepSync(150);}}",
      "if(removed){try{fs.symlinkSync(linkTo,target,'junction');}catch(e){try{fs.writeFileSync(target+'.watcher-error.txt',String(e&&e.stack||e));}catch{}}}"
    ].join("\\n");
    const {spawn: spawnDetached} = await import("node:child_process");
    const watcher = spawnDetached(process.execPath, ["-e", watcherCode], {cwd: os.tmpdir(), detached: true, stdio: "ignore"});
    watcher.unref();

    const probeJson = JSON.stringify(probe);
    console.log("PROBE:" + probeJson);
    console.log("AUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: [probeJson]}));
    process.exit(0);
  }

  const probe = {
    cwd: cwdAtStart,
    repositoryFromPrompt: repository,
    pwdEnv: process.env.PWD || null,
    initCwdEnv: process.env.INIT_CWD || null,
    safeDirectoryKeyEnv: process.env.GIT_CONFIG_KEY_1 || null,
    safeDirectoryValueEnv: process.env.GIT_CONFIG_VALUE_1 || null,
    scratchPathSeen: scratchPath
  };

  try { probe.trackedContent = fs.readFileSync("tracked.txt", "utf8"); }
  catch (e) { probe.trackedContent = null; probe.trackedError = String(e.code || e.message); }
  try { probe.untrackedContent = fs.readFileSync("untracked.txt", "utf8"); }
  catch (e) { probe.untrackedContent = null; probe.untrackedError = String(e.code || e.message); }
  probe.ignoredExists = fs.existsSync("ignored.txt");

  // For standalone scenarios with mission overlay: check EXACTLY the seeded
  // mission's PLAN.md, and record any other .autopilot/ content (the overlay
  // must copy only .autopilot/missions/<mission>/ and nothing else).
  try {
    const expectedMission = ${JSON.stringify(STANDALONE_PLAN_REVIEW_MISSION)};
    const autopilotPath = path.join(cwdAtStart, ".autopilot");
    const missionsPath = path.join(autopilotPath, "missions");
    probe.expectedMission = expectedMission;
    if (fs.existsSync(missionsPath)) {
      const exactPlan = path.join(missionsPath, expectedMission, "PLAN.md");
      probe.missionPlanMdVisible = fs.existsSync(exactPlan) ? "VISIBLE" : "NOT_FOUND";
      probe.otherMissionDirs = fs.readdirSync(missionsPath).filter(name => name !== expectedMission).sort();
      probe.otherAutopilotEntries = fs.readdirSync(autopilotPath).filter(name => name !== "missions").sort();
    } else {
      probe.missionPlanMdVisible = "MISSIONS_DIR_MISSING";
      probe.otherMissionDirs = [];
      probe.otherAutopilotEntries = fs.existsSync(autopilotPath) ? fs.readdirSync(autopilotPath).sort() : [];
    }
  } catch (e) {
    probe.missionPlanMdVisible = "ERROR:" + (e.code || e.message);
  }

  try {
    fs.writeFileSync("reviewer-relative-write.txt", "written-by-reviewer");
    probe.relativeWrite = "SUCCEEDED";
  } catch (e) {
    probe.relativeWrite = "FAILED:" + (e.code || e.message);
  }

  if (scratchPath) {
    try {
      fs.writeFileSync(path.join(scratchPath, "scratch-write.txt"), "scratch-ok");
      probe.scratchWrite = "SUCCEEDED";
    } catch (e) {
      probe.scratchWrite = "FAILED:" + (e.code || e.message);
    }
  } else {
    probe.scratchWrite = "NO_SCRATCH_PATH_FOUND";
  }

  const probeJson = JSON.stringify(probe);
  console.log("PROBE:" + probeJson);

  if (scenario === "nonzero") {
    process.exit(7);
  }
  if (scenario === "malformed") {
    console.log('AUTOPILOT_REVIEW={"decision":"PASS"');
    process.exit(0);
  }
  const decision = scenario === "fail" ? "FAIL" : "PASS";
  console.log("AUTOPILOT_REVIEW=" + JSON.stringify({decision, findings: [probeJson]}));
  process.exit(0);
}

console.error("fake-windows-adapter: unknown ROLE '" + role + "'");
process.exit(1);
`;

function makeBin() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-win-disposable-bin-"));
  const scriptPath = path.join(binDir, "windows-disposable-plan-reviewer-adapter.mjs");
  fs.writeFileSync(scriptPath, ADAPTER_SCRIPT);
  const cmdPath = path.join(binDir, "cursor-agent.cmd");
  fs.writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\nexit /b %errorlevel%\r\n`);
  return binDir;
}

// ---------------------------------------------------------------------
// Mission runner: NO explicit request text is passed — this is what makes
// ensurePlanningReady() take the cheap reviewExistingPlanning() path
// against the pre-seeded "complete" fixture instead of the full gate loop.
// ---------------------------------------------------------------------
function runMission(autopilotPath, repo, binDir, {timeoutMs}) {
    // Strip any outer mission/gate git guard (PATH shim + hooks): the
  // nested mission installs its own, and every git call through both
  // ran the mission several times slower under the orchestrator gate.
  const base = withoutOuterGitGuard({...process.env});
  const env = {...base, PATH: `${binDir};${base.PATH || ""}`};
  return runWindowsProcessTreeBounded(process.execPath, [autopilotPath, "run", "--repo", repo], {cwd: repo, env, timeoutMs});
}

function readAllResults(repo) {
  const root = path.join(repo, ".autopilot");
  const files = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "result.json") files.push(full);
    }
  })(root);
  return files.map(file => ({file, data: JSON.parse(fs.readFileSync(file, "utf8"))}));
}

function extractProbe(result) {
  const findings = result?.review?.findings || result?.verdict?.findings || [];
  for (const finding of findings) {
    try {
      const parsed = JSON.parse(finding);
      if (parsed && typeof parsed === "object" && "cwd" in parsed) return parsed;
    } catch { /* not the probe payload */ }
  }
  return null;
}

// Process-tree / temp-workspace leak check: no cursor-agent.exe-descended
// node/cmd process and no leftover ap-win-disposable-* temp directory
// should remain once every scenario below has completed.
function listLeakedTempWorkspaces(prefix) {
  const root = os.tmpdir();
  return fs.readdirSync(root).filter(name => name.startsWith(prefix)).map(name => path.join(root, name));
}

// ---------------------------------------------------------------------
// A single shared bin directory for every scenario (correction: data-driven
// scenarios with identical setup, minimal spawn count for runtime).
// ---------------------------------------------------------------------
const sharedBinDir = makeBin();

// =======================================================================
// Negative control (correction #2): runs against a DISPOSABLE COPY of the
// entire skill tree with the integration condition disabled — the
// canonical scripts/autopilot.mjs is never touched. SHA256 before/after
// proves it byte-for-byte.
// =======================================================================
async function runNegativeControl() {
  const canonicalHashBefore = sha256File(CANONICAL_AUTOPILOT);

  const skillCopyRoot = makeDisposableSkillCopy();
  const copiedAutopilotPath = path.join(skillCopyRoot, "scripts", "autopilot.mjs");
  const original = fs.readFileSync(copiedAutopilotPath, "utf8");
  const marker = "const useDisposableReviewerWorkspace = readOnly";
  if (!check("negative control: integration marker found in the disposable copy", original.includes(marker))) {
    cleanup(skillCopyRoot);
    return;
  }
  const disabled = original.replace(marker, "const useDisposableReviewerWorkspace = false && readOnly");
  assert.notEqual(disabled, original, "negative-control copy patch must actually change the copied file");
  fs.writeFileSync(copiedAutopilotPath, disabled);

  const repo = makeRepo();
  try {
    writeConfig(repo);
    setScenario(repo, "pass");
    const result = await runMission(copiedAutopilotPath, repo, sharedBinDir, {timeoutMs: 120000});
    assertCleanRun("negative control", result);
    const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
    check("negative control: reproduces READ_ONLY_CONTAINMENT_UNAVAILABLE with the integration disabled (disposable skill copy only)",
      combined.includes("READ_ONLY_CONTAINMENT_UNAVAILABLE"), {tail: combined.slice(-1500), timedOut: result.timedOut});
  } finally {
    cleanup(repo, skillCopyRoot);
  }

  const canonicalHashAfter = sha256File(CANONICAL_AUTOPILOT);
  check("negative control: canonical scripts/autopilot.mjs is byte-for-byte unchanged (SHA256 before === after)",
    canonicalHashBefore === canonicalHashAfter, {before: canonicalHashBefore, after: canonicalHashAfter});
}

// =======================================================================
// Section A + C: PASS scenario — full disposable-copy proof for Plan
// Reviewer, then the mission proceeds into implementation where Code
// Reviewer (task 15.4A) and Verifier (task 15.4B1) both PASS via the same
// disposable-copy compatibility path — full behavioral proof for those two
// roles lives in test-windows-disposable-code-reviewer.mjs and
// test-windows-disposable-verifier.mjs, and is not duplicated here. Section
// C's job in THIS file is unchanged in spirit: prove that the Plan Reviewer
// disposable-copy path does not merely succeed in isolation but lets the
// SpecKit mission continue past it. What changed is the endpoint — the
// mission now runs to completion instead of stopping at a Verifier
// containment failure.
// =======================================================================
async function runPassScenario() {
  const repo = makeRepo();
  try {
    writeConfig(repo);
    setScenario(repo, "pass");

    const result = await runMission(CANONICAL_AUTOPILOT, repo, sharedBinDir, {timeoutMs: 220000});
    if (!assertCleanRun("A", result)) return;

    const results = readAllResults(repo);
    const reviewerRuns = results.filter(r => r.data.role === "plan_reviewer");
    if (!check("A: at least one plan_reviewer run recorded", reviewerRuns.length > 0, {stdout: (result.stdout || "").slice(-2000), stderr: (result.stderr || "").slice(-2000), timedOut: result.timedOut})) {
      return;
    }
    const first = reviewerRuns[0].data;
    const probe = extractProbe(first);
    if (!check("A: reviewer probe payload recovered from findings", !!probe, first)) return;

    const officialRepoReal = fs.realpathSync(repo);
    const cwdIsDisposable = typeof probe.cwd === "string" && probe.cwd.length > 0
      && path.resolve(probe.cwd) !== officialRepoReal
      && !path.resolve(probe.cwd).toLowerCase().startsWith(officialRepoReal.toLowerCase() + path.sep);
    check("A.1/A.2: SpecKit Plan Reviewer launched and its real cwd is a disposable copy (not the official repo)", cwdIsDisposable, probe.cwd);
    check("A.3: REPOSITORY in the received prompt equals the reviewer's real cwd (the disposable copy)", probe.repositoryFromPrompt === probe.cwd, probe);
    check("A.4a: official repository path not used as PWD", probe.pwdEnv === probe.cwd, {pwdEnv: probe.pwdEnv, cwd: probe.cwd});
    check("A.4b: official repository path not used as INIT_CWD", probe.initCwdEnv === probe.cwd, {initCwdEnv: probe.initCwdEnv, cwd: probe.cwd});
    check("A.4c: Git guard safe.directory points at the disposable copy, not the official repository", probe.safeDirectoryValueEnv === probe.cwd, probe);
    check("A.5: modified tracked file content (current on-disk bytes) visible to the reviewer", probe.trackedContent === "modified-tracked-content\n", probe);
    check("A.6: untracked non-ignored file visible to the reviewer", probe.untrackedContent === "untracked-content\n", probe);
    check("A.7: ignored file absent from the disposable copy", probe.ignoredExists === false, probe);
    check("A.8/A.9: reviewer's relative write inside its own cwd succeeded (disposable copy is a plain writable filesystem)", probe.relativeWrite === "SUCCEEDED", probe);
    check("A.10: the reviewer's relative write does not appear in the official repository", !fs.existsSync(path.join(repo, "reviewer-relative-write.txt")));
    check("A.11: scratch writing succeeded", probe.scratchWrite === "SUCCEEDED", probe);
    check("A.12: a valid AUTOPILOT_REVIEW PASS was recognized", first.status === "completed" && first.verdict?.decision === "PASS", first);

    check("A.13: the plan_reviewer call itself left the official repository's Git state untouched",
      first.treeChanged === false && first.readOnlyViolation === false && first.commitDetected === false && first.policyViolation === null,
      {treeChanged: first.treeChanged, readOnlyViolation: first.readOnlyViolation, commitDetected: first.commitDetected, policyViolation: first.policyViolation});

    check("A.14: the disposable scratch directory was removed afterward", typeof first.scratchDir === "string" && !fs.existsSync(first.scratchDir), first.scratchDir);
    if (typeof first.scratchDir === "string") {
      check("A.14b: the disposable workspace root was removed afterward", !fs.existsSync(path.dirname(first.scratchDir)), path.dirname(first.scratchDir));
    }

    const safety = first.executionPlaneSafety || {};
    check("A.15a: executionPlaneSafety.mechanism truthfully reports windows-disposable-copy", safety.mechanism === "windows-disposable-copy", safety);
    check("A.15b: executionPlaneSafety.strength truthfully reports compatibility (not OS-enforced)", safety.strength === "compatibility", safety);
    check("A.15c: executionPlaneSafety.envelopeApplied is false (no bubblewrap envelope was used)", safety.envelopeApplied === false, safety);
    check("A.15d: executionPlaneSafety.officialRepositoryUsedAsCwd is false", safety.officialRepositoryUsedAsCwd === false, safety);
    check("A.16 (correction #4): executionPlaneSafety.scratchRetained is false (truthful — scratch is deleted, never kept for audit)", safety.scratchRetained === false, safety);

    const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`;
    const reachedImplementation = combinedOutput.includes("[Implementation]");
    if (check("C: this run reached the implementation phase (the existing-plan review passed via the disposable copy)", reachedImplementation, combinedOutput.slice(-3000))) {
      // Task 15.4A (Code Reviewer) and task 15.4B1 (Verifier) removed the
      // two remaining native-Windows blocks after Plan Review. Neither role
      // is re-proven in depth here — that is their own sibling files' job.
      // What this file asserts is only what it always asserted: that the
      // Plan Reviewer disposable copy did not leave the mission stuck, and
      // that nothing downstream ever falls back to the official repository
      // or to an OS-enforced-containment claim.
      const codeReviewerRuns = results.filter(r => r.data.role === "code_reviewer");
      const verifierRuns = results.filter(r => r.data.role === "verifier");
      check("C: Code Reviewer runs (and PASSes) via disposable-copy compatibility instead of failing closed",
        codeReviewerRuns.length > 0 && codeReviewerRuns[0].data.status === "completed" && codeReviewerRuns[0].data.verdict?.decision === "PASS",
        codeReviewerRuns[0]?.data);
      if (codeReviewerRuns.length > 0) {
        const crSafety = codeReviewerRuns[0].data.executionPlaneSafety || {};
        check("C: Code Reviewer's executionPlaneSafety truthfully reports the same windows-disposable-copy/compatibility metadata as Plan Reviewer",
          crSafety.mechanism === "windows-disposable-copy" && crSafety.strength === "compatibility" && crSafety.envelopeApplied === false,
          crSafety);
      }
      check("C: Verifier now runs (and PASSes) via the same disposable-copy compatibility path instead of failing closed",
        verifierRuns.length > 0 && verifierRuns[0].data.status === "completed" && verifierRuns[0].data.verdict?.decision === "PASS",
        verifierRuns[0]?.data);
      if (verifierRuns.length > 0) {
        const vSafety = verifierRuns[0].data.executionPlaneSafety || {};
        check("C: Verifier's executionPlaneSafety truthfully reports the same windows-disposable-copy/compatibility metadata as Plan Reviewer",
          vSafety.mechanism === "windows-disposable-copy" && vSafety.strength === "compatibility"
            && vSafety.envelopeApplied === false && vSafety.officialRepositoryUsedAsCwd === false && vSafety.scratchRetained === false,
          vSafety);
      }
      check("C: no read-only role reported READ_ONLY_CONTAINMENT_UNAVAILABLE anywhere in this SpecKit mission",
        !/READ_ONLY_CONTAINMENT_UNAVAILABLE/.test(combinedOutput), combinedOutput.slice(-1500));
      check("C: the SpecKit mission ran to completion after the disposable-copy Plan Review (exit 0)",
        result.status === 0 && /ALL WORK COMPLETE/.test(combinedOutput), {status: result.status, timedOut: result.timedOut, tail: combinedOutput.slice(-1500)});
      check("C: no run in this mission ever claims an OS-enforced containment envelope was applied",
        results.every(r => (r.data.executionPlaneSafety || {}).envelopeApplied !== true),
        results.map(r => ({role: r.data.role, safety: r.data.executionPlaneSafety})));
    }
  } finally {
    cleanup(repo);
  }
}

// =======================================================================
// Section B: failure cleanup — valid FAIL, malformed sentinel, nonzero
// exit, and cleanup failure. Data-driven: identical setup, only the
// committed scenario selector differs.
// =======================================================================
async function runFailureScenario(scenario, label) {
  const repo = makeRepo();
  try {
    writeConfig(repo);
    setScenario(repo, scenario);
    const before = {head: git(repo, ["rev-parse", "HEAD"]), status: repoStatusExcludingAutopilot(repo)};

    const result = await runMission(CANONICAL_AUTOPILOT, repo, sharedBinDir, {timeoutMs: 160000});
    if (!assertCleanRun(`B(${label})`, result)) return;

    const results = readAllResults(repo);
    const reviewerRuns = results.filter(r => r.data.role === "plan_reviewer");
    if (!check(`B(${label}): at least one plan_reviewer run recorded`, reviewerRuns.length > 0, {stdout: (result.stdout || "").slice(-1500), stderr: (result.stderr || "").slice(-1500), timedOut: result.timedOut})) {
      return;
    }
    const first = reviewerRuns[0].data;
    const probe = extractProbe(first);

    check(`B(${label}): the mission never records a false successful completion`,
      !(first.status === "completed" && first.verdict?.decision === "PASS"), {status: first.status, decision: first.verdict?.decision});

    if (scenario === "cleanup-failure") {
      if (probe?.substitutionError) {
        check(`B(${label}): the fixture's own workspace-root substitution did not fail (diagnostic — this is a test-fixture problem, not the production cleanup-failure path)`, false, probe.substitutionError);
        return;
      }
      check(`B(${label}): result.status is forced to "failed" even though the reviewer's own decision was PASS`, first.status === "failed", first.status);
      check(`B(${label}): workspaceCleanupFailed is recorded`, first.workspaceCleanupFailed === true, first.workspaceCleanupFailed);
      check(`B(${label}): the ORIGINAL reviewer decision is still preserved in result.review (primary + cleanup failure both preserved)`,
        first.review?.decision === "PASS", first.review);
      check(`B(${label}): executionPlaneSafety.workspaceCleaned is false`, first.executionPlaneSafety?.workspaceCleaned === false, first.executionPlaneSafety);

      if (check(`B(${label}): probe payload (workspaceRoot/externalFixtureDir) recovered`, !!probe?.workspaceRoot && !!probe?.externalFixtureDir, probe)) {
        let rootStat = null;
        try { rootStat = fs.lstatSync(probe.workspaceRoot); } catch { /* already gone */ }
        check(`B(${label}): the substituted workspace root is still a junction/symlink (cleanup correctly refused to remove it)`,
          !!rootStat && rootStat.isSymbolicLink(), rootStat && {isSymbolicLink: rootStat.isSymbolicLink()});
        check(`B(${label}): the external fixture directory is unchanged (still contains its marker)`,
          fs.existsSync(path.join(probe.externalFixtureDir, "external-marker.txt")));

        // Safely remove ONLY the test-created junction (never recursive —
        // that would follow the link into the external fixture).
        try { fs.rmdirSync(probe.workspaceRoot); } catch { /* best-effort */ }
        check(`B(${label}): the test-created junction was removed afterward`, !fs.existsSync(probe.workspaceRoot));
        check(`B(${label}): removing the junction did not remove the external fixture directory's contents`,
          fs.existsSync(path.join(probe.externalFixtureDir, "external-marker.txt")));
        cleanup(probe.externalFixtureDir);
      }
    } else {
      check(`B(${label}): the disposable scratch directory was removed afterward`, typeof first.scratchDir === "string" && !fs.existsSync(first.scratchDir), first.scratchDir);
      if (typeof first.scratchDir === "string") {
        check(`B(${label}): the disposable workspace root was removed afterward`, !fs.existsSync(path.dirname(first.scratchDir)), path.dirname(first.scratchDir));
      }
    }

    const after = {head: git(repo, ["rev-parse", "HEAD"]), status: repoStatusExcludingAutopilot(repo)};
    check(`B(${label}): the official repository HEAD is unchanged`, before.head === after.head, {before, after});
    check(`B(${label}): the official repository working tree status is unchanged (.autopilot/ bookkeeping excluded)`, before.status === after.status, {before, after});

    const implementerRan = results.some(r => r.data.role === "implementer");
    const codeReviewerRan = results.some(r => r.data.role === "code_reviewer");
    check(`B(${label}): no later workflow role (implementer/code_reviewer) launched`, !implementerRan && !codeReviewerRan, results.map(r => r.data.role));
  } finally {
    cleanup(repo);
  }
}

// Standalone seeding for plan_reviewer testing: create a resolvable mission
// with a numeric-prefixed name and seed state.json so that missionFor() will
// find the mission and disposableCopyArgs can apply the overlay.
function seedStandalonePlanReviewState(repo) {
  const mission = STANDALONE_PLAN_REVIEW_MISSION;
  const missionDir = path.join(repo, ".autopilot", "missions", mission);

  // Create the mission directory with PLAN.md (checklist for ensureStandaloneSplit to split into TASKS.md)
  fs.mkdirSync(missionDir, {recursive: true});
  fs.writeFileSync(path.join(missionDir, "PLAN.md"), "# Standalone Plan Review Test\n\n- [ ] Verify plan review works in standalone\n");

  ensureStandaloneSplit(repo, {mission});
  ensureBaseline(repo, `mission-${sanitizeKeySegment(mission)}`, {mission, declaredPaths: declaredDeliverables(repo, mission)});
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
    version: 1, phase: "planning", step: "planning", taskIndex: 0, phaseIndex: 0, attempt: 0,
    mission, status: "planning"
  }, null, 2));
}

// =======================================================================
// Standalone scenario: prove that standalone read-only roles take the
// disposable-copy path (via the mission overlay from task 2.1) and that
// PLAN.md is visible when a mission is provided. This test asserts the
// optional mission parameter on createReviewerWorkspace is wired correctly
// into runRelay via the disposableCopyArgs helper.
// =======================================================================
async function runStandaloneScenario() {
  const repo = makeRepo();
  try {
    writeStandaloneConfig(repo);
    setScenario(repo, "pass");

    // Create a resolvable mission directory with PLAN.md and TASKS.md, seeded
    // into state.json so that missionFor() finds it and disposableCopyArgs can
    // apply the mission-dir overlay to the disposable copy.
    seedStandalonePlanReviewState(repo);

    const result = await runMission(CANONICAL_AUTOPILOT, repo, sharedBinDir, {timeoutMs: 220000});
    if (!assertCleanRun("standalone", result)) return;

    const results = readAllResults(repo);
    const reviewerRuns = results.filter(r => r.data.role === "plan_reviewer");
    if (!check("standalone: at least one plan_reviewer run recorded", reviewerRuns.length > 0, {stdout: (result.stdout || "").slice(-2000), stderr: (result.stderr || "").slice(-2000), timedOut: result.timedOut})) {
      return;
    }
    const first = reviewerRuns[0].data;
    const probe = extractProbe(first);
    if (!check("standalone: reviewer probe payload recovered from findings", !!probe, first)) return;

    const officialRepoReal = fs.realpathSync(repo);
    const cwdIsDisposable = typeof probe.cwd === "string" && probe.cwd.length > 0
      && path.resolve(probe.cwd) !== officialRepoReal
      && !path.resolve(probe.cwd).toLowerCase().startsWith(officialRepoReal.toLowerCase() + path.sep);
    check("standalone: standalone read-only role takes the disposable-copy path (cwd is a disposable copy, not official repo)", cwdIsDisposable, probe.cwd);

    const safety = first.executionPlaneSafety || {};
    check("standalone: executionPlaneSafety.mechanism truthfully reports windows-disposable-copy for standalone", safety.mechanism === "windows-disposable-copy", safety);

    // Verify the overlay: the probe checks exactly
    // <disposable cwd>/.autopilot/missions/001-standalone-plan-review/PLAN.md,
    // and records any other mission dir or other .autopilot/ entry, which must
    // be absent (the overlay copies only the seeded mission dir, minus runs/).
    check("standalone: PLAN.md is visible in disposable copy at the exact seeded mission path", probe.missionPlanMdVisible === "VISIBLE" && probe.expectedMission === STANDALONE_PLAN_REVIEW_MISSION, probe);
    check("standalone: no other mission dir is present in the disposable copy", Array.isArray(probe.otherMissionDirs) && probe.otherMissionDirs.length === 0, probe);
    check("standalone: no other .autopilot/ content (besides missions/<mission>) is present in the disposable copy", Array.isArray(probe.otherAutopilotEntries) && probe.otherAutopilotEntries.length === 0, probe);

    check("standalone: plan_reviewer completed successfully with the mission overlay applied", first.status === "completed" && first.verdict?.decision === "PASS", first);

    const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`;
    check("standalone: no READ_ONLY_CONTAINMENT_UNAVAILABLE error with standalone + mission overlay",
      !/READ_ONLY_CONTAINMENT_UNAVAILABLE/.test(combinedOutput), combinedOutput.slice(-1500));
  } finally {
    cleanup(repo);
  }
}

// =======================================================================
// Run everything, then verify no process-tree/temp-workspace leaks remain.
// =======================================================================
async function main() {
  const overallStart = Date.now();

  // Snapshot pre-existing temp entries under these prefixes FIRST — an
  // unrelated earlier session/tool run may have already left entries with
  // the same prefix; only NEW ones that appear and are not cleaned up by
  // this run's own scenarios count as a leak from this run.
  const leakPrefixes = ["ap-win-disposable-", "ap-win-skillcopy-", "ap-win-cleanupfixture-", "autopilot-reviewer-"];
  const preExisting = new Set(leakPrefixes.flatMap(listLeakedTempWorkspaces));

  // Every scenario uses its own fixture repo/skill-copy and (for B
  // scenarios) its own committed scenario selector — fully independent of
  // each other, so they run concurrently. This is what keeps total wall
  // time bounded: the dominant cost observed on this machine is per-process
  // spawn/AV-scan latency (multiple git subprocess calls per snapshot, 5
  // sequential role --version preflight probes, the adapter spawn itself),
  // not CPU throughput, so running scenarios in parallel — rather than
  // five-plus sequential full missions — is what keeps this test's real
  // wall-clock time down instead of just relying on generous timeouts.
  await Promise.all([
    runNegativeControl(),
    runPassScenario(),
    runStandaloneScenario(),
    runFailureScenario("fail", "valid FAIL"),
    runFailureScenario("malformed", "malformed sentinel"),
    runFailureScenario("nonzero", "nonzero exit"),
    runFailureScenario("cleanup-failure", "cleanup failure")
  ]);

  // Temp-workspace leak check: no NEW ap-win-disposable-*/ap-win-skillcopy-*
  // fixture directory should remain (all were removed in each scenario's
  // own `finally`/cleanup() call above) beyond what already existed before
  // this run started.
  const leakedFixtures = leakPrefixes.flatMap(listLeakedTempWorkspaces).filter(p => !preExisting.has(p));
  check("no leftover fixture/skill-copy/disposable-reviewer-workspace temp directories remain (beyond what pre-existed this run)", leakedFixtures.length === 0, leakedFixtures);

  // Process-tree leak check: no cmd.exe/node.exe descendant spawned for this
  // test's fake adapter (identified by its distinctive script path) should
  // still be alive — the shared runWindowsProcessTreeBounded()'s
  // `taskkill /T /F` on timeout (with its own bounded backstop; see
  // test-windows-process-tree-runner.mjs), and the normal `child.on("close")`
  // wait on natural completion, are both meant to guarantee this.
  const survivorCheck = spawnSync("powershell", ["-NoProfile", "-Command",
    `(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*windows-disposable-plan-reviewer-adapter.mjs*' -or $_.CommandLine -like '*${sharedBinDir.replace(/\\/g, "\\\\")}*' } | Measure-Object).Count`
  ], {encoding: "utf8"});
  const survivorCount = parseInt((survivorCheck.stdout || "0").trim(), 10) || 0;
  check("no surviving cmd.exe/node.exe descendant of this test's fake adapter remains", survivorCount === 0, {survivorCount, stderr: survivorCheck.stderr});

  cleanup(sharedBinDir);

  const elapsedSeconds = ((Date.now() - overallStart) / 1000).toFixed(1);
  console.log(`\n(total runtime: ${elapsedSeconds}s)`);

  if (failures) {
    console.error(`\n${failures} windows disposable plan-reviewer check(s) failed.`);
    process.exit(1);
  }
  console.log("\nwindows disposable plan-reviewer PASS (negative control + A/C + B x4)");
}

await main();
