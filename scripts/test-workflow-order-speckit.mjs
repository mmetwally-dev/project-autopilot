#!/usr/bin/env node
// Behavioral proof (required test #7) that ordinary/SpecKit phase execution
// requires the Code Reviewer to run and PASS before gates/Verifier start.
// Drives a real `node scripts/autopilot.mjs run` subprocess against a
// disposable SpecKit fixture repo and a fake adapter CLI, then asserts the
// OBSERVED role-invocation order recorded in each relay's result.json.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {makeFixtureRepo, makeFixtureBin, makeSpecKitPhaseFixture, setScenario, writeConfig, runAutopilot, readObservedEvents, cleanup} from "./test-fixtures/workflow-order-harness.mjs";

let failures = 0;
function check(name, condition) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
}

const repo = makeFixtureRepo("speckit");
const binDir = makeFixtureBin("speckit");
const marker = path.join(repo, "speckit-verify-marker.txt");
try {
  makeSpecKitPhaseFixture(repo);
  // TASK 16.3B: network_isolation:true (the harness default) requires Linux
  // `unshare` (scripts/shell-guard.mjs's networkIsolationPrefix()), which
  // does not exist on Native Windows — decideExecution() then permanently
  // refuses this gate command there (fail-closed, by design, not a bug).
  // This test asserts gate-command ORDERING relative to Code Review, not
  // network-isolation enforcement, so disabling isolation only on the
  // platform where it can never be satisfied changes no assertion here and
  // leaves WSL/Linux behavior (network_isolation:true) untouched.
  // TASK 16.3C2: guarded-command.mjs's Windows branch now invokes cmd.exe
  // via the same `/d /s /c "<command>"` + windowsVerbatimArguments contract
  // Node uses internally for shell:true, so a real quoted Windows path with
  // backslashes (`>> "C:\...\marker.txt"`) executes correctly — the
  // forward-slash workaround this test previously needed is gone. Quoting
  // also keeps the path out of shell-guard.mjs's hasSuspiciousShellEscapes()
  // unquoted-backslash heuristic, which only scans outside quoted regions.
  const gateCommand = `echo ran >> "${marker}"`;
  writeConfig(repo, {planningFramework: "speckit", gatesCommands: [gateCommand], networkIsolation: process.platform !== "win32"});
  setScenario(repo, "success");
  // TASK 16.3B: this mission's ~14-15 real subprocess launches (5 preflight
  // --version probes + 3 planner + 3 reviewer planning-stage calls +
  // implementer + code_reviewer + verifier + the gate command + the final
  // code_reviewer) complete in ~93s measured directly on Native Windows
  // (repeatable, zero retries, zero errors) against the original 90000ms
  // budget tuned for WSL/Linux's much lower per-spawn overhead — timing is
  // the sole, conclusively measured cause of the prior Windows timeout, not
  // a hang (see the identical Windows process-spawn-overhead finding this
  // budget already documents for other missions). 180000ms leaves ample
  // margin above the measured time without masking a real hang were one to
  // reappear; WSL/Linux completes in well under a fraction of this and is
  // unaffected.
  const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: process.platform === "win32" ? 180000 : 90000});
  const events = readObservedEvents(repo);
  const order = events.map(e => `${e.role}:${e.decision || e.status}`);
  console.log(`observed order: ${order.join(" -> ")}`);

  check("SpecKit/ordinary: mission completed (exit 0)", run.status === 0);

  const codeReviewerIndex = events.findIndex(e => e.role === "code_reviewer" && e.decision === "PASS");
  const verifierIndex = events.findIndex(e => e.role === "verifier");
  check("SpecKit/ordinary: a code_reviewer PASS was observed", codeReviewerIndex !== -1);
  check("SpecKit/ordinary: verifier ran after a code_reviewer PASS", verifierIndex !== -1 && verifierIndex > codeReviewerIndex);
  check("SpecKit/ordinary: verifier PASSed", verifierIndex !== -1 && events[verifierIndex].decision === "PASS");

  const gateRanBeforeReview = fs.existsSync(marker)
    ? fs.statSync(marker).mtimeMs < Date.parse(events[codeReviewerIndex]?.startedAt || 0)
    : false;
  check("SpecKit/ordinary: no gate command ran before Code Review PASS", !gateRanBeforeReview);
  check("SpecKit/ordinary: gate command ran only after Code Review PASS", fs.existsSync(marker));
} finally {
  cleanup(repo, binDir);
}

if (failures) {
  console.error(`${failures} workflow-order (SpecKit) check(s) failed.`);
  process.exit(1);
}
console.log("workflow-order SpecKit behavioral test passed");
