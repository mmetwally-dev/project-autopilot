#!/usr/bin/env node
// Plans continue straight to implementation by default; only an explicit
// `pause_for_plan_approval:true` arms the pause. Guards the defaults and the
// old `approve_plan_myself` drop, whose value is ignored.
import {DEFAULTS, CONFIG_SCHEMA_VERSION, toRuntimeConfig} from "./config-layout.mjs";
import {migrateConfig} from "./config-migration.mjs";
import {planApprovalRequired} from "./plan-approval.mjs";

function fail(message) { throw new Error(message); }
function eq(actual, expected, label) {
  if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function deep(actual, expected, label) {
  if (stable(actual) !== stable(expected)) fail(`${label}:\n  expected ${stable(expected)}\n  got      ${stable(actual)}`);
}

eq(DEFAULTS.workflow.pause_for_plan_approval, false, "DEFAULTS.workflow.pause_for_plan_approval");
eq("approve_plan_myself" in DEFAULTS.workflow, false, "DEFAULTS.workflow must not contain approve_plan_myself");
eq(DEFAULTS.workflow.plan_review, true, "DEFAULTS.workflow.plan_review");
eq(DEFAULTS.workflow.plan_review_rounds_converge, true, "DEFAULTS.workflow.plan_review_rounds_converge");
eq(DEFAULTS.workflow.gsd_planning_review, false, "DEFAULTS.workflow.gsd_planning_review");
eq(DEFAULTS.workflow.spec_review, true, "DEFAULTS.workflow.spec_review");
eq(DEFAULTS.workflow.code_review_per_phase, true, "DEFAULTS.workflow.code_review_per_phase");
eq(DEFAULTS.workflow.final_review, true, "DEFAULTS.workflow.final_review");
eq(DEFAULTS.workflow.analysis_after_tasks, true, "DEFAULTS.workflow.analysis_after_tasks");
eq(DEFAULTS.workflow.approve_spec_myself, false, "DEFAULTS.workflow.approve_spec_myself");
eq(DEFAULTS.workflow.parallel_independent_tasks, false, "DEFAULTS.workflow.parallel_independent_tasks");
eq(DEFAULTS.workflow.use_worktrees, true, "DEFAULTS.workflow.use_worktrees");
eq(DEFAULTS.workflow.commit_by_human, true, "DEFAULTS.workflow.commit_by_human");

deep(DEFAULTS.workflow, {
  plan_review: true,
  plan_review_rounds_converge: true,
  gsd_planning_review: false,
  spec_review: true,
  code_review_per_phase: true,
  final_review: true,
  analysis_after_tasks: true,
  approve_spec_myself: false,
  pause_for_plan_approval: false,
  parallel_independent_tasks: false,
  use_worktrees: true,
  commit_by_human: true,
}, "DEFAULTS.workflow");

// The legacy pre-v4 pause switch is ignored entirely: a pre-v4
// `autoApprovePlan:false` upgrades to no pause.
const legacyMigrated = migrateConfig({
  schema_version: "3.0",
  workflow: {autoApprovePlan: false},
}, {});
const legacyWorkflow = toRuntimeConfig(legacyMigrated.config).workflow;
eq(legacyWorkflow.autoApprovePlan, undefined, "legacy autoApprovePlan must not reach the runtime");
eq(planApprovalRequired(legacyWorkflow), false, "legacy autoApprovePlan:false must not arm the pause");

// A v4 file with the old `approve_plan_myself` keeps loading: the key is
// dropped (value ignored) and the new key is false by default, so no pause.
for (const oldValue of [false, true]) {
  const v4 = migrateConfig({
    schema_version: CONFIG_SCHEMA_VERSION,
    workflow: {approve_plan_myself: oldValue},
  }, {});
  eq("approve_plan_myself" in v4.config.workflow, false, `v4 approve_plan_myself:${oldValue} must be dropped`);
  eq(v4.config.workflow.pause_for_plan_approval, false, `v4 approve_plan_myself:${oldValue} must leave the pause false`);
  const runtimeWorkflow = toRuntimeConfig(v4.config).workflow;
  eq(runtimeWorkflow.pauseForPlanApproval, false, `v4 approve_plan_myself:${oldValue} runtime pauseForPlanApproval`);
  eq(planApprovalRequired(runtimeWorkflow), false, `v4 approve_plan_myself:${oldValue} must not arm the pause`);
}

// Only the new v4 key controls the pause.
const paused = migrateConfig({
  schema_version: CONFIG_SCHEMA_VERSION,
  workflow: {pause_for_plan_approval: true},
}, {});
eq(toRuntimeConfig(paused.config).workflow.pauseForPlanApproval, true, "v4 pause_for_plan_approval:true stays true");
eq(planApprovalRequired(toRuntimeConfig(paused.config).workflow), true, "v4 pause_for_plan_approval:true arms the pause");

const auto = migrateConfig({
  schema_version: CONFIG_SCHEMA_VERSION,
  workflow: {pause_for_plan_approval: false},
}, {});
eq(toRuntimeConfig(auto.config).workflow.pauseForPlanApproval, false, "v4 pause_for_plan_approval:false stays false");
eq(planApprovalRequired(toRuntimeConfig(auto.config).workflow), false, "v4 pause_for_plan_approval:false does not pause");

console.log("test-plan-approval-config: ok");
