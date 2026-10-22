#!/usr/bin/env node
// Backlog #95: free-model chain extension when configured fallbacks are exhausted.
import assert from "node:assert/strict";
import {decideRoleFallback} from "./role-fallback.mjs";
import {extendFallbackWithFree, markTriedFreeModel, resetTriedFreeModels} from "./free-fallback-discovery.mjs";

const P = {adapter: "opencode", model: "opencode/muse-free"};
const F = {adapter: "opencode", model: "opencode/step-free"};
const cfg = {...P, fallbacks: [F]};
const catalog = [
  {id: "opencode/muse-free"}, {id: "opencode/step-free"}, {id: "opencode/paid-pro"},
  {id: "opencode/longcat-free"}, "opencode/nemotron-free", {id: "opencode/cat-free"},
];
const discover = async () => catalog;
const decideWithFree = (o) => extendFallbackWithFree({...o, decision: decideRoleFallback(o)});
const RL = "RATE_LIMITED";
const run = (o) => decideWithFree({role: "implementer", roleConfig: cfg, failureClass: RL, discover, ...o});

// exhausted -> first untried free, discovery order, never paid/primary/fallback
{
  const d = await run({activeModel: F});
  assert.equal(d.action, "switch");
  assert.equal(d.autoDiscovered, true);
  assert.deepEqual(d.next, {adapter: "opencode", model: "opencode/longcat-free"});
  assert.match(d.reason, /auto-discovered/);
}
// configured fallback still wins first
{
  const d = await run({activeModel: null});
  assert.equal(d.next.model, F.model);
  assert.equal(d.autoDiscovered, undefined);
}
// tried list respected + auto-active walks forward, ends in escalate
{
  let tried = markTriedFreeModel({}, "implementer", F);
  let active = F;
  const seen = [];
  for (let i = 0; i < 10; i++) {
    const d = await run({activeModel: active, tried: tried.implementer});
    if (d.action !== "switch") { assert.equal(d.action, "escalate"); break; }
    seen.push(d.next.model);
    assert.ok(!/paid/.test(d.next.model));
    active = d.next;
    tried = markTriedFreeModel(tried, "implementer", active);
  }
  assert.deepEqual(seen, ["opencode/longcat-free", "opencode/nemotron-free", "opencode/cat-free"]);
}
// discovery empty / throws / missing / disabled -> escalate as today
for (const o of [{discover: async () => []}, {discover: async () => { throw new Error("x"); }}, {discover: null}, {enabled: false}]) {
  const d = await run({activeModel: F, ...o});
  assert.equal(d.action, "escalate");
  assert.match(d.reason, /exhausted/);
}
// non-free primary -> escalate as before
{
  const d = await decideWithFree({role: "r", roleConfig: {adapter: "opencode", model: "opencode/paid-pro"}, failureClass: RL, discover});
  assert.equal(d.action, "escalate");
}
// other failure class untouched; silent hang extends only when exhausted
{
  const d = await run({activeModel: F, failureClass: "FAILED"});
  assert.equal(d.action, "none");
  const h = await run({activeModel: F, failureClass: "IDLE_HANG", noOutput: true});
  assert.equal(h.action, "switch");
  const h2 = await run({activeModel: F, failureClass: "IDLE_HANG", noOutput: false});
  assert.equal(h2.action, "none");
}
// new mission clears tried list
assert.deepEqual(resetTriedFreeModels(), {});
// per-adapter free_model_pattern via `adapters`
{
  const adapters = {opencode: {free_model_pattern: "-free$"}, other: {free_model_pattern: ":free$"}, plain: {}};
  const mk = (adapter, models, ad = adapters) => {
    const c = {adapter, model: models[0]};
    return extendFallbackWithFree({decision: decideRoleFallback({role: "implementer", roleConfig: c, failureClass: RL, activeModel: null}), role: "implementer", roleConfig: c, failureClass: RL, adapters: ad, discover: async () => models.map((id) => ({id}))});
  };
  let d = await mk("other", ["a:free", "b:free", "c:paid"]);
  assert.equal(d.action, "switch");
  assert.deepEqual(d.next, {adapter: "other", model: "b:free"});
  assert.equal((await mk("opencode", ["x-free", "y-free"])).next.model, "y-free");
  assert.equal((await mk("other", ["a-free", "b-free"])).action, "escalate");
  assert.equal((await mk("plain", ["a-free", "b-free"])).action, "escalate");
  assert.equal((await mk("other", ["a:free", "b:free"], {other: {free_model_pattern: "("}})).action, "escalate");
}
console.log("test-free-fallback-discovery: ok");
