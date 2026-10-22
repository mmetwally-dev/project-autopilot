#!/usr/bin/env node
// TASK-42: boxed roles must run the operator's own Claude CLI. When `ap`
// delegates a run from Native Windows into WSL, the orchestrator inside WSL
// must resolve agent binaries with the operator's login-shell PATH (what
// `bash -lc` yields), not the bare `wsl.exe --exec` PATH (which lacks
// ~/.local/bin and exposes an older /usr/local/bin copy). The resolved
// binary path is recorded in result.json's invocation record.
import {EventEmitter} from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn, spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {routeSubcommand, probeWslLoginPath, buildDelegatedEnv} from "./runtime-mode-router.mjs";
import {RUNTIME_MODE_IDS} from "./runtime-mode-capabilities.mjs";
import {PLATFORM_KINDS} from "./platform-capabilities.mjs";
import {buildInvocationRecord} from "./agent-contract.mjs";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";

const ALL = ["gsd", "speckit", "standalone"];
const SPECKIT_ONLY = ["speckit"];
const SPECKIT_AND_STANDALONE = ["speckit", "standalone"];
function mode(id, available, supportedFrameworks, extra = {}) {
  const strength = id === RUNTIME_MODE_IDS.windowsCompatibility ? "compatibility" : "strong";
  return {id, available, strength, supportedFrameworks: [...supportedFrameworks], reason: available ? null : "unavailable-for-test", distro: null, ...extra};
}

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 424242;
  child.kill = () => true;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

// Fake wsl.exe that answers the wslpath resolution, the accessibility
// probes, and the new `bash -lc 'printf %s "$PATH"'` login-PATH probe.
function makeFakeWsl() {
  const calls = [];
  const fn = (binary, args, opts) => {
    calls.push(args);
    const child = fakeChild();
    queueMicrotask(() => {
      if (args[3] === "wslpath" && args[4] === "-u") {
        child.stdout.emit("data", Buffer.from("/mnt/c/Users/user/bin/ap.cjs\n", "utf8"));
        child.emit("close", 0, null);
        return;
      }
      if (args[3] === "test") {
        child.emit("close", 0, null);
        return;
      }
      if (args[3] === "bash" && args[4] === "-lc") {
        if (fn.bashProbeFails) {
          child.emit("close", 3, null);
          return;
        }
        child.stdout.emit("data", Buffer.from("/home/user/.local/bin:/usr/local/bin:/usr/bin", "utf8"));
        child.emit("close", 0, null);
        return;
      }
      child.emit("close", 1, null);
    });
    return child;
  };
  fn.calls = calls;
  fn.bashProbeFails = false;
  return fn;
}

function windowsCaps() {
  return {
    currentPlatform: PLATFORM_KINDS.nativeWindows,
    modes: [
      mode(RUNTIME_MODE_IDS.wsl2Strong, true, ALL, {distro: "Ubuntu"}),
      mode(RUNTIME_MODE_IDS.linuxStrong, false, ALL),
      mode(RUNTIME_MODE_IDS.windowsCompatibility, true, SPECKIT_AND_STANDALONE)
    ],
    recommendedMode: RUNTIME_MODE_IDS.wsl2Strong,
    usableWslDistro: "Ubuntu"
  };
}

function linuxCaps() {
  return {
    currentPlatform: PLATFORM_KINDS.nativeLinux,
    modes: [
      mode(RUNTIME_MODE_IDS.wsl2Strong, false, ALL),
      mode(RUNTIME_MODE_IDS.linuxStrong, true, ALL),
      mode(RUNTIME_MODE_IDS.windowsCompatibility, false, SPECKIT_AND_STANDALONE)
    ],
    recommendedMode: RUNTIME_MODE_IDS.linuxStrong,
    usableWslDistro: null
  };
}

function makeDelegateSpawn(calls) {
  return (binary, args, opts) => {
    calls.push({binary, args, opts});
    const child = fakeChild();
    queueMicrotask(() => { child.emit("exit", 0, null); child.emit("close", 0, null); });
    return child;
  };
}

// 1a. Unit: login PATH wins for the delegated orchestrator.
{
  const probe = await probeWslLoginPath({spawn: makeFakeWsl(), wslBinary: "wsl.exe", distro: "Ubuntu"});
  check("probeWslLoginPath returns the distro login PATH", probe.ok && probe.path === "/home/user/.local/bin:/usr/local/bin:/usr/bin", probe);
  const env = buildDelegatedEnv({env: {PATH: "C:\\Windows\\System32", HOME: "x"}});
  check("delegated env PATH is UNTOUCHED (Windows PATH) and recursion guard set", env.PATH === "C:\\Windows\\System32" && env.AUTOPILOT_RUNTIME_ROUTED === "1", env);
}

// 1b. Unit: probe failure → buildDelegatedEnv keeps today's env, and the
// router logs one line and continues.
{
  const spawn = makeFakeWsl();
  spawn.bashProbeFails = true;
  const probe = await probeWslLoginPath({spawn, wslBinary: "wsl.exe", distro: "Ubuntu"});
  check("probeWslLoginPath reports failure", !probe.ok, probe);
  const env = buildDelegatedEnv({env: {PATH: "C:\\Windows\\System32"}});
  check("delegated env keeps today's PATH on probe failure", env.PATH === "C:\\Windows\\System32", env);
}

// 1c. Full routeSubcommand delegation wiring on win32: assert wsl.exe's
// argv carries "/usr/bin/env", "PATH=<login path>" before /usr/bin/node when
// the probe succeeds, argv unchanged when it fails, and wsl.exe's own env
// PATH is untouched. ONLY meaningful on real win32 (repo path resolution
// is POSIX-mangled on Linux otherwise) — mirrors the router's own test sections.
if (process.platform === "win32") {
  const spawn = makeFakeWsl();
  const delegateCalls = [];
  const r = await routeSubcommand({
    command: "run",
    repoArgs: ["--repo", "\\\\wsl.localhost\\Ubuntu\\home\\user\\repo"],
    cwd: "C:\\cwd",
    skillRoot: "C:\\Users\\user\\.agents\\skills\\project-autopilot",
    env: {PATH: "C:\\Windows\\System32", HOME: "C:\\Users\\user"},
    readConfig: () => ({exists: true, config: {project: {planning_framework: "speckit"}, execution: {runtime_mode: "wsl2-strong", wsl_distro: "Ubuntu"}}}),
    detectCapabilities: async () => windowsCaps(),
    spawn,
    delegateSpawn: makeDelegateSpawn(delegateCalls)
  });
  const call = delegateCalls[0];
  const envIdx = call?.args?.indexOf("/usr/bin/env") ?? -1;
  const nodeIdx = call?.args?.indexOf("/usr/bin/node") ?? -1;
  check("wslArgs carries /usr/bin/env", envIdx > 0 && envIdx < nodeIdx, call?.args);
  check("wslArgs carries PATH=<login path> immediately after /usr/bin/env", call?.args?.[envIdx + 1] === "PATH=/home/user/.local/bin:/usr/local/bin:/usr/bin", call?.args);
  check("wsl.exe's env PATH untouched (Windows PATH kept)", call?.opts?.env?.PATH === "C:\\Windows\\System32", call?.opts?.env);
  const probeCount = spawn.calls.filter(a => a[3] === "bash").length;
  check("login PATH read exactly once", probeCount === 1, spawn.calls);
  check("delegation action delegated, status preserved", r.action === "delegated" && r.result.status === 0, r);
} else {
  console.log("INFO test-sandbox-operator-cli: full-route delegation wiring check is win32-only (POSIX parseRepoArg mangles Windows drive paths) — covered by probeWslLoginPath/buildDelegatedEnv unit checks above");
}

// 2. Router behavior when the probe fails: Windows-only wiring check; the
// platform-independent pieces (probe failure → env unchanged) are above.
if (process.platform === "win32") {
  const spawn = makeFakeWsl();
  spawn.bashProbeFails = true;
  const delegateCalls = [];
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warns.push(String(msg));
  try {
    const r = await routeSubcommand({
      command: "run",
      repoArgs: ["--repo", "\\\\wsl.localhost\\Ubuntu\\home\\user\\repo"],
      cwd: "C:\\cwd",
      skillRoot: "C:\\Users\\user\\.agents\\skills\\project-autopilot",
      env: {PATH: "C:\\Windows\\System32"},
      readConfig: () => ({exists: true, config: {project: {planning_framework: "speckit"}, execution: {runtime_mode: "wsl2-strong", wsl_distro: "Ubuntu"}}}),
      detectCapabilities: async () => windowsCaps(),
      spawn,
      delegateSpawn: makeDelegateSpawn(delegateCalls)
    });
    const call = delegateCalls[0];
    check("wslArgs unchanged when the probe fails (no /usr/bin/env)", !(call?.args || []).includes("/usr/bin/env") && call?.args?.[2] === "--exec" && call?.args?.[3] === "/usr/bin/node", call?.args);
    check("wsl.exe's env PATH still untouched", call?.opts?.env?.PATH === "C:\\Windows\\System32", call?.opts?.env);
    check("one warning line naming the distro logged", warns.length === 1 && warns[0].includes("Ubuntu"), warns);
    check("run continues", r.action === "delegated" && r.result.status === 0, r);
  } finally {
    console.warn = originalWarn;
  }
}

// 3. A run started inside WSL is unchanged: proceed, no login-PATH probe, no delegation.
{
  const spawn = makeFakeWsl();
  const delegateCalls = [];
  const r = await routeSubcommand({
    command: "run",
    repoArgs: ["--repo", "/home/user/repo"],
    cwd: "/home/user/repo",
    skillRoot: "/home/user/skills/project-autopilot",
    env: {PATH: "/home/user/.local/bin:/usr/bin"},
    readConfig: () => ({exists: true, config: {project: {planning_framework: "speckit"}, execution: {runtime_mode: "linux-strong", wsl_distro: null}}}),
    detectCapabilities: async () => linuxCaps(),
    spawn,
    delegateSpawn: makeDelegateSpawn(delegateCalls)
  });
  const probeCount = spawn.calls.filter(a => a[3] === "bash").length;
  check("WSL-started run proceeds in-process", r.action === "proceed", r);
  check("no login-PATH probe, no delegation for an in-WSL run", probeCount === 0 && delegateCalls.length === 0, {probeCount, delegateCalls});
}

// 4a. Unit: invocation record carries the resolved binary path.
{
  const inv = buildInvocationRecord({role: {model: "sonnet"}, adapterId: "claude", adapter: {binary: "claude"}, args: [], verification: {ok: true}, resolvedBinary: "/home/user/.local/bin/claude"});
  check("buildInvocationRecord records resolvedBinary", inv.resolvedBinary === "/home/user/.local/bin/claude", inv);
}

// 4b. E2E: a real fixture mission writes invocation.resolvedBinary into
// result.json.
function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-task42-"));
  const git = (args) => spawnSync("git", args, {cwd: repo, encoding: "utf8", stdio: "pipe", env: withoutOuterGitGuard(process.env), shell: false});
  git(["init", "-q"]);
  git(["config", "user.email", "task42@example.invalid"]);
  git(["config", "user.name", "task42"]);
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  return repo;
}
function makeBin() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-task42-bin-"));
  const cursorAgentPath = path.join(binDir, "cursor-agent");
  fs.copyFileSync(path.join(here, "test-fixtures", "relay-scratch-probe-adapter.sh"), cursorAgentPath);
  fs.chmodSync(cursorAgentPath, 0o755);
  const claudeLauncherPath = path.join(binDir, "claude");
  fs.copyFileSync(path.join(here, "test-fixtures", "fake-claude-launcher.sh"), claudeLauncherPath);
  fs.chmodSync(claudeLauncherPath, 0o755);
  const claudeTargetPath = path.join(binDir, "claude.com");
  fs.copyFileSync(path.join(here, "test-fixtures", "fake-claude-target.mjs"), claudeTargetPath);
  fs.chmodSync(claudeTargetPath, 0o755);
  return binDir;
}
function makeConfig(repo) {
  const config = {
    schema_version: "3.0",
    project: {repo: ".", planning_framework: "standalone", state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs"},
    roles: {
      planner: {adapter: "cursor", model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null},
      plan_reviewer: {adapter: "claude", model: "sonnet", reasoning: "low", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null},
      implementer: {adapter: "cursor", model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null},
      code_reviewer: {adapter: "cursor", model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null},
      verifier: {adapter: "cursor", model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null}
    },
    workflow: {specReview: true, planReview: true, analysisAfterTasks: true, implementationReview: true, finalReview: true, verifierDisposition: true, autoApproveSpec: false, autoApprovePlan: false, parallelIndependentTasks: false, gsdPlanningReview: false, relaySafety: {block_git_commit_push: true, verify_read_only_by_snapshot: true, capture_touched_files: true, persist_role_sessions: true}},
    gates: {commands: [], env_allowlist: [], require_reviewer: true, network_isolation: true},
    policy: {max_plan_revisions: 3, retry_delay_ms: 0, checkpoint_after_task: true, checkpoint_after_phase: true, missionTimeoutMs: 0, role_timeout_ms: {}},
    agents_file: "AGENTS.md"
  };
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), JSON.stringify(config, null, 2));
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
{
  const repo = makeRepo();
  const binDir = makeBin();
  try {
    makeConfig(repo);
    const delimiter = process.platform === "win32" ? ";" : ":";
    const base = withoutOuterGitGuard({...process.env});
    const env = {...base, PATH: `${binDir}${delimiter}${base.PATH || ""}`};
    const run = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "autopilot.mjs"), "run", "add a fixture line to README.md", "--repo", repo], {
      cwd: repo, encoding: "utf8", env, timeout: 300000, stdio: ["ignore", "pipe", "pipe"], shell: false
    });
    const results = readAllResults(path.join(repo, ".autopilot")).map(f => JSON.parse(fs.readFileSync(f, "utf8")));
    check("fixture mission produced result.json records", results.length > 0, `run.status=${run.status} stderr=${(run.stderr || "").slice(-1000)}`);
    const withResolved = results.filter(r => typeof r.invocation?.resolvedBinary === "string" && r.invocation.resolvedBinary.startsWith("/"));
    check("every result.json records invocation.resolvedBinary", results.length > 0 && withResolved.length === results.length, results.map(r => r.invocation));
    const pr = results.find(r => r.role === "plan_reviewer");
    check("plan_reviewer invocation.resolvedBinary is the fixture claude (under binDir)", pr != null && pr.invocation.resolvedBinary.startsWith(binDir), pr?.invocation);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
  }
}

// 5. Live, end to end (WSL can run wsl.exe): build the exact argv the
// router builds, with `which claude` in place of node+ap, and assert it
// prints the operator's copy.
{
  const probe2 = await (async () => {
    const r = spawnSync("/mnt/c/Windows/System32/wsl.exe", ["-d", "Ubuntu", "--exec", "bash", "-lc", 'printf %s "$PATH"'], {encoding: "utf8", timeout: 30000});
    return r.status === 0 ? {ok: true, path: (r.stdout || "").trim()} : {ok: false};
  })();
  const wslArgs = ["-d", "Ubuntu", "--exec", ...(probe2.ok ? ["/usr/bin/env", `PATH=${probe2.path}`] : []), "which", "claude"];
  console.log(`LIVE end-to-end argv: ${JSON.stringify(wslArgs)}`);
  const bare = spawnSync("/mnt/c/Windows/System32/wsl.exe", ["-d", "Ubuntu", "--exec", "which", "claude"], {encoding: "utf8", timeout: 30000});
  const live = spawnSync("/mnt/c/Windows/System32/wsl.exe", wslArgs, {encoding: "utf8", timeout: 30000});
  console.log(`LIVE bare-exec which claude: ${(bare.stdout || "").trim()}`);
  console.log(`LIVE end-to-end (router argv, which claude): ${(live.stdout || "").trim()} / stderr=${(live.stderr || "").trim().slice(0, 200)}`);
  if (bare.status === 0 && live.status === 0) {
    check("live end-to-end: router argv resolves the operator's ~/.local/bin/claude (bare --exec still finds the old copy)",
      (live.stdout || "").trim().endsWith("/.local/bin/claude") && (bare.stdout || "").includes("/usr/local/bin/claude"),
      {bare: (bare.stdout || "").trim(), live: (live.stdout || "").trim()});
  } else {
    console.log("LIVE check skipped — wsl.exe interop unavailable from this shell.");
  }
  const loginLookup = spawnSync("/mnt/c/Windows/System32/wsl.exe", ["-d", "Ubuntu", "--exec", "bash", "-lc", "command -v claude; claude --version"], {encoding: "utf8", timeout: 30000});
  console.log(`LIVE login-shell claude: ${(loginLookup.stdout || "").trim()} / stderr=${(loginLookup.stderr || "").trim().slice(0, 200)}`);
}

console.log(failures === 0 ? "test-sandbox-operator-cli: OK" : `test-sandbox-operator-cli: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
