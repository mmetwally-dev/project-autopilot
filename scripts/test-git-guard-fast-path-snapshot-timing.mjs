#!/usr/bin/env node
// TASK 1.7: regression guard for the strict read-only PATH-shim fast path as
// seen by the real `gitSnapshot()` call mix. Two independent proofs:
//
//   1. Timing (POSIX only): the exact argv mix gitSnapshot issues must run
//      through the shim under `guardedEnv()` in no more than 5x the same mix
//      with plain git on PATH, plus a fixed spawn-allowance. Any read shape
//      that regresses to the ~600 ms Node wrapper blows the budget.
//   2. Stability: a self-spawned child prepends the guard dir to PATH
//      (exactly how production roles resolve `git` via `guard.prependPath`),
//      then runs the real `gitSnapshot()` twice and asserts it succeeds and
//      is byte-stable.
//
// Fixture repositories live under $TMPDIR, never in the project repo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {createGitMutationGuard, guardedEnv, gitSnapshot} from "./relay-guards.mjs";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";

const selfPath = fileURLToPath(import.meta.url);
const IS_WIN = process.platform === "win32";
// Fixed spawn allowance on top of 5x plain git. The 5x+allowance budget is a
// coarse regression guard, NOT a proof that zero calls fall back to Node: a
// single Node-wrapper call is cheap enough to hide inside 5x on a fast host.
// What it does guarantee is that the mix as a whole stays in shim territory
// (no broad fallback / no ~600 ms-per-call regression); the POSIX marker
// proof below is what asserts every mix call is answered without Node.
const ALLOWANCE_MS = 300;

// ---------------------------------------------------------------------------
// Child mode: the real `gitSnapshot()` under the production-style guarded
// PATH. Kept first so the fixture/guard setup below never runs in the child.
// ---------------------------------------------------------------------------
if (process.argv[2] === "--snapshot-child") {
  const childRepo = process.argv[3];
  const childGuardPath = process.argv[4];
  // Prepend the guard dir to PATH (the production shape): the shim is first,
  // so every `git` gitSnapshot spawns hits the guard, while the rest of PATH
  // still resolves everything else normally.
  process.env.PATH = childGuardPath + path.delimiter + (process.env.PATH || "");
  try {
    const first = gitSnapshot(childRepo);
    const second = gitSnapshot(childRepo);
    const stable = first.fingerprint === second.fingerprint
      && JSON.stringify(first) === JSON.stringify(second);
    process.stdout.write(`${JSON.stringify({ok: true, stable, fingerprint: first.fingerprint})}\n`);
    process.exit(stable ? 0 : 1);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ok: false, error: String((error && error.message) || error)})}\n`);
    process.exit(1);
  }
}

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

// Plain git must be the host git, not an outer mission's PATH shim. The
// shim's `env -i` allowlist also drops these config redirections, so drop
// them here to time the same config files on both sides.
const cleanEnv = withoutOuterGitGuard(process.env);
delete cleanEnv.XDG_CONFIG_HOME;
delete cleanEnv.GIT_CONFIG_GLOBAL;
delete cleanEnv.GIT_CONFIG_SYSTEM;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-fgf-snapshot-timing-"));
process.on("exit", () => {
  try { fs.rmSync(root, {recursive: true, force: true}); } catch { /* best-effort */ }
});
const repo = path.join(root, "repo");
fs.mkdirSync(repo, {recursive: true});

function rawGit(args, opts = {}) {
  return spawnSync("git", args, {cwd: repo, encoding: "utf8", env: cleanEnv, shell: false, ...opts});
}

rawGit(["init", "-q"]);
rawGit(["config", "user.email", "t@example.invalid"]);
rawGit(["config", "user.name", "t"]);
rawGit(["config", "core.autocrlf", "false"]);
fs.writeFileSync(path.join(repo, ".gitignore"), "ignored-dir/\n.autopilot/\n*.log\n");
fs.mkdirSync(path.join(repo, "sub"), {recursive: true});
fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
fs.writeFileSync(path.join(repo, "sub", "b.txt"), "b\n");
rawGit(["add", "-A"]);
rawGit(["commit", "-q", "-m", "init"]);
// Refs (for-each-ref / symbolic-ref have something to report) plus every
// file state gitSnapshot distinguishes: dirty tracked, untracked, ignored
// directory, ignored file, and an excluded .autopilot run dir.
rawGit(["branch", "feature"]);
rawGit(["tag", "v1"]);
fs.appendFileSync(path.join(repo, "a.txt"), "changed\n");
fs.writeFileSync(path.join(repo, "untracked.txt"), "u\n");
fs.writeFileSync(path.join(repo, "debug.log"), "ignored\n");
fs.mkdirSync(path.join(repo, "ignored-dir"), {recursive: true});
fs.writeFileSync(path.join(repo, "ignored-dir", "cache.bin"), "c\n");
fs.mkdirSync(path.join(repo, ".autopilot", "run"), {recursive: true});
fs.writeFileSync(path.join(repo, ".autopilot", "run", "state.json"), "{}\n");

// Resolve the guard's baked real git (and prependPath) against the host git,
// not an enclosing mission's PATH shim: when this test runs inside the
// implementer's own guarded session, `which git` would otherwise select the
// OUTER shim, making the "plain" baseline and every child call pay for a
// second guard layer.
const savedPath = process.env.PATH;
let guard;
try {
  process.env.PATH = cleanEnv.PATH;
  guard = createGitMutationGuard(path.join(root, "guard"), repo);
} finally {
  process.env.PATH = savedPath;
}
const shim = path.join(guard.guardDir, IS_WIN ? "git.cmd" : "git");

// The exact read-only argv mix gitSnapshot issues (submodule status is
// intentionally omitted: it is not a read shape this phase fast-paths and it
// is not part of the budgeted loop; the child below still exercises it via
// the real gitSnapshot twice).
const autocrlf = ["-c", "core.autocrlf=input"];
const snapshotMix = [
  ["rev-parse", "--show-toplevel"],
  ["rev-parse", "--is-bare-repository"],
  ["rev-parse", "--absolute-git-dir"],
  ["rev-parse", "--git-common-dir"],
  ["worktree", "list", "--porcelain"],
  ["rev-parse", "-q", "--verify", "HEAD"],
  ["symbolic-ref", "-q", "HEAD"],
  ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)"],
  ...["--local", "--worktree", "--global", "--system"].map(scope => ["config", scope, "--list"]),
  ...["--local", "--worktree", "--global", "--system"].map(scope => ["config", scope, "core.hooksPath"]),
  ["count-objects", "-v"],
  ["ls-files", "-v"],
  ["ls-files", "--others", "-z", "--exclude-standard"],
  ["ls-files", "--others", "--ignored", "-z", "--exclude-standard", "--directory", "--", ".", ":(exclude).autopilot/**"],
  ["ls-files", "--others", "--ignored", "-z", "--exclude-standard", "--", "ignored-dir/"],
  [...autocrlf, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
  [...autocrlf, "diff", "--ignore-cr-at-eol", "--name-only", "-z", "HEAD"],
  [...autocrlf, "diff", "--ignore-cr-at-eol", "--no-ext-diff", "--binary", "HEAD", "--", ".", ":(exclude).autopilot/**"]
];

const shimEnv = guardedEnv(guard, {PWD: repo, INIT_CWD: repo});
function runPlain(args) {
  return spawnSync("git", args, {cwd: repo, env: cleanEnv, shell: false, stdio: "ignore"});
}
function runGuarded(args) {
  return spawnSync(shim, args, {cwd: repo, env: shimEnv, shell: false, stdio: "ignore"});
}

if (IS_WIN) {
  console.log("INFO snapshot timing comparison skipped on Windows (POSIX fast path only)");
} else {
  // Warm up both paths so first-call filesystem/exec overhead is excluded.
  for (const args of snapshotMix) { runPlain(args); runGuarded(args); }

  function bestOf(runFn) {
    let best = Infinity;
    for (let trial = 0; trial < 3; trial += 1) {
      const started = performance.now();
      for (const args of snapshotMix) {
        const result = runFn(args);
        if (result.error) throw result.error;
      }
      best = Math.min(best, performance.now() - started);
    }
    return best;
  }

  const plainMs = bestOf(runPlain);
  const guardedMs = bestOf(runGuarded);
  const limitMs = plainMs * 5 + ALLOWANCE_MS;
  console.log(`INFO snapshot mix plain git on PATH: ${plainMs.toFixed(0)} ms (${snapshotMix.length} calls)`);
  console.log(`INFO snapshot mix through guard shim: ${guardedMs.toFixed(0)} ms (${snapshotMix.length} calls)`);
  console.log(`INFO allowed: 5 x ${plainMs.toFixed(0)} + ${ALLOWANCE_MS} ms = ${limitMs.toFixed(0)} ms`);
  check(
    `snapshot mix through shim is within 5x plain git + ${ALLOWANCE_MS} ms`,
    guardedMs <= limitMs,
    {plainMs: Math.round(plainMs), guardedMs: Math.round(guardedMs), limitMs: Math.round(limitMs)}
  );

  // No-Node proof: replace the Node wrapper with a marker stub, then require
  // every mix call to be answered by the shim fast path (no NODE_PATH_HIT).
  const wrapper = path.join(guard.guardDir, "git-guard.mjs");
  const originalWrapper = fs.readFileSync(wrapper, "utf8");
  fs.writeFileSync(wrapper, `console.log("NODE_PATH_HIT"); process.exit(42);\n`);
  try {
    for (const args of snapshotMix) {
      const r = spawnSync(shim, args, {cwd: repo, env: shimEnv, encoding: "utf8", shell: false});
      const hitMarker = (r.stdout || "").includes("NODE_PATH_HIT") || (r.stderr || "").includes("NODE_PATH_HIT");
      check(`snapshot mix answered without Node: ${args.join(" ")}`, !hitMarker && r.status !== 42,
        {status: r.status, hitMarker});
    }
  } finally {
    fs.writeFileSync(wrapper, originalWrapper);
  }
}

// ---------------------------------------------------------------------------
// Real gitSnapshot under the guarded PATH: self-spawn so PATH is exactly the
// production shape (guard.prependPath first) with no outer-guard env leaking.
// ---------------------------------------------------------------------------
const childEnv = {
  ...cleanEnv,
  PATH: cleanEnv.PATH,
  AUTOPILOT_REAL_GIT: guard.realGit
};
const child = spawnSync(
  process.execPath,
  [selfPath, "--snapshot-child", repo, guard.guardDir],
  {cwd: repo, encoding: "utf8", env: childEnv, timeout: 120000, shell: false}
);
let parsed = null;
try { parsed = JSON.parse(String(child.stdout || "").trim().split("\n").pop()); } catch { /* reported below */ }
check(
  "gitSnapshot under the guarded PATH succeeds",
  child.status === 0 && parsed && parsed.ok === true,
  {status: child.status, stdout: (child.stdout || "").slice(0, 300), stderr: (child.stderr || "").slice(0, 300)}
);
check(
  "gitSnapshot under the guarded PATH is stable across two runs",
  !!parsed && parsed.stable === true,
  parsed
);

console.log(failures === 0
  ? "test-git-guard-fast-path-snapshot-timing: OK"
  : `test-git-guard-fast-path-snapshot-timing: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
