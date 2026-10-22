#!/usr/bin/env node
// TASK 15.6J: allow the exact safe symbolic-ref query used by OpenCode
// (`git --no-optional-locks -c ... symbolic-ref --quiet --short HEAD`).
//
// The PATH shim structurally classifies symbolic-ref argv: exactly one HEAD
// operand plus only --quiet/-q/--short/--no-recurse passes through; every
// mutation or malformed shape stays blocked with trusted evidence.
// symbolic-ref REMAINS in BLOCKED_SUBCOMMANDS (no reclassification), and the
// reference-transaction hook / git-scope.conf logic is untouched.
//
// Runs on native Windows and Linux/WSL. Fully deterministic: parser, Git
// guard, safe-symbolic-ref, external-snapshot, and scope-pin regressions
// only. The live-network OpenCode probe moved to
// scripts/manual-live-opencode-symref-probe.mjs (explicit opt-in,
// never part of `npm test`); deterministic PWD-authority coverage lives in
// test-pwd-authority.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {createGitMutationGuard, guardedEnv, gitSnapshot, readGuardLog} from "./relay-guards.mjs";

let passed = 0;
let failed = 0;
function check(label, ok, detail) {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { failed++; console.error(`FAIL ${label}${detail ? ` :: ${detail}` : ""}`); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-156j-symref-"));
const DENIAL_RE = /AUTOPILOT GIT GUARD: 'symbolic-ref' is forbidden/;
const HOOK_DENIAL_RE = /AUTOPILOT GIT GUARD: ref update blocked \(reference-transaction\)/;

function git(cwd, args, env) {
  return spawnSync("git", args, {cwd, encoding: "utf8", env, shell: false});
}
function absGit(guard, cwd, args, env) {
  return spawnSync(guard.realGit, args, {cwd, encoding: "utf8", env, shell: false});
}
function combined(res) {
  return `${res.stdout || ""}\n${res.stderr || ""}`;
}
function makeRepo(name) {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, {recursive: true});
  assert.equal(git(repo, ["init", "-q"]).status, 0);
  assert.equal(git(repo, ["config", "user.email", "symref-test@example.invalid"]).status, 0);
  assert.equal(git(repo, ["config", "user.name", "Symref Test"]).status, 0);
  fs.writeFileSync(path.join(repo, "file.txt"), "base\n");
  assert.equal(git(repo, ["add", "-A"]).status, 0);
  assert.equal(git(repo, ["commit", "-q", "-m", "init"]).status, 0);
  return repo;
}
// Through the production shim path where it engages (POSIX `git` on PATH);
// through the explicit wrapper (same shim logic, direct) on native Windows
// where CreateProcess prefers git.exe over git.cmd (pre-existing gap).
function shimGit(guard, cwd, args, env) {
  if (process.platform !== "win32") return git(cwd, args, env);
  return spawnSync(process.execPath, [guard.wrapper, ...args], {cwd, encoding: "utf8", env, shell: false});
}
// Capability probe: does this git fire reference-transaction for the
// two-operand symbolic-ref WRITE form? (Linux git 2.53 does;
// Git-for-Windows 2.40 does not — verified: the write repoints HEAD with no
// hook invocation.) Cached per process.
let firesRefTxnOnSymrefWrite = null;
function gitFiresRefTxnOnSymrefWrite() {
  if (firesRefTxnOnSymrefWrite !== null) return firesRefTxnOnSymrefWrite;
  const probe = path.join(root, "symref-capability");
  const hooks = path.join(probe, "hooks");
  fs.mkdirSync(hooks, {recursive: true});
  const marker = path.join(probe, "fired.log");
  fs.writeFileSync(path.join(hooks, "reference-transaction"),
    "#!/bin/sh\n" + `echo fired >> "${marker.replace(/\\/g, "/")}"\n` + "exit 0\n");
  fs.chmodSync(path.join(hooks, "reference-transaction"), 0o755);
  const wc = path.join(probe, "wc");
  fs.mkdirSync(wc, {recursive: true});
  git(wc, ["init", "-q"]);
  git(wc, ["config", "user.email", "cap@example.invalid"]);
  git(wc, ["config", "user.name", "Cap"]);
  fs.writeFileSync(path.join(wc, "f.txt"), "x\n");
  git(wc, ["add", "-A"]);
  git(wc, ["commit", "-q", "-m", "init"]);
  git(wc, ["symbolic-ref", "HEAD", "refs/heads/probe-cap"], {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: hooks,
  });
  firesRefTxnOnSymrefWrite = fs.existsSync(marker);
  console.log(`INFO git fires reference-transaction on symbolic-ref write: ${firesRefTxnOnSymrefWrite}`);
  return firesRefTxnOnSymrefWrite;
}

try {
const official = makeRepo("official");
const branchNow = git(official, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();

// ============================================================
// 1. The exact OpenCode argv succeeds through the real guard
// ============================================================
{
  const guard = createGitMutationGuard(path.join(root, "guard-exact"), official);
  const env = guardedEnv(guard);
  const before = gitSnapshot(official);
  const headBefore = before.head;
  // Byte-shape of the 15.6H observation: boolean global, -c pair, then the
  // safe query. (-c key is opencode's own; any well-formed pair exercises
  // the global-option skip.)
  const exact = ["--no-optional-locks", "-c", "core.abbrev=auto", "symbolic-ref", "--quiet", "--short", "HEAD"];
  const logBefore = readGuardLog(guard.logFile).length;
  const res = shimGit(guard, official, exact, env);
  check("exact: OpenCode argv exits 0", res.status === 0, `status=${res.status} :: ${combined(res).slice(-300)}`);
  if (process.platform !== "win32") {
    check("exact: returns the current branch", (res.stdout || "").trim() === branchNow, JSON.stringify((res.stdout || "").trim()));
  }
  check("exact: no blocked event", readGuardLog(guard.logFile).length === logBefore);
  check("exact: no guard denial in output", !/AUTOPILOT GIT GUARD/.test(combined(res)));
  const after = gitSnapshot(official);
  check("exact: HEAD unchanged", after.head === headBefore);
  check("exact: fingerprint unchanged", after.fingerprint === before.fingerprint);
  check("exact: objects unchanged", after.objects === before.objects);
}

// ============================================================
// 2. Structural matrix: safe shapes pass, everything else blocked
// ============================================================
{
  const guard = createGitMutationGuard(path.join(root, "guard-matrix"), official);
  const env = guardedEnv(guard);
  const allow = [
    ["plain", ["symbolic-ref", "--quiet", "--short", "HEAD"]],
    ["short-q", ["symbolic-ref", "-q", "HEAD"]],
    ["operand-first", ["symbolic-ref", "HEAD", "-q", "--short"]],
    ["no-recurse", ["symbolic-ref", "--no-recurse", "--quiet", "--short", "HEAD"]],
    ["dup-options", ["symbolic-ref", "-q", "-q", "--quiet", "HEAD"]],
    ["global-boolean", ["--no-optional-locks", "symbolic-ref", "-q", "HEAD"]],
    ["global-c-pair", ["-C", official, "-c", "core.abbrev=auto", "symbolic-ref", "--short", "HEAD"]],
    ["global-gitdir-eq", [`--git-dir=${official}/.git`, "symbolic-ref", "-q", "--short", "HEAD"]],
    ["global-gitdir-sp", ["--git-dir", `${official}/.git`, "symbolic-ref", "-q", "HEAD"]],
  ];
  for (const [name, argv] of allow) {
    const logBefore = readGuardLog(guard.logFile).length;
    const res = shimGit(guard, official, argv, env);
    check(`matrix-allow: ${name}`, res.status === 0 && readGuardLog(guard.logFile).length === logBefore,
      `status=${res.status} log=${readGuardLog(guard.logFile).length} :: ${combined(res).slice(-200)}`);
  }
  // A one-operand read of a refs/... name (OpenCode's startup
  // `symbolic-ref refs/remotes/origin/HEAD` in any repo with an origin) is a
  // query: it must pass the guard (exit 0 or git's own 1/128), never 97.
  const refReads = [
    ["opencode-origin-head", ["--no-optional-locks", "-c", "core.quotepath=false", "symbolic-ref", "refs/remotes/origin/HEAD"]],
    ["non-head-ref", ["symbolic-ref", "--quiet", "refs/heads/master"]],
  ];
  for (const [name, argv] of refReads) {
    const logBefore = readGuardLog(guard.logFile).length;
    const res = shimGit(guard, official, argv, env);
    check(`matrix-allow-read: ${name}`, res.status !== 97 && readGuardLog(guard.logFile).length === logBefore
      && !/AUTOPILOT GIT GUARD/.test(combined(res)), `status=${res.status} :: ${combined(res).slice(-200)}`);
  }
  const block = [
    ["two-operands", ["symbolic-ref", "HEAD", "refs/heads/other"]],
    ["delete", ["symbolic-ref", "--delete", "HEAD"]],
    ["short-d", ["symbolic-ref", "-d", "HEAD"]],
    ["message", ["symbolic-ref", "-m", "reason", "HEAD", "refs/heads/other"]],
    ["message-flag-alone", ["symbolic-ref", "-m", "HEAD"]],
    ["missing-operand", ["symbolic-ref", "--quiet"]],
    ["bare", ["symbolic-ref"]],
    ["dup-head", ["symbolic-ref", "HEAD", "HEAD"]],
    ["unknown-option", ["symbolic-ref", "--frobnicate", "HEAD"]],
    ["option-with-value", ["symbolic-ref", "--quiet=true", "HEAD"]],
    ["refs-prefix-only", ["symbolic-ref", "-q", "refs/"]],
    ["refs-two-operands", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/x"]],
    ["lowercase-head", ["symbolic-ref", "-q", "head"]],
    ["empty-operand", ["symbolic-ref", "-q", ""]],
    ["dashdash", ["symbolic-ref", "--", "HEAD"]],
    ["global-after-subcommand", ["symbolic-ref", "-q", "HEAD", "--git-dir=x"]],
    ["c-after-subcommand", ["symbolic-ref", "-c", "a=b", "HEAD"]],
  ];
  for (const [name, argv] of block) {
    const logBefore = readGuardLog(guard.logFile).length;
    const res = shimGit(guard, official, argv, env);
    const entries = readGuardLog(guard.logFile);
    if (process.platform !== "win32") {
      check(`matrix-block: ${name}`, res.status === 97 && DENIAL_RE.test(combined(res)),
        `status=${res.status}`);
      check(`matrix-block-evidence: ${name}`, entries.length === logBefore + 1
        && entries[entries.length - 1]?.layer === "path-shim"
        && entries[entries.length - 1]?.subcommand === "symbolic-ref");
    } else {
      // Explicit wrapper routes the shim's own log writes to NUL by design
      // (it must not require a writable audit directory), so only the exit
      // status pins the parser verdict on native Windows.
      check(`matrix-block: ${name} (win32)`, res.status === 97, `status=${res.status}`);
      check(`matrix-block-evidence: ${name} (win32)`, entries.length === logBefore);
    }
  }
  // Existing operations keep their exact verdicts.
  for (const [name, argv, want] of [
    ["commit", ["commit", "--allow-empty", "-m", "x"], 97],
    ["push", ["push", "origin", "master"], 97],
    ["update-ref", ["update-ref", "refs/heads/z", "HEAD"], 97],
    ["branch-mutation", ["branch", "-f", "z", "HEAD"], 97],
    ["reset", ["reset", "--hard", "HEAD"], 97],
    ["branch-list", ["branch", "--list"], 0],
  ]) {
    const res = shimGit(guard, official, argv, env);
    check(`matrix-preserved: ${name}`, res.status === want, `status=${res.status}`);
  }
}

// ============================================================
// 3. No substring matching: near-miss subcommands are never exempted,
//    and a mutation alias still dies at the reference-transaction hook
// ============================================================
{
  // Isolated repo: §3 intentionally attempts a HEAD repoint, which succeeds
  // on git versions whose reference-transaction hook never fires for the
  // symbolic-ref write form (pre-existing git-version gap, documented below).
  const repo = makeRepo("aliasrepo");
  const guard = createGitMutationGuard(path.join(root, "guard-substr"), repo);
  const env = guardedEnv(guard);
  const headBefore = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
  // Abbreviated / suffixed / prefixed spellings must not take the safe path.
  for (const [name, argv] of [
    ["abbrev", ["symbolic-re", "-q", "HEAD"]],
    ["suffix", ["symbolic-refx", "-q", "HEAD"]],
    ["underscore", ["symbolic_ref", "-q", "HEAD"]],
  ]) {
    const logBefore = readGuardLog(guard.logFile).length;
    const res = shimGit(guard, repo, argv, env);
    // Git itself rejects the unknown command (no exemption taken, no
    // transaction possible); the guard log stays silent either way.
    check(`substr: ${name} does not succeed as a query`, res.status !== 0, `status=${res.status}`);
    check(`substr: ${name} fires no reference transaction`, readGuardLog(guard.logFile).length === logBefore);
  }
  // A config alias smuggling a mutation expands inside git (shim sees only
  // the alias). Where this git fires the hook for symbolic-ref writes, it
  // must die at Layer 2 with trusted evidence. Where it does not fire
  // (Git-for-Windows 2.40, verified: direct two-operand write repoints HEAD
  // with no hook invocation — the pre-existing deny-all hook was equally
  // blind there), pin the parser verdict via the explicit wrapper instead.
  git(repo, ["config", "alias.smuggle", "symbolic-ref HEAD refs/heads/smuggled"]);
  try {
    if (gitFiresRefTxnOnSymrefWrite()) {
      const logBefore = readGuardLog(guard.logFile).length;
      const res = absGit(guard, repo, ["smuggle"], env);
      check("substr: mutation alias blocked", res.status !== 0, `status=${res.status}`);
      check("substr: alias denial is hook evidence", HOOK_DENIAL_RE.test(combined(res))
        && readGuardLog(guard.logFile).length === logBefore + 1);
    } else {
      console.log("INFO this git never fires reference-transaction for symbolic-ref writes (pre-existing git-version gap): pinning parser verdict only");
      const res = shimGit(guard, repo, ["symbolic-ref", "HEAD", "refs/heads/smuggled"], env);
      check("substr: parser rejects the smuggled shape", res.status === 97, `status=${res.status}`);
    }
  } finally {
    git(repo, ["config", "--unset", "alias.smuggle"]);
    git(repo, ["symbolic-ref", "HEAD", "refs/heads/master"]);
    git(repo, ["update-ref", "-d", "refs/heads/smuggled"]);
  }
  check("substr: HEAD unchanged", git(repo, ["rev-parse", "HEAD"]).stdout.trim() === headBefore);
}

// ============================================================
// 4. Hook + scope behavior preserved (15.6I untouched)
// ============================================================
{
  const repo = makeRepo("scopepin");
  const guard = createGitMutationGuard(path.join(root, "guard-scopepin"), repo);
  const env = guardedEnv(guard);
  const headBefore = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
  // Official ref mutation still denied at the hook with trusted evidence.
  const denied = absGit(guard, repo, ["update-ref", "refs/heads/pin-156j", "HEAD"], env);
  check("scopepin: official update-ref still denied", denied.status !== 0 && HOOK_DENIAL_RE.test(combined(denied)));
  // External snapshot init still allowed silently (no violation).
  const snap = path.join(root, "snap-156j");
  const logBefore = readGuardLog(guard.logFile).length;
  const init = git(repo, ["init"], {...env, GIT_DIR: snap});
  const hookFiresOnInit = fs.existsSync(path.join(snap, "HEAD")) && init.status === 0 && readGuardLog(guard.logFile).length === logBefore;
  const initDenied = init.status !== 0 && HOOK_DENIAL_RE.test(combined(init));
  check("scopepin: external init allowed-or-denied consistently", hookFiresOnInit || initDenied,
    `status=${init.status} logDelta=${readGuardLog(guard.logFile).length - logBefore}`);
  if (process.platform !== "win32") {
    // This git fires the init hook: 15.6I scoped it to allow externals.
    check("scopepin: external init allowed here", hookFiresOnInit);
  }
  check("scopepin: HEAD unchanged", git(repo, ["rev-parse", "HEAD"]).stdout.trim() === headBefore);
  git(repo, ["update-ref", "-d", "refs/heads/pin-156j"]);
}

// NOTE (15.6K): the live-network OpenCode Implementer/Reviewer probe that
// used to live here as §5 moved to scripts/manual-live-opencode-symref-probe.mjs —
// an explicitly optional integration script (not auto-discovered by
// test-all.mjs, requires AP_LIVE_OPENCODE=1). A model no-op is never
// deterministic-suite evidence, so it must never run as part of `npm test`.
// Deterministic PWD-authority coverage for the same property lives in
// test-pwd-authority.mjs (fake adapters, both platforms).
} finally {
  try { fs.rmSync(root, {recursive: true, force: true}); } catch {}
}

console.log(`\n156J safe-symbolic-ref: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
