#!/usr/bin/env node
// Mission 097 Phase 2 task 2.10: this repository's local `.autopilot/config.json`
// must be complete after `ap config fill`. The file is gitignored, so a clean
// checkout has none and the check skips instead of failing.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fillLayout } from "./config-fill.mjs";
import { schemaReferenceResolves } from "./config-schema-ref.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(repoRoot, ".autopilot", "config.json");

if (!fs.existsSync(configPath)) {
  console.log(`SKIP: ${path.relative(repoRoot, configPath)} is not present (it is local-only).`);
  process.exit(0);
}

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

assert.equal(Object.keys(config)[0], "$schema", "$schema is the first key");
assert.equal(
  schemaReferenceResolves(config.$schema, path.dirname(configPath)),
  true,
  `$schema "${config.$schema}" resolves from .autopilot/`
);

const completed = fillLayout(config, configPath);
assert.deepEqual(completed, config, "no settings are missing; fillLayout is a no-op");

assert.deepEqual(config.roles.plan_reviewer.fallbacks, [], "plan_reviewer.fallbacks defaults to []");
assert.deepEqual(config.roles.code_reviewer.fallbacks, [], "code_reviewer.fallbacks defaults to []");

assert.ok(Array.isArray(config.tests.gate_commands) && config.tests.gate_commands.length > 0, "gate commands survived");
assert.equal(typeof config.runtime?.mode, "string", "runtime mode survived");
assert.ok(Array.isArray(config.roles.planner.fallbacks) && config.roles.planner.fallbacks.length > 0, "planner fallbacks survived");
assert.ok(Array.isArray(config.roles.implementer.fallbacks) && config.roles.implementer.fallbacks.length > 0, "implementer fallbacks survived");
assert.equal(typeof config.roles.planner.escalation_model?.model, "string", "planner escalation model survived");
assert.equal(typeof config.roles.implementer.escalation_model?.model, "string", "implementer escalation model survived");

console.log("PASS: .autopilot/config.json is complete and its $schema resolves.");
