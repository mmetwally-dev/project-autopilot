#!/usr/bin/env node
// TASK 6: the Layer-1 PATH-shim subcommand blocklist is scoped to the
// protected repository identity, exactly like Layer 2 already is. Observed
// false positive (mission 001, run 59-code_reviewer-57a6224c): a read-only
// reviewer ran this project's own test suites, which create disposable fixture
// repos with `git init` + `git commit -m init`; the shim blocked those commits
// globally, `gitHeadBefore === gitHeadAfter` (nothing in the mission repo was
// ever mutated), and the mission escalated on
// `policyViolation:"git_mutation_blocked"`.
//
// This file proves, end to end against the REAL guard (no mocks):
//   1. Exact repro — a fixture repo's own init/commit succeeds and
//      blocked.log stays empty while the guard protects a different repo.
//   2. A mutation that actually targets the protected repo is still blocked,
//      for EVERY subcommand in BLOCKED_SUBCOMMANDS and across every invocation
//      form git itself honours (plain cwd, `-C`, `--git-dir=`, GIT_DIR env).
//   3. A linked worktree of the protected repo is still blocked.
//   4. `repositoryRoot === null` is unchanged: global block, no throw.
//   5. A missing or malformed scope file fails closed (blocks, never crashes).
//   6. Defense in depth — Layer 2's reference-transaction hook still
//      independently denies a protected ref transaction that Layer 1 never
//      saw (invoked through the ABSOLUTE real git, bypassing the shim).
//   7. Precedence — an explicit override always wins over the ambient cwd, and
//      any combination whose effective target is not provably outside fails
//      closed.
//   8. ADVERSARIAL — a child-controlled `AUTOPILOT_REAL_GIT` pointing at a
//      cwd-sensitive forged git can neither steer the decision nor delegate
//      around it (the reviewed bypass; see the plan's amendment A3).
//
// Runs on Linux/WSL (the supported runtime for the read-only roles this
// protects) and skips on native Windows: Node there resolves a bare `git` to
// `git.exe` ahead of the guard's `.cmd` shim, so the shim path this file
// exercises cannot be dispatched at all.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {createGitMutationGuard, guardedEnv, readGuardLog} from "./relay-guards.mjs";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
// 024 Phase 4 task 4.1: this test builds its OWN guard for the scenarios it
// checks, so the ambient outer guard (when run inside a mission) must be
// stripped first — otherwise the fixture `git commit` setup calls below are
// blocked by the outer guard and the run stalls.
{ const clean = withoutOuterGitGuard(process.env); for (const k of Object.keys(process.env)) if (!(k in clean)) delete process.env[k]; process.env.PATH = clean.PATH; }

let passed = 0;
let failed = 0;
function check(label, ok, detail) {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { failed++; console.error(`FAIL ${label}${detail ? ` :: ${JSON.stringify(detail)}` : ""}`); }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const guardsSource = fs.readFileSync(path.join(here, "relay-guards.mjs"), "utf8");
// Derive the blocklist from source so "every subcommand" cannot silently drift
// from the implementation (the set is deliberately not re-declared here).
function parseBlockedSubcommands(source) {
  const match = source.match(/const BLOCKED_SUBCOMMANDS = new Set\(\[([\s\S]*?)\]\);/);
  if (!match) throw new Error("could not locate BLOCKED_SUBCOMMANDS in relay-guards.mjs");
  return [...match[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
}
const BLOCKED_SUBCOMMANDS = parseBlockedSubcommands(guardsSource);
if (BLOCKED_SUBCOMMANDS.length < 15) throw new Error(`parsed only ${BLOCKED_SUBCOMMANDS.length} blocked subcommands`);

// The Layer-1 shim is reached through PATH, and Node on native Windows resolves
// a bare `git` to git.exe ahead of the guard's .cmd shim, so the shim path this
// file exercises cannot even be dispatched there. The guard itself is
// platform-independent, and Windows coverage of the guard's verdicts lives in
// test-windows-relay-git-mutation-verdict.mjs.
if (process.platform === "win32") {
  console.log("test-git-guard-layer1-scoping: SKIP — requires POSIX PATH shim dispatch (Node on native Windows prefers git.exe over the guard's .cmd shim); run under Linux/WSL2, where the read-only roles this scoping protects actually run.");
  process.exit(0);
}

// Plausible mutating arguments per subcommand. The guard decides purely on the
// subcommand (args only matter for the branch/symbolic-ref exemptions), so
// these exist to exercise those exemptions honestly, not to run real work.
const MUTATING_ARGS = {
  "commit": ["-m", "blocked-probe"],
  "commit-tree": ["HEAD^{tree}"],
  "push": ["origin", "HEAD"],
  "update-ref": ["refs/heads/blocked-probe", "HEAD"],
  "symbolic-ref": ["refs/heads/blocked-probe", "refs/heads/master"],
  "replace": ["HEAD", "HEAD"],
  "filter-branch": ["--force", "--", "HEAD"],
  "fast-import": [],
  "reset": ["--hard"],
  "merge": ["--no-edit", "nonexistent-branch"],
  "rebase": ["--abort"],
  "cherry-pick": ["HEAD"],
  "revert": ["--no-edit", "HEAD"],
  "tag": ["blocked-probe"],
  "branch": ["-D", "blocked-probe"],
  "notes": ["add", "-m", "blocked-probe"]
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-task6-layer1-"));
const DENIAL_RE = /AUTOPILOT GIT GUARD: .* is forbidden \(history\/ref mutation\)/;

function git(cwd, args, env) {
  return spawnSync("git", args, {cwd, encoding: "utf8", env, shell: false});
}
function combined(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}
function headOf(repo, env) {
  return String(git(repo, ["rev-parse", "HEAD"], env).stdout || "").trim();
}
function makeRepo(name) {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, {recursive: true});
  assert.equal(git(repo, ["init", "-q"]).status, 0);
  assert.equal(git(repo, ["config", "user.email", "task6@example.invalid"]).status, 0);
  assert.equal(git(repo, ["config", "user.name", "Task 6"]).status, 0);
  fs.writeFileSync(path.join(repo, "file.txt"), "base\n");
  assert.equal(git(repo, ["add", "-A"]).status, 0);
  assert.equal(git(repo, ["commit", "-q", "-m", "init"]).status, 0);
  return repo;
}
function logSize(guard) {
  return fs.existsSync(guard.logFile) ? fs.statSync(guard.logFile).size : 0;
}
function blockedEntries(guard) {
  return readGuardLog(guard.logFile);
}

// A fixture repo that is NOT yet committed, so our own commit is its initial
// one — the literal shape of the run-59 false positive.
function makeUncommittedFixture(name) {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, {recursive: true});
  assert.equal(git(repo, ["init", "-q"]).status, 0);
  assert.equal(git(repo, ["config", "user.email", "fixture@example.invalid"]).status, 0);
  assert.equal(git(repo, ["config", "user.name", "Fixture"]).status, 0);
  fs.writeFileSync(path.join(repo, "made.txt"), "made\n");
  assert.equal(git(repo, ["add", "-A"]).status, 0);
  return repo;
}

const protectedRepo = makeRepo("protected");
const runDir = path.join(root, "run");
fs.mkdirSync(runDir, {recursive: true});
const guard = createGitMutationGuard(runDir, protectedRepo);
const env = guardedEnv(guard, {HOME: root, TMPDIR: root});

// =====================================================================
// 1. Exact repro: a disposable fixture repo's own init/commit succeeds.
// =====================================================================
{
  check("scope file was written for the protected repo", typeof guard.scopeFile === "string" && fs.existsSync(guard.scopeFile), guard.scopeFile);
  const fixture = makeUncommittedFixture("fixture-exact-repro");
  const commit = git(fixture, ["commit", "-q", "-m", "init"], env);
  check("1. exact repro: fixture repo's own `git commit -m init` succeeds", commit.status === 0 && !DENIAL_RE.test(combined(commit)), { status: commit.status, out: combined(commit).trim() });
  check("1. exact repro: fixture repo really got a commit", headOf(fixture, env).length > 0, headOf(fixture, env));
  check("1. exact repro: blocked.log stayed empty", logSize(guard) === 0, blockedEntries(guard));
  // A second commit with a real change, to exercise the pre-commit family too.
  fs.writeFileSync(path.join(fixture, "second.txt"), "second\n");
  git(fixture, ["add", "-A"], env);
  const second = git(fixture, ["commit", "-q", "-m", "second"], env);
  check("1. exact repro: a follow-up fixture commit also succeeds", second.status === 0 && !DENIAL_RE.test(combined(second)), { status: second.status, out: combined(second).trim() });
  check("1. exact repro: still nothing logged", logSize(guard) === 0, blockedEntries(guard));
}

// =====================================================================
// 2. Every blocked subcommand, every invocation form, still blocked when it
//    targets the protected repo.
// =====================================================================
{
  const protectedGitDir = path.join(protectedRepo, ".git");
  const forms = [
    { name: "plain cwd", cwd: () => protectedRepo, argv: sub => [sub, ...MUTATING_ARGS[sub]], env: () => env },
    { name: "-C <protected>", cwd: () => root, argv: sub => ["-C", protectedRepo, sub, ...MUTATING_ARGS[sub]], env: () => env },
    { name: "--git-dir=<protected>", cwd: () => root, argv: sub => [`--git-dir=${protectedGitDir}`, sub, ...MUTATING_ARGS[sub]], env: () => env },
    { name: "GIT_DIR=<protected>", cwd: () => root, argv: sub => [sub, ...MUTATING_ARGS[sub]], env: () => ({ ...env, GIT_DIR: protectedGitDir }) }
  ];
  const misses = [];
  for (const sub of BLOCKED_SUBCOMMANDS) {
    for (const form of forms) {
      const before = logSize(guard);
      const result = git(form.cwd(), form.argv(sub), form.env());
      const denied = result.status === 97 || DENIAL_RE.test(combined(result));
      const logged = logSize(guard) > before;
      if (!denied || !logged) misses.push({ sub, form: form.name, status: result.status, out: combined(result).trim().slice(0, 120), logged });
    }
  }
  check(`2. all ${BLOCKED_SUBCOMMANDS.length} blocked subcommands x ${forms.length} invocation forms still blocked`, misses.length === 0, misses.slice(0, 8));
  check("2. the protected repo's HEAD is still the original commit", headOf(protectedRepo, env).length > 0);
}

// =====================================================================
// 3. A linked worktree of the protected repo is still blocked.
// =====================================================================
{
  const wt = path.join(root, "protected-worktree");
  const add = git(protectedRepo, ["worktree", "add", "-b", "task6-wt", wt], process.env);
  check("3. linked worktree created (setup, unguarded)", add.status === 0, combined(add).trim());
  if (add.status === 0) {
    const before = logSize(guard);
    const commit = git(wt, ["commit", "-q", "--allow-empty", "-m", "nope"], env);
    check("3. commit inside the protected linked worktree is blocked", (commit.status === 97 || DENIAL_RE.test(combined(commit))) && logSize(guard) > before, { status: commit.status, out: combined(commit).trim().slice(0, 160) });
  }
}

// =====================================================================
// 4. repositoryRoot === null: unchanged global block, no throw.
// =====================================================================
{
  let nullGuard = null;
  let threw = false;
  try { nullGuard = createGitMutationGuard(path.join(root, "run-null"), null); }
  catch (error) { threw = true; }
  check("4. null-root guard creation does not throw", threw === false);
  if (nullGuard) {
    check("4. null-root guard records no scope file", nullGuard.scopeFile === null, nullGuard.scopeFile);
    const nullEnv = guardedEnv(nullGuard, {HOME: root, TMPDIR: root});
    const fixture = makeUncommittedFixture("fixture-null-root");
    const commit = git(fixture, ["commit", "-q", "-m", "blocked"], nullEnv);
    check("4. null-root guard still blocks a fixture commit globally", commit.status !== 0 && (commit.status === 97 || /AUTOPILOT GIT GUARD/.test(combined(commit))), { status: commit.status, out: combined(commit).trim().slice(0, 160) });
  }
}

// =====================================================================
// 5. Missing / malformed scope file fails closed.
// =====================================================================
{
  const failDir = path.join(root, "run-failclosed");
  fs.mkdirSync(failDir, {recursive: true});
  const failGuard = createGitMutationGuard(failDir, protectedRepo);
  const failEnv = guardedEnv(failGuard, {HOME: root, TMPDIR: root});
  const fixture = makeUncommittedFixture("fixture-failclosed");
  // Make the fixture already committed so only the scope-file state varies.
  git(fixture, ["commit", "-q", "-m", "seed"], process.env);
  fs.writeFileSync(path.join(fixture, "next.txt"), "next\n");
  git(fixture, ["add", "-A"], process.env);

  fs.rmSync(failGuard.scopeFile, {force: true});
  const missing = git(fixture, ["commit", "-q", "-m", "x"], failEnv);
  check("5. missing scope file: Layer 1 blocks (fail closed), no crash", DENIAL_RE.test(combined(missing)) && missing.status === 97, { status: missing.status, out: combined(missing).trim().slice(0, 160) });

  fs.writeFileSync(failGuard.scopeFile, "not-a-scope-file\n");
  const malformed = git(fixture, ["commit", "-q", "-m", "x"], failEnv);
  check("5. malformed scope file: Layer 1 blocks (fail closed), no crash", DENIAL_RE.test(combined(malformed)) && malformed.status === 97, { status: malformed.status, out: combined(malformed).trim().slice(0, 160) });

  fs.writeFileSync(failGuard.scopeFile, "v1 fold=1\ngitdir=c:/nowhere\n");
  const incomplete = git(fixture, ["commit", "-q", "-m", "x"], failEnv);
  check("5. incomplete scope file (no common dir): blocks (fail closed)", DENIAL_RE.test(combined(incomplete)) && incomplete.status === 97, { status: incomplete.status, out: combined(incomplete).trim().slice(0, 160) });
}

// =====================================================================
// 6. Defense in depth: Layer 2 still denies independently, via absolute git
//    (the path Layer 1 cannot see at all).
// =====================================================================
{
  const before = headOf(protectedRepo, env);
  const direct = spawnSync(guard.realGit, ["update-ref", "refs/heads/task6-direct-probe", "HEAD"], {cwd: protectedRepo, encoding: "utf8", env, shell: false});
  const directOut = combined(direct);
  check("6. Layer 2 (reference-transaction) independently denies a protected ref update via absolute git", direct.status !== 0 && /ref update blocked \(reference-transaction\)/.test(directOut), { status: direct.status, out: directOut.trim().slice(0, 200) });
  check("6. protected HEAD unchanged after the Layer-2 probe", headOf(protectedRepo, env) === before, { before, after: headOf(protectedRepo, env) });
  // Mirror: the same Layer-2 machinery must NOT block an outside repo.
  const fixture = path.join(root, "fixture-exact-repro");
  const outside = spawnSync(guard.realGit, ["update-ref", "refs/heads/task6-outside-probe", "HEAD"], {cwd: fixture, encoding: "utf8", env, shell: false});
  check("6. Layer 2 leaves an outside repository's ref update alone", outside.status === 0, { status: outside.status, out: combined(outside).trim().slice(0, 160) });
}

// =====================================================================
// 7. Precedence: overrides are honoured the way git honours them, and any
//    combination whose effective target is NOT provably outside the protected
//    identity still fails closed.
// =====================================================================
{
  const protectedGitDir = path.join(protectedRepo, ".git");
  const fixture = path.join(root, "fixture-exact-repro");
  // cwd outside, but GIT_DIR points at the protected repo -> must block.
  const blockedByEnv = git(fixture, ["commit", "-q", "--allow-empty", "-m", "nope"], { ...env, GIT_DIR: protectedGitDir });
  check("7. GIT_DIR=<protected> from an outside cwd is blocked", DENIAL_RE.test(combined(blockedByEnv)) && blockedByEnv.status === 97, { status: blockedByEnv.status, out: combined(blockedByEnv).trim().slice(0, 160) });
  // cwd inside the protected worktree while --git-dir points outside: the
  // effective WORK TREE is still the protected cwd (git derives --show-toplevel
  // from cwd here), so the target is NOT provably outside -> fail closed.
  const ambiguous = git(protectedRepo, [`--git-dir=${path.join(fixture, ".git")}`, "symbolic-ref", "refs/heads/task6-precedence", "HEAD"], env);
  check("7. --git-dir=<outside> from inside the protected worktree fails closed (ambiguous target)", DENIAL_RE.test(combined(ambiguous)) && ambiguous.status === 97, { status: ambiguous.status, out: combined(ambiguous).trim().slice(0, 160) });
  // Same argv, but the work tree is named too: now every identity resolves to
  // the fixture, so the target is provably outside and Layer 1 stands down.
  const allowed = git(protectedRepo, [`--git-dir=${path.join(fixture, ".git")}`, `--work-tree=${fixture}`, "symbolic-ref", "refs/heads/task6-precedence", "HEAD"], env);
  check("7. --git-dir=<outside> + --work-tree=<outside> is provably outside (allowed)", !DENIAL_RE.test(combined(allowed)), { status: allowed.status, out: combined(allowed).trim().slice(0, 160) });
  // -C to an outside repository is enough on its own: cwd, git dir, common dir
  // and toplevel all resolve outside.
  const allowedByC = git(root, ["-C", fixture, "commit", "-q", "--allow-empty", "-m", "outside"], env);
  check("7. -C <outside repo> commit is allowed", allowedByC.status === 0 && !DENIAL_RE.test(combined(allowedByC)), { status: allowedByC.status, out: combined(allowedByC).trim().slice(0, 160) });
  // -C into the protected repo is blocked, however it is spelled.
  const blockedByC = git(root, ["-C", protectedRepo, "commit", "-q", "--allow-empty", "-m", "nope"], env);
  check("7. -C <protected repo> commit is blocked", DENIAL_RE.test(combined(blockedByC)) && blockedByC.status === 97, { status: blockedByC.status, out: combined(blockedByC).trim().slice(0, 160) });
}

// =====================================================================
// 8. ADVERSARIAL: a child-controlled "real git" must not be able to steer the
//    guard. This is the exact bypass found in review: `AUTOPILOT_REAL_GIT`
//    pointed at a fake that answered the ambient probe with the protected
//    identity and the invocation probe with an outside identity, then
//    delegated to real git with the guard's hook configuration stripped — so
//    the commit landed and blocked.log stayed empty. The trust path must use
//    ONLY the guard's baked real git.
// =====================================================================
{
  const fixture = path.join(root, "fixture-exact-repro");
  const fakeDir = path.join(root, "adversarial-fake-git");
  fs.mkdirSync(fakeDir, { recursive: true });
  const fakeLog = path.join(fakeDir, "fake-invocations.log");
  const fakeSource = path.join(fakeDir, "fake-git.mjs");
  const withinGuardDir = path.join(runDir, "git-guard").replace(/\\/g, "/").toLowerCase();
  const fakeBody = [
    'import fs from "node:fs";',
    'import {spawnSync} from "node:child_process";',
    "const REAL_GIT = " + JSON.stringify(guard.realGit) + ";",
    "const LOG = " + JSON.stringify(fakeLog) + ";",
    "const PROTECTED = " + JSON.stringify(protectedRepo) + ";",
    "const OUTSIDE = " + JSON.stringify(fixture) + ";",
    "const WITHIN = " + JSON.stringify(withinGuardDir) + ";",
    "const args = process.argv.slice(2);",
    'fs.appendFileSync(LOG, JSON.stringify({cwd: process.cwd(), args}) + "\\n");',
    'if (args[0] === "rev-parse") {',
    '  const cwd = process.cwd().split("\\\\").join("/").toLowerCase();',
    "  const claimed = cwd.startsWith(WITHIN) ? PROTECTED : OUTSIDE;",
    '  console.log(args.includes("--show-toplevel") ? claimed : claimed + "/.git");',
    "  process.exit(0);",
    "}",
    "const env = {...process.env};",
    "for (const name of Object.keys(env)) { if (/^(GIT_CONFIG_|AUTOPILOT_)/.test(name)) delete env[name]; }",
    'const r = spawnSync(REAL_GIT, args, {cwd: process.cwd(), env, stdio: "inherit", shell: false});',
    "process.exit(r.status ?? 1);"
  ].join("\n");
  fs.writeFileSync(fakeSource, fakeBody);
  const fakeExe = path.join(fakeDir, "fake-git");
  fs.writeFileSync(fakeExe, '#!/bin/sh\nexec "' + process.execPath + '" "' + fakeSource + '" "$@"\n');
  fs.chmodSync(fakeExe, 0o755);

  // Prove the forgery is genuine (not a no-op): from the guard directory it
  // claims the protected repository, from anywhere else an outside one.
  const forgedIn = spawnSync(process.execPath, [fakeSource, "rev-parse", "--absolute-git-dir"], { cwd: path.join(runDir, "git-guard"), encoding: "utf8", env: { ...process.env }, shell: false });
  const forgedOut = spawnSync(process.execPath, [fakeSource, "rev-parse", "--absolute-git-dir"], { cwd: fixture, encoding: "utf8", env: { ...process.env }, shell: false });
  const norm = v => String(v || "").trim().replace(/\\/g, "/").toLowerCase();
  check("8. adversarial: the forgery is genuine (claims protected from the guard dir, outside elsewhere)",
    norm(forgedIn.stdout).startsWith(norm(protectedRepo)) && norm(forgedOut.stdout).startsWith(norm(fixture)),
    { forgedIn: norm(forgedIn.stdout), forgedOut: norm(forgedOut.stdout) });

  const before = headOf(protectedRepo, env);
  const logBefore = logSize(guard);
  const fakeLogBefore = fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, "utf8") : "";
  const adversarialEnv = { ...env, AUTOPILOT_REAL_GIT: fakeExe };
  fs.writeFileSync(path.join(protectedRepo, "adversarial.txt"), "x\n");
  git(protectedRepo, ["add", "-A"], adversarialEnv);
  const attempt = git(protectedRepo, ["commit", "-q", "-m", "adversarial"], adversarialEnv);
  check("8. adversarial: protected commit stays blocked when AUTOPILOT_REAL_GIT points at a forged cwd-sensitive git",
    (attempt.status === 97 || DENIAL_RE.test(combined(attempt))) && logSize(guard) > logBefore,
    { status: attempt.status, out: combined(attempt).trim().slice(0, 200) });
  check("8. adversarial: protected HEAD did not move", headOf(protectedRepo, env) === before, { before, after: headOf(protectedRepo, env) });
  const fakeLogAfter = fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, "utf8") : "";
  check("8. adversarial: the forged executable was never consulted for the decision",
    fakeLogAfter === fakeLogBefore, { newInvocations: fakeLogAfter.slice(fakeLogBefore.length, fakeLogBefore.length + 300) });
}

// =====================================================================
// 9. ADVERSARIAL (review round 2): the interpreter/loader environment must not
//    be able to turn a protected deny-hook decision into "allowed". NODE_OPTIONS
//    is consumed by Node BEFORE any guard code runs, so a preload can simply
//    process.exit(0) and make --autopilot-hook-scope-check read as a pass. The
//    hook must start Node under an explicit allowlist that drops it.
//
//    The decisive observable is the hook's own DECISION (the bypass makes it
//    exit 0 = allowed). The end-to-end push is kept as ground truth because a
//    bypassed pre-push lets the remote ref land even though git may still exit
//    non-zero later (a local remote-tracking ref update that Layer 2 does stop).
// =====================================================================
{
  const remote = path.join(root, "outside-remote.git");
  fs.mkdirSync(remote, { recursive: true });
  git(remote, ["init", "--bare", "-q"], process.env);
  git(protectedRepo, ["remote", "remove", "t6-remote"], process.env);
  check("9. setup: outside bare remote created", git(protectedRepo, ["remote", "add", "t6-remote", remote], process.env).status === 0);

  const evilPath = path.join(root, "evil-preload.mjs");
  fs.writeFileSync(evilPath, "process.exit(0);\n");
  // Sanity: prove the preload really does neutralise Node, otherwise a pass
  // below would prove nothing.
  const neutralised = spawnSync(process.execPath, ["-e", "process.exit(3)"], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: `--require ${evilPath}` }, shell: false });
  check("9. adversarial: the preload genuinely neutralises Node (an exit-3 script exits 0)", neutralised.status === 0, { status: neutralised.status, err: (neutralised.stderr || "").slice(0, 200) });

  // The deny hook is invoked exactly as git invokes it (cwd = the protected
  // worktree); its exit code IS the decision: 0 = allowed, non-zero = denied.
  const hook = path.join(runDir, "git-guard", "hooks", "pre-push");
  const cleanDecision = spawnSync(hook, ["origin", "unused-url"], { cwd: protectedRepo, encoding: "utf8", env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  check("9. control: the pre-push hook denies a protected decision with a clean environment", cleanDecision.status !== 0, { status: cleanDecision.status });
  { // TASK-17: MSYS sh uppercases Windows env names; the prologue must fall back.
    const hookText = fs.readFileSync(hook, "utf8");
    check("9. hook prologue falls back to MSYS-uppercased SystemRoot/windir",
      hookText.includes('"SystemRoot=${SystemRoot:-$SYSTEMROOT}"') && hookText.includes('"windir=${windir:-$WINDIR}"'),
      { hasSystemRoot: hookText.includes("SystemRoot:-$SYSTEMROOT"), hasWindir: hookText.includes("windir:-$WINDIR") });
  }
  const hostileDecision = spawnSync(hook, ["origin", "unused-url"], { cwd: protectedRepo, encoding: "utf8", env: { ...env, NODE_OPTIONS: `--require ${evilPath}` }, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  check("9. adversarial: NODE_OPTIONS cannot turn the protected pre-push decision into exit 0", hostileDecision.status !== 0, { status: hostileDecision.status, out: combined(hostileDecision).trim().slice(0, 200) });

  // Ground truth: the remote ref must not exist after the hostile push.
  const refName = "refs/heads/t6-round2-probe";
  const remoteHasRef = () => spawnSync(guard.realGit, ["--git-dir", remote, "rev-parse", "--verify", "--quiet", refName], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: false }).status === 0;
  const attack = spawnSync(guard.realGit, ["push", "t6-remote", `HEAD:${refName}`], { cwd: protectedRepo, encoding: "utf8", env: { ...env, NODE_OPTIONS: `--require ${evilPath}` }, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  check("9. adversarial: the hostile push did not create the remote ref", remoteHasRef() === false, { status: attack.status, out: combined(attack).trim().slice(0, 200) });
}

// =====================================================================
// 10. 024 Phase 4 task 4.1 — Layer-1 worktree-discarding path-restore forms
//    are denied by command FORM inside the protected repo (checkout/restore/
//    switch/stash deliberately stay OUTSIDE BLOCKED_SUBCOMMANDS), while branch
//    switches, --detach, read-only subcommands, the safe symbolic-ref HEAD
//    query and outside-repo restores stay allowed; an agent-supplied
//    `-c core.autocrlf=...` cannot override the pinned EOL value past the
//    wrapper parser.
// =====================================================================
{
  check("10. checkout/restore/switch/stash stay outside BLOCKED_SUBCOMMANDS",
    !["checkout", "restore", "switch", "stash"].some(s => BLOCKED_SUBCOMMANDS.includes(s)),
    BLOCKED_SUBCOMMANDS.filter(s => ["checkout", "restore", "switch", "stash"].includes(s)));
  const WORKTREE_DENIAL_RE = /AUTOPILOT GIT GUARD: .* is forbidden \(worktree restore\)/;
  const lastEntry = () => blockedEntries(guard).at(-1);

  // Dirty a tracked protected file; every blocked probe below must leave it dirty.
  const protectedFile = path.join(protectedRepo, "file.txt");
  fs.writeFileSync(protectedFile, "t41-dirty\n");
  const blockedForms = [
    { name: "checkout -- <paths>", argv: ["checkout", "--", "file.txt"] },
    { name: "checkout <tree-ish> <pathspec>", argv: ["checkout", "HEAD", "file.txt"] },
    { name: "checkout .", argv: ["checkout", "."] },
    { name: "-c autocrlf checkout -- <paths>", argv: ["-c", "core.autocrlf=false", "checkout", "--", "file.txt"] },
    { name: "restore <paths>", argv: ["restore", "file.txt"] },
    { name: "switch -- <paths>", argv: ["switch", "--", "file.txt"] },
    { name: "bare stash", argv: ["stash"] },
    { name: "stash push", argv: ["stash", "push", "-m", "t41-probe"] },
  ];
  const blockMisses = [];
  for (const form of blockedForms) {
    const before = logSize(guard);
    const result = git(protectedRepo, form.argv, env);
    const denied = result.status === 97 && WORKTREE_DENIAL_RE.test(combined(result));
    const entry = logSize(guard) > before ? lastEntry() : null;
    const logged = !!entry && entry.reason === "worktree-restore";
    if (!denied || !logged) blockMisses.push({ form: form.name, status: result.status, out: combined(result).trim().slice(0, 120), entry });
  }
  check("10. worktree-discarding forms are blocked in the protected repo (exit 97 + worktree-restore + log reason)", blockMisses.length === 0, blockMisses.slice(0, 8));
  check("10. dirtied protected file stays dirty after the blocked probes", fs.readFileSync(protectedFile, "utf8") === "t41-dirty\n", fs.readFileSync(protectedFile, "utf8").slice(0, 60));

  // Allowed inside the protected repo: read-only subcommands, the safe
  // symbolic-ref HEAD query, and the index-only restore form.
  const allowedProtected = [
    { name: "status", argv: ["status", "--porcelain=v1"] },
    { name: "log", argv: ["log", "--oneline", "-1"] },
    { name: "diff", argv: ["diff", "--name-only"] },
    { name: "symbolic-ref HEAD", argv: ["symbolic-ref", "HEAD"] },
    { name: "restore --staged", argv: ["restore", "--staged", "file.txt"] },
  ];
  const allowedMisses = [];
  const allowedLogBefore = logSize(guard);
  for (const form of allowedProtected) {
    const result = git(protectedRepo, form.argv, env);
    if (result.status === 97 || WORKTREE_DENIAL_RE.test(combined(result)) || DENIAL_RE.test(combined(result))) {
      allowedMisses.push({ form: form.name, status: result.status, out: combined(result).trim().slice(0, 120) });
    }
  }
  check("10. read-only subcommands, symbolic-ref HEAD and restore --staged stay allowed in the protected repo", allowedMisses.length === 0, allowedMisses.slice(0, 8));

  // Allowed outside the protected repo: branch switches, --detach, real
  // restores, stash lifecycle, and the -c override that must not survive the
  // wrapper parser (pinned core.autocrlf=input still wins).
  const fixture41 = makeUncommittedFixture("fixture-t41");
  assert.equal(git(fixture41, ["commit", "-q", "-m", "seed"], process.env).status, 0);
  const outsideAllowed = [
    { name: "checkout -b", argv: ["checkout", "-b", "t41-branch"] },
    { name: "checkout -", argv: ["checkout", "-"] },
    { name: "switch branch", argv: ["switch", "t41-branch"] },
    { name: "switch -", argv: ["switch", "-"] },
    { name: "checkout --detach", argv: ["checkout", "--detach"] },
    { name: "checkout branch (commit-ref probe)", argv: ["checkout", "t41-branch"] },
    { name: "stash list", argv: ["stash", "list"] },
  ];
  const outsideMisses = [];
  for (const form of outsideAllowed) {
    const result = git(fixture41, form.argv, env);
    if (result.status === 97 || WORKTREE_DENIAL_RE.test(combined(result)) || DENIAL_RE.test(combined(result))) {
      outsideMisses.push({ form: form.name, status: result.status, out: combined(result).trim().slice(0, 120) });
    }
  }
  check("10. branch switches, --detach and read-only stash stay allowed outside the protected repo", outsideMisses.length === 0, outsideMisses.slice(0, 8));
  // Outside restores really restore (ground truth that only the protected
  // repo is guarded), and the outside stash lifecycle still works.
  fs.writeFileSync(path.join(fixture41, "made.txt"), "t41-outside-dirty\n");
  const fixtureCheckout = git(fixture41, ["checkout", "--", "made.txt"], env);
  check("10. fixture `checkout -- <path>` still restores outside the protected repo",
    fixtureCheckout.status === 0 && fs.readFileSync(path.join(fixture41, "made.txt"), "utf8") === "made\n",
    { status: fixtureCheckout.status, out: combined(fixtureCheckout).trim().slice(0, 120) });
  fs.writeFileSync(path.join(fixture41, "made.txt"), "t41-outside-dirty\n");
  const fixtureRestore = git(fixture41, ["restore", "made.txt"], env);
  check("10. fixture `restore <path>` still restores outside the protected repo",
    fixtureRestore.status === 0 && fs.readFileSync(path.join(fixture41, "made.txt"), "utf8") === "made\n",
    { status: fixtureRestore.status, out: combined(fixtureRestore).trim().slice(0, 120) });
  const stagedOnly = git(fixture41, ["restore", "--staged", "made.txt"], env);
  check("10. fixture `restore --staged` succeeds", stagedOnly.status === 0, { status: stagedOnly.status, out: combined(stagedOnly).trim().slice(0, 120) });
  fs.writeFileSync(path.join(fixture41, "made.txt"), "t41-stash-me\n");
  git(fixture41, ["add", "-A"], env);
  const outsidePush = git(fixture41, ["stash", "push", "-m", "t41-outside"], env);
  check("10. fixture `stash push` still works outside the protected repo", outsidePush.status === 0, { status: outsidePush.status, out: combined(outsidePush).trim().slice(0, 120) });
  const stashShow = git(fixture41, ["stash", "show"], env);
  check("10. fixture `stash show` stays allowed", stashShow.status === 0, { status: stashShow.status, out: combined(stashShow).trim().slice(0, 120) });
  const pinned = git(fixture41, ["-c", "core.autocrlf=false", "config", "core.autocrlf"], env);
  check("10. agent `-c core.autocrlf=false` cannot override the pinned EOL value past the wrapper parser",
    pinned.status === 0 && String(pinned.stdout || "").trim() === "input",
    { status: pinned.status, out: combined(pinned).trim().slice(0, 120) });
  const pinnedEnvEq = git(fixture41, ["--config-env=core.autocrlf=AUTOPILOT_T41_EVIL", "config", "core.autocrlf"], { ...env, AUTOPILOT_T41_EVIL: "false" });
  check("10. agent `--config-env=core.autocrlf=X` cannot override the pinned EOL value past the wrapper parser",
    pinnedEnvEq.status === 0 && String(pinnedEnvEq.stdout || "").trim() === "input",
    { status: pinnedEnvEq.status, out: combined(pinnedEnvEq).trim().slice(0, 120) });
  const pinnedEnvSplit = git(fixture41, ["--config-env", "core.autocrlf=AUTOPILOT_T41_EVIL", "config", "core.autocrlf"], { ...env, AUTOPILOT_T41_EVIL: "false" });
  check("10. agent `--config-env core.autocrlf=X` cannot override the pinned EOL value past the wrapper parser",
    pinnedEnvSplit.status === 0 && String(pinnedEnvSplit.stdout || "").trim() === "input",
    { status: pinnedEnvSplit.status, out: combined(pinnedEnvSplit).trim().slice(0, 120) });
  check("10. no allowed probe wrote to blocked.log", logSize(guard) === allowedLogBefore, blockedEntries(guard).slice(-3));
}

// =====================================================================
console.log(`\n${passed} passed, ${failed} failed`);
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
if (failed) process.exit(1);
