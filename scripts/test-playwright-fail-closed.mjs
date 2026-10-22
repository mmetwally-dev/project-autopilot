#!/usr/bin/env node
// TASK 16.3A behavioral proof: when a task genuinely requires deterministic
// Playwright browser verification (signalled through the existing
// task-requirement authority — task-requirements.mjs's structural facts and
// an inline `<!-- autopilot-requires: browser.playwright.deterministic -->`
// annotation parsed by role-requirements.mjs — never a new regex), the
// Verifier must never be launched while the Playwright module + Chromium
// runtime is unavailable. This drives the REAL production
// `node scripts/autopilot.mjs run --repo <repo>` subprocess end to end, with
// a fake CLI adapter standing in for every role, so the assertions exercise
// the real orchestrator decision (runRelay in autopilot.mjs) rather than a
// unit-level stand-in.
//
// No Playwright/Chromium is ever installed, downloaded, or launched by this
// file. A "valid runtime" is a minimal fixture that only satisfies
// discoverPlaywrightRuntime()'s structural validation (a package.json naming
// "playwright" with a version field plus a real entry file, and a
// regular/executable file matching a recognized browser basename) — the
// Verifier itself is a fake adapter that immediately PASSes without ever
// importing or launching anything. Runtime selection is entirely via the
// explicit PLAYWRIGHT_MODULE_DIR / PLAYWRIGHT_BROWSERS_PATH overrides
// discoverPlaywrightRuntime() already supports, and an isolated HOME/
// USERPROFILE/LOCALAPPDATA keeps this hermetic against whatever is actually
// installed on the host machine running this test.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
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
  return check(`${label}: process completed cleanly (no output overflow or termination failure)`,
    !result.outputLimitExceeded && !result.terminationFailed,
    {timedOut: result.timedOut, outputLimitExceeded: result.outputLimitExceeded, terminationFailed: result.terminationFailed, stdoutTail: (result.stdout || "").slice(-1500), stderrTail: (result.stderr || "").slice(-1500)});
}

// ---------------------------------------------------------------------
// SpecKit fixture seeded directly at the implementation checkpoint.
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

function seedSpecKitTasksReadyState(repo, featureDir) {
  // The phase-execution checkpoint binds {framework, mission, phaseIndex} at
  // creation, and every relay call backfills s.mission from the resolved
  // mission dir (autopilot.mjs's `if(mission && ...) s.mission=mission`).
  // A seed without mission identity creates the checkpoint under the
  // "mission" fallback and the first relay renames the mission out from
  // under it — a later resume of the SAME repo then dies with "SpecKit phase
  // checkpoint is bound to a different phase/mission". Real planning always
  // resolves identity first (missionSeq at planning start, unified
  // `<seq>-<name>` once specify creates the feature dir), so the seed pins
  // the same values production would derive: seq 001 (fresh repo, no mission
  // dirs yet) and the number-stripped feature slug (mission-naming.mjs's
  // stripSpecNumber: leading `<digits>-` removed).
  const slug = String(featureDir.split(path.sep).pop() || "");
  const name = slug.replace(/^\d+-/, "").trim() || "fixture";
  const state = {
    version: 1, phase: "tasks_ready", step: "tasks_ready", taskIndex: 0, phaseIndex: 0, attempt: 0,
    mission: `001-${name}`, missionSeq: "001",
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

function makeSpecKitRepo(prefix, {browserRequired, featureSlug, taskText}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `ap-pw-fc-${prefix}-`));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "pw-fail-closed@example.invalid"]);
  git(repo, ["config", "user.name", "Playwright Fail Closed Test"]);
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  fs.writeFileSync(path.join(repo, "implementation.txt"), "not-yet-implemented\n");
  const workflowDir = path.join(repo, ".specify", "workflows", "speckit");
  fs.mkdirSync(workflowDir, {recursive: true});
  fs.writeFileSync(path.join(workflowDir, "workflow.yml"), WORKFLOW_YML);
  const featureDir = path.join(repo, "specs", featureSlug);
  fs.mkdirSync(featureDir, {recursive: true});
  fs.writeFileSync(path.join(repo, ".specify", "feature.json"), JSON.stringify({feature_directory: `specs/${featureSlug}`}));
  fs.writeFileSync(path.join(featureDir, "spec.md"), "# Spec\n\nPlaywright fail-closed fixture feature.\n");
  fs.writeFileSync(path.join(featureDir, "plan.md"), "# Plan\n\nPlaywright fail-closed fixture plan.\n");
  const annotation = browserRequired ? " <!-- autopilot-requires: browser.playwright.deterministic -->" : "";
  fs.writeFileSync(path.join(featureDir, "tasks.md"), `## Phase 1: ${taskText}\n\n- [ ] ${taskText}${annotation}\n`);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init: fail-closed fixture at the implementation checkpoint"]);
  seedSpecKitTasksReadyState(repo, featureDir);
  return {repo, tasksFile: path.join(featureDir, "tasks.md")};
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
      failure_budgets: {implementationFailureBudget: 3, verificationFailureBudget: 3, adapterRetryBudget: 2, infrastructureRetryBudget: 2}
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
// Fixture Playwright module/browser builders. Structural validity only:
// these satisfy discoverPlaywrightRuntime()'s package.json/entry-file/
// executable-name checks without being a real, launchable Playwright
// install — never imported, never executed, by this test or by production
// discovery (discovery only inspects package.json + entry-file presence and
// the browser file's type/name/permission bits).
// ---------------------------------------------------------------------
function makeValidModuleDir(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ap-pw-fc-module-${prefix}-`));
  const pkgDir = path.join(root, "playwright");
  fs.mkdirSync(pkgDir, {recursive: true});
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({name: "playwright", version: "1.2.3"}, null, 2));
  fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = {};\n");
  return root;
}
function makeValidBrowserDir(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ap-pw-fc-browser-${prefix}-`));
  const exeName = IS_WIN ? "chrome.exe" : "chrome";
  const revDir = path.join(root, "chromium-1091", IS_WIN ? "chrome-win" : "chrome-linux");
  fs.mkdirSync(revDir, {recursive: true});
  const exePath = path.join(revDir, exeName);
  fs.writeFileSync(exePath, "not a real binary\n");
  if (!IS_WIN) { try { fs.chmodSync(exePath, 0o755); } catch { /* best-effort */ } }
  return root;
}
function makeInvalidModuleDir(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ap-pw-fc-invalid-module-${prefix}-`));
  fs.writeFileSync(path.join(root, "not-a-package.txt"), "nothing here");
  return root;
}

// ---------------------------------------------------------------------
// Fake "cursor" adapter. Orchestration decisions only: implementer writes a
// tracked-file change, code_reviewer PASSes unconditionally, verifier
// PASSes unconditionally WITHOUT ever importing or launching Playwright —
// this file proves the orchestrator's launch-gating decision, not real
// browser execution (that real-execution proof lives in
// test-playwright-verification.mjs).
// ---------------------------------------------------------------------
const ADAPTER_SCRIPT = `
import fs from "node:fs";

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
  console.log("fake-pw-fail-closed-cursor-agent 1.0.0");
  process.exit(0);
}

const PROMPT = await readStdin();
const firstLine = PROMPT.split(/\\r?\\n/, 1)[0] || "";
const role = firstLine.startsWith("ROLE=") ? firstLine.slice("ROLE=".length) : "";

if (role === "implementer") {
  fs.writeFileSync("implementation.txt", "attempt done\\n");
  console.log("implementer ok");
  // TASK-19 Phase 4 (task 12): the per-task Implementer invocation must end
  // with the AUTOPILOT_TASK_RESULT sentinel as its final non-empty line, or the
  // mission escalates with STRUCTURED_OUTPUT_MISSING before the Verifier's
  // Playwright-runtime decision this file proves is ever reached.
  console.log("AUTOPILOT_TASK_RESULT=" + JSON.stringify({summary: "implementer ok", taskLocalCheck: {command: "true", status: "passed", exitCode: 0, summary: "fixture"}}));
  process.exit(0);
}

if (role === "code_reviewer") {
  console.log("AUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: []}));
  process.exit(0);
}

if (role === "verifier") {
  // Deliberately never imports/launches Playwright: this fixture proves the
  // orchestrator's pre-launch fail-closed decision, not real browser use.
  console.log("AUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: ["FAKE_VERIFIER_RAN=true"]}));
  process.exit(0);
}

console.error("fake-pw-fail-closed-adapter: unknown ROLE '" + role + "'");
process.exit(1);
`;

function makeBin(prefix) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), `ap-pw-fc-bin-${prefix}-`));
  if (IS_WIN) {
    const scriptPath = path.join(binDir, "pw-fail-closed-adapter.mjs");
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

function runMission(repo, binDir, {timeoutMs = 590000, extraEnv = {}, isolatedHome} = {}) {
  // 150s was enough on a fast disk, but each relay hop spawns a sandboxed
  // adapter and the mission cycles implementer/code_reviewer/verifier hops —
  // ~200s+ on a slow filesystem (same sizing as test-relay-session-continuity
  // and test-rate-limit-classification's 590s). Keep the fail-fast timeout,
  // just sized for slow disks so Phase-1-complete + verifier-PASS missions
  // are not killed before finalization.
  const delimiter = IS_WIN ? ";" : ":";
  const base = withoutOuterGitGuard({...process.env});
  const env = {
    ...base,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    LOCALAPPDATA: path.join(isolatedHome, "AppData", "Local"),
    PATH: `${binDir}${delimiter}${base.PATH || ""}`,
    ...extraEnv
  };
  // Hermetic browser discovery: an ambient PLAYWRIGHT_BROWSERS_PATH from the
  // outer process.env spread must never leak in unless a scenario opts back
  // in via extraEnv (a deleted key loses to the spread above, unlike an
  // overridden one).
  if (!("PLAYWRIGHT_BROWSERS_PATH" in extraEnv)) delete env.PLAYWRIGHT_BROWSERS_PATH;
  if (!("PLAYWRIGHT_MODULE_DIR" in extraEnv)) delete env.PLAYWRIGHT_MODULE_DIR;
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
function readState(repo) {
  const statePath = path.join(repo, ".autopilot", "state.json");
  if (!fs.existsSync(statePath)) return null;
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

async function main() {
  const overallStart = Date.now();
  const leakPrefixes = ["ap-pw-fc-", "ap-pw-fc-bin-", "ap-pw-fc-module-", "ap-pw-fc-browser-", "ap-pw-fc-invalid-module-", "ap-pw-fc-home-", "autopilot-reviewer-"];
  const preExisting = new Set(leakPrefixes.flatMap(p => {
    try { return fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(p)).map(n => path.join(os.tmpdir(), n)); }
    catch { return []; }
  }));

  const binDir = makeBin("shared");
  if (IS_WIN) {
    const warmup = await runWindowsProcessTreeBounded("cmd.exe", ["/d", "/s", "/c", path.join(binDir, "cursor-agent.cmd"), "--version"], {timeoutMs: 60000});
    check("warmup: the shared adapter binary responds to --version before any scenario starts", warmup.status === 0 && !warmup.timedOut, warmup);
  }

  const cleanupList = [binDir];

  // =====================================================================
  // Scenario A: browser-required task, module/browser both structurally
  // unavailable (isolated HOME finds no browser; PLAYWRIGHT_MODULE_DIR is
  // unset so discovery falls through to the skill's own real installed
  // playwright package — proving the gate still fires purely on the missing
  // BROWSER even though the module is genuinely discovered).
  // =====================================================================
  let scenarioARepo = null;
  {
    const label = "A";
    const {repo, tasksFile} = makeSpecKitRepo(label, {browserRequired: true, featureSlug: "920-fc-a", taskText: "Verify checkout in a real browser"});
    scenarioARepo = repo;
    writeConfig(repo);
    const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), `ap-pw-fc-home-${label}-`));
    const headBefore = git(repo, ["rev-parse", "HEAD"]);
    const result = await runMission(repo, binDir, {isolatedHome});
    if (assertCleanRun(label, result)) {
      const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
      const results = readAllResults(repo);
      const verifierRuns = results.filter(r => r.data.role === "verifier");
      const state = readState(repo);

      check(`${label}: mission process exits non-zero (fail closed, not silently downgraded)`, result.status !== 0, {status: result.status});
      check(`${label}: Verifier subprocess was never launched`, verifierRuns.length === 0, {roles: results.map(r => r.data.role)});
      check(`${label}: failure is classified PLAYWRIGHT_RUNTIME_UNAVAILABLE`, /PLAYWRIGHT_RUNTIME_UNAVAILABLE/.test(combined), combined.slice(-1200));
      check(`${label}: failure states the browser (not the module) is missing`, /\(browser missing\)/.test(combined), combined.slice(-1200));
      check(`${label}: mission never claims completion`, !/ALL WORK COMPLETE/.test(combined), combined.slice(-400));
      check(`${label}: mission never reports HUMAN COMMIT REQUIRED`, !/HUMAN COMMIT REQUIRED/.test(combined), combined.slice(-400));
      check(`${label}: task checkbox remains unchecked`, fs.readFileSync(tasksFile, "utf8").includes("- [ ] Verify checkout in a real browser"), fs.readFileSync(tasksFile, "utf8"));
      check(`${label}: no ordinary verification failure budget was consumed`,
        !state?.failureBudgets || Object.keys(state.failureBudgets).every(k => !k.startsWith("verificationFailureBudget")), state?.failureBudgets);
      check(`${label}: mission state is left resumable (still implementing, phase not advanced)`,
        state?.phase === "implementing" && (state?.phaseIndex ?? 0) === 0, {phase: state?.phase, phaseIndex: state?.phaseIndex});
      check(`${label}: official repository HEAD unchanged`, git(repo, ["rev-parse", "HEAD"]) === headBefore, {headBefore});
    }
    cleanup(isolatedHome);
  }

  // =====================================================================
  // Scenario B: browser-required task, a genuinely valid (structurally)
  // runtime is supplied via explicit overrides — the Verifier must launch
  // normally and the task must be marked complete after PASS.
  // =====================================================================
  {
    const label = "B";
    const {repo, tasksFile} = makeSpecKitRepo(label, {browserRequired: true, featureSlug: "920-fc-b", taskText: "Verify checkout in a real browser"});
    writeConfig(repo);
    const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), `ap-pw-fc-home-${label}-`));
    const moduleDir = makeValidModuleDir(label);
    const browserDir = makeValidBrowserDir(label);
    const result = await runMission(repo, binDir, {isolatedHome, extraEnv: {PLAYWRIGHT_MODULE_DIR: moduleDir, PLAYWRIGHT_BROWSERS_PATH: browserDir}});
    if (assertCleanRun(label, result)) {
      const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
      const results = readAllResults(repo);
      const verifierRuns = results.filter(r => r.data.role === "verifier");
      check(`${label}: mission completes successfully`, result.status === 0 && /ALL WORK COMPLETE/.test(combined), {status: result.status, tail: combined.slice(-500)});
      check(`${label}: Verifier subprocess was launched`, verifierRuns.length > 0, {roles: results.map(r => r.data.role)});
      check(`${label}: Verifier completed with PASS`, verifierRuns[0]?.data.status === "completed" && verifierRuns[0]?.data.verdict?.decision === "PASS", verifierRuns[0]?.data);
      check(`${label}: no PLAYWRIGHT_RUNTIME_UNAVAILABLE failure reported`, !/PLAYWRIGHT_RUNTIME_UNAVAILABLE/.test(combined), combined.slice(-800));
      check(`${label}: task checkbox marked complete`, fs.readFileSync(tasksFile, "utf8").includes("- [x] Verify checkout in a real browser"), fs.readFileSync(tasksFile, "utf8"));
    }
    cleanup(repo, isolatedHome, moduleDir, browserDir);
  }

  // =====================================================================
  // Scenario C: non-browser task, no runtime available anywhere — behavior
  // must be identical to before this task: the mission completes normally
  // (Playwright stays entirely optional).
  // =====================================================================
  {
    const label = "C";
    const {repo, tasksFile} = makeSpecKitRepo(label, {browserRequired: false, featureSlug: "920-fc-c", taskText: "Update the backend service"});
    writeConfig(repo);
    const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), `ap-pw-fc-home-${label}-`));
    const result = await runMission(repo, binDir, {isolatedHome});
    if (assertCleanRun(label, result)) {
      const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
      const results = readAllResults(repo);
      const verifierRuns = results.filter(r => r.data.role === "verifier");
      check(`${label}: mission completes successfully with no Playwright installed anywhere`, result.status === 0 && /ALL WORK COMPLETE/.test(combined), {status: result.status, tail: combined.slice(-500)});
      check(`${label}: Verifier subprocess was launched and PASSed`, verifierRuns.length > 0 && verifierRuns[0].data.status === "completed" && verifierRuns[0].data.verdict?.decision === "PASS", verifierRuns[0]?.data);
      check(`${label}: no PLAYWRIGHT_RUNTIME_UNAVAILABLE failure reported`, !/PLAYWRIGHT_RUNTIME_UNAVAILABLE/.test(combined), combined.slice(-800));
      check(`${label}: task checkbox marked complete`, fs.readFileSync(tasksFile, "utf8").includes("- [x] Update the backend service"), fs.readFileSync(tasksFile, "utf8"));
    }
    cleanup(repo, isolatedHome);
  }

  // =====================================================================
  // Scenario D: browser-required task, an EXPLICIT PLAYWRIGHT_MODULE_DIR
  // override is invalid (garbage directory) even though a separately valid
  // browser is available — must fail closed on the module dimension
  // specifically, with no partial environment ever delivered (the Verifier
  // is never launched at all).
  // =====================================================================
  {
    const label = "D";
    const {repo, tasksFile} = makeSpecKitRepo(label, {browserRequired: true, featureSlug: "920-fc-d", taskText: "Verify checkout in a real browser"});
    writeConfig(repo);
    const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), `ap-pw-fc-home-${label}-`));
    const invalidModuleDir = makeInvalidModuleDir(label);
    const browserDir = makeValidBrowserDir(label);
    const result = await runMission(repo, binDir, {isolatedHome, extraEnv: {PLAYWRIGHT_MODULE_DIR: invalidModuleDir, PLAYWRIGHT_BROWSERS_PATH: browserDir}});
    if (assertCleanRun(label, result)) {
      const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
      const results = readAllResults(repo);
      const verifierRuns = results.filter(r => r.data.role === "verifier");
      check(`${label}: mission process exits non-zero`, result.status !== 0, {status: result.status});
      check(`${label}: Verifier subprocess was never launched (no partial environment delivered)`, verifierRuns.length === 0, {roles: results.map(r => r.data.role)});
      check(`${label}: failure is classified PLAYWRIGHT_RUNTIME_UNAVAILABLE`, /PLAYWRIGHT_RUNTIME_UNAVAILABLE/.test(combined), combined.slice(-1200));
      check(`${label}: failure states the module (not the browser) is missing`, /\(module missing\)/.test(combined), combined.slice(-1200));
      check(`${label}: never falsely claims completion`, !/ALL WORK COMPLETE/.test(combined) && !/HUMAN COMMIT REQUIRED/.test(combined), combined.slice(-400));
      check(`${label}: task checkbox remains unchecked`, fs.readFileSync(tasksFile, "utf8").includes("- [ ] Verify checkout in a real browser"), fs.readFileSync(tasksFile, "utf8"));
      check(`${label}: the invalid override directory's own path never appears in mission output`, !combined.includes(fs.realpathSync(invalidModuleDir)), {});
    }
    cleanup(repo, isolatedHome, invalidModuleDir, browserDir);
  }

  // =====================================================================
  // Scenario E: resume. Scenario A's repository was left blocked with the
  // task unchecked. Provisioning a valid runtime and rerunning the EXACT
  // same request (same repo, same state.json, no manual edits) must resume
  // the same mission/feature/phase/task, run the Verifier normally, and
  // mark the task complete only after a genuine Verification PASS.
  // =====================================================================
  if (scenarioARepo) {
    const label = "E";
    const repo = scenarioARepo;
    const tasksFile = path.join(repo, "specs", "920-fc-a", "tasks.md");
    const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), `ap-pw-fc-home-${label}-`));
    const moduleDir = makeValidModuleDir(label);
    const browserDir = makeValidBrowserDir(label);
    const stateBefore = readState(repo);
    const result = await runMission(repo, binDir, {isolatedHome, extraEnv: {PLAYWRIGHT_MODULE_DIR: moduleDir, PLAYWRIGHT_BROWSERS_PATH: browserDir}});
    if (assertCleanRun(label, result)) {
      const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
      const results = readAllResults(repo);
      const plannerRuns = results.filter(r => r.data.role === "planner" || r.data.role === "plan_reviewer");
      const verifierRuns = results.filter(r => r.data.role === "verifier");
      const stateAfter = readState(repo);
      check(`${label}: no re-planning occurred (same mission resumed, not restarted)`, plannerRuns.length === 0, results.map(r => r.data.role));
      check(`${label}: same mission identity preserved across the resume`,
        !stateBefore?.mission || !stateAfter?.mission || stateBefore.mission === stateAfter.mission, {before: stateBefore?.mission, after: stateAfter?.mission});
      check(`${label}: Verifier now launched and PASSed`, verifierRuns.length > 0 && verifierRuns[0].data.status === "completed" && verifierRuns[0].data.verdict?.decision === "PASS", verifierRuns[0]?.data);
      check(`${label}: mission now completes successfully`, result.status === 0 && /ALL WORK COMPLETE/.test(combined), {status: result.status, tail: combined.slice(-500)});
      check(`${label}: the previously-blocked task is now marked complete`, fs.readFileSync(tasksFile, "utf8").includes("- [x] Verify checkout in a real browser"), fs.readFileSync(tasksFile, "utf8"));
    }
    cleanup(repo, isolatedHome, moduleDir, browserDir);
  }

  cleanup(...cleanupList);
  const leakedFixtures = leakPrefixes.flatMap(p => {
    try { return fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(p)).map(n => path.join(os.tmpdir(), n)); }
    catch { return []; }
  }).filter(p => !preExisting.has(p));
  check("no leftover fixture/bin/home temp directories remain", leakedFixtures.length === 0, leakedFixtures);

  const elapsedSeconds = ((Date.now() - overallStart) / 1000).toFixed(1);
  console.log(`\n(total runtime: ${elapsedSeconds}s, platform=${process.platform})`);

  if (failures) {
    console.error(`\n${failures} playwright fail-closed check(s) failed.`);
    process.exit(1);
  }
  console.log("\nplaywright fail-closed verification gating PASS");
}

await main();
