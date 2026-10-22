import assert from "node:assert/strict";
import {isFreeModel} from "./free-model.mjs";
import {resolvePerRoleLimits, resolveFreeModelTurnsCap} from "./per-task-budget.mjs";
const OC = "-free$";
const free = {adapter: "opencode", model: "opencode/glm-free", free_model_pattern: OC};
const paid = {adapter: "opencode", model: "opencode/gpt-5", free_model_pattern: OC};
for (const role of ["implementer", "planner", "plan_reviewer", "code_reviewer", "verifier"]) {
  const normal = resolvePerRoleLimits(role, {}).perTaskMaxTurns;
  assert.equal(resolvePerRoleLimits(role, {}, free).perTaskMaxTurns, Math.max(normal, 45), role);
  assert.equal(resolvePerRoleLimits(role, {}, paid).perTaskMaxTurns, normal, role);
}
assert.equal(resolvePerRoleLimits("implementer", {}, {adapter: "claude", model: "x-free"}).perTaskMaxTurns, 40);
// per-adapter pattern: custom pattern gets the cap, no field never, invalid regex never
assert.equal(resolvePerRoleLimits("implementer", {}, {adapter: "other", model: "m:free", free_model_pattern: ":free$"}).perTaskMaxTurns, 45);
assert.equal(resolvePerRoleLimits("implementer", {}, {adapter: "other", model: "m:paid", free_model_pattern: ":free$"}).perTaskMaxTurns, 40);
assert.equal(resolvePerRoleLimits("implementer", {}, {adapter: "opencode", model: "x-free"}).perTaskMaxTurns, 40);
assert.equal(resolvePerRoleLimits("implementer", {}, {adapter: "other", model: "x-free", free_model_pattern: "("}).perTaskMaxTurns, 40);
assert.equal(isFreeModel({free_model_pattern: "-free$"}, "a-free"), true);
assert.equal(isFreeModel({}, "a-free"), false);
assert.equal(isFreeModel({free_model_pattern: "["}, "a-free"), false);
import {readFileSync} from "node:fs";
assert.equal(JSON.parse(readFileSync(new URL("../adapters/agents.json", import.meta.url))).adapters.opencode.free_model_pattern, "-free$");
const base = resolvePerRoleLimits("implementer", {});
assert.equal(base.perTaskMaxTurns, 40);
assert.equal(resolvePerRoleLimits("implementer", {}, free).perTaskMaxTurns, 45);
assert.equal(resolvePerRoleLimits("implementer", {free_model_turns_cap: 60}, free).perTaskMaxTurns, 60);
assert.equal(resolvePerRoleLimits("implementer", {free_model_turns_cap: 20}, free).perTaskMaxTurns, 40);
assert.equal(resolvePerRoleLimits("implementer", {free_model_turns_cap: 0}, free).perTaskMaxTurns, 40);
assert.equal(resolvePerRoleLimits("implementer", {free_model_turns_cap: null}, free).perTaskMaxTurns, 40);
assert.equal(resolveFreeModelTurnsCap({}), 45);
assert.equal(resolveFreeModelTurnsCap({free_model_turns_cap: null}), 0);
// token caps unchanged
assert.equal(resolvePerRoleLimits("implementer", {}, free).perTaskMaxTokens, base.perTaskMaxTokens);
// validation
import {validatePolicyConfig} from "./config-validation.mjs";
const errs = (v) => JSON.stringify(validatePolicyConfig({free_model_turns_cap: v}));
for (const ok of [45, 0, null]) assert.doesNotMatch(errs(ok), /free_model_turns_cap/, String(ok));
for (const bad of [-1, 1.5, "x"]) assert.match(errs(bad), /free_model_turns_cap/, String(bad));
console.log("test-free-model-turns-cap OK");
