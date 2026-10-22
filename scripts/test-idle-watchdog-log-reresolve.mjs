#!/usr/bin/env node
// Mission 074 Phase 1 task 1.3: re-resolve regression guard for the opencode
// log tail. Real tmp dirs, sessionId set, explicit `now` (finishes in ms).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createIdleWatch, evaluateIdleWatch } from "./idle-hang-watchdog.mjs";

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  return false;
};

const SID = "ses_reresolve_ours";
const rlLine = (model) =>
  `level=ERROR message="stream error" providerID=opencode modelID=${model} session.id=${SID} error.error="AI_APICallError: Upstream request failed: [rate_limit_exceeded] Rate limit exceeded. Please retry after a brief wait."`;

function makeBase() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ap-idle-reresolve-"));
  fs.mkdirSync(path.join(base, "log"), { recursive: true });
  return base;
}
function cleanup(base) {
  fs.rmSync(base, { recursive: true, force: true });
}
function touch(file, mtimeMs) {
  const d = new Date(mtimeMs);
  fs.utimesSync(file, d, d);
}

// 1. Regression guard (passes before the change): empty dir at creation,
// then a session Rate limit exceeded line appears -> rate_limited.
{
  const base = makeBase();
  try {
    const t0 = Date.now();
    const watch = createIdleWatch({
      adapter: "opencode", idleHangMs: 60000, opencodeLogBase: base,
      sessionId: SID, rateLimitGapMs: 50, rateLimitMatches: 1,
      now: t0, startedAtMs: t0 - 10000,
    });
    check("1: empty dir starts ok", evaluateIdleWatch(watch, { now: t0 }).status === "ok");
    fs.writeFileSync(path.join(base, "log", "opencode.log"), `${rlLine("opencode/m")}\n`);
    check("1: hit pending before the gap", evaluateIdleWatch(watch, { now: t0 + 10 }).status === "ok" && watch.rateLimitHits === 1, { hits: watch.rateLimitHits });
    const verdict = evaluateIdleWatch(watch, { now: t0 + 200 });
    check("1: session line after creation confirms rate_limited",
      verdict.status === "rate_limited" && verdict.provider === "opencode", verdict);
  } finally {
    cleanup(base);
  }
}

// 2. A newer log appearing while the older one still exists is picked up,
// with the line counted exactly once.
{
  const base = makeBase();
  try {
    const t0 = Date.now();
    const a = path.join(base, "log", "a.log");
    fs.writeFileSync(a, "boot\n");
    touch(a, t0 - 5000);
    const watch = createIdleWatch({
      adapter: "opencode", idleHangMs: 60000, opencodeLogBase: base,
      sessionId: SID, rateLimitGapMs: 60_000, rateLimitMatches: 1,
      now: t0, startedAtMs: t0 - 10000,
    });
    check("2: starts on the older log", watch.opencodeLogFile === a);
    check("2: baseline ok", evaluateIdleWatch(watch, { now: t0 }).status === "ok" && watch.rateLimitHits === 0);
    const b = path.join(base, "log", "b.log");
    fs.writeFileSync(b, `${rlLine("opencode/m")}\n`);
    // b is newest by mtime (just written); keep a explicitly older.
    touch(a, t0 - 5000);
    check("2: newer log picked up", evaluateIdleWatch(watch, { now: t0 + 10 }).status === "ok" && watch.opencodeLogFile === b, watch.opencodeLogFile);
    check("2: newer line counted exactly once", watch.rateLimitHits === 1, { hits: watch.rateLimitHits });
    check("2: re-tick does not recount", evaluateIdleWatch(watch, { now: t0 + 20 }).status === "ok" && watch.rateLimitHits === 1, { hits: watch.rateLimitHits });
  } finally {
    cleanup(base);
  }
}

// 3. Alternating mtimes do not double-count lines.
{
  const base = makeBase();
  try {
    const t0 = Date.now();
    const a = path.join(base, "log", "a.log");
    const b = path.join(base, "log", "b.log");
    // Boot content only: creation baselines offsets, so rate-limit lines
    // must be APPENDED after the watch exists to count.
    fs.writeFileSync(a, "boot a\n");
    fs.writeFileSync(b, "boot b\n");
    touch(a, t0 - 1000); // a newest first
    touch(b, t0 - 5000);
    const watch = createIdleWatch({
      adapter: "opencode", idleHangMs: 60000, opencodeLogBase: base,
      sessionId: SID, rateLimitGapMs: 60_000, rateLimitMatches: 1,
      now: t0, startedAtMs: t0 - 10000,
    });
    evaluateIdleWatch(watch, { now: t0 });
    check("3: baseline tails newest with no hits", watch.rateLimitHits === 0 && watch.opencodeLogFile === a, { hits: watch.rateLimitHits, file: watch.opencodeLogFile });
    fs.appendFileSync(a, `${rlLine("opencode/ma")}\n`);
    evaluateIdleWatch(watch, { now: t0 + 5 });
    check("3: first log counted once", watch.rateLimitHits === 1 && watch.opencodeLogFile === a, { hits: watch.rateLimitHits, file: watch.opencodeLogFile });
    fs.appendFileSync(b, `${rlLine("opencode/mb")}\n`);
    touch(b, t0 + 1000); // flip: b newest
    evaluateIdleWatch(watch, { now: t0 + 10 });
    check("3: flipped log adds its line once", watch.rateLimitHits === 2 && watch.opencodeLogFile === b, { hits: watch.rateLimitHits, file: watch.opencodeLogFile });
    touch(a, t0 + 2000); // flip back: a newest again
    evaluateIdleWatch(watch, { now: t0 + 20 });
    check("3: flip-flop back does not recount", watch.rateLimitHits === 2 && watch.opencodeLogFile === a, { hits: watch.rateLimitHits, file: watch.opencodeLogFile });
    touch(b, t0 + 3000); // and again
    evaluateIdleWatch(watch, { now: t0 + 30 });
    check("3: second flip-flop still no recount", watch.rateLimitHits === 2, { hits: watch.rateLimitHits });
  } finally {
    cleanup(base);
  }
}

// 4. No log -> ok.
{
  const base = makeBase();
  try {
    const t0 = Date.now();
    const watch = createIdleWatch({
      adapter: "opencode", idleHangMs: 60000, opencodeLogBase: base,
      sessionId: SID, rateLimitGapMs: 50, rateLimitMatches: 1,
      now: t0, startedAtMs: t0 - 10000,
    });
    const verdict = evaluateIdleWatch(watch, { now: t0 + 5000 });
    check("4: no log stays ok", verdict.status === "ok" && watch.rateLimitHits === 0, verdict);
  } finally {
    cleanup(base);
  }
}

if (failures) { console.error(`${failures} check(s) failed.`); process.exit(1); }
console.log("test-idle-watchdog-log-reresolve: all 4 scenarios PASSED");
