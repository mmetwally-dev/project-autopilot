#!/usr/bin/env node
// Backlog #8 — multiple valid task-result sentinels in final reply (antigravity
// and multi-turn concatenating adapters): the last sentinel wins (the model's
// final word). A successful run of the same adapter+role resets that adapter's
// retry budget counter (consecutive failures, not mission-wide ones).
import assert from "node:assert/strict";
import {
  parseTaskResultContract,
  TASK_RESULT_CODE_MISSING,
  TASK_RESULT_CODE_INVALID,
  TASK_RESULT_TRAILING_NOTE
} from "./task-result-contract.mjs";
import {finalAgentText} from "./adapter-drivers.mjs";
import {
  recordFailureBudget,
  resetAdapterRetryBudget,
  failure
} from "./failure-contract.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, evidence) {
  if (condition) {
    console.log(`PASS ${name}`);
    ok += 1;
    return;
  }
  console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(evidence)}` : ""}`);
  failed += 1;
}

const SENTINEL = (obj) => `AUTOPILOT_TASK_RESULT=${JSON.stringify(obj)}`;

const SENTINEL_1 = SENTINEL({
  summary: "first turn summary: implemented helper",
  taskLocalCheck: {
    command: "node --check helper.mjs",
    status: "passed",
    exitCode: 0,
    summary: "helper ok"
  }
});

const SENTINEL_2 = SENTINEL({
  summary: "second turn final word: ran tests and fixed lint",
  taskLocalCheck: {
    command: "npm test",
    status: "passed",
    exitCode: 0,
    summary: "all 12 tests passing"
  }
});

// ── 1. Two valid sentinels: last wins (fields from second) ───────────────────
{
  const output = [
    "Turn 1 prose: editing files...",
    SENTINEL_1,
    "Turn 2 prose: running extra verification...",
    SENTINEL_2
  ].join("\n");

  const r = parseTaskResultContract(output);
  check("two valid sentinels: parse succeeds", r.ok === true, r);
  check("two valid sentinels: summary is from the second sentinel",
    r.summary === "second turn final word: ran tests and fixed lint", r.summary);
  check("two valid sentinels: taskLocalCheck command is from the second sentinel",
    r.taskLocalCheck?.command === "npm test", r.taskLocalCheck);
  check("two valid sentinels: taskLocalCheck summary is from the second sentinel",
    r.taskLocalCheck?.summary === "all 12 tests passing", r.taskLocalCheck);
  check("two valid sentinels: taskLocalCheck status is passed",
    r.taskLocalCheck?.status === "passed", r.taskLocalCheck);
  check("two valid sentinels: taskLocalCheck exitCode is 0",
    r.taskLocalCheck?.exitCode === 0, r.taskLocalCheck);
}

// ── 2. Three valid sentinels: last wins ──────────────────────────────────────
{
  const SENTINEL_3 = SENTINEL({
    summary: "third turn: final polish",
    taskLocalCheck: {command: "npm run lint", status: "passed", exitCode: 0, summary: "clean"}
  });
  const output = `${SENTINEL_1}\nprose 1\n${SENTINEL_2}\nprose 2\n${SENTINEL_3}`;
  const r = parseTaskResultContract(output);
  check("three valid sentinels: last wins",
    r.ok === true && r.summary === "third turn: final polish" && r.taskLocalCheck?.command === "npm run lint", r);
}

// ── 3. Duplicate identical sentinels (e.g. stream duplicate) ─────────────────
{
  const output = `${SENTINEL_1}\n${SENTINEL_1}`;
  const r = parseTaskResultContract(output);
  check("duplicate identical sentinels: succeeds with valid record",
    r.ok === true && r.summary === "first turn summary: implemented helper", r);
}

// ── 4. Valid then invalid: invalid ──────────────────────────────────────────
{
  const malformed = `${SENTINEL_1}\nAUTOPILOT_TASK_RESULT={not json}`;
  const rMalformed = parseTaskResultContract(malformed);
  check("valid then malformed JSON: invalid",
    !rMalformed.ok && rMalformed.code === TASK_RESULT_CODE_INVALID, rMalformed);

  const incomplete = `${SENTINEL_1}\nAUTOPILOT_TASK_RESULT={"summary":"incomplete"`;
  const rIncomplete = parseTaskResultContract(incomplete);
  check("valid then incomplete JSON: invalid",
    !rIncomplete.ok && rIncomplete.code === TASK_RESULT_CODE_INVALID, rIncomplete);

  const badSchema = `${SENTINEL_1}\n${SENTINEL({summary: 12345})}`;
  const rBadSchema = parseTaskResultContract(badSchema);
  check("valid then bad schema: invalid",
    !rBadSchema.ok && rBadSchema.code === TASK_RESULT_CODE_INVALID, rBadSchema);

  const badCheckStatus = `${SENTINEL_1}\n${SENTINEL({summary: "ok", taskLocalCheck: {command: "true", status: "unknown", summary: "s"}})}`;
  const rBadCheck = parseTaskResultContract(badCheckStatus);
  check("valid then bad check status: invalid",
    !rBadCheck.ok && rBadCheck.code === TASK_RESULT_CODE_INVALID, rBadCheck);
}

// ── 5. One invalid: invalid ──────────────────────────────────────────────────
{
  const malformed = parseTaskResultContract("some prose\nAUTOPILOT_TASK_RESULT={bad json}");
  check("one invalid (malformed JSON): invalid",
    !malformed.ok && malformed.code === TASK_RESULT_CODE_INVALID, malformed);

  const incomplete = parseTaskResultContract("AUTOPILOT_TASK_RESULT={\"incomplete\":true");
  check("one invalid (incomplete): invalid",
    !incomplete.ok && incomplete.code === TASK_RESULT_CODE_INVALID, incomplete);

  const notObject = parseTaskResultContract("AUTOPILOT_TASK_RESULT=[\"array\"]");
  check("one invalid (non-object): invalid",
    !notObject.ok && notObject.code === TASK_RESULT_CODE_INVALID, notObject);
}

// ── 6. None: missing sentinel behaviour unchanged ────────────────────────────
{
  const missing = parseTaskResultContract("just plain prose without any sentinel line");
  check("none: missing sentinel returns STRUCTURED_OUTPUT_MISSING",
    !missing.ok && missing.code === TASK_RESULT_CODE_MISSING, missing);

  const empty = parseTaskResultContract("");
  check("empty output: returns STRUCTURED_OUTPUT_MISSING",
    !empty.ok && empty.code === TASK_RESULT_CODE_MISSING, empty);
}

// ── 7. Trailing text behaviour after multiple sentinels ──────────────────────
{
  const withProseAfter = `${SENTINEL_1}\n${SENTINEL_2}\nprose after final sentinel`;
  const rProseAfter = parseTaskResultContract(withProseAfter);
  check("prose after second sentinel: fails closed (must appear on final line)",
    !rProseAfter.ok && rProseAfter.code === TASK_RESULT_CODE_INVALID, rProseAfter);

  const withStrayTags = `${SENTINEL_1}\n${SENTINEL_2}\n</antThinking>\n</function_calls>`;
  const rStrayTags = parseTaskResultContract(withStrayTags);
  check("stray tags after second sentinel: succeeds with trailingNote",
    rStrayTags.ok === true && rStrayTags.trailingNote === TASK_RESULT_TRAILING_NOTE && rStrayTags.summary === "second turn final word: ran tests and fixed lint", rStrayTags);
}

// ── 8. finalAgentText + parseTaskResultContract end-to-end for antigravity ───
{
  // Simulated antigravity event stream: step_update with text deltas followed by terminal result
  const agyEvents = [
    {event: "init", session_id: "agy-session-1"},
    {event: "step_update", step_update: {state: "ACTIVE", step_type: "agent_response", text_delta: "Turn 1 work\n" + SENTINEL_1}},
    {event: "step_update", step_update: {state: "DONE", step_type: "tool", tool_name: "run_command"}},
    {event: "step_update", step_update: {state: "ACTIVE", step_type: "agent_response", text_delta: "Turn 2 work\n" + SENTINEL_2}},
    {
      event: "result",
      result: {
        status: "SUCCESS",
        // antigravity terminal result concatenates all turns
        response: `Turn 1 work\n${SENTINEL_1}\nTurn 2 work\n${SENTINEL_2}`,
        num_turns: 2
      }
    }
  ];

  const extracted = finalAgentText(agyEvents, "fallback");
  check("finalAgentText extracts terminal result.response for antigravity",
    extracted.includes("Turn 1") && extracted.includes("Turn 2"), extracted);

  const parsed = parseTaskResultContract(extracted);
  check("parseTaskResultContract on extracted antigravity response picks last sentinel",
    parsed.ok === true && parsed.summary === "second turn final word: ran tests and fixed lint", parsed);
}

// ── 9. Adapter retry budget: fail, success, fail, fail does not exhaust (limit 3)
{
  const state = {};
  const policy = {failure_budgets: {adapterRetryBudget: 3}};
  const adapterFail = failure("PROCESS_EXIT_NONZERO", "adapter", true);
  const scope = "adapter:antigravity:implementer";

  // 1. Fail #1
  const f1 = recordFailureBudget(state, policy, adapterFail, scope);
  check("budget: fail #1 is allowed", f1.allowed === true, f1);
  check("budget: fail #1 used is 1", f1.used === 1, f1);
  check("budget: ledger has 1", state.failureBudgets[`adapterRetryBudget:${scope}`] === 1, state.failureBudgets);

  // 2. Success: resets the counter for antigravity:implementer
  resetAdapterRetryBudget(state, "antigravity", "implementer");
  check("budget: reset clears ledger entry for this adapter+role",
    state.failureBudgets[`adapterRetryBudget:${scope}`] === undefined, state.failureBudgets);

  // 3. Fail #2 (first consecutive failure after success)
  const f2 = recordFailureBudget(state, policy, adapterFail, scope);
  check("budget: fail #2 (after success) is allowed", f2.allowed === true, f2);
  check("budget: fail #2 used is 1 (streak reset)", f2.used === 1, f2);

  // 4. Fail #3 (second consecutive failure)
  const f3 = recordFailureBudget(state, policy, adapterFail, scope);
  check("budget: fail, success, fail, fail does not exhaust a budget of 3", f3.allowed === true, f3);
  check("budget: fail #3 used is 2 (2 < 3)", f3.used === 2, f3);

  // 5. Fail #4 (third consecutive failure): now exhausts budget
  const f4 = recordFailureBudget(state, policy, adapterFail, scope);
  check("budget: 3rd consecutive failure exhausts budget of 3", f4.allowed === false, f4);
  check("budget: fail #4 used is 3", f4.used === 3, f4);
}

// ── 10. resetAdapterRetryBudget scope isolation ──────────────────────────────
{
  const state = {
    failureBudgets: {
      "adapterRetryBudget:adapter:antigravity:implementer": 2,
      "adapterRetryBudget:adapter:antigravity:verifier": 2,
      "adapterRetryBudget:adapter:claude:implementer": 2,
      "implementationFailureBudget:task:1": 3
    }
  };

  // Reset only antigravity:implementer via result object
  resetAdapterRetryBudget(state, {adapter: "antigravity", role: "implementer"});
  check("reset by object clears only target adapter+role",
    state.failureBudgets["adapterRetryBudget:adapter:antigravity:implementer"] === undefined, state.failureBudgets);
  check("reset preserves other roles for same adapter",
    state.failureBudgets["adapterRetryBudget:adapter:antigravity:verifier"] === 2, state.failureBudgets);
  check("reset preserves same role for other adapter",
    state.failureBudgets["adapterRetryBudget:adapter:claude:implementer"] === 2, state.failureBudgets);
  check("reset preserves other budget domains",
    state.failureBudgets["implementationFailureBudget:task:1"] === 3, state.failureBudgets);
}

console.log(`\n${ok} passed, ${failed} failed.`);
if (failed) process.exit(1);
