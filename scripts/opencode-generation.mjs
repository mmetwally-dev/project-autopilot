// OpenCode 1.x / 2.x generation detection, cached per binary.
//
// 1.x (`opencode-ai`) exposes reasoning/effort through `run --variant` and
// lists per-model levels via `models --verbose`.
// 2.x (`@opencode/cli`) has no `run --variant`: the level is a model suffix,
// `--model provider/model#level`, and `models --verbose` is gone (levels come
// from `opencode api GET /api/model`). It also needs `--standalone` for an
// OPENCODE_CONFIG_CONTENT-defined agent (e.g. autopilot_readonly) to be seen.
//
// The probe is a real `run --help` launch, memoized per process so a mission
// pays for it once. Capability discovery normally fills this cache before any
// launch, so buildInvocation/verifyAgentInvocation just read it. A failed or
// unknown probe deliberately falls back to the 1.x path: that keeps the
// pre-2.x behaviour byte-for-byte identical when the help text cannot be read.
//
// The cache key is the adapter BINARY only (resolved path, else name), never
// the help argv: model discovery, capability discovery, the driver and the
// invocation verifier all describe the same installed CLI, so one probe must
// serve all of them even when a caller passes a partial adapter object
// (`{binary}`) and another the full manifest (with `help_args`).
import fs from "node:fs";
import path from "node:path";
import {spawnAgentSync, resolveAgentBinary} from "./agent-process.mjs";

export const OPENCODE_HELP_ARGS = Object.freeze(["run", "--help"]);
export const OPENCODE_GENERATION_1 = "1";
export const OPENCODE_GENERATION_2 = "2";

const generationCache = new Map();

export function isOpenCodeAdapter(adapter = {}) {
  if (!adapter || typeof adapter !== "object") return false;
  if (adapter.driver === "opencode" || adapter.model_discovery === "opencode_models") return true;
  // Manifest-shaped adapter without a driver/kind (tests and older callers).
  return adapter.effort_flag === "--variant"
    && /(^|[\\/])opencode(?:\.(?:exe|cmd|bat))?$/i.test(String(adapter.binary || ""));
}

export function openCodeHelpArgs(adapter = {}) {
  return Array.isArray(adapter.help_args) && adapter.help_args.length
    ? adapter.help_args.map(String)
    : [...OPENCODE_HELP_ARGS];
}

function generationKey(adapter = {}) {
  const binary = String(adapter?.binary || "opencode");
  let resolved = binary;
  try {
    if (path.isAbsolute(binary) || /[\\/]/.test(binary)) {
      resolved = fs.existsSync(binary) ? fs.realpathSync(binary) : path.resolve(binary);
    } else {
      resolved = resolveAgentBinary(binary) || binary;
      if (resolved && fs.existsSync(resolved)) resolved = fs.realpathSync(resolved);
    }
  } catch { /* keep the caller-supplied name */ }
  return resolved;
}

export function generationFromHelp(text) {
  const value = String(text || "");
  // 1.x help names the flag itself; 2.x help names it only inside the model
  // value description. Check the real flag first so a 2.x help that happens
  // to mention the word "variant" elsewhere is not misclassified.
  if (/(?:^|\s)--variant(?:\s|=|,|$)/m.test(value)) return OPENCODE_GENERATION_1;
  if (/--model\b[\s\S]{0,200}?#variant/.test(value) || /provider\/model#variant/.test(value)) {
    return OPENCODE_GENERATION_2;
  }
  return null;
}

export function cachedOpenCodeGeneration(adapter = {}) {
  return generationCache.get(generationKey(adapter));
}

// Populate the cache from help text already collected by capability
// discovery, so model discovery and the invocation builder do not launch the
// same probe again.
export function rememberOpenCodeGeneration(adapter, helpText) {
  const generation = generationFromHelp(helpText);
  if (generation) generationCache.set(generationKey(adapter), generation);
  return generation;
}

// Synchronous probe for launch-time callers (applyAgentSelections,
// verifyAgentInvocation, the driver's buildInvocation). It is a LAST-RESORT
// fallback: discovery normally populates the same per-binary cache first.
// An unknown result is cached too so a broken/odd help output is not retried
// on every role in the same process.
export function detectOpenCodeGeneration(adapter = {}) {
  const key = generationKey(adapter);
  if (generationCache.has(key)) return generationCache.get(key);
  let generation = null;
  try {
    const result = spawnAgentSync(adapter.binary || "opencode", openCodeHelpArgs(adapter), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      input: "",
      timeout: 5_000
    });
    generation = generationFromHelp(`${result?.stdout || ""}\n${result?.stderr || ""}`);
  } catch { /* unknown -> 1.x path */ }
  generationCache.set(key, generation);
  return generation;
}

export function openCodeUsesModelSuffix(adapter = {}) {
  return isOpenCodeAdapter(adapter) && detectOpenCodeGeneration(adapter) === OPENCODE_GENERATION_2;
}

// "provider/model#level" -> {model: "provider/model", reasoning: "level"}.
export function splitOpenCodeModelSuffix(value) {
  const text = String(value || "");
  const at = text.lastIndexOf("#");
  if (at < 0) return {model: text, reasoning: null};
  return {model: text.slice(0, at), reasoning: text.slice(at + 1) || null};
}
