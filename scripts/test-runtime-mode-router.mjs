#!/usr/bin/env node
// TASK 15.5C — behavioral tests for applying the saved runtime.execution
// mode to `ap run`. Covers: pure routing-decision logic, path mapping into
// WSL, and real end-to-end subprocess behavior (disposable skill copies +
// disposable repositories + a stubbed capabilities module, exactly like
// test-setup-runtime-mode-selection.mjs's own harness pattern). Never
// patches canonical production files; never launches a real installed agent
// CLI; never touches /home/user/my-app.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {EventEmitter} from "node:events";
import {spawnSync} from "node:child_process";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import {fileURLToPath} from "node:url";
import {copySkillCanonical as copySkillCanonicalTo} from "./test-fixtures/skill-copy.mjs";
import {
  RUNTIME_MODE_IDS
} from "./runtime-mode-capabilities.mjs";
import {PLATFORM_KINDS} from "./platform-capabilities.mjs";
import {
  decideRuntimeRoute,
  mapWindowsPathToWsl,
  matchWslUncPath,
  resolvePathForDistro,
  parseRepoArg,
  stripRepoArg,
  resolveEffectiveFramework,
  routeRun,
  routeSubcommand,
  runtimeLabelFor,
  RECURSION_GUARD_ENV
} from "./runtime-mode-router.mjs";

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

const FIXTURE_PREFIXES = ["ap-rtm15c-skill-", "ap-rtm15c-repo-"];
function snapshotTaskFixtures() {
  try { return new Set(fs.readdirSync(os.tmpdir()).filter(name => FIXTURE_PREFIXES.some(p => name.startsWith(p)))); }
  catch { return new Set(); }
}
const fixturesBeforeRun = snapshotTaskFixtures();
const ownedFixtureDirs = new Set();
function ownFixtureDir(dir) { ownedFixtureDirs.add(dir); return dir; }

async function withFixtures(fn) {
  const skillCopy = ownFixtureDir(fs.mkdtempSync(path.join(os.tmpdir(), "ap-rtm15c-skill-")));
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

// Overwrites the copy's runtime-mode-capabilities.mjs with a stub whose
// detectRuntimeModeCapabilities() branches on the REAL current platform
// (process.platform / a real WSL2-kernel probe) so the SAME stub file
// serves both sides of a genuine Native-Windows -> WSL2 delegation: the
// outer (Windows) call sees `winCaps`, and the inner call — genuinely
// running inside WSL2 after delegation — sees `wsl2Caps`. Never fabricates
// which OS it is actually running on; only fabricates the discovery
// RESULT for that real OS, exactly like test-setup-runtime-mode-selection.mjs's
// own stubCapabilities() (kept intentionally simple/duplicated here rather
// than imported, since that file's helper is test-local, not exported).
function stubCapabilitiesBoth(skillCopy, {winCaps, wsl2Caps, linuxCaps}) {
  const target = path.join(skillCopy, "scripts", "runtime-mode-capabilities.mjs");
  const real = path.join(skillCopy, "scripts", "runtime-mode-capabilities.real.mjs");
  // Preserve the GENUINE module under a new name before overwriting: the
  // router now also imports runBoundedProbeTree from this module for real
  // DEFECT-4 path resolution (wslpath/test probes), and that production
  // helper must keep working against routeRun()'s injected fake spawn —
  // only detectRuntimeModeCapabilities() itself is faked here.
  fs.copyFileSync(target, real);
  const body = `export {runBoundedProbeTree} from "./runtime-mode-capabilities.real.mjs";
import fs from "node:fs";
export const RUNTIME_MODE_IDS = ${JSON.stringify({wsl2Strong: "wsl2-strong", linuxStrong: "linux-strong", windowsCompatibility: "windows-compatibility"})};
export const RUNTIME_STRENGTH = ${JSON.stringify({strong: "strong", compatibility: "compatibility"})};
export const SUPPORTED_FRAMEWORKS_ALL = ${JSON.stringify(["gsd", "speckit", "standalone"])};
export const SUPPORTED_FRAMEWORKS_SPECKIT_ONLY = ${JSON.stringify(["speckit"])};
export const SUPPORTED_FRAMEWORKS_SPECKIT_AND_STANDALONE = ${JSON.stringify(["speckit", "standalone"])};
function isGenuineWsl2() {
  try {
    const t = fs.readFileSync("/proc/sys/kernel/osrelease", "utf8");
    return /microsoft-standard|wsl2/i.test(t);
  } catch { return false; }
}
export async function detectRuntimeModeCapabilities() {
  if (process.platform === "win32") return ${JSON.stringify(winCaps ?? null)};
  if (isGenuineWsl2()) return ${JSON.stringify(wsl2Caps ?? null)};
  return ${JSON.stringify(linuxCaps ?? null)};
}
`;
  fs.writeFileSync(target, body);
}

// Stub for the single-sided (non-delegating) scenarios: same result
// regardless of platform — simplest possible fake, used whenever a test
// never crosses the Windows/WSL boundary.
function stubCapabilitiesFixed(skillCopy, caps) {
  stubCapabilitiesBoth(skillCopy, {winCaps: caps, wsl2Caps: caps, linuxCaps: caps});
}

// Replaces the copy's real mission entrypoint with a fake that never
// mutates anything: it only records the argv it received and exits 0. Any
// test asserting "mission state unchanged" / "no real agent CLI launched"
// relies on this fake never having been reached at all for an error case,
// and on it never doing anything beyond writing its own marker file for a
// success case.
function stubAutopilotEntry(skillCopy) {
  const target = path.join(skillCopy, "scripts", "autopilot.mjs");
  // The marker path is computed by the stub AT ITS OWN RUNTIME (never a
  // fixed string baked in by this — Windows-side — test process): the same
  // physical file is reached whether the stub is executed by a native
  // Windows node (direct/local scenarios) or by /usr/bin/node genuinely
  // inside WSL2 after a real delegation (backslash Windows paths are not
  // valid on the Linux side, so a hardcoded Windows path would silently
  // write to the wrong place — or fail — under delegation).
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
  const repo = ownFixtureDir(fs.mkdtempSync(path.join(os.tmpdir(), "ap-rtm15c-repo-")));
  if (framework === "speckit") {
    fs.mkdirSync(path.join(repo, ".specify", "workflows", "speckit"), {recursive: true});
    fs.writeFileSync(path.join(repo, ".specify", "workflows", "speckit", "workflow.yml"), "steps: []\n");
  }
  return repo;
}
function writeRepoConfig(repo, execution, framework = "speckit") {
  const dir = path.join(repo, ".autopilot");
  fs.mkdirSync(dir, {recursive: true});
  const cfg = {project: {planning_framework: framework}, execution};
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(cfg, null, 2));
}

function runApCli(skillCopy, repo, extraArgs = [], env = {}) {
  const result = spawnSync(process.execPath, [path.join(skillCopy, "bin", "ap.cjs"), "run", ...extraArgs, "--repo", repo], {
    encoding: "utf8",
    timeout: 60000,
    shell: false,
    env: {...withoutOuterGitGuard({...process.env}), ...env}
  });
  return result;
}

// ---------------------------------------------------------------------
// A. mapWindowsPathToWsl / matchWslUncPath — pure path recognition
//
// DEFECT 4 fix: a drive path is NEVER mapped by guessing `/mnt/<drive>`
// any more — real resolution requires a distro-side `wslpath` probe (see
// resolvePathForDistro in section A2). mapWindowsPathToWsl() stays pure/
// synchronous but a drive path now always fails closed with a reason that
// says so, rather than guessing.
// ---------------------------------------------------------------------
{
  const drive = mapWindowsPathToWsl("C:\\Users\\user\\projects\\repo", "Ubuntu");
  check("drive path is never guessed as /mnt/<drive> — requires real distro resolution", !drive.ok && drive.reason === "drive_path_requires_real_distro_resolution", drive);

  const driveRoot = mapWindowsPathToWsl("D:\\", "Ubuntu");
  check("bare drive root is also never guessed", !driveRoot.ok && driveRoot.reason === "drive_path_requires_real_distro_resolution", driveRoot);

  const uncMatch = mapWindowsPathToWsl("\\\\wsl.localhost\\Ubuntu\\home\\user\\my-app", "Ubuntu");
  check("matching wsl.localhost UNC path maps to posix path", uncMatch.ok && uncMatch.posixPath === "/home/user/my-app", uncMatch);

  const uncDollar = mapWindowsPathToWsl("\\\\wsl$\\Ubuntu\\home\\user\\my-app", "Ubuntu");
  check("matching wsl$ UNC path maps to posix path", uncDollar.ok && uncDollar.posixPath === "/home/user/my-app", uncDollar);

  const uncMismatch = mapWindowsPathToWsl("\\\\wsl.localhost\\OtherDistro\\home\\user\\x", "Ubuntu");
  check("mismatching-distro UNC path fails closed", !uncMismatch.ok && /different_distro/.test(uncMismatch.reason), uncMismatch);

  const malformedUnc = mapWindowsPathToWsl("\\\\someserver\\share\\path", "Ubuntu");
  check("non-WSL UNC host is rejected, not guessed at", !malformedUnc.ok, malformedUnc);

  const bareDriveLetter = mapWindowsPathToWsl("C:", "Ubuntu");
  check("bare drive letter with no path is rejected as unresolvable", !bareDriveLetter.ok, bareDriveLetter);

  const relative = mapWindowsPathToWsl("relative\\path", "Ubuntu");
  check("relative path is rejected as unresolvable", !relative.ok, relative);

  const empty = mapWindowsPathToWsl("", "Ubuntu");
  check("empty path is rejected", !empty.ok, empty);

  const distroWithSpace = mapWindowsPathToWsl("\\\\wsl.localhost\\My Distro\\home\\x", "My Distro");
  check("distro name containing spaces matches correctly", distroWithSpace.ok && distroWithSpace.posixPath === "/home/x", distroWithSpace);

  // matchWslUncPath directly (the function mapWindowsPathToWsl delegates to).
  const notUnc = matchWslUncPath("C:\\Users\\x", "Ubuntu");
  check("matchWslUncPath: a drive path does not match at all", notUnc.matched === false, notUnc);
  const uncOk = matchWslUncPath("\\\\wsl.localhost\\Ubuntu\\home\\user\\repo", "Ubuntu");
  check("matchWslUncPath: matching distro succeeds with zero I/O", uncOk.matched === true && uncOk.ok === true && uncOk.posixPath === "/home/user/repo", uncOk);
  const uncBad = matchWslUncPath("\\\\wsl.localhost\\Debian\\home\\user\\repo", "Ubuntu");
  check("matchWslUncPath: mismatching distro fails with zero I/O", uncBad.matched === true && uncBad.ok === false, uncBad);
}

// ---------------------------------------------------------------------
// A2. resolvePathForDistro — real distro-side resolution via fake wsl.exe
// (wslpath + test probes). Proves: non-default automount handling, UTF-8
// strictness, malformed/timeout/inaccessible failure modes, and that a
// UNC match never spawns anything at all.
// ---------------------------------------------------------------------
function fakeChild() {
  const child = new EventEmitter();
  child.pid = 424242;
  child.kill = () => true;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

// Records every argv array passed to a fake spawn function into `calls`,
// then delegates to it — used to count/inspect subprocess invocations.
function wrapSpawn(calls, fn) {
  return (binary, args, opts) => { calls.push(args); return fn(binary, args, opts); };
}

// A fake `wsl.exe` that answers `wslpath -u <path>` and `test -f/-d/-e
// <posixPath>` from a fixture table — never a real subprocess, never
// /mnt/<drive> guessing. `behavior` overrides let individual tests force
// timeout/malformed/non-UTF-8/missing-binary/inaccessible outcomes.
function makeFakeWslpathSpawn(entries, behavior = {}) {
  return (binary, args, opts) => {
    const child = fakeChild();
    if (behavior.hang) return child; // never settles -> exercises the deadline path
    queueMicrotask(() => {
      if (args[3] === "wslpath" && args[4] === "-u") {
        if (behavior.missing) { child.emit("error", {code: "ENOENT", message: "spawn wslpath ENOENT"}); return; }
        const winPath = args[5];
        if (behavior.invalidUtf8) { child.stdout.emit("data", Buffer.from([0xff, 0xfe, 0xfd])); child.emit("close", 0, null); return; }
        if (behavior.malformedMultiline) { child.stdout.emit("data", Buffer.from("/mnt/c/one\n/mnt/c/two\n")); child.emit("close", 0, null); return; }
        if (behavior.nonAbsolute) { child.stdout.emit("data", Buffer.from("not-an-absolute-path\n")); child.emit("close", 0, null); return; }
        const found = entries.find(e => e.windowsPath === winPath);
        if (found) {
          child.stdout.emit("data", Buffer.from(found.posixPath + "\n", "utf8"));
          child.emit("close", 0, null);
        } else {
          child.stderr.emit("data", Buffer.from("wslpath: fixture has no mapping for this path\n"));
          child.emit("close", 1, null);
        }
        return;
      }
      if (args[3] === "test") {
        if (behavior.inaccessible) { child.emit("close", 1, null); return; }
        const posixPath = args[5];
        const known = entries.some(e => e.posixPath === posixPath);
        child.emit("close", known ? 0 : 1, null);
        return;
      }
      child.emit("close", 1, null);
    });
    return child;
  };
}

const RESOLVE_KIND_DIR = "dir";
function resolveOpts(spawn, distro, windowsPath, extra = {}) {
  return {spawn, wslBinary: "wsl.exe", distro, windowsPath, kind: RESOLVE_KIND_DIR, deadline: Date.now() + 5000, now: () => Date.now(), killGraceMs: 100, maxOutputBytes: 8192, ...extra};
}

await (async () => {
  const spawnCalls = [];
  const wrap = fn => (b, a, o) => { spawnCalls.push({b, a, o}); return fn(b, a, o); };
  const spawn = wrap(makeFakeWslpathSpawn([{windowsPath: "C:\\Users\\user\\repo", posixPath: "/customroot/c/Users/user/repo"}]));
  const r = await resolvePathForDistro(resolveOpts(spawn, "Ubuntu", "C:\\Users\\user\\repo"));
  check("resolvePathForDistro: real/injected wslpath output is used verbatim (non-default automount root, not /mnt/c)", r.ok && r.posixPath === "/customroot/c/Users/user/repo", r);
  check("resolvePathForDistro: exactly two probes (wslpath + accessibility)", spawnCalls.length === 2, spawnCalls.map(c => c.a));
})();

await (async () => {
  const spawn = makeFakeWslpathSpawn([], {missing: true});
  const r = await resolvePathForDistro(resolveOpts(spawn, "Ubuntu", "C:\\x"));
  check("resolvePathForDistro: missing wsl.exe/wslpath fails closed", !r.ok && /unavailable/.test(r.reason), r);
})();

await (async () => {
  const spawn = makeFakeWslpathSpawn([], {hang: true});
  const r = await resolvePathForDistro(resolveOpts(spawn, "Ubuntu", "C:\\x", {deadline: Date.now() + 150, killGraceMs: 50}));
  check("resolvePathForDistro: a hung probe fails closed via the deadline, never hangs the caller", !r.ok && /timed_out/.test(r.reason), r);
})();

await (async () => {
  const spawn = makeFakeWslpathSpawn([], {malformedMultiline: true});
  const r = await resolvePathForDistro(resolveOpts(spawn, "Ubuntu", "C:\\x"));
  check("resolvePathForDistro: malformed (multi-line) wslpath output fails closed", !r.ok && /malformed/.test(r.reason), r);
})();

await (async () => {
  const spawn = makeFakeWslpathSpawn([], {invalidUtf8: true});
  const r = await resolvePathForDistro(resolveOpts(spawn, "Ubuntu", "C:\\x"));
  check("resolvePathForDistro: invalid-UTF-8 wslpath output fails closed", !r.ok && /invalid_utf8/.test(r.reason), r);
})();

await (async () => {
  const spawn = makeFakeWslpathSpawn([], {nonAbsolute: true});
  const r = await resolvePathForDistro(resolveOpts(spawn, "Ubuntu", "C:\\x"));
  check("resolvePathForDistro: a non-absolute wslpath result fails closed", !r.ok && /not_absolute/.test(r.reason), r);
})();

await (async () => {
  const spawn = makeFakeWslpathSpawn([{windowsPath: "C:\\ghost", posixPath: "/mnt/c/ghost"}], {inaccessible: true});
  const r = await resolvePathForDistro(resolveOpts(spawn, "Ubuntu", "C:\\ghost"));
  check("resolvePathForDistro: a resolved-but-inaccessible path fails closed (never launches delegation to a path that isn't really there)", !r.ok && /not_accessible/.test(r.reason), r);
})();

await (async () => {
  // A matching UNC path needs zero I/O to determine its posix path (pure
  // string mapping) but STILL goes through the real accessibility probe —
  // resolvePathForDistro validates the mapped path is genuinely reachable
  // regardless of which recognition path produced it.
  const spawnCalls = [];
  const spawn = wrapSpawn(spawnCalls, makeFakeWslpathSpawn([{windowsPath: null, posixPath: "/home/user/repo"}]));
  const r = await resolvePathForDistro(resolveOpts(spawn, "Ubuntu", "\\\\wsl.localhost\\Ubuntu\\home\\user\\repo"));
  check("resolvePathForDistro: matching UNC path resolves with zero wslpath calls, still passes through the accessibility probe", r.ok && r.posixPath === "/home/user/repo" && spawnCalls.length === 1 && spawnCalls[0][3] === "test", {r, spawnCalls});
})();

await (async () => {
  const spawnCalls = [];
  const spawn = (b, a, o) => { spawnCalls.push(a); return fakeChild(); };
  const r = await resolvePathForDistro(resolveOpts(spawn, "Ubuntu", "\\\\wsl.localhost\\OtherDistro\\home\\user\\repo"));
  check("resolvePathForDistro: mismatching-distro UNC path fails with ZERO subprocess calls", !r.ok && /different_distro/.test(r.reason) && spawnCalls.length === 0, {r, spawnCalls});
})();

await (async () => {
  const winPath = "C:\\Users\\user\\My Projects\\Café Ünïcödé\\repo";
  const posix = "/mnt/c/Users/user/My Projects/Café Ünïcödé/repo";
  const spawn = makeFakeWslpathSpawn([{windowsPath: winPath, posixPath: posix}]);
  const r = await resolvePathForDistro(resolveOpts(spawn, "Ubuntu", winPath));
  check("resolvePathForDistro: spaces and Unicode survive real/injected wslpath resolution", r.ok && r.posixPath === posix, r);
})();

// ---------------------------------------------------------------------
// B. parseRepoArg / stripRepoArg
// ---------------------------------------------------------------------
{
  const p1 = parseRepoArg(["do", "the", "thing", "--repo", "C:\\tmp\\r"], "C:\\cwd");
  check("parseRepoArg picks up --repo value", path.normalize(p1) === path.resolve("C:\\tmp\\r"), p1);
  const p2 = parseRepoArg(["do", "the", "thing"], "C:\\cwd");
  check("parseRepoArg defaults to cwd when --repo absent", p2 === path.resolve("C:\\cwd"), p2);
  const stripped = stripRepoArg(["fix the bug", "--repo", "C:\\tmp\\r", "please"]);
  check("stripRepoArg removes the flag and its value only", JSON.stringify(stripped) === JSON.stringify(["fix the bug", "please"]), stripped);
}

// ---------------------------------------------------------------------
// C. runtimeLabelFor — exact required UX strings
// ---------------------------------------------------------------------
{
  check("wsl2-strong label", runtimeLabelFor(RUNTIME_MODE_IDS.wsl2Strong) === "Runtime: WSL2 Strong (bubblewrap containment)");
  check("linux-strong label", runtimeLabelFor(RUNTIME_MODE_IDS.linuxStrong) === "Runtime: Linux Strong (bubblewrap containment)");
  check("windows-compatibility label", runtimeLabelFor(RUNTIME_MODE_IDS.windowsCompatibility) === "Runtime: Windows Compatibility (SpecKit and standalone disposable-copy isolation; not OS-enforced)");
}

// ---------------------------------------------------------------------
// D. decideRuntimeRoute — pure decision logic over canned capabilities
// ---------------------------------------------------------------------
const ALL = ["gsd", "speckit", "standalone"];
const SPECKIT_ONLY = ["speckit"];
function mode(id, available, supportedFrameworks, extra = {}) {
  const strength = id === RUNTIME_MODE_IDS.windowsCompatibility ? "compatibility" : "strong";
  return {id, available, strength, supportedFrameworks: [...supportedFrameworks], reason: available ? null : "unavailable-for-test", distro: null, ...extra};
}
function wsl2Caps({available = true} = {}) {
  return {
    currentPlatform: PLATFORM_KINDS.wsl2,
    modes: [
      mode(RUNTIME_MODE_IDS.wsl2Strong, available, ALL),
      mode(RUNTIME_MODE_IDS.linuxStrong, false, ALL),
      mode(RUNTIME_MODE_IDS.windowsCompatibility, false, SPECKIT_AND_STANDALONE)
    ],
    recommendedMode: available ? RUNTIME_MODE_IDS.wsl2Strong : null,
    usableWslDistro: null
  };
}
function linuxCaps({available = true} = {}) {
  return {
    currentPlatform: PLATFORM_KINDS.nativeLinux,
    modes: [
      mode(RUNTIME_MODE_IDS.wsl2Strong, false, ALL),
      mode(RUNTIME_MODE_IDS.linuxStrong, available, ALL),
      mode(RUNTIME_MODE_IDS.windowsCompatibility, false, SPECKIT_AND_STANDALONE)
    ],
    recommendedMode: available ? RUNTIME_MODE_IDS.linuxStrong : null,
    usableWslDistro: null
  };
}
function windowsCaps({wslAvailable = true, distro = "Ubuntu"} = {}) {
  return {
    currentPlatform: PLATFORM_KINDS.nativeWindows,
    modes: [
      {...mode(RUNTIME_MODE_IDS.wsl2Strong, wslAvailable, ALL), distro: wslAvailable ? distro : null},
      mode(RUNTIME_MODE_IDS.linuxStrong, false, ALL),
      mode(RUNTIME_MODE_IDS.windowsCompatibility, true, SPECKIT_AND_STANDALONE)
    ],
    recommendedMode: wslAvailable ? RUNTIME_MODE_IDS.wsl2Strong : RUNTIME_MODE_IDS.windowsCompatibility,
    usableWslDistro: wslAvailable ? distro : null
  };
}

const SPECKIT_AND_STANDALONE = ["speckit", "standalone"];
{
  const d = decideRuntimeRoute({capabilities: wsl2Caps(), framework: "speckit", savedExecution: {runtime_mode: "wsl2-strong", wsl_distro: null}});
  check("WSL2 Strong saved + genuinely WSL2 -> proceed directly (no delegation)", d.action === "proceed" && d.mode === RUNTIME_MODE_IDS.wsl2Strong, d);
}
{
  const d = decideRuntimeRoute({capabilities: linuxCaps(), framework: "gsd", savedExecution: {runtime_mode: "linux-strong", wsl_distro: null}});
  check("Linux Strong saved + genuinely Native Linux -> proceed directly", d.action === "proceed" && d.mode === RUNTIME_MODE_IDS.linuxStrong, d);
}
{
  const d = decideRuntimeRoute({capabilities: windowsCaps(), framework: "speckit", savedExecution: {runtime_mode: "windows-compatibility", wsl_distro: null}});
  check("Windows Compatibility saved + SpecKit -> proceed", d.action === "proceed" && d.mode === RUNTIME_MODE_IDS.windowsCompatibility, d);
}
{
  const d = decideRuntimeRoute({capabilities: windowsCaps(), framework: "gsd", savedExecution: {runtime_mode: "windows-compatibility", wsl_distro: null}});
  check("Windows Compatibility saved + GSD -> rejected clearly before mutation", d.action === "error" && /SpecKit and standalone only/i.test(d.message) && /gsd/.test(d.message), d);
}
{
  const d = decideRuntimeRoute({capabilities: windowsCaps(), framework: "standalone", savedExecution: {runtime_mode: "windows-compatibility", wsl_distro: null}});
  check("Windows Compatibility saved + standalone -> proceeds via windows-compatibility", d.action === "proceed", d);
}
{
  const d = decideRuntimeRoute({capabilities: windowsCaps(), framework: null, savedExecution: {runtime_mode: "windows-compatibility", wsl_distro: null}});
  check("Windows Compatibility saved + undetermined framework -> rejected, never assumed safe", d.action === "error" && /SpecKit and standalone only/i.test(d.message) && /undetermined/.test(d.message), d);
}
{
  const d = decideRuntimeRoute({capabilities: windowsCaps({distro: "Ubuntu"}), framework: "speckit", savedExecution: {runtime_mode: "wsl2-strong", wsl_distro: "Ubuntu"}});
  check("WSL2 Strong saved on Native Windows with matching distro -> delegate", d.action === "delegate" && d.distro === "Ubuntu", d);
}
{
  const d = decideRuntimeRoute({capabilities: windowsCaps({distro: "Ubuntu"}), framework: "speckit", savedExecution: {runtime_mode: "wsl2-strong", wsl_distro: "Ubuntu"}, alreadyRouted: true});
  check("recursive delegation is impossible: already-routed process refuses to delegate again", d.action === "error" && /[Rr]ecursive/.test(d.message), d);
}
{
  // Saved distro no longer matches the freshly discovered usable distro.
  const d = decideRuntimeRoute({capabilities: windowsCaps({distro: "Debian"}), framework: "speckit", savedExecution: {runtime_mode: "wsl2-strong", wsl_distro: "Ubuntu"}});
  check("stale saved distro (no longer matches discovery) fails closed, names the saved mode", d.action === "error" && /wsl2-strong/.test(d.message), d);
}
{
  // A WSL-side Setup saves wsl_distro: null (unpinned). From native Windows
  // that must delegate to the discovered distro, not fail routing (seen live:
  // every Windows `ap stop` fell back to a Windows-only check and reported a
  // live WSL run as "isn't running").
  const d = decideRuntimeRoute({capabilities: windowsCaps({distro: "Ubuntu"}), framework: "standalone", savedExecution: {runtime_mode: "wsl2-strong", wsl_distro: null}});
  check("unpinned saved distro (null) delegates to the discovered distro", d.action === "delegate" && d.distro === "Ubuntu", d);
  const none = decideRuntimeRoute({capabilities: windowsCaps({wslAvailable: false}), framework: "standalone", savedExecution: {runtime_mode: "wsl2-strong", wsl_distro: null}});
  check("unpinned saved distro with no usable WSL still fails closed", none.action === "error", none);
}
{
  const d = decideRuntimeRoute({capabilities: windowsCaps({wslAvailable: false}), framework: "speckit", savedExecution: {runtime_mode: "wsl2-strong", wsl_distro: "Ubuntu"}});
  check("WSL2 Strong saved but no longer usable -> fails closed, names saved mode", d.action === "error" && /wsl2-strong/.test(d.message), d);
}
{
  const d = decideRuntimeRoute({capabilities: wsl2Caps(), framework: "speckit", savedExecution: {runtime_mode: "not-a-real-mode", wsl_distro: null}});
  check("invalid saved runtime_mode fails closed before mutation, names the mode", d.action === "error" && /invalid/i.test(d.message), d);
}
{
  const d = decideRuntimeRoute({capabilities: wsl2Caps({available: false}), framework: "speckit", savedExecution: undefined});
  check("missing execution + WSL2 + bubblewrap unusable -> fails closed (no unsandboxed fallback)", d.action === "error" && /ap config/.test(d.message), d);
}
{
  const d = decideRuntimeRoute({capabilities: wsl2Caps({available: true}), framework: "speckit", savedExecution: undefined});
  check("missing execution + WSL2 + bubblewrap usable -> backward-compatible proceed", d.action === "proceed" && d.mode === RUNTIME_MODE_IDS.wsl2Strong, d);
}
{
  const d = decideRuntimeRoute({capabilities: linuxCaps({available: true}), framework: "speckit", savedExecution: undefined});
  check("missing execution + Native Linux + bubblewrap usable -> backward-compatible proceed", d.action === "proceed" && d.mode === RUNTIME_MODE_IDS.linuxStrong, d);
}
{
  const d = decideRuntimeRoute({capabilities: windowsCaps(), framework: "speckit", savedExecution: undefined});
  check("missing execution + Native Windows -> requires `ap config`, never auto-picks Compatibility", d.action === "error" && /ap config/.test(d.message), d);
}

// ---------------------------------------------------------------------
// E. resolveEffectiveFramework
// ---------------------------------------------------------------------
{
  const f1 = resolveEffectiveFramework("/x", {project: {planning_framework: "gsd"}});
  check("explicit config framework wins outright", f1 === "gsd", f1);
  const f2 = resolveEffectiveFramework("/x", {project: {planning_framework: "auto"}}, {speckitDetect: () => true, gsdDetect: () => false});
  check("auto-detects speckit when only speckit markers present", f2 === "speckit", f2);
  const f3 = resolveEffectiveFramework("/x", {}, {speckitDetect: () => true, gsdDetect: () => true});
  check("ambiguous auto-detection resolves to null, never guessed", f3 === null, f3);
}

// ---------------------------------------------------------------------
// F. routeRun() with injected fakes — no real filesystem/subprocess needed
// (fakeChild()/makeFakeWslpathSpawn() defined in section A2 above)
// ---------------------------------------------------------------------

await (async () => {
  const r = await routeRun({
    repoArgs: ["do the thing", "--repo", "C:\\whatever"],
    cwd: "C:\\cwd",
    skillRoot: "C:\\skill",
    readConfig: () => ({exists: false, config: null})
  });
  check("DEFECT 1: no config on disk -> setup-required (never proceeds locally without routing the newly-saved mode)", r.action === "setup-required" && typeof r.repo === "string", r);
})();

await (async () => {
  const r = await routeRun({
    repoArgs: ["--repo", "C:\\whatever"],
    cwd: "C:\\cwd",
    skillRoot: "C:\\skill",
    readConfig: () => ({exists: true, config: null})
  });
  check("DEFECT 1: malformed/unreadable existing config fails closed (never treated like a missing first-run config)", r.action === "error" && /could not be read or parsed/.test(r.message) && /ap config/.test(r.message), r);
})();

await (async () => {
  let calls = 0;
  const r = await routeRun({
    repoArgs: ["--repo", "C:\\whatever"],
    cwd: "C:\\cwd",
    skillRoot: "C:\\skill",
    readConfig: () => ({exists: true, config: {project: {planning_framework: "speckit"}, execution: {runtime_mode: "wsl2-strong", wsl_distro: null}}}),
    detectCapabilities: async () => { calls += 1; return wsl2Caps(); }
  });
  check("WSL2 Strong direct via routeRun(): proceeds, prints correct label", r.action === "proceed" && r.runtimeLabel === "Runtime: WSL2 Strong (bubblewrap containment)", r);
  check("capability detection invoked exactly once per run", calls === 1, calls);
})();

// The next three blocks resolve Windows-style backslash/UNC path strings
// through Node's OS-native `path.resolve()` (via parseRepoArg), which only
// understands drive letters/backslashes on an actual win32 process — on
// POSIX these strings resolve to garbage (backslash is just a literal
// character there), so these are genuinely Native-Windows-only checks, not
// "applicable" elsewhere (mapWindowsPathToWsl()'s OWN regex-based mapping
// is exercised platform-independently in section A above).
if (process.platform === "win32") {
  await (async () => {
    const spawnCalls = [];
    const delegateSpawn = (binary, args, opts) => {
      spawnCalls.push({binary, args, opts});
      const child = fakeChild();
      queueMicrotask(() => { child.emit("exit", 0, null); child.emit("close", 0, null); });
      return child;
    };
    // Repo is a matching UNC path (zero I/O to resolve its POSIX path, but
    // it is STILL run through the real accessibility probe below). The
    // skill entrypoint is a drive path, so it goes through the real/
    // injected wslpath + accessibility probes (DEFECT 4) — this fake
    // stands in for both accessibility probes and the entrypoint's wslpath
    // resolution.
    const entrypointWindowsPath = path.join("C:\\Users\\user\\.agents\\skills\\project-autopilot", "bin", "ap.cjs");
    const spawn = makeFakeWslpathSpawn([
      {windowsPath: entrypointWindowsPath, posixPath: "/mnt/c/Users/user/.agents/skills/project-autopilot/bin/ap.cjs"},
      {windowsPath: null, posixPath: "/home/user/repo"}
    ]);
    const r = await routeRun({
      repoArgs: ["implement the café Ünïcödé feature", "--repo", "\\\\wsl.localhost\\Ubuntu\\home\\user\\repo"],
      cwd: "C:\\cwd",
      skillRoot: "C:\\Users\\user\\.agents\\skills\\project-autopilot",
      readConfig: () => ({exists: true, config: {project: {planning_framework: "speckit"}, execution: {runtime_mode: "wsl2-strong", wsl_distro: "Ubuntu"}}}),
      detectCapabilities: async () => windowsCaps({distro: "Ubuntu"}),
      spawn,
      delegateSpawn
    });
    check("Native Windows delegates exactly once", spawnCalls.length === 1, spawnCalls);
    const call = spawnCalls[0];
    check("delegation invokes wsl.exe (the delegate binary)", call?.binary === "wsl.exe", call);
    // DEFECT 4 shell-injection fix: `--exec`, never plain `--` — verified
    // against this machine's real wsl.exe that `--` reconstructs the whole
    // command through the distro's default shell (backslashes eaten,
    // `$(...)`/backticks/`;` genuinely shell-interpreted), while `--exec`
    // delivers argv exactly as given.
    check("delegation uses argument-array with -d <distro> --exec /usr/bin/node <ap.cjs> run ... (never plain --, which shells out)", Array.isArray(call?.args) && call.args[0] === "-d" && call.args[1] === "Ubuntu" && call.args[2] === "--exec" && call.args[3] === "/usr/bin/node" && call.args[4] === "/mnt/c/Users/user/.agents/skills/project-autopilot/bin/ap.cjs" && call.args[5] === "run", call?.args);
    check("request text with spaces/Unicode is forwarded as one untouched argv element", call?.args.includes("implement the café Ünïcödé feature"), call?.args);
    check("--repo is remapped to the posix path inside the distro", call?.args.includes("--repo") && call.args[call.args.indexOf("--repo") + 1] === "/home/user/repo", call?.args);
    check("no shell is used for delegation", call?.opts?.shell !== true, call?.opts);
    check("recursion guard env var set on the delegated child", call?.opts?.env?.[RECURSION_GUARD_ENV] === "1", call?.opts?.env?.[RECURSION_GUARD_ENV]);
    check("routeRun reports delegated action with preserved exit status", r.action === "delegated" && r.result.status === 0, r);
  })();

  await (async () => {
    // routeSubcommand({command:"stop"}) delegates exactly like "run" but
    // forwards "stop" as the ap.cjs argv element, so a Windows `ap stop`
    // reaches missions living inside WSL2 (where the /proc liveness check
    // works) instead of reporting "No mission is running."
    const spawnCalls = [];
    const delegateSpawn = (binary, args, opts) => {
      spawnCalls.push({binary, args, opts});
      const child = fakeChild();
      queueMicrotask(() => { child.emit("exit", 0, null); child.emit("close", 0, null); });
      return child;
    };
    const entrypointWindowsPath = path.join("C:\\Users\\user\\.agents\\skills\\project-autopilot", "bin", "ap.cjs");
    const spawn = makeFakeWslpathSpawn([
      {windowsPath: entrypointWindowsPath, posixPath: "/mnt/c/Users/user/.agents/skills/project-autopilot/bin/ap.cjs"},
      {windowsPath: null, posixPath: "/home/user/repo"}
    ]);
    const r = await routeSubcommand({
      command: "stop",
      repoArgs: ["--yes", "--repo", "\\\\wsl.localhost\\Ubuntu\\home\\user\\repo"],
      cwd: "C:\\cwd",
      skillRoot: "C:\\Users\\user\\.agents\\skills\\project-autopilot",
      readConfig: () => ({exists: true, config: {project: {planning_framework: "speckit"}, execution: {runtime_mode: "wsl2-strong", wsl_distro: "Ubuntu"}}}),
      detectCapabilities: async () => windowsCaps({distro: "Ubuntu"}),
      spawn,
      delegateSpawn
    });
    check("stop delegates exactly once", spawnCalls.length === 1, spawnCalls);
    const call = spawnCalls[0];
    check("stop delegation forwards stop (not run) as the ap.cjs subcommand", Array.isArray(call?.args) && call.args[5] === "stop", call?.args);
    check("stop flags pass through untouched", call?.args.includes("--yes"), call?.args);
    check("stop --repo is remapped to the posix path", call?.args.includes("--repo") && call.args[call.args.indexOf("--repo") + 1] === "/home/user/repo", call?.args);
    check("stop delegation sets the recursion guard env", call?.opts?.env?.[RECURSION_GUARD_ENV] === "1", call?.opts?.env?.[RECURSION_GUARD_ENV]);
    check("routeSubcommand reports delegated action with preserved exit status", r.action === "delegated" && r.result.status === 0, r);
    let threw = false;
    try { await routeSubcommand({command: "run-do-everything", repoArgs: []}); } catch { threw = true; }
    check("routeSubcommand rejects commands other than run/stop/cancel", threw);
  })();

  await (async () => {
    // routeSubcommand({command:"cancel"}) delegates exactly like "stop" but
    // forwards "cancel" as the ap.cjs argv element, so a Windows `ap cancel`
    // stops a WSL2-live run where it runs (instead of missing it and
    // orphaning it past the mission end) before ending the mission.
    const spawnCalls = [];
    const delegateSpawn = (binary, args, opts) => {
      spawnCalls.push({binary, args, opts});
      const child = fakeChild();
      queueMicrotask(() => { child.emit("exit", 0, null); child.emit("close", 0, null); });
      return child;
    };
    const entrypointWindowsPath = path.join("C:\\Users\\user\\.agents\\skills\\project-autopilot", "bin", "ap.cjs");
    const spawn = makeFakeWslpathSpawn([
      {windowsPath: entrypointWindowsPath, posixPath: "/mnt/c/Users/user/.agents/skills/project-autopilot/bin/ap.cjs"},
      {windowsPath: null, posixPath: "/home/user/repo"}
    ]);
    const r = await routeSubcommand({
      command: "cancel",
      repoArgs: ["operational reason", "--yes", "--repo", "\\\\wsl.localhost\\Ubuntu\\home\\user\\repo"],
      cwd: "C:\\cwd",
      skillRoot: "C:\\Users\\user\\.agents\\skills\\project-autopilot",
      readConfig: () => ({exists: true, config: {project: {planning_framework: "speckit"}, execution: {runtime_mode: "wsl2-strong", wsl_distro: "Ubuntu"}}}),
      detectCapabilities: async () => windowsCaps({distro: "Ubuntu"}),
      spawn,
      delegateSpawn
    });
    check("cancel delegates exactly once", spawnCalls.length === 1, spawnCalls);
    const call = spawnCalls[0];
    check("cancel delegation forwards cancel (not run/stop) as the ap.cjs subcommand", Array.isArray(call?.args) && call.args[5] === "cancel", call?.args);
    check("cancel reason and flags pass through untouched", call?.args.includes("operational reason") && call?.args.includes("--yes"), call?.args);
    check("cancel --repo is remapped to the posix path", call?.args.includes("--repo") && call.args[call.args.indexOf("--repo") + 1] === "/home/user/repo", call?.args);
    check("cancel delegation sets the recursion guard env", call?.opts?.env?.[RECURSION_GUARD_ENV] === "1", call?.opts?.env?.[RECURSION_GUARD_ENV]);
    check("routeSubcommand reports delegated action with preserved exit status", r.action === "delegated" && r.result.status === 0, r);
  })();

  await (async () => {
    // A UNC --repo naming a DIFFERENT distro than the saved one fails closed
    // before any subprocess is even spawned.
    const spawnCalls = [];
    const delegateSpawn = (binary, args, opts) => { spawnCalls.push({binary, args, opts}); return fakeChild(); };
    const r = await routeRun({
      repoArgs: ["--repo", "\\\\wsl.localhost\\OtherDistro\\home\\user\\repo"],
      cwd: "C:\\cwd",
      skillRoot: "C:\\Users\\user\\.agents\\skills\\project-autopilot",
      readConfig: () => ({exists: true, config: {project: {planning_framework: "speckit"}, execution: {runtime_mode: "wsl2-strong", wsl_distro: "Ubuntu"}}}),
      detectCapabilities: async () => windowsCaps({distro: "Ubuntu"}),
      delegateSpawn
    });
    check("mismatching-distro --repo UNC path fails closed before any spawn", r.action === "error" && spawnCalls.length === 0, {r, spawnCalls});
  })();

  await (async () => {
    // Exit code / signal preservation for a non-zero, and a signal, exit.
    const makeSpawn = outcome => (binary, args, opts) => {
      const child = fakeChild();
      queueMicrotask(() => {
        if (outcome.signal) { child.emit("exit", null, outcome.signal); child.emit("close", null, outcome.signal); }
        else { child.emit("exit", outcome.code, null); child.emit("close", outcome.code, null); }
      });
      return child;
    };
    const entrypointWindowsPath = path.join("C:\\skill", "bin", "ap.cjs");
    const spawn = makeFakeWslpathSpawn([
      {windowsPath: "C:\\repo", posixPath: "/mnt/c/repo"},
      {windowsPath: entrypointWindowsPath, posixPath: "/mnt/c/skill/bin/ap.cjs"}
    ]);
    const base = {
      repoArgs: ["--repo", "C:\\repo"],
      cwd: "C:\\cwd",
      skillRoot: "C:\\skill",
      readConfig: () => ({exists: true, config: {project: {planning_framework: "speckit"}, execution: {runtime_mode: "wsl2-strong", wsl_distro: "Ubuntu"}}}),
      detectCapabilities: async () => windowsCaps({distro: "Ubuntu"}),
      spawn
    };
    const r1 = await routeRun({...base, delegateSpawn: makeSpawn({code: 7})});
    check("non-zero delegated exit code is preserved", r1.result.status === 7, r1);
    const r2 = await routeRun({...base, delegateSpawn: makeSpawn({signal: "SIGTERM"})});
    check("delegated termination signal is preserved", r2.result.signal === "SIGTERM", r2);
  })();
} else {
  console.log("ok: (skipped — Windows-style path resolution via parseRepoArg only applies on a genuine win32 process) Native Windows delegates exactly once / path mapping / exit-signal preservation via fake delegateSpawn");
}

// ---------------------------------------------------------------------
// G. Real subprocess behavior via disposable skill copy + repo
// ---------------------------------------------------------------------
await withFixtures(async ({skillCopy, trackRepo}) => {
  stubCapabilitiesFixed(skillCopy, wsl2Caps());
  const marker = stubAutopilotEntry(skillCopy);
  const repo = trackRepo(makeRepo("speckit"));
  writeRepoConfig(repo, {runtime_mode: "wsl2-strong", wsl_distro: null});
  const proc = runApCli(skillCopy, repo, ["do the thing"]);
  check("real subprocess, WSL2 Strong direct: exits 0", proc.status === 0, {status: proc.status, stdout: proc.stdout, stderr: proc.stderr});
  check("real subprocess, WSL2 Strong direct: prints the Runtime line", /Runtime: WSL2 Strong \(bubblewrap containment\)/.test(proc.stdout || ""), proc.stdout);
  check("real subprocess: workflow ordering unchanged — autopilot entry received 'run' first", fs.existsSync(marker) && JSON.parse(fs.readFileSync(marker, "utf8")).argv[0] === "run", marker);
});

await withFixtures(async ({skillCopy, trackRepo}) => {
  stubCapabilitiesFixed(skillCopy, linuxCaps());
  stubAutopilotEntry(skillCopy);
  const repo = trackRepo(makeRepo("speckit"));
  writeRepoConfig(repo, {runtime_mode: "linux-strong", wsl_distro: null});
  const proc = runApCli(skillCopy, repo);
  check("real subprocess, Native Linux Strong direct: exits 0 and prints Runtime line", proc.status === 0 && /Runtime: Linux Strong \(bubblewrap containment\)/.test(proc.stdout || ""), {status: proc.status, stdout: proc.stdout});
});

await withFixtures(async ({skillCopy, trackRepo}) => {
  stubCapabilitiesFixed(skillCopy, windowsCaps({wslAvailable: false}));
  stubAutopilotEntry(skillCopy);
  const repo = trackRepo(makeRepo("speckit"));
  writeRepoConfig(repo, {runtime_mode: "windows-compatibility", wsl_distro: null}, "speckit");
  const proc = runApCli(skillCopy, repo);
  check("real subprocess, Windows Compatibility (SpecKit and standalone): exits 0 and prints Runtime line, not OS-enforced", proc.status === 0 && /Runtime: Windows Compatibility \(SpecKit and standalone disposable-copy isolation; not OS-enforced\)/.test(proc.stdout || ""), {status: proc.status, stdout: proc.stdout});
});

await withFixtures(async ({skillCopy, trackRepo}) => {
  stubCapabilitiesFixed(skillCopy, windowsCaps({wslAvailable: false}));
  const marker = stubAutopilotEntry(skillCopy);
  const repo = trackRepo(makeRepo("speckit"));
  fs.mkdirSync(path.join(repo, ".planning"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".planning", "ROADMAP.md"), "# roadmap\n");
  writeRepoConfig(repo, {runtime_mode: "windows-compatibility", wsl_distro: null}, "gsd");
  const proc = runApCli(skillCopy, repo);
  check("real subprocess: Windows Compatibility never starts GSD — rejected", proc.status !== 0 && /SpecKit and standalone only/i.test(proc.stderr || ""), {status: proc.status, stderr: proc.stderr});
  check("real subprocess: mission state never created for rejected GSD run", !fs.existsSync(marker) && !fs.existsSync(path.join(repo, ".autopilot", "state.json")) && !fs.existsSync(path.join(repo, ".autopilot", "runs")), {marker: fs.existsSync(marker)});
});

await withFixtures(async ({skillCopy, trackRepo}) => {
  stubCapabilitiesFixed(skillCopy, windowsCaps());
  const marker = stubAutopilotEntry(skillCopy);
  const repo = trackRepo(makeRepo("speckit"));
  writeRepoConfig(repo, {runtime_mode: "not-a-real-mode", wsl_distro: null});
  const proc = runApCli(skillCopy, repo);
  check("real subprocess: invalid saved execution config fails before any launch, names it", proc.status !== 0 && /not-a-real-mode/.test(proc.stderr || ""), {status: proc.status, stderr: proc.stderr});
  check("real subprocess: no autopilot entry launch, no mission artifacts for invalid config", !fs.existsSync(marker) && !fs.existsSync(path.join(repo, ".autopilot", "state.json")));
});

await withFixtures(async ({skillCopy, trackRepo}) => {
  stubCapabilitiesFixed(skillCopy, windowsCaps());
  const marker = stubAutopilotEntry(skillCopy);
  const repo = trackRepo(makeRepo("speckit"));
  // config.json exists but has no `execution` key at all (pre-15.5A schema).
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), JSON.stringify({project: {planning_framework: "speckit"}}, null, 2));
  const proc = runApCli(skillCopy, repo);
  check("real subprocess: missing execution config on Native Windows requires `ap config`, never silently picks Compatibility", proc.status !== 0 && /ap config/i.test(proc.stderr || "") && !/Runtime:/.test(proc.stdout || ""), {status: proc.status, stdout: proc.stdout, stderr: proc.stderr});
  check("real subprocess: mission state untouched for missing-execution-on-Windows failure", !fs.existsSync(marker) && !fs.existsSync(path.join(repo, ".autopilot", "state.json")));
});

await withFixtures(async ({skillCopy, trackRepo}) => {
  stubCapabilitiesFixed(skillCopy, wsl2Caps());
  stubAutopilotEntry(skillCopy);
  const repo = trackRepo(makeRepo("speckit"));
  // config.json exists but has no `execution` key — backward compatible on WSL2.
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), JSON.stringify({project: {planning_framework: "speckit"}}, null, 2));
  const proc = runApCli(skillCopy, repo);
  check("real subprocess: missing execution config on WSL2 stays backward-compatible (proceeds)", proc.status === 0 && /Runtime: WSL2 Strong/.test(proc.stdout || ""), {status: proc.status, stdout: proc.stdout, stderr: proc.stderr});
});

await withFixtures(async ({skillCopy, trackRepo}) => {
  // `ap run --help` must keep printing help unconditionally, even when the
  // saved config would otherwise fail routing before mutation (here:
  // Native Windows with no saved execution mode at all) — help is never
  // gated behind mission-mode discovery.
  stubCapabilitiesFixed(skillCopy, windowsCaps());
  const marker = stubAutopilotEntry(skillCopy);
  const repo = trackRepo(makeRepo("speckit"));
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), JSON.stringify({project: {planning_framework: "speckit"}}, null, 2));
  const proc = runApCli(skillCopy, repo, ["--help"]);
  // The fake autopilot.mjs stub always writes its marker once reached (it
  // does not itself implement --help short-circuiting) — reaching it at
  // all, successfully, is exactly the proof that routing was bypassed
  // rather than evaluated: the same saved config would otherwise fail
  // routing with a non-zero exit (see the "missing execution config on
  // Native Windows" case above).
  check("real subprocess: `ap run --help` bypasses routing entirely, even with a config that would otherwise fail", proc.status === 0 && fs.existsSync(marker), {status: proc.status, stdout: proc.stdout});
});

await withFixtures(async ({skillCopy, trackRepo}) => {
  // A saved wsl2-strong process that is ALREADY inside a routed invocation
  // must refuse to delegate again, even if (hypothetically) it still saw
  // Native Windows capabilities — proving recursive delegation cannot
  // reoccur regardless of how it might be triggered.
  stubCapabilitiesFixed(skillCopy, windowsCaps({distro: "Ubuntu"}));
  const marker = stubAutopilotEntry(skillCopy);
  const repo = trackRepo(makeRepo("speckit"));
  writeRepoConfig(repo, {runtime_mode: "wsl2-strong", wsl_distro: "Ubuntu"});
  const proc = runApCli(skillCopy, repo, [], {[RECURSION_GUARD_ENV]: "1"});
  check("real subprocess: recursion guard blocks a second delegation attempt", proc.status !== 0 && /[Rr]ecursive/.test(proc.stderr || "") && !fs.existsSync(marker), {status: proc.status, stderr: proc.stderr});
});

// ---------------------------------------------------------------------
// H. Real genuine Native-Windows -> WSL2 delegation, and timeout/cleanup,
// using the machine's real wsl.exe/Ubuntu/bwrap when actually usable.
// Opportunistic: proves the real behavior on machines that have it (this
// one does), and reports a clear, honest skip elsewhere rather than a
// fabricated pass.
// ---------------------------------------------------------------------
function realWslUsable() {
  if (process.platform !== "win32") return {ok: false, reason: "not_native_windows"};
  try {
    const list = spawnSync("wsl.exe", ["--list", "--quiet"], {timeout: 5000, shell: false});
    if (list.status !== 0) return {ok: false, reason: "wsl_list_failed"};
    const node = spawnSync("wsl.exe", ["-d", "Ubuntu", "--", "/usr/bin/node", "--version"], {timeout: 8000, shell: false});
    if (node.status !== 0) return {ok: false, reason: "node_unusable_in_ubuntu"};
    const bwrap = spawnSync("wsl.exe", ["-d", "Ubuntu", "--", "bwrap", "--version"], {timeout: 8000, shell: false});
    if (bwrap.status !== 0) return {ok: false, reason: "bwrap_unusable_in_ubuntu"};
    return {ok: true};
  } catch {
    return {ok: false, reason: "probe_threw"};
  }
}

const realWsl = realWslUsable();
if (realWsl.ok) {
  await withFixtures(async ({skillCopy, trackRepo}) => {
    // Real, platform-branching stub (see stubCapabilitiesBoth): the outer
    // Windows call sees Native-Windows+wsl2-strong-available/Ubuntu; the
    // inner call — genuinely running inside WSL2 after real delegation —
    // sees WSL2+bubblewrap-available, matching this machine's real distro.
    stubCapabilitiesBoth(skillCopy, {winCaps: windowsCaps({distro: "Ubuntu"}), wsl2Caps: wsl2Caps()});
    const marker = stubAutopilotEntry(skillCopy);
    const repo = trackRepo(makeRepo("speckit"));
    writeRepoConfig(repo, {runtime_mode: "wsl2-strong", wsl_distro: "Ubuntu"});
    const proc = runApCli(skillCopy, repo, ["build the café façade"]);
    check("REAL Native-Windows -> WSL2 delegation: exits 0", proc.status === 0, {status: proc.status, stdout: proc.stdout, stderr: proc.stderr});
    check("REAL delegation: WSL2-side Runtime line is what the user actually sees (delegation is transparent)", /Runtime: WSL2 Strong \(bubblewrap containment\)/.test(proc.stdout || ""), proc.stdout);
    // A file just created from the Linux side of a DrvFs (/mnt/c/...) mount
    // can take an instant to become visible to a synchronous existsSync()
    // on the Windows side immediately afterward — poll briefly rather than
    // asserting on a single check with no tolerance for that cross-boundary
    // visibility latency.
    let markerSeen = fs.existsSync(marker);
    const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
    for (let attempt = 0; !markerSeen && attempt < 20; attempt++) {
      Atomics.wait(sleepBuf, 0, 0, 50);
      markerSeen = fs.existsSync(marker);
    }
    check("REAL delegation: fake mission entrypoint genuinely ran INSIDE WSL2 (proves crossing the boundary, not a no-op)", markerSeen, marker);
    if (fs.existsSync(marker)) {
      const recorded = JSON.parse(fs.readFileSync(marker, "utf8"));
      check("REAL delegation: request text with Unicode preserved end-to-end through wsl.exe", recorded.argv.includes("build the café façade"), recorded.argv);
      check("REAL delegation: repository path correctly remapped to the WSL-side posix path", recorded.cwd !== repo, {cwd: recorded.cwd, repo});
    }
    check("REAL delegation: /home/user/my-app was never referenced or touched", !new RegExp(String.raw`/home/user/my-app`).test(JSON.stringify(proc)), null);
  });

  await withFixtures(async ({skillCopy, trackRepo}) => {
    // Shell-injection regression (discovered while fixing DEFECT 4): plain
    // `wsl.exe -d <distro> -- <cmd> <args>` (no `--exec`) reconstructs the
    // whole command line and runs it through the distro's DEFAULT LOGIN
    // SHELL — verified directly against this machine's real wsl.exe that
    // `$(...)`/backticks/`;` in an argument are then genuinely
    // shell-interpreted, not merely passed through. A canary file proves
    // it either way: if the request text's embedded `rm -f` ever actually
    // ran through a shell, the canary would be deleted.
    stubCapabilitiesBoth(skillCopy, {winCaps: windowsCaps({distro: "Ubuntu"}), wsl2Caps: wsl2Caps()});
    const marker = stubAutopilotEntry(skillCopy);
    const repo = trackRepo(makeRepo("speckit"));
    writeRepoConfig(repo, {runtime_mode: "wsl2-strong", wsl_distro: "Ubuntu"});
    const canary = path.join(repo, "canary.txt");
    fs.writeFileSync(canary, "still here\n");
    const trickyRequest = "weird $(whoami) `id` request; rm -f " + canary.replace(/\\/g, "/");
    const proc = runApCli(skillCopy, repo, [trickyRequest]);
    check("REAL delegation: shell metacharacters in the request never execute (canary file survives)", fs.existsSync(canary), {status: proc.status, canaryExists: fs.existsSync(canary)});
    let markerSeen = fs.existsSync(marker);
    const sleepBuf2 = new Int32Array(new SharedArrayBuffer(4));
    for (let attempt = 0; !markerSeen && attempt < 20; attempt++) {
      Atomics.wait(sleepBuf2, 0, 0, 50);
      markerSeen = fs.existsSync(marker);
    }
    if (markerSeen) {
      const recorded = JSON.parse(fs.readFileSync(marker, "utf8"));
      check("REAL delegation: the exact request string (including shell metacharacters) is forwarded as ONE untouched argv element", recorded.argv.includes(trickyRequest), recorded.argv);
    } else {
      check("REAL delegation: fake mission entrypoint ran for the shell-metacharacter request", false, {proc});
    }
  });

  await (async () => {
    // Bounded process-tree termination is real and confirmed: spawn a
    // genuinely long-sleeping process inside WSL2 through the same
    // inherited-stdio launcher used for delegation, with a short deadline,
    // and verify it is actually terminated (not left running) and reported
    // as timed out with termination NOT failed.
    const {runBoundedInheritedProcess} = await import("./bounded-process-tree.mjs");
    const result = await runBoundedInheritedProcess(
      (await import("node:child_process")).spawn,
      "wsl.exe",
      ["-d", "Ubuntu", "--exec", "sleep", "30"],
      {deadlineMs: 500, killGraceMs: 300, stdio: "ignore"}
    );
    check("timeout and process-tree cleanup are bounded and confirmed for a real hung child", result.timedOut === true && result.terminationFailed === false, result);
  })();
} else {
  console.log(`ok: (skipped — real WSL2/Ubuntu/bwrap not usable on this machine right now: ${realWsl.reason}) real Native-Windows -> WSL2 delegation and real timeout/cleanup`);
}

// ---------------------------------------------------------------------
// I. bounded-process-tree.mjs — deterministic behavior with fakes
// ---------------------------------------------------------------------
await (async () => {
  const {runBoundedInheritedProcess} = await import("./bounded-process-tree.mjs");
  const spawnFn = () => { const c = fakeChild(); queueMicrotask(() => { c.emit("exit", 3, null); c.emit("close", 3, null); }); return c; };
  const r = await runBoundedInheritedProcess(spawnFn, "irrelevant", [], {deadlineMs: null});
  check("no deadline (real mission use): natural completion preserved untouched", r.status === 3 && r.timedOut === false, r);
})();

await (async () => {
  const {runBoundedInheritedProcess} = await import("./bounded-process-tree.mjs");
  // A child that never emits close/exit at all: must still settle via the
  // deterministic backstop, never hang the caller forever.
  const groupKillCalls = [];
  const spawnFn = () => fakeChild();
  const r = await runBoundedInheritedProcess(spawnFn, "irrelevant", [], {
    deadlineMs: 100,
    killGraceMs: 100,
    isWindows: false,
    groupAliveFn: () => true, // simulate a group that never dies
    killGroupFn: (pid, signal) => { groupKillCalls.push(signal); return true; },
    confirmPollMs: 20,
    confirmAttempts: 3,
    backstopSlackMs: 50
  });
  check("wedged child settles via deterministic backstop, never hangs", r.timedOut === true, r);
  check("unconfirmed termination is reported fail-closed (terminationFailed:true)", r.terminationFailed === true, r);
  check("SIGTERM then SIGKILL escalation both attempted on the full process group", groupKillCalls.includes("SIGTERM") && groupKillCalls.includes("SIGKILL"), groupKillCalls);
})();

// ---------------------------------------------------------------------
console.log("");
console.log(`Fixture leak check: created ${ownedFixtureDirs.size} disposable dirs, all removed in finally blocks.`);
const fixturesAfterRun = snapshotTaskFixtures();
check("no disposable fixture directories leaked", fixturesAfterRun.size <= fixturesBeforeRun.size, {before: [...fixturesBeforeRun], after: [...fixturesAfterRun]});

if (failures > 0) {
  console.error(`\n${failures} runtime-mode-router check(s) failed.`);
  process.exit(1);
}
console.log("\nAll runtime-mode-router checks passed.");
