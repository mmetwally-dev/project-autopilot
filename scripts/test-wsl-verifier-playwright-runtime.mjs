#!/usr/bin/env node
// Task 15.4C3B behavioral proof: the REAL Verifier relay path — runRelay()
// -> assembleAdapterLaunchPlan() -> buildExecutionEnvelope() -> a real
// bubblewrap-sandboxed Verifier subprocess — actually receives the
// discoverPlaywrightRuntime() result that autopilot.mjs computes for it, and
// that no other role (Code Reviewer, Implementer, Planner, Plan Reviewer)
// ever does.
//
// WSL/Linux bubblewrap only. This file SKIPs (exit 0) on Native Windows —
// see the platform guard immediately below, before any fixture is created.
//
// Every scenario drives the REAL, unmodified `node scripts/autopilot.mjs run
// --repo <repo>` production entrypoint (Scenarios 1 and 2) or an
// unmodified-except-for-one-narrow-env-gated-hook DISPOSABLE COPY of the
// whole scripts/+adapters/ tree (Scenario 3 only — see
// makeDisposableProductionCopyWithInvalidationHook below). Canonical
// scripts/autopilot.mjs is never patched by this file; the only production
// change for task 15.4C3B lives in scripts/autopilot.mjs itself (a plain,
// permanent, unconditional argument-forwarding change), not in this test.
//
// Fixtures ("Playwright module", "browser cache", "browser executable") are
// disposable placeholder files this test creates and deletes — never a real
// Playwright install, never a real Chromium. Nothing here downloads,
// installs, or launches an actual browser, and nothing here makes a network
// call.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";

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

// ---------------------------------------------------------------------
// Item 9: Native Windows must SKIP cleanly, before touching bubblewrap or
// the filesystem in any way beyond this check itself.
// ---------------------------------------------------------------------
if (IS_WIN) {
  console.log("SKIP test-wsl-verifier-playwright-runtime: WSL/Linux bubblewrap-only test; not applicable on Native Windows.");
  process.exit(0);
}

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: "pipe", env: withoutOuterGitGuard(process.env), shell: false });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout || "").trim();
}
function cleanup(...targets) {
  for (const dir of targets) {
    if (!dir) continue;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
function assertCleanRun(label, result) {
  return check(`${label}: process completed without a harness-level timeout`,
    !result.timedOut, { timedOut: result.timedOut, status: result.status, signal: result.signal, stdoutTail: (result.stdout || "").slice(-1500), stderrTail: (result.stderr || "").slice(-1500) });
}

// ---------------------------------------------------------------------
// SpecKit fixture: seeded directly at the implementation-ready checkpoint
// (tasks.md + .autopilot/state.json already at phase "tasks_ready") so the
// mission reaches Code Review and Verification without running Planner or
// Plan Reviewer. Mirrors the seeding technique already proven by
// test-verifier-playwright-discovery.mjs.
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
const TASK_TEXT = "Do the playwright-runtime-relay checkpoint task";
const FEATURE_SLUG = "904-pw-runtime-relay-checkpoint";

function seedSpecKitTasksReadyState(repo, featureDir) {
  const state = {
    version: 1, phase: "tasks_ready", step: "tasks_ready", taskIndex: 0, phaseIndex: 0, attempt: 0,
    planningIntent: { kind: "new", reason: "no prior active request" },
    planningRequest: "Use the current project request/context.",
    planningDetection: {
      framework: "speckit", status: "complete", entryIndex: 7,
      evidence: { spec: true, plan: true, tasks: true },
      taskFiles: [path.join(featureDir, "tasks.md")],
      requiresValidation: true, confidence: "high", reason: "spec, plan, and tasks artifacts detected"
    },
    sessions: {},
    planningStateReview: { status: "passed", framework: "speckit", phase: null, at: new Date().toISOString() }
  };
  fs.mkdirSync(path.join(repo, ".autopilot"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(state, null, 2));
}

function makeSpecKitRepo(prefix) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `ap-pw-relay-${prefix}-`));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "pw-relay-test@example.invalid"]);
  git(repo, ["config", "user.name", "Playwright Relay Test"]);

  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  fs.writeFileSync(path.join(repo, "implementation.txt"), "not-yet-implemented\n");

  const workflowDir = path.join(repo, ".specify", "workflows", "speckit");
  fs.mkdirSync(workflowDir, { recursive: true });
  fs.writeFileSync(path.join(workflowDir, "workflow.yml"), WORKFLOW_YML);

  const featureDir = path.join(repo, "specs", FEATURE_SLUG);
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(path.join(repo, ".specify", "feature.json"), JSON.stringify({ feature_directory: `specs/${FEATURE_SLUG}` }));
  fs.writeFileSync(path.join(featureDir, "spec.md"), "# Spec\n\nPlaywright runtime relay checkpoint fixture feature.\n");
  fs.writeFileSync(path.join(featureDir, "plan.md"), "# Plan\n\nPlaywright runtime relay checkpoint fixture plan.\n");
  fs.writeFileSync(path.join(featureDir, "tasks.md"), `## Phase 1: ${TASK_TEXT}\n\n- [ ] ${TASK_TEXT}\n`);

  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init: complete speckit fixture at the implementation checkpoint"]);

  seedSpecKitTasksReadyState(repo, featureDir);
  return repo;
}

// A disposable, never-installed, never-executed "Playwright module": a
// package.json with the right name/version/entry file
// (discoverPlaywrightRuntime's own validation rules), plus a plain marker
// file directly under node_modules/ used to prove the read-only mount
// itself (distinct from the package content, which is also separately
// proven readable).
function installPlaywrightModule(repo) {
  const nodeModulesDir = path.join(repo, "node_modules");
  const pkgDir = path.join(nodeModulesDir, "playwright");
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "playwright", version: "1.2.3" }, null, 2));
  fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(nodeModulesDir, "MODULE_MARKER.txt"), "module-marker-content");
  return fs.realpathSync(nodeModulesDir);
}

// A disposable, never-executed placeholder "browser executable" under the
// package-local browser cache location discoverPlaywrightRuntime() itself
// looks for (node_modules/playwright-core/.local-browsers/...), plus a
// plain marker file directly under the cache root for the same read-only
// mount proof. The placeholder is chmod +x so the task 15.4C1 executable
// check accepts it as a candidate — it is never actually run by anything in
// this file.
function installBrowserCache(repo) {
  const browserRoot = path.join(repo, "node_modules", "playwright-core", ".local-browsers");
  const revDir = path.join(browserRoot, "chromium-1091", "chrome-linux");
  fs.mkdirSync(revDir, { recursive: true });
  const exePath = path.join(revDir, "chrome");
  fs.writeFileSync(exePath, "not a real binary\n");
  fs.chmodSync(exePath, 0o755);
  fs.writeFileSync(path.join(browserRoot, "BROWSER_MARKER.txt"), "browser-marker-content");
  return fs.realpathSync(browserRoot);
}

// Same fixture shape as installBrowserCache, but deliberately OUTSIDE
// node_modules (repo/standalone-browser-cache instead of the package-local
// node_modules/playwright-core/.local-browsers location) and discovered via
// the explicit PLAYWRIGHT_BROWSERS_PATH override rather than package-local
// inference. Scenario 3 (item 7) needs the browser fixture to survive an
// intentional module-directory deletion so it can prove that ONLY the
// invalidated directory is affected — a real install would keep its module
// and browser cache in the same node_modules tree, but nesting them there
// in this fixture would make the module-only deletion also destroy the
// browser marker, which would prove nothing about the deletion being
// module-scoped.
function installStandaloneBrowserCache(repo) {
  const browserRoot = path.join(repo, "standalone-browser-cache");
  const revDir = path.join(browserRoot, "chromium-1091", "chrome-linux");
  fs.mkdirSync(revDir, { recursive: true });
  const exePath = path.join(revDir, "chrome");
  fs.writeFileSync(exePath, "not a real binary\n");
  fs.chmodSync(exePath, 0o755);
  fs.writeFileSync(path.join(browserRoot, "BROWSER_MARKER.txt"), "browser-marker-content");
  return fs.realpathSync(browserRoot);
}

function writeConfig(repo) {
  const config = {
    schema_version: "3.0",
    project: { repo: ".", planning_framework: "speckit", state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs" },
    roles: Object.fromEntries(["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"].map(role => [
      role, { adapter: "cursor", model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null }
    ])),
    workflow: {
      specReview: true, planReview: true, analysisAfterTasks: false, implementationReview: true, finalReview: true,
      autoApproveSpec: false, autoApprovePlan: false, parallelIndependentTasks: false, gsdPlanningReview: false,
      relaySafety: { block_git_commit_push: true, verify_read_only_by_snapshot: true, capture_touched_files: true, persist_role_sessions: true }
    },
    gates: { commands: [], env_allowlist: [], require_reviewer: true, network_isolation: true },
    policy: {
      max_plan_revisions: 1, retry_delay_ms: 0, checkpoint_after_task: true, checkpoint_after_phase: true,
      require_human_commit: true, fail_closed_on_relay_violation: true,
      failure_budgets: { implementationFailureBudget: 1, verificationFailureBudget: 1, adapterRetryBudget: 1, infrastructureRetryBudget: 1 }
    },
    safety: { allow_git_commit: false, allow_git_push: false, allow_destructive_operations: false },
    planning: {
      speckit: { workflow_file: ".specify/workflows/speckit/workflow.yml", task_candidates: [".specify/tasks.md", "specs/*/tasks.md", "specs/*/tasks/*.md"] },
      gsd: {
        phase_root: ".planning/phases", run_plan_verify: true, run_state_validate: true, write_summary_artifacts: true,
        write_verification_artifacts: true, write_uat_artifact: true, use_gsd_tools_when_available: false,
        parallelization: { enabled: false, plan_level: false, task_level: false, max_concurrent_agents: 1, min_plans_for_parallel: 99 },
        planning_review: { enabled: false, review_after_each_stage: true, stages: ["discuss", "research", "plan", "plan-check"], max_revisions: 3, read_only_reviewer: true }
      }
    },
    capabilities: { project_defaults: [], role_requirements: {}, safety_denied: [], legacy_text_inference: false, verification: { browser: "native", require_browser: "when-task-requires" } }
  };
  fs.mkdirSync(path.join(repo, ".autopilot"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), JSON.stringify(config, null, 2));
}

// ---------------------------------------------------------------------
// Fake "cursor" adapter. implementer makes one harmless tracked-file
// change; code_reviewer and verifier both run the SAME observable-facts
// probe (module/browser mount presence, env vars, EROFS write attempts,
// repo/scratch write attempts) and report it verbatim as an
// AUTOPILOT_REVIEW finding, then unconditionally PASS — the test script
// (not the adapter) decides what each role SHOULD have observed. Nothing
// here requires, executes, or network-calls anything Playwright/Chromium
// related; it only reads files and attempts writes.
// ---------------------------------------------------------------------
const PROBE_BODY = `
function tryRead(p) { try { return fs.readFileSync(p, "utf8"); } catch (e) { return "ERR:" + (e.code || e.message); } }
function tryWrite(p) { try { fs.writeFileSync(p, "tampered"); return "SUCCEEDED"; } catch (e) { return "DENIED:" + (e.code || e.message); } }
const results = {};
results.moduleDirExists = fs.existsSync("/playwright/node_modules");
results.modulePkgRead = tryRead("/playwright/node_modules/playwright/package.json");
results.moduleMarkerWrite = tryWrite("/playwright/node_modules/MODULE_MARKER.txt");
results.moduleNewFileWrite = tryWrite("/playwright/node_modules/new-file-should-fail.txt");
results.browserCacheDirExists = fs.existsSync("/ms-playwright");
results.browserMarkerRead = tryRead("/ms-playwright/BROWSER_MARKER.txt");
results.browserMarkerWrite = tryWrite("/ms-playwright/BROWSER_MARKER.txt");
results.browserNewFileWrite = tryWrite("/ms-playwright/new-file-should-fail.txt");
results.repoWrite = tryWrite("/workspace/repository/implementation.txt");
results.repoContents = tryRead("/workspace/repository/implementation.txt");
results.scratchWrite = tryWrite("/workspace/scratch/probe-artifact.txt");
results.env = {
  AUTOPILOT_PLAYWRIGHT_MODULE_ROOT: process.env.AUTOPILOT_PLAYWRIGHT_MODULE_ROOT ?? null,
  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? null,
  NODE_PATH: process.env.NODE_PATH ?? null
};
console.log("AUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: ["PROBE_JSON:" + JSON.stringify(results)]}));
`;
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
  console.log("fake-pw-relay-cursor-agent 1.0.0");
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
  } else if (role === "code_reviewer" || role === "verifier") {
  ${PROBE_BODY}
  process.exit(0);
} else {
  console.log("AUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: []}));
  process.exit(0);
}
`;

function makeBin(prefix) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), `ap-pw-relay-bin-${prefix}-`));
  const binPath = path.join(binDir, "cursor-agent");
  fs.writeFileSync(binPath, `#!/usr/bin/env node\n${ADAPTER_SCRIPT}`);
  fs.chmodSync(binPath, 0o755);
  return binDir;
}

function runMission(autopilotPath, repo, binDir, { timeoutMs = 150000, extraEnv = {} } = {}) {
    // Strip any outer mission/gate git guard (PATH shim + hooks): the
  // nested mission installs its own, and every git call through both
  // ran the mission several times slower under the orchestrator gate.
  const base = withoutOuterGitGuard({...process.env});
  const env = {...base, ...extraEnv, PATH: `${binDir}:${base.PATH || ""}`};
  // Hermetic browser discovery: spreading process.env would reintroduce an
  // ambient PLAYWRIGHT_BROWSERS_PATH (e.g. the CI explicit browser cache)
  // that S1/S2 never installed — S1 proves package-local inference and S2
  // proves the no-runtime path, so neither may observe a machine-wide
  // browser cache. Delete it unless the scenario opted in via extraEnv (S3
  // sets its standalone fixture cache explicitly).
  if (!("PLAYWRIGHT_BROWSERS_PATH" in extraEnv)) delete env.PLAYWRIGHT_BROWSERS_PATH;
  const r = spawnSync(process.execPath, [autopilotPath, "run", "--repo", repo], { cwd: repo, encoding: "utf8", timeout: timeoutMs, shell: false, env });
  return { status: r.status, signal: r.signal, stdout: r.stdout || "", stderr: r.stderr || "", timedOut: r.error?.code === "ETIMEDOUT", error: r.error || null };
}

function readAllResults(repo) {
  const root = path.join(repo, ".autopilot");
  const files = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "result.json") files.push(full);
    }
  })(root);
  return files.map(file => ({ file, data: JSON.parse(fs.readFileSync(file, "utf8")) }));
}
function runSeqOf(resultFile) {
  return parseInt(path.basename(path.dirname(resultFile)).split("-")[0], 10) || 0;
}
function sortResultsBySeq(results) {
  return [...results].sort((a, b) => runSeqOf(a.file) - runSeqOf(b.file));
}
function findRunDirs(repo, role) {
  const root = path.join(repo, ".autopilot");
  const dirs = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.includes(`-${role}-`)) dirs.push(full);
        walk(full);
      }
    }
  })(root);
  return dirs;
}
function extractProbeJson(resultData) {
  const findings = resultData?.review?.findings || resultData?.verdict?.findings || [];
  for (const finding of findings) {
    if (typeof finding === "string" && finding.startsWith("PROBE_JSON:")) {
      try { return JSON.parse(finding.slice("PROBE_JSON:".length)); } catch { return null; }
    }
  }
  return null;
}

// =======================================================================
// Scenario 1: module + browser present (repo-local). Proves items 1-6, 8.
// =======================================================================
async function scenarioReady(binDir) {
  const label = "S1-ready";
  const repo = makeSpecKitRepo("ready");
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "ap-pw-relay-home-ready-"));
  const isolatedEnv = {
    HOME: isolatedHome, USERPROFILE: isolatedHome, LOCALAPPDATA: path.join(isolatedHome, "AppData", "Local")
  };
  try {
    writeConfig(repo);
    const moduleDir = installPlaywrightModule(repo);
    const browserRoot = installBrowserCache(repo);
    const moduleMarkerBefore = fs.readFileSync(path.join(moduleDir, "MODULE_MARKER.txt"), "utf8");
    const modulePkgBefore = fs.readFileSync(path.join(moduleDir, "playwright", "package.json"), "utf8");
    const browserMarkerBefore = fs.readFileSync(path.join(browserRoot, "BROWSER_MARKER.txt"), "utf8");
    const headBefore = git(repo, ["rev-parse", "HEAD"]);

    const result = runMission(CANONICAL_AUTOPILOT, repo, binDir, { extraEnv: isolatedEnv });
    if (!assertCleanRun(label, result)) return;
    check(`${label}: mission process exited 0`, result.status === 0, { status: result.status, stderrTail: result.stderr.slice(-1500) });

    const results = sortResultsBySeq(readAllResults(repo));
    const plannerRuns = results.filter(r => r.data.role === "planner" || r.data.role === "plan_reviewer");
    const implementerRuns = results.filter(r => r.data.role === "implementer");
    const codeReviewerRuns = results.filter(r => r.data.role === "code_reviewer");
    const verifierRuns = results.filter(r => r.data.role === "verifier");

    check(`${label}: no Planner/Plan Reviewer ran (seeded past planning)`, plannerRuns.length === 0, plannerRuns.map(r => r.data.role));
    if (!check(`${label}: at least one implementer run recorded`, implementerRuns.length > 0)) return;
    if (!check(`${label}: at least one code_reviewer run recorded`, codeReviewerRuns.length > 0)) return;
    if (!check(`${label}: at least one verifier run recorded`, verifierRuns.length > 0, { roles: results.map(r => r.data.role), tail: result.stdout.slice(-1500) + result.stderr.slice(-1500) })) return;

    const implResult = implementerRuns[0].data;
    const cr = codeReviewerRuns[0].data;
    const vv = verifierRuns[0].data;

    // ---- role ordering (item 5) ----
    check(`${label}: Code Reviewer ran before Verifier (run sequence)`, runSeqOf(codeReviewerRuns[0].file) < runSeqOf(verifierRuns[0].file), { crSeq: runSeqOf(codeReviewerRuns[0].file), vvSeq: runSeqOf(verifierRuns[0].file) });
    check(`${label}: Code Reviewer finished before Verifier started (timestamps)`, cr.finishedAt <= vv.startedAt, { crFinished: cr.finishedAt, vvStarted: vv.startedAt });
    check(`${label}: Code Reviewer completed with PASS`, cr.status === "completed" && cr.verdict?.decision === "PASS", cr.verdict);
    check(`${label}: Verifier completed with PASS`, vv.status === "completed" && vv.verdict?.decision === "PASS", vv.verdict);
    check(`${label}: Verifier ran inside the real read-only bubblewrap envelope`, vv.executionPlaneSafety?.envelopeApplied === true, vv.executionPlaneSafety);
    check(`${label}: Code Reviewer ran inside the real read-only bubblewrap envelope`, cr.executionPlaneSafety?.envelopeApplied === true, cr.executionPlaneSafety);
    check(`${label}: Implementer did NOT run inside a read-only envelope (writable role, unaffected by Playwright wiring)`, implResult.executionPlaneSafety?.envelopeApplied !== true, implResult.executionPlaneSafety);

    // ---- Code Reviewer role isolation (item 5) ----
    const crProbe = extractProbeJson(cr);
    if (check(`${label}: Code Reviewer probe JSON recovered`, crProbe != null, cr)) {
      check(`${label}: Code Reviewer did NOT receive the dedicated /playwright/node_modules mount`, crProbe.moduleDirExists === false, crProbe.moduleDirExists);
      check(`${label}: Code Reviewer did NOT receive AUTOPILOT_PLAYWRIGHT_MODULE_ROOT`, crProbe.env?.AUTOPILOT_PLAYWRIGHT_MODULE_ROOT == null, crProbe.env);
      check(`${label}: Code Reviewer repository write still denied EROFS (existing containment unaffected)`, /^DENIED:EROFS$/.test(crProbe.repoWrite || ""), crProbe.repoWrite);
      check(`${label}: Code Reviewer scratch write still succeeded`, crProbe.scratchWrite === "SUCCEEDED", crProbe.scratchWrite);
    }

    // ---- Verifier runtime visibility, env, read-only mounts (items 1-4) ----
    const vvProbe = extractProbeJson(vv);
    if (check(`${label}: Verifier probe JSON recovered`, vvProbe != null, vv)) {
      check(`${label}: /playwright/node_modules exists inside the Verifier`, vvProbe.moduleDirExists === true, vvProbe.moduleDirExists);
      check(`${label}: the fake Playwright package.json is readable inside the Verifier`, typeof vvProbe.modulePkgRead === "string" && vvProbe.modulePkgRead.includes("\"playwright\""), vvProbe.modulePkgRead);
      check(`${label}: /ms-playwright exists inside the Verifier`, vvProbe.browserCacheDirExists === true, vvProbe.browserCacheDirExists);
      check(`${label}: the fake browser-cache marker is readable inside the Verifier`, vvProbe.browserMarkerRead === "browser-marker-content", vvProbe.browserMarkerRead);

      check(`${label}: AUTOPILOT_PLAYWRIGHT_MODULE_ROOT === /playwright/node_modules inside the Verifier`, vvProbe.env?.AUTOPILOT_PLAYWRIGHT_MODULE_ROOT === "/playwright/node_modules", vvProbe.env);
      check(`${label}: PLAYWRIGHT_BROWSERS_PATH === /ms-playwright inside the Verifier`, vvProbe.env?.PLAYWRIGHT_BROWSERS_PATH === "/ms-playwright", vvProbe.env);
      // NODE_PATH is not on the relay's environment allowlist (relay-guards.mjs
      // SAFE_ENV_NAMES), so it is filtered out of the launch environment before
      // it ever reaches the envelope's own NODE_PATH-replacement logic and is
      // therefore never forwarded at all through this real relay path — the
      // replacement mechanism itself (when NODE_PATH IS present) is already
      // proven directly against buildExecutionEnvelope()/mapEnvironmentIntoEnvelope()
      // by test-playwright-envelope-wiring.mjs. Here we only assert the "if
      // present" half of item 2 plus the observed real-path fact: absent.
      check(`${label}: NODE_PATH is absent from the Verifier's environment (filtered upstream of the envelope) — if it were present it would have to be exactly the sandbox path`,
        vvProbe.env?.NODE_PATH == null || vvProbe.env?.NODE_PATH === "/playwright/node_modules", vvProbe.env);
      const envDump = JSON.stringify(vvProbe.env || {});
      check(`${label}: no host module/browser-cache directory path leaks into the Verifier's inspected environment values`,
        !envDump.includes(moduleDir) && !envDump.includes(browserRoot), envDump);

      check(`${label}: overwriting an existing module file fails EROFS`, /^DENIED:EROFS$/.test(vvProbe.moduleMarkerWrite || ""), vvProbe.moduleMarkerWrite);
      check(`${label}: creating a new module file fails EROFS`, /^DENIED:EROFS$/.test(vvProbe.moduleNewFileWrite || ""), vvProbe.moduleNewFileWrite);
      check(`${label}: overwriting an existing browser-cache file fails EROFS`, /^DENIED:EROFS$/.test(vvProbe.browserMarkerWrite || ""), vvProbe.browserMarkerWrite);
      check(`${label}: creating a new browser-cache file fails EROFS`, /^DENIED:EROFS$/.test(vvProbe.browserNewFileWrite || ""), vvProbe.browserNewFileWrite);

      check(`${label}: repository write still fails EROFS`, /^DENIED:EROFS$/.test(vvProbe.repoWrite || ""), vvProbe.repoWrite);
      check(`${label}: scratch write still succeeds`, vvProbe.scratchWrite === "SUCCEEDED", vvProbe.scratchWrite);
      check(`${label}: repository contents observed by the Verifier reflect only the Implementer's own change`, vvProbe.repoContents === "attempt 1\n", vvProbe.repoContents);
    }

    // ---- containment / no leaks / fixtures unchanged (item 4, 8) ----
    check(`${label}: the official repository HEAD is unchanged (Autopilot never commits)`, git(repo, ["rev-parse", "HEAD"]) === headBefore, { headBefore });
    check(`${label}: host module marker file byte-identical after the mission`, fs.readFileSync(path.join(moduleDir, "MODULE_MARKER.txt"), "utf8") === moduleMarkerBefore);
    check(`${label}: host Playwright package.json byte-identical after the mission`, fs.readFileSync(path.join(moduleDir, "playwright", "package.json"), "utf8") === modulePkgBefore);
    check(`${label}: host browser-cache marker byte-identical after the mission`, fs.readFileSync(path.join(browserRoot, "BROWSER_MARKER.txt"), "utf8") === browserMarkerBefore);
    check(`${label}: no stray write leaked onto the host module dir`, !fs.existsSync(path.join(moduleDir, "new-file-should-fail.txt")));
    check(`${label}: no stray write leaked onto the host browser cache dir`, !fs.existsSync(path.join(browserRoot, "new-file-should-fail.txt")));

    const verifierRunDir = path.dirname(verifierRuns[0].file);
    // The mission passed, so finalizeMissionComplete deleted every run's scratch dir
    // (mission-scratch-cleanup). The durable evidence that the Verifier's write went to
    // its own scratch is therefore the recorded probe result (SUCCEEDED against
    // /workspace/scratch, asserted above) plus: nothing leaked into the repo, and the
    // scratch dirs are gone.
    check(`${label}: the Verifier's scratch write was recorded as SUCCEEDED in its run result (own writable scratch)`, vvProbe?.scratchWrite === "SUCCEEDED", vvProbe?.scratchWrite);
    const runsRoot = path.dirname(path.dirname(verifierRuns[0].file));
    const leftoverScratch = fs.readdirSync(runsRoot, { withFileTypes: true }).filter(e => e.isDirectory() && fs.existsSync(path.join(runsRoot, e.name, "scratch"))).map(e => e.name);
    check(`${label}: scratch dirs were cleaned after the successful mission (no runs/*/scratch left)`, leftoverScratch.length === 0, leftoverScratch);
    check(`${label}: no probe artifact leaked into the repository tree`, !fs.existsSync(path.join(repo, "probe-artifact.txt")) && !fs.existsSync(path.join(repo, "new-file-should-fail.txt")));

    // ---- item 8: no actual browser execution / no network call ----
    check(`${label}: the placeholder browser executable was never modified (only read/mount-checked)`, fs.existsSync(path.join(browserRoot, "chromium-1091", "chrome-linux", "chrome")) && fs.readFileSync(path.join(browserRoot, "chromium-1091", "chrome-linux", "chrome"), "utf8") === "not a real binary\n");
    check(`${label}: the probe script never references networking primitives`, !/https?\.request|net\.connect|fetch\(|XMLHttpRequest/.test(PROBE_BODY), {});
    check(`${label}: the probe script never executes the discovered browser or module`, !/execFile|spawn\(|require\(["']child_process["']\)/.test(PROBE_BODY), {});
  } finally {
    cleanup(repo, isolatedHome);
  }
}

// =======================================================================
// Scenario 2: neither module nor browser present. Proves item 6 — a
// missing/unready runtime stays optional and never blocks non-browser
// verification.
// =======================================================================
async function scenarioUnavailable(binDir) {
  const label = "S2-unavailable";
  const repo = makeSpecKitRepo("unavailable");
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "ap-pw-relay-home-unavail-"));
  const isolatedEnv = { HOME: isolatedHome, USERPROFILE: isolatedHome, LOCALAPPDATA: path.join(isolatedHome, "AppData", "Local") };
  try {
    writeConfig(repo);
    const result = runMission(CANONICAL_AUTOPILOT, repo, binDir, { extraEnv: isolatedEnv });
    if (!assertCleanRun(label, result)) return;
    check(`${label}: mission process exited 0 (workflow completes normally without a browser runtime)`, result.status === 0, { status: result.status, stderrTail: result.stderr.slice(-1500) });

    const results = sortResultsBySeq(readAllResults(repo));
    const verifierRuns = results.filter(r => r.data.role === "verifier");
    if (!check(`${label}: at least one verifier run recorded`, verifierRuns.length > 0)) return;
    const vv = verifierRuns[0].data;
    check(`${label}: Verifier still completed with PASS (non-browser verification is never blocked)`, vv.status === "completed" && vv.verdict?.decision === "PASS", vv.verdict);

    const vvProbe = extractProbeJson(vv);
    if (check(`${label}: Verifier probe JSON recovered`, vvProbe != null, vv)) {
      check(`${label}: no dedicated Playwright module mount exists`, vvProbe.moduleDirExists === false, vvProbe.moduleDirExists);
      check(`${label}: AUTOPILOT_PLAYWRIGHT_MODULE_ROOT is absent`, vvProbe.env?.AUTOPILOT_PLAYWRIGHT_MODULE_ROOT == null, vvProbe.env);
      check(`${label}: repository write still fails EROFS (base containment unaffected)`, /^DENIED:EROFS$/.test(vvProbe.repoWrite || ""), vvProbe.repoWrite);
      check(`${label}: scratch write still succeeds`, vvProbe.scratchWrite === "SUCCEEDED", vvProbe.scratchWrite);
    }
  } finally {
    cleanup(repo, isolatedHome);
  }
}

// =======================================================================
// Scenario 3: readyForLaunchProbe=true but the module directory becomes
// invalid before launch-plan.mjs's own re-validation runs. Proves item 7
// (fail-closed) using the REAL, unmodified assembleAdapterLaunchPlan()/
// buildExecutionEnvelope() — reached through a DISPOSABLE COPY of the whole
// scripts/+adapters/ tree with exactly one narrow, env-gated, clearly
// commented hook applied to the COPY's autopilot.mjs (never to canonical
// scripts/autopilot.mjs, which this file never opens for writing). The hook
// is inert unless AUTOPILOT_TEST_INVALIDATE_PLAYWRIGHT_DIR is set, so it
// changes nothing about the copy's behavior in Scenarios 1/2 — it is only
// ever exercised here.
// =======================================================================
function makeDisposableProductionCopyWithInvalidationHook() {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "ap-pw-relay-copy-"));
  fs.cpSync(path.join(skillRootDir, "scripts"), path.join(dest, "scripts"), { recursive: true });
  fs.cpSync(path.join(skillRootDir, "adapters"), path.join(dest, "adapters"), { recursive: true });
  const autopilotCopyPath = path.join(dest, "scripts", "autopilot.mjs");
  const original = fs.readFileSync(autopilotCopyPath, "utf8");
  const anchor = "playwrightRuntimeForVerifier=discoverPlaywrightRuntime({repository:cwd,skillRoot});";
  if (!original.includes(anchor)) {
    cleanup(dest);
    throw new Error("test seam anchor not found in the copied autopilot.mjs — production source shifted; update this test's seam, not production");
  }
  const hook = `${anchor}
      if(process.env.AUTOPILOT_TEST_INVALIDATE_PLAYWRIGHT_DIR && playwrightRuntimeForVerifier && playwrightRuntimeForVerifier.readyForLaunchProbe===true){
        try{ fs.rmSync(playwrightRuntimeForVerifier.module.nodeModulesDir,{recursive:true,force:true}); }catch{}
      }`;
  const patched = original.split(anchor).join(hook);
  if (patched === original) {
    cleanup(dest);
    throw new Error("test seam patch did not apply to the copied autopilot.mjs");
  }
  fs.writeFileSync(autopilotCopyPath, patched);
  return { root: dest, autopilotPath: autopilotCopyPath };
}

async function scenarioInvalidReadyRuntime() {
  const label = "S3-invalid-ready";
  const repo = makeSpecKitRepo("invalid-ready");
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "ap-pw-relay-home-invalid-"));
  let copy = null;
  const binDir = makeBin("invalid-ready");
  try {
    copy = makeDisposableProductionCopyWithInvalidationHook();
    writeConfig(repo);
    // Standalone (non-nested) browser cache, discovered via the explicit
    // PLAYWRIGHT_BROWSERS_PATH override: this scenario's hook deletes only
    // the discovered MODULE directory, so keeping the browser fixture
    // outside that directory is what lets the assertions below prove the
    // invalidation is module-scoped rather than "everything happened to
    // disappear together".
    const browserRoot = installStandaloneBrowserCache(repo);
    const moduleDir = installPlaywrightModule(repo);
    const isolatedEnv = {
      HOME: isolatedHome, USERPROFILE: isolatedHome, LOCALAPPDATA: path.join(isolatedHome, "AppData", "Local"),
      AUTOPILOT_TEST_INVALIDATE_PLAYWRIGHT_DIR: "1",
      PLAYWRIGHT_BROWSERS_PATH: browserRoot
    };
    const browserMarkerBefore = fs.readFileSync(path.join(browserRoot, "BROWSER_MARKER.txt"), "utf8");
    const headBefore = git(repo, ["rev-parse", "HEAD"]);

    const result = runMission(copy.autopilotPath, repo, binDir, { extraEnv: isolatedEnv });
    if (!assertCleanRun(label, result)) return;

    check(`${label}: mission exits nonzero`, result.status !== 0, { status: result.status });
    const combined = `${result.stdout}\n${result.stderr}`;
    check(`${label}: the surfaced failure includes playwright_runtime_invalid`, combined.includes("playwright_runtime_invalid"), combined.slice(-2000));
    check(`${label}: the surfaced failure mentions the verifier role`, /verifier/i.test(combined), combined.slice(-2000));

    const results = readAllResults(repo);
    const verifierResults = results.filter(r => r.data.role === "verifier");
    check(`${label}: no verifier result.json was ever written (the Verifier subprocess was never launched)`, verifierResults.length === 0, verifierResults.map(r => r.file));

    const verifierRunDirs = findRunDirs(repo, "verifier");
    for (const dir of verifierRunDirs) {
      check(`${label}: the verifier run directory has no brief.txt (invocation never reached the spawn step)`, !fs.existsSync(path.join(dir, "brief.txt")), dir);
    }

    const codeReviewerResults = results.filter(r => r.data.role === "code_reviewer");
    check(`${label}: Code Reviewer still ran and PASSed before the Verifier launch was attempted (unaffected by the module-only invalidation)`,
      codeReviewerResults.length > 0 && codeReviewerResults[0].data.status === "completed" && codeReviewerResults[0].data.verdict?.decision === "PASS",
      codeReviewerResults[0]?.data);

    check(`${label}: the official repository HEAD is unchanged (no commit was ever created)`, git(repo, ["rev-parse", "HEAD"]) === headBefore, { headBefore });
    check(`${label}: the untouched browser-cache fixture remains byte-identical`, fs.existsSync(path.join(browserRoot, "BROWSER_MARKER.txt")) && fs.readFileSync(path.join(browserRoot, "BROWSER_MARKER.txt"), "utf8") === browserMarkerBefore, {});
    check(`${label}: the invalidated module directory is indeed gone (proves the seam actually fired, not a false pass)`, !fs.existsSync(moduleDir), moduleDir);
  } finally {
    cleanup(repo, isolatedHome, binDir, copy?.root);
  }
}

async function main() {
  const overallStart = Date.now();
  const leakPrefixes = ["ap-pw-relay-"];
  const preExisting = new Set(leakPrefixes.flatMap(p => {
    try { return fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(p)).map(n => path.join(os.tmpdir(), n)); }
    catch { return []; }
  }));

  const sharedBinDir = makeBin("shared");
  try {
    await scenarioReady(sharedBinDir);
    await scenarioUnavailable(sharedBinDir);
    await scenarioInvalidReadyRuntime();
  } finally {
    cleanup(sharedBinDir);
  }

  const leaked = leakPrefixes.flatMap(p => {
    try { return fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(p)).map(n => path.join(os.tmpdir(), n)); }
    catch { return []; }
  }).filter(p => !preExisting.has(p));
  check("no leftover fixture/bin/copy temp directories remain (beyond what pre-existed this run)", leaked.length === 0, leaked);

  const elapsedSeconds = ((Date.now() - overallStart) / 1000).toFixed(1);
  console.log(`\n(total runtime: ${elapsedSeconds}s, platform=${process.platform})`);

  if (failures) {
    console.error(`\n${failures} verifier playwright-runtime relay check(s) failed.`);
    process.exit(1);
  }
  console.log("\nverifier playwright-runtime relay integration PASS");
}

await main();
