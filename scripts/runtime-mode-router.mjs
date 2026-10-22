// TASK 15.5C — apply the saved runtime.execution mode to `ap run` (and,
// since `ap stop` must reach missions living inside WSL2, to `ap stop`).
//
// Routing only. Runs from bin/ap.cjs BEFORE scripts/autopilot.mjs is even
// spawned, so a routing failure never creates/mutates mission state, never
// creates a .autopilot/runs artifact, never starts planning, and never
// launches an agent CLI (preflight or otherwise).
//
// Reuses (never duplicates):
//   - runtime-mode-capabilities.mjs for the real, bounded, at-run-time
//     bubblewrap/WSL-distro capability probe.
//   - runtime-mode-selection.mjs's classifySavedRuntimeExecution() for
//     deciding whether the saved execution config is still valid/usable.
//   - config-validation.mjs's structural validation (via
//     classifySavedRuntimeExecution -> validateExecutionConfig).
// The only new mechanism here is deciding WHAT TO DO with that
// classification (proceed locally / delegate into WSL2 / fail closed) and,
// for Native Windows selecting a saved wsl2-strong distro, delegating the
// entire `ap run` / `ap stop` invocation into that distro exactly once via
// bounded-process-tree.mjs's inherited-stdio launcher.
import fs from "node:fs";
import path from "node:path";
import {spawn as nodeSpawn} from "node:child_process";
import {detectRuntimeModeCapabilities, RUNTIME_MODE_IDS, runBoundedProbeTree} from "./runtime-mode-capabilities.mjs";
import {classifySavedRuntimeExecution} from "./runtime-mode-selection.mjs";
import {PLATFORM_KINDS} from "./platform-capabilities.mjs";
import {runBoundedInheritedProcess} from "./bounded-process-tree.mjs";
import {loadAndMigrateConfig} from "./config-migration.mjs";
import * as speckit from "../adapters/speckit.mjs";
import * as gsd from "../adapters/gsd.mjs";

// Set on the delegated child's environment. Real recursion is already
// structurally impossible (delegation only fires when the CURRENT process
// is genuinely Native Windows; the delegated child runs genuinely inside
// WSL2, where platform detection alone routes it to the direct/local
// branch) — this is a second, independently-testable guard against ever
// attempting a second delegation from within an already-routed process.
export const RECURSION_GUARD_ENV = "AUTOPILOT_RUNTIME_ROUTED";

export function runtimeLabelFor(mode) {
  if (mode === RUNTIME_MODE_IDS.wsl2Strong) return "Runtime: WSL2 Strong (bubblewrap containment)";
  if (mode === RUNTIME_MODE_IDS.linuxStrong) return "Runtime: Linux Strong (bubblewrap containment)";
  if (mode === RUNTIME_MODE_IDS.windowsCompatibility) return "Runtime: Windows Compatibility (SpecKit and standalone disposable-copy isolation; not OS-enforced)";
  return null;
}

// Mirrors autopilot.mjs's own `--repo` parsing exactly (path.resolve against
// the value following the LAST/only `--repo` flag, defaulting to cwd).
export function parseRepoArg(args, cwd) {
  const idx = args.indexOf("--repo");
  const raw = idx !== -1 ? (args[idx + 1] || ".") : cwd;
  return path.resolve(raw);
}

export function stripRepoArg(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo") { i++; continue; }
    out.push(args[i]);
  }
  return out;
}

// Mirrors autopilot.mjs's planningAdapter() framework resolution: an
// explicit, known config value wins outright; otherwise auto-detect between
// SpecKit/GSD only (standalone is never auto-detected, matching existing
// behavior) and only when exactly one hits. Ambiguous/undetected resolves to
// null — callers must treat null conservatively (never as "safe for
// Windows Compatibility").
export function resolveEffectiveFramework(repo, config, {speckitDetect = speckit.detect, gsdDetect = gsd.detect} = {}) {
  const pf = config?.project?.planning_framework;
  if (pf === "speckit" || pf === "gsd" || pf === "standalone") return pf;
  const hits = [];
  try { if (speckitDetect(repo)) hits.push("speckit"); } catch { /* treat as not detected */ }
  try { if (gsdDetect(repo)) hits.push("gsd"); } catch { /* treat as not detected */ }
  return hits.length === 1 ? hits[0] : null;
}

const UNC_WSL_RE = /^\\\\(wsl\.localhost|wsl\$)\\([^\\]+)(\\.*)?$/i;
const DRIVE_RE = /^([A-Za-z]):[\\/](.*)$/;

/**
 * Recognize (never resolve-by-guessing) a
 * \\wsl.localhost\<distro>\... / \\wsl$\<distro>\... UNC path. Pure string
 * matching — no I/O — because a UNC path already unambiguously names the
 * POSIX path AND the distro; there is nothing to probe. Spaces/Unicode in
 * the distro name or the rest of the path survive untouched.
 *
 * Returns:
 *   {matched:false}                      — not a WSL UNC path at all
 *   {matched:true, ok:true, posixPath}    — names `distro` correctly
 *   {matched:true, ok:false, reason}      — names a DIFFERENT distro
 */
export function matchWslUncPath(inputPath, distro) {
  if (typeof inputPath !== "string" || inputPath.length === 0) return {matched: false};
  const uncMatch = inputPath.match(UNC_WSL_RE);
  if (!uncMatch) return {matched: false};
  const namedDistro = uncMatch[2];
  if (namedDistro.toLowerCase() !== String(distro).toLowerCase()) {
    return {matched: true, ok: false, reason: `unc_path_names_different_distro:${namedDistro}`};
  }
  const rest = (uncMatch[3] || "").slice(1).replace(/\\/g, "/");
  return {matched: true, ok: true, posixPath: `/${rest}`.replace(/\/+$/, "") || "/"};
}

function isUnsupportedUncHost(inputPath) {
  return /^\\\\/.test(inputPath) && !UNC_WSL_RE.test(inputPath);
}

function looksLikeWindowsDrivePath(inputPath) {
  return DRIVE_RE.test(inputPath);
}

/**
 * DEFECT 4 fix: a drive path (`C:\...`) is no longer mapped by guessing
 * `/mnt/<lower-drive>/...` — WSL's automount root is configurable
 * (`/etc/wsl.conf` `[automount] root=`) and drive mounting can be disabled
 * entirely, so that guess is not universally correct. Kept for pure,
 * synchronous UNC-only recognition (no I/O, no distro needed for that part);
 * a drive path now always fails closed with a reason telling the caller a
 * real distro-side resolution (resolvePathForDistro() below) is required —
 * it is never silently guessed here.
 *
 * Returns {ok:true, posixPath} or {ok:false, reason}.
 */
export function mapWindowsPathToWsl(inputPath, distro) {
  if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
    return {ok: false, reason: "empty_path"};
  }
  if (typeof distro !== "string" || distro.trim().length === 0) {
    return {ok: false, reason: "no_target_distro"};
  }
  const uncResult = matchWslUncPath(inputPath, distro);
  if (uncResult.matched) {
    return uncResult.ok ? {ok: true, posixPath: uncResult.posixPath} : {ok: false, reason: uncResult.reason};
  }
  if (isUnsupportedUncHost(inputPath)) {
    return {ok: false, reason: "unsupported_unc_host"};
  }
  if (looksLikeWindowsDrivePath(inputPath)) {
    return {ok: false, reason: "drive_path_requires_real_distro_resolution"};
  }
  return {ok: false, reason: "unresolvable_path"};
}

export const DEFAULT_PATH_RESOLVE_TIMEOUT_MS = 20000;
export const DEFAULT_PATH_RESOLVE_KILL_GRACE_MS = 300;
export const DEFAULT_PATH_RESOLVE_MAX_OUTPUT_BYTES = 8 * 1024;

// Strict UTF-8 decode of the RAW probe bytes (never the probe's own
// lenient/replacement-character stdoutText) — invalid UTF-8 from a distro's
// `wslpath` fails closed instead of silently mangling the path.
function strictDecodeUtf8(buffer) {
  try {
    return {ok: true, text: new TextDecoder("utf-8", {fatal: true}).decode(buffer)};
  } catch {
    return {ok: false};
  }
}

// Resolves ONE Windows drive path through the target distro's REAL
// `wslpath -u` behavior — never a guessed `/mnt/<drive>` construction — so
// a non-default automount root, or drive mounting disabled entirely, is
// honored (or fails closed) exactly as that distro actually behaves.
//
// Uses `--exec` (never plain `--`): `wsl.exe -d <distro> -- <cmd> <args>`
// (no `--exec`/`-e`) reconstructs the whole command line and runs it
// through the distro's DEFAULT LOGIN SHELL (`$SHELL -c "..."`) — verified
// against this machine's real wsl.exe: a Windows path's backslashes are
// silently eaten (`C:\Users\x` arrives at wslpath as `C:Usersx`), AND a
// windowsPath or later a request/repo string containing shell
// metacharacters (`$(...)`, backticks, `;`) would be genuinely
// shell-interpreted — an injection risk, not merely a mangled path.
// `--exec` bypasses that shell reconstruction entirely and delivers argv
// exactly as given, confirmed byte-for-byte against this machine's real
// wsl.exe for backslashes, spaces, Unicode, and shell metacharacters alike.
async function resolveDrivePathViaWslpath({spawn, wslBinary, distro, windowsPath, deadline, now, killGraceMs, maxOutputBytes}) {
  const probe = await runBoundedProbeTree(spawn, wslBinary, ["-d", distro, "--exec", "wslpath", "-u", windowsPath], {deadline, now, killGraceMs, maxOutputBytes});
  if (probe.kind === "missing") return {ok: false, reason: "wslpath_or_wsl_unavailable"};
  if (probe.kind === "timeout") return {ok: false, reason: "wslpath_probe_timed_out"};
  if (probe.kind === "error") return {ok: false, reason: `wslpath_probe_failed: ${probe.detail}`};
  if (probe.kind === "broken") return {ok: false, reason: `wslpath_probe_unusable: ${probe.detail}`};
  const decoded = strictDecodeUtf8(probe.stdoutBytes);
  if (!decoded.ok) return {ok: false, reason: "wslpath_output_invalid_utf8"};
  const lines = decoded.text.split(/\r?\n/).filter(line => line.length > 0);
  if (lines.length !== 1) return {ok: false, reason: "wslpath_output_malformed"};
  const posixPath = lines[0];
  if (!posixPath.startsWith("/")) return {ok: false, reason: `wslpath_output_not_absolute:${posixPath.slice(0, 200)}`};
  return {ok: true, posixPath};
}

// Confirms the resolved posix path is genuinely reachable inside the distro
// (not merely syntactically plausible) via a bounded `test -f`/`-d`/`-e`
// probe — the same reused probe lifecycle as above. A nonzero exit (path
// absent, or wrong type) is reported by runBoundedProbeTree as kind
// "broken", which this treats as "not accessible", never as a crash.
async function checkDistroPathAccessible({spawn, wslBinary, distro, posixPath, kind, deadline, now, killGraceMs, maxOutputBytes}) {
  const flag = kind === "file" ? "-f" : kind === "dir" ? "-d" : "-e";
  // `--exec`, not `--`: see resolveDrivePathViaWslpath's comment above.
  const probe = await runBoundedProbeTree(spawn, wslBinary, ["-d", distro, "--exec", "test", flag, posixPath], {deadline, now, killGraceMs, maxOutputBytes});
  if (probe.kind === "missing") return {ok: false, reason: "wsl_or_test_unavailable"};
  if (probe.kind === "timeout") return {ok: false, reason: "accessibility_probe_timed_out"};
  if (probe.kind === "error") return {ok: false, reason: `accessibility_probe_failed: ${probe.detail}`};
  if (probe.kind === "broken") return {ok: false, reason: `path_not_accessible_in_distro:${posixPath}`};
  return {ok: true};
}

/**
 * Full real path resolution for delegation: recognizes a matching WSL UNC
 * path with zero I/O; otherwise resolves a Windows drive path through the
 * distro's real `wslpath`; either way, confirms the resulting posix path is
 * actually reachable inside the distro before returning success. Never
 * guesses `/mnt/<drive>` — a drive path whose real resolution is
 * unavailable (wsl.exe/wslpath missing, a timeout, malformed/non-UTF-8
 * output, or a non-absolute result) fails closed instead.
 *
 * @param {"dir"|"file"} kind what the accessibility probe should check for.
 */
export async function resolvePathForDistro({spawn, wslBinary, distro, windowsPath, kind, deadline, now, killGraceMs, maxOutputBytes}) {
  if (typeof windowsPath !== "string" || windowsPath.trim().length === 0) return {ok: false, reason: "empty_path"};
  if (typeof distro !== "string" || distro.trim().length === 0) return {ok: false, reason: "no_target_distro"};

  let posixPath;
  const uncResult = matchWslUncPath(windowsPath, distro);
  if (uncResult.matched) {
    if (!uncResult.ok) return {ok: false, reason: uncResult.reason};
    posixPath = uncResult.posixPath;
  } else if (isUnsupportedUncHost(windowsPath)) {
    return {ok: false, reason: "unsupported_unc_host"};
  } else if (looksLikeWindowsDrivePath(windowsPath)) {
    const resolved = await resolveDrivePathViaWslpath({spawn, wslBinary, distro, windowsPath, deadline, now, killGraceMs, maxOutputBytes});
    if (!resolved.ok) return resolved;
    posixPath = resolved.posixPath;
  } else {
    return {ok: false, reason: "unresolvable_path"};
  }

  const accessible = await checkDistroPathAccessible({spawn, wslBinary, distro, posixPath, kind, deadline, now, killGraceMs, maxOutputBytes});
  if (!accessible.ok) return {ok: false, reason: accessible.reason};
  return {ok: true, posixPath};
}

/**
 * Pure decision logic: given already-computed capabilities (from
 * detectRuntimeModeCapabilities), the resolved framework, and the saved
 * execution config, decide what `ap run` should do next. No I/O.
 *
 * Returns one of:
 *   {action:"proceed", mode}                 — continue into autopilot.mjs directly
 *   {action:"delegate", distro}               — delegate the whole run into that WSL distro
 *   {action:"error", message}                 — fail before any mission mutation
 */
export function decideRuntimeRoute({capabilities, framework, savedExecution, alreadyRouted = false}) {
  const platform = capabilities?.currentPlatform;
  const classification = classifySavedRuntimeExecution({savedExecution, capabilities, framework});

  if (classification.status === "invalid") {
    return {action: "error", message: `Saved runtime mode is invalid: ${classification.reason} Run \`ap config\` to fix the saved execution mode.`};
  }
  if (classification.status === "unavailable") {
    return {action: "error", message: `Saved runtime mode '${String(savedExecution?.runtime_mode)}' is no longer usable: ${classification.reason} Run \`ap config\` to choose a valid runtime mode.`};
  }

  if (classification.status === "missing") {
    // Backward compatibility (task 15.5C rule 7): a config that predates the
    // execution field may keep working on WSL2/Native Linux as long as
    // bubblewrap is genuinely usable right now — but Native Windows always
    // requires an explicit saved selection; it must never silently fall
    // back to the weaker Compatibility mode.
    if (platform === PLATFORM_KINDS.wsl2) {
      const mode = capabilities?.modes?.find(m => m.id === RUNTIME_MODE_IDS.wsl2Strong);
      if (mode?.available) return {action: "proceed", mode: RUNTIME_MODE_IDS.wsl2Strong};
      return {action: "error", message: `No runtime execution mode is saved, and WSL2 Strong (bubblewrap) is not usable: ${mode?.reason || "unavailable"}. Run \`ap config\`.`};
    }
    if (platform === PLATFORM_KINDS.nativeLinux) {
      const mode = capabilities?.modes?.find(m => m.id === RUNTIME_MODE_IDS.linuxStrong);
      if (mode?.available) return {action: "proceed", mode: RUNTIME_MODE_IDS.linuxStrong};
      return {action: "error", message: `No runtime execution mode is saved, and Linux Strong (bubblewrap) is not usable: ${mode?.reason || "unavailable"}. Run \`ap config\`.`};
    }
    if (platform === PLATFORM_KINDS.nativeWindows) {
      return {action: "error", message: "No runtime execution mode is saved for this project. Run `ap config` to choose WSL2 Strong or Windows Compatibility before running `ap run` on Native Windows."};
    }
    return {action: "error", message: `No supported runtime execution mode is available on this platform (${String(platform)}). Run \`ap config\` for details.`};
  }

  // classification.status === "preserved" from here on.
  const mode = savedExecution.runtime_mode;

  if (mode === RUNTIME_MODE_IDS.wsl2Strong) {
    if (platform === PLATFORM_KINDS.wsl2) return {action: "proceed", mode};
    if (platform === PLATFORM_KINDS.nativeWindows) {
      if (alreadyRouted) {
        return {action: "error", message: "Refusing recursive Autopilot runtime delegation: this process is already inside a routed `ap run` (AUTOPILOT_RUNTIME_ROUTED is set)."};
      }
      // A null wsl_distro is "not pinned" (Setup ran inside WSL, where no
      // distro is recorded): delegate to the distro discovery found, which
      // classifySavedRuntimeExecution already accepted.
      const distro = savedExecution.wsl_distro
        ?? capabilities?.modes?.find(entry => entry?.id === RUNTIME_MODE_IDS.wsl2Strong)?.distro
        ?? capabilities?.usableWslDistro
        ?? null;
      return {action: "delegate", distro};
    }
    return {action: "error", message: `Saved runtime mode 'wsl2-strong' does not apply on this platform (${String(platform)}). Run \`ap config\`.`};
  }

  if (mode === RUNTIME_MODE_IDS.linuxStrong) {
    if (platform === PLATFORM_KINDS.nativeLinux) return {action: "proceed", mode};
    return {action: "error", message: `Saved runtime mode 'linux-strong' does not apply on this platform (${String(platform)}). Run \`ap config\`.`};
  }

  // windows-compatibility
  if (platform !== PLATFORM_KINDS.nativeWindows) {
    return {action: "error", message: `Saved runtime mode 'windows-compatibility' does not apply on this platform (${String(platform)}). Run \`ap config\`.`};
  }
  // Defensive, independent of classifySavedRuntimeExecution's own framework
  // filtering: an unresolved/ambiguous framework (null) must never be
  // treated as "safe" for Compatibility — only CONFIRMED SpecKit and
  // standalone projects may use it. GSD/undetermined are rejected explicitly
  // and clearly.
  if (framework !== "speckit" && framework !== "standalone") {
    const named = framework === null || framework === undefined ? "undetermined" : framework;
    return {action: "error", message: `Saved runtime mode 'windows-compatibility' supports SpecKit and standalone only; this project's planning framework is '${named}'. Run \`ap config\` to select WSL2 Strong instead.`};
  }
  return {action: "proceed", mode};
}

function safeReadConfig(cfgPath) {
  if (!fs.existsSync(cfgPath)) return {exists: false, config: null};
  try {
    const result = loadAndMigrateConfig(cfgPath, {persist: false});
    return {exists: true, config: result?.config ?? null};
  } catch {
    return {exists: true, config: null};
  }
}

/**
 * TASK-42: read the target distro's operator login PATH once at delegation
 * start (`bash -lc 'printf %s "$PATH"'`, bounded by timeoutMs). On any
 * failure/timeout/malformed output return {ok:false} — the caller keeps
 * today's PATH and logs one line; never fail the run for this.
 */
export async function probeWslLoginPath({spawn, wslBinary, distro, now = () => Date.now(), timeoutMs = 10000, killGraceMs = DEFAULT_PATH_RESOLVE_KILL_GRACE_MS, maxOutputBytes = DEFAULT_PATH_RESOLVE_MAX_OUTPUT_BYTES} = {}) {
  const probe = await runBoundedProbeTree(spawn, wslBinary, ["-d", distro, "--exec", "bash", "-lc", 'printf %s "$PATH"'], {deadline: now() + timeoutMs, now, killGraceMs, maxOutputBytes});
  if (probe.kind === "ok" && typeof probe.text === "string" && probe.text.includes("/") && !probe.text.includes("\n") && !probe.text.includes("\0") && probe.text !== "") {
    return {ok: true, path: probe.text};
  }
  return {ok: false, reason: probe.detail || probe.kind || "unavailable"};
}

/**
 * TASK-42: child env for the delegated orchestrator — the caller's env plus
 * the recursion guard, with PATH set to the login PATH when one was read
 * (overwriting the caller's PATH key case-insensitively — Windows passes
 * "Path"), else today's env verbatim.
 */
export function buildDelegatedEnv({env}) {
  return {...env, [RECURSION_GUARD_ENV]: "1"};
}

/**
 * Real, I/O-performing entrypoint used by bin/ap.cjs's `run`, `stop`,
 * `cancel` and `uninstall` commands. `command` is the subcommand to run
 * inside WSL2 when delegating ("run", "stop", "cancel" or "uninstall") — it
 * is forwarded verbatim as the ap.cjs argv element, so only those four
 * values are accepted. (`cancel`
 * routes like `stop` so its stop-half kills a WSL2-live run where it runs
 * instead of orphaning it past the mission end.)
 *
 * Returns one of:
 *   {action:"setup-required", repo}                 — no .autopilot/config.json exists yet; bin/ap.cjs owns running Setup exactly once and re-routing afterward (this module never launches Setup itself)
 *   {action:"proceed", mode, runtimeLabel}           — continue into autopilot.mjs directly, in-process
 *   {action:"delegated", result}                     — the whole `ap <command>` already ran inside WSL2; result carries {status, signal, timedOut, terminationFailed, killDiagnostics, error}
 *   {action:"error", message}                        — fail before any mission mutation (this INCLUDES an existing config.json that is unreadable or malformed — that is never treated like a missing first-run config)
 */
export async function routeSubcommand({
  command,
  repoArgs,
  cwd = process.cwd(),
  skillRoot,
  env = process.env,
  wslBinary = "wsl.exe",
  timeoutMs,
  killGraceMs,
  now = () => Date.now(),
  spawn = nodeSpawn,
  delegateSpawn = nodeSpawn,
  delegateDeadlineMs = null,
  pathResolveTimeoutMs = DEFAULT_PATH_RESOLVE_TIMEOUT_MS,
  pathResolveKillGraceMs = DEFAULT_PATH_RESOLVE_KILL_GRACE_MS,
  pathResolveMaxOutputBytes = DEFAULT_PATH_RESOLVE_MAX_OUTPUT_BYTES,
  detectCapabilities = detectRuntimeModeCapabilities,
  readConfig = safeReadConfig,
  speckitDetect = speckit.detect,
  gsdDetect = gsd.detect
} = {}) {
  if (command !== "run" && command !== "stop" && command !== "cancel" && command !== "uninstall") {
    throw new Error(`routeSubcommand supports only "run", "stop", "cancel" and "uninstall" (received ${JSON.stringify(command)})`);
  }
  const repo = parseRepoArg(repoArgs || [], cwd);
  const cfgPath = path.join(repo, ".autopilot", "config.json");
  const {exists, config} = readConfig(cfgPath);
  if (!exists) {
    // Genuinely absent: this is the first-run case. bin/ap.cjs runs the
    // existing Setup wizard exactly once and calls routeRun() again
    // afterward — this module never spawns Setup itself (that would
    // duplicate scripts/setup.mjs's own logic here).
    return {action: "setup-required", repo};
  }
  if (!config || typeof config !== "object") {
    // Exists but unreadable or malformed: fail closed BEFORE Autopilot ever
    // launches. Never treated like a missing first-run config — a project
    // that once had a valid config must never silently fall back to the
    // first-run wizard because its config became unreadable.
    return {action: "error", message: `The Autopilot config at '${cfgPath}' exists but could not be read or parsed as valid JSON. Run \`ap config\` to repair it.`, repo};
  }

  const framework = resolveEffectiveFramework(repo, config, {speckitDetect, gsdDetect});
  const savedExecution = config.execution;
  const alreadyRouted = env?.[RECURSION_GUARD_ENV] === "1";

  const capabilities = await detectCapabilities({spawn, timeoutMs, killGraceMs, now, wslBinary});

  const decision = decideRuntimeRoute({capabilities, framework, savedExecution, alreadyRouted});

  if (decision.action === "error") {
    return {action: "error", message: decision.message, repo};
  }

  if (decision.action === "proceed") {
    return {action: "proceed", mode: decision.mode, runtimeLabel: runtimeLabelFor(decision.mode), repo};
  }

  // decision.action === "delegate"
  const distro = decision.distro;
  const pathDeadline = now() + pathResolveTimeoutMs;
  const pathResolveOpts = {spawn, wslBinary, distro, deadline: pathDeadline, now, killGraceMs: pathResolveKillGraceMs, maxOutputBytes: pathResolveMaxOutputBytes};

  const repoMap = await resolvePathForDistro({...pathResolveOpts, windowsPath: repo, kind: "dir"});
  if (!repoMap.ok) {
    return {action: "error", message: `Cannot resolve the repository path inside WSL distro '${distro}': ${repoMap.reason}. Run \`ap config\`.`, repo};
  }
  const entrypointWindowsPath = path.join(skillRoot, "bin", "ap.cjs");
  const entryMap = await resolvePathForDistro({...pathResolveOpts, windowsPath: entrypointWindowsPath, kind: "file"});
  if (!entryMap.ok) {
    return {action: "error", message: `Cannot resolve the Autopilot entrypoint inside WSL distro '${distro}': ${entryMap.reason}. Run \`ap config\`.`, repo};
  }

  const forwardedArgs = [...stripRepoArg(repoArgs || []), "--repo", repoMap.posixPath];
  const apEntry = entryMap.posixPath;
  // `--exec`, never plain `--`: verified on real wsl.exe that `-d <distro>
  // -- <cmd> <args>` reconstructs the whole command line and runs it
  // through the distro's default login shell (`$SHELL -c "..."`) — the
  // user's request text (or any argument) containing `$(...)`, backticks,
  // or `;` would then be genuinely shell-interpreted, not merely passed
  // through. `--exec` bypasses that reconstruction and delivers argv
  // exactly as given, confirmed against this machine's real wsl.exe.
  // Backlog #17 (TASK-42): read the operator's login PATH once, and deliver
  // it to the delegated orchestrator via argv — wsl.exe does not forward a
  // modified child env PATH into Linux (no WSLENV), so the login PATH is
  // injected as `/usr/bin/env PATH=<loginPath>` between --exec and node.
  // --exec stays the delivery mechanism (no shell), preserving its quoting
  // guarantees. It is NOT put into wsl.exe's own environment (that would
  // overwrite the Windows PATH with a Linux list).
  const loginPathProbe = await probeWslLoginPath({spawn, wslBinary, distro, now, killGraceMs: pathResolveKillGraceMs, maxOutputBytes: pathResolveMaxOutputBytes, timeoutMs: pathResolveTimeoutMs});
  if (!loginPathProbe.ok) {
    console.warn(`${distro}: could not read the WSL login PATH (${loginPathProbe.reason}); keeping the current PATH`);
  }
  const wslArgs = ["-d", distro, "--exec", ...(loginPathProbe.ok ? ["/usr/bin/env", `PATH=${loginPathProbe.path}`] : []), "/usr/bin/node", apEntry, command, ...forwardedArgs];
  const childEnv = buildDelegatedEnv({env});

  const result = await runBoundedInheritedProcess(delegateSpawn, wslBinary, wslArgs, {
    env: childEnv,
    deadlineMs: delegateDeadlineMs,
    stdio: "inherit"
  });
  return {action: "delegated", result, distro, repo};
}

/**
 * The original `ap run` entrypoint, preserved verbatim: every existing caller
 * and test keeps calling routeRun() with the same options and gets the same
 * behavior — it is routeSubcommand() with command "run".
 */
export async function routeRun(opts = {}) {
  return routeSubcommand({command: "run", ...opts});
}
