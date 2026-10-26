#!/usr/bin/env node
// Backlog #24: a git guard never logs into another guard's blocked.log.
// A guard created inside a guarded session inherits the outer
// AUTOPILOT_GIT_GUARD_LOG; the PATH shim must ignore it and write only to the
// blocked.log beside itself. The null device is the one honoured value.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {createGitMutationGuard, guardedEnv, readGuardLog} from "./relay-guards.mjs";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import {fixtureGit} from "./test-fixtures/fixture-git.mjs";

const IS_WIN = process.platform === "win32";
const NULL_DEVICE = IS_WIN ? "NUL" : "/dev/null";
const cleanEnv = withoutOuterGitGuard(process.env);

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ap-gli-")));
process.on("exit", () => { try { fs.rmSync(root, {recursive: true, force: true}); } catch { /* best-effort */ } });

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

function makeGuard(name) {
  const repo = path.join(root, `${name}-repo`);
  fs.mkdirSync(repo, {recursive: true});
  fixtureGit(["init", "-q"], {cwd: repo});
  fixtureGit(["config", "user.email", "t@example.invalid"], {cwd: repo});
  fixtureGit(["config", "user.name", "t"], {cwd: repo});
  fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
  fixtureGit(["add", "."], {cwd: repo});
  fixtureGit(["commit", "-q", "-m", "base"], {cwd: repo});
  const runDir = path.join(root, `${name}-run`);
  fs.mkdirSync(runDir, {recursive: true});
  return {repo, guard: createGitMutationGuard(runDir, repo)};
}

function runBlocked(guard, repo, env) {
  return spawnSync(process.execPath, [guard.pathShimWrapper, "tag", "x"], {cwd: repo, env, encoding: "utf8", shell: false});
}
function logText(file) { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; }

const A = makeGuard("outer");
const B = makeGuard("inner");
check("guards have distinct log files", A.guard.logFile !== B.guard.logFile);

// a. inner guard B with the OUTER env inherited (AUTOPILOT_GIT_GUARD_LOG = A's log)
{
  const result = runBlocked(B.guard, B.repo, {...cleanEnv, AUTOPILOT_GIT_GUARD_LOG: A.guard.logFile});
  check("a: inner shim blocks with exit 97", result.status === 97, {status: result.status, stderr: result.stderr});
  const entries = readGuardLog(B.guard.logFile);
  check("a: entry lands in the inner guard's own blocked.log",
    entries.length === 1 && entries[0].subcommand === "tag" && entries[0].layer === "path-shim", entries);
  check("a: outer guard's blocked.log stays empty", logText(A.guard.logFile) === "", logText(A.guard.logFile));
}

// b. outer guard A with its own guardedEnv still records its real violation
{
  const result = runBlocked(A.guard, A.repo, {...cleanEnv, ...guardedEnv(A.guard)});
  check("b: outer shim blocks with exit 97", result.status === 97, {status: result.status, stderr: result.stderr});
  const entries = readGuardLog(A.guard.logFile);
  check("b: entry lands in the outer guard's blocked.log",
    entries.length === 1 && entries[0].subcommand === "tag" && entries[0].layer === "path-shim", entries);
  check("b: inner guard's log did not grow", readGuardLog(B.guard.logFile).length === 1);
}

// c. null device: still blocks, but writes nothing to its own blocked.log
{
  const before = logText(B.guard.logFile);
  const result = runBlocked(B.guard, B.repo, {...cleanEnv, AUTOPILOT_GIT_GUARD_LOG: NULL_DEVICE});
  check("c: shim still blocks with exit 97 under the null device", result.status === 97, {status: result.status, stderr: result.stderr});
  check("c: own blocked.log unchanged under the null device", logText(B.guard.logFile) === before);
  const viaExplicit = spawnSync(process.execPath, [B.guard.wrapper, "tag", "x"], {cwd: B.repo, env: {...cleanEnv, AUTOPILOT_GIT_GUARD_LOG: A.guard.logFile}, encoding: "utf8", shell: false});
  check("c: explicit wrapper blocks and logs nowhere", viaExplicit.status === 97 && logText(B.guard.logFile) === before && readGuardLog(A.guard.logFile).length === 1,
    {status: viaExplicit.status});
}

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log("All guard log isolation checks passed");
