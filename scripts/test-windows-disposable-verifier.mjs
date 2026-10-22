#!/usr/bin/env node
// Task 15.4B1 behavioral proof: Native Windows SpecKit Verifier running
// against the disposable reviewer-workspace copy (scripts/reviewer-workspace.mjs)
// instead of failing closed with READ_ONLY_CONTAINMENT_UNAVAILABLE — the same
// compatibility path task 15.3 gave Plan Reviewer and task 15.4A gave Code
// Reviewer, extended in scripts/autopilot.mjs's runRelay() to cover
// roleName==="verifier" too (see the shared `useDisposableReviewerWorkspace`
// condition). This file does NOT re-implement or fork that mechanism — it
// drives the REAL production `node scripts/autopilot.mjs run --repo <repo>`
// subprocess and observes what the shared code path actually does for the
// Verifier specifically.
//
// Deliberately NOT duplicated here (already exhaustively covered by the two
// sibling files, which exercise the identical underlying
// createReviewerWorkspace()/cleanup() primitive):
//   - symlink/junction handling and ancestor-link refusal,
//   - cleanup-failure (junction substitution) fail-closed behavior,
//   - malformed / nonzero-exit reviewer-output scenarios.
// What IS proven here is what changed for task 15.4B1: the Verifier's own
// disposable-copy behavior end to end (Section A), the Implementer ->
// Code Review PASS -> Verifier ordering with a real Code Review FAIL in the
// middle (Section B), a negative control against a DISPOSABLE COPY of the
// skill with only the Verifier half of the integration disabled (Section C),
// and the standalone/non-SpecKit fail-closed boundary (Section D).
//
// Sections A and B seed the fixture DIRECTLY at a real SpecKit
// implementation checkpoint — a persisted .autopilot/state.json using the
// current production state contract (see seedSpecKitTasksReadyState(),
// whose shape is exactly what scripts/autopilot.mjs's
// reviewExistingPlanning() itself writes on success). runImplementation()
// treats "tasks_ready" as already-open work and skips ensurePlanningReady()
// entirely, so Planner and Plan Reviewer are never launched — proven
// explicitly below, not just assumed.
//
// Playwright/browser provisioning is explicitly OUT OF SCOPE for task
// 15.4B1 and is not exercised or asserted anywhere in this file: the
// fixtures configure no gate commands, so the Verifier runs the ordinary
// non-browser path.
//
// Windows-only: this whole file is a no-op PASS on any other platform (the
// production condition it exercises is itself gated to process.platform===
// "win32"). WSL/Linux bubblewrap coverage for the verifier role already
// exists in test-relay-scratch-containment.mjs and
// test-workflow-order-speckit.mjs and is unaffected by this task.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert";
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
  console.log("SKIP: task 15.4B1 Native Windows disposable-copy Verifier coverage — not running on win32.");
  process.exit(0);
}

// ---------------------------------------------------------------------
// Small utilities (mirrors the two sibling Windows test files)
// ---------------------------------------------------------------------

function git(cwd, args) {
  const r = spawnSync("git", args, {cwd, encoding: "utf8", stdio: "pipe", env: withoutOuterGitGuard(process.env), shell: false});
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout || "").trim();
}

function cleanup(...targets) {
  for (const dir of targets) {
    if (!dir) continue;
    try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* best-effort */ }
  }
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// The required "never report a timed-out, output-overflowed, or
// termination-failed process as a successful scenario" gate — called
// immediately after every runMission() before any scenario-specific
// assertion is made.
function assertCleanRun(label, result) {
  return check(`${label}: process completed cleanly (no timeout, output overflow, or termination failure)`,
    !result.timedOut && !result.outputLimitExceeded && !result.terminationFailed,
    {timedOut: result.timedOut, outputLimitExceeded: result.outputLimitExceeded, terminationFailed: result.terminationFailed, stdoutTail: (result.stdout || "").slice(-1000), stderrTail: (result.stderr || "").slice(-1000)});
}

// Section C copies the whole runnable skill tree so the negative control
// never touches the canonical source (proven byte-for-byte by SHA256).
function makeDisposableSkillCopy() {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "ap-win-vf-skillcopy-"));
  fs.cpSync(path.join(skillRoot, "scripts"), path.join(dest, "scripts"), {recursive: true});
  fs.cpSync(path.join(skillRoot, "adapters"), path.join(dest, "adapters"), {recursive: true});
  return dest;
}

// ---------------------------------------------------------------------
// SpecKit fixture: an ALREADY-complete SpecKit feature at the
// implementation checkpoint (real spec.md/plan.md/tasks.md), a TRACKED
// implementation.txt (so the Implementer's modification of it is a genuine
// tracked-file change, not a new file), and a gitignored fixture file (so
// the disposable copy's exclusion of it can be proven).
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

const TASK_TEXT = "Do the windows verifier checkpoint task";

function seedSpecKitTasksReadyState(repo, featureDir) {
  const tasksFileAbsolute = path.join(featureDir, "tasks.md");
  const state = {
    version: 1,
    phase: "tasks_ready",
    step: "tasks_ready",
    taskIndex: 0,
    phaseIndex: 0,
    attempt: 0,
    planningIntent: {kind: "new", reason: "no prior active request"},
    planningRequest: "Use the current project request/context.",
    planningDetection: {
      framework: "speckit", status: "complete", entryIndex: 7,
      evidence: {spec: true, plan: true, tasks: true},
      taskFiles: [tasksFileAbsolute],
      requiresValidation: true, confidence: "high",
      reason: "spec, plan, and tasks artifacts detected"
    },
    sessions: {},
    planningStateReview: {status: "passed", framework: "speckit", phase: null, at: new Date().toISOString()}
  };
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(state, null, 2));
}

function makeSpecKitRepo(prefix) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `ap-win-vf-${prefix}-`));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "windows-verifier-test@example.invalid"]);
  git(repo, ["config", "user.name", "Windows Verifier Test"]);

  fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n");
  fs.writeFileSync(path.join(repo, "implementation.txt"), "not-yet-implemented\n");

  const workflowDir = path.join(repo, ".specify", "workflows", "speckit");
  fs.mkdirSync(workflowDir, {recursive: true});
  fs.writeFileSync(path.join(workflowDir, "workflow.yml"), WORKFLOW_YML);

  const featureDir = path.join(repo, "specs", "902-win-verifier-checkpoint");
  fs.mkdirSync(featureDir, {recursive: true});
  fs.writeFileSync(path.join(repo, ".specify", "feature.json"), JSON.stringify({feature_directory: "specs/902-win-verifier-checkpoint"}));
  fs.writeFileSync(path.join(featureDir, "spec.md"), "# Spec\n\nWindows Verifier checkpoint fixture feature.\n");
  fs.writeFileSync(path.join(featureDir, "plan.md"), "# Plan\n\nWindows Verifier checkpoint fixture plan.\n");
  fs.writeFileSync(path.join(featureDir, "tasks.md"), `## Phase 1: ${TASK_TEXT}\n\n- [ ] ${TASK_TEXT}\n`);

  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init: complete speckit fixture at the implementation checkpoint"]);

  // Left uncommitted/untracked on purpose, AFTER the commit — this is the
  // ignored fixture file the disposable copy must exclude. It is never
  // touched by the Implementer.
  fs.writeFileSync(path.join(repo, "ignored.txt"), "ignored-content\n");

  seedSpecKitTasksReadyState(repo, featureDir);
  return {repo, featureDir, tasksFile: path.join(featureDir, "tasks.md")};
}

function setScenario(repo, scenario) {
  fs.writeFileSync(path.join(repo, ".autopilot-test-scenario"), scenario);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", `test scenario: ${scenario}`]);
}

function baseConfig(framework, implementationFailureBudget) {
  return {
    schema_version: "3.0",
    project: {repo: ".", planning_framework: framework, state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs"},
    roles: Object.fromEntries(["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"].map(role => [
      role, {adapter: "cursor", model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null}
    ])),
    workflow: {
      specReview: framework === "speckit", planReview: framework === "speckit", analysisAfterTasks: false, implementationReview: true, finalReview: true,
      autoApproveSpec: false, autoApprovePlan: false, parallelIndependentTasks: false, gsdPlanningReview: false,
      relaySafety: {block_git_commit_push: true, verify_read_only_by_snapshot: true, capture_touched_files: true, persist_role_sessions: true}
    },
    // No gate commands: task 15.4B1 proves the ORDINARY, non-browser
    // Verifier path only. Playwright provisioning is a separate task.
    gates: {commands: [], env_allowlist: [], require_reviewer: true, network_isolation: true},
    policy: {
      max_plan_revisions: 1, retry_delay_ms: 0, checkpoint_after_task: true, checkpoint_after_phase: true,
      require_human_commit: true, fail_closed_on_relay_violation: true,
      failure_budgets: {implementationFailureBudget, verificationFailureBudget: 1, adapterRetryBudget: 1, infrastructureRetryBudget: 1}
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
}

function writeConfig(repo, framework, implementationFailureBudget = 1) {
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), JSON.stringify(baseConfig(framework, implementationFailureBudget), null, 2));
}

// ---------------------------------------------------------------------
// Section D boundary fixture: a minimal STANDALONE-framework repository
// seeded directly at its own implementation checkpoint. It exercises the
// SAME single boolean gate GSD is also excluded by
// (`c.project?.planning_framework==="speckit"`), so this is representative
// proof that the Verifier's Windows compatibility path was not broadened
// beyond SpecKit.
// ---------------------------------------------------------------------
function makeStandaloneRepo(prefix) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `ap-win-vf-${prefix}-`));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "windows-verifier-boundary@example.invalid"]);
  git(repo, ["config", "user.name", "Windows Verifier Boundary Test"]);
  const missionDir = path.join(repo, ".autopilot", "missions", "001-standalone-boundary");
  fs.mkdirSync(missionDir, {recursive: true});
  fs.writeFileSync(path.join(missionDir, "PLAN.md"), "# Standalone Plan\n\n- [ ] Do the standalone boundary task\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init: standalone fixture"]);
  const mission = "001-standalone-boundary";
  // A real resume into `implementing` always has a baseline: production
  // captures it at `tasks_ready` before the first implementation attempt ever
  // runs, and autopilot.mjs refuses to create one from `implementing`
  // (MIGRATION_BASELINE_MISSING). This fixture seeds `implementing` directly,
  // so simulate that prior capture here — the same pattern
  // test-preflight-deduplication.mjs's seedMissionBaseline() uses: split
  // PLAN.md -> TASKS.md through the production splitter, then capture the
  // mission-scoped baseline with the production declared deliverables.
  ensureStandaloneSplit(repo, {mission});
  ensureBaseline(repo, `mission-${sanitizeKeySegment(mission)}`, {mission, declaredPaths: declaredDeliverables(repo, mission)});
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
    version: 1, phase: "implementing", step: "implement", taskIndex: 0, phaseIndex: 0, attempt: 0,
    mission
  }, null, 2));
  return repo;
}

// ---------------------------------------------------------------------
// Fake "cursor" adapter CLI: a Windows .cmd trampoline around a Node
// script — identical resolution mechanism to the sibling files
// (scripts/agent-process.mjs's resolveWindowsBinary()/winShimInvocation()).
//
// There is deliberately NO "planner"/"plan_reviewer" branch: the SpecKit
// fixtures seed state.json directly at "tasks_ready", so neither role
// should ever be invoked — if the fixture ever regressed and one WAS
// invoked, it falls through to the "unknown ROLE" branch and exits 1,
// making the mistake fail loudly rather than silently succeeding.
//
// - implementer: writes an "attempt N" value into implementation.txt (a
//   TRACKED file) and creates new-feature.txt (untracked, non-ignored).
//   N comes from an observable, persisted repository counter file, not an
//   in-process variable (each invocation is a fresh Node process).
// - code_reviewer: scenario "pass" always PASSes; scenario "cr-fail" FAILs
//   only while it observes "attempt 1", i.e. the repair loop is driven by
//   real observed repository state.
// - verifier: probes cwd/env/file-visibility/write behavior, deliberately
//   attempts to overwrite the tracked implementation file through a
//   RELATIVE path (which must land in the disposable copy only), writes a
//   scratch artifact, then returns PASS.
// ---------------------------------------------------------------------
const ADAPTER_SCRIPT = `
import fs from "node:fs";
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

function readScenario(cwdNow) {
  try { return fs.readFileSync(path.join(cwdNow, ".autopilot-test-scenario"), "utf8").trim(); }
  catch { return "pass"; }
}

if (role === "implementer") {
  const cwdNow = process.cwd();
  const counterFile = path.join(cwdNow, ".autopilot-impl-attempts");
  let attemptNum = 1;
  try { attemptNum = parseInt(fs.readFileSync(counterFile, "utf8").trim(), 10) + 1; } catch {}
  fs.writeFileSync(counterFile, String(attemptNum));
  fs.writeFileSync(path.join(cwdNow, "implementation.txt"), "attempt " + attemptNum + "\\n");
  fs.writeFileSync(path.join(cwdNow, "new-feature.txt"), "untracked-content\\n");
  console.log("implementer ok attempt=" + attemptNum);
  // TASK-19 Phase 4 (task 12): a per-task Implementer invocation must end with
  // the AUTOPILOT_TASK_RESULT sentinel (scripts/task-result-contract.mjs) as the
  // final non-empty line, or the SpecKit loop escalates with
  // STRUCTURED_OUTPUT_MISSING and this suite's Verifier path is never reached.
  console.log("AUTOPILOT_TASK_RESULT=" + JSON.stringify({summary: "implementer ok attempt=" + attemptNum, taskLocalCheck: {command: "true", status: "passed", exitCode: 0, summary: "fixture"}}));
  process.exit(0);
}

if (role === "code_reviewer") {
  const cwdAtStart = process.cwd();
  const scenario = readScenario(cwdAtStart);
  let tracked = null;
  try { tracked = fs.readFileSync("implementation.txt", "utf8"); } catch {}
  let decision = "PASS";
  if (scenario === "cr-fail") decision = tracked === "attempt 1\\n" ? "FAIL" : "PASS";
  console.log("AUTOPILOT_REVIEW=" + JSON.stringify({decision, findings: ["code_reviewer saw:" + String(tracked)]}));
  process.exit(0);
}

if (role === "verifier") {
  const cwdAtStart = process.cwd();
  const workspaceRoot = path.dirname(cwdAtStart);

  const repository = extractLine("REPOSITORY=");
  const scratchMatch = PROMPT.match(/sanctioned scratch directory: (.*?) \\(/);
  const scratchPath = scratchMatch ? scratchMatch[1] : null;

  const probe = {
    cwd: cwdAtStart,
    workspaceRoot,
    repositoryFromPrompt: repository,
    pwdEnv: process.env.PWD || null,
    initCwdEnv: process.env.INIT_CWD || null,
    safeDirectoryKeyEnv: process.env.GIT_CONFIG_KEY_1 || null,
    safeDirectoryValueEnv: process.env.GIT_CONFIG_VALUE_1 || null,
    scratchPathSeen: scratchPath
  };

  // Current working-tree state produced by the Implementer must be visible.
  try { probe.trackedContent = fs.readFileSync("implementation.txt", "utf8"); }
  catch (e) { probe.trackedContent = null; probe.trackedError = String(e.code || e.message); }
  try { probe.untrackedContent = fs.readFileSync("new-feature.txt", "utf8"); }
  catch (e) { probe.untrackedContent = null; probe.untrackedError = String(e.code || e.message); }

  // Exclusions.
  probe.ignoredExists = fs.existsSync("ignored.txt");
  probe.gitDirExists = fs.existsSync(".git");
  try { probe.topLevelEntries = fs.readdirSync(".").sort(); } catch (e) { probe.topLevelEntries = ["READDIR_FAILED:" + String(e.code || e.message)]; }

  // A brand-new relative write.
  try {
    fs.writeFileSync("verifier-relative-write.txt", "written-by-verifier");
    probe.relativeWrite = "SUCCEEDED";
  } catch (e) {
    probe.relativeWrite = "FAILED:" + (e.code || e.message);
  }

  // A relative OVERWRITE of the tracked implementation file: this must
  // affect the disposable copy only and must never reach the official
  // repository.
  try {
    fs.writeFileSync("implementation.txt", "verifier-tampered\\n");
    probe.relativeOverwrite = "SUCCEEDED";
  } catch (e) {
    probe.relativeOverwrite = "FAILED:" + (e.code || e.message);
  }

  if (scratchPath) {
    try {
      fs.writeFileSync(path.join(scratchPath, "verifier-artifact.txt"), "scratch-ok");
      probe.scratchWrite = "SUCCEEDED";
    } catch (e) {
      probe.scratchWrite = "FAILED:" + (e.code || e.message);
    }
  } else {
    probe.scratchWrite = "NO_SCRATCH_PATH_FOUND";
  }

  const probeJson = JSON.stringify(probe);
  console.log("PROBE:" + probeJson);
  console.log("AUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: [probeJson]}));
  process.exit(0);
}

console.error("fake-windows-adapter: unknown ROLE '" + role + "'");
process.exit(1);
`;

function makeBin(prefix) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), `ap-win-vf-bin-${prefix}-`));
  const scriptPath = path.join(binDir, "windows-disposable-verifier-adapter.mjs");
  fs.writeFileSync(scriptPath, ADAPTER_SCRIPT);
  const cmdPath = path.join(binDir, "cursor-agent.cmd");
  fs.writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\nexit /b %errorlevel%\r\n`);
  return binDir;
}

// ---------------------------------------------------------------------
// Mission runner: NO explicit request text is passed — this is what makes
// runImplementation() see openWork===true from the seeded phase and go
// straight into Implementation, never calling ensurePlanningReady().
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

// Run directories are named "<seq>-<role>-<idshort>" (scripts/autopilot.mjs's
// runDirFor()/nextRunSeq()) — sorting by that numeric prefix recovers the
// TRUE chronological role-invocation order across the whole mission.
function sortResultsBySeq(results) {
  return [...results].sort((a, b) => {
    const seqOf = r => parseInt(path.basename(path.dirname(r.file)).split("-")[0], 10) || 0;
    return seqOf(a) - seqOf(b);
  });
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

function listLeakedTempWorkspaces(prefix) {
  const root = os.tmpdir();
  return fs.readdirSync(root).filter(name => name.startsWith(prefix)).map(name => path.join(root, name));
}

function isInsideOfficial(candidate, officialRepoReal) {
  if (typeof candidate !== "string" || !candidate) return false;
  const resolved = path.resolve(candidate).toLowerCase();
  const official = officialRepoReal.toLowerCase();
  return resolved === official || resolved.startsWith(official + path.sep);
}

// =======================================================================
// Section A: full disposable-copy proof for the Verifier on the successful
// path, plus Section E's after-the-fact official-repository, task-marking,
// leak and completion assertions.
// =======================================================================
async function runPassScenario(binDir) {
  const {repo, tasksFile} = makeSpecKitRepo("a-pass");
  try {
    writeConfig(repo, "speckit");
    setScenario(repo, "pass");

    const headBefore = git(repo, ["rev-parse", "HEAD"]);
    const implementationBefore = fs.readFileSync(path.join(repo, "implementation.txt"), "utf8");
    const tasksBefore = fs.readFileSync(tasksFile, "utf8");

    const result = await runMission(CANONICAL_AUTOPILOT, repo, binDir, {timeoutMs: 150000});
    if (!assertCleanRun("A", result)) return;
    const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`;

    const results = sortResultsBySeq(readAllResults(repo));
    const implementerRuns = results.filter(r => r.data.role === "implementer");
    const codeReviewerRuns = results.filter(r => r.data.role === "code_reviewer");
    const verifierRuns = results.filter(r => r.data.role === "verifier");

    // --- Requirement A: seeded at the implementation checkpoint ---------
    check("A.0: no planner or plan_reviewer result was created (seeded directly at the implementation checkpoint)",
      !results.some(r => r.data.role === "planner" || r.data.role === "plan_reviewer"), results.map(r => r.data.role));

    // --- Requirement B: the Implementer wrote to the OFFICIAL repo -------
    if (!check("A.1: at least one implementer run recorded", implementerRuns.length > 0, {stdout: (result.stdout || "").slice(-2000), stderr: (result.stderr || "").slice(-2000)})) return;
    const implementationAfterMission = fs.readFileSync(path.join(repo, "implementation.txt"), "utf8");
    check("A.2: the Implementer modified the TRACKED implementation.txt in the official repository",
      implementationAfterMission !== implementationBefore && implementationAfterMission === "attempt 1\n",
      {implementationBefore, implementationAfterMission});

    // --- Requirement C/F: Code Review PASS strictly before the Verifier --
    if (!check("A.3: at least one code_reviewer run recorded", codeReviewerRuns.length > 0, results.map(r => r.data.role))) return;
    if (!check("A.4: a verifier run was recorded (the Verifier actually launched on Native Windows)", verifierRuns.length > 0, {roles: results.map(r => r.data.role), tail: combinedOutput.slice(-2500)})) return;
    const firstCR = codeReviewerRuns[0];
    const firstVerifier = verifierRuns[0];
    check("A.5a: the first Code Review returned PASS", firstCR.data.status === "completed" && firstCR.data.verdict?.decision === "PASS", firstCR.data.verdict);
    check("A.5b: no verifier run occurs before the Code Review PASS",
      results.indexOf(firstVerifier) > results.indexOf(firstCR),
      {crIndex: results.indexOf(firstCR), verifierIndices: verifierRuns.map(r => results.indexOf(r))});
    check("A.5c: ordering is implementer -> code_reviewer -> verifier",
      results.indexOf(implementerRuns[0]) < results.indexOf(firstCR) && results.indexOf(firstCR) < results.indexOf(firstVerifier),
      {implementer: results.indexOf(implementerRuns[0]), codeReviewer: results.indexOf(firstCR), verifier: results.indexOf(firstVerifier)});

    // --- Requirement D: the Verifier's own disposable-copy behavior ------
    const vf = firstVerifier.data;
    const probe = extractProbe(vf);
    if (!check("A.6: verifier probe payload recovered from findings", !!probe, vf)) return;

    const officialRepoReal = fs.realpathSync(repo);
    const cwdIsDisposable = typeof probe.cwd === "string" && probe.cwd.length > 0 && !isInsideOfficial(probe.cwd, officialRepoReal);
    check("A.7: the Verifier's real cwd is a disposable copy (not the official repository, nor anything inside it)", cwdIsDisposable, {cwd: probe.cwd, officialRepoReal});
    check("A.8a: REPOSITORY in the received prompt equals the Verifier's real cwd (the disposable copy)", probe.repositoryFromPrompt === probe.cwd, probe);
    check("A.8b: official repository path not used as PWD", probe.pwdEnv === probe.cwd, {pwdEnv: probe.pwdEnv, cwd: probe.cwd});
    check("A.8c: official repository path not used as INIT_CWD", probe.initCwdEnv === probe.cwd, {initCwdEnv: probe.initCwdEnv, cwd: probe.cwd});
    check("A.8d: Git guard safe.directory points at the disposable copy, not the official repository", probe.safeDirectoryValueEnv === probe.cwd, probe);

    check("A.9a: the Verifier sees the Implementer's CURRENT working-tree bytes of the tracked file", probe.trackedContent === "attempt 1\n", probe);
    check("A.9b: the Verifier sees the untracked, non-ignored file the Implementer created", probe.untrackedContent === "untracked-content\n", probe);
    check("A.10: the Verifier cannot see the gitignored file", probe.ignoredExists === false, probe);
    check("A.11a: the Verifier cannot see .git metadata", probe.gitDirExists === false, probe);
    check("A.11b: no top-level entry named .git exists in the disposable copy",
      Array.isArray(probe.topLevelEntries) && !probe.topLevelEntries.includes(".git"), probe.topLevelEntries);

    check("A.12a: a relative write inside the Verifier's cwd succeeded (the disposable copy is a plain writable filesystem)", probe.relativeWrite === "SUCCEEDED", probe);
    check("A.12b: a relative OVERWRITE of the tracked implementation file succeeded inside the disposable copy", probe.relativeOverwrite === "SUCCEEDED", probe);
    check("A.13a: a scratch write succeeded", probe.scratchWrite === "SUCCEEDED", probe);
    check("A.13b: the Verifier's scratch directory is not inside the official repository",
      typeof vf.scratchDir === "string" && !isInsideOfficial(vf.scratchDir, officialRepoReal), vf.scratchDir);
    check("A.13c: the Verifier's scratch directory belongs to the same disposable workspace as its cwd",
      typeof vf.scratchDir === "string" && typeof probe.workspaceRoot === "string"
        && path.resolve(vf.scratchDir).toLowerCase().startsWith(path.resolve(probe.workspaceRoot).toLowerCase() + path.sep),
      {scratchDir: vf.scratchDir, workspaceRoot: probe.workspaceRoot});

    check("A.14: a valid AUTOPILOT_REVIEW PASS was recognized for the Verifier", vf.status === "completed" && vf.verdict?.decision === "PASS", vf);

    // --- Requirement E: nothing reached the official repository ----------
    check("A.15a: the Verifier's brand-new relative write does not exist in the official repository", !fs.existsSync(path.join(repo, "verifier-relative-write.txt")));
    check("A.15b: the official implementation.txt was NOT overwritten by the Verifier (still the Implementer's bytes)",
      fs.readFileSync(path.join(repo, "implementation.txt"), "utf8") === "attempt 1\n",
      fs.readFileSync(path.join(repo, "implementation.txt"), "utf8"));
    check("A.15c: the Verifier's scratch artifact does not exist anywhere in the official repository", !fs.existsSync(path.join(repo, "verifier-artifact.txt")));
    check("A.15d: the verifier relay itself observed no official-repository mutation",
      vf.treeChanged === false && vf.readOnlyViolation === false && vf.commitDetected === false && vf.policyViolation === null,
      {treeChanged: vf.treeChanged, readOnlyViolation: vf.readOnlyViolation, commitDetected: vf.commitDetected, policyViolation: vf.policyViolation});

    // --- Requirement E: no leaked workspace ------------------------------
    check("A.16a: the Verifier's disposable scratch directory was removed afterward", typeof vf.scratchDir === "string" && !fs.existsSync(vf.scratchDir), vf.scratchDir);
    check("A.16b: the Verifier's disposable workspace root was removed afterward", typeof probe.workspaceRoot === "string" && !fs.existsSync(probe.workspaceRoot), probe.workspaceRoot);
    check("A.16c: the Verifier's own cwd (the disposable repository copy) no longer exists", !fs.existsSync(probe.cwd), probe.cwd);

    // --- Truthful metadata ------------------------------------------------
    const safety = vf.executionPlaneSafety || {};
    check("A.17a: executionPlaneSafety.mechanism truthfully reports windows-disposable-copy", safety.mechanism === "windows-disposable-copy", safety);
    check("A.17b: executionPlaneSafety.strength truthfully reports compatibility (not OS-enforced)", safety.strength === "compatibility", safety);
    check("A.17c: executionPlaneSafety.envelopeApplied is false (no bubblewrap envelope was used)", safety.envelopeApplied === false, safety);
    check("A.17d: executionPlaneSafety.officialRepositoryUsedAsCwd is false", safety.officialRepositoryUsedAsCwd === false, safety);
    check("A.17e: executionPlaneSafety.scratchRetained is false (truthful — scratch is deleted, never kept for audit)", safety.scratchRetained === false, safety);

    // --- Requirement E: the workflow continues and completes --------------
    check("A.18a: no READ_ONLY_CONTAINMENT_UNAVAILABLE anywhere in this SpecKit mission", !/READ_ONLY_CONTAINMENT_UNAVAILABLE/.test(combinedOutput), combinedOutput.slice(-1500));
    const tasksAfter = fs.readFileSync(tasksFile, "utf8");
    check("A.18b: the verified phase's task was unchecked before the mission", /- \[ \] /.test(tasksBefore), tasksBefore);
    check("A.18c: the verified phase's task is marked [x] after the Verification PASS", tasksAfter.includes(`- [x] ${TASK_TEXT}`) && !/- \[ \] /.test(tasksAfter), tasksAfter);
    check("A.18d: the mission reached successful completion (exit 0 + ALL WORK COMPLETE)",
      result.status === 0 && /ALL WORK COMPLETE/.test(combinedOutput), {status: result.status, tail: combinedOutput.slice(-1200)});
    check("A.18e: a final repository code review ran after the phase completed (the workflow genuinely continued past Verification)",
      codeReviewerRuns.length >= 2, results.map(r => r.data.role));
    check("A.19: the official repository HEAD is unchanged throughout (Autopilot never commits)", headBefore === git(repo, ["rev-parse", "HEAD"]));
  } finally {
    cleanup(repo);
  }
}

// =======================================================================
// Section B (requirement F): with a real Code Review FAIL in the middle,
// the Verifier must not launch until Code Review actually PASSes.
// =======================================================================
async function runOrderingScenario(binDir) {
  const {repo, tasksFile} = makeSpecKitRepo("b-order");
  try {
    writeConfig(repo, "speckit", 2);
    setScenario(repo, "cr-fail");

    const result = await runMission(CANONICAL_AUTOPILOT, repo, binDir, {timeoutMs: 200000});
    if (!assertCleanRun("B", result)) return;
    const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`;

    const results = sortResultsBySeq(readAllResults(repo));
    const implementerRuns = results.filter(r => r.data.role === "implementer");
    const codeReviewerRuns = results.filter(r => r.data.role === "code_reviewer");
    const verifierRuns = results.filter(r => r.data.role === "verifier");

    check("B.0: no planner or plan_reviewer result was created", !results.some(r => r.data.role === "planner" || r.data.role === "plan_reviewer"), results.map(r => r.data.role));
    if (!check("B.1: exactly two implementer attempts recorded", implementerRuns.length === 2, {roles: results.map(r => r.data.role), tail: combinedOutput.slice(-2500)})) return;
    if (!check("B.2: at least two code_reviewer runs recorded (a FAIL then a PASS)", codeReviewerRuns.length >= 2, results.map(r => r.data.role))) return;
    check("B.3: the first Code Review returned FAIL", codeReviewerRuns[0].data.verdict?.decision === "FAIL", codeReviewerRuns[0].data.verdict);
    check("B.4: the second Code Review returned PASS", codeReviewerRuns[1].data.status === "completed" && codeReviewerRuns[1].data.verdict?.decision === "PASS", codeReviewerRuns[1].data.verdict);

    if (!check("B.5: a verifier run was recorded", verifierRuns.length > 0, results.map(r => r.data.role))) return;
    const firstVerifierIndex = results.indexOf(verifierRuns[0]);
    check("B.6: NO verifier run launched before the Code Review PASS (not after the FAIL, not before either Implementer)",
      firstVerifierIndex > results.indexOf(codeReviewerRuns[1]),
      {firstVerifierIndex, failIndex: results.indexOf(codeReviewerRuns[0]), passIndex: results.indexOf(codeReviewerRuns[1])});
    check("B.7: exactly one verifier run happened for the single phase (no verification attempt was made for the failed Code Review attempt)",
      verifierRuns.length === 1, verifierRuns.map(r => results.indexOf(r)));
    check("B.8: the Verifier PASSed and the phase task was marked only afterwards",
      verifierRuns[0].data.verdict?.decision === "PASS" && fs.readFileSync(tasksFile, "utf8").includes(`- [x] ${TASK_TEXT}`),
      {verdict: verifierRuns[0].data.verdict, tasks: fs.readFileSync(tasksFile, "utf8")});
    check("B.9: the official implementation.txt reflects the final successful attempt and was never overwritten by the Verifier",
      fs.readFileSync(path.join(repo, "implementation.txt"), "utf8") === "attempt 2\n",
      fs.readFileSync(path.join(repo, "implementation.txt"), "utf8"));
    check("B.10: no verifier-relative-write.txt reached the official repository", !fs.existsSync(path.join(repo, "verifier-relative-write.txt")));
    check("B.11: the mission completed successfully after the repair loop", result.status === 0 && /ALL WORK COMPLETE/.test(combinedOutput), {status: result.status, tail: combinedOutput.slice(-1200)});
  } finally {
    cleanup(repo);
  }
}

// =======================================================================
// Section C (requirement G): negative control against a DISPOSABLE COPY of
// the whole skill tree, with ONLY the Verifier half of the integration
// disabled. Plan Reviewer and Code Reviewer keep their compatibility path
// in that copy, so the only thing that can fail is the Verifier — proving
// the Verifier's PASS in Section A comes from this integration and nothing
// else. The canonical source is never patched (SHA256 before === after).
// =======================================================================
async function runNegativeControl(binDir) {
  const canonicalHashBefore = sha256File(CANONICAL_AUTOPILOT);
  const skillCopyRoot = makeDisposableSkillCopy();
  const copiedAutopilotPath = path.join(skillCopyRoot, "scripts", "autopilot.mjs");
  const original = fs.readFileSync(copiedAutopilotPath, "utf8");
  const marker = `&& (roleName==="plan_reviewer" || roleName==="code_reviewer" || roleName==="verifier");`;
  if (!check("C.0: the Verifier integration marker is present in the disposable skill copy", original.includes(marker))) {
    cleanup(skillCopyRoot);
    return;
  }
  const disabled = original.replace(marker, `&& (roleName==="plan_reviewer" || roleName==="code_reviewer");`);
  assert.notEqual(disabled, original, "negative-control copy patch must actually change the copied file");
  fs.writeFileSync(copiedAutopilotPath, disabled);

  const {repo, tasksFile} = makeSpecKitRepo("c-negative");
  try {
    writeConfig(repo, "speckit");
    setScenario(repo, "pass");

    const result = await runMission(copiedAutopilotPath, repo, binDir, {timeoutMs: 150000});
    if (!assertCleanRun("C", result)) return;
    const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`;

    const results = sortResultsBySeq(readAllResults(repo));
    const codeReviewerRuns = results.filter(r => r.data.role === "code_reviewer");
    const verifierRuns = results.filter(r => r.data.role === "verifier");

    check("C.1: with ONLY the Verifier integration disabled, the Verifier fails with READ_ONLY_CONTAINMENT_UNAVAILABLE",
      /READ_ONLY_CONTAINMENT_UNAVAILABLE/.test(combinedOutput), {tail: combinedOutput.slice(-1500)});
    check("C.2: the failure is attributed to the verifier role", /verifier: READ_ONLY_CONTAINMENT_UNAVAILABLE/.test(combinedOutput), combinedOutput.slice(-1500));
    check("C.3: Code Reviewer still PASSed in the same run (only the Verifier half was disabled)",
      codeReviewerRuns.length > 0 && codeReviewerRuns[0].data.verdict?.decision === "PASS", codeReviewerRuns.map(r => r.data.verdict));
    check("C.4: no verifier result was ever recorded as a PASS", !verifierRuns.some(r => r.data.verdict?.decision === "PASS"), verifierRuns.map(r => r.data.verdict));
    check("C.5: the mission exited non-zero (failed closed rather than continuing)", result.status !== 0, {status: result.status});
    check("C.6: the phase task remained UNCHECKED because Verification never passed",
      /- \[ \] /.test(fs.readFileSync(tasksFile, "utf8")), fs.readFileSync(tasksFile, "utf8"));
  } finally {
    cleanup(repo, skillCopyRoot);
  }

  check("C.7: canonical scripts/autopilot.mjs is byte-for-byte unchanged (SHA256 before === after)",
    canonicalHashBefore === sha256File(CANONICAL_AUTOPILOT));
}

// =======================================================================
// Section D (requirement H): standalone missions now use the same
// disposable-copy compatibility path as SpecKit, broadened in task 15.3B
// to include both planning frameworks. Verifier behavior for standalone is
// the same as for SpecKit: disposable-copy isolation on Native Windows.
// =======================================================================
async function runStandaloneBoundaryScenario(binDir) {
  const repo = makeStandaloneRepo("d-standalone");
  try {
    writeConfig(repo, "standalone");

    const result = await runMission(CANONICAL_AUTOPILOT, repo, binDir, {timeoutMs: 130000});
    if (!assertCleanRun("D", result)) return;
    const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`;

    check("D.1: the standalone mission exits 0 via disposable-copy (same compatibility path as SpecKit)", result.status === 0, {status: result.status});
    check("D.2: disposable-copy compatibility language appears for the standalone framework",
      /disposable-copy compatibility isolation/.test(combinedOutput),
      combinedOutput.slice(-1500));

    const results = readAllResults(repo);
    check("D.3: read-only roles recorded PASS for the standalone fixture via disposable-copy",
      results.some(r => (r.data.role === "code_reviewer" || r.data.role === "verifier" || r.data.role === "plan_reviewer") && r.data.verdict?.decision === "PASS"),
      results.map(r => ({role: r.data.role, decision: r.data.verdict?.decision})));
    check("D.4: mission completed with no READ_ONLY_CONTAINMENT_UNAVAILABLE error (read-only roles used disposable-copy path)", !/READ_ONLY_CONTAINMENT_UNAVAILABLE/.test(combinedOutput), combinedOutput.slice(-1500));
  } finally {
    cleanup(repo);
  }
}

// =======================================================================
// Run everything sequentially, then verify no process-tree / temp-workspace
// leaks remain. Sequential (not concurrent) for the same measured reason
// the sibling files document: several concurrent `ap run` process trees
// behave far worse than additively under Windows real-time antivirus.
// =======================================================================
async function main() {
  const overallStart = Date.now();

  const leakPrefixes = ["ap-win-vf-a-pass-", "ap-win-vf-b-order-", "ap-win-vf-c-negative-", "ap-win-vf-d-standalone-", "ap-win-vf-bin-", "ap-win-vf-skillcopy-", "autopilot-reviewer-"];
  const preExisting = new Set(leakPrefixes.flatMap(listLeakedTempWorkspaces));

  const sharedBinDir = makeBin("shared");

  // Warmup: pay the Windows antivirus first-scan cost for a freshly created
  // executable ONCE, uncontended, outside any scenario's timeout budget.
  const warmup = await runWindowsProcessTreeBounded("cmd.exe", ["/d", "/s", "/c", path.join(sharedBinDir, "cursor-agent.cmd"), "--version"], {timeoutMs: 60000});
  check("warmup: the shared adapter binary responds to --version before any scenario starts", warmup.status === 0 && !warmup.timedOut, warmup);

  await runPassScenario(sharedBinDir);
  await runOrderingScenario(sharedBinDir);
  await runNegativeControl(sharedBinDir);
  await runStandaloneBoundaryScenario(sharedBinDir);

  cleanup(sharedBinDir);

  const leakedFixtures = leakPrefixes.flatMap(listLeakedTempWorkspaces).filter(p => !preExisting.has(p));
  check("no leftover fixture/bin/skill-copy/disposable-reviewer-workspace temp directories remain (beyond what pre-existed this run)", leakedFixtures.length === 0, leakedFixtures);

  const survivorCheck = spawnSync("powershell", ["-NoProfile", "-Command",
    `(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*windows-disposable-verifier-adapter.mjs*' -or $_.CommandLine -like '*ap-win-vf-bin-*' } | Measure-Object).Count`
  ], {encoding: "utf8"});
  const survivorCount = parseInt((survivorCheck.stdout || "0").trim(), 10) || 0;
  check("no surviving cmd.exe/node.exe descendant of this test's fake adapter remains", survivorCount === 0, {survivorCount, stderr: survivorCheck.stderr});

  const elapsedSeconds = ((Date.now() - overallStart) / 1000).toFixed(1);
  console.log(`\n(total runtime: ${elapsedSeconds}s)`);

  if (failures) {
    console.error(`\n${failures} windows disposable verifier check(s) failed.`);
    process.exit(1);
  }
  console.log("\nwindows disposable verifier PASS (A + B + C + D)");
}

await main();
