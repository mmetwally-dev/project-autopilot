#!/usr/bin/env node
// Task 15.4A final correction, Part B: behavioral proof that one `ap`
// process probes each DISTINCT configured adapter executable exactly once.
//
// Before this change the same CLI was launched over and over before a single
// role ever ran: validateRoleRuntimeConfig() probed once per role (and cfg()
// — hence validateRoleRuntimeConfig() — is re-entered by every
// missionOverride() lookup), preflightConfiguredRoles() probed once per role
// again, and runRelay() probed once more before every single role
// invocation. With the usual five-roles-on-one-adapter configuration that is
// pure serial latency with no extra signal, and it is production overhead —
// not a slow test and not an antivirus artifact.
//
// Everything here is observed, not asserted about source text: the adapters
// are real disposable executables placed on PATH that append one line to a
// log file for every launch, and the counts below are read back out of that
// log. The log lives in the adapter's own throwaway bin directory, OUTSIDE
// the repository under review, so nothing about the fixture repo's contents
// or the production code is special-cased for testing — there are no test
// hooks and no environment-variable branches in production.
//
// Cross-platform: the disposable adapter is a .cmd trampoline around a Node
// script on Windows (mirroring scripts/agent-process.mjs's
// resolveWindowsBinary()/winShimInvocation()) and a /bin/sh wrapper
// elsewhere. Both reach Node through an absolute process.execPath, never
// through PATH.
//
// Hermetic by construction: this file must produce identical counts whether
// zero, one, or every supported real CLI is installed on the machine, so the
// fixtures run under a PATH from which no manifest agent binary is reachable
// outside the disposable fixture directory. That property is asserted, not
// assumed — see hermeticFixturePath()/missionFixturePath() and
// testFixturePathIsHermetic(). Nothing here is skipped or weakened based on
// what happens to be installed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import {fileURLToPath} from "node:url";
import {preflightConfig, preflightAdapter, createPreflightProbeCache} from "./preflight.mjs";
import {ensureStandaloneSplit} from "./mission-naming.mjs";
import {ensureBaseline, sanitizeKeySegment} from "./implementation-baseline.mjs";
import {declaredDeliverables} from "../adapters/standalone.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");
const CANONICAL_AUTOPILOT = path.join(skillRoot, "scripts", "autopilot.mjs");
const agents = JSON.parse(fs.readFileSync(path.join(skillRoot, "adapters", "agents.json"), "utf8")).adapters;
const PATH_DELIMITER = process.platform === "win32" ? ";" : ":";

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  return false;
};

const cleanup = (...dirs) => {
  for (const dir of dirs) {
    if (!dir) continue;
    try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* best-effort */ }
  }
};

function git(cwd, args) {
  const r = spawnSync("git", args, {cwd, encoding: "utf8", stdio: "pipe", env: withoutOuterGitGuard(process.env), shell: false});
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout || "").trim();
}

// ---------------------------------------------------------------------
// Disposable, self-logging adapter executables.
//
// Every launch — availability probe or real role invocation — appends one
// JSON line to `invocations.log` in the bin directory. `kind` distinguishes
// the two: an availability probe is the manifest's `--version` argv, a role
// invocation is anything else (and reads the relay prompt from stdin).
// ---------------------------------------------------------------------
function adapterSource({binaryName, logFile, probeExitCode}) {
  return `import fs from "node:fs";
import path from "node:path";

const LOG = ${JSON.stringify(logFile)};
const BINARY = ${JSON.stringify(binaryName)};
const args = process.argv.slice(2);
const isProbe = args.length === 1 && args[0] === "--version";

function log(entry) {
  fs.appendFileSync(LOG, JSON.stringify({binary: BINARY, kind: entry.kind, role: entry.role ?? null, args, at: Date.now()}) + "\\n");
}

if (isProbe) {
  log({kind: "probe"});
  console.log(BINARY + " fake 1.0.0");
  process.exit(${probeExitCode});
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

const PROMPT = await readStdin();
const firstLine = PROMPT.split(/\\r?\\n/, 1)[0] || "";
const role = firstLine.startsWith("ROLE=") ? firstLine.slice("ROLE=".length) : "unknown";
log({kind: "invocation", role});

if (role === "implementer") {
  const cwdNow = process.cwd();
  const counterFile = path.join(cwdNow, ".preflight-dedupe-attempts");
  let attempt = 1;
  try { attempt = parseInt(fs.readFileSync(counterFile, "utf8").trim(), 10) + 1; } catch {}
  fs.writeFileSync(counterFile, String(attempt));
  fs.writeFileSync(path.join(cwdNow, "implementation.txt"), "attempt " + attempt + "\\n");
  console.log("implementer ok attempt=" + attempt);
  process.exit(0);
}

console.log("AUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: []}));
process.exit(0);
`;
}

// Both trampolines invoke `process.execPath` by ABSOLUTE path, so the fixture
// never needs Node — or anything else the developer happens to have
// installed — to be discoverable through PATH. On Windows that is a `.cmd`
// (mirroring scripts/agent-process.mjs's winShimInvocation()); elsewhere it
// is a `/bin/sh` wrapper rather than a `#!/usr/bin/env node` shebang,
// precisely so that no PATH lookup is involved in reaching the interpreter.
//
// `binaries` are manifest binary names from adapters/agents.json —
// "cursor-agent" for the `cursor` adapter, "codex" for `codex`.
function makeAdapterBin(prefix, {binaries = ["cursor-agent"], probeExitCode = 0} = {}) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), `ap-preflight-bin-${prefix}-`));
  const logFile = path.join(binDir, "invocations.log");
  fs.writeFileSync(logFile, "");
  for (const binaryName of binaries) {
    const scriptPath = path.join(binDir, `${binaryName}-impl.mjs`);
    fs.writeFileSync(scriptPath, adapterSource({binaryName, logFile, probeExitCode}));
    if (process.platform === "win32") {
      fs.writeFileSync(path.join(binDir, `${binaryName}.cmd`), `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\nexit /b %errorlevel%\r\n`);
    } else {
      const target = path.join(binDir, binaryName);
      fs.writeFileSync(target, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} "$@"\n`);
      fs.chmodSync(target, 0o755);
    }
  }
  return {binDir, logFile, toolsDir: makeToolsDir(binDir)};
}

// ---------------------------------------------------------------------
// Hermetic PATH construction.
//
// The fixture must behave identically whether zero, one, or every supported
// real CLI is installed on the machine. Two different mechanisms are needed
// because the two platforms resolve binaries differently:
//
//  - POSIX (`which`) is strictly first-match, so putting the fixture bin
//    directory first is already decisive. The only OS tool the direct
//    preflight path needs is `which` itself, so it is symlinked into a
//    private tools directory and the PATH becomes exactly
//    [fixture bin, fixture tools] — nothing else is reachable at all.
//
//  - Windows is NOT first-match: scripts/agent-process.mjs's
//    resolveWindowsBinary() collects every `where.exe` hit and then ranks
//    resolved `.exe`/shim targets ahead of `.cmd` files GLOBALLY, so an
//    installed `claude.exe` late on PATH beats a fixture `claude.cmd` first
//    on PATH. (That global ranking is deliberate production behavior — it
//    keeps a UNC cwd working — and is not being changed here.) The fixture
//    therefore builds a PATH that simply contains no directory able to
//    supply ANY manifest agent binary, keeping System32 so `where.exe`
//    itself still resolves.
//
// Either way the result is checked, not assumed: testFixturePathIsHermetic()
// below resolves all five manifest binaries under the fixture PATH and
// asserts that nothing outside the fixture directory can answer.
// ---------------------------------------------------------------------
const AGENT_BINARY_NAMES = [...new Set(Object.values(agents).map(a => a.binary))];
const WINDOWS_EXECUTABLE_EXTENSIONS = [".exe", ".com", ".cmd", ".bat", ""];

function directorySuppliesAnAgentBinary(dir) {
  for (const name of AGENT_BINARY_NAMES) {
    const candidates = process.platform === "win32" ? WINDOWS_EXECUTABLE_EXTENSIONS.map(ext => name + ext) : [name];
    for (const candidate of candidates) {
      try { if (fs.existsSync(path.join(dir, candidate))) return true; } catch { /* unreadable dir */ }
    }
  }
  return false;
}

// POSIX only: a private directory holding just the OS tools the preflight
// path itself shells out to (`which`). Returns null on Windows, where
// System32 plays that role and cannot supply an agent CLI.
function makeToolsDir(binDir) {
  if (process.platform === "win32") return null;
  const toolsDir = path.join(binDir, "__tools");
  fs.mkdirSync(toolsDir, {recursive: true});
  for (const tool of ["which"]) {
    const source = ["/usr/bin", "/bin", "/usr/local/bin"].map(dir => path.join(dir, tool)).find(candidate => fs.existsSync(candidate));
    if (!source) continue;
    try { fs.symlinkSync(source, path.join(toolsDir, tool)); }
    catch { try { fs.copyFileSync(source, path.join(toolsDir, tool)); fs.chmodSync(path.join(toolsDir, tool), 0o755); } catch { /* best-effort */ } }
  }
  return toolsDir;
}

// PATH for the in-process preflightConfig()/preflightAdapter() calls.
function hermeticFixturePath(binDir, toolsDir) {
  if (process.platform !== "win32") return [binDir, toolsDir].filter(Boolean).join(PATH_DELIMITER);
  const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  return [binDir, path.join(systemRoot, "System32"), systemRoot].join(PATH_DELIMITER);
}

// PATH for the real `ap` subprocess runs. Those need more of the machine
// than preflight does (git above all), so instead of a minimal allowlist
// this drops exactly the directories that could supply a real agent CLI —
// which on POSIX is unnecessary (first-match already decides it) and on
// Windows is what defeats the global `.exe` preference.
function missionFixturePath(binDir) {
  const original = (process.env.PATH || "").split(PATH_DELIMITER).filter(Boolean);
  if (process.platform !== "win32") return [binDir, ...original].join(PATH_DELIMITER);
  return [binDir, ...original.filter(dir => !directorySuppliesAnAgentBinary(dir))].join(PATH_DELIMITER);
}

function readLog(logFile) {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}
const probesIn = entries => entries.filter(e => e.kind === "probe");
const invocationsIn = entries => entries.filter(e => e.kind === "invocation");
function resetLog(logFile) { fs.writeFileSync(logFile, ""); }

// ---------------------------------------------------------------------
// Fixture repository: a minimal standalone-framework project seeded
// directly at its implementation checkpoint, so `ap run` goes straight to
// role work without a planning stage.
// ---------------------------------------------------------------------
function makeRepo(prefix) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `ap-preflight-${prefix}-`));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "preflight-dedupe-test@example.invalid"]);
  git(repo, ["config", "user.name", "Preflight Dedupe Test"]);
  fs.writeFileSync(path.join(repo, "implementation.txt"), "not-yet-implemented\n");
  const missionDir = path.join(repo, ".autopilot", "missions", "001-preflight-fixture");
  fs.mkdirSync(missionDir, {recursive: true});
  fs.writeFileSync(path.join(missionDir, "PLAN.md"), "# Standalone Plan\n\n- [ ] Do the first preflight fixture task\n- [ ] Do the second preflight fixture task\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init: standalone preflight fixture"]);
  return repo;
}

// `roleAdapters` maps each role name to an adapter id, so a single config
// can put five roles on one adapter or split them across two.
function writeConfig(repo, {roleAdapters, roleExtras = {}, implementationReview = false, finalReview = false} = {}) {
  const roleNames = ["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"];
  const config = {
    schema_version: "3.0",
    project: {repo: ".", planning_framework: "standalone", state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs"},
    roles: Object.fromEntries(roleNames.map(role => [role, {
      adapter: roleAdapters[role] || "cursor",
      model: "", reasoning: "", variant: "", resume: false,
      model_source: "default", model_verified_at: null, capabilities_verified_at: null,
      ...(roleExtras[role] || {})
    }])),
    workflow: {
      specReview: false, planReview: false, analysisAfterTasks: false, implementationReview, finalReview,
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

function seedImplementingState(repo) {
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
    version: 1, phase: "implementing", step: "implement", taskIndex: 0, phaseIndex: 0, attempt: 0,
    mission: "001-preflight-fixture"
  }, null, 2));
}

// A real resume into `implementing` always has a baseline: it is captured at
// `tasks_ready` before the first implementation attempt ever runs
// (scripts/autopilot.mjs refuses to create one from `implementing` —
// MIGRATION_BASELINE_MISSING). The fixture seeds `implementing` directly,
// so simulate that prior capture here: split PLAN.md -> TASKS.md through the
// production splitter, then capture the baseline the same way production
// does (mission-scoped key, production declared deliverables).
function seedMissionBaseline(repo, mission = "001-preflight-fixture") {
  ensureStandaloneSplit(repo, {mission});
  const key = `mission-${sanitizeKeySegment(mission)}`;
  ensureBaseline(repo, key, {mission, declaredPaths: declaredDeliverables(repo, mission)});
}

function runAp(repo, binDir, command, {timeoutMs = 180000} = {}) {
    const base = withoutOuterGitGuard({...process.env});
  const env = {...base, PATH: missionFixturePath(binDir)};
  const r = spawnSync(process.execPath, [CANONICAL_AUTOPILOT, ...command, "--repo", repo], {
    cwd: repo, encoding: "utf8", env, timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"], shell: false
  });
  return {
    status: r.status,
    timedOut: !!r.error && r.error.code === "ETIMEDOUT",
    stdout: r.stdout || "",
    stderr: r.stderr || ""
  };
}

function listResultFiles(repo) {
  const root = path.join(repo, ".autopilot");
  const found = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "result.json") found.push(full);
    }
  })(root);
  return found;
}

// Runs `fn` with a hermetic PATH, so the directly-called preflight functions
// resolve the disposable adapters exactly the way a real run resolves a real
// one (through where.exe / which) while being unable to reach any CLI the
// developer happens to have installed. The original PATH is always restored.
function withBinOnPath({binDir, toolsDir}, fn) {
  const original = process.env.PATH;
  process.env.PATH = hermeticFixturePath(binDir, toolsDir);
  try { return fn(); } finally { process.env.PATH = original; }
}

const configFor = (roleAdapters, roleExtras = {}) => ({
  roles: Object.fromEntries(["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"].map(role => [
    role, {adapter: roleAdapters[role] || "cursor", model: "", reasoning: "", variant: "", ...(roleExtras[role] || {})}
  ]))
});

// =====================================================================
// 1. Five roles sharing one adapter cause exactly one executable probe.
// 3. Every role still receives its own structural validation.
// =====================================================================
function testSingleAdapterProbedOnce() {
  const bin = makeAdapterBin("single");
  const {binDir, logFile} = bin;
  const repo = makeRepo("single");
  try {
    withBinOnPath(bin, () => {
      const {ok, results} = preflightConfig({repo, config: configFor({}), agents});
      const entries = readLog(logFile);
      check("single-adapter: preflight succeeded", ok === true, results.filter(r => !r.ok));
      check("single-adapter: five roles sharing one adapter produce exactly ONE executable probe", probesIn(entries).length === 1, {probes: probesIn(entries).length, entries});
      check("single-adapter: a result is still returned for every configured role", results.length === 5 && new Set(results.map(r => r.roleName)).size === 5, results.map(r => r.roleName));
      check("single-adapter: no role invocation happened during preflight", invocationsIn(entries).length === 0, invocationsIn(entries));
    });
  } finally { cleanup(binDir, repo); }
}

// =====================================================================
// 2. Two distinct adapters cause exactly two probes — one each, not one
//    total and not one per role.
// =====================================================================
// The two adapters are fixed, not discovered: `cursor` and `codex`, both
// always present in adapters/agents.json. Which real CLIs happen to be
// installed is irrelevant — the fixture PATH cannot reach them (see
// hermeticFixturePath above, proven by testFixturePathIsHermetic below).
// `antigravity` is never used anywhere in this file: the two adapters are a
// fixed choice (cursor + codex), not a discovery of whatever is installed,
// and every other adapter — antigravity included, whose transport now
// resolves available (scripts/adapter-transport.mjs) — is simply outside
// these fixtures.
const FIRST_ADAPTER_ID = "cursor";
const SECOND_ADAPTER_ID = "codex";
const FIRST_BINARY = agents[FIRST_ADAPTER_ID].binary;
const SECOND_BINARY = agents[SECOND_ADAPTER_ID].binary;

function testTwoAdaptersProbedTwice() {
  const bin = makeAdapterBin("two", {binaries: [FIRST_BINARY, SECOND_BINARY]});
  const {binDir, logFile} = bin;
  const repo = makeRepo("two");
  try {
    withBinOnPath(bin, () => {
      const roleAdapters = {
        planner: SECOND_ADAPTER_ID, plan_reviewer: SECOND_ADAPTER_ID,
        implementer: FIRST_ADAPTER_ID, code_reviewer: FIRST_ADAPTER_ID, verifier: FIRST_ADAPTER_ID
      };
      const {ok, results} = preflightConfig({repo, config: configFor(roleAdapters), agents});
      const entries = readLog(logFile);
      const probes = probesIn(entries);
      check("two-adapters: preflight succeeded", ok === true, results.filter(r => !r.ok));
      check(`two-adapters: exactly TWO executable probes for five roles across two adapters (${FIRST_ADAPTER_ID} + ${SECOND_ADAPTER_ID})`, probes.length === 2, {probes: probes.length, entries});
      check("two-adapters: each distinct executable was probed exactly once", probes.filter(p => p.binary === FIRST_BINARY).length === 1 && probes.filter(p => p.binary === SECOND_BINARY).length === 1, probes.map(p => p.binary));
      // Only the disposable fixtures write to this log, so two probes bearing
      // both fixture binary names is direct evidence that no real installed
      // CLI answered either of them.
      check("two-adapters: both probes came from the disposable fixtures, not from any installed CLI", probes.length === 2 && probes.every(p => [FIRST_BINARY, SECOND_BINARY].includes(p.binary)), probes);
      check("two-adapters: a result is still returned for every configured role", results.length === 5, results.map(r => r.roleName));
    });
  } finally { cleanup(binDir, repo); }
}

// =====================================================================
// The fixture PATH itself is hermetic: under it, NO manifest agent binary
// resolves to anything outside the disposable fixture directory. This is
// what makes every count in this file independent of which real CLIs the
// developer has installed.
// =====================================================================
function resolveUnderCurrentPath(binary) {
  const finder = process.platform === "win32" ? "where.exe" : "which";
  const r = spawnSync(finder, [binary], {encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: false});
  if (r.status !== 0) return [];
  return String(r.stdout || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function testFixturePathIsHermetic() {
  const bin = makeAdapterBin("hermetic", {binaries: [FIRST_BINARY, SECOND_BINARY]});
  const {binDir} = bin;
  try {
    // Establish the hazard is real before claiming to have neutralised it:
    // report what the developer's own PATH would have supplied.
    const installedBefore = AGENT_BINARY_NAMES.filter(name => resolveUnderCurrentPath(name).length > 0);
    console.log(`  (real agent CLIs installed on this machine: ${installedBefore.join(", ") || "none"})`);

    withBinOnPath(bin, () => {
      const escapes = [];
      for (const name of AGENT_BINARY_NAMES) {
        for (const resolved of resolveUnderCurrentPath(name)) {
          if (!path.resolve(resolved).toLowerCase().startsWith(path.resolve(binDir).toLowerCase())) escapes.push({name, resolved});
        }
      }
      check("hermetic-path: no manifest agent binary resolves outside the disposable fixture directory", escapes.length === 0, escapes);
      check(`hermetic-path: the two fixture binaries DO resolve inside it (${FIRST_BINARY}, ${SECOND_BINARY})`,
        resolveUnderCurrentPath(FIRST_BINARY).length > 0 && resolveUnderCurrentPath(SECOND_BINARY).length > 0,
        {first: resolveUnderCurrentPath(FIRST_BINARY), second: resolveUnderCurrentPath(SECOND_BINARY)});
      check("hermetic-path: the manifest binaries with no fixture resolve to nothing at all",
        AGENT_BINARY_NAMES.filter(n => ![FIRST_BINARY, SECOND_BINARY].includes(n)).every(n => resolveUnderCurrentPath(n).length === 0),
        Object.fromEntries(AGENT_BINARY_NAMES.map(n => [n, resolveUnderCurrentPath(n)])));
    });
    check("hermetic-path: the original PATH is restored afterwards", (process.env.PATH || "").split(PATH_DELIMITER).includes(binDir) === false, {binDir});
  } finally { cleanup(binDir); }
}

// =====================================================================
// 4. A role with an unsupported model/reasoning/variant still fails — and
//    the shared probe does not hide it or spread it to healthy roles.
// =====================================================================
function testRoleSpecificValidationSurvivesDeduplication() {
  const bin = makeAdapterBin("structural");
  const {binDir, logFile} = bin;
  const repo = makeRepo("structural");
  try {
    withBinOnPath(bin, () => {
      // `cursor` has no effort flag and no variant flag in agents.json, so a
      // role asking for either is structurally unsupported. `model` IS
      // supported, so the model-carrying role must stay healthy.
      const {ok, results} = preflightConfig({
        repo,
        config: configFor({}, {
          plan_reviewer: {reasoning: "high"},
          verifier: {variant: "some-variant"},
          implementer: {model: "some-model"}
        }),
        agents
      });
      const entries = readLog(logFile);
      const byRole = Object.fromEntries(results.map(r => [r.roleName, r]));
      check("structural: overall preflight fails when any role is misconfigured", ok === false, results.filter(r => !r.ok).map(r => r.roleName));
      check("structural: the reasoning-requesting role fails", byRole.plan_reviewer?.ok === false && byRole.plan_reviewer.problems.some(p => /effort/.test(p)), byRole.plan_reviewer);
      check("structural: the variant-requesting role fails", byRole.verifier?.ok === false && byRole.verifier.problems.some(p => /variant/.test(p)), byRole.verifier);
      check("structural: the model-requesting role stays healthy (model IS supported)", byRole.implementer?.ok === true, byRole.implementer);
      check("structural: roles with no special requests stay healthy", byRole.planner?.ok === true && byRole.code_reviewer?.ok === true, {planner: byRole.planner, code_reviewer: byRole.code_reviewer});
      check("structural: per-role validation did NOT cost extra probes", probesIn(entries).length === 1, {probes: probesIn(entries).length});
    });
  } finally { cleanup(binDir, repo); }
}

// Unknown adapters are still rejected per role, without any probe at all.
function testUnknownAdapterStillRejected() {
  const bin = makeAdapterBin("unknown");
  const {binDir, logFile} = bin;
  const repo = makeRepo("unknown");
  try {
    withBinOnPath(bin, () => {
      const {ok, results} = preflightConfig({repo, config: configFor({verifier: "not-a-real-adapter"}), agents});
      const byRole = Object.fromEntries(results.map(r => [r.roleName, r]));
      check("unknown-adapter: the role naming an unknown adapter fails", byRole.verifier?.ok === false && byRole.verifier.problems.some(p => /Unknown adapter/.test(p)), byRole.verifier);
      check("unknown-adapter: overall preflight fails", ok === false, results.filter(r => !r.ok).map(r => r.roleName));
      check("unknown-adapter: the real adapter was still probed exactly once for the other four roles", probesIn(readLog(logFile)).length === 1, readLog(logFile));
    });
  } finally { cleanup(binDir, repo); }
}

// =====================================================================
// 5. A missing or nonzero probe fails preflight.
// =====================================================================
function testMissingAndNonzeroProbesFail() {
  const repo = makeRepo("missing");
  // A fixture bin directory with NO adapter executables in it — the same
  // hermetic PATH shape as every other case here, so "missing" really means
  // missing rather than "shadowed by something installed".
  const emptyFixture = makeAdapterBin("empty", {binaries: []});
  const badFixture = makeAdapterBin("nonzero", {probeExitCode: 1});
  const {binDir: emptyBin} = emptyFixture;
  const {binDir: badBin, logFile: badLog} = badFixture;
  try {
    const missing = withBinOnPath(emptyFixture, () => preflightConfig({repo, config: configFor({}), agents}));
    check("missing-cli: preflight fails when the executable cannot be found or run", missing.ok === false, missing.results.filter(r => !r.ok).map(r => r.problems));

    withBinOnPath(badFixture, () => {
      const nonzero = preflightConfig({repo, config: configFor({}), agents});
      const entries = readLog(badLog);
      check("nonzero-probe: preflight fails when the probe exits nonzero", nonzero.ok === false, nonzero.results.filter(r => !r.ok).map(r => r.problems));
      check("nonzero-probe: every role reports the shared failure (not just the first)", nonzero.results.every(r => !r.ok), nonzero.results.map(r => ({role: r.roleName, ok: r.ok})));
      check("nonzero-probe: the failing executable was still probed only once", probesIn(entries).length === 1, {probes: probesIn(entries).length});
    });
  } finally { cleanup(repo, emptyBin, badBin); }
}

// A cache is per-call, not global: two separate preflightConfig() calls in
// the SAME process each probe again. (Cross-PROCESS independence is proven
// end-to-end in testSecondProcessProbesAgain below.)
function testCacheIsNotGlobal() {
  const bin = makeAdapterBin("scope");
  const {binDir, logFile} = bin;
  const repo = makeRepo("scope");
  try {
    withBinOnPath(bin, () => {
      preflightConfig({repo, config: configFor({}), agents});
      preflightConfig({repo, config: configFor({}), agents});
      check("cache-scope: two separate preflightConfig() calls probe twice (the cache is per-call, never global or persisted)", probesIn(readLog(logFile)).length === 2, readLog(logFile));

      // And an explicitly shared cache is honoured across direct
      // preflightAdapter() calls.
      resetLog(logFile);
      const shared = createPreflightProbeCache();
      for (const roleName of ["planner", "implementer", "verifier"]) {
        preflightAdapter({repo, adapterId: "cursor", adapter: agents.cursor, role: {}, probeCache: shared, roleName});
      }
      check("cache-scope: an explicitly shared cache collapses three preflightAdapter() calls into one probe", probesIn(readLog(logFile)).length === 1, readLog(logFile));
    });
  } finally { cleanup(binDir, repo); }
}

// Nothing is written to disk: a fresh cache never finds a remembered verdict.
function testNothingPersistedToDisk() {
  const bin = makeAdapterBin("persist");
  const {binDir, logFile} = bin;
  const repo = makeRepo("persist");
  try {
    withBinOnPath(bin, () => {
      preflightConfig({repo, config: configFor({}), agents});
      const afterFirst = probesIn(readLog(logFile)).length;
      const stray = fs.readdirSync(path.join(repo, ".autopilot")).filter(name => /preflight|probe/i.test(name));
      check("no-persistence: preflight wrote no probe/verdict file into .autopilot", stray.length === 0, stray);
      preflightConfig({repo, config: configFor({}), agents});
      check("no-persistence: the second preflight really re-probed (no remembered verdict)", probesIn(readLog(logFile)).length === afterFirst + 1, readLog(logFile));
    });
  } finally { cleanup(binDir, repo); }
}

// =====================================================================
// 6/7. A preflight failure stops the run before ANY role invocation and
//      before ANY run/result artifact is created.
// 9.   A second, independent `ap run` process probes again.
// =====================================================================
function testPreflightFailureStopsBeforeMissionMutation() {
  const repo = makeRepo("fail-stop");
  const {binDir, logFile} = makeAdapterBin("fail-stop", {probeExitCode: 1});
  try {
    writeConfig(repo, {roleAdapters: {}});
    seedImplementingState(repo);
    const statePath = path.join(repo, ".autopilot", "state.json");
    const stateBefore = fs.readFileSync(statePath, "utf8");
    const run = runAp(repo, binDir, ["run"], {timeoutMs: 120000});
    const entries = readLog(logFile);
    check("preflight-failure: mission state was never transitioned (state.json byte-identical)", fs.readFileSync(statePath, "utf8") === stateBefore, {before: stateBefore, after: fs.readFileSync(statePath, "utf8")});
    check("preflight-failure: the run did not succeed", run.status !== 0 && !run.timedOut, {status: run.status, timedOut: run.timedOut, stderrTail: run.stderr.slice(-500)});
    check("preflight-failure: the failure names preflight, not a mid-mission crash", /[Pp]reflight failed/.test(run.stderr + run.stdout), {stderrTail: run.stderr.slice(-800)});
    check("preflight-failure: NO role was ever invoked", invocationsIn(entries).length === 0, invocationsIn(entries));
    check("preflight-failure: NO role run/result artifact was created", listResultFiles(repo).length === 0, listResultFiles(repo));
    check("preflight-failure: the broken CLI was probed exactly once, not once per role", probesIn(entries).length === 1, {probes: probesIn(entries).length, entries});

    // 9. A second independent process starts from nothing.
    const probesAfterFirst = probesIn(entries).length;
    runAp(repo, binDir, ["run"], {timeoutMs: 120000});
    const afterSecond = probesIn(readLog(logFile)).length;
    check("cross-process: a second, independent `ap run` process probes again (nothing cached between processes)", afterSecond === probesAfterFirst + 1, {probesAfterFirst, afterSecond});
  } finally { cleanup(repo, binDir); }
}

// =====================================================================
// 1 (end-to-end) + 8. A real mission: exactly one probe for the whole
//      process, and actual role executions add none.
// 10.  `inspect` and `status` launch no agent CLI at all.
// =====================================================================
function testRealMissionProbesOnceAndReadOnlyCommandsProbeNever() {
  const repo = makeRepo("mission");
  const {binDir, logFile} = makeAdapterBin("mission");
  try {
    writeConfig(repo, {roleAdapters: {}});
    seedImplementingState(repo);

    // 10. Read-only commands first, against a repo whose state is untouched.
    const inspect = runAp(repo, binDir, ["inspect"], {timeoutMs: 60000});
    check("inspect: exited cleanly", inspect.status === 0, {status: inspect.status, stderrTail: inspect.stderr.slice(-500)});
    check("inspect: launched NO agent CLI (no probe, no invocation)", readLog(logFile).length === 0, readLog(logFile));

    const status = runAp(repo, binDir, ["status"], {timeoutMs: 60000});
    check("status: exited cleanly", status.status === 0, {status: status.status, stderrTail: status.stderr.slice(-500)});
    check("status: launched NO agent CLI (no probe, no invocation)", readLog(logFile).length === 0, readLog(logFile));

    // 1 + 8. Now a real mission with real role invocations.
    resetLog(logFile);
    seedMissionBaseline(repo);
    const run = runAp(repo, binDir, ["run"], {timeoutMs: 300000});
    const entries = readLog(logFile);
    const probes = probesIn(entries);
    const invocations = invocationsIn(entries);
    check("mission: the run was not killed by the test timeout", run.timedOut === false, {status: run.status, stderrTail: run.stderr.slice(-500)});
    check("mission: real role invocations occurred", invocations.length >= 1, {invocations: invocations.length, roles: invocations.map(i => i.role)});
    check("mission: the whole `ap run` process performed exactly ONE availability probe", probes.length === 1, {probes: probes.length, invocations: invocations.length, entries});
    check("mission: the single probe happened BEFORE any role invocation", entries.length > 0 && entries[0].kind === "probe", entries.slice(0, 3));
    check("mission: no role invocation was preceded by its own extra probe", entries.slice(1).every(e => e.kind === "invocation"), entries);
    console.log(`  (observed: ${probes.length} availability probe(s), ${invocations.length} role invocation(s): ${invocations.map(i => i.role).join(" -> ") || "none"})`);
  } finally { cleanup(repo, binDir); }
}

// =====================================================================
function main() {
  const start = Date.now();
  testFixturePathIsHermetic();
  testSingleAdapterProbedOnce();
  testTwoAdaptersProbedTwice();
  testRoleSpecificValidationSurvivesDeduplication();
  testUnknownAdapterStillRejected();
  testMissingAndNonzeroProbesFail();
  testCacheIsNotGlobal();
  testNothingPersistedToDisk();
  testPreflightFailureStopsBeforeMissionMutation();
  testRealMissionProbesOnceAndReadOnlyCommandsProbeNever();

  console.log(`\n(total runtime: ${((Date.now() - start) / 1000).toFixed(1)}s)`);
  if (failures) {
    console.error(`\n${failures} preflight-deduplication check(s) failed.`);
    process.exit(1);
  }
  console.log("\npreflight-deduplication PASS");
}

main();
