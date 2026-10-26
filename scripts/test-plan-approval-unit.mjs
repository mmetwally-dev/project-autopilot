#!/usr/bin/env node
// Unit test for the pure plan-approval state module.
import {
  PLAN_APPROVAL_PHASE,
  planApprovalRequired,
  beginPlanApprovalPause,
  resumePlanApproval,
  isPlanApprovalPaused,
  planApprovalPauseLines,
} from "./plan-approval.mjs";

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// planApprovalRequired: only an explicit true arms the pause.
assert(planApprovalRequired({ pauseForPlanApproval: true }) === true, "explicit true must require approval");
assert(planApprovalRequired({ pauseForPlanApproval: false }) === false, "false must auto-continue");
assert(planApprovalRequired({}) === false, "missing pauseForPlanApproval must auto-continue");
assert(planApprovalRequired({ pauseForPlanApproval: undefined }) === false, "undefined must auto-continue");
assert(planApprovalRequired({ autoApprovePlan: false }) === false, "the legacy autoApprovePlan switch must be ignored");
assert(planApprovalRequired(undefined) === false, "undefined workflow must auto-continue");
assert(planApprovalRequired(null) === false, "null workflow must auto-continue");

// Pause state fields + returned operator message.
const state = { phase: "planning", step: "standalone-plan", keep: "untouched" };
const at = "2026-01-02T03:04:05.000Z";
const lines = beginPlanApprovalPause(state, {
  framework: "standalone",
  artifacts: ["PLAN.md", "TASKS.md"],
  at,
});
assert(state.phase === PLAN_APPROVAL_PHASE && state.phase === "plan_approval", `phase must be plan_approval, got ${state.phase}`);
assert(state.step === "approve_plan", `step must be approve_plan, got ${state.step}`);
assert(state.keep === "untouched", "unrelated state fields must be preserved");
assert(state.planApproval && typeof state.planApproval === "object", "planApproval must be recorded");
assert(state.planApproval.status === "awaiting", `status must be awaiting, got ${state.planApproval.status}`);
assert(state.planApproval.framework === "standalone", `framework must be recorded, got ${state.planApproval.framework}`);
assert(state.planApproval.at === at, `at must be recorded, got ${state.planApproval.at}`);
assert(Array.isArray(state.planApproval.artifacts), "artifacts must be an array");
assert(state.planApproval.artifacts.join(",") === "PLAN.md,TASKS.md", `artifacts must be recorded, got ${state.planApproval.artifacts}`);
assert(isPlanApprovalPaused(state) === true, "a paused state must report paused");
assert(isPlanApprovalPaused({ phase: "tasks_ready" }) === false, "tasks_ready is not paused");
assert(isPlanApprovalPaused(undefined) === false, "undefined state is not paused");

const message = lines.join("\n");
assert(/PLAN APPROVAL REQUIRED/.test(message), `message must say PLAN APPROVAL REQUIRED:\n${message}`);
assert(message.includes("PLAN.md"), `message must name PLAN.md:\n${message}`);
assert(message.includes("TASKS.md"), `message must name TASKS.md:\n${message}`);
assert(message.includes("`ap run`"), `message must say ap run:\n${message}`);
assert(/continuing counts as approval/i.test(message), `message must say continuing counts as approval:\n${message}`);
assert(
  lines.join("\n") === planApprovalPauseLines({ framework: "standalone", artifacts: ["PLAN.md", "TASKS.md"] }).join("\n"),
  "beginPlanApprovalPause must return planApprovalPauseLines output",
);

// SpecKit paths and a default `at` are named too.
const speckitState = {};
const speckitLines = beginPlanApprovalPause(speckitState, {
  framework: "speckit",
  artifacts: { plan: "specs/001-feature/plan.md", tasks: "specs/001-feature/tasks.md" },
});
const speckitMessage = speckitLines.join("\n");
assert(speckitMessage.includes("specs/001-feature/plan.md"), `message must name the Speckit plan:\n${speckitMessage}`);
assert(speckitMessage.includes("specs/001-feature/tasks.md"), `message must name the Speckit tasks:\n${speckitMessage}`);
assert(typeof speckitState.planApproval.at === "string" && speckitState.planApproval.at.length > 0, "at must default to a timestamp");

// Resume only from plan_approval.
const resumed = { phase: "plan_approval", step: "approve_plan", planApproval: { status: "awaiting" }, currentTask: 3 };
assert(resumePlanApproval(resumed) === true, "resume from plan_approval must return true");
assert(resumed.phase === "tasks_ready", `resume must set phase tasks_ready, got ${resumed.phase}`);
assert(resumed.step === "tasks_ready", `resume must set step tasks_ready, got ${resumed.step}`);
assert(!("planApproval" in resumed), "resume must delete planApproval");
assert(resumed.currentTask === 3, "resume must preserve unrelated state");
assert(isPlanApprovalPaused(resumed) === false, "resumed state is no longer paused");

const notPaused = { phase: "tasks_ready", step: "tasks_ready", planApproval: { status: "awaiting" } };
assert(resumePlanApproval(notPaused) === false, "resume from tasks_ready must return false");
assert(notPaused.phase === "tasks_ready" && notPaused.planApproval, "resume must not touch a non-paused state");

const planning = { phase: "planning", step: "standalone-plan" };
assert(resumePlanApproval(planning) === false, "resume from planning must return false");
assert(planning.phase === "planning" && planning.step === "standalone-plan", "resume must not touch planning state");
assert(resumePlanApproval(undefined) === false, "resume with no state must return false");

console.log("test-plan-approval-unit: ok");
