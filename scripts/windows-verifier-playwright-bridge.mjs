// Task 15.4C3C: Native Windows compatibility bridge that exposes an
// already-discovered Playwright runtime (task 15.4C1) to the disposable
// Native Windows Verifier child (the reviewer-workspace copy a SpecKit
// Verifier already runs inside).
//
// This module performs NO discovery of its own — discoverPlaywrightRuntime()
// has already run, upstream in autopilot.mjs, against the OFFICIAL
// repository (task 15.4C2). It only decides, from that already-computed
// result, whether the discovered runtime is eligible to be bridged into the
// Verifier child's environment, and re-validates it is still usable
// immediately before launch.
//
// Native Windows has no OS-enforced read-only bind the way WSL/Linux
// bubblewrap can provide (task 15.4C3A/C3B). Because of that, a runtime
// whose canonical module or browser root lives INSIDE the official
// repository, its actual Git working tree, or its real Git metadata
// directory is never bridged: handing that host path to the Verifier child
// would give it a live path into the official repository with no
// OS-enforced protection, and the disposable-copy compatibility story
// depends on the Verifier never being handed such a path. A
// repository-local runtime is simply treated as "not applicable" — the
// Verifier still runs, browser verification is unavailable for that run, and
// nothing fails.
//
// CORRECTION 1 (task 15.4C3C correction): the official repository root MUST
// be canonicalized (real filesystem identity, not merely path.resolve())
// before any containment decision — a Windows junction/symlink pointed at
// the repository (or at an ancestor of it) otherwise let a genuinely
// repository-local runtime look external, since discoverPlaywrightRuntime()'s
// own module/browser roots are already canonical (see playwright-runtime.mjs)
// while an un-canonicalized officialRepo compared unequal to them even when
// naming the same real directory. fs.realpathSync() collapses every
// junction/symlink in the chain, including one in an ancestor component.
//
// CORRECTION 2 (this file, task 15.4C3C final correction): the FIRST
// correction still only checked "<canonical officialRepo>\.git" directly —
// but Autopilot accepts a --repo path that may be a NESTED subdirectory
// inside a larger Git working tree (e.g. officialRepo =
// "C:\tmp\repo\project" where the actual Git worktree root is "C:\tmp\repo"
// and its metadata lives at "C:\tmp\repo\.git"). A purely local ".git"
// existence check at officialRepo itself finds nothing in that case and
// wrongly concludes there is no Git metadata to protect, while a runtime
// planted at "C:\tmp\repo\.git\pw-node_modules" is genuinely
// repository-local and must never be bridged.
//
// The fix: resolve the ACTUAL Git identity using Git itself as the source of
// truth — `git -C <canonicalOfficialRepo> rev-parse --show-toplevel
// --absolute-git-dir --git-common-dir`, which walks UP from officialRepo (a
// nested directory or the repository root, either way) to find the real
// enclosing worktree root, its per-worktree Git directory, and the shared
// Git-common directory (identical to the per-worktree directory for a
// normal repository; distinct for a linked worktree, where the per-worktree
// directory lives under the main repository's ".git/worktrees/<name>" and
// the common directory is the main repository's own ".git"). All three,
// together with the canonical officialRepo itself, are protected — a
// runtime root inside ANY of them is repository-local, never external.
//
// Fail-closed rule: once a runtime looked eligible (ready, and both roots
// resolve outside every protected identity), any validation failure from
// here on — including one only visible in a fresh, immediate-before-launch
// re-check, or any of the official repository/Git identities failing to
// resolve safely (Git unavailable, timeout, spawn error, nonzero exit,
// malformed/oversized output, an unresolved returned path) — makes this
// bridge attempt "applicable but invalid". Callers MUST treat that as a hard
// failure (never launch with a partial environment, never silently fall
// back to a repository-local runtime, and never treat an absent LOCAL
// "<officialRepo>\.git" entry as proof that no Git metadata exists anywhere
// in the enclosing worktree).
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {resolvePlaywrightRuntimeInput} from "./execution-envelope.mjs";

function safeRealpath(p) {
  if (typeof p !== "string" || !p) return null;
  try { return fs.realpathSync(p); } catch { return null; }
}

function normalizeForCompare(p) {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithinRoot(root, candidate) {
  if (typeof root !== "string" || !root) return false;
  if (typeof candidate !== "string" || !candidate) return false;
  const r = normalizeForCompare(root);
  const c = normalizeForCompare(candidate);
  return c === r || c.startsWith(r + path.sep);
}

// The official repository's REAL filesystem identity. fs.realpathSync
// resolves every component of the path, so a junction/symlink anywhere in
// the chain — the repository root itself, or an ancestor directory — is
// collapsed to its real target. Returns null (never a best-effort guess)
// when the path cannot be resolved to a real, existing directory; callers
// MUST fail closed on null rather than falling back to the unresolved path.
function resolveCanonicalRepositoryRoot(officialRepo) {
  if (typeof officialRepo !== "string" || !officialRepo) return null;
  const real = safeRealpath(officialRepo);
  if (!real) return null;
  let st;
  try { st = fs.statSync(real); } catch { return null; }
  if (!st.isDirectory()) return null;
  return real;
}

// ---------------------------------------------------------------------
// Actual Git identity, resolved via a single bounded `git rev-parse` probe
// — argument-array execution only (no shell), a hard timeout, a small
// bounded output buffer, strict line-count/line-length validation, and
// canonical realpath validation of every returned directory. Any failure
// mode returns {ok: false} uniformly: callers fail the WHOLE bridge attempt
// closed on any of these, including a plain "not a Git repository" result —
// every real Autopilot mission runs inside a Git repository, so that result
// is itself anomalous and is never treated as "nothing to protect."
// ---------------------------------------------------------------------
const GIT_PROBE_TIMEOUT_MS = 5000;
const GIT_PROBE_MAX_BUFFER_BYTES = 64 * 1024;
const GIT_PROBE_MAX_LINE_LENGTH = 4096;
const GIT_PROBE_EXPECTED_LINES = 3;

function resolveActualGitIdentity(canonicalOfficialRepo) {
  const failClosed = {ok: false, worktreeRoot: null, gitDir: null, commonDir: null};
  let result;
  try {
    result = spawnSync(
      "git",
      ["-C", canonicalOfficialRepo, "rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"],
      {
        cwd: canonicalOfficialRepo,
        timeout: GIT_PROBE_TIMEOUT_MS,
        maxBuffer: GIT_PROBE_MAX_BUFFER_BYTES,
        encoding: "utf8",
        stdio: "pipe",
        shell: false,
        windowsHide: true
      }
    );
  } catch {
    return failClosed; // spawnSync itself never throws for a bounded call, but never trust that blindly
  }
  if (!result || result.error) return failClosed; // spawn error, ENOBUFS (output too large), etc.
  if (result.signal) return failClosed; // killed — including a timeout kill
  if (typeof result.status !== "number" || result.status !== 0) return failClosed; // nonzero exit (e.g. "not a git repository"), or status null

  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  if (stdout.length > GIT_PROBE_MAX_BUFFER_BYTES) return failClosed; // defensive; maxBuffer already bounds this
  const lines = stdout.split(/\r?\n/).filter(line => line.length > 0);
  if (lines.length !== GIT_PROBE_EXPECTED_LINES) return failClosed; // malformed output
  if (lines.some(line => line.length > GIT_PROBE_MAX_LINE_LENGTH)) return failClosed; // excessive/malformed line

  const [toplevelRaw, gitDirRaw, commonDirRaw] = lines;
  // --show-toplevel and --absolute-git-dir are documented to always print an
  // absolute path. --git-common-dir may print a path relative to the
  // invocation cwd on older Git — resolved against the SAME cwd the probe
  // itself used, never against an unrelated path.
  const commonDirAbsolute = path.isAbsolute(commonDirRaw) ? commonDirRaw : path.resolve(canonicalOfficialRepo, commonDirRaw);

  const worktreeRoot = safeRealpath(toplevelRaw);
  const gitDir = safeRealpath(gitDirRaw);
  const commonDir = safeRealpath(commonDirAbsolute);
  if (!worktreeRoot || !gitDir || !commonDir) return failClosed; // unresolved returned directory

  for (const dir of [worktreeRoot, gitDir, commonDir]) {
    let st;
    try { st = fs.statSync(dir); } catch { return failClosed; }
    if (!st.isDirectory()) return failClosed; // returned path missing/not a directory
  }

  return {ok: true, worktreeRoot, gitDir, commonDir};
}

// A candidate is only "outside" the protected set when it lies within NONE
// of the supplied roots. Every root here is ALREADY fully resolved
// (junction/symlink-free, realpath'd) by the callers below, and every
// candidate is already canonical too (discoverPlaywrightRuntime()'s own
// module/browser roots are documented as canonical; resolvePlaywrightRuntimeInput()
// re-canonicalizes via realpath again before returning). No further realpath
// is performed here — only string comparison of already-canonical paths.
function isOutsideAllProtectedRoots(protectedRoots, candidate) {
  if (typeof candidate !== "string" || !candidate) return false;
  return protectedRoots.every(root => !isWithinRoot(root, candidate));
}

const NOT_APPLICABLE = Object.freeze({
  applicable: false, valid: false, moduleRoot: null, browserRoot: null, invalidReason: null
});

/**
 * Decide whether an already-discovered Playwright runtime should be bridged
 * into a Native Windows disposable Verifier child's environment.
 *
 * @param {object} options
 * @param {string} options.platform Defaults to `process.platform`; injectable for tests.
 * @param {string} options.roleName The relay role being launched (only "verifier" is ever eligible).
 * @param {boolean} options.disposableWorkspaceActive Whether this launch uses the Native Windows disposable reviewer-workspace copy.
 * @param {string} options.officialRepo Absolute path to the official repository directory passed to Autopilot (never the disposable copy) — may itself be a junction/symlink, and may be a NESTED subdirectory inside a larger Git working tree; canonicalized and Git-resolved internally.
 * @param {object|null} options.playwrightRuntime The discoverPlaywrightRuntime()-shaped result, computed upstream and passed through unmutated.
 * @returns {{applicable: boolean, valid: boolean, moduleRoot: string|null, browserRoot: string|null, invalidReason: string|null}}
 *   `applicable` is false whenever this bridge is a pure no-op for the call (wrong platform/role/mode, no runtime discovered, or a repository-local runtime) — never a failure.
 *   `applicable && !valid` is the fail-closed case: an external runtime looked eligible but could not be safely bridged at launch time (including an official repository/Git identity that could not be resolved safely).
 *   `applicable && valid` carries the two canonical external roots to expose.
 */
export function resolveWindowsVerifierPlaywrightBridge({
  platform = process.platform,
  roleName,
  disposableWorkspaceActive = false,
  officialRepo,
  playwrightRuntime = null
} = {}) {
  if (platform !== "win32") return NOT_APPLICABLE;
  if (roleName !== "verifier") return NOT_APPLICABLE;
  if (!disposableWorkspaceActive) return NOT_APPLICABLE;
  if (typeof officialRepo !== "string" || !officialRepo) return NOT_APPLICABLE;
  if (!playwrightRuntime || typeof playwrightRuntime !== "object") return NOT_APPLICABLE;
  if (playwrightRuntime.readyForLaunchProbe !== true) return NOT_APPLICABLE;

  // Canonicalize the OFFICIAL repository's real filesystem identity BEFORE
  // any containment decision. An otherwise-ready runtime is being evaluated
  // here, so an official repository/Git identity that cannot be resolved
  // safely fails this WHOLE bridge attempt closed — it is never classified
  // as external, and no partial environment is ever injected.
  const canonicalRepoRoot = resolveCanonicalRepositoryRoot(officialRepo);
  if (!canonicalRepoRoot) {
    return {
      applicable: true, valid: false, moduleRoot: null, browserRoot: null,
      invalidReason: `the official repository's real filesystem identity could not be resolved (${officialRepo})`
    };
  }

  // officialRepo may be a NESTED subdirectory inside a larger Git working
  // tree — resolve the ACTUAL enclosing worktree root and Git metadata
  // directories via Git itself rather than a local ".git" existence check.
  // An absent local "<officialRepo>\.git" entry is never treated as proof
  // that no Git metadata exists.
  const gitIdentity = resolveActualGitIdentity(canonicalRepoRoot);
  if (!gitIdentity.ok) {
    return {
      applicable: true, valid: false, moduleRoot: null, browserRoot: null,
      invalidReason: "the official repository's actual Git worktree/metadata identity could not be established safely"
    };
  }
  const protectedRoots = [canonicalRepoRoot, gitIdentity.worktreeRoot, gitIdentity.gitDir, gitIdentity.commonDir];

  // Pre-check against the raw discovered roots (already canonical values
  // from discoverPlaywrightRuntime()): a runtime that is plainly
  // repository-local — anywhere inside the enclosing worktree or its real
  // Git metadata, not merely inside officialRepo's own subtree — is never
  // bridged and never treated as a failure. Verifier just runs without
  // browser support for this run.
  const rawModuleDir = playwrightRuntime.module?.nodeModulesDir || null;
  const rawBrowserRoot = playwrightRuntime.browser?.root || null;
  if (!isOutsideAllProtectedRoots(protectedRoots, rawModuleDir)
    || !isOutsideAllProtectedRoots(protectedRoots, rawBrowserRoot)) {
    return NOT_APPLICABLE;
  }

  // From here on an EXTERNAL runtime looked eligible: this attempt is
  // "applicable", so any failure below must fail closed rather than quietly
  // degrade back to NOT_APPLICABLE.
  const resolution = resolvePlaywrightRuntimeInput(playwrightRuntime);
  if (!resolution.ok || !resolution.active) {
    return {
      applicable: true, valid: false, moduleRoot: null, browserRoot: null,
      invalidReason: resolution.detail || resolution.reason || "the discovered runtime is no longer ready"
    };
  }

  // Re-check containment against the FRESH canonical paths too: a symlink
  // swapped between discovery and now could otherwise smuggle a
  // repository-local target through the earlier raw-path check.
  if (!isOutsideAllProtectedRoots(protectedRoots, resolution.moduleDir)
    || !isOutsideAllProtectedRoots(protectedRoots, resolution.browserRoot)) {
    return {
      applicable: true, valid: false, moduleRoot: null, browserRoot: null,
      invalidReason: "canonical runtime path resolved inside the official repository, its actual Git worktree, or its real Git metadata directory immediately before launch"
    };
  }

  return {applicable: true, valid: true, moduleRoot: resolution.moduleDir, browserRoot: resolution.browserRoot, invalidReason: null};
}
