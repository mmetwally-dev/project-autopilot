#!/usr/bin/env node
// Backlog #9 — capped plan_reviewer loses the review it already finished.
//
// Four behaviours, each pinned by a real `node scripts/autopilot.mjs run`
// subprocess against the self-contained fixture adapter
// (test-fixtures/fake-plan-reviewer-carry-adapter.mjs), plus unit checks of
// the note predicate:
//
//   (b) a capped reviewer whose fresh hand-off note says the review is
//       complete WITH a decided verdict gets one short verdict-only session
//       (the prompt carries VERDICT-ONLY TURN) instead of a full re-review;
//   (a) that next session sees the carried scratch dir (the report session 1
//       wrote) seeded under <scratch>/previous-session/;
//   (c) the same carried-scratch path preserves a downloaded PowerShell
//       runtime, so the brief tells the continuation not to download it again;
//   (d) two capped sessions in a row without a verdict STOP the mission
//       (PLAN_REVIEW_CAPPED_TWICE) instead of launching a third identical
//       review.
//
// The mission is a pre-seeded COMPLETE standalone mission (all tasks ticked)
// so `ap run --stage planning --repo <repo>` with no request enters
// reviewExistingPlanning(); the planner never runs and only plan_reviewer
// sessions appear in the run ledger. Assertions read the fixture's own
// AUTOPILOT_REVIEW notes (which record what prompt it actually received) and
// the orchestrator's persisted state/result.json — never prompt source text.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  makeFixtureRepo, makeFixtureBin, writeConfig, setScenario,
  runAutopilot, cleanup
} from "./test-fixtures/workflow-order-harness.mjs";
import {noteSaysReviewComplete} from "./per-task-budget.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "test-fixtures", "fake-plan-reviewer-carry-adapter.mjs");
const MISSION = "001-fixture-feature";
const PLAN = "# Plan\n\nObjective: plan-reviewer carry probe.\n";
const TASKS = "## Phase 1: General\n\n- [x] Do the fixture task — accept: done ; verify: none <!-- autopilot-requires: nothing -->\n";

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

// ── Unit: the note predicate that decides the verdict-only continuation ──
{
  const accepts = [
    "Review complete, verdict FAIL. Findings in final sentinel.",
    "1. Done — full review finished.\n2. Found — verdict: PASS",
    "verdict decided",
    "Decision: FAIL",
    "The audit is complete and the result is FAIL",
  ];
  for (const text of accepts) {
    check(`noteSaysReviewComplete accepts ${JSON.stringify(text.slice(0, 48))}`, noteSaysReviewComplete(text) === true, text);
  }
  const rejects = [
    "still reviewing",
    "verdict pending",
    "verdict not decided",
    "no verdict",
    "Review complete. All good.",
    "Review incomplete; verdict pending.",
    "",
    "   ",
    null,
    42,
  ];
  for (const text of rejects) {
    check(`noteSaysReviewComplete rejects ${JSON.stringify(text)}`,
      noteSaysReviewComplete(text) === false, text);
  }
}

// Read-only roles are sandboxed: the fixture must be reachable as the bound
// executable and self-contained. Embed it through a tiny node runner exactly
// like test-capped-final-verdict.mjs does.
function installFixture(prefix) {
  const binDir = makeFixtureBin(prefix);
  const fixtureB64 = fs.readFileSync(FIXTURE).toString("base64");
  if (process.platform === "win32") {
    const runner = `await import("data:text/javascript;base64,"+process.env.FIXTURE_B64)`;
    fs.writeFileSync(path.join(binDir, "opencode.cmd"),
      `@echo off\r\nset "FIXTURE_B64=${fixtureB64}"\r\n"${process.execPath}" --input-type=module -e "${runner}" opencode %*\r\nexit /b %errorlevel%\r\n`);
  } else {
    const runner = `await import("data:text/javascript;base64,"+process.env.FIXTURE_B64)`;
    const shim = path.join(binDir, "opencode");
    fs.writeFileSync(shim,
      `#!/bin/sh\nFIXTURE_B64='${fixtureB64}'\nexport FIXTURE_B64\nexec "${process.execPath}" --input-type=module -e '${runner}' opencode "$@"\n`);
    fs.chmodSync(shim, 0o755);
  }
  return binDir;
}

// Pre-seeded COMPLETE standalone mission: TASKS.md is fully checked, which is
// standalone.state()'s own "complete" definition, and state.json names it, so
// a no-request run resumes into reviewExistingPlanning() and stops after
// planning with --stage planning.
function setupScenario(prefix, scenario) {
  const repo = makeFixtureRepo(prefix);
  const binDir = installFixture(prefix);
  writeConfig(repo, {planningFramework: "standalone", maxPlanRevisions: 3});
  const configPath = path.join(repo, ".autopilot", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.roles.plan_reviewer.adapter = "opencode";
  config.policy = {
    ...config.policy,
    per_task_timeout_ms: 60000,
    per_task_max_turns: 5,
    caps: {plan_reviewer: {max_turns: 5, max_tokens: 150000, extra_sessions: 2}},
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const missionDir = path.join(repo, ".autopilot", "missions", MISSION);
  fs.mkdirSync(missionDir, {recursive: true});
  fs.writeFileSync(path.join(missionDir, "PLAN.md"), PLAN);
  fs.writeFileSync(path.join(missionDir, "TASKS.md"), TASKS);
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
    version: 1, phase: "idle", step: "idle",
    planningRequest: "fixture request", mission: MISSION, missionSeq: "001",
  }, null, 2));
  setScenario(repo, scenario);
  return {repo, binDir};
}

function walkResults(repo) {
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

function reviewerResults(repo) {
  return walkResults(repo)
    .filter((r) => r.role === "plan_reviewer")
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || Date.parse(a.finishedAt) - Date.parse(b.finishedAt));
}

function notesOf(result) {
  const notes = result?.verdict?.notes;
  return Array.isArray(notes) ? notes : [];
}

function readState(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
}

function runScenario(scenario, prefix) {
  const {repo, binDir} = setupScenario(prefix, scenario);
  try {
    const run = runAutopilot(repo, binDir, {
      request: "",
      stage: "planning",
      timeoutMs: process.platform === "win32" ? 240000 : 180000,
    });
    const carriedExists = fs.existsSync(path.join(
      repo, ".autopilot", "missions", MISSION, "handoff", "standalone-planning-plan_reviewer-scratch"));
    return {run, reviews: reviewerResults(repo), state: readState(repo), carriedExists};
  } finally {
    cleanup(repo, binDir);
  }
}

// ── (a) + (c): the next session receives the carried scratch ──
{
  const {run, reviews, state, carriedExists} = runScenario("carry", "plan-reviewer-carry");
  const second = notesOf(reviews[1]);
  check("carry: mission completes planning (exit 0)",
    run.status === 0, {status: run.status, tail: `${run.stdout}\n${run.stderr}`.slice(-900)});
  check("carry: exactly two reviewer sessions ran",
    reviews.length === 2, reviews.map((r) => ({status: r.status, capped: r.capped, decision: r.verdict?.decision})));
  check("carry: first session ended capped without a decided verdict",
    reviews[0]?.status === "capped" && !["PASS", "FAIL"].includes(reviews[0]?.verdict?.decision),
    {status: reviews[0]?.status, capped: reviews[0]?.capped, verdict: reviews[0]?.verdict});
  check("carry: second session received the carried report (SEEDED=yes)",
    second.includes("SEEDED=yes"), second);
  check("carry: second session was told the carried PowerShell runtime exists (PWSH_LINE=yes)",
    second.includes("PWSH_LINE=yes"), second);
  check("carry: second session's prompt carried the continuation context",
    second.includes("CONTINUATION=yes"), second);
  check("carry: the review PASSed and planning is ready",
    reviews[1]?.verdict?.decision === "PASS" && state.phase === "tasks_ready",
    {decision: reviews[1]?.verdict?.decision, phase: state.phase});
  check("carry: the carried scratch dir is deleted after the PASS",
    carriedExists === false, {carriedExists});
}

// ── (b): a review-complete note gets the verdict-only continuation ──
{
  const {run, reviews, state} = runScenario("verdict", "plan-reviewer-verdict");
  const second = notesOf(reviews[1]);
  check("verdict: mission completes planning (exit 0)",
    run.status === 0, {status: run.status, tail: `${run.stdout}\n${run.stderr}`.slice(-900)});
  check("verdict: exactly two reviewer sessions ran",
    reviews.length === 2, reviews.map((r) => ({status: r.status, capped: r.capped, decision: r.verdict?.decision})));
  check("verdict: first session ended capped without a decided verdict",
    reviews[0]?.status === "capped" && !["PASS", "FAIL"].includes(reviews[0]?.verdict?.decision),
    {status: reviews[0]?.status, capped: reviews[0]?.capped, verdict: reviews[0]?.verdict});
  check("verdict: second session's prompt was verdict-only (VERDICT_ONLY=yes)",
    second.includes("VERDICT_ONLY=yes"), second);
  check("verdict: second session still saw the carried report",
    second.includes("SEEDED=yes"), second);
  check("verdict: second session emitted the decided verdict",
    reviews[1]?.verdict?.decision === "PASS", reviews[1]?.verdict);
  check("verdict: orchestrator announced the verdict-only continuation",
    `${run.stdout}\n${run.stderr}`.includes("verdict-only session"),
    `${run.stdout}\n${run.stderr}`.slice(-900));
  check("verdict: planning is ready after the verdict-only PASS",
    state.phase === "tasks_ready", state.phase);
}

// ── (d): two capped no-verdict sessions stop the mission ──
{
  const {run, reviews, state} = runScenario("double", "plan-reviewer-double");
  const output = `${run.stdout}\n${run.stderr}`;
  check("double: mission exits non-zero",
    run.status !== 0, {status: run.status, tail: output.slice(-900)});
  check("double: exactly two reviewer sessions ran (never a third)",
    reviews.length === 2, reviews.map((r) => ({status: r.status, capped: r.capped, decision: r.verdict?.decision})));
  check("double: both sessions ended capped without a decided verdict",
    reviews.every((r) => r.status === "capped" && !["PASS", "FAIL"].includes(r.verdict?.decision)),
    reviews.map((r) => ({status: r.status, capped: r.capped, verdict: r.verdict})));
  check("double: escalation records PLAN_REVIEW_CAPPED_TWICE",
    state.phaseCheckpointError?.code === "PLAN_REVIEW_CAPPED_TWICE", state.phaseCheckpointError);
  check("double: escalation names the planning-not-converging step",
    state.step === "standalone_planning_not_converging", {phase: state.phase, step: state.step});
  check("double: operator is told to raise the plan_reviewer cap",
    output.includes("Raise caps.plan_reviewer.max_turns"),
    output.slice(-1200));
  check("double: operator is told to shrink the review stage",
    output.includes("shrink this review stage"), output.slice(-1200));
  check("double: no verdict-only continuation was armed for the second session",
    !notesOf(reviews[1]).includes("VERDICT_ONLY=yes"), notesOf(reviews[1]));
}

// ── (e): two capped sessions where the second added new findings/files -> third session starts ──
{
  const {run, reviews, state} = runScenario("progress", "plan-reviewer-progress");
  check("progress: mission completes planning (exit 0)",
    run.status === 0, {status: run.status, tail: `${run.stdout}\n${run.stderr}`.slice(-900)});
  check("progress: exactly three reviewer sessions ran",
    reviews.length === 3, reviews.map((r) => ({status: r.status, capped: r.capped, decision: r.verdict?.decision})));
  check("progress: first two sessions ended capped without a decided verdict",
    reviews[0]?.status === "capped" && reviews[1]?.status === "capped",
    reviews.map((r) => ({status: r.status, capped: r.capped})));
  check("progress: third session ran and produced PASS",
    reviews[2]?.verdict?.decision === "PASS" && state.phase === "tasks_ready",
    {verdict: reviews[2]?.verdict, phase: state.phase});
}

if (failures) {
  console.error(`${failures} plan-reviewer carry/verdict-only check(s) failed.`);
  process.exit(1);
}
console.log("plan-reviewer carry/verdict-only tests passed");
