#!/usr/bin/env node
// `ap config fill` renames a present old time-limit name in place, keeps the
// value, and reports the rename; a dry run reports it without writing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fillConfigFile, fillLayout } from "./config-fill.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-config-fill-rename-"));

const OLD = "mission_timeout_minutes";
const NEW = "call_backstop_minutes";
const RENAME_LINE = `~ renamed time_limits.${OLD} -> time_limits.${NEW}`;

let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error && error.message ? error.message : error}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function configFile(name) {
  const file = path.join(root, name, ".autopilot", "config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

function baseLayout(file) {
  return fillLayout({ schema_version: "4.0" }, file);
}

function write(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return fs.readFileSync(file, "utf8");
}

function backups(file) {
  return fs.readdirSync(path.dirname(file)).filter((entry) => entry.startsWith(`${path.basename(file)}.bak-`));
}

function capture(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    return { result: fn(), lines };
  } finally {
    console.log = original;
  }
}

function withOldName(layout, value) {
  const timeLimits = {};
  for (const [key, entry] of Object.entries(layout.time_limits)) {
    timeLimits[key === NEW ? OLD : key] = key === NEW ? value : entry;
  }
  return { ...layout, time_limits: timeLimits };
}

try {
  check("old only: renamed in place, value kept, rename reported", () => {
    const file = configFile("old-only");
    const base = baseLayout(file);
    const oldLayout = withOldName(base, 125);
    const oldIndex = Object.keys(oldLayout.time_limits).indexOf(OLD);
    write(file, oldLayout);

    const { result, lines } = capture(() => fillConfigFile(file));
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));

    assert(result.changed === true, "reports a change");
    assert(result.written === true, "writes the config");
    assert(result.renamed.length === 1, "reports one rename");
    assert(result.renamed[0].from === `time_limits.${OLD}`, "reports the old path");
    assert(result.renamed[0].to === `time_limits.${NEW}`, "reports the new path");
    assert(!result.added.includes(`time_limits.${NEW}`), "the renamed key is not reported as added");
    assert(lines.includes(RENAME_LINE), `prints "${RENAME_LINE}"`);
    assert(!(OLD in onDisk.time_limits), "drops the old key");
    assert(onDisk.time_limits[NEW] === 125, "keeps the old value under the new key");
    assert(Object.keys(onDisk.time_limits).indexOf(NEW) === oldIndex, "the new key takes the old key's place");
    assert(backups(file).length === 1, "backs up the file before renaming");
  });

  check("both keys: keeps the new value and drops the old key", () => {
    const file = configFile("both");
    const base = baseLayout(file);
    const both = clone(base);
    both.time_limits = { ...base.time_limits, [OLD]: 125 };
    both.time_limits[NEW] = 200;
    write(file, both);

    const { result, lines } = capture(() => fillConfigFile(file));
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));

    assert(result.changed === true, "reports a change");
    assert(result.written === true, "writes the config");
    assert(lines.includes(RENAME_LINE), "reports the rename");
    assert(!(OLD in onDisk.time_limits), "drops the old key");
    assert(onDisk.time_limits[NEW] === 200, "keeps the new key's value");
  });

  check("dry run: reports the rename without writing", () => {
    const file = configFile("dry");
    const base = baseLayout(file);
    const before = write(file, withOldName(base, 125));

    const { result, lines } = capture(() => fillConfigFile(file, { dryRun: true }));

    assert(result.changed === true, "dry run reports what would change");
    assert(result.written === false, "dry run does not write");
    assert(result.backupPath === null, "dry run has no backup path");
    assert(lines.includes(RENAME_LINE), `dry run prints "${RENAME_LINE}"`);
    assert(fs.readFileSync(file, "utf8") === before, "dry run leaves the file untouched");
    assert(backups(file).length === 0, "dry run creates no backup");
    assert(OLD in JSON.parse(fs.readFileSync(file, "utf8")).time_limits, "old key stays on disk in dry run");
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`FAIL config-fill-rename (${failures} failed)`);
  process.exitCode = 1;
} else {
  console.log("PASS config-fill-rename");
}
