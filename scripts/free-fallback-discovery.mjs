// Backlog #95: extend a role's fallback chain with other discovered opencode
// `*-free` models when the configured chain is exhausted on RATE_LIMITED (or
// the silent-hang no-output case). Wraps decideRoleFallback; never changes it.
//
// - discovery is injected (`discover(adapter) -> [{id}|string]`), so tests need
//   no opencode binary; failure/empty -> the original decision is returned;
// - only `-free` ids of the SAME adapter are ever chosen (never paid models);
// - tried models live in `s.triedFreeModels[role]` (array of "adapter/model"),
//   mission-scoped like s.activeRoleModels.
import {isFreeModel} from "./free-model.mjs";
import {resolveEffectiveRoleModel, isExhausted, canonicalModelId, RATE_LIMITED_FAILURE_CLASS, IDLE_HANG_FAILURE_CLASS, PROVIDER_ERROR_FAILURE_CLASS} from "./role-fallback.mjs";

const isRecord = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const key = (e) => `${e?.adapter}/${e?.model}`;
const OPENCODE_FREE = {free_model_pattern: "-free$"};
// Backward-compatible: opencode default pattern. Prefer isFreeModel(adapterMeta, id).
export const isFreeModelId = (id) => isFreeModel(OPENCODE_FREE, id);

function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

// Backlog #5: match a candidate free model entry ("adapter/model" or
// {adapter, model}) against roles.free_models.exclude glob patterns.
export function matchesFreeModelExclude(entry, exclude = []) {
  if (!Array.isArray(exclude) || exclude.length === 0) return false;
  const candidates = [];
  if (typeof entry === "string") {
    if (entry) candidates.push(entry);
  } else if (isRecord(entry)) {
    const canon = canonicalModelId(entry);
    if (canon) candidates.push(canon);
    const raw = key(entry);
    if (raw && !candidates.includes(raw)) candidates.push(raw);
    if (typeof entry.model === "string" && entry.model && !candidates.includes(entry.model)) candidates.push(entry.model);
  }
  if (candidates.length === 0) return false;
  for (const rawPattern of exclude) {
    if (typeof rawPattern !== "string") continue;
    const pat = rawPattern.trim();
    if (!pat) continue;
    const re = globToRegExp(pat);
    if (candidates.some((c) => re.test(c))) return true;
  }
  return false;
}

export function resetTriedFreeModels() {
  return {};
}

function isConfigured(roleConfig, entry) {
  const list = [roleConfig, ...(Array.isArray(roleConfig?.fallbacks) ? roleConfig.fallbacks : [])];
  return list.some((c) => isRecord(c) && c.adapter === entry.adapter && c.model === entry.model);
}

// `decision` is the already-computed decideRoleFallback result (unchanged
// signature/behavior for that function); returned as-is unless it is an
// exhausted escalate (or exhausted silent-hang "none") on a free model.
export async function extendFallbackWithFree({decision, role, roleConfig, activeModel = null, failureClass, noOutput = false, tried = [], discover = null, enabled = true, adapters = null, exhausted = null, policy = null, exclude = [], nowMs = Date.now()} = {}) {
  const silentHang = failureClass === IDLE_HANG_FAILURE_CLASS && noOutput === true;
  const eligible = failureClass === RATE_LIMITED_FAILURE_CLASS || failureClass === PROVIDER_ERROR_FAILURE_CLASS || silentHang;
  const effective = resolveEffectiveRoleModel(roleConfig, activeModel);
  // An auto-discovered active model is not in the configured chain; the base
  // decision would restart it from fallback #1, so ignore it and keep extending.
  const autoActive = eligible && isRecord(activeModel) && !isConfigured(roleConfig, activeModel);
  const base = autoActive ? null : decision;
  if (base && base.action !== "escalate" && !(silentHang && base.action === "none" && /exhausted/.test(base.reason || ""))) return base;
  const fail = base ?? {action: "escalate", reason: `${role}: ${failureClass} on auto-discovered ${key(effective)}; no more untried free models`};
  if (!eligible || enabled === false || typeof discover !== "function" || !effective) return fail;
  // adapters = agents.json adapter map; omitted -> legacy opencode `-free$` default.
  const metaOf = (a) => (adapters ? adapters[a] : (a === "opencode" ? OPENCODE_FREE : null));
  const meta = metaOf(effective.adapter);
  if (!isFreeModel(meta, effective.model)) return fail;
  try {
    const items = await discover(effective.adapter);
    const skip = new Set([
      ...(Array.isArray(tried) ? tried : []),
      key(effective),
      key(roleConfig),
      ...(Array.isArray(roleConfig?.fallbacks) ? roleConfig.fallbacks.map(key) : []),
    ]);
    for (const item of Array.isArray(items) ? items : []) {
      const id = typeof item === "string" ? item : item?.id;
      if (!isFreeModel(meta, id) || skip.has(`${effective.adapter}/${id}`)) continue;
      const next = {adapter: effective.adapter, model: id};
      // Backlog #5: skip free models excluded by roles.free_models.exclude.
      if (matchesFreeModelExclude(next, exclude)) continue;
      // Backlog #18: another role already found this free model exhausted.
      if (isExhausted(exhausted, next, policy, nowMs)) continue;
      return {
        action: "switch",
        next,
        autoDiscovered: true,
        reason: `${role}: ${failureClass} on ${key(effective)}; configured fallbacks exhausted; auto-discovered free model ${key(next)}`,
      };
    }
  } catch {}
  return fail;
}

// Record the model that just rate-limited in the per-role tried map (fresh copy).
export function markTriedFreeModel(triedMap, role, entry) {
  const out = isRecord(triedMap) ? {...triedMap} : {};
  const list = Array.isArray(out[role]) ? [...out[role]] : [];
  if (isRecord(entry) && !list.includes(key(entry))) list.push(key(entry));
  out[role] = list;
  return out;
}
