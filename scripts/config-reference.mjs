#!/usr/bin/env node
// Mission 097 Phase 3 task 3.1: render the human-readable configuration
// reference from the generated schema, one markdown table per config section.
//
// The schema carries the descriptions and the allowed values; the default
// column is read from the real DEFAULTS table (falling back to the schema
// default for metadata keys such as `$schema` that have no runtime default).
//
// Run: node scripts/config-reference.mjs   (prints the reference to stdout)

import { pathToFileURL } from "node:url";
import { buildConfigSchema } from "./gen-config-schema.mjs";
import { DEFAULTS } from "./config-layout.mjs";

// A node is a table leaf when it has no child properties. Arrays are leaves
// unless their item schema is an object (fallback entries), whose properties
// are flattened with a `[]` segment.
export function schemaLeaves(schema) {
  const leaves = [];
  function walk(node, path) {
    if (!node || typeof node !== "object") return;
    if (node.properties) {
      for (const [key, child] of Object.entries(node.properties)) {
        walk(child, path ? `${path}.${key}` : key);
      }
      return;
    }
    if (node.type === "array" && node.items && node.items.type === "object" && node.items.properties) {
      for (const [key, child] of Object.entries(node.items.properties)) {
        walk(child, `${path}[].${key}`);
      }
      return;
    }
    leaves.push({path, node});
  }
  walk(schema, "");
  return leaves;
}

function valueAtPath(root, path) {
  let current = root;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return {found: false};
    if (segment.endsWith("[]")) {
      const key = segment.slice(0, -2);
      if (!Array.isArray(current[key])) return {found: false};
      // The shipped defaults have no fallback entries, so item leaves have no
      // default unless DEFAULTS gains some.
      if (current[key].length === 0) return {found: false};
      current = current[key][0];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return {found: false};
    current = current[segment];
  }
  return {found: true, value: current};
}

export function defaultForPath(path, node) {
  const fromDefaults = valueAtPath(DEFAULTS, path);
  if (fromDefaults.found) return fromDefaults.value;
  return node && Object.prototype.hasOwnProperty.call(node, "default") ? node.default : undefined;
}

function escapeCell(text) {
  return String(text).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function renderValue(value) {
  if (value === undefined) return "—";
  return `\`${escapeCell(JSON.stringify(value))}\``;
}

function renderAllowed(node) {
  const parts = [];
  if (Array.isArray(node.enum)) {
    for (const value of node.enum) parts.push(`\`${escapeCell(JSON.stringify(value))}\``);
  }
  if (Object.prototype.hasOwnProperty.call(node, "const")) {
    parts.push(`\`${escapeCell(JSON.stringify(node.const))}\``);
  }
  if (node.minimum !== undefined) parts.push(`>= ${node.minimum}`);
  return parts.length ? parts.join(", ") : "—";
}

function renderTable(leaves) {
  const lines = [
    "| Setting | Default | Allowed values | Description |",
    "| --- | --- | --- | --- |",
  ];
  for (const {path, node} of leaves) {
    const setting = `\`${escapeCell(path)}\``;
    const defaultValue = renderValue(defaultForPath(path, node));
    const allowed = renderAllowed(node);
    const description = escapeCell(node.description || "");
    lines.push(`| ${setting} | ${defaultValue} | ${allowed} | ${description} |`);
  }
  return lines.join("\n");
}

/**
 * Render the full `## Configuration reference` section.
 *
 * @param {object} [schema] generated config schema (tests may pass a custom one)
 * @returns {string} markdown ending with a trailing newline
 */
export function renderConfigReference(schema = buildConfigSchema()) {
  const blocks = [
    "## Configuration reference",
    "",
    "Generated from `config.schema.json` by `node scripts/gen-config-schema.mjs`; do not edit by hand.",
  ];
  for (const [section, node] of Object.entries(schema.properties || {})) {
    blocks.push("", `### ${section}`, "");
    if (node.description) blocks.push(node.description, "");
    blocks.push(renderTable(schemaLeaves({type: "object", properties: {[section]: node}})));
  }
  return `${blocks.join("\n")}\n`;
}

function main() {
  process.stdout.write(renderConfigReference());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
