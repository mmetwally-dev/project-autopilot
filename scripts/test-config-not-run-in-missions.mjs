#!/usr/bin/env node
// Backlog #4 Part A: tests.not_run_in_missions / the recorded original command
// are part of the v4 config contract: valid shape accepted, malformed entries
// rejected with a useful path, and the layout maps to the runtime gates object
// and back.
import { validateNewConfig } from "./config-validation.mjs";
import { DEFAULTS, toRuntimeConfig, toNewLayoutConfig } from "./config-layout.mjs";
import { buildConfigSchema } from "./gen-config-schema.mjs";

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

function errorsFor(patch) {
  const config = {
    ...DEFAULTS,
    tests: { ...DEFAULTS.tests, ...patch }
  };
  return validateNewConfig(config).errors;
}

const validEntry = {
  files: ["tests/integration/server.test.ts"],
  reason: "server not reachable on 127.0.0.1:3000",
  command: 'npx vitest run "tests/integration/server.test.ts"'
};

console.log("validation:");
check("DEFAULTS is valid", validateNewConfig(DEFAULTS).valid);
check("valid not-run entry is accepted",
  validateNewConfig({ ...DEFAULTS, tests: { ...DEFAULTS.tests, not_run_in_missions: [validEntry], not_run_in_missions_original_command: "npx vitest run" } }).valid);
check("not_run_in_missions must be an array",
  errorsFor({ not_run_in_missions: "tests/a.test.ts" }).some((error) => error.includes("not_run_in_missions") && error.includes("array")));
check("entry must be an object",
  errorsFor({ not_run_in_missions: ["tests/a.test.ts"] }).some((error) => error.includes("must be an object")));
check("files must be a non-empty array",
  errorsFor({ not_run_in_missions: [{ ...validEntry, files: [] }] }).some((error) => error.includes("files") && error.includes("non-empty")));
check("file paths must be non-empty strings",
  errorsFor({ not_run_in_missions: [{ ...validEntry, files: [""] }] }).some((error) => error.includes("files[0]")));
check("reason is required",
  errorsFor({ not_run_in_missions: [{ files: validEntry.files, command: validEntry.command }] }).some((error) => error.includes("reason")));
check("command is required",
  errorsFor({ not_run_in_missions: [{ files: validEntry.files, reason: validEntry.reason }] }).some((error) => error.includes("command")));
check("original command must be a string",
  errorsFor({ not_run_in_missions_original_command: 42 }).some((error) => error.includes("not_run_in_missions_original_command") && error.includes("string")));

console.log("\nlayout mapping:");
const layout = {
  ...DEFAULTS,
  tests: {
    ...DEFAULTS.tests,
    gate_commands: ['npx vitest run --exclude "tests/integration/server.test.ts"'],
    not_run_in_missions: [validEntry],
    not_run_in_missions_original_command: "npx vitest run"
  }
};
const runtime = toRuntimeConfig(layout);
check("runtime gates carries the list", JSON.stringify(runtime.gates.not_run_in_missions) === JSON.stringify([validEntry]));
check("runtime gates carries the original command", runtime.gates.not_run_in_missions_original_command === "npx vitest run");
const roundTrip = toNewLayoutConfig(runtime, {});
check("round-trip keeps the list", JSON.stringify(roundTrip.tests.not_run_in_missions) === JSON.stringify([validEntry]));
check("round-trip keeps the original command", roundTrip.tests.not_run_in_missions_original_command === "npx vitest run");

console.log("\nschema:");
const schema = buildConfigSchema();
const item = schema.properties.tests.properties.not_run_in_missions.items;
check("schema item is an object", item.type === "object");
check("schema item is closed", item.additionalProperties === false);
check("schema requires files, reason, command", JSON.stringify(item.required) === JSON.stringify(["files", "reason", "command"]));
check("schema has the original command key", typeof schema.properties.tests.properties.not_run_in_missions_original_command === "object");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("ALL CHECKS PASSED");
