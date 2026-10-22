// Behavioral coverage for resolveAgentBinary()'s per-process resolution
// cache (Windows E2E shared-latency fix): real fixture binaries on disk,
// real resolveAgentBinary() calls, real where.exe/which subprocess spawns
// counted via __resolveCacheTestHooks — never a source-string assertion.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {resolveAgentBinary, __resolveCacheTestHooks} from "./agent-process.mjs";

const IS_WIN = process.platform === "win32";
const savedPath = process.env.PATH;
const savedCwd = process.cwd();
const dirs = [];

function makeFixtureBinDir(prefix, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ap-resolve-cache-${prefix}-`));
  dirs.push(dir);
  const name = IS_WIN ? "fakebin.cmd" : "fakebin";
  const file = path.join(dir, name);
  if (IS_WIN) {
    fs.writeFileSync(file, `@echo off\r\necho ${content}\r\n`);
  } else {
    fs.writeFileSync(file, `#!/bin/sh\necho ${content}\n`);
    fs.chmodSync(file, 0o755);
  }
  return {dir, file};
}

function withPath(entries, fn) {
  const delim = IS_WIN ? ";" : ":";
  process.env.PATH = [...entries, savedPath].join(delim);
  try { return fn(); } finally { process.env.PATH = savedPath; }
}

try {
  // --- Test 1: cache hit avoids a second real subprocess spawn ---
  {
    const {dir} = makeFixtureBinDir("hit", "A");
    withPath([dir], () => {
      __resolveCacheTestHooks.resetForTests();
      const r1 = resolveAgentBinary("fakebin");
      const probesAfterFirst = __resolveCacheTestHooks.probeCount;
      assert.ok(probesAfterFirst > 0, "first resolution must invoke at least one real probe");
      assert.notEqual(r1, "fakebin", "first resolution must find the real fixture file, not fall through unresolved");

      const r2 = resolveAgentBinary("fakebin");
      assert.equal(__resolveCacheTestHooks.probeCount, probesAfterFirst, "second resolution with identical PATH/PATHEXT/cwd must be a cache hit — no new probe");
      assert.equal(r2, r1, "cache hit must return the exact same resolved path");
    });
  }

  // --- Test 2: PATH change triggers re-resolution, not a stale answer ---
  {
    const {dir: dirA, file: fileA} = makeFixtureBinDir("patha", "A");
    const {dir: dirB, file: fileB} = makeFixtureBinDir("pathb", "B");
    __resolveCacheTestHooks.resetForTests();
    const rA = withPath([dirA], () => resolveAgentBinary("fakebin"));
    const probesAfterA = __resolveCacheTestHooks.probeCount;
    assert.ok(pathsEqual(rA, fileA), `resolution with PATH=dirA must resolve into dirA (got ${rA})`);

    const rB = withPath([dirB], () => resolveAgentBinary("fakebin"));
    assert.ok(__resolveCacheTestHooks.probeCount > probesAfterA, "changing PATH must trigger a fresh probe, not a cache hit");
    assert.ok(pathsEqual(rB, fileB), `resolution with PATH=dirB must resolve into dirB (got ${rB}), never the stale dirA answer`);
    assert.notEqual(rA, rB, "PATH change must change the resolved path");
  }

  // --- Test 3: cwd change triggers re-resolution ---
  // Windows: where.exe also searches the current directory, so a binary
  // reachable only via cwd (not PATH) must be found when cwd points there
  // and must stop resolving once cwd moves away. POSIX `which` does not
  // search cwd, so only the "a fresh probe occurs" half is asserted there
  // (proving the cache key genuinely incorporates cwd).
  {
    const {dir: cwdDir, file: cwdFile} = makeFixtureBinDir("cwd", "C");
    const neutralDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-resolve-cache-neutral-"));
    dirs.push(neutralDir);
    __resolveCacheTestHooks.resetForTests();
    // Neither directory is on PATH — resolution can only succeed via cwd.
    process.chdir(cwdDir);
    let inCwdResult;
    try {
      inCwdResult = withPath([], () => resolveAgentBinary("fakebin"));
    } finally {
      process.chdir(savedCwd);
    }
    const probesAfterCwd = __resolveCacheTestHooks.probeCount;

    process.chdir(neutralDir);
    let outOfCwdResult;
    try {
      outOfCwdResult = withPath([], () => resolveAgentBinary("fakebin"));
    } finally {
      process.chdir(savedCwd);
    }
    assert.ok(__resolveCacheTestHooks.probeCount > probesAfterCwd, "changing cwd must trigger a fresh probe, not a cache hit for the same binary name");

    if (IS_WIN) {
      assert.ok(pathsEqual(inCwdResult, cwdFile), `on Windows, resolving from inside cwdDir with fakebin only reachable via cwd must find it (got ${inCwdResult})`);
      assert.equal(outOfCwdResult, "fakebin", "moving cwd away from the only location fakebin exists must fail to resolve it (raw fallback), never the stale cwd-relative answer");
    }
  }

  // --- Test 4: a deleted/replaced target is never served stale from cache ---
  {
    const {dir, file} = makeFixtureBinDir("delete", "D");
    __resolveCacheTestHooks.resetForTests();
    const r1 = withPath([dir], () => resolveAgentBinary("fakebin"));
    assert.ok(pathsEqual(r1, file), "must resolve to the real fixture file before deletion");
    const probesBeforeDelete = __resolveCacheTestHooks.probeCount;

    fs.rmSync(file, {force: true});
    const r2 = withPath([dir], () => resolveAgentBinary("fakebin"));
    assert.ok(__resolveCacheTestHooks.probeCount > probesBeforeDelete, "a cache entry whose file no longer exists must be evicted and re-probed, never served stale");
    assert.notEqual(r2, r1, "the deleted path must never be returned once it no longer exists on disk");
    assert.equal(r2, "fakebin", "with the only candidate deleted, resolution must fail to the raw binary name");
  }

  // --- Test 5: a failed/missing resolution is never cached ---
  {
    __resolveCacheTestHooks.resetForTests();
    const missingName = "definitely-does-not-exist-anywhere-" + Date.now();
    const r1 = withPath([], () => resolveAgentBinary(missingName));
    assert.equal(r1, missingName, "an unresolvable binary must fall back to the raw name");
    const probesAfterMiss = __resolveCacheTestHooks.probeCount;
    assert.ok(probesAfterMiss > 0, "a failed lookup must still have actually probed");

    const r2 = withPath([], () => resolveAgentBinary(missingName));
    assert.ok(__resolveCacheTestHooks.probeCount > probesAfterMiss, "a second lookup of a still-unresolvable binary must probe again — failed results are never cached");
    assert.equal(r2, missingName, "still unresolvable — still falls back to the raw name");

    // Now make it resolvable and confirm it is picked up immediately (not
    // masked by a stale "not found" cache entry).
    const {dir, file} = makeFixtureBinDir("appear", "E");
    const renamedFile = path.join(dir, IS_WIN ? `${missingName}.cmd` : missingName);
    fs.renameSync(file, renamedFile);
    if (!IS_WIN) fs.chmodSync(renamedFile, 0o755);
    const r3 = withPath([dir], () => resolveAgentBinary(missingName));
    assert.ok(pathsEqual(r3, renamedFile), `a binary that becomes available after prior failed lookups must be found on the next call (got ${r3})`);
  }

  // --- Test 6: a shim retargeted to a different real executable is never
  // served stale from cache, even though the shim file itself and the OLD
  // target both still exist on disk (so existence checks alone cannot
  // catch this — only re-reading the shim's own content can).
  // This exercises resolveWindowsBinary()'s npm-shim indirection
  // (shimTarget()), which only exists on the Windows code path.
  if (IS_WIN) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-resolve-cache-retarget-"));
    dirs.push(dir);
    const nmA = path.join(dir, "node_modules", "pkgA", "bin");
    const nmB = path.join(dir, "node_modules", "pkgB", "bin");
    fs.mkdirSync(nmA, {recursive: true});
    fs.mkdirSync(nmB, {recursive: true});
    const targetA = path.join(nmA, "A.exe");
    const targetB = path.join(nmB, "B.exe");
    fs.writeFileSync(targetA, "not a real PE, existence is all that's checked");
    fs.writeFileSync(targetB, "not a real PE, existence is all that's checked");

    const shimName = "retargetbin.cmd";
    const shimFile = path.join(dir, shimName);
    const shimPointingAt = target => `@echo off\r\n"%dp0%\\${path.relative(dir, target)}" %*\r\n`;
    fs.writeFileSync(shimFile, shimPointingAt(targetA));

    __resolveCacheTestHooks.resetForTests();
    const rA = withPath([dir], () => resolveAgentBinary("retargetbin"));
    assert.ok(pathsEqual(rA, targetA), `shim must initially resolve to A (got ${rA})`);
    const probesAfterA = __resolveCacheTestHooks.probeCount;

    // Retarget the shim from A to B in place. A is NOT deleted — it still
    // exists on disk, so a cache that only re-checks "does the cached path
    // still exist" would wrongly keep serving A.
    fs.writeFileSync(shimFile, shimPointingAt(targetB));
    assert.ok(fs.existsSync(targetA), "A must still exist on disk (the whole point of this test)");

    const rB = withPath([dir], () => resolveAgentBinary("retargetbin"));
    assert.ok(pathsEqual(rB, targetB), `after retargeting the shim to B (with A still present), resolution must return B, not the stale cached A (got ${rB})`);
    assert.ok(__resolveCacheTestHooks.probeCount > probesAfterA, "a retargeted shim must trigger a fresh where.exe probe, not a silent cache hit");
  } else {
    console.log("(test 6: shim-retarget — skipped on POSIX, no shim indirection on this code path)");
  }

  console.log("agent-process resolveAgentBinary cache behavior tests passed");
} finally {
  process.env.PATH = savedPath;
  try { process.chdir(savedCwd); } catch {}
  __resolveCacheTestHooks.resetForTests();
  for (const d of dirs) { try { fs.rmSync(d, {recursive: true, force: true}); } catch {} }
}

function pathsEqual(a, b) {
  if (a == null || b == null) return false;
  const norm = p => IS_WIN ? path.resolve(p).toLowerCase() : path.resolve(p);
  return norm(a) === norm(b);
}
