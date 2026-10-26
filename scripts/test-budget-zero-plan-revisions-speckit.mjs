#!/usr/bin/env node
// Backlog #100 phase 2 task 2.2 — SpecKit gate plan-revision budget 0 wiring.
//
// Drives real `node scripts/autopilot.mjs run` subprocesses against the
// shared fake-adapter harness with the `speckit_spec_review_fail` scenario
// (every plan_reviewer call FAILs, while each Planner stage idempotently
// rewrites the same feature so the revision call can complete).
//
// Case A: policy.max_plan_revisions = 0 — the very first gate review FAIL is
// the configured escalation point: one Planner call (the specify stage), no
// revision Planner call, no post-revision re-review, nonzero exit.
// Case B (control): the harness default (3) still grants exactly one
// revision — the Planner re-runs and the post-revision re-review is paid —
// proving case A exercises the 0 guard rather than a broken gate loop.
import fs from "node:fs";
import path from "node:path";
import {makeFixtureRepo, makeFixtureBin, makeSpecKitPhaseFixture, setScenario, writeConfig, runAutopilot, readObservedEvents, cleanup} from "./test-fixtures/workflow-order-harness.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}

function countRole(events, role) {
  return events.filter(e => e.role === role).length;
}

function readState(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
}

function readBriefs(repo) {
  const out = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "brief.txt") out.push(fs.readFileSync(full, "utf8"));
    }
  })(path.join(repo, ".autopilot"));
  return out;
}

function runPlanReviewFail(prefix, maxPlanRevisions) {
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  try {
    makeSpecKitPhaseFixture(repo);
    writeConfig(repo, {planningFramework: "speckit", maxPlanRevisions});
    setScenario(repo, "speckit_spec_review_fail");
    const run = runAutopilot(repo, binDir, {
      request: "implement the fixture task",
      timeoutMs: process.platform === "win32" ? 240000 : 120000
    });
    return {run, events: readObservedEvents(repo), briefs: readBriefs(repo), state: readState(repo)};
  } finally {
    cleanup(repo, binDir);
  }
}

// ---- A. max_plan_revisions: 0 fails the gate without a revision ----
{
  const {run, events, briefs, state} = runPlanReviewFail("budget-zero-plan-revisions-speckit-zero", 0);
  check("zero: mission fails (nonzero exit)", run.status !== 0, {status: run.status, timedOut: run.timedOut});
  check("zero: planner ran exactly once (the specify stage, no revision planner run)",
    countRole(events, "planner") === 1, {planner: countRole(events, "planner")});
  check("zero: plan_reviewer ran exactly once (no re-review)",
    countRole(events, "plan_reviewer") === 1, {plan_reviewer: countRole(events, "plan_reviewer")});
  check("zero: the one plan_reviewer call FAILed",
    events.filter(e => e.role === "plan_reviewer")[0]?.decision === "FAIL");
  check("zero: the gate failure names the first gate",
    `${run.stdout || ""}\n${run.stderr || ""}`.includes("SpecKit gate review-spec failed"),
    {tail: `${run.stdout || ""}\n${run.stderr || ""}`.slice(-600)});
  check("zero: no post-revision re-review prompt was sent",
    !briefs.some(brief => brief.includes('Re-review the SpecKit gate "review-spec"')), {briefs: briefs.length});
  check("zero: the gate findings were persisted against the spec stage",
    (state.reviewFeedback?.["speckit-stage:specify"]?.findings || []).length > 0,
    {reviewFeedback: state.reviewFeedback});
  check("zero: the failed gate checkpoint was persisted",
    state.speckitPlanningCheckpoint?.step === "review-spec", {speckitPlanningCheckpoint: state.speckitPlanningCheckpoint});
}

// ---- B. Control: the default (3) still grants one revision ----
{
  const {run, events, briefs} = runPlanReviewFail("budget-zero-plan-revisions-speckit-control", 3);
  check("control: first plan_reviewer call FAILed",
    events.filter(e => e.role === "plan_reviewer")[0]?.decision === "FAIL");
  check("control: planner was re-invoked after the FAIL (revision run)",
    countRole(events, "planner") >= 2, {planner: countRole(events, "planner")});
  check("control: the post-revision re-review was paid",
    countRole(events, "plan_reviewer") >= 2, {plan_reviewer: countRole(events, "plan_reviewer")});
  check("control: the re-review prompt is the post-revision one",
    briefs.some(brief => brief.includes('Re-review the SpecKit gate "review-spec"')), {briefs: briefs.length});
  check("control: the one-revision gate still ends in failure (the scenario never passes the re-review)",
    run.status !== 0, {status: run.status, timedOut: run.timedOut});
}

if (failures) {
  console.error(`${failures} zero plan-revision budget (SpecKit) check(s) failed.`);
  process.exit(1);
}
console.log("zero plan-revision budget (SpecKit) tests passed");
