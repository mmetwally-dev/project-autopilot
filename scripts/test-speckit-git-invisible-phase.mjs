#!/usr/bin/env node
// TASK 15.6F — pure unit tests for the git-invisible-phase guard.
//
// The real incident: Phase 1's only task created an empty docs/ directory.
// Git cannot represent empty directories, so the Implementer exited 0 with
// touchedFiles empty, the disposable-copy Verifier could never observe the
// change, and Autopilot burned five attempts plus three verification budget
// units. Production now stops at the first such attempt (GIT_INVISIBLE_PHASE)
// when the worktree listing changed while the Git-observable phase delta
// stayed empty — while a fully quiescent attempt proceeds exactly as before
// (see test-dirty-worktree-isolation.mjs zero-change, which must keep passing).
//
// This file proves, on disposable directories (no agent CLI, no mission):
//   1. listWorktreeEntries detects empty-directory creation (trailing "/"),
//      file writes, and symlink entries without following them, while
//      ignoring .git/.autopilot bookkeeping and staying identical on no-ops;
//   2. the production scopedDelta authority reports "" for an empty-dir-only
//      change and non-"" once a real file lands (the git-invisibility premise
//      the guard relies on).
// Companion to the behavioral tests (Windows + POSIX mission runs): those
// prove the die-before-review wiring, budget preservation, and ordering;
// THIS file proves the two pure signals the guard combines.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import {fileURLToPath} from "node:url";
import {listWorktreeEntries, ensureBaseline, scopedDelta} from "./implementation-baseline.mjs";
import {phases as parseSpecPhases} from "../adapters/speckit.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ap-invisible-phase-unit-"));
}
function rmRepo(repo) {
  fs.rmSync(repo, {recursive: true, force: true});
}
function git(repo, args) {
  const r = spawnSync("git", args, {cwd: repo, encoding: "utf8", env: withoutOuterGitGuard(process.env), shell: false});
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim().slice(0, 500)}`);
}
function makeGitRepo() {
  const repo = makeRepo();
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "invisible-phase-test@example.invalid"]);
  git(repo, ["config", "user.name", "Invisible Phase Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

// ── 1. worktree listing semantics ─────────────────────────────────────────
{
  const repo = makeGitRepo();
  try {
    const before = listWorktreeEntries(repo);
    assert.ok(before.includes("README.md"), "files are listed");
    assert.ok(!before.some(e => e === ".git" || e.startsWith(".git/")), ".git tree is excluded");
    assert.ok(!before.some(e => e === ".autopilot" || e.startsWith(".autopilot/")), ".autopilot tree is excluded");

    // No-op: identical listing.
    assert.deepEqual(listWorktreeEntries(repo), before, "quiescent worktree lists identically");

    // Empty directory: visible here (trailing slash) although git-blind.
    fs.mkdirSync(path.join(repo, "docs"), {recursive: true});
    const withDir = listWorktreeEntries(repo);
    assert.ok(withDir.includes("docs/"), "empty directory is listed with trailing slash");
    assert.notDeepEqual(withDir, before, "empty-dir creation changes the listing");

    // Orchestrator bookkeeping does not count as implementation change.
    fs.mkdirSync(path.join(repo, ".autopilot", "runs"), {recursive: true});
    fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), "{}");
    assert.deepEqual(listWorktreeEntries(repo), withDir, ".autopilot writes are ignored");

    // Real file: listed as well.
    fs.writeFileSync(path.join(repo, "docs", "note.md"), "# note\n");
    const withFile = listWorktreeEntries(repo);
    assert.ok(withFile.includes("docs/note.md"), "nested files are listed");
    assert.notDeepEqual(withFile, withDir, "file creation changes the listing");

    // Symlink: listed as one entry, never followed (target contents invisible).
    const outside = makeGitRepo();
    try {
      fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");
      let linkOk = true;
      try {
        fs.symlinkSync(outside, path.join(repo, "linked"));
      } catch {
        linkOk = false;
      }
      if (linkOk) {
        const withLink = listWorktreeEntries(repo);
        assert.ok(withLink.includes("linked"), "symlink itself is listed");
        assert.ok(!withLink.some(e => e.startsWith("linked/")), "symlink target is never descended into");
      } else {
        console.log("SKIP symlink case (symlink creation unsupported in this environment)");
      }
    } finally {
      rmRepo(outside);
    }
  } finally {
    rmRepo(repo);
  }
  console.log("PASS worktree listing semantics");
}

// ── 2. git-invisibility premise via the production delta authority ────────
{
  const repo = makeGitRepo();
  try {
    ensureBaseline(repo, "test-key");
    // Empty directory only: production delta stays empty (the incident).
    fs.mkdirSync(path.join(repo, "docs"), {recursive: true});
    assert.equal(scopedDelta(repo, "test-key"), "", "empty-dir-only change is git-invisible to scopedDelta");
    // Real file: delta becomes observable.
    fs.writeFileSync(path.join(repo, "docs", "FINAL-SMOKE.md"), "# doc\n");
    assert.notEqual(scopedDelta(repo, "test-key"), "", "file creation is git-observable to scopedDelta");
  } finally {
    rmRepo(repo);
  }
  console.log("PASS git-invisibility premise via production scopedDelta");
}

// ── 3. incident task shape parses to executable phases (structurally valid,
//       hence uncatchable by the 15.6E postcondition — the guard's raison d'être)
{
  const repo = makeRepo();
  try {
    const tasksRel = "specs/001-incident/tasks.md";
    fs.mkdirSync(path.join(repo, "specs", "001-incident"), {recursive: true});
    fs.writeFileSync(path.join(repo, tasksRel), [
      "## Phase 1: Setup",
      "",
      "- [ ] T001 Create the docs/ directory at the repository root",
      "",
      "## Phase 2: Documentation Authoring",
      "",
      "- [ ] T002 Write docs/WINDOWS-AUTOPILOT-FINAL-SMOKE.md",
      ""
    ].join("\n"));
    const phased = parseSpecPhases(repo, [tasksRel]);
    assert.equal(phased.length, 2, "incident shape parses to two phases");
    assert.ok(phased.every(p => p.tasks.some(t => !t.done)), "both phases executable");
    assert.equal(phased[0].tasks.filter(t => !t.done).length, 1, "Phase 1 holds exactly the dir-creation task");
  } finally {
    rmRepo(repo);
  }
  console.log("PASS incident shape is structurally valid phased input");
}

// ── 4. production hygiene: guard reuses existing authorities ──────────────
{
  const baselineSource = fs.readFileSync(path.join(here, "implementation-baseline.mjs"), "utf8");
  assert.ok(baselineSource.includes("listWorktreeEntries"), "listing lives beside the delta authority");
  const autoSource = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
  assert.ok(autoSource.includes("GIT_INVISIBLE_PHASE"), "runtime guard reports the precise failure");
  assert.ok(autoSource.includes("listWorktreeEntries"), "runtime guard uses the worktree listing");
  // No placeholder-file synthesis, no keyword heuristics in production.
  assert.ok(!/\.gitkeep/i.test(autoSource), "no placeholder-file synthesis in the orchestrator");
  assert.ok(!/\.gitkeep/i.test(baselineSource), "no placeholder-file synthesis in the baseline module");
  console.log("PASS production hygiene");
}

console.log("test-speckit-git-invisible-phase: ALL CHECKS PASSED");
