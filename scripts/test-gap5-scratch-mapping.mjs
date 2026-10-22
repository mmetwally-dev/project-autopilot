#!/usr/bin/env node
// Focused regression test for the mapPathIntoEnvelope() specificity fix
// (execution-envelope.mjs): a run's scratch directory is always nested
// inside the repository (.autopilot/runs/...), so scratch containment must
// be checked BEFORE repository containment — otherwise every scratch path
// is also a repository path and repository always wins, silently mapping
// writable-scratch paths (e.g. the Git guard log) onto the read-only
// repository bind instead ("Gap 5"). This test does not touch bwrap mounts,
// permissions, or any other containment behavior — only the specificity of
// this one path-mapping helper.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {mapPathIntoEnvelope, mapEnvironmentIntoEnvelope} from "./execution-envelope.mjs";

let failures = 0;
function check(name, condition) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
}

const repo = path.resolve(path.join(path.sep === "\\" ? "C:\\fixture" : "/fixture", "repo"));
const scratch = path.join(repo, ".autopilot", "runs", "01-plan_reviewer-abcdef12");
const envelope = {available: true, sandbox: {repository: "/workspace/repository", scratch: "/workspace/scratch"}};

// ---- 1. A path inside nested scratch maps to /workspace/scratch/<rel> ----
{
  const guardLog = path.join(scratch, "git-guard", "blocked.log");
  const mapped = mapPathIntoEnvelope(guardLog, envelope, repo, scratch);
  check("nested scratch path maps under /workspace/scratch", mapped === "/workspace/scratch/git-guard/blocked.log");
}

// ---- 2. The Git guard log path inside scratch maps to the writable
//      scratch mount, specifically via the full env mapping used by the
//      real relay launch (mapEnvironmentIntoEnvelope) ----
{
  const guardLog = path.join(scratch, "git-guard", "blocked.log");
  const mappedEnv = mapEnvironmentIntoEnvelope({AUTOPILOT_GIT_GUARD_LOG: guardLog}, envelope, repo, scratch);
  check("AUTOPILOT_GIT_GUARD_LOG maps under /workspace/scratch (writable), not /workspace/repository (read-only)",
    mappedEnv.AUTOPILOT_GIT_GUARD_LOG === "/workspace/scratch/git-guard/blocked.log");
}

// ---- 3. A normal repository path outside scratch maps to
//      /workspace/repository/<rel> ----
{
  const productionFile = path.join(repo, "src", "app.js");
  const mapped = mapPathIntoEnvelope(productionFile, envelope, repo, scratch);
  check("ordinary repository path (outside scratch) maps under /workspace/repository", mapped === "/workspace/repository/src/app.js");
}

// ---- 4. A sibling or prefix-lookalike path does not incorrectly map as
//      scratch (path-prefix matching must be component-aware, not a bare
//      string prefix test) ----
{
  // ".autopilot/runs/01-plan_reviewer-abcdef12-lookalike" is NOT inside
  // ".autopilot/runs/01-plan_reviewer-abcdef12" even though the raw string
  // has it as a text prefix.
  const lookalike = path.join(repo, ".autopilot", "runs", "01-plan_reviewer-abcdef12-lookalike", "file.txt");
  const mapped = mapPathIntoEnvelope(lookalike, envelope, repo, scratch);
  check("a prefix-lookalike sibling directory is NOT mapped as scratch", mapped !== "/workspace/scratch/file.txt");
  check("a prefix-lookalike sibling directory still correctly maps under repository (its real containing scope)",
    mapped === "/workspace/repository/.autopilot/runs/01-plan_reviewer-abcdef12-lookalike/file.txt");

  // A true sibling run directory (different run id) must also resolve to
  // repository, not scratch.
  const siblingRun = path.join(repo, ".autopilot", "runs", "02-code_reviewer-11111111", "git-guard", "blocked.log");
  const mappedSibling = mapPathIntoEnvelope(siblingRun, envelope, repo, scratch);
  check("a sibling run's scratch directory is not mapped as THIS run's scratch", mappedSibling !== "/workspace/scratch/git-guard/blocked.log");
}

// ---- 5. The real read-only role no longer produces guard_log_unavailable
//      solely because the guard log is nested under .autopilot: reproduce
//      relay-guards.mjs's actual guard-log path shape (real directories, so
//      createGitMutationGuard's real filesystem setup succeeds) and confirm
//      it now maps to scratch (writable), which is the precondition
//      makeRelayResult's guardLogUnavailable check depends on (an event
//      logged there is now observable instead of silently dropped). ----
{
  const realRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-gap5-repo-"));
  const realScratch = path.join(realRepo, ".autopilot", "runs", "01-plan_reviewer-abcdef12");
  fs.mkdirSync(realScratch, {recursive: true});
  try {
    const {createGitMutationGuard, guardedEnv} = await import("./relay-guards.mjs");
    const guard = createGitMutationGuard(realScratch, realRepo);
    const guardedLaunchEnv = guardedEnv(guard);
    const realEnvelope = {available: true, sandbox: {repository: "/workspace/repository", scratch: "/workspace/scratch"}};
    const mappedEnv = mapEnvironmentIntoEnvelope(guardedLaunchEnv, realEnvelope, realRepo, realScratch);
    const realGuardLogRelativeToScratch = path.relative(realScratch, guard.logFile);
    check("relay-guards.mjs's real guard.logFile is itself inside the run's own scratch directory",
      !realGuardLogRelativeToScratch.startsWith("..") && !path.isAbsolute(realGuardLogRelativeToScratch));
    check("the real AUTOPILOT_GIT_GUARD_LOG env var (as actually launched) maps under /workspace/scratch, not /workspace/repository",
      typeof mappedEnv.AUTOPILOT_GIT_GUARD_LOG === "string" && mappedEnv.AUTOPILOT_GIT_GUARD_LOG.startsWith("/workspace/scratch/"));
  } finally {
    fs.rmSync(realRepo, {recursive: true, force: true});
  }
}

if (failures) {
  console.error(`${failures} Gap-5 scratch-mapping check(s) failed.`);
  process.exit(1);
}
console.log("Gap-5 scratch-before-repository mapping regression tests passed");
