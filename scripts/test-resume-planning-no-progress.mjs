#!/usr/bin/env node
// Backlog #21 — the printed resume command after a standalone
// `standalone_planning_no_progress` stop must work.
//
// The stop prints `Resume: ap reset --scope task:standalone:planning:planner
// then ap run`, but a bare `ap run` (and `ap run --mission <name>`) used to
// die with "No open task to continue and no feature description provided"
// because the escalated planning state has no PLAN.md yet and the stored
// `s.planningRequest` was not used as the effective request.
//
// Real subprocesses against the shared disposable fixture repo + fake
// adapter (same harness as the standalone planning tests):
//   (a) after the allowance reset, a plain `ap run` continues the SAME
//       escalated mission: the planner runs, PLAN.md lands in that mission's
//       directory, no new mission is created, and the "No open task" death is
//       absent;
//   (b) `ap run --mission <name>` does the same;
//   (c) with no open mission and no stored request, a plain run still dies
//       with the existing message.
//
// The plan_reviewer scenario FAILs once and maxPlanRevisions is 0, so each
// resume stops right after the planner + reviewer instead of running a whole
// implementation mission.
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {
  makeFixtureRepo, makeFixtureBin, writeConfig, setScenario,
  readObservedEvents, withoutOuterGitGuard, skillRoot
} from "./test-fixtures/workflow-order-harness.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

const MISSION = "099-resume-planning-no-progress";
const CONT_SCOPE = "task:standalone:planning:planner";
const CONT_KEY = `continuationAllowance:${CONT_SCOPE}`;
const REQUEST = "continue the escalated planning mission";

function readState(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
}
function writeState(repo, state) {
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(state, null, 2));
}

function seedEscalatedPlanning(repo) {
  const missionDir = path.join(repo, ".autopilot", "missions", MISSION);
  fs.mkdirSync(path.join(missionDir, "handoff"), {recursive: true});
  fs.writeFileSync(
    path.join(missionDir, "handoff", "standalone-planning-planner.md"),
    "1. Done — nothing yet\n2. Found — plan not written\n3. Next — write PLAN.md\n4. Dead ends — none\n"
  );
  writeState(repo, {
    version: 1,
    phase: "escalated",
    step: "standalone_planning_no_progress",
    mission: MISSION,
    missionSeq: "099",
    planningRequest: REQUEST,
    continuationBudgets: {[CONT_KEY]: 2},
    rolloverDeadEnds: {[CONT_KEY]: [{generation: 1, reason: "turns", used: 40, limit: 40, tail: "dead end"}]},
    lastContinuation: {
      key: CONT_KEY, scope: CONT_SCOPE, taskId: null, mission: MISSION,
      taskRef: "standalone-planning-planner", at: "2026-10-26T00:00:00.000Z"
    }
  });
}

function makeRepo(prefix) {
  const repo = makeFixtureRepo(prefix);
  writeConfig(repo, {planningFramework: "standalone", maxPlanRevisions: 0});
  setScenario(repo, "plan_review_fail");
  return repo;
}

function runCommand(repo, binDir, args) {
  const base = withoutOuterGitGuard(process.env);
  const env = {...base, PATH: `${binDir}${path.delimiter}${base.PATH || ""}`};
  delete env.AUTOPILOT_SPEC;
  const result = spawnSync(process.execPath, [...args, "--repo", repo], {
    cwd: repo, encoding: "utf8", env, timeout: 120000, stdio: ["ignore", "pipe", "pipe"], shell: false
  });
  return {
    status: result.status,
    out: `${result.stdout || ""}${result.stderr || ""}`,
    timedOut: !!result.error && result.error.code === "ETIMEDOUT"
  };
}

function resetAllowance(repo, binDir) {
  return runCommand(repo, binDir, [path.join(skillRoot, "bin", "ap.cjs"), "reset", "--scope", CONT_SCOPE]);
}

function runAp(repo, binDir, extraArgs) {
  return runCommand(repo, binDir, [path.join(skillRoot, "scripts", "autopilot.mjs"), "run", ...extraArgs]);
}

// Shared assertions for (a) and (b): the resumed run planned the SAME mission.
function assertResumedPlanning(label, repo, binDir) {
  const reset = resetAllowance(repo, binDir);
  const afterReset = readState(repo);
  check(`${label}: allowance reset succeeds`,
    reset.status === 0 && !(afterReset.continuationBudgets || {})[CONT_KEY],
    {status: reset.status, out: reset.out, budgets: afterReset.continuationBudgets});

  const run = runAp(repo, binDir, label === "b" ? ["--mission", MISSION] : []);
  const after = readState(repo);
  const events = readObservedEvents(repo);
  const missions = fs.readdirSync(path.join(repo, ".autopilot", "missions")).filter((name) =>
    fs.statSync(path.join(repo, ".autopilot", "missions", name)).isDirectory());

  check(`${label}: run does not die with "No open task"`,
    !run.timedOut && !run.out.includes("No open task to continue"), {status: run.status, out: run.out});
  check(`${label}: planner runs on the resumed mission`,
    events.some((event) => event.role === "planner"), events.map((event) => event.role));
  check(`${label}: PLAN.md is written into the same mission`,
    fs.existsSync(path.join(repo, ".autopilot", "missions", MISSION, "PLAN.md")), missions);
  check(`${label}: no new mission directory is created`,
    missions.length === 1 && missions[0] === MISSION, missions);
  check(`${label}: mission identity and stored request are unchanged`,
    after.mission === MISSION && after.planningRequest === REQUEST, {mission: after.mission, request: after.planningRequest});
  check(`${label}: mission advanced past the no-progress stop`,
    after.step !== "standalone_planning_no_progress", {phase: after.phase, step: after.step});
}

// (a) plain `ap run` (no request text) resumes.
{
  const repo = makeRepo("resume-plan-no-progress-bare");
  const binDir = makeFixtureBin("resume-plan-no-progress-bare");
  seedEscalatedPlanning(repo);
  assertResumedPlanning("a", repo, binDir);
}

// (b) `ap run --mission <name>` resumes.
{
  const repo = makeRepo("resume-plan-no-progress-mission");
  const binDir = makeFixtureBin("resume-plan-no-progress-mission");
  seedEscalatedPlanning(repo);
  assertResumedPlanning("b", repo, binDir);
}

// (c) no open mission and no stored request still dies with the same message.
{
  const repo = makeRepo("resume-plan-no-progress-none");
  const binDir = makeFixtureBin("resume-plan-no-progress-none");
  const run = runAp(repo, binDir, []);
  check("c: plain run with no mission and no stored request still dies",
    !run.timedOut && run.status !== 0
    && run.out.includes("No open task to continue and no feature description provided."),
    {status: run.status, out: run.out});
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log("\nAll checks passed.");
}
