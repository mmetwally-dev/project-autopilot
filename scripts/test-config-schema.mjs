#!/usr/bin/env node
// Backlog #1 (mission 096 Phase 1 task 1.2): config.schema.json must describe
// every v4 section and key, with a default copied from config-layout.mjs
// DEFAULTS (so the numbers can never drift from per-task-budget.mjs). This
// asserts the schema is valid, in sync with DEFAULTS and with its generator,
// and that the file is shipped (listed in package.json "files").
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULTS, CONFIG_SCHEMA_VERSION } from "./config-layout.mjs";
import { serializeSchema, SCHEMA_PATH, SCHEMA_ID } from "./gen-config-schema.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) { throw new Error(message); }
function eq(actual, expected, label) {
  if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function deep(actual, expected, label) {
  if (stable(actual) !== stable(expected)) fail(`${label}:\n  expected ${stable(expected)}\n  got      ${stable(actual)}`);
}
function own(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

const raw = readFileSync(SCHEMA_PATH, "utf8");
let schema;
try {
  schema = JSON.parse(raw);
} catch (err) {
  fail(`config.schema.json is not valid JSON: ${err.message}`);
}

// ---------------------------------------------------------------------------
// Meta: $schema keyword + schema_version + the config's own $schema key.
// ---------------------------------------------------------------------------
eq(typeof schema.$schema, "string", "schema.$schema is a string");
if (!schema.$schema.includes("json-schema.org")) fail(`schema.$schema is not a JSON Schema dialect: ${schema.$schema}`);
eq(schema.type, "object", "schema.type");
eq(typeof schema.properties, "object", "schema.properties");

const schemaVersion = schema.properties.schema_version;
if (!schemaVersion) fail("schema.properties.schema_version is missing");
eq(schemaVersion.const, CONFIG_SCHEMA_VERSION, "schema_version.const");
eq(schemaVersion.default, CONFIG_SCHEMA_VERSION, "schema_version.default");

const schemaKey = schema.properties.$schema;
if (!schemaKey) fail("schema.properties.$schema is missing");
eq(schemaKey.default, SCHEMA_ID, "properties.$schema.default");

// ---------------------------------------------------------------------------
// Every top-level section carries a default equal to DEFAULTS.
// ---------------------------------------------------------------------------
for (const section of Object.keys(DEFAULTS)) {
  const entry = schema.properties[section];
  if (!entry) fail(`schema is missing top-level section '${section}'`);
  if (!own(entry, "default")) fail(`section '${section}' has no default`);
  deep(entry.default, DEFAULTS[section], `section '${section}' default`);
}

// ---------------------------------------------------------------------------
// Every caps / time_limits / roles key carries a default equal to DEFAULTS.
// ---------------------------------------------------------------------------
for (const section of ["caps", "time_limits", "roles"]) {
  const props = schema.properties[section].properties;
  if (!props) fail(`section '${section}' has no properties`);
  for (const key of Object.keys(DEFAULTS[section])) {
    const entry = props[key];
    if (!entry) fail(`schema.${section} is missing key '${key}'`);
    if (!own(entry, "default")) fail(`${section}.${key} has no default`);
    deep(entry.default, DEFAULTS[section][key], `${section}.${key} default`);
  }
}

// ---------------------------------------------------------------------------
// Every property (recursively) has a one-line description.
// ---------------------------------------------------------------------------
function checkDescriptions(node, path) {
  if (!node.properties) return;
  for (const [key, entry] of Object.entries(node.properties)) {
    const label = path ? `${path}.${key}` : key;
    if (typeof entry.description !== "string" || !entry.description.trim()) {
      fail(`${label} has no description`);
    }
    if (entry.description.includes("\n")) fail(`${label} description is not one line`);
    // escalation_model is an optional schema-only setting: DEFAULTS has no
    // key for it (and must not gain one), so it and its children carry no
    // default.
    if (!label.includes(".escalation_model") && own(entry, "default") === false) fail(`${label} has no default`);
    checkDescriptions(entry, label);
  }
}
checkDescriptions(schema, "");

// ---------------------------------------------------------------------------
// No generic placeholder descriptions and every leaf is described. Walk the
// whole tree (including array `items` subtrees) so nothing can hide behind an
// array; every node carrying a `default` is a settings leaf and must explain
// itself.
// ---------------------------------------------------------------------------
const PLACEHOLDER = "Configuration value.";
function walkSchemas(node, path, visit) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  visit(node, path);
  if (node.properties && typeof node.properties === "object") {
    for (const [key, entry] of Object.entries(node.properties)) {
      walkSchemas(entry, path ? `${path}.${key}` : key, visit);
    }
  }
  if (node.items && typeof node.items === "object") {
    walkSchemas(node.items, `${path}[]`, visit);
  }
}
let describedLeaves = 0;
walkSchemas(schema, "", (node, path) => {
  const label = path || "<root>";
  if (typeof node.description === "string") {
    if (node.description.trim() === PLACEHOLDER || node.description.startsWith(PLACEHOLDER)) {
      fail(`${label} uses the generic placeholder description`);
    }
    if (!node.description.trim()) fail(`${label} has an empty description`);
    if (node.description.includes("\n")) fail(`${label} description is not one line`);
  }
  const types = Array.isArray(node.type) ? node.type : [node.type];
  if (types.includes("object") && node.additionalProperties !== false) {
    fail(`${label} object schema is not strict (additionalProperties must be false)`);
  }
  if (!own(node, "default")) return;
  describedLeaves += 1;
  if (typeof node.description !== "string" || !node.description.trim()) {
    fail(`${label} leaf has no description`);
  }
});
if (describedLeaves === 0) fail("no described leaves found in config.schema.json");

// ---------------------------------------------------------------------------
// The shipped file carries the schema-only escalation model on the roles that
// can escalate, plus the value/minimum constraints added to the generator.
// ---------------------------------------------------------------------------
for (const role of ["planner", "implementer"]) {
  const roleProps = schema.properties.roles && schema.properties.roles.properties[role];
  if (!roleProps || !roleProps.properties.escalation_model) {
    fail(`schema.roles.${role}.escalation_model is missing`);
  }
  const escalation = roleProps.properties.escalation_model;
  if (!typesOf(escalation).includes("object")) fail(`roles.${role}.escalation_model must allow an object`);
}
if (!Array.isArray(schema.properties.roles.properties.planner.properties.cli.enum)) {
  fail("roles.planner.cli has no enum");
}
if (typeof schema.properties.caps.properties.planner.properties.max_turns.minimum !== "number") {
  fail("caps.planner.max_turns has no minimum");
}

function typesOf(node) {
  return Array.isArray(node.type) ? node.type : [node.type];
}

// ---------------------------------------------------------------------------
// The checked-in file is exactly what the generator emits (no drift).
// ---------------------------------------------------------------------------
eq(raw, serializeSchema(), "config.schema.json matches scripts/gen-config-schema.mjs");

// ---------------------------------------------------------------------------
// The schema ships: it is listed in package.json "files".
// ---------------------------------------------------------------------------
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
if (!Array.isArray(pkg.files) || !pkg.files.includes("config.schema.json")) {
  fail('package.json "files" does not list config.schema.json');
}

console.log("config schema tests passed (every v4 section/key has a DEFAULTS default; schema ships)");
