#!/usr/bin/env node
// Backlog #100 phase 2 task 2.1 — standalone plan-revision budget 0 wiring.
//
// Drives real `node scripts/autopilot.mjs run` subprocesses against the
// shared fake-adapter harness with the `plan_review_fail` scenario (the
// first plan_reviewer call FAILs, a call carrying feedback PASSes).
//
// Case A: policy.max_plan_revisions = 0 — the very first plan-review FAIL is
// the configured escalation point: one Planner run, no revision Planner run,
// phase "escalated", step "standalone-plan-review-failed", nonzero exit.
// Case B (control): the harness default (3) still revises after the FAIL and
// completes, proving case A exercises the 0 guard rather than a broken loop.
import fs from "node:fs";
import path from "node:path";
import {makeFixtureRepo, makeFixtureBin, setScenario, writeConfig, runAutopilot, readObservedEvents, cleanup} from "./test-fixtures/workflow-order-harness.mjs";

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

function runPlanReviewFail(prefix, maxPlanRevisions) {
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  try {
    writeConfig(repo, {planningFramework: "standalone", maxPlanRevisions});
    setScenario(repo, "plan_review_fail");
    const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: 120000});
    return {run, events: readObservedEvents(repo), state: readState(repo)};
  } finally {
    cleanup(repo, binDir);
  }
}

// ---- A. max_plan_revisions: 0 escalates on the first plan-review FAIL ----
{
  const {run, events, state} = runPlanReviewFail("budget-zero-plan-revisions-standalone-zero", 0);
  check("zero: mission escalates (nonzero exit)", run.status !== 0, {status: run.status, timedOut: run.timedOut});
  check("zero: planner ran exactly once (no revision planner run)", countRole(events, "planner") === 1,
    {planner: countRole(events, "planner")});
  check("zero: plan_reviewer ran exactly once", countRole(events, "plan_reviewer") === 1,
    {plan_reviewer: countRole(events, "plan_reviewer")});
  check("zero: the one plan_reviewer call FAILed",
    events.filter(e => e.role === "plan_reviewer")[0]?.decision === "FAIL");
  check("zero: state.phase is escalated", state.phase === "escalated", {phase: state.phase});
  check("zero: state.step is standalone-plan-review-failed",
    state.step === "standalone-plan-review-failed", {step: state.step});
}

// ---- B. Control: the default (3) still revises and completes ----
{
  const {run, events, state} = runPlanReviewFail("budget-zero-plan-revisions-standalone-control", 3);
  const reviews = events.filter(e => e.role === "plan_reviewer");
  check("control: first plan_reviewer call FAILed", reviews[0]?.decision === "FAIL");
  check("control: a later plan_reviewer call PASSed without a second FAIL", reviews.some(e => e.decision === "PASS"));
  check("control: planner was re-invoked after the FAIL (revision run)", countRole(events, "planner") >= 2,
    {planner: countRole(events, "planner")});
  check("control: mission completes (exit 0)", run.status === 0, {status: run.status, timedOut: run.timedOut});
  check("control: state.phase is complete", state.phase === "complete", {phase: state.phase});
}

if (failures) {
  console.error(`${failures} zero plan-revision budget (standalone) check(s) failed.`);
  process.exit(1);
}
console.log("zero plan-revision budget (standalone) tests passed");
