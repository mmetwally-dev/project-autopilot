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
// Run: node scripts/gen-config-schema.mjs   (rewrites ./config.schema.json)

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULTS, CONFIG_SCHEMA_VERSION } from "./config-layout.mjs";
import { HANDOFF_MIN_CHARS, HANDOFF_NOTE_MIN_CHARS } from "./per-task-budget.mjs";
import { renderConfigReference } from "./config-reference.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = join(HERE, "..", "config.schema.json");
export const SCHEMA_ID = "./config.schema.json";
export const README_PATH = join(HERE, "..", "README.md");
export const CONFIG_REFERENCE_START = "<!-- config-reference:start -->";
export const CONFIG_REFERENCE_END = "<!-- config-reference:end -->";

// The README block between the markers is generated; everything outside them
// is hand-written and must survive every regeneration untouched.
export function extractConfigReference(readme) {
  const start = readme.indexOf(CONFIG_REFERENCE_START);
  const end = readme.indexOf(CONFIG_REFERENCE_END);
  if (start === -1 || end === -1 || end < start) return null;
  const body = readme.slice(start + CONFIG_REFERENCE_START.length, end);
  return body.replace(/^\r?\n/, "");
}

export function withConfigReference(readme, reference = renderConfigReference()) {
  const block = `${CONFIG_REFERENCE_START}\n${reference}${CONFIG_REFERENCE_END}`;
  const start = readme.indexOf(CONFIG_REFERENCE_START);
  const end = readme.indexOf(CONFIG_REFERENCE_END);
  if (start !== -1 && end > start) {
    return readme.slice(0, start) + block + readme.slice(end + CONFIG_REFERENCE_END.length);
  }
  const separator = readme.endsWith("\n") ? "\n" : "\n\n";
  return `${readme}${separator}${block}\n`;
}

// One-line description per key, by dotted path (a "*" stands for any role
// name). Every property must have one; the test enforces that.
const DESCRIPTIONS = {
  $schema: "Relative path to this schema file.",
  schema_version: "On-disk config format version; always 4.0 for this layout.",

  project: "Project identity and which planning framework drives it.",
  "project.repo": "Repository root the mission runs in.",
  "project.planning_framework": "Which planning framework to drive (auto, standalone, speckit or gsd).",

  roles: "The agent CLI, model and session settings for each role.",
  "roles.planner": "Role settings for the planner.",
  "roles.plan_reviewer": "Role settings for the plan reviewer.",
  "roles.implementer": "Role settings for the implementer.",
  "roles.code_reviewer": "Role settings for the code reviewer.",
  "roles.verifier": "Role settings for the verifier.",
  "roles.*.cli": "Agent CLI adapter for this role (claude, opencode, codex, ...).",
  "roles.*.model": "Model id for this role; empty means the adapter default.",
  "roles.*.reasoning": "Reasoning effort for this role; empty means the adapter default.",
  "roles.*.variant": "Adapter-specific model variant; empty means none.",
  "roles.*.resume_session": "Resume the previous session for this role instead of starting fresh. Defaults to false for the implementer: a capped implementer continues in a fresh session with the hand-off note (the wrap-up turn still resumes); every other role defaults to true.",
  "roles.*.fallbacks": "Ordered fallback role entries tried when the primary adapter/model fails.",
  "roles.*.escalation_model": "Stronger model used for the next fix round after retries.escalate_after_not_fixed not-fixed reports; null or absent turns escalation off.",
  "roles.*.escalation_model.cli": "Agent CLI adapter for the escalation model; empty means the role's adapter.",
  "roles.*.escalation_model.model": "Model id for the escalation model; empty means the role's model.",
  "roles.*.escalation_model.reasoning": "Reasoning effort for the escalation model; empty means the role's effort.",
  "roles.*.escalation_model.variant": "Adapter-specific model variant for the escalation model; empty means none.",
  "roles.free_models": "The free-model fallback pool.",
  "roles.free_models.auto_fallback": "Automatically fall back to a free model when the primary is unavailable.",
  "roles.free_models.max_turns": "Maximum turns allowed on a free-model fallback before giving up.",

  caps: "Per-role turn, token and session caps plus the mission token backstop.",
  "caps.planner": "Caps for the planner role.",
  "caps.plan_reviewer": "Caps for the plan reviewer role.",
  "caps.implementer": "Caps for the implementer role.",
  "caps.code_reviewer": "Caps for the code reviewer role.",
  "caps.verifier": "Caps for the verifier role.",
  "caps.task_size_target_turns": "Target turns per task used when splitting oversized work.",
  "caps.*.max_turns": "Maximum model turns for this role in one session; at the limit the role stops and hands off, and extra_sessions decides whether it may continue.",
  "caps.*.max_tokens": "Maximum tokens for this role in one session; at the limit the role stops and hands off, and extra_sessions decides whether it may continue.",
  "caps.*.extra_sessions": "Extra sessions this role may start after hitting its turn or token cap; at the limit no further session is started and the mission stops or reports the cap.",
  "caps.*.wrap_up_at_tokens": "Token count at which this role is told to wrap up and hand off before reaching max_tokens; at the limit the role writes its hand-off and stops.",
  "caps.mission_token_backstop": "Raw-token backstop for a whole mission before it is stopped.",

  retries: "Retry and revision budgets for each stage.",
  "retries.plan_revisions": "Maximum plan revision rounds before plan review gives up.",
  "retries.implementation": "Failure budget for the implementation phase.",
  "retries.verification": "Failure budget for the verification phase.",
  "retries.final_review_fix_rounds": "Maximum final-review fix rounds before stopping.",
  "retries.cli_errors": "Adapter retry budget for transient CLI errors.",
  "retries.infrastructure": "Retry budget for infrastructure failures.",
  "retries.no_progress_sessions": "Consecutive no-progress generations before a mission is stopped.",
  "retries.extra_sessions_per_task": "Continuation sessions allowed per task (mirrors caps.implementer.extra_sessions).",
  "retries.escalate_after_not_fixed": "Consecutive reviews that must report the same finding not fixed before the escalation model is used (1 = escalate on the first not-fixed report).",

  time_limits: "Wall-clock limits and waits, with the unit in each name.",
  "time_limits.role_timeout_minutes": "Per-role session timeout overrides, in minutes.",
  "time_limits.role_timeout_minutes.default": "Default wall-clock limit per role session, in minutes.",
  "time_limits.role_timeout_minutes.verifier": "Wall-clock limit for the verifier role session, in minutes.",
  "time_limits.call_backstop_minutes": "Hard wall-clock backstop for ONE role call, in minutes (not a mission limit): a call that runs past it is stopped. The old name mission_timeout_minutes is still read and migrated.",
  "time_limits.role_timeout_floor_minutes": "Minimum per-role timeout floor in minutes; null disables the floor.",
  "time_limits.silent_run_minutes": "Minutes of silence before an active run is treated as hung.",
  "time_limits.no_first_output_minutes": "Minutes allowed before a session must produce its first output.",
  "time_limits.read_only_max_silence_minutes": "Maximum silence for read-only roles, in minutes.",
  "time_limits.retry_wait_seconds": "Seconds to wait between retries.",

  workflow: "Which review and approval stages run, and how work is committed.",
  "workflow.plan_review": "Run a plan review stage before implementation.",
  "workflow.plan_review_rounds_converge": "Iterate plan review rounds until the plan converges.",
  "workflow.gsd_planning_review": "Use the GSD planning-review stages.",
  "workflow.spec_review": "Run a spec review stage.",
  "workflow.code_review_per_phase": "Run code review after each implementation phase.",
  "workflow.final_review": "Run a final review at the end of the mission.",
  "workflow.analysis_after_tasks": "Run an analysis pass after all tasks complete.",
  "workflow.approve_spec_myself": "Auto-approve the spec without asking the operator.",
  "workflow.approve_plan_myself": "Auto-approve the plan without asking the operator.",
  "workflow.parallel_independent_tasks": "Run independent tasks in parallel.",
  "workflow.use_worktrees": "Use git worktrees to isolate parallel work.",
  "workflow.commit_by_human": "Only a human may commit; roles never run git commit.",

  tests: "Gate commands, reviewer requirement and verification policy.",
  "tests.gate_commands": "Commands run as the phase/mission gate.",
  "tests.gate_network": "Allow the gate commands to use the network (false keeps them network-isolated).",
  "tests.gate_env_allowlist": "Environment variables allowed through to gate commands.",
  "tests.require_reviewer": "Require a reviewer role to sign off before completion.",
  "tests.browser": "Browser capability mode used for verification (native, playwright or both).",
  "tests.require_browser": "When browser verification is required (always, when-task-requires or never).",
  "tests.verify_denylist": "Commands or paths never allowed in verification.",

  safety: "What roles may do and which safety checks are enforced.",
  "safety.allow_git_commit": "Permit roles to run git commit.",
  "safety.allow_git_push": "Permit roles to run git push.",
  "safety.allow_destructive_operations": "Permit destructive filesystem or git operations.",
  "safety.stop_on_sandbox_violation": "Stop the mission when a sandbox/relay violation is detected.",
  "safety.block_git_in_roles": "Block git commit/push inside role sessions.",
  "safety.check_read_only_roles": "Verify read-only roles by comparing snapshots.",
  "safety.record_touched_files": "Capture the files each role touches.",
  "safety.keep_role_sessions": "Persist role sessions so they can be resumed.",

  runtime: "Containment mode and, for WSL2, the distribution to use.",
  "runtime.mode": "Runtime containment mode (auto, linux-strong, wsl2-strong or windows-compatibility).",
  "runtime.wsl_distro": "WSL2 distribution to use for wsl2-strong mode; null means auto-detect.",

  frameworks: "Per-framework planning settings for SpecKit and GSD.",
  "frameworks.speckit": "SpecKit workflow and task-file settings.",
  "frameworks.speckit.workflow_file": "Path to the SpecKit workflow definition.",
  "frameworks.speckit.task_files": "Glob patterns that identify SpecKit task files.",
  "frameworks.gsd": "GSD phase, artifact and parallelism settings.",
  "frameworks.gsd.phase_root": "Root directory holding GSD phase folders.",
  "frameworks.gsd.run_plan_verify": "Run GSD plan verification.",
  "frameworks.gsd.run_state_validate": "Run GSD state validation.",
  "frameworks.gsd.write_summary_artifacts": "Write GSD summary artifacts.",
  "frameworks.gsd.write_verification_artifacts": "Write GSD verification artifacts.",
  "frameworks.gsd.write_uat_artifact": "Write the GSD UAT artifact.",
  "frameworks.gsd.use_gsd_tools_when_available": "Use GSD helper tools when they are available.",
  "frameworks.gsd.planning_review": "GSD planning-review stage settings.",
  "frameworks.gsd.planning_review.enabled": "Enable the GSD planning-review stages.",
  "frameworks.gsd.planning_review.review_after_each_stage": "Review after every GSD planning stage.",
  "frameworks.gsd.planning_review.stages": "GSD planning stages to review.",
  "frameworks.gsd.planning_review.max_revisions": "Maximum GSD planning-review revisions.",
  "frameworks.gsd.planning_review.read_only_reviewer": "Use a read-only reviewer for GSD planning review.",
  "frameworks.gsd.parallel": "Parallel GSD execution settings.",
  "frameworks.gsd.parallel.enabled": "Enable parallel GSD execution.",
  "frameworks.gsd.parallel.plan_level": "Allow plan-level GSD parallelism.",
  "frameworks.gsd.parallel.task_level": "Allow task-level GSD parallelism.",
  "frameworks.gsd.parallel.max_concurrent_agents": "Maximum concurrent GSD agents.",
  "frameworks.gsd.parallel.min_plans_for_parallel": "Minimum plans before parallel GSD execution starts.",

  advanced: "Paths, hand-off limits and capability defaults.",
  "advanced.state_file": "Path to the mission state file.",
  "advanced.runs_dir": "Directory holding run records.",
  "advanced.handoff_max_chars": "Maximum characters in a role hand-off document.",
  "advanced.handoff_note_max_chars": "Maximum characters in a hand-off note.",
  "advanced.handoff_wrapup_tokens": "Token count at which a role is told to wrap up its hand-off.",
  "advanced.fallback_retry_primary_minutes": "Minutes to wait before retrying the primary model after a fallback took over.",
  "advanced.checkpoint_after_task": "Write a checkpoint after each task.",
  "advanced.checkpoint_after_phase": "Write a checkpoint after each phase.",
  "advanced.capabilities": "Project-level capability defaults and denials.",
  "advanced.capabilities.project_defaults": "Capabilities assumed present for this project.",
  "advanced.capabilities.role_requirements": "Per-role capability requirements.",
  "advanced.capabilities.safety_denied": "Capabilities explicitly denied for safety.",
  "advanced.capabilities.legacy_text_inference": "Infer capabilities from task text (legacy behaviour).",
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
    cli: {type: "string", enum: CLI_VALUES, description: "Fallback adapter CLI."},
    model: {type: "string", description: "Fallback model id."},
    reasoning: {type: "string", enum: REASONING_VALUES, description: "Fallback reasoning effort."},
    variant: {type: "string", description: "Fallback model variant."},
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
  const readme = readFileSync(README_PATH, "utf8");
  writeFileSync(README_PATH, withConfigReference(readme));
  console.log(`wrote configuration reference in ${README_PATH}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
