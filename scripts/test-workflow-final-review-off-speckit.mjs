#!/usr/bin/env node
// Backlog #13 / mission 098 task 1.6: workflow.final_review=false (runtime
// `finalReview`) must skip the SpecKit mission-final Code Reviewer (and its
// fix rounds), record the skip on the mission state, and still reach
// finalizeMissionComplete — while the mission-final unchecked-task guard
// keeps refusing to complete a mission that still has an unchecked task.
//
// Behavioral proof only: the scenarios drive a real
// `node scripts/autopilot.mjs run` subprocess against a disposable SpecKit
// fixture repo and the fake adapter, then read the result.json files the
// orchestrator itself wrote (role order) plus the terminal state.json.
//
// The shared harness's writeConfig() hard-codes finalReview to true, so the
// off scenario rewrites .autopilot/config.json afterwards.
import fs from "node:fs";
import path from "node:path";
import {
  makeFixtureRepo, makeFixtureBin, makeSpecKitPhaseFixture, setScenario,
  writeConfig, runAutopilot, readObservedEvents, cleanup, skillRoot
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

// The orchestrator migrates config.json in place on its first run, so after a
// mission the key is `final_review` (snake_case); before it, the harness wrote
// the camelCase runtime spelling. Set whichever spelling is already present.
function setFinalReview(repo, value) {
  const config = readJson(configPath(repo));
  const workflow = {...(config.workflow || {})};
  if (Object.hasOwn(workflow, "final_review")) workflow.final_review = value;
  else workflow.finalReview = value;
  config.workflow = workflow;
  fs.writeFileSync(configPath(repo), JSON.stringify(config, null, 2));
}

const lastRoleIndex = (events, role) => {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].role === role) return i;
  return -1;
};

// ---- 1. Switch off: mission completes without a mission-final Code
//         Reviewer after the last Verifier, and state records the skip. ----
{
  const repo = makeFixtureRepo("098-speckit-final-review-off");
  const binDir = makeFixtureBin("098-speckit-final-review-off");
  try {
    makeSpecKitPhaseFixture(repo);
    writeConfig(repo, {planningFramework: "speckit"});
    setFinalReview(repo, false);
    setScenario(repo, "success");
    const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: 180000});
    const events = readObservedEvents(repo);
    const state = readJson(statePath(repo));
    const lastVerifier = lastRoleIndex(events, "verifier");
    const reviewersAfter = lastVerifier === -1
      ? events.filter((e) => e.role === "code_reviewer").length
      : events.slice(lastVerifier + 1).filter((e) => e.role === "code_reviewer").length;

    check("[off] mission completed", run.status === 0,
      `status=${run.status} tail=${JSON.stringify((run.stdout + run.stderr).slice(-400))}`);
    check("[off] verifier ran", lastVerifier !== -1,
      `events=${JSON.stringify(events.map((e) => e.role))}`);
    check("[off] no mission-final code_reviewer ran after the last verifier",
      reviewersAfter === 0,
      `after=${reviewersAfter} events=${JSON.stringify(events.map((e) => `${e.role}:${e.decision}`))}`);
    check("[off] state is complete", state.phase === "complete",
      `phase=${state.phase} step=${state.step}`);
    check("[off] state records finalReviewSkipped", state.finalReviewSkipped === true,
      `finalReviewSkipped=${JSON.stringify(state.finalReviewSkipped)}`);

    const source = fs.readFileSync(path.join(skillRoot, "scripts", "autopilot.mjs"), "utf8");
    check("[off] MISSION_SCOPED_STATE_KEYS contains finalReviewSkipped",
      source.slice(source.indexOf("MISSION_SCOPED_STATE_KEYS=Object.freeze(["),
        source.indexOf("MISSION_SCOPED_STATE_KEYS=Object.freeze([") + 2500).includes('"finalReviewSkipped"'));
  } finally {
    cleanup(repo, binDir);
  }
}

// ---- 2. Switch off plus one unchecked task left in tasks.md: the skip must
//         NOT bypass the mission-final unchecked-task guard — the mission
//         must not complete. The fake implementer injects a new phase (never
//         part of the already-parsed phaseList) while Phase 2 runs, so it
//         stays unchecked on disk when the guard re-reads tasks.md. ----
{
  const repo = makeFixtureRepo("098-speckit-final-review-off-unchecked");
  const binDir = makeFixtureBin("098-speckit-final-review-off-unchecked");
  try {
    makeSpecKitPhaseFixture(repo);
    writeConfig(repo, {planningFramework: "speckit"});
    setFinalReview(repo, false);
    setScenario(repo, "speckit_unchecked_task_left");
    const run = runAutopilot(repo, binDir, {request: "implement the multi-task fixture", timeoutMs: 180000});
    const state = readJson(statePath(repo));
    const tasksText = fs.readdirSync(path.join(repo, "specs"))
      .filter((d) => fs.existsSync(path.join(repo, "specs", d, "tasks.md")))
      .map((d) => fs.readFileSync(path.join(repo, "specs", d, "tasks.md"), "utf8"))
      .join("\n");

    check("[unchecked] mission did not complete", run.status !== 0,
      `status=${run.status} tail=${JSON.stringify((run.stdout + run.stderr).slice(-400))}`);
    check("[unchecked] state is not complete", state.phase !== "complete",
      `phase=${state.phase} step=${state.step}`);
    check("[unchecked] guard refused at task_marking_incomplete",
      state.step === "task_marking_incomplete",
      `phase=${state.phase} step=${state.step}`);
    check("[unchecked] the injected task is still unchecked on disk",
      /- \[ \] Injected unchecked task/.test(tasksText),
      `tasks=${JSON.stringify(tasksText.slice(-300))}`);
    check("[unchecked] the skip marker was recorded before the guard refused",
      state.finalReviewSkipped === true,
      `finalReviewSkipped=${JSON.stringify(state.finalReviewSkipped)}`);
    const uncheckedEvents = readObservedEvents(repo);
    const uncheckedLastVerifier = lastRoleIndex(uncheckedEvents, "verifier");
    const uncheckedReviewersAfter = uncheckedLastVerifier === -1
      ? uncheckedEvents.filter((e) => e.role === "code_reviewer").length
      : uncheckedEvents.slice(uncheckedLastVerifier + 1).filter((e) => e.role === "code_reviewer").length;
    check("[unchecked] no mission-final code_reviewer ran after the last verifier",
      uncheckedReviewersAfter === 0,
      `after=${uncheckedReviewersAfter} events=${JSON.stringify(uncheckedEvents.map((e) => `${e.role}:${e.decision}`))}`);
  } finally {
    cleanup(repo, binDir);
  }
}

console.log(failed ? `${failed} of ${ran} check(s) failed.` : `all ${ran} check(s) passed.`);
process.exit(failed ? 1 : 0);
