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

  cleanup();
  console.log("PASS test-gate-baseline-locality");
}

main().catch((error) => {
  cleanup();
  console.error(error);
  process.exit(1);
});
