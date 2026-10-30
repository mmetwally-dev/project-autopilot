import fs from "node:fs";
import path from "node:path";
import { PER_TASK_MAX_TURNS_DEFAULT, PER_TASK_MAX_TOKENS_DEFAULT, CONTINUATION_ALLOWANCE_DEFAULT, HANDOFF_MAX_CHARS_DEFAULT, HANDOFF_NOTE_MAX_CHARS_DEFAULT, HANDOFF_WRAPUP_TOKENS_DEFAULT, NO_PROGRESS_GENERATIONS_DEFAULT, FINAL_REVIEW_FIX_ROUNDS_DEFAULT, RELAY_TIMEOUT_DEFAULT_MS, PER_TASK_TIMEOUT_DEFAULT_MS, resolveIdleHangMs, PER_ROLE_CAPS_DEFAULT, PER_ROLE_WRAPUP_TOKENS_DEFAULT, BACKSTOP_RAW_TOKENS_DEFAULT, LEGACY_MAX_TURNS_DEFAULT, PREVIOUS_MAX_TURNS_DEFAULT } from "./per-task-budget.mjs";
import { CONFIG_SCHEMA_VERSION, toNewLayoutConfig, toRuntimeConfig, migrateTimeLimitNames, migratePlanApprovalKey } from "./config-layout.mjs";
import { fillLayout } from "./config-fill.mjs";

// Backlog #1 (mission 096 Phase 1 task 1.3): migration now yields the v4
// on-disk layout (config-layout.mjs). `migrateConfig` returns
// `{config: <v4 layout>, ...}`; `loadAndMigrateConfig` wraps it back into the
// legacy runtime shape the rest of the code reads and returns
// `{config: toRuntimeConfig(layout), layout}`.
export const CURRENT_SCHEMA = CONFIG_SCHEMA_VERSION;
const ROLES = ["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"];
// Machine-written fields (spec rule 7): they belong to .autopilot/config.meta.json,
// never to the operator's config.json.
const META_FILENAME = "config.meta.json";
const ROLE_META_FIELDS = ["model_source", "model_verified_at", "capabilities_verified_at"];
// Fields that belonged exclusively to the removed certification/admission
// platform. They are dropped on migration, never carried forward, and never
// written into a newly generated config.
const REMOVED_CAPABILITY_FIELDS = ["certification", "execution_plane_safety"];
// Backlog #52 final review: any policy token value above this is cumulative-era — no genuine per-turn operator setting exceeds it (the largest per-turn default is the 200K planner cap).
const CUMULATIVE_TOKEN_THRESHOLD = 300_000;
// Lossless migration (spec rule 8: the reader still accepts old names for one
// release): operator-added keys that belong to no section are genuine operator
// data, not shipped/legacy defaults, so migration carries them through rather
// than silently dropping them. Late v4 validation flags them as unknown.
const KNOWN_RUNTIME_TOP_KEYS = new Set(["$schema", "schema_version", "project", "roles", "policy", "execution", "workflow", "gates", "planning", "capabilities", "safety", "freeModelAutoFallback", "config_metadata"]);
const KNOWN_PROJECT_KEYS = new Set(["repo", "planning_framework", "state_file", "runs_dir"]);
const KNOWN_EXECUTION_KEYS = new Set(["runtime_mode", "wsl_distro"]);

function versionNumber(version) {
  const match = String(version || "0.0").match(/^(\d+)\.(\d+)$/);
  return match ? Number(match[1]) * 100 + Number(match[2]) : 0;
}

function normalizeFallbackEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
  const out = {
    adapter: entry.cli || entry.adapter || "",
    model: entry.model ?? "",
  };
  if (entry.reasoning !== undefined && entry.reasoning !== "") out.reasoning = entry.reasoning;
  if (entry.variant !== undefined && entry.variant !== "") out.variant = entry.variant;
  return out;
}

function normalizeRole(role = {}, roleName = "") {
  const out = {
    adapter: role.cli || role.adapter || "",
    model: role.model ?? "",
    reasoning: role.reasoning ?? "",
    variant: role.variant ?? "",
    // The implementer's default is a fresh session after a cap (the hand-off
    // note carries the context); every other role defaults to resuming.
    resume: role.resume_session !== undefined
      ? role.resume_session !== false
      : role.resume !== undefined
        ? role.resume !== false
        : roleName !== "implementer",
    model_source: role.model_source || "unknown",
    model_verified_at: role.model_verified_at || null,
    capabilities_verified_at: role.capabilities_verified_at || null
  };
  // Per-role fallback models (mission 087): preserve the ordered fallbacks
  // list only when the input role declares it. Roles without `fallbacks`
  // are emitted unchanged (no key added), so migration never marks them
  // changed for this reason. Entries keep declared order; validation
  // (not migration) rejects invalid entries.
  if ("fallbacks" in role) {
    out.fallbacks = Array.isArray(role.fallbacks)
      ? role.fallbacks.map(normalizeFallbackEntry)
      : role.fallbacks;
  }
  // Pending #22: optional one-round escalation model, kept verbatim.
  if ("escalation_model" in role) out.escalation_model = role.escalation_model;
  return out;
}

// Normalizes a pre-v4 (legacy runtime-shaped) config in memory: role shape,
// policy backfills, shipped/legacy-default rewrites, caps, planning,
// capabilities. Returns the legacy runtime shape plus the migration flags.
function migrateLegacyRuntime(input, existingMeta = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Autopilot config must be a JSON object.");
  const incoming = String(input.schema_version || "1.0");
  if (versionNumber(incoming) > versionNumber(CURRENT_SCHEMA)) {
    throw new Error(`Config schema ${incoming} is newer than this Autopilot (${CURRENT_SCHEMA}). Upgrade Autopilot before using this config.`);
  }
  let changed = incoming !== CURRENT_SCHEMA;
  const out = structuredClone(input);
  out.schema_version = CURRENT_SCHEMA;
  // Merge config_metadata from meta file (for marker persistence across setup rewrites)
  const metaConfigMetadata = isObject(existingMeta.config_metadata) ? existingMeta.config_metadata : {};
  out.config_metadata = {
    ...(out.config_metadata || {}),
    ...metaConfigMetadata,
    migrated_from: out.config_metadata?.migrated_from || metaConfigMetadata.migrated_from || (incoming !== CURRENT_SCHEMA ? incoming : CURRENT_SCHEMA),
    last_migrated_at: new Date().toISOString()
  };
  if (!input.config_metadata || input.schema_version !== CURRENT_SCHEMA) changed = true;
  out.roles = out.roles || {};
  // Merge role meta fields from meta file
  const metaRoles = isObject(existingMeta.roles) ? existingMeta.roles : {};
  for (const role of ROLES) {
    const next = normalizeRole(out.roles[role], role);
    if (metaRoles[role]) {
      for (const field of ROLE_META_FIELDS) {
        if (has(metaRoles[role], field)) next[field] = metaRoles[role][field];
      }
    }
    if (JSON.stringify(next) !== JSON.stringify(out.roles[role] || {})) changed = true;
    out.roles[role] = next;
  }
  out.policy = out.policy || {};
  if (!out.policy.failure_budgets) {
    out.policy.failure_budgets = {
      implementationFailureBudget: 4,
      verificationFailureBudget: 4,
      adapterRetryBudget: 3,
      infrastructureRetryBudget: 3
    };
    changed = true;
  }
  // Per-task caps (003#15/003#17): backfilled when absent so the operator can
  // SEE the effective values in config.json (operator decision 2026-09-29).
  // The numbers come from the code constants in per-task-budget.mjs — the
  // single source of the defaults; operator-set values are never overwritten.
  if (out.policy.per_task_max_turns == null) { out.policy.per_task_max_turns = PER_TASK_MAX_TURNS_DEFAULT; changed = true; }
  // Backlog #59(b): the shipped 22 is the old default, not an operator value —
  // rewrite it to the current code default; any other value is kept.
  if (out.policy.per_task_max_turns === LEGACY_MAX_TURNS_DEFAULT && PER_TASK_MAX_TURNS_DEFAULT !== LEGACY_MAX_TURNS_DEFAULT) { out.policy.per_task_max_turns = PER_TASK_MAX_TURNS_DEFAULT; changed = true; }
  // Backlog #111: the previous default 30 is upgraded to the new default (40);
  // any other value is an operator choice and stays.
  // One-time: gated on config_metadata.defaults_111_applied so an operator who
  // deliberately sets 30 after this upgrade is never overwritten again.
  const defaults111Pending = out.config_metadata?.defaults_111_applied !== true;
  if (defaults111Pending && out.policy.per_task_max_turns === PREVIOUS_MAX_TURNS_DEFAULT && PER_TASK_MAX_TURNS_DEFAULT !== PREVIOUS_MAX_TURNS_DEFAULT) { out.policy.per_task_max_turns = PER_TASK_MAX_TURNS_DEFAULT; changed = true; }
  if (out.policy.per_task_max_tokens == null) { out.policy.per_task_max_tokens = PER_TASK_MAX_TOKENS_DEFAULT; changed = true; }
  if (out.policy.continuation_allowance == null) { out.policy.continuation_allowance = CONTINUATION_ALLOWANCE_DEFAULT; changed = true; }
  if (out.policy.handoff_max_chars == null) { out.policy.handoff_max_chars = HANDOFF_MAX_CHARS_DEFAULT; changed = true; }
  if (out.policy.handoff_note_max_chars == null) { out.policy.handoff_note_max_chars = HANDOFF_NOTE_MAX_CHARS_DEFAULT; changed = true; }
  if (out.policy.handoff_wrapup_tokens == null) { out.policy.handoff_wrapup_tokens = HANDOFF_WRAPUP_TOKENS_DEFAULT; changed = true; }
  // Mission 044 Phase 1 task 1.4: rewrite shipped cumulative defaults to the
  // new per-turn defaults, preserving genuine operator values. An untouched
  // config persisted the old shipped numbers (750K cap / 690K wrap-up for the
  // implementer-scale global policy); only those exact legacy values are
  // rewritten, everything else is kept as the operator set it.
  if (out.policy.per_task_max_tokens === 750_000) { out.policy.per_task_max_tokens = PER_TASK_MAX_TOKENS_DEFAULT; changed = true; }
  if (out.policy.handoff_wrapup_tokens === 690_000) { out.policy.handoff_wrapup_tokens = HANDOFF_WRAPUP_TOKENS_DEFAULT; changed = true; }
  // Backlog #52 final review: the exact rewrites above catch only the SHIPPED
  // cumulative defaults — every other cumulative-era value (500K/950K wrap-ups,
  // 600K role caps) survived migration and failed validatePolicyConfig, so
  // setup could not save the migrated config. Above CUMULATIVE_TOKEN_THRESHOLD
  // a token value is cumulative-era by definition (see the constant), so it is
  // replaced with the matching per-turn default; anything at or below it is a
  // genuine per-turn operator value and is kept.
  if (Number(out.policy.per_task_max_tokens) > CUMULATIVE_TOKEN_THRESHOLD) { out.policy.per_task_max_tokens = PER_TASK_MAX_TOKENS_DEFAULT; changed = true; }
  if (Number(out.policy.handoff_wrapup_tokens) > CUMULATIVE_TOKEN_THRESHOLD) { out.policy.handoff_wrapup_tokens = HANDOFF_WRAPUP_TOKENS_DEFAULT; changed = true; }
  if (out.policy.no_progress_generations == null) { out.policy.no_progress_generations = NO_PROGRESS_GENERATIONS_DEFAULT; changed = true; }
  // Mission 051 Phase 1 task 1.1: backfill the final-review fix-round budget
  // default (2) so the operator can SEE the effective value in config.json.
  // Operator-set values are never overwritten (== null check only).
  if (out.policy.final_review_fix_rounds == null) { out.policy.final_review_fix_rounds = FINAL_REVIEW_FIX_ROUNDS_DEFAULT; changed = true; }
  // Mission 047 Phase 2 task 2.1: backfill the policy-level cumulative
  // raw-token backstop default (6M) so the operator can SEE the effective
  // value in config.json. Operator-set values — including an explicit 6M —
  // are never overwritten (== null check only); per-role
  // policy.caps.<role>.backstop_raw_tokens overrides are preserved untouched
  // by the role-caps loop below (spread keeps unknown fields, and no
  // cumulative-era rewrite targets the backstop key: multi-million values
  // are the normal case there, never leftovers).
  if (out.policy.backstop_raw_tokens == null) { out.policy.backstop_raw_tokens = BACKSTOP_RAW_TOKENS_DEFAULT; changed = true; }
  // Backlog #41 (TASK-35): backfill the idle-hang default FITTED to the
  // effective per-task deadline (same derivation config-validation
  // enforces), never a bare 600000: a project with a short
  // per_task_timeout_ms would otherwise migrate into a config that fails
  // validation on the next load. resolveIdleHangMs() with an empty policy
  // computes exactly that fitted default (0 = off when nothing fits).
  // Operator-set values are never overwritten (== null check above).
  if (out.policy.idle_hang_ms == null) {
    const rawRelay = Number(out.policy.relay_timeout_ms);
    const effectiveRelay = Number.isInteger(rawRelay) && rawRelay > 0 ? rawRelay : RELAY_TIMEOUT_DEFAULT_MS;
    const rawPerTask = Number(out.policy.per_task_timeout_ms);
    const effectivePerTask = Number.isInteger(rawPerTask) && rawPerTask > 0
      ? rawPerTask
      : Math.min(PER_TASK_TIMEOUT_DEFAULT_MS, effectiveRelay - 1);
    out.policy.idle_hang_ms = resolveIdleHangMs({}, effectivePerTask);
    changed = true;
  }
  // Per-role caps (mission 031 Phase 1 task 1.3): backfill policy.caps for
  // review roles so the operator can SEE the effective values in config.json.
  // The numbers come from PER_ROLE_CAPS_DEFAULT and PER_ROLE_WRAPUP_TOKENS_DEFAULT
  // in per-task-budget.mjs — the single source of defaults. Operator-set values
  // are never overwritten (== null checks only). Implementer is NOT included in
  // caps — it uses the existing policy.per_task_max_turns / per_task_max_tokens.
  out.policy.caps = out.policy.caps || {};
  const reviewRoles = ["planner", "plan_reviewer", "code_reviewer", "verifier"];
  // Mission 044 Phase 1 task 1.4: same legacy rewrite as mergeRoleCaps() —
  // shipped cumulative caps (planner 1M/950K, other review roles 500K/450K)
  // become the per-turn defaults; operator values are never overwritten.
  const legacyCaps = {
    planner: {max_tokens: 1_000_000, wrap_up_tokens_threshold: 950_000},
    plan_reviewer: {max_tokens: 500_000, wrap_up_tokens_threshold: 450_000},
    code_reviewer: {max_tokens: 500_000, wrap_up_tokens_threshold: 450_000},
    verifier: {max_tokens: 500_000, wrap_up_tokens_threshold: 450_000},
  };
  for (const role of reviewRoles) {
    const roleCaps = out.policy.caps[role] || {};
    if (roleCaps.max_tokens === legacyCaps[role].max_tokens) { roleCaps.max_tokens = PER_ROLE_CAPS_DEFAULT[role].maxTokens; changed = true; }
    if (roleCaps.wrap_up_tokens_threshold === legacyCaps[role].wrap_up_tokens_threshold) { roleCaps.wrap_up_tokens_threshold = PER_ROLE_WRAPUP_TOKENS_DEFAULT[role]; changed = true; }
    // Backlog #52 final review: same cumulative-era rule as the global keys —
    // any review-role cap above the threshold is a leftover, not an operator value.
    if (Number(roleCaps.max_tokens) > CUMULATIVE_TOKEN_THRESHOLD) { roleCaps.max_tokens = PER_ROLE_CAPS_DEFAULT[role].maxTokens; changed = true; }
    if (Number(roleCaps.wrap_up_tokens_threshold) > CUMULATIVE_TOKEN_THRESHOLD) { roleCaps.wrap_up_tokens_threshold = PER_ROLE_WRAPUP_TOKENS_DEFAULT[role]; changed = true; }
    const defaultCaps = PER_ROLE_CAPS_DEFAULT[role];
    const defaultWrapup = PER_ROLE_WRAPUP_TOKENS_DEFAULT[role];
    if (roleCaps.max_turns == null && defaultCaps?.maxTurns != null) { roleCaps.max_turns = defaultCaps.maxTurns; changed = true; }
    // Backlog #59(b): shipped 22 on a role whose default moved (verifier) → new default.
    if ((role !== "plan_reviewer" || defaults111Pending) && roleCaps.max_turns === LEGACY_MAX_TURNS_DEFAULT && defaultCaps?.maxTurns != null && defaultCaps.maxTurns !== LEGACY_MAX_TURNS_DEFAULT) { roleCaps.max_turns = defaultCaps.maxTurns; changed = true; }
    if (roleCaps.max_tokens == null && defaultCaps?.maxTokens != null) { roleCaps.max_tokens = defaultCaps.maxTokens; changed = true; }
    if (roleCaps.extra_sessions == null && defaultCaps?.extraSessions != null) { roleCaps.extra_sessions = defaultCaps.extraSessions; changed = true; }
    if (roleCaps.wrap_up_tokens_threshold == null && defaultWrapup != null) { roleCaps.wrap_up_tokens_threshold = defaultWrapup; changed = true; }
    if (Object.keys(roleCaps).length > 0) out.policy.caps[role] = roleCaps;
  }
  // Backlog #52 final review, backstop: a kept operator value can still make
  // the policy invalid — a wrap-up at/above its cap, or a non-planner role cap
  // at/above the global ceiling. Degrade the offending value to its default so
  // migrateConfig never returns a config validatePolicyConfig rejects (the
  // comparisons mirror validatePolicyConfig exactly, planner and plan_reviewer
  // exempt from the global-ceiling check like they are there).
  const effectiveCeiling = Number.isInteger(out.policy.per_task_max_tokens) && out.policy.per_task_max_tokens > 0
    ? out.policy.per_task_max_tokens
    : PER_TASK_MAX_TOKENS_DEFAULT;
  const policyWrapup = Number(out.policy.handoff_wrapup_tokens);
  if (Number.isInteger(policyWrapup) && policyWrapup > 0 && policyWrapup >= effectiveCeiling) {
    out.policy.handoff_wrapup_tokens = HANDOFF_WRAPUP_TOKENS_DEFAULT;
    changed = true;
  }
  for (const role of reviewRoles) {
    const roleCaps = out.policy.caps?.[role];
    if (!roleCaps || typeof roleCaps !== "object" || Array.isArray(roleCaps)) continue;
    if (role !== "planner" && role !== "plan_reviewer") {
      const capTokens = Number(roleCaps.max_tokens);
      if (Number.isInteger(capTokens) && capTokens > 0 && capTokens >= effectiveCeiling) {
        roleCaps.max_tokens = PER_ROLE_CAPS_DEFAULT[role].maxTokens;
        changed = true;
      }
    }
    const effectiveRoleCap = Number(roleCaps.max_tokens);
    const roleWrapup = Number(roleCaps.wrap_up_tokens_threshold);
    if (Number.isInteger(roleWrapup) && roleWrapup > 0
      && Number.isInteger(effectiveRoleCap) && effectiveRoleCap > 0
      && roleWrapup >= effectiveRoleCap) {
      roleCaps.wrap_up_tokens_threshold = PER_ROLE_WRAPUP_TOKENS_DEFAULT[role];
      changed = true;
    }
  }
  if ("max_fix_attempts_per_task" in out.policy || "max_total_failures" in out.policy) changed = true;
  delete out.policy.max_fix_attempts_per_task;
  delete out.policy.max_total_failures;

  // TASK-38: backfill the planning section and the verify denylist default
  // (operator-set values are never overwritten — == null checks only).
  out.planning = out.planning || {};
  if (out.planning.verify_denylist == null) { out.planning.verify_denylist = []; changed = true; }
  if (JSON.stringify(out.planning) !== JSON.stringify(input.planning || {})) changed = true;

  const capabilityInput = out.capabilities || {};
  const migratedLegacyInference = versionNumber(incoming) < versionNumber(CURRENT_SCHEMA);
  const hadRemovedFields = REMOVED_CAPABILITY_FIELDS.some(field => field in capabilityInput);
  out.capabilities = {
    project_defaults: capabilityInput.project_defaults || [],
    role_requirements: capabilityInput.role_requirements || {},
    safety_denied: capabilityInput.safety_denied || [],
    legacy_text_inference: capabilityInput.legacy_text_inference ?? migratedLegacyInference,
    verification: {
      browser: "native",
      require_browser: "when-task-requires",
      ...(capabilityInput.verification || {})
    }
    // certification and execution_plane_safety are intentionally NOT carried
    // forward: they belonged to the removed adapter-certification/admission
    // platform. Dropping them never requires recertification (there is
    // nothing left to certify) and never blocks setup/config/run.
  };
  if (JSON.stringify(out.capabilities) !== JSON.stringify(capabilityInput)) changed = true;
  if (!input.capabilities) changed = true;
  if (defaults111Pending) { out.config_metadata = {...out.config_metadata, defaults_111_applied: true}; changed = true; }
  if (hadRemovedFields) out.config_metadata.certification_fields_removed_at = new Date().toISOString();
  return {runtime: out, changed, from: incoming, removedCertificationFields: hadRemovedFields};
}

function isObject(value) {
  return value !== null && typeof value !== "undefined" && typeof value === "object" && !Array.isArray(value);
}

function has(obj, key) {
  return isObject(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

// A file is already v4 when it says so or carries a v4-only marker. Setup keeps
// writing the legacy "3.0" shape until 4.1 (below), so a legacy file is never
// mistaken for v4.
function isV4Config(input, incoming) {
  if (versionNumber(incoming) >= versionNumber(CURRENT_SCHEMA)) return true;
  return has(input, "$schema") || has(input, "time_limits") || (isObject(input.caps) && !isObject(input.policy));
}

// Pulls the machine-written fields out of the runtime shape: config_metadata
// plus each role's model_source / *_verified_at. They move to config.meta.json.
function extractMeta(runtime) {
  const roles = {};
  for (const role of ROLES) {
    const entry = {};
    const source = isObject(runtime.roles) ? runtime.roles[role] : null;
    if (!isObject(source)) continue;
    for (const field of ROLE_META_FIELDS) if (has(source, field)) entry[field] = source[field];
    if (Object.keys(entry).length) roles[role] = entry;
  }
  const meta = {};
  if (isObject(runtime.config_metadata)) meta.config_metadata = runtime.config_metadata;
  if (Object.keys(roles).length) meta.roles = roles;
  return meta;
}

// Migrates any pre-v4 config to the v4 layout. A v4 config is returned
// unchanged (byte-for-byte equivalent object). The returned `config` IS the v4
// layout; `loadAndMigrateConfig` adapts it to the runtime shape.
export function migrateConfig(input, existingMeta = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Autopilot config must be a JSON object.");
  const incoming = String(input.schema_version || "1.0");
  if (versionNumber(incoming) > versionNumber(CURRENT_SCHEMA)) {
    throw new Error(`Config schema ${incoming} is newer than this Autopilot (${CURRENT_SCHEMA}). Upgrade Autopilot before using this config.`);
  }
  if (isV4Config(input, incoming)) {
    // Old-name compatibility: a v4 file written before the rename still
    // carries `time_limits.mission_timeout_minutes`; migration rewrites it to
    // `call_backstop_minutes` (and then persists/backs up the file).
    const renamed = migrateTimeLimitNames(input);
    // Backlog #099 follow-up: the old `workflow.approve_plan_myself` key is
    // dropped in memory (value ignored) and never arms the new pause. Unlike
    // the time-limit rename this is not reported as a migration change; `ap
    // config fill` is what removes it from the file.
    const planApproval = migratePlanApprovalKey(renamed.layout);
    const v4Layout = planApproval.layout;
    // For v4 configs, machine-written fields are in config.meta.json, not in the
    // config file itself. Merge existingMeta (from meta file) with any meta
    // extracted from the config (should be empty for true v4).
    const extractedMeta = extractMeta(v4Layout);
    const mergedMeta = {
      config_metadata: {...(extractedMeta.config_metadata || {}), ...(existingMeta.config_metadata || {})},
      roles: {...(extractedMeta.roles || {}), ...(existingMeta.roles || {})}
    };
    // Clean up empty objects.
    if (!Object.keys(mergedMeta.config_metadata).length) delete mergedMeta.config_metadata;
    if (!Object.keys(mergedMeta.roles).length) delete mergedMeta.roles;
    return {config: v4Layout, layout: v4Layout, changed: renamed.changed, from: incoming, to: CURRENT_SCHEMA, meta: mergedMeta, removedCertificationFields: false};
  }
  const legacy = migrateLegacyRuntime(input, existingMeta);
  const meta = extractMeta(legacy.runtime);
  // Backlog #099 follow-up: plans continue without a pause by default in v4.
  // A pre-v4 config's `workflow.autoApprovePlan` was the old pause switch and
  // is ignored entirely, so dropping it lets the upgraded config take the new
  // `pause_for_plan_approval:false` default. Only an explicit v4
  // `pause_for_plan_approval:true` arms the pause.
  if (isObject(legacy.runtime.workflow)) delete legacy.runtime.workflow.autoApprovePlan;
  const layout = toNewLayoutConfig(legacy.runtime);
  layout.schema_version = CURRENT_SCHEMA;
  // Never fabricate a runtime section the operator never set: toNewLayoutConfig
  // backfills mode/wsl_distro from DEFAULTS, but migration preserves only
  // genuine operator values (shipped/legacy defaults are dropped). Without
  // this, toRuntimeConfig restored an `execution` the operator never wrote,
  // and setup mistook the fabricated default for a saved runtime mode.
  const legacyExecution = isObject(input.execution) ? input.execution : {};
  if (!has(legacyExecution, "runtime_mode") && !has(legacyExecution, "wsl_distro")) {
    layout.runtime = {};
  }
  // Lossless migration: carry operator-added keys through into the layout (see
  // KNOWN_RUNTIME_TOP_KEYS). The reverse happens in loadAndMigrateConfig.
  for (const [key, value] of Object.entries(legacy.runtime)) {
    if (!KNOWN_RUNTIME_TOP_KEYS.has(key)) layout[key] = value;
  }
  for (const [key, value] of Object.entries(isObject(legacy.runtime.project) ? legacy.runtime.project : {})) {
    if (!KNOWN_PROJECT_KEYS.has(key)) layout.project[key] = value;
  }
  for (const [key, value] of Object.entries(legacyExecution)) {
    if (!KNOWN_EXECUTION_KEYS.has(key)) layout.runtime[key] = value;
  }
  // Machine-written role metadata never lands in the user's file.
  for (const role of ROLES) {
    const entry = layout.roles?.[role];
    if (!isObject(entry)) continue;
    for (const field of ROLE_META_FIELDS) delete entry[field];
  }
  // config_metadata is machine-written; it belongs in config.meta.json, not the user's config.json.
  delete layout.config_metadata;
  return {config: layout, layout, changed: legacy.changed, from: legacy.from, to: CURRENT_SCHEMA, meta, removedCertificationFields: legacy.removedCertificationFields};
}

// Loads the file and migrates it. The returned `config` is the legacy runtime
// shape the rest of the code reads (toRuntimeConfig is lossless for
// operator-added keys); `layout` is the persisted v4 layout.
export function loadAndMigrateConfig(configPath, {persist = true} = {}) {
  if (!fs.existsSync(configPath)) return {config: null, layout: null, changed: false, from: null, to: CURRENT_SCHEMA, backupPath: null, metaPath: null};
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  
  // Read config.meta.json if it exists, to preserve machine-written fields
  // across migrations and setup rewrites.
  const metaPath = path.join(path.dirname(configPath), META_FILENAME);
  let existingMeta = {};
  if (fs.existsSync(metaPath)) {
    try { existingMeta = JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch { existingMeta = {}; }
  }
  
  const result = migrateConfig(raw, existingMeta);
  // Keep the migrated (not yet filled) layout so readers that distinguish
  // operator values from defaults (ap config show) do not mistake every filled
  // default for a value written in config.json.
  const sourceLayout = result.layout;
  // Legacy migrations land a complete v4 file: every absent default key is
  // filled (the converted layout keeps `runtime` empty when the operator never
  // set it) and `$schema` is written for the real config path so editors
  // resolve it from `.autopilot/`. v4 files are left to `ap config fill`.
  if (result.changed && result.from !== CURRENT_SCHEMA) {
    result.config = fillLayout(result.config, configPath);
    result.layout = result.config;
  }
  let backupPath = null;
  if (result.changed && persist) {
    // Back up the user's file first, then move machine-written data out.
    backupPath = `${configPath}.bak-${Date.now()}`;
    fs.copyFileSync(configPath, backupPath);
    if (result.meta && (result.meta.config_metadata || Object.keys(result.meta.roles || {}).length)) {
      let merged = {...existingMeta};
      if (result.meta.config_metadata) merged.config_metadata = {...(isObject(merged.config_metadata) ? merged.config_metadata : {}), ...result.meta.config_metadata};
      if (Object.keys(result.meta.roles || {}).length) merged.roles = {...(isObject(merged.roles) ? merged.roles : {}), ...result.meta.roles};
      const metaTemporary = `${metaPath}.tmp-${process.pid}`;
      fs.writeFileSync(metaTemporary, `${JSON.stringify(merged, null, 2)}\n`);
      fs.renameSync(metaTemporary, metaPath);
    }
    const temporary = `${configPath}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(result.config, null, 2)}\n`);
    fs.renameSync(temporary, configPath);
  }
  // The caller keeps the legacy runtime shape; `layout` is the persisted v4
  // layout (feeds the schema/`ap config show`/WATCH-REPORT in later tasks).
  const layout = result.config;
  const runtimeConfig = layout ? toRuntimeConfig(layout) : null;
  // Merge machine-written meta fields back into runtime config so they survive
  // setup rewrites and marker checks (e.g., defaults_111_applied).
  if (runtimeConfig && (existingMeta.config_metadata || Object.keys(existingMeta.roles || {}).length)) {
    if (existingMeta.config_metadata) runtimeConfig.config_metadata = {...(runtimeConfig.config_metadata || {}), ...existingMeta.config_metadata};
    if (isObject(existingMeta.roles) && isObject(runtimeConfig.roles)) {
      for (const role of ROLES) {
        if (existingMeta.roles[role]) {
          runtimeConfig.roles[role] = {...(runtimeConfig.roles[role] || {}), ...existingMeta.roles[role]};
        }
      }
    }
  }
  return {...result, config: runtimeConfig, layout, sourceLayout, backupPath, metaPath};
}
