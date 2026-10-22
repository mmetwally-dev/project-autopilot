#!/usr/bin/env node
// Backlog #208 (mission 097 Phase 1 task 1.2): a missing description is a
// generator bug, not a generic "Configuration value." string. The lookup must
// throw for an unknown key path, so no placeholder can reach the shipped file.
import { buildConfigSchema, descriptionFor, serializeSchema } from "./gen-config-schema.mjs";

const PLACEHOLDER = "Configuration value.";

function fail(message) { throw new Error(message); }

let threw = false;
try {
  descriptionFor("roles.planner.not_a_setting");
} catch (err) {
  threw = true;
  if (!String(err.message).includes("roles.planner.not_a_setting")) {
    fail(`unknown key error does not name the path: ${err.message}`);
  }
}
if (!threw) fail("descriptionFor did not throw for an unknown key path");

if (descriptionFor("roles.planner.cli") !== descriptionFor("roles.implementer.cli")) {
  fail("known role wildcard lookup no longer resolves");
}

const serialized = serializeSchema(buildConfigSchema());
if (serialized.includes(PLACEHOLDER)) fail(`generator output still contains "${PLACEHOLDER}"`);

console.log("config schema missing-description check OK");
