// Snapshot reuse cache — Phase 1 decision module (mission 084).
// In-process store keyed by repo identity + snapshot scope/version derived
// from SNAPSHOT_EXCLUDED_DIR_SEGMENTS. No wiring into autopilot.mjs yet.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SNAPSHOT_EXCLUDED_DIR_SEGMENTS } from "./relay-guards.mjs";

export { SNAPSHOT_EXCLUDED_DIR_SEGMENTS };
export const SNAPSHOT_REUSE_MAX_GAP_MS = 60000;

export const SNAPSHOT_CACHE_VERSION = 1;

export function getSnapshotCacheScopeVersion(
  segments = SNAPSHOT_EXCLUDED_DIR_SEGMENTS,
) {
  const sorted = [...segments].sort();
  return `v${SNAPSHOT_CACHE_VERSION}:${sorted.join(",")}`;
}

function hashString(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function gitOut(cwd, args, env = {}) {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...env },
  });
}

export function getRepoIdentity(cwd) {
  try {
    const common = gitOut(cwd, ["rev-parse", "--absolute-git-common-dir"])
      .toString()
      .trim();
    if (common) return path.resolve(cwd, common);
  } catch {}
  try {
    const dir = gitOut(cwd, ["rev-parse", "--absolute-git-dir"])
      .toString()
      .trim();
    if (dir) return path.resolve(cwd, dir);
  } catch {}
  return path.resolve(cwd);
}

export function getSnapshotCacheKey(cwd) {
  return `${getRepoIdentity(cwd)}::${getSnapshotCacheScopeVersion()}`;
}

// In-process store: key -> entry. A fresh process starts empty (scenario e).
export const snapshotReuseCache = new Map();

export function getCachedSnapshot(key) {
  return snapshotReuseCache.get(key) ?? null;
}

export function setCachedSnapshot(key, entry) {
  snapshotReuseCache.set(key, entry);
  return entry;
}

export function clearSnapshotReuseCache(reason = "cleared") {
  snapshotReuseCache.clear();
  return { cleared: true, reason };
}

// Lightweight guards: HEAD, index checksum/mtime, tracked+untracked status
// hash. Entry stores these guard values for later comparison.
export function collectSnapshotGuards(cwd) {
  const repoIdentity = getRepoIdentity(cwd);
  const scopeVersion = getSnapshotCacheScopeVersion();
  let head = "UNKNOWN";
  try {
    head = gitOut(cwd, ["rev-parse", "--verify", "HEAD"]).toString().trim();
  } catch {
    head = "UNBORN";
  }
  let statusHash = "UNKNOWN";
  try {
    // Status first (before reading the index): status can refresh the index
    // (racy smudge/clean, stat refresh), which would otherwise change a later
    // indexHash read and misattribute the drift. --no-optional-locks keeps
    // status from rewriting the index at all.
    const status = gitOut(cwd, [
      "--no-optional-locks",
      "-c",
      "core.autocrlf=input",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]).toString("utf8");
    statusHash = hashString(status);
  } catch {
    statusHash = "UNKNOWN";
  }
  let indexHash = "MISSING";
  let indexMtimeMs = 0;
  try {
    const gitDir = gitOut(cwd, ["rev-parse", "--absolute-git-dir"])
      .toString()
      .trim();
    const indexPath = path.resolve(cwd, gitDir, "index");
    const st = fs.statSync(indexPath);
    indexMtimeMs = st.mtimeMs;
    const buf = fs.readFileSync(indexPath);
    indexHash = hashString(buf.toString("binary") + `:mode=${st.mode}`);
  } catch {
    // Keep MISSING/0 defaults (fresh repo without an index yet).
  }
  return { repoIdentity, scopeVersion, head, indexHash, indexMtimeMs, statusHash };
}

export function makeCacheEntry(cwd, snapshot, guards = null) {
  const collected = guards ?? collectSnapshotGuards(cwd);
  return {
    key: `${collected.repoIdentity}::${collected.scopeVersion}`,
    repoIdentity: collected.repoIdentity,
    scopeVersion: collected.scopeVersion,
    guards: {
      head: collected.head,
      indexHash: collected.indexHash,
      indexMtimeMs: collected.indexMtimeMs,
      statusHash: collected.statusHash,
    },
    snapshot,
    storedAt: Date.now(),
  };
}

function fresh(reason) {
  return { reuse: false, reason };
}

// Pure decision: fresh-on-doubt default. Any missing/invalid input takes a
// fresh snapshot with a logged reason; reuse requires all 5 conditions:
// (1) entry present, (2) repo+scope/version key match, (3) guards match,
// (4) gap within SNAPSHOT_REUSE_MAX_GAP_MS, (5) no invalidation events since.
export function decideSnapshotReuse(
  cachedEntry,
  currentGuards,
  gapMs,
  eventsSince,
) {
  if (!cachedEntry || typeof cachedEntry !== "object") {
    return fresh("no cached snapshot");
  }
  if (!currentGuards || typeof currentGuards !== "object") {
    return fresh("unknown current guards");
  }
  if (typeof gapMs !== "number" || !Number.isFinite(gapMs)) {
    return fresh("unknown gap");
  }
  // Fresh-on-doubt: unknown event history can hide an invalidation, so a
  // non-array eventsSince must take fresh (never coerce to []).
  if (!Array.isArray(eventsSince)) {
    return fresh("unknown events since");
  }
  const events = eventsSince;
  // Fresh-on-doubt: scope/version or repo identity missing on either side
  // must take fresh (never pass two undefined values as a "match").
  if (
    typeof cachedEntry.scopeVersion !== "string" ||
    cachedEntry.scopeVersion.length === 0 ||
    typeof currentGuards.scopeVersion !== "string" ||
    currentGuards.scopeVersion.length === 0
  ) {
    return fresh("snapshot scope/version unknown");
  }
  if (
    typeof cachedEntry.repoIdentity !== "string" ||
    cachedEntry.repoIdentity.length === 0 ||
    typeof currentGuards.repoIdentity !== "string" ||
    currentGuards.repoIdentity.length === 0
  ) {
    return fresh("repository identity unknown");
  }
  if (cachedEntry.scopeVersion !== currentGuards.scopeVersion) {
    return fresh("snapshot scope/version changed");
  }
  if (
    cachedEntry.repoIdentity !== undefined &&
    currentGuards.repoIdentity !== undefined &&
    cachedEntry.repoIdentity !== currentGuards.repoIdentity
  ) {
    return fresh("repository identity changed");
  }
  const cachedGuards = cachedEntry.guards;
  if (!cachedGuards || typeof cachedGuards !== "object") {
    return fresh("cached guards missing");
  }
  const GUARD_PLACEHOLDERS = new Set(["UNKNOWN", "MISSING", "UNBORN"]);
  for (const field of ["head", "indexHash", "indexMtimeMs", "statusHash"]) {
    if (cachedGuards[field] === undefined || currentGuards[field] === undefined) {
      return fresh(`guard ${field} unknown`);
    }
    // Fresh-on-doubt: error placeholders (UNKNOWN/MISSING/UNBORN from a
    // failed rev-parse, missing index, or failed status) never count as a
    // match, even when both sides agree.
    if (
      GUARD_PLACEHOLDERS.has(cachedGuards[field]) ||
      GUARD_PLACEHOLDERS.has(currentGuards[field])
    ) {
      return fresh(`guard ${field} unknown`);
    }
    if (cachedGuards[field] !== currentGuards[field]) {
      return fresh(`guard ${field} changed`);
    }
  }
  if (gapMs < 0 || gapMs > SNAPSHOT_REUSE_MAX_GAP_MS) {
    return fresh("gap exceeds reuse window");
  }
  if (events.length > 0) {
    const first = events.find((event) => event !== null && event !== undefined);
    const label =
      typeof first === "object"
        ? (first.reason ?? first.type ?? JSON.stringify(first))
        : String(first);
    return fresh(label ? `invalidated: ${label}` : "invalidated since store");
  }
  return { reuse: true, reason: "snapshot reused" };
}
