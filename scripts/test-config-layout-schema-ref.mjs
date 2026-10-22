#!/usr/bin/env node
// Mission 097 Phase 2 task 2.2: toNewLayoutConfig can carry a computed
// `$schema` reference while keeping the historical default unchanged, so
// direct-call layout and validation-wire tests stay valid.
import assert from "node:assert/strict";
import { toNewLayoutConfig } from "./config-layout.mjs";
import { schemaReferenceFor } from "./config-schema-ref.mjs";

const explicitRef = schemaReferenceFor("/project/.autopilot/config.json", {
  schemaPath: "/project/config.schema.json",
});
assert.equal(explicitRef, "../config.schema.json", "fixture ref is the expected relative path");

const defaultLayout = toNewLayoutConfig({});
assert.equal(defaultLayout.$schema, "./config.schema.json", "default $schema is unchanged");
assert.equal(Object.keys(defaultLayout)[0], "$schema", "default $schema stays first");

const explicitLayout = toNewLayoutConfig({}, explicitRef);
assert.equal(explicitLayout.$schema, explicitRef, "explicit ref lands in $schema");
assert.equal(Object.keys(explicitLayout)[0], "$schema", "explicit $schema lands first");
assert.equal(explicitLayout.schema_version, defaultLayout.schema_version, "schema_version is untouched");
assert.deepEqual(explicitLayout.project, defaultLayout.project, "other defaults are untouched");

const config = {
  project: { repo: "/tmp/demo" },
  roles: { planner: { provider: "anthropic", model: "planner-model" } },
};
const withRef = toNewLayoutConfig(config, explicitRef);
assert.equal(withRef.$schema, explicitRef, "explicit ref survives a legacy runtime config");
assert.equal(withRef.project.repo, "/tmp/demo", "legacy values are still overlaid");
assert.equal(withRef.roles.planner.model, "planner-model", "legacy roles are still overlaid");

console.log("PASS config-layout-schema-ref");
