#!/usr/bin/env node
// Suite live-file guard (#19): the helper test-all.mjs uses to prove no test
// migrated the real repository's .autopilot/config.json. state.json is not
// watched because the orchestrator legitimately writes it while the suite
// (its phase gate) runs. Fixtures live under $TMPDIR, never the project repo.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  snapshotLiveFiles,
  changedLiveFiles,
  suiteGuardLine,
  LIVE_GUARD_META_FILE,
} from "./suite-live-file-guard.mjs";

let ran = 0;
let failed = 0;
function check(name, fn) {
  ran++;
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name} :: ${error?.message || String(error)}`);
  }
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suite-live-file-guard-"));
  fs.mkdirSync(path.join(root, ".autopilot"), { recursive: true });
  fs.writeFileSync(path.join(root, ".autopilot", "config.json"), JSON.stringify({ version: 1 }));
  fs.writeFileSync(path.join(root, ".autopilot", "state.json"), JSON.stringify({ phase: "planning" }));
  return root;
}

const roots = [];
function repo() {
  const root = makeRepo();
  roots.push(root);
  return root;
}

try {
  check("unchanged files report no change", () => {
    const root = repo();
    const before = snapshotLiveFiles(root);
    assert.deepEqual(changedLiveFiles(root, before, snapshotLiveFiles(root)), []);
  });

  check("changed config is reported", () => {
    const root = repo();
    const before = snapshotLiveFiles(root);
    fs.writeFileSync(path.join(root, ".autopilot", "config.json"), JSON.stringify({ version: 2 }));
    const changed = changedLiveFiles(root, before, snapshotLiveFiles(root));
    assert.deepEqual(changed, [path.join(root, ".autopilot", "config.json")]);
    assert.match(suiteGuardLine(changed[0]), /SUITE GUARD: a test modified the live repository file .*config\.json/);
  });

  check("new config.meta.json is reported", () => {
    const root = repo();
    const before = snapshotLiveFiles(root);
    fs.writeFileSync(path.join(root, ".autopilot", LIVE_GUARD_META_FILE), JSON.stringify({ migrated: true }));
    const changed = changedLiveFiles(root, before, snapshotLiveFiles(root));
    assert.deepEqual(changed, [path.join(root, ".autopilot", LIVE_GUARD_META_FILE)]);
  });

  check("state.json changed → NOT reported", () => {
    const root = repo();
    const before = snapshotLiveFiles(root);
    fs.writeFileSync(path.join(root, ".autopilot", "state.json"), JSON.stringify({ phase: "implementing" }));
    const changed = changedLiveFiles(root, before, snapshotLiveFiles(root));
    assert.deepEqual(changed, []);
  });

  check("missing files are fine", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "suite-live-file-guard-empty-"));
    roots.push(root);
    const before = snapshotLiveFiles(root);
    assert.deepEqual(before.hashed, { "config.json": null });
    assert.equal(before.metaExists, false);
    assert.deepEqual(changedLiveFiles(root, before, snapshotLiveFiles(root)), []);
  });

  check("deleted config is reported", () => {
    const root = repo();
    const before = snapshotLiveFiles(root);
    fs.rmSync(path.join(root, ".autopilot", "config.json"));
    const changed = changedLiveFiles(root, before, snapshotLiveFiles(root));
    assert.deepEqual(changed, [path.join(root, ".autopilot", "config.json")]);
  });
} finally {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${ran - failed}/${ran} passed`);
if (failed > 0) process.exit(1);
