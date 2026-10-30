#!/usr/bin/env node
// Item 5, GSD twin: the FINAL independent plan-check review is not a one-shot
// gate. A plan-check FAIL must re-run the native plan stage with the review
// findings and re-review the saved plans while max_plan_revisions remains.
//
// The fixture FAILs the first two final plan-check reviews and PASSes the
// third; the earlier discuss/research/plan stage reviews PASS normally. Real
// `node scripts/autopilot.mjs run` subprocesses are used, so the evidence is
// the orchestrator's own Planner planRevision records and reviewer verdicts.
import fs from "node:fs";
import path from "node:path";
import {
  makeFixtureRepo, makeFixtureBin, setScenario, writeConfig,
  runAutopilot, readObservedEvents, cleanup,
} from "./test-fixtures/workflow-order-harness.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}
const PLAN_CHECK = 'Review the GSD planning stage "plan-check"';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
function walkStatuses(repo) {
  const out = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "status.json") {
        const data = readJson(full);
        if (data) out.push(data);
      }
    }
  })(path.join(repo, ".autopilot"));
  return out;
}
function walkResults(repo) {
  const out = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "result.json") {
        const data = readJson(full);
        const briefPath = path.join(path.dirname(full), "brief.txt");
        const brief = fs.existsSync(briefPath) ? fs.readFileSync(briefPath, "utf8") : "";
        if (data) out.push({data, brief});
      }
    }
  })(path.join(repo, ".autopilot"));
  return out;
}

const repo = makeFixtureRepo("gsd-plan-check-loop");
const binDir = makeFixtureBin("gsd-plan-check-loop");
try {
  fs.mkdirSync(path.join(repo, ".planning"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".planning", "ROADMAP.md"), "# Roadmap\n\n## Phase 1: Foundation\n");
  fs.writeFileSync(path.join(repo, ".planning", "STATE.md"), "# State\n");
  writeConfig(repo, {
    planningFramework: "gsd",
    maxPlanRevisions: 3,
    gsdOverrides: {
      run_plan_verify: false,
      planning_review: {
        enabled: true, review_after_each_stage: true,
        stages: ["discuss", "research", "plan", "plan-check"],
        max_revisions: 3, read_only_reviewer: true,
      },
    },
  });
  const configPath = path.join(repo, ".autopilot", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.workflow.gsdPlanningReview = true;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  setScenario(repo, "gsd_plan_check_fail_twice");

  const run = runAutopilot(repo, binDir, {
    request: "plan the fixture phase",
    timeoutMs: process.platform === "win32" ? 240000 : 180000,
  });
  const output = `${run.stdout}\n${run.stderr}`;
  const events = readObservedEvents(repo);
  const results = walkResults(repo);
  const statuses = walkStatuses(repo);
  const planChecks = results
    .filter((r) => r.data.role === "plan_reviewer" && r.brief.includes(PLAN_CHECK))
    .sort((a, b) => Date.parse(a.data.startedAt) - Date.parse(b.data.startedAt));
  const revisions = results
    .filter((r) => r.data.role === "planner" && Number.isInteger(r.data.planRevision) && r.data.planRevision > 0)
    .map((r) => r.data.planRevision)
    .sort((a, b) => a - b);

  check("plan-check: the planning stage completed (no final-review one-shot death)",
    !output.includes("plans failed final planning review"), output.slice(-900));
  check("plan-check: the final review ran three times (FAIL, FAIL, PASS)",
    planChecks.length === 3
      && planChecks[0].data.verdict?.decision === "FAIL"
      && planChecks[1].data.verdict?.decision === "FAIL"
      && planChecks[2].data.verdict?.decision === "PASS",
    planChecks.map((r) => r.data.verdict?.decision));
  check("plan-check: each revised plan stage was recorded as planRevision 1 then 2",
    JSON.stringify(revisions) === JSON.stringify([1, 2]), revisions);
  check("plan-check: the later reviews were handed the previous findings",
    planChecks[1].brief.includes("plan-check still needs a revision")
      && planChecks[2].brief.includes("plan-check still needs a revision"),
    planChecks.map((r) => r.brief.includes("plan-check still needs a revision")));
  // Backlog #6: every GSD planning run records the stage it worked on, so the
  // WATCH-REPORT TASK column names discuss/research/plan/plan-check.
  const stageList = statuses
    .filter((s) => s && (s.role === "planner" || s.role === "plan_reviewer"))
    .sort((a, b) => (Date.parse(a.started_at) || 0) - (Date.parse(b.started_at) || 0))
    .map((s) => s.planningStage);
  check("plan-check: every planning run records a GSD stage",
    stageList.length > 0 && stageList.every((stage) => ["discuss", "research", "plan", "plan-check"].includes(stage)), stageList);
  check("plan-check: the plan-check stage is recorded on its runs",
    stageList.includes("plan-check"), stageList);
  const state = readJson(path.join(repo, ".autopilot", "state.json"));
  check("plan-check: the mission did not escalate",
    state?.phase !== "escalated" && !output.includes("ERROR:"),
    {phase: state?.phase, tail: output.slice(-900)});
} finally {
  cleanup(repo, binDir);
}

if (failures) {
  console.error(`${failures} GSD plan-check revision-loop check(s) failed.`);
  process.exit(1);
}
console.log("GSD plan-check revision-loop tests passed");
