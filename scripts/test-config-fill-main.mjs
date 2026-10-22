#!/usr/bin/env node
// Mission 097 Phase 2 task 2.7: the config-fill CLI entry point resolves the
// config from --repo (or the cwd) and forwards --dry-run to fillConfigFile.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { main } from "./config-fill.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-config-fill-main-"));
const originalCwd = process.cwd();
const partial = {
  $schema: "./config.schema.json",
  schema_version: "4.0",
  project: { repo: "/tmp/demo" },
};

function writeRepo(name) {
  const repo = path.join(root, name);
  const file = path.join(repo, ".autopilot", "config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(partial, null, 2)}\n`);
  return { repo, file };
}

function backups(file) {
  return fs.readdirSync(path.dirname(file)).filter((entry) => entry.startsWith(`${path.basename(file)}.bak-`));
}

function captureLog(fn) {
  const lines = [];
  const original = console.log;
  const originalError = console.error;
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    return { code: fn(), lines };
  } finally {
    console.log = original;
    console.error = originalError;
  }
}

try {
  // --repo targets <repo>/.autopilot/config.json.
  const byRepo = writeRepo("by-repo");
  const originalRaw = fs.readFileSync(byRepo.file, "utf8");
  const repoRun = captureLog(() => main(["--repo", byRepo.repo]));
  assert.equal(repoRun.code, 0, "--repo run succeeds");
  assert.ok(repoRun.lines.some((line) => line.includes("project.")), "added paths are printed");
  const repoDisk = JSON.parse(fs.readFileSync(byRepo.file, "utf8"));
  assert.notEqual(repoDisk.project.repo, ".", "missing defaults are filled");
  assert.equal(repoDisk.project.repo, "/tmp/demo", "operator values survive");
  assert.notEqual(fs.readFileSync(byRepo.file, "utf8"), originalRaw, "--repo writes the config");
  assert.equal(backups(byRepo.file).length, 1, "--repo creates one backup");

  // --dry-run forwards true and writes nothing.
  const dry = writeRepo("dry");
  const dryRaw = fs.readFileSync(dry.file, "utf8");
  const dryRun = captureLog(() => main(["--dry-run", "--repo", dry.repo]));
  assert.equal(dryRun.code, 0, "dry run succeeds");
  assert.ok(dryRun.lines.some((line) => line.includes("project.")), "dry run prints what would change");
  assert.equal(fs.readFileSync(dry.file, "utf8"), dryRaw, "dry run leaves the config untouched");
  assert.deepEqual(backups(dry.file), [], "dry run creates no backup");

  // No arguments target the cwd repo.
  const cwd = writeRepo("cwd");
  const cwdRaw = fs.readFileSync(cwd.file, "utf8");
  process.chdir(cwd.repo);
  let cwdRun;
  try {
    cwdRun = captureLog(() => main([]));
  } finally {
    process.chdir(originalCwd);
  }
  assert.equal(cwdRun.code, 0, "no-argument run succeeds");
  assert.notEqual(fs.readFileSync(cwd.file, "utf8"), cwdRaw, "no arguments fill the cwd repo config");
  assert.equal(JSON.parse(fs.readFileSync(cwd.file, "utf8")).project.repo, "/tmp/demo", "cwd repo values survive");

  // Bad arguments and a missing config fail without throwing.
  assert.equal(captureLog(() => main(["--bogus"])).code, 2, "unknown argument exits 2");
  assert.equal(captureLog(() => main(["--repo"])).code, 2, "missing --repo value exits 2");
  assert.equal(captureLog(() => main(["--repo", path.join(root, "nope")])).code, 1, "missing config exits 1");
} finally {
  process.chdir(originalCwd);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("PASS config-fill-main");
