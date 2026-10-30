#!/usr/bin/env node
// Item 5: a SpecKit gate re-review FAIL is another revision round while the
// plan_revisions budget remains — not a one-shot escalation. Drives real
// `node scripts/autopilot.mjs run` subprocesses with a fixture that FAILs the
// initial gate review and the first post-revision re-review, then PASSes.
//
// Case A (budget 3): two Planner revisions and two post-revision re-reviews
// happen, planReviewRevisions[speckit-stage:specify] reaches 2, and the gate
// passes instead of dying on the first re-review FAIL.
// Case B (budget 1): the same scenario may spend only one revision; the first
// re-review FAIL is then the escalation point.
import fs from "node:fs";
import path from "node:path";
import {
  makeFixtureRepo, makeFixtureBin, makeSpecKitPhaseFixture, setScenario,
  writeConfig, runAutopilot, readObservedEvents, cleanup,
} from "./test-fixtures/workflow-order-harness.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}
function readState(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
}
function countRole(events, role) {
  return events.filter((e) => e.role === role).length;
}
function briefs(repo) {
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
function resultData(repo) {
  const out = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "result.json") {
        try { out.push(JSON.parse(fs.readFileSync(full, "utf8"))); } catch { /* transient */ }
      }
    }
  })(path.join(repo, ".autopilot"));
  return out;
}
function statusData(repo) {
  const out = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "status.json") {
        try { out.push(JSON.parse(fs.readFileSync(full, "utf8"))); } catch { /* transient */ }
      }
    }
  })(path.join(repo, ".autopilot"));
  return out;
}
function runCase(prefix, maxPlanRevisions) {
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  try {
    makeSpecKitPhaseFixture(repo);
    writeConfig(repo, {planningFramework: "speckit", maxPlanRevisions});
    setScenario(repo, "speckit_rereview_gate_fail_twice");
    const run = runAutopilot(repo, binDir, {
      request: "implement the fixture task",
      timeoutMs: process.platform === "win32" ? 240000 : 180000,
    });
    return {run, events: readObservedEvents(repo), state: readState(repo), briefs: briefs(repo), results: resultData(repo), statuses: statusData(repo)};
  } finally {
    cleanup(repo, binDir);
  }
}

// Case A: two revisions granted, second re-review PASSes.
{
  const {run, events, results, statuses, briefs: allBriefs} = runCase("speckit-plan-loop-two-revisions", 3);
  const reviews = events.filter((e) => e.role === "plan_reviewer");
  const reReviews = allBriefs.filter((b) => b.includes('Re-review the SpecKit gate "review-spec"'));
  // Two revisions, then the plan/tasks stages: the initial specify Planner
  // plus two revisions plus plan plus tasks = five planner runs.
  check("two: mission does not die inside the gate (gate loop continues past the first re-review FAIL)",
    !`${run.stdout}\n${run.stderr}`.includes("SpecKit gate review-spec failed"),
    `${run.stdout}\n${run.stderr}`.slice(-800));
  check("two: the Planner ran the initial stage, two revisions, then plan and tasks (five runs)",
    countRole(events, "planner") === 5, countRole(events, "planner"));
  check("two: the gate reviewer FAILed, FAILed again on the first re-review, then PASSed",
    reviews.length >= 3 && reviews[0].decision === "FAIL" && reviews[1].decision === "FAIL" && reviews[2].decision === "PASS",
    reviews.map((r) => r.decision));
  check("two: two post-revision re-reviews were paid",
    reReviews.length === 2, reReviews.length);
  // The gate CLEARS the counter on PASS, so assert the two spent revisions
  // through the Planner runs' recorded planRevision (WATCH-REPORT's source).
  const revisionRuns = results
    .filter((r) => r.role === "planner" && Number.isInteger(r.planRevision))
    .map((r) => r.planRevision);
  check("two: both revisions were recorded on the Planner runs (1 then 2)",
    JSON.stringify(revisionRuns) === JSON.stringify([1, 2]), revisionRuns);
  check("two: the zero-or-exhaustion death was not reached", !`${run.stdout}\n${run.stderr}`.includes("plan revision budget is spent"),
    `${run.stdout}\n${run.stderr}`.slice(-800));
  // Backlog #6: every SpecKit planning run records the stage it worked on, so
  // the WATCH-REPORT TASK column can name spec/plan/tasks instead of plan/tasks.
  const planningStatuses = statuses
    .filter((s) => s && (s.role === "planner" || s.role === "plan_reviewer"))
    .sort((a, b) => (Date.parse(a.started_at) || 0) - (Date.parse(b.started_at) || 0));
  const stageList = planningStatuses.map((s) => s.planningStage);
  check("two: every planning run records a SpecKit stage",
    stageList.length > 0 && stageList.every((stage) => ["spec", "plan", "tasks"].includes(stage)), stageList);
  check("two: the first planning run records spec", stageList[0] === "spec", stageList);
  check("two: spec, plan and tasks are all recorded", new Set(stageList).size === 3, stageList);
}

// Case B: the configured budget is still a hard limit.
{
  const {run, events, state, briefs: allBriefs} = runCase("speckit-plan-loop-budget-one", 1);
  const output = `${run.stdout}\n${run.stderr}`;
  check("one: the mission fails once the one allowed revision is re-review FAILed",
    run.status !== 0, {status: run.status, timedOut: run.timedOut});
  check("one: it names the failed gate", output.includes("SpecKit gate review-spec failed"), output.slice(-800));
  check("one: the Planner ran the initial stage plus exactly one revision",
    countRole(events, "planner") === 2, countRole(events, "planner"));
  check("one: exactly one post-revision re-review was paid",
    allBriefs.filter((b) => b.includes('Re-review the SpecKit gate "review-spec"')).length === 1,
    allBriefs.length);
  check("one: one revision was recorded",
    state.planReviewRevisions?.["speckit-stage:specify"] === 1, state.planReviewRevisions);
}

if (failures) {
  console.error(`${failures} SpecKit plan-revision loop check(s) failed.`);
  process.exit(1);
}
console.log("SpecKit plan-revision loop tests passed");
