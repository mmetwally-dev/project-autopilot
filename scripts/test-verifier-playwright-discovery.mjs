#!/usr/bin/env node
// Task 15.4C2 correction behavioral proof: the Verifier's Playwright
// guidance is derived from discoverPlaywrightRuntime() run against the
// OFFICIAL repository — never against the sandboxed/disposable path the
// Verifier subprocess itself actually runs inside — passed as an explicit
// argument (never via hidden configuration state), and the COMPLETE final
// Verifier prompt contains zero official-repository absolute paths.
//
// This file drives the REAL production `node scripts/autopilot.mjs run
// --repo <repo>` subprocess (not a unit-level call into verifier-brief.mjs
// — that contract-level coverage lives in test-verifier-brief.mjs) and
// inspects the entire prompt text a fake Verifier adapter receives.
//
// Runs on BOTH platforms: on Native Windows for a SpecKit project, the
// Verifier runs inside the disposable reviewer-workspace copy (which
// intentionally excludes gitignored node_modules — the exact scenario that
// produced the false negative); on WSL/Linux, the Verifier runs inside the
// real bubblewrap envelope. Discovery runs in the orchestrator against the
// real `cwd` (official repository) before any sandboxing decision.
//
// No Playwright/Chromium is ever installed, downloaded, or launched by this
// file: the "browser" fixtures below are placeholder text files (chmod +x
// on POSIX so the strengthened task 15.4C1 executable check accepts them)
// that are never executed — they only need to canonicalize and validate as
// a discovered browser executable's PATH, never actually run.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {migrateConfig} from "./config-migration.mjs";
import {toRuntimeConfig} from "./config-layout.mjs";
import {fillLayout} from "./config-fill.mjs";

// Runtime view of a config's operator-owned core: migrate to the v4 layout (a
// no-op for v4), complete it through the same fill migration uses (fill only
// adds absent defaults, so operator values are untouched), convert to the
// runtime shape, keep project/roles/gates/workflow.
function normalizedConfigCore(json) {
  const layout = fillLayout(migrateConfig(JSON.parse(JSON.stringify(json))).layout);
  const runtime = toRuntimeConfig(layout);
  return JSON.stringify({project: runtime.project, roles: runtime.roles, gates: runtime.gates, workflow: runtime.workflow});
}
{
  const base = {schema_version: "3.0", project: {name: "x"}, roles: {implementer: {cli: "opencode", model: "m1"}}, gates: {commands: ["npm test"]}, workflow: {}};
  const changedModel = JSON.parse(JSON.stringify(base)); changedModel.roles.implementer.model = "m2";
  const changedGate = JSON.parse(JSON.stringify(base)); changedGate.gates.commands = ["npm run other"];
  if (normalizedConfigCore(base) !== normalizedConfigCore(JSON.parse(JSON.stringify(base)))
    || normalizedConfigCore(base) === normalizedConfigCore(changedModel)
    || normalizedConfigCore(base) === normalizedConfigCore(changedGate)) {
    console.error("FAIL: config core normalizer self-check");
    process.exit(1);
  }
}
import {spawnSync} from "node:child_process";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import {runWindowsProcessTreeBounded} from "./test-fixtures/windows-process-tree-runner.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRootDir = path.resolve(here, "..");
const CANONICAL_AUTOPILOT = path.join(skillRootDir, "scripts", "autopilot.mjs");
const IS_WIN = process.platform === "win32";

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  return false;
};

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
function assertCleanRun(label, result) {
  return check(`${label}: process completed cleanly (no timeout, output overflow, or termination failure)`,
    !result.timedOut && !result.outputLimitExceeded && !result.terminationFailed,
    {timedOut: result.timedOut, outputLimitExceeded: result.outputLimitExceeded, terminationFailed: result.terminationFailed, stdoutTail: (result.stdout || "").slice(-1200), stderrTail: (result.stderr || "").slice(-1200)});
}

// ---------------------------------------------------------------------
// SpecKit fixture: seeded directly at the implementation checkpoint (no
// Planner/Plan Reviewer involved), with a TRACKED implementation.txt and a
// gitignored node_modules/ added AFTER the initial commit, so the Native
// Windows disposable-copy exclusion this file proves is genuine.
//
// The task line deliberately embeds poison paths so the COMPLETE prompt
// remapping can be proved behaviorally:
//   - a hyphen-sibling outside path (<repo>-other/...) that must be
//     preserved verbatim,
//   - a dot-sibling outside path (<repo>.backup/...) that must be preserved,
//   - an embedded-parent outside path (/var<repo>/... on POSIX,
//     X<repo> token on Windows) that must be preserved, and
//   - a forward-slash spelling of the official root that must still remap.
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
const TASK_TEXT = "Do the playwright-discovery checkpoint task";
const FEATURE_SLUG = "903-pw-discovery-checkpoint";

function similarOutsideFor(repo) {
  return repo + "-other" + path.sep + "outside.md";
}
function dotSiblingFor(repo) {
  return repo + ".backup" + path.sep + "archived.md";
}
function embeddedParentFor(repo) {
  if (process.platform === "win32") return "X" + repo + path.sep + "embedded.md";
  return "/var" + repo + "/embedded.md";
}
function slashVariantFor(repo) {
  return repo.split(path.sep).join("/");
}
// Task 15.4C2 correction 3 poison values: a genuine native-separator child
// reference (the exact token we assert is remapped), a traversal reference
// that escapes the repository root once normalized, and a file:// URL
// reference into the repository. These are embedded into the SAME tasks.md
// line as the correction-2 poison values so the correction-3 fix is proved
// against the real end-to-end Verifier prompt, not a synthetic string.
function nativeChildFor(repo) {
  return repo + path.sep + "specs" + path.sep + FEATURE_SLUG + path.sep + "tasks.md";
}
function traversalEscapeFor(repo) {
  return repo + path.sep + ".." + path.sep + "outside-secret.md";
}
function fileUrlPathOf(repo) {
  const slash = repo.split(path.sep).join("/");
  const withLeadingSlash = slash.startsWith("/") ? slash : `/${slash}`;
  return withLeadingSlash.replace(/^\/([A-Za-z]):/, (_, d) => `/${d.toUpperCase()}:`);
}
function fileUrlChildFor(repo) {
  return `file://${fileUrlPathOf(repo)}/specs/${FEATURE_SLUG}/tasks.md`;
}

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
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `ap-pw-verify-${prefix}-`));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "pw-verify-discovery@example.invalid"]);
  git(repo, ["config", "user.name", "Playwright Verify Discovery Test"]);

  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  fs.writeFileSync(path.join(repo, "implementation.txt"), "not-yet-implemented\n");

  const workflowDir = path.join(repo, ".specify", "workflows", "speckit");
  fs.mkdirSync(workflowDir, {recursive: true});
  fs.writeFileSync(path.join(workflowDir, "workflow.yml"), WORKFLOW_YML);

  const featureDir = path.join(repo, "specs", FEATURE_SLUG);
  fs.mkdirSync(featureDir, {recursive: true});
  fs.writeFileSync(path.join(repo, ".specify", "feature.json"), JSON.stringify({feature_directory: `specs/${FEATURE_SLUG}`}));
  fs.writeFileSync(path.join(featureDir, "spec.md"), "# Spec\n\nPlaywright discovery checkpoint fixture feature.\n");
  fs.writeFileSync(path.join(featureDir, "plan.md"), "# Plan\n\nPlaywright discovery checkpoint fixture plan.\n");
  const similarOutside = similarOutsideFor(repo);
  const dotSibling = dotSiblingFor(repo);
  const embeddedParent = embeddedParentFor(repo);
  const slashVariant = slashVariantFor(repo);
  const nativeChild = nativeChildFor(repo);
  const traversalEscape = traversalEscapeFor(repo);
  const fileUrlChild = fileUrlChildFor(repo);
  const taskLine = `${TASK_TEXT} (ref ${similarOutside}; dot ${dotSibling}; parent ${embeddedParent}; slash ${slashVariant}/specs/${FEATURE_SLUG}/tasks.md; native ${nativeChild}; escape ${traversalEscape}; url ${fileUrlChild})`;
  fs.writeFileSync(path.join(featureDir, "tasks.md"), `## Phase 1: ${TASK_TEXT}\n\n- [ ] ${taskLine}\n`);

  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init: complete speckit fixture at the implementation checkpoint"]);

  seedSpecKitTasksReadyState(repo, featureDir);
  return repo;
}

// Real (validation-passing per task 15.4C1) playwright package, written
// UNCOMMITTED/UNTRACKED after the init commit — under the gitignored
// node_modules/, so it is excluded from the Native Windows disposable copy
// exactly the way a real project's install would be.
function installOfficialRepoPlaywrightPackage(repo) {
  const pkgDir = path.join(repo, "node_modules", "playwright");
  fs.mkdirSync(pkgDir, {recursive: true});
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({name: "playwright", version: "1.2.3"}, null, 2));
  fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = {};\n");
  return pkgDir;
}

// A package-local browser cache under the SAME official-repo node_modules
// (playwright-core/.local-browsers), matching discoverPlaywrightRuntime()'s
// own "package-local" candidate. The file is never executed — validation
// only inspects its type/name/permission bits.
function installOfficialRepoBrowser(repo) {
  const exeName = IS_WIN ? "chrome.exe" : "chrome";
  const revDir = path.join(repo, "node_modules", "playwright-core", ".local-browsers", "chromium-1091", IS_WIN ? "chrome-win" : "chrome-linux");
  fs.mkdirSync(revDir, {recursive: true});
  const exePath = path.join(revDir, exeName);
  fs.writeFileSync(exePath, "not a real binary\n");
  if (!IS_WIN) { try { fs.chmodSync(exePath, 0o755); } catch { /* best-effort */ } }
  return exePath;
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
    // No gate commands: this task integrates discovery INFORMATION only —
    // no browser command is ever approved or run.
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
// Fake "cursor" adapter: implementer writes a tracked-file change;
// code_reviewer PASSes unconditionally; verifier captures its FULL received
// prompt (stdin) verbatim into the AUTOPILOT_REVIEW findings so this test
// can inspect exactly what the Verifier subprocess actually saw, then
// PASSes. The verifier also reports its real cwd and whether the expected
// task file exists at that cwd during execution — proving the remapped
// visible path points at a repository representation it can actually
// access. No planner/plan_reviewer branch — the fixture is seeded past
// that checkpoint, so neither should ever be invoked.
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
  console.log("fake-pw-discovery-cursor-agent 1.0.0");
  process.exit(0);
}

const PROMPT = await readStdin();
const firstLine = PROMPT.split(/\\r?\\n/, 1)[0] || "";
const role = firstLine.startsWith("ROLE=") ? firstLine.slice("ROLE=".length) : "";

  if (role === "implementer") {
    fs.writeFileSync("implementation.txt", "attempt 1\\n");
    console.log("implementer ok");
    // TASK-19 Phase 4 (task 12): per-task Implementer invocation sentinel.
    console.log("AUTOPILOT_TASK_RESULT=" + JSON.stringify({summary: "implementer ok", taskLocalCheck: {command: "true", status: "passed", exitCode: 0, summary: "fixture"}}));
    process.exit(0);
  }

if (role === "code_reviewer") {
  console.log("AUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: []}));
  process.exit(0);
}

if (role === "verifier") {
  const encoded = Buffer.from(PROMPT, "utf8").toString("base64");
  const cwdNow = process.cwd();
  let tasksExists = false;
  try { tasksExists = fs.existsSync(path.join(cwdNow, "specs", "${FEATURE_SLUG}", "tasks.md")); } catch {}
  console.log("AUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: ["PROMPT_B64:" + encoded, "VERIFIER_CWD:" + cwdNow, "TASKS_EXISTS:" + (tasksExists ? "yes" : "no")]}));
  process.exit(0);
}

console.error("fake-pw-discovery-adapter: unknown ROLE '" + role + "'");
process.exit(1);
`;

function makeBin(prefix) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), `ap-pw-verify-bin-${prefix}-`));
  if (IS_WIN) {
    const scriptPath = path.join(binDir, "pw-discovery-adapter.mjs");
    fs.writeFileSync(scriptPath, ADAPTER_SCRIPT);
    const cmdPath = path.join(binDir, "cursor-agent.cmd");
    fs.writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\nexit /b %errorlevel%\r\n`);
  } else {
    const binPath = path.join(binDir, "cursor-agent");
    fs.writeFileSync(binPath, `#!/usr/bin/env node\n${ADAPTER_SCRIPT}`);
    fs.chmodSync(binPath, 0o755);
  }
  return binDir;
}

function runMission(repo, binDir, {timeoutMs, extraEnv = {}}) {
  const delimiter = IS_WIN ? ";" : ":";
    // Strip any outer mission/gate git guard (PATH shim + hooks): the
  // nested mission installs its own, and every git call through both
  // ran the mission several times slower under the orchestrator gate.
  const base = withoutOuterGitGuard({...process.env});
  const env = {...base, ...extraEnv, PATH: `${binDir}${delimiter}${base.PATH || ""}`};
  // Hermetic browser discovery (see runScenario): spreading process.env
  // above would reintroduce an ambient PLAYWRIGHT_BROWSERS_PATH that the
  // scenario explicitly removed (a deleted key loses to the process.env
  // spread, unlike an overridden one). Delete it again unless the scenario
  // opted back in via extraEnv.
  if (!("PLAYWRIGHT_BROWSERS_PATH" in extraEnv)) delete env.PLAYWRIGHT_BROWSERS_PATH;
  if (IS_WIN) {
    return runWindowsProcessTreeBounded(process.execPath, [CANONICAL_AUTOPILOT, "run", "--repo", repo], {cwd: repo, env, timeoutMs});
  }
  const r = spawnSync(process.execPath, [CANONICAL_AUTOPILOT, "run", "--repo", repo], {cwd: repo, env, encoding: "utf8", timeout: timeoutMs, shell: false});
  return {status: r.status, signal: r.signal, stdout: r.stdout || "", stderr: r.stderr || "", timedOut: r.error?.code === "ETIMEDOUT", outputLimitExceeded: false, terminationFailed: false, error: r.error || null};
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
function extractVerifierPrompt(result) {
  const findings = result?.review?.findings || result?.verdict?.findings || [];
  for (const finding of findings) {
    if (typeof finding === "string" && finding.startsWith("PROMPT_B64:")) {
      return Buffer.from(finding.slice("PROMPT_B64:".length), "base64").toString("utf8");
    }
  }
  return null;
}
function extractVerifierCwd(result) {
  const findings = result?.review?.findings || result?.verdict?.findings || [];
  for (const finding of findings) {
    if (typeof finding === "string" && finding.startsWith("VERIFIER_CWD:")) {
      return finding.slice("VERIFIER_CWD:".length);
    }
  }
  return null;
}
function extractTasksExists(result) {
  const findings = result?.review?.findings || result?.verdict?.findings || [];
  for (const finding of findings) {
    if (typeof finding === "string" && finding.startsWith("TASKS_EXISTS:")) {
      return finding.slice("TASKS_EXISTS:".length);
    }
  }
  return null;
}

// =======================================================================
// Scenario runner: seeds the fixture, optionally installs a repo-local
// playwright module/browser, runs the mission, and returns everything the
// checks below need.
// =======================================================================
async function runScenario(label, binDir, {installModule = false, installBrowser = false, extraEnv = {}, timeoutMs = 150000} = {}) {
  const repo = makeSpecKitRepo(label);
  // Isolated HOME/USERPROFILE/LOCALAPPDATA so discovery's real-environment
  // defaults can NEVER pick up an actual Playwright install/browser cache
  // that genuinely exists on the machine running this test.
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), `ap-pw-verify-home-${label}-`));
  const isolatedEnv = {
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    LOCALAPPDATA: path.join(isolatedHome, "AppData", "Local"),
    ...extraEnv
  };
  // Hermetic browser discovery: a machine/CI-wide PLAYWRIGHT_BROWSERS_PATH
  // (e.g. the CI explicit browser cache provisioned for the real-Chromium
  // tests) must never leak a browser into these scenarios — same rationale
  // as the isolated HOME above. Delete (do NOT point at an empty dir: an
  // explicit-but-empty path fails closed as invalid-explicit-override
  // instead of falling through). A scenario may still opt back in by passing
  // PLAYWRIGHT_BROWSERS_PATH explicitly via extraEnv.
  if (!("PLAYWRIGHT_BROWSERS_PATH" in extraEnv)) delete isolatedEnv.PLAYWRIGHT_BROWSERS_PATH;
  try {
    writeConfig(repo);
    const configBefore = fs.readFileSync(path.join(repo, ".autopilot", "config.json"), "utf8");
    const officialRepoReal = fs.realpathSync(repo);
    const officialResolved = path.resolve(repo);
    const similarOutside = similarOutsideFor(repo);
    const dotSibling = dotSiblingFor(repo);
    const embeddedParent = embeddedParentFor(repo);
    const slashVariant = slashVariantFor(repo);
    const headBefore = git(repo, ["rev-parse", "HEAD"]);
    let moduleDir = null, browserPath = null, moduleJsonBefore = null, browserContentBefore = null;
    if (installModule) {
      moduleDir = fs.realpathSync(installOfficialRepoPlaywrightPackage(repo));
      moduleJsonBefore = fs.readFileSync(path.join(moduleDir, "package.json"), "utf8");
    }
    if (installBrowser) {
      browserPath = fs.realpathSync(installOfficialRepoBrowser(repo));
      browserContentBefore = fs.readFileSync(browserPath, "utf8");
    }

    const result = await runMission(repo, binDir, {timeoutMs, extraEnv: isolatedEnv});
    if (!assertCleanRun(label, result)) return null;
    const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`;

    const results = sortResultsBySeq(readAllResults(repo));
    const plannerRuns = results.filter(r => r.data.role === "planner" || r.data.role === "plan_reviewer");
    const codeReviewerRuns = results.filter(r => r.data.role === "code_reviewer");
    const verifierRuns = results.filter(r => r.data.role === "verifier");
    if (!check(`${label}: at least one verifier run recorded`, verifierRuns.length > 0, {roles: results.map(r => r.data.role), tail: combinedOutput.slice(-2000)})) return null;

    const verifierResult = verifierRuns[0].data;
    const prompt = extractVerifierPrompt(verifierResult);
    if (!check(`${label}: verifier prompt payload recovered`, typeof prompt === "string" && prompt.length > 0, verifierResult)) return null;
    const verifierCwd = extractVerifierCwd(verifierResult);
    const tasksExists = extractTasksExists(verifierResult);

    check(`${label}: the official repository HEAD is unchanged (Autopilot never commits)`, git(repo, ["rev-parse", "HEAD"]) === headBefore, {headBefore});
    if (installModule) {
      const moduleJsonAfter = fs.readFileSync(path.join(moduleDir, "package.json"), "utf8");
      check(`${label}: the discovered module's package.json was not modified by discovery`, moduleJsonAfter === moduleJsonBefore, {moduleDir});
    }
    if (installBrowser) {
      const browserContentAfter = fs.readFileSync(browserPath, "utf8");
      check(`${label}: the placeholder browser file was never executed or modified`, browserContentAfter === browserContentBefore, {browserPath});
    }
    const configAfter = fs.readFileSync(path.join(repo, ".autopilot", "config.json"), "utf8");
    const hiddenName = "__" + "playwright" + "Runtime";
    check(`${label}: official config carries no hidden runtime property`, !configAfter.includes(hiddenName), {});
    try {
      const beforeJson = JSON.parse(configBefore);
      const afterJson = JSON.parse(configAfter);
      // A run may legitimately migrate a legacy config to the v4 layout, so
      // compare both sides through the runtime view, not the raw file shape.
      const beforeCore = normalizedConfigCore(beforeJson);
      const afterCore = normalizedConfigCore(afterJson);
      check(`${label}: official config core (project/roles/gates/workflow) unchanged by Verifier execution`, beforeCore === afterCore, {});
    } catch {
      check(`${label}: official config remains valid JSON`, false, {});
    }

    return {repo, officialRepoReal, officialResolved, similarOutside, dotSibling, embeddedParent, slashVariant, moduleDir, browserPath, results, plannerRuns, codeReviewerRuns, verifierRuns, verifierResult, prompt, verifierCwd, tasksExists, combinedOutput, mission: result};
  } finally {
    cleanup(repo, isolatedHome);
  }
}

// The COMPLETE final Verifier prompt is checked with EXACT, OBSERVABLE
// string assertions against tokens this fixture itself constructed — never
// by re-deriving production's boundary-matching algorithm to go searching
// for "any occurrence of the official root". Reimplementing that algorithm
// here would let the exact same mistake production could make (e.g.
// treating a traversal path as a genuine descendant) be reproduced
// identically in the check, which would then rubber-stamp the bug as a
// PASS. Instead: every poison value embedded in tasks.md by makeSpecKitRepo
// (similarOutside, dotSibling, embeddedParent, slashVariant, nativeChild,
// traversalEscape, fileUrlChild) is a KNOWN literal string, so this proves
// isolation by checking each one's exact expected fate — present verbatim
// (preserved), absent verbatim (remapped or blocked), or the safe
// placeholder observed — with plain `.includes()`.
function assertCompletePromptIsolation(label, ctx) {
  const visibleRoot = IS_WIN ? ctx.verifierCwd : "/workspace/repository";

  // Genuine descendant: exact official child token absent, exact visible
  // child token present, for every spelling of the official root.
  const officials = [ctx.officialRepoReal, ctx.officialResolved, ctx.repo].filter(Boolean);
  for (const official of officials) {
    const officialChild = nativeChildFor(official);
    check(`${label}: exact official child token absent (${official.slice(-24)})`,
      !ctx.prompt.includes(officialChild), {officialChild});
  }
  if (typeof visibleRoot === "string" && visibleRoot.length > 0) {
    const visibleChild = nativeChildFor(visibleRoot);
    check(`${label}: exact visible child token present`,
      ctx.prompt.includes(visibleChild), {visibleChild});
  }

  // Slash-variant genuine descendant: exact official forward-slash child
  // token absent, exact visible forward-slash child token present.
  const officialSlashChild = `${ctx.repo.split(path.sep).join("/")}/specs/${FEATURE_SLUG}/tasks.md`;
  const visibleSlashChild = `${visibleRoot.split(path.sep).join("/")}/specs/${FEATURE_SLUG}/tasks.md`;
  check(`${label}: exact official forward-slash child token absent`,
    !ctx.prompt.includes(officialSlashChild), {officialSlashChild});
  check(`${label}: exact visible forward-slash child token present`,
    ctx.prompt.includes(visibleSlashChild), {visibleSlashChild});

  // Exact sibling/embedded outside tokens preserved byte-identical.
  check(`${label}: similar-prefix outside path preserved`,
    ctx.prompt.includes(ctx.similarOutside), {similarOutside: ctx.similarOutside});
  check(`${label}: dot-sibling outside path preserved`,
    ctx.prompt.includes(ctx.dotSibling), {dotSibling: ctx.dotSibling});
  check(`${label}: embedded-parent outside path preserved`,
    ctx.prompt.includes(ctx.embeddedParent), {embeddedParent: ctx.embeddedParent});

  // Escaping traversal: exact escaping token absent, safe placeholder
  // observed instead — never a visible-repository-descendant rewrite, never
  // the official host path.
  const escapeToken = traversalEscapeFor(ctx.repo);
  check(`${label}: exact escaping traversal token absent`,
    !ctx.prompt.includes(escapeToken), {escapeToken});
  check(`${label}: safe outside-repository placeholder observed for the escaping traversal reference`,
    ctx.prompt.includes("<outside-repository-path>"), {});

  // file:// URL: contains no official host root; remaps to the visible
  // repository's own file:// URL, never a malformed mixed-slash form.
  const officialFileUrl = fileUrlChildFor(ctx.repo);
  const visibleFileUrl = fileUrlChildFor(visibleRoot);
  check(`${label}: file URL contains no official host root`,
    !ctx.prompt.includes(officialFileUrl), {officialFileUrl});
  check(`${label}: file URL remapped to the visible repository representation`,
    ctx.prompt.includes(visibleFileUrl), {visibleFileUrl});
  check(`${label}: no malformed mixed-slash Windows file URL introduced`,
    !/file:\/\/\/[A-Za-z]:[^\s"')]*\\/.test(ctx.prompt), {});

  if (IS_WIN) {
    check(`${label}: complete Windows prompt contains the disposable-copy cwd`,
      typeof ctx.verifierCwd === "string" && ctx.verifierCwd.length > 0 && ctx.prompt.includes(ctx.verifierCwd),
      {verifierCwd: ctx.verifierCwd});
    check(`${label}: disposable-copy task file existed inside the copy during execution`,
      ctx.tasksExists === "yes", {tasksExists: ctx.tasksExists, verifierCwd: ctx.verifierCwd});
    check(`${label}: complete Windows prompt references tasks.md through the disposable copy`,
      ctx.prompt.includes("tasks.md") && typeof ctx.verifierCwd === "string" && ctx.prompt.toLowerCase().includes(ctx.verifierCwd.toLowerCase()),
      {});
  } else {
    check(`${label}: complete WSL prompt contains /workspace/repository task references`,
      ctx.prompt.includes("/workspace/repository") && ctx.prompt.includes("tasks.md"), {});
    check(`${label}: WSL task file existed inside the envelope during execution`,
      ctx.tasksExists === "yes", {tasksExists: ctx.tasksExists});
  }
}

function noRawPathLeak(label, ctx) {
  // Module/browser absolute paths and discovery internals never reach the
  // COMPLETE prompt (not just a guidance subsection).
  if (ctx.moduleDir) {
    check(`${label}: the discovered module directory's real absolute path never appears anywhere in the complete verifier prompt`,
      !ctx.prompt.includes(ctx.moduleDir), {moduleDir: ctx.moduleDir});
  }
  if (ctx.browserPath) {
    check(`${label}: the discovered browser executable's real absolute path never appears anywhere in the complete verifier prompt`,
      !ctx.prompt.includes(ctx.browserPath), {browserPath: ctx.browserPath});
  }
  assertCompletePromptIsolation(label, ctx);
}

function codeReviewerUnaffected(label, ctx) {
  check(`${label}: Code Reviewer still ran and PASSed (unaffected by this task)`,
    ctx.codeReviewerRuns.length > 0 && ctx.codeReviewerRuns[0].data.status === "completed" && ctx.codeReviewerRuns[0].data.verdict?.decision === "PASS",
    ctx.codeReviewerRuns[0]?.data);
  check(`${label}: no Planner/Plan Reviewer ran (seeded past planning; behavior unchanged)`,
    ctx.plannerRuns.length === 0, ctx.plannerRuns.map(r => r.data.role));
}

function verifierNotBlocked(label, ctx) {
  check(`${label}: the Verifier itself still completed with a PASS (missing/invalid Playwright never blocks non-browser verification)`,
    ctx.verifierResult.status === "completed" && ctx.verifierResult.verdict?.decision === "PASS", ctx.verifierResult);
}

function checkNoHiddenState(label, ctx) {
  const hidden = "__" + "playwright" + "Runtime";
  check(`${label}: verifier result carries no hidden runtime property`,
    ctx.verifierResult && !(hidden in ctx.verifierResult), {});
  const autoSrc = fs.readFileSync(path.join(skillRootDir, "scripts", "autopilot.mjs"), "utf8");
  const briefSrc = fs.readFileSync(path.join(skillRootDir, "scripts", "verifier-brief.mjs"), "utf8");
  check(`${label}: production sources carry no hidden runtime property`, !autoSrc.includes(hidden) && !briefSrc.includes(hidden), {});
}

function checkNoBrowserLaunch(label, ctx) {
  // No gate commands were configured, so the prompt must stay on the
  // non-browser path or explicitly gate browser use — never claim a launch.
  // The placeholder browser fixture content proves it was never executed
  // (checked in runScenario); here we prove no Chromium artifacts leaked
  // into the official repo listing.
  check(`${label}: no Chromium launch claimed without an approved command`,
    /No verifier command is approved/i.test(ctx.prompt), ctx.prompt.slice(0, 500));
}

async function main() {
  const overallStart = Date.now();
  const leakPrefixes = ["ap-pw-verify-", "ap-pw-verify-bin-", "autopilot-reviewer-"];
  const preExisting = new Set(leakPrefixes.flatMap(p => {
    try { return fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(p)).map(n => path.join(os.tmpdir(), n)); }
    catch { return []; }
  }));

  const binDir = makeBin("shared");
  if (IS_WIN) {
    const warmup = await runWindowsProcessTreeBounded("cmd.exe", ["/d", "/s", "/c", path.join(binDir, "cursor-agent.cmd"), "--version"], {timeoutMs: 60000});
    check("warmup: the shared adapter binary responds to --version before any scenario starts", warmup.status === 0 && !warmup.timedOut, warmup);
  }

  // ---- Scenario 1: no repo install, isolated home (no browser) ----
  // Task 15.4C4A contract: the declared `playwright` skill dependency means
  // the module is ALWAYS discovered (source: skill) even with nothing
  // installed in the repository; only the browser is honestly missing here.
  {
    const ctx = await runScenario("S1-neither", binDir, {});
    if (ctx) {
      check("S1: module comes from the declared skill dependency, only the browser is reported missing",
        /Playwright is not available.*\(browser not discovered\)/i.test(ctx.prompt) && !/module and browser/i.test(ctx.prompt), ctx.prompt);
      check("S1: never claims a host Playwright runtime was discovered", !/host Playwright runtime was discovered/i.test(ctx.prompt), ctx.prompt);
      noRawPathLeak("S1", ctx);
      codeReviewerUnaffected("S1", ctx);
      verifierNotBlocked("S1", ctx);
      checkNoHiddenState("S1", ctx);
      checkNoBrowserLaunch("S1", ctx);
    }
  }

  // ---- Scenario 2: repo-local module only, no browser ----
  // The module lives under gitignored node_modules/, excluded from the
  // Native Windows disposable copy. This scenario proves the excluded
  // repo-local path never leaks into the complete prompt and verification
  // still proceeds on the non-browser path. (Since task 15.4C4A the declared
  // skill dependency also provides the module; the repo-local leak check
  // below is this scenario's distinct regression value.)
  {
    const ctx = await runScenario("S2-module-only", binDir, {installModule: true});
    if (ctx) {
      check("S2: module discovered from the official repository despite disposable/sandbox exclusion (only \"browser\" reported missing)",
        /Playwright is not available.*\(browser not discovered\)/i.test(ctx.prompt) && !/module and browser/i.test(ctx.prompt), ctx.prompt);
      check("S2: never claims a host Playwright runtime was fully discovered (browser is still missing)", !/host Playwright runtime was discovered/i.test(ctx.prompt), ctx.prompt);
      noRawPathLeak("S2", ctx);
      codeReviewerUnaffected("S2", ctx);
      verifierNotBlocked("S2", ctx);
      checkNoHiddenState("S2", ctx);
      checkNoBrowserLaunch("S2", ctx);
    }
  }

  // ---- Scenario 3: both module and browser present (repo-local) ----
  {
    const ctx = await runScenario("S3-both", binDir, {installModule: true, installBrowser: true});
    if (ctx) {
      check("S3: reports a host Playwright runtime was discovered, with safe source labels",
        /host Playwright runtime was discovered.*module source: repository.*browser source: package-local/is.test(ctx.prompt), ctx.prompt);
      check("S3: explicitly does NOT claim browser launch is already wired or proven",
        /does not mean a browser launch is already wired up or proven/i.test(ctx.prompt), ctx.prompt);
      check("S3: still instructs non-browser path when no gate commands were configured",
        /No verifier command is approved/i.test(ctx.prompt), ctx.prompt);
      noRawPathLeak("S3", ctx);
      codeReviewerUnaffected("S3", ctx);
      verifierNotBlocked("S3", ctx);
      checkNoHiddenState("S3", ctx);
    }
  }

  // ---- Scenario 4: invalid explicit override fails closed ----
  {
    const invalidModuleDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-pw-verify-invalid-explicit-"));
    fs.writeFileSync(path.join(invalidModuleDir, "not-a-package.txt"), "nothing here");
    try {
      const ctx = await runScenario("S4-invalid-explicit", binDir, {installModule: true, extraEnv: {PLAYWRIGHT_MODULE_DIR: invalidModuleDir}});
      if (ctx) {
        check("S4: an invalid explicit override is reported as unavailable, NOT silently replaced",
          /Playwright is not available for this project installation \((module|module and browser) not discovered\)/i.test(ctx.prompt), ctx.prompt);
        check("S4: never falsely claims a host Playwright runtime was discovered", !/host Playwright runtime was discovered/i.test(ctx.prompt), ctx.prompt);
        noRawPathLeak("S4", ctx);
        check("S4: the invalid override directory's own path never appears in the complete verifier prompt either",
          !ctx.prompt.includes(fs.realpathSync(invalidModuleDir)), invalidModuleDir);
        verifierNotBlocked("S4", ctx);
        checkNoHiddenState("S4", ctx);
        checkNoBrowserLaunch("S4", ctx);
      }
    } finally {
      cleanup(invalidModuleDir);
    }
  }

  cleanup(binDir);
  const leakedFixtures = leakPrefixes.flatMap(p => {
    try { return fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(p)).map(n => path.join(os.tmpdir(), n)); }
    catch { return []; }
  }).filter(p => !preExisting.has(p));
  check("no leftover fixture/bin temp directories remain (beyond what pre-existed this run)", leakedFixtures.length === 0, leakedFixtures);

  const elapsedSeconds = ((Date.now() - overallStart) / 1000).toFixed(1);
  console.log(`\n(total runtime: ${elapsedSeconds}s, platform=${process.platform})`);

  if (failures) {
    console.error(`\n${failures} verifier playwright-discovery integration check(s) failed.`);
    process.exit(1);
  }
  console.log("\nverifier playwright-discovery integration PASS");
}

await main();
