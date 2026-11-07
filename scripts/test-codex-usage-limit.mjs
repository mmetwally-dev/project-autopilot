#!/usr/bin/env node
// Backlog open #7: Codex "usage limit" is classified as RATE_LIMITED non-retryable
// with retryAt hint and sticky fallback 03:00 reset rule.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {adapterDriver} from "./adapter-drivers.mjs";
import {classifyObservedFailure} from "./failure-contract.mjs";
import {decideEscalationName} from "./escalation-naming.mjs";
import {
  stampStickyFallback,
  staleStickyFallback,
  FREE_QUOTA_REASON,
} from "./role-fallback.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
    return true;
  }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  return false;
}

const LINE1 = JSON.stringify({
  type: "error",
  message: "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 4:47 AM.",
});

const LINE2 = JSON.stringify({
  type: "turn.failed",
  error: {
    message: "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 4:47 AM.",
  },
});

const EXACT_STDOUT = `${LINE1}\n${LINE2}\n`;

// ── 1. Observation emitted with reason and parsed retryAt ───────────────────
{
  const driver = adapterDriver("codex");
  assert.ok(driver, "codex adapter driver must exist");

  const events = driver.decodeEvents(EXACT_STDOUT, "");
  assert.equal(events.length, 2, "must decode exact two events");

  const probe = {readPath: "", productionWritePath: "", outsideWritePath: ""};
  const observations = driver.observe(events, probe);
  const rateLimitObs = observations.filter(o => o.type === "rate_limited");

  check("observation: exactly one rate_limited observation emitted for the run", rateLimitObs.length === 1, rateLimitObs);
  const obs = rateLimitObs[0];
  check("observation: reason is codex_usage_limit", obs?.reason === "codex_usage_limit", obs);
  check("observation: retryAt is a non-empty ISO string", typeof obs?.retryAt === "string" && Number.isFinite(Date.parse(obs.retryAt)), obs);

  const retryDate = new Date(obs?.retryAt);
  check("observation: retryAt parses to local 4:47 AM", retryDate.getHours() === 4 && retryDate.getMinutes() === 47, {
    retryAt: obs?.retryAt,
    localHours: retryDate.getHours(),
    localMinutes: retryDate.getMinutes(),
  });

  // Also check individual lines produce the observation
  const obsLine1 = driver.observe([JSON.parse(LINE1)], probe);
  check("observation: error event alone produces rate_limited with codex_usage_limit",
    obsLine1.some(o => o.type === "rate_limited" && o.reason === "codex_usage_limit" && typeof o.retryAt === "string"));

  const obsLine2 = driver.observe([JSON.parse(LINE2)], probe);
  check("observation: turn.failed event alone produces rate_limited with codex_usage_limit",
    obsLine2.some(o => o.type === "rate_limited" && o.reason === "codex_usage_limit" && typeof o.retryAt === "string"));
}

// ── 2. Classification RATE_LIMITED non-retryable ────────────────────────────
{
  const driver = adapterDriver("codex");
  const events = driver.decodeEvents(EXACT_STDOUT, "");
  const observations = driver.observe(events, {});

  const classified = classifyObservedFailure({
    exitCode: 1,
    stdout: EXACT_STDOUT,
    stderr: "",
    startError: null,
    timedOut: false,
    driverless: false,
    evidence: observations,
  });

  check("classification: failure class is RATE_LIMITED", classified?.class === "RATE_LIMITED", classified);
  check("classification: domain is infrastructure", classified?.domain === "infrastructure", classified);
  check("classification: non-retryable", classified?.retryable === false, classified);
  check("classification: evidence carries retryAt", classified?.evidence?.some(e => e.retryAt && typeof e.retryAt === "string"), classified?.evidence);
}

// ── 3. Resume text includes the time ────────────────────────────────────────
{
  const driver = adapterDriver("codex");
  const events = driver.decodeEvents(EXACT_STDOUT, "");
  const observations = driver.observe(events, {});
  const classified = classifyObservedFailure({
    exitCode: 1,
    stdout: EXACT_STDOUT,
    stderr: "",
    evidence: observations,
  });

  const naming = decideEscalationName({
    failureClass: classified.class,
    retryable: classified.retryable,
    used: 0,
    limit: 1,
    budget: "infrastructureRetryBudget",
    evidence: classified.evidence,
  });

  check("escalation naming: step is rate_limited_escalation", naming?.step === "rate_limited_escalation", naming);
  check("escalation naming: detail says 'resume after 4:47 AM'", naming?.detail?.includes("resume after 4:47 AM"), naming?.detail);
  check("escalation naming: detail does not use generic 'after the limit lifts'", !naming?.detail?.includes("after the limit lifts"), naming?.detail);
}

// ── 4. Sticky free-quota entry kept before 03:00 and cleared after 03:00 ───
{
  const roleConfig = {
    adapter: "opencode",
    model: "deepseek/deepseek-chat",
    fallbacks: [{adapter: "gemini", model: "gemini-2.5-flash"}],
  };

  // Choose a base date today at 12:00 local time
  const now = new Date();
  const sinceDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0);
  const sinceIso = sinceDate.toISOString();
  const sinceMs = sinceDate.getTime();

  // Next local 03:00 is tomorrow at 03:00:00
  const next0300Date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 3, 0, 0, 0);
  const next0300Ms = next0300Date.getTime();

  // (a) Stamped entry carries field reason
  const fallback = roleConfig.fallbacks[0];
  const stamped = stampStickyFallback(fallback, roleConfig, sinceIso, FREE_QUOTA_REASON);
  check("sticky fallback: stamped entry has field reason = free_quota_exhausted", stamped?.reason === FREE_QUOTA_REASON, stamped);
  check("sticky fallback: derivedFrom is stamped correctly", stamped?.derivedFrom?.model === "deepseek/deepseek-chat", stamped);

  // (b) At since + 2h (14:00 today, well before 03:00 tomorrow), entry is KEPT
  const atSincePlus2h = sinceMs + 2 * 3600 * 1000;
  const kept = staleStickyFallback({
    role: "implementer",
    roleConfig,
    activeModel: stamped,
    policy: {fallback_retry_primary_minutes: 60},
    nowMs: atSincePlus2h,
  });
  check("sticky fallback: kept at since+2h before 03:00 (returns null)", kept === null, kept);

  // (c) After next local 03:00 (e.g. 03:05 next day), entry is CLEARED by age
  const after0300 = next0300Ms + 5 * 60 * 1000;
  const cleared = staleStickyFallback({
    role: "implementer",
    roleConfig,
    activeModel: stamped,
    policy: {fallback_retry_primary_minutes: 60},
    nowMs: after0300,
  });
  check("sticky fallback: cleared by age after 03:00", cleared?.why === "age", cleared);
  check("sticky fallback: message mentions retrying primary", cleared?.message?.includes("retrying primary"), cleared);

  // (d) Negative control: entry WITHOUT free_quota reason is cleared at since+2h
  const normalStamped = stampStickyFallback(fallback, roleConfig, sinceIso);
  const normalCleared = staleStickyFallback({
    role: "implementer",
    roleConfig,
    activeModel: normalStamped,
    policy: {fallback_retry_primary_minutes: 60},
    nowMs: atSincePlus2h,
  });
  check("sticky fallback: normal entry (no free quota reason) is cleared at since+2h", normalCleared?.why === "age", normalCleared);
}

// ── 5. Wiring assertion: autopilot stamps sticky fallback with reason ────────
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const autoSrc = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
  check("wiring: autopilot calls stampStickyFallback with reason when freeQuotaExhausted",
    /stampStickyFallback\(decision\.next,[^,]+,[^,]+,\s*stickyReason\)/.test(autoSrc),
    "missing stampStickyFallback call with stickyReason in autopilot.mjs");
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nALL CHECKS PASSED");
