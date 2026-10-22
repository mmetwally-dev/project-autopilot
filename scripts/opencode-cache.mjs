// OpenCode shared-cache seeding lifecycle (Mission 001, tasks 7-9 / task 11).
//
// Host-side cache root (distinct from scratchDir, SANDBOX_HOME, REPOSITORY):
//   path.join(os.homedir(), ".cache", "autopilot", "opencode-shared-cache")
// Immutable snapshots:
//   <cache-root>/versions/<version-tag>__<generation-suffix>/
// A `current` symlink at <cache-root>/current points at one absolute concrete
// versions path. Sandbox mount target: /autopilot/opencode-cache. Env vars:
// OPENCODE_MODELS_PATH + OPENCODE_DISABLE_MODELS_FETCH (see
// execution-envelope.mjs). Bind-mount time resolves `current` via
// fs.realpathSync() to the concrete versions path, never the symlink itself.
//
// Lifecycle (task 8): flock mutex on <cache-root>/.lock (kernel-released on
// crash, `flock -w` as sole wait bound), three-part validity predicate
// (.ready marker, manifest version match, required artifacts present and
// non-empty) used identically everywhere, double-checked-locking no-op and
// valid-but-not-current repoint (deleting stale .retired-at on repoint),
// build-in-temp-dir-then-publish ordering (manifest + .ready before the
// versioned rename), versioned collision-free publish plus atomic `current`
// swap (temp-symlink-then-rename), invalid snapshots never a repoint target
// (stamped with .retired-at for retirement-time-based GC), seeding-failure
// fallback (keep last valid current, or no mount if none), abandoned temp
// cleanup (kill -0 liveness), and retirement-time-based (never
// creation-time-based) GC gated by a per-snapshot .pin-lock requiring a
// non-blocking exclusive flock before deletion.
//
// Seed containment (task 9): the seed child runs in its own bwrap sandbox
// with REPOSITORY absent from the mount list, system paths read-only, only
// the temp build dir writable as HOME, the resolved opencode binary plus
// install-tree siblings explicitly --ro-bind'd, neutral cwd = temp build
// dir, sanitized four-variable env, per-phase and overall wall-clock
// timeouts shorter than the lock-wait bound, success requiring zero exit
// plus artifact presence/non-emptiness before manifest/.ready.
//
// Test-only overrides: `versionTagOverride` and `installCommandOverride`
// are plain optional function parameters with production defaults (null =
// resolve real version / run real bwrap seed). Never env vars, never global
// state, never supplied by any production call site.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {spawn, spawnSync} from "node:child_process";
import {resolveAgentBinary} from "./agent-process.mjs";

export const OPENCODE_CACHE_SANDBOX_PATH = "/autopilot/opencode-cache";
export const OPENCODE_CACHE_MODELS_SANDBOX_FILE = `${OPENCODE_CACHE_SANDBOX_PATH}/xdg-cache/opencode/models.json`;
export const OPENCODE_CACHE_ENV_MODELS_PATH = "OPENCODE_MODELS_PATH";
export const OPENCODE_CACHE_ENV_DISABLE_FETCH = "OPENCODE_DISABLE_MODELS_FETCH";

export const OPENCODE_CACHE_LOCK_WAIT_SECS = 600;
export const OPENCODE_CACHE_GC_TTL_SECS = 7 * 24 * 60 * 60;
// Backlog #1: the sandbox disables model fetching, so a structurally valid
// snapshot can still be functionally stale. Refresh the catalog after this
// age (or immediately when a role needs a model the catalog lacks).
export const OPENCODE_CACHE_MODELS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const OPENCODE_CACHE_SEED_PHASE_TIMEOUT_SECS = 120;
export const OPENCODE_CACHE_SEED_OVERALL_TIMEOUT_SECS = 300;

export function defaultOpenCodeCacheRoot() {
  return path.join(os.homedir(), ".cache", "autopilot", "opencode-shared-cache");
}

export function resolveOpenCodeVersion(versionTagOverride = null) {
  if (typeof versionTagOverride === "string" && versionTagOverride.length > 0) return versionTagOverride;
  try {
    const binary = fs.realpathSync(resolveAgentBinary("opencode"));
    const probe = spawnSync(binary, ["--version"], {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: false, timeout: 30000});
    if (probe.status !== 0) return null;
    const line = String(probe.stdout || probe.stderr || "").trim().split(/\r?\n/)[0]?.trim();
    return line ? line : null;
  } catch {
    return null;
  }
}

function isNonEmptyFile(candidate) {
  try {
    const st = fs.statSync(candidate);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isExecutableFile(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return isNonEmptyFile(candidate);
  } catch {
    return false;
  }
}

function readManifestVersion(snapshotDir) {
  try {
    const raw = fs.readFileSync(path.join(snapshotDir, "manifest.json"), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

// Three-part validity predicate, used identically everywhere: (1) .ready
// marker present, (2) manifest version exactly equals wantVersion, (3) every
// required artifact present with file artifacts non-empty.
export function isValidOpenCodeSnapshot(snapshotDir, wantVersion) {
  try {
    const st = fs.statSync(snapshotDir);
    if (!st.isDirectory()) return false;
  } catch {
    return false;
  }
  try {
    fs.accessSync(path.join(snapshotDir, ".ready"), fs.constants.F_OK);
  } catch {
    return false;
  }
  if (readManifestVersion(snapshotDir) !== wantVersion) return false;
  if (!isNonEmptyFile(path.join(snapshotDir, "xdg-cache", "opencode", "models.json"))) return false;
  if (!isDirectory(path.join(snapshotDir, "xdg-cache", "opencode", "bin"))) return false;
  if (!isExecutableFile(path.join(snapshotDir, "xdg-cache", "opencode", "bin", "rg"))) return false;
  if (!isDirectory(path.join(snapshotDir, "xdg-cache", "opencode", "packages"))) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Backlog #1: catalog freshness. The shared snapshot is keyed only by the
// opencode version, so `models.json` otherwise never changes while that
// version stays put. A sandboxed read-only role then fails with
// ProviderModelNotFoundError for any model added to the host catalog since
// the snapshot was seeded. These helpers are read-only and cheap (one stat,
// plus a JSON parse only when the caller actually names required models).
// ---------------------------------------------------------------------------
export function readOpenCodeCatalogModelIds(modelsFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(modelsFile, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const provider = parsed.opencode;
    const models = provider && typeof provider === "object" && provider.models && typeof provider.models === "object" && !Array.isArray(provider.models)
      ? provider.models
      : (parsed.models && typeof parsed.models === "object" && !Array.isArray(parsed.models) ? parsed.models : null);
    if (!models) return null;
    return new Set(Object.keys(models));
  } catch {
    return null;
  }
}

// Accepts either bare ids ("deepseek-v4.1-flash-free"), prefixed ids
// ("opencode/..."), or {adapter, model} role/fallback entries. Anything that
// is not an opencode model is ignored — this cache only serves that provider.
export function normalizeOpenCodeModelList(requiredModels) {
  const out = new Set();
  for (const entry of Array.isArray(requiredModels) ? requiredModels : []) {
    let adapter = null;
    let model = entry;
    if (entry && typeof entry === "object") {
      adapter = entry.adapter;
      model = entry.model;
    }
    if (typeof model !== "string" || !model) continue;
    let provider = null;
    let id = model;
    const slash = model.indexOf("/");
    if (slash > 0) {
      provider = model.slice(0, slash);
      id = model.slice(slash + 1);
    }
    if (adapter && adapter !== "opencode") continue;
    if (provider && provider !== "opencode") continue;
    if (id) out.add(id);
  }
  return [...out].sort();
}

function snapshotModelInfo(snapshotDir, {parse = true} = {}) {
  const modelsFile = path.join(snapshotDir, "xdg-cache", "opencode", "models.json");
  let mtimeMs = null;
  try {
    mtimeMs = fs.statSync(modelsFile).mtimeMs;
  } catch {
    // Missing artifact: validity already fails; freshness reports it stale.
  }
  return {modelsFile, mtimeMs, models: parse && mtimeMs != null ? readOpenCodeCatalogModelIds(modelsFile) : null};
}

function missingOpenCodeModels(models, required) {
  if (!required.length) return [];
  if (!models) return [...required];
  return required.filter(id => !models.has(id));
}

function snapshotFreshness(snapshotDir, required, nowMs = Date.now()) {
  const needModels = required.length > 0;
  const info = snapshotModelInfo(snapshotDir, {parse: needModels});
  if (info.mtimeMs == null) {
    return {stale: true, reason: "models_missing", info, missing: [...required]};
  }
  if (nowMs - info.mtimeMs > OPENCODE_CACHE_MODELS_MAX_AGE_MS) {
    return {stale: true, reason: "models_older_than_24h", info, missing: needModels ? missingOpenCodeModels(info.models, required) : []};
  }
  if (needModels) {
    const missing = missingOpenCodeModels(info.models, required);
    if (missing.length) return {stale: true, reason: "required_models_missing", info, missing};
  }
  return {stale: false, reason: null, info, missing: []};
}

// Read-only inspection used by `ap run` preflight: never seeds, never
// refreshes, returns the ids currently visible inside the sandbox.
export function openCodeSandboxCatalog({cacheRoot = null} = {}) {
  const root = cacheRoot || defaultOpenCodeCacheRoot();
  const current = resolveCurrentSnapshot(root);
  if (!current) return {snapshotDir: null, models: null};
  return {snapshotDir: current, models: snapshotModelInfo(current, {parse: true}).models};
}

function openCodeCacheWarning(missing, reason) {
  const names = (missing || []).map(id => `opencode/${id}`);
  const detail = names.length ? `missing ${names.join(", ")}` : `stale (${reason || "unknown"})`;
  return `OpenCode shared-cache models.json is ${detail}; the sandboxed read-only role may fail with ProviderModelNotFoundError. Keeping the current snapshot.`;
}

// Attach a single, clear warning to a result that keeps (or fails to provide)
// a snapshot. Called on every relay launch, so a persistent problem is
// visible each time without changing the cache state.
function withOpenCodeCacheWarning(result, snapshotDir, required, reason) {
  if (!result) return result;
  if (!snapshotDir) {
    if (!required.length) return result;
    const missing = [...required];
    return {...result, warning: {kind: "opencode_cache_models", models: missing.map(id => `opencode/${id}`), reason, message: openCodeCacheWarning(missing, reason)}};
  }
  const info = snapshotModelInfo(snapshotDir, {parse: required.length > 0});
  const missing = missingOpenCodeModels(info.models, required);
  const stale = required.length > 0
    ? (info.models == null || missing.length > 0)
    : (info.mtimeMs == null || Date.now() - info.mtimeMs > OPENCODE_CACHE_MODELS_MAX_AGE_MS);
  if (!stale && !missing.length) return result;
  return {...result, warning: {kind: "opencode_cache_models", models: missing.map(id => `opencode/${id}`), reason, message: openCodeCacheWarning(missing, reason)}};
}

// Cheap refresh: clone a valid snapshot into a temp build dir, replace its
// models.json with the host's (only when the host file is strictly newer and
// contains every required model), validate, then publish through the normal
// lifecycle. The source snapshot is never edited in place; publishSnapshot
// stamps the superseded current with .retired-at for the existing GC rules.
function refreshSnapshotFromHost({cacheRoot, version, baseSnapshot, required, hostModelsPath}) {
  const hostFile = hostModelsPath || path.join(os.homedir(), ".cache", "opencode", "models.json");
  let hostMtimeMs = null;
  try {
    hostMtimeMs = fs.statSync(hostFile).mtimeMs;
  } catch {
    return {attempted: false, reason: "host_models_missing"};
  }
  const baseInfo = snapshotModelInfo(baseSnapshot, {parse: false});
  if (baseInfo.mtimeMs != null && hostMtimeMs <= baseInfo.mtimeMs) {
    return {attempted: false, reason: "host_models_not_newer"};
  }
  const hostModels = readOpenCodeCatalogModelIds(hostFile);
  if (!hostModels) return {attempted: false, reason: "host_models_unparseable"};
  const missingHost = missingOpenCodeModels(hostModels, required);
  if (missingHost.length) return {attempted: false, reason: "host_models_missing_required", missing: missingHost};
  const tmpDir = path.join(cacheRoot, `.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  try {
    fs.cpSync(baseSnapshot, tmpDir, {recursive: true, dereference: true});
    for (const stale of [".ready", "manifest.json", ".retired-at"]) {
      try { fs.rmSync(path.join(tmpDir, stale), {force: true}); } catch {}
    }
    fs.copyFileSync(hostFile, path.join(tmpDir, "xdg-cache", "opencode", "models.json"));
    if (!snapshotHasPublishArtifacts(tmpDir)) throw new Error("refresh_artifact_validation_failed");
    const copiedInfo = snapshotModelInfo(tmpDir, {parse: true});
    const missingCopied = missingOpenCodeModels(copiedInfo.models, required);
    if (missingCopied.length) throw new Error(`refresh_missing_models:${missingCopied.join(",")}`);
    const published = publishSnapshot({cacheRoot, tmpDir, version});
    if (path.resolve(baseSnapshot) !== path.resolve(published)) stampRetired(baseSnapshot);
    collectOpenCodeCacheGarbage(cacheRoot);
    return {attempted: true, ok: true, snapshotDir: published, reason: "refreshed_from_host"};
  } catch (error) {
    try { fs.rmSync(tmpDir, {recursive: true, force: true}); } catch {}
    return {attempted: true, ok: false, reason: `refresh_failed:${error?.message || "unknown"}`};
  }
}

function repointCurrentSnapshot(cacheRoot, candidate) {
  const tmpLink = path.join(cacheRoot, `.current.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  try {
    fs.symlinkSync(candidate, tmpLink);
    fs.renameSync(tmpLink, path.join(cacheRoot, "current"));
  } finally {
    try { fs.rmSync(tmpLink, {force: true}); } catch {}
  }
  try { fs.rmSync(path.join(candidate, ".retired-at"), {force: true}); } catch {}
}

function resolveCurrentSnapshot(cacheRoot) {
  const link = path.join(cacheRoot, "current");
  try {
    return fs.realpathSync(link);
  } catch {
    return null;
  }
}

function listVersionSnapshots(cacheRoot) {
  const versionsDir = path.join(cacheRoot, "versions");
  let entries = [];
  try {
    entries = fs.readdirSync(versionsDir);
  } catch {
    return [];
  }
  return entries.map(name => path.join(versionsDir, name)).filter(candidate => {
    try {
      return fs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  });
}

function stampRetired(snapshotDir) {
  try {
    if (!fs.existsSync(path.join(snapshotDir, ".retired-at"))) {
      fs.writeFileSync(path.join(snapshotDir, ".retired-at"), `${Math.floor(Date.now() / 1000)}\n`);
    }
  } catch {
    // Best-effort bookkeeping only.
  }
}

function readRetiredAt(snapshotDir) {
  try {
    const raw = fs.readFileSync(path.join(snapshotDir, ".retired-at"), "utf8").trim();
    const secs = Number(raw.split(/\s/)[0]);
    return Number.isFinite(secs) ? secs : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Abandoned-temp cleanup under the exclusive lock: every
// <cache-root>/.tmp-<pid>-<rand>/ whose embedded pid fails kill -0 is
// rm -rf'd; live-pid entries are kept.
export function cleanAbandonedOpenCodeTempDirs(cacheRoot) {
  let entries = [];
  try {
    entries = fs.readdirSync(cacheRoot);
  } catch {
    return;
  }
  for (const name of entries) {
    // Stale mutex handshakes: only the lock holder's own handshake can exist
    // while this cleanup runs under the exclusive lock (a live waiter has
    // not acquired, so it has written nothing) — any file found here belongs
    // to a dead process and is safe to remove.
    if (name.startsWith(".lock-handshake-")) {
      try {
        fs.rmSync(path.join(cacheRoot, name), {force: true});
      } catch {
        // Best-effort.
      }
      continue;
    }
    if (!name.startsWith(".tmp-")) continue;
    const pidPart = name.slice(".tmp-".length).split("-")[0];
    const pid = Number(pidPart);
    if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) continue;
    try {
      fs.rmSync(path.join(cacheRoot, name), {recursive: true, force: true});
    } catch {
      // Best-effort.
    }
  }
  // Stale pin-acquisition handshakes (`.pin-handshake-<pid>-*` beside the
  // pin file): only a parent SIGKILL can leave these behind, since every
  // exit path removes its own. Sweep pid-gated — a live acquirer's pid
  // answers kill -0 and its file is kept, so concurrent pin acquisition
  // can never observe its handshake vanishing mid-poll.
  let versionDirs = [];
  try {
    versionDirs = fs.readdirSync(path.join(cacheRoot, "versions"));
  } catch {
    versionDirs = [];
  }
  for (const versionName of versionDirs) {
    let inner = [];
    try {
      inner = fs.readdirSync(path.join(cacheRoot, "versions", versionName));
    } catch {
      continue;
    }
    for (const innerName of inner) {
      if (!innerName.startsWith(".pin-handshake-")) continue;
      const pidPart = innerName.slice(".pin-handshake-".length).split("-")[0];
      const pid = Number(pidPart);
      if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) continue;
      try {
        fs.rmSync(path.join(cacheRoot, "versions", versionName, innerName), {force: true});
      } catch {
        // Best-effort.
      }
    }
  }
}

// Seed-failure negative cache. A persistently failing seed (offline CI,
// unreachable provider auth inside the seed sandbox, …) must not be
// re-run from scratch on every call — task 14 invokes the seeder
// synchronously before every opencode relay, so an unrecorded failure
// taxes every single run with the full seed cost. The under-lock failure
// exits therefore stamp `<root>/.last-seed-failure.json`
// ({version, at, reason}); entry points short-circuit while a marker for
// the same version is younger than the cooldown, serving the last valid
// snapshot (or unavailable) without spawning a seed. Success clears the
// marker. Markers are version-scoped, so a version flip always attempts a
// fresh seed.
export const OPENCODE_CACHE_SEED_FAILURE_COOLDOWN_SECS = 300;

function seedFailureMarkerPath(cacheRoot) {
  return path.join(cacheRoot, ".last-seed-failure.json");
}

function readSeedFailureMarker(cacheRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(seedFailureMarkerPath(cacheRoot), "utf8"));
    if (parsed && typeof parsed.version === "string" && Number.isFinite(Number(parsed.at))) {
      return {version: parsed.version, at: Number(parsed.at), reason: typeof parsed.reason === "string" ? parsed.reason : "unknown"};
    }
  } catch {
    // Missing or corrupt marker counts as absent.
  }
  return null;
}

function seedFailureMarkerFresh(marker, wantVersion, nowSecs = Math.floor(Date.now() / 1000)) {
  return !!marker && marker.version === wantVersion && (nowSecs - marker.at) < OPENCODE_CACHE_SEED_FAILURE_COOLDOWN_SECS;
}

function writeSeedFailureMarker(cacheRoot, wantVersion, reason) {
  try {
    fs.writeFileSync(seedFailureMarkerPath(cacheRoot), `${JSON.stringify({version: wantVersion, at: Math.floor(Date.now() / 1000), reason: String(reason || "unknown")})}\n`);
  } catch {
    // Best-effort bookkeeping only.
  }
}

function clearSeedFailureMarker(cacheRoot) {
  try {
    fs.rmSync(seedFailureMarkerPath(cacheRoot), {force: true});
  } catch {
    // Best-effort bookkeeping only.
  }
}

// Shared short-circuit: fresh failure marker for wantVersion and no valid
// current. Serves the last valid snapshot when one exists (mirroring the
// seed-failure fallback), otherwise unavailable — either way without
// re-running the seed.
function seedCooldownResult(cacheRoot, wantVersion) {
  if (!seedFailureMarkerFresh(readSeedFailureMarker(cacheRoot), wantVersion)) return null;
  const fallback = resolveCurrentSnapshot(cacheRoot);
  if (fallback) {
    const fallbackVersion = readManifestVersion(fallback);
    if (fallbackVersion && isValidOpenCodeSnapshot(fallback, fallbackVersion)) {
      return {ok: true, status: "ready", snapshotDir: fallback, version: fallbackVersion, reason: "seed_failed_cooldown_keep_current"};
    }
  }
  return {ok: false, status: "unavailable", snapshotDir: null, version: null, reason: "seed_failed_cooldown"};
}

// GC: deletion-eligible only when (a) not the resolved current target,
// (b) .retired-at older than TTL, (c) non-blocking exclusive flock on the
// snapshot's .pin-lock succeeds. Creation/mtime never consulted.
export function collectOpenCodeCacheGarbage(cacheRoot, nowSecs = Math.floor(Date.now() / 1000)) {
  const current = resolveCurrentSnapshot(cacheRoot);
  for (const snapshotDir of listVersionSnapshots(cacheRoot)) {
    if (current && path.resolve(snapshotDir) === path.resolve(current)) continue;
    const retiredAt = readRetiredAt(snapshotDir);
    if (retiredAt == null) continue;
    if (nowSecs - retiredAt < OPENCODE_CACHE_GC_TTL_SECS) continue;
    const pinFile = path.join(snapshotDir, ".pin-lock");
    try {
      if (!fs.existsSync(pinFile)) fs.writeFileSync(pinFile, "");
    } catch {
      continue;
    }
    const probe = spawnSync("flock", ["-n", "-x", pinFile, "true"], {stdio: "ignore", shell: false});
    if (probe.status !== 0) continue;
    try {
      fs.rmSync(snapshotDir, {recursive: true, force: true});
    } catch {
      // Best-effort.
    }
  }
}

// Flock mutex on <cache-root>/.lock, synchronous and safe to hold across
// blocking (spawnSync) critical sections. The holder child runs
// `flock -w <timeout> <lock> sh -c 'echo LOCKED > <handshake>; read _'`
// with stdin piped: it writes LOCKED to the handshake file only after the
// lock is acquired; exceeding the wait bound exits without writing LOCKED
// (clean failure, current untouched). The parent polls the handshake file
// with plain sync fs calls plus Atomics.wait sleeps — never stdout 'data'
// events or spawnSync sleeps, both of which deadlock against a blocked
// event loop. The kernel releases the lock when the holder exits; the
// parent keeps the stdin pipe open so a parent crash closes it and the
// holder's `read` sees EOF and exits promptly (no staleness/pid/fencing).
function sleepSyncMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Fallback if Atomics.wait is unavailable: busy-poll only.
  }
}

function flockBinaryAvailable() {
  try {
    const probe = spawnSync("flock", ["--version"], {stdio: "ignore", shell: false});
    return probe.status === 0 || probe.status === null;
  } catch {
    return false;
  }
}

// Synchronous holder-liveness check. The poll loops in this file block the
// main thread (Atomics.wait), so the child's 'exit' event never fires and
// `holder.exitCode` stays null while blocked — it must NOT be the liveness
// signal. On Linux, read /proc/<pid>/stat instead: a holder that already
// exited shows as zombie (Z) or its /proc entry vanishes entirely once
// reaped. Anywhere else, fall back to kill(pid, 0).
function holderDead(holder) {
  if (!holder) return true;
  if (holder.exitCode !== null && holder.exitCode !== undefined) return true;
  const pid = holder.pid;
  if (!pid) return true;
  if (process.platform === "linux") {
    let stat = null;
    try {
      stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch {
      return true;
    }
    const closeParen = stat.lastIndexOf(")");
    const state = closeParen >= 0 ? stat[closeParen + 2] : "";
    if (state === "Z" || state === "X" || state === "x") return true;
    return false;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

function acquireMutexSync(cacheRoot, waitSecs) {
  const lockFile = path.join(cacheRoot, ".lock");
  try {
    const fd = fs.openSync(lockFile, "a");
    fs.closeSync(fd);
  } catch {
    return {ok: false, reason: "lock_file_unwritable", holder: null};
  }
  if (!flockBinaryAvailable()) return {ok: false, reason: "lock_spawn_failed", holder: null};
  // The handshake lives in the cache root (proven writable above via the
  // .lock open) — never under os.tmpdir(), so a poisoned/missing TMPDIR
  // cannot wedge acquisition. Stale files are swept by
  // cleanAbandonedOpenCodeTempDirs(), which runs under this same lock.
  const handshake = path.join(cacheRoot, `.lock-handshake-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  let holder = null;
  try {
    // detached:true so release can signal the whole holder process group:
    // SIGTERM to the `flock` parent alone does not release the lock — the
    // `sh` child inherits the locked fd and keeps it open — so the group
    // must be signalled. Crash-safety is unchanged: the `read` still blocks
    // on the stdin pipe, and a dead parent closes it, delivering EOF.
    holder = spawn("flock", ["-w", String(waitSecs), lockFile, "sh", "-c", `echo LOCKED > ${JSON.stringify(handshake)}; read _`], {stdio: ["pipe", "ignore", "ignore"], shell: false, detached: true});
    if (holder.stdin) holder.stdin.on("error", () => {});
  } catch {
    try { fs.rmSync(handshake, {force: true}); } catch {}
    return {ok: false, reason: "lock_spawn_failed", holder: null};
  }
  const start = Date.now();
  const deadline = start + waitSecs * 1000 + 15000;
  let locked = false;
  let holderGone = false;
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(handshake) && fs.readFileSync(handshake, "utf8").includes("LOCKED")) {
        locked = true;
        break;
      }
    } catch {}
    // Sync-safe liveness: holder.exitCode never updates while this loop
    // blocks the event loop, so consult /proc instead. A holder that dies
    // at startup (immediate flock failure) is detected within one poll
    // instead of burning the full wait bound and misreporting a timeout.
    if (holderDead(holder)) {
      holderGone = true;
      break;
    }
    sleepSyncMs(50);
  }
  try { fs.rmSync(handshake, {force: true}); } catch {}
  if (locked) return {ok: true, reason: null, holder};
  killHolderGroup(holder);
  // A holder that died before the wait bound elapsed never contended — it
  // failed to start — so report that instead of a false lock_wait_timeout.
  if (holderGone && Date.now() - start < waitSecs * 1000) {
    return {ok: false, reason: "lock_holder_exited", holder: null};
  }
  return {ok: false, reason: "lock_wait_timeout", holder: null};
}

// Release a mutex/pin holder synchronously. Signals the whole process
// group (the `sh` lock-holder child inherits the locked fd, so signalling
// only the `flock` parent leaks the lock), closes the stdin pipe so a
// surviving `read` still sees EOF, and waits briefly for death. The kernel
// releases the flock the moment the last holder dies — zombie reaping via
// the event loop is not required for the lock itself to free.
function killHolderGroup(holder) {
  if (!holder) return;
  try {
    if (holder.stdin && !holder.stdin.destroyed) holder.stdin.end();
  } catch {}
  try {
    if (holder.stdin && !holder.stdin.destroyed) holder.stdin.destroy();
  } catch {}
  const pid = holder.pid;
  if (pid) {
    try { process.kill(pid, "SIGTERM"); } catch {}
    try { process.kill(-pid, "SIGTERM"); } catch {}
    sleepSyncMs(200);
    try { process.kill(pid, "SIGKILL"); } catch {}
    try { process.kill(-pid, "SIGKILL"); } catch {}
    sleepSyncMs(200);
  } else {
    try { holder.kill("SIGTERM"); } catch {}
  }
}

function releaseMutex(holder) {
  killHolderGroup(holder);
}

function systemMountsForSeed() {
  return ["/usr", "/bin", "/sbin", "/lib", "/lib64"].filter(candidate => {
    try { return fs.existsSync(candidate); } catch { return false; }
  });
}

function seedEtcArgs(bwrapArgs) {
  // Child-by-child /etc bind with the real resolv.conf target so DNS keeps
  // working inside the seed sandbox (whole-/etc bind leaves a dangling
  // resolv.conf symlink on WSL/systemd-resolved hosts).
  try {
    if (!fs.existsSync("/etc")) return;
    const resolvConf = "/etc/resolv.conf";
    let override = null;
    try {
      if (fs.existsSync(resolvConf)) {
        const target = fs.realpathSync(resolvConf);
        const mounts = systemMountsForSeed();
        if (!mounts.some(m => {
          const rel = path.relative(m, target);
          return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
        }) && fs.existsSync(target)) override = target;
      }
    } catch {}
    if (override) {
      bwrapArgs.push("--dir", "/etc");
      for (const entry of fs.readdirSync("/etc")) {
        if (entry === "resolv.conf") continue;
        bwrapArgs.push("--ro-bind", path.join("/etc", entry), `/etc/${entry}`);
      }
      bwrapArgs.push("--ro-bind", override, "/etc/resolv.conf");
    } else {
      bwrapArgs.push("--ro-bind", "/etc", "/etc");
    }
  } catch {}
}

function resolveSeedBinary() {
  const resolved = resolveAgentBinary("opencode");
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function runSeedPhase({sandboxBinary, seedArgs, stdinData, configContent, tmpDir, phaseTimeoutSecs}) {
  const bwrapArgs = ["--die-with-parent", "--new-session", "--unshare-all", "--share-net"];
  for (const mount of systemMountsForSeed()) bwrapArgs.push("--ro-bind", mount, mount);
  seedEtcArgs(bwrapArgs);
  bwrapArgs.push("--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", "/run", "--tmpfs", "/home", "--tmpfs", "/root");
  bwrapArgs.push("--bind", tmpDir, tmpDir, "--setenv", "HOME", tmpDir, "--setenv", "TMPDIR", "/tmp", "--setenv", "LANG", "C.UTF-8", "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin");
  const realBinary = resolveSeedBinary();
  bwrapArgs.push("--ro-bind", realBinary, "/autopilot/bin-opencode");
  try {
    const siblingModules = path.join(path.dirname(realBinary), "..", "node_modules");
    const resolvedSiblings = fs.realpathSync(path.join(path.dirname(realBinary), "..", "node_modules"));
    if (fs.existsSync(resolvedSiblings)) bwrapArgs.push("--ro-bind", resolvedSiblings, "/autopilot/seed-node-modules");
  } catch {}
  try {
    const homeInstall = path.join(os.homedir(), ".opencode", "node_modules");
    if (fs.existsSync(homeInstall)) bwrapArgs.push("--ro-bind", fs.realpathSync(homeInstall), "/autopilot/seed-home-modules");
  } catch {}
  bwrapArgs.push("--chdir", tmpDir, "--");
  bwrapArgs.push("timeout", String(phaseTimeoutSecs), "/autopilot/bin-opencode", ...seedArgs);
  const env = {PATH: "/usr/local/bin:/usr/bin:/bin", HOME: tmpDir, TMPDIR: "/tmp", LANG: "C.UTF-8"};
  if (configContent) env.OPENCODE_CONFIG_CONTENT = configContent;
  const result = spawnSync("bwrap", bwrapArgs, {encoding: "utf8", input: stdinData ?? undefined, env, shell: false, timeout: (phaseTimeoutSecs + 10) * 1000, maxBuffer: 16 * 1024 * 1024});
  return result;
}

function seedReadOnlyAgentConfig() {
  return JSON.stringify({snapshot: false, agent: {autopilot_readonly: {
    mode: "primary",
    description: "Autopilot cache-seed relay role.",
    tools: {invalid: true, question: true, bash: true, read: true, glob: true, grep: true, edit: true, write: true, task: true, webfetch: true, todowrite: true, websearch: true, skill: true},
    permission: {edit: {"/workspace/scratch/**": "allow"}, external_directory: {"/workspace/scratch/**": "allow"}}
  }}});
}

// Real bwrap-contained three-phase seed (npm-free): models, production-shaped
// run, grep-using run capturing bin/rg. Returns {ok, reason}.
function runRealSeed(tmpDir) {
  const overallDeadline = Date.now() + OPENCODE_CACHE_SEED_OVERALL_TIMEOUT_SECS * 1000;
  const remainingSecs = () => Math.max(1, Math.floor((overallDeadline - Date.now()) / 1000));
  // Phase 1: models catalog fetch into staging HOME.
  {
    const r = runSeedPhase({tmpDir, seedArgs: ["models"], stdinData: null, configContent: null, phaseTimeoutSecs: Math.min(OPENCODE_CACHE_SEED_PHASE_TIMEOUT_SECS, remainingSecs())});
    if (r.status !== 0) return {ok: false, reason: `seed_models_exit_${r.status ?? r.signal ?? "unknown"}`};
  }
  // Phase 2: production-shaped run validating the run path end to end.
  {
    const config = seedReadOnlyAgentConfig();
    const r = runSeedPhase({tmpDir, seedArgs: ["run", "--format", "json", "--agent", "autopilot_readonly"], stdinData: "Reply with exactly the single line SEED-OK and call no tools.\n", configContent: config, phaseTimeoutSecs: Math.min(OPENCODE_CACHE_SEED_PHASE_TIMEOUT_SECS, remainingSecs())});
    if (r.status !== 0) return {ok: false, reason: `seed_run_exit_${r.status ?? r.signal ?? "unknown"}`};
  }
  // Phase 3: grep-using run capturing the CLI-downloaded bin/rg.
  try {
    fs.writeFileSync(path.join(tmpDir, "seed-marker.txt"), "seed-marker-ripgrep-probe-001\n");
  } catch {
    return {ok: false, reason: "seed_marker_write_failed"};
  }
  {
    const config = seedReadOnlyAgentConfig();
    const r = runSeedPhase({tmpDir, seedArgs: ["run", "--format", "json", "--agent", "autopilot_readonly"], stdinData: "Use the grep tool to search for 'seed-marker-ripgrep-probe-001' in the current directory, then reply with exactly SEED-GREP-OK.\n", configContent: config, phaseTimeoutSecs: Math.min(OPENCODE_CACHE_SEED_PHASE_TIMEOUT_SECS, remainingSecs())});
    if (r.status !== 0) return {ok: false, reason: `seed_grep_exit_${r.status ?? r.signal ?? "unknown"}`};
  }
  if (Date.now() > overallDeadline) return {ok: false, reason: "seed_overall_timeout"};
  return {ok: true, reason: null};
}

function runOverrideSeed(tmpDir, installCommandOverride) {
  const env = {PATH: "/usr/local/bin:/usr/bin:/bin", HOME: tmpDir, TMPDIR: "/tmp", LANG: "C.UTF-8"};
  // Argv-array only: the caller supplies an explicit executable plus args,
  // run directly with shell:false. A bare shell string is rejected rather
  // than passed through `sh -c`, so this module never contains a dynamic
  // shell invocation (see scripts/test-no-unguarded-shell.mjs).
  if (!Array.isArray(installCommandOverride) || installCommandOverride.length === 0 || typeof installCommandOverride[0] !== "string" || installCommandOverride[0].length === 0) {
    return {ok: false, reason: "seed_override_malformed"};
  }
  const [cmd, ...rest] = installCommandOverride;
  const result = spawnSync(cmd, rest, {cwd: tmpDir, env, encoding: "utf8", shell: false, timeout: OPENCODE_CACHE_SEED_OVERALL_TIMEOUT_SECS * 1000});
  if (result.status !== 0) return {ok: false, reason: `seed_override_exit_${result.status ?? result.signal ?? "unknown"}`};
  return {ok: true, reason: null};
}

function stagingHasArtifacts(tmpDir) {
  if (!isNonEmptyFile(path.join(tmpDir, ".cache", "opencode", "models.json"))) return false;
  if (!isExecutableFile(path.join(tmpDir, ".cache", "opencode", "bin", "rg"))) return false;
  return true;
}

function promoteStagingToSnapshot(tmpDir) {
  const dest = path.join(tmpDir, "xdg-cache", "opencode");
  fs.mkdirSync(path.join(dest, "bin"), {recursive: true});
  fs.mkdirSync(path.join(dest, "packages"), {recursive: true});
  fs.copyFileSync(path.join(tmpDir, ".cache", "opencode", "models.json"), path.join(dest, "models.json"));
  fs.copyFileSync(path.join(tmpDir, ".cache", "opencode", "bin", "rg"), path.join(dest, "bin", "rg"));
  try {
    fs.chmodSync(path.join(dest, "bin", "rg"), 0o755);
  } catch {}
  for (const stale of [".cache", ".config", ".local", ".npm", "seed-marker.txt"]) {
    try {
      fs.rmSync(path.join(tmpDir, stale), {recursive: true, force: true});
    } catch {}
  }
}

function snapshotHasPublishArtifacts(tmpDir) {
  if (!isNonEmptyFile(path.join(tmpDir, "xdg-cache", "opencode", "models.json"))) return false;
  if (!isExecutableFile(path.join(tmpDir, "xdg-cache", "opencode", "bin", "rg"))) return false;
  if (!isDirectory(path.join(tmpDir, "xdg-cache", "opencode", "packages"))) return false;
  return true;
}

// Publish: manifest + .ready written before the versioned rename; rename to
// a novel versions/<tag>__<gen>/ target; atomic current swap via
// temp-symlink-then-rename; .retired-at on the superseded snapshot when
// versions differ.
function publishSnapshot({cacheRoot, tmpDir, version}) {
  const versionsDir = path.join(cacheRoot, "versions");
  fs.mkdirSync(versionsDir, {recursive: true});
  fs.writeFileSync(path.join(tmpDir, "manifest.json"), `${JSON.stringify({version})}\n`);
  try {
    if (!fs.existsSync(path.join(tmpDir, ".pin-lock"))) fs.writeFileSync(path.join(tmpDir, ".pin-lock"), "");
  } catch {}
  fs.writeFileSync(path.join(tmpDir, ".ready"), `${Date.now()}\n`);
  let target = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const gen = crypto.randomBytes(8).toString("hex");
    const candidate = path.join(versionsDir, `${version}__${gen}`);
    if (!fs.existsSync(candidate)) {
      target = candidate;
      break;
    }
  }
  if (!target) throw new Error("opencode cache publish: could not mint a novel generation suffix");
  fs.renameSync(tmpDir, target);
  const link = path.join(cacheRoot, "current");
  let previous = null;
  try {
    previous = fs.realpathSync(link);
  } catch {
    previous = null;
  }
  const tmpLink = path.join(cacheRoot, `.current.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  try {
    fs.symlinkSync(target, tmpLink);
    fs.renameSync(tmpLink, link);
  } finally {
    try { fs.rmSync(tmpLink, {force: true}); } catch {}
  }
  // The superseded snapshot is always retired (timestamped for GC),
  // whether it carried the same version or an older one — a repoint can
  // only ever bring it back via the valid-but-not-current path, which
  // clears the marker.
  if (previous && path.resolve(previous) !== path.resolve(target)) {
    stampRetired(previous);
  }
  return target;
}

// Host-side seeding entry point. Fully synchronous from the caller's
// perspective (spawnSync throughout; the mutex holder handshake is polled
// with sync fs reads plus Atomics.wait sleeps, never event-loop callbacks).
// A recent seed failure for the same version short-circuits via the
// failure-cooldown marker (no mutex wait, no seed rerun); a version flip
// always attempts a fresh seed.
//
// Options (all plain parameters, production defaults when omitted):
//   cacheRoot: host cache root (default defaultOpenCodeCacheRoot()).
//   versionTagOverride: test-only resolved-version override.
//   installCommandOverride: test-only seed replacement (argv array
//     [exe, ...args]) executed with HOME=tmpDir instead of the real bwrap
//     seed. Bare shell strings are rejected, never run via `sh -c`.
//   lockWaitTimeoutSecs: test-only mutex wait bound (default 600).
//   requiredModels: opencode model ids (or {adapter,model} entries) this
//     launch will use. When any is absent — or models.json is older than
//     24 h — the snapshot is refreshed before it is returned.
//   hostModelsPath: test-only host catalog override (default
//     ~/.cache/opencode/models.json).
export function ensureOpenCodeCacheSeeded({cacheRoot = null, versionTagOverride = null, installCommandOverride = null, lockWaitTimeoutSecs = OPENCODE_CACHE_LOCK_WAIT_SECS, requiredModels = [], hostModelsPath = null} = {}) {
  const root = cacheRoot || defaultOpenCodeCacheRoot();
  const required = normalizeOpenCodeModelList(requiredModels);
  try {
    fs.mkdirSync(path.join(root, "versions"), {recursive: true});
  } catch {
    return {ok: false, status: "unavailable", snapshotDir: null, version: null, reason: "cache_root_unwritable"};
  }
  const wantVersion = resolveOpenCodeVersion(versionTagOverride);
  if (!wantVersion) {
    const fallback = resolveCurrentSnapshot(root);
    if (fallback && isValidOpenCodeSnapshot(fallback, readManifestVersion(fallback))) {
      return withOpenCodeCacheWarning({ok: true, status: "ready", snapshotDir: fallback, version: readManifestVersion(fallback), reason: "version_unresolved_fallback"}, fallback, required, "version_unresolved");
    }
    return withOpenCodeCacheWarning({ok: false, status: "unavailable", snapshotDir: null, version: null, reason: "version_unresolved"}, null, required, "version_unresolved");
  }
  // Fast-path no-lock check: structurally valid AND fresh for this launch.
  const fastCurrent = resolveCurrentSnapshot(root);
  if (fastCurrent && isValidOpenCodeSnapshot(fastCurrent, wantVersion) && !snapshotFreshness(fastCurrent, required).stale) {
    return {ok: true, status: "ready", snapshotDir: fastCurrent, version: wantVersion, reason: "no-op"};
  }
  // Failure-cooldown short-circuit: a recent seed failure for this version
  // skips both the mutex wait and the seed rerun entirely.
  const cooldownFast = seedCooldownResult(root, wantVersion);
  if (cooldownFast) return withOpenCodeCacheWarning(cooldownFast, cooldownFast.snapshotDir, required, "seed_failed_cooldown");
  // Acquire the flock mutex (blocking handshake).
  const acquired = acquireMutexSync(root, lockWaitTimeoutSecs);
  if (!acquired.ok) {
    return withOpenCodeCacheWarning({ok: false, status: "unavailable", snapshotDir: fastCurrent, version: null, reason: acquired.reason}, fastCurrent, required, acquired.reason);
  }
  try {
    return ensureOpenCodeCacheSeededUnderLock({root, wantVersion, installCommandOverride, required, hostModelsPath});
  } finally {
    releaseMutex(acquired.holder);
  }
}

function ensureOpenCodeCacheSeededUnderLock({root, wantVersion, installCommandOverride, required, hostModelsPath}) {
  cleanAbandonedOpenCodeTempDirs(root);
  // Double-checked re-evaluation under the lock.
  const lockedCurrent = resolveCurrentSnapshot(root);
  const lockedCurrentValid = !!lockedCurrent && isValidOpenCodeSnapshot(lockedCurrent, wantVersion);
  if (lockedCurrentValid) {
    if (!snapshotFreshness(lockedCurrent, required).stale) {
      clearSeedFailureMarker(root);
      return {ok: true, status: "ready", snapshotDir: lockedCurrent, version: wantVersion, reason: "no-op-under-lock"};
    }
    // Valid but stale: try the cheap host-catalog refresh first. If the host
    // file is not newer or lacks a required model this is a no-op and the
    // existing seed path below runs instead.
    const refreshed = refreshSnapshotFromHost({cacheRoot: root, version: wantVersion, baseSnapshot: lockedCurrent, required, hostModelsPath});
    if (refreshed.ok) {
      clearSeedFailureMarker(root);
      return {ok: true, status: "ready", snapshotDir: refreshed.snapshotDir, version: wantVersion, reason: refreshed.reason};
    }
    if (refreshed.attempted) {
      // A copy was attempted and failed: keep the current snapshot and warn
      // instead of paying for a full seed on every relay launch.
      writeSeedFailureMarker(root, wantVersion, refreshed.reason);
      collectOpenCodeCacheGarbage(root);
      return withOpenCodeCacheWarning({ok: true, status: "ready", snapshotDir: lockedCurrent, version: wantVersion, reason: `refresh_failed_keep_current:${refreshed.reason}`}, lockedCurrent, required, refreshed.reason);
    }
  }
  // A concurrent holder may have just failed and stamped the marker while
  // this caller waited on the mutex — re-check the cooldown before paying
  // for another seed.
  const cooldownLocked = seedCooldownResult(root, wantVersion);
  if (cooldownLocked) return withOpenCodeCacheWarning(cooldownLocked, cooldownLocked.snapshotDir, required, "seed_failed_cooldown");
  // Valid-but-not-current repoint (never an invalid target). Prefer a fresh
  // candidate; a stale one is only usable as a refresh base below.
  const validCandidates = listVersionSnapshots(root).filter(candidate => {
    if (lockedCurrent && path.resolve(candidate) === path.resolve(lockedCurrent)) return false;
    return isValidOpenCodeSnapshot(candidate, wantVersion);
  });
  for (const candidate of validCandidates) {
    if (snapshotFreshness(candidate, required).stale) continue;
    repointCurrentSnapshot(root, candidate);
    collectOpenCodeCacheGarbage(root);
    clearSeedFailureMarker(root);
    return {ok: true, status: "ready", snapshotDir: fs.realpathSync(path.join(root, "current")), version: wantVersion, reason: "repoint"};
  }
  // The current is not usable for this version, but a valid (stale)
  // candidate is a better refresh base than a fresh seed. Try it; on a
  // failed copy repoint to it (still better than nothing) and warn.
  if (!lockedCurrentValid && validCandidates.length > 0) {
    const base = validCandidates[0];
    const refreshed = refreshSnapshotFromHost({cacheRoot: root, version: wantVersion, baseSnapshot: base, required, hostModelsPath});
    if (refreshed.ok) {
      clearSeedFailureMarker(root);
      return {ok: true, status: "ready", snapshotDir: refreshed.snapshotDir, version: wantVersion, reason: refreshed.reason};
    }
    if (refreshed.attempted) {
      repointCurrentSnapshot(root, base);
      writeSeedFailureMarker(root, wantVersion, refreshed.reason);
      collectOpenCodeCacheGarbage(root);
      return withOpenCodeCacheWarning({ok: true, status: "ready", snapshotDir: base, version: wantVersion, reason: `refresh_failed_keep_current:${refreshed.reason}`}, base, required, refreshed.reason);
    }
  }
  // Stamp invalid snapshots with .retired-at so GC stays
  // retirement-time-based without introducing a creation-time path.
  for (const candidate of listVersionSnapshots(root)) {
    if (!isValidOpenCodeSnapshot(candidate, wantVersion)) stampRetired(candidate);
  }
  // Build in a temp dir, then validate, then publish.
  const tmpDir = path.join(root, `.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(tmpDir, {recursive: true});
  let seedResult;
  try {
    seedResult = installCommandOverride != null ? runOverrideSeed(tmpDir, installCommandOverride) : runRealSeed(tmpDir);
  } catch (error) {
    seedResult = {ok: false, reason: `seed_threw_${error?.message || "unknown"}`};
  }
  if (!seedResult.ok) {
    try { fs.rmSync(tmpDir, {recursive: true, force: true}); } catch {}
    // Record the failure so repeat callers within the cooldown serve the
    // fallback (or unavailable) without re-running the seed from scratch.
    writeSeedFailureMarker(root, wantVersion, seedResult.reason);
    const fallback = resolveCurrentSnapshot(root);
    if (fallback) {
      const fallbackVersion = readManifestVersion(fallback);
      if (fallbackVersion && isValidOpenCodeSnapshot(fallback, fallbackVersion)) {
        collectOpenCodeCacheGarbage(root);
        return withOpenCodeCacheWarning({ok: true, status: "ready", snapshotDir: fallback, version: fallbackVersion, reason: `seed_failed_keep_current:${seedResult.reason}`}, fallback, required, seedResult.reason);
      }
    }
    collectOpenCodeCacheGarbage(root);
    return withOpenCodeCacheWarning({ok: false, status: "unavailable", snapshotDir: null, version: null, reason: seedResult.reason}, null, required, seedResult.reason);
  }
  // Pre-publish validation inside the temp build dir (same legs minus
  // .ready), then promote staging into the snapshot layout.
  try {
    if (installCommandOverride == null) {
      if (!stagingHasArtifacts(tmpDir)) throw new Error("seed_artifact_validation_failed");
      promoteStagingToSnapshot(tmpDir);
    } else if (!snapshotHasPublishArtifacts(tmpDir) && !stagingHasArtifacts(tmpDir)) {
      throw new Error("seed_artifact_validation_failed");
    } else if (!snapshotHasPublishArtifacts(tmpDir)) {
      promoteStagingToSnapshot(tmpDir);
    }
    if (!snapshotHasPublishArtifacts(tmpDir)) throw new Error("seed_artifact_validation_failed");
  } catch (error) {
    try { fs.rmSync(tmpDir, {recursive: true, force: true}); } catch {}
    writeSeedFailureMarker(root, wantVersion, error?.message || "seed_artifact_validation_failed");
    const fallback = resolveCurrentSnapshot(root);
    if (fallback) {
      const fallbackVersion = readManifestVersion(fallback);
      if (fallbackVersion && isValidOpenCodeSnapshot(fallback, fallbackVersion)) {
        return withOpenCodeCacheWarning({ok: true, status: "ready", snapshotDir: fallback, version: fallbackVersion, reason: `seed_invalid_keep_current:${error?.message || "unknown"}`}, fallback, required, error?.message || "seed_artifact_validation_failed");
      }
    }
    return withOpenCodeCacheWarning({ok: false, status: "unavailable", snapshotDir: null, version: null, reason: error?.message || "seed_artifact_validation_failed"}, null, required, error?.message || "seed_artifact_validation_failed");
  }
  // Backlog #1: a successful seed can still produce a catalog missing a
  // model this launch needs (provider removed it, seed sandbox fetched an
  // older list, …). Never publish such a snapshot — keep the current one
  // and name the missing model(s) in the warning instead.
  const seededInfo = snapshotModelInfo(tmpDir, {parse: required.length > 0});
  const missingSeeded = missingOpenCodeModels(seededInfo.models, required);
  if (missingSeeded.length) {
    try { fs.rmSync(tmpDir, {recursive: true, force: true}); } catch {}
    const reason = `seed_missing_models:${missingSeeded.join(",")}`;
    writeSeedFailureMarker(root, wantVersion, reason);
    const fallback = resolveCurrentSnapshot(root);
    if (fallback) {
      const fallbackVersion = readManifestVersion(fallback);
      if (fallbackVersion && isValidOpenCodeSnapshot(fallback, fallbackVersion)) {
        collectOpenCodeCacheGarbage(root);
        return withOpenCodeCacheWarning({ok: true, status: "ready", snapshotDir: fallback, version: fallbackVersion, reason: `${reason}_keep_current`}, fallback, required, reason);
      }
    }
    collectOpenCodeCacheGarbage(root);
    return withOpenCodeCacheWarning({ok: false, status: "unavailable", snapshotDir: null, version: null, reason}, null, required, reason);
  }
  let published;
  try {
    published = publishSnapshot({cacheRoot: root, tmpDir, version: wantVersion});
  } catch (error) {
    try { fs.rmSync(tmpDir, {recursive: true, force: true}); } catch {}
    writeSeedFailureMarker(root, wantVersion, error?.message || "publish_failed");
    const fallback = resolveCurrentSnapshot(root);
    if (fallback) {
      const fallbackVersion = readManifestVersion(fallback);
      if (fallbackVersion && isValidOpenCodeSnapshot(fallback, fallbackVersion)) {
        return withOpenCodeCacheWarning({ok: true, status: "ready", snapshotDir: fallback, version: fallbackVersion, reason: `publish_failed_keep_current:${error?.message || "unknown"}`}, fallback, required, error?.message || "publish_failed");
      }
    }
    return withOpenCodeCacheWarning({ok: false, status: "unavailable", snapshotDir: null, version: null, reason: error?.message || "publish_failed"}, null, required, error?.message || "publish_failed");
  }
  collectOpenCodeCacheGarbage(root);
  clearSeedFailureMarker(root);
  return {ok: true, status: "ready", snapshotDir: published, version: wantVersion, reason: "published"};
}

// Per-snapshot shared pin lock for the task 14 call site. The holder keeps
// a `flock -s` on the snapshot's .pin-lock for the full sandboxed-process
// lifetime; GC's non-blocking exclusive flock can only succeed when no live
// run holds a pin. Throws ENOENT when the snapshot or pin file is missing
// so the caller can re-resolve `current` and retry with a bounded count.
export function acquireOpenCodeCachePin(snapshotDir, waitSecs = 30) {
  let resolved;
  try {
    resolved = fs.realpathSync(snapshotDir);
  } catch (error) {
    const missing = new Error(`opencode cache pin: snapshot missing: ${snapshotDir}`);
    missing.code = "ENOENT";
    missing.cause = error;
    throw missing;
  }
  const pinFile = path.join(resolved, ".pin-lock");
  try {
    const st = fs.statSync(pinFile);
    if (!st.isFile()) throw new Error("not a file");
  } catch (error) {
    if (error?.code === "ENOENT") {
      const missing = new Error(`opencode cache pin: pin lock missing: ${pinFile}`);
      missing.code = "ENOENT";
      missing.cause = error;
      throw missing;
    }
    try {
      fs.writeFileSync(pinFile, "");
    } catch (writeError) {
      const missing = new Error(`opencode cache pin: pin lock unwritable: ${pinFile}`);
      missing.code = writeError?.code || "ENOENT";
      missing.cause = writeError;
      throw missing;
    }
  }
  // File-handshake acquisition (sync-safe): the holder writes PINNED only
  // after the shared lock is acquired; the parent polls the file without
  // touching the event loop. Throws ENOENT when the snapshot or pin file
  // vanishes mid-acquisition so the caller can re-resolve and retry.
  if (!flockBinaryAvailable()) {
    const error = new Error("opencode cache pin: flock unavailable");
    error.code = "ENOENT";
    throw error;
  }
  try {
    fs.statSync(resolved);
  } catch (error) {
    const missing = new Error(`opencode cache pin: snapshot missing: ${resolved}`);
    missing.code = "ENOENT";
    missing.cause = error;
    throw missing;
  }
  // The handshake lives beside the pin file (proven writable above) —
  // never under os.tmpdir(), so a poisoned/missing TMPDIR cannot wedge
  // acquisition. The name cannot collide with validity-predicate artifacts
  // and the file is removed on every exit path below.
  const handshake = path.join(resolved, `.pin-handshake-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  let holder = null;
  try {
    holder = spawn("flock", ["-s", pinFile, "sh", "-c", `echo PINNED > ${JSON.stringify(handshake)}; read _`], {stdio: ["pipe", "ignore", "ignore"], shell: false, detached: true});
    if (holder.stdin) holder.stdin.on("error", () => {});
  } catch (error) {
    try { fs.rmSync(handshake, {force: true}); } catch {}
    throw error;
  }
  const deadline = Date.now() + waitSecs * 1000;
  let pinned = false;
  let holderGone = false;
  while (Date.now() < deadline) {
    try {
      if (!fs.existsSync(resolved) || !fs.existsSync(pinFile)) {
        killHolderGroup(holder);
        try { fs.rmSync(handshake, {force: true}); } catch {}
        const missing = new Error(`opencode cache pin: snapshot vanished during acquisition: ${resolved}`);
        missing.code = "ENOENT";
        throw missing;
      }
      if (fs.existsSync(handshake) && fs.readFileSync(handshake, "utf8").includes("PINNED")) {
        pinned = true;
        break;
      }
    } catch (error) {
      if (error?.code === "ENOENT") throw error;
    }
    // Sync-safe liveness (see holderDead): exitCode never updates while
    // this loop blocks the event loop.
    if (holderDead(holder)) {
      holderGone = true;
      break;
    }
    sleepSyncMs(50);
  }
  try { fs.rmSync(handshake, {force: true}); } catch {}
  if (pinned) {
    return {snapshotDir: resolved, pinFile, child: holder, release: () => releaseOpenCodeCachePin({snapshotDir: resolved, pinFile, child: holder})};
  }
  killHolderGroup(holder);
  if (holderGone) {
    const error = new Error("opencode cache pin: holder exited before acquiring the pin");
    error.code = "ETIMEDOUT";
    throw error;
  }
  const timeout = new Error("opencode cache pin: wait timeout");
  timeout.code = "ETIMEDOUT";
  throw timeout;
}

export function releaseOpenCodeCachePin(handle) {
  killHolderGroup(handle?.child);
}
