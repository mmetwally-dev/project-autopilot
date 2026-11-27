import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  BROWSER_CHECK_DIR_NAME,
  BROWSER_EVIDENCE_FILE,
  BROWSER_WRAPPER_COMMAND,
  extractUiRoutesFromDelta,
  shouldRefuseVerifierPassForBrowserCheck,
} from "./verifier-browser.mjs";
import { relayVerifierWithAppForTests } from "./autopilot.mjs";

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`PASS: ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${name}`, detail);
  }
}

// 1. Route extraction from delta paths
const clinixPhase20Paths = [
  "apps/web/src/app/[locale]/admin/tenants/page.tsx",
  "apps/web/src/app/[locale]/admin/tenants/[id]/page.tsx",
  "apps/web/src/app/[locale]/admin/tenants/provisioning/[operationId]/page.tsx",
  "apps/web/src/components/TenantTable.tsx",
  "apps/web/src/app/api/admin/tenants/route.ts",
  "apps/web/src/app/[locale]/admin/tenants/page.test.tsx",
];
const routes20 = extractUiRoutesFromDelta(clinixPhase20Paths);
check("extractUiRoutesFromDelta extracts the 3 SampleApp Phase 20 routes",
  JSON.stringify(routes20) === JSON.stringify([
    "/admin/tenants",
    "/admin/tenants/[id]",
    "/admin/tenants/provisioning/[operationId]",
  ]),
  routes20);

const nonUiPhase19Paths = [
  "apps/web/src/components/TenantStatusBadge.tsx",
  "apps/web/src/lib/format.ts",
  "apps/web/src/components/TenantStatusBadge.test.tsx",
];
const routes19 = extractUiRoutesFromDelta(nonUiPhase19Paths);
check("extractUiRoutesFromDelta returns [] for components-only / non-route delta (Phase 19)", routes19.length === 0, routes19);

const pagesAndSvelteRoutes = extractUiRoutesFromDelta([
  "src/pages/settings/index.tsx",
  "src/pages/_app.tsx",
  "src/pages/api/health.ts",
  "src/routes/users/+page.svelte",
]);
check("extractUiRoutesFromDelta handles Pages Router and SvelteKit routes",
  pagesAndSvelteRoutes.includes("/settings") && pagesAndSvelteRoutes.includes("/users") && !pagesAndSvelteRoutes.some((r) => r.includes("_app") || r.includes("api")),
  pagesAndSvelteRoutes);

// 2. Unit tests of shouldRefuseVerifierPassForBrowserCheck
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ap-s15-6-"));
try {
  const emptyRunDir = path.join(tmpRoot, "run-no-browser");
  fs.mkdirSync(emptyRunDir, { recursive: true });

  const passWithoutBrowser = {
    status: "completed",
    runDir: emptyRunDir,
    review: {
      decision: "PASS",
      findings: [],
      notes: ["BROWSER CHECK NOT POSSIBLE: I did not run ap-browser-check in this session"],
    },
  };

  // Case A: UI delta + app server up + PASS without ap-browser-check -> refused once
  const resRefuse = shouldRefuseVerifierPassForBrowserCheck({
    vv: passWithoutBrowser,
    runDir: emptyRunDir,
    deltaPaths: clinixPhase20Paths,
    appServerStarted: true,
    playwrightAvailable: true,
    alreadyRetried: false,
  });
  check("UI delta + app server up + PASS without ap-browser-check -> refused",
    resRefuse.refuse === true && resRefuse.reason === "no_browser_check_run", resRefuse);
  check("retry brief names the routes from the delta and ap-browser-check",
    resRefuse.retryBrief.includes("/admin/tenants")
    && resRefuse.retryBrief.includes("/admin/tenants/[id]")
    && resRefuse.retryBrief.includes("/admin/tenants/provisioning/[operationId]")
    && resRefuse.retryBrief.includes(BROWSER_WRAPPER_COMMAND),
    resRefuse.retryBrief);

  // Case B: alreadyRetried: true -> accepted (refused at most once)
  const resAlreadyRetried = shouldRefuseVerifierPassForBrowserCheck({
    vv: passWithoutBrowser,
    runDir: emptyRunDir,
    deltaPaths: clinixPhase20Paths,
    appServerStarted: true,
    playwrightAvailable: true,
    alreadyRetried: true,
  });
  check("alreadyRetried -> not refused a second time", resAlreadyRetried.refuse === false, resAlreadyRetried);

  // Case C: Non-UI delta -> accepted without retry
  const resNonUi = shouldRefuseVerifierPassForBrowserCheck({
    vv: passWithoutBrowser,
    runDir: emptyRunDir,
    deltaPaths: nonUiPhase19Paths,
    appServerStarted: true,
    playwrightAvailable: true,
    alreadyRetried: false,
  });
  check("non-UI delta -> accepted without retry", resNonUi.refuse === false && resNonUi.reason === "non_ui_delta", resNonUi);

  // Case D: Real wrapper failure (evidence.json written by ap-browser-check with exitCode 1 + output) -> accepted
  const failWrapperRunDir = path.join(tmpRoot, "run-wrapper-failed");
  const bcDir = path.join(failWrapperRunDir, BROWSER_CHECK_DIR_NAME);
  fs.mkdirSync(bcDir, { recursive: true });
  fs.writeFileSync(path.join(bcDir, "output.log"), "Error: OAuth redirect requires external provider\n", "utf8");
  fs.writeFileSync(path.join(bcDir, BROWSER_EVIDENCE_FILE), JSON.stringify({
    command: BROWSER_WRAPPER_COMMAND,
    exitCode: 1,
    outputFile: "output.log",
    outputTail: "Error: OAuth redirect requires external provider",
  }), "utf8");
  const resRealFailure = shouldRefuseVerifierPassForBrowserCheck({
    vv: passWithoutBrowser,
    runDir: failWrapperRunDir,
    deltaPaths: clinixPhase20Paths,
    appServerStarted: true,
    playwrightAvailable: true,
    alreadyRetried: false,
  });
  check("real ap-browser-check failure output -> accepted without retry",
    resRealFailure.refuse === false && resRealFailure.reason === "wrapper_ran_with_output", resRealFailure);

  // Case E: End-to-end through relayVerifierWithAppForTests with a real local HTTP server
  const serverScript = path.join(tmpRoot, "tiny-app-server.mjs");
  fs.writeFileSync(serverScript, [
    'import http from "node:http";',
    'const port = Number(process.env.PORT || 0);',
    'const s = http.createServer((req, res) => { res.writeHead(200); res.end("ok"); });',
    's.listen(port, "127.0.0.1", () => console.log("ready"));',
  ].join("\n"), "utf8");

  const configWithApp = {
    gates: {
      network_isolation: false,
      app_server: {
        start_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(serverScript)}`,
        ready_url: "/health",
        ready_timeout_ms: 10000,
      },
    },
  };
  const fakePwRuntime = { readyForLaunchProbe: true, module: { status: "discovered" }, browser: { status: "discovered" } };

  // E1: UI delta + PASS without ap-browser-check -> relayFn called twice (initial + 1 retry)
  const promptsSeen = [];
  const vvRetried = await relayVerifierWithAppForTests(
    "Verify phase 20",
    configWithApp,
    { phaseIndex: 19 },
    { cwd: tmpRoot, deltaPaths: clinixPhase20Paths, playwrightRuntime: fakePwRuntime },
    async (_role, prompt) => {
      promptsSeen.push(prompt);
      if (promptsSeen.length === 1) {
        return {
          status: "completed",
          runDir: emptyRunDir,
          review: { decision: "PASS", findings: [], notes: ["BROWSER CHECK NOT POSSIBLE: skipped"] },
        };
      }
      return {
        status: "completed",
        runDir: failWrapperRunDir,
        review: { decision: "PASS", findings: [], notes: ["BROWSER CHECK NOT POSSIBLE: real wrapper error"] },
      };
    },
  );
  check("relayVerifierWithApp retries once on UI delta PASS without ap-browser-check",
    promptsSeen.length === 2 && vvRetried.review.decision === "PASS", { calls: promptsSeen.length, vvRetried });
  check("relayVerifierWithApp retry prompt names delta routes",
    promptsSeen[1].includes("/admin/tenants") && promptsSeen[1].includes("BROWSER CHECK REQUIRED (RETRY)"),
    promptsSeen[1]?.slice(-400));

  // E2: Non-UI delta -> relayFn called only once
  let nonUiCalls = 0;
  await relayVerifierWithAppForTests(
    "Verify phase 19",
    configWithApp,
    { phaseIndex: 18 },
    { cwd: tmpRoot, deltaPaths: nonUiPhase19Paths, playwrightRuntime: fakePwRuntime },
    async () => {
      nonUiCalls += 1;
      return { status: "completed", runDir: emptyRunDir, review: { decision: "PASS", findings: [], notes: [] } };
    },
  );
  check("relayVerifierWithApp does not retry on non-UI delta", nonUiCalls === 1, nonUiCalls);

  // 3. Wiring check: both standalone and SpecKit loops pass deltaPaths to relayVerifierWithApp
  const autopilotSrc = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
  const deltaPathMatches = autopilotSrc.match(/deltaPaths\s*:/g) || [];
  check("both standalone and SpecKit verifier sites pass deltaPaths to relayVerifierWithApp",
    deltaPathMatches.length >= 2, deltaPathMatches.length);
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
assert.equal(failed, 0, `${failed} check(s) failed`);
