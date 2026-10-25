#!/usr/bin/env node
// Backlog #13 / mission 098 task 1.5: workflow.final_review=false (runtime
// `finalReview`) must skip the standalone mission-final Code Reviewer (and
// its fix rounds), record the skip on the mission state, and still reach
// finalizeMissionComplete.
//
// Behavioral proof only: the scenario drives a real
// `node scripts/autopilot.mjs run` subprocess against a disposable fixture
// repo and the fake adapter, then reads the result.json files the
// orchestrator itself wrote (role order) plus the terminal state.json.
//
// The shared harness's writeConfig() hard-codes finalReview to true, so the
// off scenario rewrites .autopilot/config.json afterwards.
import fs from "node:fs";
import path from "node:path";
import {
  makeFixtureRepo, makeFixtureBin, setScenario, writeConfig, runAutopilot,
  readObservedEvents, cleanup, skillRoot
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

const roleIndex = (events, role, from = 0) =>
  events.findIndex((e, i) => i >= from && e.role === role);
const lastRoleIndex = (events, role) => {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].role === role) return i;
  return -1;
};

// ---- 1. Switch off: mission completes without a mission-final Code
//         Reviewer after the last Verifier, and state records the skip. ----
{
  const repo = makeFixtureRepo("098-final-review-off");
  const binDir = makeFixtureBin("098-final-review-off");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
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

    // ---- 2. A fresh mission (different request) must not inherit the
    //         previous mission's skip marker. Final review is back ON, so
    //         only the new-mission debris drop can remove it.
    setFinalReview(repo, true);
    const second = runAutopilot(repo, binDir, {request: "implement the second fixture task", timeoutMs: 180000});
    const secondState = readJson(statePath(repo));
    check("[fresh] second mission completed", second.status === 0,
      `status=${second.status} tail=${JSON.stringify((second.stdout + second.stderr).slice(-400))}`);
    check("[fresh] fresh mission state lacks finalReviewSkipped",
      !Object.hasOwn(secondState, "finalReviewSkipped"),
      `finalReviewSkipped=${JSON.stringify(secondState.finalReviewSkipped)} phase=${secondState.phase}`);
  } finally {
    cleanup(repo, binDir);
  }
}

console.log(failed ? `${failed} of ${ran} check(s) failed.` : `all ${ran} check(s) passed.`);
process.exit(failed ? 1 : 0);
