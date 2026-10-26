#!/usr/bin/env node
// Backlog #100 phase 3 task 3.3 — zero adapter (cli_errors) and infrastructure
// failure budgets in the STANDALONE loop.
//
// Drives real `node scripts/autopilot.mjs run` standalone missions against
// the shared fake-adapter harness with `policy.failure_budgets` set to 0:
//
// Case A: adapterRetryBudget = 0 (the `cli_errors` setting) with the
// `implementer_adapter_retryable_always` scenario (the first Implementer call
// exits nonzero with generic adapter stderr, retryable). The very first
// failure is the configured escalation point: exactly one Implementer run, no
// Code Reviewer, no Verifier, no Implementer retry, state.phase "escalated",
// and state.lastFailureBudget records adapterRetryBudget with limit 0.
//
// Case B: infrastructureRetryBudget = 0 with `standalone_verifier_infra_once`
// (the first Verifier call exits nonzero with a SERVER_UNAVAILABLE stderr
// line, retryable infrastructure; a retry would PASS). Exactly one Implementer,
// one Code Reviewer PASS and one Verifier failure run; no retry of any role;
// state.phase "escalated" with state.lastFailureBudget recording
// infrastructureRetryBudget and limit 0.
import fs from "node:fs";
import path from "node:path";
import {makeFixtureRepo, makeFixtureBin, setScenario, writeConfig, runAutopilot, readObservedEvents, cleanup} from "./test-fixtures/workflow-order-harness.mjs";

const RUN_TIMEOUT_MS = 120000;

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

function statuses(events, role) {
  return events.filter(e => e.role === role).map(e => e.status);
}

function readState(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
}

function runMission(prefix, scenario, failureBudgets) {
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  try {
    writeConfig(repo, {planningFramework: "standalone", failureBudgets});
    setScenario(repo, scenario);
    const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: RUN_TIMEOUT_MS});
    return {run, events: readObservedEvents(repo), state: readState(repo)};
  } finally {
    cleanup(repo, binDir);
  }
}

// ---- A. adapterRetryBudget (cli_errors): 0 denies the retry after one FAIL ----
{
  const {run, events, state} = runMission(
    "budget-zero-adapter-standalone",
    "implementer_adapter_retryable_always",
    {adapterRetryBudget: 0}
  );

  check("adapter zero: mission escalates (nonzero exit)", run.status !== 0, {status: run.status, timedOut: run.timedOut});
  check("adapter zero: exactly one Implementer run (no retry)", countRole(events, "implementer") === 1,
    {implementer: countRole(events, "implementer")});
  check("adapter zero: no Code Reviewer ever ran", countRole(events, "code_reviewer") === 0,
    {code_reviewer: countRole(events, "code_reviewer")});
  check("adapter zero: no Verifier ever ran", countRole(events, "verifier") === 0,
    {verifier: countRole(events, "verifier")});
  check("adapter zero: the one Implementer call failed", statuses(events, "implementer")[0] === "failed",
    statuses(events, "implementer"));
  check("adapter zero: state.phase is escalated", state.phase === "escalated", {phase: state.phase});
  check("adapter zero: lastFailureBudget records adapterRetryBudget with limit 0",
    state.lastFailureBudget?.budget === "adapterRetryBudget"
    && state.lastFailureBudget?.limit === 0
    && state.lastFailureBudget?.used === 1
    && state.lastFailureBudget?.allowed === false
    && state.lastFailureBudget?.scope === "adapter:cursor:implementer",
    state.lastFailureBudget);
}

// ---- B. infrastructureRetryBudget: 0 denies the retry after one FAIL ----
{
  const {run, events, state} = runMission(
    "budget-zero-infra-standalone",
    "standalone_verifier_infra_once",
    {infrastructureRetryBudget: 0}
  );
  const reviews = decisions(events, "code_reviewer");
  const verifierStatuses = statuses(events, "verifier");

  check("infra zero: mission escalates (nonzero exit)", run.status !== 0, {status: run.status, timedOut: run.timedOut});
  check("infra zero: exactly one Implementer run (no retry)", countRole(events, "implementer") === 1,
    {implementer: countRole(events, "implementer")});
  check("infra zero: exactly one Code Reviewer run and it PASSed",
    reviews.length === 1 && reviews[0] === "PASS", reviews);
  check("infra zero: exactly one Verifier run (no retry)", countRole(events, "verifier") === 1,
    {verifier: countRole(events, "verifier")});
  check("infra zero: the one Verifier call failed", verifierStatuses.length === 1 && verifierStatuses[0] === "failed",
    verifierStatuses);
  check("infra zero: state.phase is escalated", state.phase === "escalated", {phase: state.phase});
  check("infra zero: lastFailureBudget records infrastructureRetryBudget with limit 0",
    state.lastFailureBudget?.budget === "infrastructureRetryBudget"
    && state.lastFailureBudget?.limit === 0
    && state.lastFailureBudget?.used === 1
    && state.lastFailureBudget?.allowed === false
    && state.lastFailureBudget?.scope === "mission",
    state.lastFailureBudget);
}

if (failures) {
  console.error(`${failures} zero standalone adapter/infrastructure failure-budget check(s) failed.`);
  process.exit(1);
}
console.log("zero standalone adapter/infrastructure failure-budget tests passed");
