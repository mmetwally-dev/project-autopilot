#!/usr/bin/env node
// Mission 097 Phase 3 task 3.1: the README reference must render one table per
// schema section, list every leaf path, take defaults from DEFAULTS and show
// enum/minimum allowed values.
import assert from "node:assert/strict";
import { buildConfigSchema } from "./gen-config-schema.mjs";
import { DEFAULTS } from "./config-layout.mjs";
import {
  defaultForPath,
  renderConfigReference,
  schemaLeaves,
} from "./config-reference.mjs";

const schema = buildConfigSchema();
const rendered = renderConfigReference(schema);

// One table per top-level config section, in schema order.
const sections = Object.keys(schema.properties);
assert.ok(sections.length > 0, "schema has sections");
assert.equal(
  rendered.split("\n").filter((line) => line === "| Setting | Default | Allowed values | Description |").length,
  sections.length,
  "one table per section",
);
let lastIndex = -1;
for (const section of sections) {
  const heading = `### ${section}`;
  const index = rendered.indexOf(heading);
  assert.ok(index !== -1, `section heading ${heading} is rendered`);
  assert.ok(index > lastIndex, `section ${section} keeps schema order`);
  lastIndex = index;
}

// Parse the rendered rows so assertions target the row, not stray text.
const rows = new Map();
for (const line of rendered.split("\n")) {
  const match = /^\| `([^`]+)` \| (.*) \| (.*) \| (.*) \|$/.exec(line);
  if (match) rows.set(match[1], {default: match[2], allowed: match[3], description: match[4]});
}

function defaultAt(root, path) {
  let current = root;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return {found: false};
    if (segment.endsWith("[]")) {
      const key = segment.slice(0, -2);
      if (!Array.isArray(current[key]) || current[key].length === 0) return {found: false};
      current = current[key][0];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return {found: false};
    current = current[segment];
  }
  return {found: true, value: current};
}

// Every leaf path has a row, and every default shown comes from DEFAULTS.
const leaves = schemaLeaves(schema);
assert.ok(leaves.length > 50, "schema has many leaves");
for (const {path, node} of leaves) {
  const row = rows.get(path);
  assert.ok(row, `leaf path ${path} appears as a table row`);
  const expected = defaultAt(DEFAULTS, path);
  if (expected.found) {
    assert.ok(
      row.default.includes(JSON.stringify(expected.value)),
      `${path} default comes from DEFAULTS (${JSON.stringify(expected.value)})`,
    );
    assert.deepEqual(defaultForPath(path, node), expected.value, `${path} default helper matches DEFAULTS`);
  } else if (Object.prototype.hasOwnProperty.call(node, "default")) {
    assert.ok(
      row.default.includes(JSON.stringify(node.default)),
      `${path} falls back to its schema default (${JSON.stringify(node.default)})`,
    );
  } else {
    assert.equal(row.default, "—", `${path} has no default, so the cell is empty`);
  }
  assert.ok(row.description.length > 0, `${path} has a description`);
}

// Enum settings list their allowed values.
for (const [path, values] of [
  ["project.planning_framework", ["auto", "standalone", "speckit", "gsd"]],
  ["runtime.mode", ["auto", "linux-strong", "wsl2-strong", "windows-compatibility"]],
  ["tests.browser", ["native", "playwright", "both"]],
  ["roles.planner.cli", ["claude", "opencode"]],
]) {
  const row = rows.get(path);
  assert.ok(row, `enum row ${path} exists`);
  for (const value of values) {
    assert.ok(row.allowed.includes(JSON.stringify(value)), `${path} allowed values include ${value}`);
  }
}

// Minimum settings render their lower bound.
for (const path of ["caps.planner.max_turns", "retries.escalate_after_not_fixed", "advanced.handoff_max_chars"]) {
  const row = rows.get(path);
  assert.ok(row, `minimum row ${path} exists`);
  assert.ok(row.allowed.includes(">="), `${path} renders its minimum`);
}

// The schema default is used for metadata keys outside DEFAULTS.
assert.equal(defaultForPath("$schema", schema.properties.$schema), "./config.schema.json");
assert.equal(defaultForPath("schema_version", schema.properties.schema_version), "4.0");
assert.equal(defaultForPath("roles.planner.fallbacks[].cli", schema.properties.roles.properties.planner.properties.fallbacks.items.properties.cli), undefined);

console.log("PASS config-reference-render");
