#!/usr/bin/env node
// 15.6J CORRECTION — a trusted blocked official-repository mutation must fail
// the relay even when the child swallows the Git failure and exits 0.
//
// Background: one Windows run of test-git-safe-symbolic-ref.mjs §5 showed a
// single official-scope reference-transaction denial inside a raw `opencode
// run` probe that still exited 0 with its file produced. That probe is a raw
// adapter spawn, NOT a production relay: it never passes through
// autopilot.mjs's makeRelayResult(), writes no result.json, and launches no
// later roles — so its harness-level "success" says nothing about the relay
// verdict. This file proves, through REAL `node scripts/autopilot.mjs run`
// missions (the workflow-order harness + fake adapter), that the production
// result path forces the required outcome:
//
//   1. Safe symbolic-ref query, zero blocked events → relay PASS.
//   2. External snapshot git init, zero official violation → relay PASS.
//   3. Child attempts an official ref mutation, is denied, exits 0 anyway →
//      relay FAIL: status failed, policyViolation git_mutation_blocked,
//      failure class GIT_MUTATION_BLOCKED.
//   4. Code Reviewer and Verifier never launch after case 3 (mission
//      escalates via relay_policy_violation instead).
//   5. Trusted evidence (gitGuardEvents) and child diagnostics (denial text
//      in the relay output) remain visible on the failed result.
//
// The mission sections need a POSIX adapter stub and read-only containment,
// so they run on Linux/WSL and SKIP on native Windows with reason (suite
// precedent). The verdict-unit section is platform-independent and always
// runs (it pins the exact production functions makeRelayResult() calls).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {makeFixtureRepo, makeFixtureBin, setScenario, setSnapshotDir, writeConfig, runAutopilot, cleanup, withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import {classifyObservedFailure} from "./failure-contract.mjs";
import {buildRuntimeResult} from "./agent-contract.mjs";

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
  return files.map((f) => ({file: f, data: JSON.parse(fs.readFileSync(f, "utf8"))}));
}
function firstFor(results, role) {
  const matches = results
    .filter((r) => (r.data.role || null) === role)
    .sort((a, b) => Date.parse(a.data.startedAt) - Date.parse(b.data.startedAt));
  return matches.length ? matches[0].data : null;
}
function rolesPresent(results) {
  return [...new Set(results.map((r) => r.data.role || "?"))].sort();
}
function readState(repo) {
  try { return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8")); }
  catch { return null; }
}

function gitOut(repo, args) {
  const r = spawnSync("git", args, {cwd: repo, encoding: "utf8", env: withoutOuterGitGuard(process.env), shell: false});
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout || "").trim();
}

if (process.platform === "win32") {
  console.log("SKIP mission sections: fake POSIX adapter + read-only containment require Linux/WSL (suite precedent)");
} else {
// ---------------------------------------------------------------------
// 1. Safe symbolic-ref query, zero blocked events → relay PASS, reviewers run.
// ---------------------------------------------------------------------
{
  const repo = makeFixtureRepo("correction-symref");
  const binDir = makeFixtureBin("correction-symref");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    setScenario(repo, "implementer_safe_symref_query");
    const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: 120000});
    const results = readResults(repo);
    const impl = firstFor(results, "implementer");
    check("safe-symref: mission completed end to end (exit 0)", run.status === 0, `run.status=${run.status}`);
    check("safe-symref: implementer result.json produced", impl != null);
    if (impl) {
      check("safe-symref: implementer status is completed", impl.status === "completed", impl.status);
      check("safe-symref: no policy violation", impl.policy?.violation == null, JSON.stringify(impl.policy));
      check("safe-symref: failure is null", impl.failure === null, JSON.stringify(impl.failure));
      check("safe-symref: zero guard events", (impl.gitGuardEvents || []).length === 0, JSON.stringify(impl.gitGuardEvents));
    }
    check("safe-symref: code_reviewer launched after success", firstFor(results, "code_reviewer") != null,
      rolesPresent(results).join(","));
    check("safe-symref: verifier launched after success", firstFor(results, "verifier") != null,
      rolesPresent(results).join(","));
  } finally {
    cleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// 2. External snapshot git init, zero official violation → relay PASS.
// ---------------------------------------------------------------------
{
  const repo = makeFixtureRepo("correction-extinit");
  const binDir = makeFixtureBin("correction-extinit");
  // CORRECTION-2/3 fixture A: unique test-owned snapshot directory, created
  // here (never a fixed global path) and supplied to the mission exclusively
  // through the committed override file the adapter actually reads (custom
  // mission-subprocess variables cannot cross the production child-env
  // filter by design — see runAutopilot). The strict cleanup in finally
  // targets exactly this directory, records any removal error as a failure
  // (no catch), and is verified gone.
  const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-156j-correction-snap-"));
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    setScenario(repo, "implementer_external_snapshot_init");
    setSnapshotDir(repo, snapDir);
    const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: 120000});
    const results = readResults(repo);
    const impl = firstFor(results, "implementer");
    check("ext-init: mission completed end to end (exit 0)", run.status === 0, `run.status=${run.status}`);
    check("ext-init: implementer result.json produced", impl != null);
    if (impl) {
      check("ext-init: implementer status is completed", impl.status === "completed", impl.status);
      check("ext-init: no policy violation", impl.policy?.violation == null, JSON.stringify(impl.policy));
      check("ext-init: zero guard events", (impl.gitGuardEvents || []).length === 0, JSON.stringify(impl.gitGuardEvents));
      const m = /SNAPDIR=(\S+)/.exec(impl.finalMessage || "");
      check("ext-init: snapshot dir reported", m != null);
      check("ext-init: adapter used exactly the supplied directory", m != null && m[1] === snapDir,
        m ? m[1] : "no match");
      check("ext-init: HEAD created in the external snapshot", m != null && m[1] === snapDir && fs.existsSync(path.join(snapDir, "HEAD")), snapDir);
    }
    // Strict cleanup of every exact test-owned directory inside finally, so
    // it runs for every scenario outcome (including an unexpected throw
    // from result parsing above). Each removal is attempted even if an
    // earlier one failed; every removal error is recorded as a test failure
    // (never swallowed); absence is asserted afterward. Never any path
    // derived from child output.
  } finally {
    const owned = [snapDir, repo, binDir];
    for (const target of owned) {
      try {
        fs.rmSync(target, {recursive: true, force: true});
      } catch (error) {
        check("ext-init: cleanup succeeded", false, `${target}: ${error?.message || error}`);
      }
    }
    for (const target of owned) {
      check("ext-init: owned directory removed after cleanup", !fs.existsSync(target), target);
    }
  }
}

// ---------------------------------------------------------------------
// 3+4+5. Exit-0-after-denial → FAIL with GIT_MUTATION_BLOCKED; no reviewer,
//    no verifier; evidence and diagnostics visible.
// ---------------------------------------------------------------------
{
  const repo = makeFixtureRepo("correction-denied");
  const binDir = makeFixtureBin("correction-denied");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    setScenario(repo, "implementer_exit_zero_after_denial");
    const refsBefore = gitOut(repo, ["for-each-ref", "--format=%(refname)%00%(objectname)"]);
    const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: 120000});
    const results = readResults(repo);
    const impl = firstFor(results, "implementer");
    check("denied: top-level ap run exits nonzero", run.status !== 0, `run.status=${run.status}`);
    check("denied: implementer result.json produced", impl != null, `run.status=${run.status}`);
    if (impl) {
      check("denied: child process itself exited 0 (deliberate)", impl.process?.exitCode === 0,
        JSON.stringify(impl.process));
      check("denied: relay status is failed despite exit 0", impl.status === "failed", impl.status);
      check("denied: policyViolation is git_mutation_blocked", impl.policy?.violation === "git_mutation_blocked",
        JSON.stringify(impl.policy));
      check("denied: failure class is GIT_MUTATION_BLOCKED", impl.failure?.class === "GIT_MUTATION_BLOCKED",
        JSON.stringify(impl.failure));
      const hookDenials = (impl.gitGuardEvents || []).filter((e) => e.hook === "reference-transaction");
      check("denied: trusted hook evidence preserved", hookDenials.length > 0, JSON.stringify(impl.gitGuardEvents));
      check("denied: evidence is official-scope", hookDenials.every((e) => e.scope === "official"),
        JSON.stringify(hookDenials));
      check("denied: child diagnostics visible in output", /AUTOPILOT GIT GUARD/.test(impl.finalMessage || ""),
        (impl.finalMessage || "").slice(-300));
      check("denied: HEAD unchanged", impl.gitHeadBefore === impl.gitHeadAfter,
        `${impl.gitHeadBefore} vs ${impl.gitHeadAfter}`);
    }
    check("denied: official refs unchanged", gitOut(repo, ["for-each-ref", "--format=%(refname)%00%(objectname)"]) === refsBefore);
    check("denied: code_reviewer never launched", firstFor(results, "code_reviewer") == null,
      rolesPresent(results).join(","));
    check("denied: verifier never launched", firstFor(results, "verifier") == null,
      rolesPresent(results).join(","));
    const state = readState(repo);
    check("denied: mission escalated via relay_policy_violation", state?.step === "relay_policy_violation",
      state ? `${state.phase}/${state.step}` : "no state.json");
  } finally {
    cleanup(repo, binDir);
  }
}
} // end POSIX-gated mission sections

// ---------------------------------------------------------------------
// Verdict units (all platforms): the exact production functions force the
// correction outcome for the exit-0-with-denial shape.
// ---------------------------------------------------------------------
{
  const denied = classifyObservedFailure({
    exitCode: 0, stdout: "implementer ok", stderr: "AUTOPILOT GIT GUARD: ref update blocked (reference-transaction)",
    startError: null, timedOut: false, policyViolation: "git_mutation_blocked", evidence: [],
  });
  check("units: exit-0 + git_mutation_blocked classifies GIT_MUTATION_BLOCKED", denied?.class === "GIT_MUTATION_BLOCKED",
    JSON.stringify(denied));
  const built = buildRuntimeResult({
    roleName: "implementer", role: {adapter: "cursor"}, adapterId: "cursor", adapter: {binary: "cursor-agent"},
    processResult: {status: 0, signal: null, error: null}, output: "implementer ok",
    invocation: {args: []}, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    sessionId: null, touchedFiles: [], policy: {violation: "git_mutation_blocked"},
    contract: {status: "not_required", error: null}, verdict: {status: "not_applicable", decision: null, findings: []},
    failure: denied, observations: [],
  });
  check("units: exit-0 + violation builds status failed", built.status === "failed", built.status);
  check("units: exit-0 + violation keeps failure class", built.failure?.class === "GIT_MUTATION_BLOCKED",
    JSON.stringify(built.failure));
  const clean = buildRuntimeResult({
    roleName: "implementer", role: {adapter: "cursor"}, adapterId: "cursor", adapter: {binary: "cursor-agent"},
    processResult: {status: 0, signal: null, error: null}, output: "implementer ok",
    invocation: {args: []}, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    sessionId: null, touchedFiles: [], policy: {violation: null},
    contract: {status: "not_required", error: null}, verdict: {status: "not_applicable", decision: null, findings: []},
    failure: null, observations: [],
  });
  check("units: exit-0 without violation still completes (no over-fail)", clean.status === "completed", clean.status);
}

if (failures) {
  console.error(`${failures} relay-verdict check(s) failed.`);
  process.exit(1);
}
console.log("relay git-mutation verdict behavioral tests passed");
