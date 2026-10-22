#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {createReviewerWorkspace, disposableCopyArgs, __testables} from './reviewer-workspace.mjs';

let failures = 0;
function check(name, condition, detail) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.log(`ok: ${name}`);
  }
}
async function expectRejects(name, fn) {
  try {
    await fn();
    check(name, false, 'expected a throw/rejection but none occurred');
    return null;
  } catch (error) {
    check(name, true);
    return error;
  }
}
function expectThrowSync(name, fn) {
  try {
    fn();
    check(name, false, 'expected a throw but none occurred');
    return null;
  } catch (error) {
    check(name, true);
    return error;
  }
}

// ---------------------------------------------------------------------
// Fixture helpers — real, disposable Git repositories only. Never
// my-app, never anything outside a freshly created temp directory.
// ---------------------------------------------------------------------

const fixtureRoots = [];
function mkFixtureDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtureRoots.push(dir);
  return dir;
}

// Requirement G: never scan the whole global os.tmpdir() for leaks. Each
// test that needs a leak check gets its own dedicated, empty, test-owned
// temp parent, passed as `tempParentDir` — so a leak check only ever
// inspects a directory nothing else on the machine could be using.
function mkOwnedTempParent() {
  return mkFixtureDir('autopilot-reviewer-parent-');
}
function assertNoLeakIn(ownedTempParent) {
  return fs.readdirSync(ownedTempParent).length === 0;
}

function runGit(args, cwd) {
  const r = spawnSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false});
  if (r.error) throw new Error(`git ${args.join(' ')} failed to spawn in ${cwd}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} exited ${r.status} in ${cwd}: ${r.stderr}`);
  return r.stdout;
}

function initFixtureRepo() {
  const dir = mkFixtureDir('autopilot-reviewer-fixture-');
  runGit(['init', '--quiet'], dir);
  runGit(['config', 'user.email', 'reviewer-workspace-test@example.com'], dir);
  runGit(['config', 'user.name', 'Reviewer Workspace Test'], dir);
  runGit(['config', 'commit.gpgsign', 'false'], dir);
  return dir;
}

function writeFileIn(repoDir, relPath, content) {
  const full = path.join(repoDir, relPath);
  fs.mkdirSync(path.dirname(full), {recursive: true});
  fs.writeFileSync(full, content);
  return full;
}

function commitAll(repoDir, message) {
  runGit(['add', '-A'], repoDir);
  runGit(['commit', '--quiet', '-m', message], repoDir);
}

// Recursively hashes every regular-file byte and records every symlink's
// raw (unresolved) target, so a snapshot captures both content and link
// structure without ever dereferencing an external link.
function snapshotTree(root) {
  const entries = new Map();
  const walk = dir => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        entries.set(rel, `symlink:${fs.readlinkSync(full)}`);
      } else if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile()) {
        entries.set(rel, `file:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
      } else {
        entries.set(rel, `other:${stat.mode}`);
      }
    }
  };
  walk(root);
  return entries;
}

function snapshotsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}

function isWithinPath(root, candidate) {
  const normalize = p => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const r = normalize(root);
  const c = normalize(candidate);
  return c === r || c.startsWith(r + path.sep);
}

function canCreateSymlinks() {
  const dir = mkFixtureDir('autopilot-reviewer-symlink-probe-');
  const target = path.join(dir, 'target.txt');
  const link = path.join(dir, 'link.txt');
  fs.writeFileSync(target, 'probe');
  try {
    fs.symlinkSync(target, link, 'file');
    return true;
  } catch {
    return false;
  }
}

function tryMkfifo(fifoPath) {
  const r = spawnSync('mkfifo', [fifoPath], {stdio: 'ignore'});
  return !r.error && r.status === 0;
}

// A minimal EventEmitter-based fake child_process.ChildProcess, used to
// inject deterministic subprocess lifecycle sequences (process-boundary
// injection via `spawnFn` — never fake-success logic added to
// production) that would be difficult or impossible to reproduce
// reliably with a real subprocess: truncated output, out-of-order
// exit/close events, etc.
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

const symlinksSupported = canCreateSymlinks();
// Plain directory junctions do not require Developer Mode / admin on
// Windows (unlike symlinks) — this is the mechanism the confirmed
// vulnerability used, and it is expected to always succeed there.
const junctionsSupported = process.platform === 'win32';

// ===========================================================================
// 1 + 2. Workspace/scratch live outside the repo; clean tracked files are
// copied byte-for-byte.
// ===========================================================================
{
  const repo = initFixtureRepo();
  const tempParent = mkOwnedTempParent();
  writeFileIn(repo, 'README.md', 'hello world\n');
  writeFileIn(repo, 'src/index.js', 'console.log("hi");\n');
  commitAll(repo, 'initial');

  const ws = await createReviewerWorkspace({repository: repo, tempParentDir: tempParent});
  try {
    check('workspaceRoot is outside the official repository', !isWithinPath(repo, ws.workspaceRoot));
    check('reviewRepository is outside the official repository', !isWithinPath(repo, ws.reviewRepository));
    check('scratchDirectory is outside the official repository', !isWithinPath(repo, ws.scratchDirectory));
    check('reviewRepository is inside workspaceRoot', isWithinPath(ws.workspaceRoot, ws.reviewRepository));
    check('scratchDirectory is inside workspaceRoot', isWithinPath(ws.workspaceRoot, ws.scratchDirectory));

    const copiedReadme = fs.readFileSync(path.join(ws.reviewRepository, 'README.md'), 'utf8');
    const copiedSrc = fs.readFileSync(path.join(ws.reviewRepository, 'src', 'index.js'), 'utf8');
    check('clean tracked file README.md copied byte-for-byte', copiedReadme === 'hello world\n');
    check('clean tracked file src/index.js copied byte-for-byte', copiedSrc === 'console.log("hi");\n');
  } finally {
    ws.cleanup();
  }
  check('cleanup removed the workspace', !fs.existsSync(ws.workspaceRoot));
  check('no reviewer-workspace temp directory is leaked in the owned parent', assertNoLeakIn(tempParent));
}

// ===========================================================================
// 3. Modified tracked files use current working-tree bytes.
// ===========================================================================
{
  const repo = initFixtureRepo();
  const tempParent = mkOwnedTempParent();
  writeFileIn(repo, 'notes.txt', 'committed version\n');
  commitAll(repo, 'initial');
  writeFileIn(repo, 'notes.txt', 'uncommitted edit\n');

  const ws = await createReviewerWorkspace({repository: repo, tempParentDir: tempParent});
  try {
    const copied = fs.readFileSync(path.join(ws.reviewRepository, 'notes.txt'), 'utf8');
    check('modified tracked file reflects current working-tree bytes', copied === 'uncommitted edit\n');
  } finally {
    ws.cleanup();
  }
}

// ===========================================================================
// 4. Untracked non-ignored files are copied.
// ===========================================================================
{
  const repo = initFixtureRepo();
  const tempParent = mkOwnedTempParent();
  writeFileIn(repo, 'tracked.txt', 'tracked\n');
  commitAll(repo, 'initial');
  writeFileIn(repo, 'scratch-note.txt', 'never added to git\n');

  const ws = await createReviewerWorkspace({repository: repo, tempParentDir: tempParent});
  try {
    const copied = fs.readFileSync(path.join(ws.reviewRepository, 'scratch-note.txt'), 'utf8');
    check('untracked non-ignored file is copied', copied === 'never added to git\n');
  } finally {
    ws.cleanup();
  }
}

// ===========================================================================
// 5. Deleted tracked files stay absent.
// ===========================================================================
{
  const repo = initFixtureRepo();
  const tempParent = mkOwnedTempParent();
  writeFileIn(repo, 'keep.txt', 'keep\n');
  writeFileIn(repo, 'doomed.txt', 'about to be deleted\n');
  commitAll(repo, 'initial');
  fs.unlinkSync(path.join(repo, 'doomed.txt')); // deleted from working tree, not staged

  const ws = await createReviewerWorkspace({repository: repo, tempParentDir: tempParent});
  try {
    check('surviving tracked file is still present', fs.existsSync(path.join(ws.reviewRepository, 'keep.txt')));
    check('deleted tracked file stays absent from the copy', !fs.existsSync(path.join(ws.reviewRepository, 'doomed.txt')));
  } finally {
    ws.cleanup();
  }
}

// ===========================================================================
// 6. Ignored files (including .env) are not copied.
// ===========================================================================
{
  const repo = initFixtureRepo();
  const tempParent = mkOwnedTempParent();
  writeFileIn(repo, '.gitignore', 'ignored.txt\n.env\nbuild/\n');
  writeFileIn(repo, 'tracked.txt', 'tracked\n');
  commitAll(repo, 'initial');
  writeFileIn(repo, 'ignored.txt', 'should never be copied\n');
  writeFileIn(repo, '.env', 'SECRET=should-never-be-copied\n');
  writeFileIn(repo, 'build/output.bin', 'should never be copied\n');

  const ws = await createReviewerWorkspace({repository: repo, tempParentDir: tempParent});
  try {
    check('.gitignore-matched file "ignored.txt" is excluded', !fs.existsSync(path.join(ws.reviewRepository, 'ignored.txt')));
    check('.env is excluded', !fs.existsSync(path.join(ws.reviewRepository, '.env')));
    check('ignored directory "build/" is excluded', !fs.existsSync(path.join(ws.reviewRepository, 'build')));
    check('tracked file alongside ignored ones is still copied', fs.existsSync(path.join(ws.reviewRepository, 'tracked.txt')));
  } finally {
    ws.cleanup();
  }
}

// ===========================================================================
// 7. .git is absent from the review copy.
// ===========================================================================
{
  const repo = initFixtureRepo();
  const tempParent = mkOwnedTempParent();
  writeFileIn(repo, 'a.txt', 'a\n');
  commitAll(repo, 'initial');

  const ws = await createReviewerWorkspace({repository: repo, tempParentDir: tempParent});
  try {
    check('.git is absent from the review copy', !fs.existsSync(path.join(ws.reviewRepository, '.git')));
  } finally {
    ws.cleanup();
  }
}

// ===========================================================================
// 8. Paths with spaces and Unicode work.
// ===========================================================================
{
  const repo = initFixtureRepo();
  const tempParent = mkOwnedTempParent();
  const trackedName = 'dir with spaces/日本語 ファイル.txt';
  const untrackedName = 'emoji 🎉 folder/notes 📝.md';
  writeFileIn(repo, trackedName, 'tracked unicode content\n');
  commitAll(repo, 'initial');
  writeFileIn(repo, untrackedName, 'untracked unicode content\n');

  const ws = await createReviewerWorkspace({repository: repo, tempParentDir: tempParent});
  try {
    const trackedCopy = fs.readFileSync(path.join(ws.reviewRepository, ...trackedName.split('/')), 'utf8');
    const untrackedCopy = fs.readFileSync(path.join(ws.reviewRepository, ...untrackedName.split('/')), 'utf8');
    check('tracked file with spaces/unicode in its path is copied correctly', trackedCopy === 'tracked unicode content\n');
    check('untracked file with spaces/unicode/emoji in its path is copied correctly', untrackedCopy === 'untracked unicode content\n');
  } finally {
    ws.cleanup();
  }
}

// ===========================================================================
// F. Newline filename regression (POSIX only — Windows/NTFS rejects
// control characters, including newline, in filenames at the Win32 API
// level; verified empirically, not a limitation of this module).
// ===========================================================================
if (process.platform !== 'win32') {
  const repo = initFixtureRepo();
  const tempParent = mkOwnedTempParent();
  const newlineName = 'line-one\nline-two.txt';
  writeFileIn(repo, newlineName, 'newline filename content\n');
  commitAll(repo, 'initial');
  writeFileIn(repo, 'untracked-with\nnewline.txt', 'untracked newline filename content\n');

  const ws = await createReviewerWorkspace({repository: repo, tempParentDir: tempParent});
  try {
    const trackedCopy = fs.readFileSync(path.join(ws.reviewRepository, newlineName), 'utf8');
    const untrackedCopy = fs.readFileSync(path.join(ws.reviewRepository, 'untracked-with\nnewline.txt'), 'utf8');
    check('a tracked filename containing a real newline is parsed and copied correctly (NUL-delimited, not newline-delimited)', trackedCopy === 'newline filename content\n');
    check('an untracked filename containing a real newline is parsed and copied correctly', untrackedCopy === 'untracked newline filename content\n');
  } finally {
    ws.cleanup();
  }
} else {
  console.log('skip: newline-filename regression (NTFS/Win32 rejects control characters in filenames)');
}

// ===========================================================================
// 9. Mutating/deleting/adding files in the review copy cannot affect the
// official repository. Official repository unchanged overall.
// ===========================================================================
{
  const repo = initFixtureRepo();
  const tempParent = mkOwnedTempParent();
  writeFileIn(repo, 'mutate-me.txt', 'original content\n');
  writeFileIn(repo, 'delete-me.txt', 'will be deleted only in the copy\n');
  commitAll(repo, 'initial');

  const beforeSnapshot = snapshotTree(repo);
  const ws = await createReviewerWorkspace({repository: repo, tempParentDir: tempParent});
  try {
    fs.writeFileSync(path.join(ws.reviewRepository, 'mutate-me.txt'), 'mutated only in the copy\n');
    fs.unlinkSync(path.join(ws.reviewRepository, 'delete-me.txt'));
    fs.writeFileSync(path.join(ws.reviewRepository, 'added-only-in-copy.txt'), 'new file only in the copy\n');

    const officialContent = fs.readFileSync(path.join(repo, 'mutate-me.txt'), 'utf8');
    check('mutating a file in the review copy leaves the official repository file untouched', officialContent === 'original content\n');
    check('deleting a file in the review copy leaves the official repository file present', fs.existsSync(path.join(repo, 'delete-me.txt')));
    check('adding a file in the review copy does not create it in the official repository', !fs.existsSync(path.join(repo, 'added-only-in-copy.txt')));
  } finally {
    ws.cleanup();
  }
  const afterSnapshot = snapshotTree(repo);
  check('official repository (including .git) is byte-identical before/after the whole workflow', snapshotsEqual(beforeSnapshot, afterSnapshot));

  const status = runGit(['status', '--porcelain'], repo);
  check('git status on the official repository is clean after the whole workflow', status.trim() === '');
}

// ===========================================================================
// 10. Scratch writes succeed and do not appear in either repository.
// ===========================================================================
{
  const repo = initFixtureRepo();
  const tempParent = mkOwnedTempParent();
  writeFileIn(repo, 'a.txt', 'a\n');
  commitAll(repo, 'initial');

  const ws = await createReviewerWorkspace({repository: repo, tempParentDir: tempParent});
  try {
    const scratchFile = path.join(ws.scratchDirectory, 'artifact.log');
    fs.writeFileSync(scratchFile, 'scratch artifact\n');
    check('scratch write succeeds', fs.readFileSync(scratchFile, 'utf8') === 'scratch artifact\n');
    check('scratch artifact does not appear in the review repository copy', !fs.existsSync(path.join(ws.reviewRepository, 'artifact.log')));
    check('scratch artifact does not appear in the official repository', !fs.existsSync(path.join(repo, 'artifact.log')));
  } finally {
    ws.cleanup();
  }
}

// ===========================================================================
// 11. Two workspaces are isolated from each other.
// ===========================================================================
{
  const repo = initFixtureRepo();
  const tempParent = mkOwnedTempParent();
  writeFileIn(repo, 'shared.txt', 'shared original\n');
  commitAll(repo, 'initial');

  const wsA = await createReviewerWorkspace({repository: repo, tempParentDir: tempParent});
  const wsB = await createReviewerWorkspace({repository: repo, tempParentDir: tempParent});
  try {
    check('two workspaces get distinct workspace roots', wsA.workspaceRoot !== wsB.workspaceRoot);
    fs.writeFileSync(path.join(wsA.reviewRepository, 'shared.txt'), 'mutated in workspace A only\n');
    const bContent = fs.readFileSync(path.join(wsB.reviewRepository, 'shared.txt'), 'utf8');
    check('mutating workspace A does not affect workspace B', bContent === 'shared original\n');
  } finally {
    wsA.cleanup();
    wsB.cleanup();
  }
  check('cleaning up both workspaces leaves the owned parent empty', assertNoLeakIn(tempParent));
}

// ===========================================================================
// 12. Traversal / outside-repository paths fail closed.
// ===========================================================================
{
  const repo = initFixtureRepo();
  const tempParent = mkOwnedTempParent();
  writeFileIn(repo, 'a.txt', 'a\n');
  commitAll(repo, 'initial');

  // 12a. A workspace parent directory that is itself inside the official
  // repository must be rejected before anything is created — exercises
  // the real, full createReviewerWorkspace pipeline end to end.
  const insideParent = path.join(repo, 'not-a-valid-workspace-parent');
  fs.mkdirSync(insideParent, {recursive: true});
  const parentError = await expectRejects(
    'a workspace parent directory inside the official repository is rejected',
    () => createReviewerWorkspace({repository: repo, tempParentDir: insideParent})
  );
  check('the inside-repository parent rejection message is clear', Boolean(parentError) && /must not be inside the official repository/i.test(parentError.message));

  // 12b. Malformed Git output: an absolute path is rejected up front by
  // normalizeGitRelativePath, before any path.resolve/containment check.
  const absoluteCandidate = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd';
  const absoluteError = expectThrowSync(
    'a malformed absolute path from git ls-files output is rejected',
    () => __testables.normalizeGitRelativePath(absoluteCandidate)
  );
  check('the absolute-path rejection message is clear', Boolean(absoluteError) && /malformed git ls-files output/i.test(absoluteError.message));
  check('a legitimate relative path is accepted unchanged (modulo separators)', __testables.normalizeGitRelativePath('src/index.js') === path.join('src', 'index.js'));

  // 12c. A relative traversal path, once resolved against the repository
  // root, is rejected by the containment check exactly as it would be
  // inside copyEntry — same function, same guard, called directly.
  const traversalTarget = path.resolve(repo, '..', 'outside-secret.txt');
  check('a traversal path resolves outside the repository (sanity check)', !__testables.isWithin(repo, traversalTarget));
  const traversalError = expectThrowSync(
    'a traversal path that escapes the repository root is rejected by the containment guard',
    () => __testables.assertWithin(repo, traversalTarget, 'source file')
  );
  check('the traversal rejection message identifies the escape', Boolean(traversalError) && /escapes its allowed root/i.test(traversalError.message));

  // 12d. The same containment guard also protects the destination side.
  const destinationTraversalTarget = path.resolve(path.join(repo, 'reviewRepo'), '..', 'outside-secret.txt');
  check('a traversal path also resolves outside an arbitrary destination root', !__testables.isWithin(path.join(repo, 'reviewRepo'), destinationTraversalTarget));
}

// ===========================================================================
// A + B. Ancestor junction/symlink protection — the confirmed critical
// vulnerability. `git ls-files` follows a directory junction/symlink and
// reports a path like "external-junction/external-secret.txt"; naive
// per-leaf lstat only inspects the final component and sees an ordinary
// file. This must be rejected by walking every ancestor path component.
// ===========================================================================
if (junctionsSupported) {
  // B. Real Native Windows junction regression — MUST run (not skip) on
  // Windows: this is the primary platform for this correction.
  const repo = initFixtureRepo();
  const tempParent = mkOwnedTempParent();
  writeFileIn(repo, 'tracked.txt', 'tracked\n');
  commitAll(repo, 'initial');

  const outsideDir = mkFixtureDir('autopilot-reviewer-junction-outside-');
  const markerContent = `junction-marker-${crypto.randomBytes(8).toString('hex')}`;
  fs.writeFileSync(path.join(outsideDir, 'external-secret.txt'), markerContent);

  const junctionPath = path.join(repo, 'external-junction');
  fs.symlinkSync(outsideDir, junctionPath, 'junction');

  // Confirm real `git ls-files` actually follows the junction and
  // reports the path through it — proving this test reproduces the real,
  // confirmed vulnerability rather than a hypothetical.
  const listedPaths = runGit(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], repo).split('\0').filter(Boolean);
  check('git ls-files follows the junction and reports the external path through it (confirms the real vulnerability is reproduced)', listedPaths.includes('external-junction/external-secret.txt'));

  const beforeRepoSnapshot = snapshotTree(repo);
  const beforeOutsideSnapshot = snapshotTree(outsideDir);

  const error = await expectRejects(
    'createReviewerWorkspace rejects a path reached through an ancestor junction (real Windows junction regression)',
    () => createReviewerWorkspace({repository: repo, tempParentDir: tempParent})
  );
  check('the ancestor-junction rejection message identifies the cause', Boolean(error) && /ancestor path component .* is a symlink\/junction\/reparse point/i.test(error.message));

  check('no partial reviewer workspace remains after the rejected junction attempt', assertNoLeakIn(tempParent));

  const afterRepoSnapshot = snapshotTree(repo);
  const afterOutsideSnapshot = snapshotTree(outsideDir);
  check('the official repository is unchanged after the rejected junction attempt', snapshotsEqual(beforeRepoSnapshot, afterRepoSnapshot));
  check('the external directory is unchanged after the rejected junction attempt', snapshotsEqual(beforeOutsideSnapshot, afterOutsideSnapshot));
} else {
  console.log('skip: real Windows junction regression (not running on win32)');
}

if (process.platform !== 'win32' && symlinksSupported) {
  // Equivalent WSL/POSIX coverage. Note: real git's untracked-file walk
  // behaves differently by platform for a *fresh* directory symlink — on
  // Windows, `git ls-files --others` follows a junction and reports the
  // nested path through it (the scenario above); on Linux, `git
  // ls-files --others` reports a fresh directory symlink as a single
  // leaf entry (already covered by the "external leaf-symlink
  // protection" test below) and does NOT descend into it. Empirically
  // confirmed the real POSIX-equivalent reproduction of the *same*
  // ancestor hazard instead: a directory that was tracked, then later
  // replaced on disk by a symlink to an external directory — git's
  // index still has the old nested path, so `git ls-files --cached`
  // reports it (e.g. "real-dir/file.txt") even though "real-dir" is now
  // a symlink pointing outside the repository. This is a real, reachable
  // scenario (a local workflow mistake, or tampering between commits),
  // not a synthetic one.
  const repo = initFixtureRepo();
  const tempParent = mkOwnedTempParent();
  writeFileIn(repo, 'tracked.txt', 'tracked\n');
  writeFileIn(repo, 'real-dir/file.txt', 'originally tracked content\n');
  commitAll(repo, 'initial');

  fs.rmSync(path.join(repo, 'real-dir'), {recursive: true, force: true});
  const outsideDir = mkFixtureDir('autopilot-reviewer-symlink-outside-');
  const markerContent = `symlink-marker-${crypto.randomBytes(8).toString('hex')}`;
  fs.writeFileSync(path.join(outsideDir, 'file.txt'), markerContent);
  fs.symlinkSync(outsideDir, path.join(repo, 'real-dir')); // directory symlink replacing the once-tracked dir

  const listedPaths = runGit(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], repo).split('\0').filter(Boolean);
  check('git ls-files still reports the stale tracked nested path through the now-substituted directory symlink (confirms the real POSIX ancestor hazard is reproduced)', listedPaths.includes('real-dir/file.txt'));

  const beforeRepoSnapshot = snapshotTree(repo);
  const beforeOutsideSnapshot = snapshotTree(outsideDir);

  const error = await expectRejects(
    'createReviewerWorkspace rejects a path reached through an ancestor directory symlink (WSL regression)',
    () => createReviewerWorkspace({repository: repo, tempParentDir: tempParent})
  );
  // git lists both the bare "real-dir" leaf entry (the symlink itself,
  // via --others) and the stale "real-dir/file.txt" nested entry (via
  // --cached) — whichever is processed first correctly fails the whole
  // operation closed, via whichever guard applies to it: the leaf-symlink
  // guard for "real-dir" itself (an external-target symlink), or the
  // ancestor-walk guard for "real-dir/file.txt". Both are the correct,
  // intended rejection; only the specific message differs by ordering.
  check(
    'the rejection identifies either the ancestor-link or the external-leaf-symlink cause (both are correct for this fixture)',
    Boolean(error) && (/ancestor path component .* is a symlink\/junction\/reparse point/i.test(error.message) || /outside the official repository/i.test(error.message))
  );
  check('no partial reviewer workspace remains after the rejected ancestor-symlink attempt', assertNoLeakIn(tempParent));

  const afterRepoSnapshot = snapshotTree(repo);
  const afterOutsideSnapshot = snapshotTree(outsideDir);
  check('the official repository is unchanged after the rejected ancestor-symlink attempt', snapshotsEqual(beforeRepoSnapshot, afterRepoSnapshot));
  check('the external directory is unchanged after the rejected ancestor-symlink attempt', snapshotsEqual(beforeOutsideSnapshot, afterOutsideSnapshot));

  // Direct unit-level confirmation of the same guard, for good measure
  // (deterministic, independent of git's platform-specific listing
  // behavior): a real symlink whose ancestor segment is "real-dir".
  const ancestorError = expectThrowSync(
    '(direct) assertNoLinkedAncestors rejects a real ancestor directory symlink',
    () => __testables.assertNoLinkedAncestors(repo, path.join('real-dir', 'file.txt'))
  );
  check('the direct ancestor-walk rejection message identifies the linked ancestor', Boolean(ancestorError) && /is a symlink\/junction\/reparse point/i.test(ancestorError.message));
} else if (process.platform !== 'win32') {
  console.log('skip: WSL directory-link ancestor regression (this platform cannot create symlinks)');
}

// ===========================================================================
// 13. Leaf symlink protection (existing coverage, retained): an external
// leaf-symlink target is never read/copied; an in-repository leaf
// symlink is preserved, rewritten into the disposable copy.
// ===========================================================================
if (symlinksSupported) {
  const repo = initFixtureRepo();
  const tempParent = mkOwnedTempParent();
  writeFileIn(repo, 'a.txt', 'a\n');
  commitAll(repo, 'initial');

  const outsideDir = mkFixtureDir('autopilot-reviewer-outside-');
  const secretPath = path.join(outsideDir, 'secret.txt');
  const secretMarker = `top-secret-${crypto.randomBytes(8).toString('hex')}`;
  fs.writeFileSync(secretPath, secretMarker);

  const linkPath = path.join(repo, 'escape-link.txt');
  fs.symlinkSync(secretPath, linkPath, 'file'); // untracked, non-ignored

  const error = await expectRejects(
    'a leaf symlink resolving outside the official repository is rejected',
    () => createReviewerWorkspace({repository: repo, tempParentDir: tempParent})
  );
  check('the external-leaf-link rejection message identifies the cause', Boolean(error) && /outside the official repository/i.test(error.message));
  check('a failed (external leaf symlink) creation leaks no workspace directory', assertNoLeakIn(tempParent));
} else {
  console.log('skip: external leaf-symlink protection (this platform cannot create symlinks — Windows without Developer Mode/admin)');
}

if (symlinksSupported) {
  const repo = initFixtureRepo();
  const tempParent = mkOwnedTempParent();
  writeFileIn(repo, 'real/target.txt', 'link target content\n');
  commitAll(repo, 'initial');
  fs.symlinkSync(path.join('real', 'target.txt'), path.join(repo, 'alias.txt'));

  const ws = await createReviewerWorkspace({repository: repo, tempParentDir: tempParent});
  try {
    const linkCopyPath = path.join(ws.reviewRepository, 'alias.txt');
    const linkStat = fs.lstatSync(linkCopyPath);
    check('an in-repository leaf symlink is preserved as a symlink in the copy', linkStat.isSymbolicLink());
    const resolvedTarget = fs.realpathSync(linkCopyPath);
    check('the preserved symlink resolves inside the review copy, not the official repository', isWithinPath(ws.reviewRepository, resolvedTarget) && !isWithinPath(repo, resolvedTarget));
    check('reading through the preserved symlink returns the correct content', fs.readFileSync(linkCopyPath, 'utf8') === 'link target content\n');

    fs.writeFileSync(linkCopyPath, 'written through the link, in the copy\n');
    check('the official repository target is unaffected by a write through the copy‘s link', fs.readFileSync(path.join(repo, 'real', 'target.txt'), 'utf8') === 'link target content\n');
  } finally {
    ws.cleanup();
  }
} else {
  console.log('skip: in-repository leaf-symlink preservation (this platform cannot create symlinks)');
}

// ===========================================================================
// 14. Unsupported special files fail closed where the platform permits
// creating the fixture. `git` itself already excludes FIFOs from
// `ls-files --others` output (confirmed empirically), so the module's
// own classification helper is exercised directly against a real FIFO's
// lstat() result to prove the guard is real, alongside the real
// end-to-end proof that the FIFO never ends up in the copy either way.
// ===========================================================================
if (process.platform !== 'win32') {
  const repo = initFixtureRepo();
  const tempParent = mkOwnedTempParent();
  writeFileIn(repo, 'a.txt', 'a\n');
  commitAll(repo, 'initial');
  const fifoPath = path.join(repo, 'weird.fifo');
  if (tryMkfifo(fifoPath)) {
    const fifoStat = fs.lstatSync(fifoPath);
    check('a FIFO is correctly classified as an unsupported filesystem entry', __testables.isSupportedFsEntry(fifoStat) === false);
    check('a regular file is correctly classified as a supported filesystem entry', __testables.isSupportedFsEntry(fs.lstatSync(path.join(repo, 'a.txt'))) === true);

    const ws = await createReviewerWorkspace({repository: repo, tempParentDir: tempParent});
    try {
      check('end to end, an untracked FIFO never ends up in the review copy', !fs.existsSync(path.join(ws.reviewRepository, 'weird.fifo')));
    } finally {
      ws.cleanup();
    }
  } else {
    console.log('skip: unsupported special file rejection (mkfifo unavailable in this environment)');
  }
} else {
  console.log('skip: unsupported special file rejection (no FIFO fixture support on native Windows)');
}

// ===========================================================================
// C. Explicit Git-metadata-path rejection.
// ===========================================================================
{
  check(
    'a root ".git" path segment is rejected',
    Boolean(expectThrowSync('(internal) root .git segment throws', () => __testables.normalizeGitRelativePath('.git/config')))
  );
  check(
    'a nested ".git" path segment is rejected',
    Boolean(expectThrowSync('(internal) nested .git segment throws', () => __testables.normalizeGitRelativePath('sub/dir/.git/HEAD')))
  );
  if (process.platform === 'win32') {
    check(
      'a differently-cased ".GIT" segment is rejected on Windows (case-insensitive)',
      Boolean(expectThrowSync('(internal) case-insensitive .git segment throws', () => __testables.normalizeGitRelativePath('sub/.GIT/config')))
    );
  }
  check('.gitignore remains a valid, non-rejected path', __testables.normalizeGitRelativePath('.gitignore') === '.gitignore');
  check('.gitmodules remains a valid, non-rejected path', __testables.normalizeGitRelativePath('.gitmodules') === '.gitmodules');
  check('a nested file named .gitkeep remains valid', __testables.normalizeGitRelativePath('sub/.gitkeep') === path.join('sub', '.gitkeep'));
  check('the standalone segment classifier agrees: ".git" is a metadata segment', __testables.isGitMetadataSegment('.git') === true);
  check('the standalone segment classifier agrees: ".gitignore" is not a metadata segment', __testables.isGitMetadataSegment('.gitignore') === false);
}

// ===========================================================================
// D. Hard Git subprocess deadline: a real, genuinely SIGTERM-resistant
// child process proves the deadline is actually enforced end to end via
// process-boundary injection of `spawnFn` (never fake-success logic).
// ===========================================================================
{
  const repo = initFixtureRepo();
  const tempParent = mkOwnedTempParent();
  writeFileIn(repo, 'a.txt', 'a\n');
  commitAll(repo, 'initial');

  const ignoreSigtermScript = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
  let capturedPid = null;
  let spawnCallCount = 0;
  const start = Date.now();
  const error = await expectRejects(
    'a real SIGTERM-ignoring git process is terminated and the operation rejects with a timeout',
    () => createReviewerWorkspace({
      repository: repo,
      tempParentDir: tempParent,
      gitTimeoutMs: 400,
      gitKillGraceMs: 200,
      spawnFn: (bin, args, opts) => {
        spawnCallCount += 1;
        const child = spawn(process.execPath, ['-e', ignoreSigtermScript], opts);
        capturedPid = child.pid;
        return child;
      }
    })
  );
  const elapsed = Date.now() - start;
  check('the SIGTERM-resistant git process rejection resolves within a generous bound', elapsed < 8000);
  check('the SIGTERM-resistant git process rejection message mentions a timeout', Boolean(error) && /timed out/i.test(error.message));
  check('exactly one git subprocess was spawned for this attempt', spawnCallCount === 1);
  check('no partial reviewer workspace remains after the timed-out attempt', assertNoLeakIn(tempParent));

  await new Promise(r => setTimeout(r, 300));
  let stillRunning = true;
  try {
    process.kill(capturedPid, 0);
  } catch {
    stillRunning = false;
  }
  check('the SIGTERM-resistant git process is not leaked (terminated via SIGKILL escalation)', stillRunning === false);
}

// ===========================================================================
// E. Malformed NUL-delimited output validation.
// ===========================================================================
{
  check(
    'a properly NUL-terminated buffer splits into the correct entries',
    JSON.stringify(__testables.splitNulDelimited(Buffer.from('a.txt\0b.txt\0', 'utf8'))) === JSON.stringify(['a.txt', 'b.txt'])
  );
  check('an empty buffer (no files) splits into an empty list without throwing', __testables.splitNulDelimited(Buffer.alloc(0)).length === 0);
  const truncatedError = expectThrowSync(
    'a buffer missing its trailing NUL terminator is rejected (not silently accepted)',
    () => __testables.splitNulDelimited(Buffer.from('a.txt\0b.txt-no-trailing-nul', 'utf8'))
  );
  check('the malformed-output rejection message is clear', Boolean(truncatedError) && /trailing bytes without a NUL terminator/i.test(truncatedError.message));

  // End-to-end: a fake `spawnFn` (process-boundary injection, not
  // fake-success logic) returns a minimal EventEmitter-based child that
  // emits truncated stdout, proving the whole pipeline rejects it rather
  // than only the isolated splitter function.
  const repo = initFixtureRepo();
  const tempParent = mkOwnedTempParent();
  writeFileIn(repo, 'a.txt', 'a\n');
  commitAll(repo, 'initial');
  const malformedError = await expectRejects(
    'end to end, malformed (non-NUL-terminated) git output is rejected rather than partially processed',
    () => createReviewerWorkspace({
      repository: repo,
      tempParentDir: tempParent,
      spawnFn: () => {
        const child = fakeChild();
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from('a.txt\0malformed-trailing-bytes-no-nul', 'utf8'));
          child.emit('close', 0, null);
        });
        return child;
      }
    })
  );
  check('the end-to-end malformed-output rejection message is clear', Boolean(malformedError) && /trailing bytes without a NUL terminator/i.test(malformedError.message));
  check('no partial reviewer workspace remains after the malformed-output rejection', assertNoLeakIn(tempParent));
}

// ===========================================================================
// Correction 2, part A. stdout completion ordering: a child process may
// emit "exit" before its stdout stream has finished delivering every
// buffered "data" event. Reproduces the exact confirmed defect via the
// real createReviewerWorkspace() path with an injected child handle:
//   1. stdout emits "a.txt\0"
//   2. child emits exit(0)
//   3. stdout (later) emits "b.txt\0"
//   4. child emits close(0)
// Before the fix, this returned successfully having copied only a.txt.
// ===========================================================================
{
  const repo = initFixtureRepo();
  const tempParent = mkOwnedTempParent();
  writeFileIn(repo, 'a.txt', 'A content\n');
  writeFileIn(repo, 'b.txt', 'B content\n');
  commitAll(repo, 'initial');

  let settleCount = 0;
  const trackSettle = promise => promise.then(
    value => { settleCount += 1; return value; },
    error => { settleCount += 1; throw error; }
  );

  const ws = await trackSettle(createReviewerWorkspace({
    repository: repo,
    tempParentDir: tempParent,
    spawnFn: () => {
      const child = fakeChild();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('a.txt\0', 'utf8'));
        child.emit('exit', 0, null); // exit fires first — must NOT settle yet
        setTimeout(() => {
          child.stdout.emit('data', Buffer.from('b.txt\0', 'utf8')); // arrives after "exit"
          child.emit('close', 0, null); // only "close" may settle successfully
        }, 20);
      });
      return child;
    }
  }));

  try {
    check('a.txt (delivered before "exit") is present in the review copy', fs.existsSync(path.join(ws.reviewRepository, 'a.txt')));
    check('b.txt (delivered after "exit", before "close") is present in the review copy — not silently dropped', fs.existsSync(path.join(ws.reviewRepository, 'b.txt')));
    check('b.txt content is correct (proves it was actually copied, not just present as an empty stub)', fs.readFileSync(path.join(ws.reviewRepository, 'b.txt'), 'utf8') === 'B content\n');
    check('the workspace promise settled exactly once', settleCount === 1);
  } finally {
    ws.cleanup();
  }
  check('cleanup leaves no generated workspace behind', !fs.existsSync(ws.workspaceRoot));
  check('no reviewer-workspace temp directory is leaked in the owned parent', assertNoLeakIn(tempParent));
}

// ===========================================================================
// Correction 2, part B. Invalid UTF-8 filename bytes must fail closed,
// never silently decode to replacement characters and then vanish
// (a path that no longer matches the real on-disk name simply fails to
// lstat and gets treated as "deleted, stays absent" — silently hiding a
// real reviewable file from the reviewer).
// ===========================================================================
{
  // Direct unit-level check: splitNulDelimited must reject invalid UTF-8
  // rather than substituting U+FFFD.
  const invalidUtf8Buffer = Buffer.concat([Buffer.from('bad-'), Buffer.from([0xFF]), Buffer.from('-name.txt\0')]);
  const invalidUtf8Error = expectThrowSync(
    '(internal) splitNulDelimited rejects invalid UTF-8 bytes rather than substituting replacement characters',
    () => __testables.splitNulDelimited(invalidUtf8Buffer)
  );
  check('the invalid-UTF-8 rejection message is clear', Boolean(invalidUtf8Error) && /invalid utf-8/i.test(invalidUtf8Error.message));

  if (process.platform !== 'win32') {
    // Real WSL/Linux regression: Win32 filenames don't provide the same
    // raw-byte behavior (NTFS filenames are UTF-16, not arbitrary bytes),
    // so this only runs on POSIX, where a filename really can contain an
    // invalid UTF-8 byte on disk.
    const repo = initFixtureRepo();
    const tempParent = mkOwnedTempParent();
    writeFileIn(repo, 'tracked.txt', 'tracked\n');
    commitAll(repo, 'initial');

    const secretMarker = `invalid-utf8-marker-${crypto.randomBytes(8).toString('hex')}`;
    const nameBuf = Buffer.concat([Buffer.from('bad-'), Buffer.from([0xFF]), Buffer.from('-name.txt')]);
    const fullPathBuf = Buffer.concat([Buffer.from(repo + path.sep), nameBuf]);
    fs.writeFileSync(fullPathBuf, secretMarker);
    runGit(['add', '-A'], repo);

    const listedRaw = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {cwd: repo, encoding: 'buffer'}).stdout;
    check('git ls-files really emits the raw invalid UTF-8 byte untouched (confirms the real regression is reproduced)', listedRaw.includes(0xff));

    const error = await expectRejects(
      'createReviewerWorkspace rejects a real filename containing an invalid UTF-8 byte',
      () => createReviewerWorkspace({repository: repo, tempParentDir: tempParent})
    );
    check('the real invalid-UTF-8 rejection message is clear', Boolean(error) && /invalid utf-8/i.test(error.message));
    check('no partial reviewer workspace remains after the invalid-UTF-8 rejection', assertNoLeakIn(tempParent));

    // The failure must be a hard rejection, not a successful-but-
    // incomplete workspace silently missing the bad file.
    check('createReviewerWorkspace did not return a successful (incomplete) workspace', error !== null);
  } else {
    console.log('skip: real invalid-UTF-8 filename regression (Win32 filenames are UTF-16, not arbitrary bytes)');
  }
}

// ===========================================================================
// H. Cleanup hardening: substitution protection.
// ===========================================================================
if (symlinksSupported || junctionsSupported) {
  // H-child: the reviewRepository child directory is deleted and replaced
  // with a link toward the official repository. Cleanup must never
  // traverse that substituted link into deleting official files.
  const repo = initFixtureRepo();
  const tempParent = mkOwnedTempParent();
  writeFileIn(repo, 'official.txt', 'must survive cleanup\n');
  commitAll(repo, 'initial');

  const ws = await createReviewerWorkspace({repository: repo, tempParentDir: tempParent});
  fs.rmSync(ws.reviewRepository, {recursive: true, force: true});
  fs.symlinkSync(repo, ws.reviewRepository, process.platform === 'win32' ? 'junction' : 'dir');

  let cleanupThrew = false;
  try {
    ws.cleanup();
  } catch {
    cleanupThrew = true;
  }
  check('the official repository file survives cleanup after a child was substituted with a link to it', fs.existsSync(path.join(repo, 'official.txt')));
  check('the official repository content is unchanged after the substituted-child cleanup attempt', fs.readFileSync(path.join(repo, 'official.txt'), 'utf8') === 'must survive cleanup\n');
  console.log(`info: substituted-child cleanup ${cleanupThrew ? 'threw (also acceptable)' : 'completed without traversing the substituted link into official files'}`);

  // H-root: the workspaceRoot itself is deleted and replaced with a link
  // toward the official repository. Cleanup must refuse outright.
  const ws2 = await createReviewerWorkspace({repository: repo, tempParentDir: tempParent});
  const capturedRoot = ws2.workspaceRoot;
  fs.rmSync(capturedRoot, {recursive: true, force: true});
  fs.symlinkSync(repo, capturedRoot, process.platform === 'win32' ? 'junction' : 'dir');

  const rootSubstitutionError = expectThrowSync(
    'cleanup refuses to proceed when the workspace root itself has been substituted with a link',
    () => ws2.cleanup()
  );
  check('the root-substitution refusal message is clear', Boolean(rootSubstitutionError) && /replaced by a symlink\/junction/i.test(rootSubstitutionError.message));
  check('the official repository file survives cleanup after the workspace root was substituted with a link to it', fs.existsSync(path.join(repo, 'official.txt')));
  check('the official repository content is unchanged after the substituted-root cleanup attempt', fs.readFileSync(path.join(repo, 'official.txt'), 'utf8') === 'must survive cleanup\n');

  // Remove the substituted link ourselves (it is not the official repo,
  // just a link pointing at it) so it doesn't linger in the owned parent.
  fs.rmSync(capturedRoot, {recursive: true, force: true});
} else {
  console.log('skip: cleanup substitution protection (this platform can create neither symlinks nor junctions)');
}

// ===========================================================================
// 15 + 16. Cleanup removes only its generated workspace, and repeated
// cleanup is safe.
// ===========================================================================
{
  const repo = initFixtureRepo();
  const tempParent = mkOwnedTempParent();
  writeFileIn(repo, 'a.txt', 'a\n');
  commitAll(repo, 'initial');

  const ws = await createReviewerWorkspace({repository: repo, tempParentDir: tempParent});
  const workspaceRoot = ws.workspaceRoot;
  ws.cleanup();
  check('cleanup removes the generated workspace', !fs.existsSync(workspaceRoot));
  check('cleanup leaves the official repository directory intact', fs.existsSync(repo) && fs.existsSync(path.join(repo, 'a.txt')));
  let secondCleanupThrew = false;
  try {
    ws.cleanup();
  } catch {
    secondCleanupThrew = true;
  }
  check('repeated cleanup is safe (does not throw)', secondCleanupThrew === false);
  check('repeated cleanup does not resurrect or affect the official repository', fs.existsSync(repo) && fs.existsSync(path.join(repo, 'a.txt')));
  check('the owned temp parent is empty after cleanup', assertNoLeakIn(tempParent));
}

// ===========================================================================
// M. Mission-dir overlay: optional mission parameter copies
// .autopilot/missions/<mission>/ minus runs/, into workspace .autopilot/.
// ===========================================================================
{
  const repo = initFixtureRepo();
  const tempParent = mkOwnedTempParent();
  writeFileIn(repo, 'a.txt', 'a\n');
  commitAll(repo, 'initial');

  // Create a mission directory structure with multiple files and subdirectories
  const autopilotDir = path.join(repo, '.autopilot');
  const missionsDir = path.join(autopilotDir, 'missions');
  const missionDir = path.join(missionsDir, 'test-mission-001');
  fs.mkdirSync(missionDir, {recursive: true});

  writeFileIn(repo, path.join('.autopilot', 'missions', 'test-mission-001', 'PLAN.md'), 'test plan\n');
  writeFileIn(repo, path.join('.autopilot', 'missions', 'test-mission-001', 'TASKS.md'), 'test tasks\n');
  writeFileIn(repo, path.join('.autopilot', 'missions', 'test-mission-001', 'subdirectory', 'notes.txt'), 'nested notes\n');
  commitAll(repo, 'add mission');

  // Create runs/ directory (should not be copied)
  const runsDir = path.join(missionDir, 'runs');
  fs.mkdirSync(runsDir, {recursive: true});
  writeFileIn(repo, path.join('.autopilot', 'missions', 'test-mission-001', 'runs', 'run-001', 'result.json'), '{"status":"ok"}\n');

  // Create a sibling mission (should not be copied)
  writeFileIn(repo, path.join('.autopilot', 'missions', 'other-mission', 'OTHER.md'), 'other mission\n');

  const ws = await createReviewerWorkspace({repository: repo, tempParentDir: tempParent, mission: 'test-mission-001'});
  try {
    const missionInWs = path.join(ws.reviewRepository, '.autopilot', 'missions', 'test-mission-001');
    check('mission directory is present in workspace', fs.existsSync(missionInWs));
    check('mission PLAN.md is present in workspace', fs.existsSync(path.join(missionInWs, 'PLAN.md')));
    check('mission TASKS.md is present in workspace', fs.existsSync(path.join(missionInWs, 'TASKS.md')));
    check('mission subdirectory/notes.txt is present in workspace', fs.existsSync(path.join(missionInWs, 'subdirectory', 'notes.txt')));

    // Verify runs/ was excluded
    check('mission runs/ directory is NOT copied', !fs.existsSync(path.join(missionInWs, 'runs')));

    // Verify sibling missions were not copied
    const otherMissionInWs = path.join(ws.reviewRepository, '.autopilot', 'missions', 'other-mission');
    check('sibling missions are not copied to workspace', !fs.existsSync(otherMissionInWs));

    // Verify only the specified mission exists in .autopilot/missions
    const missionsInWs = path.join(ws.reviewRepository, '.autopilot', 'missions');
    const missionsListing = fs.readdirSync(missionsInWs);
    check('only the specified mission is in .autopilot/missions/', JSON.stringify(missionsListing) === JSON.stringify(['test-mission-001']));

    // Verify .autopilot/ has no other sibling content (gates, runs, etc)
    const autopilotInWs = path.join(ws.reviewRepository, '.autopilot');
    const autopilotListing = fs.readdirSync(autopilotInWs);
    check('workspace .autopilot/ contains only missions/', JSON.stringify(autopilotListing) === JSON.stringify(['missions']));

    const planContent = fs.readFileSync(path.join(missionInWs, 'PLAN.md'), 'utf8');
    check('mission file content is copied correctly', planContent === 'test plan\n');
  } finally {
    ws.cleanup();
  }
}

// ===========================================================================
// M-symlink. Mission-dir overlay: nested symlinks are correctly rewritten
// to point to the mission root, not a broken path in the nested subdirectory.
// ===========================================================================
if (symlinksSupported) {
  const repo = initFixtureRepo();
  const tempParent = mkOwnedTempParent();
  writeFileIn(repo, 'a.txt', 'a\n');
  commitAll(repo, 'initial');

  // Create a mission directory with a nested symlink
  writeFileIn(repo, path.join('.autopilot', 'missions', 'test-mission-nested-symlink', 'PLAN.md'), 'test plan\n');
  writeFileIn(repo, path.join('.autopilot', 'missions', 'test-mission-nested-symlink', 'sub', 'nested-notes.txt'), 'nested notes\n');
  const missionSourcePath = path.join(repo, '.autopilot', 'missions', 'test-mission-nested-symlink');

  // Create a nested symlink that points to PLAN.md at the mission root
  const nestedSymlinkPath = path.join(missionSourcePath, 'sub', 'link-to-plan.md');
  fs.symlinkSync(path.join('..', 'PLAN.md'), nestedSymlinkPath, 'file');

  commitAll(repo, 'add mission with nested symlink');

  const ws = await createReviewerWorkspace({repository: repo, tempParentDir: tempParent, mission: 'test-mission-nested-symlink'});
  try {
    const missionInWs = path.join(ws.reviewRepository, '.autopilot', 'missions', 'test-mission-nested-symlink');
    const copiedNestedSymlink = path.join(missionInWs, 'sub', 'link-to-plan.md');

    check('nested symlink is preserved as a symlink in workspace', fs.lstatSync(copiedNestedSymlink).isSymbolicLink());

    const resolvedTarget = fs.realpathSync(copiedNestedSymlink);
    const expectedTarget = path.join(missionInWs, 'PLAN.md');
    check(
      'nested symlink resolves to the correct mission-root location',
      normalizeForCompare(resolvedTarget) === normalizeForCompare(expectedTarget)
    );

    const content = fs.readFileSync(copiedNestedSymlink, 'utf8');
    check('reading through the nested symlink returns the correct content', content === 'test plan\n');
  } finally {
    ws.cleanup();
  }
} else {
  console.log('skip: nested-symlink mission-dir overlay (this platform cannot create symlinks)');
}

function normalizeForCompare(candidate) {
  const resolved = path.resolve(candidate);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// ===========================================================================
// N. Mission-dir overlay: missing mission directory is rejected.
// ===========================================================================
{
  const repo = initFixtureRepo();
  const tempParent = mkOwnedTempParent();
  writeFileIn(repo, 'a.txt', 'a\n');
  commitAll(repo, 'initial');

  const error = await expectRejects(
    'a missing mission directory is rejected',
    () => createReviewerWorkspace({repository: repo, tempParentDir: tempParent, mission: 'nonexistent-mission'})
  );
  check('the missing-mission rejection message is clear', Boolean(error) && /mission directory not found/i.test(error.message));
  check('no partial reviewer workspace remains after the missing-mission rejection', assertNoLeakIn(tempParent));
}

// ===========================================================================
// O. disposableCopyArgs helper: returns mission overlay args for standalone,
// rejects null mission on standalone, rejects any mission on non-standalone.
// ===========================================================================
{
  const testRepo = '/some/path';

  // Standalone with mission: returns the args
  const standaloneResult = disposableCopyArgs({framework: 'standalone', repository: testRepo, mission: 'test-mission'});
  check('disposableCopyArgs for standalone+mission returns {repository, mission}',
    standaloneResult && standaloneResult.repository === testRepo && standaloneResult.mission === 'test-mission');

  // Standalone with null/missing mission: throws
  const standaloneNullError = expectThrowSync(
    'disposableCopyArgs for standalone+null-mission throws',
    () => disposableCopyArgs({framework: 'standalone', repository: testRepo, mission: null})
  );
  check('the standalone+null-mission rejection message is clear', Boolean(standaloneNullError) && /null\/missing mission/i.test(standaloneNullError.message));

  // Speckit without mission: returns null (normal case)
  const speckitResult = disposableCopyArgs({framework: 'speckit', repository: testRepo, mission: null});
  check('disposableCopyArgs for speckit+null-mission returns null', speckitResult === null);

  // Non-standalone with mission: throws
  const speckitMissionError = expectThrowSync(
    'disposableCopyArgs for speckit+mission throws',
    () => disposableCopyArgs({framework: 'speckit', repository: testRepo, mission: 'test-mission'})
  );
  check('the speckit+mission rejection message is clear', Boolean(speckitMissionError) && /only available for standalone/i.test(speckitMissionError.message));

  // GSD with mission: throws
  const gsdMissionError = expectThrowSync(
    'disposableCopyArgs for gsd+mission throws',
    () => disposableCopyArgs({framework: 'gsd', repository: testRepo, mission: 'test-mission'})
  );
  check('the gsd+mission rejection message mentions gsd', Boolean(gsdMissionError) && /gsd/i.test(gsdMissionError.message));
}

// ===========================================================================
// Suite cleanup: remove every fixture repo/dir this test created.
// ===========================================================================
for (const dir of fixtureRoots) {
  try {
    fs.rmSync(dir, {recursive: true, force: true});
  } catch { /* best effort */ }
}

if (failures > 0) {
  console.error(`\n${failures} reviewer-workspace check(s) failed.`);
  process.exit(1);
}
console.log('\nAll reviewer-workspace checks passed.');
