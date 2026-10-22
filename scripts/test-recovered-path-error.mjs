#!/usr/bin/env node
// TASK 13 / Problem A behavioral proof: a real Codex-style Implementer
// attempted to read docs/AUTOPILOT-SMOKE-TEST-NEW.md before it existed
// (expected before a later task), got "No such file or directory" (exit 2
// from the `cat`/`Get-Content` it ran), correctly recognized the file was
// not required yet, recovered, and the ADAPTER PROCESS itself still exited
// 0 with a successful final message. Despite that, result.json contained
// failure.class = PATH_UNSUPPORTED — because
// scripts/failure-contract.mjs's classifyObservedFailure() only treated a
// recovered path error as non-fatal when `validReviewSentinel === true`,
// and Implementer relays never produce a review sentinel at all (they are
// not review roles), so the gate could never open for them.
//
// The fix widens that gate to the SAME authority classifyObservedFailure()
// already gives the adapter process's own exit code everywhere else in
// this function (PROCESS_EXIT_NONZERO, PROCESS_START_FAILED): exitCode===0
// with no start error and no timeout is itself trustworthy completion
// evidence, for any role, sentinel or not.
//
// This file proves, via the REAL relay path (a real `node scripts/
// autopilot.mjs run` subprocess, the real "cursor" no-driver adapter
// transport, and the real (unmodified, imported) classifyObservedFailure()
// function used by scripts/autopilot.mjs's makeRelayResult()):
//   - the recovered-path-error Implementer completes with failure: null;
//   - a GENUINELY unrecovered path failure (same text, nonzero exit) still
//     classifies as PATH_UNSUPPORTED;
//   - a genuine process failure unrelated to path text still fails;
//   - a genuine policy violation (Git mutation attempt) still fails despite
//     exit 0 and no path-error text at all;
//   - a reviewer role with a missing/malformed review sentinel still fails,
//     even when the SAME incidental path-error text is mixed into its
//     output — proving the fix did not rescue reviewer-contract violations;
//   - the production classifyObservedFailure() function itself (imported,
//     not reimplemented) still returns TIMEOUT / PROCESS_START_FAILED for
//     genuine timeout/start-failure evidence, which cannot be reproduced
//     deterministically through a real subprocess without a slow/flaky test.
import fs from "node:fs";
import path from "node:path";
import {makeFixtureRepo, makeFixtureBin, setScenario, writeConfig, runAutopilot, readObservedEvents, cleanup} from "./test-fixtures/workflow-order-harness.mjs";
import {classifyObservedFailure} from "./failure-contract.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${detail ? " -- " + detail : ""}`); }
}

function readResults(repo) {
  const root = path.join(repo, ".autopilot");
  const files = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "result.json") files.push(full);
    }
  })(root);
  return files.map(f => JSON.parse(fs.readFileSync(f, "utf8")));
}
function firstFor(results, role) {
  const matches = results.filter(r => r.role === role)
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  return matches[0] || null;
}

// Sections 1-5 run on all platforms: bubblewrap on Linux/WSL2, the Windows
// disposable copy for standalone.

// ---------------------------------------------------------------------
// 1. The real observed bug: a recovered path error must not override a
//    genuinely successful Implementer completion.
// ---------------------------------------------------------------------
{
  const repo = makeFixtureRepo("recovered-path");
  const binDir = makeFixtureBin("recovered-path");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    setScenario(repo, "implementer_recovered_path_error");
    const run = runAutopilot(repo, binDir, {request: "implement the fixture task"});
    const results = readResults(repo);
    const impl = firstFor(results, "implementer");

    check("recovered path error: implementer result.json produced", impl != null,
      `run.status=${run.status} stderr=${run.stderr.slice(-800)}`);
    if (impl) {
      check("recovered path error: implementer status is completed", impl.status === "completed", JSON.stringify(impl).slice(0, 800));
      check("recovered path error: implementer failure is null", impl.failure === null, JSON.stringify(impl.failure));
    }
    check("recovered path error: mission completed end to end (exit 0)", run.status === 0);
  } finally {
    cleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// 2. Genuine, UNRECOVERED path failure (same text, nonzero exit) must
//    still classify as PATH_UNSUPPORTED — the fix must not blind detection
//    of a real path failure.
// ---------------------------------------------------------------------
{
  const repo = makeFixtureRepo("unrecovered-path");
  const binDir = makeFixtureBin("unrecovered-path");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    setScenario(repo, "implementer_unrecovered_path_error");
    const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: 30000});
    const results = readResults(repo);
    const impl = firstFor(results, "implementer");

    check("unrecovered path error: implementer result.json produced", impl != null);
    if (impl) {
      check("unrecovered path error: implementer status is failed", impl.status !== "completed", JSON.stringify(impl).slice(0, 800));
      check("unrecovered path error: failure class is PATH_UNSUPPORTED", impl.failure?.class === "PATH_UNSUPPORTED", JSON.stringify(impl.failure));
    }
  } finally {
    cleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// 3. A genuine process failure unrelated to any path text must still fail.
// ---------------------------------------------------------------------
{
  const repo = makeFixtureRepo("genuine-failure");
  const binDir = makeFixtureBin("genuine-failure");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    setScenario(repo, "implementer_genuine_failure");
    runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: 30000});
    const results = readResults(repo);
    const impl = firstFor(results, "implementer");

    check("genuine failure: implementer result.json produced", impl != null);
    if (impl) {
      check("genuine failure: implementer status is failed", impl.status !== "completed", JSON.stringify(impl).slice(0, 800));
      check("genuine failure: failure class is PROCESS_EXIT_NONZERO", impl.failure?.class === "PROCESS_EXIT_NONZERO", JSON.stringify(impl.failure));
    }
  } finally {
    cleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// 4. A genuine policy violation (Git mutation attempt) must still fail
//    despite exit 0 and no path-error text at all — proving the fix did
//    not weaken policy enforcement.
// ---------------------------------------------------------------------
{
  const repo = makeFixtureRepo("policy-violation");
  const binDir = makeFixtureBin("policy-violation");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    setScenario(repo, "implementer_policy_violation");
    runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: 30000});
    const results = readResults(repo);
    const impl = firstFor(results, "implementer");

    check("policy violation: implementer result.json produced", impl != null);
    if (impl) {
      check("policy violation: implementer status is failed despite exit 0", impl.status !== "completed", JSON.stringify(impl).slice(0, 800));
      // The Git mutation guard actively blocks the commit attempt (rather
      // than letting it land and detecting it after the fact), so the
      // observed policy violation is git_mutation_blocked, not
      // git_commit_detected — either way, it must still be a failure.
      check("policy violation: policy.violation is git_mutation_blocked", impl.policy?.violation === "git_mutation_blocked", JSON.stringify(impl.policy));
      check("policy violation: failure class is GIT_MUTATION_BLOCKED", impl.failure?.class === "GIT_MUTATION_BLOCKED", JSON.stringify(impl.failure));
    }
  } finally {
    cleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// 5. A reviewer role with a missing/malformed review sentinel must still
//    fail, even with the SAME incidental path-error text mixed in — the
//    fix must not rescue a genuine reviewer-contract violation.
// ---------------------------------------------------------------------
{
  const repo = makeFixtureRepo("reviewer-missing-sentinel");
  const binDir = makeFixtureBin("reviewer-missing-sentinel");
  try {
    writeConfig(repo, {planningFramework: "standalone", maxPlanRevisions: 1});
    setScenario(repo, "plan_review_missing_sentinel_with_path_error");
    runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: 30000});
    const results = readResults(repo);
    const pr = firstFor(results, "plan_reviewer");

    check("reviewer missing sentinel: plan_reviewer result.json produced", pr != null);
    if (pr) {
      check("reviewer missing sentinel: NOT reported as completed+PASS despite the path-error text",
        !(pr.status === "completed" && pr.verdict?.decision === "PASS"), JSON.stringify(pr.verdict));
      check("reviewer missing sentinel: review contract reports an error", !!pr.contract?.error, JSON.stringify(pr.contract));
    }
  } finally {
    cleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// 6. Direct proof against the REAL, imported classifyObservedFailure()
//    (not a reimplementation) for evidence shapes a real subprocess
//    cannot reproduce deterministically without a slow/flaky test:
//    timeout and process-start failure. These mirror exactly the
//    parameter shapes scripts/autopilot.mjs's makeRelayResult() passes
//    (exitCode:p.status, startError:p.error, timedOut:p.timedOut).
// ---------------------------------------------------------------------
{
  const timeout = classifyObservedFailure({exitCode: null, stdout: "", stderr: "", startError: null, timedOut: true, evidence: []});
  check("direct: timeout still classifies as TIMEOUT", timeout?.class === "TIMEOUT", JSON.stringify(timeout));

  const startFailed = classifyObservedFailure({exitCode: null, stdout: "", stderr: "", startError: "spawn ENOENT", timedOut: false, evidence: []});
  check("direct: process start failure still classifies as PROCESS_START_FAILED", startFailed?.class === "PROCESS_START_FAILED", JSON.stringify(startFailed));

  // The exact bug shape at the unit level: no validReviewSentinel field at
  // all (as autopilot.mjs never sends one any more, and as it always was
  // for a non-review Implementer relay), exit 0, recovered path-error text.
  // In stdout (the model's own output channel) — must never be scanned at
  // all, for any exit code, so this is null regardless of the driverless
  // text fallback rather than because of the exit-0 gate specifically.
  const recovered = classifyObservedFailure({
    exitCode: 0, stdout: "cat: docs/AUTOPILOT-SMOKE-TEST-NEW.md: No such file or directory\nimplementer ok",
    stderr: "", startError: null, timedOut: false, evidence: [], driverless: true
  });
  check("direct: recovered path error with exit 0 and no sentinel classifies as no failure", recovered === null, JSON.stringify(recovered));

  // The genuine, unrecovered case: same text, but on STDERR (a driverless
  // adapter's only trustworthy failure channel — classifyObservedFailure()
  // never scans stdout, at any exit code, for any adapter) and a nonzero
  // exit. Must still classify as PATH_UNSUPPORTED.
  const unrecovered = classifyObservedFailure({
    exitCode: 2, stdout: "", stderr: "cat: docs/AUTOPILOT-SMOKE-TEST-NEW.md: No such file or directory",
    startError: null, timedOut: false, evidence: [], driverless: true
  });
  check("direct: unrecovered path error (stderr, nonzero exit) still classifies as PATH_UNSUPPORTED", unrecovered?.class === "PATH_UNSUPPORTED", JSON.stringify(unrecovered));

  // The identical incidental text on STDOUT instead of stderr, with the
  // same nonzero exit, must never be recognized AS A PATH ERROR — stdout is
  // never scanned, at any exit code, for any adapter. The exit code alone
  // still makes this a generic PROCESS_EXIT_NONZERO (retryable, unlike the
  // non-retryable PATH_UNSUPPORTED the stdout text would have produced
  // before this fix) — this is what actually caused Run 28's false
  // PATH_UNSUPPORTED: the real cause was a rate limit, and the incidental
  // stdout text was an unrelated, already-recovered tool result.
  const stdoutNeverScannedAsPath = classifyObservedFailure({
    exitCode: 2, stdout: "cat: docs/AUTOPILOT-SMOKE-TEST-NEW.md: No such file or directory",
    stderr: "", startError: null, timedOut: false, evidence: [], driverless: true
  });
  check("direct: the SAME text on stdout instead of stderr is never recognized as PATH_UNSUPPORTED",
    stdoutNeverScannedAsPath?.class === "PROCESS_EXIT_NONZERO", JSON.stringify(stdoutNeverScannedAsPath));

  // The same stderr path text, but for an adapter WITH a driver (driverless:
  // false) — process-level stderr is scanned for every adapter on nonzero
  // exit (stdout never is). Tool exploration output lives in stdout JSON
  // events, never in process stderr, so this cannot mistake exploration
  // for a terminal error the way the old stdout scan did (Run 28).
  const driverHavingStderrPath = classifyObservedFailure({
    exitCode: 2, stdout: "", stderr: "cat: docs/AUTOPILOT-SMOKE-TEST-NEW.md: No such file or directory",
    startError: null, timedOut: false, evidence: [], driverless: false
  });
  check("direct: a driver-having adapter's nonzero-exit stderr path text classifies as PATH_UNSUPPORTED",
    driverHavingStderrPath?.class === "PATH_UNSUPPORTED", JSON.stringify(driverHavingStderrPath));
}

if (failures) {
  console.error(`${failures} recovered-path-error check(s) failed.`);
  process.exit(1);
}
console.log("recovered Implementer path error behavioral tests passed");
