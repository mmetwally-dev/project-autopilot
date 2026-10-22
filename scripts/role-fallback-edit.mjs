// Per-role fallback list editing — pure contract module.
//
// Helpers for the setup wizard / `ap config` edit flows to add, remove,
// and reorder a role's ordered `fallbacks` list, warn when a reviewer
// fallback would break reviewer independence, and label quota/paid cost.
//
// Deliberately pure:
// - no imports of any kind (no filesystem, process, network, state, or
//   config modules) — takes values in, returns values out;
// - never mutates its inputs; returned entries and lists are fresh copies;
// - no I/O: no console, process, filesystem, or network access.
//
// Shapes:
// - A fallback entry is `{adapter, model, reasoning?, variant?}`.
// - A fallbacks list is an array of such entries in declared order
//   (index 0 is tried first).
// - A role config is `{adapter, model, reasoning?, variant?, ...,
//   fallbacks?: [...]}`.

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Fresh copy of one fallback entry (adapter/model/reasoning/variant only,
// so setup bookkeeping fields never leak into the persisted list).
export function copyFallbackEntry(entry) {
  if (!isRecord(entry)) return null;
  const out = {};
  if (entry.adapter !== undefined) out.adapter = entry.adapter;
  if (entry.model !== undefined) out.model = entry.model;
  if (entry.reasoning !== undefined) out.reasoning = entry.reasoning;
  if (entry.variant !== undefined) out.variant = entry.variant;
  return out;
}

// Fresh validated list: non-record entries are dropped, the rest copied.
// The input array (and its entries) are never mutated.
export function normalizeFallbackList(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(isRecord).map(copyFallbackEntry);
}

function checkIndex(index, length, name) {
  if (!Number.isInteger(index) || index < 0 || index >= length) {
    throw new RangeError(
      `${name} index ${String(index)} out of range for list of length ${length}`,
    );
  }
}

// Append `entry` after the existing entries. Returns a fresh list.
export function addFallback(list, entry) {
  const base = normalizeFallbackList(list);
  const copy = copyFallbackEntry(entry);
  if (!copy || typeof copy.adapter !== "string" || typeof copy.model !== "string") {
    throw new TypeError("addFallback requires an entry record with string adapter and model");
  }
  base.push(copy);
  return base;
}

// Remove the entry at `index`. Returns a fresh list; throws RangeError
// when the index is not a valid 0-based position.
export function removeFallbackAt(list, index) {
  const base = normalizeFallbackList(list);
  checkIndex(index, base.length, "removeFallbackAt");
  base.splice(index, 1);
  return base;
}

// Move the entry at `fromIndex` to `toIndex` (both 0-based positions in
// the original list). Returns a fresh list; throws RangeError when either
// index is out of range.
export function moveFallback(list, fromIndex, toIndex) {
  const base = normalizeFallbackList(list);
  checkIndex(fromIndex, base.length, "moveFallback from");
  checkIndex(toIndex, base.length, "moveFallback to");
  const [entry] = base.splice(fromIndex, 1);
  base.splice(toIndex, 0, entry);
  return base;
}

// Apply an edited fallbacks list to a role config. Returns a fresh role
// config object; the input is never mutated. An empty (or missing) list
// maps to key removal: the returned object has no `fallbacks` key.
export function applyFallbacks(roleConfig, fallbacks) {
  const out = isRecord(roleConfig) ? {...roleConfig} : {};
  const next = normalizeFallbackList(fallbacks);
  if (next.length === 0) {
    delete out.fallbacks;
  } else {
    out.fallbacks = next;
  }
  return out;
}

// Reviewer-independence counterpart pairs: a reviewer fallback that runs
// on the same adapter/model as the role it reviews (primary or any
// fallback) breaks independence. The map covers both directions so the
// warning fires whichever side of the pair is being edited.
export const REVIEWER_COUNTERPARTS = {
  code_reviewer: "implementer",
  implementer: "code_reviewer",
  plan_reviewer: "planner",
  planner: "plan_reviewer",
};

function sameAdapterModel(a, b) {
  return isRecord(a) && isRecord(b)
    && typeof a.adapter === "string"
    && typeof b.adapter === "string"
    && typeof a.model === "string"
    && typeof b.model === "string"
    && a.adapter === b.adapter
    && a.model === b.model;
}

function primaryAndFallbacks(roleConfig) {
  if (!isRecord(roleConfig)) return [];
  const entries = [copyFallbackEntry(roleConfig)];
  if (Array.isArray(roleConfig.fallbacks)) {
    for (const entry of roleConfig.fallbacks) {
      if (isRecord(entry)) entries.push(copyFallbackEntry(entry));
    }
  }
  return entries;
}

// Warn when `candidate` (a proposed fallback entry for `role`) runs on the
// same adapter/model as the counterpart role's primary or any of its
// fallbacks. Returns the warning string, or null when there is nothing to
// warn about (unpaired role, missing counterpart config, or no match).
export function reviewerIndependenceWarning({role, candidate, roles} = {}) {
  const counterpart = REVIEWER_COUNTERPARTS[role];
  if (!counterpart) return null;
  if (!sameAdapterModel(candidate, candidate)) return null;
  const other = isRecord(roles) ? roles[counterpart] : null;
  if (!other) return null;
  const match = primaryAndFallbacks(other).some((entry) => sameAdapterModel(entry, candidate));
  if (!match) return null;
  return (
    `warning: ${role} fallback ${candidate.adapter}/${candidate.model} matches `
    + `${counterpart}; reviewer independence requires a different model`
  );
}

// Cost label for a fallback entry:
// - adapter 'claude' runs on the user's Claude plan quota;
// - otherwise a model id without a ':free'/'-free' marker may be paid;
// - otherwise (a ':free'/'-free' model id, or no model id) no mark.
// Returns 'uses Claude plan quota', 'may be paid', or '' (no mark).
export function costLabelFor(entry) {
  if (!isRecord(entry)) return "";
  if (entry.adapter === "claude") return "uses Claude plan quota";
  if (typeof entry.model !== "string" || entry.model === "") return "";
  if (entry.model.includes(":free") || entry.model.includes("-free")) return "";
  return "may be paid";
}

// One-line display for a fallback entry: `adapter/model` plus the cost
// label in parentheses when there is one.
export function formatFallbackEntry(entry) {
  const adapter = isRecord(entry) && entry.adapter !== undefined ? String(entry.adapter) : "?";
  const model = isRecord(entry) && entry.model !== undefined ? String(entry.model) : "?";
  const label = costLabelFor(entry);
  return label ? `${adapter}/${model} (${label})` : `${adapter}/${model}`;
}
