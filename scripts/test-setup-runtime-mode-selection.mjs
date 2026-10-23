#!/usr/bin/env node
// TASK 15.5B correction — runtime-mode selection.
// Pure-helper checks import the side-effect-free module
// scripts/runtime-mode-selection.mjs (never scripts/setup.mjs).
// Real setup/config entrypoint coverage uses disposable repositories and
// disposable skill copies with stubbed discovery. Never patches canonical
// production files. Hermetic fake CLIs only. Bounded I/O, hard deadlines,
// process-tree cleanup, fixture cleanup.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {runPosixBounded} from "./test-fixtures/posix-process-runner.mjs";
import {runWindowsProcessTreeBounded} from "./test-fixtures/windows-process-tree-runner.mjs";
import {copySkillCanonical as copySkillCanonicalTo} from "./test-fixtures/skill-copy.mjs";
import {RUNTIME_MODE_IDS} from "./runtime-mode-capabilities.mjs";
import {
  getSelectableRuntimeModes,
  buildExecutionConfig,
  classifySavedRuntimeExecution,
  resolveRuntimeExecution,
  preserveExecutionForRoleScope,
  isRoleOnlyScope,
  formatRuntimeModeLabel
} from "./runtime-mode-selection.mjs";
import {
  validateExecutionConfig,
  validateConfigForSave
} from "./config-validation.mjs";
import {migrateConfig} from "./config-migration.mjs";
import {toRuntimeConfig} from "./config-layout.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const selectionSource = fs.readFileSync(path.join(root, "scripts", "runtime-mode-selection.mjs"), "utf8");
const setupSource = fs.readFileSync(path.join(root, "scripts", "setup.mjs"), "utf8");
const validationSource = fs.readFileSync(path.join(root, "scripts", "config-validation.mjs"), "utf8");
const exampleRaw = fs.readFileSync(path.join(root, "config.example.json"), "utf8");
const autopilotSource = fs.readFileSync(path.join(root, "scripts", "autopilot.mjs"), "utf8");
const apLauncherSource = fs.readFileSync(path.join(root, "bin", "ap.cjs"), "utf8");
const agentsManifest = JSON.parse(fs.readFileSync(path.join(root, "adapters", "agents.json"), "utf8")).adapters;

// Task-specific temp-fixture prefixes. Every disposable directory created by
// this file uses one of these prefixes; the before/after comparison at the
// end of the run proves the current run leaked nothing. Never bulk-delete:
// only tracked directories are removed, pre-existing entries are untouched.
const FIXTURE_PREFIXES = ["ap-rtm15b-skill-", "ap-rtm15b-repo-", "ap-rtm15b-cli-", "ap-rtm15b-tools-"];
function snapshotTaskFixtures() {
  let entries = [];
  try {
    entries = fs.readdirSync(os.tmpdir());
  } catch {
    return new Set();
  }
  return new Set(entries.filter(name => FIXTURE_PREFIXES.some(prefix => name.startsWith(prefix))));
}
const fixturesBeforeRun = snapshotTaskFixtures();

// Module-level registry: every disposable fixture directory registers here
// immediately upon creation, so withFixtures() cleanup in its guaranteed
// finally path removes it however the scenario ends (spawn failure, timeout,
// output overflow, assertion failure, or thrown exception).
const ownedFixtureDirs = new Set();
function ownFixtureDir(dir) {
  ownedFixtureDirs.add(dir);
  return dir;
}

let failures = 0;
function check(name, condition, detail) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL: ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 2000)}` : ""}`);
  } else {
    console.log(`ok: ${name}`);
  }
}

const ALL = ["gsd", "speckit", "standalone"];
const SPECKIT_ONLY = ["speckit"];
const SPECKIT_AND_STANDALONE = ["speckit", "standalone"];

function makeMode(id, available, supportedFrameworks, extra = {}) {
  const strength = id === RUNTIME_MODE_IDS.windowsCompatibility ? "compatibility" : "strong";
  return {id, available, strength, supportedFrameworks: [...supportedFrameworks], reason: available ? null : "unavailable-for-test", distro: null, ...extra};
}
function wsl2UsableCaps() {
  return {
    currentPlatform: "wsl2",
    modes: [
      makeMode(RUNTIME_MODE_IDS.wsl2Strong, true, ALL),
      makeMode(RUNTIME_MODE_IDS.linuxStrong, false, ALL, {reason: "not_applicable_current_platform_is_wsl2"}),
      makeMode(RUNTIME_MODE_IDS.windowsCompatibility, false, SPECKIT_AND_STANDALONE, {reason: "not_applicable_current_platform_is_wsl2"})
    ],
    recommendedMode: RUNTIME_MODE_IDS.wsl2Strong,
    usableWslDistro: null
  };
}
function linuxUsableCaps() {
  return {
    currentPlatform: "native-linux",
    modes: [
      makeMode(RUNTIME_MODE_IDS.wsl2Strong, false, ALL, {reason: "not_applicable_current_platform_is_native_linux"}),
      makeMode(RUNTIME_MODE_IDS.linuxStrong, true, ALL),
      makeMode(RUNTIME_MODE_IDS.windowsCompatibility, false, SPECKIT_AND_STANDALONE, {reason: "not_applicable_current_platform_is_native_linux"})
    ],
    recommendedMode: RUNTIME_MODE_IDS.linuxStrong,
    usableWslDistro: null
  };
}
function windowsDualCaps(distro = "Ubuntu") {
  return {
    currentPlatform: "native-windows",
    modes: [
      {...makeMode(RUNTIME_MODE_IDS.wsl2Strong, true, ALL), distro},
      makeMode(RUNTIME_MODE_IDS.linuxStrong, false, ALL, {reason: "not_applicable_current_platform_is_native_windows"}),
      {...makeMode(RUNTIME_MODE_IDS.windowsCompatibility, true, SPECKIT_AND_STANDALONE), reason: "disposable-copy compatibility isolation (not OS-enforced containment) — SpecKit-and-standalone"}
    ],
    recommendedMode: RUNTIME_MODE_IDS.wsl2Strong,
    usableWslDistro: distro
  };
}
function windowsNoWslCaps(reason = "wsl_not_installed") {
  return {
    currentPlatform: "native-windows",
    modes: [
      makeMode(RUNTIME_MODE_IDS.wsl2Strong, false, ALL, {reason}),
      makeMode(RUNTIME_MODE_IDS.linuxStrong, false, ALL, {reason: "not_applicable_current_platform_is_native_windows"}),
      {...makeMode(RUNTIME_MODE_IDS.windowsCompatibility, true, SPECKIT_AND_STANDALONE), reason: "disposable-copy compatibility isolation (not OS-enforced containment) — SpecKit-and-standalone"}
    ],
    recommendedMode: RUNTIME_MODE_IDS.windowsCompatibility,
    usableWslDistro: null
  };
}
function wsl1Caps() {
  return {
    currentPlatform: "wsl1",
    modes: [
      makeMode(RUNTIME_MODE_IDS.wsl2Strong, false, ALL, {reason: "wsl1_reviewer_containment_unsupported"}),
      makeMode(RUNTIME_MODE_IDS.linuxStrong, false, ALL, {reason: "wsl1_reviewer_containment_unsupported"}),
      makeMode(RUNTIME_MODE_IDS.windowsCompatibility, false, SPECKIT_ONLY, {reason: "not_applicable_current_platform_is_wsl1"})
    ],
    recommendedMode: null,
    usableWslDistro: null
  };
}

// ---------------------------------------------------------------------
// Pure helper behavior (hermetic, injected capabilities).
// ---------------------------------------------------------------------
{
  const caps = windowsDualCaps("Ubuntu");
  const result = resolveRuntimeExecution({capabilities: caps, framework: "speckit", savedExecution: undefined, userChoiceId: RUNTIME_MODE_IDS.wsl2Strong});
  check("pure dual selects wsl2-strong", result.status === "selected" && result.execution?.runtime_mode === RUNTIME_MODE_IDS.wsl2Strong, result);
  check("pure wsl2-strong mentions OS-enforced", (result.messages || []).join("\n").includes("OS-enforced"), result.messages);
}
{
  const caps = windowsDualCaps("Ubuntu");
  const exec = buildExecutionConfig(RUNTIME_MODE_IDS.wsl2Strong, caps);
  check("pure exact distro Ubuntu", exec.wsl_distro === "Ubuntu", exec);
  check("pure execution has only two keys", Object.keys(exec).sort().join(",") === "runtime_mode,wsl_distro", exec);
  const spaced = buildExecutionConfig(RUNTIME_MODE_IDS.wsl2Strong, windowsDualCaps("My Custom Distro"));
  check("pure distro spaces exact", spaced.wsl_distro === "My Custom Distro", spaced);
  check("pure WSL2 distro null", buildExecutionConfig(RUNTIME_MODE_IDS.wsl2Strong, wsl2UsableCaps()).wsl_distro === null);
  check("pure linux distro null", buildExecutionConfig(RUNTIME_MODE_IDS.linuxStrong, linuxUsableCaps()).wsl_distro === null);
}
{
  const caps = windowsDualCaps("Ubuntu");
  const result = resolveRuntimeExecution({capabilities: caps, framework: "speckit", savedExecution: undefined, userChoiceId: RUNTIME_MODE_IDS.windowsCompatibility});
  check("pure dual selects compat", result.status === "selected" && result.execution?.runtime_mode === RUNTIME_MODE_IDS.windowsCompatibility && result.execution?.wsl_distro === null, result);
  const text = (result.messages || []).join("\n");
  check("pure compat not OS-enforced", text.includes("not OS-enforced"), text);
  check("pure compat SpecKit disposable", text.includes("SpecKit-and-standalone") && text.includes("disposable-copy"), text);
}
{
  const caps = windowsNoWslCaps("wsl_not_installed");
  check("pure no-WSL selectable compat only", getSelectableRuntimeModes(caps, "speckit").length === 1, getSelectableRuntimeModes(caps, "speckit"));
  const result = resolveRuntimeExecution({capabilities: caps, framework: "speckit", savedExecution: undefined});
  check("pure no-WSL fresh requires explicit choice (no silent auto)", result.status === "need-choice" && !("execution" in result && result.execution), result);
  const text = (result.messages || []).join("\n");
  check("pure no-WSL reports unavailable", text.includes("WSL2 Strong is unavailable") && text.includes("wsl_not_installed"), text);
  check("pure no-WSL has no confirmation wording (setup prints the weaker warning)", !/Explicit confirmation is required/i.test(text) && /not OS-enforced/.test(text), text);
}
{
  const dual = windowsDualCaps("Ubuntu");
  const bad = resolveRuntimeExecution({capabilities: dual, framework: "speckit", savedExecution: undefined, userChoiceId: RUNTIME_MODE_IDS.linuxStrong});
  check("pure unavailable rejected", bad.status === "error", bad);
  const noWsl = windowsNoWslCaps("wsl_not_installed");
  check("pure unavailable strong rejected", resolveRuntimeExecution({capabilities: noWsl, framework: "speckit", savedExecution: undefined, userChoiceId: RUNTIME_MODE_IDS.wsl2Strong}).status === "error");
  let threw = false;
  try { buildExecutionConfig(RUNTIME_MODE_IDS.linuxStrong, dual); } catch { threw = true; }
  check("pure build throws unavailable", threw === true);
  let threwUnknown = false;
  try { buildExecutionConfig("unknown-mode", dual); } catch { threwUnknown = true; }
  check("pure build throws unknown", threwUnknown === true);
  check("pure never shows unavailable", getSelectableRuntimeModes(dual, "speckit").length === 2, getSelectableRuntimeModes(dual, "speckit"));
}
{
  const caps = wsl2UsableCaps();
  check("pure WSL2 selectable single strong", getSelectableRuntimeModes(caps, "speckit").length === 1, getSelectableRuntimeModes(caps, "speckit"));
  const result = resolveRuntimeExecution({capabilities: caps, framework: "speckit", savedExecution: undefined});
  check("pure WSL2 auto strong", result.status === "auto" && result.execution?.runtime_mode === RUNTIME_MODE_IDS.wsl2Strong && result.execution?.wsl_distro === null, result);
  check("pure WSL2 OS-enforced", (result.messages || []).join("\n").includes("OS-enforced bubblewrap"), result.messages);
}
{
  const caps = linuxUsableCaps();
  const result = resolveRuntimeExecution({capabilities: caps, framework: "gsd", savedExecution: undefined});
  check("pure Linux auto strong", result.status === "auto" && result.execution?.runtime_mode === RUNTIME_MODE_IDS.linuxStrong, result);
}
{
  check("pure compat valid speckit", validateExecutionConfig({runtime_mode: RUNTIME_MODE_IDS.windowsCompatibility, wsl_distro: null}, "speckit").valid === true);
  check("pure compat accepted standalone", validateExecutionConfig({runtime_mode: RUNTIME_MODE_IDS.windowsCompatibility, wsl_distro: null}, "standalone").valid === true);
  check("pure compat rejected gsd", validateExecutionConfig({runtime_mode: RUNTIME_MODE_IDS.windowsCompatibility, wsl_distro: null}, "gsd").valid === false);
  const dual = windowsDualCaps("Ubuntu");
  check("pure gsd excludes compat", getSelectableRuntimeModes(dual, "gsd").length === 1, getSelectableRuntimeModes(dual, "gsd"));
  check("pure speckit includes both", getSelectableRuntimeModes(dual, "speckit").length === 2, getSelectableRuntimeModes(dual, "speckit"));
  check("pure no WSL gsd fails", resolveRuntimeExecution({capabilities: windowsNoWslCaps("wsl_not_installed"), framework: "gsd", savedExecution: undefined}).status === "error");
}
{
  const caps = windowsDualCaps("Ubuntu");
  const saved = {runtime_mode: RUNTIME_MODE_IDS.wsl2Strong, wsl_distro: "Ubuntu"};
  check("pure preserved valid", classifySavedRuntimeExecution({savedExecution: saved, capabilities: caps, framework: "speckit"}).status === "preserved");
  const resolved = resolveRuntimeExecution({capabilities: caps, framework: "speckit", savedExecution: saved});
  check("pure preserved no switch", resolved.status === "preserved" && resolved.execution?.runtime_mode === RUNTIME_MODE_IDS.wsl2Strong, resolved);
  const compatSaved = {runtime_mode: RUNTIME_MODE_IDS.windowsCompatibility, wsl_distro: null};
  check("pure compat preserved no switch", resolveRuntimeExecution({capabilities: caps, framework: "speckit", savedExecution: compatSaved}).status === "preserved");
}
{
  const caps = windowsDualCaps("Ubuntu");
  const stale = {runtime_mode: RUNTIME_MODE_IDS.linuxStrong, wsl_distro: null};
  check("pure stale unavailable", classifySavedRuntimeExecution({savedExecution: stale, capabilities: caps, framework: "speckit"}).status === "unavailable");
  const resolved = resolveRuntimeExecution({capabilities: caps, framework: "speckit", savedExecution: stale});
  check("pure stale needs choice no execution", resolved.status === "need-choice" && !("execution" in resolved && resolved.execution), resolved);
  // Silent-replacement removal: single-replacement cases must also need choice.
  const strongStaleSingle = {runtime_mode: RUNTIME_MODE_IDS.wsl2Strong, wsl_distro: "Ubuntu"};
  const noWslSingle = resolveRuntimeExecution({capabilities: windowsNoWslCaps("wsl_not_installed"), framework: "speckit", savedExecution: strongStaleSingle});
  check("pure Strong->Compat not silent (need-choice)", noWslSingle.status === "need-choice" && !("execution" in noWslSingle && noWslSingle.execution), noWslSingle);
  const compatStaleSingle = {runtime_mode: RUNTIME_MODE_IDS.windowsCompatibility, wsl_distro: null};
  const linuxSingle = resolveRuntimeExecution({capabilities: linuxUsableCaps(), framework: "speckit", savedExecution: compatStaleSingle});
  check("pure Compat->Strong not silent (need-choice)", linuxSingle.status === "need-choice" && !("execution" in linuxSingle && linuxSingle.execution), linuxSingle);
  const explicit = resolveRuntimeExecution({capabilities: caps, framework: "speckit", savedExecution: stale, userChoiceId: RUNTIME_MODE_IDS.wsl2Strong});
  check("pure explicit accepted", explicit.status === "selected", explicit);
}
{
  check("pure role scope", isRoleOnlyScope("role") === true && isRoleOnlyScope("role:planner") === true && isRoleOnlyScope("all") === false);
  const saved = {runtime_mode: RUNTIME_MODE_IDS.wsl2Strong, wsl_distro: "Ubuntu"};
  check("pure preserve identical", preserveExecutionForRoleScope(saved) === saved);
}
{
  check("pure undefined valid", validateExecutionConfig(undefined, "speckit").valid === true);
  check("pure example schema 4.0", JSON.parse(exampleRaw).schema_version === "4.0");
}
{
  check("pure unknown rejected", validateExecutionConfig({runtime_mode: "bad", wsl_distro: null}, "speckit").valid === false);
  check("pure non-object string rejected", validateExecutionConfig("wsl2-strong", "speckit").valid === false);
  check("pure null rejected", validateExecutionConfig(null, "speckit").valid === false);
  check("pure array rejected", validateExecutionConfig([], "speckit").valid === false);
  check("pure missing runtime rejected", validateExecutionConfig({wsl_distro: null}, "speckit").valid === false);
  check("pure missing distro rejected", validateExecutionConfig({runtime_mode: RUNTIME_MODE_IDS.wsl2Strong}, "speckit").valid === false);
  check("pure distro on linux rejected", validateExecutionConfig({runtime_mode: RUNTIME_MODE_IDS.linuxStrong, wsl_distro: "Ubuntu"}, "speckit").valid === false);
  check("pure extra field rejected", validateExecutionConfig({runtime_mode: RUNTIME_MODE_IDS.wsl2Strong, wsl_distro: null, probe_output: "x"}, "speckit").valid === false);
  check("pure nested distro rejected", validateExecutionConfig({runtime_mode: RUNTIME_MODE_IDS.wsl2Strong, wsl_distro: {a: 1}}, "speckit").valid === false);
  check("pure path rejected", validateExecutionConfig({runtime_mode: RUNTIME_MODE_IDS.wsl2Strong, wsl_distro: "C:\\Windows"}, "speckit").valid === false);
  check("pure probe command rejected", validateExecutionConfig({runtime_mode: RUNTIME_MODE_IDS.wsl2Strong, wsl_distro: "wsl.exe --list"}, "speckit").valid === false);
  check("pure diagnostic rejected", validateExecutionConfig({runtime_mode: RUNTIME_MODE_IDS.wsl2Strong, wsl_distro: "probe output: x"}, "speckit").valid === false);
  check("pure compat gsd rejected", validateExecutionConfig({runtime_mode: RUNTIME_MODE_IDS.windowsCompatibility, wsl_distro: null}, "gsd").valid === false);
}
{
  const exec = buildExecutionConfig(RUNTIME_MODE_IDS.wsl2Strong, windowsDualCaps("Ubuntu"));
  check("pure only two keys", Object.keys(exec).sort().join(",") === "runtime_mode,wsl_distro", exec);
  check("pure label strong", formatRuntimeModeLabel({id: RUNTIME_MODE_IDS.wsl2Strong, distro: "Ubuntu"}, windowsDualCaps("Ubuntu")).includes("WSL2 Strong (Recommended)"));
  check("pure label compat", formatRuntimeModeLabel({id: RUNTIME_MODE_IDS.windowsCompatibility}, windowsDualCaps("Ubuntu")).includes("not OS-enforced"));
}
{
  check("pure selection module has no setup import side effects", !/loadAndMigrateConfig|readline\.createInterface/.test(selectionSource));
  check("pure setup imports selection helpers", /from ["']\.\/runtime-mode-selection\.mjs["']/.test(setupSource) && /resolveRuntimeExecution/.test(setupSource));
  check("pure tests import selection not setup", !/import\s+\{[^}]*\}\s+from\s+["']\.\/setup\.mjs["']/.test(fs.readFileSync(new URL(import.meta.url), "utf8")));
  check("pure selection integrates discovery ids", /RUNTIME_MODE_IDS/.test(selectionSource));
  check("pure setup no longer asks to confirm compat", !/Save Windows Compatibility execution mode/.test(setupSource) && /Windows Compatibility is weaker: reviewers work on a throwaway copy/.test(setupSource));
  check("pure WSL1 fails", resolveRuntimeExecution({capabilities: wsl1Caps(), framework: "speckit", savedExecution: undefined}).status === "error");
}

// ---------------------------------------------------------------------
// Real subprocess harness (disposable skill copy + repo + fake CLI).
// Process lifecycle, byte-accurate output bounds, and process-tree
// termination come from the shared runners
// (test-fixtures/posix-process-runner.mjs on POSIX,
// test-fixtures/windows-process-tree-runner.mjs on Windows) — no second
// weaker runner lives in this file. Interactive setup prompts are driven
// through the runners' onOutput/writeLine callback.
// ---------------------------------------------------------------------
const SETUP_MAX_OUTPUT_BYTES = 256 * 1024;
function hermeticPath(binDir, toolsDir) {
  const delim = process.platform === "win32" ? ";" : ":";
  // POSIX is strictly first-match with the fixture bin first, so the PATH is
  // exactly [fixture bin, fixture tools] — nothing else is reachable at all.
  // Windows is NOT first-match: resolveWindowsBinary() collects every
  // where.exe hit and ranks real executables ahead of .cmd shims globally,
  // so the PATH must contain no directory able to supply ANY manifest agent
  // binary while keeping System32 (which cannot supply one) so where.exe
  // itself still resolves. See test-preflight-deduplication.mjs.
  if (process.platform !== "win32") return [binDir, toolsDir].join(delim);
  const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  return [binDir, path.join(systemRoot, "System32"), systemRoot].join(delim);
}
function resolveOnHermeticPath(name, pathValue) {
  const delim = process.platform === "win32" ? ";" : ":";
  const exts = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
  for (const dir of String(pathValue || "").split(delim)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch { /* unreadable entry counts as absent */ }
    }
  }
  return null;
}
function copySkillCanonical(dest) {
  copySkillCanonicalTo(root, dest);
}
function stubCapabilities(skillCopy, fakeCaps) {
  const target = path.join(skillCopy, "scripts", "runtime-mode-capabilities.mjs");
  const body = `export const RUNTIME_MODE_IDS = ${JSON.stringify({wsl2Strong: "wsl2-strong", linuxStrong: "linux-strong", windowsCompatibility: "windows-compatibility"})};\nexport const RUNTIME_STRENGTH = ${JSON.stringify({strong: "strong", compatibility: "compatibility"})};\nexport const SUPPORTED_FRAMEWORKS_ALL = ${JSON.stringify(["gsd", "speckit", "standalone"])};\nexport const SUPPORTED_FRAMEWORKS_SPECKIT_ONLY = ${JSON.stringify(["speckit"])};\nexport async function detectRuntimeModeCapabilities() { return ${JSON.stringify(fakeCaps)}; }\n`;
  fs.writeFileSync(target, body);
}
function makeFakeCliDir() {
  const binDir = ownFixtureDir(fs.mkdtempSync(path.join(os.tmpdir(), "ap-rtm15b-cli-")));
  const fake = path.join(binDir, process.platform === "win32" ? "claude.cmd" : "claude");
  if (process.platform === "win32") {
    fs.writeFileSync(fake, '@echo off\r\nif "%1"=="--version" (echo claude-test & exit /b 0)\r\nif "%1"=="--help" (echo --model --effort --resume-last & exit /b 0)\r\nexit /b 0\r\n');
  } else {
    const realTrue = fs.existsSync("/usr/bin/true") ? "/usr/bin/true" : "/bin/true";
    fs.copyFileSync(realTrue, fake);
    fs.chmodSync(fake, 0o755);
  }
  return binDir;
}
// Fixture-tools directory (POSIX only): the ONLY system-tool surface visible
// to setup besides the fixture bin. No general system directory (/usr/bin,
// /bin) ever enters the fixture PATH, so a real installed agent CLI cannot
// resolve. Exact tools setup shells out to on POSIX: which (agent binary
// resolution), sh (command -v probe), unshare + true (network namespace
// probe). On Windows System32 plays this role (where.exe) and cannot supply
// an agent CLI, so no tools directory content is needed there.
function makeHermeticToolsDir() {
  const toolsDir = ownFixtureDir(fs.mkdtempSync(path.join(os.tmpdir(), "ap-rtm15b-tools-")));
  if (process.platform !== "win32") {
    for (const name of ["which", "sh", "unshare", "true"]) {
      for (const candidate of [`/usr/bin/${name}`, `/bin/${name}`]) {
        try {
          if (fs.existsSync(candidate)) {
            try { fs.symlinkSync(candidate, path.join(toolsDir, name)); } catch { /* already linked */ }
            break;
          }
        } catch { /* unreadable candidate counts as absent */ }
      }
    }
  }
  return toolsDir;
}
function makeRepo(framework) {
  const repo = ownFixtureDir(fs.mkdtempSync(path.join(os.tmpdir(), "ap-rtm15b-repo-")));
  if (framework === "speckit") {
    fs.mkdirSync(path.join(repo, ".specify", "workflows", "speckit"), {recursive: true});
    fs.writeFileSync(path.join(repo, ".specify", "workflows", "speckit", "workflow.yml"), "steps: []\n");
  } else if (framework === "gsd") {
    fs.mkdirSync(path.join(repo, ".planning"), {recursive: true});
    fs.writeFileSync(path.join(repo, ".planning", "ROADMAP.md"), "# roadmap\n");
    fs.writeFileSync(path.join(repo, ".planning", "STATE.md"), "# state\n");
  }
  return repo;
}
function writeRepoConfig(repo, obj) {
  const dir = path.join(repo, ".autopilot");
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(obj, null, 2) + "\n");
}
function readRepoConfigRaw(repo) {
  const p = path.join(repo, ".autopilot", "config.json");
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8");
}
function isSetupPromptWaiting(text) {
  // Genuine rl.question prompts end with ": " (colon + space, answer on the
  // same line). Informational message headers end with ":\n" (e.g. "Runtime
  // execution mode — choose one:") and must never trigger a send: answering
  // one buffers a line that a later prompt consumes instead, desyncing the
  // whole answer stream.
  return /: $|Press Enter[^\n]*\s$/.test(text);
}
// Runs the real setup/config entrypoint as a subprocess through the shared
// bounded process-tree runner (POSIX or Windows). The fake CLI directory and
// the hermetic tools directory are created here and therefore registered in
// the module-level fixture registry the moment they exist; withFixtures()
// removes them in its guaranteed finally path however this call settles
// (spawn failure, timeout, output overflow, assertion failure, exception).
// Rejects nothing: the runner resolves lifecycle details and the caller
// asserts on status/timedOut/outputLimitExceeded/terminationFailed.
async function runSetupSubprocess({skillCopy, repo, setupArgs, rules = [], defaultAnswer = "", timeoutMs = 60000, maxOutputBytes = SETUP_MAX_OUTPUT_BYTES, fakePlatform = null, withoutUnshare = false}) {
  const binDir = makeFakeCliDir();
  const toolsDir = makeHermeticToolsDir();
  if (withoutUnshare) {
    // Hide the network-namespace tool so no Linux isolation is detected.
    try { fs.rmSync(path.join(toolsDir, "unshare"), {force: true}); } catch { /* already absent */ }
  }
  const pathValue = hermeticPath(binDir, toolsDir);
  const env = {...process.env, PATH: pathValue};
  if (fakePlatform) {
    // Platform injection: pin the platform the network question is decided
    // for in the disposable skill copy of setup.mjs (everything else keeps the
    // real platform, so CLI discovery and the fixtures still work).
    const setupCopy = path.join(skillCopy, "scripts", "setup.mjs");
    const src = fs.readFileSync(setupCopy, "utf8");
    const pinned = src.replace("const NETWORK_PLATFORM = process.platform;", `const NETWORK_PLATFORM = ${JSON.stringify(fakePlatform)};`);
    if (pinned === src) throw new Error("NETWORK_PLATFORM seam not found in setup.mjs");
    fs.writeFileSync(setupCopy, pinned);
  }
  const fired = new Set();
  let lastAnsweredLen = 0;
  const onOutput = ({stdout, writeLine}) => {
    if (!isSetupPromptWaiting(stdout.slice(-500))) return;
    if (stdout.length <= lastAnsweredLen) return;
    for (let i = 0; i < rules.length; i += 1) {
      if (fired.has(i)) continue;
      const rule = rules[i];
      const hit = rule.pattern instanceof RegExp ? rule.pattern.test(stdout) : stdout.includes(rule.pattern);
      if (hit) {
        fired.add(i);
        lastAnsweredLen = stdout.length;
        writeLine(rule.answer);
        return;
      }
    }
    lastAnsweredLen = stdout.length;
    writeLine(defaultAnswer);
  };
  const runBounded = process.platform === "win32" ? runWindowsProcessTreeBounded : runPosixBounded;
  const result = await runBounded(process.execPath, [path.join(skillCopy, "scripts", "setup.mjs"), ...setupArgs], {
    cwd: skillCopy,
    env,
    timeoutMs,
    maxOutputBytes,
    stdin: "pipe",
    onOutput,
    maxAnswers: 500
  });
  setupRunLifecycles.push({
    timedOut: result.timedOut,
    outputLimitExceeded: result.outputLimitExceeded,
    terminationFailed: result.terminationFailed,
    error: result.error ? String(result.error?.message || result.error) : null,
    stdoutBytes: Buffer.byteLength(result.stdout || "", "utf8"),
    stderrBytes: Buffer.byteLength(result.stderr || "", "utf8"),
    cap: maxOutputBytes
  });
  return {...result, binDir, toolsDir, pathValue};
}
const setupRunLifecycles = [];
async function withFixtures(fn) {
  const skillCopy = ownFixtureDir(fs.mkdtempSync(path.join(os.tmpdir(), "ap-rtm15b-skill-")));
  const repos = [];
  const bins = [];
  try {
    copySkillCanonical(skillCopy);
    const ctx = {
      skillCopy,
      trackRepo: r => { repos.push(r); return r; },
      trackBin: b => { bins.push(b); return b; }
    };
    return await fn(ctx);
  } finally {
    for (const b of bins) { try { fs.rmSync(b, {recursive: true, force: true}); } catch {} }
    for (const r of repos) { try { fs.rmSync(r, {recursive: true, force: true}); } catch {} }
    try { fs.rmSync(skillCopy, {recursive: true, force: true}); } catch {}
    for (const dir of [...ownedFixtureDirs]) {
      ownedFixtureDirs.delete(dir);
      try { fs.rmSync(dir, {recursive: true, force: true}); } catch {}
    }
  }
}
function minimalRoles(adapter = "claude") {
  const one = () => ({adapter, model: "", reasoning: "", variant: "", resume: true, model_source: "default", model_verified_at: null, capabilities_verified_at: null});
  return {planner: one(), plan_reviewer: one(), implementer: one(), code_reviewer: one(), verifier: one()};
}
function baseConfig({framework = "speckit", execution} = {}) {
  const cfg = {
    schema_version: "3.0",
    project: {repo: ".", planning_framework: framework, state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs"},
    roles: minimalRoles(),
    workflow: {},
    gates: {commands: [], env_allowlist: [], require_reviewer: true, network_isolation: true},
    policy: {failure_budgets: {implementationFailureBudget: 3, verificationFailureBudget: 3, adapterRetryBudget: 2, infrastructureRetryBudget: 2}},
    safety: {},
    planning: {verify_denylist: []},
    capabilities: {project_defaults: [], role_requirements: {}, safety_denied: [], legacy_text_inference: false, verification: {browser: "native", require_browser: "when-task-requires"}},
    config_metadata: {migrated_from: "3.0", last_migrated_at: "2026-01-01T00:00:00.000Z"}
  };
  if (execution !== undefined) cfg.execution = execution;
  // Mission 096 task 1.3: migrateConfig now yields the v4 on-disk layout; the
  // setup reader consumes the legacy runtime shape, so adapt back through
  // toRuntimeConfig (setup itself still reads/writes that shape until 4.1).
  return toRuntimeConfig(migrateConfig(cfg).config);
}

// S1: Fresh WSL2 setup saves wsl2-strong (real subprocess).
await withFixtures(async ({skillCopy, trackRepo}) => {
  stubCapabilities(skillCopy, wsl2UsableCaps());
  const repo = trackRepo(makeRepo("standalone"));
  const r = await runSetupSubprocess({
    skillCopy, repo,
    setupArgs: ["--wizard", "--repo", repo],
    rules: [],
    defaultAnswer: "",
    timeoutMs: 60000
  });
  const combined = `${r.stdout}\n${r.stderr}`;
  check("sub fresh WSL2 exits 0", r.status === 0 && !r.timedOut, {status: r.status, timedOut: r.timedOut, tail: combined.slice(-2000)});
  const raw = readRepoConfigRaw(repo);
  check("sub fresh WSL2 wrote config", typeof raw === "string", combined.slice(-2000));
  const saved = raw ? JSON.parse(raw) : null;
  check("sub fresh WSL2 saves wsl2-strong null", saved?.runtime?.mode === "wsl2-strong" && saved?.runtime?.wsl_distro === null, saved?.runtime);
  check("sub fresh WSL2 prints OS-enforced", /OS-enforced bubblewrap/.test(combined), combined.slice(-2000));
  check("sub fresh WSL2 discovers only the fake CLI", /✓ claude/.test(combined) && !/✓ (opencode|codex|agy|cursor-agent)/.test(combined), combined.slice(-2000));
  check("sub fresh WSL2 launches no real CLI", saved !== null && ["planner","plan_reviewer","implementer","code_reviewer","verifier"].every(r => saved.roles[r]?.cli === "claude"), saved?.roles);
});

// S2: Fresh Native Linux saves linux-strong.
await withFixtures(async ({skillCopy, trackRepo}) => {
  stubCapabilities(skillCopy, linuxUsableCaps());
  const repo = trackRepo(makeRepo("standalone"));
  const r = await runSetupSubprocess({
    skillCopy, repo,
    setupArgs: ["--wizard", "--repo", repo],
    rules: [],
    defaultAnswer: "",
    timeoutMs: 60000
  });
  const combined = `${r.stdout}\n${r.stderr}`;
  check("sub fresh Linux exits 0", r.status === 0 && !r.timedOut, {status: r.status, tail: combined.slice(-2000)});
  const saved = JSON.parse(readRepoConfigRaw(repo));
  check("sub fresh Linux saves linux-strong", saved?.runtime?.mode === "linux-strong" && saved?.runtime?.wsl_distro === null, saved?.runtime);
});

// S3: Windows dual displays both and saves explicit compat choice.
await withFixtures(async ({skillCopy, trackRepo}) => {
  stubCapabilities(skillCopy, windowsDualCaps("Ubuntu"));
  const repo = trackRepo(makeRepo("speckit"));
  const r = await runSetupSubprocess({
    skillCopy, repo,
    setupArgs: ["--wizard", "--repo", repo],
    rules: [
      {pattern: /Runtime execution mode — choose one/, answer: "2"}
    ],
    defaultAnswer: "",
    timeoutMs: 60000
  });
  const combined = `${r.stdout}\n${r.stderr}`;
  check("sub dual shows both", /WSL2 Strong \(Recommended\)/.test(combined) && /Windows Compatibility/.test(combined) && /not OS-enforced/.test(combined), combined.slice(-3000));
  check("sub dual exits 0", r.status === 0 && !r.timedOut, {status: r.status, tail: combined.slice(-2000)});
  const saved = JSON.parse(readRepoConfigRaw(repo));
  check("sub dual explicit compat saved", saved?.runtime?.mode === "windows-compatibility" && saved?.runtime?.wsl_distro === null, {saved: saved?.runtime, answers: r.answersSent, timedOut: r.timedOut, overflow: r.outputLimitExceeded, termFail: r.terminationFailed, tail: combined.slice(-1500)});
  check("sub dual compat asks no confirmation", !/Save Windows Compatibility/.test(combined), combined.slice(-2000));
  check("sub dual compat prints the weaker warning", combined.includes("⚠ Windows Compatibility is weaker: reviewers work on a throwaway copy,\n  not OS-enforced containment. SpecKit and standalone projects only."), combined.slice(-2000));
  check("sub dual exact distro not stored for compat", saved?.runtime?.wsl_distro === null, saved?.runtime);
});

// S3b: Windows dual explicit strong choice (no confirmation needed).
await withFixtures(async ({skillCopy, trackRepo}) => {
  stubCapabilities(skillCopy, windowsDualCaps("Ubuntu"));
  const repo = trackRepo(makeRepo("speckit"));
  const r = await runSetupSubprocess({
    skillCopy, repo,
    setupArgs: ["--wizard", "--repo", repo],
    rules: [{pattern: /Runtime execution mode — choose one/, answer: "1"}],
    defaultAnswer: "",
    timeoutMs: 60000
  });
  const combined = `${r.stdout}\n${r.stderr}`;
  check("sub dual strong exits 0", r.status === 0, {status: r.status, tail: combined.slice(-2000)});
  const saved = JSON.parse(readRepoConfigRaw(repo));
  check("sub dual explicit strong saves exact distro", saved?.runtime?.mode === "wsl2-strong" && saved?.runtime?.wsl_distro === "Ubuntu", saved?.runtime);
});

// S4: Windows no-WSL warns and requires confirmation (confirm saves).
await withFixtures(async ({skillCopy, trackRepo}) => {
  stubCapabilities(skillCopy, windowsNoWslCaps("wsl_not_installed"));
  const repo = trackRepo(makeRepo("speckit"));
  const r = await runSetupSubprocess({
    skillCopy, repo,
    setupArgs: ["--wizard", "--repo", repo],
    rules: [],
    defaultAnswer: "",
    timeoutMs: 60000
  });
  const combined = `${r.stdout}\n${r.stderr}`;
  check("sub no-WSL warns unavailable", /WSL2 Strong is unavailable/.test(combined) && /wsl_not_installed/.test(combined), combined.slice(-3000));
  check("sub no-WSL warns weaker SpecKit not-enforced", /weaker/.test(combined) && /SpecKit and standalone/.test(combined) && /not OS-enforced/.test(combined), combined.slice(-3000));
  check("sub no-WSL asks no confirmation", !/Save Windows Compatibility/.test(combined), combined.slice(-2000));
  check("sub no-WSL confirm exits 0", r.status === 0, {status: r.status, tail: combined.slice(-2000)});
  const saved = JSON.parse(readRepoConfigRaw(repo));
  check("sub no-WSL confirm saves compat", saved?.runtime?.mode === "windows-compatibility", {saved: saved?.runtime, answers: r.answersSent, timedOut: r.timedOut, overflow: r.outputLimitExceeded, termFail: r.terminationFailed, tail: combined.slice(-1500)});
});

// S6b: Strong-unavailable with a saved Strong mode switches to Compatibility with a warning, no confirm.
await withFixtures(async ({skillCopy, trackRepo}) => {
  stubCapabilities(skillCopy, windowsNoWslCaps("wsl_not_installed"));
  const repo = trackRepo(makeRepo("speckit"));
  writeRepoConfig(repo, baseConfig({framework: "speckit", execution: {runtime_mode: "wsl2-strong", wsl_distro: "Ubuntu"}}));
  const r = await runSetupSubprocess({
    skillCopy, repo,
    setupArgs: ["--edit", "--repo", repo],
    rules: [
      {pattern: /Configuration scope:/, answer: "1"}
    ],
    defaultAnswer: "",
    timeoutMs: 60000
  });
  check("sub confirm switches explicitly", r.status === 0, {status: r.status});
  check("sub switch asks no compat confirmation", !/Save Windows Compatibility|Configuration not saved/.test(`${r.stdout}\n${r.stderr}`), `${r.stdout}`.slice(-2000));
  check("sub switch prints weaker warning", /⚠ Windows Compatibility is weaker/.test(r.stdout), `${r.stdout}`.slice(-2000));
  const saved = JSON.parse(readRepoConfigRaw(repo));
  check("sub confirm saves compat explicitly", saved?.runtime?.mode === "windows-compatibility", saved?.runtime);
});

// S6c: Native Windows (fake platform): no network question; network_isolation follows the mode.
async function winNetworkScenario(caps, repoKind, rules) {
  return withFixtures(async ({skillCopy, trackRepo}) => {
    stubCapabilities(skillCopy, caps);
    const repo = trackRepo(makeRepo(repoKind));
    const r = await runSetupSubprocess({
      skillCopy, repo,
      setupArgs: ["--wizard", "--repo", repo],
      rules, defaultAnswer: "", timeoutMs: 60000, fakePlatform: "win32"
    });
    const combined = `${r.stdout}\n${r.stderr}`;
    const raw = readRepoConfigRaw(repo);
    return {r, combined, saved: raw ? JSON.parse(raw) : null};
  });
}
{
  const strong = await winNetworkScenario(windowsDualCaps("Ubuntu"), "speckit", [{pattern: /Runtime execution mode — choose one/, answer: "1"}]);
  check("win32 strong exits 0", strong.r.status === 0, {status: strong.r.status, tail: strong.combined.slice(-2000)});
  check("win32 strong asks no network question", !/without network isolation/.test(strong.combined), strong.combined.slice(-2000));
  check("win32 strong isolation true", strong.saved?.runtime?.mode === "wsl2-strong" && strong.saved?.tests?.gate_network === false, strong.saved);
  check("win32 strong prints line", strong.combined.includes("✓ Tests (gate) will run without network access inside WSL.\n  Change later: tests.gate_network in .autopilot/config.json"), strong.combined.slice(-2000));

  const compat = await winNetworkScenario(windowsDualCaps("Ubuntu"), "speckit", [{pattern: /Runtime execution mode — choose one/, answer: "2"}]);
  check("win32 compat exits 0", compat.r.status === 0, {status: compat.r.status, tail: compat.combined.slice(-2000)});
  check("win32 compat asks no network question", !/without network isolation/.test(compat.combined), compat.combined.slice(-2000));
  check("win32 compat isolation false", compat.saved?.runtime?.mode === "windows-compatibility" && compat.saved?.tests?.gate_network === true, compat.saved);
  check("win32 compat prints line", compat.combined.includes("✓ Tests (gate) will run with network access (Windows cannot isolate them).\n  Change later: tests.gate_network in .autopilot/config.json"), compat.combined.slice(-2000));

  const only = await winNetworkScenario(windowsNoWslCaps("wsl_not_installed"), "speckit", []);
  check("win32 compat-only asks no question", only.r.status === 0 && !/without network isolation|Save Windows Compatibility/.test(only.combined) && only.saved?.tests?.gate_network === true, {status: only.r.status, saved: only.saved, tail: only.combined.slice(-1500)});
}

// S6d: non-Windows without namespace isolation still asks the network question.
await withFixtures(async ({skillCopy, trackRepo}) => {
  stubCapabilities(skillCopy, windowsDualCaps("Ubuntu"));
  const repo = trackRepo(makeRepo("speckit"));
  const r = await runSetupSubprocess({
    skillCopy, repo,
    setupArgs: ["--wizard", "--repo", repo],
    rules: [
      {pattern: /Runtime execution mode — choose one/, answer: "1"},
      {pattern: /without network isolation/, answer: "y"}
    ],
    defaultAnswer: "", timeoutMs: 60000, fakePlatform: "darwin", withoutUnshare: true
  });
  const combined = `${r.stdout}\n${r.stderr}`;
  check("darwin still asks network question", /Allow verify\/gates execution without network isolation\?/.test(combined), combined.slice(-2000));
  const saved = JSON.parse(readRepoConfigRaw(repo) || "null");
  check("darwin answer y turns gate isolation off", saved?.tests?.gate_network === true, saved);
});

// S7: Saved Compat becoming unavailable, Strong is the only mode: saved without a question, one line printed.
await withFixtures(async ({skillCopy, trackRepo}) => {
  stubCapabilities(skillCopy, linuxUsableCaps());
  const repo = trackRepo(makeRepo("speckit"));
  writeRepoConfig(repo, baseConfig({framework: "speckit", execution: {runtime_mode: "windows-compatibility", wsl_distro: null}}));
  const r = await runSetupSubprocess({
    skillCopy, repo,
    setupArgs: ["--edit", "--repo", repo],
    rules: [{pattern: /Configuration scope:/, answer: "1"}],
    defaultAnswer: "",
    timeoutMs: 60000
  });
  const combined = `${r.stdout}\n${r.stderr}`;
  check("sub compat-unavailable explains", /Saved runtime mode is (unavailable|invalid)/.test(combined), `${r.stdout}`.slice(-2000));
  check("sub strong-only exits 0", r.status === 0, {status: r.status});
  check("sub strong-only asks no confirmation", !/execution mode \(OS-enforced|Configuration not saved/.test(combined), combined.slice(-2000));
  check("sub strong-only prints the one line", combined.includes("✓ Runtime: linux-strong (OS-enforced bubblewrap containment) — the only usable mode here."), combined.slice(-2000));
  const saved = JSON.parse(readRepoConfigRaw(repo));
  check("sub strong-only saves strong", saved?.runtime?.mode === "linux-strong", saved?.runtime);
});

// S8: ap config preserves still-valid saved selection (real subprocess).
await withFixtures(async ({skillCopy, trackRepo}) => {
  stubCapabilities(skillCopy, windowsDualCaps("Ubuntu"));
  const repo = trackRepo(makeRepo("speckit"));
  writeRepoConfig(repo, baseConfig({framework: "speckit", execution: {runtime_mode: "wsl2-strong", wsl_distro: "Ubuntu"}}));
  const r = await runSetupSubprocess({
    skillCopy, repo,
    setupArgs: ["--edit", "--repo", repo],
    rules: [{pattern: /Configuration scope:/, answer: "1"}],
    defaultAnswer: "",
    timeoutMs: 60000
  });
  const combined = `${r.stdout}\n${r.stderr}`;
  check("sub preserve exits 0", r.status === 0, {status: r.status, tail: combined.slice(-2000)});
  const saved = JSON.parse(readRepoConfigRaw(repo));
  check("sub preserve keeps strong exact", saved?.runtime?.mode === "wsl2-strong" && saved?.runtime?.wsl_distro === "Ubuntu", saved?.runtime);
  check("sub preserve prints preserving", /Preserving saved runtime mode/.test(combined), combined.slice(-2000));
});

// S9: Role-only preserves execution byte-for-byte and performs no runtime discovery.
await withFixtures(async ({skillCopy, trackRepo}) => {
  // Stub where saved would be unavailable if discovery ran (proves no discovery).
  stubCapabilities(skillCopy, windowsNoWslCaps("wsl_not_installed"));
  const repo = trackRepo(makeRepo("speckit"));
  const priorExecV4 = {mode: "wsl2-strong", wsl_distro: "Ubuntu"};
  const beforeExecRaw = JSON.stringify(priorExecV4);
  writeRepoConfig(repo, baseConfig({framework: "speckit", execution: {runtime_mode: "wsl2-strong", wsl_distro: "Ubuntu"}}));
  const r = await runSetupSubprocess({
    skillCopy, repo,
    setupArgs: ["--edit", "--repo", repo, "--role", "planner"],
    rules: [],
    defaultAnswer: "",
    timeoutMs: 60000
  });
  const combined = `${r.stdout}\n${r.stderr}`;
  const after = JSON.parse(readRepoConfigRaw(repo));
  check("sub role-only preserves execution", JSON.stringify(after?.runtime) === beforeExecRaw, after?.runtime);
  check("sub role-only no runtime discovery", !/Preserving saved runtime mode|Runtime execution mode|WSL2 Strong|Windows Compatibility|OS-enforced/.test(combined), combined.slice(-3000));
});

// S10: Invalid/extra fields fail before any config write (role-only preserves invalid, validation fails).
await withFixtures(async ({skillCopy, trackRepo}) => {
  stubCapabilities(skillCopy, windowsDualCaps("Ubuntu"));
  const repo = trackRepo(makeRepo("speckit"));
  const bad = baseConfig({framework: "speckit", execution: {runtime_mode: "wsl2-strong", wsl_distro: "Ubuntu", probe_output: "x"}});
  writeRepoConfig(repo, bad);
  const before = readRepoConfigRaw(repo);
  const r = await runSetupSubprocess({
    skillCopy, repo,
    setupArgs: ["--edit", "--repo", repo, "--role", "planner"],
    rules: [],
    defaultAnswer: "",
    timeoutMs: 60000
  });
  const combined = `${r.stdout}\n${r.stderr}`;
  const after = readRepoConfigRaw(repo);
  check("sub invalid fails nonzero", r.status !== 0, {status: r.status, tail: combined.slice(-2000)});
  check("sub invalid leaves byte-identical", after === before, {before: before?.slice(-500), after: after?.slice(-500)});
  check("sub invalid reports validation", /Configuration validation failed|unknown field/i.test(combined), combined.slice(-2000));
});

// S11: Unrelated fields survive round-trip (real subprocess).
await withFixtures(async ({skillCopy, trackRepo}) => {
  stubCapabilities(skillCopy, windowsDualCaps("Ubuntu"));
  const repo = trackRepo(makeRepo("speckit"));
  const prior = baseConfig({framework: "speckit", execution: {runtime_mode: "wsl2-strong", wsl_distro: "Ubuntu"}});
  prior.custom_top_level = {nested: [1, 2, 3]};
  prior.project.custom_field = "keep-me";
  writeRepoConfig(repo, prior);
  const r = await runSetupSubprocess({
    skillCopy, repo,
    setupArgs: ["--edit", "--repo", repo],
    rules: [{pattern: /Configuration scope:/, answer: "1"}],
    defaultAnswer: "",
    timeoutMs: 60000
  });
  check("sub roundtrip exits 0", r.status === 0, {status: r.status});
  const saved = JSON.parse(readRepoConfigRaw(repo));
  check("sub unrelated top survives", JSON.stringify(saved?.custom_top_level) === JSON.stringify({nested: [1, 2, 3]}), saved);
  check("sub unrelated project survives", saved?.project?.custom_field === "keep-me", saved?.project);
  check("sub roundtrip schema 4.0", saved?.schema_version === "4.0", saved?.schema_version);
});

// Byte-exact output bounds on the shared runners (regression for the
// chunk-counting defect: bounds are accumulated bytes, not chunk counts).
{
  const runBounded = process.platform === "win32" ? runWindowsProcessTreeBounded : runPosixBounded;
  const r = await runBounded(process.execPath, ["-e", 'process.stdout.write("x".repeat(100000));'], {timeoutMs: 20000, maxOutputBytes: 1024});
  check("bytes stdout overflow flagged", r.outputLimitExceeded === true, r.outputLimitExceeded);
  check("bytes stdout byte-exact bounded", Buffer.byteLength(r.stdout, "utf8") <= 1024, Buffer.byteLength(r.stdout, "utf8"));
  check("bytes stderr byte-exact bounded", Buffer.byteLength(r.stderr, "utf8") <= 1024, Buffer.byteLength(r.stderr, "utf8"));
}
// Multibyte UTF-8 regression: 4-byte emoji split across chunks must stay
// byte-exact, complete-character-only, and flagged.
{
  const runBounded = process.platform === "win32" ? runWindowsProcessTreeBounded : runPosixBounded;
  const r = await runBounded(process.execPath, ["-e", 'for (let i = 0; i < 2000; i++) process.stdout.write("😀");'], {timeoutMs: 20000, maxOutputBytes: 100});
  check("utf8 overflow flagged", r.outputLimitExceeded === true, r.outputLimitExceeded);
  check("utf8 bytes within cap", Buffer.byteLength(r.stdout, "utf8") <= 100, Buffer.byteLength(r.stdout, "utf8"));
  check("utf8 no split corruption", r.stdout.length > 0 && [...r.stdout].every(ch => ch === "😀"), r.stdout.slice(0, 20));
}
// Runaway verbose child: overflow is observed, the complete tree is gone at
// settlement (overflow path on Windows, deadline group-kill on POSIX), and
// the scenario fails closed on the overflow flag.
{
  const runBounded = process.platform === "win32" ? runWindowsProcessTreeBounded : runPosixBounded;
  const start = Date.now();
  // The child swallows stdout errors so destroying the parent side of the
  // pipes on overflow cannot crash it ahead of the terminator: taskkill must
  // deterministically find a live tree (no "process not found" race).
  const r = await runBounded(process.execPath, ["-e", 'process.stdout.on("error",()=>{});setInterval(() => process.stdout.write("0123456789ABCDEF".repeat(4096)), 5); setTimeout(() => {}, 60000);'], {timeoutMs: 12000, maxOutputBytes: 4096});
  const elapsed = Date.now() - start;
  check("runaway overflow flagged", r.outputLimitExceeded === true, r.outputLimitExceeded);
  check("runaway tree confirmed dead", r.terminationFailed === false, r.terminationFailed);
  if (process.platform === "win32") {
    check("runaway overflow terminates before deadline", elapsed < 12000, elapsed);
  } else {
    check("runaway deadline bounds posix overflow", r.timedOut === true && elapsed < 30000, {timedOut: r.timedOut, elapsed});
  }
}
// Hermetic CLI PATH: every manifest agent binary either resolves inside the
// toy fixture directories or does not resolve at all — never to a real
// installed CLI outside the fixtures.
await withFixtures(async () => {
  const binDir = makeFakeCliDir();
  const toolsDir = makeHermeticToolsDir();
  const pathValue = hermeticPath(binDir, toolsDir);
  const binaries = [...new Set(Object.values(agentsManifest).map(entry => entry?.binary).filter(value => typeof value === "string" && value.length > 0))];
  check("hermetic manifest binaries enumerated", binaries.length > 0 && binaries.includes("claude"), binaries);
  for (const binary of binaries) {
    const resolved = resolveOnHermeticPath(binary, pathValue);
    if (binary === "claude") {
      check("hermetic fake claude resolves inside fixture", typeof resolved === "string" && resolved.startsWith(binDir + path.sep), resolved);
    } else {
      check(`hermetic real ${binary} does not resolve`, resolved === null, resolved);
    }
  }
  // Per-directory scan defeats Windows' global .exe-before-.cmd ranking: no
  // PATH directory outside the fixtures may supply ANY manifest binary, no
  // matter the extension.
  const extensions = process.platform === "win32" ? ["", ".exe", ".com", ".cmd", ".bat"] : [""];
  const fixtureDirs = new Set([binDir, toolsDir]);
  for (const dir of pathValue.split(process.platform === "win32" ? ";" : ":")) {
    if (!dir || fixtureDirs.has(dir)) continue;
    let supplies = null;
    for (const binary of binaries) {
      for (const ext of extensions) {
        try {
          if (fs.existsSync(path.join(dir, binary + ext))) { supplies = binary + ext; break; }
        } catch { /* unreadable entry counts as absent */ }
      }
      if (supplies) break;
    }
    check(`hermetic PATH dir supplies no agent CLI (${dir})`, supplies === null, supplies);
  }
});
// Every setup run in this file settled with a confirmed-dead tree, inside
// the byte caps, without timeout or spawn error: termination confirmation
// before settlement, deterministic deadlines, single settlement each.
{
  check("lifecycle setup runs recorded", setupRunLifecycles.length >= 13, setupRunLifecycles.length);
  check("lifecycle no setup run timed out", setupRunLifecycles.every(run => run.timedOut === false), setupRunLifecycles);
  check("lifecycle no setup run overflowed", setupRunLifecycles.every(run => run.outputLimitExceeded === false), setupRunLifecycles);
  check("lifecycle every tree confirmed dead", setupRunLifecycles.every(run => run.terminationFailed === false), setupRunLifecycles);
  check("lifecycle no spawn errors", setupRunLifecycles.every(run => run.error === null), setupRunLifecycles);
  check("lifecycle stdout byte-bounded", setupRunLifecycles.every(run => run.stdoutBytes <= run.cap), setupRunLifecycles.map(run => run.stdoutBytes));
  check("lifecycle stderr byte-bounded", setupRunLifecycles.every(run => run.stderrBytes <= run.cap), setupRunLifecycles.map(run => run.stderrBytes));
}

// S12: ap run behavior unchanged (real launcher subprocess, no static substitute for launcher).
await withFixtures(async ({skillCopy}) => {
  const proc = spawnSync(process.execPath, [path.join(skillCopy, "bin", "ap.cjs"), "help"], {encoding: "utf8", timeout: 15000, shell: false});
  const combined = `${proc.stdout || ""}\n${proc.stderr || ""}`;
  check("sub ap help exits 0", proc.status === 0, {status: proc.status, combined: combined.slice(-1000)});
  check("sub ap help mentions run", /ap run/.test(combined), combined.slice(-1000));
  check("sub ap help no runtime_mode", !/runtime_mode/.test(combined), combined.slice(-1000));
  check("sub autopilot has no runtime routing", !/runtime_mode|getSelectableRuntimeModes|resolveRuntimeExecution/.test(autopilotSource));
  check("sub autopilot keeps disposable path", /useDisposableReviewerWorkspace/.test(autopilotSource));
});

// Production hygiene (static only for hook detection, not behavior).
{
  for (const [label, source] of Object.entries({selection: selectionSource, setup: setupSource, validation: validationSource})) {
    check(`hygiene ${label} no env scenario branch`, !/process\.env\.(AP_TEST|TEST_|SCENARIO|MOCK_)/.test(source), label);
  }
  check("hygiene example schema 4.0", JSON.parse(exampleRaw).schema_version === "4.0");
  const exampleCheck = validateExecutionConfig(toRuntimeConfig(JSON.parse(exampleRaw)).execution, "speckit");
  check("hygiene example valid", exampleCheck.valid === true, exampleCheck);
}

// Fixture-leak proof: compare task-specific temp entries before/after the
// run. Only tracked directories are ever removed; pre-existing entries
// belonging to other processes are untouched.
{
  const after = snapshotTaskFixtures();
  const leaked = [...after].filter(name => !fixturesBeforeRun.has(name));
  check("fixtures no new temp leaks", leaked.length === 0, leaked);
}

if (failures > 0) {
  console.error(`\n${failures} runtime-mode-selection check(s) failed.`);
  process.exit(1);
}
console.log("\nAll runtime-mode-selection checks passed.");
