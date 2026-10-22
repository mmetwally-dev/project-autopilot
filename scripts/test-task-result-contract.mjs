#!/usr/bin/env node
// TASK-19 Phase 4 task 12 — unit tests for the per-task Implementer result
// contract (`task-result-contract.mjs`) and the pure attribution helpers
// (`task-attribution.mjs`). Both are importable without `autopilot.mjs`.
//
// The parser mirrors `failure-contract.mjs`'s AUTOPILOT_REVIEW parser, so the
// three failure modes are asserted independently: missing, malformed, and
// duplicate sentinels each fail closed.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  parseTaskResultContract, TASK_RESULT_CODE_MISSING, TASK_RESULT_CODE_INVALID,
  TASK_LOCAL_CHECK_STATUSES,
} from "./task-result-contract.mjs";
import {
  chunkDigest, attributionMap, changedPaths, pathsNamedInText, detectWorkAhead, normalizePath,
} from "./task-attribution.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, evidence) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(evidence)}` : ""}`);
  failed += 1;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const SENTINEL = (obj) => `AUTOPILOT_TASK_RESULT=${JSON.stringify(obj)}`;
const GOOD = SENTINEL({summary: "did the task", taskLocalCheck: {command: "node --check a.mjs", status: "passed", exitCode: 0, summary: "ok"}});

// ── Parser: valid ────────────────────────────────────────────────────────
{
  const r = parseTaskResultContract(`some prose\nmore prose\n${GOOD}`);
  check("parser: valid final-line sentinel accepted", r.ok, r);
  check("parser: summary preserved", r.ok && r.summary === "did the task", r);
  check("parser: taskLocalCheck preserved",
    r.ok && r.taskLocalCheck.status === "passed" && r.taskLocalCheck.exitCode === 0, r);
  check("parser: exitCode may be null",
    parseTaskResultContract(SENTINEL({summary: "s", taskLocalCheck: {command: "true", status: "attempted", exitCode: null, summary: "s"}})).ok);
  check("parser: statuses are the contract's set",
    JSON.stringify(TASK_LOCAL_CHECK_STATUSES) === JSON.stringify(["attempted", "passed", "failed"]));
}

// ── Parser: the three failure modes, each independent ────────────────────
{
  const missing = parseTaskResultContract("just prose with no sentinel");
  check("parser: missing sentinel fails closed", !missing.ok && missing.code === TASK_RESULT_CODE_MISSING, missing);

  const malformed = parseTaskResultContract("prose\nAUTOPILOT_TASK_RESULT={not json}");
  check("parser: malformed JSON fails closed", !malformed.ok && malformed.code === TASK_RESULT_CODE_INVALID, malformed);

  const incomplete = parseTaskResultContract("AUTOPILOT_TASK_RESULT={\"summary\":\"x\"");
  check("parser: unbalanced JSON object fails closed", !incomplete.ok && incomplete.code === TASK_RESULT_CODE_INVALID, incomplete);

  const duplicate = parseTaskResultContract(`${GOOD}\n${GOOD}`);
  check("parser: duplicate sentinel fails closed", !duplicate.ok && duplicate.code === TASK_RESULT_CODE_INVALID, duplicate);
  check("parser: duplicate rejection names the duplication",
    /Multiple/i.test(duplicate.reason), duplicate);

  const notFinal = parseTaskResultContract(`${GOOD}\nprose after the sentinel`);
  check("parser: sentinel off the final non-empty line fails closed",
    !notFinal.ok && notFinal.code === TASK_RESULT_CODE_INVALID, notFinal);

  const badSchema = parseTaskResultContract(SENTINEL({summary: "x", taskLocalCheck: {command: "true", status: "approved", exitCode: 0, summary: "s"}}));
  check("parser: invalid taskLocalCheck status fails closed",
    !badSchema.ok && badSchema.code === TASK_RESULT_CODE_INVALID, badSchema);

  const noSummary = parseTaskResultContract(SENTINEL({taskLocalCheck: {command: "true", status: "passed", exitCode: 0, summary: "s"}}));
  check("parser: missing summary fails closed", !noSummary.ok && noSummary.code === TASK_RESULT_CODE_INVALID, noSummary);

  const badExit = parseTaskResultContract(SENTINEL({summary: "x", taskLocalCheck: {command: "true", status: "passed", exitCode: "0", summary: "s"}}));
  check("parser: non-integer exitCode fails closed", !badExit.ok && badExit.code === TASK_RESULT_CODE_INVALID, badExit);

  const inProse = parseTaskResultContract(`the line AUTOPILOT_TASK_RESULT= is discussed in prose but not a record\n${GOOD}`);
  check("parser: a mention in prose does not count as a record", inProse.ok, inProse);
}

// ── Attribution: path -> chunk digest, changed paths ─────────────────────
{
  const map = attributionMap([{path: "scripts/a.mjs", text: "A1"}, {path: "scripts/b.mjs", text: "B1"}]);
  check("attribution: map keys are normalized paths", JSON.stringify(Object.keys(map).sort()) === JSON.stringify(["scripts/a.mjs", "scripts/b.mjs"]), map);
  check("attribution: digest matches chunkDigest", map["scripts/a.mjs"] === chunkDigest("A1"));
  check("attribution: backslashes and ./ normalized", normalizePath(".\\scripts\\a.mjs") === "scripts/a.mjs");
  check("attribution: blank paths ignored", Object.keys(attributionMap([{path: "", text: "x"}])).length === 0);

  const before = attributionMap([{path: "scripts/a.mjs", text: "A1"}, {path: "scripts/b.mjs", text: "B1"}]);
  const after = attributionMap([
    {path: "scripts/a.mjs", text: "A1"},
    {path: "scripts/b.mjs", text: "B2"},
    {path: "scripts/c.mjs", text: "C1"},
  ]);
  check("attribution: changedPaths reports added and changed, not untouched",
    JSON.stringify(changedPaths(before, after)) === JSON.stringify(["scripts/b.mjs", "scripts/c.mjs"]), changedPaths(before, after));
  check("attribution: changedPaths is empty when nothing changed",
    changedPaths(before, before).length === 0);
  check("attribution: a removed path is never attributed to the later task",
    !changedPaths(after, before).includes("scripts/c.mjs"), changedPaths(after, before));
}

// ── Attribution: work-ahead is evidence only ─────────────────────────────
{
  const tasks = [
    {text: "Create scripts/a.mjs"},
    {text: "Wire scripts/b.mjs"},
    {text: "Later task edits scripts/late.mjs and scripts/b.mjs"},
  ];
  const named = pathsNamedInText(tasks[2].text);
  check("work-ahead: paths named in prose extracted",
    named.includes("scripts/late.mjs") && named.includes("scripts/b.mjs"), named);

  const hit = detectWorkAhead(["scripts/a.mjs", "scripts/late.mjs"], tasks, 0);
  check("work-ahead: a path named by a later task is flagged",
    JSON.stringify(hit.paths) === JSON.stringify(["scripts/late.mjs"]), hit);
  check("work-ahead: the flag records which later task named it",
    hit.tasks[0]?.laterTaskIndexes?.includes(2), hit);
  check("work-ahead: an unrelated path is not flagged",
    detectWorkAhead(["scripts/a.mjs"], tasks, 0).paths.length === 0);
}

// ── Purity + discovery ───────────────────────────────────────────────────
{
  const parserSource = fs.readFileSync(path.join(here, "task-result-contract.mjs"), "utf8");
  for (const token of ["node:fs", "node:child_process", "process.", "writeFileSync", "spawnSync", "fetch("]) {
    check(`parser pure: no ${token}`, !parserSource.includes(token), token);
  }
  const runner = fs.readFileSync(path.join(here, "test-all.mjs"), "utf8");
  check("discovery: test-task-result-contract.mjs matches the runner discovery regex",
    /^test-.*\.mjs$/.test("test-task-result-contract.mjs"));
  check("discovery: modules are not runner candidates",
    !/^test-.*\.mjs$/.test("task-result-contract.mjs") && !/^test-.*\.mjs$/.test("task-attribution.mjs"));
  check("discovery: test-task-result-contract.mjs absent from both test-all exclusion sets",
    !runner.includes("test-task-result-contract.mjs"));
}

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
