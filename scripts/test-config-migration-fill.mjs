#!/usr/bin/env node
// Backlog #208 (mission 097 Phase 2 task 2.9): a legacy migration persists a
// complete v4 layout — every missing default filled in, no fabricated runtime,
// and a `$schema` that resolves from the real `.autopilot/` directory.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { loadAndMigrateConfig } from "./config-migration.mjs";
import { DEFAULTS } from "./config-layout.mjs";
import { schemaReferenceFor, schemaReferenceResolves } from "./config-schema-ref.mjs";

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function assertDefaultsPresent(actual, defaults, prefix = "") {
  assert.ok(isPlainObject(actual), `${prefix || "<root>"} must be an object`);
  for (const [key, value] of Object.entries(defaults)) {
    const full = prefix ? `${prefix}.${key}` : key;
    assert.ok(Object.prototype.hasOwnProperty.call(actual, key), `missing default key ${full}`);
    if (isPlainObject(value) && isPlainObject(actual[key])) {
      assertDefaultsPresent(actual[key], value, full);
    }
  }
}

const tempDirs = new Set();
process.on("exit", () => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ap-migration-fill-"));
tempDirs.add(tmp);
const configPath = path.join(tmp, ".autopilot", "config.json");
fs.mkdirSync(path.dirname(configPath), { recursive: true });

const partialV3 = {
  schema_version: "3.0",
  project: { planning_framework: "gsd" },
  roles: { planner: { adapter: "claude", model: "opus", reasoning: "high" } },
  policy: { per_task_max_tokens: 120000, continuation_allowance: 7 },
};
fs.writeFileSync(configPath, `${JSON.stringify(partialV3, null, 2)}\n`);

const result = loadAndMigrateConfig(configPath, { persist: true });
assert.equal(result.changed, true, "legacy config must be reported as migrated");
assert.ok(result.backupPath && fs.existsSync(result.backupPath), "migration must back up the legacy file");

const written = JSON.parse(fs.readFileSync(configPath, "utf8"));

// Every shipped default key is present (the empty runtime is the one documented
// exception: fill must not invent mode/wsl_distro the operator never chose).
const defaultsWithoutRuntime = { ...DEFAULTS };
delete defaultsWithoutRuntime.runtime;
assertDefaultsPresent(written, defaultsWithoutRuntime);

// The operator never set execution.runtime_mode, so no runtime is fabricated.
assert.deepEqual(written.runtime, {}, `runtime must stay empty: ${JSON.stringify(written.runtime)}`);

// The persisted $schema resolves from the real config directory.
assert.equal(written.$schema, schemaReferenceFor(configPath), "the reference is computed for the real config path");
assert.equal(schemaReferenceResolves(written.$schema, path.dirname(configPath)), true, "the written $schema resolves");

// Operator values are unchanged by the migration + fill.
assert.equal(written.roles.planner.cli, "claude");
assert.equal(written.roles.planner.model, "opus");
assert.equal(written.roles.planner.reasoning, "high");
assert.equal(written.caps.implementer.max_tokens, 120000, "operator per_task_max_tokens must be preserved by fill");
assert.equal(written.caps.implementer.extra_sessions, 7);

// The runtime view still sees the operator value.
assert.equal(result.config.policy.per_task_max_tokens, 120000);

console.log("config-migration-fill tests passed");
