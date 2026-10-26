#!/usr/bin/env node
// Backlog #100 phase 3 task 3.2 — zero implementation/verification failure
// budgets in the SPECKIT loop.
//
// Drives real `node scripts/autopilot.mjs run` SpecKit missions against the
// shared fake-adapter harness with `policy.failure_budgets` set to 0:
//
// Case A: implementationFailureBudget = 0 with the `dirty_worktree_changes`
// scenario (Code Review FAILs the first phase review exactly once). The very
// first FAIL is the configured escalation point: exactly one Implementer and
// one phase Code Reviewer run, no Verifier, no Implementer retry,
// state.phase "escalated", and state.lastFailureBudget.limit === 0.
//
// Case B: verificationFailureBudget = 0 with `speckit_verifier_fail_once`
// (the first Verifier call FAILs once, a retry would PASS). Exactly one
// phase Implementer, one phase Code Reviewer PASS and one Verifier FAIL run;
// no retry of any role; state.phase "escalated" with
// state.lastFailureBudget.limit === 0.
import fs from "node:fs";
import path from "node:path";
import {makeFixtureRepo, makeFixtureBin, makeSpecKitPhaseFixture, setScenario, writeConfig, runAutopilot, readObservedEvents, cleanup} from "./test-fixtures/workflow-order-harness.mjs";

const RUN_TIMEOUT_MS = 180000;

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}

function countRole(events, role) {
  return events.filter(e => e.role === role).length;
}

function decisions(events, role) {
  return events.filter(e => e.role === role).map(e => e.decision);
}

function readState(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
}

function runMission(prefix, scenario, failureBudgets) {
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  try {
    makeSpecKitPhaseFixture(repo);
    writeConfig(repo, {planningFramework: "speckit", failureBudgets});
    setScenario(repo, scenario);
    const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: RUN_TIMEOUT_MS});
    return {run, events: readObservedEvents(repo), state: readState(repo)};
  } finally {
    cleanup(repo, binDir);
  }
}

// ---- A. implementationFailureBudget: 0 denies the retry after one FAIL ----
{
  const {run, events, state} = runMission(
    "budget-zero-impl-speckit",
    "dirty_worktree_changes",
    {implementationFailureBudget: 0}
  );
  const reviews = decisions(events, "code_reviewer");

  check("impl zero: mission escalates (nonzero exit)", run.status !== 0, {status: run.status, timedOut: run.timedOut});
  check("impl zero: exactly one Implementer run (no retry)", countRole(events, "implementer") === 1,
    {implementer: countRole(events, "implementer")});
  check("impl zero: exactly one Code Reviewer run (no retry)", countRole(events, "code_reviewer") === 1,
    {code_reviewer: countRole(events, "code_reviewer")});
  check("impl zero: the one Code Reviewer call FAILed", reviews.length === 1 && reviews[0] === "FAIL", reviews);
  check("impl zero: no Verifier ever ran", countRole(events, "verifier") === 0,
    {verifier: countRole(events, "verifier")});
  check("impl zero: state.phase is escalated", state.phase === "escalated", {phase: state.phase});
  check("impl zero: lastFailureBudget records the implementation budget with limit 0",
    state.lastFailureBudget?.budget === "implementationFailureBudget"
    && state.lastFailureBudget?.limit === 0
    && state.lastFailureBudget?.used === 1
    && state.lastFailureBudget?.allowed === false,
    state.lastFailureBudget);
}

// ---- B. verificationFailureBudget: 0 denies the retry after one FAIL ----
{
  const {run, events, state} = runMission(
    "budget-zero-verify-speckit",
    "speckit_verifier_fail_once",
    {verificationFailureBudget: 0}
  );
  const reviews = decisions(events, "code_reviewer");
  const verifies = decisions(events, "verifier");

  check("verify zero: mission escalates (nonzero exit)", run.status !== 0, {status: run.status, timedOut: run.timedOut});
  check("verify zero: exactly one Implementer run (no retry)", countRole(events, "implementer") === 1,
    {implementer: countRole(events, "implementer")});
  check("verify zero: exactly one Code Reviewer run and it PASSed",
    reviews.length === 1 && reviews[0] === "PASS", reviews);
  check("verify zero: exactly one Verifier run (no retry)", countRole(events, "verifier") === 1,
    {verifier: countRole(events, "verifier")});
  check("verify zero: the one Verifier call FAILed", verifies.length === 1 && verifies[0] === "FAIL", verifies);
  check("verify zero: state.phase is escalated", state.phase === "escalated", {phase: state.phase});
  check("verify zero: lastFailureBudget records the verification budget with limit 0",
    state.lastFailureBudget?.budget === "verificationFailureBudget"
    && state.lastFailureBudget?.limit === 0
    && state.lastFailureBudget?.used === 1
    && state.lastFailureBudget?.allowed === false,
    state.lastFailureBudget);
}

if (failures) {
  console.error(`${failures} zero SpecKit failure-budget check(s) failed.`);
  process.exit(1);
}
console.log("zero SpecKit implementation/verification failure-budget tests passed");
