#!/usr/bin/env node
// Backlog #106: opencode UnknownError ("Unexpected server error") is PROVIDER_ERROR
// and triggers the same role fallback as RATE_LIMITED.
import assert from "node:assert/strict";
import {adapterDriver} from "./adapter-drivers.mjs";
import {classifyObservedFailure} from "./failure-contract.mjs";
import {decideRoleFallback} from "./role-fallback.mjs";
import {extendFallbackWithFree} from "./free-fallback-discovery.mjs";
import {decideEscalationName} from "./escalation-naming.mjs";

const driver = adapterDriver("opencode");
const classify = (events, exitCode = 1) =>
  classifyObservedFailure({exitCode, stderr: "", evidence: driver.observe(events, {readPath: "", productionWritePath: "", outsideWritePath: ""}), driverless: false});
const unknown = {type: "error", sessionID: "s", error: {name: "UnknownError", data: {message: "Unexpected server error. Check server logs for details.", ref: "err_1"}}};

// classifier
{
  const f = classify([unknown]);
  assert.equal(f.class, "PROVIDER_ERROR");
  assert.equal(f.domain, "infrastructure");
  assert.equal(f.retryable, true);
  assert.equal(classify([{type: "error", error: {name: "X", data: {message: "Unexpected server error"}}}]).class, "PROVIDER_ERROR");
  const rl = classify([{type: "error", error: {name: "APIError", data: {statusCode: 429, message: "slow down"}}}]);
  assert.equal(rl.class, "RATE_LIMITED");
  // documented: name UnknownError classifies regardless of the message text
  assert.equal(classify([{type: "error", error: {name: "UnknownError", data: {message: "something else entirely"}}}]).class, "PROVIDER_ERROR");
  assert.equal(classify([{type: "text", part: {text: "hi"}}]).class, "PROCESS_EXIT_NONZERO");
  assert.equal(classify([{type: "error", error: {name: "APIError", data: {message: "bad key"}}}]).class, "PROCESS_EXIT_NONZERO");
  // after tool use it is not a fast provider failure
  assert.equal(classify([{type: "tool_use", part: {type: "tool", tool: "read", state: {status: "completed", input: {}}}}, unknown]).class, "PROCESS_EXIT_NONZERO");
}

const P = {adapter: "opencode", model: "opencode/a-free"};
const F = {adapter: "opencode", model: "opencode/b-free"};
const PE = "PROVIDER_ERROR";
// switch with a configured fallback
{
  const d = decideRoleFallback({role: "verifier", roleConfig: {...P, fallbacks: [F]}, failureClass: PE});
  assert.equal(d.action, "switch");
  assert.deepEqual(d.next, F);
  assert.match(d.reason, /PROVIDER_ERROR/);
}
// escalate when none
{
  const d = decideRoleFallback({role: "verifier", roleConfig: P, failureClass: PE});
  assert.equal(d.action, "escalate");
  assert.match(d.reason, /PROVIDER_ERROR/);
  const e = decideRoleFallback({role: "verifier", roleConfig: {...P, fallbacks: [F]}, activeModel: F, failureClass: PE});
  assert.equal(e.action, "escalate");
}
// other classes unchanged
assert.equal(decideRoleFallback({role: "v", roleConfig: {...P, fallbacks: [F]}, failureClass: "PROCESS_EXIT_NONZERO"}).action, "none");
// free discovery
{
  const discover = async () => [{id: "opencode/a-free"}, {id: "opencode/b-free"}, {id: "opencode/paid"}, {id: "opencode/c-free"}];
  const o = {role: "verifier", roleConfig: {...P, fallbacks: [F]}, activeModel: F, failureClass: PE};
  const d = await extendFallbackWithFree({...o, decision: decideRoleFallback(o), discover});
  assert.equal(d.action, "switch");
  assert.equal(d.autoDiscovered, true);
  assert.equal(d.next.model, "opencode/c-free");
  assert.match(d.reason, /PROVIDER_ERROR/);
  const n = await extendFallbackWithFree({...o, decision: decideRoleFallback(o), discover: async () => []});
  assert.equal(n.action, "escalate");
}
// escalation naming
{
  const n = decideEscalationName({failureClass: PE, retryable: true, used: 2, limit: 2, budget: "infrastructureRetryBudget", evidence: []});
  assert.equal(n.step, "provider_error_escalation");
  assert.match(n.detail, /PROVIDER_ERROR/);
  assert.match(n.detail, /no fallback model is available/);
  const x = decideEscalationName({failureClass: PE, retryable: true, used: 2, limit: 2, budget: "infrastructureRetryBudget", evidence: [{source: "role-fallback", fallbacksExhausted: true}]});
  assert.match(x.detail, /no fallback left \(all configured\/discovered fallbacks tried\)/);
}
console.log("test-provider-error-fallback: ok");
