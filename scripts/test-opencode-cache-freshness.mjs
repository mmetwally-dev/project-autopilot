#!/usr/bin/env node
// Backlog #1: the shared opencode cache is keyed only by the opencode
// version, so its hidden models.json never refreshes while the version is
// unchanged. A sandboxed read-only role then dies with
// ProviderModelNotFoundError for a model the host catalog already has.
//
// These cases exercise the REAL ensureOpenCodeCacheSeeded() lifecycle:
//  1. stale snapshot (old mtime, no model X) + newer host catalog with X
//     => a NEW generation is published with X; the old snapshot is untouched
//  2. fresh snapshot that already has X => no new generation, current intact
//  3. refresh failure => old current kept, one warning naming X
//  4. host is newer but also lacks X, and a successful seed still lacks X
//     => nothing is published; old current kept + warning
//  5. host is not newer => the existing seed path runs and publishes a
//     snapshot that does contain X
//
// Requires Linux/WSL2 (flock). Skips only on native Windows; fails closed
// when flock is missing on Linux, like the lifecycle suite.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {ensureOpenCodeCacheSeeded, isValidOpenCodeSnapshot, readOpenCodeCatalogModelIds} from "./opencode-cache.mjs";

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${detail}` : ""}`);
  return false;
};

if (process.platform === "win32") {
  console.log("test-opencode-cache-freshness: SKIP — requires Linux/WSL2 (flock).");
  process.exit(0);
}
if (spawnSync("flock", ["--version"], {stdio: "ignore", shell: false}).status !== 0) {
  console.error("FAIL prerequisite: `flock` is not available on this Linux/WSL2 host — failing closed rather than skipping.");
  process.exit(1);
}

const roots = [];
function makeRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
function asArgv(snippet) {
  return ["sh", "-c", snippet];
}
function currentRealpath(root) {
  try { return fs.realpathSync(path.join(root, "current")); }
  catch { return null; }
}
function listVersions(root) {
  try { return fs.readdirSync(path.join(root, "versions")).sort(); }
  catch { return []; }
}
function modelsFile(snapshotDir) {
  return path.join(snapshotDir, "xdg-cache", "opencode", "models.json");
}
function writeCatalog(file, ids) {
  const models = Object.fromEntries(ids.map(id => [id, {}]));
  fs.writeFileSync(file, JSON.stringify({opencode: {models}}));
}
function seedScript(ids) {
  const payload = JSON.stringify({opencode: {models: Object.fromEntries(ids.map(id => [id, {}]))}}).replace(/'/g, "'\\''");
  return [
    "mkdir -p .cache/opencode/bin",
    `printf '%s' '${payload}' > .cache/opencode/models.json`,
    "printf '#!/bin/sh\\necho fake-rg\\n' > .cache/opencode/bin/rg",
    "chmod +x .cache/opencode/bin/rg"
  ].join(" && ");
}
function publishSnapshotWith(root, version, ids) {
  const r = ensureOpenCodeCacheSeeded({cacheRoot: root, versionTagOverride: version, installCommandOverride: asArgv(seedScript(ids))});
  assert.equal(r.ok, true, `fixture seed for ${version} must publish: ${JSON.stringify(r)}`);
  const snap = currentRealpath(root);
  assert.ok(snap, `fixture seed for ${version} must set current`);
  return snap;
}
function ageModels(snapshotDir, days = 2) {
  const old = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  fs.utimesSync(modelsFile(snapshotDir), old, old);
}
function catalogIds(snapshotDir) {
  return readOpenCodeCatalogModelIds(modelsFile(snapshotDir)) || new Set();
}

try {
  // Case 1: stale snapshot missing X, newer host catalog has X. The override
  // would exit 99 if the seed path ran, proving the host-copy refresh was used.
  {
    const root = makeRoot("ap-cache-fresh-1-");
    const oldSnap = publishSnapshotWith(root, "fresh-v1", ["model-a"]);
    const oldBytes = fs.readFileSync(modelsFile(oldSnap));
    ageModels(oldSnap);
    const hostDir = makeRoot("ap-cache-fresh-host-1-");
    const host = path.join(hostDir, "models.json");
    writeCatalog(host, ["model-a", "model-x"]);
    const r = ensureOpenCodeCacheSeeded({
      cacheRoot: root,
      versionTagOverride: "fresh-v1",
      requiredModels: ["opencode/model-x"],
      hostModelsPath: host,
      installCommandOverride: asArgv("exit 99")
    });
    const now = currentRealpath(root);
    check("1: refresh returns ready via host copy", r.ok === true && r.reason === "refreshed_from_host", JSON.stringify({ok: r.ok, reason: r.reason}));
    check("1: current moved to a NEW generation", !!now && now !== oldSnap, `${now} vs ${oldSnap}`);
    check("1: new generation valid for the version", !!now && isValidOpenCodeSnapshot(now, "fresh-v1"), now);
    check("1: new generation contains model-x and model-a", !!now && catalogIds(now).has("model-x") && catalogIds(now).has("model-a"), now && [...catalogIds(now)].join(","));
    check("1: exactly one new version published", listVersions(root).length === 2, JSON.stringify(listVersions(root)));
    check("1: old snapshot still on disk", fs.existsSync(oldSnap), oldSnap);
    check("1: old snapshot models.json byte-identical (never edited in place)", fs.readFileSync(modelsFile(oldSnap)).equals(oldBytes));
    check("1: old snapshot still lacks model-x", !catalogIds(oldSnap).has("model-x"));
    check("1: old snapshot still passes the validity predicate", isValidOpenCodeSnapshot(oldSnap, "fresh-v1"));
    check("1: no warning on a successful refresh", !r.warning, JSON.stringify(r.warning));
  }

  // Case 2: fresh snapshot that already has X => strict no-op, no publish.
  {
    const root = makeRoot("ap-cache-fresh-2-");
    const snap = publishSnapshotWith(root, "fresh-v2", ["model-a", "model-x"]);
    const before = currentRealpath(root);
    const hostDir = makeRoot("ap-cache-fresh-host-2-");
    const host = path.join(hostDir, "models.json");
    writeCatalog(host, ["model-a", "model-x"]);
    const r = ensureOpenCodeCacheSeeded({
      cacheRoot: root,
      versionTagOverride: "fresh-v2",
      requiredModels: ["opencode/model-x"],
      hostModelsPath: host,
      installCommandOverride: asArgv("exit 99")
    });
    check("2: fresh snapshot returns the no-op fast path", r.ok === true && r.reason === "no-op", JSON.stringify({ok: r.ok, reason: r.reason}));
    check("2: current unchanged", currentRealpath(root) === before, `${currentRealpath(root)} vs ${before}`);
    check("2: no new generation published", listVersions(root).length === 1, JSON.stringify(listVersions(root)));
    check("2: no warning", !r.warning, JSON.stringify(r.warning));
  }

  // Case 3: refresh failure (no host catalog, seed fails) => keep old current
  // and warn with the missing model's name.
  {
    const root = makeRoot("ap-cache-fresh-3-");
    const oldSnap = publishSnapshotWith(root, "fresh-v3", ["model-a"]);
    ageModels(oldSnap);
    const r = ensureOpenCodeCacheSeeded({
      cacheRoot: root,
      versionTagOverride: "fresh-v3",
      requiredModels: ["opencode/model-x"],
      hostModelsPath: path.join(root, "no-such-host-models.json"),
      installCommandOverride: asArgv("exit 1")
    });
    check("3: failure keeps serving the old current", r.ok === true && String(r.reason || "").startsWith("seed_failed_keep_current"), JSON.stringify({ok: r.ok, reason: r.reason}));
    check("3: current realpath unchanged", currentRealpath(root) === oldSnap, `${currentRealpath(root)} vs ${oldSnap}`);
    check("3: served snapshot is the old current", r.snapshotDir === oldSnap, r.snapshotDir);
    check("3: no new generation published", listVersions(root).length === 1, JSON.stringify(listVersions(root)));
    check("3: warning names opencode/model-x", !!r.warning && r.warning.message.includes("opencode/model-x"), JSON.stringify(r.warning));
  }

  // Case 4: the host is newer but also lacks X, and a successful seed still
  // lacks X. A bad catalog must never be published; keep current + warn.
  {
    const root = makeRoot("ap-cache-fresh-4-");
    const oldSnap = publishSnapshotWith(root, "fresh-v4", ["model-a"]);
    ageModels(oldSnap);
    const host = path.join(root, "host-models.json");
    writeCatalog(host, ["model-a"]); // newer, but no model-x
    const r = ensureOpenCodeCacheSeeded({
      cacheRoot: root,
      versionTagOverride: "fresh-v4",
      requiredModels: ["opencode/model-x"],
      hostModelsPath: host,
      installCommandOverride: asArgv(seedScript(["model-a"])) // seed succeeds but still lacks X
    });
    check("4: missing-from-fresh seed is rejected", r.ok === true && String(r.reason || "").startsWith("seed_missing_models"), JSON.stringify({ok: r.ok, reason: r.reason}));
    check("4: current realpath unchanged", currentRealpath(root) === oldSnap, `${currentRealpath(root)} vs ${oldSnap}`);
    check("4: no bad generation published", listVersions(root).length === 1, JSON.stringify(listVersions(root)));
    check("4: warning names opencode/model-x", !!r.warning && r.warning.message.includes("opencode/model-x"), JSON.stringify(r.warning));
  }

  // Case 5: the host is NOT newer, so the existing seed path must run and a
  // successful seed containing X is published normally.
  {
    const root = makeRoot("ap-cache-fresh-5-");
    const oldSnap = publishSnapshotWith(root, "fresh-v5", ["model-a"]);
    ageModels(oldSnap, 2);
    const host = path.join(root, "older-host-models.json");
    writeCatalog(host, ["model-a", "model-x"]);
    const older = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    fs.utimesSync(host, older, older);
    const r = ensureOpenCodeCacheSeeded({
      cacheRoot: root,
      versionTagOverride: "fresh-v5",
      requiredModels: ["opencode/model-x"],
      hostModelsPath: host,
      installCommandOverride: asArgv(seedScript(["model-a", "model-x"]))
    });
    const now = currentRealpath(root);
    check("5: seed path publishes when the host is not newer", r.ok === true && r.reason === "published", JSON.stringify({ok: r.ok, reason: r.reason}));
    check("5: current moved to a new generation", !!now && now !== oldSnap, `${now} vs ${oldSnap}`);
    check("5: seeded generation contains model-x", !!now && catalogIds(now).has("model-x"), now && [...catalogIds(now)].join(","));
    check("5: old snapshot survives until GC", fs.existsSync(oldSnap), oldSnap);
  }
} finally {
  for (const root of roots) {
    try { fs.rmSync(root, {recursive: true, force: true}); } catch {}
  }
}

if (failures) {
  console.error(`${failures} opencode cache freshness check(s) failed.`);
  process.exit(1);
}
console.log("test-opencode-cache-freshness: ALL CHECKS PASSED");
