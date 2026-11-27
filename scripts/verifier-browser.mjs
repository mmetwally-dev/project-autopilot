// Backlog #7: approved verifier browser command (ap-browser-check), brief
// instructions when the server is up, and the REQUIRED proof rule for browser
// verification.
//
// How ap-browser-check is approved and runs:
//   - When the verifier runs, installVerifierBrowserWrapper() places an
//     `ap-browser-check` executable in the run's git-guard PATH shim directory
//     (which is already first on PATH for every role and mapped to
//     `/workspace/scratch/git-guard` inside the read-only bubblewrap envelope)
//     alongside `ap-browser-check.mjs` and a small `.ap-browser-check.json`
//     metadata file.
//   - The verifier agent itself runs inside the read-only bubblewrap envelope
//     (or the Windows disposable copy) with the host network (for provider
//     calls). When it runs `ap-browser-check <script.mjs>`, the wrapper joins
//     the phase's isolated network namespace (`nsenter` via session.joinPrefix
//     from backlog #4) when a server is in namespace/host-bridge mode, injects
//     APP_BASE_URL, PORT, the test credentials from tests.app_server.env_file /
//     env (values never echoed; every output channel is masked with
//     maskSecrets()), and a preload module (`--import`) that wraps Playwright's
//     chromium.launch / newContext / page.goto / page.screenshot so that:
//       * Chromium always launches headless with `--no-sandbox`
//       * every context records a Playwright trace (`trace.zip`) and a video
//         (`.webm`) into the run's `browser-check/` directory
//       * at least one screenshot (`page-1.png`, ...) is captured automatically
//         for checked pages in addition to any `page.screenshot()` calls the
//         script makes (which are also copied into `browser-check/`)
//       * the verifier's script itself is saved in `browser-check/`
//       * exit code, masked stdout/stderr, and artifact list are recorded in
//         `browser-check/evidence.json` and `browser-check/output.log`.
//   - When called directly from the host (outside an envelope), the wrapper
//     builds the verifier's read-only bubblewrap envelope via
//     buildExecutionEnvelope({readOnly: true, playwrightModuleDir,
//     playwrightBrowserRoot}) and joins the network namespace via
//     buildNetworkIsolationInvocation({joinNetworkNamespace}).
//
// Proof rule (REQUIRED):
//   - verifyBrowserProof(runDir) checks that `browser-check/evidence.json`
//     exists in the verifier's run directory, recorded a clean exit (exitCode
//     === 0), and that the saved script file plus at least one valid PNG
//     screenshot file exist on disk in `browser-check/`.
//   - evaluateVerifierBrowserOutcome() enforces this on the verifier's result:
//     when a phase requires a browser check (taskFacts.browser or
//     taskFacts.playwright) and the verifier returns PASS without valid wrapper
//     proof (and without a BROWSER CHECK NOT POSSIBLE note when the server or
//     Playwright was missing), the browser check counts as NOT DONE — it is
//     recorded as a manual check in MANUAL-CHECKS.md (`browserProofAccepted:
//     false`), never as a proven browser PASS.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {spawn, spawnSync} from "node:child_process";
import {pathToFileURL} from "node:url";
import {parseEnvFile, maskSecrets, registerAppCleanup} from "./app-server.mjs";
import {appServerAllowHosts, makeSocketDir} from "./app-net.mjs";
import {buildExecutionEnvelope, mapEnvironmentIntoEnvelope, buildNetworkIsolationInvocation} from "./execution-envelope.mjs";
import {BROWSER_CHECK_NOTE_PREFIX, browserCheckNotes} from "./task-requirements.mjs";

export const BROWSER_WRAPPER_COMMAND = "ap-browser-check";
export const BROWSER_CHECK_DIR_NAME = "browser-check";
export const BROWSER_EVIDENCE_FILE = "evidence.json";
export const BROWSER_PROXY_BYPASS_LIST = "127.0.0.1;localhost";
export const BROWSER_BROKER_SANDBOX_SOCKET = "/autopilot/browser-broker.sock";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ZIP_MAGIC = Buffer.from([0x50, 0x4b]);

// Collects all key-value pairs from tests.app_server.env_file and
// tests.app_server.env. Values are passed only to the wrapper's child env and
// masked everywhere else; only the variable NAMES are shown in the verifier
// brief.
export function resolveAppServerSecrets(appCfg, repo) {
  const secrets = {};
  if (!appCfg || typeof appCfg !== "object") return secrets;
  if (typeof appCfg.env_file === "string" && appCfg.env_file.trim() && repo) {
    try {
      const envPath = path.resolve(repo, appCfg.env_file.trim());
      if (fs.existsSync(envPath)) {
        Object.assign(secrets, parseEnvFile(fs.readFileSync(envPath, "utf8")));
      }
    } catch {}
  }
  if (appCfg.env && typeof appCfg.env === "object") {
    for (const [k, v] of Object.entries(appCfg.env)) {
      if (v != null) secrets[k] = String(v);
    }
  }
  return secrets;
}

// Credential variable names to list in the verifier brief (never values).
// Internal fixture control variables (FIXTURE_*) are excluded so test harness
// knobs don't clutter the credential list when real env vars are present.
// Default when unset/empty = names starting with E2E_ or TEST_ and ending with
// EMAIL, USER, USERNAME or PASSWORD (case-sensitive upper).
// When tests.app_server.credential_vars is explicitly configured and non-empty,
// only those configured variable names are returned.
export function credentialEnvNames(secrets, configOrVars = null) {
  if (!secrets || typeof secrets !== "object") return [];
  const explicit = Array.isArray(configOrVars)
    ? configOrVars
    : (Array.isArray(configOrVars?.credential_vars) ? configOrVars.credential_vars : null);
  const cleanExplicit = explicit
    ? explicit.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim())
    : null;

  const validKeys = Object.keys(secrets).filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !k.startsWith("FIXTURE_"));

  if (cleanExplicit && cleanExplicit.length > 0) {
    const seen = new Set();
    const result = [];
    for (const k of cleanExplicit) {
      if (!seen.has(k) && k in secrets && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !k.startsWith("FIXTURE_")) {
        seen.add(k);
        result.push(k);
      }
    }
    return result;
  }

  return validKeys.filter((k) => /^(?:E2E_|TEST_)[A-Za-z0-9_]*(?:EMAIL|USER|USERNAME|PASSWORD)$/.test(k));
}

// Builds the browser-check instructions for the verifier brief when the app
// server is running and Playwright is available.
export function verifierBrowserBrief({session, playwrightRuntime = null, appCfg = null, repo = null, scratchDir = "/workspace/scratch"} = {}) {
  const serverUp = Boolean(session && session.alive?.() !== false && session.baseUrl);
  if (!serverUp) return "";
  const pwReady = playwrightRuntime?.readyForLaunchProbe === true
    || (playwrightRuntime?.module?.status === "discovered" && playwrightRuntime?.browser?.status === "discovered");
  const secrets = resolveAppServerSecrets(appCfg, repo);
  const credNames = credentialEnvNames(secrets, appCfg);
  const allowHosts = Array.isArray(session.allowHosts) && session.allowHosts.length > 0
    ? session.allowHosts
    : appServerAllowHosts(appCfg);
  const scratchLabel = scratchDir || "/workspace/scratch";

  if (!pwReady) {
    return [
      `Browser check: the app server is running at ${session.baseUrl}, but Playwright + Chromium are not available for this run.`,
      `Do not claim a browser PASS; add one note starting with "${BROWSER_CHECK_NOTE_PREFIX}" naming the changed pages and acceptance criteria for the operator to check by hand.`
    ].join("\n");
  }

  const credLine = credNames.length > 0
    ? `Sign in when needed using the test credential environment variable names available inside \`${BROWSER_WRAPPER_COMMAND}\`: ${credNames.join(", ")} (read them via \`process.env.<NAME>\` inside your script — their values are injected into the wrapper's environment and are never shown in this brief; never echo or print secret values).`
    : `If a page requires sign-in and no test credentials or test-only login path exist, record "${BROWSER_CHECK_NOTE_PREFIX}" for that page.`;

  const reachLine = allowHosts.length > 0
    ? `Network reachability inside \`${BROWSER_WRAPPER_COMMAND}\`: only \`APP_BASE_URL\` (\`${session.baseUrl}\`) and the configured \`tests.app_server.allow_hosts\` domains (${allowHosts.join(", ")}, on port 443 via an allowlisting HTTP CONNECT proxy) are reachable from the browser; every other host or port is refused. Email-inbox flows (invitation / password-reset links) stay manual checks.`
    : `Network reachability inside \`${BROWSER_WRAPPER_COMMAND}\`: the browser runs in a closed network namespace (only \`APP_BASE_URL\` on loopback is reachable; no outside hosts). Email-inbox flows (invitation / password-reset links) stay manual checks.`;

  return [
    `Approved browser verification command: \`${BROWSER_WRAPPER_COMMAND} <script.mjs>\``,
    `When this phase changes UI/browser behavior, write a Playwright check script in your scratch directory (for example \`${scratchLabel}/check-ui.mjs\`) or pass an existing spec, and run it through \`${BROWSER_WRAPPER_COMMAND} ${scratchLabel}/check-ui.mjs\`.`,
    `- Open the changed pages at \`process.env.APP_BASE_URL\` (\`${session.baseUrl}\`) and check the acceptance criteria (check mobile width and Arabic RTL when the phase asks for it).`,
    `- ${credLine}`,
    `- ${reachLine}`,
    `- Retry a failing browser assertion once before returning FAIL (to avoid flaky timing on first render).`,
    `- \`${BROWSER_WRAPPER_COMMAND}\` runs headless Chromium with \`--no-sandbox\` inside the isolated network namespace and automatically saves your script, a screenshot per checked page (\`.png\`), a Playwright trace (\`trace.zip\`) and a video (\`.webm\`), plus the exit code and output. You may also call \`await page.screenshot({ path: ... })\` explicitly.`,
    `- REQUIRED proof rule: the orchestrator accepts a browser PASS only when \`${BROWSER_WRAPPER_COMMAND}\` actually ran in this verifier run (exit code 0 + output recorded, saved script + at least one screenshot present). Without that evidence, a browser PASS is not accepted and counts as a manual check.`,
    `- Use "${BROWSER_CHECK_NOTE_PREFIX}" only when something required for the browser check is genuinely missing (for example, external OAuth/2FA with no test login path, an email-inbox flow such as an invite or password-reset link, or a third-party service not in \`allow_hosts\`).`
  ].join("\n");
}

// Preload script injected via `node --import` when ap-browser-check runs the
// verifier's Playwright script. It wraps Playwright's chromium.launch so:
//   1. headless: true and --no-sandbox are always enforced (plus
//      --proxy-server and --proxy-bypass-list when allow_hosts is active)
//   2. every browser.newContext() enables recordVideo into the artifact dir
//      and starts context.tracing({screenshots:true, snapshots:true})
//   3. every page.goto() and page.screenshot() captures a PNG screenshot into
//      the artifact dir, and before browser.close() (or process exit) at least
//      one screenshot, the trace zip, and the video are flushed into the
//      artifact dir.
// It also exposes `createRequire(process.env.AUTOPILOT_PLAYWRIGHT_MODULE_ROOT + "/")`
// resolution so a verifier script that does `import { chromium } from "playwright"`
// or `createRequire(...)("playwright")` works seamlessly.
//
// IMPORTANT: Playwright's `playwright/index.js` is NOT loaded eagerly at
// preload startup! Eagerly requiring `playwright` inside an `--import`
// preload hook (while Node's ESM loader is still initializing) causes V8's
// RegExpCompiler to OOM at ~14 MB heap inside bubblewrap when compiling
// Playwright's Babel/pirates transform regexes. Instead, `Module._load`
// intercepts `playwright` / `playwright-core` / `@playwright/test` lazily when
// the user script itself imports or requires Playwright.
function buildPreloadSource() {
  return `// Auto-generated by Autopilot ap-browser-check preload
import fs from "node:fs";
import path from "node:path";
import Module, {createRequire} from "node:module";

const ARTIFACT_DIR = process.env.AUTOPILOT_BROWSER_ARTIFACT_DIR;
const MODULE_ROOT = process.env.AUTOPILOT_PLAYWRIGHT_MODULE_ROOT;
const PROXY_URL = process.env.AUTOPILOT_BROWSER_PROXY_URL || "";
const PROXY_BYPASS = process.env.AUTOPILOT_BROWSER_PROXY_BYPASS || ${JSON.stringify(BROWSER_PROXY_BYPASS_LIST)};

try {
  if (ARTIFACT_DIR) fs.mkdirSync(ARTIFACT_DIR, {recursive: true});
} catch {}

// Hook Module._resolveFilename so require("playwright") or createRequire from
// anywhere finds the discovered Playwright runtime in MODULE_ROOT.
// Re-entrancy guard (resolvingInHook) prevents infinite recursion when
// createRequire(...).resolve() internally calls Module._resolveFilename again.
const origResolve = Module._resolveFilename;
const rootRequire = MODULE_ROOT ? createRequire(path.join(MODULE_ROOT, "noop.js")) : null;
let resolvingInHook = false;
Module._resolveFilename = function(request, parent, isMain, options) {
  if (!resolvingInHook && rootRequire && (request === "playwright" || request === "@playwright/test" || request === "playwright-core")) {
    resolvingInHook = true;
    try {
      return rootRequire.resolve(request);
    } catch {} finally {
      resolvingInHook = false;
    }
  }
  return origResolve.call(this, request, parent, isMain, options);
};

// Also register an ESM resolve hook so \`import { chromium } from "playwright"\`
// in an .mjs script written in /workspace/scratch resolves against MODULE_ROOT.
if (typeof Module.register === "function" && MODULE_ROOT) {
  const hookCode = [
    'import path from "node:path";',
    'import {pathToFileURL} from "node:url";',
    'import {createRequire} from "node:module";',
    'const root = ' + JSON.stringify(MODULE_ROOT) + ';',
    'const rootReq = createRequire(path.join(root, "noop.js"));',
    'let resolving = false;',
    'export async function resolve(specifier, context, nextResolve) {',
    '  if (!resolving && (specifier === "playwright" || specifier === "@playwright/test" || specifier === "playwright-core")) {',
    '    resolving = true;',
    '    try {',
    '      return {url: pathToFileURL(rootReq.resolve(specifier)).href, shortCircuit: true};',
    '    } catch {} finally {',
    '      resolving = false;',
    '    }',
    '  }',
    '  return nextResolve(specifier, context);',
    '}'
  ].join("\\n");
  try {
    Module.register("data:text/javascript;base64," + Buffer.from(hookCode, "utf8").toString("base64"));
  } catch {}
}

let shotCounter = 0;
let traceCounter = 0;
const activeContexts = new Set();
const activeBrowsers = new Set();

function nextShotPath(label = "page") {
  shotCounter += 1;
  const safe = String(label || "page").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "page";
  return path.join(ARTIFACT_DIR, \`screenshot-\${shotCounter}-\${safe}.png\`);
}

function nextTracePath() {
  traceCounter += 1;
  return path.join(ARTIFACT_DIR, traceCounter === 1 ? "trace.zip" : \`trace-\${traceCounter}.zip\`);
}

function wrapPage(page, ctxState) {
  if (!page || page.__apWrapped) return page;
  page.__apWrapped = true;
  ctxState.pages.push(page);

  const origScreenshot = page.screenshot?.bind(page);
  if (origScreenshot) {
    page.screenshot = async function(opts = {}) {
      const userPath = opts && typeof opts.path === "string" ? opts.path : null;
      const autoPath = nextShotPath("shot");
      const targetOpts = {...opts, path: userPath || autoPath};
      const buf = await origScreenshot(targetOpts);
      try {
        if (userPath && path.resolve(userPath) !== path.resolve(autoPath) && fs.existsSync(userPath)) {
          fs.copyFileSync(userPath, autoPath);
        } else if (!fs.existsSync(autoPath) && Buffer.isBuffer(buf)) {
          fs.writeFileSync(autoPath, buf);
        }
        ctxState.screenshots += 1;
      } catch {}
      return buf;
    };
  }

  const origGoto = page.goto?.bind(page);
  if (origGoto) {
    page.goto = async function(url, opts) {
      const resp = await origGoto(url, opts);
      ctxState.visitedUrls.push(String(url));
      return resp;
    };
  }
  return page;
}

async function finalizeContext(ctx, ctxState) {
  if (ctxState.finalized) return;
  ctxState.finalized = true;
  activeContexts.delete(ctxState);
  try {
    if (ctxState.screenshots === 0 && ctxState.pages.length > 0 && origScreenshotAvailable(ctxState.pages)) {
      for (const p of ctxState.pages) {
        try {
          if (!p.isClosed || !p.isClosed()) {
            const shotPath = nextShotPath("auto");
            await p.screenshot({path: shotPath, fullPage: true});
          }
        } catch {}
      }
    }
  } catch {}
  try {
    if (ctxState.tracingStarted && ctx.tracing) {
      await ctx.tracing.stop({path: nextTracePath()});
      ctxState.tracingStarted = false;
    }
  } catch {}
}

function origScreenshotAvailable(pages) {
  return pages.some((p) => typeof p?.screenshot === "function");
}

function wrapContext(ctx) {
  if (!ctx || ctx.__apWrapped) return ctx;
  ctx.__apWrapped = true;
  const ctxState = {ctx, pages: [], visitedUrls: [], screenshots: 0, tracingStarted: false, finalized: false};
  activeContexts.add(ctxState);

  const origNewPage = ctx.newPage?.bind(ctx);
  if (origNewPage) {
    ctx.newPage = async function(...args) {
      const page = await origNewPage(...args);
      return wrapPage(page, ctxState);
    };
  }

  if (ctx.tracing && typeof ctx.tracing.start === "function") {
    const origTracingStart = ctx.tracing.start.bind(ctx.tracing);
    const origTracingStop = ctx.tracing.stop.bind(ctx.tracing);
    ctx.tracing.start = async function(opts = {}) {
      if (ctxState.tracingStarted) return;
      ctxState.tracingStarted = true;
      return origTracingStart({screenshots: true, snapshots: true, ...opts});
    };
    ctx.tracing.stop = async function(opts = {}) {
      const userPath = opts && typeof opts.path === "string" ? opts.path : null;
      const autoTrace = nextTracePath();
      ctxState.tracingStarted = false;
      const res = await origTracingStop({...opts, path: userPath || autoTrace});
      try {
        if (userPath && path.resolve(userPath) !== path.resolve(autoTrace) && fs.existsSync(userPath)) {
          fs.copyFileSync(userPath, autoTrace);
        }
      } catch {}
      return res;
    };
  }

  const origClose = ctx.close?.bind(ctx);
  if (origClose) {
    ctx.close = async function(...args) {
      await finalizeContext(ctx, ctxState);
      return origClose(...args);
    };
  }
  return {ctx, ctxState};
}

// In a loopback-only sandbox network namespace, Chromium sees no non-loopback
// interface and reports navigator.onLine === false even though localhost (the
// app under test) works. Override the getter to return true before page load.
async function installOnlineInitScript(ctx) {
  if (!ctx || typeof ctx.addInitScript !== "function") return;
  try {
    await ctx.addInitScript(() => {
      try {
        Object.defineProperty(Navigator.prototype, "onLine", {
          get: () => true,
          enumerable: true,
          configurable: true,
        });
      } catch {}
    });
  } catch {}
}

function buildLaunchArgs(opts = {}) {
  const rawArgs = Array.isArray(opts?.args) ? [...opts.args] : [];
  const args = rawArgs.includes("--no-sandbox") ? rawArgs : ["--no-sandbox", ...rawArgs];
  if (PROXY_URL) {
    if (!args.some((a) => typeof a === "string" && a.startsWith("--proxy-server="))) {
      args.push(\`--proxy-server=\${PROXY_URL}\`);
    }
    if (!args.some((a) => typeof a === "string" && a.startsWith("--proxy-bypass-list="))) {
      args.push(\`--proxy-bypass-list=\${PROXY_BYPASS}\`);
    }
  }
  return args;
}

function wrapBrowser(browser) {
  if (!browser || browser.__apWrapped) return browser;
  browser.__apWrapped = true;
  const browserContexts = [];
  activeBrowsers.add(browser);

  const origNewContext = browser.newContext?.bind(browser);
  if (origNewContext) {
    browser.newContext = async function(opts = {}) {
      const videoDir = path.join(ARTIFACT_DIR, "video");
      try { fs.mkdirSync(videoDir, {recursive: true}); } catch {}
      const mergedOpts = {
        ...opts,
        recordVideo: opts?.recordVideo || {dir: videoDir}
      };
      const rawCtx = await origNewContext(mergedOpts);
      const {ctx, ctxState} = wrapContext(rawCtx);
      browserContexts.push(ctxState);
      await installOnlineInitScript(ctx);
      try {
        if (ctx.tracing && !ctxState.tracingStarted) {
          await ctx.tracing.start({screenshots: true, snapshots: true});
        }
      } catch {}
      return ctx;
    };
  }

  const origNewPage = browser.newPage?.bind(browser);
  if (origNewPage && origNewContext) {
    browser.newPage = async function(opts = {}) {
      const ctx = await browser.newContext(opts);
      const page = await ctx.newPage();
      const origPageClose = page.close?.bind(page);
      if (origPageClose) {
        page.close = async function(...a) {
          const r = await origPageClose(...a);
          try { await ctx.close(); } catch {}
          return r;
        };
      }
      return page;
    };
  }

  const origClose = browser.close?.bind(browser);
  if (origClose) {
    browser.close = async function(...args) {
      for (const cs of browserContexts) {
        try { await finalizeContext(cs.ctx, cs); } catch {}
      }
      activeBrowsers.delete(browser);
      return origClose(...args);
    };
  }
  return browser;
}

function patchChromium(chromium) {
  if (!chromium || chromium.__apPatched || typeof chromium.launch !== "function") return;
  chromium.__apPatched = true;
  const origLaunch = chromium.launch.bind(chromium);
  chromium.launch = async function(opts = {}) {
    const args = buildLaunchArgs(opts);
    const browser = await origLaunch({...opts, headless: opts?.headless ?? true, args});
    return wrapBrowser(browser);
  };
  if (typeof chromium.launchPersistentContext === "function") {
    const origLaunchPersistent = chromium.launchPersistentContext.bind(chromium);
    chromium.launchPersistentContext = async function(userDataDir, opts = {}) {
      const args = buildLaunchArgs(opts);
      const videoDir = ARTIFACT_DIR ? path.join(ARTIFACT_DIR, "video") : null;
      if (videoDir) {
        try { fs.mkdirSync(videoDir, {recursive: true}); } catch {}
      }
      const mergedOpts = {
        ...opts,
        headless: opts?.headless ?? true,
        args,
        ...(videoDir ? {recordVideo: opts?.recordVideo || {dir: videoDir}} : {})
      };
      const rawCtx = await origLaunchPersistent(userDataDir, mergedOpts);
      const {ctx, ctxState} = wrapContext(rawCtx);
      if (typeof ctx.pages === "function") {
        for (const p of ctx.pages()) wrapPage(p, ctxState);
      }
      await installOnlineInitScript(ctx);
      try {
        if (ctx.tracing && !ctxState.tracingStarted) {
          await ctx.tracing.start({screenshots: true, snapshots: true});
        }
      } catch {}
      return ctx;
    };
  }
}

// Lazily patch Playwright exports when the verifier's script loads them via
// require() / createRequire() / ESM import (which uses Module._load for CJS
// packages such as playwright and playwright-core).
const origLoad = Module._load;
Module._load = function(request, parent, isMain) {
  const loaded = origLoad.apply(this, arguments);
  if (loaded && (typeof loaded === "object" || typeof loaded === "function")) {
    if (loaded.chromium) patchChromium(loaded.chromium);
    if (loaded.default?.chromium) patchChromium(loaded.default.chromium);
  }
  return loaded;
};
`;
}

// Source for the ap-browser-check.mjs runner script placed in the guard dir.
// It can run INSIDE the verifier's envelope (when invoked by the verifier
// agent) or from the host (in tests / standalone verifier calls).
function buildWrapperRunnerSource() {
  return `#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath, pathToFileURL} from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const metaPath = path.join(here, ".ap-browser-check.json");
let meta = {};
try { meta = JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch {}

const MIN_MASK_LEN = 4;
function maskText(text, secrets) {
  let out = String(text ?? "");
  const entries = Object.entries(secrets || {})
    .filter(([, v]) => typeof v === "string" && v.length >= MIN_MASK_LEN)
    .sort((a, b) => b[1].length - a[1].length);
  for (const [name, value] of entries) out = out.split(value).join(\`<\${name}>\`);
  return out;
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  console.error("Usage: ap-browser-check <script.mjs|spec> [args...]");
  process.exit(2);
}

const scriptArg = args[0];
const scriptRestArgs = args.slice(1);
const effectiveCwd = (process.env.AUTOPILOT_BROWSER_SCRIPT_CWD && fs.existsSync(process.env.AUTOPILOT_BROWSER_SCRIPT_CWD))
  ? process.env.AUTOPILOT_BROWSER_SCRIPT_CWD
  : process.cwd();
const resolvedScript = path.resolve(effectiveCwd, scriptArg);

// When running inside the verifier's bubblewrap envelope (which has its own
// isolated PID and user namespaces and therefore cannot \`nsenter\` into the
// host-owned app network namespace), forward the check to the host-side
// browser broker over the private Unix domain socket. The broker executes the
// script on the host via \`nsenter <netns> -- bwrap --ro-bind <repo> ...\` so
// both closed-network isolation and read-only repo containment hold.
if (typeof meta.brokerSocket === "string" && meta.brokerSocket) {
  const payload = JSON.stringify({
    token: meta.brokerToken || "",
    scriptArg,
    resolvedScript,
    scriptRestArgs,
    cwd: effectiveCwd,
  }) + "\\n";
  const brokerExitCode = await new Promise((resolve) => {
    let settled = false;
    let buf = "";
    const finish = (code, out, err, errMsg) => {
      if (settled) return;
      settled = true;
      if (out) process.stdout.write(out);
      if (err) process.stderr.write(err);
      if (errMsg) console.error(\`ap-browser-check error: \${errMsg}\`);
      resolve(typeof code === "number" ? code : 1);
    };
    const client = net.connect(meta.brokerSocket, () => {
      client.write(payload);
    });
    client.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      try { client.end(); } catch {}
      try {
        const resp = JSON.parse(line);
        finish(resp.exitCode, resp.stdout || "", resp.stderr || "", resp.error || null);
      } catch (e) {
        finish(1, "", "", \`invalid response from browser-check broker: \${e?.message || e}\`);
      }
    });
    client.on("error", (e) => finish(1, "", "", \`browser-check broker unavailable: \${e?.message || e}\`));
    client.on("close", () => {
      if (!settled) finish(1, "", "", "browser-check broker closed connection without a response");
    });
  });
  process.exitCode = brokerExitCode;
  await new Promise((r) => setImmediate(r));
  process.exit(brokerExitCode);
}

const insideSandbox = fs.existsSync("/workspace/scratch") && fs.existsSync("/workspace/repository");
const scratchRoot = insideSandbox ? "/workspace/scratch" : (meta.scratchDir || path.dirname(here));
const artifactDir = path.join(scratchRoot, ${JSON.stringify(BROWSER_CHECK_DIR_NAME)});
fs.mkdirSync(artifactDir, {recursive: true});

if (!fs.existsSync(resolvedScript) || !fs.statSync(resolvedScript).isFile()) {
  const msg = \`ap-browser-check: script not found: \${scriptArg}\`;
  console.error(msg);
  process.exit(2);
}

// Copy the verifier's script into browser-check/ so it is preserved as proof.
const savedScriptName = "script-" + path.basename(resolvedScript).replace(/[^A-Za-z0-9._-]+/g, "_");
const savedScriptPath = path.join(artifactDir, savedScriptName);
fs.copyFileSync(resolvedScript, savedScriptPath);

// Snapshot existing files in scratchRoot before running so any screenshots,
// traces or videos the script writes directly to scratchRoot can be copied into
// artifactDir afterwards.
function walkFiles(dir, acc = []) {
  try {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      if (entry.name === "git-guard" || entry.name === ".autopilot-home" || entry.name === ${JSON.stringify(BROWSER_CHECK_DIR_NAME)}) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkFiles(full, acc);
      else if (entry.isFile()) {
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(full).mtimeMs; } catch {}
        acc.push({full, mtimeMs});
      }
    }
  } catch {}
  return acc;
}
const beforeScratch = new Map(walkFiles(scratchRoot).map((x) => [x.full, x.mtimeMs]));

const preloadPath = path.join(here, "ap-browser-preload.mjs");
const moduleRoot = insideSandbox
  ? (process.env.AUTOPILOT_PLAYWRIGHT_MODULE_ROOT || meta.sandboxModuleRoot || "/playwright/node_modules")
  : (process.env.AUTOPILOT_PLAYWRIGHT_MODULE_ROOT || meta.hostModuleRoot || "");
const browsersPath = insideSandbox
  ? (process.env.PLAYWRIGHT_BROWSERS_PATH || meta.sandboxBrowserRoot || "/ms-playwright")
  : (process.env.PLAYWRIGHT_BROWSERS_PATH || meta.hostBrowserRoot || "");

const proxyUrl = meta.proxyUrl || (meta.proxyPort ? \`http://127.0.0.1:\${meta.proxyPort}\` : "");
const proxyBypass = meta.proxyBypassList || ${JSON.stringify(BROWSER_PROXY_BYPASS_LIST)};

const secrets = meta.secrets && typeof meta.secrets === "object" ? meta.secrets : {};
const credentials = meta.credentials && typeof meta.credentials === "object" ? meta.credentials : secrets;
const childEnv = {
  ...process.env,
  ...credentials,
  ...(meta.baseUrl ? {APP_BASE_URL: meta.baseUrl} : {}),
  ...(meta.port ? {PORT: String(meta.port)} : {}),
  ...(moduleRoot ? {AUTOPILOT_PLAYWRIGHT_MODULE_ROOT: moduleRoot} : {}),
  ...(browsersPath ? {PLAYWRIGHT_BROWSERS_PATH: browsersPath} : {}),
  ...(proxyUrl ? {AUTOPILOT_BROWSER_PROXY_URL: proxyUrl, AUTOPILOT_BROWSER_PROXY_BYPASS: proxyBypass} : {}),
  AUTOPILOT_BROWSER_ARTIFACT_DIR: artifactDir,
};

const preloadUrl = pathToFileURL(preloadPath).href;
const nodeArgs = ["--import", preloadUrl, resolvedScript, ...scriptRestArgs];

let spawnBin = process.execPath;
let spawnArgs = nodeArgs;
if (Array.isArray(meta.joinPrefix) && meta.joinPrefix.length > 0) {
  spawnBin = meta.joinPrefix[0];
  spawnArgs = [...meta.joinPrefix.slice(1), process.execPath, ...nodeArgs];
}

const t0 = Date.now();
const r = spawnSync(spawnBin, spawnArgs, {
  cwd: effectiveCwd,
  env: childEnv,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
  timeout: Number(meta.timeoutMs) > 0 ? Number(meta.timeoutMs) : 180000,
  shell: false,
});
const durationMs = Date.now() - t0;

// If the script wrote any .png, .zip (trace) or .webm/.mp4 (video) directly to
// scratchRoot outside artifactDir during this invocation, copy them into
// artifactDir so all proof lives in one place.
for (const {full, mtimeMs} of walkFiles(scratchRoot)) {
  const prev = beforeScratch.get(full);
  if (prev !== undefined && prev >= mtimeMs) continue;
  const ext = path.extname(full).toLowerCase();
  if ([".png", ".zip", ".webm", ".mp4"].includes(ext)) {
    const dest = path.join(artifactDir, path.basename(full));
    if (!fs.existsSync(dest)) {
      try { fs.copyFileSync(full, dest); } catch {}
    }
  }
}

// Flatten any videos saved in artifactDir/video/*.webm up into artifactDir so
// they sit alongside trace.zip and screenshots.
const videoSubdir = path.join(artifactDir, "video");
if (fs.existsSync(videoSubdir)) {
  try {
    let vIdx = 0;
    for (const entry of fs.readdirSync(videoSubdir, {withFileTypes: true})) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === ".webm" || ext === ".mp4") {
        vIdx += 1;
        const targetName = vIdx === 1 ? \`video\${ext}\` : \`video-\${vIdx}\${ext}\`;
        const dest = path.join(artifactDir, targetName);
        fs.renameSync(path.join(videoSubdir, entry.name), dest);
      }
    }
    fs.rmSync(videoSubdir, {recursive: true, force: true});
  } catch {}
}

const maskedStdout = maskText(r.stdout || "", secrets);
const maskedStderr = maskText(r.stderr || "", secrets);
const combinedOutput = [maskedStdout.trim(), maskedStderr.trim()].filter(Boolean).join("\\n");

if (maskedStdout) process.stdout.write(maskedStdout);
if (maskedStderr) process.stderr.write(maskedStderr);
if (r.error) {
  const errMsg = maskText(r.error.message || String(r.error), secrets);
  console.error(\`ap-browser-check error: \${errMsg}\`);
}

// Collect final artifacts in artifactDir
const allFiles = [];
try {
  for (const entry of fs.readdirSync(artifactDir, {withFileTypes: true})) {
    if (entry.isFile()) allFiles.push(entry.name);
  }
} catch {}

const screenshots = allFiles.filter((f) => f.toLowerCase().endsWith(".png")).sort();
const traces = allFiles.filter((f) => f.toLowerCase().endsWith(".zip")).sort();
const videos = allFiles.filter((f) => /\\.(webm|mp4)$/i.test(f)).sort();

const exitCode = typeof r.status === "number" ? r.status : (r.error ? 1 : 1);
const outputLogPath = path.join(artifactDir, "output.log");
fs.writeFileSync(outputLogPath, combinedOutput + (combinedOutput.endsWith("\\n") || !combinedOutput ? "" : "\\n"), "utf8");

const evidence = {
  command: ${JSON.stringify(BROWSER_WRAPPER_COMMAND)},
  scriptArg,
  savedScript: savedScriptName,
  exitCode,
  signal: r.signal || null,
  durationMs,
  recordedAt: new Date().toISOString(),
  baseUrl: meta.baseUrl || null,
  proxyUrl: proxyUrl || null,
  screenshots,
  traces,
  videos,
  outputFile: "output.log",
  outputTail: combinedOutput.slice(-4000),
};
fs.writeFileSync(path.join(artifactDir, ${JSON.stringify(BROWSER_EVIDENCE_FILE)}), JSON.stringify(evidence, null, 2) + "\\n", "utf8");

// Also sync artifacts directly to meta.hostRunArtifactDir if running outside
// bwrap where scratchRoot !== hostRunDir.
if (!insideSandbox && meta.hostRunArtifactDir && path.resolve(meta.hostRunArtifactDir) !== path.resolve(artifactDir)) {
  try {
    fs.mkdirSync(meta.hostRunArtifactDir, {recursive: true});
    for (const name of fs.readdirSync(artifactDir)) {
      const src = path.join(artifactDir, name);
      const dst = path.join(meta.hostRunArtifactDir, name);
      if (fs.statSync(src).isFile()) fs.copyFileSync(src, dst);
    }
  } catch {}
}

process.exit(exitCode);
`;
}

// Installs the `ap-browser-check` executable into the verifier's guardDir
// (which is already first on PATH for every role and mapped into
// `/workspace/scratch/git-guard` inside the read-only envelope).
// Returns {wrapperBin, guardDir, metaPath, preloadPath, runnerPath}.
export function installVerifierBrowserWrapper({
  guardDir,
  runDir,
  scratchDir,
  repo,
  appSession = null,
  appCfg = null,
  playwrightRuntime = null,
  brokerSocket = null,
  brokerToken = null,
  timeoutMs = 180000,
} = {}) {
  if (!guardDir) throw new Error("installVerifierBrowserWrapper requires guardDir");
  fs.mkdirSync(guardDir, {recursive: true});

  let meta;
  if (typeof brokerSocket === "string" && brokerSocket) {
    // Broker mode: keep secrets, credentials, and host joinPrefix strictly on
    // the host side inside the broker process. The sandboxed wrapper only gets
    // the private broker socket path and per-run auth token.
    meta = {
      brokerSocket,
      brokerToken: brokerToken || "",
      baseUrl: appSession?.baseUrl || null,
      port: appSession?.port || null,
      mode: appSession?.mode || null,
      scratchDir: scratchDir ? path.resolve(scratchDir) : null,
      timeoutMs,
    };
  } else {
    const secrets = resolveAppServerSecrets(appCfg, repo);
    const credNames = credentialEnvNames(secrets, appCfg);
    const credentials = {};
    for (const name of credNames) {
      if (name in secrets) {
        credentials[name] = secrets[name];
      }
    }
    const hostRunArtifactDir = runDir ? path.join(runDir, BROWSER_CHECK_DIR_NAME) : null;
    const allowHosts = Array.isArray(appSession?.allowHosts) && appSession.allowHosts.length > 0
      ? appSession.allowHosts
      : appServerAllowHosts(appCfg);
    const hasProxy = allowHosts.length > 0 && Boolean(appSession?.proxyUrl || appSession?.proxyPort);
    const proxyPort = hasProxy ? (appSession.proxyPort || null) : null;
    const proxyUrl = hasProxy ? (appSession.proxyUrl || (proxyPort ? `http://127.0.0.1:${proxyPort}` : null)) : null;

    meta = {
      baseUrl: appSession?.baseUrl || null,
      port: appSession?.port || null,
      proxyPort,
      proxyUrl,
      proxyBypassList: hasProxy ? BROWSER_PROXY_BYPASS_LIST : null,
      allowHosts,
      joinPrefix: Array.isArray(appSession?.joinPrefix) && appSession.joinPrefix.length ? appSession.joinPrefix : null,
      mode: appSession?.mode || null,
      scratchDir: scratchDir ? path.resolve(scratchDir) : null,
      hostRunArtifactDir: hostRunArtifactDir ? path.resolve(hostRunArtifactDir) : null,
      hostModuleRoot: playwrightRuntime?.module?.nodeModulesDir || null,
      hostBrowserRoot: playwrightRuntime?.browser?.root || null,
      sandboxModuleRoot: "/playwright/node_modules",
      sandboxBrowserRoot: "/ms-playwright",
      secrets,
      credentials,
      timeoutMs,
    };
  }

  const metaPath = path.join(guardDir, ".ap-browser-check.json");
  const preloadPath = path.join(guardDir, "ap-browser-preload.mjs");
  const runnerPath = path.join(guardDir, "ap-browser-check.mjs");

  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), {mode: 0o600});
  fs.writeFileSync(preloadPath, buildPreloadSource(), "utf8");
  fs.writeFileSync(runnerPath, buildWrapperRunnerSource(), {mode: 0o755});

  let wrapperBin;
  if (process.platform === "win32") {
    wrapperBin = path.join(guardDir, `${BROWSER_WRAPPER_COMMAND}.cmd`);
    fs.writeFileSync(wrapperBin, `@echo off\r\n"${process.execPath}" "%~dp0\\ap-browser-check.mjs" %*\r\nexit /b %errorlevel%\r\n`, "utf8");
  } else {
    wrapperBin = path.join(guardDir, BROWSER_WRAPPER_COMMAND);
    fs.writeFileSync(wrapperBin, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/ap-browser-check.mjs" "$@"\n`, {mode: 0o755});
    fs.chmodSync(wrapperBin, 0o755);
  }

  return {wrapperBin, guardDir, metaPath, preloadPath, runnerPath};
}

// Copies the browser-check artifacts from `<scratchDir>/browser-check/` into
// `<runDir>/browser-check/` and removes the secret-bearing `.ap-browser-check.json`
// from `guardDir` so secret values from `env_file` never remain on disk in any
// run or scratch file after the verifier finishes.
export function finalizeVerifierBrowserArtifacts({runDir, scratchDir, guardDir} = {}) {
  try {
    if (guardDir) {
      const metaPath = path.join(guardDir, ".ap-browser-check.json");
      if (fs.existsSync(metaPath)) fs.rmSync(metaPath, {force: true});
    }
  } catch {}

  const srcDir = scratchDir ? path.join(scratchDir, BROWSER_CHECK_DIR_NAME) : null;
  const dstDir = runDir ? path.join(runDir, BROWSER_CHECK_DIR_NAME) : null;
  if (!srcDir || !dstDir || !fs.existsSync(srcDir)) return null;
  if (path.resolve(srcDir) !== path.resolve(dstDir)) {
    try {
      fs.mkdirSync(dstDir, {recursive: true});
      for (const entry of fs.readdirSync(srcDir, {withFileTypes: true})) {
        if (!entry.isFile()) continue;
        fs.copyFileSync(path.join(srcDir, entry.name), path.join(dstDir, entry.name));
      }
    } catch {}
  }
  return dstDir;
}

// Direct programmatic entry point to run `ap-browser-check <script>` inside
// the verifier's read-only bubblewrap envelope (or directly when `useEnvelope`
// is false, e.g. on Native Windows or in unit tests without bwrap).
export function runVerifierBrowserCheck({
  scriptPath,
  scriptArgs = [],
  repo,
  runDir,
  scratchDir = null,
  appSession = null,
  appCfg = null,
  playwrightRuntime = null,
  config = {},
  useEnvelope = process.platform === "linux",
  timeoutMs = 180000,
} = {}) {
  const effectiveScratch = scratchDir || (runDir ? path.join(runDir, "scratch") : null);
  if (!effectiveScratch) throw new Error("runVerifierBrowserCheck requires scratchDir or runDir");
  fs.mkdirSync(effectiveScratch, {recursive: true});
  const guardDir = path.join(effectiveScratch, "git-guard");

  // When running inside the bwrap envelope, the outer command joins the
  // network namespace via buildNetworkIsolationInvocation, so the inner runner
  // does not need to re-run nsenter.
  const innerSession = useEnvelope && appSession
    ? {...appSession, joinPrefix: null}
    : appSession;

  const installed = installVerifierBrowserWrapper({
    guardDir,
    runDir,
    scratchDir: effectiveScratch,
    repo,
    appSession: innerSession,
    appCfg,
    playwrightRuntime,
    timeoutMs,
  });

  try {
    if (useEnvelope) {
      const absScript = path.resolve(repo || process.cwd(), scriptPath);
      const absScratch = fs.realpathSync(effectiveScratch);
      const absRepo = repo ? fs.realpathSync(repo) : process.cwd();
      let sandboxScript = scriptPath;
      if (absScript === absScratch || absScript.startsWith(absScratch + path.sep)) {
        sandboxScript = "/workspace/scratch/" + path.relative(absScratch, absScript).split(path.sep).join("/");
      } else if (absScript === absRepo || absScript.startsWith(absRepo + path.sep)) {
        sandboxScript = "/workspace/repository/" + path.relative(absRepo, absScript).split(path.sep).join("/");
      }
      const env = buildExecutionEnvelope({
        repo: absRepo,
        scratchDir: absScratch,
        readOnly: true,
        config,
        binary: process.execPath,
        args: ["/workspace/scratch/git-guard/ap-browser-check.mjs", sandboxScript, ...scriptArgs.map(String)],
        playwrightModuleDir: playwrightRuntime?.module?.nodeModulesDir || null,
        playwrightBrowserRoot: playwrightRuntime?.browser?.root || null,
      });
      if (!env.available) {
        return {ok: false, reason: env.reason, detail: env.detail, exitCode: 97, proof: verifyBrowserProof(runDir || effectiveScratch)};
      }
      const mapped = mapEnvironmentIntoEnvelope({PATH: `/workspace/scratch/git-guard:${process.env.PATH || "/usr/bin:/bin"}`, LANG: "C.UTF-8"}, env, absRepo, absScratch);
      let bin = env.binary;
      let args = env.args;
      if (Array.isArray(appSession?.joinPrefix) && appSession.joinPrefix.length > 0) {
        const inv = buildNetworkIsolationInvocation({binary: env.binary, args: env.args, cwd: env.cwd, joinNetworkNamespace: appSession.joinPrefix});
        if (!inv.available) {
          return {ok: false, reason: inv.reason, exitCode: 98, proof: verifyBrowserProof(runDir || effectiveScratch)};
        }
        bin = inv.binary;
        args = inv.args;
      }
      const r = spawnSync(bin, args, {cwd: env.cwd, env: mapped, encoding: "utf8", timeout: timeoutMs, shell: false});
      finalizeVerifierBrowserArtifacts({runDir, scratchDir: effectiveScratch, guardDir});
      const proof = verifyBrowserProof(runDir || effectiveScratch);
      return {ok: r.status === 0 && proof.ok, exitCode: r.status, stdout: r.stdout || "", stderr: r.stderr || "", proof};
    }

    const r = spawnSync(process.execPath, [installed.runnerPath, scriptPath, ...scriptArgs.map(String)], {
      cwd: repo || process.cwd(),
      env: {...process.env, PATH: `${guardDir}${path.delimiter}${process.env.PATH || ""}`},
      encoding: "utf8",
      timeout: timeoutMs,
      shell: false,
    });
    finalizeVerifierBrowserArtifacts({runDir, scratchDir: effectiveScratch, guardDir});
    const proof = verifyBrowserProof(runDir || effectiveScratch);
    return {ok: r.status === 0 && proof.ok, exitCode: r.status, stdout: r.stdout || "", stderr: r.stderr || "", proof};
  } finally {
    finalizeVerifierBrowserArtifacts({runDir, scratchDir: effectiveScratch, guardDir});
  }
}

function killProcessGroup(pid, signal = "SIGKILL") {
  if (!pid) return;
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch {} }
}

function isWithinHostDir(rootDir, candidate) {
  const rel = path.relative(rootDir, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function resolveBrokerSandboxScript(rawScriptPath, absRepo, absScratch) {
  const normalized = path.posix.normalize(String(rawScriptPath || ""));
  let baseHost = null;
  let baseSandbox = null;
  if (normalized.startsWith("/workspace/scratch/")) {
    baseHost = absScratch;
    baseSandbox = "/workspace/scratch";
  } else if (normalized.startsWith("/workspace/repository/")) {
    baseHost = absRepo;
    baseSandbox = "/workspace/repository";
  } else {
    return null;
  }
  const relPosix = normalized.slice(baseSandbox.length + 1);
  if (!relPosix || relPosix === "." || relPosix.startsWith("..")) return null;
  const candidate = path.resolve(baseHost, ...relPosix.split("/"));
  if (!isWithinHostDir(baseHost, candidate)) return null;
  try {
    const real = fs.realpathSync(candidate);
    if (!isWithinHostDir(baseHost, real)) return null;
    if (!fs.statSync(real).isFile()) return null;
    return {hostPath: real, sandboxPath: `${baseSandbox}/${path.relative(baseHost, real).split(path.sep).join("/")}`};
  } catch {
    return null;
  }
}

function resolveBrokerSandboxCwd(rawCwd) {
  const normalized = path.posix.normalize(String(rawCwd || ""));
  if (normalized === "/workspace/repository" || normalized.startsWith("/workspace/repository/")) return normalized;
  if (normalized === "/workspace/scratch" || normalized.startsWith("/workspace/scratch/")) return normalized;
  return "/workspace/repository";
}

function tokensEqual(a, b) {
  const ba = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function syncBrowserArtifactsToRunDir(scratchDir, runDir) {
  if (!scratchDir || !runDir) return;
  const srcDir = path.join(scratchDir, BROWSER_CHECK_DIR_NAME);
  const dstDir = path.join(runDir, BROWSER_CHECK_DIR_NAME);
  if (!fs.existsSync(srcDir) || path.resolve(srcDir) === path.resolve(dstDir)) return;
  try {
    fs.mkdirSync(dstDir, {recursive: true});
    for (const entry of fs.readdirSync(srcDir, {withFileTypes: true})) {
      if (!entry.isFile()) continue;
      fs.copyFileSync(path.join(srcDir, entry.name), path.join(dstDir, entry.name));
    }
  } catch {}
}

// Asynchronous host-side isolated runner used by startVerifierBrowserBroker():
// enters the app session's network namespace on the host (where /proc/<holder>
// is visible and userns transitions are allowed), then launches a fresh
// read-only bubblewrap envelope with the temporary runner dir ro-bound at
// /autopilot/browser-runner so secrets never live in scratchDir and the
// orchestrator event loop is never blocked.
async function runBrokeredBrowserCheck({
  sandboxScript,
  scriptArgs = [],
  sandboxCwd = "/workspace/repository",
  absRepo,
  absScratch,
  runDir,
  appSession,
  appCfg,
  playwrightRuntime,
  config,
  timeoutMs,
  activeChildren,
  onCancelRegister,
}) {
  const secrets = resolveAppServerSecrets(appCfg, absRepo);
  const innerRunnerDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-bchk-run-"));
  try { fs.chmodSync(innerRunnerDir, 0o700); } catch {}
  try {
    const innerSession = {...appSession, joinPrefix: null};
    installVerifierBrowserWrapper({
      guardDir: innerRunnerDir,
      runDir,
      scratchDir: absScratch,
      repo: absRepo,
      appSession: innerSession,
      appCfg,
      playwrightRuntime,
      timeoutMs,
    });
    const env = buildExecutionEnvelope({
      repo: absRepo,
      scratchDir: absScratch,
      readOnly: true,
      config,
      binary: process.execPath,
      args: ["/autopilot/browser-runner/ap-browser-check.mjs", sandboxScript, ...scriptArgs.map(String)],
      playwrightModuleDir: playwrightRuntime?.module?.nodeModulesDir || null,
      playwrightBrowserRoot: playwrightRuntime?.browser?.root || null,
      extraReadOnlyMounts: [{host: innerRunnerDir, sandbox: "/autopilot/browser-runner"}],
    });
    if (!env.available) {
      return {exitCode: 97, stdout: "", stderr: `ap-browser-check: execution envelope unavailable (${env.reason || "unknown"})\n`, error: null};
    }
    const mapped = mapEnvironmentIntoEnvelope(
      {PATH: `/workspace/scratch/git-guard:${process.env.PATH || "/usr/bin:/bin"}`, LANG: "C.UTF-8"},
      env,
      absRepo,
      absScratch
    );
    mapped.AUTOPILOT_BROWSER_SCRIPT_CWD = sandboxCwd;

    let bin = env.binary;
    let args = env.args;
    if (appSession?.mode !== "host") {
      if (!Array.isArray(appSession?.joinPrefix) || appSession.joinPrefix.length === 0) {
        return {exitCode: 98, stdout: "", stderr: "ap-browser-check: isolated network namespace is required but unavailable\n", error: null};
      }
      const inv = buildNetworkIsolationInvocation({
        binary: env.binary,
        args: env.args,
        cwd: env.cwd,
        joinNetworkNamespace: appSession.joinPrefix,
      });
      if (!inv.available) {
        return {exitCode: 98, stdout: "", stderr: `ap-browser-check: network namespace join unavailable (${inv.reason || "unknown"})\n`, error: null};
      }
      bin = inv.binary;
      args = inv.args;
    }

    const res = await new Promise((resolve) => {
      let settled = false;
      let timer = null;
      let child = null;
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const done = (exitCode, errMsg = null) => {
        if (settled) return;
        settled = true;
        if (timer) { clearTimeout(timer); timer = null; }
        if (child?.pid) activeChildren.delete(child.pid);
        onCancelRegister?.(null);
        resolve({
          exitCode: typeof exitCode === "number" ? exitCode : 1,
          stdout: maskSecrets(stdout, secrets),
          stderr: maskSecrets(stderr, secrets),
          error: errMsg ? maskSecrets(errMsg, secrets) : (timedOut ? "browser check timed out" : null),
        });
      };
      try {
        child = spawn(bin, args, {
          cwd: env.cwd,
          env: mapped,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
        });
      } catch (e) {
        done(1, e?.message || String(e));
        return;
      }
      if (child.pid) activeChildren.add(child.pid);
      const maxBuf = 16 * 1024 * 1024;
      const append = (cur, chunk) => {
        const next = cur + chunk.toString("utf8");
        return next.length > maxBuf ? next.slice(-maxBuf) : next;
      };
      child.stdout.on("data", (d) => { stdout = append(stdout, d); });
      child.stderr.on("data", (d) => { stderr = append(stderr, d); });
      const killChild = () => { if (child?.pid) killProcessGroup(child.pid, "SIGKILL"); };
      onCancelRegister?.(killChild);
      timer = setTimeout(() => {
        timedOut = true;
        killChild();
      }, Number(timeoutMs) > 0 ? Number(timeoutMs) : 180000);
      child.once("error", (e) => done(1, e?.message || String(e)));
      child.once("close", (code) => done(code));
    });
    syncBrowserArtifactsToRunDir(absScratch, runDir);
    return res;
  } finally {
    onCancelRegister?.(null);
    try { fs.rmSync(innerRunnerDir, {recursive: true, force: true}); } catch {}
  }
}

// Host-side Unix-socket broker for an enveloped verifier agent.
// Inside the verifier's bubblewrap envelope (`--unshare-all --share-net`),
// `/proc` only contains the envelope's own PID namespace and the user namespace
// is a sibling of the holder's `unshare -Urn`, so `nsenter -t <holderPid>` can
// never succeed from inside bwrap. Binding a single private Unix domain socket
// into the verifier's envelope lets `ap-browser-check` ask the host orchestrator
// to run the script inside `nsenter <netns> -- bwrap --ro-bind <repo> ...`,
// preserving closed-network isolation, allow_hosts CONNECT proxy rules,
// read-only repository containment, secret isolation, and proof recording.
export async function startVerifierBrowserBroker({
  repo,
  runDir = null,
  scratchDir,
  getAppSession,
  ensureAppSession = null,
  appCfg = null,
  playwrightRuntime = null,
  config = {},
  timeoutMs = 180000,
  log = () => {},
} = {}) {
  if (!repo || !scratchDir) throw new Error("startVerifierBrowserBroker requires repo and scratchDir");
  const absRepo = fs.realpathSync(path.resolve(repo));
  const absScratch = fs.realpathSync(path.resolve(scratchDir));
  const sockDir = makeSocketDir("ap-bchk-");
  try { fs.chmodSync(sockDir, 0o700); } catch {}
  const socketPath = path.join(sockDir, "b.sock");
  const token = crypto.randomBytes(32).toString("hex");
  const activeChildren = new Set();
  let closed = false;
  let unregister = () => {};

  const server = net.createServer((conn) => {
    let buf = "";
    let handled = false;
    let cancelActive = null;
    const clearCancel = ({invoke = false} = {}) => {
      if (!cancelActive) return;
      const fn = cancelActive;
      cancelActive = null;
      if (invoke) { try { fn(); } catch {} }
    };
    const send = (obj) => {
      try { conn.end(JSON.stringify(obj) + "\n"); } catch { try { conn.destroy(); } catch {} }
    };
    const maskBrokerFailure = (err) => {
      let secrets = {};
      try { secrets = resolveAppServerSecrets(appCfg, absRepo); } catch {}
      const raw = err?.message ? String(err.message) : String(err || "broker execution failed");
      return maskSecrets(raw, secrets);
    };
    const handleAuthenticatedRequest = async (req) => {
      try {
        const resolved = resolveBrokerSandboxScript(req.resolvedScript, absRepo, absScratch);
        if (!resolved) {
          send({exitCode: 2, stdout: "", stderr: `ap-browser-check: script not found: ${String(req.scriptArg || "")}\n`, error: null});
          return;
        }
        const sandboxCwd = resolveBrokerSandboxCwd(req.cwd);
        const scriptArgs = Array.isArray(req.scriptRestArgs) ? req.scriptRestArgs.map(String) : [];

        let session = typeof getAppSession === "function" ? getAppSession() : null;
        if (!session || session.alive?.() === false) {
          if (typeof ensureAppSession === "function") {
            log("[app-server] verifier namespace session is stale before ap-browser-check; starting a fresh app session");
            try { session = await ensureAppSession(); } catch { session = null; }
          }
        }
        if (!session || session.alive?.() === false) {
          send({exitCode: 1, stdout: "", stderr: "ap-browser-check: app server network namespace is not running\n", error: null});
          return;
        }
        if (conn.destroyed) return;

        const res = await runBrokeredBrowserCheck({
          sandboxScript: resolved.sandboxPath,
          scriptArgs,
          sandboxCwd,
          absRepo,
          absScratch,
          runDir,
          appSession: session,
          appCfg,
          playwrightRuntime,
          config,
          timeoutMs,
          activeChildren,
          onCancelRegister: (fn) => { cancelActive = fn; },
        });
        send(res);
      } catch (err) {
        clearCancel({invoke: true});
        send({exitCode: 1, stdout: "", stderr: "", error: maskBrokerFailure(err)});
      } finally {
        clearCancel({invoke: false});
      }
    };
    conn.on("close", () => clearCancel({invoke: true}));
    conn.on("error", () => clearCancel({invoke: true}));
    conn.on("data", (chunk) => {
      if (handled) return;
      buf += chunk.toString("utf8");
      if (buf.length > 65536) {
        handled = true;
        send({exitCode: 2, stdout: "", stderr: "ap-browser-check: broker request too large\n", error: null});
        return;
      }
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      handled = true;
      let req;
      try {
        req = JSON.parse(buf.slice(0, nl));
      } catch {
        send({exitCode: 2, stdout: "", stderr: "ap-browser-check: malformed broker request\n", error: null});
        return;
      }
      if (!req || typeof req !== "object" || !tokensEqual(req.token, token)) {
        send({exitCode: 2, stdout: "", stderr: "ap-browser-check: unauthorized broker request\n", error: null});
        return;
      }
      void handleAuthenticatedRequest(req);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  try { fs.chmodSync(socketPath, 0o600); } catch {}
  server.unref();

  const closeSync = () => {
    if (closed) return;
    closed = true;
    unregister();
    for (const pid of [...activeChildren]) killProcessGroup(pid, "SIGKILL");
    activeChildren.clear();
    try { server.close(); } catch {}
    try { fs.rmSync(sockDir, {recursive: true, force: true}); } catch {}
  };
  unregister = registerAppCleanup(closeSync);

  return {
    socketPath,
    sandboxSocketPath: BROWSER_BROKER_SANDBOX_SOCKET,
    token,
    close: closeSync,
  };
}

function isValidPngFile(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size <= PNG_MAGIC.length) return false;
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(PNG_MAGIC.length);
      const read = fs.readSync(fd, buf, 0, PNG_MAGIC.length, 0);
      return read === PNG_MAGIC.length && buf.equals(PNG_MAGIC);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function isNonEmptyFile(filePath, magic = null) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size === 0) return false;
    if (!magic) return true;
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(magic.length);
      const read = fs.readSync(fd, buf, 0, magic.length, 0);
      return read === magic.length && buf.equals(magic);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

// Verifies the REQUIRED proof rule for a verifier run directory:
//   - browser-check/evidence.json exists and was written by ap-browser-check
//   - exitCode === 0 and output was recorded (outputFile exists or outputTail is string)
//   - the verifier's script copy exists and is non-empty
//   - at least one valid PNG screenshot exists in browser-check/
// Also reports whether trace (.zip) and video (.webm/.mp4) files are present.
export function verifyBrowserProof(runDir) {
  const empty = {
    ok: false,
    ran: false,
    reason: "no_wrapper_evidence",
    artifactDir: null,
    exitCode: null,
    script: null,
    screenshots: [],
    traces: [],
    videos: [],
    output: null,
  };
  if (typeof runDir !== "string" || !runDir) return empty;

  // Check `<runDir>/browser-check` first, then `<runDir>/scratch/browser-check`
  const candidates = [
    path.join(runDir, BROWSER_CHECK_DIR_NAME),
    path.join(runDir, "scratch", BROWSER_CHECK_DIR_NAME),
  ];
  const artifactDir = candidates.find((d) => fs.existsSync(path.join(d, BROWSER_EVIDENCE_FILE))) || null;
  if (!artifactDir) return empty;

  let evidence;
  try {
    evidence = JSON.parse(fs.readFileSync(path.join(artifactDir, BROWSER_EVIDENCE_FILE), "utf8"));
  } catch {
    return {...empty, artifactDir, reason: "invalid_evidence_json"};
  }
  if (!evidence || typeof evidence !== "object" || evidence.command !== BROWSER_WRAPPER_COMMAND) {
    return {...empty, artifactDir, reason: "invalid_evidence_command"};
  }

  const exitCode = typeof evidence.exitCode === "number" ? evidence.exitCode : null;
  const savedScript = typeof evidence.savedScript === "string" && evidence.savedScript
    ? path.join(artifactDir, path.basename(evidence.savedScript))
    : null;
  const scriptOk = Boolean(savedScript && isNonEmptyFile(savedScript));

  const outputFile = typeof evidence.outputFile === "string" && evidence.outputFile
    ? path.join(artifactDir, path.basename(evidence.outputFile))
    : null;
  const outputRecorded = Boolean((outputFile && fs.existsSync(outputFile)) || typeof evidence.outputTail === "string");
  let outputText = typeof evidence.outputTail === "string" ? evidence.outputTail : null;
  if (outputFile && fs.existsSync(outputFile)) {
    try { outputText = fs.readFileSync(outputFile, "utf8"); } catch {}
  }

  let files = [];
  try { files = fs.readdirSync(artifactDir); } catch {}
  const screenshots = files.filter((f) => f.toLowerCase().endsWith(".png") && isValidPngFile(path.join(artifactDir, f))).sort();
  const traces = files.filter((f) => f.toLowerCase().endsWith(".zip") && isNonEmptyFile(path.join(artifactDir, f), ZIP_MAGIC)).sort();
  const videos = files.filter((f) => /\.(webm|mp4)$/i.test(f) && isNonEmptyFile(path.join(artifactDir, f))).sort();

  const ran = exitCode !== null && outputRecorded;
  if (!ran) {
    return {ok: false, ran: false, reason: "exit_or_output_missing", artifactDir, exitCode, script: scriptOk ? path.basename(savedScript) : null, screenshots, traces, videos, output: outputText};
  }
  if (exitCode !== 0) {
    return {ok: false, ran: true, reason: `wrapper_exit_${exitCode}`, artifactDir, exitCode, script: scriptOk ? path.basename(savedScript) : null, screenshots, traces, videos, output: outputText};
  }
  if (!scriptOk) {
    return {ok: false, ran: true, reason: "saved_script_missing", artifactDir, exitCode, script: null, screenshots, traces, videos, output: outputText};
  }
  if (screenshots.length === 0) {
    return {ok: false, ran: true, reason: "screenshot_missing", artifactDir, exitCode, script: path.basename(savedScript), screenshots, traces, videos, output: outputText};
  }

  return {
    ok: true,
    ran: true,
    reason: null,
    artifactDir,
    exitCode,
    script: path.basename(savedScript),
    screenshots,
    traces,
    videos,
    output: outputText,
  };
}

// Enforces the REQUIRED proof rule on a completed verifier result (`vv`):
//   - Only applies when the phase requires a browser check (`taskFacts.browser`
//     or `taskFacts.playwright`) OR when the wrapper actually ran in this run.
//   - If the verifier returned PASS and valid wrapper proof exists (`proof.ok
//     === true`), `browserProofAccepted: true` is stamped on `vv` and the
//     browser check is accepted as a proven browser PASS.
//   - If the phase required a browser check and the verifier returned PASS
//     WITHOUT valid wrapper proof, `browserProofAccepted: false` is stamped on
//     `vv` and the browser check is downgraded to a manual check (never counted
//     as a proven browser PASS): if the verifier did not already emit a
//     `BROWSER CHECK NOT POSSIBLE:` note, one is synthesized and added to
//     `vv.review.notes` so the orchestrator records it in `MANUAL-CHECKS.md`.
export function evaluateVerifierBrowserOutcome({vv, runDir, taskFacts = {}, phaseName = "phase"} = {}) {
  const needsBrowser = taskFacts?.browser === true || taskFacts?.playwright === true;
  const proof = verifyBrowserProof(runDir);
  if (!vv || typeof vv !== "object") {
    return {needsBrowser, proof, browserProofAccepted: false, manualNotesAdded: []};
  }

  if (proof.ok) {
    vv.browserProof = {
      accepted: true,
      exitCode: proof.exitCode,
      script: proof.script,
      screenshots: proof.screenshots,
      traces: proof.traces,
      videos: proof.videos,
    };
    vv.browserProofAccepted = true;
    return {needsBrowser, proof, browserProofAccepted: true, manualNotesAdded: []};
  }

  if (!needsBrowser && !proof.ran) {
    return {needsBrowser: false, proof, browserProofAccepted: null, manualNotesAdded: []};
  }

  vv.browserProof = {
    accepted: false,
    reason: proof.reason,
    exitCode: proof.exitCode,
    script: proof.script,
    screenshots: proof.screenshots,
    traces: proof.traces,
    videos: proof.videos,
  };
  vv.browserProofAccepted = false;

  const manualNotesAdded = [];
  if (vv.review && vv.review.decision === "PASS") {
    const existingNotes = browserCheckNotes(vv.review);
    if (existingNotes.length === 0) {
      const note = `${BROWSER_CHECK_NOTE_PREFIX} ${phaseName} — browser PASS was not proven by ${BROWSER_WRAPPER_COMMAND} (${proof.reason}); counted as a manual check.`;
      vv.review.notes = Array.isArray(vv.review.notes) ? [...vv.review.notes, note] : [note];
      if (vv.verdict && typeof vv.verdict === "object") {
        vv.verdict.notes = Array.isArray(vv.verdict.notes) ? [...vv.verdict.notes, note] : [note];
      }
      manualNotesAdded.push(note);
    }
  }

  return {needsBrowser, proof, browserProofAccepted: false, manualNotesAdded};
}

// Backlog s15 #6: detect UI route/page files in a phase delta so the
// orchestrator can refuse a verifier PASS that skipped ap-browser-check while
// the app server was up. Non-route components (e.g. components/Button.tsx) and
// test/API files return no routes.
const UI_TEST_OR_IGNORED_PATH_RE = /(?:^|\/)(?:__tests__|tests?|e2e|playwright-report|coverage|dist|build|\.next)\/|\.(?:test|spec)\.[a-z0-9]+$/i;
const UI_API_PATH_RE = /(?:^|\/)api\//i;

export function extractUiRoutesFromDelta(deltaPaths) {
  if (!Array.isArray(deltaPaths) || !deltaPaths.length) return [];
  const routes = new Set();

  const normalizeRoute = (raw) => {
    const cleaned = String(raw || "")
      .split("/")
      .filter((seg) => {
        if (!seg) return false;
        // Strip Next.js route groups like (admin), (auth) and locale segment [locale]
        if (/^\([^)]+\)$/.test(seg)) return false;
        if (/^\[(?:locale|lang)\]$/.test(seg)) return false;
        return true;
      })
      .join("/");
    return `/${cleaned}`;
  };

  for (const rawPath of deltaPaths) {
    const p = String(rawPath || "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
    if (!p || UI_TEST_OR_IGNORED_PATH_RE.test(p) || UI_API_PATH_RE.test(p)) continue;

    // Next.js App Router: .../app/<route>/page.(tsx|jsx|ts|js|mdx)
    const appRouterMatch = p.match(/(?:^|\/)app\/(?:(.*)\/)?page\.(?:tsx|jsx|ts|js|mdx)$/i);
    if (appRouterMatch) {
      routes.add(normalizeRoute(appRouterMatch[1] || ""));
      continue;
    }

    // Next.js / Nuxt Pages Router: .../pages/<route>.(tsx|jsx|vue) (exclude _app, _document, _error)
    const pagesRouterMatch = p.match(/(?:^|\/)pages\/(.+)\.(?:tsx|jsx|vue)$/i);
    if (pagesRouterMatch) {
      const rel = pagesRouterMatch[1];
      const base = rel.split("/").pop() || "";
      if (/^_/.test(base)) continue;
      const withoutIndex = rel.replace(/(?:^|\/)index$/i, "");
      routes.add(normalizeRoute(withoutIndex));
      continue;
    }

    // SvelteKit / Remix / generic routes dir: .../routes/<route>/+page.svelte or .../routes/<route>.(tsx|jsx|svelte|vue)
    const routesDirMatch = p.match(/(?:^|\/)routes\/(.+?)(?:\/\+page)?\.(?:svelte|tsx|jsx|vue)$/i);
    if (routesDirMatch) {
      const rel = routesDirMatch[1].replace(/(?:^|\/)(?:index|\+page)$/i, "");
      if (/^_/.test(rel.split("/").pop() || "")) continue;
      routes.add(normalizeRoute(rel));
      continue;
    }

    // Static HTML pages
    if (/\.html?$/i.test(p)) {
      const rel = p.replace(/(?:^|\/)index\.html?$/i, "").replace(/\.html?$/i, "");
      routes.add(normalizeRoute(rel));
    }
  }

  return [...routes].sort();
}

export function buildBrowserCheckRetryBrief(routes) {
  const list = Array.isArray(routes) && routes.length ? routes.join(", ") : "/";
  return [
    `BROWSER CHECK REQUIRED (RETRY): Your previous PASS did not run \`${BROWSER_WRAPPER_COMMAND}\`, although the app server is running and this phase delta touches UI route(s): ${list}.`,
    `Run \`${BROWSER_WRAPPER_COMMAND}\` on ${list} before deciding.`,
    `A "${BROWSER_CHECK_NOTE_PREFIX}" note is accepted only with real failure output from \`${BROWSER_WRAPPER_COMMAND}\` (not when no attempt was made).`,
  ].join("\n");
}

// Backlog s15 #6: refuse a verifier PASS once when the phase delta touches UI
// routes, tests.app_server is started, Playwright is available, and
// ap-browser-check was never run in that session. Real wrapper failures
// (proof.ran === true) are accepted without retry.
export function shouldRefuseVerifierPassForBrowserCheck({
  vv,
  runDir = null,
  deltaPaths = [],
  appServerStarted = false,
  playwrightAvailable = true,
  alreadyRetried = false,
} = {}) {
  if (!vv || vv.status !== "completed" || vv.review?.decision !== "PASS") {
    return {refuse: false, reason: "not_pass", routes: [], retryBrief: ""};
  }
  if (!appServerStarted || !playwrightAvailable) {
    return {refuse: false, reason: "browser_env_unavailable", routes: [], retryBrief: ""};
  }
  if (alreadyRetried) {
    return {refuse: false, reason: "already_retried", routes: [], retryBrief: ""};
  }
  const routes = extractUiRoutesFromDelta(deltaPaths);
  if (!routes.length) {
    return {refuse: false, reason: "non_ui_delta", routes: [], retryBrief: ""};
  }
  const proof = verifyBrowserProof(runDir);
  if (proof.ok) {
    return {refuse: false, reason: "browser_proof_ok", routes, proof, retryBrief: ""};
  }
  if (proof.ran) {
    return {refuse: false, reason: "wrapper_ran_with_output", routes, proof, retryBrief: ""};
  }
  return {
    refuse: true,
    reason: "no_browser_check_run",
    routes,
    proof,
    retryBrief: buildBrowserCheckRetryBrief(routes),
  };
}
