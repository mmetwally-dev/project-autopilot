import {resolveAdapterTransport} from "./adapter-transport.mjs";
import {buildExecutionEnvelope, resolvePlaywrightRuntimeInput} from "./execution-envelope.mjs";

export const ADAPTER_LAUNCH_PLAN_SCHEMA = "autopilot-adapter-launch-plan.v1";

// Single semantic launch assembly shared by certification probes and
// production mission roles. Both paths MUST construct their launch through
// this function so executable selection, adapter invocation, provider/model/
// reasoning arguments, trusted-envelope arguments, guarded environment/path
// mapping inputs, runtime files, permissions, and provider-gateway wiring
// cannot drift apart. Callers keep role-specific steps (invocation
// verification hooks, brief writing, gateway lifecycle/failure semantics).
//
// adapterProviderProfile is the RESOLVED provider-egress profile for the
// selected model (e.g. from certificationContext/admission providerEgress),
// not the manifest default — using the unresolved default here is what made
// missions and certifications diverge historically.
// playwrightRuntime is an OPTIONAL, explicit discoverPlaywrightRuntime()-
// shaped input (Task 15.4C3A). It is never rediscovered here — only
// validated (via resolvePlaywrightRuntimeInput, read-only) and, once proven
// safe, forwarded to buildExecutionEnvelope() as two plain absolute paths.
// A null/not-ready runtime is not an error: Playwright mounting is entirely
// optional and every existing caller that omits this argument gets
// byte-for-byte the pre-existing envelope. A ready-but-invalid runtime fails
// the WHOLE launch plan closed (stage "playwright_runtime") before any
// envelope is even attempted — it never silently proceeds with one mount
// missing.
export function assembleAdapterLaunchPlan({
  driver,
  adapterProviderProfile,
  launchRequest,
  config,
  repo,
  scratchDir,
  readOnly,
  permissionFiles = [],
  runtimeFiles = [],
  providerEgressPolicy = null,
  controlledEgress = null,
  playwrightRuntime = null,
  sharedCacheMount = null,
  sharedCacheCompanionMount = null,
  extraEnv = {},
  sessionStoreMounts = []
}) {
  const transport = resolveAdapterTransport({driver, profile: adapterProviderProfile, request: launchRequest});
  if (!transport?.available) {
    return {available: false, schema: ADAPTER_LAUNCH_PLAN_SCHEMA, stage: "transport", reason: transport?.reason || "transport_unavailable", transport, envelope: null};
  }
  const playwrightResolution = resolvePlaywrightRuntimeInput(playwrightRuntime);
  if (!playwrightResolution.ok) {
    return {available: false, schema: ADAPTER_LAUNCH_PLAN_SCHEMA, stage: "playwright_runtime", reason: playwrightResolution.reason, detail: playwrightResolution.detail, transport, envelope: null};
  }
  const envelope = buildExecutionEnvelope({
    repo,
    scratchDir,
    readOnly,
    config,
    binary: transport.invocation.binary,
    args: transport.invocation.args,
    permissionFiles,
    runtimeFiles,
    controlledEgress,
    providerEgressPolicy,
    playwrightModuleDir: playwrightResolution.moduleDir,
    playwrightBrowserRoot: playwrightResolution.browserRoot,
    sharedCacheMount,
    sharedCacheCompanionMount,
    extraEnv,
    sessionStoreMounts
  });
  if (!envelope.available) {
    return {available: false, schema: ADAPTER_LAUNCH_PLAN_SCHEMA, stage: "envelope", reason: envelope.reason, transport, envelope};
  }
  return {
    available: true,
    schema: ADAPTER_LAUNCH_PLAN_SCHEMA,
    stage: null,
    reason: null,
    transport,
    invocation: transport.invocation,
    stdin: transport.stdin,
    envelope
  };
}
