#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {loadAndMigrateConfig} from "./config-migration.mjs";
import {validateNewConfig} from "./config-validation.mjs";
import {toNewLayoutConfig} from "./config-layout.mjs";
import {DEFAULTS} from "./config-layout.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-test-"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertErrorContains(errors, substring) {
  if (!errors.some(e => e.includes(substring))) {
    throw new Error(`Expected error containing "${substring}", got: ${JSON.stringify(errors)}`);
  }
}

function assertWarningContains(warnings, substring) {
  if (!warnings.some(w => w.includes(substring))) {
    throw new Error(`Expected warning containing "${substring}", got: ${JSON.stringify(warnings)}`);
  }
}

console.log("Testing validateNewConfig wiring...");

// Test 1: Load path - unknown key in v4 config should report error
const badConfigPath1 = path.join(tmpDir, "bad-config-1.json");
const badConfig1 = {
  ...DEFAULTS,
  $schema: "./config.schema.json",
  schema_version: "4.0",
  unknown_top_key: "should fail"
};
fs.writeFileSync(badConfigPath1, JSON.stringify(badConfig1, null, 2));

const result1 = loadAndMigrateConfig(badConfigPath1, {persist: false});
assert(result1.layout !== null, "Should have layout");
const validation1 = validateNewConfig(result1.layout);
assert(!validation1.valid, "Unknown top-level key should be invalid on load path");
assertErrorContains(validation1.errors, "unknown_top_key");
console.log("PASS: Load path rejects unknown top-level key");

// Test 2: Load path - legacy section should produce warning, not error
const badConfigPath2 = path.join(tmpDir, "bad-config-2.json");
const badConfig2 = {
  ...DEFAULTS,
  $schema: "./config.schema.json",
  schema_version: "4.0",
  policy: {per_task_max_turns: 10}
};
fs.writeFileSync(badConfigPath2, JSON.stringify(badConfig2, null, 2));

const result2 = loadAndMigrateConfig(badConfigPath2, {persist: false});
assert(result2.layout !== null, "Should have layout");
const validation2 = validateNewConfig(result2.layout);
assert(validation2.valid, "Legacy policy section should not cause error on load path");
assertWarningContains(validation2.warnings, "policy");
assertWarningContains(validation2.warnings, "deprecated");
console.log("PASS: Load path warns on legacy 'policy' section");

// Test 3: Load path - another legacy section (gates)
const badConfigPath3 = path.join(tmpDir, "bad-config-3.json");
const badConfig3 = {
  ...DEFAULTS,
  $schema: "./config.schema.json",
  schema_version: "4.0",
  gates: {commands: ["npm test"]}
};
fs.writeFileSync(badConfigPath3, JSON.stringify(badConfig3, null, 2));

const result3 = loadAndMigrateConfig(badConfigPath3, {persist: false});
assert(result3.layout !== null, "Should have layout");
const validation3 = validateNewConfig(result3.layout);
assert(validation3.valid, "Legacy gates section should not cause error on load path");
assertWarningContains(validation3.warnings, "gates");
assertWarningContains(validation3.warnings, "deprecated");
console.log("PASS: Load path warns on legacy 'gates' section");

// Test 4: Save path - unknown key in v4 layout should be rejected
const configForSave1 = {
  project: {repo: ".", planning_framework: "standalone"},
  roles: {
    planner: {adapter: "claude", model: "", reasoning: "", variant: "", resume: true},
    plan_reviewer: {adapter: "claude", model: "", reasoning: "", variant: "", resume: true},
    implementer: {adapter: "claude", model: "", reasoning: "", variant: "", resume: true},
    code_reviewer: {adapter: "claude", model: "", reasoning: "", variant: "", resume: true},
    verifier: {adapter: "claude", model: "", reasoning: "", variant: "", resume: true},
  },
  execution: {runtime_mode: "linux-strong", wsl_distro: null},
  workflow: {},
  gates: {commands: [], network_isolation: true, require_reviewer: true, env_allowlist: []},
  policy: {},
  planning: {verify_denylist: []},
  capabilities: {},
  safety: {},
  unknown_save_key: "should fail"
};

const v4Layout1 = toNewLayoutConfig(configForSave1);
v4Layout1.$schema = "./config.schema.json";
v4Layout1.schema_version = "4.0";
v4Layout1.unknown_save_key = "should fail"; // Add unknown key to v4 layout

const validation4 = validateNewConfig(v4Layout1);
assert(!validation4.valid, "Unknown key in v4 layout should be invalid on save path");
assertErrorContains(validation4.errors, "unknown_save_key");
console.log("PASS: Save path rejects unknown key in v4 layout");

// Test 5: Save path - invalid value (wrong type) in v4 layout
const configForSave2 = {
  project: {repo: ".", planning_framework: "standalone"},
  roles: {
    planner: {adapter: "claude", model: "", reasoning: "", variant: "", resume: true},
    plan_reviewer: {adapter: "claude", model: "", reasoning: "", variant: "", resume: true},
    implementer: {adapter: "claude", model: "", reasoning: "", variant: "", resume: true},
    code_reviewer: {adapter: "claude", model: "", reasoning: "", variant: "", resume: true},
    verifier: {adapter: "claude", model: "", reasoning: "", variant: "", resume: true},
  },
  execution: {runtime_mode: "linux-strong", wsl_distro: null},
  workflow: {},
  gates: {commands: [], network_isolation: true, require_reviewer: true, env_allowlist: []},
  policy: {},
  planning: {verify_denylist: []},
  capabilities: {},
  safety: {},
};

const v4Layout2 = toNewLayoutConfig(configForSave2);
v4Layout2.$schema = "./config.schema.json";
v4Layout2.schema_version = "4.0";
v4Layout2.caps = {...v4Layout2.caps, planner: {...v4Layout2.caps.planner, max_turns: "not-an-integer"}};

const validation5 = validateNewConfig(v4Layout2);
assert(!validation5.valid, "Invalid type in v4 layout should be invalid on save path");
assertErrorContains(validation5.errors, "max_turns");
assertErrorContains(validation5.errors, "integer");
console.log("PASS: Save path rejects invalid value in v4 layout");

// Test 6: Valid config should pass on both paths
const goodConfigPath = path.join(tmpDir, "good-config.json");
const goodConfig = {
  ...DEFAULTS,
  $schema: "./config.schema.json",
  schema_version: "4.0",
};
fs.writeFileSync(goodConfigPath, JSON.stringify(goodConfig, null, 2));

const result6 = loadAndMigrateConfig(goodConfigPath, {persist: false});
assert(result6.layout !== null, "Should have layout");
const validation6 = validateNewConfig(result6.layout);
assert(validation6.valid, "Valid config should pass on load path");
console.log("PASS: Valid config passes on load path");

const v4Layout6 = toNewLayoutConfig({
  project: {repo: ".", planning_framework: "standalone"},
  roles: {
    planner: {adapter: "claude", model: "", reasoning: "", variant: "", resume: true},
    plan_reviewer: {adapter: "claude", model: "", reasoning: "", variant: "", resume: true},
    implementer: {adapter: "claude", model: "", reasoning: "", variant: "", resume: true},
    code_reviewer: {adapter: "claude", model: "", reasoning: "", variant: "", resume: true},
    verifier: {adapter: "claude", model: "", reasoning: "", variant: "", resume: true},
  },
  execution: {runtime_mode: "linux-strong", wsl_distro: null},
  workflow: {},
  gates: {commands: [], network_isolation: true, require_reviewer: true, env_allowlist: []},
  policy: {},
  planning: {verify_denylist: []},
  capabilities: {},
  safety: {},
});
v4Layout6.$schema = "./config.schema.json";
v4Layout6.schema_version = "4.0";

const validation7 = validateNewConfig(v4Layout6);
assert(validation7.valid, "Valid config should pass on save path");
console.log("PASS: Valid config passes on save path");

// Test 7: Migrated old config with numeric time limits (from legacy ms) and
// operator-added keys still loads and validates; carried keys are warnings.
const oldConfigPath = path.join(tmpDir, "old-config.json");
const oldConfig = {
  schema_version: "3.0",
  project: {repo: ".", planning_framework: "standalone", custom_project_key: "kept"},
  roles: {
    planner: {adapter: "claude", model: "", reasoning: "", variant: "", resume: true},
    plan_reviewer: {adapter: "claude", model: "", reasoning: "", variant: "", resume: true},
    implementer: {adapter: "claude", model: "", reasoning: "", variant: "", resume: true},
    code_reviewer: {adapter: "claude", model: "", reasoning: "", variant: "", resume: true},
    verifier: {adapter: "claude", model: "", reasoning: "", variant: "", resume: true},
  },
  execution: {runtime_mode: "linux-strong", wsl_distro: null, custom_exec_key: 1},
  workflow: {},
  gates: {commands: [], network_isolation: true, require_reviewer: true, env_allowlist: []},
  policy: {role_timeout_ms: 90000, idle_hang_ms: 90000, relay_timeout_ms: null, per_task_max_turns: 10},
  planning: {verify_denylist: []},
  capabilities: {},
  safety: {},
  custom_operator_key: {hello: "world"},
};
fs.writeFileSync(oldConfigPath, JSON.stringify(oldConfig, null, 2));

const oldResult = loadAndMigrateConfig(oldConfigPath, {persist: false});
assert(oldResult.changed, "Old schema config should be reported as migrated");
assert(oldResult.layout.time_limits.role_timeout_minutes === 90000, "Numeric role_timeout_minutes should survive migration");
assert(oldResult.layout.time_limits.silent_run_minutes === 1.5, "Non-whole-minute ms should survive migration");
assert(oldResult.layout.time_limits.call_backstop_minutes === null, "null relay_timeout_ms should survive migration");

const oldStrict = validateNewConfig(oldResult.layout);
assert(!oldStrict.valid, "Carried unknown keys should fail a strict (hand-written) validation");
const oldValidation = validateNewConfig(oldResult.layout, {migrated: oldResult.changed});
assert(oldValidation.valid, `Migrated old config should validate: ${JSON.stringify(oldValidation.errors)}`);
assertWarningContains(oldValidation.warnings, "custom_operator_key");
assertWarningContains(oldValidation.warnings, "custom_project_key");
assertWarningContains(oldValidation.warnings, "custom_exec_key");
console.log("PASS: Migrated old config with ms limits and carried keys validates (warnings only)");

// Cleanup
fs.rmSync(tmpDir, {recursive: true, force: true});

console.log("\nAll validateNewConfig wiring tests passed!");