#!/usr/bin/env node
// Regression test for the fixed guardLogUnavailable rule in
// scripts/autopilot.mjs's makeRelayResult(): an empty Git-guard log is
// valid evidence that a well-behaved read-only role never attempted a Git
// mutation, and must not itself be a policy violation. Only a guard log
// that could not be READ at all is unreliable evidence.
//
// autopilot.mjs is a top-level CLI script (main() runs unconditionally at
// import time), not a unit-testable module, so this drives the REAL,
// unchanged relay-guards.mjs primitives (createGitMutationGuard, guardedEnv,
// gitSnapshot, readGuardLog, touchedFilesBetween) against real git repos and
// mirrors the current (fixed) makeRelayResult cascade — the exact same
// five-line decision now in scripts/autopilot.mjs — over that real data.
// The formula below is kept in lockstep with the source; if the source
// changes, this comment is the reminder to update it too.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import {createGitMutationGuard, guardedEnv, gitSnapshot, readGuardLog, touchedFilesBetween} from "./relay-guards.mjs";

let failures = 0;
function check(name, condition) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
}

function git(cwd, args, env = withoutOuterGitGuard(process.env)) {
  return spawnSync("git", args, {cwd, encoding: "utf8", env, shell: false});
}

function makeRepo(prefix) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `ap-guardlog-${prefix}-`));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "guardlog-test@example.invalid"]);
  git(repo, ["config", "user.name", "Guard Log Test"]);
  fs.writeFileSync(path.join(repo, "file.txt"), "base\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

// Mirrors scripts/autopilot.mjs's makeRelayResult() decision exactly (as of
// the guardLogUnavailable fix) over real guard/snapshot data.
function decide({guardLogFile, before, after, readOnly, touchedFiles}) {
  let guardEvents;
  let guardLogReadable = true;
  try { guardEvents = readGuardLog(guardLogFile); }
  catch { guardEvents = []; guardLogReadable = false; }
  const refsChanged = before.refs !== after.refs;
  const administrativeGitStateChanged = before.headSymbolic !== after.headSymbolic
    || refsChanged
    || JSON.stringify(before.config) !== JSON.stringify(after.config)
    || before.sequencer !== after.sequencer
    || before.reflogs !== after.reflogs
    || before.objects !== after.objects
    || before.indexState !== after.indexState
    || before.hooksDigest !== after.hooksDigest
    || before.administrativeDigest !== after.administrativeDigest;
  const commitDetected = before.head !== after.head || administrativeGitStateChanged;
  const gitMutationAttempted = guardEvents.length > 0 || commitDetected;
  const guardLogUnavailable = !guardLogReadable; // the fixed rule
  const readOnlyViolation = !!(readOnly && before.fingerprint !== after.fingerprint && touchedFiles.length > 0);
  let policyViolation = null;
  if (commitDetected) policyViolation = "git_commit_detected";
  else if (gitMutationAttempted) policyViolation = "git_mutation_blocked";
  else if (guardLogUnavailable) policyViolation = "guard_log_unavailable";
  else if (readOnlyViolation) policyViolation = "read_only_violation";
  return {policyViolation, guardLogUnavailable, gitMutationAttempted, commitDetected, guardEventsCount: guardEvents.length};
}

// ---- 1. Benign read-only role, no Git command attempted ----
{
  const repo = makeRepo("benign");
  try {
    const scratch = path.join(repo, ".autopilot", "runs", "01-plan_reviewer-aaaa1111");
    fs.mkdirSync(scratch, {recursive: true});
    const guard = createGitMutationGuard(scratch, repo);
    const before = gitSnapshot(repo);
    const after = gitSnapshot(repo); // nothing happened between snapshots
    const touched = touchedFilesBetween(before, after, repo);
    const result = decide({guardLogFile: guard.logFile, before, after, readOnly: true, touchedFiles: touched});
    check("benign read-only role: guardEvents is empty", result.guardEventsCount === 0);
    check("benign read-only role: guardLogUnavailable is false", result.guardLogUnavailable === false);
    check("benign read-only role: no policyViolation occurs", result.policyViolation === null);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
  }
}

// ---- 2. A blocked Git mutation: produces a guard event, remains a policy
//      violation ----
{
  const repo = makeRepo("blocked");
  try {
    const scratch = path.join(repo, ".autopilot", "runs", "02-code_reviewer-bbbb2222");
    fs.mkdirSync(scratch, {recursive: true});
    const guard = createGitMutationGuard(scratch, repo);
    const before = gitSnapshot(repo);
    const attempt = git(repo, ["commit", "--allow-empty", "-m", "blocked"], guardedEnv(guard));
    const after = gitSnapshot(repo);
    const touched = touchedFilesBetween(before, after, repo);
    const result = decide({guardLogFile: guard.logFile, before, after, readOnly: true, touchedFiles: touched});
    check("blocked git mutation: the commit attempt itself did not succeed", attempt.status !== 0);
    check("blocked git mutation: produced at least one guard event", result.guardEventsCount > 0);
    check("blocked git mutation: repository state is actually unchanged", result.commitDetected === false);
    check("blocked git mutation: remains a policy violation (git_mutation_blocked)", result.policyViolation === "git_mutation_blocked");
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
  }
}

// ---- 3. A real ref/HEAD/repository mutation remains detected even if the
//      guard log is empty (e.g. the guard was never engaged for this
//      particular git invocation) ----
{
  const repo = makeRepo("realmutation");
  try {
    const scratch = path.join(repo, ".autopilot", "runs", "03-verifier-cccc3333");
    fs.mkdirSync(scratch, {recursive: true});
    const guard = createGitMutationGuard(scratch, repo); // created, but never used below
    const before = gitSnapshot(repo);
    // Mutate directly with the real, unguarded environment — the guard log
    // for THIS guard instance stays empty regardless.
    const real = git(repo, ["commit", "--allow-empty", "-m", "real mutation, guard bypassed"]);
    const after = gitSnapshot(repo);
    const touched = touchedFilesBetween(before, after, repo);
    const result = decide({guardLogFile: guard.logFile, before, after, readOnly: true, touchedFiles: touched});
    check("real mutation: the direct commit actually succeeded", real.status === 0);
    check("real mutation: guard log is empty for this guard instance", result.guardEventsCount === 0);
    check("real mutation: still detected via before/after Git snapshot (commitDetected)", result.commitDetected === true);
    check("real mutation: remains a policy violation (git_commit_detected) despite the empty guard log", result.policyViolation === "git_commit_detected");
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
  }
}

// ---- 4. A genuinely unreadable guard log: sets guardLogUnavailable=true,
//      remains a policy violation ----
{
  const repo = makeRepo("unreadable");
  try {
    const before = gitSnapshot(repo);
    const after = gitSnapshot(repo);
    const touched = touchedFilesBetween(before, after, repo);
    // A directory where readGuardLog expects a file: fs.readFileSync throws
    // EISDIR, so guardLogReadable becomes false regardless of guardEvents.
    const unreadable = path.join(repo, "not-a-file-guard-log");
    fs.mkdirSync(unreadable, {recursive: true});
    const result = decide({guardLogFile: unreadable, before, after, readOnly: true, touchedFiles: touched});
    check("unreadable guard log: guardLogUnavailable is true", result.guardLogUnavailable === true);
    check("unreadable guard log: remains a policy violation (guard_log_unavailable)", result.policyViolation === "guard_log_unavailable");
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
  }
}

if (failures) {
  console.error(`${failures} guard-log-availability check(s) failed.`);
  process.exit(1);
}
console.log("guard-log-availability regression tests passed");
