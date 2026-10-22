#!/usr/bin/env node
import assert from "node:assert/strict";
import { guardRelay, relayGuardEnabled } from "./relay-guard.mjs";

// Guard disabled: passthrough (production behavior unchanged — same object, no Proxy).
{
  delete process.env.AUTOPILOT_RELAY_GUARD;
  assert(relayGuardEnabled() === false, "guard should be off by default");
  const p = Promise.resolve({ status: "completed" });
  const wrapped = guardRelay(p, null);
  assert(wrapped === p, "guard disabled should return the original promise untouched");
}

// Guard enabled.
process.env.AUTOPILOT_RELAY_GUARD = "1";
{
  assert(relayGuardEnabled() === true, "guard should be on with AUTOPILOT_RELAY_GUARD=1");
  const callSite = new Error("relay() call site").stack;
  const result = { status: "completed", review: { decision: "PASS" }, policyViolation: false };
  const p = Promise.resolve(result);
  const wrapped = guardRelay(p, callSite);

  // 1) await relay(...) works and resolves the real value.
  {
    const v = await wrapped;
    assert.deepEqual(v, result, "await relay(...) should resolve the relay result");
  }

  // 2) return relay(...) inside an async function works.
  {
    const fn = async () => guardRelay(Promise.resolve(42), callSite);
    const v = await fn();
    assert(v === 42, "return relay(...) from async function should work");
  }

  // 3) Promise.all([relay(...)]) works.
  {
    const a = guardRelay(Promise.resolve({ status: "completed" }), callSite);
    const b = guardRelay(Promise.resolve({ status: "failed" }), callSite);
    const all = await Promise.all([a, b]);
    assert(all[0].status === "completed" && all[1].status === "failed", "Promise.all([relay(...)]) should resolve all results");
  }

  // 4) .then/.catch/.finally still chain.
  {
    const v = await guardRelay(Promise.resolve(1), callSite).then((x) => x + 1);
    assert(v === 2, "relay(...).then should work");
    const caught = await guardRelay(Promise.reject(new Error("boom")), callSite).catch((e) => e.message);
    assert(caught === "boom", "relay(...).catch should work");
    let ran = false;
    await guardRelay(Promise.resolve(1), callSite).finally(() => { ran = true; });
    assert(ran === true, "relay(...).finally should run");
  }

  // 5) Un-awaited result-field access is caught with a clear error.
  {
    const wrapped5 = guardRelay(Promise.resolve({ status: "completed" }), callSite);
    let threw = null;
    try {
      const field = wrapped5.status; // eslint-disable-line no-unused-vars
    } catch (e) {
      threw = e;
    }
    assert(threw, "reading .status without awaiting should throw");
    assert(threw.name === "RelayAwaitError", "error should be RelayAwaitError");
    assert(/result field "\.status" was read without awaiting/.test(threw.message), "error message should name the field");
    assert(/relay\(\) call site:/.test(threw.message), "error message should include the call site");
  }

  // 6) Safe props that would be read by JSON.stringify or debuggers don't throw.
  {
    const wrapped6 = guardRelay(Promise.resolve({ status: "completed" }), callSite);
    assert(typeof wrapped6.then === "function", "then should be a function");
    assert(typeof wrapped6.constructor === "function", "constructor should be accessible");
    assert(typeof wrapped6[Symbol.toStringTag] === "undefined" || wrapped6[Symbol.toStringTag] !== "relay", "symbol access should not throw");
  }

  // 7) The guard never changes the resolved value or rejects without a reason.
  {
    const v = await guardRelay(Promise.resolve({ status: "completed", count: 7 }), callSite);
    assert(v.count === 7, "resolved value must be preserved");
  }
}
delete process.env.AUTOPILOT_RELAY_GUARD;
console.log("relay-guard: 1/1 PASS");