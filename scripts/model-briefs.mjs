import fs from "node:fs";
import path from "node:path";
import { skillRoot as defaultSkillRoot } from "./paths.mjs";

const cache = new Map();

/**
 * Load model briefs configuration relative to skill root.
 * Reads the json once per root; missing or invalid file returns empty families and never throws.
 *
 * @param {string} [skillRoot]
 * @returns {{ families: Array<{ id: string, match: string, all: string[], planner?: string[], implementer?: string[] }> }}
 */
export function loadModelBriefs(skillRoot = defaultSkillRoot) {
  const root = skillRoot || defaultSkillRoot;
  const filePath = path.join(root, "adapters", "model-briefs.json");

  if (cache.has(filePath)) {
    return cache.get(filePath);
  }

  try {
    if (!fs.existsSync(filePath)) {
      const empty = { families: [] };
      cache.set(filePath, empty);
      return empty;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.families)) {
      const empty = { families: [] };
      cache.set(filePath, empty);
      return empty;
    }
    cache.set(filePath, parsed);
    return parsed;
  } catch {
    const empty = { families: [] };
    cache.set(filePath, empty);
    return empty;
  }
}

/**
 * Get brief lines for a given model and roleName.
 * "match" is a case-insensitive substring of the configured model id.
 * Returns array of lines (all + role list), or [] when no family matches.
 *
 * @param {{ model?: string, roleName?: string, skillRoot?: string }} options
 * @returns {string[]}
 */
export function modelBriefLines({ model, roleName, skillRoot } = {}) {
  if (!model || typeof model !== "string") {
    return [];
  }

  const briefs = loadModelBriefs(skillRoot || defaultSkillRoot);
  const families = Array.isArray(briefs?.families) ? briefs.families : [];
  const modelLower = model.toLowerCase();

  const family = families.find(
    (f) => f && typeof f.match === "string" && f.match.length > 0 && modelLower.includes(f.match.toLowerCase())
  );

  if (!family) {
    return [];
  }

  const all = Array.isArray(family.all) ? family.all : [];
  const roleLines = (roleName && Array.isArray(family[roleName])) ? family[roleName] : [];

  return [...all, ...roleLines];
}
