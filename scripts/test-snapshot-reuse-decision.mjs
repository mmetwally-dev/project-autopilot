// Minimal decision-module test (mission 084, task 1.1).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SNAPSHOT_REUSE_MAX_GAP_MS,
  SNAPSHOT_CACHE_VERSION,
  SNAPSHOT_EXCLUDED_DIR_SEGMENTS,
  collectSnapshotGuards,
  decideSnapshotReuse,
  getRepoIdentity,
  getSnapshotCacheKey,
  getSnapshotCacheScopeVersion,
  makeCacheEntry,
  snapshotReuseCache,
} from "./snapshot-reuse-cache.mjs";
import { SNAPSHOT_EXCLUDED_DIR_SEGMENTS as RelaySegments } from "./relay-guards.mjs";

assert.equal(SNAPSHOT_REUSE_MAX_GAP_MS, 60000, "gap constant must be 60000");
assert.ok(snapshotReuseCache instanceof Map, "store must be a Map");
assert.equal(typeof decideSnapshotReuse, "function");
assert.equal(typeof collectSnapshotGuards, "function");
assert.equal(typeof getSnapshotCacheKey, "function");

// Scope/version key derives from relay-guards segments.
assert.deepEqual([...SNAPSHOT_EXCLUDED_DIR_SEGMENTS].sort(), [...RelaySegments].sort());
const scopeVersion = getSnapshotCacheScopeVersion();
assert.ok(scopeVersion.startsWith(`v${SNAPSHOT_CACHE_VERSION}:`));
assert.ok(scopeVersion.includes("node_modules"));

// Fresh-on-doubt default: every dubious input takes fresh.
for (const [entry, guards, gap, events] of [
  [null, null, 0, []],
  [undefined, { head: "x" }, 0, []],
  [{ guards: {} }, null, 0, []],
  [{ guards: {} }, { head: "x" }, Number.NaN, []],
  [{ guards: {} }, { head: "x" }, undefined, []],
]) {
  const decision = decideSnapshotReuse(entry, guards, gap, events);
  assert.equal(decision.reuse, false, "doubt must take fresh");
  assert.ok(typeof decision.reason === "string" && decision.reason.length > 0);
}

// Fresh-on-doubt hardening: unknown event history, missing identity/scope,
// and error-placeholder guard values must all take fresh — even when both
// sides agree.
{
  const goodGuards = {
    repoIdentity: "/repo",
    scopeVersion: "v1:a,b",
    head: "abc123",
    indexHash: "index1",
    indexMtimeMs: 123,
    statusHash: "status1",
  };
  const goodEntry = {
    repoIdentity: "/repo",
    scopeVersion: "v1:a,b",
    guards: { ...goodGuards },
  };
  // Non-array eventsSince hides possible invalidations → fresh.
  for (const badEvents of [undefined, null, "gates", {}, 0]) {
    const d = decideSnapshotReuse(goodEntry, goodGuards, 0, badEvents);
    assert.equal(d.reuse, false, `non-array events must take fresh: ${String(badEvents)}`);
  }
  // Missing scopeVersion or repoIdentity on either side → fresh.
  for (const [e, g, label] of [
    [{ ...goodEntry, scopeVersion: undefined }, goodGuards, "entry scopeVersion missing"],
    [goodEntry, { ...goodGuards, scopeVersion: undefined }, "guards scopeVersion missing"],
    [{ ...goodEntry, repoIdentity: undefined }, goodGuards, "entry repoIdentity missing"],
    [goodEntry, { ...goodGuards, repoIdentity: undefined }, "guards repoIdentity missing"],
    [{ ...goodEntry, scopeVersion: undefined }, { ...goodGuards, scopeVersion: undefined }, "both scopeVersion missing"],
    [{ ...goodEntry, repoIdentity: undefined }, { ...goodGuards, repoIdentity: undefined }, "both repoIdentity missing"],
  ]) {
    const d = decideSnapshotReuse(e, g, 0, []);
    assert.equal(d.reuse, false, `${label} must take fresh`);
  }
  // Error-placeholder guard values never count as a match, even on both sides.
  for (const [field, placeholder] of [
    ["head", "UNKNOWN"],
    ["head", "UNBORN"],
    ["indexHash", "MISSING"],
    ["indexHash", "UNKNOWN"],
    ["statusHash", "UNKNOWN"],
  ]) {
    const pe = { ...goodEntry, guards: { ...goodGuards, [field]: placeholder } };
    const pg = { ...goodGuards, [field]: placeholder };
    const d = decideSnapshotReuse(pe, pg, 0, []);
    assert.equal(d.reuse, false, `placeholder ${field}=${placeholder} must take fresh`);
    assert.ok(d.reason.includes(`guard ${field}`), `placeholder reason names ${field}`);
  }
}

// Guard collector against a tiny temp repo (outside the project repo).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-guards-"));
execFileSync("git", ["init", "-q"], { cwd: tmp });
execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: tmp });
execFileSync("git", ["config", "user.name", "t"], { cwd: tmp });
fs.writeFileSync(path.join(tmp, "a.txt"), "hello\n");
execFileSync("git", ["add", "a.txt"], { cwd: tmp });
execFileSync("git", ["commit", "-qm", "init"], { cwd: tmp });
const guards = collectSnapshotGuards(tmp);
assert.ok(guards.head && guards.head !== "UNKNOWN" && guards.head !== "UNBORN");
assert.ok(guards.statusHash && guards.statusHash !== "UNKNOWN");
assert.ok(guards.indexHash && guards.indexHash !== "MISSING");
assert.equal(guards.scopeVersion, scopeVersion);
assert.equal(guards.repoIdentity, getRepoIdentity(tmp));
assert.equal(getSnapshotCacheKey(tmp), `${guards.repoIdentity}::${guards.scopeVersion}`);

// Entry stores the guard values; identical guards reuse.
const entry = makeCacheEntry(tmp, { fingerprint: "fake" }, guards);
assert.deepEqual(entry.guards, {
  head: guards.head,
  indexHash: guards.indexHash,
  indexMtimeMs: guards.indexMtimeMs,
  statusHash: guards.statusHash,
});
const reuse = decideSnapshotReuse(entry, guards, 0, []);
assert.equal(reuse.reuse, true);
assert.equal(reuse.reason, "snapshot reused");
console.log(`happy-path reuse: ${reuse.reason}`);

// Scenario a (gates between runs): invalidation event forces fresh.
const gateDecision = decideSnapshotReuse(entry, guards, 1000, [
  { type: "gates", reason: "gates ran between runs" },
]);
assert.equal(gateDecision.reuse, false);
assert.ok(gateDecision.reason.includes("gates ran between runs"));
console.log(`scenario a (gates): fresh — ${gateDecision.reason}`);

// Scenario b (orchestrator tracked writes): mark_tasks / checkbox write forces fresh.
const trackedDecision = decideSnapshotReuse(entry, guards, 1000, [
  { type: "orchestrator-tracked-write", reason: "mark_tasks tracked write" },
]);
assert.equal(trackedDecision.reuse, false);
assert.ok(trackedDecision.reason.includes("mark_tasks tracked write"));
console.log(`scenario b (tracked write): fresh — ${trackedDecision.reason}`);

// Scenario c (phase re-baseline): expectedWorkingFingerprint forces fresh.
const rebaselineDecision = decideSnapshotReuse(entry, guards, 1000, [
  { type: "phase-rebaseline", reason: "expectedWorkingFingerprint re-baseline" },
]);
assert.equal(rebaselineDecision.reuse, false);
assert.ok(rebaselineDecision.reason.includes("expectedWorkingFingerprint re-baseline"));
console.log(`scenario c (re-baseline): fresh — ${rebaselineDecision.reason}`);

// Scenario d (gap activity): guard mismatch catches visible changes...
fs.writeFileSync(path.join(tmp, "b.txt"), "gap activity\n");
const driftedGuards = collectSnapshotGuards(tmp);
assert.notEqual(driftedGuards.statusHash, guards.statusHash);
const guardDecision = decideSnapshotReuse(entry, driftedGuards, 1000, []);
assert.equal(guardDecision.reuse, false);
assert.ok(guardDecision.reason.includes("guard statusHash changed"));
console.log(`scenario d (guard catch): fresh — ${guardDecision.reason}`);

// ...and the short-gap rule catches the rest (e.g. ignored-file-only drift).
const gapDecision = decideSnapshotReuse(
  entry,
  guards,
  SNAPSHOT_REUSE_MAX_GAP_MS + 1,
  [],
);
assert.equal(gapDecision.reuse, false);
assert.equal(gapDecision.reason, "gap exceeds reuse window");
console.log(`scenario d (short-gap rule): fresh — ${gapDecision.reason}`);

// Scenario e (restart/stop/cancel/crash/escalation/resume): in-process cache
// does not survive a new process — a fresh module instance starts empty.
const eHelper = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-reuse-e-")),
  "check-empty.mjs",
);
fs.writeFileSync(
  eHelper,
  `import assert from "node:assert/strict";\n` +
    `import { snapshotReuseCache } from ${JSON.stringify(new URL("./snapshot-reuse-cache.mjs", import.meta.url).href)};\n` +
    `assert.ok(snapshotReuseCache instanceof Map);\n` +
    `assert.equal(snapshotReuseCache.size, 0, "fresh process must start cache-empty");\n` +
    `console.log("scenario e helper: cache starts empty in a new process");\n`,
);
execFileSync("node", [eHelper], { stdio: "inherit" });
const eDecision = decideSnapshotReuse(null, guards, 0, []);
assert.equal(eDecision.reuse, false);
assert.equal(eDecision.reason, "no cached snapshot");
console.log(
  `scenario e (restart/stop/cancel/crash/escalation/resume): fresh — ${eDecision.reason} (new process cache empty)`,
);

// Scenario f (rollover relaunch): all 5 conditions hold → reuse.
const fDecision = decideSnapshotReuse(entry, guards, 1000, []);
assert.equal(fDecision.reuse, true);
assert.equal(fDecision.reason, "snapshot reused");
console.log(`scenario f (rollover relaunch): ${fDecision.reason}`);

// Scenario g (previous policy violation): invalidation event forces fresh and
// nothing is reused.
const gDecision = decideSnapshotReuse(entry, guards, 1000, [
  { type: "policy-violation", reason: "previous policy violation" },
]);
assert.equal(gDecision.reuse, false);
assert.ok(gDecision.reason.includes("previous policy violation"));
console.log(`scenario g (policy violation): fresh — ${gDecision.reason}`);

// Scenario h (scope/version change): never reuse across a scope/version bump.
const bumpedGuards = { ...guards, scopeVersion: `${guards.scopeVersion}+bump` };
const hDecision = decideSnapshotReuse(entry, bumpedGuards, 0, []);
assert.equal(hDecision.reuse, false);
assert.equal(hDecision.reason, "snapshot scope/version changed");
console.log(`scenario h (scope/version change): fresh — ${hDecision.reason}`);

fs.rmSync(path.dirname(eHelper), { recursive: true, force: true });
fs.rmSync(tmp, { recursive: true, force: true });
console.log("snapshot-reuse decision minimal checks passed");
