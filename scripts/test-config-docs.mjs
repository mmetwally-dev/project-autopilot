#!/usr/bin/env node
// Phase 4 task 4.4: verify docs and example reference the v4 config layout.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) { throw new Error(message); }
function assert(condition, message) { if (!condition) fail(message); }
function includes(haystack, needle, label) { if (!haystack.includes(needle)) fail(`${label}: missing "${needle}"`); }

const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const skill = readFileSync(join(ROOT, "SKILL.md"), "utf8");
const exampleRaw = readFileSync(join(ROOT, "config.example.json"), "utf8");

// ---------------------------------------------------------------------------
// README.md must reference the v4 sections by name
// ---------------------------------------------------------------------------
const v4Sections = [
  "project",
  "roles",
  "caps",
  "retries",
  "time_limits",
  "workflow",
  "tests",
  "safety",
  "runtime",
  "frameworks",
  "advanced"
];
for (const section of v4Sections) {
  includes(readme, section, `README.md mentions section '${section}'`);
}
includes(readme, "schema_version", "README.md mentions schema_version");
includes(readme, "4.0", "README.md mentions schema version 4.0");

// ---------------------------------------------------------------------------
// SKILL.md must reference the v4 sections by name
// ---------------------------------------------------------------------------
for (const section of v4Sections) {
  includes(skill, section, `SKILL.md mentions section '${section}'`);
}
includes(skill, "schema 4.0", "SKILL.md mentions schema 4.0");
includes(skill, "schema_version", "SKILL.md mentions schema_version");

// ---------------------------------------------------------------------------
// Both docs must document `ap config fill` and the resolved $schema
// ---------------------------------------------------------------------------
includes(readme, "config fill [--dry-run]", "README.md documents 'config fill [--dry-run]'");
includes(readme, "config.schema.json", "README.md names config.schema.json");
includes(skill, "config fill [--dry-run]", "SKILL.md documents 'config fill [--dry-run]'");
includes(skill, "config.schema.json", "SKILL.md names config.schema.json");

// ---------------------------------------------------------------------------
// config.example.json must parse as schema_version 4.0 with all v4 sections
// ---------------------------------------------------------------------------
let example;
try {
  example = JSON.parse(exampleRaw);
} catch (err) {
  fail(`config.example.json is not valid JSON: ${err.message}`);
}
assert(example.schema_version === "4.0", `config.example.json schema_version is "4.0", got ${JSON.stringify(example.schema_version)}`);
assert(example.$schema === "./config.schema.json", `config.example.json $schema is "./config.schema.json"`);
for (const section of v4Sections) {
  assert(section in example, `config.example.json has section '${section}'`);
}

// roles sub-keys
const roles = example.roles;
assert(roles && typeof roles === "object", "config.example.json has roles object");
for (const role of ["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"]) {
  assert(role in roles, `config.example.json roles has '${role}'`);
  const r = roles[role];
  for (const key of ["cli", "model", "reasoning", "variant", "resume_session", "fallbacks"]) {
    assert(key in r, `config.example.json roles.${role} has '${key}'`);
  }
}
assert("free_models" in roles, "config.example.json roles has free_models");
assert("auto_fallback" in roles.free_models, "config.example.json roles.free_models has auto_fallback");
assert("max_turns" in roles.free_models, "config.example.json roles.free_models has max_turns");

// caps sub-keys
const caps = example.caps;
assert(caps && typeof caps === "object", "config.example.json has caps object");
assert("task_size_target_turns" in caps, "config.example.json caps has task_size_target_turns");
assert("mission_token_backstop" in caps, "config.example.json caps has mission_token_backstop");
for (const role of ["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"]) {
  assert(role in caps, `config.example.json caps has '${role}'`);
  for (const key of ["max_turns", "max_tokens", "extra_sessions", "wrap_up_at_tokens"]) {
    assert(key in caps[role], `config.example.json caps.${role} has '${key}'`);
  }
}

// retries sub-keys
const retries = example.retries;
assert(retries && typeof retries === "object", "config.example.json has retries object");
for (const key of ["plan_revisions", "implementation", "verification", "final_review_fix_rounds", "cli_errors", "infrastructure", "no_progress_sessions", "extra_sessions_per_task"]) {
  assert(key in retries, `config.example.json retries has '${key}'`);
}

// time_limits sub-keys
const timeLimits = example.time_limits;
assert(timeLimits && typeof timeLimits === "object", "config.example.json has time_limits object");
for (const key of ["role_timeout_minutes", "call_backstop_minutes", "role_timeout_floor_minutes", "silent_run_minutes", "no_first_output_minutes", "read_only_max_silence_minutes", "retry_wait_seconds"]) {
  assert(key in timeLimits, `config.example.json time_limits has '${key}'`);
}
assert("default" in timeLimits.role_timeout_minutes, "config.example.json time_limits.role_timeout_minutes has default");
assert("verifier" in timeLimits.role_timeout_minutes, "config.example.json time_limits.role_timeout_minutes has verifier");

// workflow, tests, safety, runtime, frameworks, advanced
for (const section of ["workflow", "tests", "safety", "runtime", "frameworks", "advanced"]) {
  assert(section in example && typeof example[section] === "object", `config.example.json has '${section}' object`);
}

// frameworks sub-sections
assert("speckit" in example.frameworks, "config.example.json frameworks has speckit");
assert("gsd" in example.frameworks, "config.example.json frameworks has gsd");

// advanced sub-keys
const advanced = example.advanced;
assert("state_file" in advanced, "config.example.json advanced has state_file");
assert("runs_dir" in advanced, "config.example.json advanced has runs_dir");
assert("handoff_max_chars" in advanced, "config.example.json advanced has handoff_max_chars");
assert("handoff_note_max_chars" in advanced, "config.example.json advanced has handoff_note_max_chars");
assert("handoff_wrapup_tokens" in advanced, "config.example.json advanced has handoff_wrapup_tokens");
assert("fallback_retry_primary_minutes" in advanced, "config.example.json advanced has fallback_retry_primary_minutes");
assert("checkpoint_after_task" in advanced, "config.example.json advanced has checkpoint_after_task");
assert("checkpoint_after_phase" in advanced, "config.example.json advanced has checkpoint_after_phase");
assert("capabilities" in advanced, "config.example.json advanced has capabilities");

console.log("config docs tests passed (README/SKILL name v4 sections; config.example.json is v4 layout)");