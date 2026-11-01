#!/usr/bin/env node
// Backlog #15: a paid provider's empty balance/credit is not the free tier's
// quota. OpenCode 2.2.0 on deepseek/deepseek-flash reported the real line
// captured below; the old free-quota regex matched "QuotaExceeded" inside the
// stack, so the run was labelled free_quota_exhausted and told the operator to
// wait for the limit to lift — waiting never refills a paid balance.
//
// The failure class stays RATE_LIMITED (fallback/escalation unchanged); only
// the evidence reason and the operator text change.
import assert from "node:assert/strict";
import {adapterDriver} from "./adapter-drivers.mjs";
import {classifyObservedFailure} from "./failure-contract.mjs";
import {decideEscalationName} from "./escalation-naming.mjs";
import {
  formatRateLimitedMessage, rateLimitLineInfo,
  FREE_QUOTA_REASON, PROVIDER_BALANCE_REASON,
} from "./idle-hang-watchdog.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  return false;
}

const driver = adapterDriver("opencode");
const observe = (events) => driver.observe(events, {repoRoot: "/workspace/repository", readPath: "", productionWritePath: "", outsideWritePath: ""});
const stderrEvents = (text) => driver.decodeEvents("", text);

// The real 2.2.0 stderr line from the reported run. Note the cause stack:
// `AI.Error.QuotaExceeded` is engine class noise around the paid-balance
// message and is exactly what the old free-quota regex matched.
const REAL_2X_LINE = `timestamp=2026-10-31T11:06:25.809Z level=ERROR run=e0e6df6e message="Failed to drain Session" cause="AI.Error: Insufficient Balance (request_id: 6b0135bf-b458-40ca-a02d-cf43ba108bcd)\\n    at WZ (/$bunfs/root/chunk-kx5qvmxf.js:3:3653)\\n    at <anonymous> (/$bunfs/root/chunk-kx5qvmxf.js:3:3346)\\n    at SessionStep.attempt (/$bunfs/root/chunk-p4z7mg5d.js:367:3760)\\n    at SessionRunner.drain (/$bunfs/root/chunk-ykc43bz2.js:18:2552) {\\n  [cause]: AI.Error.QuotaExceeded: Insufficient Balance (request_id: 6b0135bf-b458-40ca-a02d-cf43ba108bcd)\\n      at ef (/$bunfs/root/chunk-kx5qvmxf.js:3:507)\\n}" role=server sessionID=ses_e6e5cc410ffeihc6PiftAuwtKT`;

// ── 1. The real 2.x balance line ───────────────────────────────────────────
{
  const events = stderrEvents(REAL_2X_LINE);
  const observations = observe(events);
  const hit = observations.find(o => o.type === "rate_limited");
  check("real 2.2.0 line: adapter records a rate_limited observation", Boolean(hit), observations);
  check("real 2.2.0 line: reason is provider_balance_exhausted",
    hit?.reason === PROVIDER_BALANCE_REASON, hit);
  check("real 2.2.0 line: reason is not free_quota_exhausted",
    hit?.reason !== FREE_QUOTA_REASON, hit);

  const classified = classifyObservedFailure({
    exitCode: 1, stdout: "", stderr: REAL_2X_LINE, startError: null, timedOut: false,
    driverless: false, evidence: observations,
  });
  check("real 2.2.0 line: failure class stays RATE_LIMITED",
    classified?.class === "RATE_LIMITED", classified);
  check("real 2.2.0 line: RATE_LIMITED stays infrastructure + not retryable",
    classified?.domain === "infrastructure" && classified?.retryable === false, classified);
  check("real 2.2.0 line: evidence carries the balance reason",
    classified?.evidence?.some(e => e?.reason === PROVIDER_BALANCE_REASON), classified?.evidence);

  const info = rateLimitLineInfo(REAL_2X_LINE);
  check("real 2.2.0 line: watchdog hit uses the balance reason",
    info?.reason === PROVIDER_BALANCE_REASON, info);
}

// ── 2. 1.x shape: AI_APICallError + insufficient account funds ─────────────
{
  const line = `timestamp=2026-10-31T00:00:00.000Z level=ERROR message="stream error" providerID=deepseek modelID=deepseek-flash error.error="AI_APICallError: insufficient account funds"`;
  const events = stderrEvents(line);
  const hit = observe(events).find(o => o.type === "rate_limited");
  check("1.x insufficient account funds: adapter reason is balance",
    hit?.reason === PROVIDER_BALANCE_REASON, hit);
  check("1.x insufficient account funds: watchdog reason is balance",
    rateLimitLineInfo(line)?.reason === PROVIDER_BALANCE_REASON, rateLimitLineInfo(line));
  const classified = classifyObservedFailure({
    exitCode: 1, stdout: "", stderr: line, startError: null, timedOut: false,
    driverless: false, evidence: observe(events),
  });
  check("1.x insufficient account funds: class stays RATE_LIMITED",
    classified?.class === "RATE_LIMITED", classified);
}

// ── 3. Structured error event with statusCode 402 ──────────────────────────
{
  const event = {type: "error", error: {name: "APIError", data: {message: "Payment required", statusCode: 402}}};
  const hit = observe([event]).find(o => o.type === "rate_limited");
  check("error event statusCode 402: adapter reason is balance",
    hit?.reason === PROVIDER_BALANCE_REASON, hit);
  check("error event statusCode 402: class stays RATE_LIMITED",
    classifyObservedFailure({exitCode: 1, stdout: "", stderr: "", evidence: observe([event])})?.class === "RATE_LIMITED");
}
// The real 2.x event puts the status on error.status and the type on
// provider.quota; it must classify the same way.
{
  const event = {
    type: "error",
    error: {
      type: "provider.quota",
      message: "Insufficient Balance (request_id: 6b0135bf)",
      status: 402,
    },
  };
  const hit = observe([event]).find(o => o.type === "rate_limited");
  check("real 2.x provider.quota event: reason is balance",
    hit?.reason === PROVIDER_BALANCE_REASON, hit);
}

// ── 4. Real free-quota text keeps FREE_QUOTA_REASON ────────────────────────
{
  const quotaText = "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go";
  const line = `timestamp=2026-10-28T00:00:50.996Z level=ERROR run=65c65963 message="stream error" providerID=opencode modelID=deepseek-v4.1-flash-free small=false agent=build error.error="AI_APICallError: ${quotaText}"`;
  const hit = observe(stderrEvents(line)).find(o => o.type === "rate_limited");
  check("free usage limit reached: reason stays free_quota_exhausted",
    hit?.reason === FREE_QUOTA_REASON, hit);
  check("free usage limit reached: watchdog reason stays free_quota_exhausted",
    rateLimitLineInfo(line)?.reason === FREE_QUOTA_REASON, rateLimitLineInfo(line));
}

// ── 5. Plain rate limit is unchanged ───────────────────────────────────────
{
  const line = `timestamp=2026-09-07T06:16:03.600Z level=ERROR message="stream error" providerID=opencode modelID=free error.error="AI_APICallError: [rate_limit_exceeded] Rate limit exceeded. Please retry after a brief wait."`;
  const hit = observe(stderrEvents(line)).find(o => o.type === "rate_limited");
  check("rate limit exceeded: reason stays opencode_stderr_rate_limit",
    hit?.reason === "opencode_stderr_rate_limit", hit);
}

// ── 6. Model prose is never a provider verdict ─────────────────────────────
{
  const prose = "The provider said: Insufficient Balance (request_id: nope)";
  const proseEvents = [
    {type: "text", part: {type: "text", text: prose}},
    {type: "tool_use", part: {type: "tool", tool: "bash", state: {status: "completed", input: {}, output: prose}}},
  ];
  check("stdout text/tool prose: no rate_limited observation",
    !observe(proseEvents).some(o => o.type === "rate_limited"), observe(proseEvents));
  const decoded = observe(driver.decodeEvents(JSON.stringify({type: "text", part: {type: "text", text: prose}}), ""));
  check("decoded stdout text event: no rate_limited observation",
    !decoded.some(o => o.type === "rate_limited"), decoded);
  check("watchdog: JSON stdout text quoting the words is not a hit",
    rateLimitLineInfo(JSON.stringify({type: "text", part: {type: "text", text: prose}})) === null);
  const noSource = `level=ERROR message="stream error" providerID=deepseek modelID=deepseek-flash error.error="Insufficient Balance"`;
  check("watchdog: no engine-error source => not a hit",
    rateLimitLineInfo(noSource) === null);
  check("adapter: stderr without the engine-error source => no rate_limited",
    !observe(stderrEvents(noSource)).some(o => o.type === "rate_limited"), observe(stderrEvents(noSource)));
}

// ── 7. Operator-facing text for the balance reason ─────────────────────────
{
  const message = formatRateLimitedMessage({
    role: "verifier", adapter: "opencode", model: "deepseek/deepseek-flash",
    provider: "deepseek", balanceExhausted: true,
  });
  check("watchdog message: says the paid balance is exhausted",
    message.includes("paid balance is exhausted"), message);
  check("watchdog message: tells the operator to top up", message.includes("top up"), message);
  check("watchdog message: offers switching the role model", message.includes("another model") && message.includes("ap config"), message);
  check("watchdog message: ends with ap run", message.includes("ap run"), message);
  check("watchdog message: never says the limit lifts", !message.includes("limit lifts"), message);
  check("watchdog message: never says free quota used up", !message.includes("free quota used up"), message);

  const naming = decideEscalationName({
    failureClass: "RATE_LIMITED", retryable: false, used: 0, limit: 0, budget: "infrastructureRetryBudget",
    evidence: [{type: "rate_limited", reason: PROVIDER_BALANCE_REASON, provider: "deepseek", model: "deepseek/deepseek-flash"}],
  });
  check("escalation: balance keeps the rate_limited_escalation step",
    naming?.step === "rate_limited_escalation", naming);
  check("escalation: detail says the paid balance is exhausted",
    /paid balance is exhausted/i.test(naming?.detail || ""), naming);
  check("escalation: detail tells the operator to top up", /top up the deepseek balance/i.test(naming?.detail || ""), naming);
  check("escalation: detail offers switching the role model", /switch the role to another model.*ap config/i.test(naming?.detail || ""), naming);
  check("escalation: detail never says the limit lifts", !/limit lifts/i.test(naming?.detail || ""), naming);

  // Real free-quota wording is untouched.
  const freeMessage = formatRateLimitedMessage({
    role: "implementer", adapter: "opencode", model: "free-model", provider: "opencode", freeQuota: true,
  });
  check("watchdog message: free quota keeps its existing wording",
    freeMessage.includes("free quota used up") && !freeMessage.includes("top up"), freeMessage);
  const freeNaming = decideEscalationName({
    failureClass: "RATE_LIMITED", retryable: false, used: 0, limit: 0, budget: "infrastructureRetryBudget",
    evidence: [{type: "rate_limited", reason: FREE_QUOTA_REASON, provider: "opencode", model: "free-model"}],
  });
  check("escalation: free quota keeps the existing limit-lifts wording",
    /limit lifts/i.test(freeNaming?.detail || ""), freeNaming);
}

// The progress observe label carries the balance marker, not FREE_QUOTA.
{
  const fs = await import("node:fs");
  const source = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
  check("wiring: progress line supports BALANCE_EXHAUSTED=true",
    source.includes("BALANCE_EXHAUSTED=true"), "missing BALANCE_EXHAUSTED=true");
  check("wiring: fallback log has a provider-balance label",
    source.includes("provider balance exhausted"), "missing provider balance label");
}

if (failures) {
  console.error(`${failures} provider-balance-exhausted check(s) failed.`);
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
