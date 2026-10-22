import {failure} from "./failure-contract.mjs";
import {binaryAdmission, classifyBinary} from "./execution-envelope.mjs";
import {resolveAgentBinary} from "./agent-process.mjs";

export const TRANSPORT_UNAVAILABLE_REASONS = Object.freeze([
  "windows_interop_not_contained",
  "binary_admission_denied",
  "adapter_transport_resolver_invalid",
  "adapter_invocation_unavailable"
]);

// Canonical failure.v1 mapping. Every remaining transport-unavailable reason
// is a stable, non-retryable policy failure: retrying cannot change
// containment reality (Windows interop), binary admission, or resolver misuse.
export function transportUnavailableFailure(reason, evidence = []) {
  return failure("PERMISSION_DENIED", "policy", false, [{source: "trusted_admission", reason}, ...evidence]);
}

// Single shared transport resolver consumed by every spawn path:
// mission execution (autopilot), functional certification (spawnObserved),
// and execution-plane safety (spawnAsync). Callers MUST check
// result.available before creating an envelope or spawning; when available
// is false the returned `failure` is a canonical failure.v1 object ready to
// flow through existing budget/priority logic.
//
// A null/absent driver is a LEGACY MANUAL adapter (e.g. OpenCode, Claude,
// Cursor under the manual workflow): it still goes through binary admission
// and transport-unproven checks, and — once admitted — resolves to its exact
// manifest invocation. A v2 transport driver is only required where the
// adapter's own contract requires one (v2 certification paths), never for
// probing or manual use.
export function resolveAdapterTransport({driver = null, profile = null, request = {}} = {}) {
  if (!request || !request.binary) return unavailable("adapter_transport_resolver_invalid", {});
  // Legacy adapters without a driver still get standard CLI resolution
  // (PATH lookup / Windows shim flattening) before admission classification,
  // exactly as spawnAgentSync would resolve them. antigravity (agy) is a v2
  // driver whose stdin stream-json transport is proven (tasks 1.1/1.3): it
  // clears the same admission gate as codex and is never transport-denied.
  const resolvedBinary = typeof driver?.resolveBinary === "function"
    ? driver.resolveBinary(request.binary)
    : resolveAgentBinary(request.binary);
  const identity = classifyBinary(resolvedBinary);
  const admission = binaryAdmission(identity);
  if (!admission.admitted) {
    return unavailable(admission.reason, {
      binaryPath: identity.resolvedTargetPath || resolvedBinary,
      classification: identity.kind,
      detail: admission.detail
    });
  }
  let invocation;
  try {
    // Legacy/manual passthrough preserves the exact manifest args;
    // agent-process resolution (PATH lookup, Windows shims) stays unchanged
    // because we hand back the same resolved target spawnAgentSync would
    // pick. A v2 transport driver is only engaged when its own contract
    // (mode-driven buildInvocation) applies.
    invocation = driver && typeof driver.buildInvocation === "function" && request.mode != null
      ? driver.buildInvocation({...request})
      : {binary: identity.resolvedTargetPath || request.binary, args: [...(request.args || [])]};
  } catch (error) {
    return unavailable("adapter_invocation_unavailable", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
  return {
    available: true,
    reason: null,
    failure: null,
    identity,
    profile: profile || null,
    // The invocation is the driver's own, byte for byte — including every
    // extra field it declared (agy's per-run settingsPath, the file the
    // launcher redirects HOME to). Dropping a field here would silently break
    // the grant surface behind the gate's back, so the record is forwarded
    // whole and only the args are normalized to strings.
    invocation: {
      ...invocation,
      args: [...(invocation.args || []).map(String)]
    },
    stdin: request.stdin == null ? "" : String(request.stdin)
  };
}

function unavailable(reason, evidence) {
  return {
    available: false,
    reason,
    failure: transportUnavailableFailure(reason, [evidence]),
    identity: null,
    profile: null,
    invocation: null,
    stdin: null
  };
}
