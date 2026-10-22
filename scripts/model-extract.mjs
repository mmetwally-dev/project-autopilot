// Mission 093 Part 1 task 2.1: pure resolved-model extraction.
//
// Pure module: no filesystem, process, network, or clock access. Given one
// adapter's decoded stream events plus the model configured at launch,
// resolveRunModel() reports the actual model the CLI ran with plus whether
// it differs from what was configured. Null before resolution: when the
// stream carries no model signal yet, resolvedModel is null and
// modelMismatch is null (an absent measurement is never a match verdict).
//
// Stream shapes (PLAN.md risk note; field names from the drivers):
// - Claude stream-json: per-message `message.model` on `assistant` events,
//   authoritative terminal `model` on the `result` event.
// - OpenCode `run --format json`: `modelID` stamped on events (or
//   `modelID=<id>` logfmt on decoded stderr lines, same spelling
//   idle-hang-watchdog.mjs parses) plus a `model`/`modelID` on step_finish
//   parts where the CLI reports one.
// - agy stream-json: `init` payload fields plus `model` on step_update /
//   terminal result payloads where the CLI reports one.
//
// Ordering: the LAST non-empty model signal in stream order wins, so a
// terminal result overrides an earlier per-message/step report.

const MODEL_ID_RE = /modelID=([^\s]+)/;

function clean(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function messageModel(event) {
  const message = event?.message;
  return message && typeof message === "object" ? clean(message.model) : null;
}

// Backlog #107: with `--print-logs` opencode logs a `message=stream` line per
// LLM stream: the main session (`small=false agent=build`) and its small
// title-generation model (`small=true agent=title`, e.g. gpt-5.4-nano). Only
// the former is the model the role ran with; the title line, error lines and
// any other modelID= mention are ignored.
function stderrModelId(event) {
  if (!event || typeof event !== "object" || event.type !== "stderr") return null;
  if (typeof event.text !== "string") return null;
  const text = event.text;
  if (!/\bmessage=stream(?:\s|$)/.test(text)) return null;
  if (/\bsmall=true\b/.test(text) || /\bagent=title\b/.test(text)) return null;
  const match = text.match(MODEL_ID_RE);
  return match ? clean(match[1]) : null;
}

function resultObjectModel(event) {
  const result = event?.result;
  return result && typeof result === "object" ? clean(result.model) : null;
}

// Per-event model candidates in field-priority order; the caller keeps the
// last non-empty candidate across the stream.
function candidatesFor(adapterId, event) {
  if (!event || typeof event !== "object") return [];
  if (adapterId === "claude") {
    return [messageModel(event), clean(event.model), resultObjectModel(event)];
  }
  if (adapterId === "opencode") {
    const part = event?.part && typeof event.part === "object" ? event.part : null;
    const tokens = part?.tokens && typeof part.tokens === "object" ? part.tokens : null;
    return [
      clean(event.modelID),
      clean(event.model),
      part ? clean(part.modelID) : null,
      part ? clean(part.model) : null,
      tokens ? clean(tokens.model) : null,
      stderrModelId(event)
    ];
  }
  if (adapterId === "antigravity") {
    const init = event?.init && typeof event.init === "object" ? event.init : null;
    const step = event?.step_update && typeof event.step_update === "object" ? event.step_update : null;
    const usage = step?.usage && typeof step.usage === "object" ? step.usage : null;
    return [
      init ? clean(init.model) : null,
      init ? clean(init.model_id) : null,
      init ? clean(init.modelId) : null,
      step ? clean(step.model) : null,
      usage ? clean(usage.model) : null,
      resultObjectModel(event),
      clean(event.model)
    ];
  }
  return [clean(event.model), messageModel(event)];
}

function extractResolvedModel(adapterId, events) {
  if (!Array.isArray(events)) return null;
  let resolved = null;
  for (const event of events) {
    for (const candidate of candidatesFor(adapterId, event)) {
      if (candidate != null) resolved = candidate;
    }
  }
  return resolved;
}

// Backlog #5: the claude adapter accepts short aliases (`opus`, `sonnet`,
// `haiku`, optionally with a `[1m]` suffix) and resolves them to full ids like
// `claude-opus-5-5`. That alias→full-id resolution is the SAME model, not a
// mismatch. A different family (configured `haiku`, resolved
// `claude-sonnet-5-5`) stays a real mismatch (backlog #150).
const CLAUDE_ALIAS_RE = /^(opus|sonnet|haiku)(?:\[1m\])?$/i;

function claudeAliasMatches(configured, resolved) {
  const match = String(configured).match(CLAUDE_ALIAS_RE);
  if (!match) return false;
  const family = `claude-${match[1].toLowerCase()}`;
  const id = String(resolved).toLowerCase();
  return id === family || id.startsWith(`${family}-`);
}

// Resolve the actual model reported by one adapter's decoded stream events.
// configuredModel is the model requested at launch (null/"" when the CLI
// chose its default). Returns {resolvedModel, modelMismatch}: modelMismatch
// is null before resolution, otherwise true only when a configured model
// was requested and the stream reports a different one.
export function resolveRunModel(adapterId, events, configuredModel = null) {
  const resolvedModel = extractResolvedModel(adapterId, events);
  if (resolvedModel == null) return {resolvedModel: null, modelMismatch: null};
  const configured = clean(configuredModel);
  // opencode configures `provider/model` but logs the bare model id (#107).
  // claude aliases resolve to full ids (backlog #5).
  const same = configured != null && (resolvedModel === configured
    || (adapterId === "opencode" && configured.endsWith(`/${resolvedModel}`))
    || (adapterId === "claude" && claudeAliasMatches(configured, resolvedModel)));
  return {resolvedModel, modelMismatch: configured == null ? false : !same};
}
