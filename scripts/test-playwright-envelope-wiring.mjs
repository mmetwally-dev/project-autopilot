#!/usr/bin/env node
// Task 15.4C3A behavioral proof: WSL/Linux bubblewrap envelope plumbing for
// an already-discovered Playwright module/browser cache.
//
// This is WSL/Linux envelope plumbing ONLY — it never integrates into
// autopilot.mjs/runRelay, never launches Chromium, never provisions or
// installs Playwright. Every fixture below is a disposable fake filesystem
// tree (a plain directory with a marker file in it); none of it is a real
// Playwright install and none of it is ever executed.
//
// Every proof here drives the REAL production chain:
//   assembleAdapterLaunchPlan() -> buildExecutionEnvelope()
//   -> mapEnvironmentIntoEnvelope() -> a REAL subprocess inside the REAL
//   bubblewrap envelope (spawnSync(envelope.binary, envelope.args, ...)).
// Nothing here asserts source strings or call counts — every check is an
// observable mount, environment variable, or read/write outcome.
//
// Requires Linux/WSL (bubblewrap), matching the existing convention in
// test-execution-envelope-dns.mjs. Fails closed, not skip, on Windows.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import {assembleAdapterLaunchPlan} from "./launch-plan.mjs";
import {mapEnvironmentIntoEnvelope} from "./execution-envelope.mjs";
import {gitSnapshot, touchedFilesBetween} from "./relay-guards.mjs";

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${detail}` : ""}`);
  return false;
};

if (process.platform === "win32") {
  console.log("test-playwright-envelope-wiring: SKIP — platform prerequisite not met: this is WSL/Linux bubblewrap envelope plumbing only (mounting an already-discovered Playwright module/browser cache into the real bwrap sandbox), which requires Linux/WSL2 (bwrap) and does not exist on native Windows. Windows-side Playwright runtime coverage lives in test-windows-verifier-playwright-runtime.mjs.");
  process.exit(0);
}

const lastJsonLine = (stdout, prefix) => {
  const lines = String(stdout || "").trim().split("\n");
  const line = lines.filter(l => l.startsWith(prefix)).at(-1);
  if (!line) return null;
  try { return JSON.parse(line.slice(prefix.length)); } catch { return null; }
};

function makeRepo(prefix) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const git = args => spawnSync("git", args, {cwd: repo, encoding: "utf8", stdio: "pipe", env: withoutOuterGitGuard(process.env), shell: false});
  assert.equal(git(["init", "-q"]).status, 0);
  assert.equal(git(["config", "user.email", "pw-envelope-test@example.invalid"]).status, 0);
  assert.equal(git(["config", "user.name", "Playwright Envelope Test"]).status, 0);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "one");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  return repo;
}

// ---------------------------------------------------------------------
// Disposable fake-filesystem fixtures: a fake node_modules tree and a fake
// browser cache. Neither is a real Playwright install — content proves
// nothing about Playwright itself, only about mount/read/write behavior.
// ---------------------------------------------------------------------
function makeFixtures() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-pw-envelope-fixture-"));
  const moduleDir = path.join(root, "node_modules");
  fs.mkdirSync(path.join(moduleDir, "playwright"), {recursive: true});
  fs.writeFileSync(path.join(moduleDir, "playwright", "package.json"), JSON.stringify({name: "playwright", version: "1.2.3"}, null, 2));
  fs.writeFileSync(path.join(moduleDir, "MODULE_MARKER.txt"), "module-marker-content");

  const browserDir = path.join(root, "ms-playwright-cache");
  fs.mkdirSync(browserDir, {recursive: true});
  fs.writeFileSync(path.join(browserDir, "BROWSER_MARKER.txt"), "browser-marker-content");

  const plainFile = path.join(root, "plain-file.txt");
  fs.writeFileSync(plainFile, "not-a-directory");

  return {
    root,
    moduleDir: fs.realpathSync(moduleDir),
    browserDir: fs.realpathSync(browserDir),
    plainFile: fs.realpathSync(plainFile)
  };
}

function readyRuntime(moduleDir, browserRoot) {
  return {
    readyForLaunchProbe: true,
    module: {status: "discovered", source: "repository", dir: path.join(moduleDir, "playwright"), nodeModulesDir: moduleDir, package: "playwright", reason: null},
    browser: {status: "discovered", source: "platform-cache", path: path.join(browserRoot, "BROWSER_MARKER.txt"), root: browserRoot, reason: null},
    failureReason: null
  };
}

const PROBE_SOURCE = `
import fs from "node:fs";
const results = {};
function tryRead(p) { try { return fs.readFileSync(p, "utf8"); } catch (e) { return "ERR:" + (e.code || e.message); } }
function tryWrite(p) { try { fs.writeFileSync(p, "tampered"); return "SUCCEEDED"; } catch (e) { return "DENIED:" + (e.code || e.message); } }
results.moduleMarkerRead = tryRead("/playwright/node_modules/MODULE_MARKER.txt");
results.modulePkgRead = tryRead("/playwright/node_modules/playwright/package.json");
results.browserMarkerRead = tryRead("/ms-playwright/BROWSER_MARKER.txt");
results.moduleMarkerWrite = tryWrite("/playwright/node_modules/MODULE_MARKER.txt");
results.moduleNewFileWrite = tryWrite("/playwright/node_modules/new-file.txt");
results.browserMarkerWrite = tryWrite("/ms-playwright/BROWSER_MARKER.txt");
results.browserNewFileWrite = tryWrite("/ms-playwright/new-file.txt");
results.repoWrite = tryWrite("/workspace/repository/tracked.txt");
results.scratchWrite = tryWrite("/workspace/scratch/probe-write.txt");
results.env = {
  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? null,
  AUTOPILOT_PLAYWRIGHT_MODULE_ROOT: process.env.AUTOPILOT_PLAYWRIGHT_MODULE_ROOT ?? null,
  NODE_PATH: process.env.NODE_PATH ?? null,
  LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH ?? null
};
console.log("PROBE_RESULT=" + JSON.stringify(results));
`;

// ==========================================================================
// 1-2-3-6-7. Valid discovered runtime: mounts, sandbox metadata, real
// subprocess read/write proof inside the real envelope, sandbox-only child
// environment, host fixtures byte-identical afterward.
// ==========================================================================
{
  const fixtures = makeFixtures();
  const repo = makeRepo("ap-pw-envelope-repo-");
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-pw-envelope-scratch-"));
  const moduleMarkerBefore = fs.readFileSync(path.join(fixtures.moduleDir, "MODULE_MARKER.txt"));
  const modulePkgBefore = fs.readFileSync(path.join(fixtures.moduleDir, "playwright", "package.json"));
  const browserMarkerBefore = fs.readFileSync(path.join(fixtures.browserDir, "BROWSER_MARKER.txt"));
  try {
    const runtime = readyRuntime(fixtures.moduleDir, fixtures.browserDir);
    const plan = assembleAdapterLaunchPlan({
      driver: null,
      adapterProviderProfile: null,
      launchRequest: {binary: process.execPath, args: ["--input-type=module", "-e", PROBE_SOURCE], stdin: ""},
      config: {},
      repo,
      scratchDir,
      readOnly: true,
      permissionFiles: [],
      runtimeFiles: [],
      playwrightRuntime: runtime
    });

    check("valid runtime: launch plan is available", plan.available === true, JSON.stringify({stage: plan.stage, reason: plan.reason, detail: plan.detail}));
    check("valid runtime: envelope is available", plan.envelope?.available === true, plan.envelope?.reason);

    if (plan.available && plan.envelope?.available) {
      // ---- 1. mount + sandbox metadata (truthful host path recorded) ----
      const sandboxMeta = plan.envelope.sandbox?.playwrightModule;
      check("sandbox.playwrightModule.sandbox is /playwright/node_modules", sandboxMeta?.sandbox === "/playwright/node_modules", sandboxMeta);
      check("sandbox.playwrightModule.host is the canonical host node_modules path", sandboxMeta?.host === fixtures.moduleDir, sandboxMeta);
      const browserCache = plan.envelope.sandbox?.browserCache || [];
      check("sandbox.browserCache[0].sandbox is /ms-playwright", browserCache[0]?.sandbox === "/ms-playwright", browserCache);
      check("sandbox.browserCache[0].host is the explicit discovered browser root", browserCache[0]?.host === fixtures.browserDir, browserCache);

      // ---- env object produced by mapEnvironmentIntoEnvelope directly ----
      const envWithNodePath = {...process.env, NODE_PATH: "/some/host/path/that/must/never/leak"};
      const childEnv = mapEnvironmentIntoEnvelope(envWithNodePath, plan.envelope, repo, scratchDir);
      check("child env: PLAYWRIGHT_BROWSERS_PATH is the sandbox path", childEnv.PLAYWRIGHT_BROWSERS_PATH === "/ms-playwright", childEnv.PLAYWRIGHT_BROWSERS_PATH);
      check("child env: AUTOPILOT_PLAYWRIGHT_MODULE_ROOT is the sandbox path", childEnv.AUTOPILOT_PLAYWRIGHT_MODULE_ROOT === "/playwright/node_modules", childEnv.AUTOPILOT_PLAYWRIGHT_MODULE_ROOT);
      check("child env: NODE_PATH (was set) is rewritten to the sandbox path only", childEnv.NODE_PATH === "/playwright/node_modules", childEnv.NODE_PATH);
      check("child env: NODE_PATH contains no host path", !String(childEnv.NODE_PATH || "").includes("must/never/leak"));

      const envWithoutNodePath = {...process.env};
      delete envWithoutNodePath.NODE_PATH;
      const childEnvNoNodePath = mapEnvironmentIntoEnvelope(envWithoutNodePath, plan.envelope, repo, scratchDir);
      check("child env: NODE_PATH is never introduced when absent from the incoming environment", !("NODE_PATH" in childEnvNoNodePath), Object.keys(childEnvNoNodePath).filter(k => k === "NODE_PATH"));

      // ---- 2-5. real subprocess inside the real envelope ----
      const before = gitSnapshot(repo);
      const r = spawnSync(plan.envelope.binary, plan.envelope.args, {encoding: "utf8", shell: false, timeout: 30000, env: childEnv});
      check("valid runtime: probe subprocess exits 0", r.status === 0, r.stderr);
      const results = lastJsonLine(r.stdout, "PROBE_RESULT=") || {};

      check("2. module marker file is readable inside /playwright/node_modules", results.moduleMarkerRead === "module-marker-content", results.moduleMarkerRead);
      check("2. real playwright/package.json is readable inside /playwright/node_modules", typeof results.modulePkgRead === "string" && results.modulePkgRead.includes("\"playwright\""), results.modulePkgRead);
      check("2. browser marker file is readable inside /ms-playwright", results.browserMarkerRead === "browser-marker-content", results.browserMarkerRead);

      check("3. overwriting the module marker fails EROFS", /^DENIED:EROFS$/.test(results.moduleMarkerWrite || ""), results.moduleMarkerWrite);
      check("3. creating a new file under the module mount fails EROFS", /^DENIED:EROFS$/.test(results.moduleNewFileWrite || ""), results.moduleNewFileWrite);
      check("3. overwriting the browser marker fails EROFS", /^DENIED:EROFS$/.test(results.browserMarkerWrite || ""), results.browserMarkerWrite);
      check("3. creating a new file under the browser mount fails EROFS", /^DENIED:EROFS$/.test(results.browserNewFileWrite || ""), results.browserNewFileWrite);

      check("4. repository write still fails EROFS", /^DENIED:EROFS$/.test(results.repoWrite || ""), results.repoWrite);
      check("5. scratch write still succeeds", results.scratchWrite === "SUCCEEDED", results.scratchWrite);

      check("6. subprocess PLAYWRIGHT_BROWSERS_PATH is the sandbox path", results.env?.PLAYWRIGHT_BROWSERS_PATH === "/ms-playwright", results.env);
      check("6. subprocess AUTOPILOT_PLAYWRIGHT_MODULE_ROOT is the sandbox path", results.env?.AUTOPILOT_PLAYWRIGHT_MODULE_ROOT === "/playwright/node_modules", results.env);
      check("6. subprocess NODE_PATH contains no host path", results.env?.NODE_PATH === "/playwright/node_modules", results.env);

      const after = gitSnapshot(repo);
      check("repository containment preserved: host git snapshot unchanged", touchedFilesBetween(before, after, repo).length === 0);
      check("repository containment preserved: host file unchanged", fs.readFileSync(path.join(repo, "tracked.txt"), "utf8") === "one");
    }

    // ---- 7. host fixtures remain byte-identical regardless of outcome ----
    check("7. host module marker file unchanged", fs.readFileSync(path.join(fixtures.moduleDir, "MODULE_MARKER.txt")).equals(moduleMarkerBefore));
    check("7. host playwright/package.json unchanged", fs.readFileSync(path.join(fixtures.moduleDir, "playwright", "package.json")).equals(modulePkgBefore));
    check("7. host browser marker file unchanged", fs.readFileSync(path.join(fixtures.browserDir, "BROWSER_MARKER.txt")).equals(browserMarkerBefore));
    check("7. no stray new-file.txt leaked onto the host module dir", !fs.existsSync(path.join(fixtures.moduleDir, "new-file.txt")));
    check("7. no stray new-file.txt leaked onto the host browser dir", !fs.existsSync(path.join(fixtures.browserDir, "new-file.txt")));
  } finally {
    fs.rmSync(fixtures.root, {recursive: true, force: true});
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(scratchDir, {recursive: true, force: true});
  }
}

// ==========================================================================
// 10. Explicit-runtime gating under a fixture HOME that contains BOTH a
// default browser cache (~/.cache/ms-playwright) and a user library
// directory (~/chromium-libs/...). os.homedir() follows $HOME, so
// overriding process.env.HOME here (restored afterward) makes the legacy
// locations exist deterministically on ANY machine:
//   - null runtime mounts NEITHER, sets NEITHER environment value, and the
//     subprocess cannot see either location;
//   - an explicit valid runtime mounts module + browser (the explicit
//     browser root wins over the default-looking cache) AND the supporting
//     user libraries, with all three environment values set.
// ==========================================================================
{
  const fixtures = makeFixtures();
  const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), "ap-pw-envelope-fixture-home-"));
  const homeCacheDir = path.join(fixtureHome, ".cache", "ms-playwright");
  fs.mkdirSync(homeCacheDir, {recursive: true});
  fs.writeFileSync(path.join(homeCacheDir, "HOME_CACHE_MARKER.txt"), "home-cache-marker");
  const homeLibsDir = path.join(fixtureHome, "chromium-libs", "usr", "lib", "x86_64-linux-gnu");
  fs.mkdirSync(homeLibsDir, {recursive: true});
  fs.writeFileSync(path.join(homeLibsDir, "HOME_LIBS_MARKER.txt"), "home-libs-marker");
  const savedHome = process.env.HOME;
  process.env.HOME = fixtureHome;
  const scrubbedBaseEnv = {...process.env};
  delete scrubbedBaseEnv.PLAYWRIGHT_BROWSERS_PATH;
  delete scrubbedBaseEnv.LD_LIBRARY_PATH;
  try {
    const baseArgs = (extra) => ({
      driver: null,
      adapterProviderProfile: null,
      launchRequest: {binary: process.execPath, args: ["--input-type=module", "-e", PROBE_SOURCE], stdin: ""},
      config: {},
      repo: makeRepo("ap-pw-envelope-gating-repo-"),
      scratchDir: fs.mkdtempSync(path.join(os.tmpdir(), "ap-pw-envelope-gating-scratch-")),
      readOnly: true,
      permissionFiles: [],
      runtimeFiles: [],
      ...extra
    });

    // ---- null runtime: nothing Playwright-related is mounted or set ----
    {
      const launched = baseArgs({playwrightRuntime: null});
      const plan = assembleAdapterLaunchPlan(launched);
      check("10. null runtime: launch plan is available", plan.available === true, plan.reason);
      check("10. null runtime: envelope is available", plan.envelope?.available === true, plan.envelope?.reason);
      if (plan.available && plan.envelope?.available) {
        check("10. null runtime: no browser-cache mount despite an existing default cache",
          !plan.envelope.sandbox?.browserCache?.length, plan.envelope.sandbox?.browserCache);
        check("10. null runtime: no library mount despite an existing user-library directory",
          !plan.envelope.sandbox?.libraryMounts?.length, plan.envelope.sandbox?.libraryMounts);
        check("10. null runtime: no module mount", plan.envelope.sandbox?.playwrightModule == null, plan.envelope.sandbox?.playwrightModule);
        const childEnv = mapEnvironmentIntoEnvelope(scrubbedBaseEnv, plan.envelope, launched.repo, launched.scratchDir);
        check("10. null runtime: PLAYWRIGHT_BROWSERS_PATH is not set", childEnv.PLAYWRIGHT_BROWSERS_PATH == null, childEnv.PLAYWRIGHT_BROWSERS_PATH);
        check("10. null runtime: AUTOPILOT_PLAYWRIGHT_MODULE_ROOT is not set", childEnv.AUTOPILOT_PLAYWRIGHT_MODULE_ROOT == null, childEnv.AUTOPILOT_PLAYWRIGHT_MODULE_ROOT);
        check("10. null runtime: LD_LIBRARY_PATH carries no library mount", childEnv.LD_LIBRARY_PATH == null, childEnv.LD_LIBRARY_PATH);
        const r = spawnSync(plan.envelope.binary, plan.envelope.args, {encoding: "utf8", shell: false, timeout: 30000, env: childEnv});
        check("10. null runtime: probe subprocess exits 0", r.status === 0, r.stderr);
        const results = lastJsonLine(r.stdout, "PROBE_RESULT=") || {};
        check("10. null runtime: default home cache is NOT visible at /ms-playwright",
          typeof results.browserMarkerRead === "string" && results.browserMarkerRead.startsWith("ERR:"), results.browserMarkerRead);
        check("10. null runtime: home-cache marker is NOT readable (no fallback bind)",
          tryReadHomeCacheMarker(results), results.browserMarkerRead);
      }
      fs.rmSync(launched.repo, {recursive: true, force: true});
      fs.rmSync(launched.scratchDir, {recursive: true, force: true});
    }

    // ---- explicit valid runtime: module + browser + support libraries ----
    {
      const launched = baseArgs({playwrightRuntime: readyRuntime(fixtures.moduleDir, fixtures.browserDir)});
      const plan = assembleAdapterLaunchPlan(launched);
      check("10. explicit runtime: launch plan is available", plan.available === true, plan.reason);
      if (plan.available && plan.envelope?.available) {
        check("10. explicit runtime: module mounted at /playwright/node_modules",
          plan.envelope.sandbox?.playwrightModule?.sandbox === "/playwright/node_modules", plan.envelope.sandbox?.playwrightModule);
        check("10. explicit runtime: browser mounted at /ms-playwright from the explicit root (never the default cache)",
          plan.envelope.sandbox?.browserCache?.[0]?.sandbox === "/ms-playwright"
            && plan.envelope.sandbox?.browserCache?.[0]?.host === fixtures.browserDir,
          plan.envelope.sandbox?.browserCache);
        check("10. explicit runtime: supporting user libraries mounted",
          (plan.envelope.sandbox?.libraryMounts || []).some(m => String(m.sandbox || "").startsWith("/chromium-libs/")),
          plan.envelope.sandbox?.libraryMounts);
        const childEnv = mapEnvironmentIntoEnvelope(scrubbedBaseEnv, plan.envelope, launched.repo, launched.scratchDir);
        check("10. explicit runtime: PLAYWRIGHT_BROWSERS_PATH is the sandbox path",
          childEnv.PLAYWRIGHT_BROWSERS_PATH === "/ms-playwright", childEnv.PLAYWRIGHT_BROWSERS_PATH);
        check("10. explicit runtime: AUTOPILOT_PLAYWRIGHT_MODULE_ROOT is the sandbox path",
          childEnv.AUTOPILOT_PLAYWRIGHT_MODULE_ROOT === "/playwright/node_modules", childEnv.AUTOPILOT_PLAYWRIGHT_MODULE_ROOT);
        check("10. explicit runtime: LD_LIBRARY_PATH exposes the library mount",
          typeof childEnv.LD_LIBRARY_PATH === "string" && childEnv.LD_LIBRARY_PATH.includes("/chromium-libs/"), childEnv.LD_LIBRARY_PATH);
        const r = spawnSync(plan.envelope.binary, plan.envelope.args, {encoding: "utf8", shell: false, timeout: 30000, env: childEnv});
        check("10. explicit runtime: probe subprocess exits 0", r.status === 0, r.stderr);
        const results = lastJsonLine(r.stdout, "PROBE_RESULT=") || {};
        check("10. explicit runtime: explicit browser marker readable (not the home cache)",
          results.browserMarkerRead === "browser-marker-content", results.browserMarkerRead);
        check("10. explicit runtime: module marker readable",
          results.moduleMarkerRead === "module-marker-content", results.moduleMarkerRead);
      }
      fs.rmSync(launched.repo, {recursive: true, force: true});
      fs.rmSync(launched.scratchDir, {recursive: true, force: true});
    }
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(fixtures.root, {recursive: true, force: true});
    fs.rmSync(fixtureHome, {recursive: true, force: true});
  }
}

function tryReadHomeCacheMarker(results) {
  return typeof results.browserMarkerRead === "string"
    && !results.browserMarkerRead.includes("home-cache-marker");
}

// ==========================================================================
// 9. readyForLaunchProbe === false: Playwright stays entirely optional, and
// existing non-Playwright envelope behavior (repository/scratch containment)
// is completely unaffected.
// ==========================================================================
for (const [label, runtime] of [
  ["not-ready runtime", {readyForLaunchProbe: false, module: {status: "not-found", source: null}, browser: {status: "not-found", source: null}, failureReason: "none"}],
  ["null runtime", null],
  ["omitted runtime", undefined]
]) {
  const repo = makeRepo("ap-pw-envelope-optional-repo-");
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-pw-envelope-optional-scratch-"));
  try {
    const launchArgs = {
      driver: null,
      adapterProviderProfile: null,
      launchRequest: {binary: process.execPath, args: ["--input-type=module", "-e", PROBE_SOURCE], stdin: ""},
      config: {},
      repo,
      scratchDir,
      readOnly: true,
      permissionFiles: [],
      runtimeFiles: []
    };
    if (runtime !== undefined) launchArgs.playwrightRuntime = runtime;
    const plan = assembleAdapterLaunchPlan(launchArgs);

    check(`9. ${label}: launch plan is available (Playwright is optional, never mandatory)`, plan.available === true, JSON.stringify({stage: plan.stage, reason: plan.reason}));
    check(`9. ${label}: envelope is available`, plan.envelope?.available === true, plan.envelope?.reason);
    if (plan.available && plan.envelope?.available) {
      check(`9. ${label}: no Playwright module mount was created`, plan.envelope.sandbox?.playwrightModule === null, plan.envelope.sandbox?.playwrightModule);

      const childEnv = mapEnvironmentIntoEnvelope(process.env, plan.envelope, repo, scratchDir);
      const before = gitSnapshot(repo);
      const r = spawnSync(plan.envelope.binary, plan.envelope.args, {encoding: "utf8", shell: false, timeout: 30000, env: childEnv});
      check(`9. ${label}: probe subprocess exits 0`, r.status === 0, r.stderr);
      const results = lastJsonLine(r.stdout, "PROBE_RESULT=") || {};
      check(`9. ${label}: repository write still fails EROFS (existing behavior preserved)`, /^DENIED:EROFS$/.test(results.repoWrite || ""), results.repoWrite);
      check(`9. ${label}: scratch write still succeeds (existing behavior preserved)`, results.scratchWrite === "SUCCEEDED", results.scratchWrite);
      check(`9. ${label}: AUTOPILOT_PLAYWRIGHT_MODULE_ROOT is not set`, results.env?.AUTOPILOT_PLAYWRIGHT_MODULE_ROOT == null, results.env);
      const after = gitSnapshot(repo);
      check(`9. ${label}: repository containment preserved`, touchedFilesBetween(before, after, repo).length === 0);
    }
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(scratchDir, {recursive: true, force: true});
  }
}

// ==========================================================================
// 8. Invalid ready runtimes fail the WHOLE launch plan closed — never a
// partial mount, never a silent fallback. No envelope is ever built and no
// subprocess is ever spawned for any of these.
// ==========================================================================
{
  const fixtures = makeFixtures();
  const repo = makeRepo("ap-pw-envelope-invalid-repo-");
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-pw-envelope-invalid-scratch-"));
  const escapingLinkDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-pw-envelope-outside-"));
  try {
    const nonexistentModule = fixtures.moduleDir + "-does-not-exist";
    const nonexistentBrowser = fixtures.browserDir + "-does-not-exist";

    function assertInvalid(label, moduleDir, browserRoot) {
      const runtime = {
        readyForLaunchProbe: true,
        module: {status: "discovered", source: "repository", dir: null, nodeModulesDir: moduleDir, package: "playwright", reason: null},
        browser: {status: "discovered", source: "platform-cache", path: null, root: browserRoot, reason: null},
        failureReason: null
      };
      const plan = assembleAdapterLaunchPlan({
        driver: null,
        adapterProviderProfile: null,
        launchRequest: {binary: process.execPath, args: ["--input-type=module", "-e", "console.log('should never run')"], stdin: ""},
        config: {},
        repo,
        scratchDir,
        readOnly: true,
        permissionFiles: [],
        runtimeFiles: [],
        playwrightRuntime: runtime
      });
      check(`8. ${label}: launch plan fails closed (available=false)`, plan.available === false, plan);
      check(`8. ${label}: stage is playwright_runtime`, plan.stage === "playwright_runtime", plan.stage);
      check(`8. ${label}: reason is playwright_runtime_invalid`, plan.reason === "playwright_runtime_invalid", plan.reason);
      check(`8. ${label}: no envelope was ever built`, plan.envelope === null, plan.envelope);
    }

    assertInvalid("missing nodeModulesDir", undefined, fixtures.browserDir);
    assertInvalid("relative nodeModulesDir", "relative/node_modules", fixtures.browserDir);
    assertInvalid("nonexistent nodeModulesDir", nonexistentModule, fixtures.browserDir);
    assertInvalid("nodeModulesDir is a file", fixtures.plainFile, fixtures.browserDir);
    assertInvalid("missing browser.root", fixtures.moduleDir, undefined);
    assertInvalid("relative browser.root", fixtures.moduleDir, "relative/ms-playwright");
    assertInvalid("nonexistent browser.root", fixtures.moduleDir, nonexistentBrowser);
    assertInvalid("browser.root is a file", fixtures.moduleDir, fixtures.plainFile);

    // Escaping symlink/junction, where the host supports creating one.
    const escapingLink = path.join(fixtures.root, "escaping-node_modules-link");
    try {
      fs.symlinkSync(escapingLinkDir, escapingLink, "dir");
      assertInvalid("escaping symlink nodeModulesDir", escapingLink, fixtures.browserDir);
    } catch (error) {
      console.log(`SKIP 8.escaping-nodeModulesDir: cannot create a directory symlink on this host (${error.code || error.message})`);
    }
    const escapingBrowserLink = path.join(fixtures.root, "escaping-browser-link");
    try {
      fs.symlinkSync(escapingLinkDir, escapingBrowserLink, "dir");
      assertInvalid("escaping symlink browser.root", fixtures.moduleDir, escapingBrowserLink);
    } catch (error) {
      console.log(`SKIP 8.escaping-browserRoot: cannot create a directory symlink on this host (${error.code || error.message})`);
    }
  } finally {
    fs.rmSync(fixtures.root, {recursive: true, force: true});
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(scratchDir, {recursive: true, force: true});
    fs.rmSync(escapingLinkDir, {recursive: true, force: true});
  }
}

if (failures) {
  console.error(`${failures} Playwright envelope wiring check(s) failed.`);
  process.exit(1);
}
console.log("test-playwright-envelope-wiring: ALL CHECKS PASSED (10. no Chromium/Playwright subprocess was ever launched by this file)");
