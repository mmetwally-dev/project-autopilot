#!/usr/bin/env node
// Behavioral coverage for spawnRelayChild()'s onStart/onChunk observability
// hooks (live-status fix): a real child process, real stdout events, real
// timing assertions — proves the hooks fire WHILE the child is still
// running, not merely that the final collected stdout/stderr is correct.
import assert from "node:assert/strict";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnRelayChild} from "./subprocess-relay.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${detail ? ` :: ${detail}` : ""}`); }
};

// A real child that writes a first chunk immediately, waits, then writes a
// second chunk and exits — long enough that "did onChunk fire before the
// promise resolved" is a real, non-racy timing question.
const STAGED_SCRIPT = `
process.stdout.write("first\\n");
setTimeout(() => { process.stdout.write("second\\n"); process.exit(0); }, 400);
`;

// --- 1. onStart fires synchronously with a real pid, before any output ---
{
  let startInfo = null;
  let firstChunkAt = null;
  const t0 = Date.now();
  const result = await spawnRelayChild({
    binary: process.execPath,
    args: ["-e", STAGED_SCRIPT],
    cwd: here,
    env: process.env,
    onStart: (info) => { startInfo = info; },
    onChunk: () => { if (firstChunkAt == null) firstChunkAt = Date.now() - t0; }
  });
  check("1: onStart fired", startInfo != null);
  check("1: onStart carried a real numeric pid", typeof startInfo?.pid === "number" && startInfo.pid > 0, JSON.stringify(startInfo));
  check("1: the child actually ran (status 0)", result.status === 0, JSON.stringify(result));
  check("1: final stdout still collects both chunks (unaffected by the hooks)", result.stdout === "first\nsecond\n", JSON.stringify(result.stdout));
}

// --- 2. onChunk fires LIVE — once per chunk, WHILE the child is still
// running (before the 400ms delayed second write), never batched until
// close. This is the actual proof of the bug this fix addresses: the old
// code only ever observed output once spawnRelayChild's promise resolved.
{
  const events = [];
  const t0 = Date.now();
  let resolvedAt = null;
  const promise = spawnRelayChild({
    binary: process.execPath,
    args: ["-e", STAGED_SCRIPT],
    cwd: here,
    env: process.env,
    onChunk: ({stream, chunk}) => { events.push({stream, chunk: String(chunk).trim(), t: Date.now() - t0}); }
  }).then(r => { resolvedAt = Date.now() - t0; return r; });
  const result = await promise;
  check("2: onChunk fired exactly twice (once per real write)", events.length === 2, JSON.stringify(events));
  check("2: onChunk received the correct chunk content in order", events[0]?.chunk === "first" && events[1]?.chunk === "second", JSON.stringify(events));
  check("2: onChunk carried the correct stream name", events.every(e => e.stream === "stdout"), JSON.stringify(events));
  check("2: the FIRST chunk was observed well before the promise resolved (genuinely live, not batched at close)",
    events[0] != null && resolvedAt != null && (resolvedAt - events[0].t) > 200,
    `first chunk at ${events[0]?.t}ms, resolved at ${resolvedAt}ms`);
  check("2: result still exits cleanly", result.status === 0);
}

// --- 3. Backward compatibility: omitting onStart/onChunk entirely (every
// pre-existing caller/test) behaves exactly as before — no crash, no
// change to the returned result shape.
{
  const result = await spawnRelayChild({
    binary: process.execPath,
    args: ["-e", "process.stdout.write('ok'); process.exit(0);"],
    cwd: here,
    env: process.env
  });
  check("3: omitting onStart/onChunk still resolves normally", result.status === 0 && result.stdout === "ok", JSON.stringify(result));
}

// --- 4. A throwing onStart/onChunk never breaks the relay (best-effort,
// per the shared "observability must never affect relay behavior" pattern
// already established elsewhere in this codebase, e.g. refreshWatchReport).
{
  const result = await spawnRelayChild({
    binary: process.execPath,
    args: ["-e", "process.stdout.write('ok'); process.exit(0);"],
    cwd: here,
    env: process.env,
    onStart: () => { throw new Error("boom-start"); },
    onChunk: () => { throw new Error("boom-chunk"); }
  });
  check("4: a throwing onStart/onChunk does not break the relay", result.status === 0 && result.stdout === "ok", JSON.stringify(result));
}

if (failures) {
  console.error(`${failures} subprocess-relay check(s) failed.`);
  process.exit(1);
}
console.log("subprocess-relay: ALL CHECKS PASSED");
