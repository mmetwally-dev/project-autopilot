#!/usr/bin/env node
// Relay retry contract: pins the shared pure decision core per relay scope.
//
// `invalidContract` is module-private in `failure-contract.mjs`, and the
// code_reviewer/verifier orchestration loops live inline in `autopilot.mjs`
// and are not importable, so this file pins the shared decision core per
// relay scope instead of the loops: the six `parseReviewContract()` invalid
// outputs record a retryable adapter failure under each relay scope's
// adapter budget, and the plan-reviewer scope additionally routes through
// `decidePlanningReview` (retry while budget lasts, escalate once spent).
//
// Platform-independent: imports only exported pure functions, no filesystem,
// child-channel, or network access.
import assert from "node:assert/strict";
import {parseReviewContract, recordFailureBudget} from "./failure-contract.mjs";
import {decidePlanningReview} from "./planning-review-decision.mjs";
import {decideEscalationName} from "./escalation-naming.mjs";

const SENTINEL = 'AUTOPILOT_REVIEW={"decision":"FAIL","findings":["x"]}';

// All six `parseReviewContract()` invalid-contract paths (see the six
// `invalidContract()` call sites in failure-contract.mjs).
const INVALID_CASES = [
  {name: "line-37 no marker at all", output: "review completed without a sentinel", expectedClass: "STRUCTURED_OUTPUT_MISSING"},
  {name: "line-39 unbalanced/truncated marker JSON", output: 'AUTOPILOT_REVIEW={"decision":', expectedClass: "STRUCTURED_OUTPUT_INVALID"},
  {
    name: "line-40 two complete sentinels on different lines",
    output: `${SENTINEL}\nAUTOPILOT_REVIEW={"decision":"PASS","findings":[]}`,
    expectedClass: "STRUCTURED_OUTPUT_INVALID",
  },
  {
    name: "line-47 valid record with trailing non-empty text",
    output: `${SENTINEL}\ntrailing response content`,
    expectedClass: "STRUCTURED_OUTPUT_INVALID",
  },
  {
    name: "line-51 complete record with non-PASS/FAIL decision",
    output: 'AUTOPILOT_REVIEW={"decision":"MAYBE","findings":[]}',
    expectedClass: "STRUCTURED_OUTPUT_INVALID",
  },
  {name: "line-80 balanced object that is not valid JSON", output: "AUTOPILOT_REVIEW={invalid}", expectedClass: "STRUCTURED_OUTPUT_INVALID"},
];

// One relay scope per read-only relay role, in the `adapter:<adapter>:<role>`
// shape `failureBudgetScope()` in autopilot.mjs derives for adapter-domain
// failures.
const RELAY_SCOPES = [
  {name: "plan-reviewer scope", scope: "adapter:test:plan_reviewer"},
  {name: "code-reviewer scope", scope: "adapter:test:code_reviewer"},
  {name: "verifier scope", scope: "adapter:test:verifier"},
];

const POLICY = {failure_budgets: {adapterRetryBudget: 2}};

for (const {name, output, expectedClass} of INVALID_CASES) {
  const parsed = parseReviewContract(output);
  assert.equal(parsed.contract.status, "invalid", `${name}: contract status`);
  assert.equal(parsed.failure.class, expectedClass, `${name}: failure class`);
  assert.equal(parsed.failure.domain, "adapter", `${name}: failure domain`);
  assert.equal(parsed.failure.retryable, true, `${name}: failure retryable`);
}

for (const {name: scopeName, scope} of RELAY_SCOPES) {
  for (const {name: caseName, output} of INVALID_CASES) {
    const observedFailure = parseReviewContract(output).failure;
    const state = {};
    const first = recordFailureBudget(state, POLICY, observedFailure, scope);
    assert.equal(first.budget, "adapterRetryBudget", `${scopeName}/${caseName}: budget name`);
    assert.equal(first.used, 1, `${scopeName}/${caseName}: first record used`);
    assert.equal(first.limit, 2, `${scopeName}/${caseName}: budget limit`);
    assert.equal(first.scope, scope, `${scopeName}/${caseName}: scope`);
    assert.equal(first.allowed, true, `${scopeName}/${caseName}: first record allowed`);
    const second = recordFailureBudget(state, POLICY, observedFailure, scope);
    assert.equal(second.used, 2, `${scopeName}/${caseName}: second record used`);
    assert.equal(second.allowed, false, `${scopeName}/${caseName}: budget spent blocks retry`);

    if (scopeName === "plan-reviewer scope") {
      const retryDecision = decidePlanningReview({failure: observedFailure, budget: first, scope});
      assert.equal(retryDecision.action, "retry", `${scopeName}/${caseName}: decidePlanningReview retries with budget`);
      const escalateDecision = decidePlanningReview({failure: observedFailure, budget: second, scope});
      assert.equal(escalateDecision.action, "escalate", `${scopeName}/${caseName}: decidePlanningReview escalates when spent`);
      assert.equal(escalateDecision.code, "PLANNING_REVIEW_BUDGET_EXHAUSTED", `${scopeName}/${caseName}: escalation code`);
    }

    // Honest escalation naming once the scope budget is spent.
    const naming = decideEscalationName({
      failureClass: observedFailure.class,
      retryable: observedFailure.retryable,
      used: second.used,
      limit: second.limit,
      budget: second.budget,
    });
    assert.equal(naming.step, "adapterRetryBudget_exhausted", `${scopeName}/${caseName}: escalation step`);
    assert.equal(naming.detail, "adapterRetryBudget exhausted (2/2)", `${scopeName}/${caseName}: escalation detail`);
  }
}

console.log(`relay retry contract tests passed (${INVALID_CASES.length} invalid paths x ${RELAY_SCOPES.length} relay scopes)`);
