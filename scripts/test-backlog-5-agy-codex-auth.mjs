#!/usr/bin/env node
// Backlog b5: logged-out agy (antigravity) and codex runs must classify
// AUTH_REQUIRED (terminal, non-retryable, zero adapterRetryBudget spent) and
// escalate with CLI-specific login instructions.
import assert from "node:assert/strict";
import {adapterDriver} from "./adapter-drivers.mjs";
import {classifyObservedFailure, recordFailureBudget} from "./failure-contract.mjs";
import {decideEscalationName} from "./escalation-naming.mjs";

const agy = adapterDriver("antigravity");
const codex = adapterDriver("codex");

// ── 1. agy stderr-only cases => AUTH_REQUIRED, non-retryable, adapter named ──
for (const [label, stderr] of [
  ["agy authentication required + Run 'agy' to log in", "Error: authentication required. Run 'agy' to log in, then retry."],
  ["agy authentication failed or timed out", "error: authentication failed or timed out"],
]) {
  const classified = classifyObservedFailure({
    exitCode: 1,
    stdout: "",
    stderr,
    startError: null,
    timedOut: false,
    evidence: [],
    driverless: false,
    adapter: "antigravity",
  });
  assert.equal(classified?.class, "AUTH_REQUIRED", `${label}: classified AUTH_REQUIRED`);
  assert.equal(classified?.domain, "adapter", `${label}: adapter domain`);
  assert.equal(classified?.retryable, false, `${label}: not retryable`);
  const ev = classified?.evidence?.find(e => e?.type === "auth_required");
  assert.equal(ev?.adapter, "antigravity", `${label}: evidence names antigravity adapter`);
  assert.ok(typeof ev?.reason === "string" && ev.reason.length > 0, `${label}: evidence carries reason`);
  console.log(`PASS ${label}`);
}

// ── 2. agy stream-json result event => structured auth_required => AUTH_REQUIRED ──
{
  const stdout = JSON.stringify({
    event: "result",
    result: {
      conversation_id: "",
      status: "ERROR",
      response: "",
      error: "authentication failed or timed out",
      duration_seconds: 0,
      num_turns: 0,
      finished_reason: "error",
    },
  });
  const events = agy.decodeEvents(stdout, "");
  const observed = agy.observe(events, {});
  const authObs = observed.find(o => o.type === "auth_required");
  assert.ok(authObs, "agy driver emits auth_required observation");
  assert.equal(authObs.adapter, "antigravity", "agy observation names antigravity adapter");

  const classified = classifyObservedFailure({
    exitCode: 1,
    stdout,
    stderr: "",
    startError: null,
    timedOut: false,
    evidence: observed,
    driverless: false,
    adapter: "antigravity",
  });
  assert.equal(classified?.class, "AUTH_REQUIRED", "agy stream-json result => AUTH_REQUIRED");
  assert.equal(classified?.domain, "adapter", "agy stream-json result => adapter domain");
  assert.equal(classified?.retryable, false, "agy stream-json result => not retryable");
  assert.equal(classified?.evidence?.find(e => e?.type === "auth_required")?.adapter, "antigravity");
  console.log("PASS agy stream-json result => AUTH_REQUIRED/non-retryable");
}

// ── 3. codex turn.failed (with Reconnecting lines) => AUTH_REQUIRED ───────────
{
  const stdout = [
    JSON.stringify({type: "thread.started", thread_id: "01a217ce-0000-0000-0000-000000000000"}),
    JSON.stringify({type: "turn.started"}),
    JSON.stringify({type: "error", message: "Reconnecting... 1/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header)"}),
    JSON.stringify({type: "error", message: "Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header)"}),
    JSON.stringify({type: "turn.failed", error: {message: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header"}}),
  ].join("\n");
  const events = codex.decodeEvents(stdout, "");
  const observed = codex.observe(events, {});
  const authObs = observed.filter(o => o.type === "auth_required");
  assert.equal(authObs.length, 1, "codex driver emits exactly one auth_required observation");
  assert.equal(authObs[0].adapter, "codex", "codex observation names codex adapter");

  const classified = classifyObservedFailure({
    exitCode: 1,
    stdout,
    stderr: "",
    startError: null,
    timedOut: false,
    evidence: observed,
    driverless: false,
    adapter: "codex",
  });
  assert.equal(classified?.class, "AUTH_REQUIRED", "codex turn.failed => AUTH_REQUIRED");
  assert.equal(classified?.domain, "adapter", "codex turn.failed => adapter domain");
  assert.equal(classified?.retryable, false, "codex turn.failed => not retryable");
  assert.equal(classified?.evidence?.find(e => e?.type === "auth_required")?.adapter, "codex");
  console.log("PASS codex turn.failed => AUTH_REQUIRED/non-retryable");
}

// ── 3b. codex final error event (without turn.failed) => AUTH_REQUIRED ──────
{
  const stdout = [
    JSON.stringify({type: "turn.started"}),
    JSON.stringify({type: "error", message: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header"}),
  ].join("\n");
  const events = codex.decodeEvents(stdout, "");
  const observed = codex.observe(events, {});
  assert.equal(observed.filter(o => o.type === "auth_required").length, 1, "codex final error emits auth_required");
  const classified = classifyObservedFailure({
    exitCode: 1,
    stdout,
    stderr: "",
    startError: null,
    timedOut: false,
    evidence: observed,
    driverless: false,
    adapter: "codex",
  });
  assert.equal(classified?.class, "AUTH_REQUIRED", "codex final error => AUTH_REQUIRED");
  assert.equal(classified?.retryable, false);
  console.log("PASS codex final error => AUTH_REQUIRED/non-retryable");
}

// ── 4. codex Reconnecting errors + later success (or alone) => NOT auth ─────
{
  const recoveredStdout = [
    JSON.stringify({type: "turn.started"}),
    JSON.stringify({type: "error", message: "Reconnecting... 1/5 (unexpected status 401 Unauthorized: transient)"}),
    JSON.stringify({type: "error", message: "Reconnecting... 2/5 (unexpected status 401 Unauthorized: transient)"}),
    JSON.stringify({type: "turn.completed", usage: {input_tokens: 10, output_tokens: 5}}),
  ].join("\n");
  const recoveredEvents = codex.decodeEvents(recoveredStdout, "");
  const recoveredObs = codex.observe(recoveredEvents, {});
  assert.equal(recoveredObs.filter(o => o.type === "auth_required").length, 0, "reconnecting + turn.completed never emits auth_required");
  const recoveredClassified = classifyObservedFailure({
    exitCode: 0,
    stdout: recoveredStdout,
    stderr: "",
    startError: null,
    timedOut: false,
    evidence: recoveredObs,
    driverless: false,
    adapter: "codex",
  });
  assert.equal(recoveredClassified, null, "reconnecting + turn.completed with exit 0 is not a failure");

  const reconnectingOnlyStdout = [
    JSON.stringify({type: "turn.started"}),
    JSON.stringify({type: "error", message: "Reconnecting... 1/5 (unexpected status 401 Unauthorized: transient)"}),
  ].join("\n");
  const reconnectingOnlyObs = codex.observe(codex.decodeEvents(reconnectingOnlyStdout, ""), {});
  assert.equal(reconnectingOnlyObs.filter(o => o.type === "auth_required").length, 0, "intermediate Reconnecting error alone never emits auth_required");
  const reconnectingOnlyClassified = classifyObservedFailure({
    exitCode: 1,
    stdout: reconnectingOnlyStdout,
    stderr: "",
    startError: null,
    timedOut: false,
    evidence: reconnectingOnlyObs,
    driverless: false,
    adapter: "codex",
  });
  assert.notEqual(reconnectingOnlyClassified?.class, "AUTH_REQUIRED", "intermediate Reconnecting error alone is not AUTH_REQUIRED");
  console.log("PASS codex Reconnecting errors alone or with later success => NOT auth");
}

// ── 5. Unrelated agy failure => still NOT AUTH_REQUIRED ─────────────────────
for (const [label, stderr] of [
  ["agy model overloaded", "Error: model overloaded"],
  ["bare authentication word", "Error: authentication context note in unrelated diagnostic"],
]) {
  const classified = classifyObservedFailure({
    exitCode: 1,
    stdout: "",
    stderr,
    startError: null,
    timedOut: false,
    evidence: [],
    driverless: false,
    adapter: "antigravity",
  });
  assert.notEqual(classified?.class, "AUTH_REQUIRED", `${label}: must not classify AUTH_REQUIRED`);
  assert.equal(classified?.class, "PROCESS_EXIT_NONZERO", `${label}: stays PROCESS_EXIT_NONZERO`);
  console.log(`PASS unrelated agy failure (${label}) => PROCESS_EXIT_NONZERO`);
}

// ── 6. Escalation text for agy and codex ────────────────────────────────────
{
  const agyNaming = decideEscalationName({
    failureClass: "AUTH_REQUIRED",
    retryable: false,
    used: 0,
    limit: 3,
    budget: "adapterRetryBudget",
    evidence: [{type: "auth_required", adapter: "antigravity", reason: "authentication failed or timed out"}],
  });
  assert.equal(agyNaming.step, "auth_required_escalation");
  assert.equal(
    agyNaming.detail,
    "agy is logged out (authentication failed or timed out) — run `agy` and log in, then `ap run`",
  );

  const codexNaming = decideEscalationName({
    failureClass: "AUTH_REQUIRED",
    retryable: false,
    used: 0,
    limit: 3,
    budget: "adapterRetryBudget",
    evidence: [{type: "auth_required", adapter: "codex", reason: "401 Unauthorized"}],
  });
  assert.equal(codexNaming.step, "auth_required_escalation");
  assert.equal(
    codexNaming.detail,
    "codex is not authenticated (401 Unauthorized) — run `codex login`, then `ap run`",
  );
  console.log("PASS escalation text for agy and codex");
}

// ── 7. Budget not spent for agy or codex AUTH_REQUIRED ──────────────────────
{
  const policy = {failure_budgets: {adapterRetryBudget: 3}};

  const agyState = {};
  const agyAuth = classifyObservedFailure({
    exitCode: 1,
    stdout: "",
    stderr: "Error: authentication required. Run 'agy' to log in, then retry.",
    startError: null,
    timedOut: false,
    evidence: [],
    driverless: false,
    adapter: "antigravity",
  });
  const agyBudget = recordFailureBudget(agyState, policy, agyAuth, "adapter:antigravity:implementer");
  assert.equal(agyBudget.allowed, false, "agy AUTH_REQUIRED is denied immediately");
  assert.equal(agyBudget.used, 0, "agy AUTH_REQUIRED reports used=0");
  assert.equal(agyState.failureBudgets?.["adapterRetryBudget:adapter:antigravity:implementer"], undefined, "agy adapterRetryBudget key stays unset");

  const codexState = {};
  const codexStdout = JSON.stringify({type: "turn.failed", error: {message: "unexpected status 401 Unauthorized: Missing bearer"}});
  const codexAuth = classifyObservedFailure({
    exitCode: 1,
    stdout: codexStdout,
    stderr: "",
    startError: null,
    timedOut: false,
    evidence: codex.observe(codex.decodeEvents(codexStdout, ""), {}),
    driverless: false,
    adapter: "codex",
  });
  const codexBudget = recordFailureBudget(codexState, policy, codexAuth, "adapter:codex:implementer");
  assert.equal(codexBudget.allowed, false, "codex AUTH_REQUIRED is denied immediately");
  assert.equal(codexBudget.used, 0, "codex AUTH_REQUIRED reports used=0");
  assert.equal(codexState.failureBudgets?.["adapterRetryBudget:adapter:codex:implementer"], undefined, "codex adapterRetryBudget key stays unset");

  console.log("PASS adapterRetryBudget not spent for agy or codex");
}

console.log("ALL CHECKS PASSED");
