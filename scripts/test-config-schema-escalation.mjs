#!/usr/bin/env node
// Backlog #208 (mission 097 Phase 1 task 1.3): escalation_model is a
// schema-only optional role setting for the planner and implementer. It must
// accept an object or null, carry descriptions for every child, stay out of the
// other roles, and never become a DEFAULTS key (a null default would be copied
// into new configs and rejected by runtime validation).
import { buildConfigSchema } from "./gen-config-schema.mjs";
import { DEFAULTS } from "./config-layout.mjs";

const ROLES = ["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"];
const ESCALATING_ROLES = ["planner", "implementer"];
const CHILDREN = ["cli", "model", "reasoning", "variant"];

function fail(message) { throw new Error(message); }
function isNonEmptyString(value) { return typeof value === "string" && value.length > 0; }

const schema = buildConfigSchema();
const roleProperties = schema.properties.roles.properties;

for (const role of ROLES) {
  const escalation = roleProperties[role].properties.escalation_model;
  if (ESCALATING_ROLES.includes(role)) {
    if (!escalation) fail(`roles.${role}.escalation_model is missing from the schema`);
  } else if (escalation) {
    fail(`roles.${role}.escalation_model must not exist; only the planner and implementer escalate`);
  }
}

const escalation = roleProperties.planner.properties.escalation_model;
const types = Array.isArray(escalation.type) ? escalation.type : [escalation.type];
for (const type of ["object", "null"]) {
  if (!types.includes(type)) fail(`escalation_model type must include "${type}", got ${JSON.stringify(escalation.type)}`);
}
if (escalation.default !== undefined) fail("escalation_model must not carry a default; it is schema-only and optional");
if (escalation.additionalProperties !== false) fail("escalation_model must be strict (additionalProperties: false)");
if (!isNonEmptyString(escalation.description)) fail("escalation_model has no description");
if (!escalation.description.includes("retries.escalate_after_not_fixed")) {
  fail("escalation_model description must name retries.escalate_after_not_fixed");
}
if (!escalation.description.includes("not-fixed")) {
  fail("escalation_model description must say it runs after not-fixed reports");
}

for (const child of CHILDREN) {
  const property = escalation.properties && escalation.properties[child];
  if (!property) fail(`escalation_model.${child} is missing from the schema`);
  if (!isNonEmptyString(property.description)) fail(`escalation_model.${child} has no description`);
  if (property.description === "Configuration value.") fail(`escalation_model.${child} uses the placeholder description`);
  if (property.type !== "string") fail(`escalation_model.${child} must be a string, got ${JSON.stringify(property.type)}`);
}
for (const key of Object.keys(escalation.properties)) {
  if (!CHILDREN.includes(key)) fail(`escalation_model has unexpected child "${key}"`);
}

for (const role of ROLES) {
  if (Object.prototype.hasOwnProperty.call(DEFAULTS.roles[role], "escalation_model")) {
    fail(`DEFAULTS.roles.${role} must not define escalation_model`);
  }
}
if (Object.keys(DEFAULTS.roles).some((key) => key === "escalation_model")) {
  fail("DEFAULTS.roles must not define a top-level escalation_model");
}

if (roleProperties.planner.properties.escalation_model === roleProperties.implementer.properties.escalation_model) {
  fail("escalation_model schema must not be shared between roles");
}

console.log("config schema escalation_model OK");
