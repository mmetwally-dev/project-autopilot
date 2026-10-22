// B2: shared agent environment authority.
//
// Three distinct environment views are produced from a single assembler:
//   - spawnEnv:     exactly the production value passed to the outer
//                   bwrap spawn boundary. This is the ONLY environment
//                   the orchestrator is authorized to expand.
//   - bridgeEnv:    spawnEnv plus the resulting bwrap --setenv overlay
//                   map parsed from envelope.args. This models what the
//                   provider bridge sees (when controlled egress is
//                   active) or what the directly launched adapter sees
//                   (when it is inactive).
//   - effectiveEnv: bridgeEnv plus the provider bridge's proxy overlay
//                   when controlled egress is active. This models what
//                   the real adapter process sees.
//
// Production authority MUST NOT be expanded. bridgeEnv and effectiveEnv
// must never reach the outer spawn. spawnEnv and only spawnEnv is what
// the host-side bwrap process inherits.
//
// A pure, side-effect-free environment-authority projection binds every
// relevant input for the receipt fingerprint:
//   - fixed safe ambient variable names;
//   - presence + value digest for each effective safe variable;
//   - canonical PATH-key rule;
//   - digest of ambient PATH before the guard prefix is added;
//   - canonical guard-prefix template (e.g. /workspace/repository/<run-scratch>/git-guard);
//   - stable Git-guard variable names + literal constants;
//   - stable canonical sandbox targets;
//   - canonical templates for run-specific guard paths (adapter-role guard
//     directory, guard log, hooks directory, adapter-role run scratch);
//   - the resulting bwrap --setenv overlay map (last-value-wins);
//   - the fixed provider proxy port + socket path (literal);
//   - conditional provider bridge proxy authority;
//   - no plaintext environment values;
//   - no realized run IDs or per-run host paths.

import crypto from "node:crypto";
import {mapEnvironmentIntoEnvelope} from "./execution-envelope.mjs";

// Fixed literal, not imported: the controlled-egress gateway this port
// belonged to was removed from the supported runtime (see SKILL.md). It is
// kept only as a stable authority literal for the (now always-inactive,
// gatewayActive===false) bridge-overlay projection below.
const PROVIDER_PROXY_PORT = 18080;
import {SAFE_ENV_NAMES} from "./relay-guards.mjs";

export const AGENT_ENVIRONMENT_SCHEMA = "autopilot-agent-environment.v2";
export const AGENT_ENVIRONMENT_AUTHORITY_SCHEMA = "autopilot-agent-environment-authority.v2";

// Canonical authority literals. Any change here is a deliberate
// B2 authority/fingerprint revision.
const PROVIDER_PROXY_URL = `http://127.0.0.1:${PROVIDER_PROXY_PORT}`;
const SANDBOX_SOCKET_PATH = "/autopilot/gateway/provider.sock";

// Canonical templates for run-specific paths that are not stable literals.
// These templates are part of the fingerprint projection, NOT a runtime
// path computation. They are deliberately POSIX-style and contain no run
// id or per-run host path.
const PATH_TEMPLATES = Object.freeze({
  guardDir: "/workspace/repository/<run-scratch>/git-guard",
  guardLog: "/workspace/repository/<run-scratch>/git-guard/blocked.log",
  hooksDir: "/workspace/repository/<run-scratch>/git-guard/hooks",
  adapterRoleScratch: "/workspace/scratch"
});

// Stable Git-guard variable names + literal constants. These names and
// values form the B2 Git-guard authority. Production and certification
// must match exactly.
export const GIT_GUARD_VARIABLES = Object.freeze({
  AUTOPILOT_NO_GIT_MUTATIONS: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT_REPO: "3",
  GIT_CONFIG_COUNT_NO_REPO: "2",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_KEY_1: "safe.directory",
  GIT_CONFIG_KEY_2: "core.autocrlf",
  GIT_CONFIG_AUTOCRLF_VALUE: "input"
});

// ---- Pure positional --setenv parser -------------------------------------
// Reads triples in argv order, rejects an incomplete triple, applies
// last-value-wins semantics for duplicate names, and returns the resulting
// overlay map. Pure and side-effect-free.
export function parseSetenvOverlay(args) {
  if (args == null) throw new Error("setenv parser: args is required");
  if (!Array.isArray(args)) throw new Error("setenv parser: args must be an array");
  const overlay = Object.create(null);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "--setenv") continue;
    if (i + 2 >= args.length) throw new Error("setenv parser: incomplete --setenv triple");
    const name = String(args[i + 1]);
    const value = String(args[i + 2]);
    if (!name) throw new Error("setenv parser: --setenv name must be non-empty");
    overlay[name] = value;
    i += 2;
  }
  return overlay;
}

// ---- Provider bridge overlay ---------------------------------------------
// Models what provider-egress-bridge.mjs adds when controlled egress is
// active. Returns an empty object when controlled egress is inactive, so
// the overlay is the only place that defines the eight-variable bridge
// authority. NO_PROXY/no_proxy use the bridge's current literal value;
// ALL_PROXY/all_proxy are empty.
export function providerBridgeOverlay({gatewayActive}) {
  if (!gatewayActive) return {};
  return {
    HTTP_PROXY: PROVIDER_PROXY_URL,
    HTTPS_PROXY: PROVIDER_PROXY_URL,
    http_proxy: PROVIDER_PROXY_URL,
    https_proxy: PROVIDER_PROXY_URL,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    ALL_PROXY: "",
    all_proxy: ""
  };
}

// ---- Sandbox targets (stable canonical names) ---------------------------
// The B2 projection binds the CANONICAL sandbox target names (not the
// realized values), because realized paths can shift across run layouts
// but the sandbox topology is a stable authority.
function canonicalSandboxTargets() {
  return {
    repository: "/workspace/repository",
    scratch: "/workspace/scratch",
    home: "/workspace/scratch/.autopilot-home",
    adapterBinary: "/autopilot/bin/adapter",
    socketPath: SANDBOX_SOCKET_PATH,
    bridgeScript: "/autopilot/control/provider-egress-bridge.mjs"
  };
}

// ---- Fixed safe-variable names (stable ordering) ------------------------
function safeVariableNames() {
  return [...SAFE_ENV_NAMES].sort();
}

// Build the canonical guard-prefixed PATH value (the value that is
// produced at the moment the guard prepends its shim). The path BEFORE
// the guard prepends its shim is the "ambient PATH" — represented in the
// fingerprint as a digest, not as a literal. The guard-prefixed value is
// represented as the canonical template.
function canonicalPathAuthority() {
  return {
    key: process.platform === "win32" ? "Path" : "PATH",
    guardPrefixTemplate: PATH_TEMPLATES.guardDir
  };
}

// digest a single string. We use sha256 to align with the rest of the
// project; an empty string yields a stable sentinel digest.
function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

// Effective safe-variable projection: name -> value digest (or null if
// absent). Values are NEVER persisted in plaintext.
function projectSafeVariables(effectiveEnv) {
  const out = Object.create(null);
  for (const name of safeVariableNames()) {
    if (Object.hasOwn(effectiveEnv, name)) {
      const value = effectiveEnv[name];
      if (value != null) out[name] = {present: true, digest: digest(value)};
      else out[name] = {present: false, digest: null};
    } else {
      out[name] = {present: false, digest: null};
    }
  }
  return out;
}

// ---- assembleAgentEnvironment --------------------------------------------
//
// Builds spawnEnv, bridgeEnv, and effectiveEnv from a single authority
// source. The result is reproducible: calling assembleAgentEnvironment
// twice with the same arguments returns the same three views.
//
// Required inputs:
//   - guardedEnv: the production guardedEnv() output (the same value
//     that has always been passed to the bwrap spawn).
//   - envelope: the output of buildExecutionEnvelope (used purely for
//     its parsed --setenv overlay; envelope.available is honored so an
//     unavailable envelope contributes no overlay).
//   - repo: the HOST-SIDE repository root path. Required when envelope is
//     available so mapEnvironmentIntoEnvelope can rewrite host paths
//     (AUTOPILOT_GIT_GUARD_LOG, AUTOPILOT_REAL_GIT, GIT_CONFIG_VALUE_0/1/2,
//     PATH guard prefix, etc.) into their sandbox equivalents.
//   - scratchDir: the HOST-SIDE scratch directory path. Required when
//     envelope is available for the same reason.
//   - adapterRoleScratchExists: a TRI-STATE signal:
//       true  => the dedicated adapter-role scratch exists and is
//                mounted writable; effectiveEnv inherits its path.
//       false => no dedicated adapter-role scratch is in scope; effectiveEnv
//                inherits the canonical adapter-role scratch template only.
//   - gatewayActive: a TRI-STATE signal:
//       true  => controlled egress is active; effectiveEnv inherits the
//                eight bridge proxy variables.
//       false => controlled egress is inactive; the eight bridge proxy
//                variables MUST NOT appear in effectiveEnv, even if
//                they exist in the parent ambient environment.
//
// This function is intentionally side-effect-free: it must NOT create run
// dirs, scratch dirs, Git guards, envelopes, gateway instances, or any
// filesystem artifact. Every input is a value or a parsed projection.
export function assembleAgentEnvironment({
  guardedEnv,
  envelope = null,
  repo = null,
  scratchDir = null,
  adapterRoleScratchExists = false,
  gatewayActive = false
} = {}) {
  if (guardedEnv == null || typeof guardedEnv !== "object") {
    throw new Error("assembleAgentEnvironment: guardedEnv is required");
  }
  if (typeof adapterRoleScratchExists !== "boolean") {
    throw new Error("assembleAgentEnvironment: adapterRoleScratchExists must be boolean");
  }
  if (typeof gatewayActive !== "boolean") {
    throw new Error("assembleAgentEnvironment: gatewayActive must be boolean");
  }
  // spawnEnv is EXACTLY the production value: guardedEnv(guard) projected
  // through mapEnvironmentIntoEnvelope(envelope, hostRepo, hostScratch).
  // The host-side repo and scratchDir are the paths that appear in raw
  // guardedEnv values (AUTOPILOT_GIT_GUARD_LOG, GIT_CONFIG_VALUE_0/1/2,
  // PATH guard prefix, etc.) and must be rewritten to sandbox equivalents.
  // The envelope is honored if available; otherwise the bare guardedEnv is
  // returned (this preserves the long-standing production behavior in
  // environments where an envelope is unavailable).
  const spawnEnv = envelope?.available
    ? mapEnvironmentIntoEnvelope(guardedEnv, envelope, repo, scratchDir)
    : {...guardedEnv};
  // bridgeEnv: spawnEnv plus the bwrap --setenv overlay.
  const setenvOverlay = envelope?.available ? parseSetenvOverlay(envelope.args) : {};
  const bridgeEnv = applyOverlay(spawnEnv, setenvOverlay);
  // effectiveEnv: bridgeEnv plus the provider bridge proxy overlay.
  const bridgeOverlay = providerBridgeOverlay({gatewayActive});
  const effectiveEnv = applyOverlay(bridgeEnv, bridgeOverlay);
  // Canonical environment authority projection (pure). This is what the
  // receipt fingerprint binds.
  const authority = projectEnvironmentAuthority({
    spawnEnv,
    bridgeEnv,
    effectiveEnv,
    setenvOverlay,
    bridgeOverlay,
    adapterRoleScratchExists,
    gatewayActive
  });
  return {
    schema: AGENT_ENVIRONMENT_SCHEMA,
    spawnEnv,
    bridgeEnv,
    effectiveEnv,
    authority
  };
}

// Apply a positional overlay (last-value-wins) over a base env. Returns
// a fresh object; the base env is never mutated.
function applyOverlay(base, overlay) {
  const out = {...base};
  for (const [name, value] of Object.entries(overlay)) {
    out[name] = String(value);
  }
  return out;
}

// ---- Environment authority projection (pure) ----------------------------
function projectEnvironmentAuthority({
  spawnEnv,
  bridgeEnv,
  effectiveEnv,
  setenvOverlay,
  bridgeOverlay,
  adapterRoleScratchExists,
  gatewayActive
}) {
  const safeNames = safeVariableNames();
  const safeProjection = projectSafeVariables(effectiveEnv);
  const pathAuthority = canonicalPathAuthority();
  // Ambient PATH digest: the realized guard-prefixed PATH changes per
  // invocation (it contains a new run path), so it would self-invalidate
  // receipts. Instead we digest the AMBIENT PATH entries that are
  // outside the repository and scratch — those are the only entries the
  // host actually injects.
  const ambientPathDigest = digestAmbientPath(spawnEnv[pathAuthority.key] || "");
  // Git-guard variable names + literal authority.
  const gitGuardAuthority = {
    noMutationsName: "AUTOPILOT_NO_GIT_MUTATIONS",
    noMutationsValue: GIT_GUARD_VARIABLES.AUTOPILOT_NO_GIT_MUTATIONS,
    terminalPromptName: "GIT_TERMINAL_PROMPT",
    terminalPromptValue: GIT_GUARD_VARIABLES.GIT_TERMINAL_PROMPT,
    configCountName: "GIT_CONFIG_COUNT",
    configKey0Name: "GIT_CONFIG_KEY_0",
    configKey0Value: GIT_GUARD_VARIABLES.GIT_CONFIG_KEY_0,
    configValue0Name: "GIT_CONFIG_VALUE_0",
    configKey1Name: "GIT_CONFIG_KEY_1",
    configKey1Value: GIT_GUARD_VARIABLES.GIT_CONFIG_KEY_1,
    configValue1Name: "GIT_CONFIG_VALUE_1",
    // 024 2.2: repo-layout slot 2 pins core.autocrlf=input so role git
    // agrees with a Windows CRLF checkout. No-repo layout reuses KEY_1
    // for autocrlf (safe.directory absent); the authority binds the
    // repo-layout slot numbers.
    configKey2Name: "GIT_CONFIG_KEY_2",
    configKey2Value: GIT_GUARD_VARIABLES.GIT_CONFIG_KEY_2,
    configValue2Name: "GIT_CONFIG_VALUE_2",
    configValue2Value: GIT_GUARD_VARIABLES.GIT_CONFIG_AUTOCRLF_VALUE,
    guardLogName: "AUTOPILOT_GIT_GUARD_LOG",
    realGitName: "AUTOPILOT_REAL_GIT"
  };
  // Canonical sandbox targets (stable names, not realized paths).
  const sandbox = canonicalSandboxTargets();
  // Run-specific guard path templates (canonical templates, not realized
  // host paths).
  const runSpecificTemplates = {
    guardDir: PATH_TEMPLATES.guardDir,
    guardLog: PATH_TEMPLATES.guardLog,
    hooksDir: PATH_TEMPLATES.hooksDir,
    adapterRoleScratch: adapterRoleScratchExists
      ? PATH_TEMPLATES.adapterRoleScratch
      : null
  };
  // The bwrap --setenv overlay map (last-value-wins). Sorted for stable
  // JSON serialization; the projection captures the resulting map, NOT
  // the original argv order.
  const sortedOverlay = sortOverlayKeys(setenvOverlay);
  // Provider bridge proxy authority (literal port + socket). These are
  // bound EXACTLY — not templated.
  const providerAuthority = {
    proxyPort: PROVIDER_PROXY_PORT,
    proxyUrl: PROVIDER_PROXY_URL,
    socketPath: SANDBOX_SOCKET_PATH
  };
  const bridgeOverlaySorted = sortOverlayKeys(bridgeOverlay);
  // Child-effective authority: the keys the child can actually observe.
  // We capture the presence + value digest of every relevant child
  // variable, not the values themselves.
  const childEffective = projectChildEffective(effectiveEnv, gatewayActive);
  // Build the canonical projection. The full diagnostic projection is
  // returned for human inspection; the digest binds the material
  // authoritative state so any drift in fixed authority literals,
  // the safe-variable allowlist, safe-variable values, the
  // git-guard policy literals, the sandbox targets, the canonical
  // path templates, the provider authority, or the egress config
  // invalidates the receipt. Ephemeral guard-specific runtime
  // values (e.g. the per-run guard log file path, per-run
  // GIT_CONFIG_VALUE_0/1/2) and the raw ambient PATH are excluded
  // from the digest because they are host- and run-specific: a
  // receipt that included them would self-invalidate every
  // re-validation pass that runs in a different process. The
  // diagnostic projection still records those values for human
  // inspection so a reviewer can see what was actually injected.
  const projection = {
    schema: AGENT_ENVIRONMENT_AUTHORITY_SCHEMA,
    safeVariableNames: safeNames,
    safeVariableProjection: safeProjection,
    pathKey: pathAuthority.key,
    pathGuardPrefixTemplate: pathAuthority.guardPrefixTemplate,
    pathAmbientDigest: ambientPathDigest,
    gitGuardAuthority,
    sandbox,
    runSpecificTemplates,
    setenvOverlay: sortedOverlay,
    providerAuthority,
    gatewayActive,
    bridgeOverlay: bridgeOverlaySorted,
    childEffective
  };
  const digestProjection = {
    schema: AGENT_ENVIRONMENT_AUTHORITY_SCHEMA,
    safeVariableNames: safeNames,
    safeVariableProjection: safeProjection,
    pathKey: pathAuthority.key,
    gitGuardAuthority,
    sandbox,
    runSpecificTemplates,
    providerAuthority,
    gatewayActive
  };
  return {...projection, digest: digest(canonicalProjectionString(digestProjection))};
}

function digestAmbientPath(pathValue) {
  // Ambient PATH outside repository/scratch stays host-specific absolute;
  // we digest the raw value because receipts are documented as
  // environment/machine-specific (consistent with hostname being a
  // fingerprint input). We do NOT template the guard-prefixed value.
  return digest(String(pathValue || ""));
}

function sortOverlayKeys(overlay) {
  return Object.fromEntries(Object.entries(overlay || {}).sort(([a], [b]) => a.localeCompare(b)));
}

// project the child-effective authority. We capture only the keys the
// spec names, plus their value digests. No plaintext values are
// persisted. The child-effective projection is what the receipt
// fingerprint binds to detect environment drift.
function projectChildEffective(effectiveEnv, gatewayActive) {
  const keys = [
    "HOME",
    "PWD",
    "TMPDIR",
    "AUTOPILOT_GIT_GUARD_LOG",
    "AUTOPILOT_REAL_GIT",
    "AUTOPILOT_NO_GIT_MUTATIONS",
    "GIT_TERMINAL_PROMPT",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "GIT_CONFIG_KEY_1",
    "GIT_CONFIG_VALUE_1",
    "GIT_CONFIG_KEY_2",
    "GIT_CONFIG_VALUE_2",
    "AUTOPILOT_PROVIDER_GATEWAY_SOCKET",
    "AUTOPILOT_PROVIDER_PROXY_PORT"
  ];
  if (gatewayActive) {
    keys.push(
      "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
      "NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy"
    );
  }
  const projection = Object.create(null);
  for (const key of keys) {
    if (Object.hasOwn(effectiveEnv, key)) {
      const value = effectiveEnv[key];
      if (value != null) projection[key] = {present: true, digest: digest(value)};
      else projection[key] = {present: false, digest: null};
    } else {
      projection[key] = {present: false, digest: null};
    }
  }
  return projection;
}

// Canonical JSON for the projection. Stable across runtimes; the
// projection is the input to the digest, and the digest is what the
// receipt binds.
function canonicalProjectionString(projection) {
  return JSON.stringify(projection, replacer);
}

function replacer(key, value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = value[k];
    return out;
  }
  return value;
}

// ---- Fixed gateway authority assertion ----------------------------------
// Returns null on success, or a string describing the violation. Callers
// that wire this into the orchestrator can fail closed on any non-null
// return.
export function assertFixedGatewayAuthority() {
  if (PROVIDER_PROXY_PORT !== 18080) {
    return `PROVIDER_PROXY_PORT must remain 18080 (got ${PROVIDER_PROXY_PORT}).`;
  }
  if (SANDBOX_SOCKET_PATH !== "/autopilot/gateway/provider.sock") {
    return `SANDBOX_SOCKET_PATH must remain /autopilot/gateway/provider.sock (got ${SANDBOX_SOCKET_PATH}).`;
  }
  if (PROVIDER_PROXY_URL !== "http://127.0.0.1:18080") {
    return `PROVIDER_PROXY_URL must remain http://127.0.0.1:18080 (got ${PROVIDER_PROXY_URL}).`;
  }
  return null;
}

// ---- Side-effect-free environment-authority digest for the receipt ------
// certificationContext() must NOT create run/scratch dirs, Git guards,
// envelopes, gateway instances, or any filesystem artifact. The digest
// it returns is derived from the provided environment views and the fixed
// authority literals; it binds the projection schema, the fixed gateway
// literals, the safe-variable set, the Git-guard variable names + literal
// constants, the canonical sandbox targets, the canonical run-specific
// guard path templates, and the no-args / no-active-bridge view of
// the bwrap overlay (an empty map). This is sufficient to detect any
// drift in those inputs while still being pure.
//
// When effectiveEnv is provided (the real post-mapping environment),
// the digest binds the actual safe-variable presence and value digests,
// so environment drift invalidates the receipt. When omitted, the digest
// binds only the fixed authority literals (no environment data).
export function projectEnvironmentAuthorityDigest({config = {}, effectiveEnv = null} = {}) {
  const gatewayActive = isProviderEgressActiveConfig(config);
  const projection = projectEnvironmentAuthority({
    spawnEnv: {},
    bridgeEnv: {},
    effectiveEnv: effectiveEnv || {},
    setenvOverlay: {},
    bridgeOverlay: providerBridgeOverlay({gatewayActive}),
    adapterRoleScratchExists: true,
    gatewayActive
  });
  return projection.digest;
}

function isProviderEgressActiveConfig(config) {
  if (config?.gates?.network_isolation === false) return false;
  return (config?.capabilities?.execution_plane_safety?.network?.external_egress || "provider-controlled") === "provider-controlled";
}
