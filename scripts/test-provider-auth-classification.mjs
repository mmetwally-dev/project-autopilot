#!/usr/bin/env node
// Backlog #12(b): a provider credential rejection in the CLI's own stderr is
// AUTH_REQUIRED (terminal, no adapter retry), not PROCESS_EXIT_NONZERO. The
// operator-facing escalation must name the invalid/expired key and OpenCode's
// re-auth commands. Rate-limit text and model-not-found keep their own classes.
import {classifyObservedFailure, failure, recordFailureBudget} from "./failure-contract.mjs";
import {decideEscalationName} from "./escalation-naming.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  return false;
}

function classifyText(stderr, extra = {}) {
  return classifyObservedFailure({
    exitCode: 1,
    stdout: "",
    stderr,
    startError: null,
    timedOut: false,
    evidence: [],
    driverless: false,
    adapter: "opencode",
    ...extra,
  });
}

// ── The exact DeepSeek/OpenCode text + the other provider shapes ───────────
for (const [label, text] of [
  ["DeepSeek api key invalid", "Authentication Fails, Your api key ****4fb4 is invalid"],
  ["Invalid API key", "Error: Invalid API key. Please check your credentials."],
  ["invalid_api_key", '{"error":{"code":"invalid_api_key","message":"bad key"}}'],
  ["401 Unauthorized", "HTTP 401 Unauthorized"],
  ["api key ... is invalid", "Your api key sk-**** is invalid"],
]) {
  const classified = classifyText(text);
  check(`${label}: AUTH_REQUIRED`, classified?.class === "AUTH_REQUIRED", classified);
  check(`${label}: adapter domain + non-retryable`, classified?.domain === "adapter" && classified?.retryable === false, classified);
  const evidence = classified?.evidence?.find(entry => entry?.source === "stderr_text_fallback" && entry?.pattern === "auth");
  check(`${label}: carries auth evidence`, Boolean(evidence), classified?.evidence);
  check(`${label}: evidence names the adapter`, evidence?.adapter === "opencode", evidence);
  check(`${label}: evidence carries a bounded stderr snippet`, typeof evidence?.text === "string" && evidence.text.length > 0 && evidence.text.length <= 501, evidence?.text);
}

// ── Rate-limit text keeps RATE_LIMITED (auth must not steal it) ────────────
{
  const quota = classifyText("timestamp=... level=ERROR message=\"stream error\" providerID=opencode modelID=free error.error=\"AI_APICallError: Free usage limit reached. subscribe to OpenCode Go to keep going\"");
  check("free-quota text stays RATE_LIMITED", quota?.class === "RATE_LIMITED", quota);
  check("free-quota text is infrastructure + non-retryable", quota?.domain === "infrastructure" && quota?.retryable === false, quota);
  const generic = classifyText("ERROR 429 too many requests");
  check("429 text stays RATE_LIMITED", generic?.class === "RATE_LIMITED", generic);
  const both = classifyText("Authentication Fails, Your api key is invalid; Free usage limit reached");
  check("rate-limit text wins when both appear", both?.class === "RATE_LIMITED", both);
  const structured = classifyObservedFailure({
    exitCode: 1, stdout: "", stderr: "Authentication Fails, Your api key is invalid", evidence: [{type: "rate_limited"}], driverless: false, adapter: "opencode",
  });
  check("structured rate_limited still beats auth stderr", structured?.class === "RATE_LIMITED", structured);
}

// ── Model-not-found keeps PROVIDER_ERROR ───────────────────────────────────
{
  const missing = classifyText("ProviderModelNotFoundError: model opencode/gone was not found");
  check("model-not-found still PROVIDER_ERROR", missing?.class === "PROVIDER_ERROR", missing);
  check("model-not-found stays infrastructure/retryable", missing?.domain === "infrastructure" && missing?.retryable === true, missing);
}

// ── An incidental auth word in stdout never classifies (stderr only) ───────
{
  const stdoutOnly = classifyObservedFailure({
    exitCode: 1, stdout: "Authentication Fails, Your api key **** is invalid", stderr: "", evidence: [], driverless: false, adapter: "opencode",
  });
  check("auth text in stdout is ignored", stdoutOnly?.class === "PROCESS_EXIT_NONZERO", stdoutOnly);
}

// ── AUTH_REQUIRED spends no adapter retry budget (same as claude logout) ───
{
  const state = {};
  const auth = classifyText("Authentication Fails, Your api key **** is invalid");
  const recorded = recordFailureBudget(state, {failure_budgets: {adapterRetryBudget: 3}}, auth, "adapter:opencode:implementer");
  check("AUTH_REQUIRED escalates at once", recorded.allowed === false, recorded);
  check("AUTH_REQUIRED leaves the adapter budget unset", state.failureBudgets?.["adapterRetryBudget:adapter:opencode:implementer"] === undefined, state.failureBudgets);
}

// ── Operator message names the bad key + OpenCode auth commands ────────────
{
  const auth = classifyText("Authentication Fails, Your api key ****4fb4 is invalid");
  const naming = decideEscalationName({
    failureClass: auth.class, retryable: auth.retryable, used: 0, limit: 3,
    budget: "adapterRetryBudget", evidence: auth.evidence,
  });
  check("opencode auth escalation step", naming.step === "auth_required_escalation", naming);
  check("message says the provider key is invalid or expired", /provider key .*invalid or expired/.test(naming.detail), naming.detail);
  check("message names `opencode auth logout`", naming.detail.includes("opencode auth logout"), naming.detail);
  check("message names `opencode auth login`", naming.detail.includes("opencode auth login"), naming.detail);
  check("message tells the operator to resume with ap run", naming.detail.includes("ap run"), naming.detail);
  check("message never claims a budget exhaustion", !/exhausted/.test(naming.detail), naming.detail);

  // The claude logout wording is unchanged for its existing tests.
  const claude = decideEscalationName({
    failureClass: "AUTH_REQUIRED", retryable: false, used: 0, limit: 3, budget: "adapterRetryBudget",
    evidence: [{type: "auth_required", adapter: "claude", reason: "OAuth token revoked"}],
  });
  check("claude logout wording preserved", /claude is logged out \(OAuth token revoked\)/.test(claude.detail)
    && /run `claude` and log in, then `ap run`/.test(claude.detail), claude.detail);
  check("the auth failure class is still valid", failure("AUTH_REQUIRED", "adapter", false).class === "AUTH_REQUIRED");
}

if (failures) {
  console.error(`${failures} provider auth classification check(s) failed.`);
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
