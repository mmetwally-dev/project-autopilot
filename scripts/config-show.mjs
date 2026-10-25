import {DEFAULTS, toNewLayoutConfig, toRuntimeConfig} from "./config-layout.mjs";
import {descriptionFor} from "./gen-config-schema.mjs";
import {loadAndMigrateConfig} from "./config-migration.mjs";
import path from "node:path";
import {pathToFileURL} from "node:url";

// Legacy section names the reader (toRuntimeConfig) still accepts. They are
// resolved to their v4 keys before rendering so the show output never lists a
// raw legacy section next to the v4 key that actually uses its value.
const LEGACY_TOP_LEVEL_KEYS = ["policy", "gates", "execution", "planning", "capabilities", "freeModelAutoFallback"];
const LEGACY_ROLE_KEYS = ["adapter", "resume"];

function isObject(value) {
  return value !== null && typeof value !== "undefined" && typeof value === "object" && !Array.isArray(value);
}

function has(object, key) {
  return isObject(object) && Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeLayout(layout) {
  return toNewLayoutConfig(toRuntimeConfig(isObject(layout) ? layout : {}));
}

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function collectLeafPaths(value, prefix, out) {
  if (!isObject(value)) {
    if (prefix) out.add(prefix);
    return;
  }
  const keys = Object.keys(value);
  if (!keys.length) {
    if (prefix) out.add(prefix);
    return;
  }
  for (const key of keys) {
    collectLeafPaths(value[key], prefix ? `${prefix}.${key}` : key, out);
  }
}

// Adds every path whose effective value was changed by the config (presence or
// value) relative to `base`. `actual` is the normalized layout.
function collectDifferentPaths(base, actual, prefix, out) {
  const baseIsObject = isObject(base);
  const actualIsObject = isObject(actual);
  if (baseIsObject && actualIsObject) {
    const keys = new Set([...Object.keys(base), ...Object.keys(actual)]);
    for (const key of keys) {
      const currentPath = prefix ? `${prefix}.${key}` : key;
      const baseHas = has(base, key);
      const actualHas = has(actual, key);
      if (actualHas && !baseHas) {
        collectLeafPaths(actual[key], currentPath, out);
      } else if (baseHas && actualHas) {
        collectDifferentPaths(base[key], actual[key], currentPath, out);
      }
      // A key missing from actual was not set by the file.
    }
    return;
  }
  if (actualIsObject) {
    collectLeafPaths(actual, prefix, out);
  } else if (prefix && !valuesEqual(base, actual)) {
    out.add(prefix);
  }
}

function stripLegacyAliases(layout) {
  let stripped = false;
  const clone = {...layout};
  for (const key of LEGACY_TOP_LEVEL_KEYS) {
    if (has(clone, key)) {
      delete clone[key];
      stripped = true;
    }
  }
  if (isObject(layout.roles)) {
    const roles = {...layout.roles};
    for (const [name, entry] of Object.entries(roles)) {
      if (!isObject(entry)) continue;
      let roleStripped = false;
      const copy = {...entry};
      for (const key of LEGACY_ROLE_KEYS) {
        if (has(copy, key)) {
          delete copy[key];
          roleStripped = true;
        }
      }
      if (roleStripped) {
        roles[name] = copy;
        stripped = true;
      }
    }
    if (stripped) clone.roles = roles;
  }
  return stripped ? clone : null;
}

function collectExplicitPaths(layout, normalized) {
  const explicit = new Set();
  if (!isObject(layout)) return explicit;
  // Direct v4 keys written by the operator (marked even when the value equals
  // the default).
  collectLeafPaths(layout, "", explicit);
  // Values that differ from the all-defaults layout were produced by the file
  // (this includes derived duplicates such as caps.implementer.extra_sessions
  // and retries.extra_sessions_per_task).
  const baseline = normalizeLayout({});
  collectDifferentPaths(baseline, normalized, "", explicit);
  // Legacy names (policy.per_task_max_turns, roles.<r>.adapter, ...) resolved by
  // the reader: diff the layout with and without those aliases so their v4
  // destination is still marked even when the value equals the default.
  const stripped = stripLegacyAliases(layout);
  if (stripped) {
    collectDifferentPaths(normalizeLayout(stripped), normalized, "", explicit);
  }
  return explicit;
}

function buildNode(defaults, config, explicit, prefix) {
  const result = {};
  const allKeys = new Set([...Object.keys(defaults || {}), ...Object.keys(config || {})]);

  for (const key of allKeys) {
    const currentPath = prefix ? `${prefix}.${key}` : key;
    const hasDefault = has(defaults, key);
    const defaultValue = hasDefault ? defaults[key] : undefined;
    const hasConfigValue = has(config, key);
    const configValue = hasConfigValue ? config[key] : undefined;

    if (hasConfigValue) {
      const configIsObject = isObject(configValue);
      const defaultIsObject = isObject(defaultValue);
      const nested = configIsObject && ((defaultIsObject && (Object.keys(configValue).length || Object.keys(defaultValue).length)) || !hasDefault);
      if (nested) {
        result[key] = buildNode(defaultIsObject ? defaultValue : {}, configValue, explicit, currentPath);
      } else {
        result[key] = {
          value: configValue,
          source: explicit.has(currentPath) ? "from config.json" : "default"
        };
      }
    } else if (isObject(defaultValue) && Object.keys(defaultValue).length) {
      result[key] = buildNode(defaultValue, {}, explicit, currentPath);
    } else {
      result[key] = {
        value: defaultValue,
        source: "default"
      };
    }
  }

  return result;
}

export function buildEffectiveConfig(layout) {
  // `layout` is the v4 config layout (from loadAndMigrateConfig). Normalize
  // through the reader so legacy names show under their v4 key; defaults come
  // from the layout DEFAULTS table.
  const normalized = normalizeLayout(layout);
  const explicit = collectExplicitPaths(layout, normalized);
  return buildNode(DEFAULTS, normalized, explicit, "");
}

export function renderConfigShow(effectiveConfig, options = {}) {
  const {format = "text", showOnly = null, explain = false} = options;

  function shouldShowPath(currentPath) {
    if (!showOnly) return true;
    // A path is in scope when it is the requested path, a descendant of it, or
    // an ancestor of it. Ancestor/descendant checks require a "." boundary so
    // --path caps.plan does not match caps.planner and --path roles.planner
    // does not match roles.plannerX.
    if (currentPath === showOnly) return true;
    if (currentPath.startsWith(`${showOnly}.`)) return true;
    if (showOnly.startsWith(`${currentPath}.`)) return true;
    return false;
  }

  function renderValue(obj, prefix = "") {
    let output = "";
    for (const [key, value] of Object.entries(obj)) {
      const currentPath = prefix ? `${prefix}.${key}` : key;

      if (!shouldShowPath(currentPath)) {
        continue;
      }

      if (value && typeof value === "object" && "value" in value && "source" in value) {
        const sourceLabel = value.source === "default" ? "[default]" : "[from config.json]";
        const displayValue = formatValue(value.value);
        output += `${currentPath}: ${displayValue} ${sourceLabel}\n`;
        if (explain) {
          try {
            output += `  # ${descriptionFor(currentPath)}\n`;
          } catch {
            // Keys without a schema description still render their value line.
          }
        }
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        output += renderValue(value, currentPath);
      }
    }
    return output;
  }

  return renderValue(effectiveConfig);
}

function formatValue(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[${value.map(formatValue).join(", ")}]`;
  }
  if (isObject(value)) {
    return JSON.stringify(value);
  }
  return String(value);
}

export async function configShowCommand(configPath, options = {}) {
  const result = loadAndMigrateConfig(configPath, {persist: false});
  // Use the migrated layout before legacy fill: fill adds every missing default
  // key, which would otherwise be indistinguishable from values the operator
  // actually wrote. Rendering still normalizes through DEFAULTS, so the
  // effective values are unchanged.
  const layout = result.sourceLayout ?? result.layout;
  const effectiveConfig = buildEffectiveConfig(layout);
  const output = renderConfigShow(effectiveConfig, options);
  return output;
}

export function getEffectiveConfigForTest(partialConfig) {
  // Helper for tests: build effective config from a partial config object
  // (simulating a loaded config without going through file I/O)
  return buildEffectiveConfig(partialConfig);
}

export const CONFIG_SHOW_USAGE = `Usage: ap config show [--repo <path>] [--path <key.path>] [--explain] [--format text]

Renders the effective configuration: values from .autopilot/config.json plus
code defaults, each marked [default] or [from config.json].

Options:
  --repo <path>       Repository containing .autopilot/config.json (default: .)
  --path <key.path>   Show only this key and its descendants/ancestors
  --explain           Add a one-line explanation under each setting
  --format <format>   Output format (only "text" is supported today)
  --help, -h          Show this help`;

function parseShowArgs(args) {
  const parsed = {repo: ".", showOnly: null, format: "text", explain: false, help: false};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--explain") {
      parsed.explain = true;
      continue;
    }
    if (arg !== "--repo" && arg !== "--path" && arg !== "--format") {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = args[index + 1];
    if (typeof value === "undefined" || value.startsWith("-")) {
      throw new Error(`Missing value for ${arg}`);
    }
    if (arg === "--repo") parsed.repo = value;
    if (arg === "--path") parsed.showOnly = value;
    if (arg === "--format") parsed.format = value;
    index += 1;
  }
  return parsed;
}

async function main(args) {
  let parsed;
  try {
    parsed = parseShowArgs(args);
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    console.error(CONFIG_SHOW_USAGE);
    return 2;
  }
  if (parsed.help) {
    console.log(CONFIG_SHOW_USAGE);
    return 0;
  }

  const configPath = path.join(parsed.repo, ".autopilot", "config.json");
  try {
    const output = await configShowCommand(configPath, {
      format: parsed.format,
      showOnly: parsed.showOnly,
      explain: parsed.explain
    });
    if (output) process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
    return 0;
  } catch (error) {
    console.error(`ERROR: Failed to read configuration at ${configPath}: ${error && error.message ? error.message : error}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
