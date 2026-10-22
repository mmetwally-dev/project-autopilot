// agy (antigravity CLI) stream-json event helpers plus the per-run permissions
// allow-rule writer — pure module, no filesystem/process/network access except
// the writer itself, no side effects at import.
//
// Event shapes were captured live against the installed agy and match the
// official headless docs (antigravity.google/docs/cli/headless): NDJSON lines
// of {"event":"init"|"step_update"|"result", ...}. A step_update carries
// {conversation_id, step_index, state: ACTIVE|DONE, step_type:
// user_input|agent_response|tool|checkpoint, tool_name, text_delta,
// duration_seconds, usage:{input_tokens,output_tokens,thinking_tokens,
// cache_read_tokens,total_tokens}, tool_info:{name,parameters,output,error}}.
// The terminal result carries {conversation_id, status:
// SUCCESS|ERROR|CANCELED|INTERRUPTED|INVALID|WAITING|RUNNING, response, error,
// num_turns, usage} where usage/num_turns/duration_seconds are CUMULATIVE over
// the session (per the docs), not per-turn.
//
// Permission rules follow the documented CLI schema
// (antigravity.google/docs/permissions?tab=cli):
// {"permissions":{"allow":["command(git)","write_file(src/)", ...]}}.
import fs from "node:fs";
import path from "node:path";
import {AGY_SETTINGS_RELATIVE_PATH} from "./adapter-drivers.mjs";
import {equivalentEventPath, eventReferencesPath} from "./event-paths.mjs";
import {resolveRunModel} from "./model-extract.mjs";

// NDJSON decode shared with the driver: one parsed object per non-empty line;
// unparseable lines and stderr lines become typed sentinel events (mirrors
// decodeJsonLines in adapter-drivers.mjs so 1.3 can swap dispatch to this).
export function decodeAgyEvents(stdout, stderr) {
  const events = [];
  for (const line of String(stdout || "").split(/\r?\n/).filter(Boolean)) {
    try { events.push(JSON.parse(line)); }
    catch { events.push({type: "unparsed_stdout", text: line}); }
  }
  for (const line of String(stderr || "").split(/\r?\n/).filter(Boolean)) events.push({type: "stderr", text: line});
  return events;
}

function observation(type, event, details = {}) {
  return {type, source: "cli_event", ...details, event};
}

function stepOf(event) {
  return event?.step_update && typeof event.step_update === "object" ? event.step_update : null;
}

function resultOf(event) {
  return event?.result && typeof event.result === "object" ? event.result : null;
}

// Tool-name classification over agy's tool namespace (seen live in init.tools).
const AGY_WRITE_TOOLS = new Set(["write_to_file", "replace_file_content", "multi_replace_file_content", "notebook_edit", "sed_file"]);
const AGY_READ_TOOLS = new Set(["view_file", "read_resource", "read_url_content", "grep_search", "list_dir", "list_resources"]);
const AGY_COMMAND_TOOLS = new Set(["run_command", "send_command_input"]);

function toolText(info) {
  const values = [];
  if (info && typeof info === "object") {
    for (const value of Object.values(info.parameters || {})) {
      values.push(typeof value === "string" ? value : JSON.stringify(value));
    }
    if (typeof info.output === "string") values.push(info.output);
    const err = info.error;
    if (err) values.push(typeof err === "string" ? err : `${err.type || ""}\n${err.message || ""}`);
  }
  return values.join("\n");
}

function toolTarget(info) {
  const params = info?.parameters && typeof info.parameters === "object" ? info.parameters : {};
  for (const key of ["TargetFile", "filePath", "file_path", "path", "File"]) {
    if (params[key] != null && String(params[key]) !== "") return String(params[key]);
  }
  return "";
}

// Denial phrasing only — narrow on purpose (mirrors the driver modules: match
// an actual denial, never bare "denied"/"blocked" prose).
const AGY_DENIAL_TEXT = /permission denied|rejected permission|not permitted|denied by policy|blocked by policy|requires approval|soft-denied|needs approval/i;

// Rate-limit shapes: the CLI surfaces quota/429 pressure as a terminal ERROR
// result (error text) — never prose. 429 plus the documented quota/credit and
// availability phrasings all map to the same operator-visible state.
const AGY_RATE_LIMIT_TEXT = /rate[_\s-]?limit|status.?429|\b429\b|quota|insufficient account funds|endpoint is unavailable|credits? exhausted|too many requests/i;

function isRateLimitedResult(result) {
  if (!result) return false;
  return AGY_RATE_LIMIT_TEXT.test(`${result.error || ""}\n${result.status || ""}`);
}

// A denied_actions loud failure: the terminal result carries a non-empty
// denied_actions list (scripted fixture shape), or an ERROR result whose error
// is denial-shaped. Either is the CLI's own structured outcome — never model
// prose — so it maps to permission_denied regardless of exit code.
export function agyDeniedActions(events) {
  const denied = [];
  for (const event of events) {
    const result = resultOf(event);
    if (result && Array.isArray(result.denied_actions) && result.denied_actions.length > 0) {
      denied.push(observation("permission_denied", event, {reason: "denied_actions", actions: result.denied_actions}));
      continue;
    }
    if (result && String(result.status || "").toUpperCase() !== "SUCCESS" && AGY_DENIAL_TEXT.test(String(result.error || ""))) {
      denied.push(observation("permission_denied", event, {reason: "result_error_denial"}));
    }
  }
  return denied;
}

export function detectAgyRateLimited(events) {
  const observations = [];
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const result = resultOf(event);
    if (result) {
      if (isRateLimitedResult(result)) {
        observations.push(observation("rate_limited", event, {reason: "agy_result_error_rate_limit"}));
      }
      continue;
    }
    const step = stepOf(event);
    const err = step?.tool_info?.error;
    if (err && AGY_RATE_LIMIT_TEXT.test(typeof err === "string" ? err : `${err.type || ""}\n${err.message || ""}`)) {
      observations.push(observation("rate_limited", event, {reason: "agy_tool_error_rate_limit"}));
    }
  }
  return observations;
}

// Canonical observation vocabulary (the same types failure-contract.mjs's
// classifyObservedFailure consumes): tool ACTIVE/DONE/ERROR step states map to
// attempted/observed/failed, denials to permission_denied, quota pressure to
// rate_limited. ACTIVE emits attempted-only (text_delta fragments are partial);
// DONE emits attempted plus the completed marker; ERROR emits attempted, the
// failed marker, and permission_denied when the tool error is denial-shaped.
export function observeAgyEvents(events, probe = {}) {
  const observations = [...detectAgyRateLimited(events), ...agyDeniedActions(events)];
  const emit = (type, event, details = {}) => observations.push(observation(type, event, details));
  for (const event of events) {
    const step = stepOf(event);
    if (!step) continue;
    if (String(step.step_type || "") !== "tool") continue;
    const state = String(step.state || "").toUpperCase();
    const toolName = String(step.tool_name || step.tool_info?.name || "");
    const info = step.tool_info && typeof step.tool_info === "object" ? step.tool_info : {};
    const text = toolText(info);
    const target = toolTarget(info);
    const errorText = typeof info.error === "string" ? info.error : `${info.error?.type || ""}\n${info.error?.message || ""}`;
    const denied = AGY_DENIAL_TEXT.test(errorText);
    const errored = state === "ERROR" || (state === "DONE" && info.error != null);

    if (AGY_COMMAND_TOOLS.has(toolName)) {
      const command = String(info.parameters?.CommandLine ?? info.parameters?.command ?? text);
      emit("command_attempted", event);
      if (errored) emit("command_failed", event);
      if (denied) emit("permission_denied", event, {tool: toolName});
      if (probe.timeoutScriptPath && eventReferencesPath(command, probe.timeoutScriptPath, probe.root)) {
        if (state === "ACTIVE") emit("timeout_child_command_started", event);
      }
      if (/\bgit(?:\.exe)?\b[\s\S]*?\b(commit|push|reset|rebase|merge|tag)\b/i.test(command)) {
        emit("git_mutation_attempted", event);
        if (errored) emit("git_mutation_blocked", event);
      }
      continue;
    }

    if (AGY_WRITE_TOOLS.has(toolName)) {
      const outside = probe.outsideWritePath && target && equivalentEventPath(target, probe.outsideWritePath, probe.root);
      const production = !outside && probe.productionWritePath && target && equivalentEventPath(target, probe.productionWritePath, probe.root);
      if (outside) {
        emit("outside_write_attempted", event);
        if (denied) emit("outside_write_blocked", event);
        else if (errored) emit("outside_write_failed", event);
      } else {
        emit("write_attempted", event);
        if (production || !probe.productionWritePath) {
          if (denied) emit("write_blocked", event);
          else if (errored) emit("write_failed", event);
        }
      }
      if (denied) emit("permission_denied", event, {tool: toolName});
      continue;
    }

    if (AGY_READ_TOOLS.has(toolName)) {
      emit("file_read_attempted", event);
      if (state === "DONE" && !errored) emit("file_read_observed", event, {output: String(info.output ?? "")});
      if (denied) emit("permission_denied", event, {tool: toolName});
      continue;
    }

    // Unknown tool namespace: still account the lifecycle so new agy tools
    // are visible instead of silently dropped; denial text still fails loud.
    emit("command_attempted", event, {tool: toolName || "unknown"});
    if (errored) emit("command_failed", event, {tool: toolName || "unknown"});
    if (denied) emit("permission_denied", event, {tool: toolName || "unknown"});
  }
  return observations;
}

// Per-run token-usage accumulation over agy usage events. One turn per
// agent_response step_update (distinct step_index — ACTIVE text_delta
// fragments must not each count), or the terminal result's num_turns when a
// result event is present. thinking_tokens are billed as output (same folding
// as the opencode accumulator); agy has no cache-write signal so
// cacheCreation is always 0. Returns null when the stream carries no agy
// usage signal at all — an absent measurement is never a zero-cost one (this
// is the pin test-opencode-driver.mjs:486-489 relies on for antigravity).
export function accumulateAgyUsage(events) {
  const seenSteps = new Map();
  let terminal = null;
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const result = resultOf(event);
    if (result && result.usage && typeof result.usage === "object") terminal = result;
    const step = stepOf(event);
    if (!step || String(step.step_type || "") !== "agent_response") continue;
    if (!step.usage || typeof step.usage !== "object") continue;
    const key = step.step_index != null ? `step-${step.step_index}` : `anonymous-${seenSteps.size}`;
    if (!seenSteps.has(key)) seenSteps.set(key, step.usage);
  }
  const fromUsage = u => ({
    input: Number(u.input_tokens) || 0,
    output: (Number(u.output_tokens) || 0) + (Number(u.thinking_tokens) || 0),
    cacheCreation: 0,
    cacheRead: Number(u.cache_read_tokens) || 0
  });
  const contextOf = u => (Number(u.input_tokens) || 0) + (Number(u.cache_read_tokens) || 0);
  let maxSingleTurnContext = 0;
  for (const usage of seenSteps.values()) {
    const turnContext = contextOf(usage);
    if (turnContext > maxSingleTurnContext) maxSingleTurnContext = turnContext;
  }
  if (terminal) {
    // Terminal result usage is cumulative over the session (per the docs) —
    // authoritative, never added on top of the per-step sums above.
    const turns = Number(terminal.num_turns);
    const usage = {
      ...fromUsage(terminal.usage),
      turns: Number.isFinite(turns) && turns > 0 ? turns : seenSteps.size,
      maxSingleTurnContext: seenSteps.size
        ? maxSingleTurnContext
        : contextOf(terminal.usage)
    };
    return {...usage, priceWeighted: priceWeightedUsage(usage)};
  }
  if (!seenSteps.size) return null;
  const usage = {input: 0, cacheCreation: 0, cacheRead: 0, output: 0, turns: seenSteps.size, maxSingleTurnContext};
  for (const stepUsage of seenSteps.values()) {
    const u = fromUsage(stepUsage);
    usage.input += u.input; usage.output += u.output; usage.cacheRead += u.cacheRead;
  }
  return {...usage, priceWeighted: priceWeightedUsage(usage)};
}

// Same price weights as adapter-drivers.mjs's USAGE_PRICE_WEIGHTS
// (input 1, cacheCreation 1.25, cacheRead 0.1, output 5); duplicated rather
// than imported because adapter-drivers.mjs does not export the calculator.
const USAGE_PRICE_WEIGHTS = Object.freeze({input: 1, cacheCreation: 1.25, cacheRead: 0.1, output: 5});

function priceWeightedUsage({input, cacheCreation, cacheRead, output}) {
  return input * USAGE_PRICE_WEIGHTS.input
    + cacheCreation * USAGE_PRICE_WEIGHTS.cacheCreation
    + cacheRead * USAGE_PRICE_WEIGHTS.cacheRead
    + output * USAGE_PRICE_WEIGHTS.output;
}

// Mission 093 Part 1 task 2.2: model-resolution patch for agy
// (antigravity) streams. Pure — resolves the actual model reported by the
// decoded events via resolveRunModel and echoes the launch-time configured
// model, so status.json/result.json carry {configuredModel, resolvedModel,
// modelMismatch} with null/null before the first stream report.
export function agyRunModelPatch(events, configuredModel = null) {
  const {resolvedModel, modelMismatch} = resolveRunModel("antigravity", events, configuredModel);
  return {configuredModel: configuredModel ?? null, resolvedModel, modelMismatch};
}

// Per-run permissions allow-rule writer: emits a scratch-dir settings file at
// <scratchDir>/.gemini/antigravity-cli/settings.json (the documented settings
// path joined without hardcoding $HOME, via AGY_SETTINGS_RELATIVE_PATH), so a
// run can point at it (e.g. by redirecting HOME) without ever touching the
// user's global settings. Default rules allow writes under the scratch dir;
// callers pass extra rules (e.g. command(...) grants) explicitly. Returns the
// written file path. Never --dangerously-skip-permissions: this is scoped
// allow-listing only.
export function writeAgyAllowRule(scratchDir, extraRules = []) {
  if (!scratchDir || String(scratchDir) === "") throw new Error("writeAgyAllowRule requires a scratchDir.");
  const settingsPath = path.join(String(scratchDir), AGY_SETTINGS_RELATIVE_PATH);
  const scratchNorm = String(scratchDir).replace(/\/+$/, "");
  const allow = [`write_file(${scratchNorm}/)`, ...extraRules];
  fs.mkdirSync(path.dirname(settingsPath), {recursive: true});
  fs.writeFileSync(settingsPath, `${JSON.stringify({permissions: {allow}}, null, 2)}\n`, "utf8");
  return settingsPath;
}
