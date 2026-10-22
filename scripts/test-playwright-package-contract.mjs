#!/usr/bin/env node
// Task 15.4C4A: Playwright package/provisioning contract only.
//
// Proves, against the REAL package manager state (no mocks, no Chromium
// launch):
//   1. package.json declares `playwright` (not only playwright-core) as an
//      exact pinned runtime dependency, keeps Node >=18, exposes an explicit
//      Chromium-only install script, and has no postinstall hook that could
//      silently download browsers during `npm install` / `npm ci`.
//   2. package-lock.json is internally consistent with that declaration.
//   3. The installed skill-local module is detected by the REAL
//      discoverPlaywrightRuntime() `skill` candidate.
//   4. Browser absence is still reported honestly (isolated home/cache dirs
//      so the result never depends on this machine's real browser cache)
//      under both the Native Windows and the WSL/Linux cache conventions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {discoverPlaywrightRuntime} from "./playwright-runtime.mjs";

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  return false;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");

const pkg = JSON.parse(fs.readFileSync(path.join(skillRoot, "package.json"), "utf8"));
const declared = pkg.dependencies?.playwright;

check("playwright version is pinned to exactly 1.61.1",
  declared === "1.61.1", declared);

check("playwright is declared as a runtime dependency (not only playwright-core)",
  typeof declared === "string" && declared.length > 0, declared);
check("playwright version is pinned exactly (no ^, ~, *, latest, or range)",
  typeof declared === "string" && /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(declared) && !/[*^~><= ]/.test(declared), declared);
check("no playwright-core-only substitution",
  !pkg.dependencies?.["playwright-core"] || typeof declared === "string", pkg.dependencies);
check("Node >=18 support is kept",
  typeof pkg.engines?.node === "string" && pkg.engines.node.includes("18"), pkg.engines);

const installScript = pkg.scripts?.["playwright:install"];
check("explicit Chromium install script exists",
  typeof installScript === "string" && installScript.length > 0, installScript);
check("install script targets only Chromium (no firefox/webkit)",
  typeof installScript === "string" && /chromium/.test(installScript) && !/firefox|webkit/.test(installScript), installScript);
check("install script uses the Playwright CLI",
  typeof installScript === "string" && /playwright\s+install/.test(installScript), installScript);
check("no postinstall hook downloads browsers automatically",
  pkg.scripts?.postinstall === undefined && pkg.scripts?.preinstall === undefined, pkg.scripts);

// ---- package-lock.json consistency ----
const lock = JSON.parse(fs.readFileSync(path.join(skillRoot, "package-lock.json"), "utf8"));
check("package-lock.json has a lockfile version",
  lock.lockfileVersion !== undefined || lock.lockVersion !== undefined, lock.lockfileVersion ?? lock.lockVersion);
check("lock root dependencies match the declared playwright version",
  lock.packages?.[""]?.dependencies?.playwright === declared, lock.packages?.[""]?.dependencies);
const lockPwEntry = lock.packages?.["node_modules/playwright"];
check("lock contains a node_modules/playwright entry at the declared version",
  lockPwEntry?.version === declared, lockPwEntry?.version);
const installedPkg = JSON.parse(fs.readFileSync(path.join(skillRoot, "node_modules", "playwright", "package.json"), "utf8"));
check("installed skill-local module is the declared playwright package",
  installedPkg.name === "playwright" && installedPkg.version === declared, `${installedPkg.name}@${installedPkg.version}`);

// ---- real discovery: skill-local module, honest browser absence ----
function isolatedEmptyDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
const emptyHome = isolatedEmptyDir("ap-pw-contract-home-");
const emptyAppData = isolatedEmptyDir("ap-pw-contract-appdata-");
try {
  const base = {
    repository: null,
    skillRoot,
    env: {},
    homeDir: emptyHome,
  };
  const current = discoverPlaywrightRuntime({...base, platform: process.platform, localAppData: emptyAppData});
  check("real discovery finds the skill-local module (source: skill)",
    current.module?.status === "discovered" && current.module?.source === "skill" && current.module?.package === "playwright", current.module);
  check("browser absence is reported honestly (current platform conventions)",
    current.browser?.status === "not-found", current.browser);
  check("not ready for launch probe while the browser cache is absent",
    current.readyForLaunchProbe === false, current.readyForLaunchProbe);

  const win = discoverPlaywrightRuntime({...base, platform: "win32", localAppData: emptyAppData});
  check("real discovery finds the skill-local module (Windows conventions)",
    win.module?.status === "discovered" && win.module?.source === "skill", win.module);
  check("browser absence is reported honestly (Windows cache convention)",
    win.browser?.status === "not-found", win.browser);
} finally {
  for (const dir of [emptyHome, emptyAppData]) {
    try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* best-effort */ }
  }
}

// ---- CI workflow contract (.github/workflows/security-sandbox.yml) ----
// Task 15.4C4B2: the Ubuntu CI job must provision everything explicitly
// (Node, lockfile deps, bubblewrap, Chromium + Linux deps via the pinned
// LOCAL playwright package into a shared explicit browser cache) and finish
// with the full `npm test` suite. Line-order assertions on the raw workflow
// text (no YAML library needed — the file is a flat step list).
const workflowPath = path.join(skillRoot, ".github", "workflows", "security-sandbox.yml");
const workflow = fs.readFileSync(workflowPath, "utf8");
const wlines = workflow.split(/\r?\n/);
// Non-comment workflow content: comments may legitimately document forbidden
// patterns (e.g. "not /tmp/pw-install"), so exclusion checks run against code.
const workflowCode = wlines.filter((line) => !/^\s*#/.test(line)).join("\n");
const windex = (re) => wlines.findIndex((line) => re.test(line));
const wruns = wlines
  .map((line, i) => ({line, i}))
  .filter(({line}) => /^\s*run:\s*\S/.test(line))
  .map(({line, i}) => ({cmd: line.replace(/^\s*run:\s*/, "").trim(), i}));

const idxCheckout = windex(/actions\/checkout@/);
const idxSetupNode = windex(/actions\/setup-node@/);
const nodeVersionMatch = workflow.match(/node-version:\s*["']?([^"'\s]+)["']?/);
const idxNpmCi = windex(/^\s*run:\s*npm ci\s*$/);
const idxBwrapInstall = windex(/apt-get install.*bubblewrap|apt install.*bubblewrap/);
const idxBwrapVersion = windex(/bwrap --version/);
const idxInstallDeps = windex(/npx --no-install playwright install-deps chromium/);
const idxInstallChromium = windex(/npx --no-install playwright install chromium(?!.*install-deps)/);
const npmTestRuns = wruns.filter(({cmd}) => cmd === "npm test");
const idxNpmTest = npmTestRuns.length ? npmTestRuns[npmTestRuns.length - 1].i : -1;

check("CI checks out the repository", idxCheckout >= 0, idxCheckout);
check("CI installs Node via actions/setup-node", idxSetupNode >= 0, idxSetupNode);
check("CI pins a fixed numeric Node version (no lts/*, ranges, or floating tags)",
  nodeVersionMatch !== null && /^\d+\.\d+\.\d+$/.test(nodeVersionMatch[1]), nodeVersionMatch?.[1]);
check("CI pinned Node satisfies engines >=18",
  nodeVersionMatch !== null && Number(nodeVersionMatch[1].split(".")[0]) >= 18, nodeVersionMatch?.[1]);
check("CI runs npm ci from the lockfile", idxNpmCi >= 0, idxNpmCi);
check("CI sets PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD for the npm ci step (no implicit browser download)",
  (() => {
    if (idxNpmCi < 0) return false;
    for (let i = idxNpmCi - 1; i >= 0; i -= 1) {
      const line = wlines[i];
      if (/^\s*-\s+(name|uses):/.test(line) || /^\s*steps:\s*$/.test(line)) break;
      if (/PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:\s*["']?1["']?/.test(line)) return true;
    }
    return /PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:\s*["']?1["']?/.test(workflow.split(/^\s*steps:\s*$/m)[0] ?? "");
  })());
check("CI installs bubblewrap", idxBwrapInstall >= 0, idxBwrapInstall);
check("CI shows bubblewrap capability", idxBwrapVersion >= 0, idxBwrapVersion);
check("CI installs Chromium Linux system deps via the pinned LOCAL playwright CLI",
  idxInstallDeps >= 0, idxInstallDeps);
check("CI installs Chromium via the pinned LOCAL playwright CLI",
  idxInstallChromium >= 0, idxInstallChromium);
const workflowSansLocalInstall = workflow
  .replace(/npx --no-install playwright install-deps chromium/g, "")
  .replace(/npx --no-install playwright install chromium/g, "");
check("CI never depends on a globally installed playwright",
  !/npm\s+(install|i)\s+(-g|--global)\b/.test(workflow)
  && !/playwright\s+install/.test(workflowSansLocalInstall),
  "bare/global playwright install detected");
check("CI defines an explicit shared PLAYWRIGHT_BROWSERS_PATH",
  /PLAYWRIGHT_BROWSERS_PATH:\s*\S+/.test(workflow), undefined);
check("CI browser cache lives under the workflow workspace (not machine-specific, not /tmp/pw-install)",
  (() => {
    const m = workflow.match(/PLAYWRIGHT_BROWSERS_PATH:\s*([^\r\n]+)/);
    if (!m) return false;
    const v = m[1];
    return /github\.workspace/.test(v)
      && !/\/tmp\/pw-install/.test(v)
      && !/\/home\//.test(v)
      && !/[A-Z]:\\/.test(v)
      && !/\/Users\//.test(v);
  })(), workflow.match(/PLAYWRIGHT_BROWSERS_PATH:\s*([^\r\n]+)/)?.[1]);
check("CI has no legacy /tmp/pw-install reference",
  !/\/tmp\/pw-install/.test(workflowCode), undefined);
check("CI provisions in dependency order (checkout < node < npm ci < bwrap < deps < chromium < test)",
  [idxCheckout, idxSetupNode, idxNpmCi, idxBwrapInstall, idxInstallDeps, idxInstallChromium, idxNpmTest]
    .every((v) => v >= 0)
  && [idxCheckout, idxSetupNode, idxNpmCi, idxBwrapInstall, idxInstallDeps, idxInstallChromium, idxNpmTest]
    .every((v, i, a) => i === 0 || a[i - 1] < v),
  [idxCheckout, idxSetupNode, idxNpmCi, idxBwrapInstall, idxInstallDeps, idxInstallChromium, idxNpmTest]);
check("CI runs the full npm test suite exactly as the final validation command",
  npmTestRuns.length >= 1 && wruns[wruns.length - 1].cmd === "npm test", wruns.map((r) => r.cmd));

// ---- no test excluded/skipped/weakened to manufacture success ----
const testAllSrc = fs.readFileSync(path.join(here, "test-all.mjs"), "utf8");
const excludedInSuite = new Set([...testAllSrc.matchAll(/"(test-[\w-]+\.mjs)"/g)].map((m) => m[1]));
// Frozen baseline (must match test-all.mjs exactly): 20 legacy
// security/certification exclusions + 1 unrelated-bug exclusion + test-all.mjs
// itself. Any NEW exclusion fails this contract.
const allowedExcluded = new Set([
  "test-all.mjs",
  "test-install-path-with-spaces.mjs",
  "test-paths-with-spaces.mjs",
  "test-first-run-autopilot.mjs",
  "test-setup-ux.mjs",
  "test-workflow-order-gsd.mjs",
  // Operator-approved 2026-09-30: pre-existing failures (all fail at
  // 1b2e183), each tracked in .autopilot/tasks/backlog.md and to be
  // re-enabled when fixed — NOT exclusions to manufacture success.
  // "test-intra-role-progress-resume.mjs" dropped: re-enabled by backlog #83, 2026-10-12
  // "test-task14-speckit-task-marking.mjs" dropped: re-enabled by backlog #82, 2026-10-12
  "test-setup-runtime-mode-selection.mjs",  // backlog #29
  "test-pwd-authority.mjs",                 // backlog #29
  "test-opencode-shared-cache.mjs",         // backlog #29
]);
const unexpectedExclusions = [...excludedInSuite].filter((f) => !allowedExcluded.has(f));
const missingBaseline = [...allowedExcluded].filter((f) => !excludedInSuite.has(f));
check("no test excluded beyond the frozen documented baseline",
  unexpectedExclusions.length === 0, unexpectedExclusions);
check("frozen baseline exclusions still declared (baseline not silently edited)",
  missingBaseline.length === 0, missingBaseline);
check("test-all.mjs still discovers active tests dynamically from disk",
  /readdirSync/.test(testAllSrc), undefined);
check("test-all.mjs still fails fast on the first failing test (no weakening)",
  /process\.exit\(\s*result\.status/.test(testAllSrc), undefined);
const onDiskTests = fs.readdirSync(here).filter((f) => /^test-.*\.mjs$/.test(f));
const activeOnDisk = onDiskTests.filter((f) => !excludedInSuite.has(f));
check("active test count matches disk minus baseline exclusions (nothing skipped)",
  activeOnDisk.length === onDiskTests.length - excludedInSuite.size && activeOnDisk.length > 0,
  {onDisk: onDiskTests.length, excluded: excludedInSuite.size, active: activeOnDisk.length});

if (failures) {
  console.error(`\n${failures} playwright package-contract check(s) failed.`);
  process.exit(1);
}
console.log("\nplaywright package contract PASS");
