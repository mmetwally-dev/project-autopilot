#!/usr/bin/env node
// Backlog #17: sticky role fallback is cleared when the config primary changes
// or after the retry window; `ap reset --scope fallback:<role>` clears one role.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  stampStickyFallback,
  staleStickyFallback,
  clearRoleFallback,
  resolveEffectiveRoleModel,
  FALLBACK_RETRY_PRIMARY_MINUTES,
} from "./role-fallback.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const min = (n) => T0 + n * 60000;
const roleX = {adapter: "opencode", model: "opencode/x", fallbacks: [{adapter: "opencode", model: "opencode/f-free"}]};
const roleY = {...roleX, model: "opencode/y"};
const stamped = stampStickyFallback({adapter: "opencode", model: "opencode/f-free"}, roleX, new Date(T0).toISOString());

// stamp records provenance and still resolves as the effective model
assert.deepEqual(stamped.derivedFrom, {adapter: "opencode", model: "opencode/x"});
assert.equal(stamped.since, "2026-01-01T00:00:00.000Z");
assert.equal(resolveEffectiveRoleModel(roleX, stamped).model, "opencode/f-free");
console.log("PASS stamp-provenance");

// (i) config primary changed -> cleared, config wins
{
  const r = staleStickyFallback({role: "implementer", roleConfig: roleY, activeModel: stamped, nowMs: min(1)});
  assert.equal(r?.why, "config");
  assert.equal(r.message, "fallback cleared: implementer config primary changed (opencode/x → opencode/y)");
  console.log("PASS config-primary-changed");
}

// (ii) older than the window -> cleared (default 60 min); policy override honoured
{
  assert.equal(FALLBACK_RETRY_PRIMARY_MINUTES, 60);
  const r = staleStickyFallback({role: "implementer", roleConfig: roleX, activeModel: stamped, nowMs: min(61)});
  assert.equal(r?.why, "age");
  assert.match(r.message, /^fallback cleared: implementer retrying primary/);
  assert.equal(staleStickyFallback({role: "implementer", roleConfig: roleX, activeModel: stamped, policy: {fallback_retry_primary_minutes: 5}, nowMs: min(6)})?.why, "age");
  assert.equal(staleStickyFallback({role: "implementer", roleConfig: roleX, activeModel: stamped, policy: {fallback_retry_primary_minutes: 120}, nowMs: min(61)}), null);
  console.log("PASS age-window");
}

// (iii) younger entry, same primary -> kept
{
  assert.equal(staleStickyFallback({role: "implementer", roleConfig: roleX, activeModel: stamped, nowMs: min(59)}), null);
  assert.equal(staleStickyFallback({role: "implementer", roleConfig: roleX, activeModel: null, nowMs: min(999)}), null);
  console.log("PASS young-same-primary-kept");
}

// (iv) legacy entry (no derivedFrom/since): never cleared by config change;
// no timestamp -> kept; with only `since` it is cleared by age.
{
  const legacy = {adapter: "opencode", model: "opencode/f-free"};
  assert.equal(staleStickyFallback({role: "implementer", roleConfig: roleY, activeModel: legacy, nowMs: min(9999)}), null);
  const legacyOld = {...legacy, since: new Date(T0).toISOString()};
  assert.equal(staleStickyFallback({role: "implementer", roleConfig: roleY, activeModel: legacyOld, nowMs: min(10)}), null);
  assert.equal(staleStickyFallback({role: "implementer", roleConfig: roleY, activeModel: legacyOld, nowMs: min(61)})?.why, "age");
  // Backlog #42: a config edit after a legacy sticky fallback was selected
  // proves the primary may have changed; that config change wins.
  const r = staleStickyFallback({role: "implementer", roleConfig: roleY, activeModel: legacyOld, nowMs: min(10), configMtimeMs: T0 + 1000});
  assert.equal(r?.why, "config");
  assert.match(r.message, /config changed after the fallback was selected/);
  assert.equal(staleStickyFallback({role: "implementer", roleConfig: roleY, activeModel: legacyOld, nowMs: min(10), configMtimeMs: T0 - 1000}), null);
  console.log("PASS legacy-entry");
}

// (v) clearing one role leaves the others; reset scope + wiring present in source
{
  const out = clearRoleFallback({implementer: stamped, planner: stamped}, "implementer");
  assert.deepEqual(Object.keys(out), ["planner"]);
  assert.ok(src.includes("function resetFallbackCommand(s,role)"), "reset handler missing");
  assert.ok(src.includes('scopeArg.startsWith("fallback:")'), "scope dispatch missing");
  const body = src.slice(src.indexOf("function resetFallbackCommand"), src.indexOf("function resetCommand"));
  assert.ok(body.includes("delete s.activeRoleModels[role]") && body.includes("delete s.triedFreeModels[role]"), "must clear only the named role");
  assert.ok(src.includes("stampStickyFallback(decision.next"), "writer must stamp provenance");
  assert.ok((src.match(/syncStickyFallback\(s,c,/g) || []).length >= 2, "runRelay and helper must sync");
  assert.ok(src.includes("effectiveRoleModelFor(s,c,fixer)"), "escalation trigger must use the shared helper");
  const g = src.slice(src.indexOf("function clearAllSpentCounters"), src.indexOf("function applyPendingGlobalReset"));
  assert.ok(g.includes("s.activeRoleModels={}") && g.includes("s.triedFreeModels={}"), "bare reset must clear all");
  console.log("PASS reset-scope-and-wiring");
}
