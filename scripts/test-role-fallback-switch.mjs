#!/usr/bin/env node
// Mission 087 task 2.1: relay runtime fallback switch.
// Source-level (autopilot.mjs runs main() on import, so it cannot be
// imported) plus functional simulation through the Phase 1 module using the
// exact call shapes the runRelay wiring uses.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  decideRoleFallback,
  resolveEffectiveRoleModel,
  formatRoleFallbackLog,
} from "./role-fallback.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");

// 1. activeRoleModels is mission-scoped state.
{
  const keysBlock = src.slice(src.indexOf("MISSION_SCOPED_STATE_KEYS=Object.freeze(["),
    src.indexOf("MISSION_SCOPED_STATE_KEYS=Object.freeze([") + 2500);
  assert.ok(keysBlock.includes('"activeRoleModels"') || keysBlock.includes("'activeRoleModels'"),
    "MISSION_SCOPED_STATE_KEYS must include activeRoleModels");
  console.log("PASS mission-scoped-activeRoleModels");
}

// 2. runRelay consults the Phase 1 module and builds the effective role.
{
  assert.ok(src.includes('from "./role-fallback.mjs"'), "autopilot must import the role-fallback module");
  for (const name of ["decideRoleFallback", "resolveEffectiveRoleModel", "formatRoleFallbackLog"]) {
    assert.ok(src.includes(name), `autopilot must use ${name}`);
  }
  assert.ok(src.includes("s.activeRoleModels"), "wiring must read/persist s.activeRoleModels");
  assert.ok(/resolveEffectiveRoleModel\(rawRole/.test(src) || /resolveEffectiveRoleModel\(c\.roles/.test(src),
    "effective adapter/model must be built from the sticky state");
  assert.ok(src.includes("reasoning:undefined") && src.includes("variant:undefined"),
    "effective merge must clear primary reasoning/variant so a fallback without its own values never inherits them");
  console.log("PASS phase1-module-consulted");
}

// 3. Choke point: RATE_LIMITED → persist + log line; relay/relayAsync share it.
{
  const runRelay = src.slice(src.indexOf("async function runRelay("));
  assert.ok(runRelay.includes('result?.failure?.class==="RATE_LIMITED"'),
    "switch must trigger on the RATE_LIMITED result failure class");
  assert.ok(runRelay.includes("decideRoleFallback({role:roleName"), "decision must carry the role name");
  assert.ok(runRelay.includes("s.activeRoleModels={"), "switch must persist s.activeRoleModels[role]");
  assert.ok(runRelay.includes("formatRoleFallbackLog({role:roleName,from,to:decision.next"),
    "switch must print the fallback log line");
  assert.ok(runRelay.includes("fallbackSwitch"), "switched result must carry a fallbackSwitch marker");
  assert.ok(src.includes("return guardRelay(runRelay("), "relay() must wrap runRelay");
  const relayAsync = src.slice(src.indexOf("async function relayAsync("), src.indexOf("async function relayAsync(") + 600);
  assert.ok(relayAsync.includes("runRelay(roleName,task,c,s"), "relayAsync must call runRelay directly");
  console.log("PASS choke-point-covers-all-callers");
}

// 4. Functional: state records the active model; a second run of the same
//    role resolves the fallback effective model (mirrors the wiring shapes).
{
  const roleConfig = {
    adapter: "opencode", model: "primary",
    fallbacks: [{ adapter: "opencode", model: "fallback-one" }],
  };
  const s = {};
  // First run launches the primary.
  assert.deepEqual(resolveEffectiveRoleModel(roleConfig, s.activeRoleModels?.implementer ?? null),
    { adapter: "opencode", model: "primary" }, "first run uses the primary");
  // RATE_LIMITED on the first run switches, exactly as the choke point does.
  const failureClass = "RATE_LIMITED";
  const from = resolveEffectiveRoleModel(roleConfig, s.activeRoleModels?.implementer ?? null);
  const decision = decideRoleFallback({
    role: "implementer", roleConfig, activeModel: s.activeRoleModels?.implementer ?? null, failureClass,
  });
  assert.equal(decision.action, "switch", "RATE_LIMITED with a fallback left switches");
  s.activeRoleModels = { ...(s.activeRoleModels || {}), implementer: decision.next };
  const line = formatRoleFallbackLog({ role: "implementer", from, to: decision.next, reason: failureClass });
  assert.ok(/^fallback: implementer \S+ → \S+ \(.+\)$/.test(line), `log line shape, got: ${line}`);
  assert.equal(line, "fallback: implementer opencode/primary → opencode/fallback-one (RATE_LIMITED)");
  // Second run of the same role uses the fallback effective model.
  assert.deepEqual(resolveEffectiveRoleModel(roleConfig, s.activeRoleModels?.implementer ?? null),
    { adapter: "opencode", model: "fallback-one" }, "second run uses the fallback");
  assert.deepEqual(s.activeRoleModels.implementer, { adapter: "opencode", model: "fallback-one" },
    "state records the active model");
  console.log("PASS sticky-second-run-uses-fallback");
}

// 5. Functional: a relayAsync caller (e.g. plan_reviewer) switches to its
//    own fallback independently of other roles.
{
  const s = { activeRoleModels: { implementer: { adapter: "opencode", model: "fallback-one" } } };
  const reviewerConfig = {
    adapter: "claude", model: "review-primary",
    fallbacks: [{ adapter: "claude", model: "review-fallback" }],
  };
  const decision = decideRoleFallback({
    role: "plan_reviewer", roleConfig: reviewerConfig,
    activeModel: s.activeRoleModels?.plan_reviewer ?? null, failureClass: "RATE_LIMITED",
  });
  assert.equal(decision.action, "switch", "plan_reviewer RATE_LIMITED switches");
  s.activeRoleModels = { ...(s.activeRoleModels || {}), plan_reviewer: decision.next };
  assert.deepEqual(resolveEffectiveRoleModel(reviewerConfig, s.activeRoleModels.plan_reviewer),
    { adapter: "claude", model: "review-fallback" }, "relayAsync role uses its fallback");
  assert.deepEqual(s.activeRoleModels.implementer, { adapter: "opencode", model: "fallback-one" },
    "other roles keep their own sticky entry");
  // Non-RATE_LIMITED never switches, even with fallbacks configured.
  const other = decideRoleFallback({
    role: "plan_reviewer", roleConfig: reviewerConfig,
    activeModel: s.activeRoleModels.plan_reviewer, failureClass: "TIMEOUT",
  });
  assert.equal(other.action, "none", "non-RATE_LIMITED never switches");
  console.log("PASS relayAsync-role-switches-independently");
}

// 6. Functional: the runRelay merge shape clears primary reasoning/variant
//    so a fallback entry without its own values runs bare (never with
//    effort/variant flags validated only against the primary adapter).
{
  const rawRole = {
    adapter: "opencode", model: "primary", reasoning: "high", variant: "primary-variant",
    fallbacks: [{ adapter: "other", model: "fallback-one" }],
  };
  const sticky = resolveEffectiveRoleModel(rawRole, { adapter: "other", model: "fallback-one" });
  // Mirror the runRelay merge exactly.
  const role = { ...rawRole, reasoning: undefined, variant: undefined, ...sticky };
  assert.equal(role.adapter, "other", "fallback adapter applies");
  assert.equal(role.model, "fallback-one", "fallback model applies");
  assert.equal(role.reasoning, undefined, "fallback without reasoning must not inherit primary reasoning");
  assert.equal(role.variant, undefined, "fallback without variant must not inherit primary variant");
  // A fallback with its own values still applies them.
  const rawRole2 = {
    adapter: "opencode", model: "primary", reasoning: "high", variant: "primary-variant",
    fallbacks: [{ adapter: "other", model: "fallback-two", reasoning: "low" }],
  };
  const sticky2 = resolveEffectiveRoleModel(rawRole2, { adapter: "other", model: "fallback-two", reasoning: "low" });
  const role2 = { ...rawRole2, reasoning: undefined, variant: undefined, ...sticky2 };
  assert.equal(role2.reasoning, "low", "fallback's own reasoning applies");
  assert.equal(role2.variant, undefined, "fallback without variant stays bare");
  console.log("PASS fallback-clears-primary-reasoning-variant");
}

console.log("test-role-fallback-switch: all cases passed");
