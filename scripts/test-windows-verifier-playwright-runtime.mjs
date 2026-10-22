#!/usr/bin/env node
// Task 15.4C3C behavioral proof: Native Windows compatibility bridge that
// exposes an already-discovered Playwright runtime (task 15.4C1) to the
// disposable Native Windows Verifier child (the reviewer-workspace copy a
// SpecKit Verifier already runs inside, per task 15.4B1). This is Windows
// COMPATIBILITY wiring only — Native Windows has no OS-enforced read-only
// mount the way WSL/Linux bubblewrap does (tasks 15.4C3A/C3B); this file
// never asserts otherwise.
//
// This drives the REAL production `node scripts/autopilot.mjs run --repo
// <repo>` subprocess for the full end-to-end scenarios (S1-S4), plus focused
// module-level regression coverage that calls
// resolveWindowsVerifierPlaywrightBridge() directly against real disposable
// filesystem fixtures — including real Windows junctions — for the
// containment-correction cases where a full ~150s mission run adds nothing
// a direct call against real fixtures doesn't already prove (junction
// rejection, Git metadata resolution, unresolvable-identity fail-closed).
// The module-level tests never reimplement the production containment
// algorithm themselves — they only build real directory trees / real
// junctions and inspect the function's returned decision. No real
// Playwright/Chromium is ever installed, downloaded, or executed anywhere in
// this file.
//
// Windows-only: WSL/Linux coverage for this same task lives in the sibling
// test-wsl-verifier-playwright-runtime.mjs. This whole file is a no-op SKIP
// on any other platform, checked BEFORE any fixture is created.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import {runWindowsProcessTreeBounded} from "./test-fixtures/windows-process-tree-runner.mjs";
import {resolveWindowsVerifierPlaywrightBridge} from "./windows-verifier-playwright-bridge.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRootDir = path.resolve(here, "..");
const CANONICAL_AUTOPILOT = path.join(skillRootDir, "scripts", "autopilot.mjs");

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  return false;
};

if (process.platform !== "win32") {
  console.log("SKIP: task 15.4C3C Native Windows Playwright runtime bridge coverage — not running on win32.");
  process.exit(0);
}

// ---------------------------------------------------------------------
// Small utilities (mirrors the sibling Windows test files)
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
function assertCleanRun(label, result) {
  return check(`${label}: process completed cleanly (no timeout, output overflow, or termination failure)`,
    !result.timedOut && !result.outputLimitExceeded && !result.terminationFailed,
    {timedOut: result.timedOut, outputLimitExceeded: result.outputLimitExceeded, terminationFailed: result.terminationFailed, stdoutTail: (result.stdout || "").slice(-1200), stderrTail: (result.stderr || "").slice(-1200)});
}
function isInsideOfficial(candidate, officialRepoReal) {
  if (typeof candidate !== "string" || !candidate) return false;
  const resolved = path.resolve(candidate).toLowerCase();
  const official = officialRepoReal.toLowerCase();
  return resolved === official || resolved.startsWith(official + path.sep);
}
function makeDisposableSkillCopy() {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "ap-win-pwbridge-skillcopy-"));
  fs.cpSync(path.join(skillRootDir, "scripts"), path.join(dest, "scripts"), {recursive: true});
  fs.cpSync(path.join(skillRootDir, "adapters"), path.join(dest, "adapters"), {recursive: true});
  return dest;
}

// ---------------------------------------------------------------------
// SpecKit fixture: seeded directly at the implementation-ready checkpoint
// (no Planner/Plan Reviewer involved), with a TRACKED implementation.txt.
// ---------------------------------------------------------------------
const WORKFLOW_YML = [
  "- id: specify", "  type: command", "  command: /speckit.specify",
  "- id: review-spec", "  type: gate", "  message: Review the spec",
  "- id: plan", "  type: command", "  command: /speckit.plan",
  "- id: review-plan", "  type: gate", "  message: Review the plan",
  "- id: tasks", "  type: command", "  command: /speckit.tasks",
  "- id: review-tasks", "  type: gate", "  message: Review the tasks",
  "- id: implement", "  type: command", "  command: /speckit.implement", ""
].join("\n");
const TASK_TEXT = "Do the windows verifier playwright bridge checkpoint task";
const FEATURE_SLUG = "904-win-verifier-playwright-bridge";

function seedSpecKitTasksReadyState(repo, featureDir) {
  const state = {
    version: 1, phase: "tasks_ready", step: "tasks_ready", taskIndex: 0, phaseIndex: 0, attempt: 0,
    planningIntent: {kind: "new", reason: "no prior active request"},
    planningRequest: "Use the current project request/context.",
    planningDetection: {
      framework: "speckit", status: "complete", entryIndex: 7,
      evidence: {spec: true, plan: true, tasks: true},
      taskFiles: [path.join(featureDir, "tasks.md")],
      requiresValidation: true, confidence: "high", reason: "spec, plan, and tasks artifacts detected"
    },
    sessions: {},
    planningStateReview: {status: "passed", framework: "speckit", phase: null, at: new Date().toISOString()}
  };
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(state, null, 2));
}

function makeSpecKitRepo(prefix) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `ap-win-pwbridge-${prefix}-`));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "win-pwbridge-test@example.invalid"]);
  git(repo, ["config", "user.name", "Windows Playwright Bridge Test"]);

  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  fs.writeFileSync(path.join(repo, "implementation.txt"), "not-yet-implemented\n");

  const workflowDir = path.join(repo, ".specify", "workflows", "speckit");
  fs.mkdirSync(workflowDir, {recursive: true});
  fs.writeFileSync(path.join(workflowDir, "workflow.yml"), WORKFLOW_YML);

  const featureDir = path.join(repo, "specs", FEATURE_SLUG);
  fs.mkdirSync(featureDir, {recursive: true});
  fs.writeFileSync(path.join(repo, ".specify", "feature.json"), JSON.stringify({feature_directory: `specs/${FEATURE_SLUG}`}));
  fs.writeFileSync(path.join(featureDir, "spec.md"), "# Spec\n\nWindows Playwright bridge checkpoint fixture feature.\n");
  fs.writeFileSync(path.join(featureDir, "plan.md"), "# Plan\n\nWindows Playwright bridge checkpoint fixture plan.\n");
  fs.writeFileSync(path.join(featureDir, "tasks.md"), `## Phase 1: ${TASK_TEXT}\n\n- [ ] ${TASK_TEXT}\n`);

  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init: complete speckit fixture at the implementation checkpoint"]);

  seedSpecKitTasksReadyState(repo, featureDir);
  return {repo, featureDir, tasksFile: path.join(featureDir, "tasks.md")};
}

function baseConfig() {
  return {
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
    // No gate commands anywhere in this file: this task integrates
    // environment WIRING only — no browser command is ever approved or run.
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
}
function writeConfig(repo) {
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), JSON.stringify(baseConfig(), null, 2));
}

// ---------------------------------------------------------------------
// Disposable fake Playwright fixtures. The "browser" executable is a
// placeholder text file (never executed) — only its name/type/location is
// ever inspected by discovery or by this test.
// ---------------------------------------------------------------------
function makeExternalPlaywrightModule(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ap-win-pwbridge-ext-module-${prefix}-`));
  const pkgDir = path.join(root, "playwright");
  fs.mkdirSync(pkgDir, {recursive: true});
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({name: "playwright", version: "1.2.3"}, null, 2));
  fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = {};\n");
  const marker = crypto.randomUUID();
  fs.writeFileSync(path.join(root, "AUTOPILOT_TEST_MARKER.txt"), `${marker}\n`);
  return {root, marker};
}
function makeExternalPlaywrightBrowser(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ap-win-pwbridge-ext-browser-${prefix}-`));
  const revDir = path.join(root, "chromium-9999", "chrome-win");
  fs.mkdirSync(revDir, {recursive: true});
  fs.writeFileSync(path.join(revDir, "chrome.exe"), "not a real binary\n");
  const marker = crypto.randomUUID();
  fs.writeFileSync(path.join(root, "AUTOPILOT_TEST_MARKER.txt"), `${marker}\n`);
  return {root, marker};
}
function makeRepoLocalPlaywrightModule(repo) {
  const pkgDir = path.join(repo, "node_modules", "playwright");
  fs.mkdirSync(pkgDir, {recursive: true});
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({name: "playwright", version: "1.2.3"}, null, 2));
  fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = {};\n");
  return pkgDir;
}
function makeRepoLocalPlaywrightBrowser(repo) {
  const revDir = path.join(repo, "node_modules", "playwright-core", ".local-browsers", "chromium-9999", "chrome-win");
  fs.mkdirSync(revDir, {recursive: true});
  const exePath = path.join(revDir, "chrome.exe");
  fs.writeFileSync(exePath, "not a real binary\n");
  return exePath;
}

// ---------------------------------------------------------------------
// Fake "cursor" adapter: implementer writes a tracked-file change and a
// same-process env probe file; code_reviewer PASSes unconditionally and
// reports its own env probe through AUTOPILOT_REVIEW findings; verifier
// reports its env probe, cwd, the REPOSITORY value it received, and its
// COMPLETE received prompt (base64) — then PASSes. The env probe reports
// booleans and MARKER CONTENT ONLY: it never echoes AUTOPILOT_PLAYWRIGHT_
// MODULE_ROOT / PLAYWRIGHT_BROWSERS_PATH's raw values into anything this
// test (or production) persists.
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
  console.log("fake-pw-bridge-cursor-agent 1.0.0");
  process.exit(0);
}

function readMarker(root) {
  if (!root) return null;
  try { return fs.readFileSync(path.join(root, "AUTOPILOT_TEST_MARKER.txt"), "utf8").trim(); }
  catch { return null; }
}

function envProbe() {
  const moduleRoot = process.env.AUTOPILOT_PLAYWRIGHT_MODULE_ROOT || null;
  const browserRoot = process.env.PLAYWRIGHT_BROWSERS_PATH || null;
  return {
    moduleEnvPresent: moduleRoot != null,
    browserEnvPresent: browserRoot != null,
    moduleMarkerContent: readMarker(moduleRoot),
    browserMarkerContent: readMarker(browserRoot)
  };
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
    fs.writeFileSync("implementation.txt", "attempt 1\\n");
    fs.writeFileSync(".autopilot-env-probe-implementer.json", JSON.stringify(envProbe()));
    console.log("implementer ok");
    // TASK-19 Phase 4 (task 12): the per-task Implementer invocation must end
    // with the AUTOPILOT_TASK_RESULT sentinel as its final non-empty line.
    console.log("AUTOPILOT_TASK_RESULT=" + JSON.stringify({summary: "implementer ok", taskLocalCheck: {command: "true", status: "passed", exitCode: 0, summary: "fixture"}}));
    process.exit(0);
  }

if (role === "code_reviewer") {
  const probe = envProbe();
  console.log("AUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: ["ENV_PROBE:" + JSON.stringify(probe)]}));
  process.exit(0);
}

if (role === "verifier") {
  const probe = envProbe();
  const cwdNow = process.cwd();
  const repository = extractLine("REPOSITORY=");
  const encodedPrompt = Buffer.from(PROMPT, "utf8").toString("base64");
  const findings = [
    "ENV_PROBE:" + JSON.stringify(probe),
    "VERIFIER_CWD:" + cwdNow,
    "VERIFIER_REPO_PROMPT:" + String(repository),
    "PROMPT_B64:" + encodedPrompt
  ];
  console.log("AUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings}));
  process.exit(0);
}

console.error("fake-pw-bridge-adapter: unknown ROLE '" + role + "'");
process.exit(1);
`;

function makeBin(prefix) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), `ap-win-pwbridge-bin-${prefix}-`));
  const scriptPath = path.join(binDir, "pw-bridge-adapter.mjs");
  fs.writeFileSync(scriptPath, ADAPTER_SCRIPT);
  const cmdPath = path.join(binDir, "cursor-agent.cmd");
  fs.writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\nexit /b %errorlevel%\r\n`);
  return binDir;
}

function runMission(autopilotPath, repo, binDir, {timeoutMs, extraEnv = {}}) {
    // Strip any outer mission/gate git guard (PATH shim + hooks): the
  // nested mission installs its own, and every git call through both
  // ran the mission several times slower under the orchestrator gate.
  const base = withoutOuterGitGuard({...process.env});
  const env = {...base, ...extraEnv, PATH: `${binDir};${base.PATH || ""}`};
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
function sortResultsBySeq(results) {
  return [...results].sort((a, b) => {
    const seqOf = r => parseInt(path.basename(path.dirname(r.file)).split("-")[0], 10) || 0;
    return seqOf(a) - seqOf(b);
  });
}
function findingsOf(resultData) {
  return resultData?.review?.findings || resultData?.verdict?.findings || [];
}
function extractEnvProbe(resultData) {
  for (const f of findingsOf(resultData)) {
    if (typeof f === "string" && f.startsWith("ENV_PROBE:")) {
      try { return JSON.parse(f.slice("ENV_PROBE:".length)); } catch { return null; }
    }
  }
  return null;
}
function extractFindingValue(resultData, prefix) {
  for (const f of findingsOf(resultData)) {
    if (typeof f === "string" && f.startsWith(prefix)) return f.slice(prefix.length);
  }
  return null;
}
function readImplementerProbe(repo) {
  try { return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot-env-probe-implementer.json"), "utf8")); }
  catch { return null; }
}
function isolatedHomeEnv(prefix) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `ap-win-pwbridge-home-${prefix}-`));
  return {home, env: {HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, "AppData", "Local")}};
}

// =======================================================================
// Module-level containment-correction regression coverage (junction /
// ancestor-junction / Git metadata / unresolvable-identity fail-closed).
// These call resolveWindowsVerifierPlaywrightBridge() directly against real
// disposable filesystem fixtures — real directories, a real Windows
// junction (fs.symlinkSync(..., "junction")) — never a reimplementation of
// the production containment algorithm. A full ~150s mission run adds
// nothing beyond what a direct call against real fixtures already proves
// for these specific cases; the full-mission scenarios below (S1-S4) still
// cover the end-to-end integration (role isolation, prompt/result-metadata
// isolation, disposable cleanup, ordinary repository-local rejection).
// =======================================================================
function makeJunction(target, linkPath) {
  fs.symlinkSync(target, linkPath, "junction");
}
// Removing a Windows junction MUST NOT recurse through it into its real
// target (a recursive delete of the link path would delete the real
// target's contents, since a junction is transparent to filesystem
// traversal) — a plain, non-recursive rmdir removes only the reparse point
// itself, exactly like the "rmdir" command does for a junction.
function removeJunction(linkPath) {
  if (!linkPath) return;
  try { fs.rmdirSync(linkPath); } catch { /* best-effort: already gone, or never created */ }
}
function makeBareGitRepoDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ap-win-pwbridge-unit-repo-${prefix}-`));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "win-pwbridge-unit-test@example.invalid"]);
  git(dir, ["config", "user.name", "Windows Playwright Bridge Unit Test"]);
  fs.writeFileSync(path.join(dir, "placeholder.txt"), "x\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}
// A discoverPlaywrightRuntime()-shaped object with both dimensions ready.
// The two roots passed in are used exactly as discovery itself would
// produce them (already canonical absolute directory paths) — this helper
// performs no canonicalization of its own.
function makeReadyRuntime(moduleNodeModulesDir, browserRoot) {
  return {
    readyForLaunchProbe: true,
    module: {status: "discovered", source: "repository", nodeModulesDir: moduleNodeModulesDir, dir: moduleNodeModulesDir, package: "playwright"},
    browser: {status: "discovered", source: "package-local", root: browserRoot, path: browserRoot},
    failureReason: null
  };
}

// --- Requirement A: a real repository junction cannot bypass containment -
function testRealRepositoryJunctionRejected() {
  const realRepo = makeBareGitRepoDir("a");
  const junctionParent = fs.mkdtempSync(path.join(os.tmpdir(), "ap-win-pwbridge-unit-junction-a-"));
  const junctionPath = path.join(junctionParent, "repo-link");
  const moduleDir = path.join(realRepo, "node_modules");
  const browserDir = path.join(realRepo, "browser-cache");
  fs.mkdirSync(moduleDir, {recursive: true});
  fs.mkdirSync(browserDir, {recursive: true});
  try {
    makeJunction(realRepo, junctionPath);
    const runtime = makeReadyRuntime(fs.realpathSync(moduleDir), fs.realpathSync(browserDir));
    const bridge = resolveWindowsVerifierPlaywrightBridge({
      platform: "win32", roleName: "verifier", disposableWorkspaceActive: true,
      officialRepo: junctionPath, playwrightRuntime: runtime
    });
    check("UNIT-A: a repository-local runtime reached only through a junctioned officialRepo is NOT APPLICABLE (never classified as external)",
      bridge.applicable === false && bridge.valid === false && bridge.moduleRoot === null && bridge.browserRoot === null, bridge);
  } finally {
    removeJunction(junctionPath);
    cleanup(junctionParent, realRepo);
  }
}

// --- Requirement B: a junction in an ANCESTOR path component ------------
function testAncestorJunctionRejected() {
  const realAncestor = fs.mkdtempSync(path.join(os.tmpdir(), "ap-win-pwbridge-unit-ancestor-b-"));
  const realRepo = path.join(realAncestor, "the-repo");
  fs.mkdirSync(realRepo, {recursive: true});
  git(realRepo, ["init", "-q"]);
  git(realRepo, ["config", "user.email", "win-pwbridge-unit-test@example.invalid"]);
  git(realRepo, ["config", "user.name", "Windows Playwright Bridge Unit Test"]);
  fs.writeFileSync(path.join(realRepo, "placeholder.txt"), "x\n");
  git(realRepo, ["add", "-A"]);
  git(realRepo, ["commit", "-q", "-m", "init"]);

  const junctionParent = fs.mkdtempSync(path.join(os.tmpdir(), "ap-win-pwbridge-unit-junction-b-"));
  const ancestorJunction = path.join(junctionParent, "ancestor-link");
  const moduleDir = path.join(realRepo, "node_modules");
  const browserDir = path.join(realRepo, "browser-cache");
  fs.mkdirSync(moduleDir, {recursive: true});
  fs.mkdirSync(browserDir, {recursive: true});
  try {
    makeJunction(realAncestor, ancestorJunction);
    const officialRepoViaAncestorJunction = path.join(ancestorJunction, "the-repo");
    const runtime = makeReadyRuntime(fs.realpathSync(moduleDir), fs.realpathSync(browserDir));
    const bridge = resolveWindowsVerifierPlaywrightBridge({
      platform: "win32", roleName: "verifier", disposableWorkspaceActive: true,
      officialRepo: officialRepoViaAncestorJunction, playwrightRuntime: runtime
    });
    check("UNIT-B: a junction in an ANCESTOR path component cannot bypass containment",
      bridge.applicable === false && bridge.valid === false, bridge);
  } finally {
    removeJunction(ancestorJunction);
    cleanup(junctionParent, realAncestor);
  }
}

// --- Requirement C1: a normal canonical .git directory -------------------
function testNormalGitDirRejected() {
  const repo = makeBareGitRepoDir("c1");
  const moduleDir = path.join(repo, ".git", "fake-playwright-module");
  const browserDir = path.join(repo, ".git", "fake-browser-cache");
  fs.mkdirSync(moduleDir, {recursive: true});
  fs.mkdirSync(browserDir, {recursive: true});
  try {
    const runtime = makeReadyRuntime(fs.realpathSync(moduleDir), fs.realpathSync(browserDir));
    const bridge = resolveWindowsVerifierPlaywrightBridge({
      platform: "win32", roleName: "verifier", disposableWorkspaceActive: true,
      officialRepo: repo, playwrightRuntime: runtime
    });
    check("UNIT-C1: a runtime root inside the normal canonical .git directory is NOT APPLICABLE",
      bridge.applicable === false && bridge.valid === false, bridge);
  } finally {
    cleanup(repo);
  }
}

// --- Requirement C2: a GENUINE linked worktree (created via the real       -
// `git worktree add`, not a hand-built gitfile) — its own resolveActualGit- -
// Identity() call uses real Git as the source of truth, so the fixture      -
// must be a real, structurally valid worktree or Git itself will (rightly)  -
// reject it and this test would be proving the wrong thing. The real        -
// resolved gitdir (established independently via Git itself, never by       -
// reimplementing production's containment algorithm) lives OUTSIDE the      -
// worktree's own root entirely, so this specifically proves the             -
// Git-metadata-aware resolution catches what a root-only containment check  -
// would miss.
function testLinkedWorktreeGitDirRejected() {
  const mainRepo = makeBareGitRepoDir("c2-main");
  const worktreeDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ap-win-pwbridge-unit-worktree-c2-")), "wt1");
  git(mainRepo, ["worktree", "add", "--detach", worktreeDir]);
  // Ground truth for the fixture only (never the production algorithm):
  // ask Git itself where this worktree's real gitdir lives.
  const realGitDirForWorktree = git(worktreeDir, ["rev-parse", "--absolute-git-dir"]);

  const moduleDir = path.join(realGitDirForWorktree, "fake-playwright-module");
  const browserDir = path.join(realGitDirForWorktree, "fake-browser-cache");
  fs.mkdirSync(moduleDir, {recursive: true});
  fs.mkdirSync(browserDir, {recursive: true});
  try {
    const runtime = makeReadyRuntime(fs.realpathSync(moduleDir), fs.realpathSync(browserDir));
    const bridge = resolveWindowsVerifierPlaywrightBridge({
      platform: "win32", roleName: "verifier", disposableWorkspaceActive: true,
      officialRepo: worktreeDir, playwrightRuntime: runtime
    });
    check("UNIT-C2: a runtime root inside a GENUINE linked worktree's real gitdir is NOT APPLICABLE even though it is outside the worktree's own root",
      bridge.applicable === false && bridge.valid === false, bridge);
  } finally {
    cleanup(path.dirname(worktreeDir), mainRepo);
  }
}

// --- Requirement D: an unresolvable official repository identity ---------
function testUnresolvableRepositoryIdentityFailsClosed() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ap-win-pwbridge-unit-unresolvable-d-"));
  const nonexistentRepo = path.join(parent, "does-not-exist");
  const externalModule = makeExternalPlaywrightModule("unit-d");
  const externalBrowser = makeExternalPlaywrightBrowser("unit-d");
  try {
    const runtime = makeReadyRuntime(externalModule.root, externalBrowser.root);
    const bridge = resolveWindowsVerifierPlaywrightBridge({
      platform: "win32", roleName: "verifier", disposableWorkspaceActive: true,
      officialRepo: nonexistentRepo, playwrightRuntime: runtime
    });
    check("UNIT-D: an unresolvable official repository identity fails CLOSED (applicable, invalid) rather than being classified as external",
      bridge.applicable === true && bridge.valid === false
        && typeof bridge.invalidReason === "string" && bridge.invalidReason.length > 0, bridge);
  } finally {
    cleanup(parent, externalModule.root, externalBrowser.root);
  }
}

// --- Requirement E (module-level sanity): genuine external runtime -------
function testGenuineExternalRuntimeStillBridged() {
  const repo = makeBareGitRepoDir("e");
  const externalModule = makeExternalPlaywrightModule("unit-e");
  const externalBrowser = makeExternalPlaywrightBrowser("unit-e");
  try {
    const runtime = makeReadyRuntime(externalModule.root, externalBrowser.root);
    const bridge = resolveWindowsVerifierPlaywrightBridge({
      platform: "win32", roleName: "verifier", disposableWorkspaceActive: true,
      officialRepo: repo, playwrightRuntime: runtime
    });
    check("UNIT-E: a genuinely external, valid runtime is still bridged (applicable and valid) after the containment fix",
      bridge.applicable === true && bridge.valid === true
        && bridge.moduleRoot === fs.realpathSync(externalModule.root)
        && bridge.browserRoot === fs.realpathSync(externalBrowser.root), bridge);
  } finally {
    cleanup(repo, externalModule.root, externalBrowser.root);
  }
}

// =======================================================================
// FINAL CORRECTION: officialRepo may be a NESTED subdirectory inside a
// larger Git working tree. resolveActualGitIdentity() must resolve the
// ACTUAL enclosing worktree root and Git metadata directories via Git
// itself (not a local "<officialRepo>\.git" existence check), so a runtime
// planted anywhere in the enclosing worktree or its real Git directory is
// still rejected as repository-local — never bridged.
// =======================================================================

// --- Final-correction A: exact reproduction — runtime inside the         -
// enclosing repository's REAL .git directory, officialRepo nested one     -
// level below the actual worktree root.                                  -
function testNestedRepositoryGitDirRejected() {
  const enclosingRepo = makeBareGitRepoDir("nested-a");
  const nestedOfficialRepo = path.join(enclosingRepo, "project");
  fs.mkdirSync(nestedOfficialRepo, {recursive: true});
  const moduleDir = path.join(enclosingRepo, ".git", "pw-node_modules");
  const browserDir = path.join(enclosingRepo, ".git", "pw-browser");
  fs.mkdirSync(moduleDir, {recursive: true});
  fs.mkdirSync(browserDir, {recursive: true});
  try {
    const runtime = makeReadyRuntime(fs.realpathSync(moduleDir), fs.realpathSync(browserDir));
    const bridge = resolveWindowsVerifierPlaywrightBridge({
      platform: "win32", roleName: "verifier", disposableWorkspaceActive: true,
      officialRepo: nestedOfficialRepo, playwrightRuntime: runtime
    });
    check("FINAL-A: a runtime inside the enclosing worktree's REAL .git directory is NOT bridged, even though officialRepo is a nested subdirectory with no local .git of its own",
      bridge.applicable === false && bridge.valid === false
        && bridge.moduleRoot === null && bridge.browserRoot === null, bridge);
  } finally {
    cleanup(enclosingRepo);
  }
}

// --- Final-correction B: runtime elsewhere in the enclosing working tree -
// (outside .git, outside the nested officialRepo directory).
function testEnclosingWorktreeContentRejected() {
  const enclosingRepo = makeBareGitRepoDir("nested-b");
  const nestedOfficialRepo = path.join(enclosingRepo, "project");
  fs.mkdirSync(nestedOfficialRepo, {recursive: true});
  const moduleDir = path.join(enclosingRepo, "sibling-tooling", "node_modules");
  const browserDir = path.join(enclosingRepo, "sibling-tooling", "browser-cache");
  fs.mkdirSync(moduleDir, {recursive: true});
  fs.mkdirSync(browserDir, {recursive: true});
  try {
    const runtime = makeReadyRuntime(fs.realpathSync(moduleDir), fs.realpathSync(browserDir));
    const bridge = resolveWindowsVerifierPlaywrightBridge({
      platform: "win32", roleName: "verifier", disposableWorkspaceActive: true,
      officialRepo: nestedOfficialRepo, playwrightRuntime: runtime
    });
    check("FINAL-B: a runtime elsewhere in the enclosing working tree (outside the nested officialRepo, outside .git) is still rejected as repository-local",
      bridge.applicable === false && bridge.valid === false, bridge);
  } finally {
    cleanup(enclosingRepo);
  }
}

// --- Final-correction C (module-level positive control): nested           -
// officialRepo, but the runtime is genuinely outside the WHOLE enclosing   -
// worktree and its Git directory.                                         -
function testNestedRepositoryGenuineExternalRuntimePreserved() {
  const enclosingRepo = makeBareGitRepoDir("nested-c");
  const nestedOfficialRepo = path.join(enclosingRepo, "project");
  fs.mkdirSync(nestedOfficialRepo, {recursive: true});
  const externalModule = makeExternalPlaywrightModule("unit-nested-c");
  const externalBrowser = makeExternalPlaywrightBrowser("unit-nested-c");
  try {
    const runtime = makeReadyRuntime(externalModule.root, externalBrowser.root);
    const bridge = resolveWindowsVerifierPlaywrightBridge({
      platform: "win32", roleName: "verifier", disposableWorkspaceActive: true,
      officialRepo: nestedOfficialRepo, playwrightRuntime: runtime
    });
    check("FINAL-C: a nested officialRepo with a genuinely external runtime (outside the whole enclosing worktree and its Git directory) is still bridged",
      bridge.applicable === true && bridge.valid === true
        && bridge.moduleRoot === fs.realpathSync(externalModule.root)
        && bridge.browserRoot === fs.realpathSync(externalBrowser.root), bridge);
  } finally {
    cleanup(enclosingRepo, externalModule.root, externalBrowser.root);
  }
}

// =======================================================================
// FINAL CORRECTION requirement F: Git identity failure modes must all fail
// the whole bridge attempt closed. The "non-Git directory" and "spawn
// error" cases are exercised against REAL, deterministic conditions (a
// plain non-Git directory; a PATH with no resolvable "git" at all) — no
// fake binary needed. "Timeout" and "malformed/oversized/unresolved
// output" require a controlled process-boundary fixture: git.exe cannot be
// shadowed by a .cmd/.bat shim under Node's non-shell Windows spawn (no
// PATHEXT search is performed), so the fixture below copies the CURRENT
// node.exe to "<fakeDir>\git.exe" (a genuine, directly executable binary)
// and controls its behavior via NODE_OPTIONS="--require <script>" —
// `--require` is one of the flags Node honors from NODE_OPTIONS, and the
// required script runs synchronously during bootstrap, before Node ever
// reaches argv-driven "main module" processing (which would otherwise
// crash quickly on this fake binary's real-git-style argv). PATH and
// NODE_OPTIONS are restored immediately after each call.
// =======================================================================
function makeFakeGitProbeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-win-pwbridge-unit-fakegit-"));
  fs.copyFileSync(process.execPath, path.join(dir, "git.exe"));
  // Exactly 4 non-empty lines where 3 are expected — malformed output.
  fs.writeFileSync(path.join(dir, "garbage-line-count.cjs"),
    'require("fs").writeSync(1, "line1\\nline2\\nline3\\nline4\\n"); process.exit(0);\n');
  // Exactly 3 lines, but the last one is far longer than any real absolute
  // path could plausibly be — oversized/malformed output.
  fs.writeFileSync(path.join(dir, "oversized-line.cjs"),
    'const long = "x".repeat(8000); require("fs").writeSync(1, "C:\\\\a\\nC:\\\\b\\n" + long + "\\n"); process.exit(0);\n');
  // Exactly 3 lines, well-formed, but naming directories that do not exist
  // — unresolved returned directory.
  fs.writeFileSync(path.join(dir, "unresolved-dirs.cjs"),
    'require("fs").writeSync(1, "C:\\\\ap-win-pwbridge-does-not-exist-1\\nC:\\\\ap-win-pwbridge-does-not-exist-2\\nC:\\\\ap-win-pwbridge-does-not-exist-3\\n"); process.exit(0);\n');
  // Synchronous busy-loop: blocks Node's bootstrap here forever, before it
  // ever reaches argv/main-module processing — the parent's `timeout` kills
  // it with a signal.
  fs.writeFileSync(path.join(dir, "hang.cjs"), "while (true) { /* spin */ }\n");
  return dir;
}
function withFakeGitBehavior(fakeGitDir, scriptName, fn) {
  const originalPath = process.env.PATH;
  const originalNodeOptions = process.env.NODE_OPTIONS;
  process.env.PATH = fakeGitDir;
  process.env.NODE_OPTIONS = `--require ${path.join(fakeGitDir, scriptName)}`;
  try {
    return fn();
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = originalNodeOptions;
  }
}

function testNonGitDirectoryFailsClosed() {
  const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-win-pwbridge-unit-nongit-f-"));
  const externalModule = makeExternalPlaywrightModule("unit-f-nongit");
  const externalBrowser = makeExternalPlaywrightBrowser("unit-f-nongit");
  try {
    const runtime = makeReadyRuntime(externalModule.root, externalBrowser.root);
    const bridge = resolveWindowsVerifierPlaywrightBridge({
      platform: "win32", roleName: "verifier", disposableWorkspaceActive: true,
      officialRepo: plainDir, playwrightRuntime: runtime
    });
    check("FINAL-F1: a plain, real, non-Git directory (real \"git rev-parse\" exits nonzero) fails CLOSED rather than being treated as \"nothing to protect\"",
      bridge.applicable === true && bridge.valid === false
        && typeof bridge.invalidReason === "string" && bridge.invalidReason.length > 0, bridge);
  } finally {
    cleanup(plainDir, externalModule.root, externalBrowser.root);
  }
}

function testGitUnavailableFailsClosed() {
  const repo = makeBareGitRepoDir("f-unavailable");
  const emptyPathDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-win-pwbridge-unit-nogit-path-f-"));
  const externalModule = makeExternalPlaywrightModule("unit-f-unavailable");
  const externalBrowser = makeExternalPlaywrightBrowser("unit-f-unavailable");
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = emptyPathDir; // no "git" resolvable anywhere -> spawn ENOENT
    const runtime = makeReadyRuntime(externalModule.root, externalBrowser.root);
    const bridge = resolveWindowsVerifierPlaywrightBridge({
      platform: "win32", roleName: "verifier", disposableWorkspaceActive: true,
      officialRepo: repo, playwrightRuntime: runtime
    });
    check("FINAL-F2: Git being unavailable (spawn ENOENT) fails CLOSED, never launches with a partial environment",
      bridge.applicable === true && bridge.valid === false, bridge);
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    cleanup(repo, emptyPathDir, externalModule.root, externalBrowser.root);
  }
}

function testGitProbeTimeoutFailsClosed(fakeGitDir) {
  const repo = makeBareGitRepoDir("f-timeout");
  const externalModule = makeExternalPlaywrightModule("unit-f-timeout");
  const externalBrowser = makeExternalPlaywrightBrowser("unit-f-timeout");
  try {
    const runtime = makeReadyRuntime(externalModule.root, externalBrowser.root);
    const bridge = withFakeGitBehavior(fakeGitDir, "hang.cjs", () => resolveWindowsVerifierPlaywrightBridge({
      platform: "win32", roleName: "verifier", disposableWorkspaceActive: true,
      officialRepo: repo, playwrightRuntime: runtime
    }));
    check("FINAL-F3: a Git probe that hangs past its hard deadline is killed and fails CLOSED (never launches with a partial environment)",
      bridge.applicable === true && bridge.valid === false, bridge);
  } finally {
    cleanup(repo, externalModule.root, externalBrowser.root);
  }
}

function testGitProbeMalformedOutputFailsClosed(fakeGitDir) {
  const repo = makeBareGitRepoDir("f-malformed");
  const externalModule = makeExternalPlaywrightModule("unit-f-malformed");
  const externalBrowser = makeExternalPlaywrightBrowser("unit-f-malformed");
  try {
    const runtime = makeReadyRuntime(externalModule.root, externalBrowser.root);
    const bridge = withFakeGitBehavior(fakeGitDir, "garbage-line-count.cjs", () => resolveWindowsVerifierPlaywrightBridge({
      platform: "win32", roleName: "verifier", disposableWorkspaceActive: true,
      officialRepo: repo, playwrightRuntime: runtime
    }));
    check("FINAL-F4: a malformed Git probe response (wrong line count) fails CLOSED",
      bridge.applicable === true && bridge.valid === false, bridge);
  } finally {
    cleanup(repo, externalModule.root, externalBrowser.root);
  }
}

function testGitProbeOversizedLineFailsClosed(fakeGitDir) {
  const repo = makeBareGitRepoDir("f-oversized");
  const externalModule = makeExternalPlaywrightModule("unit-f-oversized");
  const externalBrowser = makeExternalPlaywrightBrowser("unit-f-oversized");
  try {
    const runtime = makeReadyRuntime(externalModule.root, externalBrowser.root);
    const bridge = withFakeGitBehavior(fakeGitDir, "oversized-line.cjs", () => resolveWindowsVerifierPlaywrightBridge({
      platform: "win32", roleName: "verifier", disposableWorkspaceActive: true,
      officialRepo: repo, playwrightRuntime: runtime
    }));
    check("FINAL-F5: an oversized/malformed single-line Git probe response fails CLOSED",
      bridge.applicable === true && bridge.valid === false, bridge);
  } finally {
    cleanup(repo, externalModule.root, externalBrowser.root);
  }
}

function testGitProbeUnresolvedDirectoryFailsClosed(fakeGitDir) {
  const repo = makeBareGitRepoDir("f-unresolved");
  const externalModule = makeExternalPlaywrightModule("unit-f-unresolved");
  const externalBrowser = makeExternalPlaywrightBrowser("unit-f-unresolved");
  try {
    const runtime = makeReadyRuntime(externalModule.root, externalBrowser.root);
    const bridge = withFakeGitBehavior(fakeGitDir, "unresolved-dirs.cjs", () => resolveWindowsVerifierPlaywrightBridge({
      platform: "win32", roleName: "verifier", disposableWorkspaceActive: true,
      officialRepo: repo, playwrightRuntime: runtime
    }));
    check("FINAL-F6: a well-formed but unresolvable (nonexistent) Git probe response fails CLOSED",
      bridge.applicable === true && bridge.valid === false, bridge);
  } finally {
    cleanup(repo, externalModule.root, externalBrowser.root);
  }
}

function runBridgeUnitTests() {
  testRealRepositoryJunctionRejected();
  testAncestorJunctionRejected();
  testNormalGitDirRejected();
  testLinkedWorktreeGitDirRejected();
  testUnresolvableRepositoryIdentityFailsClosed();
  testGenuineExternalRuntimeStillBridged();

  testNestedRepositoryGitDirRejected();
  testEnclosingWorktreeContentRejected();
  testNestedRepositoryGenuineExternalRuntimePreserved();

  testNonGitDirectoryFailsClosed();
  testGitUnavailableFailsClosed();
  const fakeGitDir = makeFakeGitProbeDir();
  try {
    testGitProbeTimeoutFailsClosed(fakeGitDir);
    testGitProbeMalformedOutputFailsClosed(fakeGitDir);
    testGitProbeOversizedLineFailsClosed(fakeGitDir);
    testGitProbeUnresolvedDirectoryFailsClosed(fakeGitDir);
  } finally {
    cleanup(fakeGitDir);
  }
}

// =======================================================================
// Scenario 1: external runtime bridge + official repository isolation +
// role isolation (requirements 1, 2, 3).
// =======================================================================
async function runExternalBridgeScenario(binDir) {
  const {repo} = makeSpecKitRepo("s1");
  const {home: isolatedHome, env: isolatedEnv} = isolatedHomeEnv("s1");
  const externalModule = makeExternalPlaywrightModule("s1");
  const externalBrowser = makeExternalPlaywrightBrowser("s1");
  try {
    writeConfig(repo);
    const officialRepoReal = fs.realpathSync(repo);
    const headBefore = git(repo, ["rev-parse", "HEAD"]);
    const moduleJsonBefore = fs.readFileSync(path.join(externalModule.root, "playwright", "package.json"), "utf8");
    const browserExeBefore = fs.readFileSync(path.join(externalBrowser.root, "chromium-9999", "chrome-win", "chrome.exe"), "utf8");

    const extraEnv = {...isolatedEnv, PLAYWRIGHT_MODULE_DIR: externalModule.root, PLAYWRIGHT_BROWSERS_PATH: externalBrowser.root};
    const result = await runMission(CANONICAL_AUTOPILOT, repo, binDir, {timeoutMs: 150000, extraEnv});
    if (!assertCleanRun("S1", result)) return;
    const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`;

    const results = sortResultsBySeq(readAllResults(repo));
    const implementerRuns = results.filter(r => r.data.role === "implementer");
    const codeReviewerRuns = results.filter(r => r.data.role === "code_reviewer");
    const verifierRuns = results.filter(r => r.data.role === "verifier");

    check("S1.0: no planner/plan_reviewer launched (seeded past planning)",
      !results.some(r => r.data.role === "planner" || r.data.role === "plan_reviewer"), results.map(r => r.data.role));
    if (!check("S1.1: implementer ran", implementerRuns.length > 0, combinedOutput.slice(-2000))) return;
    if (!check("S1.2: code_reviewer ran and PASSed before the Verifier", codeReviewerRuns.length > 0 && codeReviewerRuns[0].data.verdict?.decision === "PASS", codeReviewerRuns[0]?.data)) return;
    if (!check("S1.3: verifier ran", verifierRuns.length > 0, {roles: results.map(r => r.data.role), tail: combinedOutput.slice(-2500)})) return;
    check("S1.3b: Verifier ran only after Code Review PASS",
      results.indexOf(verifierRuns[0]) > results.indexOf(codeReviewerRuns[0]), {});

    // --- Role isolation (requirement 3) ----------------------------------
    const implProbe = readImplementerProbe(repo);
    check("S1.4: Implementer received NEITHER Playwright environment variable",
      !!implProbe && implProbe.moduleEnvPresent === false && implProbe.browserEnvPresent === false, implProbe);
    const crProbe = extractEnvProbe(codeReviewerRuns[0].data);
    check("S1.5: Code Reviewer received NEITHER Playwright environment variable",
      !!crProbe && crProbe.moduleEnvPresent === false && crProbe.browserEnvPresent === false, crProbe);

    // --- External runtime bridge (requirement 1) -------------------------
    const vf = verifierRuns[0].data;
    const vfProbe = extractEnvProbe(vf);
    check("S1.6: AUTOPILOT_PLAYWRIGHT_MODULE_ROOT is present on the Verifier and resolves to the external module root, proven by unique marker content (never by comparing raw paths)",
      !!vfProbe && vfProbe.moduleEnvPresent === true && vfProbe.moduleMarkerContent === externalModule.marker,
      {vfProbe, expectedModuleMarker: externalModule.marker});
    check("S1.7: PLAYWRIGHT_BROWSERS_PATH is present on the Verifier and resolves to the external browser cache, proven by unique marker content",
      !!vfProbe && vfProbe.browserEnvPresent === true && vfProbe.browserMarkerContent === externalBrowser.marker,
      {vfProbe, expectedBrowserMarker: externalBrowser.marker});
    check("S1.8: the Verifier still completed with a PASS", vf.status === "completed" && vf.verdict?.decision === "PASS", vf);

    // --- Official repository isolation (requirement 2) -------------------
    const verifierCwd = extractFindingValue(vf, "VERIFIER_CWD:");
    check("S1.9: the Verifier's cwd is the disposable copy, never the official repository",
      typeof verifierCwd === "string" && verifierCwd.length > 0 && !isInsideOfficial(verifierCwd, officialRepoReal),
      {verifierCwd, officialRepoReal});
    const repoPromptValue = extractFindingValue(vf, "VERIFIER_REPO_PROMPT:");
    check("S1.10: REPOSITORY in the received prompt equals the disposable copy cwd",
      repoPromptValue === verifierCwd, {repoPromptValue, verifierCwd});
    const promptB64 = extractFindingValue(vf, "PROMPT_B64:");
    const promptText = promptB64 ? Buffer.from(promptB64, "base64").toString("utf8") : "";
    check("S1.11: the official repository path is absent from the Verifier prompt",
      promptText.length > 0 && !promptText.includes(officialRepoReal), {officialRepoReal, promptTail: promptText.slice(0, 600)});
    const resultJsonText = JSON.stringify(vf);
    check("S1.12: the official repository path is absent from Autopilot-created result metadata",
      !resultJsonText.includes(officialRepoReal), {});
    check("S1.13: the external module root's raw absolute path never appears in result metadata or the prompt",
      !resultJsonText.includes(externalModule.root) && !promptText.includes(externalModule.root), {});
    check("S1.14: the external browser root's raw absolute path never appears in result metadata or the prompt",
      !resultJsonText.includes(externalBrowser.root) && !promptText.includes(externalBrowser.root), {});
    check("S1.15: the official repository HEAD is unchanged (Autopilot never commits)",
      git(repo, ["rev-parse", "HEAD"]) === headBefore, {});
    check("S1.16: no verifier-authored relative write reached the official repository",
      !fs.existsSync(path.join(repo, "verifier-relative-write.txt")), {});

    // --- Disposable cleanup + honest metadata -----------------------------
    check("S1.17: the disposable workspace was cleaned up (Verifier cwd no longer exists)",
      typeof verifierCwd === "string" && !fs.existsSync(verifierCwd), verifierCwd);
    const safety = vf.executionPlaneSafety || {};
    check("S1.18: executionPlaneSafety truthfully reports Windows compatibility, not OS-enforced strength",
      safety.strength === "compatibility" && safety.mechanism === "windows-disposable-copy", safety);

    // --- No execution/provisioning (requirements 7, 8) --------------------
    check("S1.19: the external module package.json was never modified (read-only discovery/bridge)",
      fs.readFileSync(path.join(externalModule.root, "playwright", "package.json"), "utf8") === moduleJsonBefore, {});
    check("S1.20: the placeholder browser executable was never modified or executed",
      fs.readFileSync(path.join(externalBrowser.root, "chromium-9999", "chrome-win", "chrome.exe"), "utf8") === browserExeBefore, {});
    check("S1.21: no npm/npx install or Chromium download was ever invoked",
      !/npm install|npx playwright install|Downloading Chromium/i.test(combinedOutput), combinedOutput.slice(-800));
  } finally {
    cleanup(repo, isolatedHome, externalModule.root, externalBrowser.root);
  }
}

// =======================================================================
// Scenario 2: repository-local runtime rejection (requirement 4).
// =======================================================================
async function runRepoLocalRejectionScenario(binDir) {
  const {repo} = makeSpecKitRepo("s2");
  const {home: isolatedHome, env: isolatedEnv} = isolatedHomeEnv("s2");
  try {
    writeConfig(repo);
    const headBefore = git(repo, ["rev-parse", "HEAD"]);
    const modulePkgDir = makeRepoLocalPlaywrightModule(repo);
    makeRepoLocalPlaywrightBrowser(repo);
    const moduleJsonBefore = fs.readFileSync(path.join(modulePkgDir, "package.json"), "utf8");

    const result = await runMission(CANONICAL_AUTOPILOT, repo, binDir, {timeoutMs: 150000, extraEnv: isolatedEnv});
    if (!assertCleanRun("S2", result)) return;

    const results = sortResultsBySeq(readAllResults(repo));
    const verifierRuns = results.filter(r => r.data.role === "verifier");
    if (!check("S2.0: verifier ran", verifierRuns.length > 0, results.map(r => r.data.role))) return;
    const vf = verifierRuns[0].data;
    const vfProbe = extractEnvProbe(vf);

    check("S2.1: the repository-local module path is NOT passed to the Verifier",
      !!vfProbe && vfProbe.moduleEnvPresent === false, vfProbe);
    check("S2.2: the repository-local browser root is NOT passed to the Verifier",
      !!vfProbe && vfProbe.browserEnvPresent === false, vfProbe);

    const verifierCwd = extractFindingValue(vf, "VERIFIER_CWD:");
    check("S2.3: no node_modules directory or link exists inside the disposable copy (no junction/symlink was created)",
      typeof verifierCwd === "string" && !fs.existsSync(path.join(verifierCwd, "node_modules")), verifierCwd);
    check("S2.4: the Verifier still performs non-browser verification and PASSes",
      vf.status === "completed" && vf.verdict?.decision === "PASS", vf);
    check("S2.5: the official repository HEAD is unchanged", git(repo, ["rev-parse", "HEAD"]) === headBefore, {});
    check("S2.6: the repository-local module was never modified by discovery/bridge validation",
      fs.readFileSync(path.join(modulePkgDir, "package.json"), "utf8") === moduleJsonBefore, {});
  } finally {
    cleanup(repo, isolatedHome);
  }
}

// =======================================================================
// Scenario 3: unavailable runtime remains optional (requirement 5).
// =======================================================================
async function runUnavailableRuntimeScenario(binDir) {
  const {repo} = makeSpecKitRepo("s3");
  const {home: isolatedHome, env: isolatedEnv} = isolatedHomeEnv("s3");
  try {
    writeConfig(repo);
    const result = await runMission(CANONICAL_AUTOPILOT, repo, binDir, {timeoutMs: 150000, extraEnv: isolatedEnv});
    if (!assertCleanRun("S3", result)) return;

    const results = sortResultsBySeq(readAllResults(repo));
    const verifierRuns = results.filter(r => r.data.role === "verifier");
    if (!check("S3.0: verifier ran", verifierRuns.length > 0, results.map(r => r.data.role))) return;
    const vf = verifierRuns[0].data;
    const vfProbe = extractEnvProbe(vf);
    check("S3.1: no Playwright module environment variable is present (nothing was discovered)",
      !!vfProbe && vfProbe.moduleEnvPresent === false, vfProbe);
    check("S3.2: no Playwright browser environment variable is present (nothing was discovered)",
      !!vfProbe && vfProbe.browserEnvPresent === false, vfProbe);
    check("S3.3: non-browser verification still completes with a PASS",
      vf.status === "completed" && vf.verdict?.decision === "PASS", vf);
  } finally {
    cleanup(repo, isolatedHome);
  }
}

// =======================================================================
// Scenario 4: an eligible external runtime that becomes invalid immediately
// before launch must fail closed (requirement 6). This requires a
// synthetic seam: a disposable COPY of the skill tree with one narrow,
// env-var-gated deletion hook inserted right after the point where
// production computes the bridge decision — never a change to canonical
// source (proven by SHA256 before/after).
// =======================================================================
async function runInvalidExternalRuntimeScenario(binDir) {
  const canonicalHashBefore = sha256File(CANONICAL_AUTOPILOT);
  const skillCopyRoot = makeDisposableSkillCopy();
  const copiedAutopilotPath = path.join(skillCopyRoot, "scripts", "autopilot.mjs");
  const original = fs.readFileSync(copiedAutopilotPath, "utf8");
  const anchor = 'const windowsVerifierPlaywrightBridge=resolveWindowsVerifierPlaywrightBridge({';
  if (!check("S4.0: the bridge-computation anchor is present in the disposable skill copy", original.includes(anchor))) {
    cleanup(skillCopyRoot);
    return;
  }
  // Narrow, clearly isolated, test-only seam: a no-op unless a test sets
  // AUTOPILOT_TEST_INVALIDATE_PLAYWRIGHT_DIR, which production never does.
  // It deletes the external module directory strictly AFTER discovery has
  // already marked the runtime ready, and strictly BEFORE the bridge
  // re-validates and decides whether to launch — reproducing "the runtime
  // became invalid between discovery and launch" deterministically.
  const hook = [
    'if(process.env.AUTOPILOT_TEST_INVALIDATE_PLAYWRIGHT_DIR && roleName==="verifier" && playwrightRuntimeForVerifier?.readyForLaunchProbe===true){',
    '  try{ fs.rmSync(process.env.AUTOPILOT_TEST_INVALIDATE_PLAYWRIGHT_DIR,{recursive:true,force:true}); }catch{}',
    '}',
    anchor
  ].join("\n");
  const patched = original.replace(anchor, hook);
  assert.notEqual(patched, original, "invalid-runtime test-only hook must actually change the copied file");
  fs.writeFileSync(copiedAutopilotPath, patched);

  const {repo} = makeSpecKitRepo("s4");
  const {home: isolatedHome, env: isolatedEnv} = isolatedHomeEnv("s4");
  const externalModule = makeExternalPlaywrightModule("s4");
  const externalBrowser = makeExternalPlaywrightBrowser("s4");
  try {
    writeConfig(repo);
    const headBefore = git(repo, ["rev-parse", "HEAD"]);
    const extraEnv = {
      ...isolatedEnv,
      PLAYWRIGHT_MODULE_DIR: externalModule.root,
      PLAYWRIGHT_BROWSERS_PATH: externalBrowser.root,
      AUTOPILOT_TEST_INVALIDATE_PLAYWRIGHT_DIR: externalModule.root
    };
    const result = await runMission(copiedAutopilotPath, repo, binDir, {timeoutMs: 150000, extraEnv});
    const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`;

    check("S4.1: the mission exits nonzero (fails closed rather than launching with a partial environment)",
      !result.timedOut && result.status !== 0, {status: result.status, timedOut: result.timedOut, tail: combinedOutput.slice(-1500)});
    check("S4.2: playwright_runtime_invalid is surfaced as a controlled error",
      /playwright_runtime_invalid/i.test(combinedOutput), combinedOutput.slice(-1500));
    check("S4.3: the failure is attributed to the verifier role",
      /verifier: playwright_runtime_invalid/i.test(combinedOutput), combinedOutput.slice(-1500));

    const results = sortResultsBySeq(readAllResults(repo));
    const verifierRuns = results.filter(r => r.data.role === "verifier");
    check("S4.4: the Verifier was never launched with a partial runtime environment (no verifier run was ever recorded)",
      verifierRuns.length === 0, verifierRuns.map(r => r.data));
    check("S4.5: no repository-local fallback occurred (no node_modules directory exists under the official repository)",
      !fs.existsSync(path.join(repo, "node_modules")), {});
    check("S4.6: the official repository HEAD is unchanged", git(repo, ["rev-parse", "HEAD"]) === headBefore, {});
  } finally {
    cleanup(repo, isolatedHome, externalModule.root, externalBrowser.root);
  }

  check("S4.7: canonical scripts/autopilot.mjs is byte-for-byte unchanged (SHA256 before === after)",
    canonicalHashBefore === sha256File(CANONICAL_AUTOPILOT), {});
  cleanup(skillCopyRoot);
}

// =======================================================================
async function main() {
  const overallStart = Date.now();
  const leakPrefixes = [
    "ap-win-pwbridge-s1-", "ap-win-pwbridge-s2-", "ap-win-pwbridge-s3-", "ap-win-pwbridge-s4-",
    "ap-win-pwbridge-ext-module-", "ap-win-pwbridge-ext-browser-", "ap-win-pwbridge-home-",
    "ap-win-pwbridge-bin-", "ap-win-pwbridge-skillcopy-", "ap-win-pwbridge-unit-", "autopilot-reviewer-"
  ];
  const preExisting = new Set(leakPrefixes.flatMap(p => {
    try { return fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(p)).map(n => path.join(os.tmpdir(), n)); }
    catch { return []; }
  }));

  runBridgeUnitTests();

  const binDir = makeBin("shared");
  const warmup = await runWindowsProcessTreeBounded("cmd.exe", ["/d", "/s", "/c", path.join(binDir, "cursor-agent.cmd"), "--version"], {timeoutMs: 60000});
  check("warmup: the shared adapter binary responds to --version before any scenario starts", warmup.status === 0 && !warmup.timedOut, warmup);

  await runExternalBridgeScenario(binDir);
  await runRepoLocalRejectionScenario(binDir);
  await runUnavailableRuntimeScenario(binDir);
  await runInvalidExternalRuntimeScenario(binDir);

  cleanup(binDir);
  const leakedFixtures = leakPrefixes.flatMap(p => {
    try { return fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(p)).map(n => path.join(os.tmpdir(), n)); }
    catch { return []; }
  }).filter(p => !preExisting.has(p));
  check("no leftover fixture/bin/skill-copy/disposable-reviewer-workspace temp directories remain (beyond what pre-existed this run)", leakedFixtures.length === 0, leakedFixtures);

  const survivorCheck = spawnSync("powershell", ["-NoProfile", "-Command",
    `(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*pw-bridge-adapter.mjs*' -or $_.CommandLine -like '*ap-win-pwbridge-bin-*' } | Measure-Object).Count`
  ], {encoding: "utf8"});
  const survivorCount = parseInt((survivorCheck.stdout || "0").trim(), 10) || 0;
  check("no surviving cmd.exe/node.exe descendant of this test's fake adapter remains", survivorCount === 0, {survivorCount, stderr: survivorCheck.stderr});

  const elapsedSeconds = ((Date.now() - overallStart) / 1000).toFixed(1);
  console.log(`\n(total runtime: ${elapsedSeconds}s)`);

  if (failures) {
    console.error(`\n${failures} windows verifier playwright runtime bridge check(s) failed.`);
    process.exit(1);
  }
  console.log("\nwindows verifier playwright runtime bridge PASS");
}

await main();
