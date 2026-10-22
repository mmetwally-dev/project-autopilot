#!/usr/bin/env node
// Mission 097 Phase 1 task 1.5: the schema must advertise exactly the CLI
// adapters that ship in adapters/agents.json and the documented reasoning
// levels, plus the empty string that means "adapter/model default".
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CLI_VALUES,
  ENUMS,
  REASONING_VALUES,
  buildConfigSchema,
  documentedReasoningLevels,
} from "./gen-config-schema.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROLE_NAMES = ["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"];

function sorted(values) {
  return [...values].sort();
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

const agents = JSON.parse(readFileSync(join(ROOT, "adapters", "agents.json"), "utf8"));
const expectedCli = ["", ...Object.keys(agents.adapters)];
assert.deepEqual(sorted(expectedCli), ["", "antigravity", "claude", "codex", "cursor", "opencode"], "agents.json ships the documented CLI adapters");
assert.deepEqual(sorted(CLI_VALUES), sorted(expectedCli), "CLI_VALUES matches adapters/agents.json");

// PLAN.md documents the reasoning enum as the union of none, minimal,
// low, medium, high, xhigh and max plus "" (adapter/model default).
const PLAN_REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
assert.deepEqual(sorted(REASONING_VALUES), sorted(["", ...PLAN_REASONING_LEVELS]), "REASONING_VALUES carries the PLAN-documented effort levels plus empty");
assert.deepEqual(sorted(documentedReasoningLevels()), sorted(PLAN_REASONING_LEVELS), "documentedReasoningLevels() matches the PLAN-documented levels");
check(REASONING_VALUES.includes(""), "REASONING_VALUES allows the empty (adapter default) value");

// Every level a shipped catalog documents must still be offered.
const effortDir = join(ROOT, "adapters", "documented-effort");
for (const file of readdirSync(effortDir)) {
  if (!file.endsWith(".json")) continue;
  const entry = JSON.parse(readFileSync(join(effortDir, file), "utf8"));
  for (const level of entry.levels || []) {
    check(REASONING_VALUES.includes(level), `catalog ${file} level ${level} is in REASONING_VALUES`);
  }
}

assert.deepEqual(ENUMS["roles.*.cli"], CLI_VALUES, "roles.*.cli enum");
assert.deepEqual(ENUMS["roles.*.reasoning"], REASONING_VALUES, "roles.*.reasoning enum");
assert.deepEqual(ENUMS["roles.*.fallbacks[].cli"], CLI_VALUES, "fallback cli enum");
assert.deepEqual(ENUMS["roles.*.fallbacks[].reasoning"], REASONING_VALUES, "fallback reasoning enum");
assert.deepEqual(ENUMS["roles.*.escalation_model.cli"], CLI_VALUES, "escalation cli enum");
assert.deepEqual(ENUMS["roles.*.escalation_model.reasoning"], REASONING_VALUES, "escalation reasoning enum");

const schema = buildConfigSchema();
for (const role of ROLE_NAMES) {
  const properties = schema.properties.roles.properties[role].properties;
  assert.deepEqual(properties.cli.enum, CLI_VALUES, `${role}.cli enum`);
  assert.deepEqual(properties.reasoning.enum, REASONING_VALUES, `${role}.reasoning enum`);
  const fallback = properties.fallbacks.items.properties;
  assert.deepEqual(fallback.cli.enum, CLI_VALUES, `${role}.fallbacks[].cli enum`);
  assert.deepEqual(fallback.reasoning.enum, REASONING_VALUES, `${role}.fallbacks[].reasoning enum`);
}

for (const role of ["planner", "implementer"]) {
  const escalation = schema.properties.roles.properties[role].properties.escalation_model.properties;
  assert.deepEqual(escalation.cli.enum, CLI_VALUES, `${role}.escalation_model.cli enum`);
  assert.deepEqual(escalation.reasoning.enum, REASONING_VALUES, `${role}.escalation_model.reasoning enum`);
}

console.log("config-schema-values tests passed");
