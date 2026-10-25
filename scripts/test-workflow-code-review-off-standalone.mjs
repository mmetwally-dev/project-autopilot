#!/usr/bin/env node
// Backlog #14 / mission 098 task 1.2: workflow.code_review_per_phase=false
// (runtime `implementationReview`) must skip the standalone per-phase Code
// Reviewer and go straight from the Implementer to gates/Verifier.
//
// Behavioral proof only: every scenario drives a real
// `node scripts/autopilot.mjs run` subprocess against a disposable fixture
// repo and the fake adapter, then reads the result.json files the
// orchestrator itself wrote (role order, decisions) plus the terminal
// state.json (lastReview). No source-string checks.
//
// The shared harness's writeConfig() hard-codes both review switches to
// true, so the off scenarios rewrite .autopilot/config.json afterwards.
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {
  makeFixtureRepo, makeFixtureBin, setScenario, writeConfig, runAutopilot,
  readObservedEvents, withoutOuterGitGuard, cleanup, skillRoot
} from "./test-fixtures/workflow-order-harness.mjs";

let failed = 0;
let ran = 0;
const check = (name, ok, detail = "") => {
  ran++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${detail}`}`);
  if (!ok) failed++;
};

const configPath = (repo) => path.join(repo, ".autopilot", "config.json");
const statePath = (repo) => path.join(repo, ".autopilot", "state.json");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

// The harness writes workflow.implementationReview:true. Turn the per-phase
// code review off after the fact; the orchestrator re-reads config.json on
// every run, so this also affects a later stage/resume invocation.
function disablePerPhaseCodeReview(repo) {
  const config = readJson(configPath(repo));
  config.workflow = {...(config.workflow || {}), implementationReview: false};
  fs.writeFileSync(configPath(repo), JSON.stringify(config, null, 2));
}

function runCommand(repo, binDir, command, args, {timeoutMs = 180000} = {}) {
  const delimiter = process.platform === "win32" ? ";" : ":";
  const base = withoutOuterGitGuard(process.env);
  delete base.AUTOPILOT_SPEC;
  const env = {...base, PATH: `${binDir}${delimiter}${base.PATH || ""}`};
  const result = spawnSync(process.execPath,
    [path.join(skillRoot, "scripts", "autopilot.mjs"), command, ...args, "--repo", repo],
    {cwd: repo, encoding: "utf8", env, timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"], shell: false});
  return {
    status: result.status,
    timedOut: Boolean(result.error && result.error.code === "ETIMEDOUT"),
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}

const roleIndex = (events, role, predicate = () => true) =>
  events.findIndex((e) => e.role === role && predicate(e));
const codeReviewerBefore = (events, index) =>
  index === -1 ? events.filter((e) => e.role === "code_reviewer").length : events.slice(0, index).filter((e) => e.role === "code_reviewer").length;

// ---- 1. Default (switch on): the per-phase Code Reviewer still runs before
//         the Verifier and the phase records PASS. ----
{
  const repo = makeFixtureRepo("098-review-on");
  const binDir = makeFixtureBin("098-review-on");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    setScenario(repo, "success");
    const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: 180000});
    const events = readObservedEvents(repo);
    const firstVerifier = roleIndex(events, "verifier");
    const firstReviewer = roleIndex(events, "code_reviewer");

    check("[default] mission completed", run.status === 0, `status=${run.status} tail=${JSON.stringify((run.stdout + run.stderr).slice(-400))}`);
    check("[default] per-phase code_reviewer ran before the first verifier",
      firstReviewer !== -1 && firstVerifier !== -1 && firstReviewer < firstVerifier,
      `reviewer=${firstReviewer} verifier=${firstVerifier}`);
    check("[default] per-phase code_reviewer PASSed",
      events.some((e) => e.role === "code_reviewer" && e.decision === "PASS"));
    check("[default] state.lastReview records PASS",
      readJson(statePath(repo)).lastReview?.decision === "PASS",
      `lastReview=${JSON.stringify(readJson(statePath(repo)).lastReview)}`);
  } finally {
    cleanup(repo, binDir);
  }
}

// ---- 2. Switch off, fresh run: no per-phase Code Reviewer is launched; the
//         Verifier runs directly after the Implementer, the phase records
//         SKIPPED (never PASS), and the mission completes. ----
{
  const repo = makeFixtureRepo("098-review-off");
  const binDir = makeFixtureBin("098-review-off");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    disablePerPhaseCodeReview(repo);
    setScenario(repo, "success");
    const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: 180000});
    const events = readObservedEvents(repo);
    const firstVerifier = roleIndex(events, "verifier");
    const state = readJson(statePath(repo));

    check("[off] mission completed", run.status === 0, `status=${run.status} tail=${JSON.stringify((run.stdout + run.stderr).slice(-400))}`);
    check("[off] verifier ran", firstVerifier !== -1);
    check("[off] no per-phase code_reviewer ran before the first verifier",
      codeReviewerBefore(events, firstVerifier) === 0,
      `before=${codeReviewerBefore(events, firstVerifier)} events=${JSON.stringify(events.map((e) => e.role))}`);
    check("[off] state.lastReview is not PASS",
      state.lastReview?.decision !== "PASS",
      `lastReview=${JSON.stringify(state.lastReview)}`);
    check("[off] state.lastReview records SKIPPED",
      state.lastReview?.decision === "SKIPPED",
      `lastReview=${JSON.stringify(state.lastReview)}`);
  } finally {
    cleanup(repo, binDir);
  }
}

// ---- 3. Switch off, resumed from a checkpoint whose runningStage is
//         "code_reviewer" (the stage a hard kill during review leaves
//         behind): the resume skips that stage and reaches the Verifier,
//         then completes. ----
{
  const repo = makeFixtureRepo("098-review-off-resume");
  const binDir = makeFixtureBin("098-review-off-resume");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    disablePerPhaseCodeReview(repo);
    setScenario(repo, "success");

    const planning = runCommand(repo, binDir, "run", ["--stage", "planning", "fixture request"]);
    check("[resume] planning stage exits 0",
      planning.status === 0 && !planning.timedOut,
      `status=${planning.status} tail=${JSON.stringify((planning.stdout + planning.stderr).slice(-300))}`);

    const impl = runCommand(repo, binDir, "run", ["--stage", "implement", "fixture request"]);
    const checkpoint = readJson(statePath(repo)).phaseExecutionCheckpoint;
    check("[resume] implement stage exits 0 with a persisted checkpoint",
      impl.status === 0 && !impl.timedOut && checkpoint && typeof checkpoint === "object",
      `status=${impl.status} checkpoint=${JSON.stringify(checkpoint)?.slice(0, 200)}`);
    check("[resume] the checkpoint is queued at code_reviewer",
      checkpoint?.nextStage === "code_reviewer",
      `nextStage=${checkpoint?.nextStage}`);

    // Simulate a hard kill after the Reviewer launch was persisted.
    checkpoint.runningStage = "code_reviewer";
    const state = readJson(statePath(repo));
    state.phaseExecutionCheckpoint = checkpoint;
    fs.writeFileSync(statePath(repo), JSON.stringify(state, null, 2));

    const resumed = runAutopilot(repo, binDir, {request: "fixture request", timeoutMs: 180000});
    const events = readObservedEvents(repo);
    const firstVerifier = roleIndex(events, "verifier");
    const terminal = readJson(statePath(repo));

    check("[resume] plain run completes", resumed.status === 0,
      `status=${resumed.status} tail=${JSON.stringify((resumed.stdout + resumed.stderr).slice(-400))}`);
    check("[resume] resumed code_reviewer checkpoint reaches the verifier",
      firstVerifier !== -1 && events[firstVerifier]?.decision === "PASS",
      `verifier=${firstVerifier} events=${JSON.stringify(events.map((e) => `${e.role}:${e.decision}`))}`);
    check("[resume] no per-phase code_reviewer ran before the resumed verifier",
      codeReviewerBefore(events, firstVerifier) === 0,
      `before=${codeReviewerBefore(events, firstVerifier)}`);
    check("[resume] state.lastReview is not PASS",
      terminal.lastReview?.decision !== "PASS",
      `lastReview=${JSON.stringify(terminal.lastReview)}`);
    check("[resume] mission phase is complete",
      terminal.phase === "complete",
      `phase=${terminal.phase} status=${terminal.status}`);
  } finally {
    cleanup(repo, binDir);
  }
}

console.log(failed ? `${failed} of ${ran} check(s) failed.` : `all ${ran} check(s) passed.`);
process.exit(failed ? 1 : 0);
