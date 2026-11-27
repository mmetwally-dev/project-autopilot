#!/usr/bin/env node
// Backlog #7: approved verifier browser command (ap-browser-check), the
// REQUIRED proof rule, verifier brief when the app server is up, secret
// masking, setup Playwright/Chromium status messages, and browser artifact
// retention in mission-scratch-cleanup.mjs.
//
// Calls the real exported functions (never re-implements logic inside the test)
// and drives real verifier runs / missions with fake adapters and the #3/#4
// fixture server (scripts/test-fixtures/fake-app-server.mjs).
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {spawn, spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {
  BROWSER_WRAPPER_COMMAND,
  BROWSER_CHECK_DIR_NAME,
  BROWSER_EVIDENCE_FILE,
  BROWSER_PROXY_BYPASS_LIST,
  BROWSER_BROKER_SANDBOX_SOCKET,
  resolveAppServerSecrets,
  credentialEnvNames,
  verifierBrowserBrief,
  installVerifierBrowserWrapper,
  finalizeVerifierBrowserArtifacts,
  runVerifierBrowserCheck,
  startVerifierBrowserBroker,
  verifyBrowserProof,
  evaluateVerifierBrowserOutcome,
} from "./verifier-browser.mjs";
import {verifierTask} from "./verifier-brief.mjs";
import {formatPlaywrightStatusBlock} from "./playwright-status-block.mjs";
import {discoverPlaywrightRuntime} from "./playwright-runtime.mjs";
import {
  BROWSER_MEDIA_RETENTION_MS,
  cleanBrowserArtifacts,
  cleanAllMissionsBrowserArtifacts,
  cleanMissionScratch,
} from "./mission-scratch-cleanup.mjs";
import {startAppServer} from "./app-server.mjs";
import {startAppSession, verifierAppNote, startAllowlistProxy, makeSocketDir} from "./app-net.mjs";
import {buildExecutionEnvelope, mapEnvironmentIntoEnvelope} from "./execution-envelope.mjs";
import {networkIsolationPrefix} from "./shell-guard.mjs";
import {relayVerifierWithAppForTests} from "./autopilot.mjs";
import {appendManualChecks} from "./manual-checks.mjs";
import {browserCheckNotes, filterUnrecordedManualChecks} from "./task-requirements.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRootDir = path.resolve(here, "..");
const FIXTURE_SERVER = path.join(here, "test-fixtures", "fake-app-server.mjs");
const SECRET_MARKER = "s3cr3t-BROWSER-PW-98a7c6d5";

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

function filesUnder(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

// Valid 1x1 PNG and minimal ZIP bytes used by the mock Playwright package in
// pure/sandbox-safe tests (the real Chromium inside bwrap + netns test is in
// section 7 below and runs whenever bwrap + unshare + Chromium are usable).
const VALID_PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex"
);
const VALID_ZIP_BYTES = Buffer.from(
  "504b0506000000000000000000000000000000000000",
  "hex"
);
const VALID_WEBM_BYTES = Buffer.from("1a45dfa3934282886d6174726f736b61", "hex");

// Builds a fake `playwright` npm package in `<dir>/node_modules/playwright`
// whose `chromium.launch()` exercises the real ap-browser-check preload
// hooks (launch options, newContext recordVideo, tracing.start/stop,
// page.goto, page.screenshot) without spawning the Chromium binary.
function installStubPlaywrightModule(rootDir) {
  const nmDir = path.join(rootDir, "node_modules");
  const pwDir = path.join(nmDir, "playwright");
  fs.mkdirSync(pwDir, {recursive: true});
  fs.writeFileSync(path.join(pwDir, "package.json"), JSON.stringify({name: "playwright", version: "1.60.0", main: "index.js"}, null, 2));
  const pngHex = VALID_PNG_BYTES.toString("hex");
  const zipHex = VALID_ZIP_BYTES.toString("hex");
  const webmHex = VALID_WEBM_BYTES.toString("hex");
  fs.writeFileSync(path.join(pwDir, "index.js"), `
const fs = require("node:fs");
const path = require("node:path");
const PNG = Buffer.from(${JSON.stringify(pngHex)}, "hex");
const ZIP = Buffer.from(${JSON.stringify(zipHex)}, "hex");
const WEBM = Buffer.from(${JSON.stringify(webmHex)}, "hex");

const chromium = {
  async launch(opts = {}) {
    const launchOpts = opts;
    return {
      launchOpts,
      async newContext(ctxOpts = {}) {
        const videoDir = ctxOpts?.recordVideo?.dir || null;
        if (videoDir) {
          fs.mkdirSync(videoDir, {recursive: true});
          fs.writeFileSync(path.join(videoDir, "rec-1.webm"), WEBM);
        }
        return {
          tracing: {
            async start() {},
            async stop(stopOpts = {}) {
              if (stopOpts?.path) {
                fs.mkdirSync(path.dirname(stopOpts.path), {recursive: true});
                fs.writeFileSync(stopOpts.path, ZIP);
              }
            }
          },
          async newPage() {
            let currentUrl = "about:blank";
            return {
              async goto(url) {
                currentUrl = url;
                if (url.startsWith("http://") || url.startsWith("https://")) {
                  const res = await fetch(url);
                  return {status: () => res.status, url: () => currentUrl};
                }
                return {status: () => 200, url: () => currentUrl};
              },
              url: () => currentUrl,
              async title() { return "Stub Page Title"; },
              async screenshot(shotOpts = {}) {
                if (shotOpts?.path) {
                  fs.mkdirSync(path.dirname(shotOpts.path), {recursive: true});
                  fs.writeFileSync(shotOpts.path, PNG);
                }
                return PNG;
              },
              isClosed: () => false,
              async close() {}
            };
          },
          async close() {}
        };
      },
      async close() {}
    };
  }
};
module.exports = {chromium, default: {chromium}};
`);
  const browserRoot = path.join(nmDir, "playwright-core", ".local-browsers");
  const exeDir = path.join(browserRoot, "chromium-1223", process.platform === "win32" ? "chrome-win" : "chrome-linux");
  fs.mkdirSync(exeDir, {recursive: true});
  const exePath = path.join(exeDir, process.platform === "win32" ? "chrome.exe" : "chrome");
  fs.writeFileSync(exePath, "#!/bin/sh\nexit 0\n", {mode: 0o755});
  try { fs.chmodSync(exePath, 0o755); } catch {}
  return discoverPlaywrightRuntime({repository: rootDir});
}

// --- 1. Wrapper command + artifacts + secret masking -----------------------
console.log("1. ap-browser-check wrapper produces script, screenshot, trace and video in the run dir and masks secrets");
{
  const repo = tmp("ap-b7-repo-");
  spawnSync("git", ["init", "-q", repo]);
  const NON_CRED_SECRET = "s3cr3t-SERVICE-ROLE-KEY-987654";
  const envFileText = [
    "# test credentials for app_server",
    `E2E_SUPER_ADMIN_EMAIL="admin@clinixhub.test"`,
    `E2E_SUPER_ADMIN_PASSWORD="${SECRET_MARKER}"`,
    `E2E_DOCTOR_PASSWORD="s3cr3t-DOCTOR-PW-1234abcd"`,
    `NEXT_PUBLIC_SUPABASE_URL="https://project.supabase.co"`,
    `SUPABASE_SERVICE_ROLE_KEY="${NON_CRED_SECRET}"`,
    `POWERSYNC_URL="https://sync.powersync.journeyapps.com"`,
  ].join("\n") + "\n";
  fs.writeFileSync(path.join(repo, ".env.test"), envFileText);

  const pwRuntime = installStubPlaywrightModule(repo);
  check("discoverPlaywrightRuntime finds the installed module and browser", pwRuntime.readyForLaunchProbe === true, pwRuntime);

  const appCfg = {
    start_command: `node ${JSON.stringify(FIXTURE_SERVER)}`,
    port: "auto",
    ready_url: "/ready",
    warmup_urls: ["/ar/login"],
    ready_timeout_ms: 15000,
    env_file: ".env.test",
    env: {FIXTURE_DELAY_MS: "100"},
  };

  const started = await startAppServer({cfg: appCfg, repo});
  check("fixture app server started", started.ok === true, started);
  const server = started.server;

  const runDir = tmp("ap-b7-rundir-");
  const scratchDir = path.join(runDir, "scratch");
  fs.mkdirSync(scratchDir, {recursive: true});

  // Verifier writes a Playwright script in its OWN scratch dir.
  // The script checks APP_BASE_URL, verifies the secret env var arrived inside
  // the wrapper (and deliberately prints it to stdout to prove the wrapper masks
  // it before writing output.log / evidence.json / console), and visits 2 pages.
  const nonCredB64 = Buffer.from(NON_CRED_SECRET).toString("base64");
  const verifierScript = path.join(scratchDir, "verify-login.mjs");
  fs.writeFileSync(verifierScript, `
import {createRequire} from "node:module";
const req = createRequire(process.env.AUTOPILOT_PLAYWRIGHT_MODULE_ROOT + "/noop.js");
const {chromium} = req("playwright");

const base = process.env.APP_BASE_URL;
if (!base) throw new Error("APP_BASE_URL missing");
const email = process.env.E2E_SUPER_ADMIN_EMAIL;
const pass = process.env.E2E_SUPER_ADMIN_PASSWORD;
const docPass = process.env.E2E_DOCTOR_PASSWORD;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
console.log("checking login at", base, "with email", email, "and secret", pass);
console.log("child env has docPass:", Boolean(docPass));
console.log("child env supabaseKey is undefined:", supabaseKey === undefined);
console.log("printed non-cred secret:", Buffer.from("${nonCredB64}", "base64").toString("utf8"));

const browser = await chromium.launch();
if (!browser.launchOpts?.args?.includes("--no-sandbox") || browser.launchOpts?.headless !== true) {
  throw new Error("preload did not enforce headless --no-sandbox: " + JSON.stringify(browser.launchOpts));
}
const ctx = await browser.newContext();
const page = await ctx.newPage();
const r1 = await page.goto(base + "/ar/login");
console.log("page 1 status", r1.status());
await page.screenshot({path: "page-login.png", fullPage: true});
const r2 = await page.goto(base + "/ar/dashboard");
console.log("page 2 status", r2.status());
await page.screenshot({path: "page-dashboard.png", fullPage: true});
await ctx.close();
await browser.close();
`);

  const res = runVerifierBrowserCheck({
    scriptPath: verifierScript,
    repo,
    runDir,
    scratchDir,
    appSession: {baseUrl: server.baseUrl, port: server.port, mode: "host", joinPrefix: null},
    appCfg,
    playwrightRuntime: pwRuntime,
    useEnvelope: false,
  });

  await server.stop();

  check("wrapper exited 0 and proof is valid", res.ok === true && res.exitCode === 0, res);
  const proof = verifyBrowserProof(runDir);
  check("verifyBrowserProof accepts the run dir", proof.ok === true && proof.ran === true && proof.exitCode === 0, proof);
  check("saved verifier script exists in <runDir>/browser-check/", proof.script === "script-verify-login.mjs" && fs.existsSync(path.join(runDir, BROWSER_CHECK_DIR_NAME, proof.script)), proof);
  check("screenshots saved in <runDir>/browser-check/ (at least 2 PNGs)", proof.screenshots.length >= 2, proof.screenshots);
  check("Playwright trace zip saved in <runDir>/browser-check/", proof.traces.includes("trace.zip"), proof.traces);
  check("video webm saved in <runDir>/browser-check/", proof.videos.includes("video.webm"), proof.videos);
  check("recorded output shows page statuses", /page 1 status 200/.test(proof.output || "") && /page 2 status 200/.test(proof.output || ""), proof.output);

  // Secret check: SECRET_MARKER and NON_CRED_SECRET must NEVER appear in stdout, stderr, output.log,
  // evidence.json, or any file in runDir/scratchDir.
  check("wrapper child env contains only credential values, not SUPABASE_SERVICE_ROLE_KEY",
    /child env has docPass: true/.test(proof.output || "") && /child env supabaseKey is undefined: true/.test(proof.output || ""), proof.output);
  check("wrapper masked the credential secret value by its variable NAME in output", (proof.output || "").includes("<E2E_SUPER_ADMIN_PASSWORD>") && !(proof.output || "").includes(SECRET_MARKER), proof.output);
  check("wrapper masked non-credential secret value printed by the script as <SUPABASE_SERVICE_ROLE_KEY>",
    (proof.output || "").includes("<SUPABASE_SERVICE_ROLE_KEY>") && !(proof.output || "").includes(NON_CRED_SECRET), proof.output);
  check("wrapper stdout/stderr never contained raw secret values",
    !res.stdout.includes(SECRET_MARKER) && !res.stderr.includes(SECRET_MARKER)
    && !res.stdout.includes(NON_CRED_SECRET) && !res.stderr.includes(NON_CRED_SECRET));
  const leakedFiles = filesUnder(runDir).filter((f) => {
    const txt = fs.readFileSync(f, "utf8");
    return txt.includes(SECRET_MARKER) || txt.includes(NON_CRED_SECRET);
  });
  check("secret markers never appear in any file under the run dir (including git-guard and browser-check)", leakedFiles.length === 0, leakedFiles);
  check("temporary .ap-browser-check.json holding secrets was removed after the run", !fs.existsSync(path.join(scratchDir, "git-guard", ".ap-browser-check.json")));
}

// --- 1b. Preload Module._resolveFilename re-entrancy / non-recursion test ---
console.log("1b. ap-browser-preload.mjs resolves playwright via Module._resolveFilename hook without infinite recursion");
{
  // Place the fake playwright package in a directory that is NOT an ancestor of
  // the user script, so Node's normal node_modules walk from the script's dir
  // cannot find it and resolution MUST go through the preload's
  // Module._resolveFilename / Module.register hooks against
  // AUTOPILOT_PLAYWRIGHT_MODULE_ROOT.
  const isolatedPkgRoot = tmp("ap-b7-preload-pkg-");
  const isolatedPwRuntime = installStubPlaywrightModule(isolatedPkgRoot);
  const isolatedNm = isolatedPwRuntime.module.nodeModulesDir;

  const preloadGuardDir = tmp("ap-b7-preload-guard-");
  const preloadArtDir = tmp("ap-b7-preload-art-");
  const {preloadPath} = installVerifierBrowserWrapper({
    guardDir: preloadGuardDir,
    runDir: preloadArtDir,
    scratchDir: preloadArtDir,
    repo: isolatedPkgRoot,
    playwrightRuntime: isolatedPwRuntime,
  });

  // 1) Test CJS require / createRequire(MODULE_ROOT + "/")("playwright") and
  // createRequire(import.meta.url)("playwright") from an unrelated directory,
  // wrapping Module._resolveFilename to count recursion depth and assert maxDepth <= 2.
  const outsideScriptDir = tmp("ap-b7-preload-outside-");
  const cjsReentrancyScript = path.join(outsideScriptDir, "reentrancy-cjs.mjs");
  fs.writeFileSync(cjsReentrancyScript, `
import Module, {createRequire} from "node:module";

let activeDepth = 0;
let maxDepth = 0;
let totalCalls = 0;
const hookedResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, isMain, options) {
  if (request === "playwright" || request === "playwright-core" || request === "@playwright/test") {
    activeDepth += 1;
    totalCalls += 1;
    if (activeDepth > maxDepth) maxDepth = activeDepth;
    if (activeDepth > 5) {
      activeDepth -= 1;
      throw new Error("Infinite recursion detected in Module._resolveFilename hook (depth=" + activeDepth + ")");
    }
    try {
      return hookedResolve.call(this, request, parent, isMain, options);
    } finally {
      activeDepth -= 1;
    }
  }
  return hookedResolve.call(this, request, parent, isMain, options);
};

// Case A: createRequire(AUTOPILOT_PLAYWRIGHT_MODULE_ROOT + "/")("playwright")
const reqFromRootSlash = createRequire(process.env.AUTOPILOT_PLAYWRIGHT_MODULE_ROOT + "/");
const pw1 = reqFromRootSlash("playwright");
if (!pw1 || typeof pw1.chromium?.launch !== "function") {
  throw new Error("Failed to load playwright via createRequire(MODULE_ROOT + '/')");
}

// Case B: createRequire(import.meta.url)("playwright") from a directory with NO node_modules
const reqFromOutside = createRequire(import.meta.url);
const pw2 = reqFromOutside("playwright");
if (!pw2 || typeof pw2.chromium?.launch !== "function") {
  throw new Error("Failed to load playwright via createRequire(import.meta.url) outside node_modules");
}

console.log(JSON.stringify({ok: true, maxDepth, totalCalls, patched: Boolean(pw1.chromium.__apPatched)}));
`);

  const preloadUrl = new URL(`file://${preloadPath}`).href;
  const rCjs = spawnSync(process.execPath, ["--import", preloadUrl, cjsReentrancyScript], {
    cwd: outsideScriptDir,
    env: {
      ...process.env,
      AUTOPILOT_PLAYWRIGHT_MODULE_ROOT: isolatedNm,
      AUTOPILOT_BROWSER_ARTIFACT_DIR: preloadArtDir,
    },
    encoding: "utf8",
    timeout: 15000,
  });
  let cjsOut = null;
  try { cjsOut = JSON.parse((rCjs.stdout || "").trim().split("\n").pop()); } catch {}
  check("plain node --import <preload> resolves createRequire(MODULE_ROOT + '/')('playwright') without recursion",
    rCjs.status === 0 && cjsOut?.ok === true && cjsOut.maxDepth <= 2 && cjsOut.patched === true,
    {status: rCjs.status, cjsOut, stdout: rCjs.stdout, stderr: rCjs.stderr});

  // 2) Test ESM `import { chromium } from "playwright"` from an unrelated directory
  // (exercises the Module.register ESM resolve hook + CJS load).
  const esmReentrancyScript = path.join(outsideScriptDir, "reentrancy-esm.mjs");
  fs.writeFileSync(esmReentrancyScript, `
import {chromium} from "playwright";
if (!chromium || typeof chromium.launch !== "function" || !chromium.__apPatched) {
  throw new Error("ESM import of playwright did not resolve or patch chromium");
}
console.log(JSON.stringify({ok: true, patched: Boolean(chromium.__apPatched)}));
`);
  const rEsm = spawnSync(process.execPath, ["--import", preloadUrl, esmReentrancyScript], {
    cwd: outsideScriptDir,
    env: {
      ...process.env,
      AUTOPILOT_PLAYWRIGHT_MODULE_ROOT: isolatedNm,
      AUTOPILOT_BROWSER_ARTIFACT_DIR: preloadArtDir,
    },
    encoding: "utf8",
    timeout: 15000,
  });
  let esmOut = null;
  try { esmOut = JSON.parse((rEsm.stdout || "").trim().split("\n").pop()); } catch {}
  check("plain node --import <preload> resolves ESM `import { chromium } from 'playwright'` from outside dir without recursion",
    rEsm.status === 0 && esmOut?.ok === true && esmOut.patched === true,
    {status: rEsm.status, esmOut, stdout: rEsm.stdout, stderr: rEsm.stderr});
}

// --- 2. REQUIRED proof rule: PASS without evidence vs PASS with evidence ---
console.log("2. REQUIRED proof rule: PASS without wrapper evidence is not accepted (manual check); PASS with evidence is accepted");
{
  // Case A: Verifier returns PASS on a browser phase, but never ran ap-browser-check.
  const emptyRunDir = tmp("ap-b7-noproof-");
  const proofA = verifyBrowserProof(emptyRunDir);
  check("empty run dir has no wrapper evidence", proofA.ok === false && proofA.ran === false && proofA.reason === "no_wrapper_evidence", proofA);

  const vvNoProof = {
    status: "completed",
    review: {decision: "PASS", findings: []},
    verdict: {status: "available", decision: "PASS", findings: []},
  };
  const outA = evaluateVerifierBrowserOutcome({
    vv: vvNoProof,
    runDir: emptyRunDir,
    taskFacts: {browser: true, playwright: false},
    phaseName: "Phase 4",
  });
  check("PASS without wrapper evidence -> browserProofAccepted is false", outA.browserProofAccepted === false && vvNoProof.browserProofAccepted === false, outA);
  check("PASS without wrapper evidence -> synthesized BROWSER CHECK NOT POSSIBLE note added", outA.manualNotesAdded.length === 1 && outA.manualNotesAdded[0].startsWith("BROWSER CHECK NOT POSSIBLE:"), outA.manualNotesAdded);
  const notesA = browserCheckNotes(vvNoProof.review);
  check("browserCheckNotes extracts the manual check note for MANUAL-CHECKS.md", notesA.length === 1, notesA);

  const missionDirA = tmp("ap-b7-missionA-");
  const stateA = {};
  const freshA = filterUnrecordedManualChecks(stateA, "Phase 4", notesA);
  appendManualChecks(missionDirA, {phaseName: "Phase 4", notes: freshA, at: "2026-11-19T12:00:00.000Z"});
  const manualMd = fs.readFileSync(path.join(missionDirA, "MANUAL-CHECKS.md"), "utf8");
  check("unproven browser PASS is recorded in MANUAL-CHECKS.md as not proven by ap-browser-check",
    manualMd.includes("BROWSER CHECK NOT POSSIBLE: Phase 4") && manualMd.includes("not proven by ap-browser-check"), manualMd);

  // Case B: Wrapper ran but exited non-zero -> proof rejected.
  const failRunDir = tmp("ap-b7-exitfail-");
  const failArtDir = path.join(failRunDir, BROWSER_CHECK_DIR_NAME);
  fs.mkdirSync(failArtDir, {recursive: true});
  fs.writeFileSync(path.join(failArtDir, "script-check.mjs"), "// script\n");
  fs.writeFileSync(path.join(failArtDir, "screenshot-1.png"), VALID_PNG_BYTES);
  fs.writeFileSync(path.join(failArtDir, "output.log"), "AssertionError: button not visible\n");
  fs.writeFileSync(path.join(failArtDir, BROWSER_EVIDENCE_FILE), JSON.stringify({
    command: BROWSER_WRAPPER_COMMAND,
    savedScript: "script-check.mjs",
    exitCode: 1,
    outputFile: "output.log",
    screenshots: ["screenshot-1.png"],
  }));
  const proofB = verifyBrowserProof(failRunDir);
  check("nonzero wrapper exit code is rejected by verifyBrowserProof", proofB.ok === false && proofB.ran === true && proofB.reason === "wrapper_exit_1", proofB);

  // Case C: Wrapper ran and exited 0, but no screenshot was saved -> proof rejected.
  const noShotRunDir = tmp("ap-b7-noshot-");
  const noShotArtDir = path.join(noShotRunDir, BROWSER_CHECK_DIR_NAME);
  fs.mkdirSync(noShotArtDir, {recursive: true});
  fs.writeFileSync(path.join(noShotArtDir, "script-check.mjs"), "// script\n");
  fs.writeFileSync(path.join(noShotArtDir, "output.log"), "ran with no screenshot\n");
  fs.writeFileSync(path.join(noShotArtDir, BROWSER_EVIDENCE_FILE), JSON.stringify({
    command: BROWSER_WRAPPER_COMMAND,
    savedScript: "script-check.mjs",
    exitCode: 0,
    outputFile: "output.log",
    screenshots: [],
  }));
  const proofC = verifyBrowserProof(noShotRunDir);
  check("exit 0 without any screenshot is rejected by verifyBrowserProof", proofC.ok === false && proofC.reason === "screenshot_missing", proofC);

  // Case D: Wrapper ran, exited 0, script + valid PNG screenshot + output present -> PASS accepted!
  const goodRunDir = tmp("ap-b7-goodproof-");
  const goodArtDir = path.join(goodRunDir, BROWSER_CHECK_DIR_NAME);
  fs.mkdirSync(goodArtDir, {recursive: true});
  fs.writeFileSync(path.join(goodArtDir, "script-check.mjs"), "// script\n");
  fs.writeFileSync(path.join(goodArtDir, "screenshot-1-login.png"), VALID_PNG_BYTES);
  fs.writeFileSync(path.join(goodArtDir, "trace.zip"), VALID_ZIP_BYTES);
  fs.writeFileSync(path.join(goodArtDir, "video.webm"), VALID_WEBM_BYTES);
  fs.writeFileSync(path.join(goodArtDir, "output.log"), "ok 200\n");
  fs.writeFileSync(path.join(goodArtDir, BROWSER_EVIDENCE_FILE), JSON.stringify({
    command: BROWSER_WRAPPER_COMMAND,
    savedScript: "script-check.mjs",
    exitCode: 0,
    outputFile: "output.log",
    screenshots: ["screenshot-1-login.png"],
    traces: ["trace.zip"],
    videos: ["video.webm"],
  }));
  const vvWithProof = {
    status: "completed",
    review: {decision: "PASS", findings: []},
    verdict: {status: "available", decision: "PASS", findings: []},
  };
  const outD = evaluateVerifierBrowserOutcome({
    vv: vvWithProof,
    runDir: goodRunDir,
    taskFacts: {browser: true, playwright: true},
    phaseName: "Phase 4",
  });
  check("PASS with valid wrapper evidence -> browserProofAccepted is true", outD.browserProofAccepted === true && vvWithProof.browserProofAccepted === true, outD);
  check("PASS with valid wrapper evidence -> no manual check note added", outD.manualNotesAdded.length === 0 && browserCheckNotes(vvWithProof.review).length === 0, vvWithProof.review);
}

// --- 3. Brief instructions & secrets isolation -----------------------------
console.log("3. Verifier brief contains browser instructions + env variable NAMES only when server is up; secret values never appear");
{
  const repo = tmp("ap-b7-briefrepo-");
  fs.writeFileSync(path.join(repo, ".env.local"), [
    `E2E_SUPER_ADMIN_EMAIL=admin@clinixhub.test`,
    `E2E_SUPER_ADMIN_PASSWORD=${SECRET_MARKER}`,
    `FIXTURE_INTERNAL=ignore_me`,
  ].join("\n") + "\n");
  const appCfg = {
    start_command: "npm run dev",
    env_file: ".env.local",
  };
  const pwReady = {
    readyForLaunchProbe: true,
    module: {status: "discovered", source: "skill"},
    browser: {status: "discovered", source: "platform-cache"},
  };
  const pwMissing = {
    readyForLaunchProbe: false,
    module: {status: "discovered", source: "skill"},
    browser: {status: "not-found", source: null},
  };

  // Server not running -> empty browser brief
  check("no server -> verifierBrowserBrief is empty",
    verifierBrowserBrief({session: null, playwrightRuntime: pwReady, appCfg, repo}) === ""
    && verifierBrowserBrief({session: {alive: () => false, baseUrl: "http://127.0.0.1:3000"}, playwrightRuntime: pwReady, appCfg, repo}) === "");

  // Server running + Playwright ready -> full instructions with env var NAMES, never values
  const liveSession = {alive: () => true, baseUrl: "http://127.0.0.1:4321", port: 4321, mode: "namespace"};
  const briefUp = verifierBrowserBrief({session: liveSession, playwrightRuntime: pwReady, appCfg, repo});
  check("brief includes ap-browser-check wrapper command", briefUp.includes(`${BROWSER_WRAPPER_COMMAND} <script.mjs>`), briefUp);
  check("brief tells verifier to open changed pages at APP_BASE_URL", briefUp.includes("APP_BASE_URL") && briefUp.includes("http://127.0.0.1:4321"), briefUp);
  check("brief lists credential variable NAMES (E2E_SUPER_ADMIN_EMAIL, E2E_SUPER_ADMIN_PASSWORD)",
    briefUp.includes("E2E_SUPER_ADMIN_EMAIL") && briefUp.includes("E2E_SUPER_ADMIN_PASSWORD") && !briefUp.includes("FIXTURE_INTERNAL"), briefUp);
  check("brief NEVER contains the secret value or email value",
    !briefUp.includes(SECRET_MARKER) && !briefUp.includes("admin@clinixhub.test"), briefUp);
  check("brief instructs to retry a failing browser assertion once before FAIL",
    /Retry a failing browser assertion once before returning FAIL/i.test(briefUp), briefUp);
  check("brief states the REQUIRED proof rule and BROWSER CHECK NOT POSSIBLE rule",
    /REQUIRED proof rule/i.test(briefUp) && briefUp.includes("BROWSER CHECK NOT POSSIBLE:"), briefUp);
  check("brief without allow_hosts states browser is in a closed network namespace and email-inbox flows stay manual checks",
    /closed network namespace/i.test(briefUp) && /email-inbox flows .* stay manual checks/i.test(briefUp), briefUp);

  // Server running with allow_hosts -> brief states only APP_BASE_URL and allow_hosts are reachable, email-inbox flows stay manual checks
  const allowSession = {alive: () => true, baseUrl: "http://127.0.0.1:4321", port: 4321, mode: "host-bridge", allowHosts: ["proj.supabase.co", "sync.powersync.journeyapps.com"], proxyUrl: "http://127.0.0.1:54321", proxyPort: 54321};
  const briefAllow = verifierBrowserBrief({session: allowSession, playwrightRuntime: pwReady, appCfg: {...appCfg, allow_hosts: allowSession.allowHosts}, repo});
  check("brief with allow_hosts names only the allowed hosts as reachable and mentions email-inbox flows stay manual checks",
    briefAllow.includes("proj.supabase.co")
    && briefAllow.includes("sync.powersync.journeyapps.com")
    && /every other host or port is refused/i.test(briefAllow)
    && /email-inbox flows .* stay manual checks/i.test(briefAllow), briefAllow);

  // Server running + Playwright missing -> tells verifier Playwright is not available and to emit BROWSER CHECK NOT POSSIBLE
  const briefNoPw = verifierBrowserBrief({session: liveSession, playwrightRuntime: pwMissing, appCfg, repo});
  check("server up but Playwright missing -> brief tells verifier to emit BROWSER CHECK NOT POSSIBLE",
    briefNoPw.includes("Playwright + Chromium are not available") && briefNoPw.includes("BROWSER CHECK NOT POSSIBLE:") && !briefNoPw.includes(SECRET_MARKER), briefNoPw);

  // verifierTask approved command list includes ap-browser-check <script.mjs> only when
  // Playwright is discovered AND an app server is up for this verifier run.
  const vtWithPwAndServer = verifierTask("Check the login page", repo, "/workspace/scratch", {gates: {commands: ["npm test"]}}, pwReady, true);
  check("verifierTask lists ap-browser-check <script.mjs> when Playwright is ready and the app server is up",
    vtWithPwAndServer.includes("  - npm test") && vtWithPwAndServer.includes(`  - ${BROWSER_WRAPPER_COMMAND} <script.mjs>`), vtWithPwAndServer);
  const vtWithPwNoServer = verifierTask("Check the login page", repo, "/workspace/scratch", {gates: {commands: ["npm test"]}}, pwReady);
  check("verifierTask does not list ap-browser-check when Playwright is ready but no app server is up",
    vtWithPwNoServer.includes("  - npm test") && !vtWithPwNoServer.includes(BROWSER_WRAPPER_COMMAND), vtWithPwNoServer);
  const vtWithPwNoServerNoGates = verifierTask("Check the login page", repo, "/workspace/scratch", {gates: {commands: []}}, pwReady);
  check("verifierTask with Playwright ready, no app server and no gate commands says no verifier command is approved",
    /No verifier command is approved/.test(vtWithPwNoServerNoGates) && !vtWithPwNoServerNoGates.includes(BROWSER_WRAPPER_COMMAND), vtWithPwNoServerNoGates);
  const vtWithoutPw = verifierTask("Check the login page", repo, "/workspace/scratch", {gates: {commands: ["npm test"]}}, pwMissing, true);
  check("verifierTask does not list ap-browser-check when Playwright is missing",
    vtWithoutPw.includes("  - npm test") && !vtWithoutPw.includes(BROWSER_WRAPPER_COMMAND), vtWithoutPw);

  // Default rule vs explicit credential_vars in verifier brief and credentialEnvNames
  const repoFull = tmp("ap-b5-credvars-");
  fs.writeFileSync(path.join(repoFull, ".env.production.local"), [
    "E2E_SUPER_ADMIN_EMAIL=super@clinixhub.test",
    "E2E_SUPER_ADMIN_PASSWORD=super-password-123",
    "E2E_DOCTOR_PASSWORD=doctor-password-456",
    "NEXT_PUBLIC_SUPABASE_URL=https://project.supabase.co",
    "SUPABASE_SERVICE_ROLE_KEY=service-role-secret-key-xyz",
    "POWERSYNC_URL=https://sync.powersync.journeyapps.com",
    "MY_LOGIN=custom_user",
    "MY_PASS=custom_pass",
  ].join("\n") + "\n");

  const appCfgDefault = {
    start_command: "npm run dev",
    env_file: ".env.production.local",
  };
  const secretsFull = resolveAppServerSecrets(appCfgDefault, repoFull);

  // 1. credentialEnvNames default rule
  const defaultCredNames = credentialEnvNames(secretsFull);
  check("credentialEnvNames default rule matches names starting with E2E_/TEST_ and ending with EMAIL/USER/USERNAME/PASSWORD",
    defaultCredNames.length === 3
    && defaultCredNames.includes("E2E_SUPER_ADMIN_EMAIL")
    && defaultCredNames.includes("E2E_SUPER_ADMIN_PASSWORD")
    && defaultCredNames.includes("E2E_DOCTOR_PASSWORD")
    && !defaultCredNames.includes("NEXT_PUBLIC_SUPABASE_URL")
    && !defaultCredNames.includes("SUPABASE_SERVICE_ROLE_KEY")
    && !defaultCredNames.includes("POWERSYNC_URL")
    && !defaultCredNames.includes("MY_LOGIN")
    && !defaultCredNames.includes("MY_PASS"), defaultCredNames);

  // 2. credentialEnvNames with explicit credential_vars
  const explicitCredNames = credentialEnvNames(secretsFull, ["MY_LOGIN", "MY_PASS"]);
  check("credentialEnvNames with explicit array returns only those names",
    explicitCredNames.length === 2 && explicitCredNames[0] === "MY_LOGIN" && explicitCredNames[1] === "MY_PASS", explicitCredNames);
  const cfgCredNames = credentialEnvNames(secretsFull, {credential_vars: ["MY_LOGIN", "MY_PASS"]});
  check("credentialEnvNames with appCfg.credential_vars returns only those names",
    cfgCredNames.length === 2 && cfgCredNames[0] === "MY_LOGIN" && cfgCredNames[1] === "MY_PASS", cfgCredNames);

  // 3. credentialEnvNames with empty credential_vars array falls back to default rule
  const emptyCredNames = credentialEnvNames(secretsFull, {credential_vars: []});
  check("credentialEnvNames with empty credential_vars array falls back to default rule",
    emptyCredNames.length === 3
    && emptyCredNames.includes("E2E_SUPER_ADMIN_EMAIL")
    && emptyCredNames.includes("E2E_SUPER_ADMIN_PASSWORD")
    && emptyCredNames.includes("E2E_DOCTOR_PASSWORD"), emptyCredNames);

  // 4. verifierBrowserBrief with default rule: brief names only the E2E_* ones
  const briefDef = verifierBrowserBrief({session: liveSession, playwrightRuntime: pwReady, appCfg: appCfgDefault, repo: repoFull});
  check("brief with default rule names only the E2E_* credential variable names",
    briefDef.includes("E2E_SUPER_ADMIN_EMAIL")
    && briefDef.includes("E2E_SUPER_ADMIN_PASSWORD")
    && briefDef.includes("E2E_DOCTOR_PASSWORD")
    && !briefDef.includes("NEXT_PUBLIC_SUPABASE_URL")
    && !briefDef.includes("SUPABASE_SERVICE_ROLE_KEY")
    && !briefDef.includes("POWERSYNC_URL")
    && !briefDef.includes("MY_LOGIN")
    && !briefDef.includes("MY_PASS"), briefDef);

  // 5. verifierBrowserBrief with credential_vars ["MY_LOGIN", "MY_PASS"]: brief names only those
  const appCfgCustom = {
    start_command: "npm run dev",
    env_file: ".env.production.local",
    credential_vars: ["MY_LOGIN", "MY_PASS"],
  };
  const briefCustom = verifierBrowserBrief({session: liveSession, playwrightRuntime: pwReady, appCfg: appCfgCustom, repo: repoFull});
  check("brief with credential_vars ['MY_LOGIN','MY_PASS'] names only those configured variable names",
    briefCustom.includes("MY_LOGIN")
    && briefCustom.includes("MY_PASS")
    && !briefCustom.includes("E2E_SUPER_ADMIN_EMAIL")
    && !briefCustom.includes("E2E_SUPER_ADMIN_PASSWORD")
    && !briefCustom.includes("E2E_DOCTOR_PASSWORD")
    && !briefCustom.includes("SUPABASE_SERVICE_ROLE_KEY"), briefCustom);

  // 6. Wrapper execution with credential_vars ["MY_LOGIN", "MY_PASS"]: child env contains only those values
  {
    const credRunDir = tmp("ap-b5-cred-rundir-");
    const credScratch = path.join(credRunDir, "scratch");
    fs.mkdirSync(credScratch, {recursive: true});
    const credScript = path.join(credScratch, "verify-custom-creds.mjs");
    const e2eB64 = Buffer.from("super-password-123").toString("base64");
    fs.writeFileSync(credScript, `
console.log("child MY_LOGIN exists:", process.env.MY_LOGIN === "custom_user");
console.log("child MY_PASS exists:", process.env.MY_PASS === "custom_pass");
console.log("child E2E_SUPER_ADMIN_PASSWORD is undefined:", process.env.E2E_SUPER_ADMIN_PASSWORD === undefined);
console.log("child SUPABASE_SERVICE_ROLE_KEY is undefined:", process.env.SUPABASE_SERVICE_ROLE_KEY === undefined);
// Deliberately print E2E_SUPER_ADMIN_PASSWORD to show all env secrets are still masked
console.log("raw E2E pw printed:", Buffer.from("${e2eB64}", "base64").toString("utf8"));
`);
    const credRes = runVerifierBrowserCheck({
      scriptPath: credScript,
      repo: repoFull,
      runDir: credRunDir,
      scratchDir: credScratch,
      appSession: liveSession,
      appCfg: appCfgCustom,
      playwrightRuntime: pwReady,
      useEnvelope: false,
    });
    const credProof = verifyBrowserProof(credRunDir);
    check("wrapper with credential_vars ['MY_LOGIN','MY_PASS'] injects only those values into child env",
      (credProof.output || "").includes("child MY_LOGIN exists: true")
      && (credProof.output || "").includes("child MY_PASS exists: true")
      && (credProof.output || "").includes("child E2E_SUPER_ADMIN_PASSWORD is undefined: true")
      && (credProof.output || "").includes("child SUPABASE_SERVICE_ROLE_KEY is undefined: true"), credProof.output);
    check("wrapper with credential_vars still masks other env_file secrets in output",
      (credProof.output || "").includes("<E2E_SUPER_ADMIN_PASSWORD>")
      && !(credProof.output || "").includes("super-password-123"), credProof.output);
  }
}

// --- 4. Real relayVerifierWithApp end-to-end (server up vs no server) ------
console.log("4. relayVerifierWithApp end-to-end: brief, wrapper execution, proof acceptance, and secret non-leakage");
{
  const repo = tmp("ap-b7-relayrepo-");
  spawnSync("git", ["init", "-q", repo]);
  fs.writeFileSync(path.join(repo, ".env.test"), `E2E_SUPER_ADMIN_EMAIL=admin@test.local\nE2E_SUPER_ADMIN_PASSWORD=${SECRET_MARKER}\n`);
  const pwRuntime = installStubPlaywrightModule(repo);

  const cfgWithServer = {
    gates: {
      commands: [],
      network_isolation: false,
      app_server: {
        start_command: `node ${JSON.stringify(FIXTURE_SERVER)}`,
        port: "auto",
        ready_url: "/ready",
        ready_timeout_ms: 15000,
        env_file: ".env.test",
        env: {FIXTURE_DELAY_MS: "50"},
      },
    },
  };

  // Run 1: Verifier runs ap-browser-check against the running server and returns PASS.
  const runDir1 = tmp("ap-b7-relayrun1-");
  let briefSeen1 = "";
  const vv1 = await relayVerifierWithAppForTests(
    "Verify Phase 1 login UI",
    cfgWithServer,
    {phaseIndex: 0},
    {cwd: repo, playwrightRuntime: pwRuntime, taskFacts: {browser: true, playwright: true}},
    async (role, taskText) => {
      briefSeen1 = taskText;
      const scratchDir = path.join(runDir1, "scratch");
      fs.mkdirSync(scratchDir, {recursive: true});
      const scriptFile = path.join(scratchDir, "ui-check.mjs");
      fs.writeFileSync(scriptFile, `
import {createRequire} from "node:module";
const req = createRequire(process.env.AUTOPILOT_PLAYWRIGHT_MODULE_ROOT + "/noop.js");
const {chromium} = req("playwright");
console.log("Loaded secret in script:", process.env.E2E_SUPER_ADMIN_PASSWORD);
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const resp = await page.goto(process.env.APP_BASE_URL + "/ar/login");
if (resp.status() !== 200) throw new Error("unexpected status " + resp.status());
await page.screenshot({path: "login.png"});
await ctx.close();
await browser.close();
`);
      runVerifierBrowserCheck({
        scriptPath: scriptFile,
        repo,
        runDir: runDir1,
        scratchDir,
        appSession: {baseUrl: /APP_BASE_URL=(http:\/\/127\.0\.0\.1:\d+)/.exec(taskText)?.[1], port: null, mode: "host"},
        appCfg: cfgWithServer.gates.app_server,
        playwrightRuntime: pwRuntime,
        useEnvelope: false,
      });
      const resObj = {
        status: "completed",
        runDir: runDir1,
        review: {decision: "PASS", findings: []},
        verdict: {status: "available", decision: "PASS", findings: []},
      };
      fs.writeFileSync(path.join(runDir1, "result.json"), JSON.stringify(resObj, null, 2));
      return resObj;
    }
  );

  check("relayVerifierWithApp brief contains APP_BASE_URL, ap-browser-check, and E2E_SUPER_ADMIN_PASSWORD name",
    /APP_BASE_URL=http:\/\/127\.0\.0\.1:\d+/.test(briefSeen1)
    && briefSeen1.includes(BROWSER_WRAPPER_COMMAND)
    && briefSeen1.includes("E2E_SUPER_ADMIN_PASSWORD"), briefSeen1);
  check("relayVerifierWithApp brief never contains the secret marker", !briefSeen1.includes(SECRET_MARKER));
  check("relayVerifierWithApp accepted the browser PASS with proof", vv1.browserProofAccepted === true && vv1.browserProof?.accepted === true, vv1.browserProof);
  const diskRes1 = JSON.parse(fs.readFileSync(path.join(runDir1, "result.json"), "utf8"));
  check("result.json on disk records browserProofAccepted: true", diskRes1.browserProofAccepted === true && diskRes1.browserProof?.accepted === true, diskRes1.browserProof);
  const leaked1 = filesUnder(runDir1).filter((f) => fs.readFileSync(f, "utf8").includes(SECRET_MARKER));
  check("no file in runDir1 contains the secret marker", leaked1.length === 0, leaked1);

  // Run 2: Verifier returns PASS on a browser phase WITHOUT running ap-browser-check -> downgraded to manual check.
  const runDir2 = tmp("ap-b7-relayrun2-");
  fs.writeFileSync(path.join(runDir2, "result.json"), JSON.stringify({status: "completed", review: {decision: "PASS", findings: []}}, null, 2));
  const vv2 = await relayVerifierWithAppForTests(
    "Verify Phase 2 dashboard UI",
    cfgWithServer,
    {phaseIndex: 1},
    {cwd: repo, playwrightRuntime: pwRuntime, taskFacts: {browser: true}},
    async () => ({
      status: "completed",
      runDir: runDir2,
      review: {decision: "PASS", findings: []},
      verdict: {status: "available", decision: "PASS", findings: []},
    })
  );
  check("PASS without wrapper evidence -> browserProofAccepted is false on returned result", vv2.browserProofAccepted === false, vv2);
  check("PASS without wrapper evidence -> review.notes carries BROWSER CHECK NOT POSSIBLE", browserCheckNotes(vv2.review).length === 1, vv2.review);
  const diskRes2 = JSON.parse(fs.readFileSync(path.join(runDir2, "result.json"), "utf8"));
  check("result.json on disk records browserProofAccepted: false and the manual check note",
    diskRes2.browserProofAccepted === false && browserCheckNotes(diskRes2.review).length === 1, diskRes2);

  // Run 3: No app_server configured -> brief has no APP_BASE_URL or ap-browser-check instructions.
  let briefSeen3 = "";
  await relayVerifierWithAppForTests(
    "Verify Phase 3 backend",
    {gates: {commands: []}},
    {phaseIndex: 2},
    {taskFacts: {browser: false}},
    async (_role, taskText) => {
      briefSeen3 = taskText;
      return {status: "completed", review: {decision: "PASS", findings: []}};
    }
  );
  check("no app_server -> brief is unchanged (no APP_BASE_URL or browser instructions)", briefSeen3 === "Verify Phase 3 backend", briefSeen3);
}

// --- 5. Retention in mission-scratch-cleanup.mjs ---------------------------
console.log("5. Retention: screenshots always kept; videos/traces kept only for last verifier run of each phase and failed runs, and deleted after 3 days");
{
  const mission = tmp("ap-b7-retention-");
  const nowMs = Date.parse("2026-11-19T18:00:00.000Z");
  const oneHourAgoIso = new Date(nowMs - 60 * 60 * 1000).toISOString();
  const fourDaysAgoIso = new Date(nowMs - 4 * 24 * 60 * 60 * 1000).toISOString();
  const fourDaysAgoDate = new Date(nowMs - 4 * 24 * 60 * 60 * 1000);

  function seedVerifierRun(name, {phase, decision, recordedAtIso, fileDate = null, inScratchOnly = false}) {
    const runDir = path.join(mission, "runs", name);
    fs.mkdirSync(path.join(runDir, "scratch"), {recursive: true});
    fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({role: "verifier", phase: String(phase), status: "completed", decision, updated_at: recordedAtIso}));
    fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify({role: "verifier", phase: String(phase), status: "completed", finishedAt: recordedAtIso, review: {decision, findings: []}}));
    const artDir = inScratchOnly ? path.join(runDir, "scratch", BROWSER_CHECK_DIR_NAME) : path.join(runDir, BROWSER_CHECK_DIR_NAME);
    fs.mkdirSync(artDir, {recursive: true});
    const files = [
      ["script-check.mjs", "// playwright script\n"],
      ["screenshot-1.png", VALID_PNG_BYTES],
      ["trace.zip", VALID_ZIP_BYTES],
      ["video.webm", VALID_WEBM_BYTES],
      ["output.log", "ok\n"],
      [BROWSER_EVIDENCE_FILE, JSON.stringify({command: BROWSER_WRAPPER_COMMAND, savedScript: "script-check.mjs", exitCode: decision === "FAIL" ? 1 : 0, recordedAt: recordedAtIso, screenshots: ["screenshot-1.png"], traces: ["trace.zip"], videos: ["video.webm"]})],
    ];
    for (const [fname, content] of files) {
      const fp = path.join(artDir, fname);
      fs.writeFileSync(fp, content);
      if (fileDate) fs.utimesSync(fp, fileDate, fileDate);
    }
    return runDir;
  }

  // Phase 1:
  //   01-verifier-aaa: earlier PASS run in Phase 1 (not last, not failed) -> video & trace deleted, screenshot kept
  //   02-verifier-bbb: earlier FAIL run in Phase 1 (failed run, recent) -> video, trace & screenshot all kept
  //   03-verifier-ccc: LAST verifier run in Phase 1 (PASS, recent, artifacts in scratch/browser-check) -> rescued to browser-check/, video, trace & screenshot all kept
  const r1 = seedVerifierRun("01-verifier-aaa", {phase: 1, decision: "PASS", recordedAtIso: oneHourAgoIso});
  const r2 = seedVerifierRun("02-verifier-bbb", {phase: 1, decision: "FAIL", recordedAtIso: oneHourAgoIso});
  const r3 = seedVerifierRun("03-verifier-ccc", {phase: 1, decision: "PASS", recordedAtIso: oneHourAgoIso, inScratchOnly: true});

  // Phase 2:
  //   04-verifier-ddd: LAST verifier run in Phase 2, but recorded 4 days ago (> 3 days) -> video & trace deleted by 3-day rule, screenshot & script still kept!
  //   05-verifier-eee: FAILED verifier run in Phase 2, recorded 4 days ago (> 3 days) -> video & trace deleted by 3-day rule, screenshot & script still kept!
  const r4 = seedVerifierRun("04-verifier-ddd", {phase: 2, decision: "PASS", recordedAtIso: fourDaysAgoIso, fileDate: fourDaysAgoDate});
  const r5 = seedVerifierRun("05-verifier-eee", {phase: 2, decision: "FAIL", recordedAtIso: fourDaysAgoIso, fileDate: fourDaysAgoDate});

  const hasArt = (runDir, fname) => fs.existsSync(path.join(runDir, BROWSER_CHECK_DIR_NAME, fname));

  const cleaned = cleanMissionScratch(mission, {nowMs});
  check("cleanMissionScratch removed all 5 scratch dirs", cleaned.removed === 5, cleaned);

  // Check r1 (earlier non-failed run of phase 1):
  check("r1 (earlier PASS of phase 1): screenshot and script kept", hasArt(r1, "screenshot-1.png") && hasArt(r1, "script-check.mjs"));
  check("r1 (earlier PASS of phase 1): video and trace deleted", !hasArt(r1, "video.webm") && !hasArt(r1, "trace.zip"));

  // Check r2 (earlier FAILED run of phase 1, recent):
  check("r2 (failed run of phase 1, recent): screenshot, video and trace all kept",
    hasArt(r2, "screenshot-1.png") && hasArt(r2, "video.webm") && hasArt(r2, "trace.zip"));

  // Check r3 (last run of phase 1, recent, rescued from scratch):
  check("r3 (last run of phase 1, recent): rescued from scratch and screenshot, video, trace all kept",
    hasArt(r3, "screenshot-1.png") && hasArt(r3, "video.webm") && hasArt(r3, "trace.zip"));

  // Check r4 & r5 (4 days old > 3-day retention limit):
  check("r4 (last run of phase 2, 4 days old): video and trace deleted after 3 days, screenshot and script kept",
    hasArt(r4, "screenshot-1.png") && hasArt(r4, "script-check.mjs") && !hasArt(r4, "video.webm") && !hasArt(r4, "trace.zip"));
  check("r5 (failed run of phase 2, 4 days old): video and trace deleted after 3 days, screenshot and script kept",
    hasArt(r5, "screenshot-1.png") && hasArt(r5, "script-check.mjs") && !hasArt(r5, "video.webm") && !hasArt(r5, "trace.zip"));

  // Also test cleanAllMissionsBrowserArtifacts on an in-progress mission (before mission ends)
  const repoForSweep = tmp("ap-b7-sweeprepo-");
  const activeMission = path.join(repoForSweep, ".autopilot", "missions", "001-active");
  const activeRun = path.join(activeMission, "runs", "01-verifier-live");
  const activeArt = path.join(activeRun, BROWSER_CHECK_DIR_NAME);
  fs.mkdirSync(activeArt, {recursive: true});
  fs.writeFileSync(path.join(activeRun, "status.json"), JSON.stringify({role: "verifier", phase: "1", status: "completed", decision: "PASS", updated_at: fourDaysAgoIso}));
  fs.writeFileSync(path.join(activeArt, "screenshot-live.png"), VALID_PNG_BYTES);
  fs.writeFileSync(path.join(activeArt, "trace.zip"), VALID_ZIP_BYTES);
  fs.writeFileSync(path.join(activeArt, "video.webm"), VALID_WEBM_BYTES);
  fs.utimesSync(path.join(activeArt, "trace.zip"), fourDaysAgoDate, fourDaysAgoDate);
  fs.utimesSync(path.join(activeArt, "video.webm"), fourDaysAgoDate, fourDaysAgoDate);
  const sweepRes = cleanAllMissionsBrowserArtifacts(repoForSweep, {nowMs});
  check("cleanAllMissionsBrowserArtifacts deletes >3-day videos/traces even in an unfinished mission while keeping screenshots",
    sweepRes.deletedFiles === 2
    && fs.existsSync(path.join(activeArt, "screenshot-live.png"))
    && !fs.existsSync(path.join(activeArt, "trace.zip"))
    && !fs.existsSync(path.join(activeArt, "video.webm")), sweepRes);
}

// --- 6. Setup / ap config Playwright + Chromium check messages -------------
console.log("6. Setup / ap config Playwright + Chromium status messages (consistent across setup and config)");
{
  const bothReady = formatPlaywrightStatusBlock({
    module: {status: "discovered", source: "skill"},
    browser: {status: "discovered", source: "platform-cache"},
  });
  check("both installed: reports module and browser available with no install command",
    bothReady.includes("✓ Playwright module: available (source: skill)")
    && bothReady.includes("✓ Playwright browser: available (source: platform-cache)")
    && !bothReady.includes("Install:"), bothReady);

  const missingBrowser = formatPlaywrightStatusBlock({
    module: {status: "discovered", source: "repository"},
    browser: {status: "not-found", source: null},
  });
  check("missing Chromium: says how to install (npx playwright install chromium) and to re-run ap setup / ap config",
    missingBrowser.includes("· Playwright browser: not installed")
    && missingBrowser.includes("Install: npx playwright install chromium")
    && missingBrowser.includes('Re-run "ap setup" (or "ap config")'), missingBrowser);

  const missingBoth = formatPlaywrightStatusBlock({
    module: {status: "not-found", source: null},
    browser: {status: "not-found", source: null},
  });
  check("missing both: prints npm install playwright and npx playwright install chromium",
    missingBoth.includes("Install: npm install playwright")
    && missingBoth.includes("Install: npx playwright install chromium"), missingBoth);
}

// --- 6b. Allowlisting HTTP CONNECT proxy + ap-browser-check proxy flags ----
function startFixtureTarget({expectMatch = null, reply = "PONG", hitsFile}) {
  fs.writeFileSync(hitsFile, "0");
  const script = `
const fs = require("fs");
const net = require("net");
const [hitsFile, expectMatch, reply] = process.argv.slice(1);
let hits = 0;
const srv = net.createServer((c) => {
  hits += 1;
  try { fs.writeFileSync(hitsFile, String(hits)); } catch {}
  if (!expectMatch) {
    c.end(reply);
    return;
  }
  let buf = "";
  c.on("data", (d) => {
    buf += d.toString("utf8");
    if (buf.includes(expectMatch)) c.end(reply);
  });
  c.on("error", () => {});
});
srv.listen(0, "127.0.0.1", () => {
  console.log("ready:" + srv.address().port);
});
`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script, hitsFile, expectMatch || "", reply], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error("fixture target timeout"));
    }, 10000);
    let out = "";
    child.stdout.on("data", (d) => {
      out += d.toString("utf8");
      const m = /ready:(\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({
          port: Number(m[1]),
          hits: () => Number(fs.readFileSync(hitsFile, "utf8").trim() || "0"),
          close: () => { try { child.kill("SIGKILL"); } catch {} },
        });
      }
    });
    child.once("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

console.log("6b. Allowlisting HTTP CONNECT proxy (allow_hosts on port 443) and Chromium --proxy-server / --proxy-bypass-list");
{
  // Start a local fixture TCP target on the host as a separate child process
  // (representing an allowed Supabase/PowerSync service on port 443) and a
  // second target for a non-allowed host.
  const fix6bDir = tmp("ap-b7-fix6b-");
  const allowedFixture = await startFixtureTarget({
    expectMatch: "HELLO_SUPABASE",
    reply: "SUPABASE_OK_200",
    hitsFile: path.join(fix6bDir, "allowed.hits"),
  });
  const allowedFixturePort = allowedFixture.port;

  const disallowedFixture = await startFixtureTarget({
    expectMatch: null,
    reply: "SHOULD_NEVER_REACH",
    hitsFile: path.join(fix6bDir, "disallowed.hits"),
  });
  const disallowedFixturePort = disallowedFixture.port;

  const proxyLogs = [];
  const proxy = await startAllowlistProxy({
    listenPort: 0,
    allowHosts: ["proj.supabase.co", "sync.powersync.journeyapps.com"],
    resolveOverrides: {
      "proj.supabase.co": {host: "127.0.0.1", port: allowedFixturePort},
      "evil.example.com": {host: "127.0.0.1", port: disallowedFixturePort},
    },
    log: (m) => proxyLogs.push(m),
  });
  check("startAllowlistProxy started on a free TCP port", Number.isInteger(proxy.port) && proxy.port > 0 && proxy.alive(), proxy);

  function sendConnect(proxyPort, rawRequest) {
    return new Promise((resolve) => {
      const c = net.connect({host: "127.0.0.1", port: proxyPort, timeout: 4000}, () => {
        c.write(rawRequest);
      });
      let buf = "";
      let connected = false;
      c.on("data", (d) => {
        buf += d.toString("utf8");
        if (!connected && buf.includes("\r\n\r\n")) {
          const [head, rest] = buf.split("\r\n\r\n");
          const firstLine = (head.split("\r\n")[0] || "").trim();
          const status = Number(firstLine.split(/\s+/)[1] || 0);
          if (status === 200) {
            connected = true;
            buf = rest || "";
            c.write("HELLO_SUPABASE\n");
          } else {
            c.destroy();
            resolve({status, firstLine, body: rest || ""});
          }
        } else if (connected && buf.includes("SUPABASE_OK_200")) {
          c.destroy();
          resolve({status: 200, tunneledBody: buf.trim()});
        }
      });
      c.on("error", (e) => resolve({error: e.code || e.message}));
    });
  }

  // 1) CONNECT to an allowed host on port 443 succeeds and tunnels bytes
  const resAllowed = await sendConnect(proxy.port, "CONNECT proj.supabase.co:443 HTTP/1.1\r\nHost: proj.supabase.co:443\r\n\r\n");
  check("CONNECT to allowed host:443 succeeds (200) and tunnels traffic to target",
    resAllowed.status === 200 && resAllowed.tunneledBody === "SUPABASE_OK_200" && allowedFixture.hits() === 1, {resAllowed, allowedHits: allowedFixture.hits()});

  // 2) CONNECT to a non-allowed host is refused with 403 and logged
  const resDisallowed = await sendConnect(proxy.port, "CONNECT evil.example.com:443 HTTP/1.1\r\nHost: evil.example.com:443\r\n\r\n");
  check("CONNECT to non-allowed host is refused with 403 and never reaches target",
    resDisallowed.status === 403 && disallowedFixture.hits() === 0, {resDisallowed, disallowedHits: disallowedFixture.hits()});

  // 3) CONNECT to an allowed host on a non-443 port is refused with 403 and logged
  const hitsBeforeBadPort = allowedFixture.hits();
  const resBadPort = await sendConnect(proxy.port, "CONNECT proj.supabase.co:80 HTTP/1.1\r\nHost: proj.supabase.co:80\r\n\r\n");
  check("CONNECT to non-443 port is refused with 403",
    resBadPort.status === 403 && allowedFixture.hits() === hitsBeforeBadPort, {resBadPort, allowedHits: allowedFixture.hits()});
  const hitsBefore8443 = allowedFixture.hits();
  const resPort8443 = await sendConnect(proxy.port, "CONNECT proj.supabase.co:8443 HTTP/1.1\r\nHost: proj.supabase.co:8443\r\n\r\n");
  check("CONNECT to port 8443 is refused with 403",
    resPort8443.status === 403 && allowedFixture.hits() === hitsBefore8443, {resPort8443, allowedHits: allowedFixture.hits()});

  // 4) Non-CONNECT HTTP method is refused with 403 and logged
  const resGet = await sendConnect(proxy.port, "GET http://proj.supabase.co/ HTTP/1.1\r\nHost: proj.supabase.co\r\n\r\n");
  check("non-CONNECT HTTP request is refused with 403", resGet.status === 403, resGet);

  await new Promise((r) => setTimeout(r, 150));
  const logs = proxy.logs();
  check("proxy logged allowed CONNECT and all 403 refusals (host_not_allowed, port_not_443, method)",
    logs.some((l) => l.includes("ALLOWED CONNECT proj.supabase.co:443"))
    && logs.some((l) => l.includes("REFUSED 403") && l.includes("evil.example.com:443") && l.includes("host_not_allowed"))
    && logs.some((l) => l.includes("REFUSED 403") && l.includes("proj.supabase.co:80") && l.includes("port_not_443"))
    && logs.some((l) => l.includes("REFUSED 403") && l.includes("only CONNECT allowed")),
    logs);

  const proxyPid = proxy.pid;
  proxy.stop();
  await new Promise((r) => setTimeout(r, 100));
  let stillAlive = false;
  try { process.kill(proxyPid, 0); stillAlive = true; } catch {}
  check("proxy process is gone after stop()", !stillAlive && !proxy.alive());

  // 1b) Unix-socket bridge -> host allowlist proxy (same NS_FORWARDER_SCRIPT +
  // startAllowlistProxy({sockPath}) pipeline as startAppSession host-bridge mode):
  const sockDir = makeSocketDir();
  const proxySockPath = path.join(sockDir, "proxy.sock");
  const sockProxy = await startAllowlistProxy({
    sockPath: proxySockPath,
    allowHosts: ["proj.supabase.co"],
    resolveOverrides: {
      "proj.supabase.co": {host: "127.0.0.1", port: allowedFixturePort},
      "evil.example.com": {host: "127.0.0.1", port: disallowedFixturePort},
    },
  });
  // Spawn a local TCP -> unix socket forwarder on a free port (identical to NS_FORWARDER_SCRIPT)
  const forwarderServer = net.createServer((c) => {
    const u = net.connect(proxySockPath);
    c.pipe(u);
    u.pipe(c);
    const end = () => { c.destroy(); u.destroy(); };
    c.on("error", end);
    u.on("error", end);
    c.on("close", end);
    u.on("close", end);
  });
  await new Promise((r) => forwarderServer.listen(0, "127.0.0.1", r));
  const fwdPort = forwarderServer.address().port;

  const hitsBeforeBridge = allowedFixture.hits();
  const resBridgeAllowed = await sendConnect(fwdPort, "CONNECT proj.supabase.co:443 HTTP/1.1\r\nHost: proj.supabase.co:443\r\n\r\n");
  check("unix-socket bridge -> host proxy: CONNECT to allowed host:443 succeeds (200) and tunnels traffic",
    resBridgeAllowed.status === 200 && resBridgeAllowed.tunneledBody === "SUPABASE_OK_200" && allowedFixture.hits() === hitsBeforeBridge + 1,
    {resBridgeAllowed, allowedHits: allowedFixture.hits(), hitsBeforeBridge});

  const resBridgeDenied = await sendConnect(fwdPort, "CONNECT evil.example.com:443 HTTP/1.1\r\nHost: evil.example.com:443\r\n\r\n");
  check("unix-socket bridge -> host proxy: CONNECT to non-allowed host is refused with 403",
    resBridgeDenied.status === 403 && disallowedFixture.hits() === 0,
    {resBridgeDenied, disallowedHits: disallowedFixture.hits()});

  const hitsBeforeBridgeBadPort = allowedFixture.hits();
  const resBridgeBadPort = await sendConnect(fwdPort, "CONNECT proj.supabase.co:8443 HTTP/1.1\r\nHost: proj.supabase.co:8443\r\n\r\n");
  check("unix-socket bridge -> host proxy: CONNECT to non-443 port is refused with 403",
    resBridgeBadPort.status === 403 && allowedFixture.hits() === hitsBeforeBridgeBadPort,
    {resBridgeBadPort, allowedHits: allowedFixture.hits()});

  forwarderServer.close();
  sockProxy.stop();
  try { fs.rmSync(sockDir, {recursive: true, force: true}); } catch {}

  allowedFixture.close();
  disallowedFixture.close();

  // 5) Verify ap-browser-check passes --proxy-server and --proxy-bypass-list to
  // chromium.launch ONLY when allow_hosts is configured, and omits them when
  // allow_hosts is empty.
  const repo = tmp("ap-b7-proxyflag-repo-");
  spawnSync("git", ["init", "-q", repo]);
  const pwRuntime = installStubPlaywrightModule(repo);

  // Case A: allow_hosts configured -> --proxy-server=http://127.0.0.1:<proxyPort> and --proxy-bypass-list=127.0.0.1;localhost
  const runDirWithProxy = tmp("ap-b7-withproxy-");
  const scratchWithProxy = path.join(runDirWithProxy, "scratch");
  fs.mkdirSync(scratchWithProxy, {recursive: true});
  const scriptWithProxy = path.join(scratchWithProxy, "check-proxy-args.mjs");
  fs.writeFileSync(scriptWithProxy, `
import {createRequire} from "node:module";
const req = createRequire(process.env.AUTOPILOT_PLAYWRIGHT_MODULE_ROOT + "/noop.js");
const {chromium} = req("playwright");
const browser = await chromium.launch();
console.log("LAUNCH_ARGS=" + JSON.stringify(browser.launchOpts?.args || []));
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.screenshot({path: "proxy-shot.png"});
await ctx.close();
await browser.close();
`);
  const rWithProxy = runVerifierBrowserCheck({
    scriptPath: scriptWithProxy,
    repo,
    runDir: runDirWithProxy,
    scratchDir: scratchWithProxy,
    appSession: {
      baseUrl: "http://127.0.0.1:4100",
      port: 4100,
      mode: "host-bridge",
      allowHosts: ["proj.supabase.co"],
      proxyPort: 45678,
      proxyUrl: "http://127.0.0.1:45678",
    },
    appCfg: {start_command: "node s.js", allow_hosts: ["proj.supabase.co"]},
    playwrightRuntime: pwRuntime,
    useEnvelope: false,
  });
  check("ap-browser-check with allow_hosts launches Chromium with --proxy-server and --proxy-bypass-list=127.0.0.1;localhost",
    rWithProxy.ok === true
    && rWithProxy.stdout.includes("--proxy-server=http://127.0.0.1:45678")
    && rWithProxy.stdout.includes(`--proxy-bypass-list=${BROWSER_PROXY_BYPASS_LIST}`),
    rWithProxy.stdout);

  // Case B: no allow_hosts -> no --proxy-server flag passed to Chromium
  const runDirNoProxy = tmp("ap-b7-noproxy-");
  const scratchNoProxy = path.join(runDirNoProxy, "scratch");
  fs.mkdirSync(scratchNoProxy, {recursive: true});
  const scriptNoProxy = path.join(scratchNoProxy, "check-noproxy-args.mjs");
  fs.writeFileSync(scriptNoProxy, fs.readFileSync(scriptWithProxy, "utf8"));
  const rNoProxy = runVerifierBrowserCheck({
    scriptPath: scriptNoProxy,
    repo,
    runDir: runDirNoProxy,
    scratchDir: scratchNoProxy,
    appSession: {
      baseUrl: "http://127.0.0.1:4100",
      port: 4100,
      mode: "namespace",
      allowHosts: [],
      proxyPort: null,
      proxyUrl: null,
    },
    appCfg: {start_command: "node s.js"},
    playwrightRuntime: pwRuntime,
    useEnvelope: false,
  });
  check("ap-browser-check without allow_hosts launches Chromium with NO --proxy-server flag (browser stays fully closed)",
    rNoProxy.ok === true
    && !rNoProxy.stdout.includes("--proxy-server=")
    && !rNoProxy.stdout.includes("--proxy-bypass-list="),
    rNoProxy.stdout);
}

// --- 7. Real bwrap + isolated netns + Chromium e2e (when bwrap available) --
console.log("7. Real bubblewrap + isolated network namespace + headless Chromium e2e");
{
  const probeRepo = tmp("ap-b7-bwrap-probe-");
  const probeScratch = tmp("ap-b7-bwrap-scratch-");
  const bwrapProbe = buildExecutionEnvelope({repo: probeRepo, scratchDir: probeScratch, readOnly: true, config: {}, binary: process.execPath, args: ["-e", "process.exit(0)"]});
  const netnsAvailable = Boolean(networkIsolationPrefix() && spawnSync("sh", ["-c", "command -v nsenter"]).status === 0);
  const hostPw = discoverPlaywrightRuntime({repository: skillRootDir, skillRoot: skillRootDir});

  if (!bwrapProbe.available || !netnsAvailable || !hostPw.readyForLaunchProbe) {
    console.log(`  skip (needs bwrap + unshare/nsenter + Chromium on host: bwrap=${bwrapProbe.available} (${bwrapProbe.reason || "ok"}), netns=${netnsAvailable}, pw=${hostPw.readyForLaunchProbe})`);
  } else {
    const repo = tmp("ap-b7-e2e-repo-");
    spawnSync("git", ["init", "-q", repo]);
    fs.writeFileSync(path.join(repo, ".env.test"), `E2E_SUPER_ADMIN_EMAIL=admin@clinixhub.test\nE2E_SUPER_ADMIN_PASSWORD=${SECRET_MARKER}\n`);
    const appCfg = {
      start_command: `node ${JSON.stringify(FIXTURE_SERVER)}`,
      port: "auto",
      ready_url: "/ready",
      warmup_urls: ["/ar/login"],
      ready_timeout_ms: 20000,
      env_file: ".env.test",
      env: {FIXTURE_DELAY_MS: "100"},
    };
    const sessionRes = await startAppSession({cfg: appCfg, repo, networkIsolation: true});
    check("e2e: isolated network namespace session + fixture app server started", sessionRes.ok === true, sessionRes);
    if (sessionRes.ok) {
      const session = sessionRes.session;
      const runDir = tmp("ap-b7-e2e-rundir-");
      const scratchDir = path.join(runDir, "scratch");
      fs.mkdirSync(scratchDir, {recursive: true});
      const scriptPath = path.join(scratchDir, "real-pw-check.mjs");
      fs.writeFileSync(scriptPath, `
import {createRequire} from "node:module";
const req = createRequire(process.env.AUTOPILOT_PLAYWRIGHT_MODULE_ROOT + "/");
const {chromium} = req("playwright");
console.log("e2e secret check:", process.env.E2E_SUPER_ADMIN_PASSWORD);
const browser = await chromium.launch({args: ["--no-sandbox"]});
const ctx = await browser.newContext();
const page = await ctx.newPage();
const resp = await page.goto(process.env.APP_BASE_URL + "/ar/login", {waitUntil: "domcontentloaded", timeout: 60000});
console.log("e2e status", resp.status());
if (resp.status() !== 200) throw new Error("expected 200, got " + resp.status());
await page.screenshot({path: "/workspace/scratch/login-e2e.png", fullPage: true});
await ctx.close();
await browser.close();
`);
      const r = runVerifierBrowserCheck({
        scriptPath,
        repo,
        runDir,
        scratchDir,
        appSession: session,
        appCfg,
        playwrightRuntime: hostPw,
        useEnvelope: true,
      });
      await session.stop();

      check("e2e: ap-browser-check inside read-only bwrap + isolated netns exited 0", r.ok === true && r.exitCode === 0, {exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, proof: r.proof});
      check("e2e: verifyBrowserProof confirmed script, PNG screenshot, trace.zip and video.webm in runDir",
        r.proof.ok === true && r.proof.screenshots.length >= 1 && r.proof.traces.length >= 1 && r.proof.videos.length >= 1, r.proof);
      const leaked = filesUnder(runDir).filter((f) => fs.readFileSync(f, "utf8").includes(SECRET_MARKER));
      check("e2e: secret marker never appears in any file under runDir", leaked.length === 0, leaked);
    }

    // 7b. In-namespace e2e with allow_hosts CONNECT proxy + bwrap + netns:
    // verify a process inside the read-only bwrap envelope + isolated netns
    // reaches the allowed host fixture on port 443 through the session's proxy,
    // is refused (403) for a non-allowed host and for a non-443 port, and all
    // proxy/bridge processes are gone after session.stop().
    // Run fixture targets as separate child processes so synchronous
    // runVerifierBrowserCheck never blocks their event loop.
    const fixDir = tmp("ap-b7-e2e-fix-");
    const e2eAllowedTarget = await startFixtureTarget({
      expectMatch: "E2E_PING",
      reply: "E2E_PONG_443",
      hitsFile: path.join(fixDir, "allowed.hits"),
    });
    const e2eBlockedTarget = await startFixtureTarget({
      expectMatch: null,
      reply: "E2E_BLOCKED",
      hitsFile: path.join(fixDir, "blocked.hits"),
    });

    const appCfgProxy = {
      ...appCfg,
      allow_hosts: ["allowed.supabase.co"],
    };
    const proxySessionRes = await startAppSession({
      cfg: appCfgProxy,
      repo,
      networkIsolation: true,
      proxyResolveOverrides: {
        "allowed.supabase.co": {host: "127.0.0.1", port: e2eAllowedTarget.port},
        "blocked.example.com": {host: "127.0.0.1", port: e2eBlockedTarget.port},
      },
    });
    check("e2e proxy: host-bridge session with allow_hosts started",
      proxySessionRes.ok === true && proxySessionRes.session.mode === "host-bridge" && Number.isInteger(proxySessionRes.session.proxyPort),
      proxySessionRes);
    if (proxySessionRes.ok) {
      const pSession = proxySessionRes.session;
      const runDirP = tmp("ap-b7-e2e-proxy-rundir-");
      const scratchDirP = path.join(runDirP, "scratch");
      fs.mkdirSync(scratchDirP, {recursive: true});
      const scriptPathP = path.join(scratchDirP, "real-pw-proxy-check.mjs");
      fs.writeFileSync(scriptPathP, `
import net from "node:net";
import {createRequire} from "node:module";
const req = createRequire(process.env.AUTOPILOT_PLAYWRIGHT_MODULE_ROOT + "/");
const {chromium} = req("playwright");

const proxyUrl = process.env.AUTOPILOT_BROWSER_PROXY_URL;
if (!proxyUrl) throw new Error("AUTOPILOT_BROWSER_PROXY_URL missing");
const proxyPort = Number(new URL(proxyUrl).port);

const CONNECT_TIMEOUT_MS = 5000;
function connectViaProxy(target) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { c.destroy(); } catch {}
      resolve(val);
    };
    const timer = setTimeout(() => finish({error: "timeout", buf}), CONNECT_TIMEOUT_MS);
    const c = net.connect({host: "127.0.0.1", port: proxyPort}, () => {
      c.write("CONNECT " + target + " HTTP/1.1\\r\\nHost: " + target + "\\r\\n\\r\\n");
    });
    let buf = "";
    let tunneled = false;
    c.on("data", (d) => {
      buf += d.toString("utf8");
      if (!tunneled && buf.includes("\\r\\n\\r\\n")) {
        const [head, rest] = buf.split("\\r\\n\\r\\n");
        const status = Number((head.split("\\r\\n")[0] || "").split(/\\s+/)[1] || 0);
        if (status === 200) {
          tunneled = true;
          buf = rest || "";
          c.write("E2E_PING\\n");
        } else {
          finish({status});
        }
      } else if (tunneled && buf.includes("E2E_PONG_443")) {
        finish({status: 200, body: buf.trim()});
      }
    });
    c.on("error", (e) => finish({error: e.code || e.message}));
    c.on("close", () => finish({error: "closed_early", buf}));
  });
}

// Run all checks independently so every proxy request and browser check is exercised
const okAllowed = await connectViaProxy("allowed.supabase.co:443");
const refusedHost = await connectViaProxy("blocked.example.com:443");
const refusedPort = await connectViaProxy("allowed.supabase.co:8443");

let pageStatus = null;
let pageError = null;
try {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const resp = await page.goto(process.env.APP_BASE_URL + "/ar/login", {waitUntil: "domcontentloaded", timeout: 60000});
  pageStatus = resp.status();
  await page.screenshot({path: "/workspace/scratch/login-proxy-e2e.png", fullPage: true});
  await ctx.close();
  await browser.close();
} catch (err) {
  pageError = err?.message || String(err);
}

console.log("E2E_PROXY_SUMMARY=" + JSON.stringify({okAllowed, refusedHost, refusedPort, pageStatus, pageError}));
if (okAllowed.status !== 200 || okAllowed.body !== "E2E_PONG_443") {
  throw new Error("allowed CONNECT failed: " + JSON.stringify(okAllowed));
}
if (refusedHost.status !== 403) {
  throw new Error("expected 403 for blocked.example.com:443, got " + JSON.stringify(refusedHost));
}
if (refusedPort.status !== 403) {
  throw new Error("expected 403 for allowed.supabase.co:8443, got " + JSON.stringify(refusedPort));
}
if (pageStatus !== 200) {
  throw new Error("APP_BASE_URL direct via bypass failed: " + (pageError || pageStatus));
}
console.log("E2E_PROXY_ALL_OK");
`);
      const rp = runVerifierBrowserCheck({
        scriptPath: scriptPathP,
        repo,
        runDir: runDirP,
        scratchDir: scratchDirP,
        appSession: pSession,
        appCfg: appCfgProxy,
        playwrightRuntime: hostPw,
        useEnvelope: true,
      });
      // Wait briefly so the proxy child process stderr pipe drains into the
      // parent event loop after the synchronous runVerifierBrowserCheck call.
      await new Promise((r) => setTimeout(r, 200));
      const bridgePids = [...pSession.bridgePids];
      const logs = pSession.proxyLogs();
      const e2eAllowedHits = e2eAllowedTarget.hits();
      const e2eBlockedHits = e2eBlockedTarget.hits();
      await pSession.stop();

      check("e2e proxy: in-namespace bwrap + Chromium reached allowed fixture via proxy, got 403 for non-allowed host/port, and loaded APP_BASE_URL directly",
        rp.ok === true && rp.exitCode === 0 && rp.stdout.includes("E2E_PROXY_ALL_OK") && e2eAllowedHits === 1 && e2eBlockedHits === 0,
        {exitCode: rp.exitCode, stdout: rp.stdout, stderr: rp.stderr, e2eAllowedHits, e2eBlockedHits});
      check("e2e proxy: host proxy logged ALLOWED and REFUSED 403 entries",
        logs.some((l) => l.includes("ALLOWED CONNECT allowed.supabase.co:443"))
        && logs.some((l) => l.includes("REFUSED 403") && l.includes("blocked.example.com:443"))
        && logs.some((l) => l.includes("REFUSED 403") && l.includes("allowed.supabase.co:8443")),
        logs);
      const anyAlive = bridgePids.some((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
      check("e2e proxy: proxy and bridge processes are gone after session stops", !anyAlive, bridgePids);
    }
    e2eAllowedTarget.close();
    e2eBlockedTarget.close();
  }
}

// --- 8. Production enveloped verifier inside bwrap calling ap-browser-check
// via the host-side Unix-socket broker (regression for SampleApp 009 run 455:
// nsenter inside bwrap's isolated PID/user namespace always failed with
// `nsenter: cannot open /proc/<holder>/ns/user: No such file or directory`).
console.log("8. Enveloped verifier inside bwrap invokes ap-browser-check via host broker (namespace isolation + sustained holder + stale replacement)");
{
  const probeRepo = tmp("ap-b8-bwrap-probe-");
  const probeScratch = tmp("ap-b8-bwrap-scratch-");
  const bwrapProbe = buildExecutionEnvelope({repo: probeRepo, scratchDir: probeScratch, readOnly: true, config: {}, binary: process.execPath, args: ["-e", "process.exit(0)"]});
  const netnsAvailable = Boolean(networkIsolationPrefix() && spawnSync("sh", ["-c", "command -v nsenter"]).status === 0);

  if (!bwrapProbe.available || !netnsAvailable) {
    console.log(`  skip (needs bwrap + unshare/nsenter: bwrap=${bwrapProbe.available}, netns=${netnsAvailable})`);
  } else {
    // Host-loopback decoy listener that must remain unreachable from inside ap-browser-check.
    let brokerDecoyHits = 0;
    const brokerDecoy = net.createServer((c) => { brokerDecoyHits += 1; c.end("decoy"); });
    await new Promise((r) => brokerDecoy.listen(0, "127.0.0.1", r));
    const brokerDecoyPort = brokerDecoy.address().port;

    const repo = tmp("ap-b8-repo-");
    spawnSync("git", ["init", "-q", repo]);
    fs.writeFileSync(path.join(repo, ".env.test"), `E2E_SUPER_ADMIN_EMAIL=admin@clinixhub.test\nE2E_SUPER_ADMIN_PASSWORD=${SECRET_MARKER}\n`);
    const stubPw = installStubPlaywrightModule(repo);

    const appCfg = {
      start_command: `node ${JSON.stringify(FIXTURE_SERVER)}`,
      port: "auto",
      ready_url: "/ready",
      warmup_urls: ["/ar/login"],
      ready_timeout_ms: 20000,
      env_file: ".env.test",
      env: {FIXTURE_DELAY_MS: "100"},
    };

    const runDir = tmp("ap-b8-rundir-");
    const scratchDir = path.join(runDir, "scratch");
    const guardDir = path.join(scratchDir, "git-guard");
    fs.mkdirSync(guardDir, {recursive: true});

    let activeSession = null;
    const startFresh = async () => {
      if (activeSession) {
        try { await activeSession.stop(); } catch {}
        activeSession = null;
      }
      const res = await startAppSession({cfg: appCfg, repo, networkIsolation: true});
      if (!res.ok) return null;
      activeSession = res.session;
      return activeSession;
    };

    await startFresh();
    check("broker e2e: isolated namespace session started", Boolean(activeSession && activeSession.alive()), activeSession);
    const initialHolderPid = activeSession.holderPid;

    const broker = await startVerifierBrowserBroker({
      repo,
      runDir,
      scratchDir,
      getAppSession: () => activeSession,
      ensureAppSession: startFresh,
      appCfg,
      playwrightRuntime: stubPw,
      config: {},
    });

    const installed = installVerifierBrowserWrapper({
      guardDir,
      runDir,
      scratchDir,
      repo,
      appSession: activeSession,
      appCfg,
      playwrightRuntime: stubPw,
      brokerSocket: broker.sandboxSocketPath,
      brokerToken: broker.token,
    });

    const outerMetaText = fs.readFileSync(installed.metaPath, "utf8");
    check("broker mode: outer .ap-browser-check.json inside scratch does not contain raw secrets or host joinPrefix",
      outerMetaText.includes(BROWSER_BROKER_SANDBOX_SOCKET)
      && !outerMetaText.includes(SECRET_MARKER)
      && !outerMetaText.includes("nsenter"),
      outerMetaText);

    const checkScriptPath = path.join(scratchDir, "bwrap-verifier-check.mjs");
    fs.writeFileSync(checkScriptPath, `
import fs from "node:fs";
import net from "node:net";
import {createRequire} from "node:module";

const req = createRequire(process.env.AUTOPILOT_PLAYWRIGHT_MODULE_ROOT + "/noop.js");
const {chromium} = req("playwright");

const base = process.env.APP_BASE_URL;
if (!base) throw new Error("APP_BASE_URL missing");
console.log("secret check:", process.env.E2E_SUPER_ADMIN_PASSWORD);

// 1) Prove repository is read-only inside brokered browser check
let repoRoError = null;
try { fs.writeFileSync("/workspace/repository/should-fail.txt", "nope"); } catch (e) { repoRoError = e.code; }

// 2) Prove host decoy and outside network are unreachable inside the closed namespace
const tcp = (h, p) => new Promise((r) => {
  const c = net.connect({host: h, port: p, timeout: 2500});
  c.on("connect", () => { c.destroy(); r("connected"); });
  c.on("timeout", () => { c.destroy(); r("timeout"); });
  c.on("error", (e) => r(e.code));
});
const decoy = await tcp("127.0.0.1", ${brokerDecoyPort});
const outside = await tcp("1.1.1.1", 80);

// 3) Run Playwright against APP_BASE_URL
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const resp = await page.goto(base + "/ar/login");
await page.screenshot({path: "/workspace/scratch/brokered-login.png"});
await ctx.close();
await browser.close();

console.log("BROKER_CHECK_SUMMARY=" + JSON.stringify({
  base,
  status: resp.status(),
  repoRoError,
  decoy,
  outside,
}));
if (resp.status() !== 200) throw new Error("unexpected status " + resp.status());
if (repoRoError !== "EROFS" && repoRoError !== "EACCES") throw new Error("repo not read-only: " + repoRoError);
if (decoy !== "ECONNREFUSED") throw new Error("decoy reachable: " + decoy);
if (!["ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL"].includes(outside)) throw new Error("outside reachable: " + outside);
`);

    const runInVerifierEnvelope = (shellCmd) => new Promise((resolve) => {
      const env = buildExecutionEnvelope({
        repo,
        scratchDir,
        readOnly: true,
        config: {},
        binary: "sh",
        args: ["-c", shellCmd],
        playwrightModuleDir: stubPw.module.nodeModulesDir,
        playwrightBrowserRoot: stubPw.browser.root,
        browserBrokerSocket: {host: broker.socketPath, sandbox: broker.sandboxSocketPath},
      });
      const mapped = mapEnvironmentIntoEnvelope({PATH: `${guardDir}:${process.env.PATH}`}, env, repo, scratchDir);
      const child = spawn(env.binary, env.args, {cwd: env.cwd, env: mapped, stdio: ["ignore", "pipe", "pipe"]});
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
      child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
      child.on("close", (status) => resolve({status, stdout, stderr}));
    });

    // Wait beyond the old 1s watchdog interval before running inside the verifier envelope.
    await new Promise((r) => setTimeout(r, 2200));
    check("broker e2e: holder survived idle window before verifier ran ap-browser-check", activeSession.alive() === true);

    // Confirm raw nsenter inside bwrap fails with the exact production error (proving the boundary is real).
    const rawNsenter = await runInVerifierEnvelope(`nsenter -U --preserve-credentials -n -t ${initialHolderPid} -- true`);
    check("broker e2e: raw nsenter inside verifier bwrap fails with missing /proc/<holder>/ns/user",
      rawNsenter.status !== 0 && rawNsenter.stderr.includes(`/proc/${initialHolderPid}/ns/user`),
      rawNsenter);

    // Run ap-browser-check from INSIDE the verifier's bwrap envelope!
    const brokerRun1 = await runInVerifierEnvelope("ap-browser-check /workspace/scratch/bwrap-verifier-check.mjs");
    const proof1 = verifyBrowserProof(runDir);
    check("broker e2e: ap-browser-check from inside verifier bwrap succeeded in closed namespace with read-only repo",
      brokerRun1.status === 0
      && brokerRun1.stdout.includes("BROKER_CHECK_SUMMARY=")
      && brokerRun1.stdout.includes("<E2E_SUPER_ADMIN_PASSWORD>")
      && !brokerRun1.stdout.includes(SECRET_MARKER)
      && brokerDecoyHits === 0,
      {status: brokerRun1.status, stdout: brokerRun1.stdout, stderr: brokerRun1.stderr, brokerDecoyHits});
    check("broker e2e: valid browser proof (script, PNG screenshot, trace, video) recorded in runDir",
      proof1.ok === true && proof1.screenshots.length >= 1 && proof1.traces.length >= 1 && proof1.videos.length >= 1,
      proof1);

    // Security check: symlink escaping scratchDir must be rejected by the broker.
    const escapeLink = path.join(scratchDir, "escape-link.mjs");
    fs.symlinkSync("/etc/hosts", escapeLink);
    const escapeRun = await runInVerifierEnvelope("ap-browser-check /workspace/scratch/escape-link.mjs");
    check("broker e2e: symlink escaping scratch is rejected (exit 2)", escapeRun.status === 2, escapeRun);
    try { fs.rmSync(escapeLink, {force: true}); } catch {}

    // Stale holder replacement mid-verifier: SIGKILL the holder while the verifier
    // envelope is running, verify alive() goes false, and confirm the next
    // ap-browser-check call refreshes the session transparently.
    try { process.kill(-initialHolderPid, "SIGKILL"); } catch { try { process.kill(initialHolderPid, "SIGKILL"); } catch {} }
    const deadUntil = Date.now() + 3000;
    while (activeSession.alive() && Date.now() < deadUntil) await new Promise((r) => setTimeout(r, 25));
    check("broker e2e: dead holder detected immediately via session.alive()", activeSession.alive() === false);

    const brokerRun2 = await runInVerifierEnvelope("ap-browser-check /workspace/scratch/bwrap-verifier-check.mjs");
    const refreshedHolderPid = activeSession?.holderPid;
    check("broker e2e: dead holder mid-verifier is replaced with a fresh isolated session and check succeeds",
      brokerRun2.status === 0
      && Number.isInteger(refreshedHolderPid)
      && refreshedHolderPid !== initialHolderPid
      && brokerDecoyHits === 0,
      {status: brokerRun2.status, initialHolderPid, refreshedHolderPid, stderr: brokerRun2.stderr, stdout: brokerRun2.stdout});

    const brokerSocketHost = broker.socketPath;
    broker.close();
    finalizeVerifierBrowserArtifacts({runDir, scratchDir, guardDir});
    await activeSession.stop();
    brokerDecoy.close();

    check("broker e2e: broker socket dir removed on close", !fs.existsSync(brokerSocketHost));
    const leakedB8 = filesUnder(runDir).filter((f) => fs.readFileSync(f, "utf8").includes(SECRET_MARKER));
    check("broker e2e: raw secret never appears in any file under runDir", leakedB8.length === 0, leakedB8);

    // 8b. Enveloped verifier inside bwrap calling ap-browser-check via broker
    // in host-bridge (allow_hosts) mode: verify CONNECT proxy allows only
    // allow_hosts:443, refuses non-allowed hosts/ports with 403, and keeps
    // direct host loopback decoys unreachable.
    const b8ProxyFixDir = tmp("ap-b8-proxyfix-");
    const b8AllowedTarget = await startFixtureTarget({
      expectMatch: "B8_PING",
      reply: "B8_PONG_443",
      hitsFile: path.join(b8ProxyFixDir, "allowed.hits"),
    });
    const b8BlockedTarget = await startFixtureTarget({
      expectMatch: null,
      reply: "B8_BLOCKED",
      hitsFile: path.join(b8ProxyFixDir, "blocked.hits"),
    });
    const b8ProxyCfg = {...appCfg, allow_hosts: ["allowed.supabase.co"]};
    const b8ProxySessionRes = await startAppSession({
      cfg: b8ProxyCfg,
      repo,
      networkIsolation: true,
      proxyResolveOverrides: {
        "allowed.supabase.co": {host: "127.0.0.1", port: b8AllowedTarget.port},
        "blocked.example.com": {host: "127.0.0.1", port: b8BlockedTarget.port},
      },
    });
    check("broker allow_hosts e2e: host-bridge session started",
      b8ProxySessionRes.ok === true && b8ProxySessionRes.session.mode === "host-bridge", b8ProxySessionRes);
    if (b8ProxySessionRes.ok) {
      const b8ProxySession = b8ProxySessionRes.session;
      const runDir8b = tmp("ap-b8-proxy-rundir-");
      const scratchDir8b = path.join(runDir8b, "scratch");
      const guardDir8b = path.join(scratchDir8b, "git-guard");
      fs.mkdirSync(guardDir8b, {recursive: true});
      const broker8b = await startVerifierBrowserBroker({
        repo,
        runDir: runDir8b,
        scratchDir: scratchDir8b,
        getAppSession: () => b8ProxySession,
        appCfg: b8ProxyCfg,
        playwrightRuntime: stubPw,
        config: {},
      });
      installVerifierBrowserWrapper({
        guardDir: guardDir8b,
        runDir: runDir8b,
        scratchDir: scratchDir8b,
        repo,
        appSession: b8ProxySession,
        appCfg: b8ProxyCfg,
        playwrightRuntime: stubPw,
        brokerSocket: broker8b.sandboxSocketPath,
        brokerToken: broker8b.token,
      });
      const script8b = path.join(scratchDir8b, "proxy-broker-check.mjs");
      fs.writeFileSync(script8b, `
import net from "node:net";
import {createRequire} from "node:module";
const req = createRequire(process.env.AUTOPILOT_PLAYWRIGHT_MODULE_ROOT + "/noop.js");
const {chromium} = req("playwright");
const proxyUrl = process.env.AUTOPILOT_BROWSER_PROXY_URL;
if (!proxyUrl) throw new Error("AUTOPILOT_BROWSER_PROXY_URL missing");
const proxyPort = Number(new URL(proxyUrl).port);
function connectViaProxy(target) {
  return new Promise((resolve) => {
    let settled = false, buf = "", tunneled = false;
    const finish = (v) => { if (settled) return; settled = true; clearTimeout(t); try { c.destroy(); } catch {} resolve(v); };
    const t = setTimeout(() => finish({error: "timeout"}), 5000);
    const c = net.connect({host: "127.0.0.1", port: proxyPort}, () => {
      c.write("CONNECT " + target + " HTTP/1.1\\r\\nHost: " + target + "\\r\\n\\r\\n");
    });
    c.on("data", (d) => {
      buf += d.toString("utf8");
      if (!tunneled && buf.includes("\\r\\n\\r\\n")) {
        const [head, rest] = buf.split("\\r\\n\\r\\n");
        const status = Number((head.split("\\r\\n")[0] || "").split(/\\s+/)[1] || 0);
        if (status === 200) { tunneled = true; buf = rest || ""; c.write("B8_PING\\n"); }
        else finish({status});
      } else if (tunneled && buf.includes("B8_PONG_443")) {
        finish({status: 200, body: buf.trim()});
      }
    });
    c.on("error", (e) => finish({error: e.code || e.message}));
    c.on("close", () => finish({error: "closed_early"}));
  });
}
const okAllowed = await connectViaProxy("allowed.supabase.co:443");
const badHost = await connectViaProxy("blocked.example.com:443");
const badPort = await connectViaProxy("allowed.supabase.co:8443");
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const resp = await page.goto(process.env.APP_BASE_URL + "/ar/login");
await page.screenshot({path: "/workspace/scratch/b8-proxy.png"});
await ctx.close();
await browser.close();
if (okAllowed.status !== 200 || okAllowed.body !== "B8_PONG_443") throw new Error("allowed failed: " + JSON.stringify(okAllowed));
if (badHost.status !== 403) throw new Error("badHost not 403: " + JSON.stringify(badHost));
if (badPort.status !== 403) throw new Error("badPort not 403: " + JSON.stringify(badPort));
if (resp.status() !== 200) throw new Error("app status " + resp.status());
console.log("B8_PROXY_OK");
`);
      const env8b = buildExecutionEnvelope({
        repo,
        scratchDir: scratchDir8b,
        readOnly: true,
        config: {},
        binary: "sh",
        args: ["-c", "ap-browser-check /workspace/scratch/proxy-broker-check.mjs"],
        playwrightModuleDir: stubPw.module.nodeModulesDir,
        playwrightBrowserRoot: stubPw.browser.root,
        browserBrokerSocket: {host: broker8b.socketPath, sandbox: broker8b.sandboxSocketPath},
      });
      const mapped8b = mapEnvironmentIntoEnvelope({PATH: `${guardDir8b}:${process.env.PATH}`}, env8b, repo, scratchDir8b);
      const run8b = await new Promise((resolve) => {
        const ch = spawn(env8b.binary, env8b.args, {cwd: env8b.cwd, env: mapped8b, stdio: ["ignore", "pipe", "pipe"]});
        let stdout = "", stderr = "";
        ch.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
        ch.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
        ch.on("close", (status) => resolve({status, stdout, stderr}));
      });
      const proof8b = verifyBrowserProof(runDir8b);
      broker8b.close();
      finalizeVerifierBrowserArtifacts({runDir: runDir8b, scratchDir: scratchDir8b, guardDir: guardDir8b});
      await b8ProxySession.stop();
      check("broker allow_hosts e2e: enveloped verifier reached allowed host:443 via proxy, got 403 for blocked host/port, and recorded valid proof",
        run8b.status === 0 && run8b.stdout.includes("B8_PROXY_OK") && proof8b.ok === true && b8AllowedTarget.hits() === 1 && b8BlockedTarget.hits() === 0,
        {status: run8b.status, stdout: run8b.stdout, stderr: run8b.stderr, proof8b, allowedHits: b8AllowedTarget.hits(), blockedHits: b8BlockedTarget.hits()});
    }
    b8AllowedTarget.close();
    b8BlockedTarget.close();

    // 8c. Broker exception containment: throwing inside the broker request path
    // or failing child spawn (ENOENT) must never produce an unhandledRejection,
    // must mask secrets in error output, and must keep the broker alive for
    // subsequent requests.
    const unhandled = [];
    const onUnhandled = (reason) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    let session8c = null;
    try {
      const started8c = await startAppSession({cfg: appCfg, repo, networkIsolation: true});
      check("broker fault containment: live session started for recovery probe", started8c.ok === true, started8c);
      if (started8c.ok) {
        session8c = started8c.session;
        const runDir8c = tmp("ap-b8-fault-rundir-");
        const scratchDir8c = path.join(runDir8c, "scratch");
        fs.mkdirSync(scratchDir8c, {recursive: true});
        const script8c = path.join(scratchDir8c, "fault-check.mjs");
        fs.writeFileSync(script8c, `console.log("FAULT_RECOVERY_OK");\n`);

        let mode8c = "throw";
        const broker8c = await startVerifierBrowserBroker({
          repo,
          runDir: runDir8c,
          scratchDir: scratchDir8c,
          getAppSession: () => {
            if (mode8c === "throw") {
              throw new Error(`simulated broker failure with secret ${SECRET_MARKER}`);
            }
            if (mode8c === "bad-spawn") {
              return {
                ...session8c,
                alive: () => true,
                joinPrefix: ["/nonexistent-autopilot-nsenter-bin"],
              };
            }
            return session8c;
          },
          appCfg,
          playwrightRuntime: stubPw,
          config: {},
        });

        const callBroker = (payload) => new Promise((resolve, reject) => {
          let buf = "";
          const c = net.connect(broker8c.socketPath, () => {
            c.write(JSON.stringify(payload) + "\n");
          });
          c.on("data", (d) => {
            buf += d.toString("utf8");
            const nl = buf.indexOf("\n");
            if (nl === -1) return;
            c.end();
            try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); }
          });
          c.on("error", reject);
        });

        const baseReq = {
          token: broker8c.token,
          scriptArg: "/workspace/scratch/fault-check.mjs",
          resolvedScript: "/workspace/scratch/fault-check.mjs",
          scriptRestArgs: [],
          cwd: "/workspace/repository",
        };

        // 1) Throw inside broker path (with secret in error message)
        const respThrow = await callBroker(baseReq);
        check("broker fault containment: thrown error returns non-zero masked failure without raw secret",
          respThrow.exitCode === 1
          && typeof respThrow.error === "string"
          && respThrow.error.includes("<E2E_SUPER_ADMIN_PASSWORD>")
          && !respThrow.error.includes(SECRET_MARKER),
          respThrow);

        // 2) Unavailable spawn binary (ENOENT -> error + close idempotency)
        mode8c = "bad-spawn";
        const respBadSpawn = await callBroker(baseReq);
        check("broker fault containment: failing spawn returns non-zero failure cleanly",
          respBadSpawn.exitCode === 1 && typeof respBadSpawn.error === "string" && respBadSpawn.error.length > 0,
          respBadSpawn);

        // 3) Broker stays alive and serves subsequent healthy request normally
        mode8c = "ok";
        const respRecovered = await callBroker(baseReq);
        check("broker fault containment: broker remains alive and serves healthy request after prior failures",
          respRecovered.exitCode === 0 && (respRecovered.stdout || "").includes("FAULT_RECOVERY_OK"),
          respRecovered);

        broker8c.close();
        await new Promise((r) => setImmediate(r));
        check("broker fault containment: zero unhandledRejection events emitted", unhandled.length === 0, unhandled);
      }
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      if (session8c) { try { await session8c.stop(); } catch {} }
    }
  }
}

for (const d of tmpDirs) {
  try { fs.rmSync(d, {recursive: true, force: true}); } catch {}
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
