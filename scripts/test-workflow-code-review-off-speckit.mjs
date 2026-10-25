#!/usr/bin/env node
// Backlog #14 / mission 098 task 1.3: workflow.code_review_per_phase=false
// (runtime `implementationReview`) must skip the SpecKit per-phase Code
// Reviewer and go straight to gates/Verifier.
//
// Behavioral proof only: every scenario drives a real
// `node scripts/autopilot.mjs run` subprocess against a disposable SpecKit
// fixture repo and the fake adapter, then reads the result.json files the
// orchestrator itself wrote (role order, decisions) plus the terminal
// state.json (lastReview). No source-string checks.
//
// The shared harness's writeConfig() hard-codes both review switches to
// true, so the off scenarios rewrite .autopilot/config.json afterwards.
import fs from "node:fs";
import path from "node:path";
import {
  makeFixtureRepo, makeFixtureBin, makeSpecKitPhaseFixture, setScenario,
  writeConfig, runAutopilot, runAutopilotUntilMarker, readObservedEvents,
  cleanup
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
// The orchestrator may normalize the config to canonical keys during the
// first run (code_review_per_phase), in which case adding the runtime alias
// back would be an unknown-key error. Turn off whichever spelling is present.
function disablePerPhaseCodeReview(repo) {
  const config = readJson(configPath(repo));
  const workflow = {...(config.workflow || {})};
  delete workflow.implementationReview;
  if ("code_review_per_phase" in workflow) workflow.code_review_per_phase = false;
  else workflow.implementationReview = false;
  config.workflow = workflow;
  fs.writeFileSync(configPath(repo), JSON.stringify(config, null, 2));
}

const roleIndex = (events, role, predicate = () => true) =>
  events.findIndex((e) => e.role === role && predicate(e));
const codeReviewerBefore = (events, index) =>
  index === -1 ? events.filter((e) => e.role === "code_reviewer").length : events.slice(0, index).filter((e) => e.role === "code_reviewer").length;

// Backlog #83 helper shape, reused here: the fake Code Reviewer's hold knob
// blocks (sleep 7301) so the test can kill the whole tree while the reviewer
// runs, leaving a persisted checkpoint whose runningStage is "code_reviewer".
// A read-only role cannot drop a marker, so the test watches for the run
// directory itself.
function reviewerRunStarted(repo) {
  const missions = path.join(repo, ".autopilot", "missions");
  try {
    for (const m of fs.readdirSync(missions)) {
      const runs = path.join(missions, m, "runs");
      if (fs.existsSync(runs) && fs.readdirSync(runs).some((d) => /^\d+-code_reviewer-/.test(d))) return true;
    }
  } catch { /* not created yet */ }
  return false;
}

// The sandboxed reviewer's `sleep` lives in a process group the harness's tree
// kill does not reach; reap it (identified by its unique duration) so no fake
// process outlives the test.
function reapHeldReviewer() {
  for (const pid of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      if (fs.readFileSync(`/proc/${pid}/cmdline`, "utf8") !== "sleep\x007301\x00") continue;
      const pgid = fs.readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "").split(" ")[2];
      try { process.kill(-Number(pgid), "SIGKILL"); } catch { /* group already gone */ }
      process.kill(Number(pid), "SIGKILL");
    } catch { /* process vanished or not ours */ }
  }
}

async function runUntilReviewer(repo, binDir) {
  const markerFile = `${repo}-reviewer-marker`;
  fs.writeFileSync(path.join(repo, ".autopilot", ".autopilot-test-reviewer-hold"), "");
  const watcher = setInterval(() => {
    if (reviewerRunStarted(repo)) fs.writeFileSync(markerFile, "");
  }, 25);
  try {
    return await runAutopilotUntilMarker(repo, binDir, {request: "implement the fixture task", markerFile, timeoutMs: 180000});
  } finally {
    clearInterval(watcher);
    fs.rmSync(markerFile, {force: true});
    reapHeldReviewer();
  }
}

// ---- 1. Default (switch on): the per-phase Code Reviewer still runs before
//         the Verifier and the phase records PASS. ----
{
  const repo = makeFixtureRepo("098-speckit-review-on");
  const binDir = makeFixtureBin("098-speckit-review-on");
  try {
    makeSpecKitPhaseFixture(repo);
    writeConfig(repo, {planningFramework: "speckit"});
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
  const repo = makeFixtureRepo("098-speckit-review-off");
  const binDir = makeFixtureBin("098-speckit-review-off");
  try {
    makeSpecKitPhaseFixture(repo);
    writeConfig(repo, {planningFramework: "speckit"});
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
  const repo = makeFixtureRepo("098-speckit-review-off-resume");
  const binDir = makeFixtureBin("098-speckit-review-off-resume");
  try {
    makeSpecKitPhaseFixture(repo);
    writeConfig(repo, {planningFramework: "speckit"});
    setScenario(repo, "success");

    const first = await runUntilReviewer(repo, binDir);
    check("[resume] the first run reached the Code Reviewer and was killed there",
      first.markerObserved && first.killed, JSON.stringify(first));

    const checkpoint = readJson(statePath(repo)).phaseExecutionCheckpoint;
    check("[resume] the killed run left a checkpoint queued at code_reviewer",
      checkpoint?.nextStage === "code_reviewer",
      `nextStage=${checkpoint?.nextStage}`);
    check("[resume] the checkpoint records runningStage code_reviewer",
      checkpoint?.runningStage === "code_reviewer",
      `runningStage=${checkpoint?.runningStage}`);

    fs.rmSync(path.join(repo, ".autopilot", ".autopilot-test-reviewer-hold"), {force: true});
    disablePerPhaseCodeReview(repo);

    const resumed = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: 180000});
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
      `before=${codeReviewerBefore(events, firstVerifier)} events=${JSON.stringify(events.map((e) => e.role))}`);
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
