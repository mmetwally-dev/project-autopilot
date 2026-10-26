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

// Backlog #100: every retries budget must explain an explicit 0 and what an
// absent value does (it keeps the built-in default).
const retryDescriptions = {
  "retries.plan_revisions": "an absent value uses the built-in default of 8.",
  "retries.implementation": "an absent value uses the built-in default of 4.",
  "retries.verification": "an absent value uses the built-in default of 4.",
  "retries.cli_errors": "an absent value uses the built-in default of 3.",
  "retries.infrastructure": "an absent value uses the built-in default of 3.",
  "retries.extra_sessions_per_task": "an absent value uses the built-in default of 5.",
};
for (const [path, defaultSentence] of Object.entries(retryDescriptions)) {
  const description = leaf(schema, path);
  includes(description, "0", `${path} zero`);
  includes(description, "absent", `${path} absence`);
  includes(description, defaultSentence, `${path} default sentence`);
}

// plan_revisions is an escalation point, not a revision count: 0 and 1 both
// stop at the first FAIL in standalone, SpecKit never runs more than one
// revision per gate, and GSD planning still treats 0 or absent as 8.
const planRevisions = leaf(schema, "retries.plan_revisions");
for (const marker of ["first plan-review FAIL", "one fewer revision", "1 behaves like 0", "at most one revision per gate", "any value above 0", "GSD planning still treats 0 or an absent value as 8"]) {
  includes(planRevisions, marker, `retries.plan_revisions ${marker}`);
}
if (/revision rounds/i.test(planRevisions)) fail("retries.plan_revisions still claims a number of revision rounds");

// Backlog #16: these three implemented settings used to claim they had no
// effect. Each description must now state the real true/false behavior.
const implementedSettings = {
  "workflow.plan_review_rounds_converge": ["(true)", "(false)"],
  "workflow.code_review_per_phase": ["(true)", "(false)"],
  "workflow.final_review": ["(true)", "(false)"],
  "workflow.pause_for_plan_approval": ["(true)", "(false)", "ap run"],
};
for (const [path, markers] of Object.entries(implementedSettings)) {
  const description = leaf(schema, path);
  if (description.includes("Not used by this version")) fail(`${path} still says it is not used`);
  for (const marker of markers) includes(description, marker, `${path} ${marker}`);
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
