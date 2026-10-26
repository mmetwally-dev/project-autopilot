#!/usr/bin/env node
// TASK 15.5C CORRECTION — behavioral tests for bin/ap.cjs's first-run
// Setup orchestration (DEFECT 1), bin/_dispatch.cjs's async-safe dispatch
// (DEFECT 2), public help wording (DEFECT 3), and delegated signal
// semantics at the public CLI boundary (DEFECT 5). Disposable skill copies
// and disposable repositories only; never patches canonical production
// files; never launches a real installed agent CLI; never touches
// /home/user/my-app.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import {fileURLToPath} from "node:url";
import {copySkillCanonical as copySkillCanonicalTo} from "./test-fixtures/skill-copy.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

let failures = 0;
function check(name, condition, detail) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL: ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 2000)}` : ""}`);
  } else {
    console.log(`ok: ${name}`);
  }
}

const FIXTURE_PREFIXES = ["ap-rtm15c2-skill-", "ap-rtm15c2-repo-"];
function snapshotTaskFixtures() {
  try { return new Set(fs.readdirSync(os.tmpdir()).filter(name => FIXTURE_PREFIXES.some(p => name.startsWith(p)))); }
  catch { return new Set(); }
}
const fixturesBeforeRun = snapshotTaskFixtures();
const ownedFixtureDirs = new Set();
function ownFixtureDir(dir) { ownedFixtureDirs.add(dir); return dir; }

async function withFixtures(fn) {
  const skillCopy = ownFixtureDir(fs.mkdtempSync(path.join(os.tmpdir(), "ap-rtm15c2-skill-")));
  const repos = [];
  try {
    copySkillCanonical(skillCopy);
    const ctx = {skillCopy, trackRepo: r => { repos.push(r); return r; }};
    return await fn(ctx);
  } finally {
    for (const r of repos) { try { fs.rmSync(r, {recursive: true, force: true}); } catch {} }
    try { fs.rmSync(skillCopy, {recursive: true, force: true}); } catch {}
    for (const dir of [...ownedFixtureDirs]) {
      ownedFixtureDirs.delete(dir);
      try { fs.rmSync(dir, {recursive: true, force: true}); } catch {}
    }
  }
}

function copySkillCanonical(dest) {
  copySkillCanonicalTo(root, dest);
}

// Real, platform-branching capabilities stub (see test-runtime-mode-router.mjs's
// own stubCapabilitiesBoth): the OUTER Native-Windows call and the INNER
// call genuinely running inside WSL2 after real delegation each see their
// own canned result, decided by the REAL current platform.
function stubCapabilitiesBoth(skillCopy, {winCaps, wsl2Caps}) {
  const target = path.join(skillCopy, "scripts", "runtime-mode-capabilities.mjs");
  const real = path.join(skillCopy, "scripts", "runtime-mode-capabilities.real.mjs");
  fs.copyFileSync(target, real);
  const body = `export {runBoundedProbeTree} from "./runtime-mode-capabilities.real.mjs";
import fs from "node:fs";
export const RUNTIME_MODE_IDS = ${JSON.stringify({wsl2Strong: "wsl2-strong", linuxStrong: "linux-strong", windowsCompatibility: "windows-compatibility"})};
export const RUNTIME_STRENGTH = ${JSON.stringify({strong: "strong", compatibility: "compatibility"})};
export const SUPPORTED_FRAMEWORKS_ALL = ${JSON.stringify(["gsd", "speckit", "standalone"])};
export const SUPPORTED_FRAMEWORKS_SPECKIT_ONLY = ${JSON.stringify(["speckit"])};
export const SUPPORTED_FRAMEWORKS_SPECKIT_AND_STANDALONE = ${JSON.stringify(["speckit", "standalone"])};
function isGenuineWsl2() {
  try { return /microsoft-standard|wsl2/i.test(fs.readFileSync("/proc/sys/kernel/osrelease", "utf8")); } catch { return false; }
}
export async function detectRuntimeModeCapabilities() {
  if (process.platform === "win32") return ${JSON.stringify(winCaps ?? null)};
  if (isGenuineWsl2()) return ${JSON.stringify(wsl2Caps ?? null)};
  return null;
}
`;
  fs.writeFileSync(target, body);
}

function stubCapabilitiesFixed(skillCopy, caps) {
  const target = path.join(skillCopy, "scripts", "runtime-mode-capabilities.mjs");
  const real = path.join(skillCopy, "scripts", "runtime-mode-capabilities.real.mjs");
  fs.copyFileSync(target, real);
  const body = `export {runBoundedProbeTree} from "./runtime-mode-capabilities.real.mjs";
export const RUNTIME_MODE_IDS = ${JSON.stringify({wsl2Strong: "wsl2-strong", linuxStrong: "linux-strong", windowsCompatibility: "windows-compatibility"})};
export const RUNTIME_STRENGTH = ${JSON.stringify({strong: "strong", compatibility: "compatibility"})};
export const SUPPORTED_FRAMEWORKS_ALL = ${JSON.stringify(["gsd", "speckit", "standalone"])};
export const SUPPORTED_FRAMEWORKS_SPECKIT_ONLY = ${JSON.stringify(["speckit"])};
export const SUPPORTED_FRAMEWORKS_SPECKIT_AND_STANDALONE = ${JSON.stringify(["speckit", "standalone"])};
export async function detectRuntimeModeCapabilities() { return ${JSON.stringify(caps)}; }
`;
  fs.writeFileSync(target, body);
}

// Replaces scripts/runtime-mode-router.mjs entirely with a canned decision
// (or a stateful sequence of decisions, one per call) — used ONLY for the
// handful of scenarios that are otherwise impractical to construct through
// the real router (a forced rejection, an "always setup-required" infinite-
// loop-prevention proof, and exact signal-exit-code mapping at the CLI
// boundary). Every other scenario in this file uses the REAL router.
function stubRouterCanned(skillCopy, decisions) {
  const target = path.join(skillCopy, "scripts", "runtime-mode-router.mjs");
  const counterFile = path.join(skillCopy, "ROUTER-CALL-COUNT.json");
  fs.writeFileSync(counterFile, "0");
  const body = `import fs from "node:fs";
const counterFile = ${JSON.stringify(counterFile)};
const decisions = ${JSON.stringify(decisions)};
export const RECURSION_GUARD_ENV = "AUTOPILOT_RUNTIME_ROUTED";
export async function routeRun() {
  const n = Number(fs.readFileSync(counterFile, "utf8"));
  fs.writeFileSync(counterFile, String(n + 1));
  const idx = Math.min(n, decisions.length - 1);
  return decisions[idx];
}
`;
  fs.writeFileSync(target, body);
  return counterFile;
}

// Replaces bin/ap.cjs's exported `main` with a fake that always rejects —
// used only to prove bin/_dispatch.cjs's OWN Promise-rejection handling
// (DEFECT 2) without needing to defeat this codebase's already-thorough
// internal try/catch coverage (which makes a genuine unhandled rejection
// from the real ap.cjs hard to construct honestly).
function stubApMainRejecting(skillCopy, message) {
  const target = path.join(skillCopy, "bin", "ap.cjs");
  const body = `'use strict';
async function main() { throw new Error(${JSON.stringify(message)}); }
if (require.main === module) {
  Promise.resolve(main(process.argv.slice(2))).then(
    code => { process.exitCode = code; },
    error => { console.error('ERROR: ' + (error && error.message ? error.message : error)); process.exitCode = 1; }
  );
}
module.exports = {main};
`;
  fs.writeFileSync(target, body);
}

// A fake Setup wizard: writes (or withholds) a valid config.json for the
// `--repo` it was invoked with, exactly mirroring what a real `ap setup`
// run would leave behind — the real router then classifies it normally.
function stubSetupWizard(skillCopy, behavior) {
  const target = path.join(skillCopy, "scripts", "setup.mjs");
  const invocationsFile = path.join(skillCopy, "FAKE-SETUP-INVOCATIONS.json");
  fs.writeFileSync(invocationsFile, "[]");
  const body = `import fs from "node:fs";
import path from "node:path";
const invocationsFile = ${JSON.stringify(invocationsFile)};
const args = process.argv.slice(2);
const list = JSON.parse(fs.readFileSync(invocationsFile, "utf8"));
list.push(args);
fs.writeFileSync(invocationsFile, JSON.stringify(list));
const idx = args.indexOf("--repo");
const repo = idx !== -1 ? args[idx + 1] : process.cwd();
const behavior = ${JSON.stringify(behavior)};
if (behavior === "fail") { console.error("FAKE SETUP: simulated failure"); process.exit(1); }
if (behavior === "succeed-no-config") { console.log("FAKE SETUP: simulated success without writing a config"); process.exit(0); }
const dir = path.join(repo, ".autopilot");
fs.mkdirSync(dir, {recursive: true});
let execution;
if (behavior === "succeed-wsl2") execution = {runtime_mode: "wsl2-strong", wsl_distro: "Ubuntu"};
else if (behavior === "succeed-compat") execution = {runtime_mode: "windows-compatibility", wsl_distro: null};
fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({project: {planning_framework: "speckit"}, execution}, null, 2));
console.log("FAKE SETUP: wrote config for behavior=" + behavior);
process.exit(0);
`;
  fs.writeFileSync(target, body);
  return invocationsFile;
}

function stubAutopilotEntry(skillCopy) {
  const target = path.join(skillCopy, "scripts", "autopilot.mjs");
  const body = `import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const marker = path.join(here, "..", "FAKE-AUTOPILOT-INVOKED.json");
fs.writeFileSync(marker, JSON.stringify({argv: process.argv.slice(2), cwd: process.cwd()}, null, 2));
console.log("FAKE-AUTOPILOT-RAN");
process.exit(0);
`;
  fs.writeFileSync(target, body);
  return path.join(skillCopy, "FAKE-AUTOPILOT-INVOKED.json");
}

function makeRepo(framework = "speckit") {
  const repo = ownFixtureDir(fs.mkdtempSync(path.join(os.tmpdir(), "ap-rtm15c2-repo-")));
  if (framework === "speckit") {
    fs.mkdirSync(path.join(repo, ".specify", "workflows", "speckit"), {recursive: true});
    fs.writeFileSync(path.join(repo, ".specify", "workflows", "speckit", "workflow.yml"), "steps: []\n");
  }
  return repo;
}

function runCli(skillCopy, binName, repo, extraArgs = [], env = {}) {
  return spawnSync(process.execPath, [path.join(skillCopy, "bin", binName), "run", ...extraArgs, "--repo", repo], {
    encoding: "utf8",
    timeout: 60000,
    shell: false,
    env: {...withoutOuterGitGuard({...process.env}), ...env}
  });
}

// ---------------------------------------------------------------------
// DEFECT 1: first-run Setup orchestration (real router + fake Setup)
// ---------------------------------------------------------------------
await withFixtures(async ({skillCopy, trackRepo}) => {
  // Setup succeeds and selects Windows Compatibility: continues locally,
  // exactly once, no delegation, no loop.
  stubCapabilitiesFixed(skillCopy, {
    currentPlatform: "native-windows",
    modes: [
      {id: "wsl2-strong", available: false, strength: "strong", supportedFrameworks: ["gsd", "speckit", "standalone"], reason: "wsl_not_installed", distro: null},
      {id: "linux-strong", available: false, strength: "strong", supportedFrameworks: ["gsd", "speckit", "standalone"], reason: "not_applicable_current_platform_is_native_windows", distro: null},
      {id: "windows-compatibility", available: true, strength: "compatibility", supportedFrameworks: ["speckit", "standalone"], reason: "disposable-copy compatibility isolation (not OS-enforced containment) — SpecKit and standalone only", distro: null}
    ],
    recommendedMode: "windows-compatibility",
    usableWslDistro: null
  });
  const invocations = stubSetupWizard(skillCopy, "succeed-compat");
  const marker = stubAutopilotEntry(skillCopy);
  const repo = trackRepo(makeRepo("speckit"));
  const proc = runCli(skillCopy, "ap.cjs", repo, ["do the thing"]);
  check("DEFECT 1: no-config run invokes Setup exactly once", JSON.parse(fs.readFileSync(invocations, "utf8")).length === 1, fs.readFileSync(invocations, "utf8"));
  check("DEFECT 1: Setup selecting Windows Compatibility continues locally, exit 0", proc.status === 0, {status: proc.status, stdout: proc.stdout, stderr: proc.stderr});
  check("DEFECT 1: Runtime line reflects the newly-saved mode after Setup", /Runtime: Windows Compatibility/.test(proc.stdout || ""), proc.stdout);
  check("DEFECT 1: the mission entrypoint actually ran after Setup", fs.existsSync(marker), marker);
});

await withFixtures(async ({skillCopy, trackRepo}) => {
  // Setup fails (nonzero exit): no mission ever launches, no artifacts.
  stubCapabilitiesFixed(skillCopy, {currentPlatform: "native-windows", modes: [], recommendedMode: null, usableWslDistro: null});
  const invocations = stubSetupWizard(skillCopy, "fail");
  const marker = stubAutopilotEntry(skillCopy);
  const repo = trackRepo(makeRepo("speckit"));
  const proc = runCli(skillCopy, "ap.cjs", repo);
  check("DEFECT 1: failed Setup -> ap run stops nonzero", proc.status !== 0, {status: proc.status, stderr: proc.stderr});
  check("DEFECT 1: failed Setup invoked exactly once (no retry loop)", JSON.parse(fs.readFileSync(invocations, "utf8")).length === 1);
  check("DEFECT 1: failed Setup -> no mission entrypoint launch, no state artifacts", !fs.existsSync(marker) && !fs.existsSync(path.join(repo, ".autopilot", "state.json")));
});

await withFixtures(async ({skillCopy, trackRepo}) => {
  // Setup exits 0 but writes no config: fails closed, Setup invoked exactly
  // once (never a second attempt — no Setup/routing loop).
  stubCapabilitiesFixed(skillCopy, {currentPlatform: "native-windows", modes: [], recommendedMode: null, usableWslDistro: null});
  const invocations = stubSetupWizard(skillCopy, "succeed-no-config");
  const marker = stubAutopilotEntry(skillCopy);
  const repo = trackRepo(makeRepo("speckit"));
  const proc = runCli(skillCopy, "ap.cjs", repo);
  check("DEFECT 1: Setup completing without a valid config fails closed", proc.status !== 0 && /still does not exist/i.test(proc.stderr || ""), {status: proc.status, stderr: proc.stderr});
  check("DEFECT 1: Setup invoked exactly once even though it produced no config (no loop)", JSON.parse(fs.readFileSync(invocations, "utf8")).length === 1);
  check("DEFECT 1: no mission entrypoint launch when Setup produced no config", !fs.existsSync(marker));
});

await withFixtures(async ({skillCopy, trackRepo}) => {
  // Malformed EXISTING config must fail before Setup is even considered —
  // never treated like the missing-config first-run case.
  stubCapabilitiesFixed(skillCopy, {currentPlatform: "native-windows", modes: [], recommendedMode: null, usableWslDistro: null});
  const invocations = stubSetupWizard(skillCopy, "succeed-compat");
  const marker = stubAutopilotEntry(skillCopy);
  const repo = trackRepo(makeRepo("speckit"));
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), "{ this is not valid json");
  const proc = runCli(skillCopy, "ap.cjs", repo);
  check("DEFECT 1: malformed existing config fails before Setup/Autopilot launch", proc.status !== 0 && /could not be read or parsed/.test(proc.stderr || ""), {status: proc.status, stderr: proc.stderr});
  check("DEFECT 1: malformed config never triggers Setup", JSON.parse(fs.readFileSync(invocations, "utf8")).length === 0);
  check("DEFECT 1: malformed config -> no mission entrypoint launch", !fs.existsSync(marker));
});

await withFixtures(async ({skillCopy, trackRepo}) => {
  // Unreadable existing config (a directory in place of the file) also
  // fails before Setup/Autopilot launch.
  stubCapabilitiesFixed(skillCopy, {currentPlatform: "native-windows", modes: [], recommendedMode: null, usableWslDistro: null});
  const invocations = stubSetupWizard(skillCopy, "succeed-compat");
  const marker = stubAutopilotEntry(skillCopy);
  const repo = trackRepo(makeRepo("speckit"));
  fs.mkdirSync(path.join(repo, ".autopilot", "config.json"), {recursive: true}); // a directory, not a file: unreadable as config
  const proc = runCli(skillCopy, "ap.cjs", repo);
  check("DEFECT 1: unreadable existing config (directory in its place) fails before Setup/Autopilot launch", proc.status !== 0 && /could not be read or parsed/.test(proc.stderr || ""), {status: proc.status, stderr: proc.stderr});
  check("DEFECT 1: unreadable config never triggers Setup", JSON.parse(fs.readFileSync(invocations, "utf8")).length === 0);
  check("DEFECT 1: unreadable config -> no mission entrypoint launch", !fs.existsSync(marker));
});

// ---------------------------------------------------------------------
// DEFECT 1 (real): Setup selecting WSL2 Strong on a genuine first run
// delegates the FIRST mission exactly once, and it never launches locally
// on Windows first — proven with the machine's real wsl.exe/Ubuntu/bwrap
// when actually usable (this one has it); a clear, honest skip otherwise.
// ---------------------------------------------------------------------
function realWslUsable() {
  if (process.platform !== "win32") return {ok: false, reason: "not_native_windows"};
  try {
    const list = spawnSync("wsl.exe", ["--list", "--quiet"], {timeout: 5000, shell: false});
    if (list.status !== 0) return {ok: false, reason: "wsl_list_failed"};
    const node = spawnSync("wsl.exe", ["-d", "Ubuntu", "--exec", "/usr/bin/node", "--version"], {timeout: 8000, shell: false});
    if (node.status !== 0) return {ok: false, reason: "node_unusable_in_ubuntu"};
    const bwrap = spawnSync("wsl.exe", ["-d", "Ubuntu", "--exec", "bwrap", "--version"], {timeout: 8000, shell: false});
    if (bwrap.status !== 0) return {ok: false, reason: "bwrap_unusable_in_ubuntu"};
    return {ok: true};
  } catch {
    return {ok: false, reason: "probe_threw"};
  }
}
const realWsl = realWslUsable();
if (realWsl.ok) {
  await withFixtures(async ({skillCopy, trackRepo}) => {
    stubCapabilitiesBoth(skillCopy, {
      winCaps: {
        currentPlatform: "native-windows",
        modes: [
          {id: "wsl2-strong", available: true, strength: "strong", supportedFrameworks: ["gsd", "speckit", "standalone"], reason: null, distro: "Ubuntu"},
          {id: "linux-strong", available: false, strength: "strong", supportedFrameworks: ["gsd", "speckit", "standalone"], reason: "not_applicable_current_platform_is_native_windows", distro: null},
          {id: "windows-compatibility", available: true, strength: "compatibility", supportedFrameworks: ["speckit", "standalone"], reason: "disposable-copy compatibility isolation (not OS-enforced containment) — SpecKit and standalone only", distro: null}
        ],
        recommendedMode: "wsl2-strong",
        usableWslDistro: "Ubuntu"
      },
      wsl2Caps: {
        currentPlatform: "wsl2",
        modes: [
          {id: "wsl2-strong", available: true, strength: "strong", supportedFrameworks: ["gsd", "speckit", "standalone"], reason: null, distro: null},
          {id: "linux-strong", available: false, strength: "strong", supportedFrameworks: ["gsd", "speckit", "standalone"], reason: "not_applicable_current_platform_is_wsl2", distro: null},
          {id: "windows-compatibility", available: false, strength: "compatibility", supportedFrameworks: ["speckit", "standalone"], reason: "not_applicable_current_platform_is_wsl2", distro: null}
        ],
        recommendedMode: "wsl2-strong",
        usableWslDistro: null
      }
    });
    const invocations = stubSetupWizard(skillCopy, "succeed-wsl2");
    const marker = stubAutopilotEntry(skillCopy);
    const repo = trackRepo(makeRepo("speckit"));
    const proc = runCli(skillCopy, "ap.cjs", repo, ["first real mission"]);
    check("DEFECT 1 (real): first-run Setup invoked exactly once", JSON.parse(fs.readFileSync(invocations, "utf8")).length === 1, fs.readFileSync(invocations, "utf8"));
    check("DEFECT 1 (real): first mission after Setup exits 0", proc.status === 0, {status: proc.status, stdout: proc.stdout, stderr: proc.stderr});
    check("DEFECT 1 (real): first mission is DELEGATED — the Runtime line the user sees is the WSL2-side one (proof it never ran locally on Windows first)", /Runtime: WSL2 Strong \(bubblewrap containment\)/.test(proc.stdout || ""), proc.stdout);
    let markerSeen = fs.existsSync(marker);
    const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
    for (let attempt = 0; !markerSeen && attempt < 20; attempt++) {
      Atomics.wait(sleepBuf, 0, 0, 50);
      markerSeen = fs.existsSync(marker);
    }
    check("DEFECT 1 (real): the mission entrypoint genuinely ran INSIDE WSL2 (crossed the boundary — not a local Windows run)", markerSeen, marker);
  });
} else {
  console.log(`ok: (skipped — real WSL2/Ubuntu/bwrap not usable on this machine right now: ${realWsl.reason}) DEFECT 1 (real): first-run Setup + first-mission delegation`);
}

await withFixtures(async ({skillCopy, trackRepo}) => {
  // A router that ALWAYS reports setup-required (simulating a case where
  // even a freshly-written config still looks absent to the router, e.g. a
  // filesystem race) must still invoke Setup exactly once and then fail
  // closed — never loop indefinitely.
  const invocations = stubSetupWizard(skillCopy, "succeed-wsl2");
  const marker = stubAutopilotEntry(skillCopy);
  const repo = trackRepo(makeRepo("speckit"));
  stubRouterCanned(skillCopy, [{action: "setup-required", repo}]);
  const proc = runCli(skillCopy, "ap.cjs", repo);
  check("DEFECT 1: a router that always reports setup-required still invokes Setup exactly once, never loops", JSON.parse(fs.readFileSync(invocations, "utf8")).length === 1, fs.readFileSync(invocations, "utf8"));
  check("DEFECT 1: ...and fails closed afterward rather than looping forever", proc.status !== 0 && /still does not exist/i.test(proc.stderr || ""), {status: proc.status, stderr: proc.stderr});
  check("DEFECT 1: ...and never launches the mission entrypoint", !fs.existsSync(marker));
});

// ---------------------------------------------------------------------
// DEFECT 5: delegated signal semantics at the public CLI boundary
// (canned router decisions — this is the one scenario that is impractical
// to construct through the real router/real wsl.exe deterministically).
// ---------------------------------------------------------------------
await withFixtures(async ({skillCopy, trackRepo}) => {
  stubRouterCanned(skillCopy, [{action: "delegated", distro: "Ubuntu", result: {status: null, signal: "SIGTERM", timedOut: false, terminationFailed: false, error: null}}]);
  const repo = trackRepo(makeRepo("speckit"));
  const proc = runCli(skillCopy, "ap.cjs", repo);
  check("DEFECT 5: a SIGTERM-terminated delegated mission yields the conventional 128+15=143 exit code at the public CLI boundary (never a generic 1)", proc.status === 143, {status: proc.status, stderr: proc.stderr});
});

await withFixtures(async ({skillCopy, trackRepo}) => {
  stubRouterCanned(skillCopy, [{action: "delegated", distro: "Ubuntu", result: {status: null, signal: "SIGKILL", timedOut: false, terminationFailed: false, error: null}}]);
  const repo = trackRepo(makeRepo("speckit"));
  const proc = runCli(skillCopy, "ap.cjs", repo);
  check("DEFECT 5: a SIGKILL-terminated delegated mission yields 128+9=137 at the public CLI boundary", proc.status === 137, {status: proc.status});
});

await withFixtures(async ({skillCopy, trackRepo}) => {
  stubRouterCanned(skillCopy, [{action: "delegated", distro: "Ubuntu", result: {status: 5, signal: null, timedOut: false, terminationFailed: false, error: null}}]);
  const repo = trackRepo(makeRepo("speckit"));
  const proc = runCli(skillCopy, "ap.cjs", repo);
  check("DEFECT 5: a plain nonzero delegated exit code is preserved unchanged at the public CLI boundary", proc.status === 5, {status: proc.status});
});

// ---------------------------------------------------------------------
// DEFECT 2: bin/_dispatch.cjs — async-safe compatibility dispatcher
// ---------------------------------------------------------------------
await withFixtures(async ({skillCopy}) => {
  const proc = spawnSync(process.execPath, [path.join(skillCopy, "bin", "_dispatch.cjs"), "run", "--help"], {encoding: "utf8", timeout: 15000, shell: false});
  const combined = `${proc.stdout || ""}\n${proc.stderr || ""}`;
  check("DEFECT 2: `_dispatch.cjs run --help` exits 0", proc.status === 0, {status: proc.status, combined: combined.slice(-500)});
  check("DEFECT 2: `_dispatch.cjs run --help` never crashes with ERR_INVALID_ARG_TYPE (the Promise-to-exitCode bug)", !/ERR_INVALID_ARG_TYPE/.test(combined), combined.slice(-1000));
});

await withFixtures(async ({skillCopy, trackRepo}) => {
  stubCapabilitiesFixed(skillCopy, {
    currentPlatform: "wsl2",
    modes: [
      {id: "wsl2-strong", available: true, strength: "strong", supportedFrameworks: ["gsd", "speckit", "standalone"], reason: null, distro: null},
      {id: "linux-strong", available: false, strength: "strong", supportedFrameworks: ["gsd", "speckit", "standalone"], reason: "not_applicable_current_platform_is_wsl2", distro: null},
      {id: "windows-compatibility", available: false, strength: "compatibility", supportedFrameworks: ["speckit", "standalone"], reason: "not_applicable_current_platform_is_wsl2", distro: null}
    ],
    recommendedMode: "wsl2-strong",
    usableWslDistro: null
  });
  const marker = stubAutopilotEntry(skillCopy);
  const repo = trackRepo(makeRepo("speckit"));
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), JSON.stringify({project: {planning_framework: "speckit"}, execution: {runtime_mode: "wsl2-strong", wsl_distro: null}}, null, 2));
  const proc = runCli(skillCopy, "_dispatch.cjs", repo);
  check("DEFECT 2: `_dispatch.cjs run ...` correctly awaits the async result and proceeds normally", proc.status === 0 && fs.existsSync(marker) && /Runtime: WSL2 Strong/.test(proc.stdout || ""), {status: proc.status, stdout: proc.stdout, stderr: proc.stderr});
});

await withFixtures(async ({skillCopy, trackRepo}) => {
  stubApMainRejecting(skillCopy, "SIMULATED_REJECTION_FOR_TEST");
  const repo = trackRepo(makeRepo("speckit"));
  const proc = runCli(skillCopy, "_dispatch.cjs", repo);
  const combined = `${proc.stdout || ""}\n${proc.stderr || ""}`;
  check("DEFECT 2: a rejected main() yields a clean nonzero exit (never ERR_INVALID_ARG_TYPE, never an unhandled-rejection crash)", proc.status === 1 && !/ERR_INVALID_ARG_TYPE/.test(combined) && /SIMULATED_REJECTION_FOR_TEST/.test(combined), {status: proc.status, combined: combined.slice(-1000)});
  check("DEFECT 2: the rejection is reported exactly once", (combined.match(/SIMULATED_REJECTION_FOR_TEST/g) || []).length === 1, combined);
});

// ---------------------------------------------------------------------
// DEFECT 3: public help text accurately describes both runtime modes
// ---------------------------------------------------------------------
{
  const proc = spawnSync(process.execPath, [path.join(root, "bin", "ap.cjs"), "--help"], {encoding: "utf8", timeout: 15000, shell: false});
  const text = proc.stdout || "";
  check("DEFECT 3: help mentions WSL2/Linux Strong mode", /WSL2\/Linux Strong/.test(text), text);
  check("DEFECT 3: help mentions OS-enforced bubblewrap containment", /OS-enforced bubblewrap/.test(text), text);
  check("DEFECT 3: help mentions Windows Compatibility for SpecKit and standalone", /Windows[\s\S]{0,40}Compatibility mode/.test(text), text);
  check("DEFECT 3: help clarifies Compatibility is not OS-enforced", /not OS-enforced/.test(text), text);
  check("DEFECT 3: help mentions GSD still requires Strong mode", /GSD still requires Strong mode/.test(text), text);
  check("DEFECT 3: help no longer claims plain Windows cannot support these roles", !/not currently supported/.test(text) && !/plain Windows without WSL/.test(text), text);
}
{
  const skillMd = fs.readFileSync(path.join(root, "SKILL.md"), "utf8");
  check("DEFECT 3: SKILL.md no longer claims Windows-without-WSL is unsupported for the same reason", !/does not currently support these roles/.test(skillMd), null);
  check("DEFECT 3: SKILL.md documents Windows Compatibility disposable-copy isolation", /windows-compatibility/.test(skillMd) && /disposable-copy isolation/.test(skillMd), null);
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const safety = fs.readFileSync(path.join(root, "docs", "safety.md"), "utf8");
  check("DEFECT 3: README.md no longer claims those roles are simply unsupported on Windows", !/those three roles are not currently supported there/.test(readme) && !/does not currently support these roles/.test(readme), null);
  check("DEFECT 3: docs/safety.md documents Windows Compatibility disposable-copy isolation", /[Dd]isposable-copy isolation/.test(safety), null);
}

// ---------------------------------------------------------------------
console.log("");
console.log(`Fixture leak check: created ${ownedFixtureDirs.size} disposable dirs, all removed in finally blocks.`);
const fixturesAfterRun = snapshotTaskFixtures();
check("no disposable fixture directories leaked", fixturesAfterRun.size <= fixturesBeforeRun.size, {before: [...fixturesBeforeRun], after: [...fixturesAfterRun]});

if (failures > 0) {
  console.error(`\n${failures} runtime-mode-launcher check(s) failed.`);
  process.exit(1);
}
console.log("\nAll runtime-mode-launcher checks passed.");
