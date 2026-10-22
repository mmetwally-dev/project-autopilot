#!/usr/bin/env node
// Planning-review wiring extraction test (mission 006-task-13-non, Phase 3 T4).
//
// Exercises the extracted `resolvePlanningReviewAttempt` from
// `scripts/planning-review-wiring.mjs` directly — never via `autopilot.mjs`
// (which runs `main()` at import with no guard):
// 1. a PASS result is returned unchanged with state untouched;
// 2. a passthrough-class (PLANNING_REJECTED) result is returned unchanged
//    with state untouched (nothing recorded);
// 3. a staged reset-request file is consumed through the injected accessors
//    (read + consume + configured-budget callbacks), proving the live
//    `ap reset` call-through survived extraction.
import assert from "node:assert/strict";
import {resolvePlanningReviewAttempt, escalateIfRateLimited} from "./planning-review-wiring.mjs";
import {failure} from "./failure-contract.mjs";

function makeIo({resetRequests = null, configuredBudgets = {}} = {}) {
  const calls = {saveState: 0, readResetRequests: 0, consumeResetRequest: [], getConfiguredBudget: []};
  return {
    calls,
    fatal: (m) => { throw new Error(`FATAL:${m}`); },
    saveState: () => { calls.saveState += 1; },
    readResetRequests: () => {
      calls.readResetRequests += 1;
      if (resetRequests === null || resetRequests === undefined) throw new Error("ENOENT: no reset request");
      return resetRequests.map((r) => ({...r}));
    },
    consumeResetRequest: (key) => { calls.consumeResetRequest.push(key); },
    getConfiguredBudget: (name) => {
      calls.getConfiguredBudget.push(name);
      return configuredBudgets[name];
    },
    now: () => "2026-01-01T00:00:00.000Z"
  };
}

const baseOpts = (io) => ({
  policyMessage: "policy violated",
  escalatePrefix: "Test review",
  fatal: io.fatal,
  saveState: io.saveState,
  readResetRequests: io.readResetRequests,
  consumeResetRequest: io.consumeResetRequest,
  getConfiguredBudget: io.getConfiguredBudget,
  now: io.now
});

// 1. PASS results pass through untouched.
{
  const io = makeIo();
  const state = {};
  const before = JSON.stringify(state);
  const pass = {status: "completed", review: {decision: "PASS", findings: []}, policyViolation: null};
  let rerunCalled = false;
  const out = await resolvePlanningReviewAttempt(
    {policy: {retry_delay_ms: 0}}, state, "test-scope", pass,
    async () => { rerunCalled = true; return pass; },
    baseOpts(io)
  );
  assert.equal(out, pass, "PASS result must be returned identical");
  assert.equal(rerunCalled, false, "PASS must not re-invoke the reviewer");
  assert.equal(JSON.stringify(state), before, "PASS must leave state untouched");
  assert.equal(io.calls.saveState, 0, "PASS must not persist state");
  console.log("PASS passthrough-PASS");
}

// 2. Passthrough-class (PLANNING_REJECTED) results pass through with nothing recorded.
{
  const io = makeIo();
  const state = {};
  const before = JSON.stringify(state);
  const rejected = {
    status: "completed",
    review: {decision: "FAIL", findings: ["needs work"]},
    failure: failure("PLANNING_REJECTED", "planning", true, [{source: "test"}])
  };
  let rerunCalled = false;
  const out = await resolvePlanningReviewAttempt(
    {policy: {retry_delay_ms: 0}}, state, "test-scope", rejected,
    async () => { rerunCalled = true; return rejected; },
    baseOpts(io)
  );
  assert.equal(out, rejected, "passthrough result must be returned identical");
  assert.equal(rerunCalled, false, "passthrough must not re-invoke the reviewer");
  assert.equal(JSON.stringify(state), before, "passthrough must leave state untouched");
  assert.equal(io.calls.saveState, 0, "passthrough must not persist state");
  console.log("PASS passthrough-PLANNING_REJECTED");
}

// 3. A staged reset-request queue is consumed through the injected accessors:
//    the pre-existing budget use is cleared before recording, so the fresh
//    record starts from 1 and the retry proceeds.
{
  const resetRequests = [{scope: "mission", key: "infrastructureRetryBudget:mission"}];
  const io = makeIo({resetRequests, configuredBudgets: {infrastructureRetryBudget: 2}});
  const state = {failureBudgets: {"infrastructureRetryBudget:mission": 1}};
  const config = {policy: {retry_delay_ms: 0, failure_budgets: {infrastructureRetryBudget: 2}}};
  const failedAttempt = {
    status: "failed",
    role: "plan_reviewer",
    adapter: "test-adapter",
    failure: failure("SERVER_UNAVAILABLE", "infrastructure", true, [{source: "test", type: "server_unavailable"}])
  };
  const retriedPass = {status: "completed", review: {decision: "PASS", findings: []}};
  let reruns = 0;
  const out = await resolvePlanningReviewAttempt(
    config, state, "standalone-plan-review", failedAttempt,
    async () => { reruns += 1; return retriedPass; },
    baseOpts(io)
  );
  assert.equal(out, retriedPass, "retryable failure with budget must retry and return the fresh PASS");
  assert.equal(reruns, 1, "reviewer must be re-invoked exactly once");
  assert.equal(io.calls.readResetRequests, 1, "the queue must be read exactly once through the injected accessor");
  assert.equal(io.calls.consumeResetRequest.length, 1, "reset request consumed exactly once");
  assert.equal(io.calls.consumeResetRequest[0], "infrastructureRetryBudget:mission", "the consumption must name the applied budget key");
  assert.ok(io.calls.getConfiguredBudget.includes("infrastructureRetryBudget"), "configured limit must be read through the injected cfg accessor");
  assert.equal(state.failureBudgets["infrastructureRetryBudget:mission"], 1, "cleared budget must re-record from 1, not accumulate to 2");
  assert.ok(state.lastReset, "live reset must record lastReset evidence");
  assert.equal(state.lastReset.scope, "infrastructureRetryBudget:mission", "lastReset scope names the budget key");
  assert.equal(state.lastReset.appliedLive, true, "live-applied reset must be marked appliedLive");
  console.log("PASS live-reset-consumed-through-injected-accessors");
}

// 4. RATE_LIMITED short-circuits inside the helper to escalation with zero
//    failure-budget writes: the reviewer is never re-invoked, nothing is
//    recorded, and the fatal carries the rate-limited step plus the resume
//    hint. The exported guard is a no-op for non-rate-limited results.
{
  const io = makeIo();
  const state = {};
  const config = {policy: {retry_delay_ms: 0}};
  const rateLimited = {
    status: "failed",
    role: "plan_reviewer",
    adapter: "test-adapter",
    failure: failure("RATE_LIMITED", "infrastructure", false, [{source: "test", type: "rate_limited", provider: "opencode", model: "m"}])
  };
  let reruns = 0;
  let fatal = null;
  const opts = {...baseOpts(io), fatal: (m) => { fatal = String(m); io.fatal(m); }};
  assert.equal(escalateIfRateLimited(config, {}, "test-scope", {status: "completed"}, {fatal: () => { throw new Error("must not escalate"); }, saveState: () => { throw new Error("must not persist"); }, escalatePrefix: "Test review"}), false, "guard must ignore non-rate-limited results");
  try {
    await resolvePlanningReviewAttempt(
      config, state, "test-scope", rateLimited,
      async () => { reruns += 1; return rateLimited; },
      opts
    );
    assert.fail("RATE_LIMITED must escalate via fatal");
  } catch (e) {
    assert.ok(String(e?.message || e).startsWith("FATAL:"), "escalation must go through the injected fatal");
  }
  assert.equal(reruns, 0, "RATE_LIMITED must not re-invoke the reviewer");
  assert.equal(state.phase, "escalated", "escalation persists the phase");
  assert.equal(state.step, "rate_limited_escalation", "escalation persists the rate-limited step");
  assert.ok(fatal.includes("RATE_LIMITED/infrastructure"), "fatal names the failure class and domain");
  assert.ok(fatal.includes("ap run"), "fatal carries the resume hint");
  assert.equal(state.failureBudgets, undefined, "zero failure-budget writes");
  assert.equal(state.lastFailure, undefined, "nothing recorded as the last failure");
  assert.equal(state.lastFailureBudget, undefined, "no budget record persisted");
  assert.equal(io.calls.saveState, 1, "exactly one persist (the escalation itself)");
  assert.equal(io.calls.readResetRequests, 0, "no reset-queue read before escalating");
  console.log("PASS rate-limited-escalation-zero-budget-writes");
}

// 5. The guard runs before the policy-violation die: a RATE_LIMITED result
//    that also carries a policy violation still escalates as rate-limited.
{
  const io = makeIo();
  const state = {};
  const config = {policy: {retry_delay_ms: 0}};
  const rateLimitedPolicy = {
    status: "failed",
    role: "plan_reviewer",
    adapter: "test-adapter",
    policyViolation: {code: "fixture-violation"},
    failure: failure("RATE_LIMITED", "infrastructure", false, [{source: "test", type: "rate_limited"}])
  };
  let fatal = null;
  try {
    await resolvePlanningReviewAttempt(
      config, state, "test-scope", rateLimitedPolicy,
      async () => rateLimitedPolicy,
      {...baseOpts(io), fatal: (m) => { fatal = String(m); io.fatal(m); }}
    );
    assert.fail("RATE_LIMITED with a policy violation must still escalate via fatal");
  } catch (e) {
    assert.ok(String(e?.message || e).startsWith("FATAL:"), "escalation must go through the injected fatal");
  }
  assert.equal(state.step, "rate_limited_escalation", "rate-limited guard wins over the policy die");
  assert.ok(!fatal.includes("policy violated"), "policy message must not win");
  assert.ok(fatal.includes("ap run"), "fatal still carries the resume hint");
  assert.equal(state.failureBudgets, undefined, "zero failure-budget writes");
  console.log("PASS rate-limited-guard-before-policy-violation");
}

console.log("test-planning-review-wiring: all cases passed");
