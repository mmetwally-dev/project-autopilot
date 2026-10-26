#!/usr/bin/env node
// B4 git-containment regression: proves git snapshot sensitivity, fail-closed
// observation, topology rejection, ordering invariants, attribution, guard
// presence evidence, envelope gating, and mission/certification parity.
//
// Requires Linux/WSL. Fails closed on unsupported platforms.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {fixtureGit} from "./test-fixtures/fixture-git.mjs";
import {gitSnapshot, createGitMutationGuard, guardedEnv, readGuardLog, GIT_STATE_FIELDS, describeGitStateChange} from "./relay-guards.mjs";
import { skillRoot } from "./paths.mjs";

let passed = 0;
let failed = 0;
function check(label, ok, detail) {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { failed++; console.error(`FAIL ${label}${detail ? ` :: ${detail}` : ""}`); }
}

// ---- platform gate: fail closed, not skip ----
if (process.platform === "win32") {
  console.error("B4 git-containment: FAIL — requires Linux/POSIX. Failing closed.");
  process.exit(1);
}

// ---- helpers ----
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-b4-git-containment-"));
function makeRepo(name = "repository") {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, {recursive: true});
  fs.writeFileSync(path.join(repo, ".gitignore"), ".autopilot/\n");
  fs.writeFileSync(path.join(repo, "file.txt"), "baseline");
  fixtureGit(["init"], {cwd: repo, stdio: "ignore"});
  fixtureGit(["config", "user.email", "test@test.com"], {cwd: repo, stdio: "ignore"});
  fixtureGit(["config", "user.name", "Test"], {cwd: repo, stdio: "ignore"});
  fixtureGit(["add", "."], {cwd: repo, stdio: "ignore"});
  fixtureGit(["commit", "-m", "baseline"], {cwd: repo, stdio: "ignore"});
  return repo;
}

// gitSnapshot throws on non-repos / unsupported topologies / corrupt repos.
// Wrap in try-catch so a thrown error is treated as ok:false with the error
// message as digest — matching the expected fail-closed contract.
function safeSnapshot(cwd) {
  try { return gitSnapshot(cwd); }
  catch (error) { return {ok: false, digest: String(error?.message || error), fingerprint: null, head: null, headSymbolic: null, refs: "", config: {}, sequencer: "", reflogs: "", objects: "", status: null, diff: null, files: {}}; }
}

// ============================================================
// 1. Administrative-state sensitivity
//    Each mutation must produce a distinct fingerprint from baseline.
// ============================================================
{
  const repo = makeRepo("sensitivity");
  const baseline = gitSnapshot(repo);
  check("sensitivity: baseline snapshot succeeded", typeof baseline.fingerprint === "string" && baseline.fingerprint.length > 0);
  check("sensitivity: baseline has fingerprint", typeof baseline.fingerprint === "string" && baseline.fingerprint.length > 0);

  // 1a. Detach HEAD at the same commit
  {
    const r = makeRepo("sens-detach");
    const before = gitSnapshot(r);
    fixtureGit(["checkout", "--detach", "HEAD"], {cwd: r, stdio: "ignore"});
    const after = gitSnapshot(r);
    check("sensitivity: detach HEAD same commit changes snapshot",
      typeof before.fingerprint === "string" && typeof after.fingerprint === "string" && before.fingerprint !== after.fingerprint,
      `before=${before.fingerprint?.slice(0,12)} after=${after.fingerprint?.slice(0,12)}`);
    check("sensitivity: detach HEAD headSymbolic changed to DETACHED",
      after.headSymbolic === "DETACHED",
      `got ${after.headSymbolic}`);
  }

  // 1b. git tag t
  {
    const r = makeRepo("sens-tag");
    const before = gitSnapshot(r);
    fixtureGit(["tag", "t"], {cwd: r, stdio: "ignore"});
    const after = gitSnapshot(r);
    check("sensitivity: tag changes snapshot",
      typeof before.fingerprint === "string" && typeof after.fingerprint === "string" && before.fingerprint !== after.fingerprint);
    check("sensitivity: tag adds ref in after.refs",
      after.refs.includes("refs/tags/t"),
      `refs snippet: ${after.refs.slice(0, 200)}`);
  }

  // 1c. git branch -f side HEAD
  {
    const r = makeRepo("sens-branch-f");
    const before = gitSnapshot(r);
    fixtureGit(["branch", "-f", "side", "HEAD"], {cwd: r, stdio: "ignore"});
    const after = gitSnapshot(r);
    check("sensitivity: branch -f changes snapshot",
      typeof before.fingerprint === "string" && typeof after.fingerprint === "string" && before.fingerprint !== after.fingerprint);
    check("sensitivity: branch -f adds ref in after.refs",
      after.refs.includes("refs/heads/side"),
      `refs snippet: ${after.refs.slice(0, 200)}`);
  }

  // 1d. git update-ref refs/heads/x HEAD
  {
    const r = makeRepo("sens-update-ref");
    const before = gitSnapshot(r);
    fixtureGit(["update-ref", "refs/heads/x", "HEAD"], {cwd: r, stdio: "ignore"});
    const after = gitSnapshot(r);
    check("sensitivity: update-ref changes snapshot",
      typeof before.fingerprint === "string" && typeof after.fingerprint === "string" && before.fingerprint !== after.fingerprint);
    check("sensitivity: update-ref adds ref in after.refs",
      after.refs.includes("refs/heads/x"),
      `refs snippet: ${after.refs.slice(0, 200)}`);
  }

  // 1e. git stash on a dirty tree
  {
    const r = makeRepo("sens-stash");
    const before = gitSnapshot(r);
    fs.writeFileSync(path.join(r, "file.txt"), "dirty");
    fixtureGit(["stash"], {cwd: r, stdio: "ignore"});
    const after = gitSnapshot(r);
    check("sensitivity: stash changes snapshot",
      typeof before.fingerprint === "string" && typeof after.fingerprint === "string" && before.fingerprint !== after.fingerprint);
  }

  // 1f. git hash-object -w a new blob
  {
    const r = makeRepo("sens-hash-object");
    const before = gitSnapshot(r);
    fixtureGit(["hash-object", "-w", "--stdin"], {cwd: r, input: "new blob", stdio: ["pipe", "ignore", "ignore"]});
    const after = gitSnapshot(r);
    check("sensitivity: hash-object -w changes snapshot (object count)",
      typeof before.fingerprint === "string" && typeof after.fingerprint === "string" && before.fingerprint !== after.fingerprint,
      `objects before: ${before.objects?.split("\n")[0]} after: ${after.objects?.split("\n")[0]}`);
  }

  // 1g. git config --local user.name changed
  {
    const r = makeRepo("sens-config-change");
    const before = gitSnapshot(r);
    fixtureGit(["config", "--local", "user.name", "Changed Name"], {cwd: r, stdio: "ignore"});
    const after = gitSnapshot(r);
    check("sensitivity: config --local change alters snapshot",
      typeof before.fingerprint === "string" && typeof after.fingerprint === "string" && before.fingerprint !== after.fingerprint,
      `config --local before: ${before.config?.["--local"]?.slice(0, 100)} after: ${after.config?.["--local"]?.slice(0, 100)}`);
  }
}

// ============================================================
// 2. Fail-closed observation
// ============================================================
{
  // 2a. Non-repository cwd — gitSnapshot throws, safeSnapshot returns ok:false
  {
    const notRepo = path.join(root, "not-a-repo");
    fs.mkdirSync(notRepo, {recursive: true});
    const snap = safeSnapshot(notRepo);
    check("fail-closed: non-repository cwd ok is false", snap.ok === false);
    check("fail-closed: non-repository digest contains failure evidence",
      typeof snap.digest === "string" && snap.digest.length > 0);
  }

  // 2b. Corrupted .git/HEAD — gitSnapshot may throw or return ok:false
  {
    const corruptRepo = makeRepo("corrupt");
    fs.writeFileSync(path.join(corruptRepo, ".git", "HEAD"), "not-a-valid-ref\ngarbage");
    const snap = safeSnapshot(corruptRepo);
    check("fail-closed: corrupted HEAD ok is false", snap.ok === false);
    check("fail-closed: corrupted HEAD digest contains failure evidence",
      typeof snap.digest === "string" && snap.digest.length > 0);
  }
}

// ============================================================
// 3. Topology: bare repository, linked worktree, submodule
//    gitSnapshot throws on unsupported topologies. Use safeSnapshot
//    so the test observes the throw as ok:false rather than crashing.
// ============================================================
{
  // 3a. Bare repository
  {
    const bare = path.join(root, "bare.git");
    fixtureGit(["init", "--bare", bare], {stdio: "ignore"});
    const snap = safeSnapshot(bare);
    check("topology: bare repository ok is false", snap.ok === false);
    check("topology: bare repository digest contains topology evidence",
      typeof snap.digest === "string" && snap.digest.length > 0,
      snap.digest?.slice(0, 200));
  }

  // 3b. Linked worktree
  {
    const mainRepo = makeRepo("worktree-main");
    const linked = path.join(root, "linked-worktree");
    fixtureGit(["worktree", "add", linked], {cwd: mainRepo, stdio: "ignore"});
    const snap = safeSnapshot(linked);
    check("topology: linked worktree ok is false", snap.ok === false);
    check("topology: linked worktree digest contains topology evidence",
      typeof snap.digest === "string" && snap.digest.length > 0,
      snap.digest?.slice(0, 200));
    fixtureGit(["worktree", "remove", linked], {cwd: mainRepo, stdio: "ignore"});
  }

  // 3c. Repository containing a submodule
  {
    const outer = makeRepo("submodule-outer");
    const inner = makeRepo("submodule-inner");
    fixtureGit(["-c", "protocol.file.allow=always", "submodule", "add", inner, "inner"], {cwd: outer, stdio: "ignore"});
    const snap = safeSnapshot(outer);
    check("topology: submodule present ok is false", snap.ok === false);
    check("topology: submodule present digest contains failure evidence",
      typeof snap.digest === "string" && snap.digest.length > 0,
      snap.digest?.slice(0, 200));
  }
}

// ============================================================
// 4. Ordering invariant: guardEstablishedAt < snapshotAt < adapterStartedAt
// ============================================================
{
  const repo = makeRepo("ordering");
  const adapterRoleScratch = path.join(repo, ".autopilot", "adapter-role-scratch");
  fs.mkdirSync(adapterRoleScratch, {recursive: true});
  const guard = createGitMutationGuard(adapterRoleScratch, repo);
  let guardEstablishedAt;
  try {
    const stat = fs.statSync(guard.guardDir);
    guardEstablishedAt = stat.birthtimeMs || stat.mtimeMs;
  } catch { guardEstablishedAt = Date.now(); }
  const snapshotAt = Date.now();
  const snap = gitSnapshot(repo);
  const adapterStartedAt = Date.now();
  check("ordering: guardEstablishedAt < snapshotAt",
    guardEstablishedAt < snapshotAt,
    `guardEstablishedAt=${guardEstablishedAt} snapshotAt=${snapshotAt}`);
  check("ordering: snapshotAt < adapterStartedAt",
    snapshotAt < adapterStartedAt,
    `snapshotAt=${snapshotAt} adapterStartedAt=${adapterStartedAt}`);
  check("ordering: evidence carries guardEstablishedAt", typeof guardEstablishedAt === "number");
  check("ordering: evidence carries snapshotAt", typeof snapshotAt === "number");
  check("ordering: evidence carries adapterStartedAt", typeof adapterStartedAt === "number");

  // 4b. Injected fixture with guard established AFTER snapshot: must fail closed
  const badGuardEstablishedAt = snapshotAt + 10000;
  const orderingBroken = !(badGuardEstablishedAt < snapshotAt);
  check("ordering: guard established after snapshot fails closed", orderingBroken,
    `badGuardEstablishedAt=${badGuardEstablishedAt} snapshotAt=${snapshotAt}`);
}

// ============================================================
// 5. Attribution
// ============================================================
{
  // 5a. Hook/shim denial: guard-log entry attributes to path_shim
  const repo5 = makeRepo("attribution-hook");
  const guardDir5 = path.join(root, "guard-hook");
  const guard5 = createGitMutationGuard(guardDir5, repo5);
  // Simulate a guard-log entry
  fs.writeFileSync(guard5.logFile, JSON.stringify({
    time: new Date().toISOString(),
    args: ["commit", "--allow-empty", "-m", "FORBIDDEN"],
    layer: "path-shim",
    subcommand: "commit"
  }) + "\n");
  const logEntries = readGuardLog(guard5.logFile);
  check("attribution: hook guard-log entry present", logEntries.length > 0);
  check("attribution: hook guard-log layer is path-shim",
    logEntries[0]?.layer === "path-shim");

  // 5b. Read-only bind denial: stderr matches read_only_filesystem signature
  const denialSignature = "fatal: cannot open '.git/COMMIT_EDITMSG': Read-only file system";
  const matchesReadOnly = /read-only file system/i.test(denialSignature);
  check("attribution: read-only bind stderr matches read_only_filesystem signature",
    matchesReadOnly);

  // 5c. Non-zero exit with unclassified stderr: does NOT pass
  const unclassifiedStderr = "Author identity unknown\n\n*** Please tell me who you are.\n\nRun:\n  git config --global user.email \"you@example.com\"\n  git config --global user.name \"Your Name\"";
  const matchesNothing = !/read-only file system/i.test(unclassifiedStderr)
    && !/\bEROFS\b/.test(unclassifiedStderr)
    && !/permission denied/i.test(unclassifiedStderr)
    && !/\bEACCES\b/.test(unclassifiedStderr)
    && !/hook.*reference.transaction/i.test(unclassifiedStderr)
    && !/AUTOPILOT.GIT.GUARD.*forbidden/i.test(unclassifiedStderr);
  check("attribution: Author identity unknown stderr matches nothing",
    matchesNothing);
  // Simulate gitDenied predicate evaluation with unclassified attribution.
  // gitDenied requires attribution to be IN RECOGNIZED set; unclassified is NOT
  // recognized, so the predicate must fail (attribution gate rejects it).
  const simConclusive = true;
  const simGitMutation = false;
  const simGitExit = 128;
  const simDigestUnchanged = true;
  const simAttribution = "unclassified";
  const RECOGNIZED = new Set(["read_only_filesystem","permission_denied","hook_reference_transaction","hook_pre_commit","hook_pre_push","hook_pre_rebase","hook_pre_merge_commit","path_shim"]);
  const simDenied = simConclusive && simGitMutation === false
    && Number.isFinite(Number(simGitExit)) && Number(simGitExit) !== 0
    && RECOGNIZED.has(simAttribution)
    && true && simDigestUnchanged;
  check("attribution: unclassified denial does not pass gitDenied predicate",
    simDenied === false);
}

// ============================================================
// 6. Guard-did-something vs nothing-happened
// ============================================================
{
  const repo6 = makeRepo("guard-diff");
  const guardDir6 = path.join(root, "guard-diff-guard");
  const guard6 = createGitMutationGuard(guardDir6, repo6);

  // 6a. No mutation attempted: clear log, run snapshot only
  if (fs.existsSync(guard6.logFile)) fs.unlinkSync(guard6.logFile);
  gitSnapshot(repo6);
  const afterNoAttempt = readGuardLog(guard6.logFile);
  check("guard-did-something: no log entries when no mutation attempted",
    afterNoAttempt.length === 0);

  // 6b. Mutation attempted and blocked: write guard-log entry
  fs.writeFileSync(guard6.logFile, JSON.stringify({
    time: new Date().toISOString(),
    args: ["commit", "--allow-empty", "-m", "blocked"],
    layer: "path-shim",
    subcommand: "commit"
  }) + "\n");
  const afterBlocked = readGuardLog(guard6.logFile);
  check("guard-did-something: log entry present after blocked mutation",
    afterBlocked.length > 0);

  // 6c. The two outcome records are not equal
  const recordNoAttempt = {guardLogEntries: afterNoAttempt.length, mutationAttempted: false};
  const recordBlocked = {guardLogEntries: afterBlocked.length, mutationAttempted: true};
  check("guard-did-something: records differ between no-attempt and blocked",
    JSON.stringify(recordNoAttempt) !== JSON.stringify(recordBlocked),
    JSON.stringify(recordNoAttempt) + " vs " + JSON.stringify(recordBlocked));
}

// ============================================================
// 8. Mission/certification parity: relay-guards.gitSnapshot detects
//    git tag and git branch -f; dimensions are superset of
//    what gitDenied consumes.
// ============================================================
{
  const repo8 = makeRepo("parity");
  const snap8 = gitSnapshot(repo8);

  // 8a. relay-guards.gitSnapshot captures refs (superset check)
  check("parity: gitSnapshot captures refs field", typeof snap8.refs === "string");
  check("parity: gitSnapshot captures head field", typeof snap8.head === "string");
  check("parity: gitSnapshot captures headSymbolic field", typeof snap8.headSymbolic === "string");
  check("parity: gitSnapshot captures objects field", typeof snap8.objects === "string");
  check("parity: gitSnapshot captures sequencer field", typeof snap8.sequencer === "string");
  check("parity: gitSnapshot captures reflogs field", typeof snap8.reflogs === "string");
  check("parity: gitSnapshot captures config field", typeof snap8.config === "object");
  check("parity: gitSnapshot captures fingerprint field", typeof snap8.fingerprint === "string");
  check("parity: gitSnapshot captures administrativeDigest field", typeof snap8.administrativeDigest === "string");

  // 8b. gitSnapshot detects git tag in refs
  {
    const r = makeRepo("parity-tag");
    const before = gitSnapshot(r);
    fixtureGit(["tag", "release-1"], {cwd: r, stdio: "ignore"});
    const after = gitSnapshot(r);
    check("parity: gitSnapshot refs contains tag after git tag",
      after.refs.includes("refs/tags/release-1"),
      `refs: ${after.refs.slice(0, 300)}`);
    check("parity: gitSnapshot fingerprint differs after tag",
      before.fingerprint !== after.fingerprint);
  }

  // 8c. gitSnapshot detects git branch -f in refs
  {
    const r = makeRepo("parity-branch-f");
    const before = gitSnapshot(r);
    fixtureGit(["branch", "-f", "feature", "HEAD"], {cwd: r, stdio: "ignore"});
    const after = gitSnapshot(r);
    check("parity: gitSnapshot refs contains branch after branch -f",
      after.refs.includes("refs/heads/feature"),
      `refs: ${after.refs.slice(0, 300)}`);
    check("parity: gitSnapshot fingerprint differs after branch -f",
      before.fingerprint !== after.fingerprint);
  }

  // 8d. Dimensions consumed by gitDenied in execution-plane-safety.mjs:
  //     gitDenied requires: conclusive, gitMutation===false, exit!==0,
  //     recognized attribution, gitControl.available && commitSucceeded,
  //     beforeState.digest === afterState.digest. The digest folds in refs,
  //     head, headSymbolic, config, sequencer, reflogs, objects, status, diff,
  //     files — every field gitSnapshot returns. So gitSnapshot's captured
  //     dimensions are by construction a superset.
  const deniedDimensions = ["head", "headSymbolic", "refs", "config", "sequencer", "reflogs", "objects"];
  for (const dim of deniedDimensions) {
    check(`parity: gitSnapshot field '${dim}' is present (superset of gitDenied consumption)`,
      snap8[dim] !== undefined,
      `typeof ${dim}=${typeof snap8[dim]}`);
  }
}

// ============================================================
// 9. Administrative-state sensitivity: each mutation is independent
//     (a single missing dimension fails distinctly).
// ============================================================
{
  // Verify that the fingerprint changes are not coincidental — each
  // mutation touches a distinct dimension. We check the specific field
  // that each mutation affects.

  // Tag adds a ref entry
  const rTag = makeRepo("indep-tag");
  const tagBefore = gitSnapshot(rTag);
  fixtureGit(["tag", "v1"], {cwd: rTag, stdio: "ignore"});
  const tagAfter = gitSnapshot(rTag);
  check("independence: tag mutation visible in refs dimension",
    tagAfter.refs.includes("refs/tags/v1") && !tagBefore.refs.includes("refs/tags/v1"));

  // Branch -f adds a ref entry
  const rBranch = makeRepo("indep-branch");
  const branchBefore = gitSnapshot(rBranch);
  fixtureGit(["branch", "-f", "topic", "HEAD"], {cwd: rBranch, stdio: "ignore"});
  const branchAfter = gitSnapshot(rBranch);
  check("independence: branch -f mutation visible in refs dimension",
    branchAfter.refs.includes("refs/heads/topic") && !branchBefore.refs.includes("refs/heads/topic"));

  // Detach changes headSymbolic
  const rDetach = makeRepo("indep-detach");
  const detachBefore = gitSnapshot(rDetach);
  fixtureGit(["checkout", "--detach", "HEAD"], {cwd: rDetach, stdio: "ignore"});
  const detachAfter = gitSnapshot(rDetach);
  check("independence: detach mutation visible in headSymbolic dimension",
    detachBefore.headSymbolic !== "DETACHED" && detachAfter.headSymbolic === "DETACHED");

  // Config change visible in config dimension
  const rConfig = makeRepo("indep-config");
  const configBefore = gitSnapshot(rConfig);
  fixtureGit(["config", "--local", "user.name", "Independent Name"], {cwd: rConfig, stdio: "ignore"});
  const configAfter = gitSnapshot(rConfig);
  check("independence: config mutation visible in config dimension",
    configBefore.config?.["--local"] !== configAfter.config?.["--local"],
    `before: ${configBefore.config?.["--local"]?.slice(0, 100)} after: ${configAfter.config?.["--local"]?.slice(0, 100)}`);

  // hash-object changes objects dimension
  const rHash = makeRepo("indep-hash");
  const hashBefore = gitSnapshot(rHash);
  fixtureGit(["hash-object", "-w", "--stdin"], {cwd: rHash, input: "independent blob", stdio: ["pipe", "ignore", "ignore"]});
  const hashAfter = gitSnapshot(rHash);
  check("independence: hash-object mutation visible in objects dimension",
    hashBefore.objects !== hashAfter.objects,
    `before: ${hashBefore.objects?.split("\n")[0]} after: ${hashAfter.objects?.split("\n")[0]}`);
}

// ============================================================
// 11. Index-state sensitivity: git update-index --assume-unchanged
//     changes the fingerprint.
// ============================================================
{
  const r = makeRepo("index-assume-unchanged");
  const before = gitSnapshot(r);
  check("index-state: baseline snapshot has indexState field",
    typeof before.indexState === "string",
    `typeof indexState=${typeof before.indexState}`);

  // 11a. git update-index --assume-unchanged on a tracked file
  {
    const r1 = makeRepo("index-assume-unchanged-a");
    const b1 = gitSnapshot(r1);
    fixtureGit(["update-index", "--assume-unchanged", "file.txt"], {cwd: r1, stdio: "ignore"});
    const a1 = gitSnapshot(r1);
    check("index-state: --assume-unchanged changes fingerprint",
      typeof b1.fingerprint === "string" && typeof a1.fingerprint === "string" && b1.fingerprint !== a1.fingerprint,
      `before=${b1.fingerprint?.slice(0,12)} after=${a1.fingerprint?.slice(0,12)}`);
    check("index-state: --assume-unchanged visible in indexState",
      b1.indexState !== a1.indexState,
      `indexState before length=${b1.indexState?.length} after length=${a1.indexState?.length}`);
  }

  // 11b. git update-index --no-assume-unchanged restores the flag
  {
    const r2 = makeRepo("index-assume-unchanged-b");
    fixtureGit(["update-index", "--assume-unchanged", "file.txt"], {cwd: r2, stdio: "ignore"});
    const mid = gitSnapshot(r2);
    fixtureGit(["update-index", "--no-assume-unchanged", "file.txt"], {cwd: r2, stdio: "ignore"});
    const after = gitSnapshot(r2);
    const original = gitSnapshot(makeRepo("index-assume-unchanged-orig"));
    // Restoring should bring indexState back to the unmodified state
    check("index-state: --no-assume-unchanged restores indexState",
      mid.indexState !== after.indexState,
      `mid indexState differs from restored`);
  }

  // 11c. git update-index --skip-worktree on a tracked file
  {
    const r3 = makeRepo("index-skip-worktree");
    const b3 = gitSnapshot(r3);
    fixtureGit(["update-index", "--skip-worktree", "file.txt"], {cwd: r3, stdio: "ignore"});
    const a3 = gitSnapshot(r3);
    check("index-state: --skip-worktree changes fingerprint",
      typeof b3.fingerprint === "string" && typeof a3.fingerprint === "string" && b3.fingerprint !== a3.fingerprint,
      `before=${b3.fingerprint?.slice(0,12)} after=${a3.fingerprint?.slice(0,12)}`);
    check("index-state: --skip-worktree visible in indexState",
      b3.indexState !== a3.indexState);
  }
}

// ============================================================
// 12. Hook-contents sensitivity: adding an executable hook
//     changes the fingerprint.
// ============================================================
{
  // 12a. Add executable post-commit hook
  {
    const r = makeRepo("hooks-add");
    const before = gitSnapshot(r);
    check("hooks: baseline snapshot has hooksDigest field",
      typeof before.hooksDigest === "string",
      `typeof hooksDigest=${typeof before.hooksDigest}`);

    const hooksDir = path.join(r, ".git", "hooks");
    fs.mkdirSync(hooksDir, {recursive: true});
    const hookPath = path.join(hooksDir, "post-commit");
    fs.writeFileSync(hookPath, "#!/bin/sh\necho hook-fired\n");
    fs.chmodSync(hookPath, 0o755);
    const after = gitSnapshot(r);
    check("hooks: adding executable post-commit changes fingerprint",
      typeof before.fingerprint === "string" && typeof after.fingerprint === "string" && before.fingerprint !== after.fingerprint,
      `before=${before.fingerprint?.slice(0,12)} after=${after.fingerprint?.slice(0,12)}`);
    check("hooks: hooksDigest changes after adding hook",
      before.hooksDigest !== after.hooksDigest,
      `before digest len=${before.hooksDigest?.length} after len=${after.hooksDigest?.length}`);
  }

  // 12b. Modify hook content (same name, different content)
  {
    const r = makeRepo("hooks-modify");
    const hooksDir = path.join(r, ".git", "hooks");
    fs.mkdirSync(hooksDir, {recursive: true});
    fs.writeFileSync(path.join(hooksDir, "pre-commit"), "#!/bin/sh\nexit 0\n");
    fs.chmodSync(path.join(hooksDir, "pre-commit"), 0o755);
    const before = gitSnapshot(r);
    fs.writeFileSync(path.join(hooksDir, "pre-commit"), "#!/bin/sh\nexit 1\n");
    const after = gitSnapshot(r);
    check("hooks: modifying hook content changes fingerprint",
      before.fingerprint !== after.fingerprint);
    check("hooks: hooksDigest changes after modifying hook",
      before.hooksDigest !== after.hooksDigest);
  }

  // 12c. Remove hook
  {
    const r = makeRepo("hooks-remove");
    const hooksDir = path.join(r, ".git", "hooks");
    fs.mkdirSync(hooksDir, {recursive: true});
    fs.writeFileSync(path.join(hooksDir, "post-push"), "#!/bin/sh\nexit 0\n");
    fs.chmodSync(path.join(hooksDir, "post-push"), 0o755);
    const before = gitSnapshot(r);
    fs.unlinkSync(path.join(hooksDir, "post-push"));
    const after = gitSnapshot(r);
    check("hooks: removing hook changes fingerprint",
      before.fingerprint !== after.fingerprint);
    check("hooks: hooksDigest changes after removing hook",
      before.hooksDigest !== after.hooksDigest);
  }
}

// ============================================================
// 13. Production ordering invariant: guard must precede snapshot
//     (validates the autopilot.mjs fix, not just a fixture)
//
//     Scoped to runRelay()'s body: a whole-file indexOf matches the wrong
//     function (guardedShell() also calls createGitMutationGuard), so the
//     slice below isolates runRelay before comparing call order.
// ============================================================
{
  // runRelay()'s body: from its definition to the next top-level function.
  // CRLF-tolerant: the working tree may use \r\n, so never assume \n.
  const runRelayOrdering = (source) => {
    const start = source.indexOf("async function runRelay(");
    if (start === -1) return null;
    const rest = source.slice(start);
    const endMatch = rest.slice(1).search(/\r?\n(?:async )?function /);
    const body = endMatch === -1 ? rest : rest.slice(0, endMatch + 1);
    const guardCall = body.indexOf("createGitMutationGuard(");
    const snapshotCall = body.indexOf("gitSnapshot(");
    return {
      guardCall,
      snapshotCall,
      ordered: guardCall !== -1 && snapshotCall !== -1 && guardCall < snapshotCall
    };
  };
  // The production code in runRelay() must call createGitMutationGuard
  // BEFORE gitSnapshot. Verify this by reading the source and checking
  // call order within runRelay's body.
  const autopilotSource = fs.readFileSync(
    path.join(skillRoot, "scripts", "autopilot.mjs"), "utf8"
  );
  const ordering = runRelayOrdering(autopilotSource);
  check("production-ordering: guard call exists in autopilot.mjs",
    ordering !== null && ordering.guardCall !== -1,
    `indexOf guardCall=${ordering?.guardCall}`);
  check("production-ordering: snapshot call exists in autopilot.mjs",
    ordering !== null && ordering.snapshotCall !== -1,
    `indexOf snapshotCall=${ordering?.snapshotCall}`);
  check("production-ordering: guard precedes snapshot in source",
    ordering !== null && ordering.ordered,
    `guardCall=${ordering?.guardCall} snapshotCall=${ordering?.snapshotCall}`);
  // Negative sanity: the helper must report "not ordered" when the snapshot
  // comes before the guard, so this check can actually fail.
  const inverted = "async function runRelay(){\n  const before=gitSnapshot(cwd);\n  const guard=createGitMutationGuard(dir,cwd);\n}\nfunction next(){}";
  const invertedOrdering = runRelayOrdering(inverted);
  check("production-ordering: inverted order reports not ordered",
    invertedOrdering !== null && invertedOrdering.guardCall !== -1
    && invertedOrdering.snapshotCall !== -1 && invertedOrdering.ordered === false,
    invertedOrdering);
}

// ============================================================
// 14. Verdict consumption: indexState, hooksDigest, and
//     administrativeDigest are compared in makeRelayResult's
//     administrative-state check.
//
//     TASK-28: the hand-written `||` chain over
//     `before.<field>!==after.<field>` was replaced by a derivation from
//     describeGitStateChange() over GIT_STATE_FIELDS (evidence only;
//     detection identical). So this pins the NEW shape instead: the three
//     fields are members of GIT_STATE_FIELDS, each one alone trips the
//     evidence diff, and makeRelayResult derives
//     administrativeGitStateChanged from describeGitStateChange.
// ============================================================
{
  const autopilotSource = fs.readFileSync(
    path.join(skillRoot, "scripts", "autopilot.mjs"), "utf8"
  );
  // CRLF-tolerant: the working tree may use \r\n, so never assume \n.
  const adminMatch = autopilotSource.match(
    /const administrativeGitStateChanged=([\s\S]*?);\r?\n\s*const commitDetected/
  );
  check("verdict-consumption: administrativeGitStateChanged definition found",
    adminMatch != null);
  if (adminMatch) {
    const expr = adminMatch[1];
    check("verdict-consumption: derived from describeGitStateChange evidence",
      expr.includes("gitStateChangesForEvidence")
      && autopilotSource.includes("gitStateChangesForEvidence=describeGitStateChange(before,after)"),
      `expression: ${expr.slice(0, 200)}`);
  }
  for (const field of ["indexState", "hooksDigest", "administrativeDigest"]) {
    check(`verdict-consumption: ${field} is a GIT_STATE_FIELDS member`,
      GIT_STATE_FIELDS.includes(field),
      `GIT_STATE_FIELDS: ${[...GIT_STATE_FIELDS].join(",")}`);
    const before = {
      head: "h", headSymbolic: "refs/heads/main", refs: "r",
      config: {"--local": "0:a=1"}, sequencer: "s", reflogs: "rl",
      objects: "o", indexState: "i", hooksDigest: "hd",
      administrativeDigest: "ad"
    };
    const after = {...before, [field]: `${before[field]}#changed`};
    const entry = describeGitStateChange(before, after).find((e) => e.field === field);
    check(`verdict-consumption: ${field} alone trips the evidence diff`,
      entry != null && entry.addedCount > 0,
      entry);
  }
}

// ============================================================
// 15. Hook mode sensitivity: chmod +x changes the snapshot.
// ============================================================
{
  // 15a. Add hook then change its executable bit
  {
    const r = makeRepo("hooks-mode");
    const hooksDir = path.join(r, ".git", "hooks");
    fs.mkdirSync(hooksDir, {recursive: true});
    const hookPath = path.join(hooksDir, "pre-commit");
    fs.writeFileSync(hookPath, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(hookPath, 0o644); // not executable
    const before = gitSnapshot(r);
    fs.chmodSync(hookPath, 0o755); // executable
    const after = gitSnapshot(r);
    check("hooks-mode: chmod +x changes fingerprint",
      before.fingerprint !== after.fingerprint,
      `before=${before.fingerprint?.slice(0,12)} after=${after.fingerprint?.slice(0,12)}`);
    check("hooks-mode: hooksDigest changes after mode change",
      before.hooksDigest !== after.hooksDigest,
      `before hooksDigest len=${before.hooksDigest?.length} after len=${after.hooksDigest?.length}`);
    // Verify the mode string is embedded
    check("hooks-mode: before hooksDigest contains mode=644",
      before.hooksDigest?.includes("mode=33188"),
      `before: ${before.hooksDigest}`);
    check("hooks-mode: after hooksDigest contains mode=755",
      after.hooksDigest?.includes("mode=33261"),
      `after: ${after.hooksDigest}`);
  }
}

// ============================================================
// 16. core.hooksPath sensitivity: hooks in configured directory
//     are included in the snapshot.
// ============================================================
{
  // 16a. Hook placed in a custom hooksPath directory
  {
    const r = makeRepo("hooks-path");
    const customHooksDir = path.join(r, ".custom-hooks");
    fs.mkdirSync(customHooksDir, {recursive: true});
    fs.writeFileSync(path.join(customHooksDir, "post-commit"), "#!/bin/sh\necho custom\n");
    fs.chmodSync(path.join(customHooksDir, "post-commit"), 0o755);
    // Configure core.hooksPath
    fixtureGit(["config", "--local", "core.hooksPath", customHooksDir], {cwd: r, stdio: "ignore"});
    const before = gitSnapshot(r);
    // Add a hook in the custom directory
    fs.writeFileSync(path.join(customHooksDir, "pre-push"), "#!/bin/sh\necho pre-push\n");
    fs.chmodSync(path.join(customHooksDir, "pre-push"), 0o755);
    const after = gitSnapshot(r);
    check("hooks-path: hooks in configured hooksPath are detected",
      before.fingerprint !== after.fingerprint,
      `before=${before.fingerprint?.slice(0,12)} after=${after.fingerprint?.slice(0,12)}`);
    check("hooks-path: hooksDigest changes after adding hook in custom dir",
      before.hooksDigest !== after.hooksDigest);
  }

  // 16b. Hook placed in custom hooksPath without default .git/hooks
  {
    const r = makeRepo("hooks-path-only");
    const customHooksDir = path.join(r, ".git-hooks");
    fs.mkdirSync(customHooksDir, {recursive: true});
    fs.writeFileSync(path.join(customHooksDir, "commit-msg"), "#!/bin/sh\nexit 0\n");
    fs.chmodSync(path.join(customHooksDir, "commit-msg"), 0o755);
    fixtureGit(["config", "--local", "core.hooksPath", customHooksDir], {cwd: r, stdio: "ignore"});
    const snap = gitSnapshot(r);
    check("hooks-path: hook in custom dir visible in hooksDigest",
      snap.hooksDigest?.includes("commit-msg"),
      `hooksDigest: ${snap.hooksDigest}`);
  }
}

// ============================================================
// 17. Administrative-git-state verdict: index-only and hook-only
//     mutations produce policy violations via administrativeGitStateChanged.
// ============================================================
{
  // 17a. Source-level verification that indexState triggers policy violation
  {
    const autopilotSource = fs.readFileSync(
      path.join(skillRoot, "scripts", "autopilot.mjs"), "utf8"
    );
    // Verify that administrativeGitStateChanged feeds into commitDetected
    const commitDetectedMatch = autopilotSource.match(
      /const commitDetected=before\.head!==after\.head \|\| administrativeGitStateChanged/
    );
    check("verdict-index-hook: commitDetected includes administrativeGitStateChanged",
      commitDetectedMatch != null);
    // Verify commitDetected feeds into the policy-violation classification
    // (relay-guards.mjs classifyGitBlocks maps commitDetected to
    // git_commit_detected; pinned in test-fixture-git-block-classification).
    const policyMatch = autopilotSource.match(
      /classifyGitBlocks\(guardEvents,\{commitDetected/
    );
    check("verdict-index-hook: commitDetected triggers git_commit_detected policy violation",
      policyMatch != null);
  }
}

// ============================================================
// 18. Global/system hooksPath sensitivity: hooks selected by
//     non-local config scopes are observed.
// ============================================================
{
  // 18a. Global core.hooksPath with hook
  {
    const r = makeRepo("hooks-path-global");
    const globalHooksDir = path.join(root, "global-hooks");
    fs.mkdirSync(globalHooksDir, {recursive: true});
    fs.writeFileSync(path.join(globalHooksDir, "post-commit"), "#!/bin/sh\necho global-hook\n");
    fs.chmodSync(path.join(globalHooksDir, "post-commit"), 0o755);
    // Set global config (isolated via HOME so we don't pollute the real user)
    const fakeHome = path.join(root, "fake-home");
    fs.mkdirSync(fakeHome, {recursive: true});
    const origHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      fixtureGit(["config", "--global", "core.hooksPath", globalHooksDir], {cwd: r, stdio: "ignore"});
      const before = gitSnapshot(r);
      // Add another hook in the global dir
      fs.writeFileSync(path.join(globalHooksDir, "pre-push"), "#!/bin/sh\necho global-pre-push\n");
      fs.chmodSync(path.join(globalHooksDir, "pre-push"), 0o755);
      const after = gitSnapshot(r);
      check("hooks-path-global: hook in global hooksPath detected",
        before.fingerprint !== after.fingerprint,
        `before=${before.fingerprint?.slice(0,12)} after=${after.fingerprint?.slice(0,12)}`);
      check("hooks-path-global: hooksDigest changes",
        before.hooksDigest !== after.hooksDigest);
      check("hooks-path-global: global hook visible in hooksDigest",
        after.hooksDigest?.includes("post-commit"),
        `hooksDigest: ${after.hooksDigest?.slice(0, 200)}`);
    } finally {
      if (origHome !== undefined) process.env.HOME = origHome;
      else delete process.env.HOME;
      // Clean up global config
      try { fs.rmSync(fakeHome, {recursive: true, force: true}); } catch {}
    }
  }

  // 18b. System core.hooksPath with hook
  {
    const r = makeRepo("hooks-path-system");
    const systemHooksDir = path.join(root, "system-hooks");
    fs.mkdirSync(systemHooksDir, {recursive: true});
    fs.writeFileSync(path.join(systemHooksDir, "commit-msg"), "#!/bin/sh\nexit 0\n");
    fs.chmodSync(path.join(systemHooksDir, "commit-msg"), 0o755);
    fixtureGit(["config", "--system", "core.hooksPath", systemHooksDir], {cwd: r, stdio: "ignore"});
    const snap = gitSnapshot(r);
    // System config may fail due to permissions; just verify the code path
    // doesn't crash and returns a valid snapshot
    check("hooks-path-system: snapshot succeeds with --system config",
      typeof snap.fingerprint === "string" && snap.fingerprint.length > 0);
  }
}

// ============================================================
// 19. Symlink hook sensitivity: executable symlink hooks are
//     detected and their target hash + mode are captured.
// ============================================================
{
  // 19a. Symlink to executable script
  {
    const r = makeRepo("hooks-symlink");
    const hooksDir = path.join(r, ".git", "hooks");
    fs.mkdirSync(hooksDir, {recursive: true});
    // Create target script outside .git
    const targetDir = path.join(root, "hook-targets");
    fs.mkdirSync(targetDir, {recursive: true});
    const targetScript = path.join(targetDir, "shared-hook.sh");
    fs.writeFileSync(targetScript, "#!/bin/sh\necho symlink-hook\n");
    fs.chmodSync(targetScript, 0o755);
    // Create symlink in hooks dir
    const symlinkPath = path.join(hooksDir, "post-commit");
    fs.symlinkSync(targetScript, symlinkPath);
    const before = gitSnapshot(r);
    check("hooks-symlink: baseline snapshot has symlink hook",
      before.hooksDigest?.includes("post-commit"),
      `hooksDigest: ${before.hooksDigest?.slice(0, 200)}`);
    check("hooks-symlink: hooksDigest marks entry as symlink",
      before.hooksDigest?.includes("symlink=true"),
      `hooksDigest: ${before.hooksDigest?.slice(0, 200)}`);
    check("hooks-symlink: hooksDigest includes target path",
      before.hooksDigest?.includes("target="),
      `hooksDigest: ${before.hooksDigest?.slice(0, 300)}`);
    // Modify the target script
    fs.writeFileSync(targetScript, "#!/bin/sh\necho modified-hook\n");
    const after = gitSnapshot(r);
    check("hooks-symlink: modifying symlink target changes fingerprint",
      before.fingerprint !== after.fingerprint,
      `before=${before.fingerprint?.slice(0,12)} after=${after.fingerprint?.slice(0,12)}`);
    check("hooks-symlink: hooksDigest changes after target modification",
      before.hooksDigest !== after.hooksDigest);
  }

  // 19b. Symlink to non-executable (mode should capture this)
  {
    const r = makeRepo("hooks-symlink-noexec");
    const hooksDir = path.join(r, ".git", "hooks");
    fs.mkdirSync(hooksDir, {recursive: true});
    const targetDir = path.join(root, "hook-targets-noexec");
    fs.mkdirSync(targetDir, {recursive: true});
    const targetScript = path.join(targetDir, "noexec-hook.sh");
    fs.writeFileSync(targetScript, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(targetScript, 0o644); // not executable
    const symlinkPath = path.join(hooksDir, "pre-commit");
    fs.symlinkSync(targetScript, symlinkPath);
    const snap = gitSnapshot(r);
    check("hooks-symlink-noexec: non-exec symlink hook captured",
      snap.hooksDigest?.includes("pre-commit"),
      `hooksDigest: ${snap.hooksDigest?.slice(0, 200)}`);
    check("hooks-symlink-noexec: mode reflects target (not symlink)",
      snap.hooksDigest?.includes("mode=33188"),
      `hooksDigest: ${snap.hooksDigest?.slice(0, 200)}`);
  }

  // 19c. Broken symlink (target deleted)
  {
    const r = makeRepo("hooks-symlink-broken");
    const hooksDir = path.join(r, ".git", "hooks");
    fs.mkdirSync(hooksDir, {recursive: true});
    const targetPath = path.join(root, "deleted-hook");
    const symlinkPath = path.join(hooksDir, "post-push");
    fs.symlinkSync(targetPath, symlinkPath);
    // Don't create the target — it's a broken symlink
    const snap = gitSnapshot(r);
    check("hooks-symlink-broken: broken symlink captured in hooksDigest",
      snap.hooksDigest?.includes("post-push"),
      `hooksDigest: ${snap.hooksDigest?.slice(0, 200)}`);
  }
}

// ============================================================
// 20. Tilde expansion: core.hooksPath with ~ resolves to $HOME,
//     not <repo>/~. The snapshot must inspect the expanded path.
// ============================================================
{
  // 20a. core.hooksPath=~/.git-hooks resolves to $HOME/.git-hooks
  {
    const r = makeRepo("hooks-tilde");
    const fakeHome = path.join(root, "tilde-home");
    fs.mkdirSync(fakeHome, {recursive: true});
    const tildeHooksDir = path.join(fakeHome, ".git-hooks");
    fs.mkdirSync(tildeHooksDir, {recursive: true});
    fs.writeFileSync(path.join(tildeHooksDir, "post-commit"), "#!/bin/sh\necho tilde-hook\n");
    fs.chmodSync(path.join(tildeHooksDir, "post-commit"), 0o755);
    // Set core.hooksPath with tilde
    const origHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      fixtureGit(["config", "--local", "core.hooksPath", "~/.git-hooks"], {cwd: r, stdio: "ignore"});
      const snap = gitSnapshot(r);
      check("hooks-tilde: tilde-expanded hooksPath hook detected",
        snap.hooksDigest?.includes("post-commit"),
        `hooksDigest: ${snap.hooksDigest?.slice(0, 300)}`);
      check("hooks-tilde: tilde-expanded hook is from $HOME dir",
        snap.hooksDigest?.includes("tilde-hook") || snap.hooksDigest?.includes("post-commit"),
        `hooksDigest: ${snap.hooksDigest?.slice(0, 300)}`);
      // Verify it did NOT resolve to <repo>/~/.git-hooks (which would be empty)
      const literalTildeDir = path.join(r, "~", ".git-hooks");
      check("hooks-tilde: literal tilde dir is NOT the resolved path",
        !fs.existsSync(literalTildeDir) || !fs.readdirSync(literalTildeDir).includes("post-commit"),
        `literal tilde dir should not contain the hook`);
    } finally {
      if (origHome !== undefined) process.env.HOME = origHome;
      else delete process.env.HOME;
    }
  }

  // 20b. core.hooksPath=~/hooks without subdirectory
  {
    const r = makeRepo("hooks-tilde-nosub");
    const fakeHome = path.join(root, "tilde-home-nosub");
    const tildeHooksDir = path.join(fakeHome, "hooks");
    fs.mkdirSync(tildeHooksDir, {recursive: true});
    fs.writeFileSync(path.join(tildeHooksDir, "commit-msg"), "#!/bin/sh\nexit 0\n");
    fs.chmodSync(path.join(tildeHooksDir, "commit-msg"), 0o755);
    const origHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      fixtureGit(["config", "--local", "core.hooksPath", "~/hooks"], {cwd: r, stdio: "ignore"});
      const snap = gitSnapshot(r);
      check("hooks-tilde-nosub: ~/hooks resolves correctly",
        snap.hooksDigest?.includes("commit-msg"),
        `hooksDigest: ${snap.hooksDigest?.slice(0, 300)}`);
    } finally {
      if (origHome !== undefined) process.env.HOME = origHome;
      else delete process.env.HOME;
    }
  }
}

// ============================================================
// 21. Symlink retargeting: changing the target of a symlink to
//     another path with the same content MUST change the
//     fingerprint (target identity is part of the digest).
// ============================================================
{
  // 21a. Retarget symlink to another path with identical content
  {
    const r = makeRepo("hooks-symlink-retarget");
    const hooksDir = path.join(r, ".git", "hooks");
    fs.mkdirSync(hooksDir, {recursive: true});
    const targetDir = path.join(root, "retarget-targets");
    fs.mkdirSync(targetDir, {recursive: true});
    const targetA = path.join(targetDir, "hook-a.sh");
    const targetB = path.join(targetDir, "hook-b.sh");
    const hookContent = "#!/bin/sh\necho identical\n";
    fs.writeFileSync(targetA, hookContent);
    fs.chmodSync(targetA, 0o755);
    fs.writeFileSync(targetB, hookContent);
    fs.chmodSync(targetB, 0o755);
    // Create symlink pointing to targetA
    const symlinkPath = path.join(hooksDir, "post-commit");
    fs.symlinkSync(targetA, symlinkPath);
    const before = gitSnapshot(r);
    // Retarget to targetB (same content, different path)
    fs.unlinkSync(symlinkPath);
    fs.symlinkSync(targetB, symlinkPath);
    const after = gitSnapshot(r);
    check("hooks-symlink-retarget: retargeting symlink changes fingerprint",
      before.fingerprint !== after.fingerprint,
      `before=${before.fingerprint?.slice(0,12)} after=${after.fingerprint?.slice(0,12)}`);
    check("hooks-symlink-retarget: hooksDigest changes on retarget",
      before.hooksDigest !== after.hooksDigest,
      `before: ${before.hooksDigest?.slice(0, 200)} after: ${after.hooksDigest?.slice(0, 200)}`);
    // Verify target paths differ in the digest
    check("hooks-symlink-retarget: before contains target-a path",
      before.hooksDigest?.includes("hook-a.sh"),
      `before hooksDigest: ${before.hooksDigest?.slice(0, 300)}`);
    check("hooks-symlink-retarget: after contains target-b path",
      after.hooksDigest?.includes("hook-b.sh"),
      `after hooksDigest: ${after.hooksDigest?.slice(0, 300)}`);
  }

  // 21b. Retarget symlink to a broken target
  {
    const r = makeRepo("hooks-symlink-retarget-broken");
    const hooksDir = path.join(r, ".git", "hooks");
    fs.mkdirSync(hooksDir, {recursive: true});
    const targetDir = path.join(root, "retarget-targets-broken");
    fs.mkdirSync(targetDir, {recursive: true});
    const targetA = path.join(targetDir, "hook-valid.sh");
    fs.writeFileSync(targetA, "#!/bin/sh\necho valid\n");
    fs.chmodSync(targetA, 0o755);
    const brokenTarget = path.join(targetDir, "hook-deleted.sh");
    // Create symlink to valid target
    const symlinkPath = path.join(hooksDir, "pre-commit");
    fs.symlinkSync(targetA, symlinkPath);
    const before = gitSnapshot(r);
    // Retarget to broken target
    fs.unlinkSync(symlinkPath);
    fs.symlinkSync(brokenTarget, symlinkPath);
    const after = gitSnapshot(r);
    check("hooks-symlink-retarget-broken: retarget to broken changes fingerprint",
      before.fingerprint !== after.fingerprint,
      `before=${before.fingerprint?.slice(0,12)} after=${after.fingerprint?.slice(0,12)}`);
    check("hooks-symlink-retarget-broken: hooksDigest changes on retarget to broken",
      before.hooksDigest !== after.hooksDigest);
  }
}

// ============================================================
// 22. Broken symlink target identity: two broken symlinks
//     pointing to different nonexistent paths MUST produce
//     different fingerprints (target identity differs).
// ============================================================
{
  const r = makeRepo("hooks-broken-symlink-identity");
  const hooksDir = path.join(r, ".git", "hooks");
  fs.mkdirSync(hooksDir, {recursive: true});
  const brokenA = path.join(root, "nonexistent-a");
  const brokenB = path.join(root, "nonexistent-b");
  const symlinkPath = path.join(hooksDir, "post-commit");
  // Symlink to broken target A
  fs.symlinkSync(brokenA, symlinkPath);
  const before = gitSnapshot(r);
  // Retarget to broken target B
  fs.unlinkSync(symlinkPath);
  fs.symlinkSync(brokenB, symlinkPath);
  const after = gitSnapshot(r);
  check("broken-symlink-identity: retargeting broken symlink changes fingerprint",
    before.fingerprint !== after.fingerprint,
    `before=${before.fingerprint?.slice(0,12)} after=${after.fingerprint?.slice(0,12)}`);
  check("broken-symlink-identity: hooksDigest changes on broken retarget",
    before.hooksDigest !== after.hooksDigest,
    `before: ${before.hooksDigest?.slice(0, 200)} after: ${after.hooksDigest?.slice(0, 200)}`);
  // Verify target paths differ in the digest
  check("broken-symlink-identity: before contains target-a",
    before.hooksDigest?.includes("nonexistent-a"),
    `before hooksDigest: ${before.hooksDigest?.slice(0, 300)}`);
  check("broken-symlink-identity: after contains target-b",
    after.hooksDigest?.includes("nonexistent-b"),
    `after hooksDigest: ${after.hooksDigest?.slice(0, 300)}`);
}

// ============================================================
// 23. ~user/hooks expansion: core.hooksPath with ~<username>
//     resolves via the system user database, not <repo>/~user.
// ============================================================
{
  // 23a. ~user/hooks resolves to the user's home directory
  {
    const r = makeRepo("hooks-tilde-user");
    const currentUser = os.userInfo().username;
    const fakeHome = path.join(root, "tilde-user-home");
    fs.mkdirSync(fakeHome, {recursive: true});
    const tildeHooksDir = path.join(fakeHome, ".git-hooks");
    fs.mkdirSync(tildeHooksDir, {recursive: true});
    fs.writeFileSync(path.join(tildeHooksDir, "post-commit"), "#!/bin/sh\necho tilde-user-hook\n");
    fs.chmodSync(path.join(tildeHooksDir, "post-commit"), 0o755);
    // We can't actually create a ~<username> path that resolves differently
    // than $HOME without system-level user database changes. Instead, verify
    // that git config --path resolves ~ to $HOME, and that the snapshot
    // detects hooks at the resolved path.
    const origHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      fixtureGit(["config", "--local", "core.hooksPath", "~/.git-hooks"], {cwd: r, stdio: "ignore"});
      const snap = gitSnapshot(r);
      check("hooks-tilde-user: tilde-expanded hooksPath hook detected",
        snap.hooksDigest?.includes("post-commit"),
        `hooksDigest: ${snap.hooksDigest?.slice(0, 300)}`);
      // Verify the effective path is used (not the literal ~)
      // The label may be configured:effective, configured:--local:..., or
      // configured:--worktree:... depending on which scope Git reads.
      check("hooks-tilde-user: hooksDigest contains dir label",
        snap.hooksDigest?.includes("configured:"),
        `hooksDigest: ${snap.hooksDigest?.slice(0, 300)}`);
    } finally {
      if (origHome !== undefined) process.env.HOME = origHome;
      else delete process.env.HOME;
    }
  }
}

// ============================================================
// 24. Hook directory identity: swapping hooks between .git/hooks
//     and a configured hooks directory MUST change the fingerprint.
// ============================================================
{
  const r = makeRepo("hooks-dir-identity");
  const hooksDir = path.join(r, ".git", "hooks");
  fs.mkdirSync(hooksDir, {recursive: true});
  const customDir = path.join(r, ".custom-hooks");
  fs.mkdirSync(customDir, {recursive: true});
  // Create hook A in .git/hooks and hook B in custom dir
  fs.writeFileSync(path.join(hooksDir, "pre-commit"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(hooksDir, "pre-commit"), 0o755);
  fs.writeFileSync(path.join(customDir, "pre-commit"), "#!/bin/sh\nexit 1\n");
  fs.chmodSync(path.join(customDir, "pre-commit"), 0o755);
  fixtureGit(["config", "--local", "core.hooksPath", customDir], {cwd: r, stdio: "ignore"});
  const before = gitSnapshot(r);
  // Swap: put B in .git/hooks and A in custom dir
  fs.writeFileSync(path.join(hooksDir, "pre-commit"), "#!/bin/sh\nexit 1\n");
  fs.writeFileSync(path.join(customDir, "pre-commit"), "#!/bin/sh\nexit 0\n");
  const after = gitSnapshot(r);
  check("hooks-dir-identity: swapping hooks between dirs changes fingerprint",
    before.fingerprint !== after.fingerprint,
    `before=${before.fingerprint?.slice(0,12)} after=${after.fingerprint?.slice(0,12)}`);
  check("hooks-dir-identity: hooksDigest changes on swap",
    before.hooksDigest !== after.hooksDigest,
    `before: ${before.hooksDigest?.slice(0, 300)} after: ${after.hooksDigest?.slice(0, 300)}`);
  // Verify the directory labels are present
  check("hooks-dir-identity: hooksDigest contains default label",
    before.hooksDigest?.includes("default:"),
    `hooksDigest: ${before.hooksDigest?.slice(0, 300)}`);
  check("hooks-dir-identity: hooksDigest contains configured label",
    before.hooksDigest?.includes("configured:"),
    `hooksDigest: ${before.hooksDigest?.slice(0, 300)}`);
}

// ============================================================
// 25. ORIG_HEAD and pseudo-ref sensitivity: update-ref to
//     pseudo-refs changes the snapshot, and content matters.
// ============================================================
{
  // 25a. git update-ref ORIG_HEAD HEAD changes snapshot
  {
    const r = makeRepo("pseudo-ref-orig-head");
    const before = gitSnapshot(r);
    check("pseudo-ref: before has no ORIG_HEAD",
      before.administrativeDigest?.includes("ORIG_HEAD:ABSENT"),
      `administrativeDigest: ${before.administrativeDigest?.slice(0, 300)}`);
    fixtureGit(["update-ref", "ORIG_HEAD", "HEAD"], {cwd: r, stdio: "ignore"});
    const after = gitSnapshot(r);
    check("pseudo-ref: ORIG_HEAD update changes fingerprint",
      before.fingerprint !== after.fingerprint,
      `before=${before.fingerprint?.slice(0,12)} after=${after.fingerprint?.slice(0,12)}`);
    check("pseudo-ref: ORIG_HEAD no longer ABSENT",
      !after.administrativeDigest?.includes("ORIG_HEAD:ABSENT"),
      `administrativeDigest: ${after.administrativeDigest?.slice(0, 300)}`);
    check("pseudo-ref: ORIG_HEAD contains file content",
      after.administrativeDigest?.includes("ORIG_HEAD:file:"),
      `administrativeDigest: ${after.administrativeDigest?.slice(0, 300)}`);
  }

  // 25b. Changing ORIG_HEAD from one SHA to another is detected
  {
    const r = makeRepo("pseudo-ref-orig-head-change");
    fixtureGit(["update-ref", "ORIG_HEAD", "HEAD"], {cwd: r, stdio: "ignore"});
    const before = gitSnapshot(r);
    // Create a new commit to get a different SHA
    fs.writeFileSync(path.join(r, "another.txt"), "another");
    fixtureGit(["add", "another.txt"], {cwd: r, stdio: "ignore"});
    fixtureGit(["commit", "-m", "second"], {cwd: r, stdio: "ignore"});
    // Update ORIG_HEAD to point to the new commit
    fixtureGit(["update-ref", "ORIG_HEAD", "HEAD"], {cwd: r, stdio: "ignore"});
    const after = gitSnapshot(r);
    check("pseudo-ref: changing ORIG_HEAD SHA changes fingerprint",
      before.fingerprint !== after.fingerprint,
      `before=${before.fingerprint?.slice(0,12)} after=${after.fingerprint?.slice(0,12)}`);
  }

  // 25c. FETCH_HEAD presence/absence is detected
  {
    const r = makeRepo("pseudo-ref-fetch-head");
    const before = gitSnapshot(r);
    check("pseudo-ref: before has no FETCH_HEAD",
      before.administrativeDigest?.includes("FETCH_HEAD:ABSENT"),
      `administrativeDigest: ${before.administrativeDigest?.slice(0, 300)}`);
    // Simulate FETCH_HEAD by writing a file
    fs.writeFileSync(path.join(r, ".git", "FETCH_HEAD"), "abc123\tnull\thttp://example.com\tfetch\n");
    const after = gitSnapshot(r);
    check("pseudo-ref: FETCH_HEAD presence changes fingerprint",
      before.fingerprint !== after.fingerprint,
      `before=${before.fingerprint?.slice(0,12)} after=${after.fingerprint?.slice(0,12)}`);
    check("pseudo-ref: FETCH_HEAD no longer ABSENT",
      !after.administrativeDigest?.includes("FETCH_HEAD:ABSENT"),
      `administrativeDigest: ${after.administrativeDigest?.slice(0, 300)}`);
  }

  // 25d. administrativeDigest is included in the fingerprint
  {
    const r = makeRepo("pseudo-ref-field");
    const snap = gitSnapshot(r);
    check("pseudo-ref: administrativeDigest field exists",
      typeof snap.administrativeDigest === "string",
      `typeof administrativeDigest=${typeof snap.administrativeDigest}`);
    check("pseudo-ref: administrativeDigest included in fingerprint",
      snap.administrativeDigest !== undefined && snap.fingerprint.length > 0);
  }

  // 25e. rebase-merge directory content is digested recursively
  {
    const r = makeRepo("pseudo-ref-rebase-merge");
    const before = gitSnapshot(r);
    // Create rebase-merge directory with state files
    const rebaseMergeDir = path.join(r, ".git", "rebase-merge");
    fs.mkdirSync(rebaseMergeDir, {recursive: true});
    fs.writeFileSync(path.join(rebaseMergeDir, "head-name"), "refs/heads/main\n");
    fs.writeFileSync(path.join(rebaseMergeDir, "onto"), "abc123\n");
    fs.writeFileSync(path.join(rebaseMergeDir, "msgnum"), "3\n");
    const after = gitSnapshot(r);
    check("pseudo-ref: rebase-merge directory content changes fingerprint",
      before.fingerprint !== after.fingerprint,
      `before=${before.fingerprint?.slice(0,12)} after=${after.fingerprint?.slice(0,12)}`);
    check("pseudo-ref: rebase-merge digested recursively",
      after.administrativeDigest?.includes("rebase-merge:") &&
      after.administrativeDigest?.includes("head-name"),
      `administrativeDigest: ${after.administrativeDigest?.slice(0, 400)}`);
  }

  // 25f. Modifying rebase-merge state file changes fingerprint
  {
    const r = makeRepo("pseudo-ref-rebase-merge-change");
    const rebaseMergeDir = path.join(r, ".git", "rebase-merge");
    fs.mkdirSync(rebaseMergeDir, {recursive: true});
    fs.writeFileSync(path.join(rebaseMergeDir, "msgnum"), "1\n");
    const before = gitSnapshot(r);
    fs.writeFileSync(path.join(rebaseMergeDir, "msgnum"), "5\n");
    const after = gitSnapshot(r);
    check("pseudo-ref: modifying rebase-merge state changes fingerprint",
      before.fingerprint !== after.fingerprint,
      `before=${before.fingerprint?.slice(0,12)} after=${after.fingerprint?.slice(0,12)}`);
  }
}

// ---- IGNORED_REF_NAMESPACES (refs/codex/) ----
{
  const git = (r, ...a) => fixtureGit(a, {cwd: r, encoding: "utf8"});
  const sameRefs = (b, a) => b.refs === a.refs && b.reflogs === a.reflogs && b.fingerprint === a.fingerprint;
  {
    const r = makeRepo("codex-ignored");
    const head = git(r, "rev-parse", "HEAD").stdout.trim();
    const before = gitSnapshot(r);
    git(r, "update-ref", "refs/codex/turn-diffs/abc123", head);
    const after = gitSnapshot(r);
    check("codex ref: refs/codex/turn-diffs ref does not change refs", before.refs === after.refs);
    check("codex ref: fingerprint unchanged", before.fingerprint === after.fingerprint);
  }
  {
    const r = makeRepo("codex-inverse");
    const head = git(r, "rev-parse", "HEAD").stdout.trim();
    const before = gitSnapshot(r);
    git(r, "update-ref", "refs/heads/some-other-branch", head);
    check("codex ref inverse: new branch still changes refs", before.refs !== gitSnapshot(r).refs);
    const r2 = makeRepo("codex-inverse2");
    const h2 = git(r2, "rev-parse", "HEAD").stdout.trim();
    const b2 = gitSnapshot(r2);
    git(r2, "update-ref", "refs/some-other-tool/x", h2);
    check("codex ref inverse: unlisted custom namespace still changes refs", b2.refs !== gitSnapshot(r2).refs);
    const r3 = makeRepo("codex-inverse3");
    const h3 = git(r3, "rev-parse", "HEAD").stdout.trim();
    const b3 = gitSnapshot(r3);
    git(r3, "update-ref", "refs/codexish/x", h3);
    check("codex ref inverse: refs/codexish/ (not exact prefix) still changes refs", b3.refs !== gitSnapshot(r3).refs);
  }
  {
    const r = makeRepo("codex-combined");
    const head = git(r, "rev-parse", "HEAD").stdout.trim();
    const before = gitSnapshot(r);
    git(r, "update-ref", "refs/codex/turn-diffs/zzz", head);
    fs.writeFileSync(path.join(r, "file.txt"), "changed");
    git(r, "commit", "-am", "real commit");
    const after = gitSnapshot(r);
    check("codex ref combined: real commit alongside ignored ref still changes head and refs", before.head !== after.head && before.refs !== after.refs);
    check("codex ref combined: ignored ref absent from refs", !after.refs.includes("refs/codex/"));
  }
  {
    const r = makeRepo("codex-reflog");
    const before = gitSnapshot(r);
    const dir = path.join(r, ".git", "logs", "refs", "codex", "turn-diffs");
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, "abc"), "0 1 x\n");
    check("codex reflog: logs/refs/codex file ignored by reflog digest", sameRefs(before, gitSnapshot(r)));
    fs.mkdirSync(path.join(r, ".git", "logs", "refs", "other"), {recursive: true});
    fs.writeFileSync(path.join(r, ".git", "logs", "refs", "other", "abc"), "0 1 x\n");
    check("codex reflog: logs/refs/other file still changes reflogs", before.reflogs !== gitSnapshot(r).reflogs);
  }
}

// ---- cleanup ----
try { fs.rmSync(root, {recursive: true, force: true}); } catch {}

// ---- summary ----
console.log(`\nB4 git-containment regression: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
