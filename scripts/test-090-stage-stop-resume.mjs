#!/usr/bin/env node
// Mission 090 task 1.3: stage plumbing + planning stop/resume in runImplementation.
// Subprocess cases on disposable fixtures (standalone framework, default fake
// adapter which PASSes planning): `ap run --stage planning` stops after
// planning with state.phase/step persisted and no implementer work; a later
// plain run skips planning and implements (the implement-after-planning-stop
// progression now lives in test-090-stage-stop-resume-loop.mjs).
// Run: node scripts/test-090-stage-stop-resume.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeFixtureRepo, makeFixtureBin, writeConfig, withoutOuterGitGuard, cleanup, skillRoot, readObservedEvents } from "./test-fixtures/workflow-order-harness.mjs";

let failed = 0;
let ran = 0;
const check = (name, ok, detail = "") => {
  ran++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${detail}`}`);
  if (!ok) failed++;
};

function runCommand(repo, binDir, command, args, { timeoutMs = 120000 } = {}) {
  const delimiter = process.platform === "win32" ? ";" : ":";
  const base = withoutOuterGitGuard(process.env);
  delete base.AUTOPILOT_SPEC;
  const env = { ...base, PATH: `${binDir}${delimiter}${base.PATH || ""}` };
  const result = spawnSync(process.execPath,
    [path.join(skillRoot, "scripts", "autopilot.mjs"), command, ...args, "--repo", repo],
    { cwd: repo, encoding: "utf8", env, timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"], shell: false });
  return { status: result.status, timedOut: Boolean(result.error && result.error.code === "ETIMEDOUT"), stdout: result.stdout || "", stderr: result.stderr || "" };
}

const readState = (repo) => JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
const roleCount = (repo, role) => readObservedEvents(repo).filter((e) => e.role === role).length;
const missionPlanFiles = (repo, mission) => ({
  plan: path.join(repo, ".autopilot", "missions", mission, "PLAN.md"),
  tasks: path.join(repo, ".autopilot", "missions", mission, "TASKS.md"),
});

// ── Case 1: --stage planning stops after planning ────────────────────
{
  const repo = makeFixtureRepo("090-stage-planning-stop");
  const binDir = makeFixtureBin("090-stage-planning-stop");
  try {
    writeConfig(repo, { planningFramework: "standalone" });
    const run = runCommand(repo, binDir, "run", ["--stage", "planning", "fixture request"]);
    const combined = `${run.stdout}\n${run.stderr}`;
    const state = readState(repo);
    const files = missionPlanFiles(repo, state.mission);
    check("[planning-stop] ap run --stage planning exits 0",
      run.status === 0 && !run.timedOut, `status=${run.status} timedOut=${run.timedOut} tail=${JSON.stringify(combined.slice(-400))}`);
    check("[planning-stop] stops after planning with a marker",
      /stopping after planning/i.test(combined), `tail=${JSON.stringify(combined.slice(-400))}`);
    check("[planning-stop] state.phase/step persisted as tasks_ready",
      state.phase === "tasks_ready" && state.step === "tasks_ready",
      `phase=${state.phase} step=${state.step}`);
    check("[planning-stop] PLAN.md and TASKS.md exist",
      fs.existsSync(files.plan) && fs.existsSync(files.tasks),
      `mission=${state.mission}`);
    check("[planning-stop] no implementer work ran",
      roleCount(repo, "implementer") === 0, `implementer=${roleCount(repo, "implementer")}`);

    // ── Case 2: a later plain run skips planning and implements ──
    const plannersBefore = roleCount(repo, "planner");
    const resume = runCommand(repo, binDir, "run", ["fixture request"]);
    const resumeCombined = `${resume.stdout}\n${resume.stderr}`;
    check("[planning-resume] later plain run exits 0",
      resume.status === 0 && !resume.timedOut, `status=${resume.status} timedOut=${resume.timedOut} tail=${JSON.stringify(resumeCombined.slice(-400))}`);
    check("[planning-resume] plain run skipped planning (planner count unchanged)",
      roleCount(repo, "planner") === plannersBefore,
      `before=${plannersBefore} after=${roleCount(repo, "planner")}`);
    check("[planning-resume] plain run implemented (implementer ran)",
      roleCount(repo, "implementer") > 0, `implementer=${roleCount(repo, "implementer")}`);
  } finally {
    cleanup(repo, binDir);
  }
}

console.log(failed ? `${failed} of ${ran} case(s) failed.` : `all ${ran} case(s) passed.`);
process.exit(failed ? 1 : 0);
