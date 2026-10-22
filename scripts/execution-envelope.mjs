import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {spawnSync} from "node:child_process";
import {resolveAgentBinary} from "./agent-process.mjs";
import {sha256} from "./capability-contract.mjs";

export const BINARY_KINDS = Object.freeze({
  windowsExecutable: "windows-executable",
  windowsShim: "windows-shim",
  native: "native",
  unresolved: "unresolved"
});
import {networkIsolationPrefix} from "./shell-guard.mjs";

export const EXECUTION_ENVELOPE_SCHEMA = "autopilot-execution-envelope.v4";
export const SANDBOX_HOME = "/workspace/scratch/.autopilot-home";

export function normalizedExecutionSafetyPolicy(config = {}) {
  const configured = config?.capabilities?.execution_plane_safety || {};
  return {
    required: configured.required !== false,
    network: {
      egress: config?.gates?.network_isolation === false ? "unrestricted" : configured.network?.external_egress || "provider-controlled",
      loopback: configured.network?.loopback || "controlled"
    },
    browserNetworkPolicy: configured.browser_network_policy || "separate",
    requireFilesystemBoundary: configured.require_filesystem_boundary !== false,
    requireProcessContainment: configured.require_process_containment !== false
  };
}

export function executionPlaneName(repo = process.cwd()) {
  const location = String(repo || "");
  if (process.platform === "win32") {
    return /^\\\\wsl(?:\$|\.localhost)\\/i.test(location) ? "windows-wsl-unc" : "windows-local";
  }
  if (process.platform !== "linux") return process.platform;
  try {
    return /microsoft|wsl/i.test(fs.readFileSync("/proc/version", "utf8")) ? "wsl" : "linux";
  } catch {
    return "linux";
  }
}

export function executionEnvelopeContext({repo, config, binaryPath = null, permissionFiles = [], runtimeFiles = [], providerEgressPolicy = null}) {
  const plane = executionPlaneName(repo);
  const policy = normalizedExecutionSafetyPolicy(config);
  const mechanism = {...detectBubblewrap(), networkNamespace: detectNetworkNamespace()};
  const inputs = {
    schema: EXECUTION_ENVELOPE_SCHEMA,
    plane,
    policy,
    mechanism,
    binaryKind: binaryPath ? binaryKind(binaryPath) : null,
    permissionTargets: permissionFiles.map(file => permissionTarget(file)).sort(),
    runtimeTargets: runtimeFiles.map(file => path.basename(file)).sort(),
    providerEgress: providerEgressPolicy ? {
      schema: providerEgressPolicy.schema,
      standard: providerEgressPolicy.standard,
      available: providerEgressPolicy.available,
      reason: providerEgressPolicy.reason,
      mode: providerEgressPolicy.mode,
      channel: providerEgressPolicy.channel,
      adapter: providerEgressPolicy.adapter,
      profile: providerEgressPolicy.profile,
      destinations: providerEgressPolicy.destinations,
      enforcement: providerEgressPolicy.enforcement,
      limits: providerEgressPolicy.limits,
      implementation: providerEgressPolicy.implementation
    } : null
  };
  return {...inputs, digest: sha256(inputs)};
}

// Task 15.4C3A: fs-only validation for an explicit Playwright module/browser
// directory the caller supplies (never invented, never rediscovered here).
// A candidate is only accepted when it is an absolute, existing, real
// directory whose fully-resolved realpath is IDENTICAL to its own
// lexically-resolved form — i.e. no symlink anywhere in the path chain
// (leaf or an intermediate parent) changes where it actually points. This
// is deliberately conservative: a real discoverPlaywrightRuntime() result is
// already realpath'd (see playwright-runtime.mjs's canonicalOrResolved), so
// a genuine discovered runtime always satisfies this check; only a
// fabricated/escaping symlink path is ever rejected by it.
// Generalized: validates that `candidate` is an absolute, existing,
// non-symlink-escaping real path (optionally requiring it to be a
// directory). Deliberately conservative, same as before: only a
// fabricated/escaping symlink path (leaf or intermediate parent) is ever
// rejected once the target genuinely exists.
function validateAbsoluteRealPath(candidate, {requireDirectory = false} = {}) {
  if (typeof candidate !== "string" || candidate.length === 0) return {ok: false, reason: "missing_or_wrong_type"};
  if (!path.isAbsolute(candidate)) return {ok: false, reason: "not_absolute"};
  try {
    fs.lstatSync(candidate);
  } catch {
    return {ok: false, reason: "does_not_exist"};
  }
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return {ok: false, reason: "unresolvable"};
  }
  if (real !== path.resolve(candidate)) return {ok: false, reason: "escaping_symlink"};
  let st;
  try {
    st = fs.statSync(real);
  } catch {
    return {ok: false, reason: "does_not_exist"};
  }
  if (requireDirectory && !st.isDirectory()) return {ok: false, reason: "not_a_directory"};
  return {ok: true, canonical: real};
}
function validateAbsoluteRealDirectory(candidate) {
  return validateAbsoluteRealPath(candidate, {requireDirectory: true});
}

// Explicit, non-mutating bridge from a discoverPlaywrightRuntime()-shaped
// object to the two validated absolute paths buildExecutionEnvelope needs.
// Playwright is OPTIONAL: a null/missing runtime, or one whose
// readyForLaunchProbe is not exactly true, is not an error — it simply
// means no Playwright mount is requested (active: false), and no
// module/browser-cache/library mount or Playwright environment value is
// produced for that caller. Once readyForLaunchProbe IS true, both required
// fields become mandatory and fail closed (reason
// "playwright_runtime_invalid") rather than silently mounting one side and
// pretending the runtime is usable. The input object itself is only ever
// read, never mutated.
export function resolvePlaywrightRuntimeInput(playwrightRuntime) {
  const inactive = {ok: true, active: false, moduleDir: null, browserRoot: null, reason: null, detail: null};
  if (playwrightRuntime == null || typeof playwrightRuntime !== "object") return inactive;
  if (playwrightRuntime.readyForLaunchProbe !== true) return inactive;
  const moduleCheck = validateAbsoluteRealDirectory(playwrightRuntime?.module?.nodeModulesDir);
  if (!moduleCheck.ok) {
    return {ok: false, active: false, moduleDir: null, browserRoot: null, reason: "playwright_runtime_invalid", detail: `module.nodeModulesDir:${moduleCheck.reason}`};
  }
  const browserCheck = validateAbsoluteRealDirectory(playwrightRuntime?.browser?.root);
  if (!browserCheck.ok) {
    return {ok: false, active: false, moduleDir: null, browserRoot: null, reason: "playwright_runtime_invalid", detail: `browser.root:${browserCheck.reason}`};
  }
  return {ok: true, active: true, moduleDir: moduleCheck.canonical, browserRoot: browserCheck.canonical, reason: null, detail: null};
}

export function buildNetworkIsolationInvocation({binary, args = [], cwd}) {
  const prefix = networkIsolationPrefix();
  if (!prefix) return {available: false, reason: "network_namespace_unavailable", binary: null, args: [], cwd};
  return {available: true, reason: null, binary: prefix[0], args: [...prefix.slice(1), binary, ...args.map(String)], cwd};
}

export function buildExecutionEnvelope({repo, scratchDir = null, readOnly = false, config = {}, binary, args = [], permissionFiles = [], runtimeFiles = [], providerEgressPolicy = null, browserCacheDir = null, extraLibraryDirs = [], playwrightModuleDir = null, playwrightBrowserRoot = null, sharedCacheMount = null, sharedCacheCompanionMount = null, extraEnv = {}, sessionStoreMounts = []}) {
  const context = executionEnvelopeContext({repo, config, binaryPath: binary, permissionFiles, runtimeFiles, providerEgressPolicy});
  if (!context.mechanism.available) {
    return {available: false, reason: context.mechanism.reason, context, binary: null, args: [], cwd: repo, sandbox: null};
  }

  const repository = realPath(repo);
  const scratch = scratchDir ? realPath(scratchDir) : null;
  // Task 15.4C3A: an explicit, pre-validated browser root (normally handed
  // down from launch-plan.mjs's resolvePlaywrightRuntimeInput()) always
  // takes precedence over a caller-supplied browserCacheDir — but a caller
  // that never supplies one (playwrightBrowserRoot stays null) gets NO
  // browser-cache mount at all. There is deliberately no default-cache
  // fallback: Playwright mounts exist only for an explicit validated
  // runtime, so Plan Reviewer, Code Reviewer, and every other null-runtime
  // caller observe no /playwright mount, no /ms-playwright mount, and no
  // Playwright environment values. Re-validated here (not just trusted) so
  // a direct buildExecutionEnvelope() caller — bypassing launch-plan —
  // still fails closed rather than silently mounting an invalid/escaping
  // path.
  const hadExplicitBrowserRoot = playwrightBrowserRoot != null;
  let playwrightModuleMount = null;
  if (playwrightBrowserRoot != null) {
    const check = validateAbsoluteRealDirectory(playwrightBrowserRoot);
    if (!check.ok) {
      return {available: false, reason: "playwright_runtime_invalid", detail: `browser.root:${check.reason}`, context, binary: null, args: [], cwd: repo, sandbox: null};
    }
    browserCacheDir = check.canonical;
  }
  if (playwrightModuleDir != null) {
    const check = validateAbsoluteRealDirectory(playwrightModuleDir);
    if (!check.ok) {
      return {available: false, reason: "playwright_runtime_invalid", detail: `module.nodeModulesDir:${check.reason}`, context, binary: null, args: [], cwd: repo, sandbox: null};
    }
    playwrightModuleMount = check.canonical;
  }
  // Supporting browser libraries (user-space Chromium dependencies) follow
  // the same explicit-runtime gating: the conventional user-library
  // directory is consulted ONLY when an explicit validated Playwright
  // runtime is active for this caller, never for null-runtime callers. A
  // caller-supplied extraLibraryDirs list is still honored as given.
  const explicitRuntimeActive = playwrightModuleMount != null || hadExplicitBrowserRoot;
  if ((!extraLibraryDirs || extraLibraryDirs.length === 0) && explicitRuntimeActive) {
    const userLibs = path.join(os.homedir(), 'chromium-libs', 'usr', 'lib', 'x86_64-linux-gnu');
    if (fs.existsSync(userLibs)) extraLibraryDirs = [userLibs];
  }
  const resolvedBinary = resolveAgentBinary(binary);
  const binaryIdentity = classifyBinary(resolvedBinary);
  const admission = binaryAdmission(binaryIdentity);
  if (!admission.admitted) {
    return {available: false, reason: admission.reason, detail: admission.detail, context, binary: null, args: [], cwd: repo, sandbox: null};
  }
  const missingRuntimeFile = runtimeFiles.find(file => !fs.existsSync(file));
  if (missingRuntimeFile) return {available: false, reason: "adapter_runtime_file_missing", missingRuntimeFile, context, binary: null, args: [], cwd: repository, sandbox: null};
  const mounts = systemMounts();
  // Filesystem containment only: unshare everything bwrap supports, then
  // re-share the network namespace unconditionally. Normal CLI network
  // behavior (provider calls, auth, telemetry) is preserved; there is no
  // network-namespace isolation and no controlled-egress gateway in the
  // supported runtime. The read-only repository bind below is the actual
  // containment boundary this mechanism exists to provide.
  const bwrapArgs = ["--die-with-parent", "--new-session", "--unshare-all", "--share-net"];
  // DNS resolution: on many hosts (WSL's /mnt/wsl/resolv.conf; systemd-resolved's
  // /run/systemd/resolve/stub-resolv.conf on plain Linux) /etc/resolv.conf is a
  // symlink whose target lives outside every directory bound below AND outside
  // /run (which is always re-created empty via --tmpfs). So even though the
  // network namespace is shared with the host and raw IP connectivity keeps
  // working, hostname resolution inside the sandbox silently breaks — the
  // symlink target simply doesn't exist in the sandbox's mount namespace.
  // bwrap cannot layer a later --ro-bind directly onto that path once the
  // whole /etc directory has already been bound (the destination is a
  // dangling symlink, so bwrap's own mountpoint creation fails with
  // "Can't create file ... No such file or directory"). So when an override
  // is actually needed, /etc is bound child-by-child instead of as one
  // whole-directory bind (skipping the native resolv.conf entry), leaving a
  // fresh, non-pre-existing /etc/resolv.conf path that the resolved real
  // file can be ro-bound onto — everything else about /etc is unaffected.
  let resolvConfOverrideSource = null;
  const etcMount = mounts.includes("/etc") ? "/etc" : null;
  if (etcMount) {
    try {
      const resolvConf = "/etc/resolv.conf";
      if (fs.existsSync(resolvConf)) {
        const resolvedTarget = fs.realpathSync(resolvConf);
        const alreadyBound = mounts.some(mount => isWithin(mount, resolvedTarget));
        if (!alreadyBound && fs.existsSync(resolvedTarget)) resolvConfOverrideSource = resolvedTarget;
      }
    } catch {
      // Best-effort: an unreadable/broken resolv.conf leaves the plain
      // whole-/etc bind in place rather than failing the whole envelope.
    }
  }
  for (const mount of mounts) {
    if (mount === etcMount && resolvConfOverrideSource) {
      bwrapArgs.push("--dir", "/etc");
      for (const entry of fs.readdirSync(etcMount)) {
        if (entry === "resolv.conf") continue;
        const child = path.join(etcMount, entry);
        bwrapArgs.push("--ro-bind", child, path.posix.join("/etc", entry));
      }
      bwrapArgs.push("--ro-bind", resolvConfOverrideSource, "/etc/resolv.conf");
      continue;
    }
    bwrapArgs.push("--ro-bind", mount, mount);
  }
  bwrapArgs.push("--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", "/run", "--tmpfs", "/home", "--tmpfs", "/root");
  const browserMounts = [];
  if (browserCacheDir && fs.existsSync(browserCacheDir)) {
    bwrapArgs.push("--ro-bind", realPath(browserCacheDir), "/ms-playwright");
    browserMounts.push({host: realPath(browserCacheDir), sandbox: "/ms-playwright"});
  }
  // Task 15.4C3A: a dedicated, read-only mount for the discovered Playwright
  // node module — deliberately separate from /chromium-libs (never added to
  // LD_LIBRARY_PATH; a Node module resolution root is not a shared-library
  // search path) and separate from /ms-playwright (a browser executable
  // cache, not a node_modules tree). playwrightModuleMount was already
  // validated (existing, absolute, non-escaping) above.
  let playwrightModule = null;
  if (playwrightModuleMount) {
    bwrapArgs.push("--ro-bind", playwrightModuleMount, "/playwright/node_modules");
    playwrightModule = {host: playwrightModuleMount, sandbox: "/playwright/node_modules"};
  }
  // Mission 001 task 12 (generalized): an optional, caller-supplied extra
  // read-only directory mount. Fully generic and adapter-agnostic — this
  // function has no knowledge of what the mount contains or which caller
  // requested it (a companion scratch-permission test enforces exactly
  // that separation). Explicit and optional: callers that omit
  // sharedCacheMount see zero difference in
  // bwrapArgs. When supplied it is re-validated here with the same
  // symlink-escape-safe check used for Playwright above (fail closed on
  // invalid/escaping paths); a supplied but meanwhile-vanished path simply
  // mounts nothing rather than failing the whole envelope, mirroring the
  // browserCacheDir pattern below.
  let sharedCache = null;
  if (sharedCacheMount != null) {
    if (typeof sharedCacheMount !== "object" || typeof sharedCacheMount.host !== "string" || typeof sharedCacheMount.sandbox !== "string") {
      return {available: false, reason: "shared_cache_mount_invalid", detail: "malformed sharedCacheMount", context, binary: null, args: [], cwd: repo, sandbox: null};
    }
    const check = validateAbsoluteRealDirectory(sharedCacheMount.host);
    if (!check.ok) {
      return {available: false, reason: "shared_cache_mount_invalid", detail: `sharedCacheMount.host:${check.reason}`, context, binary: null, args: [], cwd: repo, sandbox: null};
    }
    if (check.canonical && fs.existsSync(check.canonical)) {
      bwrapArgs.push("--ro-bind", check.canonical, sharedCacheMount.sandbox);
      sharedCache = {host: check.canonical, sandbox: sharedCacheMount.sandbox};
    }
  }
  const libraryMounts = [];
  for (const libraryDir of (extraLibraryDirs || [])) {
    if (libraryDir && fs.existsSync(libraryDir)) {
      const target = "/chromium-libs/" + path.basename(libraryDir);
      bwrapArgs.push("--ro-bind", realPath(libraryDir), target);
      libraryMounts.push({host: realPath(libraryDir), sandbox: target});
    }
  }
  bwrapArgs.push("--dir", "/workspace");
  bwrapArgs.push(readOnly ? "--ro-bind" : "--bind", repository, "/workspace/repository");
  if (scratch) {
    bwrapArgs.push("--dir", "/workspace/scratch", "--bind", scratch, "/workspace/scratch");
  } else {
    bwrapArgs.push("--tmpfs", "/workspace/scratch");
  }
  bwrapArgs.push("--dir", SANDBOX_HOME, "--setenv", "HOME", SANDBOX_HOME);
  // Backlog #26 Step B (TASK-34): persistent per-task session store
  // (implementer only). HOME itself stays tmpfs; only the adapter's data
  // dir (a caller-supplied HOME subpath, e.g. `~/.local/share/<adapter>`)
  // is bound here — never the whole HOME — so unrelated HOME contents stay
  // out. Writable `--bind` (the adapter must persist sessions across relay
  // processes); the host dir lives under `.autopilot/missions/<m>/sessions/`
  // so the snapshot/fingerprint exclusion covers it. Validated like the
  // shared-cache mount above (fail closed on malformed/escaping paths); a
  // supplied-but-vanished source mounts nothing rather than failing the
  // whole envelope. Read-only roles never receive this parameter.
  let sessionStores = [];
  for (const mount of (sessionStoreMounts || [])) {
    if (mount == null || typeof mount !== "object" || typeof mount.host !== "string" || typeof mount.sandbox !== "string") {
      return {available: false, reason: "session_store_mount_invalid", detail: "malformed sessionStoreMounts entry", context, binary: null, args: [], cwd: repo, sandbox: null};
    }
    const check = validateAbsoluteRealDirectory(mount.host);
    if (!check.ok) {
      return {available: false, reason: "session_store_mount_invalid", detail: `sessionStoreMounts.host:${check.reason}`, context, binary: null, args: [], cwd: repo, sandbox: null};
    }
    if (check.canonical && fs.existsSync(check.canonical)) {
      sessionStores.push({host: check.canonical, sandbox: mount.sandbox});
    }
  }
  for (const directory of parentDirectories(sessionStores.map(m => m.sandbox))) bwrapArgs.push("--dir", directory);
  for (const mount of sessionStores) bwrapArgs.push("--bind", mount.host, mount.sandbox);
  // Mission 001 task 12 (generalized, per-file companion to the directory
  // mount above): an optional extra read-only FILE mount. Fully generic —
  // this function does not know what the file is or why the caller wants
  // it pre-seeded. Pushed after the scratch bind above so any target under
  // it already exists at bind time; the caller is responsible for
  // pre-creating that target (bwrap requires it to exist) before supplying
  // this parameter. A vanished/invalid source simply mounts nothing rather
  // than failing the whole envelope, same resilience as the directory
  // mount above.
  let sharedCacheRg = null;
  if (scratch && sharedCacheCompanionMount != null) {
    if (typeof sharedCacheCompanionMount !== "object" || typeof sharedCacheCompanionMount.host !== "string" || typeof sharedCacheCompanionMount.sandbox !== "string") {
      return {available: false, reason: "shared_cache_mount_invalid", detail: "malformed sharedCacheCompanionMount", context, binary: null, args: [], cwd: repo, sandbox: null};
    }
    if (fs.existsSync(sharedCacheCompanionMount.host)) {
      bwrapArgs.push("--ro-bind", realPath(sharedCacheCompanionMount.host), sharedCacheCompanionMount.sandbox);
      sharedCacheRg = {host: realPath(sharedCacheCompanionMount.host), sandbox: sharedCacheCompanionMount.sandbox};
    }
  }

  const permissionMounts = permissionFiles.filter(file => fs.existsSync(file)).map(file => ({source: realPath(file), target: permissionTarget(file)}));
  for (const directory of parentDirectories(permissionMounts.map(mount => mount.target))) bwrapArgs.push("--dir", directory);
  for (const mount of permissionMounts) bwrapArgs.push("--ro-bind", mount.source, mount.target);

  const externalBinary = !pathVisibleThroughSystemMounts(resolvedBinary, mounts);
  const runtimeMounts = externalBinary
    ? runtimeFiles.map(file => ({source: realPath(file), target: path.posix.join("/autopilot/bin", path.basename(file))}))
    : [];
  const autopilotDirectories = new Set();
  if (externalBinary || runtimeMounts.length > 0) autopilotDirectories.add("/autopilot/bin");
  for (const directory of parentDirectories([...autopilotDirectories])) bwrapArgs.push("--dir", directory);
  for (const directory of [...autopilotDirectories].sort()) bwrapArgs.push("--dir", directory);

  let sandboxBinary = resolvedBinary;
  if (externalBinary) {
    sandboxBinary = "/autopilot/bin/adapter";
    bwrapArgs.push("--ro-bind", realPath(resolvedBinary), sandboxBinary);
  }
  for (const mount of runtimeMounts) bwrapArgs.push("--ro-bind", mount.source, mount.target);
  bwrapArgs.push(
    "--setenv", "TMPDIR", "/workspace/scratch",
    "--remount-ro", "/",
    "--remount-ro", "/tmp",
    "--remount-ro", "/run",
    "--remount-ro", "/home",
    "--remount-ro", "/root"
  );
  bwrapArgs.push("--chdir", "/workspace/repository", "--");
  bwrapArgs.push(sandboxBinary, ...args.map(String));
  return {
    available: true,
    reason: null,
    context,
    binary: context.mechanism.binary,
    args: bwrapArgs,
    cwd: repository,
    sandbox: {repository: "/workspace/repository", scratch: "/workspace/scratch", binary: sandboxBinary, providerEgress: null, browserCache: browserMounts, libraryMounts, playwrightModule, sharedCache, sharedCacheRg, sessionStores, extraEnv: extraEnv && typeof extraEnv === "object" ? {...extraEnv} : {}}
  };
}

export function mapPathIntoEnvelope(candidate, envelope, repo, scratchDir = null) {
  if (!candidate || !envelope?.available) return candidate;
  const absolute = path.resolve(candidate);
  const repository = path.resolve(repo);
  // Scratch is checked FIRST: a run's scratch directory is always nested
  // inside the repository (.autopilot/runs/...), so it is the more specific
  // containment match and must win. Checking repository first would always
  // shadow scratch (every scratch path is also a repository path), silently
  // mapping writable-scratch paths (e.g. the Git guard log) onto the
  // read-only repository bind instead.
  if (scratchDir) {
    const scratch = path.resolve(scratchDir);
    if (isWithin(scratch, absolute)) return path.posix.join(envelope.sandbox.scratch, slash(path.relative(scratch, absolute)));
  }
  if (isWithin(repository, absolute)) return path.posix.join(envelope.sandbox.repository, slash(path.relative(repository, absolute)));
  return candidate;
}

export function mapEnvironmentIntoEnvelope(environment, envelope, repo, scratchDir = null) {
  if (!envelope?.available) return {...environment};
  const mapped = {};
  for (const [name, raw] of Object.entries(environment || {})) {
    if (raw == null) continue;
    if (name.toLowerCase() === "path") {
      mapped[name] = String(raw).split(path.delimiter).map(entry => mapPathIntoEnvelope(entry, envelope, repo, scratchDir)).join(path.delimiter);
      continue;
    }
    const value = String(raw);
    // Same specificity rule as mapPathIntoEnvelope: scratch is always
    // nested inside the repository, so its (more specific) prefix
    // replacement must be applied first — otherwise the repository
    // replacement always matches first and consumes the whole string.
    mapped[name] = [scratchDir ? path.resolve(scratchDir) : null, path.resolve(repo)]
      .filter(Boolean)
      .reduce((current, root) => replacePathPrefix(current, root, mapPathIntoEnvelope(root, envelope, repo, scratchDir)), value);
  }
  if (envelope.sandbox?.browserCache?.length) {
    mapped.PLAYWRIGHT_BROWSERS_PATH = envelope.sandbox.browserCache[0].sandbox;
  }
  if (envelope.sandbox?.libraryMounts?.length) {
    mapped.LD_LIBRARY_PATH = envelope.sandbox.libraryMounts.map(mount => mount.sandbox).join(path.delimiter);
  }
  // Task 15.4C3A: AUTOPILOT_PLAYWRIGHT_MODULE_ROOT is the stable, always-set
  // authoritative sandbox module location whenever the mount is active. It
  // does not by itself guarantee ESM package resolution — a caller that
  // needs the module must still resolve against this absolute root. NODE_PATH
  // is only ever touched when the incoming environment already set it (never
  // introduced from nothing here); when it was set, it is fully REPLACED —
  // never merged — with the sandbox path, since the generic per-value
  // repo/scratch prefix replacement above only rewrites repo/scratch-rooted
  // entries and would otherwise leave an unrelated host module path intact.
  if (envelope.sandbox?.playwrightModule) {
    mapped.AUTOPILOT_PLAYWRIGHT_MODULE_ROOT = envelope.sandbox.playwrightModule.sandbox;
    if (Object.prototype.hasOwnProperty.call(mapped, "NODE_PATH")) {
      mapped.NODE_PATH = envelope.sandbox.playwrightModule.sandbox;
    }
  }
  // Mission 001 task 13 (generalized): the caller's extraEnv values are
  // applied last, verbatim, with no prefix rewriting and no knowledge of
  // what they are — this function has no adapter-specific knowledge at all.
  // Absent entirely when the caller supplied none (every caller that omits
  // extraEnv sees no new env vars). Following the AUTOPILOT_PLAYWRIGHT_
  // MODULE_ROOT pattern above in spirit: a caller-computed, always-set
  // value whenever its corresponding mount is active.
  if (envelope.sandbox?.extraEnv) {
    Object.assign(mapped, envelope.sandbox.extraEnv);
  }
  mapped.HOME = SANDBOX_HOME;
  mapped.PWD = envelope.sandbox.repository;
  // Task 15.6K: INIT_CWD is forced alongside PWD (not left to the generic
  // prefix replacement above). npm-style launchers seed INIT_CWD from the
  // outer cwd, and OpenCode-style adapters resolve relative tool paths
  // against PWD/INIT_CWD — a launcher-inherited value that merely passes
  // through the generic replacement (e.g. a path outside the repo, which
  // no prefix rule rewrites) would expose a host path inside the sandbox
  // and misdirect relative writes. runRelay() always seeds both from the
  // effective repository, so this force is the matching sandbox-side
  // authority: inside the envelope, both are exactly /workspace/repository.
  mapped.INIT_CWD = envelope.sandbox.repository;
  return mapped;
}

function detectBubblewrap() {
  if (process.platform !== "linux") return {kind: "none", available: false, binary: null, version: null, reason: "bubblewrap_requires_linux"};
  const which = spawnSync("sh", ["-lc", "command -v bwrap"], {encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: false});
  const binary = String(which.stdout || "").trim().split(/\r?\n/)[0];
  if (which.status !== 0 || !binary) return {kind: "none", available: false, binary: null, version: null, reason: "bubblewrap_not_installed"};
  const versionProbe = spawnSync(binary, ["--version"], {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: false});
  const test = spawnSync(binary, minimalProbeArgs(), {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: false});
  if (test.status !== 0) {
    return {kind: "bubblewrap", available: false, binary, version: String(versionProbe.stdout || versionProbe.stderr || "").trim() || null, reason: "bubblewrap_unusable", probeExit: test.status, probeError: String(test.stderr || "").trim().slice(-500)};
  }
  return {kind: "bubblewrap", available: true, binary, version: String(versionProbe.stdout || versionProbe.stderr || "").trim() || null, reason: null};
}

function detectNetworkNamespace() {
  const prefix = networkIsolationPrefix();
  if (!prefix) return {kind: "none", available: false, prefix: [], reason: "unshare_network_namespace_unavailable"};
  const version = spawnSync(prefix[0], ["--version"], {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: false});
  return {kind: prefix.includes("-Urn") ? "unshare-user-network" : "unshare-network", available: true, prefix, version: String(version.stdout || version.stderr || "").trim().split(/\r?\n/)[0] || null, reason: null};
}

function minimalProbeArgs() {
  const args = ["--die-with-parent", "--new-session", "--unshare-all"];
  for (const mount of systemMounts()) args.push("--ro-bind", mount, mount);
  args.push("--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", "/run", "--", "true");
  return args;
}

function systemMounts() {
  return ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"].filter(candidate => fs.existsSync(candidate));
}

function pathVisibleThroughSystemMounts(binary, mounts) {
  const absolute = path.resolve(binary);
  return mounts.some(mount => isWithin(path.resolve(mount), absolute));
}

function permissionTarget(file) {
  const absolute = path.resolve(file);
  const home = path.resolve(os.homedir());
  if (isWithin(home, absolute)) return path.posix.join(SANDBOX_HOME, slash(path.relative(home, absolute)));
  return path.posix.join("/autopilot/permissions", Buffer.from(absolute).toString("hex"), path.basename(absolute));
}

function parentDirectories(files) {
  const directories = new Set();
  for (const file of files) {
    let current = path.posix.dirname(file);
    while (current && current !== "/" && current !== ".") {
      directories.add(current);
      current = path.posix.dirname(current);
    }
  }
  return [...directories].sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right));
}

function binaryKind(binary) {
  return classifyBinary(binary).kind;
}

// Content-based classification. A file is only trusted as "native" when its
// bytes prove it is not a PE image; filename suffixes alone are never proof.
// Every classification failure (missing target, unreadable file, broken
// symlink, symlink cycle, truncated header) yields kind "unresolved" plus a
// stable error code — callers MUST deny launch on any non-native result.
export function classifyBinary(candidate) {
  const requestedPath = path.resolve(String(candidate || ""));
  if (!requestedPath || requestedPath === ".") return unresolved("binary_target_missing", null);
  let linkStat = null;
  try {
    linkStat = fs.lstatSync(requestedPath);
  } catch {
    return unresolved("binary_target_missing", null);
  }
  const symlinkPath = linkStat.isSymbolicLink() ? requestedPath : null;
  let resolvedTargetPath = requestedPath;
  try {
    resolvedTargetPath = fs.realpathSync(requestedPath);
  } catch (error) {
    return unresolved(error?.code === "ELOOP" ? "binary_symlink_cycle" : "binary_symlink_unresolvable", symlinkPath);
  }
  let targetStat = null;
  try {
    targetStat = fs.statSync(resolvedTargetPath);
  } catch {
    return unresolved("binary_target_missing", symlinkPath);
  }
  if (!targetStat.isFile()) return unresolved("binary_target_not_a_file", symlinkPath);
  let header = null;
  try {
    header = readBinaryHeader(resolvedTargetPath, targetStat.size);
  } catch {
    return unresolved("binary_unreadable", symlinkPath);
  }
  if (!header) return unresolved("binary_unreadable", symlinkPath);
  const inspection = inspectPeHeader(header, targetStat.size);
  if (inspection.pe) {
    const kindResult = resolved(BINARY_KINDS.windowsExecutable, symlinkPath, resolvedTargetPath);
    if (!kindResult.error) return kindResult;
    return unresolved(kindResult.error, symlinkPath);
  }
  // Any file that claims to be a PE image (MZ magic) but fails structural
  // validation is denied outright — it never falls back to a benign kind.
  if (inspection.error) return unresolved(inspection.error, symlinkPath);
  const extension = path.extname(resolvedTargetPath).toLowerCase();
  // Conservative fallback: a .exe suffix is treated as a Windows executable
  // even when the content does not carry a recognizable PE signature.
  if (extension === ".exe") {
    const exeResult = resolved(BINARY_KINDS.windowsExecutable, symlinkPath, resolvedTargetPath);
    if (!exeResult.error) return exeResult;
    return unresolved(exeResult.error, symlinkPath);
  }
  if (extension === ".cmd" || extension === ".bat") {
    const shimResult = resolved(BINARY_KINDS.windowsShim, symlinkPath, resolvedTargetPath);
    if (!shimResult.error) return shimResult;
    return unresolved(shimResult.error, symlinkPath);
  }
  return resolved(BINARY_KINDS.native, symlinkPath, resolvedTargetPath);

  function resolved(kind, linkPath, targetPath) {
    let contentDigest = null;
    try {
      contentDigest = fileDigest(targetPath);
    } catch {
      return {kind: BINARY_KINDS.unresolved, error: "binary_unreadable", symlinkPath: linkPath, resolvedTargetPath: null, contentDigest: null};
    }
    return {kind, error: null, symlinkPath: linkPath, resolvedTargetPath: targetPath, contentDigest};
  }
}

function unresolved(error, symlinkPath) {
  return {kind: BINARY_KINDS.unresolved, error, symlinkPath, resolvedTargetPath: null, contentDigest: null};
}

function readBinaryHeader(file, size) {
  const descriptor = fs.openSync(file, "r");
  try {
    const length = Math.min(size, 65536);
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(descriptor, buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
}

function inspectPeHeader(header, fileSize) {
  if (header.length < 2 || header[0] !== 0x4d || header[1] !== 0x5a) return {pe: false, error: null};
  if (header.length < 64 || fileSize < 64) return {pe: false, error: "binary_truncated_header"};
  let e_lfanew = 0;
  for (let byte = 0; byte < 4; byte += 1) e_lfanew += header[0x3c + byte] * (2 ** (byte * 8));
  if (e_lfanew <= 0 || e_lfanew + 26 > Number(fileSize)) return {pe: false, error: "binary_pe_offset_out_of_range"};
  if (e_lfanew + 26 > header.length) return {pe: false, error: "binary_truncated_header"};
  const signatureValid = header[e_lfanew] === 0x50 && header[e_lfanew + 1] === 0x45 && header[e_lfanew + 2] === 0x00 && header[e_lfanew + 3] === 0x00;
  if (!signatureValid) return {pe: false, error: "binary_pe_signature_invalid"};
  const magic = header[e_lfanew + 24] + header[e_lfanew + 25] * 256;
  if (magic !== 0x10b && magic !== 0x20b) return {pe: false, error: "binary_optional_header_magic_unsupported"};
  return {pe: true, error: null};
}

function fileDigest(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

// Pre-spawn admission rule shared by every execution entry point:
// Windows binaries are admitted only on a Windows host. Classification or
// hashing failures always deny. Note the documented scope limitation: this
// proves direct binaries, renamed PE files, Windows shims, and symlink
// targets; it cannot generally prove that an arbitrary native POSIX wrapper
// will not later launch a PE through WSL interop.
export function binaryAdmission(identity) {
  if (!identity || identity.kind === BINARY_KINDS.unresolved) {
    return {admitted: false, reason: "binary_admission_denied", detail: identity?.error || "binary_classification_failed"};
  }
  if (process.platform === "win32") return {admitted: true, reason: null, detail: null};
  if (identity.kind === BINARY_KINDS.windowsExecutable || identity.kind === BINARY_KINDS.windowsShim) {
    return {admitted: false, reason: "windows_interop_not_contained", detail: identity.kind};
  }
  return {admitted: true, reason: null, detail: null};
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function realPath(candidate) {
  try { return fs.realpathSync(candidate); }
  catch { return path.resolve(candidate); }
}

function slash(candidate) {
  return String(candidate || "").replace(/\\/g, "/");
}

function replacePathPrefix(value, hostRoot, sandboxRoot) {
  // Normalize both sides to forward slashes BEFORE splitting: on Windows,
  // `value` and `hostRoot` are native (backslash-separated) host paths, but
  // splitting on the native-form root only rewrites the matched prefix —
  // the remainder of the string (the part after the root) keeps its
  // original backslashes, producing a mixed separator result like
  // "/workspace/scratch\git-guard\blocked.log" instead of the sandbox's
  // all-POSIX "/workspace/scratch/git-guard/blocked.log". Slashing the
  // whole value first (not just the root) avoids that; it is a no-op on
  // POSIX, where native paths already use forward slashes.
  return slash(String(value)).split(slash(String(hostRoot))).join(sandboxRoot);
}
