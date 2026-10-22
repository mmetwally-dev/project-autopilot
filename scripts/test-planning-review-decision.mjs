#!/usr/bin/env node
// Planning-review decision unit tests: the pure function is exercised
// directly over pre-recorded `{failure, budget, scope}` triples (never a raw
// relay result, never the filesystem).
//
// Covers every branch of `decidePlanningReview()`:
// - each `retryable:true` class reachable at a relay call (TIMEOUT,
//   RATE_LIMITED, SERVER_UNAVAILABLE, generic PROCESS_EXIT_NONZERO,
//   PROCESS_START_FAILED) with budget available retries the reviewer;
// - the same classes with budget exhausted escalate;
// - PATH_UNSUPPORTED and PERMISSION_DENIED escalate naming class+domain;
// - INTERNAL_CONTRACT_ERROR/"orchestrator" escalates;
// - PLANNING_REJECTED passes through in every case tried, including with
//   budget available;
// - STRUCTURED_OUTPUT_MISSING and STRUCTURED_OUTPUT_INVALID are retryable
//   adapter failures: they retry with budget available and escalate with
//   budget exhausted.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {failure} from "./failure-contract.mjs";
import {decidePlanningReview, isPlanningReviewRetryFramework} from "./planning-review-decision.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  failed += 1;
}

check("exports decidePlanningReview", typeof decidePlanningReview === "function");

// ── Purity: no filesystem/child-channel/network access, no budget authority ──
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, "planning-review-decision.mjs"), "utf8");
  for (const token of [
    "node:fs", "node:child_process", "node:net", "node:http", "node:https",
    "process.", "new Date(", "writeFileSync", "readFileSync", "renameSync",
    "spawnSync", "execSync", "fetch(", "XMLHttpRequest",
  ]) {
    check(`pure: no ${token}`, !source.includes(token), token);
  }
  // Never calls (or imports) the budget authorities: comment-stripped so the
  // docblock naming them as the caller's job does not false-positive. There
  // is no "planning" budget — this module never derives one.
  const codeOnly = source.replace(/\/\/.*$/gm, "");
  check("pure: no module imports", !/^\s*import\s/m.test(codeOnly), "import statement found");
  for (const name of ["recordFailureBudget", "enforceAttemptFailure", "recordAttemptFailure"]) {
    check(`pure: never calls ${name}()`, !new RegExp(`\\b${name}\\s*\\(`).test(codeOnly), name);
  }
}

const SCOPE_INFRA = "mission";
const SCOPE_ADAPTER = "adapter:codex:plan_reviewer";
const budgetAvailable = (budget, scope) => ({allowed: true, budget, used: 1, limit: 2, scope});
const budgetExhausted = (budget, scope) => ({allowed: false, budget, used: 2, limit: 2, scope});

function decided(input) {
  const result = decidePlanningReview(input);
  check(`returns a decision object for ${input.failure.class}/${input.failure.domain}`, result !== null && typeof result === "object" && typeof result.action === "string", result);
  return result;
}

// ── Retryable adapter/infrastructure failures with budget available → retry ──
const retryableCases = [
  {failure: failure("TIMEOUT", "infrastructure", true, [{source: "relay"}]), budget: budgetAvailable("infrastructureRetryBudget", SCOPE_INFRA), scope: SCOPE_INFRA},
  {failure: failure("RATE_LIMITED", "infrastructure", true, [{type: "rate_limited"}]), budget: budgetAvailable("infrastructureRetryBudget", SCOPE_INFRA), scope: SCOPE_INFRA},
  {failure: failure("SERVER_UNAVAILABLE", "infrastructure", true, [{type: "server_unavailable"}]), budget: budgetAvailable("infrastructureRetryBudget", SCOPE_INFRA), scope: SCOPE_INFRA},
  {failure: failure("PROCESS_EXIT_NONZERO", "adapter", true, [{source: "relay"}]), budget: budgetAvailable("adapterRetryBudget", SCOPE_ADAPTER), scope: SCOPE_ADAPTER},
  {failure: failure("PROCESS_START_FAILED", "adapter", true, [{source: "relay"}]), budget: budgetAvailable("adapterRetryBudget", SCOPE_ADAPTER), scope: SCOPE_ADAPTER},
];
for (const input of retryableCases) {
  const result = decided(input);
  check(`${input.failure.class}/${input.failure.domain} with budget available retries`, result.action === "retry", result);
}

// ── The same classes with budget exhausted → escalate ──
for (const retryable of retryableCases) {
  const budgetName = retryable.failure.domain === "infrastructure" ? "infrastructureRetryBudget" : "adapterRetryBudget";
  const input = {...retryable, budget: budgetExhausted(budgetName, retryable.scope)};
  const result = decided(input);
  check(`${input.failure.class}/${input.failure.domain} with budget exhausted escalates`,
    result.action === "escalate" &&
    result.evidence?.class === input.failure.class &&
    result.evidence?.domain === input.failure.domain, result);
}

// ── PATH_UNSUPPORTED / PERMISSION_DENIED → escalate naming class+domain ──
for (const input of [
  {failure: failure("PATH_UNSUPPORTED", "infrastructure", false, [{type: "path_unsupported"}]), budget: budgetAvailable("infrastructureRetryBudget", SCOPE_INFRA), scope: SCOPE_INFRA},
  {failure: failure("PATH_UNSUPPORTED", "infrastructure", false, [{type: "path_unsupported"}]), budget: budgetExhausted("infrastructureRetryBudget", SCOPE_INFRA), scope: SCOPE_INFRA},
  {failure: failure("PERMISSION_DENIED", "adapter", false, [{type: "permission_denied"}]), budget: budgetAvailable("adapterRetryBudget", SCOPE_ADAPTER), scope: SCOPE_ADAPTER},
  {failure: failure("PERMISSION_DENIED", "adapter", false, [{type: "permission_denied"}]), budget: budgetExhausted("adapterRetryBudget", SCOPE_ADAPTER), scope: SCOPE_ADAPTER},
]) {
  const result = decided(input);
  const budgetState = input.budget.allowed ? "budget available" : "budget exhausted";
  check(`${input.failure.class} with ${budgetState} escalates naming class+domain`,
    result.action === "escalate" &&
    result.evidence?.class === input.failure.class &&
    result.evidence?.domain === input.failure.domain, result);
}

// ── INTERNAL_CONTRACT_ERROR / "orchestrator" → escalate ──
{
  const input = {
    failure: failure("INTERNAL_CONTRACT_ERROR", "orchestrator", false, [{source: "attempt"}]),
    budget: {allowed: false, budget: null, used: 0, limit: 0, scope: "task:planning"},
    scope: "task:planning",
  };
  const result = decided(input);
  check(`INTERNAL_CONTRACT_ERROR/orchestrator escalates`,
    result.action === "escalate" &&
    result.evidence?.class === "INTERNAL_CONTRACT_ERROR" &&
    result.evidence?.domain === "orchestrator", result);
}

// ── Passthrough class → passthrough in every case, budget or not ──
for (const input of [
  {failure: failure("PLANNING_REJECTED", "planning", true, ["finding"]), budget: budgetAvailable("adapterRetryBudget", SCOPE_ADAPTER), scope: SCOPE_ADAPTER},
  {failure: failure("PLANNING_REJECTED", "planning", true, ["finding"]), budget: budgetExhausted("adapterRetryBudget", SCOPE_ADAPTER), scope: SCOPE_ADAPTER},
]) {
  const result = decided(input);
  const budgetState = input.budget.allowed ? "budget available" : "budget exhausted";
  check(`${input.failure.class} with ${budgetState} passes through`, result.action === "passthrough", result);
}

// ── STRUCTURED_OUTPUT_MISSING / STRUCTURED_OUTPUT_INVALID are retryable
// adapter failures: retry with budget available, escalate with budget exhausted ──
for (const input of [
  {failure: failure("STRUCTURED_OUTPUT_MISSING", "adapter", true, [{source: "relay"}]), budget: budgetAvailable("adapterRetryBudget", SCOPE_ADAPTER), scope: SCOPE_ADAPTER},
  {failure: failure("STRUCTURED_OUTPUT_INVALID", "adapter", true, [{source: "relay"}]), budget: budgetAvailable("adapterRetryBudget", SCOPE_ADAPTER), scope: SCOPE_ADAPTER},
]) {
  const result = decided(input);
  check(`${input.failure.class} with budget available retries`, result.action === "retry", result);
}
for (const input of [
  {failure: failure("STRUCTURED_OUTPUT_MISSING", "adapter", true, [{source: "relay"}]), budget: budgetExhausted("adapterRetryBudget", SCOPE_ADAPTER), scope: SCOPE_ADAPTER},
  {failure: failure("STRUCTURED_OUTPUT_INVALID", "adapter", true, [{source: "relay"}]), budget: budgetExhausted("adapterRetryBudget", SCOPE_ADAPTER), scope: SCOPE_ADAPTER},
]) {
  const result = decided(input);
  check(`${input.failure.class} with budget exhausted escalates`,
    result.action === "escalate" &&
    result.evidence?.class === input.failure.class &&
    result.evidence?.domain === input.failure.domain, result);
}

// ── Allowlist predicate for reviewExistingPlanning()'s retry path ──
//
// Unit-tested directly here — never via a subprocess/CLI run:
// state.framework/config.project.planning_framework is validated upstream
// to one of the three real values by planningAdapter(c), so a real `ap
// run` can never reach reviewExistingPlanning() with a value this
// predicate would reject, and a subprocess test attempting that case
// would prove nothing.
check("exports isPlanningReviewRetryFramework", typeof isPlanningReviewRetryFramework === "function");
for (const [framework, expected] of [
  ["standalone", true],
  ["speckit", true],
  ["gsd", false],
  ["standalon", false],
  ["SPECKIT", false],
  ["", false],
  ["some-future-framework", false],
]) {
  check(`allowlist: ${JSON.stringify(framework)} -> ${expected}`,
    isPlanningReviewRetryFramework(framework) === expected,
    isPlanningReviewRetryFramework(framework));
}

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);