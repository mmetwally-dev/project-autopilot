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
function formatLocalTime(isoString) {
  try {
    const ms = Date.parse(isoString);
    if (!Number.isFinite(ms)) return String(isoString);
    const d = new globalThis.Date(ms);
    let hours = d.getHours();
    const minutes = String(d.getMinutes()).padStart(2, "0");
    const ampm = hours >= 12 ? "PM" : "AM";
    hours = hours % 12 || 12;
    return `${hours}:${minutes} ${ampm}`;
  } catch {
    return String(isoString);
  }
}

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
      let balanceExhausted = false;
      let retryAt = null;
      if (Array.isArray(evidence)) {
        for (const entry of evidence) {
          if (!entry || typeof entry !== "object") continue;
          if (provider == null && typeof entry.provider === "string" && entry.provider !== "") provider = entry.provider;
          if (model == null && typeof entry.model === "string" && entry.model !== "") model = entry.model;
          // Backlog #15: kept as a literal because this module is deliberately
          // import-free; the value is PROVIDER_BALANCE_REASON in
          // idle-hang-watchdog.mjs.
          if (entry.reason === "provider_balance_exhausted") balanceExhausted = true;
          if (retryAt == null && typeof entry.retryAt === "string" && entry.retryAt !== "") retryAt = entry.retryAt;
        }
      }
      const where = [provider, model].filter(Boolean).join("/");
      // A paid balance never refills by waiting, so the resume instruction
      // must be top-up/switch-model, never "after the limit lifts".
      if (balanceExhausted) {
        const providerName = provider || "provider";
        const named = where !== "" ? ` (${where})` : "";
        return {
          step: "rate_limited_escalation",
          detail: `RATE_LIMITED is not retryable${named} — the provider's paid balance is exhausted; top up the ${providerName} balance, or switch the role to another model (\`ap config\`), then \`ap run\``,
        };
      }
      const resume = retryAt
        ? `resume after ${formatLocalTime(retryAt)}`
        : "resume with `ap run` after the limit lifts";
      const detail = where !== ""
        ? `RATE_LIMITED is not retryable (${where}); ${resume}`
        : `RATE_LIMITED is not retryable; ${resume}`;
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
      // Backlog #12(b): a provider-key rejection in OpenCode is not a generic
      // logout — name the bad/expired key and OpenCode's own re-auth commands.
      if (adapter === "opencode") {
        return {step: "auth_required_escalation", detail: `opencode is not authenticated${why} — the provider key in the OpenCode CLI is invalid or expired; run \`opencode auth logout\` then \`opencode auth login\`, then \`ap run\``};
      }
      if (reason === "provider_key_invalid") {
        return {step: "auth_required_escalation", detail: `the provider key in ${cli} is invalid or expired${why} — re-authenticate the CLI (for OpenCode: \`opencode auth logout\` then \`opencode auth login\`) and then \`ap run\``};
      }
      return {step: "auth_required_escalation", detail: `${cli} is logged out${why} — run \`${cli}\` and log in, then \`ap run\``};
    }
    // Backlog #5: the read-only launch-plan denial. The reason (and the
    // missing runtime file when present) travel on the evidence; name both so
    // the persisted step and the WATCH-REPORT stop line say WHY the mission
    // escalated, not just "non_retryable_failure". The class stem follows
    // the rate_limited_escalation/auth_required_escalation convention.
    if (failureClass === "READ_ONLY_CONTAINMENT_UNAVAILABLE") {
      let reason = null;
      let missingRuntimeFile = null;
      if (Array.isArray(evidence)) {
        for (const entry of evidence) {
          if (!entry || typeof entry !== "object") continue;
          if (reason == null && typeof entry.reason === "string" && entry.reason !== "") reason = entry.reason;
          if (missingRuntimeFile == null && typeof entry.missingRuntimeFile === "string" && entry.missingRuntimeFile !== "") missingRuntimeFile = entry.missingRuntimeFile;
        }
      }
      const why = missingRuntimeFile
        ? `${reason ?? "adapter_runtime_file_missing"}: missing runtime file ${missingRuntimeFile}`
        : (reason ?? "unknown reason");
      return { step: "read_only_containment_unavailable", detail: `READ_ONLY_CONTAINMENT_UNAVAILABLE (${why})` };
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
