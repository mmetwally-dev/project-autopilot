#!/usr/bin/env node
// Backlog #1 (mission 096 Phase 1 task 1.1): config-layout.mjs maps the v4
// on-disk layout to the legacy in-memory runtime shape and back. This asserts
// both directions round-trip and that DEFAULTS carries the real code defaults
// from per-task-budget.mjs (the single source — never a copied number).
import {
  DEFAULTS,
  CONFIG_SCHEMA_VERSION,
  ROLE_NAMES,
  REVIEW_ROLES,
  toRuntimeConfig,
  toNewLayoutConfig,
} from "./config-layout.mjs";
import {
  PER_TASK_MAX_TURNS_DEFAULT,
  PER_TASK_MAX_TOKENS_DEFAULT,
  CONTINUATION_ALLOWANCE_DEFAULT,
  TASK_SIZE_TARGET_TURNS_DEFAULT,
  HANDOFF_MAX_CHARS_DEFAULT,
  HANDOFF_NOTE_MAX_CHARS_DEFAULT,
  HANDOFF_WRAPUP_TOKENS_DEFAULT,
  NO_PROGRESS_GENERATIONS_DEFAULT,
  FINAL_REVIEW_FIX_ROUNDS_DEFAULT,
  RELAY_TIMEOUT_DEFAULT_MS,
  PER_TASK_TIMEOUT_DEFAULT_MS,
  IDLE_HANG_MS_DEFAULT,
  FIRST_OUTPUT_MS_DEFAULT,
  MAX_SILENCE_MS_DEFAULT,
  BACKSTOP_RAW_TOKENS_DEFAULT,
  PER_ROLE_CAPS_DEFAULT,
  PER_ROLE_WRAPUP_TOKENS_DEFAULT,
  FREE_MODEL_TURNS_CAP_DEFAULT,
} from "./per-task-budget.mjs";
import {FALLBACK_RETRY_PRIMARY_MINUTES} from "./role-fallback.mjs";

function fail(message) { throw new Error(message); }
function eq(actual, expected, label) {
  if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function deep(actual, expected, label) {
  if (stable(actual) !== stable(expected)) fail(`${label}:\n  expected ${stable(expected)}\n  got      ${stable(actual)}`);
}
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }

// ---------------------------------------------------------------------------
// DEFAULTS mirrors the real code defaults from per-task-budget.mjs.
// ---------------------------------------------------------------------------
eq(CONFIG_SCHEMA_VERSION, "4.0", "CONFIG_SCHEMA_VERSION");
deep(ROLE_NAMES, ["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"], "ROLE_NAMES");
deep(REVIEW_ROLES, ["planner", "plan_reviewer", "code_reviewer", "verifier"], "REVIEW_ROLES");

for (const role of REVIEW_ROLES) {
  const d = DEFAULTS.caps[role];
  const caps = PER_ROLE_CAPS_DEFAULT[role];
  eq(d.max_turns, caps.maxTurns, `DEFAULTS.caps.${role}.max_turns`);
  eq(d.max_tokens, caps.maxTokens, `DEFAULTS.caps.${role}.max_tokens`);
  eq(d.extra_sessions, caps.extraSessions, `DEFAULTS.caps.${role}.extra_sessions`);
  eq(d.wrap_up_at_tokens, PER_ROLE_WRAPUP_TOKENS_DEFAULT[role], `DEFAULTS.caps.${role}.wrap_up_at_tokens`);
}
eq(DEFAULTS.caps.implementer.max_turns, PER_TASK_MAX_TURNS_DEFAULT, "DEFAULTS.caps.implementer.max_turns");
eq(DEFAULTS.caps.implementer.max_tokens, PER_TASK_MAX_TOKENS_DEFAULT, "DEFAULTS.caps.implementer.max_tokens");
eq(DEFAULTS.caps.implementer.extra_sessions, CONTINUATION_ALLOWANCE_DEFAULT, "DEFAULTS.caps.implementer.extra_sessions");
eq(DEFAULTS.caps.implementer.wrap_up_at_tokens, HANDOFF_WRAPUP_TOKENS_DEFAULT, "DEFAULTS.caps.implementer.wrap_up_at_tokens");
eq(DEFAULTS.caps.task_size_target_turns, TASK_SIZE_TARGET_TURNS_DEFAULT, "DEFAULTS.caps.task_size_target_turns");
eq(DEFAULTS.caps.mission_token_backstop, BACKSTOP_RAW_TOKENS_DEFAULT, "DEFAULTS.caps.mission_token_backstop");
eq(DEFAULTS.retries.final_review_fix_rounds, FINAL_REVIEW_FIX_ROUNDS_DEFAULT, "DEFAULTS.retries.final_review_fix_rounds");
eq(DEFAULTS.retries.no_progress_sessions, NO_PROGRESS_GENERATIONS_DEFAULT, "DEFAULTS.retries.no_progress_sessions");
eq(DEFAULTS.retries.extra_sessions_per_task, CONTINUATION_ALLOWANCE_DEFAULT, "DEFAULTS.retries.extra_sessions_per_task");
eq(DEFAULTS.time_limits.call_backstop_minutes, RELAY_TIMEOUT_DEFAULT_MS / 60000, "DEFAULTS.time_limits.call_backstop_minutes");
eq(DEFAULTS.time_limits.role_timeout_minutes.default, PER_TASK_TIMEOUT_DEFAULT_MS / 60000, "DEFAULTS.time_limits.role_timeout_minutes.default");
eq(DEFAULTS.time_limits.role_timeout_minutes.verifier, 180, "DEFAULTS.time_limits.role_timeout_minutes.verifier");
eq(DEFAULTS.roles.implementer.resume_session, false, "DEFAULTS.roles.implementer.resume_session");
eq(DEFAULTS.roles.planner.resume_session, true, "DEFAULTS.roles.planner.resume_session");
eq(DEFAULTS.time_limits.silent_run_minutes, IDLE_HANG_MS_DEFAULT / 60000, "DEFAULTS.time_limits.silent_run_minutes");
eq(DEFAULTS.time_limits.no_first_output_minutes, FIRST_OUTPUT_MS_DEFAULT / 60000, "DEFAULTS.time_limits.no_first_output_minutes");
eq(DEFAULTS.time_limits.read_only_max_silence_minutes, MAX_SILENCE_MS_DEFAULT / 60000, "DEFAULTS.time_limits.read_only_max_silence_minutes");
eq(DEFAULTS.roles.free_models.max_turns, FREE_MODEL_TURNS_CAP_DEFAULT, "DEFAULTS.roles.free_models.max_turns");
eq(DEFAULTS.advanced.handoff_max_chars, HANDOFF_MAX_CHARS_DEFAULT, "DEFAULTS.advanced.handoff_max_chars");
eq(DEFAULTS.advanced.handoff_note_max_chars, HANDOFF_NOTE_MAX_CHARS_DEFAULT, "DEFAULTS.advanced.handoff_note_max_chars");
eq(DEFAULTS.advanced.handoff_wrapup_tokens, HANDOFF_WRAPUP_TOKENS_DEFAULT, "DEFAULTS.advanced.handoff_wrapup_tokens");
eq(DEFAULTS.advanced.fallback_retry_primary_minutes, FALLBACK_RETRY_PRIMARY_MINUTES, "DEFAULTS.advanced.fallback_retry_primary_minutes");

// ---------------------------------------------------------------------------
// layout -> runtime: every mapping note in PLAN.md.
// ---------------------------------------------------------------------------
const layout = clone(DEFAULTS);
layout.$schema = "./config.schema.json";
layout.schema_version = CONFIG_SCHEMA_VERSION;
// Distinct operator values so a mapping bug cannot hide behind a default.
layout.project.planning_framework = "gsd";
layout.roles.planner.cli = "claude";
layout.roles.planner.model = "opus";
layout.roles.planner.reasoning = "high";
layout.roles.planner.fallbacks = [
  {cli: "opencode", model: "opencode/mimo-v2.6-flash-free", reasoning: "high"},
];
layout.roles.implementer.cli = "opencode";
layout.roles.implementer.escalation_model = {cli: "claude", model: "sonnet[1m]", reasoning: "high"};
layout.roles.free_models = {auto_fallback: false, max_turns: 45};
layout.caps.planner = {max_turns: 31, max_tokens: 210000, extra_sessions: 3, wrap_up_at_tokens: 190000};
layout.caps.implementer = {max_turns: 41, max_tokens: 190000, extra_sessions: 6, wrap_up_at_tokens: 170000};
layout.caps.task_size_target_turns = 33;
layout.caps.mission_token_backstop = 7000000;
layout.retries = {
  plan_revisions: 9,
  implementation: 3,
  verification: 5,
  final_review_fix_rounds: 4,
  cli_errors: 2,
  infrastructure: 6,
  no_progress_sessions: 3,
  extra_sessions_per_task: 6,
  escalate_after_not_fixed: 2,
};
layout.time_limits = {
  role_timeout_minutes: {default: 70, verifier: 185},
  call_backstop_minutes: 200,
  role_timeout_floor_minutes: 25,
  silent_run_minutes: 11,
  no_first_output_minutes: 4,
  read_only_max_silence_minutes: 16,
  retry_wait_seconds: 75,
};
layout.workflow.approve_plan_myself = true;
layout.workflow.plan_review_rounds_converge = false;
layout.tests.gate_commands = ["node scripts/test-all.mjs"];
layout.tests.gate_network = true;
layout.tests.gate_env_allowlist = ["PATH"];
layout.tests.verify_denylist = ["scripts/test-slow.mjs"];
layout.safety.stop_on_sandbox_violation = false;
layout.safety.block_git_in_roles = false;
layout.runtime.mode = "wsl2-strong";
layout.runtime.wsl_distro = "Ubuntu";
layout.frameworks.speckit.task_files = ["custom/tasks.md"];
layout.frameworks.gsd.parallel = {enabled: true, plan_level: true, task_level: false, max_concurrent_agents: 3, min_plans_for_parallel: 2};
layout.advanced.state_file = ".autopilot/custom-state.json";
layout.advanced.fallback_retry_primary_minutes = 320;
// The duplicated implementer caps agree with their retries/advanced twins, so
// the shared runtime key round-trips unambiguously.
layout.advanced.handoff_wrapup_tokens = 170000;

const rt = toRuntimeConfig(layout);
// roles
eq(rt.roles.planner.adapter, "claude", "roles.planner.adapter");
eq(rt.roles.planner.resume, true, "roles.planner.resume");
deep(rt.roles.planner.fallbacks, [{adapter: "opencode", model: "opencode/mimo-v2.6-flash-free", reasoning: "high", variant: ""}], "roles.planner.fallbacks");
eq(rt.roles.implementer.adapter, "opencode", "roles.implementer.adapter");
deep(rt.roles.implementer.escalation_model, {adapter: "claude", model: "sonnet[1m]", reasoning: "high"}, "roles.implementer.escalation_model");
// caps -> policy.caps (review roles) and policy.per_task_* (implementer)
eq(rt.policy.caps.planner.max_turns, 31, "policy.caps.planner.max_turns");
eq(rt.policy.caps.planner.max_tokens, 210000, "policy.caps.planner.max_tokens");
eq(rt.policy.caps.planner.extra_sessions, 3, "policy.caps.planner.extra_sessions");
eq(rt.policy.caps.planner.wrap_up_tokens_threshold, 190000, "policy.caps.planner.wrap_up_tokens_threshold");
eq("implementer" in rt.policy.caps, false, "policy.caps.implementer must be absent");
eq(rt.policy.per_task_max_turns, 41, "policy.per_task_max_turns");
eq(rt.policy.per_task_max_tokens, 190000, "policy.per_task_max_tokens");
eq(rt.policy.continuation_allowance, 6, "policy.continuation_allowance (implementer)");
eq(rt.policy.handoff_wrapup_tokens, 170000, "policy.handoff_wrapup_tokens");
eq(rt.policy.task_size_target_turns, 33, "policy.task_size_target_turns");
eq(rt.policy.backstop_raw_tokens, 7000000, "policy.backstop_raw_tokens");
// retries
eq(rt.policy.max_plan_revisions, 9, "policy.max_plan_revisions");
eq(rt.policy.failure_budgets.implementationFailureBudget, 3, "failure_budgets.implementationFailureBudget");
eq(rt.policy.failure_budgets.verificationFailureBudget, 5, "failure_budgets.verificationFailureBudget");
eq(rt.policy.failure_budgets.adapterRetryBudget, 2, "failure_budgets.adapterRetryBudget");
eq(rt.policy.failure_budgets.infrastructureRetryBudget, 6, "failure_budgets.infrastructureRetryBudget");
eq(rt.policy.no_progress_generations, 3, "policy.no_progress_generations");
eq(rt.policy.final_review_fix_rounds, 4, "policy.final_review_fix_rounds");
// time_limits (units *1000 / *60000)
eq(rt.policy.relay_timeout_ms, 200 * 60000, "policy.relay_timeout_ms");
deep(rt.policy.role_timeout_ms, {default: 70 * 60000, verifier: 185 * 60000}, "policy.role_timeout_ms");
eq(rt.policy.per_task_timeout_ms, 70 * 60000, "policy.per_task_timeout_ms (from role_timeout_minutes.default)");
eq(rt.policy.role_deadline_floor_ms, 25 * 60000, "policy.role_deadline_floor_ms");
eq(rt.policy.idle_hang_ms, 11 * 60000, "policy.idle_hang_ms");
eq(rt.policy.first_output_ms, 4 * 60000, "policy.first_output_ms");
eq(rt.policy.max_silence_ms, 16 * 60000, "policy.max_silence_ms");
eq(rt.policy.retry_delay_ms, 75 * 1000, "policy.retry_delay_ms");
eq(rt.policy.fallback_retry_primary_minutes, 320, "policy.fallback_retry_primary_minutes");
// workflow / safety / runtime / tests / planning / capabilities / project
eq(rt.workflow.planReview, true, "workflow.planReview");
eq(rt.workflow.plan_review_convergence, false, "workflow.plan_review_convergence");
eq(rt.workflow.autoApprovePlan, true, "workflow.autoApprovePlan");
eq(rt.workflow.relaySafety.block_git_commit_push, false, "workflow.relaySafety.block_git_commit_push");
eq(rt.policy.fail_closed_on_relay_violation, false, "policy.fail_closed_on_relay_violation");
eq(rt.policy.require_human_commit, true, "policy.require_human_commit");
eq(rt.execution.runtime_mode, "wsl2-strong", "execution.runtime_mode");
eq(rt.execution.wsl_distro, "Ubuntu", "execution.wsl_distro");
deep(rt.gates.commands, ["node scripts/test-all.mjs"], "gates.commands");
eq(rt.gates.network_isolation, false, "gates.network_isolation (inverted)");
deep(rt.gates.env_allowlist, ["PATH"], "gates.env_allowlist");
deep(rt.planning.speckit.task_candidates, ["custom/tasks.md"], "planning.speckit.task_candidates");
eq(rt.planning.gsd.parallelization.enabled, true, "planning.gsd.parallelization.enabled");
deep(rt.planning.verify_denylist, ["scripts/test-slow.mjs"], "planning.verify_denylist");
eq(rt.capabilities.verification.browser, "native", "capabilities.verification.browser");
eq(rt.project.state_file, ".autopilot/custom-state.json", "project.state_file");
eq(rt.policy.free_model_turns_cap, 45, "policy.free_model_turns_cap");
eq(rt.freeModelAutoFallback, false, "freeModelAutoFallback");

// ---------------------------------------------------------------------------
// runtime -> layout: the inverse names.
// ---------------------------------------------------------------------------
const layout2 = toNewLayoutConfig(rt);
eq(layout2.schema_version, "4.0", "layout2.schema_version");
eq(layout2.$schema, "./config.schema.json", "layout2.$schema");
eq(layout2.roles.planner.cli, "claude", "layout2.roles.planner.cli");
eq(layout2.roles.implementer.escalation_model.cli, "claude", "layout2.roles.implementer.escalation_model.cli");
eq(layout2.roles.free_models.max_turns, 45, "layout2.roles.free_models.max_turns");
eq(layout2.roles.free_models.auto_fallback, false, "layout2.roles.free_models.auto_fallback");
eq(layout2.caps.planner.wrap_up_at_tokens, 190000, "layout2.caps.planner.wrap_up_at_tokens");
eq(layout2.caps.implementer.max_turns, 41, "layout2.caps.implementer.max_turns");
eq(layout2.caps.task_size_target_turns, 33, "layout2.caps.task_size_target_turns");
eq(layout2.caps.mission_token_backstop, 7000000, "layout2.caps.mission_token_backstop");
eq(layout2.retries.implementation, 3, "layout2.retries.implementation");
eq(layout2.retries.cli_errors, 2, "layout2.retries.cli_errors");
eq(layout2.retries.extra_sessions_per_task, 6, "layout2.retries.extra_sessions_per_task");
eq(layout2.retries.escalate_after_not_fixed, 2, "layout2.retries.escalate_after_not_fixed");
eq(layout2.time_limits.call_backstop_minutes, 200, "layout2.time_limits.call_backstop_minutes");
deep(layout2.time_limits.role_timeout_minutes, {default: 70, verifier: 185}, "layout2.time_limits.role_timeout_minutes");
eq(layout2.time_limits.retry_wait_seconds, 75, "layout2.time_limits.retry_wait_seconds");
eq(layout2.advanced.fallback_retry_primary_minutes, 320, "layout2.advanced.fallback_retry_primary_minutes");
eq(layout2.workflow.approve_plan_myself, true, "layout2.workflow.approve_plan_myself");
eq(layout2.workflow.commit_by_human, true, "layout2.workflow.commit_by_human");
eq(layout2.tests.gate_network, true, "layout2.tests.gate_network (inverted)");
eq(layout2.tests.browser, "native", "layout2.tests.browser");
deep(layout2.tests.verify_denylist, ["scripts/test-slow.mjs"], "layout2.tests.verify_denylist");
eq(layout2.safety.stop_on_sandbox_violation, false, "layout2.safety.stop_on_sandbox_violation");
eq(layout2.safety.block_git_in_roles, false, "layout2.safety.block_git_in_roles");
eq(layout2.runtime.mode, "wsl2-strong", "layout2.runtime.mode");
deep(layout2.frameworks.speckit.task_files, ["custom/tasks.md"], "layout2.frameworks.speckit.task_files");
eq(layout2.frameworks.gsd.parallel.enabled, true, "layout2.frameworks.gsd.parallel.enabled");
eq("parallelization" in layout2.frameworks.gsd, false, "layout2.frameworks.gsd.parallelization must be renamed");
eq(layout2.advanced.state_file, ".autopilot/custom-state.json", "layout2.advanced.state_file");
eq(layout2.advanced.handoff_wrapup_tokens, 170000, "layout2.advanced.handoff_wrapup_tokens");

// ---------------------------------------------------------------------------
// Round trips both ways for every mapped key.
// ---------------------------------------------------------------------------
deep(toNewLayoutConfig(toRuntimeConfig(layout)), layout, "layout -> runtime -> layout");
deep(toRuntimeConfig(toNewLayoutConfig(rt)), rt, "runtime -> layout -> runtime");

// ---------------------------------------------------------------------------
// A defaults-only layout maps to a defaults-only runtime (missing keys are
// never fabricated; present defaults are carried through).
// ---------------------------------------------------------------------------
const defaultsRuntime = toRuntimeConfig(clone(DEFAULTS));
eq(defaultsRuntime.policy.per_task_max_turns, PER_TASK_MAX_TURNS_DEFAULT, "defaults runtime per_task_max_turns");
eq(defaultsRuntime.policy.caps.code_reviewer.max_turns, PER_ROLE_CAPS_DEFAULT.code_reviewer.maxTurns, "defaults runtime code_reviewer cap");
eq(defaultsRuntime.roles.free_models, undefined, "roles.free_models is not a runtime key");
eq(defaultsRuntime.freeModelAutoFallback, true, "defaults freeModelAutoFallback");

// A partial layout only emits the keys it holds (never a fabricated value).
const partialRt = toRuntimeConfig({caps: {verifier: {max_tokens: 150000}}});
eq(partialRt.policy.caps.verifier.max_tokens, 150000, "partial verifier cap");
eq("per_task_max_turns" in partialRt.policy, false, "partial must not fabricate per_task_max_turns");
eq(partialRt.roles, undefined, "partial must not fabricate roles");

// ---------------------------------------------------------------------------
// Integer ms round-trips for relay/role/idle timeouts (no floating drift).
// ---------------------------------------------------------------------------
const msRt = {
  policy: {
    role_timeout_ms: {default: 2000000, verifier: 10800000},
    relay_timeout_ms: 2700000,
    idle_hang_ms: 600000,
    first_output_ms: 180000,
    max_silence_ms: 900000,
  }
};
const msLayout = toNewLayoutConfig(msRt);
const msRt2 = toRuntimeConfig(msLayout);
eq(msRt2.policy.role_timeout_ms.default, 2000000, "role_timeout_ms.default integer round-trip");
eq(msRt2.policy.role_timeout_ms.verifier, 10800000, "role_timeout_ms.verifier integer round-trip");
eq(msRt2.policy.relay_timeout_ms, 2700000, "relay_timeout_ms integer round-trip");
eq(msRt2.policy.idle_hang_ms, 600000, "idle_hang_ms integer round-trip");
eq(msRt2.policy.first_output_ms, 180000, "first_output_ms integer round-trip");
eq(msRt2.policy.max_silence_ms, 900000, "max_silence_ms integer round-trip");
// Ensure all are integers (no floating point drift).
for (const [k, v] of Object.entries(msRt2.policy)) {
  if (typeof v === "number") eq(Number.isInteger(v), true, `policy.${k} is integer`);
}
if (msRt2.policy.role_timeout_ms && typeof msRt2.policy.role_timeout_ms === "object") {
  for (const [k, v] of Object.entries(msRt2.policy.role_timeout_ms)) {
    eq(Number.isInteger(v), true, `policy.role_timeout_ms.${k} is integer`);
  }
}

// Resume defaults are role-aware: only the implementer starts fresh by default
// (a capped session continues via the hand-off note); others resume.
const resumeDefaults = toRuntimeConfig({roles: {planner: {}, implementer: {}, verifier: {}}});
eq(resumeDefaults.roles.implementer.resume, false, "implementer default resume false");
eq(resumeDefaults.roles.planner.resume, true, "planner default resume true");
eq(resumeDefaults.roles.verifier.resume, true, "verifier default resume true");
const resumeLayout = toNewLayoutConfig(resumeDefaults);
eq(resumeLayout.roles.implementer.resume_session, false, "implementer resume_session round-trips false");
eq(resumeLayout.roles.planner.resume_session, true, "planner resume_session round-trips true");

console.log("config layout tests passed (v4 <-> runtime mappings both ways; DEFAULTS match per-task-budget constants)");
