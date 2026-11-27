#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULTS } from "./config-layout.mjs";
import { fillConfigFile, fillLayout } from "./config-fill.mjs";
import { migrateV4Caps } from "./config-migration.mjs";
import { FINAL_REVIEW_FIX_ROUNDS_DEFAULT } from "./per-task-budget.mjs";

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail === undefined ? "" : ` :: ${JSON.stringify(detail)}`}`);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-test-b8-"));

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

try {
  // 1. New defaults in fresh config
  check("code constant: FINAL_REVIEW_FIX_ROUNDS_DEFAULT is 3", FINAL_REVIEW_FIX_ROUNDS_DEFAULT === 3, FINAL_REVIEW_FIX_ROUNDS_DEFAULT);
  check("DEFAULTS.retries.implementation is 5", DEFAULTS.retries.implementation === 5, DEFAULTS.retries.implementation);
  check("DEFAULTS.retries.verification is 5", DEFAULTS.retries.verification === 5, DEFAULTS.retries.verification);
  check("DEFAULTS.retries.final_review_fix_rounds is 3", DEFAULTS.retries.final_review_fix_rounds === 3, DEFAULTS.retries.final_review_fix_rounds);
  check("DEFAULTS.retries.escalate_after_not_fixed is 3", DEFAULTS.retries.escalate_after_not_fixed === 3, DEFAULTS.retries.escalate_after_not_fixed);

  const fresh = fillLayout({});
  check("fresh layout gains implementation 5", fresh.retries.implementation === 5, fresh.retries);
  check("fresh layout gains verification 5", fresh.retries.verification === 5, fresh.retries);
  check("fresh layout gains final_review_fix_rounds 3", fresh.retries.final_review_fix_rounds === 3, fresh.retries);
  check("fresh layout gains escalate_after_not_fixed 3", fresh.retries.escalate_after_not_fixed === 3, fresh.retries);

  // 2. migrateV4Caps moves old shipped defaults
  const oldShipped = {
    schema_version: "4.0",
    retries: {
      implementation: 4,
      verification: 4,
      final_review_fix_rounds: 2,
      escalate_after_not_fixed: 2,
    },
  };
  const migrated = migrateV4Caps(oldShipped);
  check("migrateV4Caps marks changed for old defaults", migrated.changed === true, migrated);
  check("migrateV4Caps moved implementation to 5", migrated.layout.retries.implementation === 5, migrated.layout.retries);
  check("migrateV4Caps moved verification to 5", migrated.layout.retries.verification === 5, migrated.layout.retries);
  check("migrateV4Caps moved final_review_fix_rounds to 3", migrated.layout.retries.final_review_fix_rounds === 3, migrated.layout.retries);
  check("migrateV4Caps moved escalate_after_not_fixed to 3", migrated.layout.retries.escalate_after_not_fixed === 3, migrated.layout.retries);
  check("migrateV4Caps records 4 changes", migrated.changes.length === 4, migrated.changes);

  // 3. fill leaves custom values alone
  const custom = {
    schema_version: "4.0",
    retries: {
      implementation: 7,
      verification: 6,
      final_review_fix_rounds: 4,
      escalate_after_not_fixed: 1,
    },
  };
  const customMigrated = migrateV4Caps(custom);
  check("migrateV4Caps leaves custom values unchanged", customMigrated.changed === false, customMigrated);
  check("custom implementation 7 preserved", customMigrated.layout.retries.implementation === 7, customMigrated.layout.retries);
  check("custom verification 6 preserved", customMigrated.layout.retries.verification === 6, customMigrated.layout.retries);
  check("custom final_review_fix_rounds 4 preserved", customMigrated.layout.retries.final_review_fix_rounds === 4, customMigrated.layout.retries);
  check("custom escalate_after_not_fixed 1 preserved", customMigrated.layout.retries.escalate_after_not_fixed === 1, customMigrated.layout.retries);

  // 4. fillConfigFile end-to-end moves old defaults and prints `~ path old -> new`
  const configFile = path.join(tmpDir, ".autopilot", "config.json");
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(oldShipped, null, 2) + "\n");

  const { result, lines } = captureLog(() => fillConfigFile(configFile));
  check("fillConfigFile reports changed", result.changed === true, result);
  check("fillConfigFile reports written", result.written === true, result);
  check("log prints ~ retries.implementation 4 -> 5", lines.includes("~ retries.implementation 4 -> 5"), lines);
  check("log prints ~ retries.verification 4 -> 5", lines.includes("~ retries.verification 4 -> 5"), lines);
  check("log prints ~ retries.final_review_fix_rounds 2 -> 3", lines.includes("~ retries.final_review_fix_rounds 2 -> 3"), lines);
  check("log prints ~ retries.escalate_after_not_fixed 2 -> 3", lines.includes("~ retries.escalate_after_not_fixed 2 -> 3"), lines);

  const onDisk = JSON.parse(fs.readFileSync(configFile, "utf8"));
  check("onDisk implementation is 5", onDisk.retries.implementation === 5, onDisk.retries);
  check("onDisk verification is 5", onDisk.retries.verification === 5, onDisk.retries);
  check("onDisk final_review_fix_rounds is 3", onDisk.retries.final_review_fix_rounds === 3, onDisk.retries);
  check("onDisk escalate_after_not_fixed is 3", onDisk.retries.escalate_after_not_fixed === 3, onDisk.retries);

  // 5. fillConfigFile on custom value does not change it
  const customConfigFile = path.join(tmpDir, "custom", ".autopilot", "config.json");
  fs.mkdirSync(path.dirname(customConfigFile), { recursive: true });
  fs.writeFileSync(customConfigFile, JSON.stringify(custom, null, 2) + "\n");
  const { lines: customLines } = captureLog(() => fillConfigFile(customConfigFile));
  const customOnDisk = JSON.parse(fs.readFileSync(customConfigFile, "utf8"));
  check("custom onDisk implementation is still 7", customOnDisk.retries.implementation === 7, customOnDisk.retries);
  check("custom onDisk verification is still 6", customOnDisk.retries.verification === 6, customOnDisk.retries);
  check("custom onDisk final_review_fix_rounds is still 4", customOnDisk.retries.final_review_fix_rounds === 4, customOnDisk.retries);
  check("custom onDisk escalate_after_not_fixed is still 1", customOnDisk.retries.escalate_after_not_fixed === 1, customOnDisk.retries);
  check("no ~ retries lines printed for custom values", !customLines.some((l) => l.includes("~ retries.")), customLines);

} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
