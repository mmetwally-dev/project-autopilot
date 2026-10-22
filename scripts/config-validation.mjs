import {discoverCapabilities, loadDocumentedCatalog} from "./model-discovery.mjs";
import {validateAdapterContract, discoverAgentContract} from "./agent-contract.mjs";
import {buildRoleRequirements} from "./role-requirements.mjs";
import {CAPABILITY_IDS, ENUM_CAPABILITIES} from "./capability-contract.mjs";
import {RUNTIME_MODE_IDS} from "./runtime-mode-capabilities.mjs";
import {
  RELAY_TIMEOUT_DEFAULT_MS,
  PER_TASK_TIMEOUT_DEFAULT_MS,
  HANDOFF_MIN_CHARS,
  HANDOFF_NOTE_MIN_CHARS,
  HANDOFF_WRAPUP_TOKENS_DEFAULT,
  PER_TASK_MAX_TOKENS_DEFAULT,
  PER_ROLE_CAPS_DEFAULT,
  PER_TASK_MAX_TURNS_DEFAULT,
  CONTINUATION_ALLOWANCE_DEFAULT,
  TASK_SIZE_TARGET_TURNS_DEFAULT,
  NO_PROGRESS_GENERATIONS_DEFAULT,
  FINAL_REVIEW_FIX_ROUNDS_DEFAULT,
  IDLE_HANG_MS_DEFAULT,
  FIRST_OUTPUT_MS_DEFAULT,
  MAX_SILENCE_MS_DEFAULT,
  BACKSTOP_RAW_TOKENS_DEFAULT,
  FREE_MODEL_TURNS_CAP_DEFAULT,
} from "./per-task-budget.mjs";
import {FALLBACK_RETRY_PRIMARY_MINUTES} from "./role-fallback.mjs";
import {DEFAULTS, ROLE_NAMES, REVIEW_ROLES, CONFIG_SCHEMA_VERSION} from "./config-layout.mjs";
// The allowed values for enumerated settings come from the schema generator,
// which is also the source of the shipped config.schema.json — one list, so
// validation can never accept a value the schema forbids (or vice versa).
import {ENUMS as SCHEMA_ENUMS} from "./gen-config-schema.mjs";

export async function validateRoleSelection({roleName, role, adapter, agents, now = new Date().toISOString()}) {
  const errors = [];
  const warnings = [];
  // Backlog #1(a): structured list of configured models that the live catalog
  // no longer reports. Callers (setup) use it to offer an in-place re-pick or
  // drop instead of aborting the whole flow on a single vanished model.
  const missingModels = [];
  if (!role || typeof role !== "object") return {valid: false, errors: [`${roleName}: missing role configuration.`], warnings: [], missingModels};
  if (!role.adapter || !adapter) errors.push(`${roleName}: adapter is missing.`);
  if (adapter) {
    const contract = validateAdapterContract(role.adapter, adapter);
    if (!contract.ok) errors.push(...contract.errors);
    const capabilities = await discoverCapabilities(adapter);
    if (role.model && !capabilities.model) errors.push(`${roleName}: ${adapter.binary} does not advertise model selection.`);
    if (role.reasoning && !capabilities.effort) errors.push(`${roleName}: ${adapter.binary} does not advertise effort/reasoning selection.`);
    if (role.variant && !capabilities.variant && adapter.variant_mode !== "model_suffix") errors.push(`${roleName}: ${adapter.binary} does not advertise a variant capability.`);
    if (role.resume && !capabilities.resume) warnings.push(`${roleName}: ${adapter.binary} does not advertise exact-session resume support; retries will always start a fresh session instead of resuming.`);
    if (role.model) await validateModelSelection({roleName, role, adapter, errors, warnings, missingModels, target: {kind: "primary"}});
    // Per-role fallback models (mission 087): each fallback entry's
    // adapter/model/reasoning/variant is checked against that entry's
    // adapter capabilities, mirroring the primary checks above. The
    // fallback adapter is resolved from `agents` (it may differ from the
    // primary adapter); live model verification reuses
    // validateModelSelection with the fallback-scoped label.
    if (role.fallbacks !== undefined) {
      if (!Array.isArray(role.fallbacks)) {
        errors.push(`${roleName}.fallbacks: must be an array of {adapter, model, reasoning, variant} entries.`);
      } else {
        for (let i = 0; i < role.fallbacks.length; i++) {
          const fb = role.fallbacks[i];
          const label = `${roleName}.fallbacks[${i}]`;
          if (!fb || typeof fb !== "object" || Array.isArray(fb)) {
            errors.push(`${label}: must be an object with adapter, model, reasoning, variant.`);
            continue;
          }
          const fbAdapter = agents?.[fb.adapter];
          if (!fb.adapter || !fbAdapter) {
            errors.push(`${label}: adapter is missing or unknown ('${fb.adapter}').`);
            continue;
          }
          const fbContract = validateAdapterContract(fb.adapter, fbAdapter);
          if (!fbContract.ok) errors.push(...fbContract.errors.map(e => `${label}: ${e}`));
          const fbCapabilities = await discoverCapabilities(fbAdapter);
          if (fb.model && !fbCapabilities.model) errors.push(`${label}: ${fbAdapter.binary} does not advertise model selection.`);
          if (fb.reasoning && !fbCapabilities.effort) errors.push(`${label}: ${fbAdapter.binary} does not advertise effort/reasoning selection.`);
          if (fb.variant && !fbCapabilities.variant && fbAdapter.variant_mode !== "model_suffix") errors.push(`${label}: ${fbAdapter.binary} does not advertise a variant capability.`);
          if (fb.model) await validateModelSelection({roleName: label, role: fb, adapter: fbAdapter, errors, warnings, missingModels, target: {kind: "fallback", index: i}});
        }
      }
    }
    // Pending #22: optional stronger model for one fix round (planner and
    // implementer only). Absent = feature off; validated like a fallback entry.
    if (role.escalation_model !== undefined) {
      const label = `${roleName}.escalation_model`;
      const em = role.escalation_model;
      if (roleName !== "planner" && roleName !== "implementer") {
        errors.push(`${label}: only the planner and implementer roles may set escalation_model.`);
      } else if (!em || typeof em !== "object" || Array.isArray(em)) {
        errors.push(`${label}: must be an object with adapter, model, reasoning, variant.`);
      } else if (typeof em.model !== "string" || !em.model) {
        errors.push(`${label}: model is required.`);
      } else {
        const emAdapter = agents?.[em.adapter];
        if (!em.adapter || !emAdapter) {
          errors.push(`${label}: adapter is missing or unknown ('${em.adapter}').`);
        } else {
          const emContract = validateAdapterContract(em.adapter, emAdapter);
          if (!emContract.ok) errors.push(...emContract.errors.map(e => `${label}: ${e}`));
          const emCapabilities = await discoverCapabilities(emAdapter);
          if (!emCapabilities.model) errors.push(`${label}: ${emAdapter.binary} does not advertise model selection.`);
          if (em.reasoning && !emCapabilities.effort) errors.push(`${label}: ${emAdapter.binary} does not advertise effort/reasoning selection.`);
          if (em.variant && !emCapabilities.variant && emAdapter.variant_mode !== "model_suffix") errors.push(`${label}: ${emAdapter.binary} does not advertise a variant capability.`);
          await validateModelSelection({roleName: label, role: em, adapter: emAdapter, errors, warnings, missingModels, target: {kind: "escalation"}});
        }
      }
    }
  }
  return {valid: errors.length === 0, errors, warnings, verifiedAt: now, missingModels};
}

async function validateModelSelection({roleName, role, adapter, errors, warnings, missingModels = null, target = null}) {
  const discovery = await discoverAgentContract(role.adapter, adapter);
  const catalog = discovery.models.status === "reported" ? discovery.models.items : [];
  if (discovery.models.status === "reported") {
    const match = catalog.find(model => model.id === role.model || Object.values(model.effortModelIds || {}).includes(role.model));
    if (!match) {
      errors.push(`${roleName}: model '${role.model}' is not in the live model list returned by ${adapter.binary}.`);
      if (missingModels) missingModels.push({model: role.model, adapter: role.adapter, ...(target || {})});
    }
    else if (role.reasoning) {
      // Some adapters (e.g. OpenCode) expose model-specific effort levels only
      // via `variants`, never `reasoning` (model-discovery.mjs hardcodes
      // reasoning:[] for those catalogs) — fall back to variants as the live
      // source before concluding the catalog has no model-specific data.
      const modelSpecificLevels = match.reasoning?.length ? match.reasoning : (match.variants?.length ? match.variants : null);
      if (modelSpecificLevels) {
        if (!modelSpecificLevels.includes(role.reasoning)) errors.push(`${roleName}: reasoning '${role.reasoning}' is not supported by model '${role.model}'.`);
      } else {
        warnings.push(`${roleName}: live catalog did not expose model-specific reasoning levels; keeping '${role.reasoning}' as CLI-validated but model-unverified.`);
      }
    }
    if (match && role.variant && match.variants?.length && !match.variants.includes(role.variant)) errors.push(`${roleName}: variant '${role.variant}' is not supported by model '${role.model}'.`);
    return;
  }
  const documented = discovery.models.status === "aliases"
    ? {source: discovery.models.source, last_verified: discovery.models.verified, models: discovery.models.items}
    : loadDocumentedCatalog(role.adapter);
  if (documented) {
    const match = documented.models.find(model => model.id === role.model);
    if (!match) warnings.push(`${roleName}: model '${role.model}' could not be live-verified and is outside the documented catalog.`);
    else {
      warnings.push(`${roleName}: model '${role.model}' is from a documented non-live catalog; account/subscription availability was not verified.`);
      if (role.reasoning && match.reasoning?.length && !match.reasoning.includes(role.reasoning)) errors.push(`${roleName}: reasoning '${role.reasoning}' is not documented for model '${role.model}'.`);
    }
  } else {
    warnings.push(`${roleName}: model '${role.model}' cannot be live-verified by ${adapter.binary}; manual selection is unverified.`);
  }
}

// TASK-19 Phase 5 task 14: the FIRST validated policy.* fields. Until this
// branch, `policy.*` (including relay_timeout_ms) was unvalidated/optional.
// Both per-task limits are optional; when present they must be positive
// integers, and per_task_timeout_ms must be strictly below relay_timeout_ms
// (when that is also set) or the intentional per-task deadline could never
// fire — a configuration that silently disables the budget. The rejection
// message names both values and the fix.
export function validatePolicyConfig(policy = {}) {
  const errors = [];
  if (policy && typeof policy === "object" && !Array.isArray(policy)) {
    // The effective relay timeout is the explicit policy value when present,
    // otherwise the same 200-minute runtime default `autopilot.mjs` uses — so an
    // absent relay_timeout_ms does NOT disable this invariant. The comparison
    // is against what the deadline would actually race, not only against an
    // explicitly written field.
    const explicitRelay = Number.isInteger(policy.relay_timeout_ms) && policy.relay_timeout_ms > 0;
    const effectiveRelay = explicitRelay ? policy.relay_timeout_ms : RELAY_TIMEOUT_DEFAULT_MS;
    const perTask = policy.per_task_timeout_ms;
    if (perTask != null) {
      if (!Number.isInteger(perTask) || perTask <= 0) {
        errors.push("policy.per_task_timeout_ms must be a positive integer of milliseconds.");
      } else if (perTask >= effectiveRelay) {
        const relayLabel = explicitRelay ? `policy.relay_timeout_ms (${effectiveRelay})` : `the default relay timeout (${effectiveRelay})`;
        errors.push(`policy.per_task_timeout_ms (${perTask}) must be strictly below ${relayLabel}; otherwise the per-task deadline can never fire. Lower policy.per_task_timeout_ms to match.`);
      }
    }
    const maxTurns = policy.per_task_max_turns;
    if (maxTurns != null && (!Number.isInteger(maxTurns) || maxTurns <= 0)) {
      errors.push("policy.per_task_max_turns must be a positive integer.");
    }
    const sizeTarget = policy.task_size_target_turns;
    if (sizeTarget != null && (!Number.isInteger(sizeTarget) || sizeTarget <= 0)) {
      errors.push("policy.task_size_target_turns must be a positive integer.");
    }
    const freeTurns = policy.free_model_turns_cap;
    if (freeTurns != null && (!Number.isInteger(freeTurns) || freeTurns < 0)) {
      errors.push("policy.free_model_turns_cap must be a non-negative integer (0 or null disables).");
    }
    // Backlog #41 (TASK-35): idle-hang watchdog. Absent means the code
    // default (10 min), never "no watchdog". An explicit 0 is the only off
    // switch. A positive value must be strictly below the EFFECTIVE
    // per-task deadline (the explicit per_task_timeout_ms when valid,
    // otherwise the same derived default resolvePerTaskLimits() uses), or
    // the deadline would always fire first and the watchdog could never
    // trip — a configuration that silently disables the feature.
    const idleHang = policy.idle_hang_ms;
    if (idleHang != null) {
      if (!Number.isInteger(idleHang) || idleHang < 0) {
        errors.push("policy.idle_hang_ms must be a non-negative integer of milliseconds (0 disables the idle-hang watchdog).");
      } else if (idleHang > 0) {
        const explicitPerTask = Number.isInteger(perTask) && perTask > 0;
        const effectivePerTask = explicitPerTask ? perTask : Math.min(PER_TASK_TIMEOUT_DEFAULT_MS, effectiveRelay - 1);
        if (idleHang >= effectivePerTask) {
          const perTaskLabel = explicitPerTask ? `policy.per_task_timeout_ms (${effectivePerTask})` : `the effective per-task deadline (${effectivePerTask})`;
          errors.push(`policy.idle_hang_ms (${idleHang}) must be strictly below ${perTaskLabel}; otherwise the per-task deadline always fires first and the watchdog can never trip. Lower policy.idle_hang_ms (or 0 to disable it).`);
        }
      }
    }
    // First-output deadline (silent-hang fallback): optional; 0 disables.
    const firstOutput = policy.first_output_ms;
    if (firstOutput != null && (!Number.isInteger(firstOutput) || firstOutput < 0)) {
      errors.push("policy.first_output_ms must be a non-negative integer of milliseconds (0 disables the first-output deadline).");
    }
    const maxSilence = policy.max_silence_ms;
    if (maxSilence != null && (!Number.isInteger(maxSilence) || maxSilence < 0)) {
      errors.push("policy.max_silence_ms must be a non-negative integer of milliseconds (0 disables the absolute silence cap).");
    }
    // Backlog 003#15: per-turn context-size ceiling on the per-turn term
    // (maxSingleTurnContext). Absent means the PER_TASK_MAX_TOKENS_DEFAULT code default, never "no ceiling".
    const maxTokens = policy.per_task_max_tokens;
    if (maxTokens != null && (!Number.isInteger(maxTokens) || maxTokens <= 0)) {
      errors.push("policy.per_task_max_tokens must be a positive integer of tokens.");
    }
    // Backlog 003#17: continuation allowance per task, independent of every
    // failure budget. Absent means the default of 3, never zero.
    const contAllowance = policy.continuation_allowance;
    if (contAllowance != null && (!Number.isInteger(contAllowance) || contAllowance <= 0)) {
      errors.push("policy.continuation_allowance must be a positive integer.");
    }
    // Backlog #22: single per-entry rollover-handoff limit. Absent means the
    // code default; when present it must leave room for the digest's
    // protected sections (floor HANDOFF_MIN_CHARS).
    const handoffMax = policy.handoff_max_chars;
    if (handoffMax != null && (!Number.isInteger(handoffMax) || handoffMax < HANDOFF_MIN_CHARS)) {
      errors.push(`policy.handoff_max_chars must be a positive integer >= ${HANDOFF_MIN_CHARS}.`);
    }
    // Backlog #26 Step A: hand-off note limit. Absent means the code
    // default; when present it must fit the four note sections (floor
    // HANDOFF_NOTE_MIN_CHARS).
    const handoffNoteMax = policy.handoff_note_max_chars;
    if (handoffNoteMax != null && (!Number.isInteger(handoffNoteMax) || handoffNoteMax < HANDOFF_NOTE_MIN_CHARS)) {
      errors.push(`policy.handoff_note_max_chars must be a positive integer >= ${HANDOFF_NOTE_MIN_CHARS}.`);
    }
    // Backlog #26 Step B: fixed wrap-up token threshold. Absent means the
    // HANDOFF_WRAPUP_TOKENS_DEFAULT code default; when present it must be a positive integer strictly
    // below the effective token ceiling, or the wrap-up could never fire
    // before the cap.
    const wrapupTokens = policy.handoff_wrapup_tokens;
    if (wrapupTokens != null) {
      const maxTokens = policy.per_task_max_tokens;
      const ceiling = Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : PER_TASK_MAX_TOKENS_DEFAULT;
      if (!Number.isInteger(wrapupTokens) || wrapupTokens <= 0) {
        errors.push("policy.handoff_wrapup_tokens must be a positive integer of tokens.");
      } else if (wrapupTokens >= ceiling) {
        errors.push(`policy.handoff_wrapup_tokens (${wrapupTokens}) must be strictly below policy.per_task_max_tokens (${ceiling}); otherwise the forced hand-off note can never fire before the cap.`);
      }
    }
    // Mission 031 Phase 1 task 1.4: validate policy.caps per-role entries.
    // Review roles: planner, plan_reviewer, code_reviewer, verifier.
    // Each entry requires positive integer max_turns, max_tokens, extra_sessions;
    // max_tokens < effective token ceiling; extra_sessions >= 0;
    // wrap_up_tokens_threshold optional, if present must be < max_tokens for review roles.
    const caps = policy.caps;
    if (caps !== undefined) {
      if (caps === null || typeof caps !== "object" || Array.isArray(caps)) {
        errors.push("policy.caps must be an object mapping role names to cap objects.");
      } else {
        const reviewRoles = ["planner", "plan_reviewer", "code_reviewer", "verifier"];
        const globalMaxTokens = policy.per_task_max_tokens;
        const globalCeiling = Number.isInteger(globalMaxTokens) && globalMaxTokens > 0
          ? globalMaxTokens
          : PER_TASK_MAX_TOKENS_DEFAULT;
        for (const [roleName, roleCaps] of Object.entries(caps)) {
          if (!reviewRoles.includes(roleName)) {
            errors.push(`policy.caps.${roleName}: unknown role (valid review roles: ${reviewRoles.join(", ")}).`);
            continue;
          }
          if (!roleCaps || typeof roleCaps !== "object" || Array.isArray(roleCaps)) {
            errors.push(`policy.caps.${roleName}: must be an object with max_turns, max_tokens, extra_sessions.`);
            continue;
          }
          const maxTurns = roleCaps.max_turns;
          if (maxTurns == null || !Number.isInteger(maxTurns) || maxTurns <= 0) {
            errors.push(`policy.caps.${roleName}.max_turns must be a positive integer.`);
          }
          const maxTokens = roleCaps.max_tokens;
          if (maxTokens == null || !Number.isInteger(maxTokens) || maxTokens <= 0) {
            errors.push(`policy.caps.${roleName}.max_tokens must be a positive integer.`);
          } else if (maxTokens >= globalCeiling && roleName !== "planner") {
            // Mission 039 task 1.4: planner is exempt from the sub-ceiling
            // check. Its code default (200K per-turn) intentionally exceeds the
            // ~180K implementer-oriented global default, and the relay enforces
            // planner caps via resolvePerRoleLimits, so the planner cap fires
            // at its own max regardless of the global ceiling.
            errors.push(`policy.caps.${roleName}.max_tokens (${maxTokens}) must be strictly below the effective token ceiling (${globalCeiling}); otherwise the cap can never fire.`);
          }
          const extraSessions = roleCaps.extra_sessions;
          if (extraSessions == null || !Number.isInteger(extraSessions) || extraSessions < 0) {
            errors.push(`policy.caps.${roleName}.extra_sessions must be a non-negative integer.`);
          }
          const wrapUpThreshold = roleCaps.wrap_up_tokens_threshold;
          if (wrapUpThreshold != null) {
            if (!Number.isInteger(wrapUpThreshold) || wrapUpThreshold <= 0) {
              errors.push(`policy.caps.${roleName}.wrap_up_tokens_threshold must be a positive integer.`);
            } else if (maxTokens != null && Number.isInteger(maxTokens) && maxTokens > 0 && wrapUpThreshold >= maxTokens) {
              errors.push(`policy.caps.${roleName}.wrap_up_tokens_threshold (${wrapUpThreshold}) must be strictly below max_tokens (${maxTokens}); otherwise the wrap-up can never fire before the cap.`);
            }
          }
          // Mission 047 Phase 2 task 2.1: per-role cumulative raw-token
          // backstop override. Absent means the policy-level (or code
          // default 6M) value; when present it must be a positive integer.
          // Unlike max_tokens it is a cumulative total, so no ceiling
          // comparison applies — multi-million values (incl. the 6M
          // default) are the normal case, never cumulative-era leftovers.
          const roleBackstop = roleCaps.backstop_raw_tokens;
          if (roleBackstop != null && (!Number.isInteger(roleBackstop) || roleBackstop <= 0)) {
            errors.push(`policy.caps.${roleName}.backstop_raw_tokens must be a positive integer of tokens.`);
          }
        }
      }
    }
    // Backlog #32: consecutive no-edit generations before a task stops.
    // Absent means the code default (2); when present, a positive integer.
    const noProgress = policy.no_progress_generations;
    if (noProgress != null && (!Number.isInteger(noProgress) || noProgress <= 0)) {
      errors.push("policy.no_progress_generations must be a positive integer.");
    }
    // Mission 051 Phase 1 task 1.1: final-review fix rounds. Absent means
    // the code default (2); when present, a positive integer.
    const fixRounds = policy.final_review_fix_rounds;
    if (fixRounds != null && (!Number.isInteger(fixRounds) || fixRounds <= 0)) {
      errors.push("policy.final_review_fix_rounds must be a positive integer.");
    }
    // Mission 047 Phase 2 task 2.1: policy-level cumulative raw-token
    // backstop (the implementer-scale limit; review roles override it via
    // policy.caps.<role>.backstop_raw_tokens). Absent means the code
    // default (6M), never "no backstop". A cumulative total by nature, so
    // multi-million values (incl. the 6M default) are valid — unlike the
    // per-turn max_tokens ceiling, no cumulative-era threshold applies.
    const backstopRaw = policy.backstop_raw_tokens;
    if (backstopRaw != null && (!Number.isInteger(backstopRaw) || backstopRaw <= 0)) {
      errors.push("policy.backstop_raw_tokens must be a positive integer of tokens.");
    }
  } else if (policy != null) {
    errors.push("policy must be an object.");
  }
  return {valid: errors.length === 0, errors};
}

// TASK-38: planning.verify_denylist — an array of non-empty strings naming
// tests/commands a task's verify must never use (substring match). Absent
// is valid (treated as the migrated-in `[]` default); when present it must
// be exactly an array of non-empty strings.
export function validatePlanningConfig(planning = {}) {
  const errors = [];
  if (planning && typeof planning === "object" && !Array.isArray(planning)) {
    const list = planning.verify_denylist;
    if (list != null) {
      if (!Array.isArray(list)) {
        errors.push("planning.verify_denylist must be an array of non-empty strings.");
      } else {
        for (const entry of list) {
          if (typeof entry !== "string" || entry.trim().length === 0) {
            errors.push("planning.verify_denylist entries must be non-empty strings.");
            break;
          }
        }
      }
    }
  } else if (planning != null) {
    errors.push("planning must be an object.");
  }
  return {valid: errors.length === 0, errors};
}

export function validateCapabilityConfig(capabilities = {}) {
  const errors = [];
  try {
    for (const roleName of ROLE_NAMES) buildRoleRequirements({config: {capabilities}, roleName});
    for (const denied of capabilities.safety_denied || []) {
      if (typeof denied !== "string" || denied.includes("=") || (!CAPABILITY_IDS.includes(denied) && !(denied in ENUM_CAPABILITIES))) {
        errors.push(`Invalid safety-denied capability '${JSON.stringify(denied)}'.`);
      }
    }
    if (capabilities.certification?.receipt_ttl_days != null && capabilities.certification.receipt_ttl_days !== 30) {
      errors.push("capabilities.certification.receipt_ttl_days is fixed at 30.");
    }
    const planeSafety = capabilities.execution_plane_safety || {};
    if (planeSafety.network?.loopback != null && !["controlled", "denied"].includes(planeSafety.network.loopback)) {
      errors.push("capabilities.execution_plane_safety.network.loopback must be 'controlled' or 'denied'.");
    }
    if (planeSafety.network?.external_egress != null && !["deny", "provider-controlled"].includes(planeSafety.network.external_egress)) {
      errors.push("capabilities.execution_plane_safety.network.external_egress must be 'deny' or 'provider-controlled'.");
    }
    if (planeSafety.network?.provider_profile != null && !/^[a-z0-9][a-z0-9._-]*$/i.test(planeSafety.network.provider_profile)) {
      errors.push("capabilities.execution_plane_safety.network.provider_profile must be a profile identifier.");
    }
    if (planeSafety.browser_network_policy != null && planeSafety.browser_network_policy !== "separate") {
      errors.push("capabilities.execution_plane_safety.browser_network_policy must be 'separate'.");
    }
  } catch (error) {
    errors.push(error.message);
  }
  return {valid: errors.length === 0, errors};
}

const KNOWN_RUNTIME_MODES = new Set(Object.values(RUNTIME_MODE_IDS));
const DISTRO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*( [A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export function validateExecutionConfig(execution, framework) {
  if (execution === undefined) return {valid: true, errors: []};
  const errors = [];
  if (!execution || typeof execution !== "object" || Array.isArray(execution)) {
    return {valid: false, errors: ["execution must be an object with runtime_mode and wsl_distro."]};
  }
  const keys = Object.keys(execution);
  for (const key of keys) {
    if (key !== "runtime_mode" && key !== "wsl_distro") {
      errors.push(`execution.${key} is an unknown field (only runtime_mode and wsl_distro are allowed).`);
    }
  }
  if (!("runtime_mode" in execution)) {
    errors.push("execution.runtime_mode is required.");
  }
  if (!("wsl_distro" in execution)) {
    errors.push("execution.wsl_distro is required (null unless Native Windows selects wsl2-strong).");
  }
  const mode = execution.runtime_mode;
  if ("runtime_mode" in execution) {
    if (typeof mode !== "string" || !KNOWN_RUNTIME_MODES.has(mode)) {
      errors.push(`execution.runtime_mode is unknown: ${JSON.stringify(mode)}.`);
    }
  }
  if ("wsl_distro" in execution) {
    const distro = execution.wsl_distro;
    if (distro !== null) {
      if (typeof distro !== "string") {
        errors.push("execution.wsl_distro must be null or a non-empty distro name (unexpected nested data).");
      } else if (distro.trim().length === 0) {
        errors.push("execution.wsl_distro must be null or a non-empty distro name.");
      } else if (distro.length > 64 || !DISTRO_NAME_RE.test(distro)) {
        errors.push("execution.wsl_distro must be the exact discovered distro name, not a host path, probe output, diagnostic, or command.");
      }
    }
    if (mode !== RUNTIME_MODE_IDS.wsl2Strong && distro !== null && distro !== undefined) {
      errors.push("execution.wsl_distro must be null unless runtime_mode is wsl2-strong selected on Native Windows.");
    }
  }
  if (mode === RUNTIME_MODE_IDS.windowsCompatibility && framework !== "speckit" && framework !== "standalone") {
    const named = framework === null || framework === undefined ? "undetermined" : framework;
    errors.push(`execution.runtime_mode windows-compatibility supports SpecKit and standalone only and cannot be used with framework '${named}'.`);
  }
  return {valid: errors.length === 0, errors};
}

export async function validateConfigForSave({roles, agents, capabilities = {}, execution, framework, project, policy, planning} = {}) {
  const errors = [];
  const warnings = [];
  const missingModels = [];
  const verifiedAt = new Date().toISOString();
  const roleResults = {};
  for (const roleName of ROLE_NAMES) {
    const role = roles?.[roleName] || {};
    const adapter = agents?.[role.adapter];
    const result = await validateRoleSelection({roleName, role, adapter, agents, now: verifiedAt});
    roleResults[roleName] = result;
    errors.push(...result.errors);
    warnings.push(...result.warnings);
    for (const missing of result.missingModels || []) missingModels.push({role: roleName, ...missing});
  }
  errors.push(...validateCapabilityConfig(capabilities).errors);
  errors.push(...validatePolicyConfig(policy).errors);
  errors.push(...validatePlanningConfig(planning).errors);
  const effectiveFramework = framework ?? project?.planning_framework;
  errors.push(...validateExecutionConfig(execution, effectiveFramework).errors);
  return {valid: errors.length === 0, errors, warnings, verifiedAt, roleResults, missingModels};
}

const V4_SECTIONS = new Set([
  "$schema",
  "schema_version",
  "project",
  "roles",
  "caps",
  "retries",
  "time_limits",
  "workflow",
  "tests",
  "safety",
  "runtime",
  "frameworks",
  "advanced",
]);

const LEGACY_SECTIONS = new Set([
  "policy",
  "gates",
  "execution",
  "planning",
  "capabilities",
]);

// The v4 section(s) that replace each deprecated legacy section. Warnings
// name them so an operator knows where the setting moved.
const LEGACY_SECTION_TARGETS = {
  policy: "caps, retries, time_limits, advanced, workflow, safety",
  gates: "tests",
  execution: "runtime",
  planning: "tests, frameworks",
  capabilities: "advanced.capabilities, tests",
};

// Per-key v4 target for the legacy names toRuntimeConfig still resolves. Used
// only for warnings (the legacy sections are read by the migration, not
// validated key-by-key), so an unmapped key still gets the section warning.
const LEGACY_KEY_TARGETS = {
  policy: {
    per_task_max_turns: "caps.implementer.max_turns",
    per_task_max_tokens: "caps.implementer.max_tokens",
    continuation_allowance: "caps.implementer.extra_sessions",
    handoff_wrapup_tokens: "caps.implementer.wrap_up_at_tokens",
    task_size_target_turns: "caps.task_size_target_turns",
    backstop_raw_tokens: "caps.mission_token_backstop",
    max_plan_revisions: "retries.plan_revisions",
    no_progress_generations: "retries.no_progress_sessions",
    final_review_fix_rounds: "retries.final_review_fix_rounds",
    free_model_turns_cap: "roles.free_models.max_turns",
    relay_timeout_ms: "time_limits.call_backstop_minutes",
    role_timeout_ms: "time_limits.role_timeout_minutes",
    role_deadline_floor_ms: "time_limits.role_timeout_floor_minutes",
    idle_hang_ms: "time_limits.silent_run_minutes",
    first_output_ms: "time_limits.no_first_output_minutes",
    max_silence_ms: "time_limits.read_only_max_silence_minutes",
    retry_delay_ms: "time_limits.retry_wait_seconds",
    handoff_max_chars: "advanced.handoff_max_chars",
    handoff_note_max_chars: "advanced.handoff_note_max_chars",
    fallback_retry_primary_minutes: "advanced.fallback_retry_primary_minutes",
    checkpoint_after_task: "advanced.checkpoint_after_task",
    checkpoint_after_phase: "advanced.checkpoint_after_phase",
    require_human_commit: "workflow.commit_by_human",
    fail_closed_on_relay_violation: "safety.stop_on_sandbox_violation",
    caps: "caps.<role>",
    failure_budgets: "retries.<stage>",
  },
  gates: {
    commands: "tests.gate_commands",
    network_isolation: "tests.gate_network",
    require_reviewer: "tests.require_reviewer",
    env_allowlist: "tests.gate_env_allowlist",
  },
  execution: {
    runtime_mode: "runtime.mode",
    wsl_distro: "runtime.wsl_distro",
  },
  planning: {
    verify_denylist: "tests.verify_denylist",
    speckit: "frameworks.speckit",
    gsd: "frameworks.gsd",
  },
  capabilities: {
    project_defaults: "advanced.capabilities.project_defaults",
    role_requirements: "advanced.capabilities.role_requirements",
    safety_denied: "advanced.capabilities.safety_denied",
    legacy_text_inference: "advanced.capabilities.legacy_text_inference",
    verification: "tests.browser, tests.require_browser",
  },
};

// Legacy top-level names toRuntimeConfig still resolves (one-release old-name
// compatibility).
const TOP_LEVEL_ALIASES = new Map([
  ["freeModelAutoFallback", "roles.free_models.auto_fallback"],
]);

function warnLegacySection(section, value, warnings) {
  const targets = LEGACY_KEY_TARGETS[section] || {};
  if (isObject(value)) {
    for (const [key, target] of Object.entries(targets)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        warnings.push(`${section}.${key}: deprecated legacy name; use \`${target}\` instead.`);
      }
    }
  }
  warnings.push(`${section}: deprecated legacy section; use \`${LEGACY_SECTION_TARGETS[section]}\` instead.`);
}

const ROLE_KEYS = new Set(["cli", "model", "reasoning", "variant", "resume_session", "fallbacks", "escalation_model"]);
const ROLE_FALLBACK_KEYS = new Set(["cli", "model", "reasoning", "variant"]);
const ESCALATION_MODEL_KEYS = new Set(["cli", "model", "reasoning", "variant"]);

const CAPS_REVIEW_ROLE_KEYS = new Set(["max_turns", "max_tokens", "extra_sessions", "wrap_up_at_tokens", "backstop_raw_tokens"]);
const CAPS_IMPLEMENTER_KEYS = new Set(["max_turns", "max_tokens", "extra_sessions", "wrap_up_at_tokens"]);
const CAPS_TOP_KEYS = new Set(["task_size_target_turns", "planner", "plan_reviewer", "implementer", "code_reviewer", "verifier", "mission_token_backstop"]);

const RETRIES_KEYS = new Set([
  "plan_revisions",
  "implementation",
  "verification",
  "final_review_fix_rounds",
  "cli_errors",
  "infrastructure",
  "no_progress_sessions",
  "extra_sessions_per_task",
  "escalate_after_not_fixed",
]);

const TIME_LIMITS_KEYS = new Set([
  "role_timeout_minutes",
  "call_backstop_minutes",
  // One-release old name, accepted and migrated by config fill/migration.
  "mission_timeout_minutes",
  "role_timeout_floor_minutes",
  "silent_run_minutes",
  "no_first_output_minutes",
  "read_only_max_silence_minutes",
  "retry_wait_seconds",
]);

const WORKFLOW_KEYS = new Set([
  "plan_review",
  "plan_review_rounds_converge",
  "gsd_planning_review",
  "spec_review",
  "code_review_per_phase",
  "final_review",
  "analysis_after_tasks",
  "approve_spec_myself",
  "approve_plan_myself",
  "parallel_independent_tasks",
  "use_worktrees",
  "commit_by_human",
]);

const TESTS_KEYS = new Set([
  "gate_commands",
  "gate_network",
  "gate_env_allowlist",
  "require_reviewer",
  "browser",
  "require_browser",
  "verify_denylist",
]);

const SAFETY_KEYS = new Set([
  "allow_git_commit",
  "allow_git_push",
  "allow_destructive_operations",
  "stop_on_sandbox_violation",
  "block_git_in_roles",
  "check_read_only_roles",
  "record_touched_files",
  "keep_role_sessions",
]);

const RUNTIME_KEYS = new Set(["mode", "wsl_distro"]);

const FRAMEWORKS_SPECKIT_KEYS = new Set(["workflow_file", "task_files"]);
const FRAMEWORKS_GSD_KEYS = new Set([
  "phase_root",
  "run_plan_verify",
  "run_state_validate",
  "write_summary_artifacts",
  "write_verification_artifacts",
  "write_uat_artifact",
  "use_gsd_tools_when_available",
  "planning_review",
  "parallel",
]);

const ADVANCED_KEYS = new Set([
  "state_file",
  "runs_dir",
  "handoff_max_chars",
  "handoff_note_max_chars",
  "handoff_wrapup_tokens",
  "fallback_retry_primary_minutes",
  "checkpoint_after_task",
  "checkpoint_after_phase",
  "capabilities",
]);

const ADVANCED_CAPABILITIES_KEYS = new Set([
  "project_defaults",
  "role_requirements",
  "safety_denied",
  "legacy_text_inference",
]);

const PROJECT_KEYS = new Set(["repo", "planning_framework"]);

const FREE_MODELS_KEYS = new Set(["auto_fallback", "max_turns"]);

// Enumerated values come from the schema generator so the validator and the
// shipped config.schema.json cannot drift.
const BROWSER_VALUES = new Set(SCHEMA_ENUMS["tests.browser"]);
const REQUIRE_BROWSER_VALUES = new Set(SCHEMA_ENUMS["tests.require_browser"]);
const PLANNING_FRAMEWORK_VALUES = SCHEMA_ENUMS["project.planning_framework"];

function isObject(value) {
  return value !== null && typeof value !== "undefined" && typeof value === "object" && !Array.isArray(value);
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({length: m + 1}, (_, i) => Array.from({length: n + 1}, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1];
      else dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function findNearestKey(unknown, knownKeys) {
  let best = null;
  let bestDist = Infinity;
  for (const known of knownKeys) {
    const dist = levenshtein(unknown, known);
    if (dist < bestDist) {
      bestDist = dist;
      best = known;
    }
  }
  return bestDist <= 3 ? best : null;
}

// `aliases` maps a legacy name the reader still resolves to the v4 path that
// replaces it. Alias keys are accepted (never unknown-key errors) and reported
// as deprecated warnings naming the new name, per the one-release old-name
// compatibility of toRuntimeConfig.
function checkUnknownKeys(obj, allowedKeys, path, errors, warnings, {aliases = null, unknownAsWarnings = false} = {}) {
  if (!isObject(obj)) return;
  for (const key of Object.keys(obj)) {
    if (key.startsWith("_")) continue;
    const fullPath = path ? `${path}.${key}` : key;
    if (aliases && aliases.has(key)) {
      warnings.push(`${fullPath}: deprecated legacy name; use \`${aliases.get(key)}\` instead.`);
      continue;
    }
    if (!allowedKeys.has(key)) {
      const nearest = findNearestKey(key, allowedKeys);
      const suggestion = nearest ? ` (did you mean \`${nearest}\`?) ` : " ";
      const message = `${fullPath}: unknown key${suggestion}known keys: ${Array.from(allowedKeys).sort().join(", ")}.`;
      if (unknownAsWarnings) warnings.push(`Carried from the legacy config (not a v4 key): ${message}`);
      else errors.push(message);
    }
  }
}

// Emits a deprecation warning for each legacy key present, naming the v4 path
// the reader resolves it to. Used for the deprecated sections, whose contents
// are mapped explicitly by toRuntimeConfig rather than validated key-by-key.
function warnLegacyKeys(obj, aliases, path, warnings) {
  if (!isObject(obj)) return;
  for (const [key, target] of aliases) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      warnings.push(`${path}.${key}: deprecated legacy name; use \`${target}\` instead.`);
    }
  }
}

function validateType(value, expectedType, path, errors, allowedValues = null, {minimum = null, nullable = false} = {}) {
  if (nullable && value === null) return true;
  if (expectedType === "integer") {
    if (!Number.isInteger(value)) {
      errors.push(`${path}: must be an integer${allowedValues ? ` (allowed: ${allowedValues.join(", ")})` : ""}.`);
      return false;
    }
  } else if (expectedType === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push(`${path}: must be a number${allowedValues ? ` (allowed: ${allowedValues.join(", ")})` : ""}.`);
      return false;
    }
  } else if (expectedType === "string") {
    if (typeof value !== "string") {
      errors.push(`${path}: must be a string${allowedValues ? ` (allowed: ${allowedValues.join(", ")})` : ""}.`);
      return false;
    }
  } else if (expectedType === "boolean") {
    if (typeof value !== "boolean") {
      errors.push(`${path}: must be a boolean${allowedValues ? ` (allowed: ${allowedValues.join(", ")})` : ""}.`);
      return false;
    }
  } else if (expectedType === "object") {
    if (!isObject(value)) {
      errors.push(`${path}: must be an object${allowedValues ? ` (allowed keys: ${allowedValues.join(", ")})` : ""}.`);
      return false;
    }
  } else if (expectedType === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${path}: must be an array${allowedValues ? ` (allowed: ${allowedValues.join(", ")})` : ""}.`);
      return false;
    }
  }
  if (allowedValues && !allowedValues.includes(value)) {
    errors.push(`${path}: invalid value ${JSON.stringify(value)}${allowedValues ? ` (allowed: ${allowedValues.join(", ")})` : ""}.`);
    return false;
  }
  if (minimum !== null && typeof value === "number" && value < minimum) {
    errors.push(`${path}: must be >= ${minimum} (got ${value}).`);
    return false;
  }
  return true;
}

// Legacy role names toRuntimeConfig resolves when the v4 key is absent.
const ROLE_ALIASES = new Map([["adapter", "cli"], ["resume", "resume_session"]]);
const ROLE_FALLBACK_ALIASES = new Map([["adapter", "cli"]]);

function validateRoleConfig(roleConfig, roleName, path, errors, warnings) {
  if (!isObject(roleConfig)) return;
  checkUnknownKeys(roleConfig, ROLE_KEYS, path, errors, warnings, {aliases: ROLE_ALIASES});
  if (roleConfig.cli !== undefined) validateType(roleConfig.cli, "string", `${path}.cli`, errors);
  if (roleConfig.model !== undefined) validateType(roleConfig.model, "string", `${path}.model`, errors);
  if (roleConfig.reasoning !== undefined) validateType(roleConfig.reasoning, "string", `${path}.reasoning`, errors);
  if (roleConfig.variant !== undefined) validateType(roleConfig.variant, "string", `${path}.variant`, errors);
  if (roleConfig.resume_session !== undefined) validateType(roleConfig.resume_session, "boolean", `${path}.resume_session`, errors);
  if (roleConfig.fallbacks !== undefined) {
    if (!Array.isArray(roleConfig.fallbacks)) {
      errors.push(`${path}.fallbacks: must be an array.`);
    } else {
      for (let i = 0; i < roleConfig.fallbacks.length; i++) {
        const fb = roleConfig.fallbacks[i];
        const fbPath = `${path}.fallbacks[${i}]`;
        if (!isObject(fb)) {
          errors.push(`${fbPath}: must be an object.`);
        } else {
          checkUnknownKeys(fb, ROLE_FALLBACK_KEYS, fbPath, errors, warnings, {aliases: ROLE_FALLBACK_ALIASES});
          for (const key of ["cli", "model", "reasoning", "variant"]) {
            if (fb[key] !== undefined) validateType(fb[key], "string", `${fbPath}.${key}`, errors);
          }
        }
      }
    }
  }
  if (roleConfig.escalation_model !== undefined) {
    const em = roleConfig.escalation_model;
    const emPath = `${path}.escalation_model`;
    if (em === null) {
    } else if (!isObject(em)) {
      errors.push(`${emPath}: must be an object or null.`);
    } else {
      checkUnknownKeys(em, ESCALATION_MODEL_KEYS, emPath, errors, warnings, {aliases: ROLE_FALLBACK_ALIASES});
      for (const key of ["cli", "model", "reasoning", "variant"]) {
        if (em[key] !== undefined) validateType(em[key], "string", `${emPath}.${key}`, errors);
      }
    }
  }
}

// Count-like caps: max_turns/max_tokens must be positive (>=1), session and
// wrap-up counts may be 0. The minimums mirror validatePolicyConfig, which
// rejects the same values for the runtime shape.
const CAP_MINIMUMS = {max_turns: 1, max_tokens: 1, extra_sessions: 0, wrap_up_at_tokens: 1, backstop_raw_tokens: 1};

function validateCapsConfig(caps, path, errors, warnings) {
  if (!isObject(caps)) return;
  checkUnknownKeys(caps, CAPS_TOP_KEYS, path, errors, warnings);
  if (caps.task_size_target_turns !== undefined) {
    validateType(caps.task_size_target_turns, "integer", `${path}.task_size_target_turns`, errors, null, {minimum: 1});
  }
  if (caps.mission_token_backstop !== undefined) {
    validateType(caps.mission_token_backstop, "integer", `${path}.mission_token_backstop`, errors, null, {minimum: 1});
  }
  const validateRoleCaps = (entry, rolePath, allowedKeys) => {
    checkUnknownKeys(entry, allowedKeys, rolePath, errors, warnings);
    for (const [key, minimum] of Object.entries(CAP_MINIMUMS)) {
      if (entry[key] !== undefined) validateType(entry[key], "integer", `${rolePath}.${key}`, errors, null, {minimum});
    }
  };
  for (const role of REVIEW_ROLES) {
    if (caps[role] === undefined) continue;
    const rolePath = `${path}.${role}`;
    if (!isObject(caps[role])) errors.push(`${rolePath}: must be an object.`);
    else validateRoleCaps(caps[role], rolePath, CAPS_REVIEW_ROLE_KEYS);
  }
  if (caps.implementer !== undefined) {
    const rolePath = `${path}.implementer`;
    if (!isObject(caps.implementer)) errors.push(`${rolePath}: must be an object.`);
    else validateRoleCaps(caps.implementer, rolePath, CAPS_IMPLEMENTER_KEYS);
  }
}

// Every retry/revision budget is a count: 0 is allowed (no retries), negative
// values are not.
const RETRY_MINIMUMS = {
  plan_revisions: 0,
  implementation: 0,
  verification: 0,
  final_review_fix_rounds: 1,
  cli_errors: 0,
  infrastructure: 0,
  no_progress_sessions: 1,
  extra_sessions_per_task: 0,
  escalate_after_not_fixed: 1,
};

function validateRetriesConfig(retries, path, errors, warnings) {
  if (!isObject(retries)) return;
  checkUnknownKeys(retries, RETRIES_KEYS, path, errors, warnings);
  for (const [key, minimum] of Object.entries(RETRY_MINIMUMS)) {
    if (retries[key] !== undefined) {
      validateType(retries[key], "integer", `${path}.${key}`, errors, null, {minimum});
    }
  }
}

// Time limits are minute/second values, so a number is valid even when it is
// not a whole minute (migration can turn e.g. 90000ms into 1.5 minutes). The
// reader (minutesToMs/seconds conversion) passes null through unchanged, so
// null is accepted wherever the runtime tolerates it — except
// role_timeout_minutes, whose object form holds the per-role overrides.
const TIME_LIMIT_KEYS = [
  "call_backstop_minutes",
  "mission_timeout_minutes",
  "role_timeout_floor_minutes",
  "silent_run_minutes",
  "no_first_output_minutes",
  "read_only_max_silence_minutes",
  "retry_wait_seconds",
];

function validateTimeLimitsConfig(timeLimits, path, errors, warnings) {
  if (!isObject(timeLimits)) return;
  checkUnknownKeys(timeLimits, TIME_LIMITS_KEYS, path, errors, warnings);
  if (timeLimits.mission_timeout_minutes !== undefined) {
    warnings.push(`${path}.mission_timeout_minutes: deprecated old name; use \`${path}.call_backstop_minutes\` instead.`);
  }
  for (const key of TIME_LIMIT_KEYS) {
    if (timeLimits[key] !== undefined) {
      validateType(timeLimits[key], "number", `${path}.${key}`, errors, null, {minimum: 0, nullable: true});
    }
  }
  if (timeLimits.role_timeout_minutes !== undefined) {
    const rtm = timeLimits.role_timeout_minutes;
    const rtmPath = `${path}.role_timeout_minutes`;
    if (rtm === null) {
      // null disables the per-role override; the reader passes it through.
    } else if (typeof rtm === "number") {
      // A numeric value is what migration produces from a numeric legacy
      // policy.role_timeout_ms; toRuntimeConfig resolves it unchanged.
      validateType(rtm, "number", rtmPath, errors, null, {minimum: 0});
    } else if (!isObject(rtm)) {
      errors.push(`${rtmPath}: must be a number or an object with 'default' and optional 'verifier' keys.`);
    } else {
      for (const key of ["default", "verifier"]) {
        // minutesToMs passes null through unchanged, so null disables the
        // override just like it does for the scalar time-limit keys.
        if (rtm[key] !== undefined) validateType(rtm[key], "number", `${rtmPath}.${key}`, errors, null, {minimum: 0, nullable: true});
      }
      checkUnknownKeys(rtm, new Set(["default", "verifier"]), rtmPath, errors, warnings);
    }
  }
}

function validateWorkflowConfig(workflow, path, errors, warnings) {
  if (!isObject(workflow)) return;
  checkUnknownKeys(workflow, WORKFLOW_KEYS, path, errors, warnings);
  for (const key of WORKFLOW_KEYS) {
    if (workflow[key] !== undefined) {
      validateType(workflow[key], "boolean", `${path}.${key}`, errors);
    }
  }
}

function validateTestsConfig(tests, path, errors, warnings) {
  if (!isObject(tests)) return;
  checkUnknownKeys(tests, TESTS_KEYS, path, errors, warnings);
  if (tests.gate_commands !== undefined) {
    if (!Array.isArray(tests.gate_commands)) {
      errors.push(`${path}.gate_commands: must be an array.`);
    } else {
      for (let i = 0; i < tests.gate_commands.length; i++) {
        if (typeof tests.gate_commands[i] !== "string") {
          errors.push(`${path}.gate_commands[${i}]: must be a string.`);
        }
      }
    }
  }
  if (tests.gate_network !== undefined) validateType(tests.gate_network, "boolean", `${path}.gate_network`, errors);
  if (tests.gate_env_allowlist !== undefined) {
    if (!Array.isArray(tests.gate_env_allowlist)) {
      errors.push(`${path}.gate_env_allowlist: must be an array.`);
    } else {
      for (let i = 0; i < tests.gate_env_allowlist.length; i++) {
        if (typeof tests.gate_env_allowlist[i] !== "string") {
          errors.push(`${path}.gate_env_allowlist[${i}]: must be a string.`);
        }
      }
    }
  }
  if (tests.require_reviewer !== undefined) validateType(tests.require_reviewer, "boolean", `${path}.require_reviewer`, errors);
  if (tests.browser !== undefined) validateType(tests.browser, "string", `${path}.browser`, errors, Array.from(BROWSER_VALUES));
  if (tests.require_browser !== undefined) validateType(tests.require_browser, "string", `${path}.require_browser`, errors, Array.from(REQUIRE_BROWSER_VALUES));
  if (tests.verify_denylist !== undefined) {
    if (!Array.isArray(tests.verify_denylist)) {
      errors.push(`${path}.verify_denylist: must be an array.`);
    } else {
      for (let i = 0; i < tests.verify_denylist.length; i++) {
        if (typeof tests.verify_denylist[i] !== "string" || tests.verify_denylist[i].trim().length === 0) {
          errors.push(`${path}.verify_denylist[${i}]: must be a non-empty string.`);
        }
      }
    }
  }
}

function validateSafetyConfig(safety, path, errors, warnings) {
  if (!isObject(safety)) return;
  checkUnknownKeys(safety, SAFETY_KEYS, path, errors, warnings);
  for (const key of SAFETY_KEYS) {
    if (safety[key] !== undefined) {
      validateType(safety[key], "boolean", `${path}.${key}`, errors);
    }
  }
}

function validateRuntimeConfig(runtime, path, errors, warnings, options = {}) {
  if (!isObject(runtime)) return;
  checkUnknownKeys(runtime, RUNTIME_KEYS, path, errors, warnings, {unknownAsWarnings: Boolean(options.migrated)});
  if (runtime.mode !== undefined) {
    if (!KNOWN_RUNTIME_MODES.has(runtime.mode)) {
      const nearest = findNearestKey(runtime.mode, KNOWN_RUNTIME_MODES);
      const suggestion = nearest ? ` (did you mean \`${nearest}\`?)` : "";
      errors.push(`${path}.mode: unknown runtime mode ${JSON.stringify(runtime.mode)}${suggestion}. Known modes: ${Array.from(KNOWN_RUNTIME_MODES).join(", ")}.`);
    }
  }
  if (runtime.wsl_distro !== undefined) {
    if (runtime.wsl_distro !== null) {
      if (typeof runtime.wsl_distro !== "string") {
        errors.push(`${path}.wsl_distro: must be null or a string.`);
      } else if (runtime.wsl_distro.trim().length === 0) {
        errors.push(`${path}.wsl_distro: must be null or a non-empty string.`);
      }
    }
  }
}

function validateFrameworksConfig(frameworks, path, errors, warnings) {
  if (!isObject(frameworks)) return;
  if (frameworks.speckit !== undefined) {
    const spPath = `${path}.speckit`;
    if (!isObject(frameworks.speckit)) {
      errors.push(`${spPath}: must be an object.`);
    } else {
      checkUnknownKeys(frameworks.speckit, FRAMEWORKS_SPECKIT_KEYS, spPath, errors, warnings);
      if (frameworks.speckit.workflow_file !== undefined) {
        validateType(frameworks.speckit.workflow_file, "string", `${spPath}.workflow_file`, errors);
      }
      if (frameworks.speckit.task_files !== undefined) {
        if (!Array.isArray(frameworks.speckit.task_files)) {
          errors.push(`${spPath}.task_files: must be an array.`);
        } else {
          for (let i = 0; i < frameworks.speckit.task_files.length; i++) {
            if (typeof frameworks.speckit.task_files[i] !== "string") {
              errors.push(`${spPath}.task_files[${i}]: must be a string.`);
            }
          }
        }
      }
    }
  }
  if (frameworks.gsd !== undefined) {
    const gsdPath = `${path}.gsd`;
    if (!isObject(frameworks.gsd)) {
      errors.push(`${gsdPath}: must be an object.`);
    } else {
      checkUnknownKeys(frameworks.gsd, FRAMEWORKS_GSD_KEYS, gsdPath, errors, warnings);
      if (frameworks.gsd.phase_root !== undefined) {
        validateType(frameworks.gsd.phase_root, "string", `${gsdPath}.phase_root`, errors);
      }
      for (const key of ["run_plan_verify", "run_state_validate", "write_summary_artifacts", "write_verification_artifacts", "write_uat_artifact", "use_gsd_tools_when_available"]) {
        if (frameworks.gsd[key] !== undefined) {
          validateType(frameworks.gsd[key], "boolean", `${gsdPath}.${key}`, errors);
        }
      }
      if (frameworks.gsd.planning_review !== undefined) {
        const prPath = `${gsdPath}.planning_review`;
        if (!isObject(frameworks.gsd.planning_review)) {
          errors.push(`${prPath}: must be an object.`);
        } else {
          const PLANNING_REVIEW_KEYS = new Set(["enabled", "review_after_each_stage", "stages", "max_revisions", "read_only_reviewer"]);
          checkUnknownKeys(frameworks.gsd.planning_review, PLANNING_REVIEW_KEYS, prPath, errors, warnings);
          if (frameworks.gsd.planning_review.enabled !== undefined) validateType(frameworks.gsd.planning_review.enabled, "boolean", `${prPath}.enabled`, errors);
          if (frameworks.gsd.planning_review.review_after_each_stage !== undefined) validateType(frameworks.gsd.planning_review.review_after_each_stage, "boolean", `${prPath}.review_after_each_stage`, errors);
          if (frameworks.gsd.planning_review.stages !== undefined) {
            if (!Array.isArray(frameworks.gsd.planning_review.stages)) {
              errors.push(`${prPath}.stages: must be an array.`);
            }
          }
          if (frameworks.gsd.planning_review.max_revisions !== undefined) validateType(frameworks.gsd.planning_review.max_revisions, "integer", `${prPath}.max_revisions`, errors, null, {minimum: 0});
          if (frameworks.gsd.planning_review.read_only_reviewer !== undefined) validateType(frameworks.gsd.planning_review.read_only_reviewer, "boolean", `${prPath}.read_only_reviewer`, errors);
        }
      }
      if (frameworks.gsd.parallel !== undefined) {
        const parPath = `${gsdPath}.parallel`;
        if (!isObject(frameworks.gsd.parallel)) {
          errors.push(`${parPath}: must be an object.`);
        } else {
          const PARALLEL_KEYS = new Set(["enabled", "plan_level", "task_level", "max_concurrent_agents", "min_plans_for_parallel"]);
          checkUnknownKeys(frameworks.gsd.parallel, PARALLEL_KEYS, parPath, errors, warnings);
          if (frameworks.gsd.parallel.enabled !== undefined) validateType(frameworks.gsd.parallel.enabled, "boolean", `${parPath}.enabled`, errors);
          if (frameworks.gsd.parallel.plan_level !== undefined) validateType(frameworks.gsd.parallel.plan_level, "boolean", `${parPath}.plan_level`, errors);
          if (frameworks.gsd.parallel.task_level !== undefined) validateType(frameworks.gsd.parallel.task_level, "boolean", `${parPath}.task_level`, errors);
          if (frameworks.gsd.parallel.max_concurrent_agents !== undefined) validateType(frameworks.gsd.parallel.max_concurrent_agents, "integer", `${parPath}.max_concurrent_agents`, errors, null, {minimum: 1});
          if (frameworks.gsd.parallel.min_plans_for_parallel !== undefined) validateType(frameworks.gsd.parallel.min_plans_for_parallel, "integer", `${parPath}.min_plans_for_parallel`, errors, null, {minimum: 1});
        }
      }
    }
  }
}

function validateAdvancedConfig(advanced, path, errors, warnings) {
  if (!isObject(advanced)) return;
  checkUnknownKeys(advanced, ADVANCED_KEYS, path, errors, warnings);
  if (advanced.handoff_max_chars !== undefined) validateType(advanced.handoff_max_chars, "integer", `${path}.handoff_max_chars`, errors, null, {minimum: HANDOFF_MIN_CHARS});
  if (advanced.handoff_note_max_chars !== undefined) validateType(advanced.handoff_note_max_chars, "integer", `${path}.handoff_note_max_chars`, errors, null, {minimum: HANDOFF_NOTE_MIN_CHARS});
  if (advanced.handoff_wrapup_tokens !== undefined) validateType(advanced.handoff_wrapup_tokens, "integer", `${path}.handoff_wrapup_tokens`, errors, null, {minimum: 1});
  if (advanced.fallback_retry_primary_minutes !== undefined) validateType(advanced.fallback_retry_primary_minutes, "integer", `${path}.fallback_retry_primary_minutes`, errors);
  if (advanced.checkpoint_after_task !== undefined) validateType(advanced.checkpoint_after_task, "boolean", `${path}.checkpoint_after_task`, errors);
  if (advanced.checkpoint_after_phase !== undefined) validateType(advanced.checkpoint_after_phase, "boolean", `${path}.checkpoint_after_phase`, errors);
  if (advanced.capabilities !== undefined) {
    const capPath = `${path}.capabilities`;
    if (!isObject(advanced.capabilities)) {
      errors.push(`${capPath}: must be an object.`);
    } else {
      checkUnknownKeys(advanced.capabilities, ADVANCED_CAPABILITIES_KEYS, capPath, errors, warnings);
      if (advanced.capabilities.project_defaults !== undefined) {
        if (!Array.isArray(advanced.capabilities.project_defaults)) {
          errors.push(`${capPath}.project_defaults: must be an array.`);
        }
      }
      if (advanced.capabilities.role_requirements !== undefined) {
        if (!isObject(advanced.capabilities.role_requirements)) {
          errors.push(`${capPath}.role_requirements: must be an object.`);
        }
      }
      if (advanced.capabilities.safety_denied !== undefined) {
        if (!Array.isArray(advanced.capabilities.safety_denied)) {
          errors.push(`${capPath}.safety_denied: must be an array.`);
        }
      }
      if (advanced.capabilities.legacy_text_inference !== undefined) {
        validateType(advanced.capabilities.legacy_text_inference, "boolean", `${capPath}.legacy_text_inference`, errors);
      }
    }
  }
}

function validateProjectConfig(project, path, errors, warnings, options = {}) {
  if (!isObject(project)) return;
  checkUnknownKeys(project, PROJECT_KEYS, path, errors, warnings, {unknownAsWarnings: Boolean(options.migrated)});
  if (project.repo !== undefined) validateType(project.repo, "string", `${path}.repo`, errors);
  if (project.planning_framework !== undefined) {
    validateType(project.planning_framework, "string", `${path}.planning_framework`, errors, PLANNING_FRAMEWORK_VALUES);
  }
}

function validateRolesConfig(roles, path, errors, warnings) {
  if (!isObject(roles)) return;
  const roleKeysWithFree = new Set([...ROLE_NAMES, "free_models"]);
  checkUnknownKeys(roles, roleKeysWithFree, path, errors, warnings);
  for (const roleName of ROLE_NAMES) {
    if (roles[roleName] !== undefined) {
      validateRoleConfig(roles[roleName], roleName, `${path}.${roleName}`, errors, warnings);
    }
  }
  if (roles.free_models !== undefined) {
    const fmPath = `${path}.free_models`;
    if (!isObject(roles.free_models)) {
      errors.push(`${fmPath}: must be an object.`);
    } else {
      checkUnknownKeys(roles.free_models, FREE_MODELS_KEYS, fmPath, errors, warnings);
      if (roles.free_models.auto_fallback !== undefined) validateType(roles.free_models.auto_fallback, "boolean", `${fmPath}.auto_fallback`, errors);
      if (roles.free_models.max_turns !== undefined) validateType(roles.free_models.max_turns, "integer", `${fmPath}.max_turns`, errors, null, {minimum: 0});
    }
  }
}

// `migrated` says the layout came out of migrateConfig: operator-added keys
// that migration carried over intentionally are reported as warnings (they are
// valid legacy data preserved for the operator), while a hand-written v4 config
// still fails on unknown keys.
export function validateNewConfig(layout, {migrated = false} = {}) {
  const errors = [];
  const warnings = [];

  if (!isObject(layout)) {
    errors.push("Config must be an object.");
    return {valid: false, errors, warnings};
  }

  const allAllowedSections = new Set([...V4_SECTIONS, ...LEGACY_SECTIONS]);
  checkUnknownKeys(layout, allAllowedSections, "", errors, warnings, {aliases: TOP_LEVEL_ALIASES, unknownAsWarnings: migrated});

  for (const key of Object.keys(layout)) {
    if (LEGACY_SECTIONS.has(key)) warnLegacySection(key, layout[key], warnings);
  }

  if (layout.$schema !== undefined) {
    validateType(layout.$schema, "string", "$schema", errors);
  }
  if (layout.schema_version !== undefined) {
    validateType(layout.schema_version, "string", "schema_version", errors);
    if (layout.schema_version !== CONFIG_SCHEMA_VERSION) {
      warnings.push(`schema_version: expected "${CONFIG_SCHEMA_VERSION}", got "${layout.schema_version}".`);
    }
  }

  if (layout.project !== undefined) {
    validateType(layout.project, "object", "project", errors);
    if (isObject(layout.project)) validateProjectConfig(layout.project, "project", errors, warnings, {migrated});
  }

  if (layout.roles !== undefined) {
    validateType(layout.roles, "object", "roles", errors);
    if (isObject(layout.roles)) validateRolesConfig(layout.roles, "roles", errors, warnings);
  }

  if (layout.caps !== undefined) {
    validateType(layout.caps, "object", "caps", errors);
    if (isObject(layout.caps)) validateCapsConfig(layout.caps, "caps", errors, warnings);
  }

  if (layout.retries !== undefined) {
    validateType(layout.retries, "object", "retries", errors);
    if (isObject(layout.retries)) validateRetriesConfig(layout.retries, "retries", errors, warnings);
  }

  if (layout.time_limits !== undefined) {
    validateType(layout.time_limits, "object", "time_limits", errors);
    if (isObject(layout.time_limits)) validateTimeLimitsConfig(layout.time_limits, "time_limits", errors, warnings);
  }

  if (layout.workflow !== undefined) {
    validateType(layout.workflow, "object", "workflow", errors);
    if (isObject(layout.workflow)) validateWorkflowConfig(layout.workflow, "workflow", errors, warnings);
  }

  if (layout.tests !== undefined) {
    validateType(layout.tests, "object", "tests", errors);
    if (isObject(layout.tests)) validateTestsConfig(layout.tests, "tests", errors, warnings);
  }

  if (layout.safety !== undefined) {
    validateType(layout.safety, "object", "safety", errors);
    if (isObject(layout.safety)) validateSafetyConfig(layout.safety, "safety", errors, warnings);
  }

  if (layout.runtime !== undefined) {
    validateType(layout.runtime, "object", "runtime", errors);
    if (isObject(layout.runtime)) validateRuntimeConfig(layout.runtime, "runtime", errors, warnings, {migrated});
  }

  if (layout.frameworks !== undefined) {
    validateType(layout.frameworks, "object", "frameworks", errors);
    if (isObject(layout.frameworks)) validateFrameworksConfig(layout.frameworks, "frameworks", errors, warnings);
  }

  if (layout.advanced !== undefined) {
    validateType(layout.advanced, "object", "advanced", errors);
    if (isObject(layout.advanced)) validateAdvancedConfig(layout.advanced, "advanced", errors, warnings);
  }

  return {valid: errors.length === 0, errors, warnings};
}
