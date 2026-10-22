#!/usr/bin/env node
// Mission 094 Phase 4 task 4.2 — Refresh on finalize, escalation, die()
// Verifies that the refresh hook is properly wired and called on all three paths.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
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
// 1. Refresh hook declared as no-op
check("refreshHook declared as no-op", /let\s+refreshHook\s*=\s*\(\)\s*=>\s*\{\s*\}/.test(src));
check("activeRelayState declared", /let\s+activeRelayState\s*=\s*null/.test(src));
check("die() refreshes through refreshHook when a relay state is active",
  /const\s+die\s*=\s*m\s*=>\s*\{.*if\s*\(\s*activeRelayState\s*\)\s*refreshHook\s*\(\s*activeRelayState\s*,\s*"die"\s*\)/.test(src));
check("refreshHook wraps refreshWatchReport",
  /refreshHook\s*=\s*\(\s*s\s*,\s*tag\s*=\s*"hook"\s*\)\s*=>\s*\{\s*try\s*\{\s*refreshWatchReportTagged\s*\(\s*s\s*,\s*tag\s*\)/.test(src));
check("finalize path refreshes after finalizeRun",
  /finalizeRun\s*\([^;]*\);\s*refreshWatchReportTagged\s*\(\s*s\s*,\s*"finalize"\s*\)/.test(src));
check("process.on('exit') hook refreshes the report",
  /process\.on\s*\(\s*["']exit["']\s*,\s*\(\s*\)\s*=>\s*\{\s*if\s*\(\s*activeRelayState\s*\)\s*refreshWatchReport\s*\(\s*activeRelayState\s*\)/.test(src));

// ── Behavioral checks (fixture harness) ───────────────────────────────────
// AUTOPILOT_TEST_REFRESH_TRACE=<file> makes the orchestrator append a tag per
// refresh trigger ("finalize", "die", ...). Report CONTENT proves the rewrite:
// an escalated stop line cannot appear unless the report was rewritten after
// the mission escalated (earlier refreshes show RUNNING).
function runScenario(label, scenario) {
  const prefix = `test-094-refresh-${label}-${Date.now()}`;
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  const traceFile = path.join(os.tmpdir(), `${prefix}.trace`);
  writeConfig(repo, {planningFramework: "standalone"});
  const specsDir = path.join(repo, "specs/999-smoke-test");
  fs.mkdirSync(path.join(specsDir, "checklists"), {recursive: true});
  fs.mkdirSync(path.join(specsDir, "contracts"), {recursive: true});
  for (const [f, t] of [["spec.md", "Spec"], ["plan.md", "Plan"], ["research.md", "Research"], ["data-model.md", "Data Model"], ["quickstart.md", "Quickstart"], ["contracts/health.md", "Contract"]]) {
    fs.writeFileSync(path.join(specsDir, f), `# ${t}\n\n${t}.\n`);
  }
  fs.writeFileSync(path.join(specsDir, "checklists/requirements.md"), "- [ ] Test\n");
  fs.writeFileSync(path.join(specsDir, "tasks.md"), "## Phase 1: Test\n\n- [ ] Task 1 — accept: done ; verify: none\n");
  setScenario(repo, scenario);
  const startedAt = Date.now();
  const r = spawnSync(process.execPath, [path.join(skillRoot, "autopilot.mjs"), "run", `refresh ${label}`, "--repo", repo], {
    cwd: repo, encoding: "utf8", timeout: 240000, stdio: ["ignore", "pipe", "pipe"],
    env: {...process.env, AUTOPILOT_TEST_REFRESH_TRACE: traceFile, PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`}
  });
  let trace = [];
  try { trace = fs.readFileSync(traceFile, "utf8").split("\n").filter(Boolean); } catch {}
  let report = null, mtimeMs = null;
  try {
    const missionsDir = path.join(repo, ".autopilot", "missions");
    const m = fs.readdirSync(missionsDir).sort().pop();
    const rp = path.join(missionsDir, m, "WATCH-REPORT.md");
    report = fs.readFileSync(rp, "utf8");
    mtimeMs = fs.statSync(rp).mtimeMs;
  } catch {}
  if (process.env.TEST_TIMING) console.error(`[timing] ${label}: ${Date.now()-startedAt}ms`);
  const out = {status: r.status, stderr: r.stderr || "", trace, report, mtimeMs, startedAt, endedAt: Date.now()};
  cleanup(repo);
  try { fs.rmSync(traceFile, {force: true}); } catch {}
  return out;
}

// Finalize: a successful run.
const ok = runScenario("finalize", "standalone_refresh_fast");
check("finalize: run exits 0", ok.status === 0, {status: ok.status, stderr: ok.stderr.slice(-300)});
check("finalize: finalize refresh fired", ok.trace.includes("finalize"), ok.trace);
check("finalize: report rewritten after run start", ok.mtimeMs !== null && ok.mtimeMs >= ok.startedAt, ok.mtimeMs);
check("finalize: final report shows COMPLETED, no CURRENT RUN",
  !!ok.report && /COMPLETED/.test(ok.report) && !ok.report.includes("=== CURRENT RUN ==="), ok.report && ok.report.slice(0, 600));

// Escalation + die(): the implementer fails every attempt -> escalation -> die().
const esc = runScenario("escalation", "implementer_adapter_retryable_always");
check("escalation: run exits non-zero (die)", esc.status !== 0 && esc.status !== null, esc.status);
check("escalation: die() refreshed through the hook", esc.trace.includes("die"), esc.trace);
check("escalation: report rewritten after run start", esc.mtimeMs !== null && esc.mtimeMs >= esc.startedAt, esc.mtimeMs);
check("escalation: report has the ESCALATED stop line",
  !!esc.report && /ESCALATED[^\n]*human intervention required/.test(esc.report), esc.report && esc.report.slice(0, 600));
check("escalation: report has no CURRENT marker",
  !!esc.report && !esc.report.includes("CURRENT RUN"), esc.report && esc.report.slice(0, 600));

if (failures.length) {
  console.error(`\n${failures.length} refresh-terminal check(s) failed.`);
  process.exit(1);
}
console.log("\nAll refresh-terminal checks passed.");
