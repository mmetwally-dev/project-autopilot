#!/usr/bin/env node
// Mission 001 task 16: lifecycle proof for the real ensureOpenCodeCacheSeeded()
// from scripts/opencode-cache.mjs.
//
// This file imports and exercises the REAL function directly — never a
// mock/stub/fake of it (a static self-check below forbids shadowing its
// name). The only test seam used is the implementation's own explicit
// test-only parameters (versionTagOverride / installCommandOverride /
// lockWaitTimeoutSecs), which are plain function parameters with production
// defaults — no env vars, no global state, no monkey-patching. Override
// seeds are tiny POSIX shell commands that stage the same artifact layout
// the real bwrap seed produces (.cache/opencode/models.json + bin/rg),
// so every publish/validity/GC path under test is the production path.
//
// Cases (each a distinct check group; all against disposable temp roots):
//  1. concurrent first use serializes via real flock contention, one seed
//  2. matching-manifest no-op (byte-identical current realpath, no new dirs)
//  3. version mismatch via versionTagOverride (new snapshot, prior survives)
//  4. valid-but-not-current repoint with no install work (failing override)
//  5a-c. three invalid snapshots (missing .ready / manifest mismatch /
//     missing-or-empty artifact) left untouched while a fresh seed publishes
//  6. lock-wait timeout: clean failure, current untouched, no failure marker
//  7. killed lock-holder: kernel releases the lock, promptly reusable
//  8. seeding failure via installCommandOverride with no current: no publish
//  9. abandoned .tmp-* cleanup: stale pid removed, live pid kept
// 10. last-valid preservation across a subsequent seeding failure
// 11. retirement-time-based (not creation/mtime-based) GC
// 12. pin-lock-gated GC: refused while a helper holds the shared pin,
//     succeeds once released (both halves through the real lifecycle)
//
// Requires Linux/WSL2 (flock, chmod +x semantics). Skips only on native
// Windows; fails closed when flock is missing on Linux.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn, spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {
  ensureOpenCodeCacheSeeded,
  isValidOpenCodeSnapshot,
  collectOpenCodeCacheGarbage,
  acquireOpenCodeCachePin,
  OPENCODE_CACHE_GC_TTL_SECS
} from "./opencode-cache.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const thisFile = fileURLToPath(import.meta.url);
const cacheModuleUrl = new URL("./opencode-cache.mjs", import.meta.url).href;

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${detail}` : ""}`);
  return false;
};

if (process.platform === "win32") {
  console.log("test-opencode-cache-lifecycle: SKIP — requires Linux/WSL2 (flock-based mutex, POSIX executable bits).");
  process.exit(0);
}
if (spawnSync("flock", ["--version"], {stdio: "ignore", shell: false}).status !== 0) {
  console.error("FAIL prerequisite: `flock` is not available on this Linux/WSL2 host — failing closed rather than skipping.");
  process.exit(1);
}

// Static self-check: this file must import the real function, never shadow
// or redefine it (no mock/stub of ensureOpenCodeCacheSeeded anywhere here).
{
  const ownSource = fs.readFileSync(thisFile, "utf8");
  check("self: real ensureOpenCodeCacheSeeded is imported from opencode-cache.mjs",
    ownSource.includes("ensureOpenCodeCacheSeeded") && ownSource.includes('from "./opencode-cache.mjs"'));
  // Needles are built via concatenation so this check's own source text can
  // never contain them as a contiguous run (which would self-match and
  // always fail).
  check("self: no local redefinition of the seeder (no mock/stub)",
    !ownSource.includes("function ensure" + "OpenCodeCacheSeeded")
    && !ownSource.match(new RegExp("(const|let|var)\\s+" + "ensure" + "OpenCodeCacheSeeded\\s*=")));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const roots = [];
function makeRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
// Shell seed staging the same layout the real bwrap seed produces: a
// non-empty .cache/opencode/models.json plus an executable bin/rg. The
// lifecycle then promotes it into xdg-cache/opencode/ before publishing.
function seedScript(counterFile = null, sleepSecs = 0) {
  const parts = [];
  if (counterFile) parts.push(`echo seed >> '${counterFile}'`);
  if (sleepSecs > 0) parts.push(`sleep ${sleepSecs}`);
  parts.push("mkdir -p .cache/opencode/bin");
  parts.push("printf 'seed-models-payload' > .cache/opencode/models.json");
  parts.push("printf '#!/bin/sh\\necho fake-rg\\n' > .cache/opencode/bin/rg");
  parts.push("chmod +x .cache/opencode/bin/rg");
  return parts.join(" && ");
}
// Wrap a shell snippet as an explicit argv for the test-only override: the
// implementation accepts argv arrays only (never bare `sh -c` strings, see
// scripts/test-no-unguarded-shell.mjs).
function asArgv(snippet) {
  return ["sh", "-c", snippet];
}
function listVersions(root) {
  try {
    return fs.readdirSync(path.join(root, "versions")).sort();
  } catch { return []; }
}
function currentRealpath(root) {
  try { return fs.realpathSync(path.join(root, "current")); }
  catch { return null; }
}
// Hand-craft a snapshot directory (used for invalid/GC fixtures).
function craftSnapshot(dir, {version, ready = true, manifestVersion = null, emptyModels = false, omitRg = false} = {}) {
  fs.mkdirSync(path.join(dir, "xdg-cache", "opencode", "bin"), {recursive: true});
  fs.mkdirSync(path.join(dir, "xdg-cache", "opencode", "packages"), {recursive: true});
  fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify({version: manifestVersion ?? version})}\n`);
  if (emptyModels) fs.writeFileSync(path.join(dir, "xdg-cache", "opencode", "models.json"), "");
  else fs.writeFileSync(path.join(dir, "xdg-cache", "opencode", "models.json"), "crafted-models-payload");
  if (!omitRg) {
    fs.writeFileSync(path.join(dir, "xdg-cache", "opencode", "bin", "rg"), "#!/bin/sh\necho crafted-rg\n");
    fs.chmodSync(path.join(dir, "xdg-cache", "opencode", "bin", "rg"), 0o755);
  }
  try { fs.writeFileSync(path.join(dir, ".pin-lock"), ""); } catch {}
  if (ready) fs.writeFileSync(path.join(dir, ".ready"), `${Date.now()}\n`);
}
function lockHeld(lockFile) {
  return spawnSync("flock", ["-n", lockFile, "true"], {stdio: "ignore", shell: false}).status !== 0;
}
// Kill a flock-holder process GROUP. `flock <file> sleep N` leaves the
// lock fd inherited by the sleep child, so killing only the parent pid
// keeps the lock held until the child exits — the whole group must die
// (mirroring killHolderGroup in opencode-cache.mjs).
function killFlockGroup(child) {
  if (!child) return;
  const pid = child.pid;
  if (pid) {
    try { process.kill(pid, "SIGKILL"); } catch {}
    try { process.kill(-pid, "SIGKILL"); } catch {}
  } else {
    try { child.kill("SIGKILL"); } catch {}
  }
}
function waitFor(condition, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) return true;
    spawnSync("sleep", ["0.1"], {stdio: "ignore", shell: false});
  }
  return condition();
}

try {
// ---------------------------------------------------------------------------
// Cases 1-7, 10: main sequential root (versions never reused across cases,
// so the seed-failure cooldown marker can never cross-contaminate).
// ---------------------------------------------------------------------------
const R1 = makeRoot("ap-cache-lifecycle-r1-");

// Case 1: concurrent first use. The parent pre-holds the real flock mutex,
// launches 4 worker subprocesses that all block on it, then releases —
// forcing genuine contention. Exactly one worker's seed may run.
{
  fs.mkdirSync(path.join(R1, "versions"), {recursive: true});
  const lockFile = path.join(R1, ".lock");
  const counter = path.join(R1, "seed-counter.txt");
  fs.writeFileSync(counter, "");
  const seed = seedScript(counter, 3);
  const preHolder = spawn("flock", [lockFile, "sleep", "15"], {stdio: "ignore", shell: false, detached: true});
  assert.equal(waitFor(() => lockHeld(lockFile), 5000), true, "pre-holder must acquire the lock");
  const workerCode = `
const cacheRoot = ${JSON.stringify(R1)};
const seedCmd = ${JSON.stringify(seed)};
const modUrl = ${JSON.stringify(cacheModuleUrl)};
const m = await import(modUrl);
const r = m.ensureOpenCodeCacheSeeded({cacheRoot, versionTagOverride: "conc-v1", installCommandOverride: ["sh", "-c", seedCmd]});
console.log("WORKER_RESULT=" + JSON.stringify({ok: r.ok, reason: r.reason, snapshotDir: r.snapshotDir}));
`;
  const workers = [0, 1, 2, 3].map(() => new Promise(resolve => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", workerCode],
      {stdio: ["ignore", "pipe", "pipe"], shell: false});
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("close", code => resolve({code, out, err}));
  }));
  spawnSync("sleep", ["1"], {stdio: "ignore", shell: false}); // let all workers block on the mutex
  killFlockGroup(preHolder);
  const results = await Promise.all(workers);
  const parsed = results.map(r => {
    const line = String(r.out).split("\n").find(l => l.startsWith("WORKER_RESULT="));
    try { return {code: r.code, ...(line ? JSON.parse(line.slice("WORKER_RESULT=".length)) : {ok: false, reason: "no-result-line"})}; }
    catch { return {code: r.code, ok: false, reason: "unparseable"}; }
  });
  check("1: all 4 concurrent workers exit 0 with ok:true", results.every(r => r.code === 0) && parsed.every(p => p.ok === true), JSON.stringify(parsed));
  const seedCount = fs.readFileSync(counter, "utf8").split("\n").filter(l => l === "seed").length;
  check("1: exactly one seed ran under real flock contention", seedCount === 1, `seedCount=${seedCount}`);
  check("1: exactly one snapshot published", listVersions(R1).length === 1, JSON.stringify(listVersions(R1)));
  const snap1 = currentRealpath(R1);
  check("1: current resolves to a valid snapshot for conc-v1", !!snap1 && isValidOpenCodeSnapshot(snap1, "conc-v1"), snap1);
  killFlockGroup(preHolder);
}

// Case 2: matching-manifest no-op. The override would fail loudly if it
// ever ran, proving no install work happens on the fast path.
{
  const beforeRP = currentRealpath(R1);
  const beforeVersions = listVersions(R1);
  const r = ensureOpenCodeCacheSeeded({cacheRoot: R1, versionTagOverride: "conc-v1", installCommandOverride: ["sh", "-c", "exit 99"]});
  check("2: no-op returns ready", r.ok === true, JSON.stringify({reason: r.reason}));
  check("2: current realpath byte-identical", currentRealpath(R1) === beforeRP, `${currentRealpath(R1)} vs ${beforeRP}`);
  check("2: no new directories published", JSON.stringify(listVersions(R1)) === JSON.stringify(beforeVersions), JSON.stringify(listVersions(R1)));
  check("2: no seed-failure marker stamped (no seed attempted)", !fs.existsSync(path.join(R1, ".last-seed-failure.json")));
}

// Case 3: version mismatch publishes a new snapshot; the prior one survives.
let snapV1 = currentRealpath(R1);
{
  const r = ensureOpenCodeCacheSeeded({cacheRoot: R1, versionTagOverride: "conc-v2", installCommandOverride: asArgv(seedScript())});
  const snapV2 = currentRealpath(R1);
  check("3: mismatch publishes ready", r.ok === true && r.reason === "published", JSON.stringify({reason: r.reason}));
  check("3: current moved to a new snapshot", !!snapV2 && snapV2 !== snapV1, `${snapV2} vs ${snapV1}`);
  check("3: prior snapshot survives on disk", fs.existsSync(snapV1) && isValidOpenCodeSnapshot(snapV1, "conc-v1"), snapV1);
  check("3: new snapshot valid for conc-v2", isValidOpenCodeSnapshot(snapV2, "conc-v2"), snapV2);
  check("3: two snapshots on disk", listVersions(R1).length === 2, JSON.stringify(listVersions(R1)));
}

// Case 4: valid-but-not-current repoint performs no install work — the
// override exits 1, so success proves the seed never ran.
{
  const r = ensureOpenCodeCacheSeeded({cacheRoot: R1, versionTagOverride: "conc-v1", installCommandOverride: ["sh", "-c", "exit 1"]});
  check("4: repoint returns ready despite failing override (no install work)", r.ok === true && r.reason === "repoint", JSON.stringify({reason: r.reason, ok: r.ok}));
  check("4: current repointed to the prior snapshot", currentRealpath(R1) === snapV1, `${currentRealpath(R1)} vs ${snapV1}`);
  check("4: stale .retired-at cleared on repoint", !fs.existsSync(path.join(snapV1, ".retired-at")));
  const snapV2dir = listVersions(R1).map(n => path.join(R1, "versions", n)).find(d => d !== snapV1);
  check("4: superseded snapshot survives repoint", !!snapV2dir && fs.existsSync(snapV2dir), snapV2dir);
}

// Case 6 (ordered before the failure-stamping cases): lock-wait timeout is
// a clean failure — current untouched, versions unchanged, no marker.
{
  const beforeRP = currentRealpath(R1);
  const beforeVersions = listVersions(R1);
  const holder = spawn("flock", [path.join(R1, ".lock"), "sleep", "30"], {stdio: "ignore", shell: false, detached: true});
  assert.equal(waitFor(() => lockHeld(path.join(R1, ".lock")), 5000), true, "timeout-case holder must hold the lock");
  const t0 = Date.now();
  const r = ensureOpenCodeCacheSeeded({cacheRoot: R1, versionTagOverride: "conc-lock-wait", installCommandOverride: asArgv(seedScript()), lockWaitTimeoutSecs: 2});
  const elapsed = Date.now() - t0;
  killFlockGroup(holder);
  // Reap the holder so a later kill -0 liveness check cannot confuse it.
  await new Promise(resolve => { holder.on("close", resolve); setTimeout(resolve, 2000); });
  check("6: lock-wait timeout fails clean (ok:false, unavailable)", r.ok === false && r.status === "unavailable", JSON.stringify({ok: r.ok, reason: r.reason}));
  check("6: timeout reason is lock_wait_timeout", r.reason === "lock_wait_timeout", r.reason);
  check("6: current untouched by the timeout", currentRealpath(R1) === beforeRP, `${currentRealpath(R1)} vs ${beforeRP}`);
  check("6: no snapshot published during the timeout", JSON.stringify(listVersions(R1)) === JSON.stringify(beforeVersions));
  check("6: no seed-failure marker stamped (no seed attempted)", !fs.existsSync(path.join(R1, ".last-seed-failure.json")));
  check("6: timeout returned promptly (well under the 600s production bound)", elapsed < 20000, `elapsed=${elapsed}ms`);
}

// Case 10: the last valid cache is preserved across a seeding failure.
{
  const beforeRP = currentRealpath(R1);
  const beforeVersions = listVersions(R1);
  const r = ensureOpenCodeCacheSeeded({cacheRoot: R1, versionTagOverride: "conc-v4", installCommandOverride: ["sh", "-c", "exit 1"]});
  check("10: failure keeps serving the last valid cache", r.ok === true && String(r.reason || "").startsWith("seed_failed_keep_current"), JSON.stringify({reason: r.reason}));
  check("10: current realpath unchanged across the failure", currentRealpath(R1) === beforeRP, `${currentRealpath(R1)} vs ${beforeRP}`);
  check("10: served snapshot is the prior valid one", r.snapshotDir === beforeRP, r.snapshotDir);
  check("10: no snapshot published by the failure", JSON.stringify(listVersions(R1)) === JSON.stringify(beforeVersions));
}

// Case 9: abandoned-temp cleanup distinguishes stale vs live pids. The
// failing override keeps current pinned while still running the under-lock
// cleanup first.
{
  const beforeRP = currentRealpath(R1);
  const staleDir = path.join(R1, ".tmp-1073741824-deadbeef");
  fs.mkdirSync(staleDir, {recursive: true});
  fs.writeFileSync(path.join(staleDir, "leftover.txt"), "stale");
  const sleeper = spawn("sleep", ["60"], {stdio: "ignore", shell: false});
  const liveDir = path.join(R1, `.tmp-${sleeper.pid}-livecheck`);
  fs.mkdirSync(liveDir, {recursive: true});
  fs.writeFileSync(path.join(liveDir, "active.txt"), "live");
  const r = ensureOpenCodeCacheSeeded({cacheRoot: R1, versionTagOverride: "conc-v6", installCommandOverride: ["sh", "-c", "exit 1"]});
  const staleGone = !fs.existsSync(staleDir);
  const liveKept = fs.existsSync(path.join(liveDir, "active.txt"));
  try { sleeper.kill("SIGKILL"); } catch {}
  check("9: seed-failure fallback still returns keep_current", r.ok === true, JSON.stringify({reason: r.reason}));
  check("9: stale-pid .tmp dir removed", staleGone, staleDir);
  check("9: live-pid .tmp dir preserved with contents", liveKept, liveDir);
  check("9: current untouched", currentRealpath(R1) === beforeRP, currentRealpath(R1));
  try { fs.rmSync(liveDir, {recursive: true, force: true}); } catch {}
}

// Case 7: a killed lock-holder's lock is kernel-released and promptly reusable.
{
  const R4 = makeRoot("ap-cache-lifecycle-r4-");
  fs.mkdirSync(path.join(R4, "versions"), {recursive: true});
  const holder = spawn("flock", [path.join(R4, ".lock"), "sleep", "60"], {stdio: "ignore", shell: false, detached: true});
  assert.equal(waitFor(() => lockHeld(path.join(R4, ".lock")), 5000), true, "killed-holder case must hold the lock first");
  killFlockGroup(holder);
  const t0 = Date.now();
  const r = ensureOpenCodeCacheSeeded({cacheRoot: R4, versionTagOverride: "killed-v1", installCommandOverride: asArgv(seedScript())});
  const elapsed = Date.now() - t0;
  killFlockGroup(holder);
  check("7: seeding succeeds right after the holder is killed", r.ok === true, JSON.stringify({reason: r.reason}));
  check("7: lock reusable promptly (no 600s wait)", elapsed < 30000, `elapsed=${elapsed}ms`);
  check("7: exactly one snapshot published", listVersions(R4).length === 1, JSON.stringify(listVersions(R4)));
}

// Case 8: seeding failure with no current publishes nothing.
{
  const R5 = makeRoot("ap-cache-lifecycle-r5-");
  const r = ensureOpenCodeCacheSeeded({cacheRoot: R5, versionTagOverride: "fail-nocurrent", installCommandOverride: ["sh", "-c", "exit 1"]});
  check("8: failure with no current is unavailable", r.ok === false && r.status === "unavailable", JSON.stringify({ok: r.ok, reason: r.reason}));
  check("8: current left untouched (still absent)", currentRealpath(R5) === null && !fs.existsSync(path.join(R5, "current")));
  check("8: no versioned snapshot published", listVersions(R5).length === 0, JSON.stringify(listVersions(R5)));
  check("8: no abandoned .tmp dir left behind", fs.readdirSync(R5).filter(n => n.startsWith(".tmp-")).length === 0, JSON.stringify(fs.readdirSync(R5)));
}

// Cases 5a-c: each invalid-snapshot flavor is left untouched while a fresh
// valid seed publishes separately. (.retired-at bookkeeping may be stamped
// by design — "untouched" here means: still on disk, still invalid, core
// content byte-identical, never became current.)
const invalidCases = [
  {id: "5a-missing-ready", craft: {ready: false}, desc: "missing .ready"},
  {id: "5b-manifest-mismatch", craft: {manifestVersion: "wrong-version-xyz"}, desc: "manifest mismatch"},
  {id: "5c-empty-artifact", craft: {emptyModels: true, omitRg: true}, desc: "missing/empty artifact"}
];
for (const {id, craft, desc} of invalidCases) {
  const root = makeRoot(`ap-cache-lifecycle-${id}-`);
  fs.mkdirSync(path.join(root, "versions"), {recursive: true});
  const badDir = path.join(root, "versions", `badver__deadbeefcafe000${id.length}`);
  craftSnapshot(badDir, {version: "badver", ...craft});
  const manifestBefore = fs.readFileSync(path.join(badDir, "manifest.json"));
  const readyBefore = fs.existsSync(path.join(badDir, ".ready"));
  assert.equal(isValidOpenCodeSnapshot(badDir, "badver"), false, `${id} fixture must start invalid`);
  const r = ensureOpenCodeCacheSeeded({cacheRoot: root, versionTagOverride: "badver", installCommandOverride: asArgv(seedScript())});
  const now = currentRealpath(root);
  check(`${id} (${desc}): fresh valid seed publishes`, r.ok === true && r.reason === "published", JSON.stringify({reason: r.reason}));
  check(`${id}: invalid directory left on disk`, fs.existsSync(badDir), badDir);
  check(`${id}: invalid directory still fails the validity predicate`, isValidOpenCodeSnapshot(badDir, "badver") === false);
  check(`${id}: manifest bytes identical`, fs.readFileSync(path.join(badDir, "manifest.json")).equals(manifestBefore));
  check(`${id}: .ready presence unchanged`, fs.existsSync(path.join(badDir, ".ready")) === readyBefore);
  check(`${id}: current points at the fresh snapshot, not the invalid one`, !!now && now !== badDir && isValidOpenCodeSnapshot(now, "badver"), now);
}

// Case 11: GC is retirement-time-based, never creation/mtime-based.
// R (fresh mtime, backdated .retired-at) must go; O (30-day-old mtime, no
// marker) and F (fresh, no marker) must survive; A (newly retired) survives.
{
  const R2 = makeRoot("ap-cache-lifecycle-r2-");
  const a = ensureOpenCodeCacheSeeded({cacheRoot: R2, versionTagOverride: "gc-v1", installCommandOverride: asArgv(seedScript())});
  assert.equal(a.ok, true, "gc fixture seed must publish");
  const snapA = currentRealpath(R2);
  const dirR = path.join(R2, "versions", "gc-v1__staleretired0001");
  craftSnapshot(dirR, {version: "gc-v1", ready: false});
  fs.writeFileSync(path.join(dirR, ".retired-at"), `${Math.floor(Date.now() / 1000) - 8 * 24 * 3600}\n`);
  const now = new Date();
  fs.utimesSync(dirR, now, now); // fresh creation/mtime — deletion must come from .retired-at, not mtime
  const dirF = path.join(R2, "versions", "gc-v1__freshnomarker002");
  craftSnapshot(dirF, {version: "gc-v1", ready: false});
  const dirO = path.join(R2, "versions", "gc-v1__oldmtimenomark03");
  craftSnapshot(dirO, {version: "gc-v1", ready: false});
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  fs.utimesSync(dirO, old, old); // far older than the TTL — survives anyway: mtime is never consulted
  const b = ensureOpenCodeCacheSeeded({cacheRoot: R2, versionTagOverride: "gc-v2", installCommandOverride: asArgv(seedScript())});
  assert.equal(b.ok, true, "gc trigger publish must succeed");
  const snapB = currentRealpath(R2);
  check("11: trigger publish moved current", !!snapB && snapB !== snapA, snapB);
  check("11: backdated-.retired-at snapshot collected despite fresh mtime", !fs.existsSync(dirR), dirR);
  check("11: newly retired prior snapshot survives (fresh marker)", fs.existsSync(snapA), snapA);
  check("11: old-mtime snapshot without marker survives (mtime never consulted)", fs.existsSync(dirO), dirO);
  check("11: fresh snapshot without marker survives", fs.existsSync(dirF), dirF);
}

// Case 12: pin-lock-gated GC. A helper process holds the REAL shared pin
// (acquireOpenCodeCachePin) on a stale snapshot: the publish-triggered GC
// must refuse it; after release the next publish-triggered GC removes it.
{
  const R3 = makeRoot("ap-cache-lifecycle-r3-");
  const a = ensureOpenCodeCacheSeeded({cacheRoot: R3, versionTagOverride: "pin-v1", installCommandOverride: asArgv(seedScript())});
  assert.equal(a.ok, true, "pin fixture seed must publish");
  const dirR = path.join(R3, "versions", "pin-v1__staleretired0001");
  craftSnapshot(dirR, {version: "pin-v1", ready: false});
  fs.writeFileSync(path.join(dirR, ".retired-at"), `${Math.floor(Date.now() / 1000) - 8 * 24 * 3600}\n`);
  const readyFile = path.join(R3, "pin-helper-ready.txt");
  const helperCode = `
const snap = ${JSON.stringify(dirR)};
const ready = ${JSON.stringify(readyFile)};
const modUrl = ${JSON.stringify(cacheModuleUrl)};
const fsMod = await import("node:fs");
const m = await import(modUrl);
const handle = m.acquireOpenCodeCachePin(snap);
fsMod.writeFileSync(ready, "pinned");
await new Promise(r => setTimeout(r, 25000));
`;
  const helper = spawn(process.execPath, ["--input-type=module", "-e", helperCode], {stdio: "ignore", shell: false});
  assert.equal(waitFor(() => fs.existsSync(readyFile), 15000), true, "pin helper must acquire the shared pin");
  const exclusiveBlocked = spawnSync("flock", ["-n", "-x", path.join(dirR, ".pin-lock"), "true"], {stdio: "ignore", shell: false}).status !== 0;
  check("12: helper really holds the shared pin (exclusive try fails)", exclusiveBlocked);
  const b = ensureOpenCodeCacheSeeded({cacheRoot: R3, versionTagOverride: "pin-v2", installCommandOverride: asArgv(seedScript())});
  assert.equal(b.ok, true, "pin trigger publish must succeed");
  check("12: pinned stale snapshot refused by GC while pin held", fs.existsSync(dirR), dirR);
  try { helper.kill("SIGKILL"); } catch {}
  await new Promise(resolve => { helper.on("close", resolve); setTimeout(resolve, 5000); });
  const released = waitFor(() => spawnSync("flock", ["-n", "-x", path.join(dirR, ".pin-lock"), "true"], {stdio: "ignore", shell: false}).status === 0, 15000);
  check("12: pin released after helper death (kernel release)", released);
  const c = ensureOpenCodeCacheSeeded({cacheRoot: R3, versionTagOverride: "pin-v3", installCommandOverride: asArgv(seedScript())});
  assert.equal(c.ok, true, "post-release publish must succeed");
  check("12: stale snapshot collected once the pin is released", !fs.existsSync(dirR), dirR);
  check("12: newest snapshot is current and valid", (() => { const cur = currentRealpath(R3); return !!cur && isValidOpenCodeSnapshot(cur, "pin-v3"); })(), currentRealpath(R3));
}
} finally {
  for (const root of roots) {
    try { fs.rmSync(root, {recursive: true, force: true}); } catch {}
  }
}

if (failures) {
  console.error(`${failures} opencode cache lifecycle check(s) failed.`);
  process.exit(1);
}
console.log("test-opencode-cache-lifecycle: ALL CHECKS PASSED");
