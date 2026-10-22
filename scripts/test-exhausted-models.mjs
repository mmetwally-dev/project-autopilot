#!/usr/bin/env node
// Backlog #18: mission-wide exhausted-model list (and #5 prefix display).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {
  markExhausted,
  isExhausted,
  pruneExhausted,
  skipExhaustedRoleModel,
  staleStickyFallback,
} from "./role-fallback.mjs";
import {extendFallbackWithFree} from "./free-fallback-discovery.mjs";
import {makeFixtureRepo, writeConfig, cleanup} from "./test-fixtures/workflow-order-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const min = (n) => T0 + n * 60000;
const P = {adapter: "opencode", model: "opencode/primary-free"};
const F1 = {adapter: "opencode", model: "opencode/f1-free"};
const F2 = {adapter: "opencode", model: "opencode/f2-free"};
const roleConfig = {...P, fallbacks: [F1, F2]};

// mark + active within window / expired after it
{
  const empty = {};
  const marked = markExhausted(empty, P, "implementer", iso(T0));
  assert.deepEqual(marked["opencode/primary-free"], {at: iso(T0), reason: "RATE_LIMITED", by: "implementer"});
  assert.deepEqual(empty, {}, "markExhausted must not mutate its input");
  assert.equal(isExhausted(marked, P, null, min(59)), true, "active within 60 min");
  assert.equal(isExhausted(marked, P, null, min(60)), false, "expired at the 60 min boundary");
  assert.equal(isExhausted(marked, F1, null, min(1)), false, "a different model is not exhausted");
  console.log("PASS mark-and-window");
}

// policy override changes the window
{
  const marked = markExhausted({}, P, "implementer", iso(T0));
  assert.equal(isExhausted(marked, P, {fallback_retry_primary_minutes: 5}, min(4)), true);
  assert.equal(isExhausted(marked, P, {fallback_retry_primary_minutes: 5}, min(5)), false);
  assert.equal(isExhausted(marked, P, {fallback_retry_primary_minutes: 120}, min(61)), true);
  const pruned = pruneExhausted(marked, {fallback_retry_primary_minutes: 5}, min(5));
  assert.deepEqual(pruned, {}, "prune drops expired entries");
  assert.deepEqual(marked, {"opencode/primary-free": {at: iso(T0), reason: "RATE_LIMITED", by: "implementer"}},
    "prune must not mutate its input");
  console.log("PASS policy-override-and-prune");
}

// before a run: primary exhausted + a usable fallback -> switch without a run
{
  const exhausted = markExhausted({}, P, "implementer", iso(T0));
  const d = skipExhaustedRoleModel({role: "verifier", roleConfig, activeModel: null, exhausted, nowMs: min(10)});
  assert.equal(d.action, "switch");
  assert.deepEqual(d.next, F1, "first non-exhausted configured fallback wins");
  // An exhausted first fallback is skipped for the second.
  const skipFirst = markExhausted(exhausted, F1, "implementer", iso(T0));
  const d2 = skipExhaustedRoleModel({role: "verifier", roleConfig, activeModel: null, exhausted: skipFirst, nowMs: min(10)});
  assert.equal(d2.action, "switch");
  assert.deepEqual(d2.next, F2);
  // The effective model itself is fine -> never switch.
  const fine = skipExhaustedRoleModel({role: "verifier", roleConfig, activeModel: null, exhausted: {}, nowMs: min(10)});
  assert.equal(fine.action, "none");
  console.log("PASS skip-before-run");
}

// all candidates exhausted -> no skip (today's run/escalation path)
{
  let exhausted = markExhausted({}, P, "implementer", iso(T0));
  exhausted = markExhausted(exhausted, F1, "verifier", iso(T0));
  exhausted = markExhausted(exhausted, F2, "planner", iso(T0));
  const d = skipExhaustedRoleModel({role: "verifier", roleConfig, activeModel: null, exhausted, nowMs: min(10)});
  assert.equal(d.action, "none", "all candidates exhausted must not skip the run");
  // Expired entries are not candidates either, so the same model may run.
  const aged = skipExhaustedRoleModel({role: "verifier", roleConfig, activeModel: null, exhausted, nowMs: min(61)});
  assert.equal(aged.action, "none");
  console.log("PASS all-exhausted-no-skip");
}

// free auto-discovery skips mission-exhausted free models
{
  const freeCfg = {...P, fallbacks: []};
  let exhausted = markExhausted({}, F1, "implementer", iso(T0));
  const d = await extendFallbackWithFree({
    decision: {action: "escalate", reason: "test"},
    role: "verifier",
    roleConfig: freeCfg,
    activeModel: null,
    failureClass: "RATE_LIMITED",
    discover: async () => [F1.model, F2.model],
    exhausted,
    nowMs: min(10),
  });
  assert.equal(d.action, "switch");
  assert.deepEqual(d.next, F2, "exhausted free model is skipped");
  console.log("PASS free-discovery-skips-exhausted");
}

// wiring: runRelay skips before the run and records every RATE_LIMITED model
{
  const src = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
  const runRelay = src.slice(src.indexOf("async function runRelay("), src.indexOf("function guardedShell("));
  assert.ok(runRelay.includes("skipExhaustedRoleModel({role:roleName"), "runRelay must use the pre-run skip helper");
  assert.ok(runRelay.includes("isExhausted(s.exhaustedModels,effective"), "pre-run skip must check the effective model");
  assert.ok(runRelay.includes("skipExhaustedRoleModel") && runRelay.includes("skipped, exhausted by"),
    "the skip must be logged in the ap log");
  assert.ok(runRelay.includes("markExhausted(s.exhaustedModels,from,roleName"), "RATE_LIMITED runs must be recorded mission-wide");
  assert.ok(runRelay.includes("exhausted:s.exhaustedModels") && runRelay.includes("policy:c.policy"),
    "chain walking and free discovery must receive the exhausted map");
  console.log("PASS wiring");
}

// reset: bare clears all; fallback:<role> clears only that role's entries
{
  const repos = [];
  const makeRepo = (state) => {
    const repo = makeFixtureRepo("exhausted-models");
    writeConfig(repo, {planningFramework: "standalone"});
    repos.push(repo);
    fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(state, null, 2));
    return repo;
  };
  const readState = (repo) => JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
  const run = (args, repo) => spawnSync(process.execPath, [path.join(skillRoot, "bin", "ap.cjs"), ...args, "--repo", repo], {encoding: "utf8"});
  const base = (extra = {}) => ({
    version: 1, phase: "escalated", step: "standalone-plan",
    mission: "999-test-mission", missionSeq: "999",
    ...extra,
  });
  try {
    const entry = {at: iso(T0), reason: "RATE_LIMITED", by: "implementer"};
    const repo = makeRepo(base({exhaustedModels: {"opencode/opencode/x": entry}}));
    const r = run(["reset"], repo);
    assert.equal(r.status, 0, `bare reset with exhausted models must succeed: ${r.stdout}${r.stderr}`);
    assert.deepEqual(readState(repo).exhaustedModels, {}, "bare reset clears exhaustedModels");
    assert.ok(`${r.stdout}${r.stderr}`.includes("exhaustedModels:opencode/opencode/x"), "reset lists the cleared entry");

    const repo2 = makeRepo(base({exhaustedModels: {
      "opencode/opencode/a": {at: iso(T0), reason: "RATE_LIMITED", by: "implementer"},
      "opencode/opencode/b": {at: iso(T0), reason: "RATE_LIMITED", by: "verifier"},
    }}));
    const r2 = run(["reset", "--scope", "fallback:implementer"], repo2);
    assert.equal(r2.status, 0, `scoped reset must succeed: ${r2.stdout}${r2.stderr}`);
    assert.deepEqual(readState(repo2).exhaustedModels, {
      "opencode/opencode/b": {at: iso(T0), reason: "RATE_LIMITED", by: "verifier"},
    }, "only the named role's exhausted entries are cleared");
  } finally {
    cleanup(...repos);
  }
  console.log("PASS reset-clears");
}

// prefix display: the retrying-primary line never doubles opencode/
{
  const active = {adapter: "opencode", model: "opencode/fallback-free", since: iso(T0)};
  const stale = staleStickyFallback({
    role: "implementer",
    roleConfig: {adapter: "opencode", model: "opencode/x"},
    activeModel: active,
    policy: {fallback_retry_primary_minutes: 60},
    nowMs: min(61),
  });
  assert.equal(stale?.why, "age");
  assert.ok(stale.message.includes("retrying primary opencode/x"), stale.message);
  assert.ok(!stale.message.includes("opencode/opencode/x"), `must not double the prefix: ${stale.message}`);
  console.log("PASS prefix-display");
}

console.log("test-exhausted-models: all cases passed");
