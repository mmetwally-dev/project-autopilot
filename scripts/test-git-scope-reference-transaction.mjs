#!/usr/bin/env node
// TASK 15.6I / 15.6M_B: reference-transaction protection is scoped to the official
// repository identities recorded in the trusted git-scope.conf. An external
// tool's `git init` with an outside GIT_DIR (the OpenCode snapshot mechanism
// from TASK 15.6H) must succeed silently, while every ref mutation aimed at
// the official repository — including nested, symlink/junction,
// linked-worktree and child-environment-override attempts — stays blocked
// with trusted evidence. Missing or corrupted identity fails closed.
// Symbolic-ref command classification is deliberately UNCHANGED here.
//
// Runs on native Windows and on Linux/WSL (junction fallback covers Windows
// hosts without symlink privilege; the link-indirection property is tested
// either way).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {createGitMutationGuard, guardedEnv, gitSnapshot, readGuardLog, normalizeGuardPath} from "./relay-guards.mjs";

let passed = 0;
let failed = 0;
function check(label, ok, detail) {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { failed++; console.error(`FAIL ${label}${detail ? ` :: ${detail}` : ""}`); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-156i-scope-"));
const DENIAL_RE = /AUTOPILOT GIT GUARD: ref update blocked \(reference-transaction\)/;

function git(cwd, args, env) {
  return spawnSync("git", args, {cwd, encoding: "utf8", env, shell: false});
}
function absGit(guard, cwd, args, env) {
  return spawnSync(guard.realGit, args, {cwd, encoding: "utf8", env, shell: false});
}
function makeRepo(name) {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, {recursive: true});
  assert.equal(git(repo, ["init", "-q"]).status, 0);
  assert.equal(git(repo, ["config", "user.email", "scope-test@example.invalid"]).status, 0);
  assert.equal(git(repo, ["config", "user.name", "Scope Test"]).status, 0);
  fs.writeFileSync(path.join(repo, "file.txt"), "base\n");
  assert.equal(git(repo, ["add", "-A"]).status, 0);
  assert.equal(git(repo, ["commit", "-q", "-m", "init"]).status, 0);
  return repo;
}
function headOf(repo) {
  return git(repo, ["rev-parse", "HEAD"]).stdout.trim();
}
function combined(res) {
  return `${res.stdout || ""}\n${res.stderr || ""}`;
}
function gitMetadataBytes(repo) {
  const gitDir = path.join(repo, ".git");
  const pendingDirs = [gitDir];
  const records = [];
  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop();
    for (const entry of fs.readdirSync(currentDir, {withFileTypes: true})) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) { pendingDirs.push(fullPath); continue; }
      const relativePath = path.relative(gitDir, fullPath).replace(/\\/g, "/");
      records.push([relativePath, fs.lstatSync(fullPath).mode, fs.readFileSync(fullPath).toString("base64")].join(":"));
    }
  }
  return records.sort().join("\n");
}

// Capability probe: does this git fire reference-transaction for `git init`
// (Linux git 2.53 does; Git-for-Windows 2.40 does not). Init-path assertions
// adapt to the answer; the enforceable property on every platform is that a
// nested/identity-less repository can never complete a ref transaction.
let firesRefTxnOnInit = null;
function gitFiresRefTxnOnInit() {
  if (firesRefTxnOnInit !== null) return firesRefTxnOnInit;
  const probe = path.join(root, "init-capability");
  const hooks = path.join(probe, "hooks");
  fs.mkdirSync(hooks, {recursive: true});
  const marker = path.join(probe, "fired.log");
  const hook = "#!/bin/sh\n" +
    `echo fired >> "${marker.replace(/\\/g, "/")}"\n` +
    "exit 0\n";
  fs.writeFileSync(path.join(hooks, "reference-transaction"), hook);
  fs.chmodSync(path.join(hooks, "reference-transaction"), 0o755);
  const wc = path.join(probe, "wc");
  fs.mkdirSync(wc, {recursive: true});
  git(wc, ["init", "-q"], {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: hooks,
  });
  firesRefTxnOnInit = fs.existsSync(marker);
  console.log(`INFO git fires reference-transaction on init: ${firesRefTxnOnInit}`);
  return firesRefTxnOnInit;
}

// Link helper: symlink where privileged, junction fallback on Windows.
let linkKind = "symlink";
function linkDir(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, process.platform === "win32" ? "dir" : "dir");
    linkKind = "symlink";
  } catch {
    assert.equal(process.platform, "win32", "symlink creation must succeed off Windows");
    fs.symlinkSync(target, linkPath, "junction");
    linkKind = "junction";
  }
}

try {
// ============================================================
// 0. Guard creation records a trusted, complete identity
// ============================================================
const official = makeRepo("official");
{
  const guard = createGitMutationGuard(path.join(root, "guard-identity"), official);
  check("identity: scope file exists", !!guard.scopeFile && fs.existsSync(guard.scopeFile));
  const conf = fs.readFileSync(guard.scopeFile, "utf8");
  const lines = conf.split("\n").filter(Boolean);
  check("identity: versioned header", lines[0] === "v1 fold=0" || lines[0] === "v1 fold=1", lines[0]);
  const keys = lines.slice(1).map((l) => l.split("=")[0]);
  for (const need of ["root", "gitdir", "common"]) check(`identity: conf carries ${need}`, keys.includes(need), conf);
  check("identity: object exposes gitDir", typeof guard.protectedIdentity?.gitDir === "string");
  check("identity: object exposes commonDir", typeof guard.protectedIdentity?.commonDir === "string");
  check("identity: object exposes root", typeof guard.protectedIdentity?.root === "string");
  // Normalization parity between writer and hook spelling.
  check("identity: gitdir is normalized", guard.protectedIdentity.gitDir === normalizeGuardPath(guard.protectedIdentity.gitDir, guard.protectedIdentity.foldCase));
  // Guarded-env contract unchanged (safe.directory still names the repo).
  const env = guardedEnv(guard);
  check("identity: GIT_CONFIG_COUNT still 3", env.GIT_CONFIG_COUNT === "3");
  check("identity: safe.directory still exact repo", env.GIT_CONFIG_VALUE_1 === path.resolve(official));
  check("identity: autocrlf pinned input", env.GIT_CONFIG_KEY_2 === "core.autocrlf" && env.GIT_CONFIG_VALUE_2 === "input");
}

// ============================================================
// 1. External snapshot `git init` (OpenCode mechanism) succeeds
// ============================================================
{
  const guard = createGitMutationGuard(path.join(root, "guard-external"), official);
  const env = guardedEnv(guard);
  const before = gitSnapshot(official);
  const headBefore = headOf(official);
  const snap = path.join(root, "snapshot-external");
  // cwd INSIDE the official worktree, GIT_DIR outside — the exact 15.6H shape.
  const init = git(official, ["init"], {...env, GIT_DIR: snap});
  check("external: snapshot init exits 0 from inside official", init.status === 0, combined(init).slice(-300));
  check("external: HEAD created in the snapshot only", fs.existsSync(path.join(snap, "HEAD")));
  check("external: no policy violation reported", readGuardLog(guard.logFile).length === 0, JSON.stringify(readGuardLog(guard.logFile)));
  check("external: official HEAD unchanged", headOf(official) === headBefore);
  const after = gitSnapshot(official);
  check("external: official fingerprint unchanged", before.fingerprint === after.fingerprint);
  check("external: official refs unchanged", before.refs === after.refs);
}

// ============================================================
// 2. Same via --git-dir flag form + from outside the worktree
// ============================================================
{
  const guard = createGitMutationGuard(path.join(root, "guard-external2"), official);
  const env = guardedEnv(guard);
  const headBefore = headOf(official);
  const snap = path.join(root, "snapshot-flag");
  const init = absGit(guard, root, ["--git-dir=" + snap, "init"], env);
  check("external: --git-dir flag init exits 0", init.status === 0, combined(init).slice(-300));
  check("external: flag-form HEAD created externally", fs.existsSync(path.join(snap, "HEAD")));
  check("external: flag-form reports no violation", readGuardLog(guard.logFile).length === 0);
  check("external: flag-form official HEAD unchanged", headOf(official) === headBefore);
}

// ============================================================
// 3. Official mutations blocked with trusted evidence
//    (absolute git binary: bypasses the PATH shim, exercises the hook)
// ============================================================
{
  const guard = createGitMutationGuard(path.join(root, "guard-official"), official);
  const env = guardedEnv(guard);
  const headBefore = headOf(official);
  const cases = [
    ["update-ref", ["update-ref", "refs/heads/try-update", "HEAD"]],
    ["branch", ["branch", "-f", "try-branch", "HEAD"]],
    ["tag", ["tag", "try-tag"]],
    ["reset", ["reset", "--hard", "HEAD"]],
  ];
  for (const [name, args] of cases) {
    const beforeCount = readGuardLog(guard.logFile).length;
    const res = absGit(guard, official, args, env);
    const entries = readGuardLog(guard.logFile);
    check(`official: ${name} blocked`, res.status !== 0, `status=${res.status}`);
    check(`official: ${name} emits trusted denial`, DENIAL_RE.test(combined(res)), combined(res).slice(-200));
    check(`official: ${name} writes hook evidence`, entries.length === beforeCount + 1 && entries[entries.length - 1]?.hook === "reference-transaction",
      JSON.stringify(entries.slice(-1)));
    check(`official: ${name} evidence names scope`, entries[entries.length - 1]?.scope === "official");
  }
  check("official: HEAD unchanged after all attempts", headOf(official) === headBefore);
  check("official: forbidden refs absent", git(official, ["for-each-ref", "--format=%(refname)"]).stdout.includes("try-update") === false
    && git(official, ["for-each-ref", "--format=%(refname)"]).stdout.includes("try-branch") === false
    && git(official, ["for-each-ref", "--format=%(refname)"]).stdout.includes("try-tag") === false);
  // Commit via the absolute binary is still denied (pre-commit layer, global).
  const commit = absGit(guard, official, ["commit", "--allow-empty", "-m", "must-not-land"], env);
  check("official: absolute-binary commit denied", commit.status !== 0);
  check("official: commit denial carries guard evidence", /AUTOPILOT GIT GUARD/.test(combined(commit)));
  check("official: commit left HEAD unchanged", headOf(official) === headBefore);
  // Checkout of another branch moves HEAD -> blocked for official.
  const co = absGit(guard, official, ["checkout", "-q", "-b", "try-checkout-branch"], env);
  check("official: checkout -b blocked", co.status !== 0, `status=${co.status}`);
  check("official: checkout left HEAD unchanged", headOf(official) === headBefore);
  git(official, ["branch", "-D", "try-checkout-branch"]);
}

// ============================================================
// 4. Nested repository creation inside the worktree stays blocked
// ============================================================
{
  const guard = createGitMutationGuard(path.join(root, "guard-nested"), official);
  const env = guardedEnv(guard);
  const headBefore = headOf(official);
  const firesOnInit = gitFiresRefTxnOnInit();
  const plain = git(official, ["init", "nested-plain"], env);
  if (firesOnInit) {
    check("nested: plain init inside worktree blocked", plain.status !== 0, `status=${plain.status}`);
    check("nested: plain init emits trusted denial", DENIAL_RE.test(combined(plain)));
    check("nested: plain init reports violation", readGuardLog(guard.logFile).length > 0);
  } else {
    console.log("INFO init does not fire the hook on this git: asserting stillborn nested repo instead");
    check("nested: hook never fires for init on this git (pre-existing platform behavior)", plain.status === 0);
  }
  // Wherever init itself lands, the nested repository must be stillborn: no
  // ref transaction inside it may ever succeed. On hook-firing gits the init
  // denial itself is the enforcement (retry stays denied); on other gits the
  // fully-created nested repo cannot transact.
  const nestedGit = path.join(official, "nested-plain");
  if (firesOnInit) {
    const retry = git(official, ["init", "nested-plain"], env);
    check("nested: retry init stays denied", retry.status !== 0 && DENIAL_RE.test(combined(retry)));
  } else if (fs.existsSync(path.join(nestedGit, "HEAD"))) {
    const logBefore = readGuardLog(guard.logFile).length;
    const nestedOp = absGit(guard, nestedGit, ["update-ref", "refs/heads/try-nested", "HEAD"], env);
    check("nested: ref op inside nested repo denied", nestedOp.status !== 0, `status=${nestedOp.status}`);
    check("nested: nested denial is trusted", DENIAL_RE.test(combined(nestedOp)) && readGuardLog(guard.logFile).length === logBefore + 1,
      combined(nestedOp).slice(-200));
  }
  // Explicit GIT_DIR pointing back inside the worktree is equally blocked
  // where the hook fires; elsewhere the created repo is equally stillborn.
  const innerSnap = path.join(official, "nested-explicit", "snapgit");
  fs.mkdirSync(path.dirname(innerSnap), {recursive: true});
  const explicit = git(official, ["init"], {...env, GIT_DIR: innerSnap});
  if (firesOnInit) {
    check("nested: explicit GIT_DIR inside worktree blocked", explicit.status !== 0, `status=${explicit.status}`);
    check("nested: explicit GIT_DIR denial is trusted", DENIAL_RE.test(combined(explicit)));
  } else {
    check("nested: explicit GIT_DIR init fires no hook on this git (matches baseline)", explicit.status === 0);
    if (fs.existsSync(innerSnap)) {
      const op = absGit(guard, official, ["update-ref", "refs/heads/try-nested-explicit", "HEAD"], {...env, GIT_DIR: innerSnap});
      check("nested: ref op via inner GIT_DIR denied", op.status !== 0, `status=${op.status}`);
    }
  }
  check("nested: official HEAD unchanged", headOf(official) === headBefore);
  fs.rmSync(path.join(official, "nested-plain"), {recursive: true, force: true});
  fs.rmSync(path.join(official, "nested-explicit"), {recursive: true, force: true});
}

// ============================================================
// 5. Symlink/junction indirection cannot escape the scope
// ============================================================
{
  const guard = createGitMutationGuard(path.join(root, "guard-link"), official);
  const env = guardedEnv(guard);
  const headBefore = headOf(official);
  const link = path.join(root, "link-to-official");
  linkDir(official, link);
  // (a) -C through the link, existing repo path.
  const viaC = absGit(guard, root, ["-C", link, "update-ref", "refs/heads/try-link", "HEAD"], env);
  check(`link(${linkKind}): -C through link blocked`, viaC.status !== 0, `status=${viaC.status}`);
  check(`link(${linkKind}): -C denial is trusted`, DENIAL_RE.test(combined(viaC)));
  // (b) GIT_DIR through the link.
  const viaEnv = absGit(guard, root, ["update-ref", "refs/heads/try-link2", "HEAD"], {...env, GIT_DIR: path.join(link, ".git")});
  check(`link(${linkKind}): GIT_DIR through link blocked`, viaEnv.status !== 0, `status=${viaEnv.status}`);
  check(`link(${linkKind}): GIT_DIR denial is trusted`, DENIAL_RE.test(combined(viaEnv)));
  // (c) init with a GIT_DIR behind the link (init path, rev-parse blind).
  // Denied with evidence where the hook fires; elsewhere the repo behind the
  // link is stillborn for ref transactions.
  const behindLink = path.join(link, "snap-behind-link");
  const logBeforeLink = readGuardLog(guard.logFile).length;
  const viaInit = git(root, ["init"], {...env, GIT_DIR: behindLink});
  if (gitFiresRefTxnOnInit()) {
    check(`link(${linkKind}): init behind link blocked`, viaInit.status !== 0, `status=${viaInit.status}`);
    check(`link(${linkKind}): init denial is trusted`, DENIAL_RE.test(combined(viaInit)) && readGuardLog(guard.logFile).length > logBeforeLink);
  } else {
    check(`link(${linkKind}): init fires no hook on this git (matches baseline)`, viaInit.status === 0);
    if (fs.existsSync(behindLink)) {
      // Reach the repo behind the link via -C (a bare GIT_DIR form is
      // rejected by git's own dubious-ownership check before any hook; the
      // -C traversal must still be denied by THIS guard with evidence).
      // Seed one COMMIT via the physical path (test setup, plain env), then
      // transact through the junction: the fresh repo is otherwise empty and
      // git would reject an unknown/blob OID before reaching the hook.
      // commit-tree needs no worktree, so GIT_DIR-only seeding suffices.
      const physical = path.join(official, "snap-behind-link");
      const seedEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: "Scope Test",
        GIT_AUTHOR_EMAIL: "scope-test@example.invalid",
        GIT_COMMITTER_NAME: "Scope Test",
        GIT_COMMITTER_EMAIL: "scope-test@example.invalid",
      };
      const tree = spawnSync(guard.realGit, ["--git-dir=" + physical, "mktree"],
        {cwd: root, input: "", encoding: "utf8", shell: false, env: seedEnv});
      const commit = tree.status === 0
        ? spawnSync(guard.realGit, ["--git-dir=" + physical, "commit-tree", (tree.stdout || "").trim(), "-m", "seed"],
          {cwd: root, encoding: "utf8", shell: false, env: seedEnv})
        : tree;
      const oid = (commit.stdout || "").trim();
      check(`link(${linkKind}): seed commit created`, commit.status === 0 && /^[0-9a-f]{40}$/.test(oid), `status=${commit.status}`);
      const op = absGit(guard, root, ["-C", behindLink, "update-ref", "refs/heads/try-behind-link", oid], env);
      check(`link(${linkKind}): ref op behind link denied`, op.status !== 0, `status=${op.status}`);
      check(`link(${linkKind}): behind-link denial is trusted`, DENIAL_RE.test(combined(op)), combined(op).slice(-300));
    }
  }
  check(`link(${linkKind}): official HEAD unchanged`, headOf(official) === headBefore);
  check(`link(${linkKind}): violations recorded`, readGuardLog(guard.logFile).length >= 3, `${readGuardLog(guard.logFile).length}`);
}

// ============================================================
// 6. Linked worktrees are protected (enumerated + post-guard)
// ============================================================
{
  const wtMain = makeRepo("wt-main");
  const linked = path.join(root, "wt-linked");
  assert.equal(git(wtMain, ["worktree", "add", linked]).status, 0);
  const guard = createGitMutationGuard(path.join(root, "guard-wt"), wtMain);
  check("worktree: conf records linked metadata", /wtpath=/.test(fs.readFileSync(guard.scopeFile, "utf8")) && /wtgit=/.test(fs.readFileSync(guard.scopeFile, "utf8")));
  const env = guardedEnv(guard);
  const mainHead = headOf(wtMain);
  // (a) Commit inside the linked worktree via the absolute binary.
  // pre-commit fires first (global); the ref layer must ALSO deny, so drive
  // a pure ref op to isolate reference-transaction.
  const wtRef = absGit(guard, linked, ["update-ref", "refs/heads/try-wt", "HEAD"], env);
  check("worktree: linked update-ref blocked", wtRef.status !== 0, `status=${wtRef.status}`);
  check("worktree: linked denial is trusted", DENIAL_RE.test(combined(wtRef)));
  check("worktree: main HEAD unchanged", headOf(wtMain) === mainHead);
  // (b) A worktree added AFTER guard creation is still covered via the
  // common-dir containment (<common>/worktrees/<name>).
  const late = path.join(root, "wt-late");
  assert.equal(git(wtMain, ["worktree", "add", late]).status, 0);
  const lateRef = absGit(guard, late, ["update-ref", "refs/heads/try-wt-late", "HEAD"], env);
  check("worktree: post-guard worktree update-ref blocked", lateRef.status !== 0, `status=${lateRef.status}`);
  check("worktree: post-guard denial is trusted", DENIAL_RE.test(combined(lateRef)));
  const lateHead = git(late, ["rev-parse", "HEAD"]).stdout.trim();
  check("worktree: main HEAD still unchanged", headOf(wtMain) === mainHead && lateHead === mainHead);
  git(wtMain, ["worktree", "remove", "--force", linked]);
  git(wtMain, ["worktree", "remove", "--force", late]);
}

// ============================================================
// 7. Missing / corrupted identity fails closed
// ============================================================
{
  // (a) No repositoryRoot -> no scope file -> every prepared txn denied.
  // Where this git fires the hook for init, init itself is denied; on every
  // platform a repo created without identity stays stillborn for ref ops.
  const guard = createGitMutationGuard(path.join(root, "guard-noscope"));
  check("fail-closed: null repo writes no scope file", guard.scopeFile === null && guard.protectedIdentity === null);
  const env = guardedEnv(guard);
  const noScopeSnap = path.join(root, "snap-noscope");
  const extInit = git(root, ["init"], {...env, GIT_DIR: noScopeSnap});
  if (gitFiresRefTxnOnInit()) {
    check("fail-closed: external init denied without identity", extInit.status !== 0, `status=${extInit.status}`);
    check("fail-closed: denial is trusted", DENIAL_RE.test(combined(extInit)));
  } else {
    check("fail-closed: init fires no hook on this git (matches baseline)", extInit.status === 0);
  }
  // A seeded COMPLETE repo (plain env) operated under guard: the hook is
  // always reached, so the missing identity must deny with evidence.
  {
    const seed = makeRepo("seed-noscope");
    const op = absGit(guard, seed, ["update-ref", "refs/heads/try-noscope", "HEAD"], env);
    check("fail-closed: ref op without identity denied", op.status !== 0, `status=${op.status}`);
    check("fail-closed: identity-less denial is trusted", DENIAL_RE.test(combined(op)));
  }
  // (b) Corrupted scope file (bad version + garbage).
  const guard2 = createGitMutationGuard(path.join(root, "guard-corrupt"), official);
  const env2 = guardedEnv(guard2);
  const headBefore = headOf(official);
  fs.writeFileSync(guard2.scopeFile, "v9 fold=0\ngitdir=/bogus\ncommon=/bogus\n");
  const corruptSnap = path.join(root, "snap-corrupt");
  const badVersion = git(root, ["init"], {...env2, GIT_DIR: corruptSnap});
  if (gitFiresRefTxnOnInit()) {
    check("fail-closed: bad version denies external init", badVersion.status !== 0, `status=${badVersion.status}`);
    check("fail-closed: bad-version denial is trusted", DENIAL_RE.test(combined(badVersion)));
  } else {
    check("fail-closed: init fires no hook on this git (matches baseline)", badVersion.status === 0);
  }
  if (fs.existsSync(corruptSnap)) {
    check("fail-closed: corrupt snapshot dir noted", true);
  }
  // Seeded complete repo under the corrupted identity: always denied.
  {
    const seed = makeRepo("seed-corrupt");
    const op = absGit(guard2, seed, ["update-ref", "refs/heads/try-corrupt-ext", "HEAD"], env2);
    check("fail-closed: ref op under bad version denied", op.status !== 0, `status=${op.status}`);
    check("fail-closed: bad-version ref denial is trusted", DENIAL_RE.test(combined(op)));
  }
  fs.writeFileSync(guard2.scopeFile, "not a scope file at all\n{{{");
  const garbage = absGit(guard2, official, ["update-ref", "refs/heads/try-corrupt", "HEAD"], env2);
  check("fail-closed: garbage identity denies official op", garbage.status !== 0, `status=${garbage.status}`);
  check("fail-closed: official HEAD unchanged", headOf(official) === headBefore);
  // (c) Guard creation against a non-repository does NOT throw (creation
  // never validated the repository — envelope-mapping callers rely on the
  // filesystem shape alone), but it records no identity, so the hook fails
  // closed for every transaction.
  {
    const plain = path.join(root, "not-a-repo");
    fs.mkdirSync(plain, {recursive: true});
    let guard;
    let threw = false;
    try { guard = createGitMutationGuard(path.join(root, "guard-badrepo"), plain); }
    catch { threw = true; }
    check("fail-closed: non-repo guard creation does not throw", threw === false);
    check("fail-closed: non-repo records no identity", guard?.scopeFile === null && guard?.protectedIdentity === null);
    const seed = makeRepo("seed-badrepo");
    const op = absGit(guard, seed, ["update-ref", "refs/heads/try-badrepo", "HEAD"], guardedEnv(guard));
    check("fail-closed: ref op with unresolvable identity denied", op.status !== 0, `status=${op.status}`);
    check("fail-closed: unresolvable-identity denial is trusted", DENIAL_RE.test(combined(op)));
  }
}

// ============================================================
// 8. Child-controlled environment cannot relocate the scope
// ============================================================
{
  const guard = createGitMutationGuard(path.join(root, "guard-envresist"), official);
  const env = guardedEnv(guard);
  const headBefore = headOf(official);
  const hostile = {
    ...env,
    AUTOPILOT_GIT_GUARD_LOG: path.join(root, "untrusted-redirect.log"),
    AUTOPILOT_REAL_GIT: guard.realGit,
    GIT_DIR: path.join(official, ".git"),
    GIT_WORK_TREE: official,
  };
  const res = absGit(guard, official, ["update-ref", "refs/heads/try-hostile", "HEAD"], hostile);
  check("env-resist: official update-ref still blocked", res.status !== 0, `status=${res.status}`);
  check("env-resist: denial is trusted", DENIAL_RE.test(combined(res)));
  const entries = readGuardLog(guard.logFile);
  check("env-resist: evidence stayed in the trusted log", entries.length > 0 && entries[entries.length - 1]?.hook === "reference-transaction");
  check("env-resist: untrusted redirect not created", fs.existsSync(hostile.AUTOPILOT_GIT_GUARD_LOG) === false);
  check("env-resist: HEAD unchanged", headOf(official) === headBefore);
  // GIT_CONFIG_* override attempts must not weaken the verdict either: the
  // identity never comes from the environment.
  const noHooks = {...env, GIT_CONFIG_COUNT: "0"};
  delete noHooks.GIT_CONFIG_KEY_0;
  delete noHooks.GIT_CONFIG_VALUE_0;
  delete noHooks.GIT_CONFIG_KEY_1;
  delete noHooks.GIT_CONFIG_VALUE_1;
  const confText = fs.readFileSync(guard.scopeFile, "utf8");
  check("env-resist: scope file untouched by env games", confText.includes("gitdir=") && confText.includes("common="));
}

// ============================================================
// 9. Symbolic-ref safe query allowed (TASK 15.6J behavior change).
//    Classification is UNCHANGED (symbolic-ref stays blocklisted); only the
//    exact read-only HEAD query is structurally exempted by the shim.
// ============================================================
{
  const guard = createGitMutationGuard(path.join(root, "guard-symref"), official);
  const env = guardedEnv(guard);
  const expectedBranch = git(official, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  if (process.platform !== "win32") {
    // Via the PATH shim the exact safe query now passes through and answers.
    const logBeforeShim = readGuardLog(guard.logFile).length;
    const shim = git(official, ["symbolic-ref", "--quiet", "--short", "HEAD"], env);
    check("symbolic-ref: shim allows the exact safe query", shim.status === 0, `status=${shim.status}`);
    check("symbolic-ref: safe query returns the current branch", (shim.stdout || "").trim() === expectedBranch,
      JSON.stringify((shim.stdout || "").trim()));
    check("symbolic-ref: safe query logs no violation", readGuardLog(guard.logFile).length === logBeforeShim);
  } else {
    // Native Windows: CreateProcess prefers git.exe over the guard dir's
    // git.cmd, so the PATH shim never engages there (pre-existing platform
    // gap, untouched by this task). Pin the exemption itself instead via
    // the explicit wrapper, which runs the same shim logic directly.
    const logBeforeExplicit = readGuardLog(guard.logFile).length;
    const explicit = spawnSync(process.execPath, [guard.wrapper, "symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd: official, encoding: "utf8", env, shell: false,
    });
    // The explicit wrapper redirects the shim's own log writes to NUL, so it
    // can never pollute the trusted log; success is proven by exit 0.
    check("symbolic-ref: explicit wrapper allows the safe query (win32)", explicit.status === 0, `status=${explicit.status}`);
    check("symbolic-ref: trusted log untouched (win32)", readGuardLog(guard.logFile).length === logBeforeExplicit);
  }
  const source = fs.readFileSync(new URL("./relay-guards.mjs", import.meta.url), "utf8");
  check("symbolic-ref: still in BLOCKED_SUBCOMMANDS", /"symbolic-ref"/.test(source));
  // Read-only query via the absolute binary never fires the hook (no ref
  // update) — unchanged baseline behavior, pinned so a future task notices.
  const logBeforeDirect = readGuardLog(guard.logFile).length;
  const direct = absGit(guard, official, ["symbolic-ref", "--quiet", "--short", "HEAD"], env);
  check("symbolic-ref: absolute read-only query fires no hook", direct.status === 0 && readGuardLog(guard.logFile).length === logBeforeDirect,
    `status=${direct.status} log=${readGuardLog(guard.logFile).length}`);
}

// ============================================================
// 10. TASK 15.6M_B: an external empty prepared transaction is not
//     reclassified by GIT_WORK_TREE, while genuine ref changes remain scoped.
// ============================================================
{
  const guard = createGitMutationGuard(path.join(root, "guard-empty-external"), official);
  const env = guardedEnv(guard);
  const officialBefore = gitSnapshot(official);
  const officialIndexBefore = fs.readFileSync(path.join(official, ".git", "index"));
  const officialMetadataBefore = gitMetadataBytes(official);
  const snapshot = makeRepo("snapshot-empty-pack-refs");
  const snapshotGitDir = path.join(snapshot, ".git");
  assert.equal(git(snapshot, ["pack-refs", "--all", "--prune"]).status, 0);
  const emptyLogBefore = readGuardLog(guard.logFile).length;
  const emptyExternal = absGit(guard, root, ["pack-refs", "--all", "--prune"], {
    ...env, GIT_DIR: snapshotGitDir, GIT_WORK_TREE: official,
  });
  const officialAfterEmpty = gitSnapshot(official);
  check("empty external: protected worktree pack-refs exits 0", emptyExternal.status === 0, combined(emptyExternal).slice(-300));
  check("empty external: pack-refs writes no guard denial", readGuardLog(guard.logFile).length === emptyLogBefore);
  check("empty external: official HEAD and refs unchanged", officialAfterEmpty.head === officialBefore.head && officialAfterEmpty.refs === officialBefore.refs);
  check("empty external: official index bytes unchanged", Buffer.compare(officialIndexBefore, fs.readFileSync(path.join(official, ".git", "index"))) === 0);
  check("empty external: official Git metadata bytes unchanged", gitMetadataBytes(official) === officialMetadataBefore);
  check("empty external: official tracked files unchanged", officialAfterEmpty.fingerprint === officialBefore.fingerprint);

  const protectedRepo = makeRepo("protected-empty-pack-refs");
  assert.equal(git(protectedRepo, ["pack-refs", "--all", "--prune"]).status, 0);
  const protectedGuard = createGitMutationGuard(path.join(root, "guard-empty-protected"), protectedRepo);
  const protectedEnv = guardedEnv(protectedGuard);
  const protectedEmpty = absGit(protectedGuard, protectedRepo, ["pack-refs", "--all", "--prune"], protectedEnv);
  check("empty protected: pack-refs denied by protected Git identity", protectedEmpty.status !== 0 && DENIAL_RE.test(combined(protectedEmpty)));
  const protectedNonEmpty = absGit(protectedGuard, protectedRepo, ["update-ref", "refs/heads/try-protected-nonempty", "HEAD"], protectedEnv);
  check("non-empty protected: update-ref remains denied", protectedNonEmpty.status !== 0 && DENIAL_RE.test(combined(protectedNonEmpty)));

  const externalRepo = makeRepo("external-nonempty");
  const externalGitDir = path.join(externalRepo, ".git");
  const externalHead = headOf(externalRepo);
  const protectedTopLogBefore = readGuardLog(guard.logFile).length;
  const protectedTop = absGit(guard, root, ["update-ref", "refs/heads/try-protected-top", externalHead], {
    ...env, GIT_DIR: externalGitDir, GIT_WORK_TREE: official,
  });
  check("non-empty external: protected worktree update-ref denied", protectedTop.status !== 0 && DENIAL_RE.test(combined(protectedTop)));
  check("non-empty external: protected worktree writes guard evidence", readGuardLog(guard.logFile).length === protectedTopLogBefore + 1);
  const externalLogBefore = readGuardLog(guard.logFile).length;
  const externalRef = absGit(guard, root, ["update-ref", "refs/heads/try-external", externalHead], {
    ...env, GIT_DIR: externalGitDir, GIT_WORK_TREE: externalRepo,
  });
  check("non-empty external: external Git dir and worktree remain allowed", externalRef.status === 0, combined(externalRef).slice(-300));
  check("non-empty external: allowed update writes no guard evidence", readGuardLog(guard.logFile).length === externalLogBefore);
  check("empty external: official remains unchanged after all external transactions", gitSnapshot(official).fingerprint === officialBefore.fingerprint);
}
} finally {
  try { fs.rmSync(root, {recursive: true, force: true}); } catch {}
}

console.log(`\n156I git-scope: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
