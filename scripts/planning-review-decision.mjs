// Planning-review attempt-failure decision — pure contract module.
//
// Decides what a pre-recorded `plan_reviewer` attempt failure means. The
// input is the `{failure, budget, scope}` triple already produced by
// `recordAttemptFailure()` in `scripts/autopilot.mjs` (the non-dying,
// record-only budget function): failure selection, the
// `INTERNAL_CONTRACT_ERROR`/`"orchestrator"` fallback, source-role/adapter
// enrichment, scope calculation, budget recording, and
// `s.lastFailure`/`s.lastFailureBudget` persistence are all the caller's job,
// done once per attempt before this function is ever called. This module only
// decides what `budget.allowed` (and the failure's class/domain) should mean.
//
// Deliberately pure:
// - no filesystem, child-channel, or network access;
// - no state writes — takes values in, returns a decision object out;
// - never calls `enforceAttemptFailure()` (which would end the run itself on
//   budget exhaustion instead of letting the caller decide) and never touches
//   `recordFailureBudget()` directly (which would duplicate and bypass the
//   selection/enrichment/scope/persist authority `recordAttemptFailure()`
//   already owns). There is no `"planning"` budget; this module never derives
//   one.
//
// Returns a decision object — never a boolean — matching the
// `evaluatePlanningGate()` precedent in `scripts/phase-stage-checkpoint.mjs`:
// - `{action: "retry", ...}` — a `retryable:true` adapter/infrastructure
//   failure with budget available: retry the reviewer only.
// - `{action: "escalate", ...}` — `PATH_UNSUPPORTED`/`PERMISSION_DENIED`, a
//   retryable adapter/infrastructure failure with budget exhausted, or an
//   `INTERNAL_CONTRACT_ERROR`/`"orchestrator"` failure. Carries the failure's
//   `class` and `domain` in the result.
// - `{action: "passthrough", ...}` — `PLANNING_REJECTED` or any other
//   non-PASS not classified above, unconditionally, regardless of budget
//   state. The caller runs its unchanged behavior.
//
// Policy violations are not this function's concern at all: the existing
// pre-check at each call site keeps handling them, unchanged. A
// policy-domain failure reaching here therefore falls through to
// `"passthrough"` like any other unclassified outcome.

// Failure classes that always escalate: retrying cannot change the outcome.
const NON_RETRYABLE_ESCALATE_CLASSES = Object.freeze([
  "PATH_UNSUPPORTED",
  "PERMISSION_DENIED",
  // The CLI is logged out: another reviewer attempt on the same adapter
  // cannot succeed any more than another path/permission attempt can.
  "AUTH_REQUIRED",
]);

// Functional class that is never intercepted here: the caller runs its
// unchanged behavior for `PLANNING_REJECTED`, whatever the budget state.
// `STRUCTURED_OUTPUT_MISSING` and `STRUCTURED_OUTPUT_INVALID` are NOT
// passthrough classes — they are retryable adapter failures handled by the
// retry/budget path below.
const PASSTHROUGH_CLASSES = Object.freeze([
  "PLANNING_REJECTED",
]);

// Exported so the Phase 2/3 wiring call sites in `scripts/autopilot.mjs`
// classify against exactly this set (pre-record skip) instead of
// duplicating the list and drifting from it.
export const PLANNING_REVIEW_PASSTHROUGH_CLASSES = PASSTHROUGH_CLASSES;

// Allowlist for `reviewExistingPlanning()`'s adapter/infrastructure retry
// path (TASK-14 Evidence call site 4): only these frameworks route a
// non-PASS existing-planning review through the decision function above.
// Deliberately a POSITIVE allowlist (`framework === "standalone" ||
// framework === "speckit"`), never a negative `framework !== "gsd"` check:
// a negative check would fail open for any malformed or future framework
// value, silently granting it the retry path. An unrecognized value fails
// closed to today's behavior (immediate die, no retry, nothing recorded).
// Pure like the rest of this module: takes a value in, returns a boolean,
// no filesystem/process/network dependency, no budget authority.
export function isPlanningReviewRetryFramework(framework) {
  return framework === "standalone" || framework === "speckit";
}

// Domains whose retryable failures may retry the reviewer while budget lasts.
const RETRYABLE_DOMAINS = Object.freeze(["adapter", "infrastructure"]);

function isRetryableDomain(domain) {
  return RETRYABLE_DOMAINS.includes(domain);
}

function evidenceOf(failure, budget, scope) {
  return {
    class: failure?.class ?? null,
    domain: failure?.domain ?? null,
    retryable: failure?.retryable ?? null,
    budget: budget?.budget ?? null,
    allowed: budget?.allowed ?? null,
    used: budget?.used ?? null,
    limit: budget?.limit ?? null,
    scope: scope ?? budget?.scope ?? null,
  };
}

// Decide what a pre-recorded plan-reviewer attempt failure means.
//
// Signature: `decidePlanningReview({failure, budget, scope} = {})`.
// - `failure`: the classified failure object (`{class, domain, retryable,
//   evidence, ...}`) already selected and enriched by `recordAttemptFailure()`.
// - `budget`: the recorded budget outcome (`{allowed, budget, used, limit,
//   scope}`) from that same call.
// - `scope`: the recorded scope string (also present on `budget.scope`;
//   accepted separately so callers may pass the triple through verbatim).
export function decidePlanningReview({failure, budget, scope} = {}) {
  // Fail closed on a missing or malformed failure: without a classified
  // failure there is nothing to retry and nothing to pass through, so
  // escalate rather than silently choosing either.
  if (!failure || typeof failure !== "object" || typeof failure.class !== "string") {
    return {
      action: "escalate",
      code: "PLANNING_REVIEW_CONTRACT_ERROR",
      reason: "planning-review decision requires a classified failure",
      evidence: {...evidenceOf(failure, budget, scope), observed: failure ?? null},
    };
  }
  const failureClass = failure.class;
  const domain = failure.domain;

  // Contract fallback: nothing classified, so no budget could authorize a
  // retry and no reviewer semantics apply. Always escalate.
  if (failureClass === "INTERNAL_CONTRACT_ERROR" || domain === "orchestrator") {
    return {
      action: "escalate",
      code: "PLANNING_REVIEW_CONTRACT_ERROR",
      reason: `unclassified attempt failure (${failureClass}/${domain}); human intervention required`,
      evidence: evidenceOf(failure, budget, scope),
    };
  }

  // Permanently unsupported paths / denied permissions: retrying cannot
  // change containment reality. Always escalate, whatever the budget state.
  if (NON_RETRYABLE_ESCALATE_CLASSES.includes(failureClass)) {
    return {
      action: "escalate",
      code: "PLANNING_REVIEW_NON_RETRYABLE",
      reason: `${failureClass}/${domain}: failure is outside a retry budget; human intervention required`,
      evidence: evidenceOf(failure, budget, scope),
    };
  }

  // Retryable adapter/infrastructure failure: the only path that may retry.
  // `budget.allowed` is the sole retry authority — no counter is compared
  // against a limit here.
  if (failure.retryable === true && isRetryableDomain(domain)) {
    if (budget?.allowed === true) {
      return {
        action: "retry",
        code: "PLANNING_REVIEW_RETRY",
        reason: `${failureClass}/${domain}: retryable failure with budget available; retry the reviewer`,
        evidence: evidenceOf(failure, budget, scope),
      };
    }
    const detail = budget?.budget
      ? `${budget.budget} exhausted (${budget.used}/${budget.limit})`
      : "failure is outside a retry budget";
    return {
      action: "escalate",
      code: "PLANNING_REVIEW_BUDGET_EXHAUSTED",
      reason: `${failureClass}/${domain}: ${detail}; human intervention required`,
      evidence: evidenceOf(failure, budget, scope),
    };
  }

  // Everything else — `PLANNING_REJECTED` or any other non-PASS not
  // classified above — passes through untouched, unconditionally,
  // regardless of budget state. (`STRUCTURED_OUTPUT_MISSING` and
  // `STRUCTURED_OUTPUT_INVALID` are retryable adapter failures and take
  // the retry/budget path above, not this branch.)
  // (The named passthrough classes are listed explicitly in
  // `PASSTHROUGH_CLASSES` for documentation; the branch itself is the
  // catch-all below so future classes default to today's behavior too.)
  void PASSTHROUGH_CLASSES;
  return {
    action: "passthrough",
    code: "PLANNING_REVIEW_PASSTHROUGH",
    reason: `${failureClass}/${domain}: not an adapter/infrastructure retry decision; caller behavior unchanged`,
    evidence: evidenceOf(failure, budget, scope),
  };
}
