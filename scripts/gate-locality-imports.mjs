#!/usr/bin/env node
// Gate locality imports: a RED gate's failing test may be phase-related even
// when the phase never touched the test file, because the test imports a file
// the phase changed (directly, or through one local module). This pure helper
// resolves the test's relative imports against its own directory and reports
// whether any imported local module is in the phase delta.
//
// Bare package specifiers ("fs", "node:path", "@scope/pkg") are ignored: only
// `./x` / `../x` specifiers can name a repository file. The caller injects
// `readFile`, so this module performs no filesystem access itself.

import path from "node:path";

const STATIC_IMPORT_RE = /\b(?:import|export)\s+(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const REQUIRE_RE = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
// Backlog #25: tests that RUN a script as a subprocess (spawn/spawnSync/
// execFile/fork/node <path>) never import it, so the import scan above misses
// them. Any string literal that names the changed script (its path or its
// basename) inside the test source is enough — the usual forms are
// `spawnSync(process.execPath, [path.join(here, "setup.mjs"), ...])` and
// `fork("./worker.mjs")`.
const STRING_LITERAL_RE = /(["'`])([^"'`]*)\1/g;

const EXTENSIONS = [".mjs", ".cjs", ".js", ".mts", ".ts"];

function normalise(value) {
  let text = typeof value === "string" ? value.replace(/\\/g, "/").trim() : "";
  if (!text) return "";
  text = text.replace(/[?#].*$/, "");
  text = text.replace(/:\d+(?::\d+)?$/, "");
  text = text.replace(/^\.\/+/, "");
  return text;
}

// A string literal inside the test names a delta script when it is the full
// delta path or ends with the delta's basename (`"setup.mjs"`,
// `path.join(here, "setup.mjs")`, `"scripts/setup.mjs"`, `"node setup.mjs"`).
function literalNamesDelta(literal, deltaPath) {
  const text = String(literal).replace(/\\/g, "/");
  if (!text) return false;
  if (text.includes(deltaPath)) return true;
  const base = deltaPath.split("/").pop();
  if (!base) return false;
  return text === base || text.endsWith(`/${base}`) || text.endsWith(` ${base}`);
}

function spawnsDeltaScript(source, deltaPaths) {
  for (const pattern of [STRING_LITERAL_RE]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const literal = match[2];
      for (const deltaPath of deltaPaths) {
        if (literalNamesDelta(literal, deltaPath)) return deltaPath;
      }
    }
  }
  return null;
}

function extractSpecifiers(source) {
  const specifiers = [];
  const seen = new Set();
  for (const pattern of [STATIC_IMPORT_RE, DYNAMIC_IMPORT_RE, REQUIRE_RE]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const spec = match[1];
      if (typeof spec !== "string" || !spec || seen.has(spec)) continue;
      seen.add(spec);
      specifiers.push(spec);
    }
  }
  return specifiers;
}

// A relative specifier resolved against the importing file's directory.
// Absolute or bare specifiers are not repository files we may inspect.
function resolveSpecifier(importer, specifier) {
  const spec = specifier.replace(/[?#].*$/, "");
  if (!spec.startsWith(".")) return "";
  const from = importer.replace(/\\/g, "/");
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  return normalise(resolved);
}

function candidates(resolved) {
  const out = [resolved];
  if (!path.posix.extname(resolved)) {
    for (const ext of EXTENSIONS) out.push(`${resolved}${ext}`);
  }
  return out;
}

function readFirst(read, resolved) {
  for (const candidate of candidates(resolved)) {
    let source;
    try {
      source = read(candidate);
    } catch {
      continue;
    }
    if (typeof source === "string") return source;
  }
  return null;
}

export function importsDeltaFile({ testPath, deltaPaths, readFile, maxDepth = 2 } = {}) {
  if (typeof testPath !== "string" || !testPath.trim()) return { inside: false, via: null };
  if (typeof readFile !== "function") return { inside: false, via: null };
  const deltas = (Array.isArray(deltaPaths) ? deltaPaths : [])
    .map((entry) => [normalise(entry), entry])
    .filter(([norm]) => norm);
  if (!deltas.length) return { inside: false, via: null };
  const deltaByPath = new Map();
  for (const [norm, original] of deltas) {
    if (!deltaByPath.has(norm)) deltaByPath.set(norm, original);
  }
  const limit = Number.isInteger(maxDepth) && maxDepth >= 1 ? maxDepth : 2;
  const visited = new Set();

  const matchDelta = (resolved) => {
    for (const candidate of candidates(resolved)) {
      if (deltaByPath.has(candidate)) return deltaByPath.get(candidate);
    }
    return null;
  };

  const scan = (filePath, level) => {
    if (level > limit) return null;
    const key = normalise(filePath);
    if (!key || visited.has(key)) return null;
    visited.add(key);
    const source = readFirst(readFile, filePath);
    if (typeof source !== "string") return null;
    for (const specifier of extractSpecifiers(source)) {
      const resolved = resolveSpecifier(filePath, specifier);
      if (!resolved) continue;
      const matched = matchDelta(resolved);
      if (matched) return matched;
      if (level < limit) {
        const via = scan(resolved, level + 1);
        if (via) return via;
      }
    }
    return null;
  };

  const via = scan(testPath, 1);
  if (via !== null) return { inside: true, via };
  // Backlog #25: no import link — also count a test that spawns/execs a
  // phase-changed script as a subprocess (its source names the script path
  // or basename in a spawn/exec/fork/`node <path>` string).
  const rootSource = readFirst(readFile, testPath);
  if (typeof rootSource === "string") {
    const spawned = spawnsDeltaScript(rootSource, [...deltaByPath.keys()]);
    if (spawned) return { inside: true, via: deltaByPath.get(spawned) };
  }
  return { inside: false, via: null };
}
