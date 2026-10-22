// Cross-platform, non-mutating Playwright runtime DISCOVERY primitive.
//
// This module only answers "where (if anywhere) is an installed Playwright
// node module, and where (if anywhere) is a Chromium/Chromium-headless-shell
// browser cache with a real executable in it". It performs no installation,
// no provisioning, no subprocess launches, and no filesystem writes — it is
// read-only reconnaissance that a later, separately reviewed task can wire
// into the Verifier/setup runtime.
//
// Every environment/platform dependency (`env`, `homeDir`, `platform`,
// `localAppData`) is an injectable parameter with a real-environment default,
// so callers get real discovery for free while tests stay fully
// deterministic and independent of the host machine's actual installs.
//
// Discovery never invents a machine-specific path: candidates are built only
// from the caller-supplied repository/skillRoot roots, the injected
// env/home/localAppData values, and one stable, non-machine-specific
// Autopilot runtime directory name ("project-autopilot/playwright" under the
// platform's standard per-user cache/appdata root).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A real Playwright install is recognized by a `playwright` or
// `@playwright/test` directory under `node_modules` — never by an outer
// package.json merely *declaring* the dependency, and never by an empty
// directory. Order here doesn't imply precedence between the two packages;
// whichever is actually installed and real wins.
const MODULE_PACKAGES = [
  {name: "playwright", relDir: "playwright"},
  {name: "@playwright/test", relDir: path.join("@playwright", "test")}
];

// A real installed npm package always has at least one of these top-level
// entry files — this is the ONLY package-content signal this module reads
// beyond package.json's own `name`/`version`/`main` fields (task
// requirement: no more file content than the minimum needed to validate an
// install). A bare `lib/` directory, empty or not, is deliberately NOT
// enough by itself — only a real regular file (one of these basenames, or
// the file package.json's own `main` field points at) counts as an entry.
const RECOGNIZED_ENTRY_BASENAMES = ["index.js", "index.mjs", "index.cjs", "cli.js"];

// Recognized browser executable basenames, by the injected target platform
// (not necessarily the host OS running this code — the whole point of
// injection is that discovery for a given platform can be exercised from
// any host). Both the legacy `headless_shell`/`headless-shell` spellings
// and the modern `chrome-headless-shell` basename Playwright now installs
// are accepted, since real installs across versions use either.
function executableNamesForPlatform(platform) {
  return platform === "win32"
    ? ["chrome.exe", "chrome-headless-shell.exe", "headless_shell.exe", "headless-shell.exe"]
    : ["chrome", "chrome-headless-shell", "headless_shell", "headless-shell"];
}

function isWin32(platform) {
  return platform === "win32";
}

function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}
function safeLstat(p) {
  try { return fs.lstatSync(p); } catch { return null; }
}
function safeRealpath(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}
function canonicalOrResolved(p) {
  return safeRealpath(p) || path.resolve(p);
}

// Containment comparison always uses the REAL host's case sensitivity
// (process.platform), independent of the `platform` parameter callers use
// to select naming/location conventions for the environment being
// discovered — the filesystem actually being touched is always the real
// one this process is running on.
function normalizeForCompare(p) {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function isWithinRoot(root, candidate) {
  const r = normalizeForCompare(root);
  const c = normalizeForCompare(candidate);
  return c === r || c.startsWith(r + path.sep);
}

// A candidate is only ever an acceptable BROWSER executable when it
// canonicalizes to a real regular file. On a POSIX target (`platform !==
// "win32"`) it must additionally pass a real `X_OK` access check — a text
// file that merely happens to be named "chrome" is not launchable and must
// be rejected. Windows has no equivalent POSIX permission bit to check
// (Node's own `fs.access(..., X_OK)` does not meaningfully validate
// executability there), so for a Windows target this is deliberately a
// pure name+regular-file check — never a pretend permission check.
function isAcceptableExecutableFile(realPath, platform) {
  const st = safeStat(realPath);
  if (!st || !st.isFile()) return false;
  if (!isWin32(platform)) {
    try {
      fs.accessSync(realPath, fs.constants.X_OK);
    } catch {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------
// Module (node package) validation
// ---------------------------------------------------------------------

// Resolve one candidate entry path (already known to exist as some kind of
// filesystem entry by name) to a real regular file that canonicalizes to
// somewhere inside `pkgDirReal` — rejecting a directory, a missing target,
// or an entry (plain or via symlink) that escapes the resolved package
// root. `pkgDirReal` is always the CANONICAL package directory, so a whole
// npm/pnpm package directory that is itself a symlink (pnpm's content-store
// layout) is still allowed — only escapes from that resolved root are
// rejected.
function resolveRealEntryWithinRoot(candidatePath, pkgDirReal) {
  const real = safeRealpath(candidatePath);
  if (!real) return null;
  const st = safeStat(real);
  if (!st || !st.isFile()) return null;
  if (!isWithinRoot(pkgDirReal, real)) return null;
  return real;
}

function packageLooksInstalled(pkgDir, expectedName) {
  const pkgJsonPath = path.join(pkgDir, "package.json");
  const pkgJsonStat = safeStat(pkgJsonPath);
  if (!pkgJsonStat || !pkgJsonStat.isFile()) return {ok: false, reason: `missing package.json under ${pkgDir}`};
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
  } catch {
    return {ok: false, reason: `package.json under ${pkgDir} is not valid JSON`};
  }
  if (!pkg || typeof pkg !== "object") {
    return {ok: false, reason: `package.json under ${pkgDir} is not a JSON object`};
  }
  if (pkg.name !== expectedName) {
    return {ok: false, reason: `package.json under ${pkgDir} has name ${JSON.stringify(pkg.name)}, expected ${JSON.stringify(expectedName)}`};
  }
  if (typeof pkg.version !== "string" || !pkg.version.trim()) {
    return {ok: false, reason: `package.json under ${pkgDir} has no version field (not a real install)`};
  }

  const pkgDirReal = safeRealpath(pkgDir);
  if (!pkgDirReal) return {ok: false, reason: `package directory does not resolve to a real path: ${pkgDir}`};

  for (const name of RECOGNIZED_ENTRY_BASENAMES) {
    const entry = resolveRealEntryWithinRoot(path.join(pkgDir, name), pkgDirReal);
    if (entry) return {ok: true, entry};
  }
  if (typeof pkg.main === "string" && pkg.main.trim()) {
    const entry = resolveRealEntryWithinRoot(path.join(pkgDir, pkg.main), pkgDirReal);
    if (entry) return {ok: true, entry};
    return {ok: false, reason: `package.json "main" (${JSON.stringify(pkg.main)}) under ${pkgDir} does not resolve to a real file inside the package (missing, or escapes the package root)`};
  }
  return {ok: false, reason: `no real installed entry file found under ${pkgDir} (checked ${RECOGNIZED_ENTRY_BASENAMES.join(", ")} and package.json "main")`};
}

function findPackageInNodeModules(nodeModulesDir) {
  for (const pkg of MODULE_PACKAGES) {
    const pkgDir = path.join(nodeModulesDir, pkg.relDir);
    const st = safeStat(pkgDir);
    if (!st || !st.isDirectory()) continue;
    const check = packageLooksInstalled(pkgDir, pkg.name);
    if (check.ok) return {ok: true, package: pkg.name, dir: pkgDir};
  }
  return {ok: false};
}

function resolveModuleCandidate(nodeModulesDir) {
  const st = safeStat(nodeModulesDir);
  if (!st) return {ok: false, reason: `node_modules directory does not exist: ${nodeModulesDir}`};
  if (!st.isDirectory()) return {ok: false, reason: `node_modules path is not a directory: ${nodeModulesDir}`};
  const found = findPackageInNodeModules(nodeModulesDir);
  if (!found.ok) {
    return {ok: false, reason: `no installed "playwright" or "@playwright/test" package found under ${nodeModulesDir}`};
  }
  return {
    ok: true,
    package: found.package,
    dir: canonicalOrResolved(found.dir),
    nodeModulesDir: canonicalOrResolved(nodeModulesDir)
  };
}

// ---------------------------------------------------------------------
// Browser cache validation
// ---------------------------------------------------------------------

// Bounded, symlink-aware walk from `root` looking for a recognized browser
// executable. Descent (and the final executable match) is only accepted
// when the canonical (realpath'd) target still resolves inside `root` —
// an executable or a directory reachable only by escaping the cache root
// via a symlink/junction is never followed or returned. Unsupported entry
// types (sockets, fifos, block/char devices) are always skipped.
function findBrowserExecutable(root, platform) {
  const rootReal = safeRealpath(root);
  if (!rootReal) return {found: false, escaped: false, path: null};
  const names = new Set(executableNamesForPlatform(platform));
  const visited = new Set([normalizeForCompare(rootReal)]);
  const stack = [{dir: root, depth: 0}];
  let escaped = false;
  let steps = 0;
  const MAX_DEPTH = 6;
  const MAX_STEPS = 5000;

  while (stack.length) {
    if (++steps > MAX_STEPS) break;
    const {dir, depth} = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, {withFileTypes: true});
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const lst = safeLstat(full);
      if (!lst) continue;

      if (lst.isSymbolicLink()) {
        const real = safeRealpath(full);
        if (!real) continue;
        const targetStat = safeStat(real);
        if (!targetStat) continue;
        if (targetStat.isFile()) {
          if (!names.has(entry.name)) continue;
          if (!isWithinRoot(rootReal, real)) { escaped = true; continue; }
          if (isAcceptableExecutableFile(real, platform)) return {found: true, escaped: false, path: real};
          continue; // real regular file inside root, but not a valid/executable one — keep looking
        }
        if (targetStat.isDirectory() && depth < MAX_DEPTH) {
          if (!isWithinRoot(rootReal, real)) continue; // never descend through an escaping link
          const key = normalizeForCompare(real);
          if (visited.has(key)) continue;
          visited.add(key);
          stack.push({dir: full, depth: depth + 1});
        }
        continue;
      }

      if (lst.isFile()) {
        if (names.has(entry.name)) {
          const real = safeRealpath(full) || full;
          if (!isWithinRoot(rootReal, real)) { escaped = true; continue; }
          if (isAcceptableExecutableFile(real, platform)) return {found: true, escaped: false, path: real};
          // real regular file, correctly named, inside root — but fails the
          // executable-access (POSIX) or regular-file (Windows) check —
          // rejected, keep looking rather than ever returning it.
        }
        continue;
      }

      if (lst.isDirectory() && depth < MAX_DEPTH) {
        const real = safeRealpath(full) || full;
        const key = normalizeForCompare(real);
        if (visited.has(key)) continue;
        visited.add(key);
        stack.push({dir: full, depth: depth + 1});
        continue;
      }
      // unsupported type (socket/fifo/device/etc.) — reject, never traverse or match
    }
  }
  return {found: false, escaped, path: null};
}

function resolveBrowserCandidate(root, platform) {
  const st = safeStat(root);
  if (!st) return {ok: false, reason: `browser cache directory does not exist: ${root}`};
  if (!st.isDirectory()) return {ok: false, reason: `browser cache path is not a directory: ${root}`};
  const result = findBrowserExecutable(root, platform);
  if (result.found) return {ok: true, path: result.path, root: canonicalOrResolved(root)};
  if (result.escaped) {
    return {ok: false, reason: `a browser executable exists only via a link that escapes the browser-cache root (rejected): ${root}`};
  }
  return {ok: false, reason: `no Chromium or Chromium headless-shell executable found beneath ${root}`};
}

// ---------------------------------------------------------------------
// Stable per-user Autopilot runtime directory
// ---------------------------------------------------------------------

function stableAutopilotRuntimeDir({platform, homeDir, localAppData}) {
  if (isWin32(platform)) {
    if (!localAppData) return null;
    return path.join(localAppData, "project-autopilot", "playwright");
  }
  if (!homeDir) return null;
  return path.join(homeDir, ".cache", "project-autopilot", "playwright");
}

function platformStandardBrowserCache({platform, homeDir, localAppData}) {
  if (isWin32(platform)) {
    if (!localAppData) return null;
    return path.join(localAppData, "ms-playwright");
  }
  if (!homeDir) return null;
  return path.join(homeDir, ".cache", "ms-playwright");
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

/**
 * Discover (never install, never launch) a Playwright node module and a
 * Chromium/Chromium-headless-shell browser cache on the current — or an
 * injected — platform. Read-only: makes no filesystem writes and spawns no
 * subprocesses.
 *
 * @param {object} [options]
 * @param {string|null} [options.repository] Official repository root (its `node_modules` is checked).
 * @param {string|null} [options.skillRoot] Project Autopilot skill root (its `node_modules` is checked).
 * @param {object} [options.env] Environment variables to read PLAYWRIGHT_MODULE_DIR / PLAYWRIGHT_BROWSERS_PATH from. Defaults to `process.env`.
 * @param {string|null} [options.homeDir] Home directory for the Linux/WSL cache locations. Defaults to `os.homedir()`.
 * @param {string} [options.platform] Target platform ('win32' selects Windows conventions). Defaults to `process.platform`.
 * @param {string|null} [options.localAppData] Windows LOCALAPPDATA root. Defaults to `env.LOCALAPPDATA`.
 * @returns {{
 *   readyForLaunchProbe: boolean,
 *   module: {status: string, source: string|null, dir: string|null, nodeModulesDir: string|null, package: string|null, reason: string|null},
 *   browser: {status: string, source: string|null, path: string|null, root: string|null, reason: string|null},
 *   failureReason: string|null
 * }}
 */
export function discoverPlaywrightRuntime(options = {}) {
  const {
    repository = null,
    skillRoot = null,
    env = process.env,
    homeDir = os.homedir(),
    platform = process.platform,
    localAppData = null
  } = options;

  const effectiveLocalAppData = localAppData || env.LOCALAPPDATA || null;
  const runtimeDir = stableAutopilotRuntimeDir({platform, homeDir, localAppData: effectiveLocalAppData});

  // ---- module discovery (precedence order; an explicit override that is
  // invalid fails the whole module dimension closed — it never falls
  // through to a lower-precedence candidate) ----
  const moduleCandidates = [
    {source: "explicit-env", explicit: true, dir: env.PLAYWRIGHT_MODULE_DIR || null},
    {source: "repository", explicit: false, dir: repository ? path.join(repository, "node_modules") : null},
    {source: "skill", explicit: false, dir: skillRoot ? path.join(skillRoot, "node_modules") : null},
    {source: "autopilot-runtime", explicit: false, dir: runtimeDir ? path.join(runtimeDir, "node_modules") : null}
  ];

  let moduleResult = {
    status: "not-found", source: null, dir: null, nodeModulesDir: null, package: null,
    reason: "no candidate location produced an installed \"playwright\" or \"@playwright/test\" package"
  };
  for (const candidate of moduleCandidates) {
    if (!candidate.dir) continue;
    const resolved = resolveModuleCandidate(candidate.dir);
    if (resolved.ok) {
      moduleResult = {
        status: "discovered", source: candidate.source, dir: resolved.dir,
        nodeModulesDir: resolved.nodeModulesDir, package: resolved.package, reason: null
      };
      break;
    }
    if (candidate.explicit) {
      moduleResult = {
        status: "invalid-explicit-override", source: candidate.source, dir: null, nodeModulesDir: null, package: null,
        reason: `PLAYWRIGHT_MODULE_DIR is set but invalid: ${resolved.reason}`
      };
      break;
    }
    // non-explicit candidates that are missing/invalid are skipped safely.
  }

  // ---- browser discovery (same fail-closed-on-explicit-invalid rule) ----
  const packageLocalBrowserDir = moduleResult.status === "discovered" && moduleResult.nodeModulesDir
    ? path.join(moduleResult.nodeModulesDir, "playwright-core", ".local-browsers")
    : null;

  const browserCandidates = [
    {source: "explicit-env", explicit: true, dir: env.PLAYWRIGHT_BROWSERS_PATH || null},
    {source: "package-local", explicit: false, dir: packageLocalBrowserDir},
    {source: "platform-cache", explicit: false, dir: platformStandardBrowserCache({platform, homeDir, localAppData: effectiveLocalAppData})},
    {source: "autopilot-runtime", explicit: false, dir: runtimeDir}
  ];

  let browserResult = {
    status: "not-found", source: null, path: null, root: null,
    reason: "no candidate location contained a Chromium or Chromium headless-shell executable"
  };
  for (const candidate of browserCandidates) {
    if (!candidate.dir) continue;
    const resolved = resolveBrowserCandidate(candidate.dir, platform);
    if (resolved.ok) {
      browserResult = {status: "discovered", source: candidate.source, path: resolved.path, root: resolved.root, reason: null};
      break;
    }
    if (candidate.explicit) {
      browserResult = {
        status: "invalid-explicit-override", source: candidate.source, path: null, root: null,
        reason: `PLAYWRIGHT_BROWSERS_PATH is set but invalid: ${resolved.reason}`
      };
      break;
    }
  }

  const readyForLaunchProbe = moduleResult.status === "discovered" && browserResult.status === "discovered";
  let failureReason = null;
  if (!readyForLaunchProbe) {
    const parts = [];
    if (moduleResult.status !== "discovered") parts.push(`module: ${moduleResult.reason}`);
    if (browserResult.status !== "discovered") parts.push(`browser: ${browserResult.reason}`);
    failureReason = parts.join("; ");
  }

  return {readyForLaunchProbe, module: moduleResult, browser: browserResult, failureReason};
}
