import fs from "node:fs";
import path from "node:path";
import {spawnAgentSync, resolveAgentBinary} from "./agent-process.mjs";
import {equivalentEventPath, eventReferencesPath} from "./event-paths.mjs";
// agy stream-json event helpers (decode/observe/accumulate) plus the per-run
// permissions allow-rule writer. Imported for driver dispatch only; the
// reverse import (AGY_SETTINGS_RELATIVE_PATH) is a cycle resolved by function
// hoisting — no module-level execution in either file touches it.
import {decodeAgyEvents, observeAgyEvents, accumulateAgyUsage, agyRunModelPatch, writeAgyAllowRule} from "./agy-events.mjs";
import {resolveRunModel} from "./model-extract.mjs";
import {updateRunModel} from "./run-observability.mjs";
import {FREE_QUOTA_REASON, OPENCODE_TITLE_MODEL_LINE_RE} from "./idle-hang-watchdog.mjs";
import {detectOpenCodeGeneration, splitOpenCodeModelSuffix} from "./opencode-generation.mjs";

const DRIVERS = Object.freeze({
  codex: codexDriver(),
  antigravity: agyDriver(),
  opencode: opencodeDriver(),
  claude: claudeDriver()
});

export function adapterDriver(adapterId) {
  return DRIVERS[adapterId] || null;
}

function codexDriver() {
  return {
    id: "codex",
    contractVersion: 2,
    resolveBinary: binary => resolveAgentBinary(binary),
    version: binary => versionOf(binary),
    buildInvocation: codexInvocation,
    appliedSelections: codexAppliedSelections,
    detectProviderProfile: codexProviderProfile,
    trustedEnvelopeArgs: codexTrustedEnvelopeArgs,
    decodeEvents: decodeJsonLines,
    observe: observeCodexEvents,
    structuredTransport: "event-stream"
  };
}

// OpenCode 1.18.x contract-v2 driver. Event/transport semantics were captured
// live from native Linux OpenCode 1.18.22 (`opencode run --format json`):
// NDJSON events {type:"step_start"|"text"|"tool_use"|"step_finish", part:{...}}.
// Tool parts carry tool:"read"|"write"|"bash"|..., state.status
// ("completed"|"error") and state.input/state.output/state.error.
// CRITICAL: a bash tool part reports state.status:"completed" even when the
// command failed — the real exit code lives ONLY in state.metadata.exit.
// Success/failure is therefore derived exclusively from trusted event
// metadata, never from model prose or the coarse status field.
//
// --auto is a PERMISSION UX flag required for noninteractive runs; it is NOT
// an isolation or safety boundary. Repository/outside-write/Git containment
// claims may come only from the trusted WSL execution envelope plus observed
// certification evidence.
function opencodeDriver() {
  return {
    id: "opencode",
    contractVersion: 2,
    resolveBinary: resolveOpenCodeBinary,
    version: binary => versionOf(binary),
    buildInvocation: opencodeInvocation,
    appliedSelections: opencodeAppliedSelections,
    detectProviderProfile: () => null,
    trustedEnvelopeArgs: opencodeTrustedEnvelopeArgs,
    decodeEvents: decodeJsonLines,
    observe: observeOpenCodeEvents,
    structuredTransport: "sentinel"
  };
}

function resolveOpenCodeBinary(binary) {
  const resolved = resolveAgentBinary(binary);
  if (!fs.existsSync(resolved)) return resolved;
  return fs.realpathSync(resolved);
}

function opencodeInvocation(request) {
  // --print-logs: the only place opencode reports the model it ran (#107).
  const args = ["run", "--print-logs", "--format", "json"];
  // 2.x resolves config-defined agents (autopilot_readonly lives in
  // OPENCODE_CONFIG_CONTENT) only in a private server, so every run role on
  // that generation needs --standalone.
  const generation = detectOpenCodeGeneration({binary: request.binary});
  if (generation === "2") args.push("--standalone");
  if (["write", "scratch"].includes(request.mode)) args.push("--auto");
  // Not the native "plan" agent: OpenCode 1.18.29's built-in "plan" agent
  // carries an unconditional `edit "*": deny` in its own resolved permission
  // list that no override (top-level or agent.plan-scoped) can defeat — its
  // permission engine is deny-wins (any matching deny beats any matching
  // allow, regardless of specificity or which config source is "last"), so a
  // read-only role could never be granted the sanctioned-scratch write it
  // needs. "autopilot_readonly" is a custom agent this adapter's own
  // OPENCODE_CONFIG_CONTENT defines (see opencode-runtime-config.mjs's
  // opencodeRuntimeConfigOverride()) with no baked-in deny at all —
  // repository containment still comes from bubblewrap's read-only bind, not
  // from this permission block.
  else args.push("--agent", "autopilot_readonly");
  // 2.x carries the effort level as provider/model#level (there is no
  // --variant); 1.x keeps the flag it was verified against.
  const effort = generation === "2" && request.reasoning;
  if (effort && !request.model) throw new Error("OpenCode 2.x reasoning/effort requires a selected model.");
  if (request.model || effort) {
    args.push("--model", effort ? `${request.model}#${request.reasoning}` : request.model);
  }
  if (request.reasoning && generation !== "2") args.push("--variant", request.reasoning);
  return {binary: request.binary, args};
}

function opencodeAppliedSelections(invocation) {
  const pick = flag => {
    const index = invocation.args.indexOf(flag);
    return index >= 0 ? invocation.args[index + 1] : null;
  };
  const model = pick("--model");
  if (model && String(model).includes("#")) {
    const split = splitOpenCodeModelSuffix(model);
    return {model: split.model, reasoning: split.reasoning};
  }
  return {model, reasoning: pick("--variant")};
}

// Containment inside the trusted envelope comes from bubblewrap, not from any
// OpenCode flag. The mapping validates shape only.
function opencodeTrustedEnvelopeArgs(values) {
  const args = [...values];
  if (!args.includes("run")) throw new Error("OpenCode trusted-envelope invocation requires 'run'.");
  return args;
}

// OpenCode's own denial phrasing, deliberately narrow. Unlike the `blocked`
// regex inside the observer below — which tests bare "denied"/"permission"/
// "blocked" substrings and is consumed only by the *_blocked branches — this
// matches an actual denial without widening to unrelated prose. Verified
// against OpenCode's live text: "The user rejected permission to use this
// specific tool call." Codex's PERMISSION_DENIAL_TEXT is not shared or reused
// here: it belongs to permissionDenied()/observeCodexEvents only, and does not
// match that phrasing anyway.
const OPENCODE_DENIAL_TEXT = /permission denied|rejected permission|not permitted|blocked by policy/i;
// Auto-rejected out-of-sandbox refusal (mission 022 part 1, phase 2.1):
// OpenCode's permission engine auto-rejects tool calls touching paths outside
// the project sandbox. The refusal surfaces as a rejected tool event whose
// state.error carries only the generic "The user rejected permission to use
// this specific tool call." wording, while the explanation
// ("permission requested: external_directory (...); auto-rejecting") is
// emitted ONLY on process stderr — never inside the tool event itself (live:
// mission 021 run 18-verifier-bd5860b5, `cat /tmp/...`). Such a refusal is
// NON-TERMINAL — the agent already received it from opencode and keeps
// working — so the observer records it as a warning observation, never
// permission_denied. Detection correlates the rejected event with (a) the
// stderr auto-reject line anywhere in the decoded run, and/or (b) an
// out-of-sandbox path in the tool input when stderr is unavailable. This
// shape takes precedence over the strict terminal-denial path (task 1.4): a
// correlated write/edit/patch/multiedit auto-reject keeps
// write_blocked/outside_write_blocked but emits zero permission_denied.
const AUTO_REJECT_STDERR_TEXT = /permission requested:\s*external_directory[\s\S]*?auto-rejecting/i;
// The CLI's own generic auto-reject phrasing in state.error (live text).
// Narrower than OPENCODE_DENIAL_TEXT on purpose: the input-path-only prong
// must not demote genuine policy denials ("not permitted by policy",
// "permission denied") that merely touch an outside path — those stay
// terminal per task 1.4. The stderr-correlated prong needs no such narrowing:
// no existing terminal-denial fixture carries a stderr event, so it cannot
// regress them.
const AUTO_REJECT_ERROR_TEXT = /rejected permission to use this specific tool call/i;

// The review sentinel token, used ONLY to suppress a denial whose run still
// produced a verdict. Loose and suppression-only on purpose: the authoritative
// parser is failure-contract.mjs's parseReviewContract(), which alone decides
// whether a verdict is valid. A false positive here can only mean the denial
// goes untagged, falling back to the existing STRUCTURED_OUTPUT_MISSING path —
// never the unsafe direction. Not prose-as-evidence.
const SENTINEL_TOKEN = "AUTOPILOT_REVIEW";

// OpenCode-specific observation over captured live event shapes. Emits the
// same canonical observation vocabulary the certifier consumes
// (file_read_*, write_*, outside_write_*, git_mutation_*, command_*,
// timeout_child_command_started, permission_denied).
function observeOpenCodeEvents(events, probe = {}) {
  const observations = [...detectOpenCodeRateLimited(events), ...detectOpenCodeProviderError(events), ...detectOpenCodeAgentNotFound(events)];
  const emit = (type, event, details = {}) => observations.push({type, source: "cli_event", ...details, event});
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const part = event?.part || {};
    const type = String(event?.type || part.type || "");
    if (type !== "tool_use" && type !== "tool") continue;
    const tool = String(part.tool || "");
    const state = part.state || {};
    const status = String(state.status || "");
    const input = state.input || {};
    const meta = state.metadata || {};
    const errorText = `${state.error || ""}\n${state.output || ""}`;
    // Trusted failure derivation: explicit error status, or bash exit != 0
    // delivered through metadata.exit (status stays "completed" on failure).
    const exitValue = Number.isFinite(Number(meta.exit)) ? Number(meta.exit) : null;
    const failed = status === "error" || exitValue === null ? status === "error" : exitValue !== 0;
    const blocked = status === "error" && /denied|permission|not permitted|read-only|blocked/i.test(errorText);

    if (tool === "read") {
      emit("file_read_attempted", event);
      if (status === "completed") emit("file_read_observed", event, {output: String(state.output ?? "")});
      // A correlated auto-reject is a non-terminal warning, never
      // permission_denied — it takes precedence over terminalDenial().
      if (autoRejectedOutOfSandbox(events, tool, input, status, state, probe)) emit("out_of_sandbox_auto_reject_warning", event, autoRejectWarningDetails(tool, input));
      // Strict terminal denials only, via the one shared terminalDenial()
      // predicate — never the loose `blocked` regex. A denial the role worked
      // around stays untagged per terminalDenial()'s suppression.
      else if (terminalDenial(events, index, status, state)) emit("permission_denied", event);
      continue;
    }

    if (tool === "bash") {
      const command = String(input.command ?? "");
      emit("command_attempted", event);
      if (failed) emit("command_failed", event, {exit: exitValue});
      // A correlated auto-reject is a non-terminal warning, never
      // permission_denied — it takes precedence over terminalDenial().
      // permission_denied is trusted structured
      // failure evidence that is preserved even on a completed, policy-clean
      // result and outranks the role's own verdict by domain priority, so
      // tagging a recovered denial would escalate a mission whose reviewer did
      // produce findings.
      if (autoRejectedOutOfSandbox(events, tool, input, status, state, probe)) emit("out_of_sandbox_auto_reject_warning", event, autoRejectWarningDetails(tool, input));
      else if (terminalDenial(events, index, status, state)) emit("permission_denied", event);
      if (probe.timeoutScriptPath && eventReferencesPath(command, probe.timeoutScriptPath, probe.root)) {
        emit("timeout_child_command_started", event);
      }
      if (/\bgit(?:\.exe)?\b[\s\S]*?\b(commit|push|reset|rebase|merge|tag)\b/i.test(command)) {
        emit("git_mutation_attempted", event);
        const guardWrapper = probe.gitGuardWrapperPath
          ? eventReferencesPath(command, probe.gitGuardWrapperPath, null)
          : false;
        const guardMarker = /AUTOPILOT GIT GUARD|read-only file system|blocked by .*hook|ref update blocked/i.test(`${commandOutputText(state)}\n${errorText}`);
        if (blocked || (guardWrapper && guardMarker)) emit("git_mutation_blocked", event);
      }
      continue;
    }

    if (tool === "write" || tool === "edit" || tool === "patch" || tool === "multiedit") {
      const target = String(input.filePath ?? input.file_path ?? "");
      const outside = probe.outsideWritePath && equivalentEventPath(target, probe.outsideWritePath, probe.root);
      const production = !outside && probe.productionWritePath && equivalentEventPath(target, probe.productionWritePath, probe.root);
      if (outside) {
        emit("outside_write_attempted", event);
        if (blocked) emit("outside_write_blocked", event);
        else if (failed) emit("outside_write_failed", event);
      } else {
        emit("write_attempted", event);
        if (production || !probe.productionWritePath) {
          if (blocked) emit("write_blocked", event);
          else if (failed) emit("write_failed", event);
        }
      }
      // A correlated auto-reject is a non-terminal warning, never
      // permission_denied — it takes precedence over terminalDenial() per
      // task 1.4's exception: a correlated write/edit/patch/multiedit
      // auto-reject keeps write_blocked/outside_write_blocked (emitted above)
      // but emits zero permission_denied.
      if (autoRejectedOutOfSandbox(events, tool, input, status, state, probe)) emit("out_of_sandbox_auto_reject_warning", event, autoRejectWarningDetails(tool, input));
      // Strict terminal denials only, via the one shared terminalDenial()
      // predicate — never the loose `blocked` regex. Kept additive: the
      // existing write_blocked/outside_write_blocked vocabulary above is
      // unchanged.
      else if (terminalDenial(events, index, status, state)) emit("permission_denied", event);
      continue;
    }
  }
  return observations;
}

// opencode provider errors (never prose). Two channels carry them:
// - the structured stdout error event `{"type":"error","error":{"name":
//   "APIError","data":{"message":...,"statusCode":429}}}` (2026-10-13
//   incident B);
// - opencode's own logfmt ERROR line on stderr (mission 2026-10-28 backlog
//   #14: `error.error="AI_APICallError: Free usage limit reached ..."`, no
//   429 status at all).
// Rate limit, quota ("Insufficient account funds") and the free tier's
// "Endpoint is unavailable"/"Free usage limit reached" are all the same
// operator-visible state: RATE_LIMITED. The 1.x stderr branch requires the
// engine error source token (`AI_APICallError`/`AI_RetryError`); 2.x logfmt
// ERROR lines instead carry `cause=`/`role=server` (real 2.2.0 shape, see
// scripts/test-fixtures/opencode-2x-run-bad-model.stderr.txt). Either way the
// line must come from stderr, so model prose or tool output containing the
// same words never matches.
const OPENCODE_FREE_QUOTA_MESSAGE = /free usage limit reached|usage limit reached|insufficient[_\s-]?quota|quota[_\s-]?(?:exceeded|exhausted)|subscribe to [^\n]{0,80}to keep going/i;
const OPENCODE_RATE_LIMIT_MESSAGE = new RegExp(`rate[_\\s]limit[_\\s]exceeded|endpoint is unavailable|insufficient account funds|${OPENCODE_FREE_QUOTA_MESSAGE.source}`, "i");
const OPENCODE_PROVIDER_ERROR_SOURCE = /AI_APICallError|AI_RetryError/;
// 2.x's own logfmt ERROR lines are engine-level diagnostics too, but they do
// not spell the 1.x AI SDK error class. The structural marker (server role or
// a stack-bearing cause=) keeps the existing 1.x negative control — a no-source
// line is still not a rate-limit hit — intact.
const OPENCODE_2X_ENGINE_ERROR_LINE = /\blevel=ERROR\b[^\n]*(?:\brole=server\b|\bcause=)/;
function openCodeEngineErrorLine(text) {
  return OPENCODE_PROVIDER_ERROR_SOURCE.test(text) || OPENCODE_2X_ENGINE_ERROR_LINE.test(text);
}
function detectOpenCodeRateLimited(events) {
  const observations = [];
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (event.type === "stderr") {
      const text = String(event.text ?? "");
      // Backlog #107: the small title-generation model's stream errors
      // (small=true agent=title) say nothing about the role's own model, so a
      // completed run must never be reclassified RATE_LIMITED from one.
      if (OPENCODE_TITLE_MODEL_LINE_RE.test(text)) continue;
      if (!openCodeEngineErrorLine(text) || !OPENCODE_RATE_LIMIT_MESSAGE.test(text)) continue;
      observations.push(observation("rate_limited", event, {
        reason: OPENCODE_FREE_QUOTA_MESSAGE.test(text) ? FREE_QUOTA_REASON : "opencode_stderr_rate_limit",
        message: text.slice(0, 200),
      }));
      continue;
    }
    if (event.type !== "error") continue;
    const err = event.error && typeof event.error === "object" ? event.error : {};
    const data = err.data && typeof err.data === "object" ? err.data : {};
    const status = Number(data.statusCode ?? err.statusCode);
    const message = String(data.message ?? err.message ?? "");
    if (status === 429 || OPENCODE_RATE_LIMIT_MESSAGE.test(message)) {
      const freeQuota = OPENCODE_FREE_QUOTA_MESSAGE.test(message);
      observations.push(observation("rate_limited", event, {
        reason: freeQuota ? FREE_QUOTA_REASON : status === 429 ? "api_error_status_429" : "opencode_error_message",
      }));
    }
  }
  return observations;
}

// Backlog #106: opencode's generic provider/model-side failure — the stream's
// only error event is `{"type":"error","error":{"name":"UnknownError","data":
// {"message":"Unexpected server error. ..."}}}` and the run did no tool work
// (a failure tied to the brief/model, not to anything the agent did). Not a
// rate limit (detectOpenCodeRateLimited keeps precedence in the classifier).
// 2.x reports an unavailable model as `{"type":"error","error":{"type":
// "provider.no-route","message":"Model unavailable: provider/model"}}`; that is
// the same provider/model-side failure class even when tools already ran.
const OPENCODE_PROVIDER_ERROR_MESSAGE = /unexpected server error/i;
const OPENCODE_MODEL_UNAVAILABLE_MESSAGE = /model unavailable/i;
function detectOpenCodeProviderError(events) {
  const hasToolUse = events.some(event => event && typeof event === "object"
    && (event.type === "tool_use" || event.type === "tool" || event.part?.type === "tool"));
  const observations = [];
  for (const event of events) {
    if (!event || typeof event !== "object" || event.type !== "error") continue;
    const err = event.error && typeof event.error === "object" ? event.error : {};
    const data = err.data && typeof err.data === "object" ? err.data : {};
    const message = String(data.message ?? err.message ?? "");
    const errorType = String(err.type ?? "");
    if (errorType === "provider.no-route" || OPENCODE_MODEL_UNAVAILABLE_MESSAGE.test(message)) {
      observations.push(observation("provider_error", event, {reason: "opencode_model_unavailable", errorType: errorType || null, errorName: err.name ?? null, message: message.slice(0, 200)}));
      continue;
    }
    if (!hasToolUse && (err.name === "UnknownError" || OPENCODE_PROVIDER_ERROR_MESSAGE.test(message))) {
      observations.push(observation("provider_error", event, {reason: "opencode_unknown_error", errorName: err.name ?? null, message: message.slice(0, 200), ref: data.ref ?? null}));
    }
  }
  return observations;
}

// 2.x without --standalone cannot see an OPENCODE_CONFIG_CONTENT agent:
// `{"type":"error","error":{"type":"unknown","message":"Agent not found:
// \"autopilot_readonly\""}}`. That is an invocation/config failure, not an idle
// hang or a provider limit, so it gets its own structured observation.
const OPENCODE_AGENT_NOT_FOUND_MESSAGE = /agent not found/i;
function detectOpenCodeAgentNotFound(events) {
  const observations = [];
  for (const event of events) {
    if (!event || typeof event !== "object" || event.type !== "error") continue;
    const err = event.error && typeof event.error === "object" ? event.error : {};
    const data = err.data && typeof err.data === "object" ? err.data : {};
    const message = String(data.message ?? err.message ?? "");
    if (OPENCODE_AGENT_NOT_FOUND_MESSAGE.test(message)) {
      observations.push(observation("agent_not_found", event, {errorType: String(err.type ?? "") || null, message: message.slice(0, 200)}));
    }
  }
  return observations;
}

// Whether a later event is a successful tool call, derived from the CLI's own
// status plus, where a shell exit was recorded, that exit code — the same
// derivation the observer's own `failed` uses. Only successful calls suppress a
// denial: a run that kept failing after the denial never recovered from it.
function toolCallSucceeded(event) {
  const part = event?.part || {};
  const type = String(event?.type || part.type || "");
  if (type !== "tool_use" && type !== "tool") return false;
  const state = part.state || {};
  if (String(state.status || "") !== "completed") return false;
  const meta = state.metadata || {};
  return !Number.isFinite(Number(meta.exit)) || Number(meta.exit) === 0;
}

// A terminal denial ended the run: the call is denied, nothing succeeded after
// it, and no later agent text carries the sentinel. Anything else is a denial
// the role worked around, which must not be tagged. Matches `state.error` only
// — never merged output, which can carry tool output or prose that merely
// mentions permissions.
function terminalDenial(events, index, status, state) {
  if (status !== "error") return false;
  if (!OPENCODE_DENIAL_TEXT.test(String(state.error || ""))) return false;
  const collected = [];
  for (let cursor = index + 1; cursor < events.length; cursor += 1) {
    if (toolCallSucceeded(events[cursor])) return false;
    collectText(events[cursor], collected);
  }
  return !collected.some(text => text.includes(SENTINEL_TOKEN));
}

function commandOutputText(state) {
  return String(state?.metadata?.output ?? state?.output ?? "");
}

// Whether a rejected tool event is a correlated out-of-sandbox auto-reject:
// OpenCode's permission engine auto-rejecting an external_directory request.
// Non-terminal by construction — the agent already received the refusal and
// keeps working — so callers record it as a warning observation and skip the
// terminalDenial() permission_denied path entirely. Two correlation prongs:
//
// (a) stderr prong (any tool, including bash): the rejected event's
//     state.error is denial-shaped (OPENCODE_DENIAL_TEXT, error-side only)
//     and the decoded run carries the engine's auto-reject line
//     ("permission requested: external_directory (...); auto-rejecting")
//     as a stderr event anywhere in the stream. This is the live run-18
//     shape: the wording lives ONLY on stderr, never in the tool event.
// (b) input-path prong (explicit file-path tools only: read/write/edit/
//     patch/multiedit): the CLI's generic auto-reject wording
//     (AUTO_REJECT_ERROR_TEXT) in state.error plus an out-of-sandbox path
//     in the tool input. Narrow on purpose: genuine policy denials ("not
//     permitted by policy", "permission denied") touching an outside path
//     stay terminal per task 1.4. Bash is excluded from this prong: denied
//     bash commands routinely reference sanctioned-but-outside-root paths
//     (live run 26: `/workspace/scratch` plus `/proc/self/mountinfo`, which
//     must stay terminal), so command-text correlation cannot distinguish
//     an auto-reject — bash relies on the stderr prong.
function autoRejectedOutOfSandbox(events, tool, input, status, state, probe) {
  if (status !== "error") return false;
  const err = String(state?.error || "");
  if (OPENCODE_DENIAL_TEXT.test(err) && runHasAutoRejectStderr(events)) return true;
  if (tool === "bash") return false;
  if (!AUTO_REJECT_ERROR_TEXT.test(err)) return false;
  const targets = [input?.filePath, input?.file_path, input?.path]
    .filter(value => value != null && String(value) !== "")
    .map(value => String(value));
  return targets.some(target => isOutsideSandboxPath(target, probe));
}

function runHasAutoRejectStderr(events) {
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (event.type === "stderr" && typeof event.text === "string" && AUTO_REJECT_STDERR_TEXT.test(event.text)) return true;
  }
  return false;
}

// Out-of-sandbox for an explicit file-path input: equivalent to the probe's
// known-outside path, or (when a root is known) an absolute path not under
// that root / a relative path escaping it. Without a root nothing can be
// classified, so the check defers to the stderr prong.
function isOutsideSandboxPath(candidate, probe) {
  if (!candidate) return false;
  if (probe?.outsideWritePath && equivalentEventPath(candidate, probe.outsideWritePath, probe.root)) return true;
  const root = probe?.root || null;
  if (!root) return false;
  const squash = value => String(value).replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  const rootNorm = squash(root);
  const raw = squash(candidate);
  const resolved = path.posix.normalize(raw.startsWith("/") ? raw : `${rootNorm}/${raw}`);
  return !(resolved === rootNorm || resolved.startsWith(`${rootNorm}/`));
}

function autoRejectWarningDetails(tool, input) {
  if (tool === "bash") {
    return {tool, command: String(input?.command ?? ""), reason: "auto_rejected_out_of_sandbox"};
  }
  const target = String(input?.filePath ?? input?.file_path ?? input?.path ?? "");
  return {tool, path: target, reason: "auto_rejected_out_of_sandbox"};
}

// Verified live against the installed agy plus the official CLI settings
// docs: persistent user settings live at ~/.gemini/antigravity-cli/settings.json
// (sparse JSON; only non-default values are persisted). Relative to $HOME so
// tests and the per-run allow-rule writer can join it without hardcoding $HOME.
export const AGY_SETTINGS_RELATIVE_PATH = ".gemini/antigravity-cli/settings.json";

// Frames raw relay prompt text as one stream-json stdin line for agy:
// {"event":"user","message":{"content":"<text>"}} (verified live: init +
// step_update emitted; {"type":"user",...} is rejected as missing event).
export function encodeAgyStdin(text) {
  return JSON.stringify({event: "user", message: {content: String(text ?? "")}}) + "\n";
}

function agyDriver() {
  return {
    id: "antigravity",
    contractVersion: 2,
    resolveBinary: binary => resolveAgentBinary(binary),
    version: binary => versionOf(binary),
    buildInvocation: agyInvocation,
    appliedSelections: agyAppliedSelections,
    // Observed Windows-interoperability metadata only — NOT a certified
    // network containment capability. This profile is excluded from
    // certified capability proofs and never contributes to any
    // effectiveCapabilities computation.
    detectProviderProfile: () => "google-windows-interop-1.1.19",
    trustedEnvelopeArgs: agyTrustedEnvelopeArgs,
    decodeEvents: decodeAgyEvents,
    observe: observeAgyEvents,
    // stream-json NDJSON on stdout, one typed event per line (task 1.1's stdin
    // contract pairs `--input-format stream-json` with `--output-format
    // stream-json`), so the transport class is the same one codex/claude use —
    // not a sentinel scan.
    structuredTransport: "event-stream",
    encodeStdin: encodeAgyStdin
  };
}

function agyInvocation(request) {
  // Stdin stream-json contract (verified live against the installed agy and
  // https://antigravity.google/docs/cli/headless): prompts arrive on stdin as
  // one NDJSON user event per line, so output must also be stream-json and no
  // prompt may ride on argv (--print/-p with text is dropped in this mode;
  // -p "" keeps the noninteractive slot without sending prompt text).
  // --conversation resume continues the role session in-process.
  const args = ["--mode", ["write", "scratch"].includes(request.mode) ? "accept-edits" : "plan", "--input-format", "stream-json", "--output-format", "stream-json", "-p", "", "--conversation", "resume", "--print-timeout", "45m0s"];
  
  if (request.model) args.push("--model", request.model);
  if (request.reasoning) args.push("--effort", request.reasoning);
  if (request.scratchDir) args.push("--add-dir", request.scratchDir);
  // Per-run permissions, never --dangerously-skip-permissions: agy has no
  // --allowedTools/--settings equivalent (verified against `agy --help`), so
  // the only least-privileged grant surface is the settings file agy reads at
  // $HOME/.gemini/antigravity-cli/settings.json (headless runs honor its
  // permissions per the CLI's own changelog). The writer emits that file under
  // the run's OWN scratch dir, so nothing global is touched and every run is
  // scoped to its own tree. read_only (plan mode) needs no grant at all — no
  // allow-rule, and therefore no command(...) permission, is written for it.
  // The child only reads agy's settings file when it resolves it as its $HOME,
  // so the record surfaces the written path as settingsPath for a launcher to
  // consume later (route the child's HOME to this one scratch dir, never the
  // operator's real HOME). That consumption is DEFERRED to task 1.4: the
  // production relay resolves agy from the static adapters/agents.json manifest
  // args — runRelay passes no `mode` (scripts/autopilot.mjs:2806), so
  // resolveAdapterTransport never reaches buildInvocation and spawns no per-run
  // HOME — so today no settingsPath is produced in production and agy has not yet
  // read this file. Task 1.3 only WRITES and SURFACES the file (PLAN.md limits
  // 1.3's autopilot.mjs edits to the unrelated :3062 comment); task 1.4 owns
  // injecting it into runRelay's launch env (launchEnv) once the agy child is
  // routed through buildInvocation with its mode + scratchDir. Until then a
  // write/scratch agy run whose command needs a permission fails loud via
  // denied_actions (-> PERMISSION_DENIED, tested in scripts/test-agy-wire.mjs),
  // never a silent pass. The file still lands in the run's OWN scratch dir,
  // which the relay harness has already created (autopilot.mjs:2508 for a write
  // role, :2514 for a disposable workspace); a scratch dir that is not on disk
  // at all — a synthetic request path, or a resolution before the harness made
  // the tree — writes nothing and claims no path, so nothing global is ever
  // touched and settingsPath is only ever non-null for a file that exists.
  const settingsPath = ["write", "scratch"].includes(request.mode)
    && request.scratchDir && fs.existsSync(request.scratchDir)
    ? writeAgyAllowRule(request.scratchDir, Array.isArray(request.allowRules) ? request.allowRules : [])
    : null;
  return {binary: request.binary, args, settingsPath};
}

function agyAppliedSelections(invocation) {
  const modelIndex = invocation.args.indexOf("--model");
  const effortIndex = invocation.args.indexOf("--effort");
  return {
    model: modelIndex >= 0 ? invocation.args[modelIndex + 1] : null, 
    reasoning: effortIndex >= 0 ? invocation.args[effortIndex + 1] : null
  };
}

function agyTrustedEnvelopeArgs(values) {
  const args = [...values];
  args.push("--sandbox");
  return args;
}

// Claude Code 2.1.x contract-v2 driver. Transport is the native Linux
// `claude` CLI in noninteractive stdin mode (`-p --output-format stream-json
// --input-format text`), matching the plain-text prompt Autopilot delivers
// on stdin. Permission flags are invocation mechanics
// only and provide no containment authority. Containment comes from the
// generic WSL trusted envelope and the existing admission/binary classifier.
// Claude telemetry is diagnostic only: capability proofs come from the
// trusted filesystem/Git/hidden-nonce/scratch/final-sentinel checks; this
// driver only normalizes live event shapes for observation accounting.
function claudeDriver() {
  return {
    id: "claude",
    contractVersion: 2,
    resolveBinary: resolveClaudeBinary,
    version: binary => versionOf(binary),
    buildInvocation: claudeInvocation,
    appliedSelections: claudeAppliedSelections,
    detectProviderProfile: claudeProviderProfile,
    trustedEnvelopeArgs: claudeTrustedEnvelopeArgs,
    decodeEvents: decodeJsonLines,
    observe: observeClaudeEvents,
    structuredTransport: "event-stream"
  };
}

function resolveClaudeBinary(binary) {
  // Claude launcher resolution must follow the launcher to the
  // executable it actually starts before the shared binary admission
  // gate classifies the result. A WSL claude that resolves to a
  // Cygwin/MinGW shell shim pointing at a Windows PE (.exe/.com)
  // must surface the PE to the shared gate so it rejects with
  // windows_interop_not_contained. A true native Linux Claude
  // (ELF) is returned as-is for the shared gate to accept. A shell
  // shim with no resolvable target is reported to the shared gate
  // as a missing Windows PE so it fails closed as
  // binary_admission_denied [binary_target_missing].
  const resolved = resolveAgentBinary(binary);
  if (!fs.existsSync(resolved)) return resolved;
  const fd = fs.openSync(resolved, "r");
  let header;
  try {
    const stat = fs.fstatSync(fd);
    const len = Math.min(Number(stat.size), 8192);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    header = buf;
  } finally {
    fs.closeSync(fd);
  }
  if (header.length >= 2 && header[0] === 0x4d && header[1] === 0x5a) return resolved;
  if (header.length >= 4 && header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) {
    return fs.realpathSync(resolved);
  }
  const ext = path.extname(resolved).toLowerCase();
  if (ext === ".cmd" || ext === ".bat" || ext === ".com" || ext === ".exe") return resolved;
  if (header.length >= 2 && header[0] === 0x23 && header[1] === 0x21) {
    const text = header.toString("utf8");
    // Capture only the path portion, excluding any leading shell
    // variable reference (e.g. $basedir, ${dir}). The npm Claude
    // shim has a line like
    //   "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe"
    // We strip a leading $VAR and any leading slashes so the
    // relative path resolves against the shim's directory.
    const stripVar = s => s.replace(/^\$[\w_]+/, "").replace(/^\$\{[\w_]+\}/, "");
    let captured = null;
    const q1 = text.match(/(?:"([^"]*?node_modules[^"]*?claude\.(?:exe|com))"|'([^']*?node_modules[^']*?claude\.(?:exe|com))')/i);
    if (q1) captured = q1[1] || q1[2];
    if (!captured) {
      const q2 = text.match(/(?:"([^"]*?claude\.(?:exe|com))"|'([^']*?claude\.(?:exe|com))')/i);
      if (q2) captured = q2[1] || q2[2];
    }
    if (!captured) {
      const m = text.match(/([^\s'"`;&|()<>]*?node_modules[^\s'"`;&|()<>]*?claude\.(?:exe|com))/i)
              || text.match(/([^\s'"`;&|()<>]*?claude\.(?:exe|com))/i);
      if (m) captured = m[1];
    }
    if (captured) {
      captured = stripVar(captured).replace(/^\/+/, "");
      const shimDir = path.dirname(resolved);
      const candidate = path.isAbsolute(captured) ? captured : path.join(shimDir, captured);
      const real = fs.realpathSync(candidate, { throwIfNoEntry: false });
      return real || candidate;
    }
    return joinMissingSyntheticExe(resolved);
  }
  return joinMissingSyntheticExe(resolved);
}

function joinMissingSyntheticExe(originalPath) {
  const dir = path.dirname(originalPath);
  const base = path.basename(originalPath, path.extname(originalPath));
  return path.join(dir, base + ".synthetic-missing-target.exe");
}

// Claude Code permission-rule syntax is `Tool(//absolute/path/**)`; a single
// leading `/` is project-relative, so the scratch grant uses two. A read-only
// role may write ONLY its hand-off note tree. No scratch dir => no Write/Edit
// grant at all (fail closed), never an unrestricted tool.
export const CLAUDE_READ_ONLY_ALLOWED_TOOLS = Object.freeze(["Read", "Glob", "Grep", "Bash"]);

export function claudeScratchAllowRules(scratchDir) {
  const normalized = String(scratchDir ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!/^(?:[A-Za-z]:\/|\/)/.test(normalized)) return [];
  if (normalized.split("/").includes("..")) return [];
  const base = `//${normalized.replace(/^\/+/, "")}`;
  return [`Write(${base}/**)`, `Edit(${base}/**)`];
}

export function applyClaudeReadOnlyScratchAllow(args, scratchDir) {
  const out = Array.isArray(args) ? [...args] : [];
  const rules = claudeScratchAllowRules(scratchDir);
  if (!rules.length) return out;
  const at = out.indexOf("--allowedTools");
  if (at < 0) {
    const before = out.indexOf("--permission-mode");
    const insertAt = before >= 0 ? before : out.length;
    out.splice(insertAt, 0, "--allowedTools", ...rules);
    return out;
  }
  let end = at + 1;
  while (end < out.length && !String(out[end]).startsWith("--")) end += 1;
  out.splice(end, 0, ...rules);
  return out;
}

function claudeInvocation(request) {
  const args = ["-p"];
  args.push("--output-format", "stream-json");
  args.push("--input-format", "text");
  args.push("--verbose");
  if (request.model) args.push("--model", request.model);
  if (request.reasoning) args.push("--effort", request.reasoning);
  // Permission mode is decided SOLELY by the invocation mode (fail closed):
  // a caller-supplied --permission-mode would either duplicate or conflict
  // with the mode-derived flag, so it is rejected instead of merged.
  if (Array.isArray(request.args) && request.args.includes("--permission-mode")) {
    throw new Error("Claude invocation must not carry a pre-existing --permission-mode flag (fail closed: mode decides).");
  }
  if (request.mode === "read_only") {
    // Plan mode refuses EVERY Write, including the sanctioned scratch note a
    // capped reviewer must leave for the next session (backlog #2). Run in
    // default mode with an explicit allow list instead: read tools + Bash,
    // plus Write/Edit scoped to the scratch dir the brief names. The
    // repository stays read-only through bubblewrap (Linux/WSL) or the
    // disposable workspace (Windows), never through the permission mode.
    args.push("--allowedTools", ...CLAUDE_READ_ONLY_ALLOWED_TOOLS, ...claudeScratchAllowRules(request.scratchDir));
    args.push("--disallowedTools", "Monitor", "TaskStop");
    args.push("--settings", CLAUDE_FOREGROUND_ONLY_SETTINGS);
    args.push("--permission-mode", "default");
  } else if (request.mode === "write" || request.mode === "scratch") {
    // Least-privileged non-interactive write mode: auto-accept file edits
    // without the broad bypass of --dangerously-skip-permissions.
    // acceptEdits alone auto-accepts edits but DENIES Bash in headless -p, so
    // the implementer could not run its verify command (mission 089 runs
    // 18/19: permission_denials Bash -> STRUCTURED_OUTPUT_MISSING). Allow
    // Bash only (no bypass flag); the bubblewrap envelope and the git guard
    // still contain it. Placed before --permission-mode: the flag is variadic.
    args.push("--allowedTools", "Bash");
    // Foreground-only: headless -p ends the session when the model ends its
    // turn, so a run_in_background Bash task (or a Monitor wait) yields no
    // final structured result (STRUCTURED_OUTPUT_MISSING, mission 089 run 66).
    // CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 (via --settings env, verified live
    // on claude 2.1.287) removes Bash run_in_background; Monitor/TaskStop are
    // also disallowed. Both flags are variadic, so a flag follows each.
    args.push("--disallowedTools", "Monitor", "TaskStop");
    args.push("--settings", CLAUDE_FOREGROUND_ONLY_SETTINGS);
    args.push("--permission-mode", "acceptEdits");
  } else {
    throw new Error(`Unknown Claude invocation mode '${String(request.mode)}' (fail closed: expected write/scratch/read_only).`);
  }
  return {binary: request.binary, args};
}

const CLAUDE_FOREGROUND_ONLY_SETTINGS = '{"env":{"CLAUDE_CODE_DISABLE_BACKGROUND_TASKS":"1"}}';

function claudeAppliedSelections(invocation) {
  const pick = flag => {
    const index = invocation.args.indexOf(flag);
    return index >= 0 ? invocation.args[index + 1] : null;
  };
  return {model: pick("--model"), reasoning: pick("--effort")};
}

// Containment inside the trusted envelope comes from bubblewrap, not from
// any Claude flag. The mapping validates shape only.
function claudeTrustedEnvelopeArgs(values) {
  const args = [...values];
  if (!args.includes("-p")) throw new Error("Claude trusted-envelope invocation requires '-p' (noninteractive).");
  if (!args.includes("--output-format") || !args.includes("stream-json")) {
    throw new Error("Claude trusted-envelope invocation requires '--output-format stream-json'.");
  }
  return args;
}

function claudeProviderProfile({binary}) {
  // The native Linux `claude` CLI exposes authentication state through
  // `claude auth status`. The provider_egress layer treats declared
  // profiles as the only legitimate egress route; unknown auth surfaces
  // (e.g. Bedrock/Vertex/Foundry) are not declared and therefore not
  // permitted by the controlled-egress policy.
  const probe = spawnAgentSync(binary, ["auth", "status"], {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]});
  if (probe.status !== 0) return null;
  const text = `${probe.stdout || ""}\n${probe.stderr || ""}`.toLowerCase();
  if (/anthropic\s*api\s*key/.test(text)) return "anthropic-api";
  if (/oauth|claude\.ai/.test(text)) return "anthropic-api";
  return null;
}

// Claude event-shape normalization is intentionally a thin re-decoder:
// telemetry is diagnostic only. The certifier's authoritative proofs
// (filesystem, Git, hidden-nonce, scratch, final-sentinel) come from the
// trusted envelope; this observer only re-emits command/file references
// for accounting. It does not introduce new containment, safety, or
// isolation authority.
function observeClaudeEvents(events, probe = {}) {
  return [...detectClaudeRateLimited(events), ...detectClaudeAuthRequired(events), ...observeCodexEvents(events, probe)];
}

// Mission 002 runs 09-11 (2026-10-28, a real operator project): the claude CLI
// ended with a genuine `{"type":"result","is_error":true,...}` line whose
// `api_error_status` was 401 ("Failed to authenticate: OAuth token revoked.
// Please log in again…") or null with the same text naming an expired OAuth
// session. Nothing recognized it, so it fell through to a generic adapter
// error and was retried until adapterRetryBudget_exhausted — an escalation
// that never told the operator to log in. Auth is terminal for the CLI
// itself: no same-adapter retry can succeed.
//
// Text is trusted ONLY on the CLI's own terminal result record with
// `is_error:true` (or an explicit 401 status), never on assistant prose: a
// model answer that merely discusses "log in again" is not an auth failure.
// TODO: codex/opencode/agy have no captured auth-failure fixture yet; extend
// this mapping with their own terminal event shapes when one is observed.
const CLAUDE_AUTH_REQUIRED_TEXT = /failed to authenticate|oauth token revoked|oauth session expired|please log in again|invalid api key/i;
const CLAUDE_AUTH_REASON_PATTERNS = [
  /oauth token revoked/i,
  /oauth session expired[^.]*/i,
  /invalid api key/i,
  /please log in again/i,
  /failed to authenticate/i,
];
function detectClaudeAuthRequired(events) {
  const observations = [];
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const status = event.api_error_status == null ? null : Number(event.api_error_status);
    const resultFailed = event.type === "result" && event.is_error === true;
    const text = typeof event.result === "string" ? event.result : "";
    if (status !== 401 && !(resultFailed && CLAUDE_AUTH_REQUIRED_TEXT.test(text))) continue;
    const reasonPattern = CLAUDE_AUTH_REASON_PATTERNS.find((pattern) => pattern.test(text));
    const matched = reasonPattern ? text.match(reasonPattern) : null;
    observations.push(observation("auth_required", event, {
      adapter: "claude",
      reason: status === 401 ? "api_error_status_401" : (matched ? matched[0] : "authentication failed"),
      status: Number.isFinite(status) ? status : null,
      message: text.slice(0, 200),
    }));
  }
  return observations;
}

// Mission 001 runs 27-28: a real Anthropic rate-limit rejection (`{"type":
// "rate_limit_event","rate_limit_info":{"status":"rejected",...}}`, verified
// live) went unrecognized as a failure at all — classifyObservedFailure()
// had no structured signal for it, so it fell through to a raw-text regex
// scan that matched an UNRELATED incidental "No such file or directory" tool
// result and misclassified the run as PATH_UNSUPPORTED/non-retryable. This
// is the trusted, structured counterpart: a CLI-protocol status field, not
// text scraped from prose, so it is authoritative regardless of exit code.
// "allowed"/"allowed_warning" status values are advisory (utilization
// approaching the limit) and are deliberately NOT matched — only "rejected"
// (the request was actually refused) is a failure. error/api_error_status
// are defensive extras for API-error event shapes not yet observed live.
function detectClaudeRateLimited(events) {
  const observations = [];
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const rejected = event.type === "rate_limit_event" && event.rate_limit_info?.status === "rejected";
    const explicitRateLimitError = event.error === "rate_limit";
    const apiStatus429 = event.api_error_status === 429;
    if (rejected || explicitRateLimitError || apiStatus429) {
      observations.push(observation("rate_limited", event, {
        reason: rejected ? "rate_limit_event_rejected" : explicitRateLimitError ? "error_rate_limit" : "api_error_status_429"
      }));
    }
  }
  return observations;
}

function codexProviderProfile({binary}) {
  const probe = spawnAgentSync(binary, ["login", "status"], {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]});
  const status = `${probe.stdout || ""}\n${probe.stderr || ""}`;
  if (probe.status === 0 && /logged in using chatgpt/i.test(status)) return "chatgpt";
  if (probe.status === 0 && /api key/i.test(status)) return "openai-api";
  return null;
}

function versionOf(binary) {
  const probe = spawnAgentSync(binary, ["--version"], {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]});
  if (probe.status !== 0) throw new Error(`Unable to read CLI version from ${binary}.`);
  return String(probe.stdout || probe.stderr || "").trim().split(/\r?\n/)[0];
}

function codexInvocation(request) {
  const args = ["exec", "--json", "--ephemeral", "--color", "never", "--skip-git-repo-check"];
  args.push("--sandbox", ["write", "scratch"].includes(request.mode) ? "workspace-write" : "read-only");
  args.push("--cd", request.cwd);
  if (request.scratchDir) args.push("--add-dir", request.scratchDir);
  if (request.model) args.push("--model", request.model);
  if (request.reasoning) args.push("--config", `model_reasoning_effort=${JSON.stringify(request.reasoning)}`);
  if (request.outputSchema) args.push("--output-schema", request.outputSchema);
  args.push("-");
  return {binary: request.binary, args: request.trustedEnvelope === true ? codexTrustedEnvelopeArgs(args) : args};
}

function codexTrustedEnvelopeArgs(values) {
  const args = [...values];
  const sandbox = args.indexOf("--sandbox");
  if (sandbox < 0 || !args[sandbox + 1]) throw new Error("Codex trusted-envelope invocation requires an explicit sandbox option.");
  args[sandbox + 1] = "danger-full-access";
  return args;
}

function codexAppliedSelections(invocation) {
  const modelIndex = invocation.args.indexOf("--model");
  const configIndex = invocation.args.findIndex((value, index) => value === "--config" && /^model_reasoning_effort=/.test(invocation.args[index + 1] || ""));
  let reasoning = null;
  if (configIndex >= 0) {
    const raw = invocation.args[configIndex + 1].replace(/^model_reasoning_effort=/, "");
    try { reasoning = JSON.parse(raw); }
    catch { reasoning = raw; }
  }
  return {model: modelIndex >= 0 ? invocation.args[modelIndex + 1] : null, reasoning};
}

function decodeJsonLines(stdout, stderr) {
  const events = [];
  for (const line of String(stdout || "").split(/\r?\n/).filter(Boolean)) {
    try { events.push(JSON.parse(line)); }
    catch { events.push({type: "unparsed_stdout", text: line}); }
  }
  for (const line of String(stderr || "").split(/\r?\n/).filter(Boolean)) events.push({type: "stderr", text: line});
  return events;
}

function observeCodexEvents(events, probe = {}) {
  const observations = [];
  for (const event of events) {
    const item = event?.item || event;
    const itemType = String(item?.type || event?.type || "");
    const trustedToolEvent = /command_execution|file_change|mcp_tool_call|tool_call/i.test(itemType);
    if (!trustedToolEvent && itemType !== "stderr") continue;
    const command = commandText(item);
    const paths = changedPaths(item);
    const readReferenced = eventReferencesPath(command, probe.readPath, probe.root);
    const productionReferenced = paths.some(candidate => equivalentEventPath(candidate, probe.productionWritePath, probe.root)) || eventReferencesPath(command, probe.productionWritePath, probe.root);
    const outsideReferenced = paths.some(candidate => equivalentEventPath(candidate, probe.outsideWritePath, probe.root)) || eventReferencesPath(command, probe.outsideWritePath, probe.root);
    const gitMutation = /\bgit(?:\.exe)?\b[\s\S]*?\bcommit\b/i.test(command);
    const denied = permissionDenied(item, itemType);
    const gitBlocked = gitMutation && (trustedGitGuardDenial(event, item, command, probe) || trustedReadOnlyGitDenial(event, item));
    if (readReferenced) {
      observations.push(observation("file_read_attempted", event));
      if (commandSucceeded(event, item)) observations.push(observation("file_read_observed", event, {output: commandOutput(item)}));
    }
    if (productionReferenced) {
      observations.push(observation("write_attempted", event));
      if (denied) observations.push(observation("write_blocked", event));
      if (toolFailed(event, item)) observations.push(observation("write_failed", event));
    }
    if (outsideReferenced) {
      observations.push(observation("outside_write_attempted", event));
      if (denied) observations.push(observation("outside_write_blocked", event));
      if (toolFailed(event, item)) observations.push(observation("outside_write_failed", event));
    }
    if (gitMutation) {
      observations.push(observation("git_mutation_attempted", event));
      if (gitBlocked) observations.push(observation("git_mutation_blocked", event));
    }
    if (/command_execution/i.test(itemType)) {
      observations.push(observation("command_attempted", event));
      if (eventReferencesPath(command, probe.timeoutScriptPath, probe.root) && commandStarted(event, item)) {
        observations.push(observation("timeout_child_command_started", event));
      }
    }
    const toolName = String(item?.tool || item?.name || item?.server || "");
    if (/navigate_page/i.test(toolName)) observations.push(observation("browser_navigate", event));
    if (/take_snapshot/i.test(toolName)) observations.push(observation("browser_snapshot", event));
    if (/(?:^|\W)click(?:$|\W)/i.test(toolName)) observations.push(observation("browser_click", event));
    if (denied) observations.push(observation("permission_denied", event));
  }
  return observations;
}

function commandText(item) {
  const values = [item?.command, item?.input, item?.arguments, item?.args].filter(value => value != null);
  return values.map(value => typeof value === "string" ? value : JSON.stringify(value)).join("\n");
}

function changedPaths(item) {
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  return changes.map(change => change?.path || change?.file || change?.file_path).filter(Boolean);
}

function commandOutput(item) {
  return String(item?.aggregated_output ?? item?.output ?? item?.stdout ?? "");
}

function commandSucceeded(event, item) {
  const completed = event?.type === "item.completed" || item?.status === "completed";
  return completed && item?.status === "completed" && Number(item?.exit_code) === 0;
}

function commandStarted(event, item) {
  return event?.type === "item.started" || item?.status === "in_progress";
}

function toolFailed(event, item) {
  return event?.type === "item.completed" && (item?.status === "failed" || (item?.exit_code != null && Number(item.exit_code) !== 0));
}

function trustedGitGuardDenial(event, item, command, probe) {
  if (event?.type !== "item.completed" || item?.status !== "failed" || Number(item?.exit_code) === 0) return false;
  const output = `${commandOutput(item)}\n${item?.error || ""}`;
  const explicitWrapper = eventReferencesPath(command, probe.gitGuardWrapperPath, null);
  const explicitMarker = /AUTOPILOT GIT GUARD: '[^']+' is forbidden \(history\/ref mutation\)\./i.test(output);
  const hookMarker = /AUTOPILOT GIT GUARD: (?:blocked by [^\r\n]+ hook|ref update blocked \(reference-transaction\))/i.test(output);
  return (explicitWrapper && explicitMarker) || hookMarker;
}

function trustedReadOnlyGitDenial(event, item) {
  if (event?.type !== "item.completed" || Number(item?.exit_code) === 0) return false;
  const output = `${commandOutput(item)}\n${item?.error || ""}`;
  return /read-only file system|blocked by (?:active )?policy|writing is blocked/i.test(output);
}

// Specific denial phrases only — no bare "denied"/"read-only" fragments.
// Those matched unrelated prose too easily: a successfully-read repository
// document that merely discusses permissions (e.g. "Insufficient
// permissions to create emergency appointments.") or describes a read-only
// operating mode (e.g. "PowerSync is read-only in this release") is neither
// an assistant claim nor the CLI's own outcome, and must never be treated as
// evidence of a permission denial.
const PERMISSION_DENIAL_TEXT = /permission denied|insufficient permissions|not permitted|read-only file system|blocked by policy|writing is blocked|sandbox.*(?:error|fail)|(?:error|fail).*sandbox/i;
// A structured CLI-protocol status value (e.g. Codex's "declined" tool
// status) is trustworthy regardless of exit code: it IS the tool's own
// outcome field, not text scraped from its output.
const EXPLICIT_DENIAL_STATUS = /^(?:denied|declined|rejected|blocked)$/i;

function permissionDenied(item, itemType) {
  const status = String(item?.status || "").trim();
  if (EXPLICIT_DENIAL_STATUS.test(status)) return true;
  if (itemType === "stderr") return PERMISSION_DENIAL_TEXT.test(item?.text || "");
  // Otherwise, only ever infer denial from a genuinely FAILED event — never
  // from a successful (exit 0) command/tool call. A successful command's
  // own stdout/aggregated_output may be arbitrary tool output, assistant
  // prose, or repository file content and is not evidence of the CLI's own
  // outcome.
  const exitCode = item?.exit_code;
  const genuinelyFailed = status.toLowerCase() === "failed" || (exitCode != null && Number(exitCode) !== 0);
  if (!genuinelyFailed) return false;
  const errorText = `${item?.error || ""}\n${item?.output || ""}\n${item?.aggregated_output || ""}`;
  return PERMISSION_DENIAL_TEXT.test(errorText);
}

function observation(type, event, details = {}) {
  return {type, source: "cli_event", ...details, event};
}

// The CLI-native session/thread id lives in the RAW decoded event stream,
// never in finalAgentText's human-readable result text: Claude reports it
// once, in a `{"type":"system","subtype":"init","session_id":...}` event;
// OpenCode stamps `sessionID` on every single event; Codex reports
// `thread_id` on its `thread.started` event. None of these fields are part
// of the assistant's displayed message, so scanning finalAgentText's output
// (as this codebase previously did) can never find them — every relay
// session id was silently persisted as null, and every `resume:true` call
// fell through to a blind "resume the last session" instead of resuming
// THIS role's own prior session. Scan raw events directly instead.
export function sessionIdFromEvents(events) {
  let found = null;
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (typeof event.session_id === "string" && event.session_id) found = event.session_id;
    else if (typeof event.sessionID === "string" && event.sessionID) found = event.sessionID;
    else if (typeof event.thread_id === "string" && event.thread_id) found = event.thread_id;
  }
  return found;
}

// Per-invocation token-usage price weights (TASK-19 phase 0 task 0a). A
// cache write bills ~1.25x base input and a cache read ~0.1x per current
// Claude/OpenCode Zen pricing; output tokens are not billed at the input
// rate (Claude Sonnet's output listing runs ~5x its input listing), so that
// ratio stands in as the output multiplier until it is swapped for a live
// per-model rate. Every price-weighted figure in this file goes through
// this one constant so all of them can be re-pinned together when pricing
// changes.
export const USAGE_PRICE_WEIGHTS = Object.freeze({input: 1, cacheCreation: 1.25, cacheRead: 0.1, output: 5});

function priceWeightedUsage({input, cacheCreation, cacheRead, output}) {
  return input * USAGE_PRICE_WEIGHTS.input
    + cacheCreation * USAGE_PRICE_WEIGHTS.cacheCreation
    + cacheRead * USAGE_PRICE_WEIGHTS.cacheRead
    + output * USAGE_PRICE_WEIGHTS.output;
}

// Per-invocation token-usage accumulation, keyed by adapter id since the raw
// event shape is adapter-specific (mirrors accumulateUsage's own dispatch
// pattern for observe()). Returns null whenever the event stream carries no
// usage signal at all -- for a driverless adapter, for codex (which decodes no
// per-turn usage event), or for a stream that never emitted one -- so an
// absent measurement is never mistaken for a free (zero-cost) invocation. A
// non-null return always carries the full breakdown (input, cacheCreation,
// cacheRead, output), the turn count, and the derived price-weighted figure
// together; the breakdown is the point of this function, not the total,
// because per-task dispatch (this task list's reason for existing) changes
// the MIX of these four, not just their sum.
export function accumulateUsage(adapterId, events, options = {}) {
  if (adapterId === "opencode") return accumulateOpenCodeUsage(events, options);
  if (adapterId === "claude") return accumulateClaudeUsage(events);
  if (adapterId === "antigravity") return accumulateAgyUsage(events);
  return null;
}

// Mission 093 Part 1 task 2.2: model-resolution patch for any adapter's
// decoded stream events. Pure — echoes the launch-time configured model
// alongside resolveRunModel's {resolvedModel, modelMismatch}, so callers
// persist {configuredModel, resolvedModel, modelMismatch} with null/null
// before the first stream report. The legacy `model` field is untouched.
export function runModelPatch(adapterId, events, configuredModel = null) {
  if (adapterId === "antigravity") return agyRunModelPatch(events, configuredModel);
  const {resolvedModel, modelMismatch} = resolveRunModel(adapterId, events, configuredModel);
  return {configuredModel: configuredModel ?? null, resolvedModel, modelMismatch};
}

// Mission 093 Part 1 task 2.2: stream hook — resolve the actual model from
// the decoded events so far and persist it to the run's status.json as soon
// as the stream reports it. Best-effort (a failed write degrades to no
// persist, never a broken run); returns the patch for callers that also
// carry it onto result.json. Before the first stream report nothing is
// written (initRun's null/null stands — never clobbered), and an unchanged
// resolution is not re-persisted, so the 1s relay tick pays one JSON
// read+write only when the model first resolves or actually changes.
// Memory only — dirs are unique per run, so no clearing is needed.
const lastModelPersist = new Map();
export function recordRunModel(dir, adapterId, events, configuredModel = null) {
  const patch = runModelPatch(adapterId, events, configuredModel);
  try {
    if (patch.resolvedModel == null) return patch;
    const key = JSON.stringify(patch);
    if (lastModelPersist.get(dir) === key) return patch;
    lastModelPersist.set(dir, key);
    updateRunModel(dir, patch);
  } catch {}
  return patch;
}

// OpenCode 1.18.x emits `{type:"step_finish", part:{type:"step-finish",
// tokens:{input,output,reasoning,cache:{read,write}}}}` once per step; one
// step_finish is one turn. `reasoning` tokens are billed as output tokens,
// so they are folded into the output total rather than tracked as a fifth
// component. The return also carries `maxSingleTurnContext`: the largest
// single-step context footprint (`input + cache.read + cache.write`), i.e.
// the current context size rather than the cumulative session total.
//
// OpenCode 2.x omits step_finish for the FINAL step (a one-step reply has no
// step_finish at all; a tool run's last step has text but no finish), so its
// sum is inherently a lower bound. The caller passes the generation detected
// at launch; on 2.x a text-bearing step after the last step_finish marks the
// result `usage_partial:true` while still summing every step_finish that did
// arrive. A 2.x stream with no step_finish at all returns only that flag —
// never zeroed/invented token counts. 1.x (and callers with no generation,
// e.g. the existing unit tests) keep the exact old null/throw-free behavior.
function openCodeTextAfterLastFinish(events, lastFinishIndex) {
  for (let index = lastFinishIndex + 1; index < events.length; index += 1) {
    const event = events[index];
    const part = event?.part || {};
    const type = String(event?.type || part.type || "");
    if (type !== "text") continue;
    if (String(part.text ?? event?.text ?? "").trim() !== "") return true;
  }
  return false;
}
function accumulateOpenCodeUsage(events, {generation = null} = {}) {
  let input = 0, output = 0, cacheCreation = 0, cacheRead = 0, turns = 0, seen = false;
  let maxSingleTurnContext = 0;
  let lastFinishIndex = -1;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const part = event?.part || {};
    const type = String(event?.type || part.type || "");
    if (type !== "step_finish" && type !== "step-finish") continue;
    const tokens = part.tokens;
    if (!tokens || typeof tokens !== "object") continue;
    seen = true;
    lastFinishIndex = index;
    turns += 1;
    input += Number(tokens.input) || 0;
    output += (Number(tokens.output) || 0) + (Number(tokens.reasoning) || 0);
    cacheCreation += Number(tokens.cache?.write) || 0;
    cacheRead += Number(tokens.cache?.read) || 0;
    const turnContext = (Number(tokens.input) || 0)
      + (Number(tokens.cache?.read) || 0)
      + (Number(tokens.cache?.write) || 0);
    if (turnContext > maxSingleTurnContext) maxSingleTurnContext = turnContext;
  }
  const partial = generation === "2" && openCodeTextAfterLastFinish(events, lastFinishIndex);
  if (!seen) return partial ? {usage_partial: true} : null;
  const usage = {input, cacheCreation, cacheRead, output, turns, maxSingleTurnContext};
  return {...usage, priceWeighted: priceWeightedUsage(usage), ...(partial ? {usage_partial: true} : {})};
}

// Claude Code's stream-json carries a per-Messages-API-shaped `usage` object
// on every `{type:"assistant", message:{...}}` event (input_tokens,
// cache_creation_input_tokens, cache_read_input_tokens, output_tokens); one
// assistant event is one turn, the claude observer's equivalent of
// OpenCode's step_finish. The terminal `{type:"result",...}` event's own
// `usage` field (a cumulative total, where present) is deliberately not
// added here -- summing it alongside the per-assistant-event totals above
// would double-count the same tokens.
// Claude Code stream-json emits one `assistant` event PER CONTENT BLOCK
// (thinking, text, each tool_use), every one repeating the same message.id and
// the same usage — so summing events double-counted (seen live: 38 events for
// 20 messages, 245.3K priced vs 175K real). One message is one turn: keep the
// last event per message.id. Streamed output_tokens are partial, so the
// terminal `result` event's usage/num_turns, when present, is authoritative.
// The return also carries `maxSingleTurnContext`: the largest single-message
// context footprint (`input_tokens + cache_read_input_tokens +
// cache_creation_input_tokens`) across `byMessage`. It is always derived
// from the per-message samples — never from the terminal `result` usage,
// which is a cumulative session total and would defeat the per-turn
// semantics. When no per-message sample exists but a terminal `result` does,
// its cumulative sum is used fail-closed (a breach fires sooner rather than
// being missed).
function accumulateClaudeUsage(events) {
  const byMessage = new Map(), contentChars = new Map();
  let anonymous = 0, final = null;
  for (const event of events) {
    if (event?.type === "result" && event.usage && typeof event.usage === "object") final = event;
    if (!event || event.type !== "assistant") continue;
    const msgUsage = event.message?.usage;
    if (!msgUsage || typeof msgUsage !== "object") continue;
    const key = event.message?.id || `anonymous-${anonymous++}`;
    byMessage.set(key, msgUsage);
    // Streamed output_tokens are partial (1-3 per message); keep an estimate
    // from the content actually emitted (one event per content block, summed).
    let chars = 0;
    for (const b of Array.isArray(event.message?.content) ? event.message.content : []) {
      chars += (typeof b?.text === "string" ? b.text.length : 0)
        + (typeof b?.thinking === "string" ? b.thinking.length : 0)
        + (b?.input !== undefined ? JSON.stringify(b.input).length : 0);
    }
    contentChars.set(key, (contentChars.get(key) || 0) + chars);
  }
  const fromUsage = (u) => ({
    input: Number(u.input_tokens) || 0,
    output: Number(u.output_tokens) || 0,
    cacheCreation: Number(u.cache_creation_input_tokens) || 0,
    cacheRead: Number(u.cache_read_input_tokens) || 0
  });
  const contextOf = (u) => (Number(u.input_tokens) || 0)
    + (Number(u.cache_read_input_tokens) || 0)
    + (Number(u.cache_creation_input_tokens) || 0);
  let maxSingleTurnContext = 0;
  for (const msgUsage of byMessage.values()) {
    const turnContext = contextOf(msgUsage);
    if (turnContext > maxSingleTurnContext) maxSingleTurnContext = turnContext;
  }
  let usage;
  if (final) {
    const turns = Number(final.num_turns);
    usage = {...fromUsage(final.usage), turns: Number.isFinite(turns) && turns > 0 ? turns : byMessage.size};
    if (!byMessage.size) {
      const f = fromUsage(final.usage);
      maxSingleTurnContext = f.input + f.cacheRead + f.cacheCreation;
    }
  } else {
    if (!byMessage.size) return null;
    usage = {input: 0, cacheCreation: 0, cacheRead: 0, output: 0, turns: byMessage.size};
    // No terminal result (killed / capped stream): streamed output_tokens are
    // partial, so floor each message at a ~4 chars/token content estimate
    // (backlog #117). A lower bound; redacted thinking is not countable.
    for (const [key, msgUsage] of byMessage) {
      const u = fromUsage(msgUsage);
      u.output = Math.max(u.output, Math.ceil((contentChars.get(key) || 0) / 4));
      usage.input += u.input; usage.output += u.output;
      usage.cacheCreation += u.cacheCreation; usage.cacheRead += u.cacheRead;
    }
  }
  usage = {input: usage.input, cacheCreation: usage.cacheCreation, cacheRead: usage.cacheRead, output: usage.output, turns: usage.turns, maxSingleTurnContext};
  return {...usage, priceWeighted: priceWeightedUsage(usage)};
}

export function finalAgentText(events, fallback = "") {
  const candidates = [];
  // The real Claude Code CLI's terminal `{"type":"result","result":"..."}`
  // event is the authoritative final text when present: it wins over any
  // interim assistant-message text collected below, regardless of stream
  // ordering (the terminal event is normally last, but this makes the
  // precedence explicit rather than relying on array position).
  let resultText = null;
  for (const event of events) {
    collectText(event, candidates);
    const r = resultEventText(event);
    if (r != null) resultText = r;
  }
  if (resultText != null) return resultText;
  return candidates.at(-1) || fallback;
}

function resultEventText(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  if (candidate.type === "result" && typeof candidate.result === "string") return candidate.result;
  return null;
}

function collectText(candidate, collected) {
  if (!candidate || typeof candidate !== "object") return;
  if (candidate.type === "agent_message" && typeof candidate.text === "string") collected.push(candidate.text);
  if (candidate.item?.type === "agent_message" && typeof candidate.item.text === "string") collected.push(candidate.item.text);
  if (candidate.result?.response && typeof candidate.result.response === "string") collected.push(candidate.result.response);
  if (typeof candidate.response === "string") collected.push(candidate.response);
  // OpenCode 1.18.x `run --format json`: assistant prose arrives as
  // {type:"text", part:{type:"text", text}} NDJSON events.
  if (candidate.type === "text" && typeof candidate.part?.text === "string") collected.push(candidate.part.text);
  // Real Claude Code CLI (--output-format stream-json) assistant message
  // shape: {"type":"assistant","message":{"role":"assistant","content":[
  // {"type":"text","text":"..."}, {"type":"tool_use",...}, ...]}}. Only
  // "text" content blocks are collected here — "thinking" and tool_use/
  // tool_result blocks are deliberately skipped, and top-level "user" or
  // "system" typed events never reach this branch at all (their `type` is
  // never "assistant"), so their content is never collected either.
  if (candidate.type === "assistant" && Array.isArray(candidate.message?.content)) {
    for (const block of candidate.message.content) {
      if (block?.type === "text" && typeof block.text === "string") collected.push(block.text);
    }
  }
}
