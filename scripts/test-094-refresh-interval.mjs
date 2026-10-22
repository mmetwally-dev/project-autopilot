#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  makeFixtureRepo, makeFixtureBin, writeConfig, setScenario, cleanup
} from "./test-fixtures/workflow-order-harness.mjs";

const skillRoot = path.dirname(fileURLToPath(import.meta.url));
const failures = [];
const check = (name, cond, details) => {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures.push(name);
    console.error(`FAIL ${name}${details !== undefined ? ` :: ${JSON.stringify(details)}` : ""}`);
  }
};

const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");

// ── Source code checks ────────────────────────────────────────────────────
check("watches refresh interval declared at module level", /let\s+watchRefreshInterval\s*=\s*null/.test(src));

// Verify interval is set in main() context by looking for it near the runImplementation call
// and in the try/finally that surrounds the command dispatch, not in other functions
check("watches refresh interval is set in main with setInterval",
  /watchRefreshInterval\s*=\s*setInterval\s*\(\s*\(\s*\)\s*=>\s*\{\s*try\s*\{\s*watchRefreshTrace\s*\(\s*"tick"\s*\)\s*;\s*refreshWatchReport\s*\(\s*activeRelayState\s*\?\?\s*loadState\s*\(\s*\)\s*\)/.test(src));

check("watches refresh interval uses unref() to not block exit",
  /watchRefreshInterval\s*=\s*setInterval.*\.unref\s*\(\s*\)/.test(src));

check("watches refresh interval cleared in finally block",
  /finally\s*\{[^}]*if\s*\(\s*watchRefreshInterval\s*\)\s*\{[^}]*clearInterval\s*\(\s*wri\s*\)/.test(src));

check("process.on('exit') hook installed for report refresh",
  /process\.on\s*\(\s*["']exit["']\s*,\s*\(\s*\)\s*=>\s*\{\s*if\s*\(\s*activeRelayState\s*\)\s*refreshWatchReport\s*\(\s*activeRelayState\s*\)/.test(src));

check("only one process.on('exit') hook in full source",
  (src.match(/process\.on\s*\(\s*["']exit["']/g) || []).length === 1);

// ── Test-interrupt-flush compatibility ────────────────────────────────────
// The exact pattern from test-interrupt-flush.mjs:28-29
check("exit hook matches test-interrupt-flush contract",
  /process\.on\s*\(\s*["']exit["']\s*,\s*\(\s*\)\s*=>\s*\{\s*if\s*\(\s*activeRelayState\s*\)\s*refreshWatchReport\s*\(\s*activeRelayState\s*\)\s*;\s*\}\s*\)/.test(src));

// ── Additional source code checks ────────────────────────────────────────
check("interval resolves live state with activeRelayState??loadState()",
  /refreshWatchReport\s*\(\s*activeRelayState\s*\?\?\s*loadState\s*\(\s*\)\s*\)/.test(src));

// ── Behavioral checks ──────────────────────────────────────────────────────
// A silent fake run (implementer sleeps 7 s with no events). The test-only
// AUTOPILOT_TEST_REFRESH_TRACE hook records each interval tick and the clear
// (with the Timeout's destroyed flag), so we prove the interval itself fired,
// refreshed the report, and was really cleared when the run ended.
(async () => {
  const prefix = `test-094-refresh-interval-${Date.now()}`;
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  const traceFile = path.join(os.tmpdir(), `${prefix}.trace`);
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    const specsDir = path.join(repo, "specs/999-smoke-test");
    fs.mkdirSync(path.join(specsDir, "checklists"), {recursive: true});
    fs.mkdirSync(path.join(specsDir, "contracts"), {recursive: true});
    for (const [f, t] of [["spec.md", "Spec"], ["plan.md", "Plan"], ["research.md", "Research"], ["data-model.md", "Data Model"], ["quickstart.md", "Quickstart"], ["contracts/health.md", "Contract"]]) {
      fs.writeFileSync(path.join(specsDir, f), `# ${t}\n\n${t}.\n`);
    }
    fs.writeFileSync(path.join(specsDir, "checklists/requirements.md"), "- [ ] Test\n");
    fs.writeFileSync(path.join(specsDir, "tasks.md"), "## Phase 1: Test\n\n- [ ] Task 1 — accept: done ; verify: none\n");
    setScenario(repo, "standalone_silent");

    const missionsDir = path.join(repo, ".autopilot", "missions");
    const reportMtime = () => {
      try {
        const m = fs.readdirSync(missionsDir).sort().pop();
        return m ? fs.statSync(path.join(missionsDir, m, "WATCH-REPORT.md")).mtimeMs : null;
      } catch { return null; }
    };
    const readTrace = () => { try { return fs.readFileSync(traceFile, "utf8").split("\n").filter(Boolean); } catch { return []; } };
    // mtime changes seen within 1.5 s after a new "tick" line appears
    let seenTicks = 0, lastM = null, tickMtimeAdvances = 0, pendingUntil = 0;
    const mon = setInterval(() => {
      const m = reportMtime();
      const ticks = readTrace().filter(l => l === "tick").length;
      if (ticks > seenTicks) { seenTicks = ticks; pendingUntil = Date.now() + 4000; }
      if (m !== null && lastM !== null && m !== lastM && Date.now() <= pendingUntil) { tickMtimeAdvances++; pendingUntil = 0; }
      if (m !== null) lastM = m;
    }, 100);

    const result = await new Promise((resolve) => {
      const proc = spawn(process.execPath, [path.join(skillRoot, "autopilot.mjs"), "run", "test refresh interval", "--repo", repo], {
        cwd: repo,
        env: {...process.env, AUTOPILOT_TEST_REFRESH_TRACE: traceFile, PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`},
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "", stderr = "";
      proc.stdout.on("data", d => stdout += d);
      proc.stderr.on("data", d => stderr += d);
      const timeout = setTimeout(() => { proc.kill(); resolve({status: 124, stdout, stderr}); }, 420000);
      proc.on("close", (code) => { clearTimeout(timeout); resolve({status: code, stdout, stderr}); });
    });
    clearInterval(mon);

    const trace = readTrace();
    const ticks = trace.filter(l => l === "tick").length;
    const clearIdx = trace.findIndex(l => l.startsWith("clear"));
    check("run exits 0", result.status === 0, {status: result.status, stderr: result.stderr.slice(-400)});
    check("interval fired at least once during the silent run", ticks >= 1, trace);
    check("report mtime advanced right after an interval tick", tickMtimeAdvances >= 1, {ticks, tickMtimeAdvances});
    check("interval cleared exactly once, with a destroyed Timeout", trace.filter(l => l.startsWith("clear")).length === 1 && trace[clearIdx] === "clear destroyed=true", trace);
    check("no interval tick after the clear", clearIdx >= 0 && !trace.slice(clearIdx + 1).includes("tick"), trace);
  } finally {
    cleanup(repo);
    try { fs.rmSync(traceFile, {force: true}); } catch {}
  }
  if (failures.length) {
    console.error(`${failures.length} refresh-interval check(s) failed.`);
    process.exit(1);
  }
  console.log("All refresh-interval checks passed.");
})();
