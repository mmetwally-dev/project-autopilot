// Disposable reviewer-workspace primitive (task 15.2, corrected).
//
// Scope: this module only builds and tears down a throwaway, read-only-role
// copy of a repository's current working-tree state. It is NOT wired into
// Plan Reviewer, Code Reviewer, Verifier, `ap run`, setup, or runtime
// selection — that wiring is future work. Today this is a standalone
// primitive: `createReviewerWorkspace()` in, a workspace + `cleanup()` out.
//
// Why this exists: on Native Windows there is no bubblewrap-equivalent
// filesystem containment (see platform-capabilities.mjs). The eventual
// plan is for read-only roles to run against a disposable copy of the
// repository instead of the official one, so a role process that somehow
// writes outside its declared scratch directory can never touch the real
// repository. This module produces that disposable copy.
//
// Design constraints:
//  - Get the source file list from Git itself (`ls-files -z --cached
//    --others --exclude-standard`), never a raw directory walk — this is
//    what naturally excludes ignored files (node_modules, .env, build
//    output, .autopilot/runs, ...) and anything Git wouldn't consider
//    part of the reviewable working tree. `.git`/nested `.git` path
//    segments are additionally rejected explicitly (see
//    `rejectGitMetadataSegment`) — never trust that Git alone will keep
//    them out.
//  - Every file is copied as independent bytes (read + write a fresh
//    file) — never a hardlink, never `git worktree`, never a junction
//    back to the official repository.
//  - CRITICAL: `lstat` only refuses to follow the *final* path component
//    if it's a link — every ancestor directory component is silently
//    (and transparently) resolved by the OS, including through a Windows
//    junction/reparse point or a symlinked directory. A path like
//    "external-junction/secret.txt", where "external-junction" is a
//    junction pointing outside the repository, lstats as an ordinary
//    regular file — `git ls-files` will even report it, since `git`
//    itself doesn't guard against this either. So before touching the
//    final entry, every ancestor path component from the repository root
//    down is walked and lstat'd individually; an ancestor that is itself
//    a symlink/junction/reparse point fails the whole entry closed,
//    before the final file (or anything through the link) is ever read.
//  - A *leaf* symlink is never dereferenced automatically either. Its
//    target is resolved and validated *before* anything is read: a
//    target outside the official repository fails closed immediately. A
//    target inside the repository is preserved as a link, but rewritten
//    to point at the mirrored location inside the disposable copy —
//    never at the original — so a write through a preserved link can
//    never reach the official repository. If the current platform can't
//    actually create that link (e.g. Windows without symlink privilege —
//    note plain junctions do NOT require that privilege), this fails
//    explicitly rather than silently copying the dereferenced content.
//  - Every source and destination path is canonicalized and containment-
//    checked before any read or write.
//  - The Git listing subprocess is bounded by a real, enforced deadline
//    (async `spawn` + SIGTERM then SIGKILL escalation), not
//    `spawnSync`'s `timeout` option, which cannot terminate a child that
//    ignores SIGTERM.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn as nodeSpawn} from "node:child_process";

const DEFAULT_GIT_TIMEOUT_MS = 15000;
const DEFAULT_GIT_KILL_GRACE_MS = 300;
const DEFAULT_MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024; // generous for real repositories
const WORKSPACE_PREFIX = "autopilot-reviewer-";

function normalizeForCompare(candidate) {
  const resolved = path.resolve(candidate);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithin(root, candidate) {
  const normalizedRoot = normalizeForCompare(root);
  const normalizedCandidate = normalizeForCompare(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(normalizedRoot + path.sep);
}

function assertWithin(root, candidate, label) {
  if (!isWithin(root, candidate)) {
    throw new Error(`reviewer-workspace: ${label} escapes its allowed root: ${candidate}`);
  }
}

function assertNotWithin(root, candidate, label) {
  if (isWithin(root, candidate)) {
    throw new Error(`reviewer-workspace: ${label} must not be inside the official repository: ${candidate}`);
  }
}

function isGitMetadataSegment(segment) {
  return process.platform === "win32" ? segment.toLowerCase() === ".git" : segment === ".git";
}

// `Buffer#toString("utf8")` never throws — an invalid byte sequence
// silently becomes one or more U+FFFD replacement characters, after
// which the resulting string no longer matches the real on-disk path.
// That path would then simply fail to `lstat` (ENOENT) and be silently
// treated as "deleted, stays absent" — an invalid-UTF-8 filename must
// never be silently skipped, it must fail the whole operation closed.
// `TextDecoder` with `fatal: true` is a Node global (no import needed)
// and throws a TypeError on any invalid sequence instead.
const strictUtf8Decoder = new TextDecoder("utf-8", {fatal: true});

function decodeStrictUtf8Segment(bytes) {
  try {
    return strictUtf8Decoder.decode(bytes);
  } catch (error) {
    throw new Error(`reviewer-workspace: git ls-files output contains a path with invalid UTF-8 bytes — refusing rather than silently substituting replacement characters and skipping it (${error.message})`);
  }
}

// Splits raw NUL-delimited `git ls-files -z` output into UTF-8 path
// strings without ever going through a shell — filenames may legitimately
// contain spaces, unicode, and even newlines, all of which are safe here
// since NUL (not newline) is the delimiter. Non-empty output MUST end
// exactly on a NUL boundary; any trailing bytes after the last NUL are
// treated as malformed/truncated output and rejected rather than
// silently accepted as one more (unterminated) entry. Each entry is
// decoded with strict/fatal UTF-8 validation (see above).
function splitNulDelimited(buffer) {
  const parts = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0) {
      if (i > start) parts.push(decodeStrictUtf8Segment(buffer.subarray(start, i)));
      start = i + 1;
    }
  }
  if (start < buffer.length) {
    throw new Error("reviewer-workspace: malformed git ls-files output (trailing bytes without a NUL terminator)");
  }
  return parts;
}

// Rejects malformed Git output up front (absolute paths, Windows drive
// paths, `.git`/nested-`.git` path segments) and converts Git's
// always-forward-slash paths to the platform separator. `.gitignore` and
// `.gitmodules` are ordinary filenames (not exact `.git` segments) and
// remain valid. Traversal (`..`) is not string-matched here — it's
// rejected structurally by the caller's containment check after
// `path.resolve`, which is robust regardless of how the traversal was
// spelled.
function normalizeGitRelativePath(relPath) {
  if (!relPath) return null;
  if (relPath.startsWith("/") || relPath.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(relPath)) {
    throw new Error(`reviewer-workspace: refusing malformed git ls-files output (absolute path): ${relPath}`);
  }
  const segments = relPath.split("/");
  for (const segment of segments) {
    if (isGitMetadataSegment(segment)) {
      throw new Error(`reviewer-workspace: refusing to copy a git-metadata path (contains a ".git" segment): ${relPath}`);
    }
  }
  return segments.join(path.sep);
}

function appendBounded(buffer, chunk, maxLen) {
  if (buffer.length >= maxLen) return buffer;
  const combined = buffer + chunk.toString("utf8");
  return combined.length > maxLen ? combined.slice(0, maxLen) : combined;
}

// Bounded, asynchronous `git ls-files` invocation. Never `spawnSync`: a
// child that ignores SIGTERM cannot block the caller forever here — on
// deadline this sends SIGTERM, escalates to SIGKILL after
// `killGraceMs`, and resolves/rejects deterministically via a `settled`
// guard so error/exit/close/timeout races can never double-complete or
// hang. Output is capped at `maxOutputBytes`; exceeding it fails closed
// (never silently truncates and proceeds).
function listReviewableFiles({repoRoot, spawnFn, gitBinary, timeoutMs, killGraceMs, maxOutputBytes}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadlineTimer = null;
    let killTimer = null;
    let backstopTimer = null;

    const clearTimers = () => {
      clearTimeout(deadlineTimer);
      clearTimeout(killTimer);
      clearTimeout(backstopTimer);
    };
    const finishOk = value => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(value);
    };
    const finishErr = error => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    };

    let child;
    try {
      child = spawnFn(gitBinary, ["-C", repoRoot, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false
      });
    } catch (error) {
      finishErr(new Error(`reviewer-workspace: failed to spawn "${gitBinary} ls-files": ${error?.message || error}`));
      return;
    }
    if (!child || typeof child.on !== "function") {
      finishErr(new Error("reviewer-workspace: git spawn returned no child handle"));
      return;
    }

    const chunks = [];
    let totalBytes = 0;
    let overflowed = false;
    let stderrText = "";
    let timedOut = false;

    child.stdout?.on("data", chunk => {
      if (overflowed || timedOut) return;
      totalBytes += chunk.length;
      if (totalBytes > maxOutputBytes) {
        overflowed = true;
        try { child.kill("SIGTERM"); } catch { /* already dead */ }
        return;
      }
      chunks.push(chunk);
    });
    child.stderr?.on("data", chunk => { stderrText = appendBounded(stderrText, chunk, 4096); });

    child.on("error", error => {
      if (error?.code === "ENOENT") {
        finishErr(new Error(`reviewer-workspace: git binary not found: "${gitBinary}"`));
        return;
      }
      finishErr(new Error(`reviewer-workspace: git ls-files failed to run: ${error.message}`));
    });

    // "exit" can fire before stdout has finished draining through the
    // pipe (the process itself has exited, but buffered stdio data may
    // still be in flight) — resolving on "exit" risks silently returning
    // an incomplete file list. "close" fires only after every stdio
    // stream has itself emitted its final event, guaranteeing every byte
    // of stdout has already been delivered to the "data" handler above.
    // So "exit" only ever *records* code/signal (as a fallback for a
    // fake/injected child whose "close" event might not carry them
    // itself); the actual success/failure decision, and the only
    // resolve/reject for a normal termination, happens on "close".
    let exitInfo = null;
    child.on("exit", (code, signal) => {
      exitInfo = {code, signal};
    });

    const settleFromClose = (code, signal) => {
      const finalCode = code ?? exitInfo?.code ?? null;
      const finalSignal = signal ?? exitInfo?.signal ?? null;
      if (timedOut) {
        finishErr(new Error(`reviewer-workspace: git ls-files timed out after ${timeoutMs}ms and was terminated`));
        return;
      }
      if (overflowed) {
        finishErr(new Error(`reviewer-workspace: git ls-files output exceeded the maximum allowed size (${maxOutputBytes} bytes) — refusing to process`));
        return;
      }
      if (finalSignal) {
        finishErr(new Error(`reviewer-workspace: git ls-files was terminated by signal ${finalSignal}`));
        return;
      }
      if (finalCode !== 0) {
        finishErr(new Error(`reviewer-workspace: git ls-files exited with status ${finalCode}: ${stderrText}`));
        return;
      }
      finishOk(Buffer.concat(chunks));
    };
    child.on("close", settleFromClose);

    deadlineTimer = setTimeout(() => {
      timedOut = true;
      try { child.stdout?.destroy(); } catch { /* already closed */ }
      try { child.stderr?.destroy(); } catch { /* already closed */ }
      try { child.kill("SIGTERM"); } catch { /* already dead */ }
      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
        // Backstop: SIGKILL cannot be caught, so `exit`/`close` should
        // follow almost immediately — but resolve deterministically even
        // in a pathological case where they never arrive.
        backstopTimer = setTimeout(() => finishErr(new Error(`reviewer-workspace: git ls-files timed out after ${timeoutMs}ms and did not terminate cleanly`)), Math.max(killGraceMs, 200));
      }, killGraceMs);
    }, timeoutMs);
  });
}

function copyRegularFile(sourcePath, destPath) {
  // Read + write a brand-new file — never a hardlink, never a reflink —
  // so the destination is byte-for-byte independent of the source: later
  // writes to either side can never affect the other.
  const bytes = fs.readFileSync(sourcePath);
  fs.writeFileSync(destPath, bytes);
}

function resolveSymlinkTarget(sourcePath, rawTarget) {
  const candidate = path.isAbsolute(rawTarget) ? path.resolve(rawTarget) : path.resolve(path.dirname(sourcePath), rawTarget);
  try {
    return {resolved: fs.realpathSync(candidate), dangling: false};
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`reviewer-workspace: cannot resolve symlink target for "${sourcePath}": ${error.message}`);
    }
    // Dangling target: nothing exists to realpath, but `candidate` is
    // already a fully lexical, `..`-collapsed absolute path (from
    // path.resolve), so it is still safe to containment-check directly.
    return {resolved: candidate, dangling: true};
  }
}

// A symlink is never dereferenced to decide safety. Its target is
// resolved via readlink/realpath (metadata only — no file content is ever
// read) and containment-checked *before* anything else happens. A target
// outside the official repository fails closed here, immediately, with
// no further access to it. A target inside the repository is preserved
// as a link, but re-pointed at the mirrored path inside the disposable
// copy so a write through it can never reach the official repository.
function copySymlink({sourceRepository, reviewRepository, sourcePath, destPath}) {
  const rawTarget = fs.readlinkSync(sourcePath);
  const {resolved: realTarget, dangling} = resolveSymlinkTarget(sourcePath, rawTarget);

  if (!isWithin(sourceRepository, realTarget)) {
    throw new Error(`reviewer-workspace: refusing to copy symlink "${sourcePath}" — its target resolves outside the official repository`);
  }

  const relFromRepoRoot = path.relative(sourceRepository, realTarget);
  const mirroredTarget = path.resolve(reviewRepository, relFromRepoRoot);
  const newLinkText = path.relative(path.dirname(destPath), mirroredTarget) || ".";

  let linkType;
  if (process.platform === "win32") {
    linkType = "file";
    if (!dangling) {
      try {
        linkType = fs.statSync(realTarget).isDirectory() ? "dir" : "file";
      } catch { /* keep the "file" default */ }
    }
  }

  try {
    fs.symlinkSync(newLinkText, destPath, linkType);
  } catch (error) {
    // Covers the documented Windows case: symlink creation requires a
    // privilege (admin / Developer Mode) that may not be present. Fail
    // explicitly rather than falling back to copying the dereferenced
    // content, which would silently defeat the point of preserving a link.
    throw new Error(`reviewer-workspace: safe link preservation is unavailable on this platform for "${sourcePath}" — refusing to dereference it instead (${error.message})`);
  }
}

// A regular file or a symlink is all this module ever copies. Anything
// else (FIFO, socket, block/char device, ...) fails explicitly rather
// than being silently skipped or dereferenced. In practice `git` itself
// already excludes these from `ls-files` output (they can be neither
// tracked nor reported by `--others`), so this is defense-in-depth for
// any Git behavior/version/filesystem this module hasn't been exercised
// against.
function isSupportedFsEntry(stat) {
  return stat.isFile() || stat.isSymbolicLink();
}

// `lstat` only refuses to follow the *final* path component if it's a
// link — every ancestor directory component in between is silently
// resolved by the OS regardless, including through a Windows
// junction/reparse point or a symlinked directory. This walks every
// ancestor component from `sourceRepository` down to (but not including)
// the final entry, `lstat`-ing each one individually, and fails closed on
// the first ancestor that is itself a symlink/junction/reparse point —
// *before* the final entry (or anything reachable only through the link)
// is ever touched. An ancestor that no longer exists (ENOENT) means a
// deleted tracked entry (its parent directory itself is gone) — reported
// back as `missing` so the caller can skip it, matching the existing
// "deleted tracked files stay absent" behavior for the leaf case.
function assertNoLinkedAncestors(sourceRepository, relPath) {
  const segments = relPath.split(path.sep).filter(Boolean);
  let current = sourceRepository;
  for (let i = 0; i < segments.length - 1; i += 1) {
    current = path.join(current, segments[i]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === "ENOENT") return {missing: true};
      throw error;
    }
    if (stat.isSymbolicLink()) {
      const ancestorRel = segments.slice(0, i + 1).join("/");
      throw new Error(`reviewer-workspace: refusing "${relPath}" — ancestor path component "${ancestorRel}" is a symlink/junction/reparse point (ancestor links are never followed)`);
    }
    if (!stat.isDirectory()) {
      const ancestorRel = segments.slice(0, i + 1).join("/");
      throw new Error(`reviewer-workspace: refusing "${relPath}" — ancestor path component "${ancestorRel}" is not a directory`);
    }
  }
  return {missing: false};
}

function copyEntry({sourceRepository, reviewRepository, relPath}) {
  const sourcePath = path.resolve(sourceRepository, relPath);
  assertWithin(sourceRepository, sourcePath, "source file");
  const destPath = path.resolve(reviewRepository, relPath);
  assertWithin(reviewRepository, destPath, "destination file");

  const ancestors = assertNoLinkedAncestors(sourceRepository, relPath);
  if (ancestors.missing) return; // an ancestor directory is gone — deleted tracked entry, stays absent

  let stat;
  try {
    stat = fs.lstatSync(sourcePath);
  } catch (error) {
    if (error.code === "ENOENT") return; // deleted tracked file — stays absent
    throw error;
  }

  if (!isSupportedFsEntry(stat)) {
    throw new Error(`reviewer-workspace: unsupported file type for "${relPath}" (only regular files and symlinks are supported)`);
  }

  fs.mkdirSync(path.dirname(destPath), {recursive: true});

  if (stat.isSymbolicLink()) {
    copySymlink({sourceRepository, reviewRepository, sourcePath, destPath});
    return;
  }
  copyRegularFile(sourcePath, destPath);
}

// Walk a directory tree and recursively copy regular files and symlinks
// to a destination, skipping only the `runs/` subdirectory at the top
// level of the mission directory. Used to copy .autopilot/missions/<mission>/*
// minus its runs/ subdir.
function copyMissionDirRecursive({sourcePath, destPath, missionSourcePath, missionDestPath, runsBasename}) {
  let stat;
  try {
    stat = fs.lstatSync(sourcePath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  if (stat.isSymbolicLink()) {
    const rawTarget = fs.readlinkSync(sourcePath);
    const {resolved: realTarget, dangling} = resolveSymlinkTarget(sourcePath, rawTarget);

    if (!isWithin(missionSourcePath, realTarget)) {
      throw new Error(`reviewer-workspace: refusing to copy symlink "${sourcePath}" in mission directory — its target resolves outside the mission directory`);
    }

    const relFromMissionRoot = path.relative(missionSourcePath, realTarget);
    const mirroredTarget = path.resolve(missionDestPath, relFromMissionRoot);
    const newLinkText = path.relative(path.dirname(destPath), mirroredTarget) || ".";

    let linkType;
    if (process.platform === "win32") {
      linkType = "file";
      if (!dangling) {
        try {
          linkType = fs.statSync(realTarget).isDirectory() ? "dir" : "file";
        } catch { /* keep the "file" default */ }
      }
    }

    try {
      fs.symlinkSync(newLinkText, destPath, linkType);
    } catch (error) {
      throw new Error(`reviewer-workspace: safe link preservation is unavailable on this platform for "${sourcePath}" in mission directory — refusing to dereference it instead (${error.message})`);
    }
    return;
  }

  if (stat.isDirectory()) {
    // Skip the runs/ directory only at the top level of the mission
    if (path.basename(sourcePath) === runsBasename && sourcePath === path.join(missionSourcePath, runsBasename)) {
      return; // skip the runs directory
    }

    fs.mkdirSync(destPath, {recursive: true});
    for (const entry of fs.readdirSync(sourcePath)) {
      copyMissionDirRecursive({
        sourcePath: path.join(sourcePath, entry),
        destPath: path.join(destPath, entry),
        missionSourcePath,
        missionDestPath,
        runsBasename
      });
    }
    return;
  }

  if (stat.isFile()) {
    fs.mkdirSync(path.dirname(destPath), {recursive: true});
    copyRegularFile(sourcePath, destPath);
    return;
  }

  throw new Error(`reviewer-workspace: unsupported file type in mission directory for "${sourcePath}" (only regular files and symlinks are supported)`);
}

// Pure, side-effect-free validation/classification helpers, exposed only
// so tests can exercise the path-traversal / malformed-Git-output /
// unsupported-entry-type / ancestor-link guards directly and
// deterministically (including cases real `git` won't reproduce, or that
// a fake-`git` subprocess fixture can't reliably reproduce on Windows —
// spawnSync cannot directly execute a .cmd/.bat fixture without a shell).
// Not used by, and not required by, any production caller.
export const __testables = Object.freeze({
  normalizeGitRelativePath,
  isWithin,
  assertWithin,
  isSupportedFsEntry,
  assertNoLinkedAncestors,
  splitNulDelimited,
  isGitMetadataSegment
});

/**
 * Exported helper for runRelay wiring: decides whether to use the
 * disposable-copy (mission-dir overlay) path and returns the args
 * for createReviewerWorkspace accordingly.
 *
 * For standalone with a mission, returns {repository, mission}.
 * For other frameworks or null mission on standalone, throws loudly.
 *
 * Args:
 *   - framework: 'speckit', 'standalone', 'gsd', or 'undetermined'
 *   - repository: path to the official repository
 *   - mission: mission name/path (may be null/undefined)
 *
 * Returns: {repository, mission} if standalone with mission.
 * Throws: loudly if mission is null on standalone, or if framework is not standalone.
 */
export function disposableCopyArgs({framework, repository, mission}) {
  if (framework === "standalone") {
    if (!mission) {
      throw new Error("reviewer-workspace: standalone with null/missing mission is unsupported — disposable-copy requires a mission directory");
    }
    return {repository, mission};
  }
  if (!mission) {
    // Non-standalone without mission is expected (normal case)
    return null;
  }
  // Non-standalone with mission is an error
  throw new Error(`reviewer-workspace: mission-dir overlay is only available for standalone, not ${framework}`);
}

/**
 * Build one disposable, throwaway copy of `repository`'s current
 * reviewable working-tree state (tracked files at their current on-disk
 * bytes, plus untracked-but-not-ignored files — exactly what
 * `git ls-files -z --cached --others --exclude-standard` reports, minus
 * any `.git` metadata path segment) inside a fresh unique temp directory
 * outside the official repository.
 *
 * When `mission` is provided (relative path), also copy the contents of
 * `.autopilot/missions/<mission>/` into the workspace's `.autopilot/`
 * directory, excluding the `runs/` subdirectory — providing a small
 * read-only copy of the mission directory for reviewer access.
 *
 * Async: the Git listing subprocess is bounded by a real, enforced
 * deadline (SIGTERM then SIGKILL), which requires asynchronous `spawn`.
 *
 * Returns a Promise resolving to `{sourceRepository, workspaceRoot,
 * reviewRepository, scratchDirectory, cleanup}`. `cleanup()` is
 * synchronous, idempotent, and removes only the generated
 * `workspaceRoot` — never the official repository — re-validating the
 * workspace's identity and structural integrity (still directly beneath
 * its captured temp parent, still matching the generated prefix, still a
 * plain directory rather than a substituted link) immediately before any
 * deletion.
 *
 * Purely a primitive: does not select a runtime, does not know about
 * roles, and is not called from anywhere in production yet.
 */
export async function createReviewerWorkspace({
  repository,
  mission,
  tempParentDir = os.tmpdir(),
  gitBinary = "git",
  gitTimeoutMs = DEFAULT_GIT_TIMEOUT_MS,
  gitKillGraceMs = DEFAULT_GIT_KILL_GRACE_MS,
  maxGitOutputBytes = DEFAULT_MAX_GIT_OUTPUT_BYTES,
  spawnFn = nodeSpawn
} = {}) {
  if (!repository) {
    throw new Error("reviewer-workspace: `repository` is required");
  }

  const sourceRepository = fs.realpathSync(path.resolve(repository));
  const repoStat = fs.statSync(sourceRepository);
  if (!repoStat.isDirectory()) {
    throw new Error(`reviewer-workspace: repository path is not a directory: ${sourceRepository}`);
  }

  const tempParentReal = fs.realpathSync(path.resolve(tempParentDir));
  assertNotWithin(sourceRepository, tempParentReal, "workspace parent directory");

  const workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(tempParentReal, WORKSPACE_PREFIX)));
  assertNotWithin(sourceRepository, workspaceRoot, "generated workspace");

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;

    // Revalidate identity and structural integrity immediately before
    // ever touching disk — even though `workspaceRoot`/`tempParentReal`
    // are closed-over constants already proven safe at creation time.
    if (normalizeForCompare(path.dirname(workspaceRoot)) !== normalizeForCompare(tempParentReal)) {
      throw new Error("reviewer-workspace: refusing to clean up — workspace is not directly beneath its captured temp parent");
    }
    if (!path.basename(workspaceRoot).startsWith(WORKSPACE_PREFIX)) {
      throw new Error("reviewer-workspace: refusing to clean up — workspace path does not match the generated prefix");
    }
    if (normalizeForCompare(workspaceRoot) === normalizeForCompare(sourceRepository) || isWithin(workspaceRoot, sourceRepository)) {
      throw new Error("reviewer-workspace: refusing to clean up a workspace path that contains the official repository");
    }

    // The workspace root itself must never be traversed if it has been
    // substituted by a symlink/junction — `lstat` (never `stat`) decides
    // this, so a substituted link is detected instead of silently
    // followed.
    let rootStat;
    try {
      rootStat = fs.lstatSync(workspaceRoot);
    } catch (error) {
      if (error.code === "ENOENT") {
        cleaned = true; // already gone — idempotent no-op
        return;
      }
      throw error;
    }
    if (rootStat.isSymbolicLink()) {
      throw new Error("reviewer-workspace: refusing to clean up — workspace root has been replaced by a symlink/junction");
    }
    if (!rootStat.isDirectory()) {
      throw new Error("reviewer-workspace: refusing to clean up — workspace root is no longer a plain directory");
    }

    // `fs.rmSync` recursive walk uses `lstat` at every level (never
    // follows a symlink/junction it encounters partway through the
    // tree — it just unlinks the link itself), so a child that was
    // substituted with a link pointing at the official repository is
    // never traversed into either.
    fs.rmSync(workspaceRoot, {recursive: true, force: true, maxRetries: 3});
    cleaned = true;
  };

  try {
    const reviewRepository = path.join(workspaceRoot, "repository");
    const scratchDirectory = path.join(workspaceRoot, "scratch");
    fs.mkdirSync(reviewRepository, {recursive: true});
    fs.mkdirSync(scratchDirectory, {recursive: true});

    const rawOutput = await listReviewableFiles({
      repoRoot: sourceRepository,
      spawnFn,
      gitBinary,
      timeoutMs: gitTimeoutMs,
      killGraceMs: gitKillGraceMs,
      maxOutputBytes: maxGitOutputBytes
    });
    const relativePaths = splitNulDelimited(rawOutput).map(normalizeGitRelativePath).filter(Boolean);
    for (const relPath of relativePaths) {
      // When mission is provided, exclude .autopilot/ from normal copy
      // (it will be added separately as a focused mission-dir overlay)
      if (mission && (relPath.startsWith(`.autopilot${path.sep}`) || relPath === ".autopilot")) {
        continue;
      }
      copyEntry({sourceRepository, reviewRepository, relPath});
    }

    // If mission is provided, copy the mission directory (minus runs/)
    // into the workspace's .autopilot/ directory
    if (mission) {
      const autopilotSourcePath = path.join(sourceRepository, ".autopilot");
      const missionSourcePath = path.join(autopilotSourcePath, "missions", mission);
      const autopilotDestPath = path.join(reviewRepository, ".autopilot");
      const missionDestPath = path.join(autopilotDestPath, "missions", mission);

      if (!fs.existsSync(missionSourcePath)) {
        throw new Error(`reviewer-workspace: mission directory not found: ${missionSourcePath}`);
      }

      const missionStat = fs.statSync(missionSourcePath);
      if (!missionStat.isDirectory()) {
        throw new Error(`reviewer-workspace: mission path is not a directory: ${missionSourcePath}`);
      }

      // Copy the mission directory recursively, skipping the runs/ subdirectory
      for (const entry of fs.readdirSync(missionSourcePath)) {
        if (entry === "runs") continue; // skip the runs directory
        copyMissionDirRecursive({
          sourcePath: path.join(missionSourcePath, entry),
          destPath: path.join(missionDestPath, entry),
          missionSourcePath,
          missionDestPath,
          runsBasename: "runs"
        });
      }
    }

    return {sourceRepository, workspaceRoot, reviewRepository, scratchDirectory, cleanup};
  } catch (error) {
    try {
      fs.rmSync(workspaceRoot, {recursive: true, force: true});
    } catch (cleanupError) {
      // Never silently hide a cleanup failure — but never let it mask the
      // original (primary) failure either. Both are preserved.
      error.cleanupError = cleanupError;
      error.message += ` (additionally, best-effort cleanup of the partial workspace failed: ${cleanupError.message})`;
    }
    throw error;
  }
}
