#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {
  makeFixtureRepo, writeConfig, withoutOuterGitGuard, cleanup
} from "./test-fixtures/workflow-order-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const AUTOPILOT = path.join(here, "autopilot.mjs");
const ENV = withoutOuterGitGuard(process.env);

let ok = 0, failed = 0;
function check(name, condition, detail){
  if(condition){ ok++; console.log(`PASS ${name}`); return; }
  failed++;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

const statePath = (repo) => path.join(repo, ".autopilot", "state.json");
const readState = (repo) => JSON.parse(fs.readFileSync(statePath(repo), "utf8"));
const writeState = (repo, s) => fs.writeFileSync(statePath(repo), JSON.stringify(s, null, 2));

function runReset(repo){
  return spawnSync(process.execPath,
    [AUTOPILOT, "reset", "--yes", "--repo", repo],
    {cwd: repo, encoding: "utf8", env: ENV, timeout: 60000, shell: false});
}

// ── a & b. state.json with planReviewRevisions -> cleared, unrelated unchanged ─
{
  const repo = makeFixtureRepo("reset-plan-rev");
  try {
    writeConfig(repo, {});
    const initialFeedback = {
      "speckit-stage:plan": ["Cross-check dependency order and task size"]
    };
    const initialState = {
      version: 1,
      phase: "planning",
      step: "speckit-plan",
      planningStepIndex: 3,
      reviewFeedback: initialFeedback,
      planReviewRevisions: {
        "speckit-stage:plan": 6,
        "gsd-plan-review:plan:2": 1
      }
    };
    writeState(repo, initialState);

    const run = runReset(repo);
    check("a: bare reset exits 0", run.status === 0, {status: run.status, stdout: run.stdout, stderr: run.stderr});
    check("a: output contains cleared planReviewRevisions:speckit-stage:plan=6",
      run.stdout.includes("cleared planReviewRevisions:speckit-stage:plan=6"), run.stdout);
    check("a: output contains cleared planReviewRevisions:gsd-plan-review:plan:2=1",
      run.stdout.includes("cleared planReviewRevisions:gsd-plan-review:plan:2=1"), run.stdout);

    const savedState = readState(repo);
    check("a: saved state.json has no planReviewRevisions key",
      !("planReviewRevisions" in savedState), Object.keys(savedState));

    check("b: reviewFeedback is unchanged",
      JSON.stringify(savedState.reviewFeedback) === JSON.stringify(initialFeedback), savedState.reviewFeedback);
    check("b: phase is unchanged", savedState.phase === "planning", savedState.phase);
    check("b: step is unchanged", savedState.step === "speckit-plan", savedState.step);
    check("b: planningStepIndex is unchanged", savedState.planningStepIndex === 3, savedState.planningStepIndex);
  } finally {
    cleanup(repo);
  }
}

// ── c. nothing spent at all -> exit 1 and message lists planReviewRevisions ───
{
  const repo = makeFixtureRepo("reset-empty");
  try {
    writeConfig(repo, {});
    const initialState = {
      version: 1,
      phase: "planning",
      step: "speckit-plan",
      planningStepIndex: 1,
      reviewFeedback: {}
    };
    writeState(repo, initialState);

    const run = runReset(repo);
    check("c: exit 1 when nothing spent", run.status === 1, {status: run.status, stdout: run.stdout, stderr: run.stderr});
    const combinedOutput = `${run.stdout}\n${run.stderr}`;
    check("c: error message lists planReviewRevisions",
      combinedOutput.includes("planReviewRevisions") &&
      combinedOutput.includes("nothing is spent anywhere (failureBudgets, continuationBudgets, rolloverDeadEnds, standalonePlanReview.revision, planReviewRevisions)"),
      combinedOutput);
  } finally {
    cleanup(repo);
  }
}

if(failed > 0){
  console.error(`\nFAILED: ${failed} check(s) failed`);
  process.exit(1);
}
console.log(`\nALL CHECKS PASSED (${ok}/${ok})`);
