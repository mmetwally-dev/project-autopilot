// Per-role fallback decision — pure contract module.
//
// Maps (role config, sticky active state, failure class) to "switch to the
// next fallback" or "escalate". Only a run classified RATE_LIMITED (or
// quota-exhausted reported under that class) may switch; every other failure
// class returns `{action: "none"}` so the caller keeps today's behavior.
//
// Deliberately pure:
// - no imports of any kind (no filesystem, process, network, state, or
//   config modules) — takes values in, returns a decision object out;
// - never mutates its inputs; returned entries are fresh copies.
//
// Shapes:
// - roleConfig: `{adapter, model, reasoning?, variant?, fallbacks?: [...]}`.
//   Each fallback entry is `{adapter, model, reasoning?, variant?}` in
//   declared order (index 0 is tried first).
// - activeModel: `null`/`undefined` (role still on its primary) or the
//   sticky entry currently in effect (as persisted in
//   `s.activeRoleModels[role]` by the runtime wiring).
// - failureClass: the classified failure class string (e.g. "RATE_LIMITED").

export const RATE_LIMITED_FAILURE_CLASS = "RATE_LIMITED";
export const IDLE_HANG_FAILURE_CLASS = "IDLE_HANG";
export const PROVIDER_ERROR_FAILURE_CLASS = "PROVIDER_ERROR";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function copyModelEntry(entry) {
  if (!isRecord(entry)) return null;
  const out = {};
  if (entry.adapter !== undefined) out.adapter = entry.adapter;
  if (entry.model !== undefined) out.model = entry.model;
  if (entry.reasoning !== undefined) out.reasoning = entry.reasoning;
  if (entry.variant !== undefined) out.variant = entry.variant;
  return out;
}

function primaryOf(roleConfig) {
  if (!isRecord(roleConfig)) return null;
  return copyModelEntry(roleConfig);
}

function fallbackListOf(roleConfig) {
  if (!isRecord(roleConfig) || !Array.isArray(roleConfig.fallbacks)) return [];
  return roleConfig.fallbacks.filter(isRecord).map(copyModelEntry);
}

function sameModelEntry(a, b) {
  if (!isRecord(a) || !isRecord(b)) return false;
  return a.adapter === b.adapter
    && a.model === b.model
    && (a.reasoning ?? null) === (b.reasoning ?? null)
    && (a.variant ?? null) === (b.variant ?? null);
}

// Backlog #42: opencode model ids already carry their provider prefix
// (`opencode/beam-free`), so `${adapter}/${model}` must never be applied
// blindly — that produced `opencode/opencode/beam-free` in exhausted-model
// keys and config-change comparisons. One canonical spelling everywhere.
function canonicalModelId(entry) {
  if (!isRecord(entry)) return null;
  const adapter = entry.adapter ?? "";
  const model = entry.model ?? "";
  if (!adapter && !model) return null;
  return model.startsWith(`${adapter}/`) ? model : `${adapter}/${model}`;
}

function describeModel(entry) {
  return canonicalModelId(entry) ?? "unconfigured";
}

// Resolve the effective adapter/model/reasoning/variant for a role: the
// sticky active entry when present, otherwise the primary. Returns a fresh
// copy (or null when the role config itself is missing).
export function resolveEffectiveRoleModel(roleConfig, activeModel = null) {
  if (isRecord(activeModel)) return copyModelEntry(activeModel);
  return primaryOf(roleConfig);
}

// Backlog #18: mission-wide list of models a role already found RATE_LIMITED.
// Shape: `{ "<adapter>/<model>": {at: ISO, reason: "RATE_LIMITED", by: role} }`.
// An entry stays active for the same retry window as the sticky fallback
// (policy.fallback_retry_primary_minutes, default 60 min), so every role skips
// a model another role already paid a failed run for.
const modelKey = (entry) => canonicalModelId(entry);

function retryWindowMinutes(policy) {
  const mins = Number(policy?.fallback_retry_primary_minutes);
  return Number.isFinite(mins) && mins > 0 ? mins : FALLBACK_RETRY_PRIMARY_MINUTES;
}

// Record a RATE_LIMITED model in the mission map. Returns a fresh map; the
// input is never mutated.
export function markExhausted(map, entry, role, nowIso) {
  const out = isRecord(map) ? {...map} : {};
  const key = modelKey(entry);
  if (!key) return out;
  out[key] = {
    at: typeof nowIso === "string" ? nowIso : new Date().toISOString(),
    reason: RATE_LIMITED_FAILURE_CLASS,
    by: typeof role === "string" && role ? role : "unknown",
  };
  return out;
}

// True while the entry exists and is younger than the retry window.
export function isExhausted(map, entry, policy, nowMs = Date.now()) {
  if (!isRecord(map) || !isRecord(entry)) return false;
  const record = map[modelKey(entry)];
  if (!isRecord(record)) return false;
  const at = Date.parse(record.at);
  if (!Number.isFinite(at)) return false;
  return nowMs - at < retryWindowMinutes(policy) * 60000;
}

// Drop expired entries. Returns a fresh map; the input is never mutated.
export function pruneExhausted(map, policy, nowMs = Date.now()) {
  const out = {};
  if (!isRecord(map)) return out;
  for (const [key, record] of Object.entries(map)) {
    if (!isRecord(record)) continue;
    const at = Date.parse(record.at);
    if (!Number.isFinite(at)) continue;
    if (nowMs - at < retryWindowMinutes(policy) * 60000) out[key] = record;
  }
  return out;
}

// Pre-run skip: when the effective model is exhausted and a later fallback is
// still usable, return a switch decision WITHOUT spending a run on the
// exhausted model. When the effective model is fine, or every remaining
// candidate is exhausted too, return `{action: "none"}` so today's run (and
// its failure/escalation path) happens unchanged.
export function skipExhaustedRoleModel({role, roleConfig, activeModel = null, exhausted = null, policy = null, nowMs = Date.now()} = {}) {
  const effective = resolveEffectiveRoleModel(roleConfig, activeModel);
  if (!isExhausted(exhausted, effective, policy, nowMs)) {
    return {action: "none", reason: `${role || "unknown"}: effective model is not exhausted`};
  }
  const primary = primaryOf(roleConfig);
  const fallbacks = fallbackListOf(roleConfig);
  let currentIndex = 0;
  if (isRecord(activeModel)) {
    if (primary && sameModelEntry(activeModel, primary)) {
      currentIndex = 0;
    } else {
      const found = fallbacks.findIndex((entry) => sameModelEntry(entry, activeModel));
      currentIndex = found === -1 ? 0 : found + 1;
    }
  }
  const next = fallbacks.slice(currentIndex).find((entry) => !isExhausted(exhausted, entry, policy, nowMs)) ?? null;
  if (!next) {
    return {action: "none", reason: `${role || "unknown"}: effective model exhausted and no fallback is usable`};
  }
  return {
    action: "switch",
    next,
    reason: `${role || "unknown"}: effective model ${describeModel(effective)} exhausted; switch to ${describeModel(next)}`,
  };
}

// Decide what a classified relay failure means for per-role fallback.
//
// Signature: `decideRoleFallback({role, roleConfig, activeModel, failureClass})`.
// - `role`: role name string (used in reasons and the log line only).
// - `roleConfig`: primary + ordered `fallbacks` (see above).
// - `activeModel`: sticky entry currently in effect, or null for primary.
// - `failureClass`: classified failure class string.
// - `exhausted` / `policy` / `nowMs` (optional): mission-wide exhausted map
//   (backlog #18); active fallbacks are skipped in the chain walk.
//
// Returns a decision object — never a boolean:
// - `{action: "switch", next, reason}` — RATE_LIMITED with an untried
//   fallback left: run the same run at once on `next` (fresh copy).
// - `{action: "escalate", reason}` — RATE_LIMITED with no fallback left
//   (or no fallbacks configured): keep today's escalate-and-stop.
// - `{action: "none", reason}` — any non-RATE_LIMITED class: no switch,
//   caller behavior unchanged.
//
// IDLE_HANG with `noOutput: true` (the run produced 0 bytes for its whole
// life) is treated like RATE_LIMITED for the switch (sticky, next untried
// fallback) but, with nothing left to switch to, returns `{action: "none"}`
// (today's retry-same-model behavior) instead of escalating. IDLE_HANG after
// output, or without the flag, is always `{action: "none"}`.
export function decideRoleFallback({role, roleConfig, activeModel = null, failureClass, noOutput = false, exhausted = null, policy = null, nowMs = Date.now()} = {}) {
  const name = typeof role === "string" && role ? role : "unknown";
  const silentHang = failureClass === IDLE_HANG_FAILURE_CLASS && noOutput === true;
  const providerError = failureClass === PROVIDER_ERROR_FAILURE_CLASS;
  if (failureClass !== RATE_LIMITED_FAILURE_CLASS && !silentHang && !providerError) {
    return {
      action: "none",
      reason: `${name}: failure class ${String(failureClass)} is not RATE_LIMITED; no fallback switch`,
    };
  }
  const fallbacks = fallbackListOf(roleConfig);
  const label = silentHang ? "IDLE_HANG (no output)" : providerError ? "PROVIDER_ERROR" : "RATE_LIMITED";
  if (fallbacks.length === 0) {
    if (silentHang) {
      return {action: "none", reason: `${name}: ${label} with no fallbacks configured; normal retry`};
    }
    return {
      action: "escalate",
      reason: `${name}: ${label} with no fallbacks configured; human intervention required`,
    };
  }
  // Sticky order: the current position is the active entry when it matches
  // a known entry, else the primary (covers null active and stale state
  // after a config change — never fail closed to escalate while an untried
  // fallback exists).
  const primary = primaryOf(roleConfig);
  let currentIndex = 0;
  if (isRecord(activeModel)) {
    if (primary && sameModelEntry(activeModel, primary)) {
      currentIndex = 0;
    } else {
      const found = fallbacks.findIndex((entry) => sameModelEntry(entry, activeModel));
      currentIndex = found === -1 ? 0 : found + 1;
    }
  }
  const next = fallbacks.slice(currentIndex).find((entry) => !isExhausted(exhausted, entry, policy, nowMs)) ?? null;
  if (!next) {
    if (silentHang) {
      return {action: "none", reason: `${name}: ${label} with all ${fallbacks.length} fallback(s) exhausted; normal retry`};
    }
    return {
      action: "escalate",
      reason: `${name}: ${label} with all ${fallbacks.length} fallback(s) exhausted; human intervention required`,
    };
  }
  const from = currentIndex === 0 ? primary : fallbacks[currentIndex - 1];
  return {
    action: "switch",
    next: copyModelEntry(next),
    reason: `${name}: ${label} on ${describeModel(from)}; switch to ${describeModel(next)}`,
  };
}

// Decide how the at-once re-run after a fallback switch launches.
//
// Same adapter session resume is only valid when the fallback runs on the
// SAME adapter (`from.adapter === to.adapter`) AND that adapter supports
// exact-session resume (`resumeSupported === true`, computed by the caller
// from the fallback adapter's declared `resume_session` args). Anything
// else starts a new session with the same brief/inputs/hand-off note.
//
// Pure like the rest of this module: `resumeSupported` is a boolean in,
// never a live adapter lookup here.
//
// Returns `{mode: "same-session"|"new-session", resume: boolean, reason}`.
// `resume` is the session flag the re-run must use; `mode` names it for
// logs and tests.
export function decideRoleFallbackRetry({from, to, resumeSupported = false} = {}) {
  const name = (isRecord(to) && typeof to.adapter === "string" && to.adapter)
    || (isRecord(from) && typeof from.adapter === "string" && from.adapter)
    || "unknown";
  const sameAdapter = isRecord(from) && isRecord(to)
    && typeof from.adapter === "string" && from.adapter !== ""
    && from.adapter === to.adapter;
  if (sameAdapter && resumeSupported === true) {
    return {
      mode: "same-session",
      resume: true,
      reason: `${name}: fallback keeps adapter ${from.adapter} with resume support; re-run resumes the same session`,
    };
  }
  const why = !sameAdapter
    ? `${name}: fallback changes adapter ${describeModel(from)} → ${describeModel(to)}; re-run starts a new session with the same brief/inputs/hand-off note`
    : `${name}: adapter ${from.adapter} has no exact-session resume support; re-run starts a new session with the same brief/inputs/hand-off note`;
  return {mode: "new-session", resume: false, reason: why};
}

// Fresh sticky fallback state for a new mission: roles start on their
// primary again. The runtime holds this map at `s.activeRoleModels`.
export function resetRoleFallbacks() {
  return {};
}

// Backlog #17: the sticky entry must not outlive its cause. It records the
// configured primary it was derived from (`derivedFrom`) and when (`since`);
// a changed primary (operator edited the config) or an entry older than the
// retry window ends it so the primary is tried again.
export const FALLBACK_RETRY_PRIMARY_MINUTES = 60;

const primaryId = (roleConfig) => canonicalModelId(roleConfig);

// Stamp a fresh sticky entry (the chosen fallback) with its provenance.
export function stampStickyFallback(next, roleConfig, nowIso) {
  const out = copyModelEntry(next);
  if (!out) return out;
  if (isRecord(roleConfig)) out.derivedFrom = {adapter: roleConfig.adapter, model: roleConfig.model};
  out.since = nowIso;
  return out;
}

// Decide whether a role's sticky entry must be cleared now. Returns null (keep)
// or `{why: "config"|"age", message}`. Legacy entries without `derivedFrom`
// are never cleared by a config change (unknown), only by age; entries without
// a parseable `since` are never cleared by age.
export function staleStickyFallback({role, roleConfig, activeModel, policy, nowMs = Date.now(), configMtimeMs = null} = {}) {
  if (!isRecord(activeModel)) return null;
  const df = activeModel.derivedFrom;
  if (isRecord(df)) {
    const was = canonicalModelId(df);
    const now = primaryId(roleConfig);
    if (now && was !== now) return {why: "config", message: `fallback cleared: ${role} config primary changed (${was} → ${now})`};
  } else {
    // Backlog #42: pre-#17 sticky entries recorded no `derivedFrom`, so a
    // primary change could never be proven. Clear one when the config file
    // was written after the fallback was selected — the operator edited the
    // config during the mission, and the current primary must win.
    const since = Date.parse(activeModel.since);
    if (Number.isFinite(since) && Number.isFinite(configMtimeMs) && configMtimeMs > since) {
      return {why: "config", message: `fallback cleared: ${role} config changed after the fallback was selected; retrying primary ${describeModel(roleConfig)}`};
    }
  }
  const mins = Number(policy?.fallback_retry_primary_minutes);
  const windowMin = Number.isFinite(mins) && mins > 0 ? mins : FALLBACK_RETRY_PRIMARY_MINUTES;
  const since = Date.parse(activeModel.since);
  if (Number.isFinite(since) && nowMs - since >= windowMin * 60000) {
    // Backlog #5: opencode model ids already carry their `opencode/`
    // provider prefix, so `${adapter}/${model}` would print it twice.
    return {why: "age", message: `fallback cleared: ${role} retrying primary ${describeModel(roleConfig)} (fallback active ${windowMin}+ min)`};
  }
  return null;
}

// Clear one role's sticky entry (e.g. operator reset mid-mission).
// Returns a fresh map; the input is never mutated.
export function clearRoleFallback(activeRoleModels, role) {
  const out = isRecord(activeRoleModels) ? {...activeRoleModels} : {};
  if (typeof role === "string") delete out[role];
  return out;
}

// Render the required run log/console line:
// `fallback: <role> <old adapter/model> → <new adapter/model> (reason)`.
// Pure string builder so wiring and tests share one format.
export function formatRoleFallbackLog({role, from, to, reason} = {}) {
  const name = typeof role === "string" && role ? role : "unknown";
  const suffix = reason ? ` (${String(reason)})` : "";
  return `fallback: ${name} ${describeModel(from)} → ${describeModel(to)}${suffix}`;
}
