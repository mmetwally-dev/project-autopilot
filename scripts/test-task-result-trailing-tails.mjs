#!/usr/bin/env node
// Mission 076 task 1.1 — pin tolerant stray-tag trailing tails.
import {
  parseTaskResultContract, TASK_RESULT_CODE_INVALID,
} from "./task-result-contract.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, evidence) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(evidence)}` : ""}`);
  failed += 1;
}

const SENTINEL = (obj) => `AUTOPILOT_TASK_RESULT=${JSON.stringify(obj)}`;
const GOOD = SENTINEL({summary: "did the task", taskLocalCheck: {command: "node scripts/test-task-result-trailing-tails.mjs", status: "passed", exitCode: 0, summary: "ok"}});
const NOTE = "trailing text ignored after a valid result";

// 1. valid block plus same-line stray tail accepted with the exact note
{
  const r = parseTaskResultContract(`${GOOD} </func>`);
  check("same-line stray tail accepted with exact note", r.ok === true && r.trailingNote === NOTE, r);
}

// 2. valid block plus subsequent stray-tag lines accepted with the exact note
{
  const r = parseTaskResultContract(`${GOOD}\n</func>\n</func>`);
  check("subsequent stray-tag lines accepted with exact note", r.ok === true && r.trailingNote === NOTE, r);
}

// 3. broken JSON still STRUCTURED_OUTPUT_INVALID
{
  const r = parseTaskResultContract("prose\nAUTOPILOT_TASK_RESULT={not json}");
  check("broken JSON still STRUCTURED_OUTPUT_INVALID", !r.ok && r.code === TASK_RESULT_CODE_INVALID, r);
}

// 4. clean block has no trailingNote
{
  const r = parseTaskResultContract(`some prose\n${GOOD}`);
  check("clean block has no trailingNote", r.ok === true && !("trailingNote" in r), r);
}

// 5. genuine trailing prose still rejected
{
  const r = parseTaskResultContract(`${GOOD}\nprose after the sentinel`);
  check("genuine trailing prose still rejected", !r.ok && r.code === TASK_RESULT_CODE_INVALID, r);
}

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
