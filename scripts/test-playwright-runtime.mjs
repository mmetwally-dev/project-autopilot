#!/usr/bin/env node
// Task 15.4C1 behavioral proof for scripts/playwright-runtime.mjs's
// discoverPlaywrightRuntime(): a stable, non-mutating, cross-platform
// Playwright module/browser DISCOVERY primitive. This file drives the real
// exported function against disposable fixture directories only — it never
// asserts internal implementation details or exact wording, and it never
// installs, downloads, or launches anything (Playwright, Chromium, npm, or
// npx). Runtime integration (wiring this into the Verifier or setup) is
// explicitly out of scope for this task and is not exercised here.
//
// Every test constructs its own throwaway fixture tree under a per-run
// temp directory and passes fully injected options (repository, skillRoot,
// env, homeDir, platform, localAppData) to discoverPlaywrightRuntime() so
// results never depend on — or leak from — this actual machine's real
// Playwright installation, environment variables, or home directory.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {discoverPlaywrightRuntime} from "./playwright-runtime.mjs";

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  return false;
};

const FIXTURE_PREFIX = "ap-pw-runtime-";
// Snapshot BEFORE creating this run's own root — a stray directory left
// behind by a previous interrupted/crashed run (which never reached its own
// cleanup) must never be misattributed to THIS run's leak check below.
const preExistingFixtureDirs = new Set(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith(FIXTURE_PREFIX)));
const root = fs.mkdtempSync(path.join(os.tmpdir(), FIXTURE_PREFIX));
const fixtures = [];
function freshDir(name) {
  const dir = path.join(root, name, String(fixtures.length));
  fs.mkdirSync(dir, {recursive: true});
  fixtures.push(dir);
  return dir;
}

// ---------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------

// A real (validation-passing) playwright/@playwright-test install: a
// package.json with the CORRECT `name`, a version field, and at least one
// real regular entry file (index.js) — never just a bare package.json, and
// never satisfied by an empty `lib/` directory alone (still created here so
// the fixture matches a real install's shape, but it is not what makes
// validation pass).
function writeInstalledPackage(nodeModulesDir, pkgName) {
  const relDir = pkgName === "@playwright/test" ? path.join("@playwright", "test") : pkgName;
  const pkgDir = path.join(nodeModulesDir, relDir);
  fs.mkdirSync(pkgDir, {recursive: true});
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({name: pkgName, version: "1.2.3"}, null, 2));
  fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = {};\n");
  fs.mkdirSync(path.join(pkgDir, "lib"), {recursive: true});
  return pkgDir;
}

// A directory containing package.json (with a version) but NO other
// installed files — the "declaration without installed files" case that
// must be rejected.
function writeStubPackage(nodeModulesDir, pkgName) {
  const relDir = pkgName === "@playwright/test" ? path.join("@playwright", "test") : pkgName;
  const pkgDir = path.join(nodeModulesDir, relDir);
  fs.mkdirSync(pkgDir, {recursive: true});
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({name: pkgName, version: "1.2.3"}, null, 2));
  return pkgDir;
}

function writeEmptyPackageDir(nodeModulesDir, pkgName) {
  const relDir = pkgName === "@playwright/test" ? path.join("@playwright", "test") : pkgName;
  const pkgDir = path.join(nodeModulesDir, relDir);
  fs.mkdirSync(pkgDir, {recursive: true});
  return pkgDir;
}

// Same shape as writeInstalledPackage, but package.json's own "name" field
// does not match the package directory it lives in (e.g. a typosquat or a
// misplaced/corrupted install) — must be rejected on package identity
// grounds even though a real entry file is present.
function writeWrongNamePackage(nodeModulesDir, pkgName) {
  const relDir = pkgName === "@playwright/test" ? path.join("@playwright", "test") : pkgName;
  const pkgDir = path.join(nodeModulesDir, relDir);
  fs.mkdirSync(pkgDir, {recursive: true});
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({name: "not-" + pkgName.replace("/", "-"), version: "1.2.3"}, null, 2));
  fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = {};\n");
  return pkgDir;
}

// package.json (correct name + version) plus an empty lib/ directory and
// NOTHING else — the "empty lib/ alone is not an install" case.
function writeEmptyLibOnlyPackage(nodeModulesDir, pkgName) {
  const relDir = pkgName === "@playwright/test" ? path.join("@playwright", "test") : pkgName;
  const pkgDir = path.join(nodeModulesDir, relDir);
  fs.mkdirSync(path.join(pkgDir, "lib"), {recursive: true});
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({name: pkgName, version: "1.2.3"}, null, 2));
  return pkgDir;
}

// package.json (correct name + version, no recognized top-level entry
// basename) whose "main" field points at a real regular file elsewhere
// inside the package directory — the package.json "main" acceptance path.
function writeMainEntryPackage(nodeModulesDir, pkgName, {mainRelPath = path.join("lib", "main.js"), createTarget = true} = {}) {
  const relDir = pkgName === "@playwright/test" ? path.join("@playwright", "test") : pkgName;
  const pkgDir = path.join(nodeModulesDir, relDir);
  fs.mkdirSync(pkgDir, {recursive: true});
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({name: pkgName, version: "1.2.3", main: mainRelPath}, null, 2));
  if (createTarget) {
    const targetPath = path.join(pkgDir, mainRelPath);
    fs.mkdirSync(path.dirname(targetPath), {recursive: true});
    fs.writeFileSync(targetPath, "module.exports = {};\n");
  }
  return pkgDir;
}

// package.json (correct name + version) whose "main" points at a real
// regular file OUTSIDE the resolved package directory via a symlink that
// escapes — the "entry symlink escaping the package root" rejection case.
function writeEscapingEntryPackage(nodeModulesDir, pkgName, outsideDir) {
  const relDir = pkgName === "@playwright/test" ? path.join("@playwright", "test") : pkgName;
  const pkgDir = path.join(nodeModulesDir, relDir);
  fs.mkdirSync(pkgDir, {recursive: true});
  const outsideTarget = path.join(outsideDir, "outside-entry.js");
  fs.writeFileSync(outsideTarget, "module.exports = {};\n");
  const linkPath = path.join(pkgDir, "index.js");
  fs.symlinkSync(outsideTarget, linkPath, process.platform === "win32" ? "file" : undefined);
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({name: pkgName, version: "1.2.3"}, null, 2));
  return {pkgDir, linkPath, outsideTarget};
}

function windowsExeNameFor(exeName) {
  return exeName.endsWith(".exe") ? exeName : `${exeName}.exe`;
}

// A real (validation-passing) browser cache:
// <root>/<revisionPrefix>-<rev>/<platformDir>/<exeName>
// On a POSIX target the file is chmod'd +x — a real Playwright install
// always produces an executable browser binary, and discovery now requires
// (and enforces) that for real via a genuine X_OK access check.
function writeBrowserExecutable(cacheRoot, platform, {revisionPrefix = "chromium", exeName, platformDir} = {}) {
  const isWin = platform === "win32";
  const chosenName = exeName ? (isWin ? windowsExeNameFor(exeName) : exeName) : (isWin ? "chrome.exe" : "chrome");
  const revDir = path.join(cacheRoot, `${revisionPrefix}-1091`, platformDir || (isWin ? "chrome-win" : "chrome-linux"));
  fs.mkdirSync(revDir, {recursive: true});
  const exePath = path.join(revDir, chosenName);
  fs.writeFileSync(exePath, "#!/bin/sh\necho not-a-real-binary\n");
  if (!isWin) {
    // Real POSIX Playwright installs are executable. chmod is a real,
    // required precondition for the resolver's X_OK check whenever this
    // suite actually runs on a POSIX host (WSL/Linux); on an actual
    // Windows host this call is harmless and inert (Windows has no
    // meaningful POSIX execute bit for fs.accessSync's X_OK to enforce),
    // so it is always safe to apply regardless of the real host.
    try { fs.chmodSync(exePath, 0o755); } catch { /* best-effort on this host */ }
  }
  return exePath;
}

// Same shape as writeBrowserExecutable but deliberately WITHOUT the execute
// bit — a real file, correctly named, that a real launch could never run.
function writeNonExecutableBrowserFile(cacheRoot, {revisionPrefix = "chromium", exeName = "chrome", platformDir = "chrome-linux"} = {}) {
  const revDir = path.join(cacheRoot, `${revisionPrefix}-1091`, platformDir);
  fs.mkdirSync(revDir, {recursive: true});
  const exePath = path.join(revDir, exeName);
  fs.writeFileSync(exePath, "just some text, not a real binary\n");
  fs.chmodSync(exePath, 0o644); // explicit: readable/writable, NOT executable
  return exePath;
}

// ---------------------------------------------------------------------
// 1/3. Explicit valid overrides win over everything else
// ---------------------------------------------------------------------
{
  const explicitModuleDir = freshDir("explicit-module");
  writeInstalledPackage(explicitModuleDir, "playwright");

  const repo = freshDir("repo-with-valid-module-too");
  writeInstalledPackage(path.join(repo, "node_modules"), "playwright");

  const result = discoverPlaywrightRuntime({
    repository: repo,
    env: {PLAYWRIGHT_MODULE_DIR: explicitModuleDir},
    platform: "linux",
    homeDir: freshDir("home-unused-1")
  });
  check("1. explicit valid module override wins over repository", result.module.status === "discovered" && result.module.source === "explicit-env", result.module);
  check("1b. explicit module resolves inside the explicit dir, not the repository", result.module.nodeModulesDir === explicitModuleDir, result.module);
}
{
  const explicitBrowserRoot = freshDir("explicit-browser");
  const exePath = writeBrowserExecutable(explicitBrowserRoot, "linux");

  const homeDir = freshDir("home-with-valid-browser-too");
  writeBrowserExecutable(path.join(homeDir, ".cache", "ms-playwright"), "linux");

  const moduleDir = freshDir("module-for-browser-explicit-test");
  writeInstalledPackage(moduleDir, "playwright");

  const result = discoverPlaywrightRuntime({
    env: {PLAYWRIGHT_MODULE_DIR: moduleDir, PLAYWRIGHT_BROWSERS_PATH: explicitBrowserRoot},
    platform: "linux",
    homeDir
  });
  check("3. explicit valid browser override wins over platform cache", result.browser.status === "discovered" && result.browser.source === "explicit-env", result.browser);
  check("3b. explicit browser path resolves to the explicit executable", result.browser.path === fs.realpathSync(exePath), result.browser);
  check("3c. readyForLaunchProbe is true when both are discovered", result.readyForLaunchProbe === true, result);
}

// ---------------------------------------------------------------------
// 2/4. Invalid explicit overrides fail CLOSED (never fall back)
// ---------------------------------------------------------------------
{
  const invalidExplicitModuleDir = freshDir("invalid-explicit-module");
  writeStubPackage(invalidExplicitModuleDir, "playwright"); // package.json only, no entry files

  const repo = freshDir("repo-would-have-worked");
  writeInstalledPackage(path.join(repo, "node_modules"), "playwright");

  const result = discoverPlaywrightRuntime({
    repository: repo,
    env: {PLAYWRIGHT_MODULE_DIR: invalidExplicitModuleDir},
    platform: "linux",
    homeDir: freshDir("home-unused-2")
  });
  check("2. invalid explicit module override fails closed (status)", result.module.status === "invalid-explicit-override", result.module);
  check("2b. invalid explicit module override does NOT fall back to the repository", result.module.dir === null && result.module.source === "explicit-env", result.module);
  check("2c. failureReason mentions the module dimension", typeof result.failureReason === "string" && result.failureReason.includes("module:"), result.failureReason);
}
{
  const invalidExplicitBrowserRoot = freshDir("invalid-explicit-browser");
  fs.mkdirSync(path.join(invalidExplicitBrowserRoot, "empty-subdir"), {recursive: true}); // no executable

  const homeDir = freshDir("home-would-have-worked");
  writeBrowserExecutable(path.join(homeDir, ".cache", "ms-playwright"), "linux");

  const moduleDir = freshDir("module-for-invalid-browser-test");
  writeInstalledPackage(moduleDir, "playwright");

  const result = discoverPlaywrightRuntime({
    env: {PLAYWRIGHT_MODULE_DIR: moduleDir, PLAYWRIGHT_BROWSERS_PATH: invalidExplicitBrowserRoot},
    platform: "linux",
    homeDir
  });
  check("4. invalid explicit browser override fails closed (status)", result.browser.status === "invalid-explicit-override", result.browser);
  check("4b. invalid explicit browser override does NOT fall back to the home cache", result.browser.path === null && result.browser.source === "explicit-env", result.browser);
  check("4c. readyForLaunchProbe is false when the browser override is invalid", result.readyForLaunchProbe === false, result);
  check("4d. failureReason mentions the browser dimension", typeof result.failureReason === "string" && result.failureReason.includes("browser:"), result.failureReason);
}

// ---------------------------------------------------------------------
// 5/6/7. Precedence chain: repository -> skill -> autopilot-runtime
// ---------------------------------------------------------------------
{
  const repo = freshDir("precedence-repo");
  writeInstalledPackage(path.join(repo, "node_modules"), "playwright");
  const result = discoverPlaywrightRuntime({repository: repo, env: {}, platform: "linux", homeDir: freshDir("home-unused-3")});
  check("5. official-repository module discovery works", result.module.status === "discovered" && result.module.source === "repository", result.module);
}
{
  const skillRoot = freshDir("precedence-skill");
  writeInstalledPackage(path.join(skillRoot, "node_modules"), "@playwright/test");
  const result = discoverPlaywrightRuntime({skillRoot, env: {}, platform: "linux", homeDir: freshDir("home-unused-4")});
  check("6. skill-local module discovery works", result.module.status === "discovered" && result.module.source === "skill", result.module);
  check("11. @playwright/test package layout is recognized", result.module.package === "@playwright/test", result.module);
}
{
  const homeDir = freshDir("precedence-home-posix");
  const runtimeNodeModules = path.join(homeDir, ".cache", "project-autopilot", "playwright", "node_modules");
  writeInstalledPackage(runtimeNodeModules, "playwright");
  const result = discoverPlaywrightRuntime({env: {}, platform: "linux", homeDir});
  check("7. stable per-user Autopilot module discovery works (Linux/WSL)", result.module.status === "discovered" && result.module.source === "autopilot-runtime", result.module);
  check("10. playwright package layout is recognized", result.module.package === "playwright", result.module);
}
{
  const localAppData = freshDir("precedence-localappdata-win");
  const runtimeNodeModules = path.join(localAppData, "project-autopilot", "playwright", "node_modules");
  writeInstalledPackage(runtimeNodeModules, "playwright");
  const result = discoverPlaywrightRuntime({env: {}, platform: "win32", localAppData, homeDir: freshDir("home-unused-win")});
  check("7b. stable per-user Autopilot module discovery works (Windows LOCALAPPDATA)", result.module.status === "discovered" && result.module.source === "autopilot-runtime", result.module);
}

// ---------------------------------------------------------------------
// 8/9. Platform-standard browser cache discovery
// ---------------------------------------------------------------------
{
  const localAppData = freshDir("win-browser-localappdata");
  const exePath = writeBrowserExecutable(path.join(localAppData, "ms-playwright"), "win32");
  const result = discoverPlaywrightRuntime({env: {}, platform: "win32", localAppData, homeDir: freshDir("home-unused-win2")});
  check("8. Windows LOCALAPPDATA browser discovery works", result.browser.status === "discovered" && result.browser.source === "platform-cache", result.browser);
  check("8b. Windows browser path resolves to the created chrome.exe", result.browser.path === fs.realpathSync(exePath), result.browser);
}
{
  const homeDir = freshDir("linux-browser-home");
  const exePath = writeBrowserExecutable(path.join(homeDir, ".cache", "ms-playwright"), "linux");
  const result = discoverPlaywrightRuntime({env: {}, platform: "linux", homeDir});
  check("9. Linux/WSL home-cache browser discovery works", result.browser.status === "discovered" && result.browser.source === "platform-cache", result.browser);
  check("9b. Linux browser path resolves to the created chrome executable", result.browser.path === fs.realpathSync(exePath), result.browser);
}

// ---------------------------------------------------------------------
// 12/13. Rejections: empty directory, and package.json-only "install"
// ---------------------------------------------------------------------
{
  const repo = freshDir("empty-dir-repo");
  writeEmptyPackageDir(path.join(repo, "node_modules"), "playwright");
  const result = discoverPlaywrightRuntime({repository: repo, env: {}, platform: "linux", homeDir: freshDir("home-unused-5")});
  check("12. an empty package directory is rejected (not discovered)", result.module.status === "not-found", result.module);
}
{
  const repo = freshDir("stub-package-repo");
  writeStubPackage(path.join(repo, "node_modules"), "playwright");
  const result = discoverPlaywrightRuntime({repository: repo, env: {}, platform: "linux", homeDir: freshDir("home-unused-6")});
  check("13. package.json declaration without installed files is rejected", result.module.status === "not-found", result.module);
}

// ---------------------------------------------------------------------
// CORRECTION C: strengthened package identity/entry validation.
// ---------------------------------------------------------------------
{
  // C8: package.json with the wrong "name" is rejected, even with a real entry file.
  const repo = freshDir("wrong-name-repo");
  writeWrongNamePackage(path.join(repo, "node_modules"), "playwright");
  const result = discoverPlaywrightRuntime({repository: repo, env: {}, platform: "linux", homeDir: freshDir("home-unused-c8")});
  check("C8. package.json with the wrong name is rejected", result.module.status === "not-found", result.module);
}
{
  // C9: package.json + an empty lib/ directory, and nothing else, is rejected
  // (an empty/real-file-less lib/ no longer counts as an entry by itself).
  const repo = freshDir("empty-lib-only-repo");
  writeEmptyLibOnlyPackage(path.join(repo, "node_modules"), "playwright");
  const result = discoverPlaywrightRuntime({repository: repo, env: {}, platform: "linux", homeDir: freshDir("home-unused-c9")});
  check("C9. package.json plus an empty lib/ directory alone is rejected", result.module.status === "not-found", result.module);
}
{
  // C10: package.json + a real regular index.js entry is accepted (the
  // ordinary case — already exercised throughout via writeInstalledPackage,
  // reproven directly here against a fresh, minimal fixture).
  const repo = freshDir("real-index-entry-repo");
  const pkgDir = path.join(repo, "node_modules", "playwright");
  fs.mkdirSync(pkgDir, {recursive: true});
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({name: "playwright", version: "1.2.3"}, null, 2));
  fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = {};\n");
  const result = discoverPlaywrightRuntime({repository: repo, env: {}, platform: "linux", homeDir: freshDir("home-unused-c10")});
  check("C10. package.json plus a real regular index.js entry is accepted", result.module.status === "discovered" && result.module.package === "playwright", result.module);
}
{
  // C11: a valid package.json "main" entry (no recognized top-level entry
  // basename present) is accepted.
  const repo = freshDir("valid-main-entry-repo");
  writeMainEntryPackage(path.join(repo, "node_modules"), "playwright", {mainRelPath: path.join("lib", "main.js")});
  const result = discoverPlaywrightRuntime({repository: repo, env: {}, platform: "linux", homeDir: freshDir("home-unused-c11")});
  check("C11. a valid package.json \"main\" entry is accepted", result.module.status === "discovered" && result.module.package === "playwright", result.module);
}
{
  // C12: package.json declares a "main" but the target file was never
  // actually installed — rejected, not silently ignored.
  const repo = freshDir("missing-main-target-repo");
  writeMainEntryPackage(path.join(repo, "node_modules"), "playwright", {mainRelPath: path.join("lib", "main.js"), createTarget: false});
  const result = discoverPlaywrightRuntime({repository: repo, env: {}, platform: "linux", homeDir: freshDir("home-unused-c12")});
  check("C12. a missing package.json \"main\" target is rejected", result.module.status === "not-found", result.module);
}
{
  // C13: a package entry that is a symlink escaping the resolved package
  // root is rejected, even though the symlink itself lives at a recognized
  // entry basename ("index.js") inside the package directory.
  const repo = freshDir("escaping-entry-repo");
  const nodeModulesDir = path.join(repo, "node_modules");
  fs.mkdirSync(nodeModulesDir, {recursive: true});
  const outsideDir = freshDir("escaping-entry-outside");
  let escapingFixtureCreated = false;
  try {
    writeEscapingEntryPackage(nodeModulesDir, "playwright", outsideDir);
    escapingFixtureCreated = true;
  } catch (error) {
    console.log(`SKIP C13: cannot create a file symlink on this host (${error.code || error.message})`);
  }
  if (escapingFixtureCreated) {
    const result = discoverPlaywrightRuntime({repository: repo, env: {}, platform: "linux", homeDir: freshDir("home-unused-c13")});
    check("C13. a package entry symlink escaping the resolved package root is rejected", result.module.status === "not-found", result.module);
  }
}
{
  // C-pnpm: a whole package DIRECTORY that is itself a symlink (the
  // pnpm content-store layout) is still allowed, as long as its entry file
  // stays inside the RESOLVED (real) package directory — proves escaping
  // entries are rejected on their own merits, not merely by disallowing all
  // package-directory symlinks outright.
  const repo = freshDir("pnpm-style-repo");
  const nodeModulesDir = path.join(repo, "node_modules");
  fs.mkdirSync(nodeModulesDir, {recursive: true});
  const store = freshDir("pnpm-style-store");
  const realPkgDir = path.join(store, "playwright");
  fs.mkdirSync(realPkgDir, {recursive: true});
  fs.writeFileSync(path.join(realPkgDir, "package.json"), JSON.stringify({name: "playwright", version: "1.2.3"}, null, 2));
  fs.writeFileSync(path.join(realPkgDir, "index.js"), "module.exports = {};\n");
  let pnpmLinkCreated = false;
  try {
    fs.symlinkSync(realPkgDir, path.join(nodeModulesDir, "playwright"), process.platform === "win32" ? "junction" : "dir");
    pnpmLinkCreated = true;
  } catch (error) {
    console.log(`SKIP C-pnpm: cannot create a directory symlink/junction on this host (${error.code || error.message})`);
  }
  if (pnpmLinkCreated) {
    const result = discoverPlaywrightRuntime({repository: repo, env: {}, platform: "linux", homeDir: freshDir("home-unused-cpnpm")});
    check("C-pnpm. a package directory that is itself a symlink (pnpm layout) is still discovered", result.module.status === "discovered" && result.module.package === "playwright", result.module);
  }
}

// ---------------------------------------------------------------------
// 14/15. Browser cache without an executable is rejected; both layouts recognized
// ---------------------------------------------------------------------
{
  const repo = freshDir("browser-cache-no-exe");
  fs.mkdirSync(path.join(repo, "chromium-1091", "chrome-linux"), {recursive: true});
  fs.writeFileSync(path.join(repo, "chromium-1091", "chrome-linux", "README.txt"), "no executable here");
  const result = discoverPlaywrightRuntime({env: {PLAYWRIGHT_BROWSERS_PATH: repo, PLAYWRIGHT_MODULE_DIR: null}, platform: "linux", homeDir: freshDir("home-unused-7")});
  check("14. a browser cache without a recognized executable is rejected", result.browser.status === "invalid-explicit-override", result.browser);
}
{
  const cacheRoot = freshDir("headless-shell-layout");
  const exePath = writeBrowserExecutable(cacheRoot, "linux", {revisionPrefix: "chromium_headless_shell", exeName: "headless_shell"});
  const result = discoverPlaywrightRuntime({env: {PLAYWRIGHT_BROWSERS_PATH: cacheRoot}, platform: "linux", homeDir: freshDir("home-unused-8")});
  check("15a. Chromium headless-shell layout is recognized", result.browser.status === "discovered" && result.browser.path === fs.realpathSync(exePath), result.browser);
}
{
  const cacheRoot = freshDir("chrome-win-layout");
  const exePath = writeBrowserExecutable(cacheRoot, "win32", {exeName: "chrome.exe"});
  const result = discoverPlaywrightRuntime({env: {PLAYWRIGHT_BROWSERS_PATH: cacheRoot}, platform: "win32", localAppData: freshDir("localappdata-unused"), homeDir: freshDir("home-unused-9")});
  check("15b. Chromium chrome.exe layout is recognized on Windows", result.browser.status === "discovered" && result.browser.path === fs.realpathSync(exePath), result.browser);
}

// ---------------------------------------------------------------------
// CORRECTION A/B/D: strengthened browser executable validation.
// ---------------------------------------------------------------------
{
  // D1/D2: a text file named "chrome" without execute permission is
  // rejected; adding the execute bit back makes the SAME fixture
  // discoverable. Only meaningful on a real POSIX host — POSIX permission
  // bits are not a real concept on Windows (Node's own fs.accessSync(...,
  // X_OK) does not enforce them there), so on native Windows this whole
  // pairing is a documented, honest SKIP rather than a test that would
  // silently pass without ever having exercised the real POSIX check.
  if (process.platform === "win32") {
    console.log("SKIP D1/D2: POSIX execute-permission enforcement is not meaningful on native Windows (fs.accessSync X_OK does not check it there) — run under WSL/Linux for real enforcement.");
  } else {
    const cacheRoot = freshDir("non-executable-chrome");
    const exePath = writeNonExecutableBrowserFile(cacheRoot);
    const before = discoverPlaywrightRuntime({env: {PLAYWRIGHT_BROWSERS_PATH: cacheRoot}, platform: "linux", homeDir: freshDir("home-unused-d1")});
    check("D1. a text file named \"chrome\" without execute permission is rejected", before.browser.status === "invalid-explicit-override", before.browser);

    fs.chmodSync(exePath, 0o755);
    const after = discoverPlaywrightRuntime({env: {PLAYWRIGHT_BROWSERS_PATH: cacheRoot}, platform: "linux", homeDir: freshDir("home-unused-d2")});
    check("D2. adding execute permission makes the SAME fixture discoverable", after.browser.status === "discovered" && after.browser.path === fs.realpathSync(exePath), after.browser);
  }
}
{
  // D3: modern chrome-headless-shell Linux layout
  // (chromium_headless_shell-<rev>/chrome-headless-shell-linux64/chrome-headless-shell).
  const cacheRoot = freshDir("modern-headless-shell-linux");
  const exePath = writeBrowserExecutable(cacheRoot, "linux", {
    revisionPrefix: "chromium_headless_shell", exeName: "chrome-headless-shell", platformDir: "chrome-headless-shell-linux64"
  });
  const result = discoverPlaywrightRuntime({env: {PLAYWRIGHT_BROWSERS_PATH: cacheRoot}, platform: "linux", homeDir: freshDir("home-unused-d3")});
  check("D3. modern chrome-headless-shell Linux layout is discovered", result.browser.status === "discovered" && result.browser.path === fs.realpathSync(exePath), result.browser);
}
{
  // D4: modern chrome-headless-shell.exe Windows layout.
  const cacheRoot = freshDir("modern-headless-shell-win");
  const exePath = writeBrowserExecutable(cacheRoot, "win32", {
    revisionPrefix: "chromium_headless_shell", exeName: "chrome-headless-shell.exe", platformDir: "chrome-headless-shell-win64"
  });
  const result = discoverPlaywrightRuntime({env: {PLAYWRIGHT_BROWSERS_PATH: cacheRoot}, platform: "win32", localAppData: freshDir("localappdata-unused-d4"), homeDir: freshDir("home-unused-d4")});
  check("D4. modern chrome-headless-shell.exe Windows layout is discovered", result.browser.status === "discovered" && result.browser.path === fs.realpathSync(exePath), result.browser);
}
{
  // D5: legacy headless_shell / headless-shell names (both spellings) remain
  // recognized alongside the new chrome-headless-shell basename.
  const underscoreRoot = freshDir("legacy-headless-underscore");
  const underscorePath = writeBrowserExecutable(underscoreRoot, "linux", {revisionPrefix: "chromium_headless_shell", exeName: "headless_shell"});
  const underscoreResult = discoverPlaywrightRuntime({env: {PLAYWRIGHT_BROWSERS_PATH: underscoreRoot}, platform: "linux", homeDir: freshDir("home-unused-d5a")});
  check("D5a. legacy headless_shell (underscore) name remains recognized", underscoreResult.browser.status === "discovered" && underscoreResult.browser.path === fs.realpathSync(underscorePath), underscoreResult.browser);

  const hyphenRoot = freshDir("legacy-headless-hyphen");
  const hyphenPath = writeBrowserExecutable(hyphenRoot, "linux", {revisionPrefix: "chromium_headless_shell", exeName: "headless-shell"});
  const hyphenResult = discoverPlaywrightRuntime({env: {PLAYWRIGHT_BROWSERS_PATH: hyphenRoot}, platform: "linux", homeDir: freshDir("home-unused-d5b")});
  check("D5b. legacy headless-shell (hyphen) name remains recognized", hyphenResult.browser.status === "discovered" && hyphenResult.browser.path === fs.realpathSync(hyphenPath), hyphenResult.browser);
}
{
  // D6: a DIRECTORY named exactly like a recognized executable basename
  // must never be accepted as the executable itself.
  const cacheRoot = freshDir("dir-named-like-exe");
  fs.mkdirSync(path.join(cacheRoot, "chromium-1091", "chrome-linux", "chrome"), {recursive: true}); // "chrome" is a DIRECTORY here
  const result = discoverPlaywrightRuntime({env: {PLAYWRIGHT_BROWSERS_PATH: cacheRoot}, platform: "linux", homeDir: freshDir("home-unused-d6")});
  check("D6. a directory named like an executable is rejected (never returned as the executable)", result.browser.status === "invalid-explicit-override", result.browser);
}
{
  // D7: a FIFO/socket entry with a recognized executable basename is
  // rejected — created for real only where the host OS permits it (POSIX
  // `mkfifo`); this is TEST FIXTURE setup only (not part of the resolver
  // itself — see the "no subprocess" checks below, which assert against
  // playwright-runtime.mjs's own source, not this test file).
  if (process.platform === "win32") {
    console.log("SKIP D7: FIFO/socket creation is not attempted on native Windows (no portable equivalent) — unsupported-type rejection is still exercised structurally by D6 above.");
  } else {
    const cacheRoot = freshDir("fifo-named-like-exe");
    const revDir = path.join(cacheRoot, "chromium-1091", "chrome-linux");
    fs.mkdirSync(revDir, {recursive: true});
    const fifoPath = path.join(revDir, "chrome");
    const {spawnSync} = await import("node:child_process");
    const mkfifo = spawnSync("mkfifo", [fifoPath], {stdio: "ignore"});
    if (mkfifo.status !== 0) {
      console.log(`SKIP D7: "mkfifo" is unavailable or failed on this host (status=${mkfifo.status}, error=${mkfifo.error?.message || "n/a"})`);
    } else {
      const result = discoverPlaywrightRuntime({env: {PLAYWRIGHT_BROWSERS_PATH: cacheRoot}, platform: "linux", homeDir: freshDir("home-unused-d7")});
      check("D7. a FIFO named like an executable is rejected", result.browser.status === "invalid-explicit-override", result.browser);
    }
  }
}

// ---------------------------------------------------------------------
// 16. Canonical absolute paths are returned
// ---------------------------------------------------------------------
{
  const repo = freshDir("canonical-paths-repo");
  const pkgDir = writeInstalledPackage(path.join(repo, "node_modules"), "playwright");
  const cacheRoot = freshDir("canonical-paths-browser");
  const exePath = writeBrowserExecutable(cacheRoot, "linux");
  const result = discoverPlaywrightRuntime({repository: repo, env: {PLAYWRIGHT_BROWSERS_PATH: cacheRoot}, platform: "linux", homeDir: freshDir("home-unused-10")});
  check("16a. module.dir is an absolute, canonical path", path.isAbsolute(result.module.dir) && result.module.dir === fs.realpathSync(pkgDir), result.module);
  check("16b. browser.path is an absolute, canonical path", path.isAbsolute(result.browser.path) && result.browser.path === fs.realpathSync(exePath), result.browser);
}

// ---------------------------------------------------------------------
// 17. Browser executable containment is enforced (symlink/junction escape)
// ---------------------------------------------------------------------
{
  const cacheRoot = freshDir("containment-cache-root");
  const outsideDir = freshDir("containment-outside-target");
  writeBrowserExecutable(outsideDir, "linux"); // real executable OUTSIDE the cache root

  const linkPath = path.join(cacheRoot, "escaped-chromium");
  let linkCreated = false;
  try {
    fs.symlinkSync(outsideDir, linkPath, process.platform === "win32" ? "junction" : "dir");
    linkCreated = true;
  } catch (error) {
    console.log(`SKIP 17: cannot create a directory symlink/junction on this host (${error.code || error.message}) — containment logic still exercised by 17b below`);
  }

  if (linkCreated) {
    const result = discoverPlaywrightRuntime({env: {PLAYWRIGHT_BROWSERS_PATH: cacheRoot}, platform: "linux", homeDir: freshDir("home-unused-11")});
    check("17. a browser executable reachable only via a directory link escaping the cache root is never returned", result.browser.status !== "discovered", result.browser);
  }
}
{
  // Direct behavioral proof that content strictly outside a candidate root
  // (no link involved at all) is never treated as part of that root, even
  // when a sibling escape path exists on disk.
  const cacheRoot = freshDir("containment-sibling-root");
  const siblingOutside = path.join(path.dirname(cacheRoot), "sibling-outside-with-browser");
  fs.mkdirSync(siblingOutside, {recursive: true});
  writeBrowserExecutable(siblingOutside, "linux");
  fs.mkdirSync(path.join(cacheRoot, "chromium-empty"), {recursive: true});
  const result = discoverPlaywrightRuntime({env: {PLAYWRIGHT_BROWSERS_PATH: cacheRoot}, platform: "linux", homeDir: freshDir("home-unused-12")});
  check("17b. an executable outside the candidate root (no link) is never discovered as part of it", result.browser.status !== "discovered", result.browser);
}

// ---------------------------------------------------------------------
// 18. No files or metadata are modified by discovery itself
// ---------------------------------------------------------------------
{
  const repo = freshDir("no-mutation-repo");
  const pkgDir = writeInstalledPackage(path.join(repo, "node_modules"), "playwright");
  const pkgJsonPath = path.join(pkgDir, "package.json");
  const before = fs.statSync(pkgJsonPath);
  discoverPlaywrightRuntime({repository: repo, env: {}, platform: "linux", homeDir: freshDir("home-unused-13")});
  discoverPlaywrightRuntime({repository: repo, env: {}, platform: "linux", homeDir: freshDir("home-unused-14")});
  const after = fs.statSync(pkgJsonPath);
  check("18. discovery performs no filesystem writes (mtime/size unchanged across two calls)",
    before.mtimeMs === after.mtimeMs && before.size === after.size, {before: before.mtimeMs, after: after.mtimeMs});
}

// ---------------------------------------------------------------------
// 19. No hardcoded username or /tmp/pw-install path in the new module
// ---------------------------------------------------------------------
{
  const source = fs.readFileSync(new URL("./playwright-runtime.mjs", import.meta.url), "utf8");
  check("19a. no /tmp/pw-install reference", !source.includes("/tmp/pw-install"), null);
  const operatorUser = ["P", "C"].join(".");
  const operatorHome = ["", "home", "linux"].join("/");
  check("19b. no hardcoded operator Windows username", !new RegExp(`\\b${operatorUser.replace(".", "\\.")}\\b`).test(source), null);
  check("19c. no hardcoded operator home path", !source.includes(operatorHome), null);
  check("19d. no hardcoded C:\\Users reference", !source.includes("C:\\Users") && !source.includes("C:/Users"), null);
}

// ---------------------------------------------------------------------
// 20. The resolver launches no subprocesses (static + behavioral)
// ---------------------------------------------------------------------
{
  const source = fs.readFileSync(new URL("./playwright-runtime.mjs", import.meta.url), "utf8");
  check("20a. module does not import node:child_process", !/from\s*["']node:child_process["']/.test(source), null);
  check("20b. module never references spawn/exec/fork", !/\b(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/.test(source), null);
}

// ---------------------------------------------------------------------
// 21. Multiple calls do not persist/cache results globally
// ---------------------------------------------------------------------
{
  const repoA = freshDir("no-global-cache-a");
  writeInstalledPackage(path.join(repoA, "node_modules"), "playwright");
  const first = discoverPlaywrightRuntime({repository: repoA, env: {}, platform: "linux", homeDir: freshDir("home-unused-15")});
  check("21a. first call discovers the first repository's module", first.module.status === "discovered" && first.module.nodeModulesDir === fs.realpathSync(path.join(repoA, "node_modules")), first.module);

  const repoB = freshDir("no-global-cache-b"); // deliberately has NOTHING installed
  const second = discoverPlaywrightRuntime({repository: repoB, env: {}, platform: "linux", homeDir: freshDir("home-unused-16")});
  check("21b. second call against a different (empty) repository does not reuse the first call's result", second.module.status === "not-found", second.module);
}

// ---------------------------------------------------------------------
// Cleanup — 22. all temporary fixtures removed
// ---------------------------------------------------------------------
fs.rmSync(root, {recursive: true, force: true});
const leftovers = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith(FIXTURE_PREFIX) && !preExistingFixtureDirs.has(name));
check("22. no leftover fixture directories remain in the temp root (beyond what pre-existed this run)", leftovers.length === 0, leftovers);

if (failures) {
  console.error(`\n${failures} playwright-runtime discovery check(s) failed.`);
  process.exit(1);
}
console.log("\nplaywright-runtime discovery PASS");
