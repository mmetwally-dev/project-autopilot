#!/usr/bin/env node
// TASK 16 — the Layer-1 git-guard scope check gets a sandbox-side protected
// identity (`appendGuardScopeRoot`), so a disposable fixture repo's own
// `git init`/`git commit` under os.tmpdir() inside the bubblewrap envelope
// (repository and scratch as sibling binds, TMPDIR=/workspace/scratch) is no
// longer blocked, while a mutation that genuinely targets
// `/workspace/repository` still is.
//
// Coverage, mirroring test-git-guard-layer1-scoping.mjs's structure:
//   A. appendGuardScopeRoot()'s I/O contract, unit-tested directly (runs on
//      every platform with git): exact `root=<path>` line, prior bytes
//      preserved, and every rejection (relative path, embedded \n or \r,
//      missing/unwritable scope file) throws with the file unmodified.
//   B. Old-vs-new discrimination WITHOUT touching the working tree (which
//      may carry unrelated uncommitted changes): two independent guard
//      instances, one without the append and one with it — the appended
//      root flips from "outside" to "protected" under the EXISTING
//      containment logic, while an unrelated repo stays outside for both.
//   C. The core case inside a REAL bubblewrap invocation (Linux-only; a
//      counted, clearly reported SKIP elsewhere — never a silent pass):
//      fixture commit under os.tmpdir() succeeds with blocked.log empty for
//      the appended guard, is blocked for the un-appended guard (today's
//      bug, reproduced), and all four invocation forms targeting
//      /workspace/repository are still blocked with Layer-1 evidence.
//   D. Static call-site check (runs on every platform, no sandbox needed):
//      section C drives appendGuardScopeRoot with a literal, so it never
//      executes runRelay's actual wiring. This section pins that wiring by
//      inspection: the call site passes executionEnvelope.sandbox.repository
//      (never a hardcoded path), is gated on the reviewer-role envelope
//      condition, sits after guard creation and before launch (fail closed
//      before spawn), and exists exactly once (guardedShell untouched).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {createGitMutationGuard, appendGuardScopeRoot, writeGuardBeforeSnapshot, normalizeGuardPath, isOutsideProtectedIdentity, guardedEnv, readGuardLog} from "./relay-guards.mjs";
import {buildExecutionEnvelope, mapEnvironmentIntoEnvelope} from "./execution-envelope.mjs";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
// 024 Phase 4 task 4.2: this test builds its own git repos, so the ambient
// outer guard (when run inside a mission) must be stripped first — otherwise
// the fixture `git commit` setup calls below are blocked by the outer guard.
{ const clean = withoutOuterGitGuard(process.env); for (const k of Object.keys(process.env)) if (!(k in clean)) delete process.env[k]; process.env.PATH = clean.PATH; }

let passed = 0;
let failed = 0;
let skipped = 0;
function check(label, ok, detail) {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { failed++; console.error(`FAIL ${label}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`); }
}
function skip(label) {
  skipped++;
  console.log(`SKIP ${label}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-task16-sandbox-"));
const DENIAL_RE = /AUTOPILOT GIT GUARD: .* is forbidden \(history\/ref mutation\)/;

function git(cwd, args, env) {
  return spawnSync("git", args, {cwd, encoding: "utf8", env: env || process.env, shell: false});
}
function combined(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}
function headOf(repo) {
  return String(git(repo, ["rev-parse", "HEAD"], process.env).stdout || "").trim();
}
function makeRepo(name) {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, {recursive: true});
  assert.equal(git(repo, ["init", "-q"]).status, 0);
  assert.equal(git(repo, ["config", "user.email", "task16@example.invalid"]).status, 0);
  assert.equal(git(repo, ["config", "user.name", "Task 16"]).status, 0);
  fs.writeFileSync(path.join(repo, "file.txt"), "base\n");
  assert.equal(git(repo, ["add", "-A"]).status, 0);
  assert.equal(git(repo, ["commit", "-q", "-m", "init"]).status, 0);
  return repo;
}

if (git(root, ["--version"]).status !== 0) {
  skip("A/B/C/D git executable unavailable — nothing to prove without git");
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed ? 1 : 0);
}

const protectedRepo = makeRepo("protected");
const outsideRepo = makeRepo("outside");

// =====================================================================
// A. appendGuardScopeRoot() I/O contract (direct, no sandbox needed).
// =====================================================================
{
  const runDir = path.join(root, "run-contract");
  fs.mkdirSync(runDir, {recursive: true});
  const guard = createGitMutationGuard(runDir, protectedRepo);
  check("A. scope file was written for the protected repo", typeof guard.scopeFile === "string" && fs.existsSync(guard.scopeFile), guard.scopeFile);

  const before = fs.readFileSync(guard.scopeFile, "utf8");
  const sandboxPath = process.platform === "win32" ? "C:/workspace/repository" : "/workspace/repository";
  appendGuardScopeRoot(guard.scopeFile, sandboxPath);
  const after = fs.readFileSync(guard.scopeFile, "utf8");
  const expectedLine = `root=${normalizeGuardPath(sandboxPath, process.platform === "win32" || process.platform === "darwin")}\n`;
  check("A. append produces exactly one new root= line, prior bytes preserved", after === before + expectedLine, {tail: after.slice(before.length)});

  const rejections = [
    ["relative path", "relative/path"],
    ["embedded newline", "/x\nroot=/evil"],
    ["embedded carriage return", "/x\rroot=/evil"],
    ["empty path", ""],
  ];
  for (const [label, bad] of rejections) {
    const snap = fs.readFileSync(guard.scopeFile, "utf8");
    let threw = false;
    try { appendGuardScopeRoot(guard.scopeFile, bad); } catch { threw = true; }
    check(`A. rejection: ${label} throws`, threw === true);
    check(`A. rejection: ${label} leaves the scope file unmodified`, fs.readFileSync(guard.scopeFile, "utf8") === snap);
  }
  {
    const snap = fs.readFileSync(guard.scopeFile, "utf8");
    let threw = false;
    try { appendGuardScopeRoot(path.join(root, "no-such-dir", "git-scope.conf"), sandboxPath); } catch { threw = true; }
    check("A. rejection: missing/unwritable scope file throws", threw === true);
    check("A. rejection: missing scope file leaves the real file unmodified", fs.readFileSync(guard.scopeFile, "utf8") === snap);
  }
}

// =====================================================================
// B. Old-vs-new discrimination with two independent guard instances — no
//    source file is ever edited (pure isOutsideProtectedIdentity calls).
// =====================================================================
{
  const oldDir = path.join(root, "run-old");
  const newDir = path.join(root, "run-new");
  fs.mkdirSync(oldDir, {recursive: true});
  fs.mkdirSync(newDir, {recursive: true});
  const oldGuard = createGitMutationGuard(oldDir, protectedRepo);
  const newGuard = createGitMutationGuard(newDir, protectedRepo);
  const sandboxRepo = outsideRepo; // an existing directory standing in for the sandbox-side path
  appendGuardScopeRoot(newGuard.scopeFile, sandboxRepo);
  check(
    "B. without the append, the second root reads as outside (today's behavior)",
    isOutsideProtectedIdentity(sandboxRepo, oldGuard.scopeFile, {}, oldGuard.realGit) === true
  );
  check(
    "B. with the append, the same root reads as protected (fixed behavior)",
    isOutsideProtectedIdentity(sandboxRepo, newGuard.scopeFile, {}, newGuard.realGit) === false
  );
  const third = makeRepo("third");
  check(
    "B. an unrelated repo stays outside under both instances",
    isOutsideProtectedIdentity(third, oldGuard.scopeFile, {}, oldGuard.realGit) === true
    && isOutsideProtectedIdentity(third, newGuard.scopeFile, {}, newGuard.realGit) === true
  );
}

// =====================================================================
// C. Real bubblewrap sandbox case. The bug is specifically that host paths
//    recorded in git-scope.conf don't resolve inside the sandbox's own
//    mount namespace — plain sibling host directories cannot reproduce it,
//    so this section runs inside a real bwrap invocation or reports a
//    counted SKIP (never a silent pass).
// =====================================================================
if (process.platform !== "linux") {
  skip("C. real-bwrap sandbox case requires Linux (bubblewrap) — not evaluated on this platform");
} else {
  const probeName = "task16-probe.mjs";
  const probeSource = [
    'import {spawnSync} from "node:child_process";',
    'import fs from "node:fs";',
    'import os from "node:os";',
    'import path from "node:path";',
    'const mode = process.argv[2];',
    'const git = (cwd, args, env) => spawnSync("git", args, {cwd, encoding: "utf8", env, shell: false});',
    'const report = (obj) => { console.log("AUTOPILOT_PROBE_RESULT:" + JSON.stringify(obj)); };',
    'if (mode === "fixture") {',
    '  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ap-task16-fixture-"));',
    '  const steps = [];',
    '  steps.push(["init", git(d, ["init", "-q"]).status]);',
    '  git(d, ["config", "user.email", "fixture@example.invalid"]);',
    '  git(d, ["config", "user.name", "Fixture"]);',
    '  fs.writeFileSync(path.join(d, "made.txt"), "made\\n");',
    '  git(d, ["add", "-A"]);',
    '  const commit = git(d, ["commit", "-q", "-m", "init"]);',
    '  const head = String(git(d, ["rev-parse", "HEAD"]).stdout || "").trim();',
    '  report({tmpdir: os.tmpdir(), commitStatus: commit.status, out: ((commit.stdout || "") + "\\n" + (commit.stderr || "")).slice(0, 400), head});',
    '} else if (mode === "attack") {',
    '  const repo = "/workspace/repository";',
    '  const gitDir = "/workspace/repository/.git";',
    '  const forms = [',
    '    {name: "plain cwd", cwd: repo, argv: ["commit", "-q", "--allow-empty", "-m", "nope"], env: null},',
    '    {name: "-C", cwd: "/workspace/scratch", argv: ["-C", repo, "commit", "-q", "--allow-empty", "-m", "nope"], env: null},',
    '    {name: "--git-dir=", cwd: "/workspace/scratch", argv: [`--git-dir=${gitDir}`, "commit", "-q", "--allow-empty", "-m", "nope"], env: null},',
    '    {name: "GIT_DIR", cwd: "/workspace/scratch", argv: ["commit", "-q", "--allow-empty", "-m", "nope"], env: {GIT_DIR: gitDir}},',
    '  ];',
    '  const results = forms.map((f) => {',
    '    const r = git(f.cwd, f.argv, f.env ? {...process.env, ...f.env} : undefined);',
    '    return {form: f.name, status: r.status, out: ((r.stdout || "") + "\\n" + (r.stderr || "")).slice(0, 200)};',
    '  });',
    '  report({tmpdir: os.tmpdir(), results});',
    '} else { report({error: "unknown mode " + mode}); process.exit(3); }',
    "",
  ].join("\n");

  // One envelope per guard instance: each scratch dir is bound to
  // /workspace/scratch for its own invocation.
  async function sandboxCase({label, append}) {
    const scratch = path.join(root, `scratch-${label}`);
    fs.mkdirSync(scratch, {recursive: true});
    const guard = createGitMutationGuard(scratch, protectedRepo);
    if (append) appendGuardScopeRoot(guard.scopeFile, "/workspace/repository");
    fs.writeFileSync(path.join(scratch, probeName), probeSource);
    const envelope = buildExecutionEnvelope({
      repo: protectedRepo, scratchDir: scratch, readOnly: true, config: {},
      binary: process.execPath, args: [`/workspace/scratch/${probeName}`, "fixture"],
    });
    if (!envelope.available) return {skipped: envelope.reason || "envelope unavailable"};
    const launchEnv = mapEnvironmentIntoEnvelope(guardedEnv(guard, {}), envelope, protectedRepo, scratch);
    const r = spawnSync(envelope.binary, envelope.args, {cwd: envelope.cwd, encoding: "utf8", env: launchEnv, shell: false, timeout: 120000});
    const line = String(r.stdout || "").split(/\r?\n/).find(l => l.startsWith("AUTOPILOT_PROBE_RESULT:"));
    if (!line) return {error: `no probe result (status ${r.status}): ${(r.stderr || "").slice(0, 300)}`};
    return {probe: JSON.parse(line.slice("AUTOPILOT_PROBE_RESULT:".length)), guard, envelope};
  }

  // Availability gate first: without a usable envelope nothing below can run.
  const gateScratch = path.join(root, "scratch-gate");
  fs.mkdirSync(gateScratch, {recursive: true});
  const gate = buildExecutionEnvelope({
    repo: protectedRepo, scratchDir: gateScratch, readOnly: true, config: {},
    binary: process.execPath, args: ["--version"],
  });
  if (!gate.available) {
    skip(`C. real-bwrap sandbox case unavailable in this environment (${gate.reason || "unknown"}) — not evaluated`);
  } else {
    const oldResult = await sandboxCase({label: "old", append: false});
    if (oldResult.skipped || oldResult.error) {
      skip(`C. old-guard sandbox probe could not run (${oldResult.skipped || oldResult.error})`);
    } else {
      check(
        "C. regression control: without the append, the sandbox fixture commit is blocked (today's bug reproduced)",
        oldResult.probe.commitStatus === 97 && DENIAL_RE.test(oldResult.probe.out || ""),
        {status: oldResult.probe.commitStatus, out: (oldResult.probe.out || "").slice(0, 160), tmpdir: oldResult.probe.tmpdir}
      );
      check("C. regression control: the fixture really landed under /workspace/scratch", String(oldResult.probe.tmpdir || "").startsWith("/workspace/scratch"), oldResult.probe.tmpdir);
    }

    const newResult = await sandboxCase({label: "new", append: true});
    if (newResult.skipped || newResult.error) {
      skip(`C. new-guard sandbox probe could not run (${newResult.skipped || newResult.error})`);
    } else {
      check(
        "C. core case: with the append, the sandbox fixture commit succeeds",
        newResult.probe.commitStatus === 0 && !DENIAL_RE.test(newResult.probe.out || "") && (newResult.probe.head || "").length > 0,
        {status: newResult.probe.commitStatus, out: (newResult.probe.out || "").slice(0, 160)}
      );
      const entries = readGuardLog(newResult.guard.logFile);
      check("C. core case: blocked.log stayed empty", entries.length === 0, entries.slice(0, 3));

      // Security control in the same sandbox: every form targeting
      // /workspace/repository must still be blocked BY LAYER 1 (exit 97 +
      // guard stderr + a path-shim log entry), not merely fail — a
      // read-only bind can fail a write for unrelated reasons, so "didn't
      // succeed" alone would pass for the wrong reason. HEAD must not move.
      const headBefore = headOf(protectedRepo);
      const logBefore = readGuardLog(newResult.guard.logFile).length;
      const attackScratch = path.join(root, "scratch-new");
      // Reuse the same sandbox: probe in attack mode against the appended guard.
      const attackEnvelope = buildExecutionEnvelope({
        repo: protectedRepo, scratchDir: attackScratch, readOnly: true, config: {},
        binary: process.execPath, args: [`/workspace/scratch/${probeName}`, "attack"],
      });
      let attackProbe = null;
      if (attackEnvelope.available) {
        const attackLaunchEnv = mapEnvironmentIntoEnvelope(guardedEnv(newResult.guard, {}), attackEnvelope, protectedRepo, attackScratch);
        const ar = spawnSync(attackEnvelope.binary, attackEnvelope.args, {cwd: attackEnvelope.cwd, encoding: "utf8", env: attackLaunchEnv, shell: false, timeout: 120000});
        const aline = String(ar.stdout || "").split(/\r?\n/).find(l => l.startsWith("AUTOPILOT_PROBE_RESULT:"));
        if (aline) attackProbe = JSON.parse(aline.slice("AUTOPILOT_PROBE_RESULT:".length));
      }
      const logAfter = readGuardLog(newResult.guard.logFile);
      const newEntries = logAfter.slice(logBefore);
      const misses = [];
      if (!attackProbe) {
        misses.push({form: "*", reason: "no attack probe result"});
      } else {
        for (const fr of attackProbe.results || []) {
          const denied = fr.status === 97 && DENIAL_RE.test(fr.out || "");
          if (!denied || !newEntries.some(e => e && e.layer === "path-shim")) misses.push({form: fr.form, status: fr.status, out: (fr.out || "").slice(0, 120)});
        }
      }
      check("C. security control: all 4 forms targeting /workspace/repository still blocked by Layer 1", misses.length === 0, misses.slice(0, 4));
      check("C. security control: blocked.log gained a path-shim entry per attempt", newEntries.filter(e => e && e.layer === "path-shim").length >= 4, newEntries.slice(0, 6));
      check("C. security control: protected HEAD unchanged", headOf(protectedRepo) === headBefore, {before: headBefore, after: headOf(protectedRepo)});
    }
  }
}

// =====================================================================
// D. Static call-site check: section C proves the mechanism through the
//    production envelope builders, but drives appendGuardScopeRoot with a
//    literal — it never executes runRelay's own wiring. Pin that wiring
//    here: envelope value (not a literal), reviewer-role gate, placement
//    after guard creation / before launch, exactly one call site.
// =====================================================================
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const autopilotSource = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
  const envelopeSource = fs.readFileSync(path.join(here, "execution-envelope.mjs"), "utf8");
  check(
    "D. runRelay imports appendGuardScopeRoot from the guard module",
    /import\s*\{[^}]*\bappendGuardScopeRoot\b[^}]*\}\s*from\s*["']\.\/relay-guards\.mjs["']/.test(autopilotSource)
  );
  check(
    "D. runRelay passes executionEnvelope.sandbox.repository (not a literal)",
    /appendGuardScopeRoot\s*\(\s*guard\.scopeFile\s*,\s*executionEnvelope\.sandbox\.repository\s*\)/.test(autopilotSource)
  );
  check(
    "D. no call site passes a hardcoded sandbox path",
    !/appendGuardScopeRoot\s*\([^)]*["']\/workspace\/repository["']/.test(autopilotSource),
    "a literal would silently diverge from the envelope's source of truth"
  );
  check(
    "D. exactly one appendGuardScopeRoot call site (runRelay only; guardedShell untouched)",
    (autopilotSource.match(/appendGuardScopeRoot\s*\(/g) || []).length === 1
  );
  check(
    "D. append is gated on attemptEnvelope && executionEnvelope.available && sandbox.repository",
    /if\s*\(\s*attemptEnvelope\s*&&\s*executionEnvelope\?\.available\s*&&\s*executionEnvelope\?\.sandbox\?\.repository\s*\)/.test(autopilotSource)
  );
  check(
    "D. attemptEnvelope is the reviewer-role condition (readOnly && !disposableWorkspace)",
    /const\s+attemptEnvelope\s*=\s*readOnly\s*&&\s*!disposableWorkspace/.test(autopilotSource)
  );
  check(
    "D. envelope owns the sandbox.repository source of truth",
    envelopeSource.includes('repository: "/workspace/repository"')
  );
  const guardIdx = autopilotSource.indexOf("createGitMutationGuard(effectiveScratchDir||dir,effectiveCwd)");
  const appendIdx = autopilotSource.indexOf("appendGuardScopeRoot(guard.scopeFile,");
  const snapshotIdx = autopilotSource.indexOf("collectSnapshotGuards(cwd)");
  check(
    "D. append sits after guard creation and before launch (fail closed before spawn)",
    guardIdx !== -1 && appendIdx > guardIdx && snapshotIdx > appendIdx,
    {guardIdx, appendIdx, snapshotIdx}
  );
  check(
    "D. append failure fails the relay call closed",
    autopilotSource.includes("failed to record the sandbox repository identity")
  );
}

// =====================================================================
// E-H. 024 Phase 4 task 4.2 — per-run before-snapshot restore guard, live
// against the REAL wrapper (no mocks): restores of files the role did not
// modify in this run are denied (exit 97 + worktree-restore guard event,
// which the relay verdict surfaces as git_mutation_blocked), while restores
// of the role's own touched files stay allowed. Files dirty before the run
// but untouched by the role count as foreign; a missing snapshot denies
// fail-closed. POSIX PATH-shim dispatch only — counted SKIP on win32.
// I. Static wiring checks (every platform, no shim needed).
// =====================================================================
if (process.platform === "win32") {
  skip("E. foreign-file restore denied (needs POSIX PATH shim dispatch)");
  skip("F. own-file restore allowed (needs POSIX PATH shim dispatch)");
  skip("G. pre-dirty untouched=foreign, re-touched=allowed (needs POSIX PATH shim dispatch)");
  skip("H. missing snapshot denies fail-closed (needs POSIX PATH shim dispatch)");
} else {
  const WORKTREE_RE = /AUTOPILOT GIT GUARD: .* is forbidden \(worktree restore\)/;
  function makeGuardRepo(name, files) {
    const repo = path.join(root, name);
    fs.mkdirSync(repo, {recursive: true});
    assert.equal(git(repo, ["init", "-q"]).status, 0);
    assert.equal(git(repo, ["config", "user.email", "t42@example.invalid"]).status, 0);
    assert.equal(git(repo, ["config", "user.name", "Task 42"]).status, 0);
    for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(repo, rel), content);
    assert.equal(git(repo, ["add", "-A"]).status, 0);
    assert.equal(git(repo, ["commit", "-q", "-m", "init"]).status, 0);
    return repo;
  }
  function shieldedEnv(guard) {
    return guardedEnv(guard, {HOME: root, TMPDIR: root});
  }
  function lastEntries(guard, before) {
    return readGuardLog(guard.logFile).slice(before);
  }

  // E. Foreign-file restore denied across checkout/restore/stash forms.
  {
    const repo = makeGuardRepo("t42-foreign", {"own.txt": "own base\n", "foreign.txt": "foreign base\n"});
    const runDir = path.join(root, "run-t42-foreign");
    fs.mkdirSync(runDir, {recursive: true});
    const guard = createGitMutationGuard(runDir, repo);
    const snap = writeGuardBeforeSnapshot(guard.scopeFile, repo);
    check("E. before-snapshot file written next to git-scope.conf",
      typeof snap === "string" && fs.existsSync(snap) && path.dirname(snap) === path.dirname(guard.scopeFile),
      snap);
    const env = shieldedEnv(guard);
    const forms = [
      ["checkout", "--", "foreign.txt"],
      ["restore", "foreign.txt"],
      ["stash", "push", "-m", "t42-probe"],
    ];
    const misses = [];
    for (const argv of forms) {
      const before = readGuardLog(guard.logFile).length;
      const r = git(repo, argv, env);
      const denied = r.status === 97 && WORKTREE_RE.test(combined(r));
      const entries = lastEntries(guard, before);
      const logged = entries.some((e) => e && e.reason === "worktree-restore" && e.layer === "path-shim");
      if (!denied || !logged) misses.push({argv, status: r.status, out: combined(r).slice(0, 120), entries: entries.slice(0, 2)});
    }
    check("E. foreign-file restore denied with a guard event per form (block-plus-observation)", misses.length === 0, misses.slice(0, 3));
    check("E. foreign file bytes unchanged after the denied restores",
      fs.readFileSync(path.join(repo, "foreign.txt"), "utf8") === "foreign base\n");
  }

  // F. Own-file restore allowed; legitimate reads still succeed.
  {
    const repo = makeGuardRepo("t42-own", {"own.txt": "own base\n", "other.txt": "other base\n"});
    const runDir = path.join(root, "run-t42-own");
    fs.mkdirSync(runDir, {recursive: true});
    const guard = createGitMutationGuard(runDir, repo);
    writeGuardBeforeSnapshot(guard.scopeFile, repo);
    const env = shieldedEnv(guard);
    fs.writeFileSync(path.join(repo, "own.txt"), "own edited by the role\n");
    const logBefore = readGuardLog(guard.logFile).length;
    const r = git(repo, ["checkout", "--", "own.txt"], env);
    check("F. restore of the role's own touched file is allowed",
      r.status === 0 && !WORKTREE_RE.test(combined(r)),
      {status: r.status, out: combined(r).slice(0, 120)});
    check("F. own file restored to its HEAD bytes",
      fs.readFileSync(path.join(repo, "own.txt"), "utf8") === "own base\n");
    check("F. allowed restore wrote no guard event",
      readGuardLog(guard.logFile).length === logBefore);
    const st = git(repo, ["status", "--porcelain=v1"], env);
    const df = git(repo, ["diff", "--name-only"], env);
    check("F. legitimate implementer reads (status/diff) still succeed",
      st.status === 0 && df.status === 0, {status: st.status, diff: df.status});
  }

  // G. Pre-dirty but untouched by the role counts as foreign; re-touch allows.
  {
    const repo = makeGuardRepo("t42-predirty", {"predirty.txt": "committed\n"});
    fs.writeFileSync(path.join(repo, "predirty.txt"), "dirty before the run\n");
    const runDir = path.join(root, "run-t42-predirty");
    fs.mkdirSync(runDir, {recursive: true});
    const guard = createGitMutationGuard(runDir, repo);
    writeGuardBeforeSnapshot(guard.scopeFile, repo);
    const env = shieldedEnv(guard);
    const before = readGuardLog(guard.logFile).length;
    const r1 = git(repo, ["checkout", "--", "predirty.txt"], env);
    const entries1 = lastEntries(guard, before);
    check("G. pre-dirty file untouched by the role counts as foreign (denied)",
      r1.status === 97 && WORKTREE_RE.test(combined(r1))
        && entries1.some((e) => e && e.reason === "worktree-restore"),
      {status: r1.status, out: combined(r1).slice(0, 120)});
    fs.appendFileSync(path.join(repo, "predirty.txt"), "touched by the role\n");
    const r2 = git(repo, ["checkout", "--", "predirty.txt"], env);
    check("G. re-touched file restore is allowed once the role modifies it",
      r2.status === 0 && !WORKTREE_RE.test(combined(r2)),
      {status: r2.status, out: combined(r2).slice(0, 120)});
  }

  // H. No snapshot file denies fail-closed.
  {
    const repo = makeGuardRepo("t42-nosnap", {"dirty.txt": "committed\n"});
    fs.writeFileSync(path.join(repo, "dirty.txt"), "role edit, no snapshot\n");
    const runDir = path.join(root, "run-t42-nosnap");
    fs.mkdirSync(runDir, {recursive: true});
    const guard = createGitMutationGuard(runDir, repo);
    const env = shieldedEnv(guard);
    const before = readGuardLog(guard.logFile).length;
    const r = git(repo, ["restore", "dirty.txt"], env);
    const entries = lastEntries(guard, before);
    check("H. restore with no before-snapshot is denied fail-closed",
      r.status === 97 && WORKTREE_RE.test(combined(r))
        && entries.some((e) => e && e.reason === "worktree-restore"),
      {status: r.status, out: combined(r).slice(0, 120)});
    check("H. dirtied file stays dirty after the fail-closed denial",
      fs.readFileSync(path.join(repo, "dirty.txt"), "utf8") === "role edit, no snapshot\n");
  }
}

// =====================================================================
// I. Static wiring checks: the orchestrator writes the per-run snapshot
//    the wrapper reads, and the relay verdict surfaces the guard event.
//    Runs on every platform (no shim dispatch needed). CRLF-tolerant by
//    construction (regex/includes matching, never literal newline bytes).
// =====================================================================
{
  const hereI = path.dirname(fileURLToPath(import.meta.url));
  const autopilotSource = fs.readFileSync(path.join(hereI, "autopilot.mjs"), "utf8");
  const guardsSource = fs.readFileSync(path.join(hereI, "relay-guards.mjs"), "utf8");
  check(
    "I. runRelay imports writeGuardBeforeSnapshot from the guard module",
    /import\s*\{[^}]*\bwriteGuardBeforeSnapshot\b[^}]*\}\s*from\s*["']\.\/relay-guards\.mjs["']/.test(autopilotSource)
  );
  check(
    "I. runRelay records the before-snapshot against the guard root",
    /writeGuardBeforeSnapshot\s*\(\s*guard\.scopeFile\s*,\s*effectiveCwd\s*\)/.test(autopilotSource)
  );
  check(
    "I. snapshot failure fails the relay call closed",
    autopilotSource.includes("failed to record the git guard before-snapshot")
  );
  const appendIdx = autopilotSource.indexOf("appendGuardScopeRoot(guard.scopeFile,");
  const snapIdx = autopilotSource.indexOf("writeGuardBeforeSnapshot(guard.scopeFile,");
  const gitSnapIdx = autopilotSource.indexOf("collectSnapshotGuards(cwd)");
  check(
    "I. snapshot sits after the scope append and before launch snapshots (fail closed before spawn)",
    appendIdx !== -1 && snapIdx > appendIdx && gitSnapIdx > snapIdx,
    {appendIdx, snapIdx, gitSnapIdx}
  );
  check(
    "I. wrapper embeds the snapshot verdict helpers",
    guardsSource.includes("guardBeforeSnapshotAllows")
      && guardsSource.includes("extractRestorePathspecs")
      && guardsSource.includes("isBroadRestorePathspec")
      && guardsSource.includes("snapshotAllowsRestore")
  );
  check(
    "I. relay verdict surfaces guard denials as a policy observation",
    guardsSource.includes("export function classifyGitBlocks") && guardsSource.includes('"git_mutation_blocked"') && /makeRelayResult[\s\S]*?classifyGitBlocks\(/.test(autopilotSource)
  );
}

// =====================================================================
console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
try { fs.rmSync(root, {recursive: true, force: true}); } catch { /* best effort */ }
if (failed) process.exit(1);
