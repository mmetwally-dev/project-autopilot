import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGitMutationGuard, guardedEnv } from "./relay-guards.mjs";
import { assembleAgentEnvironment } from "./agent-environment.mjs";
import { createGateShell } from "./gate-shell.mjs";
import { killStuckPagers, stuckInteractiveKind, STUCK_PAGER_IDLE_MS } from "./idle-hang-watchdog.mjs";

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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ap-s15-7-"));
try {
  const repoDir = path.join(tmpRoot, "repo");
  const scratchDir = path.join(tmpRoot, "scratch");
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(scratchDir, { recursive: true });

  // 1. guardedEnv sets PLAYWRIGHT_HTML_OPEN=never and BROWSER=none
  const guard = createGitMutationGuard(scratchDir, repoDir);
  const gEnv = guardedEnv(guard, {});
  check("guardedEnv sets PLAYWRIGHT_HTML_OPEN=never", gEnv.PLAYWRIGHT_HTML_OPEN === "never", gEnv.PLAYWRIGHT_HTML_OPEN);
  check("guardedEnv sets BROWSER=none", gEnv.BROWSER === "none", gEnv.BROWSER);

  // 2. assembleAgentEnvironment sets PLAYWRIGHT_HTML_OPEN=never and BROWSER=none
  // for every adapter (implementer/verifier/code_reviewer/etc.), both native and enveloped
  const adapters = ["claude", "codex", "opencode", "gemini", "agy", "cursor-agent"];
  const fakeEnvelope = {
    available: true,
    args: ["--setenv", "HOME", "/workspace/home"],
    sandbox: { repository: "/workspace/repository", scratch: "/workspace/scratch" },
  };
  for (const adapter of adapters) {
    const nativeRes = assembleAgentEnvironment({
      guardedEnv: { ...gEnv, AUTOPILOT_ADAPTER: adapter },
      envelope: null,
      repo: repoDir,
      scratchDir,
      adapterRoleScratchExists: false,
      gatewayActive: false,
    });
    check(`${adapter} native spawnEnv has PLAYWRIGHT_HTML_OPEN=never and BROWSER=none`,
      nativeRes.spawnEnv.PLAYWRIGHT_HTML_OPEN === "never" && nativeRes.spawnEnv.BROWSER === "none",
      { PLAYWRIGHT_HTML_OPEN: nativeRes.spawnEnv.PLAYWRIGHT_HTML_OPEN, BROWSER: nativeRes.spawnEnv.BROWSER });

    const envRes = assembleAgentEnvironment({
      guardedEnv: { ...gEnv, AUTOPILOT_ADAPTER: adapter },
      envelope: fakeEnvelope,
      repo: repoDir,
      scratchDir,
      adapterRoleScratchExists: false,
      gatewayActive: false,
    });
    check(`${adapter} enveloped effectiveEnv has PLAYWRIGHT_HTML_OPEN=never and BROWSER=none`,
      envRes.effectiveEnv.PLAYWRIGHT_HTML_OPEN === "never" && envRes.effectiveEnv.BROWSER === "none",
      { PLAYWRIGHT_HTML_OPEN: envRes.effectiveEnv.PLAYWRIGHT_HTML_OPEN, BROWSER: envRes.effectiveEnv.BROWSER });
  }

  // 3. Gate env (createGateShell) has PLAYWRIGHT_HTML_OPEN=never and BROWSER=none
  const gate = createGateShell(repoDir, repoDir, false);
  check("gate env has PLAYWRIGHT_HTML_OPEN=never", gate.env.PLAYWRIGHT_HTML_OPEN === "never", gate.env.PLAYWRIGHT_HTML_OPEN);
  check("gate env has BROWSER=none", gate.env.BROWSER === "none", gate.env.BROWSER);

  // 4. stuckInteractiveKind + killStuckPagers matches Playwright report server & powershell Start -Wait
  const encodedStartWait = Buffer.from('Start -Wait "http://localhost:9323"', "utf16le").toString("base64");
  const pwShowReportCmd = "node /repo/node_modules/.bin/playwright show-report playwright-report";
  const pwHtmlReporterCmd = "node /repo/node_modules/playwright-core/lib/reporters/html.js --port 9323";
  const psEncodedCmd = `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodedStartWait}`;
  const psPlainCmd = 'powershell.exe -Command Start-Process "http://localhost:9323" -Wait';
  const lessCmd = "/usr/bin/less -R";
  const normalWorkCmd = "node scripts/test-e2e.mjs";
  const normalPsCmd = "powershell.exe -NoProfile -Command Get-Date";

  check("stuckInteractiveKind matches playwright show-report",
    stuckInteractiveKind(pwShowReportCmd)?.kind === "playwright_report", stuckInteractiveKind(pwShowReportCmd));
  check("stuckInteractiveKind matches playwright-core html reporter server",
    stuckInteractiveKind(pwHtmlReporterCmd)?.kind === "playwright_report", stuckInteractiveKind(pwHtmlReporterCmd));
  check("stuckInteractiveKind matches powershell.exe -EncodedCommand Start -Wait",
    stuckInteractiveKind(psEncodedCmd)?.kind === "powershell_start_wait", stuckInteractiveKind(psEncodedCmd));
  check("stuckInteractiveKind matches plaintext powershell.exe Start-Process -Wait",
    stuckInteractiveKind(psPlainCmd)?.kind === "powershell_start_wait", stuckInteractiveKind(psPlainCmd));
  check("stuckInteractiveKind still matches classic pager (less)",
    stuckInteractiveKind(lessCmd)?.kind === "pager", stuckInteractiveKind(lessCmd));
  check("stuckInteractiveKind ignores normal node test command",
    stuckInteractiveKind(normalWorkCmd) === null, stuckInteractiveKind(normalWorkCmd));
  check("stuckInteractiveKind ignores normal powershell command without Start -Wait",
    stuckInteractiveKind(normalPsCmd) === null, stuckInteractiveKind(normalPsCmd));

  // Mock /proc tree under agent pid 1000:
  //   1001: normal node test
  //   1002: playwright show-report
  //   1003: powershell.exe -EncodedCommand Start -Wait
  //   1004: less
  const fakeProc = {
    1000: { children: [1001, 1002, 1003, 1004], stat: "1000 (node) S 1", cmdline: "node adapter.mjs" },
    1001: { children: [], stat: "1001 (node) S 1000", cmdline: normalWorkCmd },
    1002: { children: [], stat: "1002 (node) S 1000", cmdline: pwShowReportCmd },
    1003: { children: [], stat: "1003 (powershell.exe) S 1000", cmdline: psEncodedCmd },
    1004: { children: [], stat: "1004 (less) S 1000", cmdline: lessCmd },
  };
  const readdirSync = (p) => {
    const m = String(p).match(/^\/proc\/(\d+)\/task$/);
    if (m && fakeProc[Number(m[1])]) return [m[1]];
    throw new Error("ENOENT");
  };
  const readFileSync = (p) => {
    const s = String(p);
    let m = s.match(/^\/proc\/(\d+)\/task\/\d+\/children$/);
    if (m && fakeProc[Number(m[1])]) return fakeProc[Number(m[1])].children.join(" ");
    m = s.match(/^\/proc\/(\d+)\/stat$/);
    if (m && fakeProc[Number(m[1])]) return fakeProc[Number(m[1])].stat;
    m = s.match(/^\/proc\/(\d+)\/cmdline$/);
    if (m && fakeProc[Number(m[1])]) return fakeProc[Number(m[1])].cmdline.replace(/ /g, "\0");
    throw new Error("ENOENT");
  };

  const killedCalls = [];
  const watch = { pid: 1000, lastActivityAt: 0, lastSilenceResetAt: 0 };
  const killed = killStuckPagers(watch, {
    now: STUCK_PAGER_IDLE_MS + 1000,
    platform: "linux",
    killFn: (pid, sig) => killedCalls.push({ pid, sig }),
    log: () => {},
    readdirSync,
    readFileSync,
  });
  const killedPids = killedCalls.map((k) => k.pid).sort((a, b) => a - b);
  check("killStuckPagers kills playwright report server, powershell Start -Wait, and less (never normal work)",
    JSON.stringify(killedPids) === JSON.stringify([1002, 1003, 1004]) && killed.length === 3,
    { killedPids, killed });
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
assert.equal(failed, 0, `${failed} check(s) failed`);
