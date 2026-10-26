// Backlog #1 "readable config" (mission 096 Phase 1 task 1.1): the single
// owner of the mapping between the new on-disk v4 layout and the legacy
// in-memory runtime shape.
//
// Two representations, one seam:
//   - On disk (v4) = grouped sections with plain names and units in the name
//     (`caps.<role>.wrap_up_at_tokens`, `time_limits.call_backstop_minutes`),
//     `$schema` first.
//   - In memory (runtime) = the existing shape the ~30 `c.policy.*` read
//     sites in autopilot.mjs and the resolvers in per-task-budget.mjs already
//     consume (`policy.*`, `roles.<r>.adapter/resume`, `gates.*`,
//     `planning.*`, `capabilities.*`, `execution.*`, workflow camelCase).
//
// This module is pure: no filesystem, process, network, or clock reads.
// `DEFAULTS` is the real default table; every number that also exists as a
// code constant is imported from per-task-budget.mjs (the single source), so
// the schema generator (task 1.2) and the loader (1.4) cannot drift.
//
// Mapping notes live in .autopilot/missions/096-implement-backlog-item/PLAN.md
// ("Mapping notes") and .autopilot/tasks/config.md ("Old -> new names").

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

export const CONFIG_SCHEMA_VERSION = "4.0";

// Same order as config-validation.mjs ROLE_NAMES: every role lists the same
// keys in the same order.
export const ROLE_NAMES = ["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"];
// The implementer's caps live on policy.per_task_max_* (legacy shape);
// the four review roles use policy.caps.<role>.
export const REVIEW_ROLES = ["planner", "plan_reviewer", "code_reviewer", "verifier"];

const MINUTE_MS = 60_000;
const SECOND_MS = 1_000;

// ---------------------------------------------------------------------------
// DEFAULTS — the v4 layout populated with the real code defaults.
// ---------------------------------------------------------------------------

function defaultRole(resumeSession = true) {
  return {
    cli: "",
    model: "",
    reasoning: "",
    variant: "",
    resume_session: resumeSession,
    fallbacks: [],
  };
}

export const DEFAULTS = {
  project: {
    repo: ".",
    planning_framework: "standalone",
  },
  roles: {
    planner: defaultRole(),
    plan_reviewer: defaultRole(),
    // A capped implementer continues in a FRESH session with the hand-off
    // note (the wrap-up turn still resumes via forceResume), so resuming the
    // old session would keep growing context and defeat the caps.
    implementer: defaultRole(false),
    code_reviewer: defaultRole(),
    verifier: defaultRole(),
    free_models: {
      auto_fallback: true,
      max_turns: FREE_MODEL_TURNS_CAP_DEFAULT,
    },
  },
  caps: {
    task_size_target_turns: TASK_SIZE_TARGET_TURNS_DEFAULT,
    planner: {
      max_turns: PER_ROLE_CAPS_DEFAULT.planner.maxTurns,
      max_tokens: PER_ROLE_CAPS_DEFAULT.planner.maxTokens,
      extra_sessions: PER_ROLE_CAPS_DEFAULT.planner.extraSessions,
      wrap_up_at_tokens: PER_ROLE_WRAPUP_TOKENS_DEFAULT.planner,
    },
    plan_reviewer: {
      max_turns: PER_ROLE_CAPS_DEFAULT.plan_reviewer.maxTurns,
      max_tokens: PER_ROLE_CAPS_DEFAULT.plan_reviewer.maxTokens,
      extra_sessions: PER_ROLE_CAPS_DEFAULT.plan_reviewer.extraSessions,
      wrap_up_at_tokens: PER_ROLE_WRAPUP_TOKENS_DEFAULT.plan_reviewer,
    },
    implementer: {
      max_turns: PER_TASK_MAX_TURNS_DEFAULT,
      max_tokens: PER_TASK_MAX_TOKENS_DEFAULT,
      extra_sessions: CONTINUATION_ALLOWANCE_DEFAULT,
      wrap_up_at_tokens: HANDOFF_WRAPUP_TOKENS_DEFAULT,
    },
    code_reviewer: {
      max_turns: PER_ROLE_CAPS_DEFAULT.code_reviewer.maxTurns,
      max_tokens: PER_ROLE_CAPS_DEFAULT.code_reviewer.maxTokens,
      extra_sessions: PER_ROLE_CAPS_DEFAULT.code_reviewer.extraSessions,
      wrap_up_at_tokens: PER_ROLE_WRAPUP_TOKENS_DEFAULT.code_reviewer,
    },
    verifier: {
      max_turns: PER_ROLE_CAPS_DEFAULT.verifier.maxTurns,
      max_tokens: PER_ROLE_CAPS_DEFAULT.verifier.maxTokens,
      extra_sessions: PER_ROLE_CAPS_DEFAULT.verifier.extraSessions,
      wrap_up_at_tokens: PER_ROLE_WRAPUP_TOKENS_DEFAULT.verifier,
    },
    mission_token_backstop: BACKSTOP_RAW_TOKENS_DEFAULT,
  },
  retries: {
    plan_revisions: 8,
    implementation: 4,
    verification: 4,
    final_review_fix_rounds: FINAL_REVIEW_FIX_ROUNDS_DEFAULT,
    cli_errors: 3,
    infrastructure: 3,
    no_progress_sessions: NO_PROGRESS_GENERATIONS_DEFAULT,
    extra_sessions_per_task: CONTINUATION_ALLOWANCE_DEFAULT,
    escalate_after_not_fixed: 2,
  },
  time_limits: {
    role_timeout_minutes: {default: PER_TASK_TIMEOUT_DEFAULT_MS / MINUTE_MS, verifier: 180},
    // Hard backstop for ONE role call, not a mission deadline: the old name
    // `mission_timeout_minutes` is still read and migrated to this one.
    call_backstop_minutes: RELAY_TIMEOUT_DEFAULT_MS / MINUTE_MS,
    role_timeout_floor_minutes: null,
    silent_run_minutes: IDLE_HANG_MS_DEFAULT / MINUTE_MS,
    no_first_output_minutes: FIRST_OUTPUT_MS_DEFAULT / MINUTE_MS,
    read_only_max_silence_minutes: MAX_SILENCE_MS_DEFAULT / MINUTE_MS,
    retry_wait_seconds: 60,
  },
  workflow: {
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
  },
  tests: {
    gate_commands: [],
    gate_network: false,
    gate_env_allowlist: [],
    require_reviewer: true,
    browser: "native",
    require_browser: "when-task-requires",
    verify_denylist: [],
  },
  safety: {
    allow_git_commit: false,
    allow_git_push: false,
    allow_destructive_operations: false,
    stop_on_sandbox_violation: true,
    block_git_in_roles: true,
    check_read_only_roles: true,
    record_touched_files: true,
    keep_role_sessions: true,
  },
  runtime: {
    mode: "linux-strong",
    wsl_distro: null,
  },
  frameworks: {
    speckit: {
      workflow_file: ".specify/workflows/speckit/workflow.yml",
      task_files: [".specify/tasks.md", "specs/*/tasks.md", "specs/*/tasks/*.md"],
    },
    gsd: {
      phase_root: ".planning/phases",
      run_plan_verify: true,
      run_state_validate: true,
      write_summary_artifacts: true,
      write_verification_artifacts: true,
      write_uat_artifact: true,
      use_gsd_tools_when_available: true,
      planning_review: {
        enabled: false,
        review_after_each_stage: true,
        stages: ["discuss", "research", "plan", "plan-check"],
        max_revisions: 3,
        read_only_reviewer: true,
      },
      parallel: {
        enabled: false,
        plan_level: false,
        task_level: false,
        max_concurrent_agents: 3,
        min_plans_for_parallel: 2,
      },
    },
  },
  advanced: {
    state_file: ".autopilot/state.json",
    runs_dir: ".autopilot/runs",
    handoff_max_chars: HANDOFF_MAX_CHARS_DEFAULT,
    handoff_note_max_chars: HANDOFF_NOTE_MAX_CHARS_DEFAULT,
    handoff_wrapup_tokens: HANDOFF_WRAPUP_TOKENS_DEFAULT,
    fallback_retry_primary_minutes: FALLBACK_RETRY_PRIMARY_MINUTES,
    checkpoint_after_task: true,
    checkpoint_after_phase: true,
    capabilities: {
      project_defaults: [],
      role_requirements: {},
      safety_denied: [],
      legacy_text_inference: false,
    },
  },
};

// ---------------------------------------------------------------------------
// Mapping helpers.
// ---------------------------------------------------------------------------

function isObject(value) {
  return value !== null && typeof value !== "undefined" && typeof value === "object" && !Array.isArray(value);
}

function has(obj, key) {
  return isObject(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

function minutesToMs(value) {
  return value == null ? value : Math.round(value * MINUTE_MS);
}

function msToMinutes(value) {
  return value == null ? value : value / MINUTE_MS;
}

function roleTimeoutToMs(value) {
  if (!isObject(value)) return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) out[key] = minutesToMs(entry);
  return out;
}

function roleTimeoutToMinutes(value) {
  if (!isObject(value)) return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) out[key] = msToMinutes(entry);
  return out;
}

// Machine-written role metadata (moved to config.meta.json by migration, but
// carried through the runtime shape so an unmigrated file keeps it).
const ROLE_META_FIELDS = ["model_source", "model_verified_at", "capabilities_verified_at"];

function runtimeFallbackEntry(entry = {}, inheritReasoning = "", inheritVariant = "") {
  const out = {
    adapter: entry.cli || entry.adapter || "",
    model: entry.model ?? "",
  };
  const hasReasoning = entry.reasoning !== undefined && entry.reasoning !== "";
  const hasVariant = entry.variant !== undefined && entry.variant !== "";
  out.reasoning = hasReasoning ? entry.reasoning : inheritReasoning;
  out.variant = hasVariant ? entry.variant : inheritVariant;
  return out;
}

function layoutFallbackEntry(entry = {}) {
  const out = {
    cli: entry.adapter || "",
    model: entry.model ?? "",
  };
  if (entry.reasoning !== undefined && entry.reasoning !== "") out.reasoning = entry.reasoning;
  if (entry.variant !== undefined && entry.variant !== "") out.variant = entry.variant;
  return out;
}

// The implementer starts fresh after a cap; every other role resumes.
function defaultResumeFor(role) {
  return role !== "implementer";
}

function runtimeRole(layoutRole = {}, role = "") {
  const out = {
    adapter: layoutRole.cli || "",
    model: layoutRole.model ?? "",
    reasoning: layoutRole.reasoning ?? "",
    variant: layoutRole.variant ?? "",
    resume: has(layoutRole, "resume_session") ? layoutRole.resume_session !== false : defaultResumeFor(role),
  };
  for (const field of ROLE_META_FIELDS) {
    if (has(layoutRole, field)) out[field] = layoutRole[field];
  }
  if (has(layoutRole, "fallbacks")) {
    out.fallbacks = Array.isArray(layoutRole.fallbacks)
      ? layoutRole.fallbacks.map((fb) => runtimeFallbackEntry(fb, out.reasoning, out.variant))
      : layoutRole.fallbacks;
  }
  if (has(layoutRole, "escalation_model")) {
    const em = layoutRole.escalation_model;
    out.escalation_model = em == null
      ? em
      : {
          adapter: em.cli || em.adapter || "",
          model: em.model ?? "",
          ...(em.reasoning !== undefined && em.reasoning !== "" ? {reasoning: em.reasoning} : {}),
          ...(em.variant !== undefined && em.variant !== "" ? {variant: em.variant} : {}),
        };
  }
  return out;
}

function layoutRole(runtimeRoleEntry = {}, role = "") {
  const out = {
    cli: runtimeRoleEntry.adapter || "",
    model: runtimeRoleEntry.model ?? "",
    reasoning: runtimeRoleEntry.reasoning ?? "",
    variant: runtimeRoleEntry.variant ?? "",
    resume_session: has(runtimeRoleEntry, "resume") ? runtimeRoleEntry.resume !== false : defaultResumeFor(role),
  };
  if (has(runtimeRoleEntry, "fallbacks")) {
    out.fallbacks = Array.isArray(runtimeRoleEntry.fallbacks)
      ? runtimeRoleEntry.fallbacks.map(layoutFallbackEntry)
      : runtimeRoleEntry.fallbacks;
  }
  if (has(runtimeRoleEntry, "escalation_model")) {
    out.escalation_model = runtimeRoleEntry.escalation_model == null
      ? runtimeRoleEntry.escalation_model
      : layoutFallbackEntry(runtimeRoleEntry.escalation_model);
  }
  return out;
}

// The workflow camelCase keys the runtime reads. Each entry maps the v4
// snake_case name to the legacy camelCase key.
const WORKFLOW_MAP = [
  ["plan_review", "planReview"],
  ["plan_review_rounds_converge", "plan_review_convergence"],
  ["gsd_planning_review", "gsdPlanningReview"],
  ["spec_review", "specReview"],
  ["code_review_per_phase", "implementationReview"],
  ["final_review", "finalReview"],
  ["analysis_after_tasks", "analysisAfterTasks"],
  ["approve_spec_myself", "autoApproveSpec"],
  ["pause_for_plan_approval", "pauseForPlanApproval"],
  ["parallel_independent_tasks", "parallelIndependentTasks"],
  ["use_worktrees", "use_worktrees"],
];

// safety.* -> workflow.relaySafety.*
const RELAY_SAFETY_MAP = [
  ["block_git_in_roles", "block_git_commit_push"],
  ["check_read_only_roles", "verify_read_only_by_snapshot"],
  ["record_touched_files", "capture_touched_files"],
  ["keep_role_sessions", "persist_role_sessions"],
];

// retries.* -> policy.failure_budgets.*
const FAILURE_BUDGET_MAP = [
  ["implementation", "implementationFailureBudget"],
  ["verification", "verificationFailureBudget"],
  ["cli_errors", "adapterRetryBudget"],
  ["infrastructure", "infrastructureRetryBudget"],
];

// tests.* -> gates.* (gate_network is the inverse of network_isolation).
const GATES_MAP = [
  ["gate_commands", "commands"],
  ["gate_env_allowlist", "env_allowlist"],
  ["require_reviewer", "require_reviewer"],
];

function toRuntimePlanning(frameworks = {}) {
  const out = {};
  if (isObject(frameworks.speckit)) {
    const speckit = {};
    if (has(frameworks.speckit, "workflow_file")) speckit.workflow_file = frameworks.speckit.workflow_file;
    if (has(frameworks.speckit, "task_files")) speckit.task_candidates = frameworks.speckit.task_files;
    out.speckit = speckit;
  }
  if (isObject(frameworks.gsd)) {
    const gsd = {...frameworks.gsd};
    if (has(gsd, "parallel")) {
      gsd.parallelization = gsd.parallel;
      delete gsd.parallel;
    }
    out.gsd = gsd;
  }
  return out;
}

function toLayoutFrameworks(runtimePlanning = {}) {
  const out = {};
  if (isObject(runtimePlanning.speckit)) {
    const speckit = {};
    if (has(runtimePlanning.speckit, "workflow_file")) speckit.workflow_file = runtimePlanning.speckit.workflow_file;
    if (has(runtimePlanning.speckit, "task_candidates")) speckit.task_files = runtimePlanning.speckit.task_candidates;
    out.speckit = speckit;
  }
  if (isObject(runtimePlanning.gsd)) {
    const gsd = {...runtimePlanning.gsd};
    if (has(gsd, "parallelization")) {
      gsd.parallel = gsd.parallelization;
      delete gsd.parallelization;
    }
    out.gsd = gsd;
  }
  return out;
}

// One-release old-name compatibility for renamed time limits. The map is
// shared by migration, `ap config fill` and its report.
export const TIME_LIMIT_RENAMES = Object.freeze({
  mission_timeout_minutes: "call_backstop_minutes",
});

// Returns the same layout object when nothing changes; otherwise a new object
// with each old `time_limits` name rewritten in place to its new name (the new
// name wins if both exist). The input is never mutated. `renamed` lists the
// paths that changed so callers can report them.
export function migrateTimeLimitNames(layout = {}) {
  if (!isObject(layout) || !isObject(layout.time_limits)) {
    return {layout, changed: false, renamed: []};
  }
  const oldNames = Object.keys(TIME_LIMIT_RENAMES).filter((oldName) => has(layout.time_limits, oldName));
  if (oldNames.length === 0) return {layout, changed: false, renamed: []};

  const timeLimits = {};
  const renamed = [];
  for (const [key, value] of Object.entries(layout.time_limits)) {
    const newName = TIME_LIMIT_RENAMES[key];
    if (!newName) {
      timeLimits[key] = value;
    } else {
      if (!has(layout.time_limits, newName)) timeLimits[newName] = value;
      renamed.push({from: `time_limits.${key}`, to: `time_limits.${newName}`});
    }
  }
  const out = {};
  for (const [key, value] of Object.entries(layout)) {
    out[key] = key === "time_limits" ? timeLimits : value;
  }
  return {layout: out, changed: true, renamed};
}

// The old v4 `workflow.approve_plan_myself` never reached the runtime and its
// value must never arm the new pause. Migration and `ap config fill` drop it
// (ignoring the value) and leave `pause_for_plan_approval` at its default
// false when that key is absent. The input is never mutated; `removed` names
// the dropped path for the fill report.
export function migratePlanApprovalKey(layout = {}) {
  if (!isObject(layout) || !isObject(layout.workflow) || !has(layout.workflow, "approve_plan_myself")) {
    return {layout, changed: false, removed: []};
  }
  const workflow = {};
  let inserted = false;
  for (const [key, value] of Object.entries(layout.workflow)) {
    if (key === "approve_plan_myself") {
      if (!has(layout.workflow, "pause_for_plan_approval")) {
        workflow.pause_for_plan_approval = false;
        inserted = true;
      }
      continue;
    }
    workflow[key] = value;
  }
  const out = {};
  for (const [key, value] of Object.entries(layout)) {
    out[key] = key === "workflow" ? workflow : value;
  }
  return {layout: out, changed: true, removed: ["workflow.approve_plan_myself"], inserted};
}

// ---------------------------------------------------------------------------
// toRuntimeConfig: v4 layout -> legacy runtime shape.
// Only keys present in the layout are emitted, so a partial layout lets the
// runtime fall back to its own code defaults (never a fabricated value).
// ---------------------------------------------------------------------------
export function toRuntimeConfig(layout = {}) {
  const out = {};

  // Legacy sections (for one-release compatibility when v4 keys are absent).
  // Must be declared early because roles section references legacyPolicy.
  const legacyPolicy = isObject(layout.policy) ? layout.policy : {};
  const legacyGates = isObject(layout.gates) ? layout.gates : {};
  const legacyExecution = isObject(layout.execution) ? layout.execution : {};
  const legacyWorkflow = isObject(layout.workflow) ? layout.workflow : {};
  const legacyPlanning = isObject(layout.planning) ? layout.planning : {};
  const legacyCapabilities = isObject(layout.capabilities) ? layout.capabilities : {};

  // project (+ advanced.state_file / advanced.runs_dir map in).
  const project = {};
  if (isObject(layout.project)) {
    if (has(layout.project, "repo")) project.repo = layout.project.repo;
    if (has(layout.project, "planning_framework")) project.planning_framework = layout.project.planning_framework;
  }
  if (isObject(layout.advanced)) {
    if (has(layout.advanced, "state_file")) project.state_file = layout.advanced.state_file;
    if (has(layout.advanced, "runs_dir")) project.runs_dir = layout.advanced.runs_dir;
  }
  if (Object.keys(project).length) out.project = project;

  // roles (+ roles.free_models -> policy/top-level free-model settings).
  const policy = {};
  if (isObject(layout.roles)) {
    const roles = {};
    for (const role of ROLE_NAMES) {
      const roleLayout = layout.roles[role];
      if (!isObject(roleLayout)) continue;
      // Legacy fallback: adapter -> cli, resume -> resume_session
      const roleWithLegacy = {...roleLayout};
      if (!has(roleWithLegacy, "cli") && has(roleWithLegacy, "adapter")) roleWithLegacy.cli = roleWithLegacy.adapter;
      if (!has(roleWithLegacy, "resume_session") && has(roleWithLegacy, "resume")) roleWithLegacy.resume_session = roleWithLegacy.resume;
      roles[role] = runtimeRole(roleWithLegacy, role);
    }
    if (Object.keys(roles).length) out.roles = roles;
    if (isObject(layout.roles.free_models)) {
      if (has(layout.roles.free_models, "max_turns")) policy.free_model_turns_cap = layout.roles.free_models.max_turns;
      if (has(layout.roles.free_models, "auto_fallback")) out.freeModelAutoFallback = layout.roles.free_models.auto_fallback;
    }
  }
  // Legacy fallback: top-level freeModelAutoFallback and policy.free_model_turns_cap
  if (!has(layout.roles?.free_models || {}, "auto_fallback") && has(layout, "freeModelAutoFallback")) out.freeModelAutoFallback = layout.freeModelAutoFallback;
  if (!has(layout.roles?.free_models || {}, "max_turns") && has(legacyPolicy, "free_model_turns_cap")) policy.free_model_turns_cap = legacyPolicy.free_model_turns_cap;

  const caps = isObject(layout.caps) ? layout.caps : {};
  const retries = isObject(layout.retries) ? layout.retries : {};
  const timeLimits = isObject(layout.time_limits) ? layout.time_limits : {};
  const workflow = isObject(layout.workflow) ? layout.workflow : {};
  const tests = isObject(layout.tests) ? layout.tests : {};
  const safety = isObject(layout.safety) ? layout.safety : {};
  const advanced = isObject(layout.advanced) ? layout.advanced : {};

  // caps.<reviewRole> -> policy.caps.<role>
  const runtimeCaps = {};
  for (const role of REVIEW_ROLES) {
    const roleCaps = caps[role];
    const legacyRoleCaps = isObject(legacyPolicy.caps) ? legacyPolicy.caps[role] : null;
    if (!isObject(roleCaps) && !isObject(legacyRoleCaps)) continue;
    const entry = {};
    if (has(roleCaps, "max_turns")) entry.max_turns = roleCaps.max_turns;
    else if (has(legacyRoleCaps, "max_turns")) entry.max_turns = legacyRoleCaps.max_turns;
    if (has(roleCaps, "max_tokens")) entry.max_tokens = roleCaps.max_tokens;
    else if (has(legacyRoleCaps, "max_tokens")) entry.max_tokens = legacyRoleCaps.max_tokens;
    if (has(roleCaps, "extra_sessions")) entry.extra_sessions = roleCaps.extra_sessions;
    else if (has(legacyRoleCaps, "extra_sessions")) entry.extra_sessions = legacyRoleCaps.extra_sessions;
    if (has(roleCaps, "wrap_up_at_tokens")) entry.wrap_up_tokens_threshold = roleCaps.wrap_up_at_tokens;
    else if (has(legacyRoleCaps, "wrap_up_tokens_threshold")) entry.wrap_up_tokens_threshold = legacyRoleCaps.wrap_up_tokens_threshold;
    // Mission 047 backstop: a per-role raw-token backstop override is an operator
    // value, not a shipped default, so it round-trips even though it has no
    // DEFAULTS entry (mission 096 PLAN.md:108,113-115 — behaviour must not change).
    if (has(roleCaps, "backstop_raw_tokens")) entry.backstop_raw_tokens = roleCaps.backstop_raw_tokens;
    else if (has(legacyRoleCaps, "backstop_raw_tokens")) entry.backstop_raw_tokens = legacyRoleCaps.backstop_raw_tokens;
    if (Object.keys(entry).length) runtimeCaps[role] = entry;
  }
  if (Object.keys(runtimeCaps).length) policy.caps = runtimeCaps;

  // caps.implementer -> policy.per_task_max_* / continuation_allowance / handoff_wrapup_tokens
  const implementerCaps = isObject(caps.implementer) ? caps.implementer : {};
  if (has(implementerCaps, "max_turns")) policy.per_task_max_turns = implementerCaps.max_turns;
  else if (has(legacyPolicy, "per_task_max_turns")) policy.per_task_max_turns = legacyPolicy.per_task_max_turns;
  if (has(implementerCaps, "max_tokens")) policy.per_task_max_tokens = implementerCaps.max_tokens;
  else if (has(legacyPolicy, "per_task_max_tokens")) policy.per_task_max_tokens = legacyPolicy.per_task_max_tokens;
  if (has(implementerCaps, "extra_sessions")) policy.continuation_allowance = implementerCaps.extra_sessions;
  else if (has(retries, "extra_sessions_per_task")) policy.continuation_allowance = retries.extra_sessions_per_task;
  else if (has(legacyPolicy, "continuation_allowance")) policy.continuation_allowance = legacyPolicy.continuation_allowance;
  if (has(implementerCaps, "wrap_up_at_tokens")) policy.handoff_wrapup_tokens = implementerCaps.wrap_up_at_tokens;
  else if (has(advanced, "handoff_wrapup_tokens")) policy.handoff_wrapup_tokens = advanced.handoff_wrapup_tokens;
  else if (has(legacyPolicy, "handoff_wrapup_tokens")) policy.handoff_wrapup_tokens = legacyPolicy.handoff_wrapup_tokens;
  if (has(caps, "task_size_target_turns")) policy.task_size_target_turns = caps.task_size_target_turns;
  else if (has(legacyPolicy, "task_size_target_turns")) policy.task_size_target_turns = legacyPolicy.task_size_target_turns;
  if (has(caps, "mission_token_backstop")) policy.backstop_raw_tokens = caps.mission_token_backstop;
  else if (has(legacyPolicy, "backstop_raw_tokens")) policy.backstop_raw_tokens = legacyPolicy.backstop_raw_tokens;

  // retries.* -> policy.failure_budgets.* / revisions / continuation / no-progress / fix rounds
  const failureBudgets = {};
  for (const [layoutKey, runtimeKey] of FAILURE_BUDGET_MAP) {
    if (has(retries, layoutKey)) failureBudgets[runtimeKey] = retries[layoutKey];
    else if (has(legacyPolicy.failure_budgets || {}, runtimeKey)) failureBudgets[runtimeKey] = legacyPolicy.failure_budgets[runtimeKey];
  }
  if (Object.keys(failureBudgets).length) policy.failure_budgets = failureBudgets;
  if (has(retries, "plan_revisions")) policy.max_plan_revisions = retries.plan_revisions;
  else if (has(legacyPolicy, "max_plan_revisions")) policy.max_plan_revisions = legacyPolicy.max_plan_revisions;
  if (has(retries, "no_progress_sessions")) policy.no_progress_generations = retries.no_progress_sessions;
  else if (has(legacyPolicy, "no_progress_generations")) policy.no_progress_generations = legacyPolicy.no_progress_generations;
  if (has(retries, "final_review_fix_rounds")) policy.final_review_fix_rounds = retries.final_review_fix_rounds;
  else if (has(legacyPolicy, "final_review_fix_rounds")) policy.final_review_fix_rounds = legacyPolicy.final_review_fix_rounds;
  if (has(retries, "escalate_after_not_fixed")) policy.escalate_after_not_fixed = retries.escalate_after_not_fixed;
  else if (has(legacyPolicy, "escalate_after_not_fixed")) policy.escalate_after_not_fixed = legacyPolicy.escalate_after_not_fixed;

  // time_limits.* -> policy.* (minutes/seconds -> milliseconds)
  // Old name one-release compatibility: `mission_timeout_minutes` maps to the
  // same one-role-call backstop, but the new name wins when both are present.
  if (has(timeLimits, "call_backstop_minutes")) policy.relay_timeout_ms = minutesToMs(timeLimits.call_backstop_minutes);
  else if (has(timeLimits, "mission_timeout_minutes")) policy.relay_timeout_ms = minutesToMs(timeLimits.mission_timeout_minutes);
  else if (has(legacyPolicy, "relay_timeout_ms")) policy.relay_timeout_ms = legacyPolicy.relay_timeout_ms;
  if (has(timeLimits, "role_timeout_minutes")) {
    policy.role_timeout_ms = roleTimeoutToMs(timeLimits.role_timeout_minutes);
    // per_task_timeout_ms uses the default role timeout (config.md mapping)
    const roleTimeouts = timeLimits.role_timeout_minutes;
    if (isObject(roleTimeouts) && has(roleTimeouts, "default")) {
      policy.per_task_timeout_ms = minutesToMs(roleTimeouts.default);
    }
  } else if (has(legacyPolicy, "role_timeout_ms")) {
    policy.role_timeout_ms = legacyPolicy.role_timeout_ms;
    if (isObject(legacyPolicy.role_timeout_ms) && has(legacyPolicy.role_timeout_ms, "default")) {
      policy.per_task_timeout_ms = legacyPolicy.role_timeout_ms.default;
    }
  }
  // Legacy fallback: explicit policy.per_task_timeout_ms when not derived from role_timeout_minutes.default
  if (!has(policy, "per_task_timeout_ms") && has(legacyPolicy, "per_task_timeout_ms")) {
    policy.per_task_timeout_ms = legacyPolicy.per_task_timeout_ms;
  }
  if (has(timeLimits, "role_timeout_floor_minutes")) policy.role_deadline_floor_ms = minutesToMs(timeLimits.role_timeout_floor_minutes);
  else if (has(legacyPolicy, "role_deadline_floor_ms")) policy.role_deadline_floor_ms = legacyPolicy.role_deadline_floor_ms;
  if (has(timeLimits, "silent_run_minutes")) policy.idle_hang_ms = minutesToMs(timeLimits.silent_run_minutes);
  else if (has(legacyPolicy, "idle_hang_ms")) policy.idle_hang_ms = legacyPolicy.idle_hang_ms;
  if (has(timeLimits, "no_first_output_minutes")) policy.first_output_ms = minutesToMs(timeLimits.no_first_output_minutes);
  else if (has(legacyPolicy, "first_output_ms")) policy.first_output_ms = legacyPolicy.first_output_ms;
  if (has(timeLimits, "read_only_max_silence_minutes")) policy.max_silence_ms = minutesToMs(timeLimits.read_only_max_silence_minutes);
  else if (has(legacyPolicy, "max_silence_ms")) policy.max_silence_ms = legacyPolicy.max_silence_ms;
  if (has(timeLimits, "retry_wait_seconds")) policy.retry_delay_ms = timeLimits.retry_wait_seconds == null ? timeLimits.retry_wait_seconds : timeLimits.retry_wait_seconds * SECOND_MS;
  else if (has(legacyPolicy, "retry_delay_ms")) policy.retry_delay_ms = legacyPolicy.retry_delay_ms;

  // advanced.* -> policy.handoff_* / checkpoint_* / fallback_retry_primary_minutes
  if (has(advanced, "handoff_max_chars")) policy.handoff_max_chars = advanced.handoff_max_chars;
  else if (has(legacyPolicy, "handoff_max_chars")) policy.handoff_max_chars = legacyPolicy.handoff_max_chars;
  if (has(advanced, "handoff_note_max_chars")) policy.handoff_note_max_chars = advanced.handoff_note_max_chars;
  else if (has(legacyPolicy, "handoff_note_max_chars")) policy.handoff_note_max_chars = legacyPolicy.handoff_note_max_chars;
  if (has(advanced, "fallback_retry_primary_minutes")) policy.fallback_retry_primary_minutes = advanced.fallback_retry_primary_minutes;
  else if (has(legacyPolicy, "fallback_retry_primary_minutes")) policy.fallback_retry_primary_minutes = legacyPolicy.fallback_retry_primary_minutes;
  if (has(advanced, "checkpoint_after_task")) policy.checkpoint_after_task = advanced.checkpoint_after_task;
  else if (has(legacyPolicy, "checkpoint_after_task")) policy.checkpoint_after_task = legacyPolicy.checkpoint_after_task;
  if (has(advanced, "checkpoint_after_phase")) policy.checkpoint_after_phase = advanced.checkpoint_after_phase;
  else if (has(legacyPolicy, "checkpoint_after_phase")) policy.checkpoint_after_phase = legacyPolicy.checkpoint_after_phase;

  // workflow.* -> policy.require_human_commit + runtime workflow camelCase
  if (has(workflow, "commit_by_human")) policy.require_human_commit = workflow.commit_by_human;
  else if (has(legacyPolicy, "require_human_commit")) policy.require_human_commit = legacyPolicy.require_human_commit;

  // safety.stop_on_sandbox_violation -> policy.fail_closed_on_relay_violation
  if (has(safety, "stop_on_sandbox_violation")) policy.fail_closed_on_relay_violation = safety.stop_on_sandbox_violation;
  else if (has(legacyPolicy, "fail_closed_on_relay_violation")) policy.fail_closed_on_relay_violation = legacyPolicy.fail_closed_on_relay_violation;

  // Carry unmapped legacy policy keys through (without overriding v4-derived values)
  if (isObject(legacyPolicy)) {
    for (const [key, value] of Object.entries(legacyPolicy)) {
      const knownKeys = new Set([
        "caps", "free_model_turns_cap", "per_task_max_turns", "per_task_max_tokens",
        "continuation_allowance", "handoff_wrapup_tokens", "handoff_max_chars",
        "handoff_note_max_chars", "fallback_retry_primary_minutes", "task_size_target_turns",
        "backstop_raw_tokens", "relay_timeout_ms", "role_timeout_ms", "role_deadline_floor_ms",
        "idle_hang_ms", "first_output_ms", "max_silence_ms", "retry_delay_ms",
        "checkpoint_after_task", "checkpoint_after_phase", "fail_closed_on_relay_violation",
        "max_plan_revisions", "no_progress_generations", "final_review_fix_rounds",
        "failure_budgets", "require_human_commit", "per_task_timeout_ms"
      ]);
      if (!knownKeys.has(key) && !has(policy, key)) policy[key] = value;
    }
  }

  if (Object.keys(policy).length) out.policy = policy;

  // runtime -> execution
  const execution = {};
  if (isObject(layout.runtime)) {
    if (has(layout.runtime, "mode")) execution.runtime_mode = layout.runtime.mode;
    else if (has(legacyExecution, "runtime_mode")) execution.runtime_mode = legacyExecution.runtime_mode;
    if (has(layout.runtime, "wsl_distro")) execution.wsl_distro = layout.runtime.wsl_distro;
    else if (has(legacyExecution, "wsl_distro")) execution.wsl_distro = legacyExecution.wsl_distro;
  } else {
    if (has(legacyExecution, "runtime_mode")) execution.runtime_mode = legacyExecution.runtime_mode;
    if (has(legacyExecution, "wsl_distro")) execution.wsl_distro = legacyExecution.wsl_distro;
  }
  if (Object.keys(execution).length) out.execution = execution;

  // workflow camelCase + relaySafety
  const runtimeWorkflow = {};
  for (const [layoutKey, runtimeKey] of WORKFLOW_MAP) {
    if (has(workflow, layoutKey)) runtimeWorkflow[runtimeKey] = workflow[layoutKey];
    else if (has(legacyWorkflow, runtimeKey)) runtimeWorkflow[runtimeKey] = legacyWorkflow[runtimeKey];
  }
  const relaySafety = {};
  for (const [layoutKey, runtimeKey] of RELAY_SAFETY_MAP) {
    if (has(safety, layoutKey)) relaySafety[runtimeKey] = safety[layoutKey];
    else if (has(legacyWorkflow.relaySafety || {}, runtimeKey)) relaySafety[runtimeKey] = legacyWorkflow.relaySafety[runtimeKey];
  }
  if (Object.keys(relaySafety).length) runtimeWorkflow.relaySafety = relaySafety;
  if (Object.keys(runtimeWorkflow).length) out.workflow = runtimeWorkflow;

  // gates
  const gates = {};
  for (const [layoutKey, runtimeKey] of GATES_MAP) {
    if (has(tests, layoutKey)) gates[runtimeKey] = tests[layoutKey];
    else if (has(legacyGates, runtimeKey)) gates[runtimeKey] = legacyGates[runtimeKey];
  }
  if (has(tests, "gate_network")) gates.network_isolation = tests.gate_network === false;
  else if (has(legacyGates, "network_isolation")) gates.network_isolation = legacyGates.network_isolation;
  if (Object.keys(gates).length) out.gates = gates;

  // safety (allow_* stay in safety)
  const runtimeSafety = {};
  for (const key of ["allow_git_commit", "allow_git_push", "allow_destructive_operations"]) {
    if (has(safety, key)) runtimeSafety[key] = safety[key];
  }
  if (Object.keys(runtimeSafety).length) out.safety = runtimeSafety;

  // planning (frameworks + tests.verify_denylist)
  const planning = toRuntimePlanning(layout.frameworks);
  if (has(tests, "verify_denylist")) planning.verify_denylist = tests.verify_denylist;
  else if (has(legacyPlanning, "verify_denylist")) planning.verify_denylist = legacyPlanning.verify_denylist;
  // Legacy fallback: planning.speckit / planning.gsd — merge missing keys even when frameworks exists
  if (isObject(legacyPlanning.speckit)) {
    planning.speckit = planning.speckit || {};
    if (has(legacyPlanning.speckit, "workflow_file") && !has(planning.speckit, "workflow_file")) planning.speckit.workflow_file = legacyPlanning.speckit.workflow_file;
    if (has(legacyPlanning.speckit, "task_candidates") && !has(planning.speckit, "task_candidates")) planning.speckit.task_candidates = legacyPlanning.speckit.task_candidates;
  }
  if (isObject(legacyPlanning.gsd)) {
    planning.gsd = planning.gsd || {};
    for (const [key, value] of Object.entries(legacyPlanning.gsd)) {
      if (!has(planning.gsd, key)) planning.gsd[key] = value;
    }
  }
  if (Object.keys(planning).length) out.planning = planning;

  // capabilities (advanced.capabilities + tests.browser/require_browser)
  const capabilities = {};
  if (isObject(advanced.capabilities)) {
    for (const [key, value] of Object.entries(advanced.capabilities)) capabilities[key] = value;
  } else if (isObject(legacyCapabilities)) {
    for (const [key, value] of Object.entries(legacyCapabilities)) {
      if (key !== "verification") capabilities[key] = value;
    }
  }
  const verification = {};
  if (has(tests, "browser")) verification.browser = tests.browser;
  else if (has(legacyCapabilities.verification || {}, "browser")) verification.browser = legacyCapabilities.verification.browser;
  if (has(tests, "require_browser")) verification.require_browser = tests.require_browser;
  else if (has(legacyCapabilities.verification || {}, "require_browser")) verification.require_browser = legacyCapabilities.verification.require_browser;
  if (Object.keys(verification).length) capabilities.verification = verification;
  if (Object.keys(capabilities).length) out.capabilities = capabilities;

  // Lossless adapter (spec rule 8: the reader still accepts the old layout for
  // one release): operator-added keys that belong to no section are carried
  // back onto the runtime shape instead of being silently dropped. `_`-prefixed
  // keys are ignored by design. Late v4 validation flags
  // unknown keys as errors. Legacy section names are listed so they are not
  // carried through as unknown keys — their contents are mapped explicitly above.
  const SECTION_KEYS = new Set(["$schema", "schema_version", "project", "roles", "caps", "retries", "time_limits", "workflow", "tests", "safety", "runtime", "frameworks", "advanced", "policy", "gates", "execution", "planning", "capabilities"]);
  for (const [key, value] of Object.entries(layout)) {
    if (!SECTION_KEYS.has(key) && !key.startsWith("_")) out[key] = value;
  }
  if (isObject(layout.project)) {
    const carried = {};
    for (const [key, value] of Object.entries(layout.project)) {
      if (!["repo", "planning_framework"].includes(key) && !key.startsWith("_")) carried[key] = value;
    }
    if (Object.keys(carried).length) {
      out.project = out.project || {};
      Object.assign(out.project, carried);
    }
  }
  if (isObject(layout.runtime)) {
    const carried = {};
    for (const [key, value] of Object.entries(layout.runtime)) {
      if (!["mode", "wsl_distro"].includes(key) && !key.startsWith("_")) carried[key] = value;
    }
    if (Object.keys(carried).length) {
      out.execution = out.execution || {};
      Object.assign(out.execution, carried);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// toNewLayoutConfig: legacy runtime shape -> v4 layout (for setup/edit writes).
// Starts from DEFAULTS (complete v4 layout with all defaults) and overlays
// any explicitly-set values from the legacy runtime config.
// ---------------------------------------------------------------------------
export function toNewLayoutConfig(runtimeConfig = {}, schemaRef = "./config.schema.json") {
  const project = isObject(runtimeConfig.project) ? runtimeConfig.project : {};
  const roles = isObject(runtimeConfig.roles) ? runtimeConfig.roles : {};
  const policy = isObject(runtimeConfig.policy) ? runtimeConfig.policy : {};
  const execution = isObject(runtimeConfig.execution) ? runtimeConfig.execution : {};
  const workflow = isObject(runtimeConfig.workflow) ? runtimeConfig.workflow : {};
  const gates = isObject(runtimeConfig.gates) ? runtimeConfig.gates : {};
  const planning = isObject(runtimeConfig.planning) ? runtimeConfig.planning : {};
  const capabilities = isObject(runtimeConfig.capabilities) ? runtimeConfig.capabilities : {};
  const safety = isObject(runtimeConfig.safety) ? runtimeConfig.safety : {};
  const relaySafety = isObject(workflow.relaySafety) ? workflow.relaySafety : {};

  // Start with a deep copy of DEFAULTS so every v4 section/key is present at its default.
  const baseLayout = JSON.parse(JSON.stringify(DEFAULTS));
  // Build layout with $schema first, then schema_version, then all other sections.
  const layout = {
    $schema: typeof schemaRef === "string" && schemaRef.trim() !== "" ? schemaRef : "./config.schema.json",
    schema_version: CONFIG_SCHEMA_VERSION,
    ...baseLayout
  };

  // project
  if (has(project, "repo")) layout.project.repo = project.repo;
  if (has(project, "planning_framework")) layout.project.planning_framework = project.planning_framework;

  // roles
  for (const role of ROLE_NAMES) {
    layout.roles[role] = layoutRole(roles[role] || {}, role);
  }
  // roles.free_models
  if (runtimeConfig.freeModelAutoFallback !== undefined) {
    layout.roles.free_models.auto_fallback = runtimeConfig.freeModelAutoFallback !== false;
  }
  if (has(policy, "free_model_turns_cap")) {
    layout.roles.free_models.max_turns = policy.free_model_turns_cap;
  }

  // caps
  if (has(policy, "task_size_target_turns")) layout.caps.task_size_target_turns = policy.task_size_target_turns;
  const runtimeCaps = isObject(policy.caps) ? policy.caps : {};
  for (const role of REVIEW_ROLES) {
    const entry = runtimeCaps[role];
    if (!isObject(entry)) continue;
    if (has(entry, "max_turns")) layout.caps[role].max_turns = entry.max_turns;
    if (has(entry, "max_tokens")) layout.caps[role].max_tokens = entry.max_tokens;
    if (has(entry, "extra_sessions")) layout.caps[role].extra_sessions = entry.extra_sessions;
    if (has(entry, "wrap_up_tokens_threshold")) layout.caps[role].wrap_up_at_tokens = entry.wrap_up_tokens_threshold;
    if (has(entry, "backstop_raw_tokens")) layout.caps[role].backstop_raw_tokens = entry.backstop_raw_tokens;
  }
  if (has(policy, "per_task_max_turns")) layout.caps.implementer.max_turns = policy.per_task_max_turns;
  if (has(policy, "per_task_max_tokens")) layout.caps.implementer.max_tokens = policy.per_task_max_tokens;
  if (has(policy, "continuation_allowance")) layout.caps.implementer.extra_sessions = policy.continuation_allowance;
  if (has(policy, "handoff_wrapup_tokens")) layout.caps.implementer.wrap_up_at_tokens = policy.handoff_wrapup_tokens;
  if (has(policy, "backstop_raw_tokens")) layout.caps.mission_token_backstop = policy.backstop_raw_tokens;

  // retries
  if (has(policy, "max_plan_revisions")) layout.retries.plan_revisions = policy.max_plan_revisions;
  if (has(policy, "no_progress_generations")) layout.retries.no_progress_sessions = policy.no_progress_generations;
  if (has(policy, "final_review_fix_rounds")) layout.retries.final_review_fix_rounds = policy.final_review_fix_rounds;
  if (has(policy, "continuation_allowance")) layout.retries.extra_sessions_per_task = policy.continuation_allowance;
  const failureBudgets = isObject(policy.failure_budgets) ? policy.failure_budgets : {};
  for (const [layoutKey, runtimeKey] of FAILURE_BUDGET_MAP) {
    if (has(failureBudgets, runtimeKey)) layout.retries[layoutKey] = failureBudgets[runtimeKey];
  }

  // time_limits
  if (has(policy, "relay_timeout_ms")) layout.time_limits.call_backstop_minutes = msToMinutes(policy.relay_timeout_ms);
  if (has(policy, "role_timeout_ms")) layout.time_limits.role_timeout_minutes = roleTimeoutToMinutes(policy.role_timeout_ms);
  // per_task_timeout_ms maps to role_timeout_minutes.default (config.md) if no explicit default
  const roleTimeoutMs = isObject(policy.role_timeout_ms) ? policy.role_timeout_ms : {};
  const hasRoleTimeoutDefault = has(roleTimeoutMs, "default");
  if (has(policy, "per_task_timeout_ms") && !hasRoleTimeoutDefault) {
    layout.time_limits.role_timeout_minutes = {...layout.time_limits.role_timeout_minutes, default: msToMinutes(policy.per_task_timeout_ms)};
  }
  if (has(policy, "role_deadline_floor_ms")) layout.time_limits.role_timeout_floor_minutes = msToMinutes(policy.role_deadline_floor_ms);
  if (has(policy, "idle_hang_ms")) layout.time_limits.silent_run_minutes = msToMinutes(policy.idle_hang_ms);
  if (has(policy, "first_output_ms")) layout.time_limits.no_first_output_minutes = msToMinutes(policy.first_output_ms);
  if (has(policy, "max_silence_ms")) layout.time_limits.read_only_max_silence_minutes = msToMinutes(policy.max_silence_ms);
  if (has(policy, "retry_delay_ms")) layout.time_limits.retry_wait_seconds = policy.retry_delay_ms == null ? policy.retry_delay_ms : policy.retry_delay_ms / SECOND_MS;

  // workflow
  for (const [layoutKey, runtimeKey] of WORKFLOW_MAP) {
    if (has(workflow, runtimeKey)) layout.workflow[layoutKey] = workflow[runtimeKey];
  }
  if (has(policy, "require_human_commit")) layout.workflow.commit_by_human = policy.require_human_commit;

  // tests
  for (const [layoutKey, runtimeKey] of GATES_MAP) {
    if (has(gates, runtimeKey)) layout.tests[layoutKey] = gates[runtimeKey];
  }
  if (has(gates, "network_isolation")) layout.tests.gate_network = gates.network_isolation === false;
  const verification = isObject(capabilities.verification) ? capabilities.verification : {};
  if (has(verification, "browser")) layout.tests.browser = verification.browser;
  if (has(verification, "require_browser")) layout.tests.require_browser = verification.require_browser;
  if (has(planning, "verify_denylist")) layout.tests.verify_denylist = planning.verify_denylist;

  // safety
  for (const key of ["allow_git_commit", "allow_git_push", "allow_destructive_operations"]) {
    if (has(safety, key)) layout.safety[key] = safety[key];
  }
  if (has(policy, "fail_closed_on_relay_violation")) layout.safety.stop_on_sandbox_violation = policy.fail_closed_on_relay_violation;
  for (const [layoutKey, runtimeKey] of RELAY_SAFETY_MAP) {
    if (has(relaySafety, runtimeKey)) layout.safety[layoutKey] = relaySafety[runtimeKey];
  }

  // runtime
  if (has(execution, "runtime_mode")) layout.runtime.mode = execution.runtime_mode;
  if (has(execution, "wsl_distro")) layout.runtime.wsl_distro = execution.wsl_distro;

  // frameworks
  layout.frameworks = toLayoutFrameworks(planning);

  // advanced
  if (has(project, "state_file")) layout.advanced.state_file = project.state_file;
  if (has(project, "runs_dir")) layout.advanced.runs_dir = project.runs_dir;
  if (has(policy, "handoff_max_chars")) layout.advanced.handoff_max_chars = policy.handoff_max_chars;
  if (has(policy, "handoff_note_max_chars")) layout.advanced.handoff_note_max_chars = policy.handoff_note_max_chars;
  if (has(policy, "handoff_wrapup_tokens")) layout.advanced.handoff_wrapup_tokens = policy.handoff_wrapup_tokens;
  if (has(policy, "fallback_retry_primary_minutes")) layout.advanced.fallback_retry_primary_minutes = policy.fallback_retry_primary_minutes;
  if (has(policy, "checkpoint_after_task")) layout.advanced.checkpoint_after_task = policy.checkpoint_after_task;
  if (has(policy, "checkpoint_after_phase")) layout.advanced.checkpoint_after_phase = policy.checkpoint_after_phase;
  const advCapabilities = {};
  for (const key of ["project_defaults", "role_requirements", "safety_denied", "legacy_text_inference"]) {
    if (has(capabilities, key)) advCapabilities[key] = capabilities[key];
  }
  if (Object.keys(advCapabilities).length) layout.advanced.capabilities = advCapabilities;

  // Lossless: carry forward operator-added keys that belong to no v4 section.
  // Mirrors the logic in toRuntimeConfig (spec rule 8: accept old layout for one release).
  const SECTION_KEYS = new Set(["$schema", "schema_version", "project", "roles", "caps", "retries", "time_limits", "workflow", "tests", "safety", "runtime", "frameworks", "advanced", "policy", "gates", "execution", "planning", "capabilities", "freeModelAutoFallback"]);
  for (const [key, value] of Object.entries(runtimeConfig)) {
    if (!SECTION_KEYS.has(key) && !key.startsWith("_")) layout[key] = value;
  }
  if (isObject(runtimeConfig.project)) {
    const carried = {};
    for (const [key, value] of Object.entries(runtimeConfig.project)) {
      if (!["repo", "planning_framework", "state_file", "runs_dir"].includes(key) && !key.startsWith("_")) carried[key] = value;
    }
    if (Object.keys(carried).length) {
      layout.project = layout.project || {};
      Object.assign(layout.project, carried);
    }
  }
  if (isObject(runtimeConfig.execution)) {
    const carried = {};
    for (const [key, value] of Object.entries(runtimeConfig.execution)) {
      if (!["runtime_mode", "wsl_distro"].includes(key) && !key.startsWith("_")) carried[key] = value;
    }
    if (Object.keys(carried).length) {
      layout.runtime = layout.runtime || {};
      Object.assign(layout.runtime, carried);
    }
  }

  return layout;
}
