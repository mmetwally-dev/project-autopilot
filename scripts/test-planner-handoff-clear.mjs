#!/usr/bin/env node
// Backlog #7: a completed planner run must clear its hand-off note.
//
// The bug: run 46's COMPLETED planner revision left handoff/...planner.md on
// disk; a later revision (run 50) wrote no note and died RATE_LIMITED, so its
// fallback (run 51) was handed the earlier, finished revision's note as
// "Prior planner handoff note (continuation context)". All three loops
// (standalone, SpecKit, GSD) now clear the note when a planner run finishes
// uncapped, mirroring the plan_reviewer path.
//
// Wiring is pinned for all three loops (autopilot.mjs runs main() on import,
// so it cannot be imported), and the standalone lifecycle is exercised for
// real through `node scripts/autopilot.mjs run`: the fixture Planner completes
// and writes STALE-PLANNER-HANDOFF-MARKER, the reviewer FAILs to schedule a
// revision, and the revision hits a provider 429 so its configured fallback
// relaunches with the SAME prompt. Both revision briefs must be free of the
// stale note.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  makeFixtureRepo, makeFixtureBin, setScenario, writeConfig,
  runAutopilot, cleanup,
} from "./test-fixtures/workflow-order-harness.mjs";
import {handoffNoteRelPath} from "./per-task-budget.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CAP_FIXTURE = path.join(here, "test-fixtures", "fake-cap-breach-adapter.mjs");
const autopilotSrc = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
const MISSION = "001-planner-handoff-clear";
const STALE = "STALE-PLANNER-HANDOFF-MARKER";
const PLAN = "# Plan\n\nObjective: planner hand-off clear probe.\n";
const TASKS = "## Phase 1: General\n\n- [ ] Do the fixture task — accept: done ; verify: none\n";

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

// ── Wiring: all three planner loops clear the note on uncapped completion ──
{
  const start = autopilotSrc.indexOf("async function runStandalonePlanning");
  const end = autopilotSrc.indexOf("async function runSpecKitPlanning");
  const standalone = autopilotSrc.slice(start, end);
  const clearIdx = standalone.indexOf("clearHandoffNote(mission,'standalone-planning-planner')");
  const scopeIdx = standalone.indexOf("clearPlanningContinuationScope(s,'task:standalone:planning:planner')");
  check("wiring: standalone planner completion clears its hand-off note", clearIdx !== -1, clearIdx);
  check("wiring: standalone clear sits with the uncapped completion reset (not a capped branch)",
    clearIdx !== -1 && scopeIdx !== -1 && clearIdx > scopeIdx
    && clearIdx < standalone.indexOf("writeStandaloneReviewerPendingCheckpoint(s,mission)", clearIdx),
    {clearIdx, scopeIdx});
}
{
  const start = autopilotSrc.indexOf("async function runPlanningPhase");
  const end = autopilotSrc.indexOf("function boundaryNoteFor", start);
  const speckit = autopilotSrc.slice(start, end);
  check("wiring: SpecKit planner completion derives the shared planner taskRef",
    speckit.includes('const {taskRef:plannerTaskRef,contScope:plannerContScope}=planningScopeParts("speckit","planner");'));
  check("wiring: SpecKit planner completion clears its hand-off note after the uncapped reset",
    speckit.indexOf("clearPlanningContinuationScope(s,plannerContScope)") !== -1
    && speckit.indexOf("clearHandoffNote(s.mission,plannerTaskRef)") > speckit.indexOf("clearPlanningContinuationScope(s,plannerContScope)"));
}
{
  const start = autopilotSrc.indexOf("async function gsdPlanningStage");
  const end = autopilotSrc.indexOf("async function reviewGsdPlanningStage", start);
  const gsd = autopilotSrc.slice(start, end);
  check("wiring: GSD planner completion clears its hand-off note after the uncapped reset",
    gsd.indexOf("clearPlanningContinuationScope(s,contScope)") !== -1
    && gsd.indexOf("clearHandoffNote(s.mission,taskRef)") > gsd.indexOf("clearPlanningContinuationScope(s,contScope)"));
}

// ── Behaviour: completed planner revision -> later revision's fallback ──
const repo = makeFixtureRepo("planner-handoff-clear");
const binDir = makeFixtureBin("planner-handoff-clear");
try {
  // Same sandbox-safe embedding as test-planning-continuation-reset: the
  // read-only review role's envelope binds only the adapter executable.
  const fixtureB64 = fs.readFileSync(CAP_FIXTURE).toString("base64");
  const runner = `await import("data:text/javascript;base64,"+process.env.FIXTURE_B64)`;
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "opencode.cmd"),
      `@echo off\r\nset "FIXTURE_B64=${fixtureB64}"\r\n"${process.execPath}" --input-type=module -e '${runner}' opencode %*\r\nexit /b %errorlevel%\r\n`);
  } else {
    fs.writeFileSync(path.join(binDir, "opencode"),
      `#!/bin/sh\nFIXTURE_B64='${fixtureB64}'\nexport FIXTURE_B64\nexec "${process.execPath}" --input-type=module -e '${runner}' opencode "$@"\n`);
    fs.chmodSync(path.join(binDir, "opencode"), 0o755);
  }
  writeConfig(repo, {planningFramework: "standalone", maxPlanRevisions: 3});
  const configPath = path.join(repo, ".autopilot", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.roles.planner.adapter = "opencode";
  config.roles.plan_reviewer.adapter = "opencode";
  // A configured fallback is what makes the revision relaunch after the 429.
  config.roles.planner.fallbacks = [{adapter: "opencode", model: "fallback-model"}];
  config.policy = {
    ...config.policy,
    per_task_timeout_ms: 60000,
    per_task_max_turns: 30,
    caps: {
      planner: {max_turns: 30, max_tokens: 200000, extra_sessions: 1},
      plan_reviewer: {max_turns: 30, max_tokens: 150000, extra_sessions: 1},
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  setScenario(repo, "planner_stale_note_then_rate_limit");
  const planFile = path.join(repo, ".autopilot", "missions", MISSION, "PLAN.md");
  const tasksFile = path.join(repo, ".autopilot", "missions", MISSION, "TASKS.md");
  fs.mkdirSync(path.dirname(planFile), {recursive: true});
  fs.writeFileSync(planFile, PLAN);
  fs.writeFileSync(tasksFile, TASKS);
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
    version: 1, phase: "planning", step: "standalone_planning",
    mission: MISSION, planningRequest: "planner hand-off clear probe",
  }, null, 2));

  const run = runAutopilot(repo, binDir, {
    request: "planner hand-off clear probe",
    stage: "planning",
    timeoutMs: process.platform === "win32" ? 240000 : 180000,
  });
  const output = `${run.stdout}\n${run.stderr}`;

  const auditPath = path.join(repo, ".autopilot", ".fixture-stale-planner-note");
  const audit = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, "utf8") : "";
  check("setup: the completed initial Planner really wrote the stale note", audit.includes(STALE), audit.slice(0, 200));

  const noteAbs = path.join(repo, handoffNoteRelPath(MISSION, "standalone-planning-planner"));
  check("behaviour: the completed Planner's hand-off note is gone from disk", !fs.existsSync(noteAbs), noteAbs);

  const briefs = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "brief.txt") briefs.push(fs.readFileSync(full, "utf8"));
    }
  })(path.join(repo, ".autopilot"));
  const plannerBriefs = briefs.filter((b) => b.includes("Create or continue an implementation plan"));
  const revisionBriefs = plannerBriefs.filter((b) => b.includes("This is a REVISION round"));
  check("behaviour: the planner ran an initial run plus a revision and its fallback",
    plannerBriefs.length >= 2 && revisionBriefs.length >= 2,
    {plannerBriefs: plannerBriefs.length, revisionBriefs: revisionBriefs.length, tail: output.slice(-500)});
  check("behaviour: the rate-limit fallback actually relaunched the planner",
    /fallback: planner /i.test(output), output.slice(-800));
  check("behaviour: no revision brief carries the finished revision's hand-off note",
    revisionBriefs.every((b) => !b.includes("Prior planner handoff note") && !b.includes(STALE)),
    revisionBriefs.map((b) => b.includes(STALE)));
} finally {
  cleanup(repo, binDir);
}

if (failures) {
  console.error(`${failures} planner hand-off clear check(s) failed.`);
  process.exit(1);
}
console.log("planner hand-off clear tests passed");
