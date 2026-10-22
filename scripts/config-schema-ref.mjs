// Backlog #208 (mission 097 Phase 2 task 2.1): compute the `$schema`
// reference that belongs in a written config file.
//
// The shipped schema lives beside the skill entry point (the repo root);
// a config lives in `<repo>/.autopilot/config.json`. Editors resolve a
// relative `$schema` against the config file's directory, so a plain
// `./config.schema.json` is wrong there. This helper turns the real config
// path into either:
//   - a relative path with forward slashes when both live on the same
//     drive/root (`../config.schema.json`), or
//   - a `file://` URL when they do not (Windows different drives).
//
// This module is pure apart from reading the schema path location: it has no
// filesystem writes. `schemaReferenceResolves` does a read-only existence
// check.

import { existsSync } from "node:fs";
import { dirname, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SCHEMA_PATH } from "./gen-config-schema.mjs";

function rootOf(filePath) {
  return parse(resolve(filePath)).root;
}

function onSameRoot(a, b) {
  if (process.platform === "win32") {
    return rootOf(a).toLowerCase() === rootOf(b).toLowerCase();
  }
  return rootOf(a) === rootOf(b);
}

// A relative reference must look like a path, not a URL or a bare package
// name: prefix `./` when the relative path does not already start with a dot.
function withDotPrefix(relPath) {
  if (relPath === "") return ".";
  if (relPath.startsWith(".")) return relPath;
  return `./${relPath}`;
}

function toForwardSlashes(relPath) {
  return sep === "/" ? relPath : relPath.split(sep).join("/");
}

/**
 * Build the `$schema` value for a config written at `configPath`.
 *
 * @param {string} configPath absolute or cwd-relative path of the config file
 * @param {{schemaPath?: string, forceFileUrl?: boolean}} [options]
 *   schemaPath overrides the shipped schema location (tests);
 *   forceFileUrl simulates a different drive/root (tests).
 * @returns {string} relative reference or `file://` URL
 */
export function schemaReferenceFor(configPath, options = {}) {
  const schemaPath = resolve(options.schemaPath ?? SCHEMA_PATH);
  const configDir = dirname(resolve(configPath));
  const crossRoot = options.forceFileUrl === true || !onSameRoot(configDir, schemaPath);
  if (crossRoot) return pathToFileURL(schemaPath).href;
  return toForwardSlashes(withDotPrefix(relative(configDir, schemaPath)));
}

/**
 * Whether a `$schema` reference in a config at `configDir` points at an
 * existing file named `config.schema.json` (or the shipped SCHEMA_PATH).
 *
 * @param {unknown} ref
 * @param {string} configDir directory the reference is resolved from
 * @returns {boolean}
 */
export function schemaReferenceResolves(ref, configDir) {
  if (typeof ref !== "string" || ref.trim() === "") return false;
  let targetPath;
  if (ref.startsWith("file:")) {
    try {
      targetPath = fileURLToPath(ref);
    } catch {
      return false;
    }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) {
    // Any other URL scheme (http:, https:, ...) is not a local schema file.
    return false;
  } else {
    targetPath = resolve(configDir, ref);
  }
  if (!existsSync(targetPath)) return false;
  // The resolved file must be named config.schema.json or be the shipped schema.
  const targetName = parse(targetPath).base;
  const shippedSchema = resolve(SCHEMA_PATH);
  return targetName === "config.schema.json" || targetPath === shippedSchema;
}
