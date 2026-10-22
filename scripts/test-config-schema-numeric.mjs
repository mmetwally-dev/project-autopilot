#!/usr/bin/env node
// Mission 097 Phase 1 task 1.6: the generated schema must carry the same
// numeric lower bounds as config-validation.mjs, and the nullable time-limit
// leaves (plus the object|number|null role_timeout_minutes) must be accepted.
import assert from "node:assert/strict";
import { MINIMUMS, buildConfigSchema, minimumFor } from "./gen-config-schema.mjs";
import { validateNewConfig } from "./config-validation.mjs";

const ROLE_NAMES = ["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"];
const TIME_LIMIT_LEAVES = [
  "call_backstop_minutes",
  "role_timeout_floor_minutes",
  "silent_run_minutes",
  "no_first_output_minutes",
  "read_only_max_silence_minutes",
  "retry_wait_seconds",
];

const expectedMinimums = {
  "roles.free_models.max_turns": 0,
  "caps.task_size_target_turns": 1,
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
  "advanced.handoff_max_chars": 500,
  "advanced.handoff_note_max_chars": 1000,
  "advanced.handoff_wrapup_tokens": 1,
  "advanced.fallback_retry_primary_minutes": 0,
};
const CAP_MINIMUMS = {max_turns: 1, max_tokens: 1, extra_sessions: 0, wrap_up_at_tokens: 1};
for (const role of ROLE_NAMES) {
  for (const [key, minimum] of Object.entries(CAP_MINIMUMS)) {
    expectedMinimums[`caps.${role}.${key}`] = minimum;
  }
}

function nodeAt(schema, path) {
  let node = schema;
  for (const key of path.split(".")) {
    if (!node || !node.properties || !node.properties[key]) {
      throw new Error(`missing schema property ${path}`);
    }
    node = node.properties[key];
  }
  return node;
}

function isNumeric(node) {
  const type = node?.type;
  if (Array.isArray(type)) return type.includes("number") || type.includes("integer");
  return type === "number" || type === "integer";
}

const schema = buildConfigSchema();
const actual = new Map();
(function walk(node, path) {
  if (!node || typeof node !== "object") return;
  if (node.properties) {
    for (const [key, entry] of Object.entries(node.properties)) {
      walk(entry, path ? `${path}.${key}` : key);
    }
  }
  if (isNumeric(node)) actual.set(path, node.minimum);
})(schema, "");

assert.deepEqual(
  [...actual.keys()].sort(),
  Object.keys(expectedMinimums).sort(),
  "schema numeric leaves are exactly the settings validation knows",
);
for (const [path, minimum] of Object.entries(expectedMinimums)) {
  assert.equal(actual.get(path), minimum, `${path} minimum matches validation`);
  assert.equal(minimumFor(path), minimum, `${path} minimumFor() lookup`);
}

const roleTimeout = nodeAt(schema, "time_limits.role_timeout_minutes");
assert.deepEqual([...roleTimeout.type].sort(), ["null", "number", "object"], "role_timeout_minutes accepts object, number or null");
assert.equal(roleTimeout.minimum, 0, "numeric role_timeout_minutes has the validation minimum");

const nullableTimeLimits = [
  "time_limits.role_timeout_minutes.default",
  "time_limits.role_timeout_minutes.verifier",
  ...TIME_LIMIT_LEAVES.map((key) => `time_limits.${key}`),
];
for (const path of nullableTimeLimits) {
  const node = nodeAt(schema, path);
  assert.deepEqual(node.type, ["number", "null"], `${path} is number|null`);
  assert.equal(node.minimum, 0, `${path} keeps the validation minimum`);
}

function assertValid(config, label) {
  const { valid, errors } = validateNewConfig({ schema_version: "4.0", ...config });
  assert.ok(valid, `${label} must validate: ${errors.join("; ")}`);
}

for (const key of TIME_LIMIT_LEAVES) {
  assertValid({ time_limits: { [key]: null } }, `time_limits.${key} = null`);
}
assertValid({ time_limits: { role_timeout_minutes: null } }, "role_timeout_minutes = null");
assertValid({ time_limits: { role_timeout_minutes: 45 } }, "role_timeout_minutes = number");
assertValid({ time_limits: { role_timeout_minutes: { default: 30 } } }, "role_timeout_minutes = object");
assertValid(
  { time_limits: { role_timeout_minutes: { default: null, verifier: null } } },
  "role_timeout_minutes.default/verifier = null",
);

for (const [path, minimum] of Object.entries(MINIMUMS)) {
  assert.equal(typeof minimum, "number", `${path} MINIMUMS entry is numeric`);
  assert.ok(Number.isInteger(minimum), `${path} MINIMUMS entry is an integer`);
}

console.log("config schema numeric minimums OK");
