#!/usr/bin/env node
// Backlog #4: ap-browser-preload.mjs forces navigator.onLine === true on every
// context created through the Playwright wrapper (browser.newContext,
// browser.newPage, and chromium.launchPersistentContext) so apps gated on
// navigator.onLine do not render their offline screen inside a loopback-only
// sandbox network namespace.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {spawn, spawnSync} from "node:child_process";
import {fileURLToPath, pathToFileURL} from "node:url";
import {installVerifierBrowserWrapper} from "./verifier-browser.mjs";
import {discoverPlaywrightRuntime} from "./playwright-runtime.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRootDir = path.resolve(here, "..");

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` - ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  }
}

const tmpDirs = [];
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

const VALID_PNG_HEX =
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082";
const VALID_ZIP_HEX = "504b0506000000000000000000000000000000000000";

function installStubPlaywrightModule(rootDir) {
  const nmDir = path.join(rootDir, "node_modules");
  const pwDir = path.join(nmDir, "playwright");
  fs.mkdirSync(pwDir, {recursive: true});
  fs.writeFileSync(
    path.join(pwDir, "package.json"),
    JSON.stringify({name: "playwright", version: "1.60.0", main: "index.js"}, null, 2)
  );
  fs.writeFileSync(path.join(pwDir, "index.js"), `
const fs = require("node:fs");
const path = require("node:path");
const PNG = Buffer.from(${JSON.stringify(VALID_PNG_HEX)}, "hex");
const ZIP = Buffer.from(${JSON.stringify(VALID_ZIP_HEX)}, "hex");

function makeStubContext(ctxOpts) {
  const initScripts = [];
  let pageCount = 0;

  function evaluateInitScripts() {
    function FakeNavigator() {}
    Object.defineProperty(FakeNavigator.prototype, "onLine", {
      get: () => false,
      enumerable: true,
      configurable: true,
    });
    const fakeWindow = {};
    const prevNavigator = globalThis.Navigator;
    const prevWindow = globalThis.window;
    globalThis.Navigator = FakeNavigator;
    globalThis.window = fakeWindow;
    try {
      for (const fn of initScripts) {
        if (typeof fn === "function") fn();
      }
    } finally {
      if (prevNavigator === undefined) delete globalThis.Navigator;
      else globalThis.Navigator = prevNavigator;
      if (prevWindow === undefined) delete globalThis.window;
      else globalThis.window = prevWindow;
    }
    const nav = new FakeNavigator();
    const desc = Object.getOwnPropertyDescriptor(FakeNavigator.prototype, "onLine");
    return {
      onLine: nav.onLine,
      hasGetter: typeof desc?.get === "function",
      configurable: Boolean(desc?.configurable),
      windowState: fakeWindow,
    };
  }

  return {
    ctxOpts,
    initScripts,
    tracing: {
      async start() {},
      async stop(stopOpts = {}) {
        if (stopOpts?.path) {
          fs.mkdirSync(path.dirname(stopOpts.path), {recursive: true});
          fs.writeFileSync(stopOpts.path, ZIP);
        }
      },
    },
    async addInitScript(fn) {
      initScripts.push(fn);
    },
    pages() {
      return [];
    },
    async newPage() {
      pageCount += 1;
      const initCountAtNewPage = initScripts.length;
      return {
        initCountAtNewPage,
        async goto(url) {
          this.lastLoad = evaluateInitScripts();
          return {status: () => 200, url: () => url};
        },
        async screenshot(shotOpts = {}) {
          if (shotOpts?.path) {
            fs.mkdirSync(path.dirname(shotOpts.path), {recursive: true});
            fs.writeFileSync(shotOpts.path, PNG);
          }
          return PNG;
        },
        isClosed: () => false,
        async close() {},
      };
    },
    async close() {},
  };
}

const chromium = {
  async launch(opts = {}) {
    return {
      launchOpts: opts,
      async newContext(ctxOpts = {}) {
        return makeStubContext(ctxOpts);
      },
      async newPage(ctxOpts = {}) {
        const ctx = await this.newContext(ctxOpts);
        return ctx.newPage();
      },
      async close() {},
    };
  },
  async launchPersistentContext(userDataDir, opts = {}) {
    return makeStubContext({userDataDir, ...opts});
  },
};

module.exports = {chromium, default: {chromium}};
`);
  const browserRoot = path.join(nmDir, "playwright-core", ".local-browsers");
  const exeDir = path.join(browserRoot, "chromium-1223", process.platform === "win32" ? "chrome-win" : "chrome-linux");
  fs.mkdirSync(exeDir, {recursive: true});
  const exePath = path.join(exeDir, process.platform === "win32" ? "chrome.exe" : "chrome");
  fs.writeFileSync(exePath, "#!/bin/sh\nexit 0\n", {mode: 0o755});
  try { fs.chmodSync(exePath, 0o755); } catch {}
  const stubEnv = {...process.env};
  delete stubEnv.PLAYWRIGHT_MODULE_DIR;
  delete stubEnv.PLAYWRIGHT_BROWSERS_PATH;
  return discoverPlaywrightRuntime({repository: rootDir, env: stubEnv});
}

try {
  // --- 1. Preload wrapper behavior via stub Playwright -----------------------
  console.log("1. Preload installs configurable Navigator.prototype.onLine getter on newContext, newPage, and launchPersistentContext");
  {
    const stubRoot = tmp("ap-b4-stub-pkg-");
    const stubRuntime = installStubPlaywrightModule(stubRoot);
    const guardDir = tmp("ap-b4-stub-guard-");
    const artDir = tmp("ap-b4-stub-art-");
    const {preloadPath} = installVerifierBrowserWrapper({
      guardDir,
      runDir: artDir,
      scratchDir: artDir,
      repo: stubRoot,
      playwrightRuntime: stubRuntime,
    });

    const scriptPath = path.join(tmp("ap-b4-stub-script-"), "check-stub.mjs");
    fs.writeFileSync(scriptPath, `
import {chromium} from "playwright";

const browser = await chromium.launch();

// A) browser.newContext preserves options, installs init script before page load,
//    and keeps user init scripts + configurability working.
const ctx = await browser.newContext({locale: "en-US"});
await ctx.addInitScript(() => {
  window.userInitRan = true;
});
const pageA = await ctx.newPage();
await pageA.goto("http://127.0.0.1/test-a");
const resultA = {
  localePreserved: ctx.ctxOpts?.locale === "en-US",
  initCountAtNewPage: pageA.initCountAtNewPage,
  ...pageA.lastLoad,
};

// Verify configurable: user init script can override navigator.onLine back to false
const ctxOverride = await browser.newContext();
await ctxOverride.addInitScript(() => {
  Object.defineProperty(Navigator.prototype, "onLine", {
    get: () => false,
    configurable: true,
  });
});
const pageOverride = await ctxOverride.newPage();
await pageOverride.goto("http://127.0.0.1/test-override");
const resultOverride = pageOverride.lastLoad;

// B) browser.newPage preserves options and installs init script before newPage
const pageB = await browser.newPage({locale: "ar-SA"});
await pageB.goto("http://127.0.0.1/test-b");
const resultB = {
  initCountAtNewPage: pageB.initCountAtNewPage,
  ...pageB.lastLoad,
};

// C) chromium.launchPersistentContext preserves options and installs init script
const pCtx = await chromium.launchPersistentContext("/tmp/fake-profile", {locale: "fr-FR"});
const pageC = await pCtx.newPage();
await pageC.goto("http://127.0.0.1/test-c");
const resultC = {
  localePreserved: pCtx.ctxOpts?.locale === "fr-FR",
  initCountAtNewPage: pageC.initCountAtNewPage,
  ...pageC.lastLoad,
};

await pCtx.close();
await ctxOverride.close();
await ctx.close();
await pageB.close();
await browser.close();

console.log(JSON.stringify({resultA, resultOverride, resultB, resultC}));
`);

    const stubChildEnv = {
      ...process.env,
      AUTOPILOT_PLAYWRIGHT_MODULE_ROOT: stubRuntime.module.nodeModulesDir,
      PLAYWRIGHT_BROWSERS_PATH: stubRuntime.browser.root,
      AUTOPILOT_BROWSER_ARTIFACT_DIR: artDir,
    };
    delete stubChildEnv.PLAYWRIGHT_MODULE_DIR;

    const r = spawnSync(process.execPath, ["--import", pathToFileURL(preloadPath).href, scriptPath], {
      env: stubChildEnv,
      encoding: "utf8",
      timeout: 15000,
    });
    let out = null;
    try { out = JSON.parse((r.stdout || "").trim().split("\n").pop()); } catch {}

    check("stub preload script exited 0", r.status === 0, {status: r.status, stdout: r.stdout, stderr: r.stderr});
    check(
      "browser.newContext installs configurable online getter and preserves options + user init script",
      out?.resultA?.localePreserved === true
        && out?.resultA?.initCountAtNewPage >= 2
        && out?.resultA?.onLine === true
        && out?.resultA?.hasGetter === true
        && out?.resultA?.configurable === true
        && out?.resultA?.windowState?.userInitRan === true,
      out?.resultA
    );
    check(
      "Navigator.prototype.onLine remains configurable so a user init script can override it",
      out?.resultOverride?.onLine === false,
      out?.resultOverride
    );
    check(
      "browser.newPage installs configurable online getter before page load",
      out?.resultB?.initCountAtNewPage >= 1
        && out?.resultB?.onLine === true
        && out?.resultB?.hasGetter === true
        && out?.resultB?.configurable === true,
      out?.resultB
    );
    check(
      "chromium.launchPersistentContext installs configurable online getter and preserves options",
      out?.resultC?.localePreserved === true
        && out?.resultC?.initCountAtNewPage >= 1
        && out?.resultC?.onLine === true
        && out?.resultC?.hasGetter === true
        && out?.resultC?.configurable === true,
      out?.resultC
    );
  }

  // --- 2. Real headless Chromium run via preload -----------------------------
  console.log("2. Real headless Chromium through ap-browser-preload.mjs reports navigator.onLine === true");
  {
    const hostPw = discoverPlaywrightRuntime({
      repository: skillRootDir,
      skillRoot: skillRootDir,
    });

    if (!hostPw.readyForLaunchProbe) {
      console.log(
        `  skip (real Playwright/Chromium not available in this environment: module=${hostPw.module?.status}${hostPw.module?.reason ? ` (${hostPw.module.reason})` : ""}, browser=${hostPw.browser?.status}${hostPw.browser?.reason ? ` (${hostPw.browser.reason})` : ""})`
      );
    } else {
      const server = http.createServer((req, res) => {
        res.writeHead(200, {"content-type": "text/html; charset=utf-8"});
        res.end(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Online Check</title></head>
  <body>
    <pre id="online"></pre>
    <script>
      window.__onlineAtLoad = navigator.onLine;
      window.__descAtLoad = Object.getOwnPropertyDescriptor(Navigator.prototype, "onLine");
      document.getElementById("online").textContent = String(navigator.onLine);
    </script>
  </body>
</html>`);
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const {port} = server.address();
      const testUrl = `http://127.0.0.1:${port}/`;

      try {
        const guardDir = tmp("ap-b4-real-guard-");
        const artDir = tmp("ap-b4-real-art-");
        const profileDir = tmp("ap-b4-real-profile-");
        const {preloadPath} = installVerifierBrowserWrapper({
          guardDir,
          runDir: artDir,
          scratchDir: artDir,
          repo: skillRootDir,
          playwrightRuntime: hostPw,
        });

        const scriptPath = path.join(tmp("ap-b4-real-script-"), "check-real-chromium.mjs");
        const pwPackage = hostPw.module.package || "playwright";
        fs.writeFileSync(scriptPath, `
import {createRequire} from "node:module";

const require = createRequire(import.meta.url);
const {chromium} = require(${JSON.stringify(pwPackage)});

const url = process.env.TEST_ONLINE_URL;
const profileDir = process.env.TEST_PROFILE_DIR;

const browser = await chromium.launch({headless: true});

// A) browser.newPage()
const pageDirect = await browser.newPage();
await pageDirect.goto(url, {waitUntil: "domcontentloaded"});
const viaNewPage = await pageDirect.evaluate(() => ({
  renderedText: document.getElementById("online")?.textContent,
  onlineAtLoad: window.__onlineAtLoad,
  onlineNow: navigator.onLine,
  configurable: Boolean(Object.getOwnPropertyDescriptor(Navigator.prototype, "onLine")?.configurable),
}));
await pageDirect.close();

// B) browser.newContext().newPage() with user options and user init script
const ctx = await browser.newContext({viewport: {width: 1024, height: 768}});
await ctx.addInitScript(() => {
  window.__userInitRan = true;
});
const pageCtx = await ctx.newPage();
await pageCtx.goto(url, {waitUntil: "domcontentloaded"});
const viaNewContext = await pageCtx.evaluate(() => ({
  renderedText: document.getElementById("online")?.textContent,
  onlineAtLoad: window.__onlineAtLoad,
  onlineNow: navigator.onLine,
  userInitRan: window.__userInitRan === true,
  innerWidth: window.innerWidth,
  configurable: Boolean(Object.getOwnPropertyDescriptor(Navigator.prototype, "onLine")?.configurable),
}));
await ctx.close();
await browser.close();

// C) chromium.launchPersistentContext()
const pCtx = await chromium.launchPersistentContext(profileDir, {headless: true, viewport: {width: 900, height: 600}});
const pagePersistent = await pCtx.newPage();
await pagePersistent.goto(url, {waitUntil: "domcontentloaded"});
const viaPersistent = await pagePersistent.evaluate(() => ({
  renderedText: document.getElementById("online")?.textContent,
  onlineAtLoad: window.__onlineAtLoad,
  onlineNow: navigator.onLine,
  innerWidth: window.innerWidth,
  configurable: Boolean(Object.getOwnPropertyDescriptor(Navigator.prototype, "onLine")?.configurable),
}));
await pCtx.close();

console.log(JSON.stringify({viaNewPage, viaNewContext, viaPersistent}));
`);

        const r = await new Promise((resolve) => {
          const child = spawn(process.execPath, ["--import", pathToFileURL(preloadPath).href, scriptPath], {
            env: {
              ...process.env,
              AUTOPILOT_PLAYWRIGHT_MODULE_ROOT: hostPw.module.nodeModulesDir,
              PLAYWRIGHT_BROWSERS_PATH: hostPw.browser.root,
              AUTOPILOT_BROWSER_ARTIFACT_DIR: artDir,
              TEST_ONLINE_URL: testUrl,
              TEST_PROFILE_DIR: profileDir,
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          let timedOut = false;
          let settled = false;
          const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
          };
          const timer = setTimeout(() => {
            timedOut = true;
            try { child.kill("SIGTERM"); } catch {}
            setTimeout(() => {
              try { child.kill("SIGKILL"); } catch {}
            }, 2000).unref();
          }, 60000);
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", (chunk) => { stdout += chunk; });
          child.stderr.on("data", (chunk) => { stderr += chunk; });
          child.on("error", (err) => {
            finish({status: null, signal: null, timedOut, stdout, stderr: `${stderr}${err.message}`});
          });
          child.on("close", (code, signal) => {
            finish({status: code, signal, timedOut, stdout, stderr});
          });
        });
        let out = null;
        try { out = JSON.parse((r.stdout || "").trim().split("\n").pop()); } catch {}

        check("real headless Chromium preload script exited 0", r.status === 0, {
          status: r.status,
          signal: r.signal,
          timedOut: r.timedOut,
          stdout: r.stdout,
          stderr: r.stderr,
        });
        check(
          "real Chromium browser.newPage() reports navigator.onLine === true at page load",
          out?.viaNewPage?.renderedText === "true"
            && out?.viaNewPage?.onlineAtLoad === true
            && out?.viaNewPage?.onlineNow === true
            && out?.viaNewPage?.configurable === true,
          out?.viaNewPage
        );
        check(
          "real Chromium browser.newContext().newPage() reports navigator.onLine === true and preserves options + user init script",
          out?.viaNewContext?.renderedText === "true"
            && out?.viaNewContext?.onlineAtLoad === true
            && out?.viaNewContext?.onlineNow === true
            && out?.viaNewContext?.userInitRan === true
            && out?.viaNewContext?.innerWidth === 1024
            && out?.viaNewContext?.configurable === true,
          out?.viaNewContext
        );
        check(
          "real Chromium chromium.launchPersistentContext() reports navigator.onLine === true at page load",
          out?.viaPersistent?.renderedText === "true"
            && out?.viaPersistent?.onlineAtLoad === true
            && out?.viaPersistent?.onlineNow === true
            && out?.viaPersistent?.innerWidth === 900
            && out?.viaPersistent?.configurable === true,
          out?.viaPersistent
        );
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, {recursive: true, force: true}); } catch {}
  }
}

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
