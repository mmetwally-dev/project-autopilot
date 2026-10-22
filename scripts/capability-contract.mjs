import crypto from "node:crypto";

export const CAPABILITY_SCHEMA = "autopilot-capabilities.v3";
export const ADAPTER_CONTRACT_VERSION = 2;

export const FUNCTIONAL_CAPABILITY_IDS = Object.freeze([
  "cli.discovery",
  "selection.model",
  "selection.effort",
  "repository.read",
  "repository.write",
  "commands.execute",
  "commands.timeoutTermination",
  "commands.childTermination",
  "isolation.repositoryReadOnly",
  "isolation.scratchWrite",
  "isolation.outsideScratchDenied",
  "isolation.gitMutationDenied",
  "output.structuredReview",
  "headless.nonInteractive",
  "headless.permissionDenialObservable",
  "paths.windows",
  "paths.wsl",
  "paths.unc",
  "paths.spaces",
  "paths.unicode",
  "browser.server.prestartTrusted",
  "browser.native.supported",
  "browser.native.headless",
  "browser.native.navigate",
  "browser.native.snapshot",
  "browser.native.click",
  "browser.native.requiresPrestartedServer",
  "browser.native.originScopedPermission",
  "browser.playwright.agentDriven",
  "browser.playwright.deterministic"
]);

export const SAFETY_CAPABILITY_IDS = Object.freeze([
  "safety.network.egressDenied",
  "safety.network.defaultDeny",
  "safety.network.providerControlledEgress",
  "safety.network.providerDestinationPolicyEnforced",
  "safety.network.loopbackControlled",
  "safety.filesystem.repositoryBoundary",
  "safety.filesystem.scratchWrite",
  "safety.filesystem.outsideBoundaryDenied",
  "safety.git.readOnlyMutationDenied",
  "safety.process.childContained",
  "safety.process.descendantTimeoutTermination",
  "safety.filesystem.linkEscapeDenied",
  "safety.filesystem.pathTraversalDenied",
  "safety.browser.networkPolicyEnforced",
  "safety.runtime.adapterProcessEnveloped"
]);

export const FILESYSTEM_BOUNDARY_SAFETY_CAPABILITIES = Object.freeze([
  "safety.filesystem.repositoryBoundary",
  "safety.filesystem.scratchWrite",
  "safety.filesystem.outsideBoundaryDenied",
  "safety.filesystem.linkEscapeDenied",
  "safety.filesystem.pathTraversalDenied"
]);

export const TRUSTED_REPOSITORY_IMMUTABILITY_CAPABILITIES = Object.freeze([
  ...FILESYSTEM_BOUNDARY_SAFETY_CAPABILITIES,
  "safety.git.readOnlyMutationDenied"
]);

// Every isolation.* alias that a mission consumer treats as a trust boundary
// (see verifierTask()'s use of isolation.scratchWrite in verifier-brief.mjs)
// has a single named safety.* capability it stands for. Functional's
// declared===certified match on the alias id itself is adapter
// self-declaration corroborated by a certification scenario, not proof that
// the environment enforces anything — this map is the revocation key used by
// missionEffectiveCapabilities() to strike an alias down whenever its named
// equivalent was not itself certified by trusted infrastructure.
export const ISOLATION_TRUSTED_EQUIVALENTS = Object.freeze({
  "isolation.repositoryReadOnly": "safety.filesystem.repositoryBoundary",
  "isolation.scratchWrite": "safety.filesystem.scratchWrite",
  "isolation.outsideScratchDenied": "safety.filesystem.outsideBoundaryDenied",
  "isolation.gitMutationDenied": "safety.git.readOnlyMutationDenied"
});

export const CAPABILITY_IDS = Object.freeze([...FUNCTIONAL_CAPABILITY_IDS, ...SAFETY_CAPABILITY_IDS]);

// Capabilities admissionDecision can re-measure at decision time, independent
// of the adapter's self-declaration and the certification receipt. Every
// other functional id has no live probe: "runtime" for those is only ever
// declared/certified agreement wearing a third name. Keeping this list
// explicit stops that agreement from being sold as three-way corroboration
// it isn't (see runtimeCapabilities() in admission-gate.mjs).
export const RUNTIME_VERIFIED_CAPABILITY_IDS = Object.freeze(["cli.discovery"]);

export const ENUM_CAPABILITIES = Object.freeze({
  "browser.native.permissionScope": ["none", "tool", "origin", "unrestricted"],
  "output.structuredTransport": ["none", "sentinel", "json", "json-schema", "event-stream"]
});

export function canonicalJson(candidate) {
  if (Array.isArray(candidate)) return `[${candidate.map(canonicalJson).join(",")}]`;
  if (!candidate || typeof candidate !== "object") return JSON.stringify(candidate);
  const entries = Object.keys(candidate).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(candidate[key])}`);
  return `{${entries.join(",")}}`;
}

export function sha256(candidate) {
  const bytes = typeof candidate === "string" || ArrayBuffer.isView(candidate) ? candidate : canonicalJson(candidate);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function capabilityValueIsValid(id, value) {
  return (CAPABILITY_IDS.includes(id) && typeof value === "boolean") || ENUM_CAPABILITIES[id]?.includes(value) === true;
}

export function validateCapabilityDeclaration(declaration) {
  const errors = [];
  const declared = declaration?.capabilities || {};
  for (const [id, value] of Object.entries(declared)) {
    if (!capabilityValueIsValid(id, value)) errors.push(`Invalid declared capability '${id}'.`);
    else if (SAFETY_CAPABILITY_IDS.includes(id)) errors.push(`Execution-plane safety capability '${id}' must be certified by trusted Autopilot infrastructure, not declared by an adapter.`);
    else if (id in ISOLATION_TRUSTED_EQUIVALENTS) errors.push(`Trusted isolation capability '${id}' must be certified by trusted Autopilot infrastructure, not declared by an adapter.`);
  }
  return {ok: errors.length === 0, errors};
}

// A requirement token that is not in this contract (or carries an invalid
// value) is a STRUCTURAL condition, not a programming accident: the token
// usually comes from planner-authored task text (`<!-- autopilot-requires: … -->`,
// parsed by the framework adapters into `requiredCapabilities`). Naming the
// error with the offending token lets every caller — relay requirement
// assembly, admission, config validation — fail closed with a classified
// cause. Before this class existed such a token escaped as a bare Error and
// killed a mission with a stack trace and no `state.step` (mission 004's F6).
export class CapabilityRequirementError extends Error {
  constructor(message, {token = null} = {}) {
    super(message);
    this.name = "CapabilityRequirementError";
    this.token = token;
  }
}

export function normalizeRequirement(candidate) {
  if (typeof candidate === "string") {
    const match = candidate.match(/^([^=]+)=(.+)$/);
    if (!match) {
      if (!CAPABILITY_IDS.includes(candidate)) throw new CapabilityRequirementError(`Unknown capability requirement '${candidate}'.`, {token: candidate});
      return candidate;
    }
    const id = match[1];
    const raw = match[2];
    const equals = raw === "true" ? true : raw === "false" ? false : raw;
    if (!capabilityValueIsValid(id, equals)) throw new CapabilityRequirementError(`Invalid capability requirement '${candidate}'.`, {token: candidate});
    return {id, equals};
  }
  if (candidate && typeof candidate === "object" && capabilityValueIsValid(candidate.id, candidate.equals)) {
    return {id: candidate.id, equals: candidate.equals};
  }
  throw new CapabilityRequirementError(`Invalid capability requirement '${JSON.stringify(candidate)}'.`,
    {token: candidate && typeof candidate === "object" ? candidate.id ?? null : null});
}

export function requirementKey(requirement) {
  return typeof requirement === "string" ? requirement : `${requirement.id}=${String(requirement.equals)}`;
}

export function certifiedCapabilityValues(receipt) {
  const values = {};
  for (const [id, proof] of Object.entries(receipt?.capabilities || {})) {
    if (proof?.certified === true) values[id] = proof.value ?? true;
  }
  return values;
}

export function effectiveCapabilities({declared, certified, runtime, safetyDenied = []}) {
  const denied = new Set(safetyDenied.map(item => typeof item === "string" ? item : item.id));
  const effective = {};
  for (const id of [...FUNCTIONAL_CAPABILITY_IDS, ...Object.keys(ENUM_CAPABILITIES)]) {
    if (denied.has(id)) continue;
    const declaredValue = declared?.[id];
    const certifiedValue = certified?.[id];
    if (declaredValue == null || certifiedValue == null || declaredValue !== certifiedValue) continue;
    // Only demand live corroboration where a real probe exists. For every
    // other id, requiring a third opinion would just be requiring declared
    // to equal itself again under a different name.
    if (RUNTIME_VERIFIED_CAPABILITY_IDS.includes(id)) {
      const runtimeValue = runtime?.[id];
      if (runtimeValue == null || runtimeValue !== certifiedValue) continue;
    }
    effective[id] = declaredValue;
  }
  return effective;
}

export function certifiedExecutionSafetyCapabilities(receipt) {
  const values = {};
  for (const id of SAFETY_CAPABILITY_IDS) {
    const proof = receipt?.capabilities?.[id];
    if (proof?.certified === true && proof.value === true) values[id] = true;
  }
  return values;
}

export function missionEffectiveCapabilities({functional = {}, executionSafety = {}, safetyDenied = []}) {
  const denied = new Set(safetyDenied.map(item => typeof item === "string" ? item : item.id));
  const effective = Object.fromEntries(Object.entries({...functional, ...executionSafety}).filter(([id]) => !denied.has(id)));
  if (trustedRepositoryImmutabilityProven(effective, denied)) effective["isolation.repositoryReadOnly"] = true;
  // The additive derivation above can still let an isolation.* alias through
  // on functional's declared===certified match on the alias id ALONE —
  // adapter self-declaration corroborated by a certification scenario, not
  // proof the environment enforces anything (adapters are free to, and do,
  // self-declare these; validateCapabilityDeclaration now forbids it going
  // forward, but existing receipts/config may still carry it). Revoke any
  // such alias whose single named trusted equivalent (ISOLATION_TRUSTED_EQUIVALENTS)
  // was not itself certified true, regardless of how the alias got into
  // `effective`.
  for (const [isolationId, safetyId] of Object.entries(ISOLATION_TRUSTED_EQUIVALENTS)) {
    if (effective[isolationId] === true && executionSafety[safetyId] !== true) delete effective[isolationId];
  }
  return effective;
}

function trustedRepositoryImmutabilityProven(effective, denied) {
  return !denied.has("isolation.repositoryReadOnly")
    && TRUSTED_REPOSITORY_IMMUTABILITY_CAPABILITIES.every(id => effective[id] === true);
}

export function missingCapabilities(required, effective) {
  return required.filter(requirement => {
    if (typeof requirement === "string") return effective?.[requirement] !== true;
    return effective?.[requirement.id] !== requirement.equals;
  });
}
