// TASK-19 Phase 4 task 12 — the per-task Implementer result contract.
//
// One invocation owns exactly one task, so the model's only job in its final
// line is to report what it alone can know: a bounded summary and the truthful
// outcome of the task-local check. The changed-file set is NEVER taken from the
// model — it is computed from the tree by the orchestrator (task attribution),
// so a model that omits a file it changed cannot hide that change from
// per-task review. This module is deliberately separate from `autopilot.mjs`
// so the parser is unit-testable without importing the orchestrator.
//
// Sentinel recognition mirrors `failure-contract.mjs`'s `AUTOPILOT_REVIEW`
// parser exactly, because the same three failure modes matter:
// - a MISSING sentinel is an invalid result;
// - a MALFORMED sentinel (not a well-formed JSON object, or off the final
//   non-empty line) is an invalid result;
// - MORE THAN ONE sentinel is an invalid result — a duplicate is rejected, not
//   silently resolved to one of them.
export const TASK_RESULT_CODE_MISSING = "STRUCTURED_OUTPUT_MISSING";
export const TASK_RESULT_CODE_INVALID = "STRUCTURED_OUTPUT_INVALID";

export const TASK_LOCAL_CHECK_STATUSES = Object.freeze(["attempted", "passed", "failed"]);

const SENTINEL_LINE = /^\s*AUTOPILOT_TASK_RESULT\s*[:=]/;

// Mission 076 task 1.1: a stray-tag-shaped tail after an otherwise valid
// result block is tolerated (noted, not failed). A tail counts only if it
// matches this pattern exactly.
export const TASK_RESULT_TRAILING_NOTE = "trailing text ignored after a valid result";
const STRAY_TAG_TAIL = /^(\s*<\/[A-Za-z_][\w:.-]*>)+\s*$/;

function invalid(code, reason) {
  return {ok: false, code, reason};
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
    const straySameLine = STRAY_TAG_TAIL.test(trailing);
    records.push({index, complete: /^\s*$/.test(trailing) || straySameLine, straySameLine, json: line.slice(objectStart, objectEnd + 1)});
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

// Mission 054 task 1.2: clamp an over-long taskLocalCheck.command so the
// recorded verify stays within the downstream bound
// (ROLE_PROGRESS_COMMAND_MAX_CHARS = 500). The clamped command is at most
// 500 characters, carries the `…truncated` marker plus the full original
// length, and preserves the record's exact four-field shape.
const TASK_LOCAL_CHECK_COMMAND_MAX_CHARS = 500;
const COMMAND_TRUNCATION_MARKER = "…truncated";
function clampTaskLocalCheckCommand(command) {
  if (command.length <= TASK_LOCAL_CHECK_COMMAND_MAX_CHARS) return command;
  const suffix = ` ${COMMAND_TRUNCATION_MARKER} (original ${command.length} chars)`;
  return command.slice(0, TASK_LOCAL_CHECK_COMMAND_MAX_CHARS - suffix.length) + suffix;
}

function validateTaskLocalCheck(check) {
  if (!isPlainObject(check)) return invalid(TASK_RESULT_CODE_INVALID, "taskLocalCheck must be an object.");
  if (typeof check.command !== "string" || !check.command) {
    return invalid(TASK_RESULT_CODE_INVALID, "taskLocalCheck.command must be a non-empty string.");
  }
  const command = clampTaskLocalCheckCommand(check.command);
  if (!TASK_LOCAL_CHECK_STATUSES.includes(check.status)) {
    return invalid(TASK_RESULT_CODE_INVALID, `taskLocalCheck.status must be one of ${TASK_LOCAL_CHECK_STATUSES.join("/")}.`);
  }
  if (check.exitCode !== null && check.exitCode !== undefined && !Number.isInteger(check.exitCode)) {
    return invalid(TASK_RESULT_CODE_INVALID, "taskLocalCheck.exitCode must be an integer or null.");
  }
  if (typeof check.summary !== "string") {
    return invalid(TASK_RESULT_CODE_INVALID, "taskLocalCheck.summary must be a string.");
  }
  return {ok: true, value: {command, status: check.status, exitCode: check.exitCode ?? null, summary: check.summary}};
}

// Parse the final-line sentinel. Returns `{ok:true, summary, taskLocalCheck}`
// or a fail-closed `{ok:false, code, reason}`.
export function parseTaskResultContract(output) {
  const text = typeof output === "string" ? output : `${output ?? ""}`;
  const records = sentinelRecords(text);
  if (records.length === 0) return invalid(TASK_RESULT_CODE_MISSING, "Task-result sentinel was not observed.");
  const valid = records.filter((record) => record.complete);
  if (valid.length === 0) return invalid(TASK_RESULT_CODE_INVALID, "Task-result sentinel was not a well-formed JSON object.");
  if (valid.length > 1) return invalid(TASK_RESULT_CODE_INVALID, "Multiple task-result sentinels were observed.");
  const lines = text.split(/\r?\n/);
  const record = valid[0];
  let sawStrayAfter = false;
  let lastNonEmpty = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() === "") continue;
    if (index > record.index && STRAY_TAG_TAIL.test(lines[index])) { sawStrayAfter = true; continue; }
    lastNonEmpty = index; break;
  }
  if (record.index !== lastNonEmpty) {
    return invalid(TASK_RESULT_CODE_INVALID, "Task-result sentinel must appear on the final non-empty response line.");
  }
  let parsed;
  try {
    parsed = JSON.parse(record.json);
  } catch {
    return invalid(TASK_RESULT_CODE_INVALID, "Task-result sentinel was not valid JSON.");
  }
  if (!isPlainObject(parsed)) return invalid(TASK_RESULT_CODE_INVALID, "Task-result sentinel did not match the required schema.");
  if (typeof parsed.summary !== "string") {
    return invalid(TASK_RESULT_CODE_INVALID, "Task-result sentinel is missing a string summary.");
  }
  const check = validateTaskLocalCheck(parsed.taskLocalCheck);
  if (!check.ok) return check;
  if (record.straySameLine || sawStrayAfter) {
    return {ok: true, summary: parsed.summary, taskLocalCheck: check.value, trailingNote: TASK_RESULT_TRAILING_NOTE};
  }
  return {ok: true, summary: parsed.summary, taskLocalCheck: check.value};
}
