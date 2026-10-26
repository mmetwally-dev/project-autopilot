#!/usr/bin/env node
// Mission 090 task 1.2: stage-ordering guard helper cases (pure, no fixtures).
// Covers: refuse+reason for review-before-implement, allow for valid resume
// positions, and one case per STAGE_CHECKPOINT_MAP entry.
// Backlog open #5: new-request / terminal-mission refusals, pure and a
// dispatch-level subprocess replay of mission 095.
// Run: node scripts/test-090-stage-guards.mjs
import path from "node:path";
import {guardStage, isPlanningComplete, isTerminalPhase, STAGE_ORDER, STAGE_CHECKPOINT_MAP} from "./stage-guards.mjs";

let failed = 0;
let ran = 0;
const check = (name, ok, detail = "") => {
  ran++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${detail}`}`);
  if (!ok) failed++;
};

const cp = (nextStage, runningStage = null) => ({nextStage, runningStage});
const FRESH_STATE = {phase: "idle", step: "idle"};
const PLANNING_STATE = {phase: "planning", step: "planning_new_request"};
const PLANNED_STATE = {phase: "tasks_ready", step: "tasks_ready"};

// ── Mapping table (one case per entry) ──────────────────────────
check("[map] STAGE_ORDER lists the four CLI stages",
  JSON.stringify(STAGE_ORDER) === JSON.stringify(["planning", "implement", "review", "verify"]),
  JSON.stringify(STAGE_ORDER));
check("[map] planning maps to no checkpoint stage",
  STAGE_CHECKPOINT_MAP.planning === null, JSON.stringify(STAGE_CHECKPOINT_MAP.planning));
check("[map] implement maps to implementer",
  STAGE_CHECKPOINT_MAP.implement === "implementer", JSON.stringify(STAGE_CHECKPOINT_MAP.implement));
check("[map] review maps to code_reviewer",
  STAGE_CHECKPOINT_MAP.review === "code_reviewer", JSON.stringify(STAGE_CHECKPOINT_MAP.review));
check("[map] verify maps to verifier+mark_tasks",
  Array.isArray(STAGE_CHECKPOINT_MAP.verify)
  && STAGE_CHECKPOINT_MAP.verify.length === 2
  && STAGE_CHECKPOINT_MAP.verify.includes("verifier")
  && STAGE_CHECKPOINT_MAP.verify.includes("mark_tasks"),
  JSON.stringify(STAGE_CHECKPOINT_MAP.verify));

// ── planning (no prerequisites) ─────────────────────────────────
{
  const got = guardStage("planning", {state: FRESH_STATE, checkpoint: null});
  check("[planning] fresh state allows planning",
    got.allowed === true && got.reason === null && got.checkpointStage === null, JSON.stringify(got));
}
{
  const got = guardStage("planning", {state: PLANNED_STATE, checkpoint: cp("verifier")});
  check("[planning] later position still allows planning",
    got.allowed === true && got.reason === null, JSON.stringify(got));
}

// ── implement (planning prerequisite) ───────────────────────────
{
  const got = guardStage("implement", {state: FRESH_STATE, checkpoint: null});
  check("[implement] fresh state refuses implement",
    got.allowed === false && typeof got.reason === "string" && got.reason.length > 0, JSON.stringify(got));
  check("[implement] refusal reason names the missing planning state",
    got.allowed === false && /planning/i.test(got.reason) && /state\.phase/i.test(got.reason), JSON.stringify(got));
}
{
  const got = guardStage("implement", {state: PLANNING_STATE, checkpoint: null});
  check("[implement] mid-planning state refuses implement",
    got.allowed === false && typeof got.reason === "string", JSON.stringify(got));
}
{
  const got = guardStage("implement", {state: PLANNED_STATE, checkpoint: null});
  check("[implement] planning-stop state (tasks_ready, no checkpoint) allows implement",
    got.allowed === true && got.reason === null && got.checkpointStage === "implementer", JSON.stringify(got));
}
{
  const got = guardStage("implement", {state: PLANNED_STATE, checkpoint: cp("implementer")});
  check("[implement] checkpoint at implementer allows implement",
    got.allowed === true && got.reason === null, JSON.stringify(got));
}
{
  // Mission 099 task 2.3: the plan is written and only awaiting approval, so
  // `--stage implement` is the approval itself (runImplementation consumes the
  // pause). Refusing here would make the pause unreachable except through
  // `--stage planning`, which must never approve.
  const got = guardStage("implement", {
    state: {phase: "plan_approval", step: "approve_plan"}, checkpoint: null,
  });
  check("[implement] plan_approval allows implement (the pause is the approval)",
    got.allowed === true && got.reason === null && got.checkpointStage === "implementer", JSON.stringify(got));
}

// ── review (implementer prerequisite) ───────────────────────────
{
  const got = guardStage("review", {state: PLANNED_STATE, checkpoint: null});
  check("[review] review-before-implement refuses",
    got.allowed === false && typeof got.reason === "string" && got.reason.length > 0, JSON.stringify(got));
  check("[review] refusal reason names the missing implemented state",
    got.allowed === false && /implement/i.test(got.reason), JSON.stringify(got));
}
{
  const got = guardStage("review", {state: PLANNED_STATE, checkpoint: cp("implementer")});
  check("[review] checkpoint still at implementer refuses review",
    got.allowed === false && typeof got.reason === "string", JSON.stringify(got));
}
{
  const got = guardStage("review", {state: PLANNED_STATE, checkpoint: cp("code_reviewer")});
  check("[review] checkpoint at code_reviewer allows review",
    got.allowed === true && got.reason === null && got.checkpointStage === "code_reviewer", JSON.stringify(got));
}
{
  const got = guardStage("review", {state: PLANNED_STATE, checkpoint: cp("verifier")});
  check("[review] later resume position (verifier) allows review",
    got.allowed === true && got.reason === null, JSON.stringify(got));
}
{
  const got = guardStage("review", {state: PLANNED_STATE, checkpoint: cp("code_reviewer", "code_reviewer")});
  check("[review] runningStage code_reviewer allows review",
    got.allowed === true && got.reason === null, JSON.stringify(got));
}

// ── verify (code_reviewer prerequisite) ─────────────────────────
{
  const got = guardStage("verify", {state: PLANNED_STATE, checkpoint: cp("code_reviewer")});
  check("[verify] checkpoint at code_reviewer refuses verify",
    got.allowed === false && typeof got.reason === "string" && got.reason.length > 0, JSON.stringify(got));
  check("[verify] refusal reason names the missing review state",
    got.allowed === false && /code_reviewer|review/i.test(got.reason), JSON.stringify(got));
}
{
  const got = guardStage("verify", {state: FRESH_STATE, checkpoint: null});
  check("[verify] fresh state refuses verify",
    got.allowed === false && typeof got.reason === "string", JSON.stringify(got));
}
{
  const got = guardStage("verify", {state: PLANNED_STATE, checkpoint: cp("verifier")});
  check("[verify] checkpoint at verifier allows verify",
    got.allowed === true && got.reason === null && got.checkpointStage.includes("verifier"), JSON.stringify(got));
}
{
  const got = guardStage("verify", {state: PLANNED_STATE, checkpoint: cp("mark_tasks")});
  check("[verify] checkpoint at mark_tasks allows verify",
    got.allowed === true && got.reason === null, JSON.stringify(got));
}

// ── unknown stage + planning-complete predicate ─────────────────
{
  const got = guardStage("bogus", {state: FRESH_STATE, checkpoint: null});
  check("[usage] unknown stage refuses with usage naming valid stages",
    got.allowed === false && STAGE_ORDER.every((s) => String(got.reason).includes(s)), JSON.stringify(got));
}
check("[predicate] isPlanningComplete false for idle/planning",
  isPlanningComplete(FRESH_STATE) === false && isPlanningComplete(PLANNING_STATE) === false, "");
check("[predicate] isPlanningComplete true past planning",
  isPlanningComplete(PLANNED_STATE) === true
  && isPlanningComplete({phase: "implementing"}) === true
  && isPlanningComplete({phase: "final_review"}) === true, "");

// ── Backlog open #5: new-request / terminal-mission refusals ─────
// The stage guard must evaluate the mission that will actually run: a
// supplied request that differs from the recorded planningRequest starts a
// NEW mission (same trim-compare as runImplementation), and a terminal
// mission (complete/cancelled only — escalated is paused/resumable, not
// finished) has no active work. Mission 095: `--stage implement
// <backlog-path>` against a COMPLETED mission ran the planner on the whole
// file before the fix.
const COMPLETED_STATE = {phase: "complete", step: "human_commit", planningRequest: "old request"};
const CANCELLED_STATE = {phase: "cancelled", step: "cancelled", planningRequest: "old request"};
const ESCALATED_STATE = {phase: "escalated", step: "budget_exhausted", planningRequest: "old request"};
// Terminal phases no longer count as "planning complete" for a stage run.
// Escalated is not terminal either (review fix 1) — it never counted before.
check("[predicate] isPlanningComplete false for terminal phases",
  isPlanningComplete(COMPLETED_STATE) === false
  && isPlanningComplete({phase: "cancelled"}) === false
  && isPlanningComplete({phase: "escalated"}) === false, "");
check("[predicate] isTerminalPhase flags terminal phases only",
  isTerminalPhase(COMPLETED_STATE) === true
  && isTerminalPhase(CANCELLED_STATE) === true
  && isTerminalPhase(ESCALATED_STATE) === false
  && isTerminalPhase(PLANNED_STATE) === false
  && isTerminalPhase(FRESH_STATE) === false, "");
for (const terminalState of [
  ["complete", COMPLETED_STATE],
  ["cancelled", CANCELLED_STATE],
]) {
  const [label, st] = terminalState;
  for (const stage of ["implement", "review", "verify"]) {
    const got = guardStage(stage, {state: st, checkpoint: stage === "implement" ? cp("implementer") : cp("verifier"), request: "fresh feature text"});
    check(`[${stage}] ${label} mission with a request refuses`,
      got.allowed === false && /NEW mission|new mission/.test(got.reason) && /planning/.test(got.reason),
      JSON.stringify(got));
    const bare = guardStage(stage, {state: st, checkpoint: stage === "implement" ? cp("implementer") : cp("verifier"), request: ""});
    check(`[${stage}] ${label} mission without a request refuses too`,
      bare.allowed === false && typeof bare.reason === "string", JSON.stringify(bare));
    // Review fix 2: the bare refusal must not say "with a request" nor end
    // in an empty "planning" suggestion.
    check(`[${stage}] ${label} bare refusal names the finished mission, not a request`,
      /the last mission is/.test(bare.reason) && !/with a request/.test(bare.reason)
      && /--stage planning <request>/.test(bare.reason) && !/planning ``/.test(bare.reason),
      JSON.stringify(bare.reason));
    const plan = guardStage("planning", {state: st, checkpoint: null, request: "fresh feature"});
    check(`[planning] ${label} mission with a request still allows planning`,
      plan.allowed === true && plan.reason === null, JSON.stringify(plan));
  }
}
{
  // Review fix 1: escalated is paused, not finished — `ap run` resumes it,
  // so a bare `--stage implement` with a valid checkpoint is allowed (same
  // as the tasks_ready resume shape), while a NEW request still refuses.
  const resumed = guardStage("implement", {state: ESCALATED_STATE, checkpoint: cp("implementer"), request: ""});
  check("[implement] escalated mission + checkpoint without a request is resumable",
    resumed.allowed === true && resumed.reason === null, JSON.stringify(resumed));
  const reviewResumed = guardStage("review", {state: ESCALATED_STATE, checkpoint: cp("code_reviewer"), request: ""});
  check("[review] escalated mission + checkpoint without a request is resumable",
    reviewResumed.allowed === true && reviewResumed.reason === null, JSON.stringify(reviewResumed));
  const fromRequest = guardStage("implement", {state: ESCALATED_STATE, checkpoint: cp("implementer"), request: "fresh feature text"});
  check("[implement] escalated mission with a NEW request refuses",
    fromRequest.allowed === false
    && /with a request/.test(fromRequest.reason) && /NEW mission/.test(fromRequest.reason),
    JSON.stringify(fromRequest));
  const escalatedBare = guardStage("implement", {state: ESCALATED_STATE, checkpoint: null, request: ""});
  check("[implement] escalated mission without checkpoint keeps the old planning refusal",
    escalatedBare.allowed === false && /planning has not completed/.test(escalatedBare.reason),
    JSON.stringify(escalatedBare));
}
{
  // Not every usable-looking request starts a new mission: the identical
  // request resumes the recorded one (and the placeholder is not a request).
  const sameState = {phase: "tasks_ready", step: "tasks_ready", planningRequest: "same feature"};
  const same = guardStage("implement", {state: sameState, checkpoint: null, request: "same feature"});
  check("[implement] identical request still resumes the recorded mission",
    same.allowed === true && same.reason === null, JSON.stringify(same));
  const placeholder = guardStage("implement", {
    state: {phase: "tasks_ready", step: "tasks_ready", planningRequest: ""},
    checkpoint: null, request: "Use the current project request/context.",
  });
  check("[implement] placeholder request is not a new mission",
    placeholder.allowed === true && placeholder.reason === null, JSON.stringify(placeholder));
  // A live (non-terminal) mission keeps its old allow/refuse behavior.
  const planned = guardStage("implement", {
    state: {phase: "tasks_ready", step: "tasks_ready", planningRequest: "old request"},
    checkpoint: null, request: "",
  });
  check("[implement] non-terminal mission without a request still allows",
    planned.allowed === true && planned.reason === null, JSON.stringify(planned));
}

// ── Backlog open #5: dispatch-level wiring (fixture subprocess) ──
// Completed mission + `--stage implement <request>` must exit 2 with no
// mission dir created and no relay launched (mission 095 replay).
{
  const { spawnSync } = await import("node:child_process");
  const { makeFixtureRepo, makeFixtureBin, writeConfig, withoutOuterGitGuard, cleanup, skillRoot } =
    await import("./test-fixtures/workflow-order-harness.mjs");
  const repo = makeFixtureRepo("090-stage-guard-terminal");
  const binDir = makeFixtureBin("090-stage-guard-terminal");
  try {
    writeConfig(repo, { planningFramework: "standalone" });
    const fs = await import("node:fs");
    const statePath = path.join(repo, ".autopilot", "state.json");
    fs.mkdirSync(path.dirname(statePath), {recursive: true});
    fs.writeFileSync(statePath, JSON.stringify({phase: "complete", step: "human_commit", planningRequest: "old request"}));
    const delimiter = process.platform === "win32" ? ";" : ":";
    const base = withoutOuterGitGuard(process.env);
    delete base.AUTOPILOT_SPEC;
    const result = spawnSync(process.execPath,
      [path.join(skillRoot, "scripts", "autopilot.mjs"), "run", "--stage", "implement", "new feature text", "--repo", repo],
      { cwd: repo, encoding: "utf8", env: {...base, PATH: `${binDir}${delimiter}${base.PATH || ""}`}, timeout: 120000, stdio: ["ignore", "pipe", "pipe"], shell: false });
    const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
    check("[dispatch] completed mission + --stage implement <request> exits 2",
      result.status === 2 && !Boolean(result.error && result.error.code === "ETIMEDOUT"),
      `status=${result.status} timedOut=${Boolean(result.error && result.error.code === "ETIMEDOUT")} out=${JSON.stringify(combined.slice(-400))}`);
    check("[dispatch] refusal names the new-mission reason",
      /NEW mission/.test(combined) && /planning/.test(combined), JSON.stringify(combined.slice(-400)));
    const missionsRoot = path.join(repo, ".autopilot", "missions");
    check("[dispatch] no mission dir was created",
      !fs.existsSync(missionsRoot) || fs.readdirSync(missionsRoot).length === 0,
      JSON.stringify(fs.existsSync(missionsRoot) ? fs.readdirSync(missionsRoot) : null));
    check("[dispatch] no relay/progress debris was created",
      !fs.existsSync(path.join(repo, ".autopilot", "runs")),
      "runs dir exists");
  } finally {
    cleanup(repo, binDir);
  }
}

console.log(failed ? `${failed} of ${ran} case(s) failed.` : `all ${ran} case(s) passed.`);
process.exit(failed ? 1 : 0);
