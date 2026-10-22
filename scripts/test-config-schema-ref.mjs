#!/usr/bin/env node
// Mission 097 Phase 2 task 2.1: the `$schema` written into a config must
// resolve from that config's directory, not from wherever `ap` happens to run.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  schemaReferenceFor,
  schemaReferenceResolves,
} from "./config-schema-ref.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// A config inside this repo (the skill tree) gets a short relative reference.
const repoConfig = join(ROOT, ".autopilot", "config.json");
const repoRef = schemaReferenceFor(repoConfig);
assert.equal(repoRef, "../config.schema.json", "same-tree config gets ../config.schema.json");
assert.ok(schemaReferenceResolves(repoRef, dirname(repoConfig)), "the relative reference resolves to the shipped schema");
assert.ok(!repoRef.includes("\\"), "relative references use forward slashes");
assert.ok(!isAbsolute(repoRef), "same-tree reference stays relative");

// A nested config elsewhere still resolves, and never uses backslashes.
const scratch = mkdtempSync(join(tmpdir(), "ap-schema-ref-"));
try {
  const nestedConfig = join(scratch, "repo", ".autopilot", "config.json");
  mkdirSync(dirname(nestedConfig), { recursive: true });
  const nestedRef = schemaReferenceFor(nestedConfig);
  assert.ok(!nestedRef.includes("\\"), "nested relative reference uses forward slashes");
  assert.ok(schemaReferenceResolves(nestedRef, dirname(nestedConfig)), "nested relative reference resolves from its directory");

  // Simulated different drive/root: must be a file:// URL that resolves.
  const crossRef = schemaReferenceFor(nestedConfig, { forceFileUrl: true });
  assert.ok(crossRef.startsWith("file://"), `different-drive reference is a file:// URL (got ${crossRef})`);
  assert.ok(schemaReferenceResolves(crossRef, dirname(nestedConfig)), "file:// reference resolves to the schema");

  // A reference that does not exist is rejected instead of silently accepted.
  assert.equal(schemaReferenceResolves("./missing.schema.json", dirname(nestedConfig)), false, "missing relative reference does not resolve");
  assert.equal(schemaReferenceResolves("https://example.com/config.schema.json", dirname(nestedConfig)), false, "remote URL does not resolve as a local file");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log("PASS config-schema-ref");
