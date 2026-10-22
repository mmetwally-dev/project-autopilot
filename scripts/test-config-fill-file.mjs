#!/usr/bin/env node
// Mission 097 Phase 2 task 2.5: fillConfigFile completes a config on disk,
// backs it up first, and is inert on --dry-run or when nothing is missing.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULTS } from "./config-layout.mjs";
import { fillConfigFile, fillLayout } from "./config-fill.mjs";
import { loadAndMigrateConfig } from "./config-migration.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-config-fill-file-"));

function writeConfig(name, value) {
  const file = path.join(root, name, ".autopilot", "config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function backups(file) {
  return fs.readdirSync(path.dirname(file)).filter((entry) => entry.startsWith(`${path.basename(file)}.bak-`));
}

function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    return { result: fn(), lines };
  } finally {
    console.log = original;
  }
}

const partial = {
  $schema: "./config.schema.json",
  schema_version: "4.0",
  project: { repo: "/tmp/demo" },
  roles: { planner: { cli: "codex", model: "planner-model" }, free_models: { auto_fallback: false } },
  runtime: {},
};

try {
  // A partial config gains the defaults, and the original is backed up.
  const file = writeConfig("partial", partial);
  const originalRaw = fs.readFileSync(file, "utf8");
  assert.deepEqual(backups(file), [], "no backup before fill");

  const { result, lines } = captureLog(() => fillConfigFile(file));

  assert.equal(result.changed, true, "fill reports a change");
  assert.equal(result.written, true, "fill reports a write");
  assert.ok(result.added.length > 0, "added paths are reported");
  assert.ok(result.added.some((entry) => entry.startsWith("safety.")), "a missing section path is reported");
  assert.ok(lines.some((line) => line.includes("safety.")), "added paths are printed");

  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(onDisk, fillLayout(partial, file), "the file gains every missing default");
  assert.equal(onDisk.project.repo, "/tmp/demo", "operator values survive");
  assert.equal(onDisk.roles.planner.model, "planner-model", "nested operator values survive");
  assert.deepEqual(onDisk.roles.free_models, { auto_fallback: false, max_turns: DEFAULTS.roles.free_models.max_turns }, "a partial section is completed");
  assert.deepEqual(onDisk.runtime, {}, "an empty runtime stays empty");

  const backupNames = backups(file);
  assert.equal(backupNames.length, 1, "exactly one backup is written");
  assert.match(backupNames[0], /^config\.json\.bak-\d+$/, "backup name is config.json.bak-<time>");
  assert.equal(fs.readFileSync(path.join(path.dirname(file), backupNames[0]), "utf8"), originalRaw, "the backup matches the original bytes");
  assert.equal(result.backupPath, path.join(path.dirname(file), backupNames[0]), "the result names the backup");

  // Dry run prints but writes nothing and creates no backup.
  const dryFile = writeConfig("dry", partial);
  const dryRaw = fs.readFileSync(dryFile, "utf8");
  const dry = captureLog(() => fillConfigFile(dryFile, { dryRun: true }));
  assert.equal(dry.result.changed, true, "dry run still reports what would change");
  assert.equal(dry.result.written, false, "dry run does not write");
  assert.equal(dry.result.backupPath, null, "dry run has no backup path");
  assert.ok(dry.lines.some((line) => line.includes("safety.")), "dry run prints added paths");
  assert.equal(fs.readFileSync(dryFile, "utf8"), dryRaw, "dry run leaves the file untouched");
  assert.deepEqual(backups(dryFile), [], "dry run creates no backup");

  // An already-complete config is left alone: no write and no backup.
  const completeFile = path.join(root, "complete", ".autopilot", "config.json");
  fs.mkdirSync(path.dirname(completeFile), { recursive: true });
  fs.writeFileSync(completeFile, `${JSON.stringify(fillLayout(partial, completeFile), null, 2)}\n`);
  const completeRaw = fs.readFileSync(completeFile, "utf8");
  const complete = captureLog(() => fillConfigFile(completeFile));
  assert.equal(complete.result.changed, false, "complete config reports no change");
  assert.equal(complete.result.written, false, "complete config is not written");
  assert.deepEqual(complete.result.added, [], "complete config reports no added paths");
  assert.equal(complete.lines.length, 0, "complete config prints nothing");
  assert.equal(fs.readFileSync(completeFile, "utf8"), completeRaw, "complete config bytes are unchanged");
  assert.deepEqual(backups(completeFile), [], "complete config gets no backup");

  // Filling a v3 config migrates first, preserving operator values.
  const v3Config = {
    schema_version: "3.1",
    policy: {
      max_plan_revisions: 3,
      per_task_max_turns: 30,
    },
    execution: {
      runtime_mode: "linux-strong",
    },
    project: {
      repo: "/custom/repo",
      planning_framework: "standalone",
    },
  };
  const v3File = writeConfig("v3", v3Config);
  const v3Result = captureLog(() => fillConfigFile(v3File));
  assert.equal(v3Result.result.changed, true, "v3 fill reports a change");
  assert.equal(v3Result.result.written, true, "v3 fill writes the migrated config");

  const v3OnDisk = JSON.parse(fs.readFileSync(v3File, "utf8"));
  // After migration + fill, schema_version should be 4.0
  assert.equal(v3OnDisk.schema_version, "4.0", "v3 config is migrated to schema_version 4.0");
  // Operator values should be preserved
  assert.equal(v3OnDisk.retries.plan_revisions, 3, "operator max_plan_revisions preserved as retries.plan_revisions");
  assert.equal(v3OnDisk.runtime.mode, "linux-strong", "operator runtime_mode preserved");
  // The migration should have filled in defaults for missing sections
  assert.ok(v3OnDisk.caps, "caps section added by migration/fill");
  assert.ok(v3OnDisk.safety, "safety section added by migration/fill");
  // And loadAndMigrateConfig should now report no further changes
  const reload = loadAndMigrateConfig(v3File, { persist: false });
  assert.equal(reload.changed, false, "loadAndMigrateConfig reports no further changes after fill");
  assert.equal(reload.config.policy.max_plan_revisions, 3, "operator max_plan_revisions survives reload");
  assert.equal(reload.config.execution.runtime_mode, "linux-strong", "operator runtime_mode survives reload");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("PASS config-fill-file");
