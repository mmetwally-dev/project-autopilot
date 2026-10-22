#!/usr/bin/env node
// Mission 097 Phase 2 task 2.6: fill repairs `$schema` so it resolves from the
// config's own directory, puts it first, and leaves a correct reference alone.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fillConfigFile, fillLayout } from "./config-fill.mjs";
import { schemaReferenceFor, schemaReferenceResolves } from "./config-schema-ref.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-config-fill-schema-"));

function writeConfig(name, value) {
  const file = path.join(root, name, ".autopilot", "config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function read(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

try {
  // A wrong `./config.schema.json` in a nested config is replaced by a
  // reference that resolves from the config's directory and sits first.
  const wrongFile = writeConfig("nested/wrong", { $schema: "./config.schema.json", schema_version: "4.0" });
  const wrong = fillConfigFile(wrongFile);
  const wrongLayout = read(wrongFile);

  assert.equal(wrong.changed, true, "a wrong schema reference is a change");
  assert.equal(wrong.written, true, "the repaired config is written");
  assert.equal(wrongLayout.$schema, schemaReferenceFor(wrongFile), "the reference is computed for the config path");
  assert.notEqual(wrongLayout.$schema, "./config.schema.json", "the wrong reference is replaced");
  assert.equal(schemaReferenceResolves(wrongLayout.$schema, path.dirname(wrongFile)), true, "the new reference resolves from the config directory");
  assert.equal(Object.keys(wrongLayout)[0], "$schema", "$schema is first");

  // A $schema pointing to a non-schema file (e.g., ./config.json) is replaced.
  const nonSchemaFile = writeConfig("nested/non-schema", { $schema: "./config.json", schema_version: "4.0" });
  // Create a dummy config.json at that location so the old check would have passed.
  fs.writeFileSync(path.join(path.dirname(nonSchemaFile), "config.json"), "{}");
  const nonSchema = fillConfigFile(nonSchemaFile);
  const nonSchemaLayout = read(nonSchemaFile);
  assert.equal(nonSchema.changed, true, "a $schema pointing to config.json is a change");
  assert.equal(nonSchema.written, true, "the repaired config is written");
  assert.equal(nonSchemaLayout.$schema, schemaReferenceFor(nonSchemaFile), "the reference is computed for the config path");
  assert.notEqual(nonSchemaLayout.$schema, "./config.json", "the non-schema reference is replaced");
  assert.equal(schemaReferenceResolves(nonSchemaLayout.$schema, path.dirname(nonSchemaFile)), true, "the new reference resolves from the config directory");
  assert.equal(Object.keys(nonSchemaLayout)[0], "$schema", "$schema is first");

  // A correct reference is left exactly as written.
  const correctFile = path.join(root, "nested/correct", ".autopilot", "config.json");
  const correctRef = schemaReferenceFor(correctFile);
  fs.mkdirSync(path.dirname(correctFile), { recursive: true });
  const complete = fillLayout({ $schema: correctRef, schema_version: "4.0" }, correctFile);
  fs.writeFileSync(correctFile, `${JSON.stringify(complete, null, 2)}\n`);
  const before = fs.readFileSync(correctFile, "utf8");

  const untouched = fillConfigFile(correctFile);
  assert.equal(untouched.changed, false, "a correct reference reports no change");
  assert.equal(untouched.written, false, "a correct reference is not rewritten");
  assert.equal(read(correctFile).$schema, correctRef, "the correct reference is unchanged");
  assert.equal(fs.readFileSync(correctFile, "utf8"), before, "the file bytes are unchanged");

  // A missing reference is added in first position.
  const missingFile = writeConfig("nested/missing", { schema_version: "4.0" });
  fillConfigFile(missingFile);
  const missingLayout = read(missingFile);
  assert.equal(missingLayout.$schema, schemaReferenceFor(missingFile), "a missing reference is added");
  assert.equal(Object.keys(missingLayout)[0], "$schema", "an added $schema is first");
  assert.equal(schemaReferenceResolves(missingLayout.$schema, path.dirname(missingFile)), true, "the added reference resolves");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("PASS config-fill-schema");
