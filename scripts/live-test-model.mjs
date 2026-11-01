// Live-test model selection (backlog #12).
//
// The live tests drive the real installed CLIs with the operator's real
// credentials. OpenCode resolves a role with no model to the CLI's OWN default
// model inside the sandbox's fresh HOME — which, when the operator is logged
// into a paid provider, is that paid provider. Every live test that actually
// asks OpenCode for an answer must therefore pin an explicit FREE model from
// the live `opencode models` list; never `""` (the CLI default).
//
// If the list has no `opencode/*-free` model, or the one free call is rejected
// because the free quota is exhausted, the live part is skipped with one clear
// `LIVE SKIPPED:` line (never a silent pass, never a paid model).
import {spawnSync} from "node:child_process";

export const LIVE_SKIP_PREFIX = "LIVE SKIPPED:";
export const LIVE_MODEL_ENV = "AP_LIVE_TEST_OPENCODE_MODEL";

// Only OpenCode's own free models are safe to choose automatically:
// provider `opencode`, id ending in `-free`.
export function isFreeOpenCodeModel(id) {
  const value = typeof id === "string" ? id.trim() : "";
  return /^opencode\/[^\s/]+-free$/.test(value);
}

export function liveSkipLine(reason) {
  const text = String(reason ?? "").trim();
  if (text.startsWith(LIVE_SKIP_PREFIX)) return text;
  return `${LIVE_SKIP_PREFIX} ${text || "live check skipped"}`;
}

// Pure picker: an explicit operator override wins (it is a deliberate choice,
// not an automatic one); otherwise the FIRST `opencode/*-free` id in the live
// list order. Returns {model, source, skip} — exactly one of model/skip is set.
export function pickFreeOpenCodeModel(available, {env = process.env} = {}) {
  const override = String(env?.[LIVE_MODEL_ENV] ?? "").trim();
  if (override) return {model: override, source: "env", skip: null};
  const ids = (Array.isArray(available) ? available : [])
    .map(entry => typeof entry === "string" ? entry : entry?.id)
    .map(id => typeof id === "string" ? id.trim() : "")
    .filter(Boolean);
  const model = ids.find(isFreeOpenCodeModel) || null;
  if (model) return {model, source: "live", skip: null};
  return {
    model: null,
    source: null,
    skip: liveSkipLine("no free OpenCode model (opencode/*-free) is listed by `opencode models`; refusing to fall back to the CLI default/paid provider"),
  };
}

// One model id per line; `opencode models` prints plain ids (and, on some
// versions, a following metadata block whose lines are not ids). Take the
// first whitespace-separated token only when it is provider/model-shaped.
export function parseOpenCodeModelList(text) {
  const ids = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const token = line.trim().split(/\s+/)[0];
    if (!token || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:@+-]+$/.test(token)) continue;
    if (!ids.includes(token)) ids.push(token);
  }
  return ids;
}

export function readOpenCodeModelIds({binary = "opencode", spawn = spawnSync, env = process.env, timeoutMs = 60_000} = {}) {
  const result = spawn(binary, ["models"], {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    env,
  });
  if (result?.error || result?.status !== 0) {
    return {ids: [], error: result?.error?.message || `\`${binary} models\` exited ${result?.status}`};
  }
  return {ids: parseOpenCodeModelList(result.stdout), error: null};
}

// Resolve the model a live OpenCode call must use. An env override does not
// need the live list (the operator named it explicitly); otherwise the real
// `opencode models` output is required. On any failure the caller gets a
// `LIVE SKIPPED:` line and MUST NOT make the model call.
export function resolveLiveFreeOpenCodeModel({binary = "opencode", spawn = spawnSync, env = process.env} = {}) {
  if (String(env?.[LIVE_MODEL_ENV] ?? "").trim()) return pickFreeOpenCodeModel([], {env});
  const listed = readOpenCodeModelIds({binary, spawn, env});
  if (listed.error) {
    return {model: null, source: null, skip: liveSkipLine(`could not read the live \`${binary} models\` list (${listed.error}); refusing to fall back to the CLI default/paid provider`)};
  }
  return pickFreeOpenCodeModel(listed.ids, {env});
}

// The free-tier quota rejection is not a test failure: it means this live
// check cannot run right now. Structured RATE_LIMITED is authoritative; the
// text fallback covers the CLI's own stderr before classification.
export function isLiveQuotaExhausted({failureClass = null, output = ""} = {}) {
  if (failureClass === "RATE_LIMITED") return true;
  return /free usage limit reached|usage limit reached|RATE_LIMITED|rate[_\s-]?limit|too many requests|\b429\b/i.test(String(output || ""));
}

// test-all.mjs keeps every passing child's output only in memory, so LIVE
// SKIPPED lines would otherwise vanish. Collect the exact lines from any
// child output and render them once in the final suite summary.
export function collectLiveSkipLines(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith(LIVE_SKIP_PREFIX));
}

export function formatLiveSkipSummary(lines) {
  const unique = [...new Set((Array.isArray(lines) ? lines : []).filter(Boolean))];
  if (!unique.length) return "";
  return ["Live checks skipped:", ...unique.map(line => `- ${line}`)].join("\n");
}
