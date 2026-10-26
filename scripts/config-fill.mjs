// Backlog #1 (mission 097 Phase 2 task 2.4): fill a v4 layout with the
// settings the operator never wrote. `fillLayout` only inserts absent keys at
// their DEFAULTS value; every existing value (including `null` and empty
// arrays) is kept exactly as written, and a second pass changes nothing.
//
// The `runtime` subtree is special: a config that never had a runtime (no
// key, or `{}` after migration) must not gain the fabricated default
// `mode`/`wsl_distro` pair (PLAN.md: "Fill reintroduces a runtime the operator
// never chose"). A non-empty runtime is filled normally.

import fs from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { DEFAULTS, migrateTimeLimitNames, migratePlanApprovalKey } from "./config-layout.mjs";
import { schemaReferenceFor, schemaReferenceResolves } from "./config-schema-ref.mjs";
import { loadAndMigrateConfig, CURRENT_SCHEMA } from "./config-migration.mjs";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function own(obj, key) {
  return isPlainObject(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = clone(entry);
    return out;
  }
  return value;
}

// Keep the existing key order and values; append absent default keys in
// DEFAULTS order. Recurse only when both sides are plain objects, so a
// scalar/array/null written by the operator is never replaced by an object.
function fillObject(current, defaults) {
  const out = {};
  for (const [key, value] of Object.entries(current)) {
    if (isPlainObject(value) && isPlainObject(defaults[key])) {
      out[key] = fillObject(value, defaults[key]);
    } else {
      out[key] = value;
    }
  }
  for (const [key, value] of Object.entries(defaults)) {
    if (own(current, key)) continue;
    out[key] = clone(value);
  }
  return out;
}

function fillRuntime(value) {
  if (!isPlainObject(value) || Object.keys(value).length === 0) return value;
  return fillObject(value, DEFAULTS.runtime);
}

// Put `$schema` first, keeping the value that already resolves from the
// config's directory and replacing a missing or wrong one with the reference
// computed for `configPath`.
function withSchemaReference(layout, configPath) {
  const configDir = dirname(configPath);
  const current = layout.$schema;
  const value = schemaReferenceResolves(current, configDir) ? current : schemaReferenceFor(configPath);
  const out = { $schema: value };
  for (const [key, entry] of Object.entries(layout)) {
    if (key === "$schema") continue;
    out[key] = entry;
  }
  return out;
}

/**
 * Complete a v4 layout with every missing `DEFAULTS` key.
 *
 * When `configPath` is given, `$schema` is placed first and repaired with a
 * reference that resolves from the config's directory; an already-correct
 * reference is kept as written.
 *
 * @param {Record<string, unknown>} layout parsed on-disk layout
 * @param {string} [configPath] on-disk location of the layout
 * @returns {Record<string, unknown>} a new layout; the input is not mutated
 */
export function fillLayout(layout, configPath) {
  // `ap config fill` also rewrites the old `mission_timeout_minutes` name and
  // drops `approve_plan_myself` (replaced by `pause_for_plan_approval`).
  const timeRenamed = migrateTimeLimitNames(isPlainObject(layout) ? layout : {});
  const source = migratePlanApprovalKey(timeRenamed.layout).layout;
  const out = {};

  for (const [key, value] of Object.entries(source)) {
    if (key === "runtime") {
      out.runtime = fillRuntime(value);
    } else if (isPlainObject(value) && isPlainObject(DEFAULTS[key])) {
      out[key] = fillObject(value, DEFAULTS[key]);
    } else {
      out[key] = value;
    }
  }

  for (const [key, value] of Object.entries(DEFAULTS)) {
    // Never introduce a runtime the operator never set (see top comment).
    if (key === "runtime") continue;
    if (own(source, key)) continue;
    out[key] = clone(value);
  }

  if (configPath) return withSchemaReference(out, configPath);
  return out;
}

// Dot-separated paths of every key present in `after` but absent from `before`.
// Objects are expanded to their leaves; arrays and scalars are leaves.
function addedPaths(before, after, prefix = "") {
  const paths = [];
  for (const [key, value] of Object.entries(after)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (own(before, key)) {
      if (isPlainObject(value) && isPlainObject(before[key])) {
        paths.push(...addedPaths(before[key], value, full));
      }
      continue;
    }
    if (isPlainObject(value) && Object.keys(value).length > 0) {
      paths.push(...addedPaths({}, value, full));
    } else {
      paths.push(full);
    }
  }
  return paths;
}

/**
 * Fill `config.json` on disk with every missing `DEFAULTS` key.
 *
 * A timestamped `config.json.bak-<time>` copy is written before the config is
 * replaced, but only when the layout changes (keys added, old time-limit names
 * renamed, `approve_plan_myself` removed, or `$schema` repaired). A dry run
 * prints the changes and touches nothing.
 *
 * If the config is not v4 (schema_version !== "4.0" and no valid $schema),
 * it is migrated first using loadAndMigrateConfig so operator values are
 * preserved and the migration result is kept.
 *
 * @param {string} configPath path to the on-disk config
 * @param {{dryRun?: boolean}} [options]
 * @returns {{changed: boolean, added: string[], renamed: {from: string, to: string}[], removed: string[], written: boolean, backupPath: string|null}}
 */
export function fillConfigFile(configPath, { dryRun = false } = {}) {
  const raw = fs.readFileSync(configPath, "utf8");
  const original = JSON.parse(raw);

  // If the config is not v4, migrate it first so operator values are preserved.
  const incoming = String(original.schema_version || "1.0");
  const hasValidSchemaRef = typeof original.$schema === "string" && schemaReferenceResolves(original.$schema, dirname(configPath));
  const isV4 = incoming === CURRENT_SCHEMA || hasValidSchemaRef;

  let layoutToFill;
  let migrationResult = null;
  if (!isV4) {
    migrationResult = loadAndMigrateConfig(configPath, { persist: false });
    if (!migrationResult.layout) {
      throw new Error(`Failed to migrate config at ${configPath} before fill`);
    }
    layoutToFill = migrationResult.layout;
  } else {
    layoutToFill = original;
  }

  const {renamed} = migrateTimeLimitNames(isPlainObject(original) ? original : {});
  const {removed} = migratePlanApprovalKey(isPlainObject(original) ? original : {});
  const filled = fillLayout(layoutToFill, configPath);
  const renamedTargets = new Set(renamed.map((entry) => entry.to));
  const added = addedPaths(layoutToFill, filled).filter((path) => !renamedTargets.has(path));
  const schemaChanged =
    layoutToFill.$schema !== filled.$schema || Object.keys(layoutToFill)[0] !== Object.keys(filled)[0];
  // Compare against original to detect migration as a change.
  const changed =
    added.length > 0 || renamed.length > 0 || removed.length > 0 || schemaChanged
    || JSON.stringify(original) !== JSON.stringify(filled);
  const result = { changed, added, renamed, removed, written: false, backupPath: null };

  if (!changed) return result;

  for (const entry of renamed) console.log(`~ renamed ${entry.from} -> ${entry.to}`);
  for (const entry of removed) console.log(`- removed ${entry} (replaced by workflow.pause_for_plan_approval, default false)`);
  for (const entry of added) console.log(`+ ${entry}`);
  if (schemaChanged) console.log("~ $schema");
  if (dryRun) return result;

  result.backupPath = `${configPath}.bak-${Date.now()}`;
  fs.copyFileSync(configPath, result.backupPath);
  fs.writeFileSync(configPath, `${JSON.stringify(filled, null, 2)}\n`);
  result.written = true;
  return result;
}

const CONFIG_FILL_USAGE = `Usage: ap config fill [options]

Fill .autopilot/config.json with every missing default setting. Existing
values are preserved and the resolved $schema reference is repaired.

Options:
  --dry-run           Print what would be added without writing anything
  --repo <path>       Repository containing .autopilot/config.json (default: .)
  --help, -h          Show this help`;

function parseFillArgs(argv) {
  const parsed = { dryRun: false, repo: ".", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (arg !== "--repo") throw new Error(`Unknown argument: ${arg}`);
    const value = argv[index + 1];
    if (typeof value === "undefined" || value.startsWith("-")) {
      throw new Error(`Missing value for ${arg}`);
    }
    parsed.repo = value;
    index += 1;
  }
  return parsed;
}

/**
 * CLI entry point: `ap config fill [--dry-run] [--repo <path>]`.
 *
 * @param {string[]} argv arguments after the command name
 * @returns {number} process exit code (0 ok, 1 failure, 2 bad arguments)
 */
export function main(argv = []) {
  let parsed;
  try {
    parsed = parseFillArgs(argv);
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    console.error(CONFIG_FILL_USAGE);
    return 2;
  }
  if (parsed.help) {
    console.log(CONFIG_FILL_USAGE);
    return 0;
  }

  const configPath = resolve(parsed.repo, ".autopilot", "config.json");
  try {
    fillConfigFile(configPath, { dryRun: parsed.dryRun });
    return 0;
  } catch (error) {
    console.error(
      `ERROR: Failed to fill configuration at ${configPath}: ${error && error.message ? error.message : error}`
    );
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
