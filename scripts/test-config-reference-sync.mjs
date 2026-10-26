#!/usr/bin/env node
// Mission 097 Phase 3 task 3.2: the docs configuration reference is generated
// between markers and must stay equal to a fresh render. Regeneration may only
// replace the marked block; text outside the markers is hand-written.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderConfigReference } from "./config-reference.mjs";
import {
  CONFIG_REFERENCE_PATH,
  CONFIG_REFERENCE_START,
  CONFIG_REFERENCE_END,
  extractConfigReference,
  withConfigReference,
} from "./gen-config-schema.mjs";

const document = readFileSync(CONFIG_REFERENCE_PATH, "utf8");

assert.equal(document.split(CONFIG_REFERENCE_START).length, 2, "docs file has exactly one config-reference start marker");
assert.equal(document.split(CONFIG_REFERENCE_END).length, 2, "docs file has exactly one config-reference end marker");
assert.ok(
  document.indexOf(CONFIG_REFERENCE_START) < document.indexOf(CONFIG_REFERENCE_END),
  "config-reference markers are in start/end order",
);

const rendered = renderConfigReference();
assert.equal(extractConfigReference(document), rendered, "marked docs block equals a fresh render");
assert.equal(withConfigReference(document), document, "docs file is fully regenerated (regenerating is a no-op)");

// Regenerating with different content keeps everything outside the markers.
const start = document.indexOf(CONFIG_REFERENCE_START);
const end = document.indexOf(CONFIG_REFERENCE_END) + CONFIG_REFERENCE_END.length;
const prefix = document.slice(0, start);
const suffix = document.slice(end);
const regenerated = withConfigReference(document, "# stale placeholder\n");
assert.equal(regenerated.slice(0, prefix.length), prefix, "text before the markers is untouched");
assert.ok(regenerated.endsWith(suffix), "text after the markers is untouched");
assert.equal(extractConfigReference(regenerated), "# stale placeholder\n", "the marked block is replaced");
assert.equal(withConfigReference(regenerated, rendered), document, "regeneration restores the fresh render");

console.log("config-reference-sync ok");
