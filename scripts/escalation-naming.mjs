// Escalation naming — the single source for how a disallowed attempt failure is
// named, in both the persisted `s.step` and the die() detail a human reads.
//
// Extracted because those two had already drifted apart: `s.step` read
// "<budget>_exhausted" for a failure whose real reason was that no retry could
// help, while the message said "exhausted" for a different reason again
// (TASK-18 finding 3).
//
// Deliberately pure: no filesystem, child-channel, or network access, and no
// state writes. The caller passes the values `recordFailureBudget()` already
// computed and gets `{step, detail}` back.
//
// Branch order is load-bearing in two places:
//  - `retryable` is tested before any count, mirroring
//    `recordFailureBudget()`'s own `allowed: retryable && used < limit`, where
//    `retryable` is the left operand that short-circuits the count. A `limit:1`
//    budget whose first occurrence is non-retryable has `used === limit === 1`,
//    so a count-first check would call genuine non-retryability "exhausted".
//  - budget ABSENCE is tested before the count, for the same reason one case
//    over: `recordFailureBudget()` returns `{budget: null, used: 0, limit: 0}`
//    for any domain `budgetName()` does not map (planning/policy/orchestrator),
//    which makes `used >= limit` a satisfied `0 >= 0`. Count-first would render
//    that as "null_exhausted" / "null exhausted (0/0)" and leave this branch
//    unreachable.
export function decideEscalationName({failureClass, retryable, used, limit, budget, evidence} = {}) {
  // Required, because the non-retryable branch names it in the detail.
  if (typeof failureClass !== "string" || failureClass === "") {
    throw new Error("Escalation naming requires a failure class.");
  }
  if (retryable === false) {
    // RATE_LIMITED escalates immediately (non-retryable, no budget spent)
    // with its own step and a resume instruction, whether or not evidence
    // is present. Provider/model are named when the evidence carries them
    // (the watchdog-confirmed path); otherwise the fallback wording omits
    // them but keeps the same step and resume instruction.
    if (failureClass === "RATE_LIMITED") {
      let provider = null;
      let model = null;
      if (Array.isArray(evidence)) {
        for (const entry of evidence) {
          if (!entry || typeof entry !== "object") continue;
          if (provider == null && typeof entry.provider === "string" && entry.provider !== "") provider = entry.provider;
          if (model == null && typeof entry.model === "string" && entry.model !== "") model = entry.model;
          if (provider != null && model != null) break;
        }
      }
      const where = [provider, model].filter(Boolean).join("/");
      const detail = where !== ""
        ? `RATE_LIMITED is not retryable (${where}); resume with \`ap run\` after the limit lifts`
        : "RATE_LIMITED is not retryable; resume with `ap run` after the limit lifts";
      return {step: "rate_limited_escalation", detail};
    }
    // The CLI's own credentials are unusable. Same-adapter retry (and any
    // same-adapter fallback) cannot fix it; the operator must log the CLI in
    // again. The adapter/binary and the CLI's own reason travel on the auth
    // observation's evidence.
    if (failureClass === "AUTH_REQUIRED") {
      let adapter = null;
      let reason = null;
      if (Array.isArray(evidence)) {
        for (const entry of evidence) {
          if (!entry || typeof entry !== "object") continue;
          if (adapter == null && typeof entry.adapter === "string" && entry.adapter !== "") adapter = entry.adapter;
          if (reason == null && typeof entry.reason === "string" && entry.reason !== "") reason = entry.reason;
          if (adapter != null && reason != null) break;
        }
      }
      const cli = adapter || "the CLI";
      const why = reason ? ` (${reason})` : "";
      return {step: "auth_required_escalation", detail: `${cli} is logged out${why} — run \`${cli}\` and log in, then \`ap run\``};
    }
    return {step: "non_retryable_failure", detail: `${failureClass} is not retryable`};
  }
  if (budget == null) {
    return {step: "non_retryable_failure", detail: "failure is outside a retry budget"};
  }
  if (failureClass === "PROVIDER_ERROR") {
    const exhausted = Array.isArray(evidence) && evidence.some(e => e && typeof e === "object" && e.fallbacksExhausted === true);
    const left = exhausted ? "no fallback left (all configured/discovered fallbacks tried)" : "no fallback model is available";
    return {step: "provider_error_escalation", detail: `PROVIDER_ERROR: the provider reported an unexpected server error (opencode UnknownError) and ${left} (${used}/${limit} retries used); retry later or configure a fallback`};
  }
  if (used >= limit) {
    return {step: `${budget}_exhausted`, detail: `${budget} exhausted (${used}/${limit})`};
  }
  // retryable + budget remaining is not an escalation at all: every caller
  // reaches here only after `recorded.budget.allowed` was already false, so
  // this combination means a caller bypassed that check.
  throw new Error(`Escalation naming reached a non-escalation input: retryable ${failureClass} with ${used}/${limit} used on ${budget}.`);
}
