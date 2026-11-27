#!/usr/bin/env node
// Backlog #4: markExhausted stores `until` from retryAfterMs (opencode
// FreeUsageLimitError event or stderr) and claude rate_limit_event resetsAt;
// isExhausted/pruneExhausted/skipExhaustedRoleModel honour `until` first and
// fall back to daily_reset_time only without `until`; "by unknown" fixed via
// canonicalModelId lookup.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  markExhausted,
  isExhausted,
  pruneExhausted,
  skipExhaustedRoleModel,
  extractExhaustedUntilIso,
  canonicalModelId,
} from "./role-fallback.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PRIMARY = {adapter: "opencode", model: "opencode/deepseek-v4.1-flash-free"};
const FALLBACK = {adapter: "antigravity", model: "gemini-4-hydrogen-medium"};
const ROLE_CFG = {...PRIMARY, fallbacks: [FALLBACK]};

// 1. OpenCode FreeUsageLimitError event.error.retryAfterMs -> `until` ISO
{
  // Reproduces SampleApp 008 run 100: hit at 03:00:33 with retryAfterMs=2492000 (-> 03:42:05)
  const hitMs = new Date(2026, 10, 21, 3, 0, 33, 0).getTime();
  const retryAfterMs = 2492000;
  const expectedUntilMs = hitMs + retryAfterMs;
  const evidence = [{
    type: "rate_limited",
    reason: "free_quota_exhausted",
    event: {type: "error", error: {name: "FreeUsageLimitError", retryAfterMs, message: "Free usage limit reached"}},
  }];

  const map = markExhausted({}, PRIMARY, "implementer", new Date(hitMs).toISOString(), {quota: "free", evidence});
  const key = canonicalModelId(PRIMARY);
  assert.equal(key, "opencode/deepseek-v4.1-flash-free");
  assert.equal(map[key].by, "implementer");
  assert.equal(map[key].until, new Date(expectedUntilMs).toISOString());

  // Before until (03:30) -> exhausted = true, skip switches to fallback
  const beforeUntil = new Date(2026, 10, 21, 3, 30, 0, 0).getTime();
  assert.equal(isExhausted(map, PRIMARY, {daily_reset_time: "03:00"}, beforeUntil), true);
  assert.equal(Object.keys(pruneExhausted(map, {daily_reset_time: "03:00"}, beforeUntil)).length, 1);
  const skipBefore = skipExhaustedRoleModel({
    role: "implementer",
    roleConfig: ROLE_CFG,
    exhausted: map,
    policy: {daily_reset_time: "03:00"},
    nowMs: beforeUntil,
  });
  assert.equal(skipBefore.action, "switch");
  assert.equal(skipBefore.next.model, FALLBACK.model);

  // After until (04:41 — BEFORE next day's 03:00 daily reset!) -> exhausted = false!
  const afterUntil = new Date(2026, 10, 21, 4, 41, 0, 0).getTime();
  assert.equal(isExhausted(map, PRIMARY, {daily_reset_time: "03:00"}, afterUntil), false);
  assert.equal(Object.keys(pruneExhausted(map, {daily_reset_time: "03:00"}, afterUntil)).length, 0);
  const skipAfter = skipExhaustedRoleModel({
    role: "implementer",
    roleConfig: ROLE_CFG,
    exhausted: map,
    policy: {daily_reset_time: "03:00"},
    nowMs: afterUntil,
  });
  assert.equal(skipAfter.action, "none");
}
console.log("PASS 1: retryAfterMs -> until; isExhausted/pruneExhausted/skipExhaustedRoleModel honour until over daily_reset_time");

// 2. OpenCode stderr message with retryAfterMs -> `until` ISO
{
  const hitMs = Date.parse("2026-11-21T20:48:48.000Z");
  const retryAfterMs = 13997000;
  const evidence = [{
    type: "rate_limited",
    reason: "free_quota_exhausted",
    message: `level=ERROR FreeUsageLimitError retryAfterMs=${retryAfterMs}`,
  }];
  const untilIso = extractExhaustedUntilIso(evidence, hitMs);
  assert.equal(untilIso, new Date(hitMs + retryAfterMs).toISOString());
}
console.log("PASS 2: stderr retryAfterMs extracted to until ISO");

// 3. Claude rate_limit_event resetsAt (epoch seconds) -> `until` ISO
{
  const hitMs = Date.parse("2026-11-21T10:00:00.000Z");
  const resetsAtSec = Math.floor(Date.parse("2026-11-21T12:30:00.000Z") / 1000);
  const claudeEntry = {adapter: "claude", model: "claude-opus-4"};
  const evidence = [{
    type: "rate_limited",
    reason: "rate_limit_event_rejected",
    event: {type: "rate_limit_event", rate_limit_info: {status: "rejected", resetsAt: resetsAtSec}},
  }];
  const map = markExhausted({}, claudeEntry, "code_reviewer", new Date(hitMs).toISOString(), {evidence});
  assert.equal(map["claude/claude-opus-4"].until, "2026-11-21T12:30:00.000Z");
  assert.equal(isExhausted(map, claudeEntry, {}, Date.parse("2026-11-21T12:29:59.000Z")), true);
  assert.equal(isExhausted(map, claudeEntry, {}, Date.parse("2026-11-21T12:30:00.000Z")), false);
}
console.log("PASS 3: claude rate_limit_event resetsAt (seconds) -> until ISO");

// 4. No `until` -> falls back to old daily_reset_time rule
{
  const hitMs = new Date(2026, 10, 21, 3, 0, 34, 0).getTime();
  const map = markExhausted({}, PRIMARY, "implementer", new Date(hitMs).toISOString(), {quota: "free"});
  assert.equal(map["opencode/deepseek-v4.1-flash-free"].until, undefined);
  const laterSameDay = new Date(2026, 10, 21, 4, 41, 0, 0).getTime();
  const nextDayAfterReset = new Date(2026, 10, 22, 3, 1, 0, 0).getTime();
  assert.equal(isExhausted(map, PRIMARY, {daily_reset_time: "03:00"}, laterSameDay), true);
  assert.equal(isExhausted(map, PRIMARY, {daily_reset_time: "03:00"}, nextDayAfterReset), false);
}
console.log("PASS 4: absent until falls back to daily_reset_time");

// 5. "by unknown" fix: autopilot.mjs looks up s.exhaustedModels via canonicalModelId(effective)
{
  const autopilotSrc = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
  assert.ok(
    autopilotSrc.includes("const spent=s.exhaustedModels?.[canonicalModelId(effective)];"),
    "autopilot.mjs must look up s.exhaustedModels using canonicalModelId(effective)"
  );
  assert.ok(
    !autopilotSrc.includes("s.exhaustedModels?.[`${effective.adapter}/${effective.model}`]"),
    "autopilot.mjs must not double-prefix opencode model ids when looking up exhaustedModels"
  );
  // Verify the actual lookup finds `by: "implementer"` for opencode/deepseek-v4.1-flash-free
  const hitMs = new Date(2026, 10, 21, 3, 0, 33, 0).getTime();
  const map = markExhausted({}, PRIMARY, "implementer", new Date(hitMs).toISOString(), {quota: "free"});
  const spent = map[canonicalModelId(PRIMARY)];
  assert.equal(spent?.by, "implementer");
}
console.log("PASS 5: exhausted log lookup uses canonicalModelId and reads real `by`");

console.log("\nALL BACKLOG #4 TESTS PASSED.");
