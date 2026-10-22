#!/usr/bin/env node
// Backlog #208 (mission 097 Phase 1 task 1.1): generated schema descriptions
// must come from the wildcard lookups, not the generic "Configuration value."
// fallback, and the caps sentences must state the unit and the at-limit effect.
import { buildConfigSchema } from "./gen-config-schema.mjs";

const PLACEHOLDER = "Configuration value.";

function fail(message) { throw new Error(message); }
function leaf(schema, path) {
  let node = schema;
  for (const key of path.split(".")) {
    if (!node || !node.properties || !node.properties[key]) fail(`missing schema property ${path}`);
    node = node.properties[key];
  }
  if (typeof node.description !== "string" || !node.description) fail(`${path} has no description`);
  return node.description;
}
function includes(description, needle, label) {
  if (!description.includes(needle)) fail(`${label}: expected "${needle}" in ${JSON.stringify(description)}`);
}

const schema = buildConfigSchema();

const cli = leaf(schema, "roles.planner.cli");
includes(cli, "CLI adapter", "roles.planner.cli");
if (cli === PLACEHOLDER) fail("roles.planner.cli fell back to the placeholder");

const reasoning = leaf(schema, "roles.verifier.reasoning");
includes(reasoning, "Reasoning effort", "roles.verifier.reasoning");
if (reasoning === PLACEHOLDER) fail("roles.verifier.reasoning fell back to the placeholder");

const maxTurns = leaf(schema, "caps.planner.max_turns");
includes(maxTurns, "turns", "caps.planner.max_turns unit");
includes(maxTurns, "at the limit", "caps.planner.max_turns limit");

const wrapUp = leaf(schema, "caps.code_reviewer.wrap_up_at_tokens");
includes(wrapUp, "Token", "caps.code_reviewer.wrap_up_at_tokens unit");
includes(wrapUp, "wrap up", "caps.code_reviewer.wrap_up_at_tokens limit");
includes(wrapUp, "at the limit", "caps.code_reviewer.wrap_up_at_tokens limit");

for (const role of ["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"]) {
  for (const key of ["max_turns", "max_tokens", "extra_sessions", "wrap_up_at_tokens"]) {
    const description = leaf(schema, `caps.${role}.${key}`);
    if (description === PLACEHOLDER) fail(`caps.${role}.${key} fell back to the placeholder`);
    if (!description.includes("at the limit")) fail(`caps.${role}.${key} does not say what happens at the limit`);
  }
}

const bad = [];
function walk(node, path) {
  if (!node || typeof node !== "object") return;
  if (node.type === "object" && node.properties) {
    for (const [key, entry] of Object.entries(node.properties)) walk(entry, path ? `${path}.${key}` : key);
    return;
  }
  if (node.type !== "object" && node.description === PLACEHOLDER) bad.push(path || "<root>");
}
walk(schema, "");
if (bad.length) fail(`generic placeholder description on: ${bad.join(", ")}`);

console.log("config schema descriptions OK");
