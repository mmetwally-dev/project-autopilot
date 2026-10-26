import {renderFinding} from "./review-feedback.mjs";

export const FAILURE_SCHEMA = "autopilot-failure.v1";

export const FAILURE_DOMAINS = Object.freeze([
  "planning", "implementation", "verification", "adapter", "infrastructure", "policy", "orchestrator"
]);

export const FAILURE_CLASSES = Object.freeze([
  "CLI_UNAVAILABLE", "PROCESS_START_FAILED", "PROCESS_EXIT_NONZERO", "TIMEOUT",
  "PERMISSION_DENIED", "PATH_UNSUPPORTED", "INVOCATION_MISMATCH",
  "STRUCTURED_OUTPUT_MISSING", "STRUCTURED_OUTPUT_INVALID",
  "READ_ONLY_VIOLATION", "GIT_MUTATION_BLOCKED", "GIT_COMMIT_DETECTED",
  "COMMAND_FAILED", "SERVER_UNAVAILABLE", "RATE_LIMITED", "PROVIDER_ERROR", "IDLE_HANG", "IMPLEMENTATION_REJECTED",
  "VERIFICATION_REJECTED", "PLANNING_REJECTED", "INTERNAL_CONTRACT_ERROR"
]);

const permissionPattern = /permission(?:\s+was)?\s+(?:denied|rejected)|auto-?denied|not permitted|read-only file system/i;
const pathPattern = /UNC paths are not supported|no such file or directory|cannot find the path|invalid cwd/i;
const serverPattern = /ERR_CONNECTION_REFUSED|ECONNREFUSED|server unavailable/i;

// Mission 022 phase 2 (task 2.2): the Phase 2.1 non-terminal out-of-sandbox
// auto-reject warning observation. It is informational only — never a
// PERMISSION_DENIED classification input. The observer (adapter-drivers.mjs)
// emits it INSTEAD of permission_denied, and this classifier must keep that
// separation: the warning type appears in no structured-evidence branch
// below, and its engine stderr line never trips the permission text
// fallback (see the explicit guard at the stderr fallback).
export const AUTO_REJECT_WARNING_TYPE = "out_of_sandbox_auto_reject_warning";
// Mirrors AUTO_REJECT_STDERR_TEXT in scripts/adapter-drivers.mjs: the
// permission engine's auto-reject line on process stderr
// ("permission requested: external_directory (...); auto-rejecting"). It
// only incidentally contains the word "permission" — permissionPattern
// above does not match it today — but that is not load-bearing: the guard
// below skips the permission fallback whenever this line is present, so a
// future permissionPattern widening can never reclassify a warned run.
const autoRejectStderrPattern = /permission requested:\s*external_directory[\s\S]*?auto-rejecting/i;

export function unavailableVerdict() {
  return {status: "unavailable", decision: null, findings: []};
}

// Sentinel recognition is anchored to complete response records:
// - only lines matching ^\s*AUTOPILOT_REVIEW\s*[:=] are marker candidates,
//   so an occurrence inside prose or a JSON finding string never counts;
// - a record is valid only when its balanced JSON object consumes the
//   remainder of that line except for trailing whitespace;
// - exactly one valid record must sit on the final non-empty line.
const SENTINEL_LINE = /^\s*AUTOPILOT_REVIEW\s*[:=]/;

import { normalizePreviousStatuses } from "./code-review-rounds.mjs";

export function parseReviewContract(output) {
  const text = typeof output === "string" ? output : `${output ?? ""}`;
  const records = sentinelRecords(text);
  if (records.length === 0) return invalidContract("STRUCTURED_OUTPUT_MISSING", "Review sentinel was not observed.");
  const valid = records.filter(record => record.complete);
  if (valid.length === 0) return invalidContract("STRUCTURED_OUTPUT_INVALID", "Review sentinel was not a well-formed JSON object.");
  if (valid.length > 1) return invalidContract("STRUCTURED_OUTPUT_INVALID", "Multiple review sentinels were observed.");
  const lines = text.split(/\r?\n/);
  let lastNonEmpty = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() !== "") { lastNonEmpty = index; break; }
  }
  const record = valid[0];
  if (record.index !== lastNonEmpty) return invalidContract("STRUCTURED_OUTPUT_INVALID", "Review sentinel must appear on the final non-empty response line.");
  try {
    const review = JSON.parse(record.json);
    if (!["PASS", "FAIL", "INCOMPLETE"].includes(review.decision) || !Array.isArray(review.findings)) {
      return invalidContract("STRUCTURED_OUTPUT_INVALID", "Review sentinel did not match the required schema.");
    }
    // Findings may be plain strings (the long-standing shape) or structured
    // {location, problem, correction} objects, which reviewers are now asked
    // to produce so a retried role is handed what to fix instead of having
    // to go searching for it. renderFinding() folds both into one line;
    // String() alone would have turned every structured finding into
    // "[object Object]" and silently destroyed the detail.
    //
    // Unclamped on purpose: the verdict is the faithful record of what the
    // reviewer returned, and findings double as a verbatim data channel
    // (the Playwright verifier returns its whole sandbox probe as one base64
    // finding). The length budget is applied where it actually matters —
    // persisting to state.json and re-injecting into a retry prompt — by
    // saveReviewFeedback()/normalizeFindings().
    //
    // Faithful in ARITY as well as content: unrenderable entries render to
    // "" but are NOT filtered out, because the count is load-bearing.
    // execution-plane-safety's operational proof requires findings.length
    // === 0, and dropping falsy entries let a malformed non-empty array
    // ([""], [null], [0], [{}]) read as empty and satisfy a predicate whose
    // whole job is to reject malformed reviewer output. Callers that want
    // the unusable entries gone get that from normalizeFindings().
    return {
      contract: {status: "valid", error: null},
      verdict: {
        status: "available",
        decision: review.decision,
        findings: review.findings.map(f => renderFinding(f, {clamped: false})),
        // The verdict exactly as the reviewer returned it, alongside the
        // rendered one-line form every prompt/persistence consumer reads.
        // renderFinding() flattens an object to one line, so per-finding
        // fields that are NOT part of that rendering — currently the task tags
        // `["T1"]` a reviewer uses to say which task a finding is about —
        // exist only here. Anything that needs those fields must read this
        // array, never `findings`.
        rawFindings: review.findings,
        // Backlog #118: optional per-previous-finding fixed/not_fixed record
        // (code-review rounds 2+). Tolerant: absent/malformed -> [].
        previous: normalizePreviousStatuses(review.previous),
      },
      failure: null
    };
  } catch {
    return invalidContract("STRUCTURED_OUTPUT_INVALID", "Review sentinel was not valid JSON.");
  }
}

function invalidContract(failureClass, message) {
  const retryable = failureClass === "STRUCTURED_OUTPUT_MISSING" || failureClass === "STRUCTURED_OUTPUT_INVALID";
  return {
    contract: {status: "invalid", error: message},
    verdict: unavailableVerdict(),
    failure: failure(failureClass, "adapter", retryable, [{source: "relay", message}])
  };
}

function sentinelRecords(text) {
  const lines = String(text || "").split(/\r?\n/);
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!SENTINEL_LINE.test(line)) continue;
    const objectStart = line.indexOf("{");
    if (objectStart < 0) { records.push({index, complete: false, json: null}); continue; }
    const objectEnd = balancedObjectEnd(line, objectStart);
    if (objectEnd < 0) { records.push({index, complete: false, json: null}); continue; }
    const trailing = line.slice(objectEnd + 1);
    records.push({index, complete: /^\s*$/.test(trailing), json: line.slice(objectStart, objectEnd + 1)});
  }
  return records;
}

function balancedObjectEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index;
  }
  return -1;
}

export function failure(failureClass, domain, retryable, evidence = []) {
  if (!FAILURE_CLASSES.includes(failureClass)) throw new Error(`Unknown failure class '${failureClass}'.`);
  if (!FAILURE_DOMAINS.includes(domain)) throw new Error(`Unknown failure domain '${domain}'.`);
  return {schema: FAILURE_SCHEMA, class: failureClass, domain, retryable: Boolean(retryable), evidence: Array.isArray(evidence) ? evidence : [evidence]};
}

// Mission 001 runs 27-28, live: a genuinely SUCCESSFUL Implementer (exit 0)
// was misclassified PERMISSION_DENIED because its own investigation of a
// read-only sandbox naturally produced the text "read-only file system";
// separately, a genuine Anthropic rate-limit rejection was misclassified
// PATH_UNSUPPORTED because an unrelated, already-recovered tool result
// elsewhere in the same transcript said "No such file or directory". Both
// were non-retryable, so a single transient rate limit escalated the whole
// mission on its first occurrence instead of getting the retry a 2-attempt
// budget was supposed to allow.
//
// Root cause: raw model prose, file contents, successful tool output, and
// complete stdout transcripts were treated as authoritative evidence. They
// never are — only these are:
//   - an explicit policy violation (computed independently, from Git state);
//   - the child process's own start/timeout signal;
//   - a TRUSTED structured terminal event from the adapter's own protocol
//     (a rate-limit rejection, a genuinely-failed tool call's denial status);
//   - a NONZERO exit's own stderr text (launcher/runtime-level errors only:
//     bad cwd, missing paths, connection failures). Stdout is never scanned,
//     for any adapter, under any circumstance: it is the model's own output
//     channel — assistant prose, file contents, and genuinely successful
//     tool results all live there indistinguishably from failure text.
//     Tool exploration output (e.g. a recovered `cat missing`) likewise lives
//     in stdout JSON events, never in process stderr, so stderr-only scanning
//     cannot mistake exploration for a terminal error. Structured terminal
//     events above take precedence over stderr text, so a genuine
//     rate-limit/denial verdict always wins over incidental stderr text.
//     `driverless` is retained for call compatibility but no longer gates the
//     fallback: process-level stderr is equally (un)trustworthy regardless of
//     driver presence.
// Stdout is never scanned, for any adapter, under any circumstance: it is
// the model's own output channel — assistant prose, file contents, and
// genuinely successful tool results all live there indistinguishably from
// failure text.
export function classifyObservedFailure(observation) {
  const evidence = observation?.evidence || [];
  const eventTypes = new Set(evidence.map(item => item?.type));
  // 1. Policy violation — always first; independent of process outcome.
  if (observation?.policyViolation) return policyFailure(observation.policyViolation, evidence);
  // 2. Process start failure.
  if (observation?.startError) return failure("PROCESS_START_FAILED", "adapter", true, evidence);
  // 3. Timeout.
  if (observation?.timedOut) return failure("TIMEOUT", "infrastructure", true, evidence);
  // 4. Structured terminal rate limit — a CLI-protocol status field, not
  // text scraped from prose, so it is authoritative regardless of exit code.
  if (eventTypes.has("rate_limited")) return failure("RATE_LIMITED", "infrastructure", false, evidence);
  // 4b. Backlog #106: structured provider-side error (opencode UnknownError).
  // Retryable (one same-model retry may be spent) but also a role-fallback
  // trigger like RATE_LIMITED, so a configured fallback is tried first.
  if (eventTypes.has("provider_error")) return failure("PROVIDER_ERROR", "infrastructure", true, evidence);
  // 5. Structured failed permission/path/server evidence — trusted because
  // it comes from the adapter's own canonicalized tool-call outcome
  // (permissionDenied() in adapter-drivers.mjs only fires on a genuinely
  // failed/denied item, never on a successful one), not from scanning text.
  if (eventTypes.has("permission_denied")) return failure("PERMISSION_DENIED", "adapter", false, evidence);
  if (eventTypes.has("path_unsupported")) return failure("PATH_UNSUPPORTED", "infrastructure", false, evidence);
  if (eventTypes.has("server_unavailable")) return failure("SERVER_UNAVAILABLE", "infrastructure", true, evidence);
  // Text fallback: only a NONZERO exit's own stderr — never stdout, for any
  // adapter (see docblock above for why stderr is safe and stdout is not).
  // `driverless` defaults true so existing direct unit-level calls (which
  // never model an adapter driver at all) keep their historical behavior;
  // the real relay call site always passes it explicitly, but it no longer
  // gates: a registered adapter's nonzero-exit stderr is scanned exactly
  // like a driverless one's. Without this, genuine launcher-level path /
  // server errors from registered adapters (bad cwd, refused connection)
  // degrade to generic PROCESS_EXIT_NONZERO, since no adapter currently
  // emits path_unsupported/server_unavailable structured events.
  if (observation?.exitCode !== 0) {
    const stderrText = String(observation?.stderr || "");
    // Phase 2.1 warning guard: an auto-rejected out-of-sandbox request is
    // non-terminal (the run continued), so its engine stderr line must never
    // classify PERMISSION_DENIED. Genuine permission_denied evidence above
    // is untouched — only this text-fallback branch is skipped.
    const isAutoRejectStderr = autoRejectStderrPattern.test(stderrText);
    if (!isAutoRejectStderr && permissionPattern.test(stderrText)) return textFallbackFailure("PERMISSION_DENIED", "adapter", false, evidence, "permission", stderrText);
    if (pathPattern.test(stderrText)) return textFallbackFailure("PATH_UNSUPPORTED", "infrastructure", false, evidence, "path", stderrText);
    if (serverPattern.test(stderrText)) return textFallbackFailure("SERVER_UNAVAILABLE", "infrastructure", true, evidence, "server", stderrText);
  }
  // 6. Clean exit, nothing above matched => no observed process failure.
  // (A genuine content-level failure — a reviewer FAIL verdict, a missing
  // sentinel — is layered on separately via verdictFailure()/
  // reviewContract.failure; it never depends on this function at all.)
  if (observation?.exitCode === 0) return null;
  // 7. Otherwise: the process exited nonzero for a reason nothing above
  // could name specifically.
  return failure("PROCESS_EXIT_NONZERO", "adapter", true, evidence);
}

// Backlog #42: opencode sometimes ends with a nonzero exit and no terminal
// event at all — its own log carries the provider's 429/quota rejection, or
// the session dies before printing an answer. A real crash still writes an
// error line (which stays PROCESS_EXIT_NONZERO); only silence or explicit
// limit text is reclassified, so the normal fallback path runs instead of
// burning the adapter retry budget and stopping.
const OPENCODE_LIMIT_TEXT = /(?:\b429\b|rate[_\s-]?limit|too many requests|insufficient[_\s-]?(?:quota|funds)|quota[_\s-]?(?:exceeded|exhausted))/i;
export function reclassifySilentOpenCodeFailure(observed, { adapter, output, stderr } = {}) {
  if (!observed || observed.class !== "PROCESS_EXIT_NONZERO" || adapter !== "opencode") return observed;
  const answer = String(output || "").trim();
  const err = String(stderr || "");
  // Only the child's stderr (its own diagnostic channel), never the
  // assistant's answer: prose in the answer is not a provider verdict.
  const limitText = OPENCODE_LIMIT_TEXT.test(err);
  if (answer && !limitText) return observed;
  const message = limitText
    ? "opencode exited nonzero after reporting a provider rate/quota limit"
    : "opencode exited nonzero with no answer or output";
  return failure("RATE_LIMITED", "infrastructure", false, [
    ...(Array.isArray(observed.evidence) ? observed.evidence : []),
    { source: "opencode_silent_provider_limit", adapter, noOutput: answer.length === 0, limitText, message },
  ]);
}

function policyFailure(policyViolation, evidence) {
  const classes = {
    git_commit_detected: "GIT_COMMIT_DETECTED",
    git_mutation_blocked: "GIT_MUTATION_BLOCKED",
    read_only_violation: "READ_ONLY_VIOLATION"
  };
  return failure(classes[policyViolation] || "INTERNAL_CONTRACT_ERROR", "policy", false, evidence);
}

// Explicit source tag on the evidence entry a stderr-text-fallback failure
// carries — selectAttemptFailure() below uses it to distrust exactly this
// kind of evidence (and only this kind) when it is attached to an otherwise
// genuinely completed result.
const TEXT_FALLBACK_SOURCE = "stderr_text_fallback";
const TEXT_FALLBACK_MAX_CHARS = 500;
function textFallbackFailure(failureClass, domain, retryable, evidence, pattern, text) {
  // Bounded: the raw stderr snippet is diagnostic context, not evidence to
  // persist verbatim — a full transcript must never accumulate in state.json
  // across retries.
  const raw = String(text ?? "");
  const snippet = raw.length > TEXT_FALLBACK_MAX_CHARS ? `${raw.slice(0, TEXT_FALLBACK_MAX_CHARS).trimEnd()}…` : raw;
  return failure(failureClass, domain, retryable, [...evidence, {source: TEXT_FALLBACK_SOURCE, pattern, text: snippet}]);
}

export function verdictFailure(roleName, verdict) {
  if (verdict?.status !== "available" || verdict.decision !== "FAIL") return null;
  if (roleName === "verifier") return failure("VERIFICATION_REJECTED", "verification", true, verdict.findings);
  if (roleName === "plan_reviewer") return failure("PLANNING_REJECTED", "planning", true, verdict.findings);
  return failure("IMPLEMENTATION_REJECTED", "implementation", true, verdict.findings);
}

// Evidence types that constitute a trusted structured failure signal from
// an adapter's own protocol. Informational observations (file_read_*,
// command_attempted, write_attempted, …) are never failure evidence: a
// failure carrying ONLY those on a completed, policy-clean result is stale
// noise (the persisted Run-27 shape) and must not outrank a genuine
// sibling failure. The Phase 2.1 out_of_sandbox_auto_reject_warning
// (AUTO_REJECT_WARNING_TYPE) is informational in the same sense —
// deliberately absent here — so a warning-only observation set on a clean
// exit classifies to null below and the relay mapping falls through to the
// missing-sentinel STRUCTURED_OUTPUT_MISSING path.
const TRUSTED_FAILURE_EVENT_TYPES = new Set(["rate_limited", "provider_error", "permission_denied", "path_unsupported", "server_unavailable"]);
// Reviewer FAIL verdicts live in the failure class (their findings are plain
// strings, not typed events), so they are exempt from the evidence check.
const VERDICT_FAILURE_CLASSES = new Set(["IMPLEMENTATION_REJECTED", "VERIFICATION_REJECTED", "PLANNING_REJECTED"]);

export function selectAttemptFailure({results = [], gate = null}) {
  const candidates = results
    .map(result => {
      const f = result?.failure;
      if (!f) return null;
      // Defense in depth for Run 27's exact shape: a result whose CLI
      // process genuinely completed with no policy violation cannot
      // legitimately carry a failure sourced from the stderr text
      // fallback — that fallback only ever fires on a NONZERO exit (see
      // classifyObservedFailure), so a "completed" result reaching here
      // with one attached means something else stapled stale evidence onto
      // an otherwise successful outcome. Only that specific, tagged source
      // is distrusted: a genuinely TRUSTED structured failure (a real
      // permission_denied/rate_limited event) is preserved even at exit 0,
      // and policy violations and reviewer FAIL verdicts never carry this
      // tag at all, so they are never touched by this check.
      const isStaleTextFallback = Array.isArray(f.evidence) && f.evidence.some(e => e?.source === "stderr_text_fallback");
      if (isStaleTextFallback && result?.status === "completed" && !result?.policy?.violation) return null;
      // Legacy Run-27 shape: failures persisted before structured-failure
      // gating (e.g. PERMISSION_DENIED evidenced only by file_read_*
      // observations) carry no trusted failure evidence at all, yet sit on
      // genuinely completed, policy-clean results. On a replay alongside a
      // reclassified sibling (e.g. Run 28 as retryable RATE_LIMITED), the
      // stale adapter-domain failure would otherwise still win by domain
      // priority and escalate the mission. Drop any failure on a completed,
      // policy-clean result unless it carries trusted structured failure
      // evidence or is a reviewer FAIL verdict (which lives in the failure
      // class, since verdict findings are plain strings, not typed events).
      if (result?.status === "completed" && !(result?.policy?.violation || result?.policyViolation)) {
        if (!VERDICT_FAILURE_CLASSES.has(f?.class)) {
          const ev = Array.isArray(f.evidence) ? f.evidence : [];
          const hasTrustedFailureEvidence = ev.some(e => e && typeof e === "object" && TRUSTED_FAILURE_EVENT_TYPES.has(e?.type));
          if (!hasTrustedFailureEvidence) return null;
        }
      }
      return f;
    })
    .filter(Boolean);
  if (gate && !gate.ok) candidates.push(failure("COMMAND_FAILED", "verification", true, [{source: "trusted_gate", command: gate.command || null}]));
  const priority = ["policy", "adapter", "infrastructure", "orchestrator", "verification", "implementation", "planning"];
  return priority.map(domain => candidates.find(candidate => candidate.domain === domain)).find(Boolean) || null;
}

// Mission 025 task 1.2 (backlog #28): normalized PASS-refusal predicate for
// linked verify/tool results. A PASS verdict must be refused when any linked
// result did not exit cleanly: status is not 0 (including null — a killed or
// never-started process has no exit code) or a signal/timedOut is present.
// Reason classification: exit 124 (the `timeout(1)` kill code), a timedOut
// flag, or any signal classifies as the "timed-out" reason; any other
// non-zero exit classifies as the "failed" reason. Both status and exitCode
// are read (guarded-command records use status; the mission-023 fixture
// carries both) with no field winning over another: the record is clean only
// when every exit field present is 0.
//
// shouldRefusePassForLinkedResults() returns null when every record is clean
// (PASS may stand) or the first refusal {refuse: true, reason, index,
// command, status, exitCode, signal, timedOut} when PASS must be refused.
export const LINKED_RESULT_TIMEOUT_EXIT = 124;
export const LINKED_REFUSAL_TIMED_OUT = "timed-out";
export const LINKED_REFUSAL_FAILED = "failed";

export function classifyLinkedResult(record) {
  const hasStatus = record?.status !== undefined;
  const hasExitCode = record?.exitCode !== undefined;
  const status = hasStatus ? record.status : null;
  const exitCode = hasExitCode ? record.exitCode : null;
  const signal = record?.signal ?? null;
  const timedOut = record?.timedOut === true;
  // Clean only when every exit field present is 0, with no kill signal and
  // no timeout. Any present non-zero (including 124), any present null
  // (killed/never-started), a missing exit pair, a signal, or timedOut —
  // refuses PASS. No field wins over another: conflicting records such as
  // {status: 0, exitCode: 124} refuse because not every present field is 0.
  const present = [];
  if (hasStatus) present.push(status);
  if (hasExitCode) present.push(exitCode);
  const allZero = present.length > 0 && present.every(code => code === 0);
  if (allZero && signal == null && !timedOut) return null;
  const isTimeout = timedOut || signal != null || present.includes(LINKED_RESULT_TIMEOUT_EXIT);
  return {
    reason: isTimeout ? LINKED_REFUSAL_TIMED_OUT : LINKED_REFUSAL_FAILED,
    status: status ?? null,
    exitCode: exitCode ?? null,
    signal,
    timedOut,
  };
}

export function shouldRefusePassForLinkedResults(linkedResults) {
  if (!Array.isArray(linkedResults) || linkedResults.length === 0) return null;
  for (let index = 0; index < linkedResults.length; index += 1) {
    const refusal = classifyLinkedResult(linkedResults[index]);
    if (refusal) {
      return {
        refuse: true,
        index,
        command: linkedResults[index]?.command ?? null,
        ...refusal,
      };
    }
  }
  return null;
}

// Normalize one gate- or tool-shaped record to the canonical linked-result
// shape {command,status,exitCode,signal,timedOut,durationMs} that
// classifyLinkedResult reads. Gate channels record the exit as `exitCode`
// without `status` (autopilot.mjs gate results); tool observers record it
// as `metadata.exit` or a bare `exit`/`code`. Only finite-integer exit
// values are used:
// OpenCode tool parts carry a string state.status ('completed'/'error') with
// the real exit code only in metadata.exit, so a non-numeric status must
// never shadow a numeric exit. The status field contributes only when it is
// itself numeric; otherwise the resolved numeric exit is assigned to both
// status and exitCode (fail-closed: no numeric exit at all normalizes to
// null/null, which classifyLinkedResult refuses).
// Mission 025 phase 4 task 4.1: durationMs (guarded-command measured wall
// time per linked verify command) is carried through as well — a finite
// non-negative number, else null — so the brief builder has a per-test
// duration source. Never affects refusal classification.
function toLinkedExitNumber(value) {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}

function toLinkedDurationMs(value) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

export function normalizeLinkedResult(record) {
  const metadata = record?.metadata ?? null;
  const statusNumber = toLinkedExitNumber(record?.status);
  const exitNumber = toLinkedExitNumber(record?.exitCode)
    ?? toLinkedExitNumber(record?.exit)
    ?? toLinkedExitNumber(record?.code)
    ?? toLinkedExitNumber(metadata?.exit)
    ?? toLinkedExitNumber(metadata?.status)
    ?? toLinkedExitNumber(metadata?.code)
    ?? null;
  // Preserve genuine conflicts (e.g. {status: 0, exitCode: 124} refuses):
  // when both a numeric status and a distinct numeric exit exist, keep both.
  // When the status is a non-numeric tool string, fall back to the exit.
  const status = statusNumber ?? exitNumber ?? null;
  const exitCode = exitNumber ?? statusNumber ?? null;
  const signal = record?.signal ?? metadata?.signal ?? null;
  const timedOut = record?.timedOut === true || metadata?.timedOut === true;
  const durationMs = toLinkedDurationMs(record?.durationMs)
    ?? toLinkedDurationMs(metadata?.durationMs)
    ?? null;
  return {
    command: record?.command ?? null,
    status: status ?? null,
    exitCode: exitCode ?? null,
    signal,
    timedOut,
    durationMs,
  };
}

// Mission 025 task 2.1 (isolated for unit testing, task 2.3): linked
// verify commands for a standalone phase — task `; verify: ...` segments
// (same regex as standaloneTaskVerifyEntries) plus configured gate
// commands. "none"/empty never counts as a linked command.
export function linkedVerifyCommandsForPhase(phaseTasks = [], gatesCommands = []) {
  const out = [];
  for (const t of Array.isArray(phaseTasks) ? phaseTasks : []) {
    const text = typeof t?.text === "string" ? t.text : "";
    const vm = text.match(/;\s*verify:\s*(.+?)(?:\s*<!--|$)/);
    if (!vm) continue;
    const v = vm[1].trim();
    if (!v || /^(none|n\/a|-)$/i.test(v)) continue;
    out.push(v);
  }
  for (const cmd of Array.isArray(gatesCommands) ? gatesCommands : []) {
    if (typeof cmd !== "string") continue;
    const v = cmd.trim();
    if (!v || /^(none|n\/a|-)$/i.test(v)) continue;
    out.push(v);
  }
  return out;
}

// Mission 025 task 2.1 (isolated for unit testing, task 2.3): tool
// results observed on a standalone reviewer result, normalized to the
// linked-result shape shouldRefusePassForEvidence() reads. Only
// command-execution events are collected — file reads and other
// non-command observations carry no exit code and must never refuse PASS.
// Deduplicated by raw event identity: one bash call fans out to several
// observations sharing the same event object. Events with no numeric exit,
// signal, or timeout flag are not failure evidence and are skipped (never
// fail-closed on missing telemetry: a completed OpenCode bash part may
// carry a null metadata.exit). Only commands matching a linked verify or
// gate command count — routine inspection (grep/test/git diff/repro) must
// never refuse PASS. Empty linked set returns [].
export function reviewerLinkedToolResults(result, linkedCommands = []) {
  const linked = Array.isArray(linkedCommands) ? linkedCommands.filter((c) => typeof c === "string" && c.trim()) : [];
  if (!linked.length) return [];
  const observations = Array.isArray(result?.observations) ? result.observations : [];
  const seen = new Set();
  const toolResults = [];
  for (const obs of observations) {
    const event = obs?.event;
    if (!event || typeof event !== "object" || seen.has(event)) continue;
    const part = event?.part;
    let command = null;
    let exit = null;
    let signal = null;
    let timedOut = false;
    let durationMs = null;
    let isCommand = false;
    if (part && typeof part === "object" && part.tool === "bash") {
      isCommand = true;
      const state = part.state ?? {};
      const input = state.input ?? {};
      const meta = state.metadata ?? {};
      if (typeof input.command === "string" && input.command) command = input.command;
      const raw = meta?.exit ?? obs?.exit ?? state?.exit;
      const n = Number(raw);
      if (raw != null && raw !== "" && Number.isInteger(n)) exit = n;
      signal = meta?.signal ?? state?.signal ?? null;
      timedOut = meta?.timedOut === true || state?.timedOut === true;
      durationMs = toLinkedDurationMs(meta?.durationMs)
        ?? toLinkedDurationMs(state?.durationMs)
        ?? toLinkedDurationMs(obs?.durationMs);
    } else {
      const item = event?.item || event;
      const itemType = String(item?.type ?? event?.type ?? "");
      if (/command_execution/i.test(itemType)) {
        isCommand = true;
        const values = [item?.command, item?.input, item?.arguments, item?.args].filter((value) => value != null);
        const text = values.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join("\n");
        if (text) command = text;
        const code = item?.exit_code;
        const n = Number(code);
        if (code != null && code !== "" && Number.isInteger(n)) exit = n;
        signal = item?.signal ?? null;
        timedOut = item?.timedOut === true;
        durationMs = toLinkedDurationMs(item?.durationMs)
          ?? toLinkedDurationMs(item?.duration_ms)
          ?? toLinkedDurationMs(event?.durationMs);
      }
    }
    if (!isCommand) continue;
    {
      const normCmd = typeof command === "string" ? command.trim() : "";
      const matches = normCmd && linked.some((lc) => {
        const l = String(lc).trim();
        if (!l) return false;
        return normCmd.includes(l) || l.includes(normCmd);
      });
      if (!matches) { seen.add(event); continue; }
    }
    seen.add(event);
    if (exit == null && signal == null && !timedOut) continue;
    toolResults.push({command, status: exit ?? null, exitCode: exit ?? null, signal, timedOut, durationMs});
  }
  return toolResults;
}

// Single refusal entry point for both evidence channels: normalize every
// gate result and every parsed role-tool result, then delegate to the shared
// predicate so both channels return the same refusal. Accepts either
// shouldRefusePassForEvidence({gateResults, toolResults}) or
// shouldRefusePassForEvidence(gateResults, toolResults).
export function shouldRefusePassForEvidence(gateResultsOrBag, toolResults = []) {
  let gateResults = gateResultsOrBag;
  if (!Array.isArray(gateResultsOrBag) && gateResultsOrBag != null && typeof gateResultsOrBag === "object") {
    gateResults = gateResultsOrBag.gateResults ?? [];
    toolResults = gateResultsOrBag.toolResults ?? [];
  }
  const gate = Array.isArray(gateResults) ? gateResults : [];
  const tools = Array.isArray(toolResults) ? toolResults : [];
  const normalized = [...gate, ...tools].map(normalizeLinkedResult);
  const refusal = shouldRefusePassForLinkedResults(normalized);
  if (!refusal) return null;
  // Re-attribute the command to the original (pre-normalization) record so
  // the refusal names the failing gate command or tool call.
  const sources = [...gate, ...tools];
  const origin = sources[refusal.index];
  return {
    ...refusal,
    command: origin?.command ?? refusal.command,
  };
}

export function budgetName(domain) {
  return {
    implementation: "implementationFailureBudget",
    verification: "verificationFailureBudget",
    adapter: "adapterRetryBudget",
    infrastructure: "infrastructureRetryBudget"
  }[domain] || null;
}

export function recordFailureBudget(state, policy, observedFailure, scope) {
  const name = budgetName(observedFailure?.domain);
  if (!name) return {allowed: false, budget: null, used: 0, limit: 0, scope};
  const limit = positiveInteger(policy?.failure_budgets?.[name], defaultBudget(name));
  // RATE_LIMITED escalates immediately without consuming the budget: the
  // counter is never incremented, so the key stays unset and every such
  // failure reports allowed:false.
  if (observedFailure?.class === "RATE_LIMITED") return {allowed: false, budget: name, used: 0, limit, scope};
  const key = `${name}:${scope}`;
  state.failureBudgets = state.failureBudgets || {};
  state.failureBudgets[key] = (state.failureBudgets[key] || 0) + 1;
  return {allowed: observedFailure.retryable && state.failureBudgets[key] < limit, budget: name, used: state.failureBudgets[key], limit, scope};
}

export function clearStaleStandaloneBudgets(state) {
  if (!state?.failureBudgets || typeof state.failureBudgets !== "object") return;
  for (const k of Object.keys(state.failureBudgets)) {
    if (k.includes(":task:standalone:")) delete state.failureBudgets[k];
  }
}

function positiveInteger(value, fallback) {
  if (value === undefined || value === null || typeof value === "boolean") return fallback;
  if (typeof value === "string" && value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function defaultBudget(name) {
  return name === "implementationFailureBudget" || name === "verificationFailureBudget" ? 4 : 3;
}
