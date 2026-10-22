#!/usr/bin/env node
// Backlog #208 (mission 097 Phase 1 task 1.4): every object in the generated
// schema is closed to unknown keys, except for the shared "^_" metadata escape.
// advanced.capabilities.role_requirements is a map, so it additionally accepts
// exactly the five role names and rejects anything else.
import { buildConfigSchema } from "./gen-config-schema.mjs";

const ROLE_NAMES = ["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"];
const METADATA_PATTERN = "^_";
const ROLE_REQUIREMENTS_PATH = ["advanced", "capabilities", "role_requirements"];

function fail(message) { throw new Error(message); }
function own(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }

function isObjectSchema(node) {
  if (!node || typeof node !== "object") return false;
  const types = Array.isArray(node.type) ? node.type : [node.type];
  return types.includes("object");
}

const schema = buildConfigSchema();
let objectNodes = 0;

function checkStrict(node, path) {
  objectNodes += 1;
  if (node.additionalProperties !== false) {
    fail(`${path}: object schema must set additionalProperties: false (got ${JSON.stringify(node.additionalProperties)})`);
  }
  if (!node.patternProperties || typeof node.patternProperties !== "object") {
    fail(`${path}: object schema must declare patternProperties with a "${METADATA_PATTERN}" escape`);
  }
  if (!own(node.patternProperties, METADATA_PATTERN)) {
    fail(`${path}: patternProperties must include the "${METADATA_PATTERN}" metadata escape`);
  }
}

function walk(node, path) {
  if (!node || typeof node !== "object") return;
  if (isObjectSchema(node)) checkStrict(node, path || "<root>");
  if (node.additionalProperties && typeof node.additionalProperties === "object") {
    walk(node.additionalProperties, `${path}.additionalProperties`);
  }
  for (const [key, child] of Object.entries(node.properties || {})) {
    walk(child, path ? `${path}.${key}` : key);
  }
  for (const [pattern, child] of Object.entries(node.patternProperties || {})) {
    walk(child, `${path}.<${pattern}>`);
  }
  if (node.items) walk(node.items, `${path}[]`);
}

walk(schema, "");

if (objectNodes < 10) fail(`walk found only ${objectNodes} object schemas; the traversal is probably broken`);

let roleRequirements = schema;
for (const key of ROLE_REQUIREMENTS_PATH) {
  roleRequirements = roleRequirements && roleRequirements.properties && roleRequirements.properties[key];
}
if (!roleRequirements) fail(`missing schema node ${ROLE_REQUIREMENTS_PATH.join(".")}`);
if (!isObjectSchema(roleRequirements)) fail("advanced.capabilities.role_requirements is not an object schema");

const patterns = Object.keys(roleRequirements.patternProperties || {});

function accepts(key) {
  if (own(roleRequirements.properties || {}, key)) return true;
  return patterns.some((pattern) => new RegExp(pattern).test(key));
}

for (const role of ROLE_NAMES) {
  if (!accepts(role)) {
    fail(`advanced.capabilities.role_requirements must accept the role name "${role}"; patterns: ${JSON.stringify(patterns)}`);
  }
}
for (const unknown of ["not_a_role", "wizard", "free_models"]) {
  if (accepts(unknown)) {
    fail(`advanced.capabilities.role_requirements must reject the unknown key "${unknown}"; patterns: ${JSON.stringify(patterns)}`);
  }
}

const fallbacks = schema.properties.roles.properties.planner.properties.fallbacks.items;
if (!isObjectSchema(fallbacks)) fail("fallback entries must remain object schemas");
checkStrict(fallbacks, "roles.planner.fallbacks[]");

console.log(`config schema strictness OK (${objectNodes} object schemas closed; role requirements accept the five roles)`);
