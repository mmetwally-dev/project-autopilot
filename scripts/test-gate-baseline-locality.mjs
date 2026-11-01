#!/usr/bin/env node
// Backlog #215: before escalating "all gate failures outside the delta",
// failing gate files are re-run once on a clean phase-baseline copy.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {
  GATE_BASELINE_MAX_FILES,
  checkGateBaseline,
  resolveGateTestFile,
  runBaselineTest,
} from "./gate-baseline-locality.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const scratch = path.join(repo, ".autopilot", "scratch", `test-gate-baseline-${process.pid}`);
const failures = (count) => Array.from({length: count}, (_, index) => ({file: `scripts/test-${index}.mjs`}));

function cleanup() {
  fs.rmSync(scratch, {recursive: true, force: true});
}

async function main() {
  cleanup();

  // A pass on the baseline proves the failure is this phase's regression.
  {
    const seen = [];
    const result = await checkGateBaseline({
      repo,
      baselineKey: "key",
      failures: failures(2),
      scratchRoot: scratch,
      makeId: () => "one",
      materialize: async ({dest}) => {
        seen.push(dest);
        fs.mkdirSync(dest, {recursive: true});
      },
      runTest: async ({file}) => ({passed: file === "scripts/test-1.mjs"}),
    });
    assert.equal(result.outcome, "pass");
    assert.equal(result.passingFile, "scripts/test-1.mjs");
    assert.equal(result.attempts.length, 2);
    assert.equal(seen.length, 2, "each file gets a fresh baseline copy");
    assert.equal(fs.existsSync(scratch), true, "scratch root is created");
    assert.deepEqual(fs.readdirSync(scratch), [], "the copy is removed afterwards");
  }

  // Every file failing on the baseline is real evidence for escalation.
  {
    const result = await checkGateBaseline({
      repo,
      baselineKey: "key",
      failures: failures(3),
      scratchRoot: scratch,
      makeId: () => "two",
      materialize: async ({dest}) => fs.mkdirSync(dest, {recursive: true}),
      runTest: async () => ({passed: false, status: 1}),
    });
    assert.equal(result.outcome, "all-fail");
    assert.equal(result.attempts.length, 3);
  }

  // Bounded: never more than five files.
  {
    let runs = 0;
    const result = await checkGateBaseline({
      repo,
      baselineKey: "key",
      failures: failures(9),
      scratchRoot: scratch,
      makeId: () => "three",
      materialize: async ({dest}) => fs.mkdirSync(dest, {recursive: true}),
      runTest: async () => {
        runs += 1;
        return {passed: false};
      },
    });
    assert.equal(GATE_BASELINE_MAX_FILES, 5);
    assert.equal(runs, GATE_BASELINE_MAX_FILES);
    assert.equal(result.attempts.length, GATE_BASELINE_MAX_FILES);
  }

  // Any preparation/run error fails open to the normal fix round.
  {
    const result = await checkGateBaseline({
      repo,
      baselineKey: "key",
      failures: failures(1),
      scratchRoot: scratch,
      makeId: () => "four",
      materialize: async () => {
        throw new Error("baseline missing");
      },
    });
    assert.equal(result.outcome, "error");
    assert.match(result.error, /baseline missing/);
    assert.deepEqual(fs.readdirSync(scratch), [], "a failed copy is removed");
  }

  // Missing inputs are an error, not a false escalation.
  {
    const result = await checkGateBaseline({repo, baselineKey: "", failures: failures(1), scratchRoot: scratch});
    assert.equal(result.outcome, "error");
    assert.equal(result.attempts.length, 0);
  }

  // Backlog #5: resolveGateTestFile resolutions.
  {
    let listCalled = false;
    const r1 = resolveGateTestFile({
      repo: "/fake/repo",
      file: "scripts/test-a.mjs",
      exists: (p) => p === path.resolve("/fake/repo", "scripts/test-a.mjs"),
      listTracked: () => { listCalled = true; return []; },
    });
    assert.equal(r1, "scripts/test-a.mjs");
    assert.equal(listCalled, false, "listTracked is not called when file exists");

    const r2 = resolveGateTestFile({
      repo: "/fake/repo",
      file: "test-config-schema.mjs",
      exists: () => false,
      listTracked: () => ["package.json", "scripts/test-config-schema.mjs", "src/index.js"],
    });
    assert.equal(r2, "scripts/test-config-schema.mjs");

    const r3 = resolveGateTestFile({
      repo: "/fake/repo",
      file: "test-duplicate.mjs",
      exists: () => false,
      listTracked: () => ["scripts/test-duplicate.mjs", "tests/test-duplicate.mjs"],
    });
    assert.equal(r3, "test-duplicate.mjs");

    const r4 = resolveGateTestFile({
      repo: "/fake/repo",
      file: "test-missing.mjs",
      exists: () => false,
      listTracked: () => ["scripts/test-config-schema.mjs"],
    });
    assert.equal(r4, "test-missing.mjs");

    let searched = false;
    const r5 = resolveGateTestFile({
      repo: "/fake/repo",
      file: "nonexistent/test-a.mjs",
      exists: () => false,
      listTracked: () => { searched = true; return ["scripts/test-a.mjs"]; },
    });
    assert.equal(r5, "nonexistent/test-a.mjs");
    assert.equal(searched, false, "name containing '/' is never searched");
  }

  // Backlog #5: runBaselineTest with missing file returns missing:true without spawning.
  {
    const spawned = [];
    const result = await runBaselineTest({
      cwd: scratch,
      file: "nonexistent-test.mjs",
      timeoutMs: 1000,
      spawnFn: (...args) => { spawned.push(args); },
    });
    assert.equal(result.missing, true);
    assert.equal(result.passed, false);
    assert.equal(spawned.length, 0, "spawnFn was never called");
  }

  // Backlog #5: checkGateBaseline with missing file returns error, not all-fail.
  {
    const result = await checkGateBaseline({
      repo,
      baselineKey: "key",
      failures: [{file: "scripts/test-missing.mjs"}],
      scratchRoot: scratch,
      makeId: () => "missing-test",
      materialize: async ({dest}) => fs.mkdirSync(dest, {recursive: true}),
      runTest: async () => ({passed: false, missing: true}),
    });
    assert.equal(result.outcome, "error");
    assert.match(result.error, /test file not found in the baseline copy: scripts\/test-missing\.mjs/);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].file, "scripts/test-missing.mjs");
    assert.equal(result.attempts[0].passed, false);
  }

  // Backlog #5: mission 102 end-to-end regression.
  {
    const tempDir = path.join(scratch, "e2e-mission-102");
    fs.mkdirSync(path.join(tempDir, "scripts"), {recursive: true});
    const testScript = path.join(tempDir, "scripts", "test-x.mjs");
    fs.writeFileSync(testScript, "process.exit(0);\n");

    const passRes = await runBaselineTest({cwd: tempDir, file: "scripts/test-x.mjs", timeoutMs: 5000});
    assert.equal(passRes.passed, true);
    assert.equal(passRes.missing, undefined);

    const missingRes = await runBaselineTest({cwd: tempDir, file: "test-x.mjs", timeoutMs: 5000});
    assert.equal(missingRes.missing, true);
    assert.equal(missingRes.passed, false);

    fs.rmSync(tempDir, {recursive: true, force: true});
  }

  cleanup();
  console.log("PASS test-gate-baseline-locality");
}

main().catch((error) => {
  cleanup();
  console.error(error);
  process.exit(1);
});
