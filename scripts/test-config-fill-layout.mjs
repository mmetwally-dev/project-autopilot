#!/usr/bin/env node
// Mission 097 Phase 2 task 2.4: fillLayout inserts absent DEFAULTS keys only.
import assert from "node:assert/strict";
import { DEFAULTS } from "./config-layout.mjs";
import { fillLayout } from "./config-fill.mjs";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function withoutRuntime(value) {
  const out = clone(value);
  delete out.runtime;
  return out;
}

// Added keys equal the defaults, in DEFAULTS order; no runtime is fabricated.
const emptyFilled = fillLayout({});
assert.deepEqual(emptyFilled, withoutRuntime(DEFAULTS), "empty layout gains every non-runtime default");
assert.deepEqual(
  Object.keys(emptyFilled),
  Object.keys(DEFAULTS).filter((key) => key !== "runtime"),
  "inserted keys follow layout (DEFAULTS) order"
);
assert.equal("runtime" in emptyFilled, false, "an absent runtime stays absent");

// Preset values survive, including null, empty arrays and false.
const preset = {
  $schema: "../config.schema.json",
  schema_version: "4.0",
  project: { repo: "/tmp/demo" },
  roles: { planner: { cli: "codex", model: "planner-model", resume_session: false } },
  caps: { task_size_target_turns: 11, implementer: { max_turns: 9 } },
  time_limits: { role_timeout_floor_minutes: null },
  tests: { gate_commands: [] },
  workflow: { plan_review: false },
  custom_section: { keep: "operator data" },
};
const presetSnapshot = clone(preset);
const filled = fillLayout(preset);

assert.deepEqual(preset, presetSnapshot, "fillLayout does not mutate its input");
assert.equal(filled.project.repo, "/tmp/demo", "preset project value survives");
assert.equal(filled.roles.planner.cli, "codex", "preset role value survives");
assert.equal(filled.caps.task_size_target_turns, 11, "preset cap value survives");
assert.equal(filled.caps.implementer.max_turns, 9, "preset nested cap value survives");
assert.equal(filled.time_limits.role_timeout_floor_minutes, null, "null value survives");
assert.deepEqual(filled.tests.gate_commands, [], "empty array survives");
assert.equal(filled.workflow.plan_review, false, "false value survives");
assert.deepEqual(filled.custom_section, { keep: "operator data" }, "unknown operator section survives");

// Missing keys gained their defaults.
assert.deepEqual(filled.caps.planner, DEFAULTS.caps.planner, "missing caps role gains its defaults");
assert.equal(filled.caps.implementer.max_tokens, DEFAULTS.caps.implementer.max_tokens, "missing nested value gains its default");
assert.deepEqual(filled.roles.verifier, DEFAULTS.roles.verifier, "missing role section gains its defaults");
assert.deepEqual(filled.safety, DEFAULTS.safety, "missing top-level section gains its defaults");
assert.equal(filled.$schema, "../config.schema.json", "existing $schema is preserved");
assert.equal(Object.keys(filled)[0], "$schema", "$schema keeps its first position");
assert.equal(filled.schema_version, "4.0", "schema_version is preserved");

// Runtime: empty stays empty, a real runtime is completed, null is kept.
const emptyRuntime = fillLayout({ runtime: {} });
assert.deepEqual(emptyRuntime.runtime, {}, "an empty runtime stays empty");
assert.equal("mode" in emptyRuntime.runtime, false, "empty runtime gets no fabricated mode");
assert.equal("wsl_distro" in emptyRuntime.runtime, false, "empty runtime gets no fabricated wsl_distro");

const realRuntime = fillLayout({ runtime: { mode: "wsl" } });
assert.deepEqual(realRuntime.runtime, { mode: "wsl", wsl_distro: null }, "a real runtime gains its missing default");

const nullRuntime = fillLayout({ runtime: null });
assert.equal(nullRuntime.runtime, null, "a null runtime is left untouched");

// The old time-limit name is rewritten to the current one.
const renamed = fillLayout({ time_limits: { mission_timeout_minutes: 125 } });
assert.equal(renamed.time_limits.call_backstop_minutes, 125, "fill rewrites the old name");
assert.equal("mission_timeout_minutes" in renamed.time_limits, false, "fill drops the old name");

// Idempotent: a second pass adds nothing.
const once = fillLayout(preset);
const twice = fillLayout(once);
assert.deepEqual(twice, once, "second pass changes nothing");
assert.equal(JSON.stringify(twice), JSON.stringify(once), "key order is stable across passes");

console.log("PASS config-fill-layout");
