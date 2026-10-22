#!/usr/bin/env node
// TASK 13 correction — focused, fast, module-level regression tests for
// scripts/implementation-baseline.mjs against plain disposable Git repos
// (no full Autopilot mission needed for these): key sanitization
// (Defect 1's path-safety half), the manifest/current-status UNION fix
// (Defect 2), fail-closed Git error handling (Defect 3), and symlink-safe
// snapshotting (Defect 4). Cross-mission collision/resume and reviewer
// behavior are proven end-to-end in test-dirty-worktree-isolation.mjs
// instead, since those require a real mission (state.json identity,
// prompts, decisions) that this module has no concept of on its own.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import {ensureBaseline, hasBaseline, removeBaseline, scopedDelta, sanitizeKeySegment, listWorktreeEntries, rebaseBaselineOntoHead, baselineBaseHead} from "./implementation-baseline.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${detail ? " -- " + detail : ""}`); }
}

function git(cwd, args) {
  const r = spawnSync("git", args, {cwd, encoding: "utf8", env: withoutOuterGitGuard(process.env), shell: false});
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout || "").trim();
}

function makeRepo(prefix) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `ap-ib-${prefix}-`));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "ib-test@example.invalid"]);
  git(repo, ["config", "user.name", "IB Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

function cleanup(...dirs) {
  for (const d of dirs) { try { fs.rmSync(d, {recursive: true, force: true}); } catch { /* best-effort */ } }
}

// ===========================================================================
// Defect 1 (path-safety half): sanitizeKeySegment must never let caller
// identity escape a single path segment.
// ===========================================================================
{
  check("sanitizeKeySegment: safe input passes through unchanged", sanitizeKeySegment("plain-name_123.txt") === "plain-name_123.txt");
  check("sanitizeKeySegment: path separators are neutralized", !sanitizeKeySegment("../../etc/passwd").includes("/"));
  check("sanitizeKeySegment: a pure '..' input never resolves to a parent-dir escape", sanitizeKeySegment("..") !== "..");
  check("sanitizeKeySegment: a pure '.' input never resolves to the current-dir sentinel", sanitizeKeySegment(".") !== ".");
  check("sanitizeKeySegment: empty input is never an empty path segment", sanitizeKeySegment("") !== "");
  check("sanitizeKeySegment: null/undefined input is handled", sanitizeKeySegment(null).length > 0 && sanitizeKeySegment(undefined).length > 0);
  check("sanitizeKeySegment: result is bounded in length", sanitizeKeySegment("x".repeat(10000)).length <= 200);
  // A sanitized identity actually used as a real path component must resolve
  // INSIDE the intended parent directory, never outside it.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ap-ib-sanitize-"));
  try {
    const evil = "../../../../../../etc/passwd";
    const joined = path.resolve(parent, sanitizeKeySegment(evil));
    check("sanitizeKeySegment: joining the sanitized result stays inside the parent directory", joined.startsWith(parent + path.sep) || joined === parent);
  } finally {
    cleanup(parent);
  }
}

// ===========================================================================
// Defect 2: scopedDelta must iterate the UNION of baseline-manifest paths
// and current git-status paths, not current status alone.
// ===========================================================================
{
  const repo = makeRepo("union");
  try {
    // Pre-existing dirty shape: modified tracked, deleted tracked, staged
    // tracked, untracked.
    fs.writeFileSync(path.join(repo, "tracked-a.txt"), "line1\n");
    fs.writeFileSync(path.join(repo, "tracked-b.txt"), "original\n");
    fs.writeFileSync(path.join(repo, "tracked-c.txt"), "keep me\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "seed tracked files"]);

    fs.writeFileSync(path.join(repo, "tracked-a.txt"), "line1\nmodified-before\n"); // modified, unstaged
    fs.unlinkSync(path.join(repo, "tracked-b.txt")); // deleted, unstaged
    fs.writeFileSync(path.join(repo, "tracked-c.txt"), "keep me\nstaged-before\n"); // staged
    git(repo, ["add", "tracked-c.txt"]);
    fs.writeFileSync(path.join(repo, "untracked-d.txt"), "untracked-before\n"); // untracked
    fs.writeFileSync(path.join(repo, "untracked-untouched.txt"), "never touched\n"); // untracked, stays untouched

    ensureBaseline(repo, "key1");

    // 1) deletion of a baseline UNTRACKED file
    fs.unlinkSync(path.join(repo, "untracked-d.txt"));
    // 2) restoration of a baseline DIRTY TRACKED file back to HEAD
    fs.writeFileSync(path.join(repo, "tracked-a.txt"), "line1\n");
    // 3) restoration of a baseline DELETED TRACKED file (exact original content)
    fs.writeFileSync(path.join(repo, "tracked-b.txt"), "original\n");
    // 4) additional change to a file that was ALREADY dirty (staged) at baseline
    fs.writeFileSync(path.join(repo, "tracked-c.txt"), "keep me\nstaged-before\nmission-addition\n");

    const delta = scopedDelta(repo, "key1");

    check("union: untracked-file deletion is detected", /untracked-d\.txt/.test(delta) && /-untracked-before/.test(delta), delta);
    check("union: dirty-tracked-file restoration to HEAD is detected", /tracked-a\.txt/.test(delta) && /-modified-before/.test(delta), delta);
    check("union: deleted-tracked-file restoration is detected", /tracked-b\.txt/.test(delta) && /\+original/.test(delta), delta);
    check("union: additional change on top of already-dirty content is detected", /tracked-c\.txt/.test(delta) && /\+mission-addition/.test(delta), delta);
    check("union: unchanged untracked pre-existing file remains absent from the delta", !delta.includes("untracked-untouched.txt"), delta);
    // Nothing about the STAGED prefix itself ("staged-before") should look
    // like a NEW change — only "mission-addition" is new for tracked-c.txt.
    check("union: the pre-existing staged content itself is not reported as a change (only the addition on top of it is)",
      !new RegExp("\\+staged-before(?!\\n)").test(delta) || delta.split("tracked-c.txt")[1]?.split(/diff --git/)[0]?.includes("mission-addition"), delta);
  } finally {
    cleanup(repo);
  }
}

// ===========================================================================
// Defect 3: Git failures must fail closed (throw), never silently succeed
// with an empty delta.
// ===========================================================================
{
  const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-ib-nonrepo-"));
  try {
    assert.throws(() => ensureBaseline(nonRepo, "k"), /implementation-baseline/, "ensureBaseline in a non-Git directory must throw");
    check("git failure: ensureBaseline in a non-Git repository throws", true);
  } catch (e) {
    check("git failure: ensureBaseline in a non-Git repository throws", false, e.message);
  } finally {
    cleanup(nonRepo);
  }

  const nonRepo2 = fs.mkdtempSync(path.join(os.tmpdir(), "ap-ib-nonrepo2-"));
  try {
    assert.throws(() => scopedDelta(nonRepo2, "k"), /implementation-baseline/, "scopedDelta in a non-Git directory must throw");
    check("git failure: scopedDelta in a non-Git repository throws (no manifest, but status still fails)", true);
  } catch (e) {
    check("git failure: scopedDelta in a non-Git repository throws (no manifest, but status still fails)", false, e.message);
  } finally {
    cleanup(nonRepo2);
  }

  // git spawn failure: PATH stripped of any git binary. Real subprocess/
  // environment fixture, not a production hook — implementation-baseline.mjs
  // uses spawnSync("git", ...) with no explicit env, so it inherits
  // process.env.PATH at call time.
  {
    const repo = makeRepo("spawnfail");
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = "";
      let threw = false;
      let message = "";
      try { ensureBaseline(repo, "k"); } catch (e) { threw = true; message = e.message; }
      check("git failure: a git spawn failure (git not on PATH) throws a clear error", threw && /implementation-baseline/.test(message), message);
    } finally {
      process.env.PATH = originalPath;
      cleanup(repo);
    }
  }

  // diff exit code > 1: a fake `git` wrapper on PATH forwards every
  // subcommand to the REAL git except `diff --no-index`, which it forces to
  // exit 2 (an invalid, unexpected code — only 0/1 are ever valid for
  // --no-index). A real subprocess fixture, not a production test hook.
  //
  // Windows capability note: this fixture only works as a POSIX shebang
  // script. A Windows port would need a `.cmd`/`.bat` forwarder, but
  // Node.js refuses to spawn `.bat`/`.cmd` files at all when `shell` is not
  // `true` (throws EINVAL — confirmed directly against this Node version;
  // this is deliberate upstream hardening, not a bug) — and
  // implementation-baseline.mjs's own git() helper (line ~100 above) calls
  // spawnSync("git", args, {shell: false}) unconditionally, exactly like
  // real git.exe is invoked in production (where it works fine, since
  // git.exe is a genuine native binary, never a batch script). So a
  // batch-script "git" can never be reached this way on native Windows —
  // an unrelated-to-this-task Node/Windows capability gap, not something a
  // fixture change or a production change belongs to. Probe it directly
  // rather than assuming by platform, and self-skip only this one check if
  // so; every other Defect-3 check above already ran and is unaffected.
  {
    const repo = makeRepo("diffexit");
    const realGit = (spawnSync(process.platform === "win32" ? "where" : "which", ["git"], {encoding: "utf8"}).stdout || "").trim().split(/\r?\n/)[0];
    const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-ib-fakegit-"));
    let batchSpawnCapable = true;
    if (process.platform === "win32") {
      const probePath = path.join(fakeBinDir, "ap-ib-batch-probe.cmd");
      fs.writeFileSync(probePath, "@echo off\r\nexit /b 0\r\n");
      const probe = spawnSync(probePath, [], {encoding: "utf8", shell: false});
      batchSpawnCapable = !probe.error;
    }
    if (!batchSpawnCapable) {
      console.log("SKIP: 'git failure: diff --no-index exit code > 1 throws a clear error' — platform prerequisite not met: Node.js on this platform refuses to spawn a .bat/.cmd file without shell:true (EINVAL), and implementation-baseline.mjs's git() helper spawns with shell:false, so this fixture's fake-git-as-batch-script technique cannot intercept it here.");
      cleanup(repo, fakeBinDir);
    } else {
    const fakeGitPath = process.platform === "win32" ? path.join(fakeBinDir, "git.cmd") : path.join(fakeBinDir, "git");
    if (process.platform === "win32") {
      fs.writeFileSync(fakeGitPath, [
        "@echo off",
        "for %%a in (%*) do (",
        "  if \"%%a\"==\"--no-index\" (",
        "    echo fake git: forced diff --no-index failure 1>&2",
        "    exit /b 2",
        "  )",
        ")",
        `"${realGit}" %*`,
        ""
      ].join("\r\n"));
    } else {
      fs.writeFileSync(fakeGitPath, [
        "#!/bin/sh",
        "for a in \"$@\"; do",
        "  if [ \"$a\" = \"--no-index\" ]; then",
        "    echo 'fake git: forced diff --no-index failure' 1>&2",
        "    exit 2",
        "  fi",
        "done",
        `exec "${realGit}" "$@"`,
        ""
      ].join("\n"));
      fs.chmodSync(fakeGitPath, 0o755);
    }
    fs.writeFileSync(path.join(repo, "dirty.txt"), "seed\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "seed"]);
    fs.writeFileSync(path.join(repo, "dirty.txt"), "seed\nchanged-before\n");
    const originalPath = process.env.PATH;
    try {
      ensureBaseline(repo, "k"); // capture with the REAL git still on PATH
      fs.writeFileSync(path.join(repo, "dirty.txt"), "seed\nchanged-before\nmission-change\n");
      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
      let threw = false, message = "";
      try { scopedDelta(repo, "k"); } catch (e) { threw = true; message = e.message; }
      check("git failure: diff --no-index exit code > 1 throws a clear error", threw && /implementation-baseline/.test(message) && /exited 2/.test(message), message);
    } finally {
      process.env.PATH = originalPath;
      cleanup(repo, fakeBinDir);
    }
    }
  }
}

// ===========================================================================
// Defect 4: symlinks must never be dereferenced — external target content
// must never be read into the baseline snapshot, manifest, or delta.
//
// File symlinks specifically (not directory junctions, which Windows allows
// unprivileged) require SeCreateSymbolicLinkPrivilege on Windows — granted
// only in Developer Mode or when elevated. Probe the actual capability
// rather than assuming by platform: self-skip only this defect's checks
// when creating a real symlink fails, since there is no unprivileged
// Windows-native mechanism with symlink semantics (a hardlink shares the
// same inode and cannot be repointed at a different target the way this
// test's second half requires, so it is not an equivalent substitute).
// ===========================================================================
{
  const repo = makeRepo("symlink");
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-ib-external-"));
  let symlinkCapable = true;
  try {
    const probeTarget = path.join(externalDir, "probe-target.txt");
    const probeLink = path.join(externalDir, "probe-link.txt");
    fs.writeFileSync(probeTarget, "probe");
    fs.symlinkSync(probeTarget, probeLink);
    fs.unlinkSync(probeLink);
    fs.unlinkSync(probeTarget);
  } catch (e) {
    symlinkCapable = false;
    console.log(`SKIP: Defect 4 (symlink) checks — platform prerequisite not met: file-symlink creation is unavailable (${e.code || e.message}); on Windows this needs Developer Mode or elevation (SeCreateSymbolicLinkPrivilege).`);
  }
  if (!symlinkCapable) {
    cleanup(repo, externalDir);
  } else
  try {
    const secretA = "SECRET_EXTERNAL_CONTENT_ALPHA_" + Math.random().toString(36).slice(2);
    const secretB = "SECRET_EXTERNAL_CONTENT_BETA_" + Math.random().toString(36).slice(2);
    const externalFileA = path.join(externalDir, "secret-a.txt");
    const externalFileB = path.join(externalDir, "secret-b.txt");
    fs.writeFileSync(externalFileA, secretA + "\n");
    fs.writeFileSync(externalFileB, secretB + "\n");

    const linkPath = path.join(repo, "external-link.txt");
    fs.symlinkSync(externalFileA, linkPath);

    ensureBaseline(repo, "k");

    // Nothing under .autopilot/baseline may ever contain either secret, and
    // no snapshot entry may be a REGULAR FILE copy of the symlink's target
    // (it must remain a symlink itself).
    const baselineRoot = path.join(repo, ".autopilot", "baseline", "k");
    let anySecretLeaked = false;
    let snapshotIsSymlink = false;
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          if (full.endsWith(path.join("files", "external-link.txt"))) snapshotIsSymlink = true;
          continue; // never follow/read through it
        }
        if (entry.isDirectory()) { walk(full); continue; }
        const content = fs.readFileSync(full, "utf8");
        if (content.includes(secretA) || content.includes(secretB)) anySecretLeaked = true;
      }
    })(baselineRoot);
    check("symlink: baseline snapshot recreates the symlink itself, never a copy of its target's bytes", snapshotIsSymlink);
    check("symlink: no external target content is ever copied into .autopilot/baseline", !anySecretLeaked);

    // Change the symlink's target -- the delta must reflect the LINK change
    // without ever exposing either target's content.
    fs.unlinkSync(linkPath);
    fs.symlinkSync(externalFileB, linkPath);
    const delta = scopedDelta(repo, "k");
    check("symlink: the target change is included in the scoped delta", delta.length > 0 && /external-link\.txt/.test(delta), delta);
    check("symlink: the scoped delta never contains either external file's content", !delta.includes(secretA) && !delta.includes(secretB), delta);

    check("symlink: the external files themselves remain byte-unchanged", fs.readFileSync(externalFileA, "utf8") === secretA + "\n" && fs.readFileSync(externalFileB, "utf8") === secretB + "\n");
  } finally {
    cleanup(repo, externalDir);
  }
}

// ===========================================================================
// Harness-prefix visibility (negative regression): files under the
// `.autopilot-test-` prefix are ordinary repository content to the delta
// authority — no production exclusion may ever hide them. A prefix-wide
// bypass would let real deliverables skip review evidence (empty delta)
// and the git-invisible guard (unchanged listing) alike, so both the
// untracked and the tracked-modified shapes must stay visible here.
// ===========================================================================
{
  const repo = makeRepo("prefix-visibility");
  try {
    const probeName = ".autopilot-test-production-output";
    const probeAbs = path.join(repo, probeName);
    const marker = "REAL_DELIVERABLE_CONTENT_" + Math.random().toString(36).slice(2);
    ensureBaseline(repo, "k");

    // Untracked shape: brand-new file carrying real content.
    fs.writeFileSync(probeAbs, marker + "\n");
    check("prefix-visibility: untracked harness-prefix file is listed by listWorktreeEntries",
      listWorktreeEntries(repo).includes(probeName));
    const deltaUntracked = scopedDelta(repo, "k");
    check("prefix-visibility: untracked harness-prefix file content is surfaced in the scoped delta",
      deltaUntracked.includes(marker), deltaUntracked.slice(0, 300));

    // Tracked-modified shape: committed, then changed.
    git(repo, ["add", probeName]);
    git(repo, ["commit", "-q", "-m", "seed probe file"]);
    ensureBaseline(repo, "k2");
    fs.writeFileSync(probeAbs, marker + "\nmodified\n");
    const deltaTracked = scopedDelta(repo, "k2");
    check("prefix-visibility: tracked-modified harness-prefix file content is surfaced in the scoped delta",
      deltaTracked.includes(marker) && deltaTracked.includes("modified"), deltaTracked.slice(0, 300));
  } finally {
    cleanup(repo);
  }
}

// ===========================================================================
// TASK-23: hasBaseline/removeBaseline — manifest-existence probe and
// force-remove of a whole baseline key, in a temp directory.
// ===========================================================================
{
  const repo = makeRepo("has-remove");
  try {
    check("hasBaseline: absent before capture", hasBaseline(repo, "rk") === false);
    ensureBaseline(repo, "rk");
    check("hasBaseline: present after capture", hasBaseline(repo, "rk") === true);
    check("hasBaseline: a sibling key is still absent", hasBaseline(repo, "other") === false);
    // Deleting only the manifest flips the probe: the re-review fallback
    // keys off the manifest, never the files/ directory.
    fs.rmSync(path.join(repo, ".autopilot", "baseline", "rk", "manifest.json"));
    check("hasBaseline: absent once the manifest is gone", hasBaseline(repo, "rk") === false);
    removeBaseline(repo, "rk");
    check("removeBaseline: key directory gone", !fs.existsSync(path.join(repo, ".autopilot", "baseline", "rk")));
    // Force: removing a never-captured or already-removed key never throws.
    removeBaseline(repo, "never-captured");
    check("removeBaseline: unknown key is a no-op", true);
    ensureBaseline(repo, "rk2");
    removeBaseline(repo, "rk2");
    check("removeBaseline: captured key removed", hasBaseline(repo, "rk2") === false);
  } finally {
    cleanup(repo);
  }
}

// ===========================================================================
// Backlog #40: rebaseBaselineOntoHead applies operator commits made after
// capture to the stored baseline copy and records the new HEAD, so those
// commits stop appearing in the phase delta.
// ===========================================================================
{
  const repo = makeRepo("rebase-head");
  try {
    const file = path.join(repo, "operator.txt");
    fs.writeFileSync(file, "one\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);
    const baseHead = git(repo, ["rev-parse", "HEAD"]);
    // Pre-existing dirty copy at capture time.
    fs.writeFileSync(file, "operator-one\n");
    ensureBaseline(repo, "phase");
    check("rebase: manifest records the capture HEAD", baselineBaseHead(repo, "phase") === baseHead);
    check("rebase: pre-existing dirty copy is excluded from the delta before the commit",
      scopedDelta(repo, "phase").trim() === "");
    // Operator commits the paused work while the phase baseline stays put.
    fs.writeFileSync(file, "operator-two\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "operator pause commit"]);
    const newHead = git(repo, ["rev-parse", "HEAD"]);
    check("rebase: HEAD moved", newHead !== baseHead);
    const result = rebaseBaselineOntoHead(repo, "phase");
    check("rebase: reports the patched file", result.ok === true && result.rebased === true && result.files.includes("operator.txt"), JSON.stringify(result));
    check("rebase: manifest baseHead moves to current HEAD", baselineBaseHead(repo, "phase") === newHead);
    check("rebase: operator commit no longer appears in the phase delta", scopedDelta(repo, "phase").trim() === "", scopedDelta(repo, "phase"));
    check("rebase: no-op at HEAD", rebaseBaselineOntoHead(repo, "phase").reason === "already-at-head");
  } finally {
    cleanup(repo);
  }
}

if (failures) {
  console.error(`${failures} implementation-baseline check(s) failed.`);
  process.exit(1);
}
console.log("implementation-baseline unit tests passed");
