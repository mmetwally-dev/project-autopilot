#!/usr/bin/env node
// Task 15.4C4B1: REAL Playwright execution through the REAL production
// Verifier runtime — `node scripts/autopilot.mjs run --repo <repo>` with the
// production runRelay() path, on BOTH platforms:
//
//   Native Windows: SpecKit disposable-copy compatibility mode. The Verifier
//     child receives the external skill-local Playwright module and the
//     Windows browser cache via the production bridge environment, launches
//     real Chromium, and writes artifacts only into disposable scratch.
//   WSL/Linux: bubblewrap strong mode. The Verifier child receives the
//     /playwright/node_modules and /ms-playwright read-only mounts plus the
//     production environment mapping, and launches real Chromium inside the
//     actual bubblewrap process.
//
// The browser run is REAL: headless Chromium launch, a local data: URL page
// with a unique title, title read-back, a genuine screenshot (PNG magic
// verified), a genuine Playwright trace archive (zip magic verified), and a
// clean close — with no external network request. Nothing is simulated and
// no screenshot/trace file is ever created manually.
//
// Fixtures are disposable Git/SpecKit repositories seeded past planning, so
// the mission runs Implementation -> Code Review PASS -> Verification.
// Fake adapters drive orchestration decisions only; the Verifier step imports
// the REAL installed `playwright` package (resolved through the runtime
// environment production injects, never a hardcoded path) and launches the
// REAL installed Chromium binary. A real browser failure fails this test;
// it is never silently downgraded to PASS.
//
// This file uses the production discoverPlaywrightRuntime() result only as a
// pre-flight readiness gate (fail loudly when the runtime is not provisioned).
// The Verifier derives its scratch directory from the stable runtime signal
// AUTOPILOT_GIT_GUARD_LOG (<scratch>/git-guard/blocked.log) — never by
// parsing prompt prose. Browser network use is instrumented and proven
// absent. All machine-specific discovery of earlier revisions is gone.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import {discoverPlaywrightRuntime} from "./playwright-runtime.mjs";
import {runWindowsProcessTreeBounded} from "./test-fixtures/windows-process-tree-runner.mjs";
import {runPosixBounded} from "./test-fixtures/posix-process-runner.mjs";

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
// Production pre-flight: the declared skill-local module AND a browser must
// both be discoverable through the REAL production discovery result before
// the mission runs. Anything else fails loudly with a provisioning message.
// ---------------------------------------------------------------------
const declaredPlaywrightVersion = JSON.parse(fs.readFileSync(path.join(skillRootDir, "package.json"), "utf8")).dependencies?.playwright || null;
const preflight = discoverPlaywrightRuntime({repository: null, skillRoot: skillRootDir});
if (!check("pre-flight: production discovery finds the declared skill-local module",
  preflight.module?.status === "discovered" && preflight.module?.source === "skill" && preflight.module?.package === "playwright",
  preflight.module)) {
  console.error(`\n${failures} playwright real-execution check(s) failed.`);
  process.exit(1);
}
if (!check("pre-flight: production discovery finds a provisioned browser (run npm run playwright:install if missing)",
  preflight.browser?.status === "discovered", preflight.browser)) {
  console.error(`\n${failures} playwright real-execution check(s) failed.`);
  process.exit(1);
}

// ---------------------------------------------------------------------
// Disposable SpecKit fixture seeded past planning.
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
const TASK_TEXT = "Do the real browser verification task";
const FEATURE_SLUG = "904-pw-real-run";

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
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `ap-pw-real-${prefix}-`));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "pw-real-run@example.invalid"]);
  git(repo, ["config", "user.name", "Playwright Real Run Test"]);
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  fs.writeFileSync(path.join(repo, "implementation.txt"), "not-yet-implemented\n");
  const workflowDir = path.join(repo, ".specify", "workflows", "speckit");
  fs.mkdirSync(workflowDir, {recursive: true});
  fs.writeFileSync(path.join(workflowDir, "workflow.yml"), WORKFLOW_YML);
  const featureDir = path.join(repo, "specs", FEATURE_SLUG);
  fs.mkdirSync(featureDir, {recursive: true});
  fs.writeFileSync(path.join(repo, ".specify", "feature.json"), JSON.stringify({feature_directory: `specs/${FEATURE_SLUG}`}));
  fs.writeFileSync(path.join(featureDir, "spec.md"), "# Spec\n\nReal browser run fixture feature.\n");
  fs.writeFileSync(path.join(featureDir, "plan.md"), "# Plan\n\nReal browser run fixture plan.\n");
  fs.writeFileSync(path.join(featureDir, "tasks.md"), `## Phase 1: ${TASK_TEXT}\n\n- [ ] ${TASK_TEXT}\n`);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init: real browser run fixture at the implementation checkpoint"]);
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
// Fake adapter. Orchestration decisions only — except the Verifier, which
// imports the REAL playwright package through the runtime root production
// injects into its environment and launches the REAL Chromium binary.
// ---------------------------------------------------------------------
const ADAPTER_SCRIPT = `
import fs from "node:fs";
import path from "node:path";
import {createRequire} from "node:module";

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
  console.log("fake-real-pw-agent 1.0.0");
  process.exit(0);
}

const PROMPT = await readStdin();
const firstLine = PROMPT.split(/\\r?\\n/, 1)[0] || "";
const role = firstLine.startsWith("ROLE=") ? firstLine.slice("ROLE=".length) : "";
const IS_WIN_CHILD = ${IS_WIN ? "true" : "false"};

function runtimeEnvProbe() {
  const nodePath = process.env.NODE_PATH || null;
  const ldPath = process.env.LD_LIBRARY_PATH || null;
  const mentionsRuntimeMount = (value) => typeof value === "string"
    && value.split(path.delimiter).some(entry => entry.replace(/\\\\/g, "/").includes("/playwright") || entry.replace(/\\\\/g, "/").includes("/ms-playwright"));
  const existsDir = (p) => { try { return fs.existsSync(p); } catch { return false; } };
  return {
    moduleRoot: process.env.AUTOPILOT_PLAYWRIGHT_MODULE_ROOT || null,
    browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH || null,
    nodePath,
    ldPath,
    nodePathHasRuntime: mentionsRuntimeMount(nodePath),
    ldPathHasRuntime: mentionsRuntimeMount(ldPath),
    pwd: process.env.PWD || null,
    home: process.env.HOME || null,
    cwd: process.cwd(),
    playwrightMountExists: existsDir("/playwright/node_modules"),
    msPlaywrightMountExists: existsDir("/ms-playwright")
  };
}
// Scratch is derived from the stable runtime signal production always
// supplies — AUTOPILOT_GIT_GUARD_LOG, structurally located at
// <effective scratch>/git-guard/blocked.log — never from prompt prose.
function scratchFromGuardLog() {
  const guardLog = process.env.AUTOPILOT_GIT_GUARD_LOG || null;
  if (typeof guardLog !== "string" || !guardLog || !path.isAbsolute(guardLog)) {
    return {ok: false, reason: "guard log missing or not absolute", guardLog};
  }
  if (path.basename(guardLog) !== "blocked.log") {
    return {ok: false, reason: "guard log basename is not blocked.log", guardLog};
  }
  const guardDir = path.dirname(guardLog);
  if (path.basename(guardDir) !== "git-guard") {
    return {ok: false, reason: "guard log parent is not git-guard", guardLog};
  }
  const scratch = path.dirname(guardDir);
  let st = null;
  try { st = fs.statSync(scratch); } catch { st = null; }
  if (!st || !st.isDirectory()) {
    return {ok: false, reason: "derived scratch directory does not exist", guardLog, scratch};
  }
  return {ok: true, scratch, guardLog};
}

  if (role === "implementer") {
    fs.writeFileSync("implementation.txt", "attempt 1\\n");
    console.log("PW_ENV_IMPLEMENTER=" + JSON.stringify(runtimeEnvProbe()));
    console.log("implementer ok");
    // TASK-19 Phase 4 (task 12): the per-task Implementer invocation must end
    // with the AUTOPILOT_TASK_RESULT sentinel as its final non-empty line.
    console.log("AUTOPILOT_TASK_RESULT=" + JSON.stringify({summary: "implementer ok", taskLocalCheck: {command: "true", status: "passed", exitCode: 0, summary: "fixture"}}));
    process.exit(0);
  }

if (role === "code_reviewer") {
  console.log("AUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: ["PW_ROLE_ENV=" + JSON.stringify(runtimeEnvProbe())]}));
  process.exit(0);
}

if (role === "verifier") {
  const derived = scratchFromGuardLog();
  const probe = {env: runtimeEnvProbe(), scratchDerivation: {ok: derived.ok, reason: derived.reason || null}};
  const fail = (message) => {
    console.log("AUTOPILOT_REVIEW=" + JSON.stringify({decision: "FAIL", findings: ["PW_BROWSER_FAIL:" + message, "PW_PROBE_B64:" + Buffer.from(JSON.stringify(probe), "utf8").toString("base64")]}));
    process.exit(0);
  };
  try {
    const moduleRoot = probe.env.moduleRoot;
    if (!moduleRoot) fail("verifier environment has no AUTOPILOT_PLAYWRIGHT_MODULE_ROOT");
    if (!derived.ok) fail("scratch derivation failed: " + (derived.reason || "unknown"));
    const scratch = derived.scratch;
    probe.scratchDerived = scratch;
    const pwRequire = createRequire(path.join(moduleRoot, "playwright", "package.json"));
    const playwrightPkg = pwRequire(path.join(moduleRoot, "playwright", "package.json"));
    probe.playwrightVersion = playwrightPkg.version;
    const {chromium} = pwRequire(path.join(moduleRoot, "playwright"));
    const marker = "PWREAL" + Date.now().toString(36) + process.pid.toString(36);
    const browser = await chromium.launch({headless: true, timeout: 60000});
    probe.launch = "OK";
    try {
      const context = await browser.newContext();
      // Every browser request is recorded; any external (non-local-scheme)
      // request aborts the run instead of succeeding silently.
      const seenRequests = [];
      const forbiddenRequests = [];
      const isForbiddenScheme = (url) => /^(https?|wss?):/i.test(url);
      context.on("request", (request) => {
        const url = request.url();
        seenRequests.push(url);
        if (isForbiddenScheme(url)) forbiddenRequests.push(url);
      });
      await context.route(/^(https?|wss?):\\/\\//, async (route) => {
        forbiddenRequests.push("ROUTE:" + route.request().url());
        await route.abort();
      });
      const page = await context.newPage();
      await page.goto("data:text/html,<title>" + marker + "</title><body>real-browser-probe</body>");
      probe.marker = marker;
      probe.title = await page.title();
      probe.seenRequests = seenRequests;
      probe.forbiddenRequests = forbiddenRequests;
      if (forbiddenRequests.length > 0) throw new Error("external browser request observed: " + forbiddenRequests[0]);
      const shotPath = path.join(scratch, "pw-real-shot-" + process.pid + ".png");
      const tracePath = path.join(scratch, "pw-real-trace-" + process.pid + ".zip");
      probe.artifactsInsideScratch = shotPath.startsWith(scratch + path.sep) && tracePath.startsWith(scratch + path.sep);
      if (!probe.artifactsInsideScratch) throw new Error("artifact destination escapes the derived scratch directory");
      let shotError = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await new Promise(r => setTimeout(r, 400));
          await page.screenshot({path: shotPath, timeout: 30000});
          shotError = null;
          break;
        } catch (e) {
          shotError = e;
        }
      }
      if (shotError) throw shotError;
      const shotBytes = fs.readFileSync(shotPath);
      probe.shotBytes = shotBytes.length;
      probe.shotMagic = Buffer.from(shotBytes.subarray(0, 4)).toString("hex");
      await context.tracing.start({screenshots: true, snapshots: true});
      await page.goto("data:text/html,<title>" + marker + "-trace</title><body>trace-pass</body>");
      await context.tracing.stop({path: tracePath});
      const traceBytes = fs.readFileSync(tracePath);
      probe.traceBytes = traceBytes.length;
      probe.traceMagic = Buffer.from(traceBytes.subarray(0, 2)).toString("hex");
      await context.close();
    } finally {
      await browser.close();
    }
    probe.closed = "yes";
    try {
      fs.writeFileSync(path.join(process.cwd(), "pw-repo-write-probe.txt"), "written-by-verifier");
      probe.repoWrite = "SUCCEEDED";
    } catch (e) {
      probe.repoWrite = "DENIED:" + (e.code || e.message);
    }
    if (!IS_WIN_CHILD) {
      try {
        fs.writeFileSync(path.join(moduleRoot, "pw-module-write-probe.txt"), "x");
        probe.moduleWrite = "SUCCEEDED";
      } catch (e) {
        probe.moduleWrite = "DENIED:" + (e.code || e.message);
      }
      const browsersPath = probe.env.browsersPath;
      if (browsersPath) {
        try {
          fs.writeFileSync(path.join(browsersPath, "pw-cache-write-probe.txt"), "x");
          probe.cacheWrite = "SUCCEEDED";
        } catch (e) {
          probe.cacheWrite = "DENIED:" + (e.code || e.message);
        }
      }
    }
    console.log("AUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: ["PW_PROBE_B64:" + Buffer.from(JSON.stringify(probe), "utf8").toString("base64")]}));
    process.exit(0);
  } catch (e) {
    fail("real browser execution failed: " + (e && e.message ? String(e.message).split("\\n")[0] : String(e)));
  }
}

console.error("fake-real-pw-adapter: unknown ROLE '" + role + "'");
process.exit(1);
`;

function makeBin(prefix) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), `ap-pw-real-bin-${prefix}-`));
  if (IS_WIN) {
    const scriptPath = path.join(binDir, "real-pw-adapter.mjs");
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

function runMission(repo, binDir, {timeoutMs}) {
  const delimiter = IS_WIN ? ";" : ":";
    // Strip any outer mission/gate git guard (PATH shim + hooks): the
  // nested mission installs its own, and every git call through both
  // ran the mission several times slower under the orchestrator gate.
  const base = withoutOuterGitGuard({...process.env});
  const env = {...base, PATH: `${binDir}${delimiter}${base.PATH || ""}`};
  if (IS_WIN) {
    return runWindowsProcessTreeBounded(process.execPath, [CANONICAL_AUTOPILOT, "run", "--repo", repo], {cwd: repo, env, timeoutMs});
  }
  // Genuinely bounded POSIX runner: wall-clock deadline, process-group
  // SIGTERM/SIGKILL escalation, byte-capped output, confirmed tree cleanup.
  return runPosixBounded(process.execPath, [CANONICAL_AUTOPILOT, "run", "--repo", repo],
    {cwd: repo, env, timeoutMs, killGraceMs: 2000, backstopMs: 5000, maxOutputBytes: 4 * 1024 * 1024});
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
function readAllStdoutLogs(repo) {
  const root = path.join(repo, ".autopilot");
  const out = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "stdout.log") out.push(fs.readFileSync(full, "utf8"));
    }
  })(root);
  return out.join("\n");
}
function extractFinding(result, prefix) {
  const findings = result?.review?.findings || result?.verdict?.findings || [];
  for (const finding of findings) {
    if (typeof finding === "string" && finding.startsWith(prefix)) return finding.slice(prefix.length);
  }
  return null;
}
function decodeProbe(result) {
  const b64 = extractFinding(result, "PW_PROBE_B64:");
  if (!b64) return null;
  try { return JSON.parse(Buffer.from(b64, "base64").toString("utf8")); }
  catch { return null; }
}

async function runRealRun(binDir, repo, tasksFile) {
    writeConfig(repo);
    const officialRepoReal = fs.realpathSync(repo);
    const headBefore = git(repo, ["rev-parse", "HEAD"]);

    const result = await runMission(repo, binDir, {timeoutMs: IS_WIN ? 300000 : 240000});
    if (!assertCleanRun("mission", result)) return;
    const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`;

    const results = sortResultsBySeq(readAllResults(repo));
    const plannerRuns = results.filter(r => r.data.role === "planner" || r.data.role === "plan_reviewer");
    const implementerRuns = results.filter(r => r.data.role === "implementer");
    const codeReviewerRuns = results.filter(r => r.data.role === "code_reviewer");
    const verifierRuns = results.filter(r => r.data.role === "verifier");

    check("no planner or plan_reviewer ran (seeded past planning)", plannerRuns.length === 0, results.map(r => r.data.role));
    if (!check("at least one verifier run recorded", verifierRuns.length > 0, {roles: results.map(r => r.data.role), tail: combinedOutput.slice(-2000)})) return;
    if (!check("implementer and code_reviewer runs recorded", implementerRuns.length > 0 && codeReviewerRuns.length > 0, results.map(r => r.data.role))) return;

    // ---- Verifier ordering: implementer -> code_review PASS -> verifier ----
    const firstCR = codeReviewerRuns[0];
    const firstVerifier = verifierRuns[0];
    check("first Code Review returned PASS", firstCR.data.status === "completed" && firstCR.data.verdict?.decision === "PASS", firstCR.data.verdict);
    check("no verifier run occurs before the Code Review PASS",
      results.indexOf(firstVerifier) > results.indexOf(firstCR), {});
    check("ordering is implementer -> code_reviewer -> verifier",
      results.indexOf(implementerRuns[0]) < results.indexOf(firstCR) && results.indexOf(firstCR) < results.indexOf(firstVerifier), {});
    check("verifier completed with PASS (a real browser failure is never downgraded)",
      firstVerifier.data.status === "completed" && firstVerifier.data.verdict?.decision === "PASS", firstVerifier.data.verdict);

    const probe = decodeProbe(firstVerifier.data);
    if (!check("verifier browser probe recovered from findings", !!probe, firstVerifier.data)) return;

    // ---- Stable scratch derivation (no prompt-prose parsing) ----
    check("scratch derived from the guard-log runtime signal",
      probe.scratchDerivation?.ok === true && typeof probe.scratchDerived === "string" && path.isAbsolute(probe.scratchDerived),
      probe.scratchDerivation);
    check("screenshot and trace stayed inside the derived scratch directory",
      probe.artifactsInsideScratch === true, probe);

    // ---- Real browser execution ----
    check("real Chromium launched headless", probe.launch === "OK", probe);
    check("unique marker round-tripped through a real page load (no simulation)",
      typeof probe.marker === "string" && probe.marker.startsWith("PWREAL") && probe.title === probe.marker, {marker: probe.marker, title: probe.title});
    check("no forbidden external browser request was observed",
      Array.isArray(probe.forbiddenRequests) && probe.forbiddenRequests.length === 0, probe.forbiddenRequests);
    check("only local data: navigation was used",
      Array.isArray(probe.seenRequests) && probe.seenRequests.every(u => typeof u === "string" && u.startsWith("data:")), probe.seenRequests);
    check("real screenshot produced in scratch (PNG magic, non-empty)",
      typeof probe.shotBytes === "number" && probe.shotBytes > 0 && probe.shotMagic === "89504e47", {shotBytes: probe.shotBytes, shotMagic: probe.shotMagic});
    check("real Playwright trace archive produced in scratch (zip magic, non-empty)",
      typeof probe.traceBytes === "number" && probe.traceBytes > 0 && probe.traceMagic === "504b", {traceBytes: probe.traceBytes, traceMagic: probe.traceMagic});
    check("browser closed cleanly", probe.closed === "yes", probe);
    check("verifier used the declared installed playwright package",
      probe.playwrightVersion === declaredPlaywrightVersion, {playwrightVersion: probe.playwrightVersion, declared: declaredPlaywrightVersion});

    // ---- Role isolation: the discovered runtime is verifier-only ----
    // Dedicated delivery (module root, /playwright mount, and on Windows the
    // bridged browser path) must never reach Implementer or Code Reviewer.
    // NODE_PATH/LD_LIBRARY_PATH must not smuggle a runtime mount either.
    const assertNoDedicatedRuntime = (label, env) => {
      check(`${label} received no Playwright module root`, env.moduleRoot === null, env);
      check(`${label} saw no /playwright mount`, env.playwrightMountExists === false, env);
      check(`${label} NODE_PATH points at no runtime mount`, env.nodePathHasRuntime === false, env.nodePath);
      check(`${label} LD_LIBRARY_PATH points at no runtime mount`, env.ldPathHasRuntime === false, env.ldPath);
    };
    const implementerLog = readAllStdoutLogs(repo);
    const implEnvLine = implementerLog.split(/\r?\n/).find(l => l.startsWith("PW_ENV_IMPLEMENTER="));
    const implEnv = implEnvLine ? JSON.parse(implEnvLine.slice("PW_ENV_IMPLEMENTER=".length)) : null;
    if (!check("implementer environment probe recovered", !!implEnv, {})) return;
    assertNoDedicatedRuntime("implementer", implEnv);
    check("implementer received no browser cache path", implEnv.browsersPath === null, implEnv);
    check("implementer saw no browser-cache mount", implEnv.msPlaywrightMountExists === false, implEnv);
    const crEnvRaw = extractFinding(firstCR.data, "PW_ROLE_ENV=");
    const crEnv = crEnvRaw ? JSON.parse(crEnvRaw) : null;
    if (!check("code reviewer environment probe recovered", !!crEnv, firstCR.data)) return;
    assertNoDedicatedRuntime("code reviewer", crEnv);
    if (IS_WIN) {
      check("code reviewer received no browser cache path (Windows)", crEnv.browsersPath === null, crEnv);
      check("code reviewer saw no browser-cache mount (Windows)", crEnv.msPlaywrightMountExists === false, crEnv);
    } else {
      // No legacy fallback remains: a null-runtime caller mounts nothing,
      // so the WSL code reviewer observes no browser cache at all.
      check("code reviewer received no browser cache path", crEnv.browsersPath === null, crEnv);
      check("code reviewer saw no browser-cache mount", crEnv.msPlaywrightMountExists === false, crEnv);
    }

    if (IS_WIN) {
      // ---- Native Windows disposable-copy requirements ----
      const skillModuleRoot = fs.realpathSync(path.join(skillRootDir, "node_modules"));
      check("verifier received the external skill-local Playwright module",
        typeof probe.env.moduleRoot === "string" && probe.env.moduleRoot.toLowerCase() === skillModuleRoot.toLowerCase(),
        {moduleRoot: probe.env.moduleRoot, skillModuleRoot});
      check("verifier received the Windows browser cache",
        typeof probe.env.browsersPath === "string" && fs.existsSync(probe.env.browsersPath)
          && path.basename(probe.env.browsersPath).toLowerCase() === "ms-playwright",
        probe.env.browsersPath);
      check("verifier relative write landed only in the disposable copy (official repo has no probe file)",
        probe.repoWrite === "SUCCEEDED" && !fs.existsSync(path.join(repo, "pw-repo-write-probe.txt")),
        {repoWrite: probe.repoWrite});
      check("official implementation.txt holds the implementer bytes only",
        fs.readFileSync(path.join(repo, "implementation.txt"), "utf8") === "attempt 1\n", {});
      check("official repository HEAD unchanged (content and Git metadata intact)",
        git(repo, ["rev-parse", "HEAD"]) === headBefore, {headBefore});
      check("disposable scratch removed after completion",
        typeof firstVerifier.data.scratchDir === "string" && !fs.existsSync(firstVerifier.data.scratchDir), firstVerifier.data.scratchDir);
      check("disposable repository copy removed after completion",
        typeof probe.env.cwd === "string" && probe.env.cwd.length > 0 && !fs.existsSync(probe.env.cwd), probe.env.cwd);
      const safety = firstVerifier.data.executionPlaneSafety || {};
      check("execution-plane metadata reports compatibility (never OS-enforced)",
        safety.mechanism === "windows-disposable-copy" && safety.strength === "compatibility", safety);
      check("no bubblewrap envelope claimed on Windows", safety.envelopeApplied === false, safety);
    } else {
      // ---- WSL bubblewrap requirements ----
      check("verifier received /playwright/node_modules", probe.env.moduleRoot === "/playwright/node_modules", probe.env.moduleRoot);
      check("verifier received /ms-playwright", probe.env.browsersPath === "/ms-playwright", probe.env.browsersPath);
      check("repository write denied with EROFS", /^DENIED:EROFS$/.test(probe.repoWrite || ""), probe.repoWrite);
      check("module write denied with EROFS", /^DENIED:EROFS$/.test(probe.moduleWrite || ""), probe.moduleWrite);
      check("browser-cache write denied with EROFS", /^DENIED:EROFS$/.test(probe.cacheWrite || ""), probe.cacheWrite);
      const hostStrings = [officialRepoReal, fs.realpathSync(skillRootDir)];
      const watched = [probe.env.pwd, probe.env.home, probe.env.browsersPath, probe.env.moduleRoot, probe.env.nodePath, probe.env.ldPath];
      check("no host module/cache paths appear in the Verifier environment",
        watched.every(v => v == null || !hostStrings.some(h => String(v).includes(h))), {watched});
      check("official repository HEAD unchanged", git(repo, ["rev-parse", "HEAD"]) === headBefore, {headBefore});
      check("official implementation.txt unchanged", fs.readFileSync(path.join(repo, "implementation.txt"), "utf8") === "attempt 1\n", {});
    }

    // ---- Mission completion ----
    check("phase task marked [x] after real Verification PASS",
      fs.readFileSync(tasksFile, "utf8").includes(`- [x] ${TASK_TEXT}`), fs.readFileSync(tasksFile, "utf8"));
    check("mission completed successfully", result.status === 0 && /ALL WORK COMPLETE/.test(combinedOutput),
      {status: result.status, tail: combinedOutput.slice(-800)});
}

async function main() {
  const overallStart = Date.now();
  const leakPrefixes = ["ap-pw-real-", "ap-pw-real-bin-", "autopilot-reviewer-"];
  const preExisting = new Set(leakPrefixes.flatMap(p => {
    try { return fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(p)).map(n => path.join(os.tmpdir(), n)); }
    catch { return []; }
  }));

  const binDir = makeBin("shared");
  if (IS_WIN) {
    const warmup = await runWindowsProcessTreeBounded("cmd.exe", ["/d", "/s", "/c", path.join(binDir, "cursor-agent.cmd"), "--version"], {timeoutMs: 60000});
    check("warmup: the shared adapter binary responds to --version before any scenario starts", warmup.status === 0 && !warmup.timedOut, warmup);
  }
  // Syntax gate: the generated adapter must parse before any mission runs,
  // so template-escaping mistakes fail here instead of inside all five roles.
  {
    const syntaxProbe = path.join(os.tmpdir(), `ap-pw-real-syntax-${process.pid}.mjs`);
    fs.writeFileSync(syntaxProbe, ADAPTER_SCRIPT);
    const syntaxResult = spawnSync(process.execPath, ["--check", syntaxProbe], {encoding: "utf8", stdio: "pipe", shell: false});
    try { fs.rmSync(syntaxProbe, {force: true}); } catch { /* best-effort */ }
    if (!check("fake adapter script parses (syntax gate)", syntaxResult.status === 0, syntaxResult.stderr)) {
      cleanup(binDir);
      console.error(`\n${failures} playwright real-execution check(s) failed.`);
      process.exit(1);
    }
  }

  const {repo, tasksFile} = makeSpecKitRepo("run");
  try {
    await runRealRun(binDir, repo, tasksFile);
  } finally {
    cleanup(repo, binDir);
  }

  const leakedFixtures = leakPrefixes.flatMap(p => {
    try { return fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(p)).map(n => path.join(os.tmpdir(), n)); }
    catch { return []; }
  }).filter(p => !preExisting.has(p));
  check("no leftover fixture/bin/disposable-workspace temp directories remain", leakedFixtures.length === 0, leakedFixtures);

  const elapsedSeconds = ((Date.now() - overallStart) / 1000).toFixed(1);
  console.log(`\n(total runtime: ${elapsedSeconds}s, platform=${process.platform})`);

  if (failures) {
    console.error(`\n${failures} playwright real-execution check(s) failed.`);
    process.exit(1);
  }
  console.log("\nplaywright real browser execution PASS");
}

await main();
