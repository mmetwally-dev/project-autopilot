#!/usr/bin/env node
// TASK 15.6F — POSIX behavioral proof for the git-invisible-phase guard.
//
// The real incident: Phase 1's only task created an empty docs/ directory.
// Git cannot represent empty directories: the Implementer exited 0 with an
// empty delta, the disposable-copy Verifier could never observe it, and
// Autopilot burned five attempts plus three verification budget units.
//
// Drives real `node scripts/autopilot.mjs run` subprocesses against
// disposable git fixture repos and the hermetic fake adapter
// (scripts/test-fixtures/fake-workflow-adapter.sh), inspecting OBSERVED
// process outcome, result.json roles, brief.txt prompts, state.json, and
// filesystem state:
//
//   M-runtime: mkdir-only implementer -> GIT_INVISIBLE_PHASE after exactly
//     one attempt; zero phase code_reviewer/verifier; budgets untouched;
//     tasks unmarked; later-phase file absent.
//   M-gate: review-tasks FAILs on observability -> gate failure before any
//     implementation; the brief proves the strengthened contract arrived.
//   M-normal: a real-file phase completes in order (control).
//
// Requires a POSIX environment (shell fake adapter, bubblewrap read-only
// roles). Runs in the WSL suite. Windows coverage lives in
// test-windows-git-invisible-phase.mjs.
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {
  makeFixtureRepo, makeFixtureBin, makeSpecKitWorkflowOnly, makeClaudeMdBaseline,
  setScenario, writeConfig, runAutopilot, readObservedEvents, cleanup, withoutOuterGitGuard
} from "./test-fixtures/workflow-order-harness.mjs";

// This file's own header documents it as POSIX-only (the fake adapter is a
// shell script; read-only roles use bubblewrap) — Windows coverage lives in
// test-windows-git-invisible-phase.mjs. It previously had no runtime guard
// enforcing that, so it just failed outright on native Windows instead of
// skipping.
if (process.platform === "win32") {
  console.log("test-speckit-git-invisible-phase-behavior: SKIP — platform prerequisite not met: requires a POSIX environment (the fake adapter is a shell script; read-only roles need Linux/WSL2 bubblewrap). Windows coverage lives in test-windows-git-invisible-phase.mjs.");
  process.exit(0);
}

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

const NEW_FEATURE = "999-smoke-test";

function setUp(prefix) {
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  makeSpecKitWorkflowOnly(repo);
  makeClaudeMdBaseline(repo);
  writeConfig(repo, {planningFramework: "speckit"});
  return {repo, binDir};
}
function gitHead(repo) {
  return spawnSync("git", ["rev-parse", "HEAD"], {cwd: repo, encoding: "utf8", env: withoutOuterGitGuard(process.env), shell: false}).stdout.trim();
}
function readState(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
}
function readBriefs(repo) {
  const root = path.join(repo, ".autopilot");
  const out = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === "brief.txt") out.push(fs.readFileSync(full, "utf8"));
    }
  })(root);
  return out;
}
function tasksContent(repo) {
  return fs.readFileSync(path.join(repo, "specs", NEW_FEATURE, "tasks.md"), "utf8");
}

// ── M-runtime: mkdir-only attempt dies GIT_INVISIBLE_PHASE ─────────────────
{
  const {repo, binDir} = setUp("invisible-runtime");
  try {
    setScenario(repo, "speckit_git_invisible_phase");
    const headBefore = gitHead(repo);
    const run = runAutopilot(repo, binDir, {request: "smoke test the invisible phase guard", timeoutMs: 120000});
    const combined = `${run.stdout}\n${run.stderr}`;

    check("runtime: nonzero exit", run.status !== 0, run.status);
    check("runtime: precise GIT_INVISIBLE_PHASE failure", /GIT_INVISIBLE_PHASE/.test(combined), combined.slice(-1200));
    check("runtime: names the phase", /Phase 1/.test(combined), combined.slice(-1200));
    check("runtime: names the affected task", /tasks\.md:/.test(combined), combined.slice(-1200));

    const events = readObservedEvents(repo);
    const roles = events.map(e => e.role);
    check("runtime: exactly 1 implementer attempt", roles.filter(r => r === "implementer").length === 1, roles);
    check("runtime: ZERO code_reviewer/verifier results", !roles.includes("code_reviewer") && !roles.includes("verifier"), roles);
    check("runtime: 3 gate reviewers ran first", roles.filter(r => r === "plan_reviewer").length === 3, roles);
    const implIdx = roles.indexOf("implementer");
    check("runtime: implementer ran only after the 3 gates",
      implIdx !== -1 && roles.slice(0, implIdx).filter(r => r === "plan_reviewer").length === 3, roles);

    const state = readState(repo);
    check("runtime: escalated git_invisible_phase", state.phase === "escalated" && state.step === "git_invisible_phase", {phase: state.phase, step: state.step});
    check("runtime: attempt stayed at 1", state.attempt === 1, state.attempt);
    check("runtime: failure budgets untouched", !state.failureBudgets || Object.keys(state.failureBudgets).length === 0, state.failureBudgets);
    check("runtime: phase identity recorded", /Phase 1/.test(state.gitInvisiblePhase?.phase || ""), state.gitInvisiblePhase);

    const implEvent = events.find(e => e.role === "implementer");
    const implFile = implEvent.file;
    const implData = JSON.parse(fs.readFileSync(implFile, "utf8"));
    check("runtime: implementer touched nothing git-visible", (implData.touchedFiles || []).length === 0, implData.touchedFiles);
    const docsDir = path.join(repo, "docs");
    check("runtime: empty docs/ dir exists in official repo (fs changed, git blind)",
      fs.existsSync(docsDir) && fs.statSync(docsDir).isDirectory() && fs.readdirSync(docsDir).length === 0,
      fs.existsSync(docsDir) && fs.readdirSync(docsDir));
    check("runtime: tasks.md unmarked (all still [ ])", !/- \[x\]/.test(tasksContent(repo)));
    check("runtime: later-phase file absent (not skipped)", !fs.existsSync(path.join(repo, "docs", "FINAL-SMOKE.md")));
    check("runtime: HEAD unchanged", gitHead(repo) === headBefore);
  } finally {
    cleanup(repo, binDir);
  }
}

// ── M-gate: review-tasks rejects the invisible phase ───────────────────────
{
  const {repo, binDir} = setUp("invisible-gate");
  try {
    setScenario(repo, "speckit_review_tasks_reject_invisible");
    const run = runAutopilot(repo, binDir, {request: "smoke test the invisible phase gate", timeoutMs: 120000});
    const combined = `${run.stdout}\n${run.stderr}`;

    check("gate: nonzero exit", run.status !== 0, run.status);
    check("gate: review-tasks gate failure surfaced", /SpecKit gate review-tasks failed/.test(combined), combined.slice(-800));

    const events = readObservedEvents(repo);
    const roles = events.map(e => e.role);
    check("gate: implementer NEVER launched", !roles.includes("implementer"), roles);
    check("gate: code_reviewer/verifier NEVER launched", !roles.includes("code_reviewer") && !roles.includes("verifier"), roles);

    const gateBriefs = readBriefs(repo).filter(b => b.includes('SpecKit gate "review-tasks"'));
    check("gate: gate brief exists", gateBriefs.length >= 1, gateBriefs.length);
    check("gate: strengthened contract delivered to reviewer",
      gateBriefs.some(b => b.includes("Git-observable") && b.includes("empty directory")), gateBriefs.length);
    check("gate: tasks unmarked", !/- \[x\]/.test(tasksContent(repo)));
  } finally {
    cleanup(repo, binDir);
  }
}

// ── M-normal: real-file phase completes in order (control) ─────────────────
{
  const {repo, binDir} = setUp("invisible-normal");
  try {
    setScenario(repo, "speckit_full_contract");
    const headBefore = gitHead(repo);
    const run = runAutopilot(repo, binDir, {request: "smoke test the health endpoint", timeoutMs: 120000});
    const combined = `${run.stdout}\n${run.stderr}`;

    check("normal: exit 0", run.status === 0, `stderr=${run.stderr.slice(-800)}`);
    check("normal: HUMAN COMMIT REQUIRED", /HUMAN COMMIT REQUIRED/.test(combined), combined.slice(-400));
    const events = readObservedEvents(repo);
    const roles = events.map(e => e.role);
    check("normal: implementer + review + verify ran",
      roles.includes("implementer") && roles.includes("code_reviewer") && roles.includes("verifier"), roles);
    const state = readState(repo);
    check("normal: complete/human_commit", state.phase === "complete" && state.step === "human_commit", {phase: state.phase, step: state.step});
    check("normal: HEAD unchanged", gitHead(repo) === headBefore);
  } finally {
    cleanup(repo, binDir);
  }
}

if (failures) {
  console.error(`${failures} git-invisible-phase behavioral check(s) failed.`);
  process.exit(1);
}
console.log("test-speckit-git-invisible-phase-behavior: ALL CHECKS PASSED");
