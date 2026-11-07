// Helper module for antigravity model and reasoning effort compatibility.
// Pure module: no filesystem, network, or process access.

const EFFORT_TIER_PATTERN = /^(.*?)-(low|medium|high)$/i;

/**
 * Checks whether an Antigravity model ID and explicit effort conflict.
 * A model whose ID ends in -low/-medium/-high encodes an effort tier and
 * conflicts with a different explicit effort.
 *
 * @param {string|null} model
 * @param {string|null} effort
 * @returns {{model: string, effort: string, suggested: string}|null}
 */
export function agyModelEffortConflict(model, effort) {
  if (typeof model !== "string" || !model.trim()) return null;
  if (typeof effort !== "string" || !effort.trim()) return null;

  const trimmedModel = model.trim();
  const trimmedEffort = effort.trim();

  const match = trimmedModel.match(EFFORT_TIER_PATTERN);
  if (!match) return null;

  const base = match[1];
  const modelTier = match[2].toLowerCase();
  const explicitEffort = trimmedEffort.toLowerCase();

  if (modelTier === explicitEffort) return null;

  const suggested = `${base}-${explicitEffort}`;
  return {
    model: trimmedModel,
    effort: trimmedEffort,
    suggested
  };
}

/**
 * Extracts all known model IDs from an array or Set of catalog entries,
 * including both item.id and item.effortModelIds values.
 *
 * @param {Array|Set|null} catalog
 * @returns {Set<string>}
 */
export function extractCatalogModelIds(catalog) {
  const ids = new Set();
  if (!catalog) return ids;
  const list = Array.isArray(catalog) ? catalog : (catalog instanceof Set ? [...catalog] : [catalog]);
  for (const entry of list) {
    if (typeof entry === "string" && entry.trim()) {
      ids.add(entry.trim());
    } else if (entry && typeof entry === "object") {
      if (typeof entry.id === "string" && entry.id.trim()) ids.add(entry.id.trim());
      if (entry.effortModelIds && typeof entry.effortModelIds === "object") {
        for (const val of Object.values(entry.effortModelIds)) {
          if (typeof val === "string" && val.trim()) ids.add(val.trim());
        }
      }
    }
  }
  return ids;
}

/**
 * Normalizes an Antigravity model/effort pair.
 * When the suggested ID is in the catalog, it is chosen.
 * When the suggested ID is not in the catalog, the base model is kept only if listed.
 * Otherwise, the model is left unchanged so preflight can fail with a clear message.
 *
 * @param {string} model
 * @param {string} effort
 * @param {Array|Set|null} [catalog]
 * @returns {{model: string, conflict: {model: string, effort: string, suggested: string}|null, changed: boolean}}
 */
export function normalizeAgyModelEffort(model, effort, catalog = null) {
  const conflict = agyModelEffortConflict(model, effort);
  if (!conflict) {
    return { model, conflict: null, changed: false };
  }

  if (catalog) {
    const ids = extractCatalogModelIds(catalog);
    if (ids.size > 0) {
      if (ids.has(conflict.suggested)) {
        return { model: conflict.suggested, conflict, changed: true };
      }
      const match = conflict.model.match(EFFORT_TIER_PATTERN);
      const base = match ? match[1] : null;
      if (base && ids.has(base)) {
        return { model: base, conflict, changed: true };
      }
      // Neither suggested nor base is in the catalog: leave unchanged
      return { model, conflict, changed: false };
    }
  }

  // Without catalog restrictions, normalize to suggested
  return { model: conflict.suggested, conflict, changed: true };
}
