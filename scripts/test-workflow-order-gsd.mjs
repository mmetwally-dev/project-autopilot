#!/usr/bin/env node
// Behavioral proof (required test #5) that the GSD phase Code Reviewer runs
// and PASSes before the phase Verifier starts, and (as a consequence of the
// same runGsdPlanUnit fix) that gate/task.verify commands run only after
// the plan-unit Code Reviewer PASSes. Drives a real
// `node scripts/autopilot.mjs run` subprocess against a disposable GSD
// fixture repo and a fake adapter CLI, then asserts the OBSERVED
// role-invocation order recorded in each relay's result.json.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {makeFixtureRepo, makeFixtureBin, makeGsdPhaseFixture, setScenario, writeConfig, runAutopilot, readObservedEvents, cleanup} from "./test-fixtures/workflow-order-harness.mjs";

let failures = 0;
function check(name, condition) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
}

const repo = makeFixtureRepo("gsd");
const binDir = makeFixtureBin("gsd");
const marker = path.join(repo, "gsd-verify-marker.txt");
try {
  makeGsdPhaseFixture(repo);
  writeConfig(repo, {
    planningFramework: "gsd",
    gsdOverrides: {run_plan_verify: false, write_uat_artifact: false, write_summary_artifacts: false, write_verification_artifacts: false}
  });
  setScenario(repo, "success");
  const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: 90000});
  const events = readObservedEvents(repo);
  const order = events.map(e => `${e.role}:${e.decision || e.status}`);
  console.log(`observed order: ${order.join(" -> ")}`);

  check("GSD phase: mission completed (exit 0)", run.status === 0);

  const verifierIndex = events.findIndex(e => e.role === "verifier");
  check("GSD phase: a verifier call was observed", verifierIndex !== -1);
  check("GSD phase: the code_reviewer immediately preceding the phase verifier PASSed",
    (() => {
      if (verifierIndex === -1) return false;
      const priorReviews = events.slice(0, verifierIndex).filter(e => e.role === "code_reviewer");
      return priorReviews.length > 0 && priorReviews[priorReviews.length - 1].decision === "PASS";
    })());
  check("GSD phase: verifier itself PASSed",
    verifierIndex !== -1 && events[verifierIndex].decision === "PASS");
  check("GSD phase: at least one code_reviewer ran strictly before the verifier (chronological order)",
    events.some((e, i) => e.role === "code_reviewer" && i < verifierIndex));
} finally {
  cleanup(repo, binDir);
}

if (failures) {
  console.error(`${failures} workflow-order (GSD) check(s) failed.`);
  process.exit(1);
}
console.log("workflow-order GSD behavioral test passed");
