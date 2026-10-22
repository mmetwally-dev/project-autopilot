#!/usr/bin/env node
// Behavioral proof of the required workflow order (Planning -> Plan Review
// -> Implementation -> Code Review -> Verification) and its failure
// transitions, using the standalone planning framework. Drives a real
// `node scripts/autopilot.mjs run` subprocess against a disposable fixture
// repo and a fake adapter CLI, then asserts the OBSERVED role-invocation
// order and PASS/FAIL decisions recorded in each relay's result.json — not
// a source-string check.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {makeFixtureRepo, makeFixtureBin, setScenario, writeConfig, runAutopilot, readObservedEvents, cleanup} from "./test-fixtures/workflow-order-harness.mjs";


let failures = 0;
function check(name, condition) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
}

function firstIndex(events, role, predicate = () => true) {
  return events.findIndex(e => e.role === role && predicate(e));
}
function countRole(events, role) {
  return events.filter(e => e.role === role).length;
}

// ---- 1. Successful flow: Planning -> Plan Review PASS -> Implementation
//      -> Code Review PASS -> Verification PASS ----
{
  const repo = makeFixtureRepo("success");
  const binDir = makeFixtureBin("success");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    setScenario(repo, "success");
    const run = runAutopilot(repo, binDir, {request: "implement the fixture task"});
    const events = readObservedEvents(repo);
    const order = events.map(e => e.role);

    check("successful flow: mission completed (exit 0)", run.status === 0);
    check("successful flow: planner ran", order.includes("planner"));
    check("successful flow: plan_reviewer ran and PASSed",
      events.some(e => e.role === "plan_reviewer" && e.decision === "PASS"));
    check("successful flow: implementer ran after plan_reviewer PASS",
      firstIndex(events, "implementer") > firstIndex(events, "plan_reviewer", e => e.decision === "PASS"));
    check("successful flow: code_reviewer ran and PASSed after implementer",
      events.some((e, i) => e.role === "code_reviewer" && e.decision === "PASS" && i > firstIndex(events, "implementer")));
    check("successful flow: verifier ran and PASSed after a code_reviewer PASS",
      (() => {
        const v = firstIndex(events, "verifier");
        if (v === -1) return false;
        const priorReviews = events.slice(0, v).filter(e => e.role === "code_reviewer");
        return priorReviews.length > 0 && priorReviews[priorReviews.length - 1].decision === "PASS" && events[v].decision === "PASS";
      })());
    check("successful flow: role order is Planning-group then Implementation-group then a final code_reviewer",
      order[0] === "planner" && order[1] === "plan_reviewer");
  } finally {
    cleanup(repo, binDir);
  }
}

// ---- 2. Plan Review FAIL: Planning -> Plan Review FAIL -> Planning again;
//      Implementation never starts before a later Plan Review PASS ----
{
  const repo = makeFixtureRepo("plan-review-fail");
  const binDir = makeFixtureBin("plan-review-fail");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    setScenario(repo, "plan_review_fail");
    const run = runAutopilot(repo, binDir, {request: "implement the fixture task"});
    const events = readObservedEvents(repo);

    const reviews = events.filter(e => e.role === "plan_reviewer");
    check("plan review fail: plan_reviewer was called at least twice (fail then pass)", reviews.length >= 2);
    check("plan review fail: first plan_reviewer call FAILed", reviews[0]?.decision === "FAIL");
    check("plan review fail: a later plan_reviewer call PASSed", reviews.some(e => e.decision === "PASS"));

    const plannerCalls = countRole(events, "planner");
    check("plan review fail: planner was invoked again after the FAIL (returned to Planning)", plannerCalls >= 2);

    const firstPassIndex = events.findIndex(e => e.role === "plan_reviewer" && e.decision === "PASS");
    const firstImplementerIndex = firstIndex(events, "implementer");
    check("plan review fail: Implementation never starts before a later Plan Review PASS",
      firstPassIndex !== -1 && (firstImplementerIndex === -1 || firstImplementerIndex > firstPassIndex));

    check("plan review fail: mission eventually completed once plan review passed", run.status === 0);
  } finally {
    cleanup(repo, binDir);
  }
}

// ---- 3 & 6. Code Review FAIL: Implementation -> Code Review FAIL ->
//      Implementation again; no gate command runs, no task verification
//      command runs, Verifier is never launched before a later Code Review
//      PASS. (Standalone's single per-task loop is the same code path
//      required test #6 — "standalone Code Reviewer must run and PASS
//      before gates/Verifier start" — asserts.) ----
{
  const repo = makeFixtureRepo("code-review-fail");
  const binDir = makeFixtureBin("code-review-fail");
  const marker = path.join(repo, "gate-marker.txt");
  try {
    writeConfig(repo, {
      planningFramework: "standalone",
      gatesCommands: [`echo ran >> "${marker}"`]
    });
    setScenario(repo, "code_review_fail");
    const run = runAutopilot(repo, binDir, {request: "implement the fixture task"});
    const events = readObservedEvents(repo);

    const reviews = events.filter(e => e.role === "code_reviewer");
    check("code review fail: code_reviewer was called at least twice (fail then pass)", reviews.length >= 2);
    check("code review fail: first code_reviewer call FAILed", reviews[0]?.decision === "FAIL");
    check("code review fail: a later code_reviewer call PASSed", reviews.some(e => e.decision === "PASS"));

    const implementerCalls = countRole(events, "implementer");
    check("code review fail: implementer was invoked again after the FAIL (returned to Implementation)", implementerCalls >= 2);

    const firstFailIndex = events.findIndex(e => e.role === "code_reviewer" && e.decision === "FAIL");
    const firstPassIndex = events.findIndex(e => e.role === "code_reviewer" && e.decision === "PASS");
    const firstVerifierIndex = firstIndex(events, "verifier");
    check("code review fail: Verifier never launched before a later Code Review PASS",
      firstPassIndex !== -1 && (firstVerifierIndex === -1 || firstVerifierIndex > firstPassIndex));

    const gateRanBeforeFirstPass = fs.existsSync(marker)
      ? fs.statSync(marker).mtimeMs < Date.parse(events[firstPassIndex]?.startedAt || 0)
      : false;
    check("code review fail: no gate command ran before Code Review PASS", !gateRanBeforeFirstPass);
    check("code review fail (== standalone test 6): gate command ran only after Code Review PASS", fs.existsSync(marker));

    check("code review fail: FAIL happened before the retry (chronological order)", firstFailIndex < firstPassIndex);
    check("code review fail: mission eventually completed once code review passed", run.status === 0);
  } finally {
    cleanup(repo, binDir);
  }
}

// ---- 4. Verification FAIL: Implementation -> Code Review PASS ->
//      Verification FAIL -> Implementation -> Code Review PASS ->
//      Verification again ----
{
  const repo = makeFixtureRepo("verification-fail");
  const binDir = makeFixtureBin("verification-fail");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    setScenario(repo, "verification_fail");
    const run = runAutopilot(repo, binDir, {request: "implement the fixture task"});
    const events = readObservedEvents(repo);

    const verifierCalls = events.filter(e => e.role === "verifier");
    check("verification fail: verifier was called at least twice (fail then pass)", verifierCalls.length >= 2);
    check("verification fail: first verifier call FAILed", verifierCalls[0]?.decision === "FAIL");
    check("verification fail: a later verifier call PASSed", verifierCalls.some(e => e.decision === "PASS"));

    const codeReviews = events.filter(e => e.role === "code_reviewer");
    check("verification fail: Code Review ran at least twice (repeated after the repair loop)", codeReviews.length >= 2);
    check("verification fail: every Code Review before the final Verifier PASS was itself a PASS (Code Review always gated Verification)",
      (() => {
        const lastVerifierPassIndex = events.map(e => e.role === "verifier" && e.decision === "PASS").lastIndexOf(true);
        const priorReviews = events.slice(0, lastVerifierPassIndex).filter(e => e.role === "code_reviewer");
        return priorReviews.length > 0 && priorReviews.every(e => e.decision === "PASS");
      })());

    const implementerCalls = countRole(events, "implementer");
    check("verification fail: implementer was invoked again after the verification FAIL (returned to Implementation)", implementerCalls >= 2);

    check("verification fail: mission eventually completed once verification passed", run.status === 0);
  } finally {
    cleanup(repo, binDir);
  }
}

if (failures) {
  console.error(`${failures} workflow-order (standalone) check(s) failed.`);
  process.exit(1);
}
console.log("workflow-order standalone behavioral tests passed");
