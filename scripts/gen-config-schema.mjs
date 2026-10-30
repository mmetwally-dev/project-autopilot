#!/usr/bin/env node
// Backlog #1 "readable config" (mission 096 Phase 1 task 1.2): generate the
// shipped config.schema.json from config-layout.mjs DEFAULTS.
//
// The schema is the single source of the human descriptions and of the
// allowed values; the default values themselves are copied straight out of
// DEFAULTS (which imports the real numbers from per-task-budget.mjs), so the
// numbers cannot drift from the code. scripts/test-config-schema.mjs asserts
// the checked-in file still matches DEFAULTS and this generator.
//
// Run: node scripts/gen-config-schema.mjs   (rewrites ./config.schema.json and the reference in docs/configuration.md)

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULTS, CONFIG_SCHEMA_VERSION } from "./config-layout.mjs";
import { HANDOFF_MIN_CHARS, HANDOFF_NOTE_MIN_CHARS } from "./per-task-budget.mjs";
import { renderConfigReference } from "./config-reference.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = join(HERE, "..", "config.schema.json");
export const SCHEMA_ID = "./config.schema.json";
export const CONFIG_REFERENCE_PATH = join(HERE, "..", "docs", "configuration.md");
export const CONFIG_REFERENCE_START = "<!-- config-reference:start -->";
export const CONFIG_REFERENCE_END = "<!-- config-reference:end -->";

// The docs block between the markers is generated; everything outside them
// is hand-written and must survive every regeneration untouched.
export function extractConfigReference(document) {
  const start = document.indexOf(CONFIG_REFERENCE_START);
  const end = document.indexOf(CONFIG_REFERENCE_END);
  if (start === -1 || end === -1 || end < start) return null;
  const body = document.slice(start + CONFIG_REFERENCE_START.length, end);
  return body.replace(/^\r?\n/, "");
}

export function withConfigReference(document, reference = renderConfigReference()) {
  const block = `${CONFIG_REFERENCE_START}\n${reference}${CONFIG_REFERENCE_END}`;
  const start = document.indexOf(CONFIG_REFERENCE_START);
  const end = document.indexOf(CONFIG_REFERENCE_END);
  if (start !== -1 && end > start) {
    return document.slice(0, start) + block + document.slice(end + CONFIG_REFERENCE_END.length);
  }
  const separator = document.endsWith("\n") ? "\n" : "\n\n";
  return `${document}${separator}${block}\n`;
}

// One-line description per key, by dotted path (a "*" stands for any role
// name). Every property must have one; the test enforces that.
const DESCRIPTIONS = {
  $schema: "Path to the JSON schema that gives editor help for this file.",
  schema_version: "On-disk config format version; always 4.0 for this layout.",

  project: "Project identity and how its work is planned.",
  "project.repo": "Intended repository root the mission runs in. Fixed in this version; changing it has no effect. Autopilot uses the folder you run it in, or --repo.",
  "project.planning_framework": "How work is planned: standalone, speckit or gsd; auto detects the framework from the repository.",

  roles: "The agent CLI, model and session settings for each role.",
  "roles.planner": "Role settings for the planner, which writes the plan.",
  "roles.plan_reviewer": "Role settings for the plan reviewer, which checks the plan.",
  "roles.implementer": "Role settings for the implementer, which makes the code changes.",
  "roles.code_reviewer": "Role settings for the code reviewer, which checks the changes.",
  "roles.verifier": "Role settings for the verifier, which runs the checks.",
  "roles.*.cli": "Agent CLI adapter that runs this role (for example claude, opencode or codex); empty leaves it unset.",
  "roles.*.model": "Model id this role uses (for example provider/model); empty means the adapter default.",
  "roles.*.reasoning": "Reasoning effort sent to the model (low, medium, high, ...); empty means the adapter default.",
  "roles.*.variant": "Extra model variant for adapters that support it; empty means no variant.",
  "roles.*.resume_session": "Start from this role's previous session (true) or fresh (false); the implementer defaults to false so a capped run continues fresh with the hand-off note.",
  "roles.*.fallbacks": "Fallback CLI and model entries tried in order when the primary one fails; empty means no fallbacks.",
  "roles.*.escalation_model": "Stronger model used for fix rounds after retries.escalate_after_not_fixed reviews report the same finding not-fixed; null or absent turns escalation off.",
  "roles.*.escalation_model.cli": "CLI adapter for the escalation model; required for escalation.",
  "roles.*.escalation_model.model": "Model id for the escalation model; required for escalation.",
  "roles.*.escalation_model.reasoning": "Reasoning effort for the escalation model; empty uses no explicit effort.",
  "roles.*.escalation_model.variant": "Model variant for the escalation model; empty means no variant.",
  "roles.free_models": "The free-model fallback pool.",
  "roles.free_models.auto_fallback": "When the effective model is free and the configured fallbacks are used up, try another free model from the same CLI (true) or not (false).",
  "roles.free_models.max_turns": "Most turns a role running a free model may use; 0 turns this extra cap off, and at the limit the run is cut and may continue in a new session.",

  caps: "Per-role turn, token and session caps plus the mission token backstop.",
  "caps.planner": "Caps for the planner role.",
  "caps.plan_reviewer": "Caps for the plan reviewer role.",
  "caps.implementer": "Caps for the implementer role.",
  "caps.code_reviewer": "Caps for the code reviewer role.",
  "caps.verifier": "Caps for the verifier role.",
  "caps.task_size_target_turns": "Implementer turns the planner should aim for per task when splitting work; this is guidance, not a hard limit.",
  "caps.*.max_turns": "Most model turns this role may use in one session; at the limit the role stops and hands off, then extra_sessions decides whether a new session may continue.",
  "caps.*.max_tokens": "Largest single-turn context (input plus cached input) this role may use; at the limit the role stops and hands off, then extra_sessions decides whether a new session may continue.",
  "caps.*.extra_sessions": "Extra sessions this role may start after hitting its turn or token cap; at the limit no further session starts and the mission stops or reports the cap.",
  "caps.*.wrap_up_at_tokens": "Token count at which this role is told to wrap up and hand off before max_tokens; at the limit the role writes its hand-off and stops.",
  "caps.mission_token_backstop": "Cumulative raw tokens (input, cached input and output) allowed across one task; when exceeded the role wraps up and continues in a new backstop session, and two firings in a row stop the task with BACKSTOP_CONSECUTIVE_FIRINGS.",

  retries: "How many times each stage may retry or revise before it stops and asks you.",
  "retries.plan_revisions": "Plan-review escalation point, not a revision count. In standalone, 0 escalates at the first plan-review FAIL without a Planner revision and it runs one fewer revision than the number (the number is one higher than the revisions run), so 1 behaves like 0; SpecKit runs at most one revision per gate for any value above 0; GSD planning still treats 0 or an absent value as 8; an absent value uses the built-in default of 8.",
  "retries.implementation": "Implementer fix rounds per phase before the phase stops; 0 stops the phase on the first fix-requiring review with no fix round, at the limit the mission stops and asks you, and an absent value uses the built-in default of 4.",
  "retries.verification": "Verifier FAIL rounds per phase before the phase stops; 0 stops the phase on the first verifier FAIL with no retry, at the limit the mission stops and asks you, and an absent value uses the built-in default of 4.",
  "retries.final_review_fix_rounds": "Final-review fix rounds per mission before it stops; 1 allows one round, and at the limit the mission stops.",
  "retries.cli_errors": "Same-model retries after a CLI error before the run gives up; 0 skips same-model retries and fails over or stops on the first CLI error, at the limit the run fails over or stops, and an absent value uses the built-in default of 3.",
  "retries.infrastructure": "Retries after an infrastructure error such as a snapshot, sandbox or gate failure; 0 stops on the first infrastructure error, at the limit the mission stops, and an absent value uses the built-in default of 3.",
  "retries.no_progress_sessions": "Sessions in a row that change no file before the task stops; 1 stops on the first session that changes nothing.",
  "retries.extra_sessions_per_task": "Extra sessions the implementer may start per task after a cap; 0 starts no extra session and an absent value uses the built-in default of 5. The caps.implementer.extra_sessions value wins when both are set.",
  "retries.escalate_after_not_fixed": "Reviews in a row that must report the same finding not fixed before the stronger escalation model is used; 1 escalates on the first not-fixed report.",

  time_limits: "Wall-clock limits and waits, with the unit in each name.",
  "time_limits.role_timeout_minutes": "Per-role session time limits in minutes, keyed by role name (for example verifier); past a role's limit that role call is stopped.",
  "time_limits.role_timeout_minutes.default": "Time limit in minutes for one implementer task; past the limit the implementer call is stopped.",
  "time_limits.role_timeout_minutes.verifier": "Session time limit for the verifier role, in minutes; past the limit the verifier call is stopped.",
  "time_limits.call_backstop_minutes": "Hard wall-clock backstop for one role call, in minutes (not a mission limit); a call that runs past it is stopped. The old name mission_timeout_minutes is still read and migrated.",
  "time_limits.role_timeout_floor_minutes": "Lowest session limit that measured run times may produce, in minutes; null or 0 uses the built-in 10-minute floor.",
  "time_limits.silent_run_minutes": "Minutes without any output before an active run is treated as hung and stopped; 0 turns this watchdog off.",
  "time_limits.no_first_output_minutes": "Minutes a new session may run without producing any output before it is stopped; 0 turns this check off.",
  "time_limits.read_only_max_silence_minutes": "Maximum minutes a read-only role may stay silent even while a tool runs before it is stopped; 0 turns this cap off.",
  "time_limits.retry_wait_seconds": "Seconds to wait before retrying after a provider or network error; 0 retries immediately.",

  workflow: "Which review and approval stages run, and how work is committed.",
  "workflow.plan_review": "Run the GSD plan-review stage before implementation (true) or skip it (false); only GSD reads this setting. (GSD is not yet reviewed in this version).",
  "workflow.plan_review_rounds_converge": "Make the first plan-review round review the whole plan and later rounds check only the requested fixes (true), or re-review the whole plan every round (false); default true. Applies to standalone and SpecKit planning; GSD uses its own plan-review settings. The legacy name plan_review_convergence is still read and migrated.",
  "workflow.gsd_planning_review": "Use the GSD planning-review stages (true) or skip them (false). (GSD is not yet reviewed in this version).",
  "workflow.spec_review": "Intended to run a spec review stage before planning. Controlled by your SpecKit workflow.yml — add or remove the step there; this setting has no effect.",
  "workflow.code_review_per_phase": "Run a code review after each implementation phase (true), or skip the per-phase review and rely on the end-of-mission review (false); default true. The legacy name implementationReview is still read and migrated.",
  "workflow.final_review": "Run a final review over the whole mission at the end, including its fix rounds (true), or skip it and complete the mission after implementation (false); default true. The legacy name finalReview is still read and migrated.",
  "workflow.analysis_after_tasks": "Intended to run an analysis pass after all tasks complete. Controlled by your SpecKit workflow.yml — add or remove the step there; this setting has no effect.",
  "workflow.approve_spec_myself": "Intended to approve the spec automatically without asking you. Controlled by your SpecKit workflow.yml — add or remove the step there; this setting has no effect.",
  "workflow.pause_for_plan_approval": "Approve the plan automatically without asking you (true) or pause after planning and wait for you to approve it (false); default false. Applies to standalone and SpecKit planning. When paused, a following `ap run` continues as the approval.",
  "workflow.parallel_independent_tasks": "Intended to run independent tasks in parallel. Not used by this version; changing it has no effect.",
  "workflow.use_worktrees": "Intended to run parallel tasks in separate git worktrees. Not used by this version; changing it has no effect.",
  "workflow.commit_by_human": "Stop at \"ready to commit\" and let you commit; false is not supported because Autopilot never commits.",

  tests: "Gate commands, reviewer requirement and verification policy.",
  "tests.gate_commands": "Commands run after each phase and at the end as the gate; a failing command fails the phase, and an empty list runs no gate.",
  "tests.gate_network": "Allow the gate commands to use the network (true); false keeps them network-isolated.",
  "tests.gate_env_allowlist": "Environment variable names allowed through to gate commands; empty passes no extra variables.",
  "tests.require_reviewer": "Intended to require a reviewer verdict before a phase passes. Fixed in this version; changing it has no effect.",
  "tests.browser": "Browser capability used for verification: native (the agent's own browser), playwright or both.",
  "tests.require_browser": "How browser capabilities are required for the verifier: always adds them to every call; when-task-requires and never add them only when the task itself needs a browser.",
  "tests.e2e": "End-to-end test tool for UI projects: playwright, cypress or none. Unset (null) = setup asks once; treated as none until answered.",
  "tests.e2e_setup_pending": "True while an end-to-end tool setup is still pending for the project; unset or false means nothing is pending.",
  "tests.verify_denylist": "Commands or paths that a task or verification step may never run; empty adds no bans beyond the built-in full-suite ban.",

  safety: "What roles may do and which safety checks are enforced.",
  "safety.allow_git_commit": "Setting this true is rejected; Autopilot never commits, so keep it false.",
  "safety.allow_git_push": "Setting this true is rejected; Autopilot never pushes, so keep it false.",
  "safety.allow_destructive_operations": "Setting this true is rejected; destructive operations stay blocked, so keep it false.",
  "safety.stop_on_sandbox_violation": "Setting this false is rejected; a sandbox or relay violation always stops the mission, so keep it true.",
  "safety.block_git_in_roles": "Blocks git commit and push inside role sessions. Always on — cannot be turned off; changing it has no effect.",
  "safety.check_read_only_roles": "Checks that read-only roles changed no file by comparing before and after snapshots. Always on — cannot be turned off; changing it has no effect.",
  "safety.record_touched_files": "Records the files each role touches. Always on — cannot be turned off; changing it has no effect.",
  "safety.keep_role_sessions": "Keeps role sessions on disk so a later run can resume them. Always on — cannot be turned off; changing it has no effect.",

  runtime: "Containment mode and, for WSL2, the distribution to use.",
  "runtime.mode": "How roles are contained: auto, linux-strong, wsl2-strong or windows-compatibility.",
  "runtime.wsl_distro": "WSL2 distribution used for wsl2-strong mode; null detects it automatically.",

  frameworks: "Per-framework planning settings for SpecKit and GSD.",
  "frameworks.speckit": "SpecKit workflow and task-file settings.",
  "frameworks.speckit.workflow_file": "Intended path to the SpecKit workflow definition. Fixed in this version; changing it has no effect. Autopilot always reads .specify/workflows/speckit/workflow.yml.",
  "frameworks.speckit.task_files": "Glob patterns that identify SpecKit task files; empty means no task files are found.",
  "frameworks.gsd": "GSD phase, artifact and parallelism settings. (GSD is not yet reviewed in this version).",
  "frameworks.gsd.phase_root": "Directory holding GSD phase folders. (GSD is not yet reviewed in this version).",
  "frameworks.gsd.run_plan_verify": "Run the gsd-tools plan check (references and state validation) after planning (true) or skip it (false). (GSD is not yet reviewed in this version).",
  "frameworks.gsd.run_state_validate": "Intended to run GSD state validation. Not used by this version; changing it has no effect. (GSD is not yet reviewed in this version).",
  "frameworks.gsd.write_summary_artifacts": "Intended to write GSD summary artifacts. Not used by this version; changing it has no effect. (GSD is not yet reviewed in this version).",
  "frameworks.gsd.write_verification_artifacts": "Intended to write GSD verification artifacts. Not used by this version; changing it has no effect. (GSD is not yet reviewed in this version).",
  "frameworks.gsd.write_uat_artifact": "Intended to write the GSD UAT artifact. Not used by this version; changing it has no effect. (GSD is not yet reviewed in this version).",
  "frameworks.gsd.use_gsd_tools_when_available": "Use GSD helper tools when they are available (true) or skip them (false). (GSD is not yet reviewed in this version).",
  "frameworks.gsd.planning_review": "GSD planning-review stage settings. (GSD is not yet reviewed in this version).",
  "frameworks.gsd.planning_review.enabled": "Enable the GSD planning-review stages (true) or skip them (false). (GSD is not yet reviewed in this version).",
  "frameworks.gsd.planning_review.review_after_each_stage": "Intended to review after every GSD planning stage. Not used by this version; changing it has no effect. (GSD is not yet reviewed in this version).",
  "frameworks.gsd.planning_review.stages": "GSD planning stages to review: discuss, research and plan. (GSD is not yet reviewed in this version).",
  "frameworks.gsd.planning_review.max_revisions": "Revisions allowed per GSD planning stage; at the limit the stage fails and the mission stops. (GSD is not yet reviewed in this version).",
  "frameworks.gsd.planning_review.read_only_reviewer": "Intended to use a read-only reviewer for GSD planning review. Not used by this version; changing it has no effect. (GSD is not yet reviewed in this version).",
  "frameworks.gsd.parallel": "Parallel GSD execution settings. (GSD is not yet reviewed in this version).",
  "frameworks.gsd.parallel.enabled": "Allow GSD work to run in parallel (true) or one at a time (false). (GSD is not yet reviewed in this version).",
  "frameworks.gsd.parallel.plan_level": "Allow different GSD plans to run in parallel (true) or one plan at a time (false). (GSD is not yet reviewed in this version).",
  "frameworks.gsd.parallel.task_level": "Tasks inside one GSD plan always run one at a time; this setting has no effect. (GSD is not yet reviewed in this version).",
  "frameworks.gsd.parallel.max_concurrent_agents": "Most GSD agents that may run at once; at the limit new work waits for a free slot. (GSD is not yet reviewed in this version).",
  "frameworks.gsd.parallel.min_plans_for_parallel": "Smallest number of plans that starts GSD parallel execution; below it plans run one at a time. (GSD is not yet reviewed in this version).",

  advanced: "Paths, hand-off limits and capability defaults.",
  "advanced.state_file": "Intended path to the mission state file. Fixed in this version; changing it has no effect.",
  "advanced.runs_dir": "Intended directory holding run records. Fixed in this version; changing it has no effect.",
  "advanced.handoff_max_chars": "Maximum characters in a role hand-off document; longer text is cut, and values below 500 are rejected.",
  "advanced.handoff_note_max_chars": "Maximum characters in a hand-off note; longer text is cut, and values below 1000 are rejected.",
  "advanced.handoff_wrapup_tokens": "Token count at which a role is told to wrap up its hand-off; it must be below the implementer token cap.",
  "advanced.fallback_retry_primary_minutes": "Minutes to wait before retrying the primary model after a fallback took over; 0 uses the built-in 60-minute wait.",
  "advanced.checkpoint_after_task": "Intended to write a checkpoint after each task. Fixed in this version; changing it has no effect.",
  "advanced.checkpoint_after_phase": "Intended to write a checkpoint after each phase. Fixed in this version; changing it has no effect.",
  "advanced.capabilities": "Project-level capability defaults and denials.",
  "advanced.capabilities.project_defaults": "Capabilities assumed present for every role in this project; empty adds none.",
  "advanced.capabilities.role_requirements": "Extra capabilities required per role, keyed by role name; empty adds none.",
  "advanced.capabilities.safety_denied": "Intended to deny capabilities for safety. Fixed in this version; changing it has no effect.",
  "advanced.capabilities.legacy_text_inference": "Infer browser capabilities from task text for the verifier (legacy); false keeps inference off.",
};

const AGENTS_PATH = join(HERE, "..", "adapters", "agents.json");
const DOCUMENTED_EFFORT_DIR = join(HERE, "..", "adapters", "documented-effort");
const REASONING_LEVEL_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

// Effort levels the documentation treats as always valid even when a given
// adapter catalog does not list them (the shipped catalog omits `none` and
// `minimal`, but PLAN.md documents them as part of the enum).
export const BASE_REASONING_LEVELS = ["none", "minimal"];

export const CLI_VALUES = ["", ...Object.keys(JSON.parse(readFileSync(AGENTS_PATH, "utf8")).adapters)];

export function documentedReasoningLevels() {
  const levels = new Set(BASE_REASONING_LEVELS);
  for (const file of readdirSync(DOCUMENTED_EFFORT_DIR)) {
    if (!file.endsWith(".json")) continue;
    const documented = JSON.parse(readFileSync(join(DOCUMENTED_EFFORT_DIR, file), "utf8"));
    for (const level of documented.levels || []) {
      if (typeof level === "string" && level) levels.add(level);
    }
  }
  const rank = (level) => {
    const index = REASONING_LEVEL_ORDER.indexOf(level);
    return index === -1 ? REASONING_LEVEL_ORDER.length : index;
  };
  return [...levels].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export const REASONING_VALUES = ["", ...documentedReasoningLevels()];

// Allowed values for enumerated keys, keyed by dotted path ("*" stands for
// any role name and "[]" for a fallback entry). Exported so
// config-validation.mjs checks exactly the values the shipped schema
// advertises (no drift).
export const ENUMS = {
  "project.planning_framework": ["auto", "standalone", "speckit", "gsd"],
  "runtime.mode": ["auto", "linux-strong", "wsl2-strong", "windows-compatibility"],
  "tests.browser": ["native", "playwright", "both"],
  "tests.require_browser": ["always", "when-task-requires", "never"],
  "tests.e2e": ["playwright", "cypress", "none"],
  "roles.*.cli": CLI_VALUES,
  "roles.*.reasoning": REASONING_VALUES,
  "roles.*.fallbacks[].cli": CLI_VALUES,
  "roles.*.fallbacks[].reasoning": REASONING_VALUES,
  "roles.*.escalation_model.cli": CLI_VALUES,
  "roles.*.escalation_model.reasoning": REASONING_VALUES,
};

// `default` is null for these keys, so the type cannot be inferred from it.
// Numeric lower bounds documented in the shipped schema and enforced by
// config-validation.mjs.
export const MINIMUMS = {
  "roles.free_models.max_turns": 0,
  "caps.task_size_target_turns": 1,
  "caps.*.max_turns": 1,
  "caps.*.max_tokens": 1,
  "caps.*.extra_sessions": 0,
  "caps.*.wrap_up_at_tokens": 1,
  "caps.mission_token_backstop": 1,
  "retries.plan_revisions": 0,
  "retries.implementation": 0,
  "retries.verification": 0,
  "retries.final_review_fix_rounds": 1,
  "retries.cli_errors": 0,
  "retries.infrastructure": 0,
  "retries.no_progress_sessions": 1,
  "retries.extra_sessions_per_task": 0,
  "retries.escalate_after_not_fixed": 1,
  "time_limits.role_timeout_minutes": 0,
  "time_limits.role_timeout_minutes.default": 0,
  "time_limits.role_timeout_minutes.verifier": 0,
  "time_limits.call_backstop_minutes": 0,
  "time_limits.role_timeout_floor_minutes": 0,
  "time_limits.silent_run_minutes": 0,
  "time_limits.no_first_output_minutes": 0,
  "time_limits.read_only_max_silence_minutes": 0,
  "time_limits.retry_wait_seconds": 0,
  "frameworks.gsd.planning_review.max_revisions": 0,
  "frameworks.gsd.parallel.max_concurrent_agents": 1,
  "frameworks.gsd.parallel.min_plans_for_parallel": 1,
  "advanced.handoff_max_chars": HANDOFF_MIN_CHARS,
  "advanced.handoff_note_max_chars": HANDOFF_NOTE_MIN_CHARS,
  "advanced.handoff_wrapup_tokens": 1,
  "advanced.fallback_retry_primary_minutes": 0,
};

const NULLABLE_TYPES = {
  "time_limits.role_timeout_minutes.default": ["number", "null"],
  "time_limits.role_timeout_minutes.verifier": ["number", "null"],
  "time_limits.call_backstop_minutes": ["number", "null"],
  "time_limits.role_timeout_floor_minutes": ["number", "null"],
  "time_limits.silent_run_minutes": ["number", "null"],
  "time_limits.no_first_output_minutes": ["number", "null"],
  "time_limits.read_only_max_silence_minutes": ["number", "null"],
  "time_limits.retry_wait_seconds": ["number", "null"],
  "runtime.wsl_distro": ["string", "null"],
};

// Schema-only optional role setting: no default exists in DEFAULTS, so fill,
// setup and the example never write a null escalation_model that runtime
// validation would reject. Only the planner and implementer may escalate.
const ESCALATION_MODEL_ROLES = ["planner", "implementer"];

// Every object is closed to unknown keys, but keys prefixed with "_" are an
// escape hatch for operator metadata/comments and must stay accepted.
const METADATA_PATTERN = "^_";
const ROLE_NAMES = ["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"];
const ROLE_REQUIREMENTS_PATH = "advanced.capabilities.role_requirements";
const ROLE_REQUIREMENTS_PATTERN = `^(${ROLE_NAMES.join("|")})$`;

function escalationModelSchema() {
  return {
    type: ["object", "null"],
    description: descriptionFor("roles.*.escalation_model"),
    additionalProperties: false,
    patternProperties: {[METADATA_PATTERN]: {}},
    properties: {
      cli: {type: "string", enum: CLI_VALUES, description: descriptionFor("roles.*.escalation_model.cli")},
      model: {type: "string", description: descriptionFor("roles.*.escalation_model.model")},
      reasoning: {type: "string", enum: REASONING_VALUES, description: descriptionFor("roles.*.escalation_model.reasoning")},
      variant: {type: "string", description: descriptionFor("roles.*.escalation_model.variant")},
    },
  };
}

const FALLBACK_ENTRY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  patternProperties: {[METADATA_PATTERN]: {}},
  properties: {
    cli: {type: "string", enum: CLI_VALUES, description: "CLI adapter for this fallback entry."},
    model: {type: "string", description: "Model id for this fallback entry."},
    reasoning: {type: "string", enum: REASONING_VALUES, description: "Reasoning effort for this fallback entry; empty uses the role's value."},
    variant: {type: "string", description: "Model variant for this fallback entry; empty uses the role's value."},
  },
};

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function descriptionFor(path) {
  if (Object.prototype.hasOwnProperty.call(DESCRIPTIONS, path)) return DESCRIPTIONS[path];
  const generic = path.replace(/\.(planner|plan_reviewer|implementer|code_reviewer|verifier)(\.|$)/, ".*$2");
  const description = DESCRIPTIONS[generic] || DESCRIPTIONS[`${path.split(".").slice(0, -1).join(".")}.*`];
  if (description) return description;
  throw new Error(`Missing config schema description for '${path}'`);
}

function enumFor(path) {
  if (ENUMS[path]) return ENUMS[path];
  const wildcard = path
    .split(".")
    .map((part) => (ROLE_NAMES.includes(part) ? "*" : part))
    .join(".");
  return ENUMS[wildcard];
}

export function minimumFor(path) {
  if (MINIMUMS[path] !== undefined) return MINIMUMS[path];
  const wildcard = path
    .split(".")
    .map((part) => (ROLE_NAMES.includes(part) ? "*" : part))
    .join(".");
  return MINIMUMS[wildcard];
}

function itemsFor(path) {
  if (path.endsWith(".fallbacks")) return FALLBACK_ENTRY_SCHEMA;
  return {type: "string"};
}

function buildSchema(value, path) {
  const description = descriptionFor(path);

  if (Array.isArray(value)) {
    return {
      type: "array",
      description,
      default: value,
      items: value.length && isPlainObject(value[0]) ? buildSchema(value[0], `${path}[]`) : itemsFor(path),
    };
  }

  if (isPlainObject(value)) {
    const properties = {};
    for (const [key, entry] of Object.entries(value)) {
      properties[key] = buildSchema(entry, path ? `${path}.${key}` : key);
    }
    const schema = {
      type: "object",
      description,
      default: value,
      properties,
      additionalProperties: false,
      patternProperties: {[METADATA_PATTERN]: {}},
    };
    if (path === ROLE_REQUIREMENTS_PATH) {
      schema.patternProperties[ROLE_REQUIREMENTS_PATTERN] = {type: "array", items: {type: "string"}};
    }
    if (path === "time_limits.role_timeout_minutes") {
      schema.type = ["object", "number", "null"];
      schema.minimum = minimumFor(path);
    }
    return schema;
  }

  const schema = {
    type: NULLABLE_TYPES[path] || (value === null ? ["string", "null"] : typeof value),
    description,
    default: value,
  };
  const values = enumFor(path);
  if (values) schema.enum = values;
  const minimum = minimumFor(path);
  if (minimum !== undefined) schema.minimum = minimum;
  return schema;
}

export function buildConfigSchema() {
  const properties = {
    $schema: {
      type: "string",
      description: DESCRIPTIONS.$schema,
      default: SCHEMA_ID,
    },
    schema_version: {
      type: "string",
      description: DESCRIPTIONS.schema_version,
      const: CONFIG_SCHEMA_VERSION,
      default: CONFIG_SCHEMA_VERSION,
    },
  };
  for (const [key, value] of Object.entries(DEFAULTS)) {
    properties[key] = buildSchema(value, key);
  }
  for (const role of ESCALATION_MODEL_ROLES) {
    properties.roles.properties[role].properties.escalation_model = escalationModelSchema();
  }
  // Schema-only keys: not in DEFAULTS, so they stay out of config.example.json.
  // Unset (null) means never asked; setup/config asks the operator once.
  properties.tests.properties.e2e = {type: ["string", "null"], description: descriptionFor("tests.e2e"), default: null, enum: [...enumFor("tests.e2e"), null]};
  properties.tests.properties.e2e_setup_pending = {type: "boolean", description: descriptionFor("tests.e2e_setup_pending"), default: false};
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://project-autopilot.dev/config.schema.json",
    title: "project-autopilot config",
    description: "The v4 `.autopilot/config.json` layout: settings grouped by what you decide, with units in the names.",
    type: "object",
    additionalProperties: false,
    patternProperties: {[METADATA_PATTERN]: {}},
    properties,
    required: ["schema_version"],
  };
}

export function serializeSchema(schema = buildConfigSchema()) {
  return `${JSON.stringify(schema, null, 2)}\n`;
}

function main() {
  writeFileSync(SCHEMA_PATH, serializeSchema());
  console.log(`wrote ${SCHEMA_PATH}`);
  const document = readFileSync(CONFIG_REFERENCE_PATH, "utf8");
  writeFileSync(CONFIG_REFERENCE_PATH, withConfigReference(document));
  console.log(`wrote configuration reference in ${CONFIG_REFERENCE_PATH}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
