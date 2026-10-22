// Diagnostic await-guard for relay().
//
// relay() historically returned its result object synchronously. After the
// async conversion it returns a Promise, so any caller that reads a result
// field (e.g. `relay(...).status`) without awaiting would silently get
// `undefined`. This guard makes that misuse fail loudly in development.
//
// Activation is opt-in: set AUTOPILOT_RELAY_GUARD=1. When disabled, guardRelay
// returns the original promise untouched (production behavior is unchanged —
// no wrapper, no Proxy, no extra allocation). When enabled, relay() returns a
// Proxy that forwards Promise semantics (await / then / catch / finally /
// Promise.all) but throws a clear error on any result-field read, pointing at
// the relay() call site.
//
// It never adds retries, background work, or state mutations, and it never
// changes the resolved value or the relay result contract.

export function relayGuardEnabled() {
  return process.env.AUTOPILOT_RELAY_GUARD === "1";
}

const SAFE_PROPS = new Set([
  "then",
  "catch",
  "finally",
  "constructor",
  "toString",
  "valueOf",
  "toJSON",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "__proto__",
]);

export function guardRelay(promise, callSite) {
  if (!relayGuardEnabled()) return promise;
  const stack = callSite || new Error("relay() call site").stack || "";
  return new Proxy(promise, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
      if (prop === "then") return (onFulfilled, onRejected) => target.then(onFulfilled, onRejected);
      if (prop === "catch") return (onRejected) => target.catch(onRejected);
      if (prop === "finally") return (onFinally) => target.finally(onFinally);
      if (SAFE_PROPS.has(prop)) return Reflect.get(target, prop, receiver);
      const err = new Error(
        `[relay-guard] relay() returned a Promise, but its result field ".${String(prop)}" was read without awaiting.\n` +
          `Add \`await\` before this relay(...) call (or await it before accessing the result).\n` +
          `relay() call site:\n${stack}`,
      );
      err.name = "RelayAwaitError";
      throw err;
    },
  });
}