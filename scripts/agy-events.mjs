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
import os from "node:os";
import path from "node:path";
export const AGY_SETTINGS_RELATIVE_PATH = ".gemini/antigravity-cli/settings.json";
import {equivalentEventPath, eventReferencesPath} from "./event-paths.mjs";
import {resolveRunModel} from "./model-extract.mjs";
export {agyModelEffortConflict} from "./agy-model-effort.mjs";

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

export function stepOf(event) {
  return event?.step_update && typeof event.step_update === "object" ? event.step_update : null;
}

export function resultOf(event) {
  return event?.result && typeof event.result === "object" ? event.result : null;
}

// Tool-name classification over agy's tool namespace (seen live in init.tools).
export const AGY_WRITE_TOOLS = new Set([
  "write_to_file", "write_file", "replace_file_content", "multi_replace_file_content",
  "notebook_edit", "sed_file", "edit_file"
]);
export const AGY_READ_TOOLS = new Set([
  "view_file", "read_file", "read_resource", "read_url_content",
  "grep_search", "list_dir", "list_resources"
]);
export const AGY_COMMAND_TOOLS = new Set([
  "run_command", "send_command_input"
]);

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

export function toolTarget(info) {
  const params = info?.parameters && typeof info.parameters === "object" ? info.parameters : {};
  for (const key of ["TargetFile", "filePath", "file_path", "path", "File", "Path", "AbsolutePath", "file", "target_file"]) {
    if (params[key] != null && String(params[key]) !== "") return String(params[key]);
  }
  return "";
}

// Denial phrasing only — narrow on purpose (mirrors the driver modules: match
// an actual denial, never bare "denied"/"blocked" prose).
const AGY_DENIAL_TEXT = /permission denied|rejected permission|not permitted|denied by policy|blocked by policy|requires approval|soft-denied|needs approval|auto-?denied|cannot prompt for/i;

// Rate-limit shapes: the CLI surfaces quota/429 pressure as a terminal ERROR
// result (error text) — never prose. 429 plus the documented quota/credit and
// availability phrasings all map to the same operator-visible state.
const AGY_RATE_LIMIT_TEXT = /rate[_\s-]?limit|status.?429|\b429\b|quota|insufficient account funds|endpoint is unavailable|credits? exhausted|too many requests/i;

function isRateLimitedResult(result) {
  if (!result) return false;
  return AGY_RATE_LIMIT_TEXT.test(`${result.error || ""}\n${result.status || ""}`);
}

export function extractAgyDeniedActionPaths(deniedActions, events = []) {
  const paths = [];
  const actionsWithPaths = [];
  let allResolved = true;

  for (const rawAction of Array.isArray(deniedActions) ? deniedActions : []) {
    const action = String(rawAction || "");
    const match = action.match(/\(([^)]+)\)/);
    let resolvedPath = null;
    if (match) {
      const candidate = match[1].trim().replace(/^['"]|['"]$/g, "");
      if (candidate.startsWith("/") || candidate.startsWith("./") || candidate.startsWith("../") || candidate.startsWith("~") || /^[a-zA-Z]:[\\/]/.test(candidate)) {
        resolvedPath = candidate;
      }
    }

    if (!resolvedPath && Array.isArray(events)) {
      for (const event of events) {
        const step = stepOf(event);
        if (!step || String(step.step_type || "") !== "tool") continue;
        const toolName = String(step.tool_name || step.tool_info?.name || "");
        if (!toolName) continue;
        if (action === toolName || action.startsWith(toolName) || action.includes(toolName) || toolName.includes(action)) {
          const target = toolTarget(step.tool_info);
          if (target) {
            resolvedPath = target;
            break;
          }
        }
      }
    }

    if (resolvedPath) {
      paths.push(resolvedPath);
      actionsWithPaths.push({action, path: resolvedPath});
    } else {
      allResolved = false;
      actionsWithPaths.push({action, path: null});
    }
  }

  return {paths, allResolved, actionsWithPaths};
}

export function isPathInsideRepo(targetPath, repoRoot) {
  if (!targetPath || !repoRoot) return false;
  try {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    let expanded = String(targetPath);
    if (home && (expanded.startsWith("~/") || expanded === "~")) {
      expanded = path.join(home, expanded.slice(1));
    }
    const absTarget = path.resolve(repoRoot, expanded);
    const absRepo = path.resolve(repoRoot);
    const rel = path.relative(absRepo, absTarget);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

export function isPathAllowedWorkspace(targetPath, {root = null, scratchDir = null, handoffDir = null} = {}) {
  if (!targetPath || !root) return false;
  if (isPathInsideRepo(targetPath, root)) return true;
  if (scratchDir && isPathInsideRepo(targetPath, scratchDir)) return true;
  if (handoffDir && isPathInsideRepo(targetPath, handoffDir)) return true;
  return false;
}

export function agyPathInstruction(repoRoot) {
  const rootStr = String(repoRoot || "").trim();
  return `Write files only with absolute paths inside ${rootStr}; never build paths relative to your own brain/ or app-data directory.`;
}

export function resolveHandoffPathsInBrief(text, {repoRoot = null, scratchDir = null, useSandboxPaths = false} = {}) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  const repoBase = useSandboxPaths ? "/workspace/repository" : (repoRoot ? String(repoRoot).replace(/\/+$/, "") : null);
  if (repoBase) {
    out = out.replace(/(^|[\s`"'(\[])(\.autopilot\/missions\/[^\s`"')\].,;:]+?\/handoff\/[^\s`"')\].,;:]+\.md)/g, (m, prefix, rel) => {
      return `${prefix}${repoBase}/${rel}`;
    });
  }
  if (!useSandboxPaths && scratchDir) {
    const scratchNorm = String(scratchDir).replace(/\/+$/, "");
    out = out.replace(/\/workspace\/scratch(?=\/|[\s`"')\].,;:]|$)/g, scratchNorm);
  }
  return out;
}

export function isPathInCliDataDir(targetPath, cliDataDir = null, repoRoot = null) {
  if (!targetPath) return false;
  try {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const dataDir = cliDataDir ? path.resolve(cliDataDir) : path.resolve(home, ".gemini", "antigravity-cli");
    const geminiDir = path.resolve(home, ".gemini");

    let expanded = targetPath;
    if (expanded.startsWith("~/") || expanded === "~") {
      expanded = path.join(home, expanded.slice(1));
    }
    const absTarget = path.isAbsolute(expanded)
      ? path.resolve(expanded)
      : path.resolve(repoRoot || process.cwd(), expanded);

    const rel = path.relative(dataDir, absTarget);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return true;
    const relGemini = path.relative(geminiDir, absTarget);
    return !relGemini.startsWith("..") && !path.isAbsolute(relGemini);
  } catch {
    return false;
  }
}

function collectDeniedWritePaths(result, events = []) {
  const evidence = Array.isArray(result?.failure?.evidence) ? result.failure.evidence : [];
  const observations = Array.isArray(result?.observations) ? result.observations : [];
  const allEvents = Array.isArray(events) ? events : [];
  const allObs = [...evidence, ...observations];

  const deniedPaths = [];
  let hasDenial = false;
  let hasUnknownAction = false;

  for (const obs of allObs) {
    if (obs?.type !== "permission_denied" && obs?.type !== "path_outside_workspace") continue;
    hasDenial = true;

    let obsResolved = false;
    if (obs.allActionsResolved === false) {
      hasUnknownAction = true;
    } else if (obs.allActionsResolved === true) {
      obsResolved = true;
    }

    if (Array.isArray(obs.paths) && obs.paths.length > 0) {
      deniedPaths.push(...obs.paths);
    }
    if (Array.isArray(obs.targets) && obs.targets.length > 0) {
      deniedPaths.push(...obs.targets);
    }
    if (typeof obs.path === "string" && obs.path) {
      deniedPaths.push(obs.path);
    }

    if (!obsResolved && Array.isArray(obs.actions) && obs.actions.length > 0) {
      if (Array.isArray(obs.paths) && obs.paths.length === obs.actions.length) {
        obsResolved = true;
      } else {
        const extracted = extractAgyDeniedActionPaths(obs.actions, allEvents);
        deniedPaths.push(...extracted.paths);
        if (!extracted.allResolved) {
          hasUnknownAction = true;
        }
      }
    } else if (obs.actions && !Array.isArray(obs.actions)) {
      hasUnknownAction = true;
    }

    const step = obs.event?.step_update || obs.event?.step;
    if (step && typeof step === "object") {
      const target = toolTarget(step.tool_info);
      if (target) deniedPaths.push(target);
    }
  }

  for (const ev of allEvents) {
    const res = ev?.result;
    if (res && Array.isArray(res.denied_actions) && res.denied_actions.length > 0) {
      hasDenial = true;
      const extracted = extractAgyDeniedActionPaths(res.denied_actions, allEvents);
      deniedPaths.push(...extracted.paths);
      if (!extracted.allResolved) {
        hasUnknownAction = true;
      }
    }
  }

  return {deniedPaths, hasDenial, hasUnknownAction};
}

export function isOutOfRepoWritePermissionDenied(result, repoRoot, events = [], allowedDirs = {}) {
  const isPermDenied = result?.failure?.class === "PERMISSION_DENIED" && result?.failure?.domain === "adapter";
  const isPathSlip = result?.failure?.class === "PATH_OUTSIDE_WORKSPACE" && result?.failure?.domain === "model";
  if (!result || (!isPermDenied && !isPathSlip)) {
    return false;
  }

  const {deniedPaths, hasDenial, hasUnknownAction} = collectDeniedWritePaths(result, events);

  if (!hasDenial) return false;
  if (hasUnknownAction || deniedPaths.length === 0) return false;

  const dirs = {
    root: repoRoot,
    scratchDir: allowedDirs?.scratchDir || null,
    handoffDir: allowedDirs?.handoffDir || null,
  };

  for (const p of deniedPaths) {
    if (!p) return false;
    if (isPathAllowedWorkspace(p, dirs)) return false;
  }

  return true;
}

export function decideDeniedWriteRetry({
  result,
  repo,
  events = [],
  retries = {},
  taskKey = null,
  scratch = null,
  handoffNotePath = null,
  handoffDir = null,
  readOnly = false,
} = {}) {
  if (readOnly) {
    return {retry: false, note: null, nextRetries: retries || {}};
  }
  const isPermDenied = result?.failure?.class === "PERMISSION_DENIED" && result.failure?.domain === "adapter";
  const isPathSlip = result?.failure?.class === "PATH_OUTSIDE_WORKSPACE" && result.failure?.domain === "model";
  if (!isPermDenied && !isPathSlip) {
    return {retry: false, note: null, nextRetries: retries || {}};
  }
  const isOutOfRepo = isOutOfRepoWritePermissionDenied(result, repo, events, {scratchDir: scratch, handoffDir});
  const key = taskKey || "default";
  const retriedCount = (retries && typeof retries === "object") ? (retries[key] || 0) : 0;
  if (isOutOfRepo && retriedCount === 0) {
    const scratchDir = scratch || "";
    const {deniedPaths} = collectDeniedWritePaths(result, events);
    const badPath = deniedPaths[0] || "";
    let note;
    if (isPathSlip || handoffNotePath) {
      const matchesHandoff = Boolean(handoffNotePath && badPath && path.basename(badPath) === path.basename(handoffNotePath));
      const correctPath = matchesHandoff
        ? handoffNotePath
        : (scratchDir && badPath ? path.join(scratchDir, path.basename(badPath)) : (handoffNotePath || scratchDir || repo || ""));
      note = `Write only inside the repository; your write to ${badPath} was outside the workspace; the correct path is ${correctPath}.${scratchDir ? ` Your scratch dir is ${scratchDir}.` : ""}`;
    } else {
      note = scratchDir
        ? `Write only inside the repository; your scratch dir is ${scratchDir}.`
        : `Write only inside the repository.`;
    }
    const nextRetries = {...(retries || {}), [key]: 1};
    return {retry: true, note, nextRetries};
  }
  return {retry: false, note: null, nextRetries: retries || {}};
}

// A denied_actions loud failure: the terminal result carries a non-empty
// denied_actions list (scripted fixture shape), or an ERROR result whose error
// is denial-shaped. Either is the CLI's own structured outcome — never model
// prose — so it maps to permission_denied regardless of exit code.
// Backlog #3: when EVERY denied action's target path resolves outside the
// workspace (repo, scratch, mission handoff dir), classify it as
// path_outside_workspace (model path slip) instead of permission_denied.
export function agyDeniedActions(events, probe = {}) {
  const denied = [];
  const checkOutside = Boolean(probe?.root && !probe?.outsideWritePath);
  for (const event of events) {
    const result = resultOf(event);
    if (result && Array.isArray(result.denied_actions) && result.denied_actions.length > 0) {
      const {paths, allResolved} = extractAgyDeniedActionPaths(result.denied_actions, events);
      const allOutside = checkOutside && allResolved && paths.length > 0
        && paths.every((p) => !isPathAllowedWorkspace(p, probe));
      denied.push(observation(allOutside ? "path_outside_workspace" : "permission_denied", event, {
        reason: allOutside ? "denied_actions_outside_workspace" : "denied_actions",
        actions: result.denied_actions,
        ...(paths.length > 0 ? {paths, targets: paths} : {}),
        allActionsResolved: allResolved
      }));
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

// Auth-required shapes: agy emits a terminal ERROR result with
// "authentication failed or timed out" when logged out. Produces a structured
// auth_required observation with adapter "antigravity" so the classifier marks
// it AUTH_REQUIRED (non-retryable) instead of PROCESS_EXIT_NONZERO.
const AGY_AUTH_REQUIRED_TEXT = /authentication failed or timed out/i;

export function detectAgyAuthRequired(events) {
  const observations = [];
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const result = resultOf(event);
    if (!result) continue;
    if (String(result.status || "").toUpperCase() !== "ERROR") continue;
    const errorText = typeof result.error === "string" ? result.error : "";
    const match = errorText.match(AGY_AUTH_REQUIRED_TEXT);
    if (!match) continue;
    observations.push(observation("auth_required", event, {
      adapter: "antigravity",
      reason: match[0],
      message: errorText.slice(0, 200),
    }));
  }
  return observations;
}

// Invalid model selection: antigravity rejects a model/effort conflict before
// the first turn ("invalid model selection ... conflicts with --effort=medium").
// Produces a structured observation so the classifier marks it INVOCATION_MISMATCH
// (non-retryable adapter failure).
export const AGY_INVALID_MODEL_TEXT = /invalid model selection/i;

export function detectAgyInvalidModel(events) {
  const observations = [];
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    let message = "";
    if (event.type === "stderr" || event.type === "unparsed_stdout") {
      message = String(event.text || "");
    } else {
      const result = resultOf(event);
      if (result) {
        message = `${result.error || ""} ${result.message || ""}`;
      } else if (event.error) {
        message = typeof event.error === "string" ? event.error : `${event.error.type || ""} ${event.error.message || ""}`;
      } else if (typeof event.message === "string") {
        message = event.message;
      } else {
        message = JSON.stringify(event);
      }
    }
    if (AGY_INVALID_MODEL_TEXT.test(message)) {
      observations.push(observation("invalid_model", event, {reason: "agy_invalid_model_selection", message: message.slice(0, 200)}));
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
  const observations = [...detectAgyRateLimited(events), ...detectAgyAuthRequired(events), ...agyDeniedActions(events, probe), ...detectAgyInvalidModel(events)];
  const emit = (type, event, details = {}) => observations.push(observation(type, event, details));
  const checkOutside = Boolean(probe?.root && !probe?.outsideWritePath);
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
      if (denied) emit("permission_denied", event, {tool: toolName, path: target || undefined, targets: target ? [target] : []});
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
      if (denied) {
        const isOutside = checkOutside && target && !isPathAllowedWorkspace(target, probe);
        emit(isOutside ? "path_outside_workspace" : "permission_denied", event, {
          tool: toolName,
          path: target || undefined,
          targets: target ? [target] : [],
          ...(isOutside ? {reason: "tool_denied_outside_workspace"} : {}),
        });
      }
      continue;
    }

    if (AGY_READ_TOOLS.has(toolName)) {
      emit("file_read_attempted", event);
      if (state === "DONE" && !errored) emit("file_read_observed", event, {output: String(info.output ?? "")});
      if (denied) {
        const isOutside = checkOutside && target && !isPathAllowedWorkspace(target, probe);
        emit(isOutside ? "path_outside_workspace" : "permission_denied", event, {
          tool: toolName,
          path: target || undefined,
          targets: target ? [target] : [],
          ...(isOutside ? {reason: "tool_denied_outside_workspace"} : {}),
        });
      }
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
// fragments must not each count); when a terminal result is present, turns
// preserves the step count (using num_turns only if no steps were seen, or the
// max of both). thinking_tokens are billed as output (same folding
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
    // Distinct agent_response steps count turns; terminal.num_turns is used
    // when no steps were seen or to ensure turns is not lower than num_turns.
    const rawTurns = Number(terminal.num_turns);
    const termTurns = Number.isFinite(rawTurns) && rawTurns > 0 ? rawTurns : 0;
    const turns = seenSteps.size > 0 ? Math.max(seenSteps.size, termTurns) : termTurns;
    const usage = {
      ...fromUsage(terminal.usage),
      turns,
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

function resolveHomeDir(options) {
  if (typeof options === "string" && options.length > 0) return options;
  if (options && typeof options === "object" && typeof options.homeDir === "string" && options.homeDir.length > 0) {
    return options.homeDir;
  }
  if (process.env.AGY_TEST_HOME && process.env.AGY_TEST_HOME.length > 0) {
    return process.env.AGY_TEST_HOME;
  }
  if (process.env.AGY_HOME && process.env.AGY_HOME.length > 0) {
    return process.env.AGY_HOME;
  }
  return os.homedir();
}

function readGlobalPermissions(homeDir) {
  try {
    if (!homeDir || typeof homeDir !== "string") return null;
    const globalPath = path.join(homeDir, AGY_SETTINGS_RELATIVE_PATH);
    if (!fs.existsSync(globalPath)) return null;
    const raw = fs.readFileSync(globalPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (!parsed.permissions || typeof parsed.permissions !== "object" || Array.isArray(parsed.permissions)) return null;
    return parsed.permissions;
  } catch {
    return null;
  }
}

// Per-run permissions allow-rule writer: emits a scratch-dir settings file at
// <scratchDir>/.gemini/antigravity-cli/settings.json (the documented settings
// path joined without hardcoding $HOME, via AGY_SETTINGS_RELATIVE_PATH), so a
// run can point at it (e.g. by redirecting HOME) without ever touching the
// user's global settings. Merges the user's global permissions (allow rules
// appended and deduplicated; deny rules and other permission lists copied
// unchanged) so user grants/denials are preserved. Returns the written file path.
// Never --dangerously-skip-permissions: this is scoped allow-listing only.
export function writeAgyAllowRule(scratchDir, extraRules = [], options = {}) {
  if (!scratchDir || String(scratchDir) === "") throw new Error("writeAgyAllowRule requires a scratchDir.");
  const settingsPath = path.join(String(scratchDir), AGY_SETTINGS_RELATIVE_PATH);
  const scratchNorm = String(scratchDir).replace(/\/+$/, "");
  const ourRules = [`write_file(${scratchNorm}/)`, ...(Array.isArray(extraRules) ? extraRules : [])];

  const homeDir = resolveHomeDir(options);
  const globalPermissions = readGlobalPermissions(homeDir);

  const userAllow = Array.isArray(globalPermissions?.allow) ? globalPermissions.allow : [];
  const allow = [...new Set([...ourRules, ...userAllow])];

  const permissions = {allow};
  if (globalPermissions) {
    for (const [key, value] of Object.entries(globalPermissions)) {
      if (key === "allow") continue;
      if (key === "deny" || Array.isArray(value)) {
        permissions[key] = Array.isArray(value) ? [...value] : value;
      }
    }
  }

  fs.mkdirSync(path.dirname(settingsPath), {recursive: true});
  fs.writeFileSync(settingsPath, `${JSON.stringify({permissions}, null, 2)}\n`, "utf8");
  return settingsPath;
}

// Write roles get command(*), the same policy as opencode --auto /
// claude --allowedTools Bash / codex --sandbox workspace-write; agy's other
// checks stay; never --dangerously-skip-permissions.
export function agyAllowRulesForRole(roleName, config = {}, {speckit = false, repo} = {}) {
  return ["command(*)"];
}

// Backlog #7: extra argv for the production relay. An agy WRITE role gets
// `--settings <file>`, a per-run file under the run's own dir; read-only runs
// and other adapters get nothing (read-only containment is unchanged).
export function agyRelayExtraArgs({adapter, readOnly, roleName, config, runDir, repo, homeDir}) {
  if (adapter !== "antigravity" || readOnly) return [];
  const rules = agyAllowRulesForRole(roleName, config, {speckit: fs.existsSync(path.join(String(repo ?? ""), ".specify")), repo});
  return ["--settings", writeAgyAllowRule(path.join(String(runDir), "agy"), rules, {homeDir})];
}
