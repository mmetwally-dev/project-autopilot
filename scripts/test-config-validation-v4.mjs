#!/usr/bin/env node
import {validateNewConfig} from "./config-validation.mjs";
import {DEFAULTS} from "./config-layout.mjs";

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

console.log("Testing validateNewConfig...");

// 1. Valid config (DEFAULTS) should pass
const validResult = validateNewConfig(DEFAULTS);
assert(validResult.valid, `DEFAULTS should be valid: ${JSON.stringify(validResult.errors)}`);
console.log("PASS: DEFAULTS config validates successfully");

// 2. Misspelled top-level key should suggest correction
const misspelledTop = {...DEFAULTS, "projecct": {repo: "."}};
const misspelledResult = validateNewConfig(misspelledTop);
assert(!misspelledResult.valid, "Misspelled top-level key should be invalid");
assertErrorContains(misspelledResult.errors, "projecct");
assertErrorContains(misspelledResult.errors, "project");
console.log("PASS: Misspelled top-level key suggests correction");

// 3. Misspelled nested key (caps.implementor -> caps.implementer)
const misspelledCaps = {
  ...DEFAULTS,
  caps: {...DEFAULTS.caps, implementor: {max_turns: 10}},
};
const misspelledCapsResult = validateNewConfig(misspelledCaps);
assert(!misspelledCapsResult.valid, "Misspelled caps key should be invalid");
assertErrorContains(misspelledCapsResult.errors, "implementor");
assertErrorContains(misspelledCapsResult.errors, "implementer");
console.log("PASS: Misspelled caps.implementor suggests caps.implementer");

// 4. Bad enum value for runtime.mode
const badRuntimeMode = {
  ...DEFAULTS,
  runtime: {mode: "linux-weak", wsl_distro: null},
};
const badRuntimeResult = validateNewConfig(badRuntimeMode);
assert(!badRuntimeResult.valid, "Bad runtime mode should be invalid");
assertErrorContains(badRuntimeResult.errors, "linux-weak");
assertErrorContains(badRuntimeResult.errors, "linux-strong");
console.log("PASS: Bad runtime mode enum rejected with suggestion");

// 5. Bad enum value for tests.browser
const badBrowser = {
  ...DEFAULTS,
  tests: {...DEFAULTS.tests, browser: "chrome"},
};
const badBrowserResult = validateNewConfig(badBrowser);
assert(!badBrowserResult.valid, "Bad browser value should be invalid");
assertErrorContains(badBrowserResult.errors, "chrome");
assertErrorContains(badBrowserResult.errors, "native");
console.log("PASS: Bad browser enum rejected with allowed values");

// 6. Wrong type for integer field (caps.planner.max_turns as string)
const badType = {
  ...DEFAULTS,
  caps: {...DEFAULTS.caps, planner: {...DEFAULTS.caps.planner, max_turns: "ten"}},
};
const badTypeResult = validateNewConfig(badType);
assert(!badTypeResult.valid, "String for integer field should be invalid");
assertErrorContains(badTypeResult.errors, "max_turns");
assertErrorContains(badTypeResult.errors, "integer");
console.log("PASS: Wrong type for integer field rejected");

// 7. Wrong type for boolean field (workflow.plan_review as string)
const badBoolType = {
  ...DEFAULTS,
  workflow: {...DEFAULTS.workflow, plan_review: "yes"},
};
const badBoolResult = validateNewConfig(badBoolType);
assert(!badBoolResult.valid, "String for boolean field should be invalid");
assertErrorContains(badBoolResult.errors, "plan_review");
assertErrorContains(badBoolResult.errors, "boolean");
console.log("PASS: Wrong type for boolean field rejected");

// 8. Legacy section "policy" should produce deprecated warning, not error
const legacyPolicy = {
  ...DEFAULTS,
  policy: {per_task_max_turns: 10},
};
const legacyResult = validateNewConfig(legacyPolicy);
assert(legacyResult.valid, "Legacy policy section should not cause error");
assertWarningContains(legacyResult.warnings, "policy");
assertWarningContains(legacyResult.warnings, "deprecated");
console.log("PASS: Legacy 'policy' section produces deprecated warning");

// 9. Legacy section "gates" should produce deprecated warning
const legacyGates = {
  ...DEFAULTS,
  gates: {commands: ["npm test"]},
};
const legacyGatesResult = validateNewConfig(legacyGates);
assert(legacyGatesResult.valid, "Legacy gates section should not cause error");
assertWarningContains(legacyGatesResult.warnings, "gates");
assertWarningContains(legacyGatesResult.warnings, "deprecated");
console.log("PASS: Legacy 'gates' section produces deprecated warning");

// 10. Legacy section "execution" should produce deprecated warning
const legacyExecution = {
  ...DEFAULTS,
  execution: {runtime_mode: "linux-strong", wsl_distro: null},
};
const legacyExecResult = validateNewConfig(legacyExecution);
assert(legacyExecResult.valid, "Legacy execution section should not cause error");
assertWarningContains(legacyExecResult.warnings, "execution");
assertWarningContains(legacyExecResult.warnings, "deprecated");
console.log("PASS: Legacy 'execution' section produces deprecated warning");

// 11. Legacy section "planning" should produce deprecated warning
const legacyPlanning = {
  ...DEFAULTS,
  planning: {verify_denylist: []},
};
const legacyPlanResult = validateNewConfig(legacyPlanning);
assert(legacyPlanResult.valid, "Legacy planning section should not cause error");
assertWarningContains(legacyPlanResult.warnings, "planning");
assertWarningContains(legacyPlanResult.warnings, "deprecated");
console.log("PASS: Legacy 'planning' section produces deprecated warning");

// 12. Legacy section "capabilities" should produce deprecated warning
const legacyCaps = {
  ...DEFAULTS,
  capabilities: {verification: {browser: "native"}},
};
const legacyCapsResult = validateNewConfig(legacyCaps);
assert(legacyCapsResult.valid, "Legacy capabilities section should not cause error");
assertWarningContains(legacyCapsResult.warnings, "capabilities");
assertWarningContains(legacyCapsResult.warnings, "deprecated");
console.log("PASS: Legacy 'capabilities' section produces deprecated warning");

// 13. Unknown key in roles section
const badRoleKey = {
  ...DEFAULTS,
  roles: {...DEFAULTS.roles, planner: {...DEFAULTS.roles.planner, adpater: "opencode"}},
};
const badRoleResult = validateNewConfig(badRoleKey);
assert(!badRoleResult.valid, "Unknown role key should be invalid");
assertErrorContains(badRoleResult.errors, "adpater");
assertErrorContains(badRoleResult.errors, "cli");
console.log("PASS: Unknown role key 'adpater' suggests 'cli'");

// 14. Non-integer number for integer field (float)
const floatForInt = {
  ...DEFAULTS,
  caps: {...DEFAULTS.caps, planner: {...DEFAULTS.caps.planner, max_turns: 10.5}},
};
const floatResult = validateNewConfig(floatForInt);
assert(!floatResult.valid, "Float for integer field should be invalid");
assertErrorContains(floatResult.errors, "max_turns");
assertErrorContains(floatResult.errors, "integer");
console.log("PASS: Float for integer field rejected");

// 15. Unknown key in caps section
const badCapsKey = {
  ...DEFAULTS,
  caps: {...DEFAULTS.caps, planner: {...DEFAULTS.caps.planner, max_tokenz: 100000}},
};
const badCapsResult = validateNewConfig(badCapsKey);
assert(!badCapsResult.valid, "Unknown caps key should be invalid");
assertErrorContains(badCapsResult.errors, "max_tokenz");
assertErrorContains(badCapsResult.errors, "max_tokens");
console.log("PASS: Unknown caps key 'max_tokenz' suggests 'max_tokens'");

// 16. Array where object expected
const arrayForObject = {
  ...DEFAULTS,
  project: [".", "standalone"],
};
const arrayResult = validateNewConfig(arrayForObject);
assert(!arrayResult.valid, "Array for object should be invalid");
assertErrorContains(arrayResult.errors, "project");
assertErrorContains(arrayResult.errors, "object");
console.log("PASS: Array for object rejected");

// 17. Valid config with extra _ prefixed key (should be ignored)
const withPrivate = {
  ...DEFAULTS,
  _comment: "this is ignored",
};
const privateResult = validateNewConfig(withPrivate);
assert(privateResult.valid, "_ prefixed keys should be ignored");
console.log("PASS: _ prefixed keys are ignored");

// 18. Unknown key in retries section
const badRetries = {
  ...DEFAULTS,
  retries: {...DEFAULTS.retries, plan_revisons: 5},
};
const badRetriesResult = validateNewConfig(badRetries);
assert(!badRetriesResult.valid, "Unknown retries key should be invalid");
assertErrorContains(badRetriesResult.errors, "plan_revisons");
assertErrorContains(badRetriesResult.errors, "plan_revisions");
console.log("PASS: Unknown retries key 'plan_revisons' suggests 'plan_revisions'");

// 19. Unknown key in time_limits section
const badTimeLimits = {
  ...DEFAULTS,
  time_limits: {...DEFAULTS.time_limits, call_backstop_minutess: 60},
};
const badTimeResult = validateNewConfig(badTimeLimits);
assert(!badTimeResult.valid, "Unknown time_limits key should be invalid");
assertErrorContains(badTimeResult.errors, "call_backstop_minutess");
assertErrorContains(badTimeResult.errors, "call_backstop_minutes");
console.log("PASS: Unknown time_limits key suggests correction");

// 20. Non-object config should fail
const notObject = validateNewConfig("not an object");
assert(!notObject.valid, "Non-object config should be invalid");
assertErrorContains(notObject.errors, "must be an object");
console.log("PASS: Non-object config rejected");

// 21. Legacy role-level names the reader resolves are deprecated, not unknown.
const legacyRoleNames = {
  ...DEFAULTS,
  roles: {...DEFAULTS.roles, planner: {...DEFAULTS.roles.planner, adapter: "opencode", resume: true}},
};
const legacyRoleResult = validateNewConfig(legacyRoleNames);
assert(legacyRoleResult.valid, `Legacy role names should validate: ${JSON.stringify(legacyRoleResult.errors)}`);
assertWarningContains(legacyRoleResult.warnings, "roles.planner.adapter");
assertWarningContains(legacyRoleResult.warnings, "cli");
assertWarningContains(legacyRoleResult.warnings, "roles.planner.resume");
assertWarningContains(legacyRoleResult.warnings, "resume_session");
console.log("PASS: Legacy role names adapter/resume warn with the new key names");

// 22. Legacy top-level freeModelAutoFallback is deprecated, not unknown.
const legacyTop = {...DEFAULTS, freeModelAutoFallback: false};
const legacyTopResult = validateNewConfig(legacyTop);
assert(legacyTopResult.valid, `freeModelAutoFallback should validate: ${JSON.stringify(legacyTopResult.errors)}`);
assertWarningContains(legacyTopResult.warnings, "freeModelAutoFallback");
assertWarningContains(legacyTopResult.warnings, "roles.free_models.auto_fallback");
console.log("PASS: Legacy top-level freeModelAutoFallback warns with the new key name");

// 23. Legacy section warnings name the v4 key the setting moved to.
const legacyGatesNamed = {...DEFAULTS, gates: {commands: ["npm test"]}};
const legacyGatesNamedResult = validateNewConfig(legacyGatesNamed);
assertWarningContains(legacyGatesNamedResult.warnings, "tests.gate_commands");
console.log("PASS: Legacy gates warning names tests.gate_commands");

// 24. Bad role field types are rejected (from the schema types).
const badRoleFields = {
  ...DEFAULTS,
  roles: {...DEFAULTS.roles, implementer: {...DEFAULTS.roles.implementer, reasoning: 7, cli: 5}},
};
const badRoleFieldsResult = validateNewConfig(badRoleFields);
assert(!badRoleFieldsResult.valid, "Numeric role reasoning/cli should be invalid");
assertErrorContains(badRoleFieldsResult.errors, "roles.implementer.reasoning");
assertErrorContains(badRoleFieldsResult.errors, "string");
assertErrorContains(badRoleFieldsResult.errors, "roles.implementer.cli");
console.log("PASS: Numeric role reasoning/cli rejected as non-strings");

// 25. Bad planning_framework enum and non-string repo are rejected.
const badProject = {...DEFAULTS, project: {repo: 5, planning_framework: "nope"}};
const badProjectResult = validateNewConfig(badProject);
assert(!badProjectResult.valid, "Bad project fields should be invalid");
assertErrorContains(badProjectResult.errors, "project.repo");
assertErrorContains(badProjectResult.errors, "project.planning_framework");
assertErrorContains(badProjectResult.errors, "standalone");
console.log("PASS: Bad planning_framework enum and numeric repo rejected");

// 26. Framework scalar keys are type-checked.
const badFramework = {...DEFAULTS, frameworks: {...DEFAULTS.frameworks, speckit: {...DEFAULTS.frameworks.speckit, workflow_file: 5}}};
const badFrameworkResult = validateNewConfig(badFramework);
assert(!badFrameworkResult.valid, "Numeric speckit.workflow_file should be invalid");
assertErrorContains(badFrameworkResult.errors, "frameworks.speckit.workflow_file");
console.log("PASS: Bad frameworks.speckit scalar rejected");

// 27. Operator-added key carried by migration warns (does not error) when the
// layout is flagged as migrated.
const carried = {...DEFAULTS, custom_operator_key: {hello: "world"}};
const carriedStrict = validateNewConfig(carried);
assert(!carriedStrict.valid, "Unknown key in a hand-written config should be invalid");
const carriedMigrated = validateNewConfig(carried, {migrated: true});
assert(carriedMigrated.valid, `Carried key should not error when migrated: ${JSON.stringify(carriedMigrated.errors)}`);
assertWarningContains(carriedMigrated.warnings, "custom_operator_key");
console.log("PASS: Carried operator key warns when migrated, errors when hand-written");

console.log("\nAll validateNewConfig tests passed!");