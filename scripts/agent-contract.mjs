import {discoverCapabilities, discoverModelCatalog, loadDocumentedCatalog} from "./model-discovery.mjs";
import {ADAPTER_CONTRACT_VERSION, validateCapabilityDeclaration} from "./capability-contract.mjs";

export const ADAPTER_CONTRACT = "autopilot-adapter.v2";
export const RESULT_CONTRACT = "autopilot-relay.result.v3";

export function validateAdapterContract(id, adapter) {
  const errors = [];
  if (!adapter || typeof adapter !== "object") return {ok: false, errors: [`${id}: adapter must be an object.`]};
  if (!adapter.binary) errors.push(`${id}: binary is required.`);
  if (!Array.isArray(adapter.probe) || !adapter.probe.length) errors.push(`${id}: probe must be a non-empty array.`);
  if (!Array.isArray(adapter.write) || !adapter.write.length) errors.push(`${id}: write must be a non-empty array.`);
  if (!Array.isArray(adapter.read_only) || !adapter.read_only.length) errors.push(`${id}: read_only must be a non-empty array.`);
  if (adapter.model_flag != null && typeof adapter.model_flag !== "string") errors.push(`${id}: model_flag must be a string or null.`);
  if (adapter.effort_flag != null && typeof adapter.effort_flag !== "string") errors.push(`${id}: effort_flag must be a string or null.`);
  if (adapter.variant_flag != null && typeof adapter.variant_flag !== "string") errors.push(`${id}: variant_flag must be a string or null.`);
  if (adapter.variant_mode != null && !["model_suffix"].includes(adapter.variant_mode)) errors.push(`${id}: unsupported variant_mode '${adapter.variant_mode}'.`);
  if (adapter.model_discovery != null && typeof adapter.model_discovery !== "string") errors.push(`${id}: model_discovery must be a string.`);
  if (adapter.contract_version === ADAPTER_CONTRACT_VERSION) {
    if (!adapter.driver) errors.push(`${id}: driver is required for adapter contract v${ADAPTER_CONTRACT_VERSION}.`);
    const validation = validateCapabilityDeclaration({capabilities: adapter.declared_capabilities});
    errors.push(...validation.errors.map(error => `${id}: ${error}`));
  } else if (adapter.contract_version != null) {
    errors.push(`${id}: unsupported adapter contract version '${adapter.contract_version}'.`);
  }
  return {ok: errors.length === 0, errors};
}

export async function discoverAgentContract(id, adapter) {
  const validation = validateAdapterContract(id, adapter);
  if (!validation.ok) return {contract: ADAPTER_CONTRACT, adapter: id, valid: false, errors: validation.errors, capabilities: null, access: {method: "cli", requires_api_key: false}, models: {status: "failed", source: "contract", items: []}};
  const capabilities = await discoverCapabilities(adapter);
  try {
    const items = await discoverModelCatalog(adapter);
    if (Array.isArray(items) && items.length) {
      return {contract: ADAPTER_CONTRACT, adapter: id, valid: true, errors: [], capabilities, access: {method: "cli", requires_api_key: false, note: "Uses the installed CLI/provider authentication context."}, models: {status: "reported", source: adapter.model_discovery || "cli", items}};
    }
  } catch (error) {
    return {contract: ADAPTER_CONTRACT, adapter: id, valid: true, errors: [String(error?.message || error)], capabilities, access: {method: "cli", requires_api_key: false}, models: {status: "failed", source: adapter.model_discovery || "cli", items: []}};
  }
  const documented = loadDocumentedCatalog(id);
  if (documented) return {contract: ADAPTER_CONTRACT, adapter: id, valid: true, errors: [], capabilities, access: {method: "cli", requires_api_key: false, note: "Model aliases are documented fallback; account availability is not live-verified."}, models: {status: "aliases", source: documented.source, verified: documented.last_verified, items: documented.models}};
  const liveCapable = Boolean(adapter.model_discovery && adapter.model_discovery !== "manual");
  return {contract: ADAPTER_CONTRACT, adapter: id, valid: true, errors: [], capabilities, access: {method: "cli", requires_api_key: false}, models: {status: liveCapable ? "failed" : "unsupported", source: liveCapable ? (adapter.model_discovery || "cli") : "none", items: []}};
}

export function buildInvocationRecord({role, adapterId, adapter, args, verification, resolvedBinary = null}) {
  return {
    contract: ADAPTER_CONTRACT,
    adapter: adapterId,
    binary: adapter?.binary || null,
    // TASK-42: the binary path that was actually resolved for this launch
    // (e.g. ~/.local/bin/claude vs /usr/local/bin/claude) — the operator's
    // copy must be auditable from the run record. Null when not supplied.
    resolvedBinary: typeof resolvedBinary === "string" && resolvedBinary !== "" ? resolvedBinary : null,
    requested: {model: role?.model || null, reasoning: role?.reasoning || null, variant: role?.variant || null},
    args: Array.isArray(args) ? args.map(String) : [],
    verifiedBeforeLaunch: verification?.ok === true,
    verificationErrors: verification?.errors || []
  };
}

export function buildRuntimeResult({roleName, role, adapterId, adapter, processResult, output, invocation, startedAt, finishedAt, sessionId, touchedFiles, policy, contract, verdict, failure, observations, usage}) {
  return {
    schema: RESULT_CONTRACT,
    resultContract: RESULT_CONTRACT,
    role: roleName,
    cli: adapter?.binary || null,
    adapter: adapterId,
    status: processResult?.status === 0 && !policy?.violation ? "completed" : "failed",
    process: {exitCode: processResult?.status ?? null, signal: processResult?.signal ?? null, error: processResult?.error || null},
    processStatus: processResult?.timedOut ? "timed_out" : processResult?.status === 0 ? "completed" : processResult?.status == null ? "failed_start" : "failed",
    contract: contract || {status: "not_required", error: null},
    verdict: verdict || {status: "not_applicable", decision: null, findings: []},
    failure: failure || null,
    observations: Array.isArray(observations) ? observations : [],
    // An absent measurement (driverless adapter, or an adapter whose
    // observer does not decode a per-turn usage event) is recorded as
    // `null`, never `0` -- see accumulateUsage()'s own docblock in
    // adapter-drivers.mjs. Consumers must treat null as "unmeasured", not
    // "free".
    usage: usage || null,
    sessionId: sessionId || null,
    startedAt,
    finishedAt,
    invocation,
    execution: {
      requested: invocation.requested,
      delivered: invocation.args,
      cliExitCode: processResult?.status ?? null,
      cliAccepted: processResult?.status === 0,
      backendConfirmed: false
    },
    touchedFiles: Array.isArray(touchedFiles) ? touchedFiles : [],
    policy: policy || {violation: null},
    finalMessage: output || ""
  };
}
