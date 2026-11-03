// Read-only launch-plan (envelope) denial — the classified failure and the
// operator-facing text, shared by scripts/autopilot.mjs (the launch-plan
// branch that fails closed before any read-only role is spawned) and by
// scripts/test-envelope-denial-classified.mjs.
//
// Backlog #5: a read-only role whose launch plan is denied used to reach the
// operator as an unclassified stop ("Attempt failed without a classified
// cause" / INTERNAL_CONTRACT_ERROR). The denial is a deterministic adapter
// condition, not an attempt that failed: classify it here, once, so every
// path that records or escalates it names the real cause.
//
// Deliberately a leaf module (failure-contract.mjs + escalation-naming.mjs
// only, no filesystem/state/process access of its own) so it is unit-testable
// without booting the orchestrator.
import path from "node:path";
import { failure } from "./failure-contract.mjs";
import { decideEscalationName } from "./escalation-naming.mjs";

export const READ_ONLY_CONTAINMENT_UNAVAILABLE_CLASS = "READ_ONLY_CONTAINMENT_UNAVAILABLE";

// The classified failure the denial carries. Shape mirrors every other
// relay failure: `{schema, class, domain, retryable, evidence}` — the domain
// is `adapter` (an adapter runtime condition, like CLI_UNAVAILABLE /
// INVOCATION_MISMATCH), never retryable (the condition is deterministic
// until the operator fixes the environment), and the evidence names the
// reason plus the missing runtime file when the launch plan reported one.
export function envelopeDenialFailure({ reason, missingRuntimeFile, role, adapter } = {}) {
  const evidence = [
    {
      source: "launch_plan",
      reason: typeof reason === "string" && reason ? reason : null,
      role: typeof role === "string" && role ? role : null,
      adapter: typeof adapter === "string" && adapter ? adapter : null,
      ...(typeof missingRuntimeFile === "string" && missingRuntimeFile ? { missingRuntimeFile } : {}),
    },
  ];
  return failure(READ_ONLY_CONTAINMENT_UNAVAILABLE_CLASS, "adapter", false, evidence);
}

// "Plain Windows" means the native Windows platform. WSL2 reports
// process.platform === "linux", so an explicit "linux"/"darwin" is never plain
// Windows, and a native Windows host never is WSL. Tests can drive the branch
// decision directly by passing a platform string.
export function isPlainWindows(platform = process.platform) {
  return platform === "win32";
}

// The one-line operator detail appended to the role-prefixed error.
// `adapter_runtime_file_missing` names the missing file and a one-line fix;
// every other envelope reason keeps the containment requirement and never
// claims Windows support the current platform does not have.
export function envelopeDenialDetail({ reason, missingRuntimeFile, platform = process.platform } = {}) {
  if (reason === "adapter_runtime_file_missing") {
    const missing = typeof missingRuntimeFile === "string" && missingRuntimeFile ? missingRuntimeFile : null;
    const fix = missing
      ? `Missing runtime file: ${missing}. Fix: reinstall the agent CLI or put ${path.basename(missing)} next to ${path.dirname(missing)}.`
      : "Missing runtime file (the launch plan did not name it). Fix: reinstall the agent CLI.";
    return `${READ_ONLY_CONTAINMENT_UNAVAILABLE_CLASS}: ${reason}. ${fix}`;
  }
  const windowsSuffix = isPlainWindows(platform)
    ? " Plain Windows without WSL is not currently supported for these roles."
    : "";
  return `${READ_ONLY_CONTAINMENT_UNAVAILABLE_CLASS}: ${reason}. Read-only roles (plan_reviewer, code_reviewer, verifier) require WSL/Linux bubblewrap filesystem containment (repository read-only bind, writable scratch); it is not available in this environment.${windowsSuffix}`;
}

// Persist the denial as a terminal, classified escalation before the caller
// stops the mission — the same contract as the pre-launch fail-closed stop
// for an unrecognised task requirement (this file's twin in autopilot.mjs).
// `persist(state)` is injected by the caller (it owns saveState); when absent
// or throwing the state object is still mutated in place.
export function recordEnvelopeDenial(state, { failure: denial, roleName, adapter, persist } = {}) {
  const naming = decideEscalationName({
    failureClass: denial?.class,
    retryable: denial?.retryable === true,
    used: 0,
    limit: 0,
    budget: "adapterRetryBudget",
    evidence: Array.isArray(denial?.evidence) ? denial.evidence : [],
  });
  state.phase = "escalated";
  state.step = naming.step;
  state.lastFailure = { ...denial, sourceRole: roleName ?? null, adapter: adapter ?? null };
  if (typeof persist === "function") {
    try { persist(state); } catch { /* state.json write failed; the in-memory state still carries it */ }
  }
  return naming;
}
