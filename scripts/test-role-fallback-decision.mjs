#!/usr/bin/env node
// Mission 087 task 1.1: pure per-role fallback decision unit tests.
// Covers next-fallback order, sticky active model, exhausted → escalate,
// non-RATE_LIMITED → no switch, reset helper, and module purity (no imports).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  RATE_LIMITED_FAILURE_CLASS,
  decideRoleFallback,
  resolveEffectiveRoleModel,
  resetRoleFallbacks,
  clearRoleFallback,
  formatRoleFallbackLog,
} from "./role-fallback.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleSrc = fs.readFileSync(path.join(here, "role-fallback.mjs"), "utf8");

const PRIMARY = {adapter: "opencode", model: "muse-spark"};
const FIRST = {adapter: "opencode", model: "longcat"};
const SECOND = {adapter: "claude", model: "haiku", reasoning: "medium"};
const ROLE = {
  adapter: PRIMARY.adapter,
  model: PRIMARY.model,
  fallbacks: [FIRST, SECOND],
};

// 1. Order: primary RATE_LIMITED → first fallback, then second.
{
  const d1 = decideRoleFallback({role: "implementer", roleConfig: ROLE, activeModel: null, failureClass: "RATE_LIMITED"});
  assert.equal(d1.action, "switch", "primary RATE_LIMITED switches");
  assert.deepEqual(d1.next, FIRST, "first switch is fallbacks[0]");
  const d2 = decideRoleFallback({role: "implementer", roleConfig: ROLE, activeModel: FIRST, failureClass: "RATE_LIMITED"});
  assert.equal(d2.action, "switch", "first fallback RATE_LIMITED switches again");
  assert.deepEqual(d2.next, SECOND, "second switch is fallbacks[1] in order");
  console.log("PASS order-primary-then-fallbacks");
}

// 2. Sticky: effective model follows the active entry; decisions start there.
{
  assert.deepEqual(resolveEffectiveRoleModel(ROLE, null), PRIMARY, "no active → primary");
  assert.deepEqual(resolveEffectiveRoleModel(ROLE, FIRST), FIRST, "active first → first stays");
  assert.deepEqual(resolveEffectiveRoleModel(ROLE, SECOND), SECOND, "active second → second stays");
  const again = decideRoleFallback({role: "implementer", roleConfig: ROLE, activeModel: SECOND, failureClass: "RATE_LIMITED"});
  assert.equal(again.action, "escalate", "sticky last fallback has nothing left");
  console.log("PASS sticky-active-model");
}

// 3. Exhausted → escalate (all fallbacks tried; also no fallbacks at all).
{
  const exhausted = decideRoleFallback({role: "implementer", roleConfig: ROLE, activeModel: SECOND, failureClass: "RATE_LIMITED"});
  assert.equal(exhausted.action, "escalate", "exhausted fallbacks escalate");
  const bare = decideRoleFallback({role: "implementer", roleConfig: PRIMARY, activeModel: null, failureClass: "RATE_LIMITED"});
  assert.equal(bare.action, "escalate", "role without fallbacks escalates");
  console.log("PASS exhausted-escalates");
}

// 4. Non-RATE_LIMITED → no switch, whatever the fallback list.
{
  for (const failureClass of ["TIMEOUT", "INTERNAL_CONTRACT_ERROR", "AGENT_FAILED", "COMPLETED", undefined, null]) {
    const d = decideRoleFallback({role: "implementer", roleConfig: ROLE, activeModel: null, failureClass});
    assert.equal(d.action, "none", `class ${String(failureClass)} never switches`);
    assert.ok(!("next" in d), "no-switch decision carries no next model");
  }
  console.log("PASS non-rate-limited-no-switch");
}

// 5. Reset helper: fresh map is empty; effective model is primary again;
//    clearing one role leaves the others untouched; inputs are not mutated.
{
  const fresh = resetRoleFallbacks();
  assert.deepEqual(fresh, {}, "reset returns an empty sticky map");
  assert.deepEqual(resolveEffectiveRoleModel(ROLE, fresh.implementer ?? null), PRIMARY, "fresh state resolves to primary");
  const sticky = {implementer: FIRST, planner: SECOND};
  const cleared = clearRoleFallback(sticky, "implementer");
  assert.deepEqual(cleared, {planner: SECOND}, "clear drops only the named role");
  assert.deepEqual(sticky, {implementer: FIRST, planner: SECOND}, "clear does not mutate the input");
  assert.deepEqual(resolveEffectiveRoleModel(ROLE, cleared.implementer ?? null), PRIMARY, "cleared role resolves to primary");
  console.log("PASS reset-helper");
}

// 6. Log line format matches the mission contract.
{
  const line = formatRoleFallbackLog({role: "implementer", from: PRIMARY, to: FIRST, reason: "RATE_LIMITED"});
  assert.equal(line, "fallback: implementer opencode/muse-spark → opencode/longcat (RATE_LIMITED)", "log line format");
  console.log("PASS log-line-format");
}

// 6b. Silent IDLE_HANG (0 bytes) switches like RATE_LIMITED; other IDLE_HANG does not.
{
  const d1 = decideRoleFallback({role: "implementer", roleConfig: ROLE, activeModel: null, failureClass: "IDLE_HANG", noOutput: true});
  assert.equal(d1.action, "switch", "silent IDLE_HANG switches");
  assert.deepEqual(d1.next, FIRST);
  const d2 = decideRoleFallback({role: "implementer", roleConfig: ROLE, activeModel: FIRST, failureClass: "IDLE_HANG", noOutput: true});
  assert.deepEqual(d2.next, SECOND, "sticky order");
  const d3 = decideRoleFallback({role: "implementer", roleConfig: ROLE, activeModel: SECOND, failureClass: "IDLE_HANG", noOutput: true});
  assert.equal(d3.action, "none", "exhausted silent IDLE_HANG keeps today's retry (no escalate)");
  const d4 = decideRoleFallback({role: "implementer", roleConfig: PRIMARY, failureClass: "IDLE_HANG", noOutput: true});
  assert.equal(d4.action, "none", "no fallbacks: none");
  const d5 = decideRoleFallback({role: "implementer", roleConfig: ROLE, failureClass: "IDLE_HANG", noOutput: false});
  assert.equal(d5.action, "none", "IDLE_HANG after output: none");
  const d6 = decideRoleFallback({role: "implementer", roleConfig: ROLE, failureClass: "IDLE_HANG"});
  assert.equal(d6.action, "none", "IDLE_HANG without flag: none");
  const d7 = decideRoleFallback({role: "implementer", roleConfig: ROLE, failureClass: "TIMEOUT", noOutput: true});
  assert.equal(d7.action, "none", "other class with flag: none");
  console.log("PASS silent-idle-hang-switch");
}

// 7. Purity: the decision module has no imports (no IO/state/config access).
{
  assert.ok(!/^\s*import\s/m.test(moduleSrc), "module has no import statements");
  assert.ok(!/^import\s/m.test(moduleSrc), "module has no static imports");
  assert.ok(!moduleSrc.includes("require("), "module has no require calls");
  assert.ok(!moduleSrc.includes("node:"), "module imports no node builtins");
  assert.ok(!moduleSrc.includes("process."), "module touches no process globals");
  assert.equal(RATE_LIMITED_FAILURE_CLASS, "RATE_LIMITED", "rate-limit class constant");
  console.log("PASS module-pure-no-imports");
}

console.log("test-role-fallback-decision: all cases passed");
