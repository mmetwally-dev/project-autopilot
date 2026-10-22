#!/usr/bin/env node
// TASK-25 (003#43) — a missing/malformed implementer task-result sentinel
// retries the SAME task under adapterRetryBudget instead of killing the
// mission (the implementer twin of closed #23's reviewer/verifier sentinel
// retry).
//
// Part 1 (pure, every platform): a `source:"task-result"` failure on a
// `status:"failed"` result survives selectAttemptFailure() (it is NOT the
// distrusted `stderr_text_fallback` shape), and a parseable-but-wrong-task
// commit is still rejected (the gate behind `*_task_commit_invalid`, which
// keeps escalating immediately).
//
// Part 2 (behavioural, all platforms): real `node scripts/autopilot.mjs run` missions on a
// 2-task phase using the fake-adapter scenarios `impl_missing_sentinel_once`
// (recovers), `impl_missing_sentinel_always` (budget exhausted) and
// `impl_malformed_sentinel_once` (malformed JSON recovers). The recover case
// runs on both loops; exhaustion and malformed run on Speckit only. Both
// framework halves now run on every platform.
import fs from "node:fs";
import path from "node:path";
import {failure, selectAttemptFailure} from "./failure-contract.mjs";
import {prepareTaskInvocation, commitTaskResult} from "./role-progress-commit.mjs";
import {emptyRoleProgress} from "./phase-stage-checkpoint.mjs";
import {resolveStandaloneMission} from "./mission-naming.mjs";
import * as standalone from "../adapters/standalone.mjs";
import {
  makeFixtureRepo, makeFixtureBin, makeSpecKitWorkflowOnly, makeClaudeMdBaseline,
  setScenario, writeConfig, runAutopilot, readObservedEvents, cleanup,
} from "./test-fixtures/workflow-order-harness.mjs";

const SENTINEL_MISSION = "001-sentinel-retry";
const REQUEST = "sentinel retry fixture request";
const RUN_TIMEOUT_MS = 180000;
// resumeNote wording in autopilot.mjs (both loops): the T1 relaunch must
// carry it, proving the retry resumes the same task rather than restarting.
const RESUME_NOTE_FRAGMENT = "inspect the existing work in the tree and continue it";

let ok = 0;
let failed = 0;
function check(name, condition, evidence) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(evidence)}` : ""}`);
  failed += 1;
}
function skips(name, why) {
  console.log(`SKIP ${name} — ${why}`);
}
function readState(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
}
function readBrief(file) {
  try { return fs.readFileSync(file, "utf8"); }
  catch { return ""; }
}
// Chronological implementer task IDs, one per COMPLETED relay, read from
// each run's brief (every implementer relay completes here — the sentinel
// failure is detected after result.json is written, so the run is recorded).
function implementerLaunchedIds(repo) {
  return readObservedEvents(repo).filter((e) => e.role === "implementer").map((e) => {
    const brief = readBrief(path.join(path.dirname(e.file), "brief.txt"));
    const m = /^Task ID: (.*)$/m.exec(brief) || /^currentTaskId: (.*)$/m.exec(brief);
    return m ? m[1].trim() : null;
  });
}
function implementerBriefs(repo) {
  return readObservedEvents(repo).filter((e) => e.role === "implementer")
    .map((e) => readBrief(path.join(path.dirname(e.file), "brief.txt")));
}
function codeReviewerBriefs(repo) {
  return readObservedEvents(repo).filter((e) => e.role === "code_reviewer")
    .map((e) => readBrief(path.join(path.dirname(e.file), "brief.txt")));
}

// ══════════════════════════════════════════════════════════════════════
// 1. Pure: the new failure shape survives selection; wrong-task commits
// still rejected (so they keep escalating immediately).
// ══════════════════════════════════════════════════════════════════════
{
  const sentinelFailure = failure("STRUCTURED_OUTPUT_MISSING", "adapter", true,
    [{source: "task-result", message: "Task-result sentinel was not observed.", taskId: "t1"}]);
  const selected = selectAttemptFailure({results: [{status: "failed", failure: sentinelFailure}]});
  check("select: a task-result sentinel failure is kept (not filtered as stale)",
    selected !== null && selected.class === "STRUCTURED_OUTPUT_MISSING", selected);

  const prep = prepareTaskInvocation({
    progress: emptyRoleProgress(), role: "implementer", runId: "r",
    revision: 1, phaseTaskDigest: "d", taskId: "t1", taskIds: ["t1", "t2"],
  });
  check("commit: prep for the unit pin succeeds", prep.ok === true, prep);
  if (prep.ok) {
    const wrongTask = commitTaskResult({
      progress: prep.progress, expected: prep.expected,
      result: {
        role: "implementer", runId: "r", revision: 1, phaseTaskDigest: "d",
        taskId: "t2", status: "completed", facts: {summary: "s", files: []},
      },
    });
    check("commit: a parseable result for the wrong task is still rejected (escalates immediately, never retried)",
      wrongTask.ok === false, wrongTask);
  }
}

function writeSentinelStandaloneMission(repo) {
  const planFile = standalone.planPath(repo, SENTINEL_MISSION);
  const tasksFile = standalone.tasksPath(repo, SENTINEL_MISSION);
  fs.mkdirSync(path.dirname(planFile), {recursive: true});
  fs.writeFileSync(planFile, "# Plan\n\nObjective: fixture task.\n");
  fs.writeFileSync(tasksFile, [
    "## Phase 1: General", "",
    "- [ ] Do the first sentinel task",
    "- [ ] Do the second sentinel task", "",
  ].join("\n"));
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
    version: 1, phase: "tasks_ready", step: "tasks_ready",
    phaseIndex: 0, attempt: 1, mission: SENTINEL_MISSION, planningRequest: "fixture request",
  }));
  return {planFile, tasksFile};
}

function speckitSentinelTasksFile(repo) {
  const specsDir = path.join(repo, "specs");
  const matches = [];
  for (const entry of fs.readdirSync(specsDir)) {
    const candidate = path.join(specsDir, entry, "tasks.md");
    if (fs.existsSync(candidate)) matches.push(candidate);
  }
  if (matches.length !== 1) throw new Error(`expected exactly one SpecKit tasks.md, found ${matches.length}: ${matches.join(", ")}`);
  return matches[0];
}

// ══════════════════════════════════════════════════════════════════════
// 2. Recovers: T1 omits the sentinel once, the relaunch prints it.
// Exactly 3 launches (T1, T1 again, T2); the relaunch carries resumeNote;
// the adapter budget shows one implementer use; the mission completes with
// no escalation (hence no *_task_result_invalid step was ever set).
// ══════════════════════════════════════════════════════════════════════
async function runRecoverCase(label, framework, scenario) {
  const tag = `${label}/${scenario}`;
  const repo = makeFixtureRepo(`sn-${framework}-${scenario}`);
  const binDir = makeFixtureBin(`sn-${framework}-${scenario}`);
  try {
    let request = REQUEST;
    let tasksFile = null;
    if (framework === "speckit") {
      makeSpecKitWorkflowOnly(repo);
      makeClaudeMdBaseline(repo);
    } else {
      request = "fixture request";
    }
    writeConfig(repo, {planningFramework: framework});
    setScenario(repo, scenario);
    if (framework !== "speckit") ({tasksFile} = writeSentinelStandaloneMission(repo));

    const run = runAutopilot(repo, binDir, {request, timeoutMs: RUN_TIMEOUT_MS});
    if (framework === "speckit") tasksFile = speckitSentinelTasksFile(repo);
    const tasksText = fs.readFileSync(tasksFile, "utf8");
    check(`${tag}: the run completes the phase (exit 0, every checkbox marked)`,
      run.status === 0 && !/^- \[ \]/m.test(tasksText),
      {status: run.status, timedOut: run.timedOut, tail: String(run.stderr || run.stdout || "").slice(-400)});
    if (run.status !== 0) return;

    const launched = implementerLaunchedIds(repo);
    check(`${tag}: exactly 3 launches — T1, T1 again, then T2`,
      launched.length === 3 && launched[0] === launched[1] && launched[2] !== launched[0], launched);
    if (launched.length !== 3) return;
    const briefs = implementerBriefs(repo);
    const relaunch = briefs.find((b) => b.includes(RESUME_NOTE_FRAGMENT)) ?? "";
    check(`${tag}: the T1 relaunch brief carries the resumeNote`, !!relaunch, briefs.length);
    check(`${tag}: the phase proceeded to code review`,
      codeReviewerBriefs(repo).length >= 1, codeReviewerBriefs(repo).length);

    const state = readState(repo);
    const budgetKey = "adapterRetryBudget:adapter:cursor:implementer";
    check(`${tag}: one adapterRetryBudget use for the implementer scope`,
      state.failureBudgets?.[budgetKey] === 1, state.failureBudgets);
    check(`${tag}: no escalation and no task_result_invalid step was ever set`,
      state.phase !== "escalated" && !/task_result_invalid/.test(state.step ?? ""), {phase: state.phase, step: state.step});
  } finally {
    cleanup(repo, binDir);
  }
}

// ══════════════════════════════════════════════════════════════════════
// 3. Budget exhausted (speckit only): the sentinel never arrives.
// With adapterRetryBudget:1 the single T1 failure spends the budget, so the
// mission escalates as adapterRetryBudget_exhausted after exactly 1 T1
// launch. No crash, no hang (die() exits 2, no deadline kill).
// ══════════════════════════════════════════════════════════════════════
async function runExhaustedCase() {
  const tag = "speckit/impl_missing_sentinel_always";
  const repo = makeFixtureRepo("sn-exhausted");
  const binDir = makeFixtureBin("sn-exhausted");
  try {
    makeSpecKitWorkflowOnly(repo);
    makeClaudeMdBaseline(repo);
    writeConfig(repo, {planningFramework: "speckit", failureBudgets: {adapterRetryBudget: 1}});
    setScenario(repo, "impl_missing_sentinel_always");

    const run = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: RUN_TIMEOUT_MS});
    check(`${tag}: the run escalates without hanging (exit 2, no deadline kill)`,
      run.status === 2 && run.timedOut === false,
      {status: run.status, timedOut: run.timedOut, tail: String(run.stderr || run.stdout || "").slice(-400)});
    const state = readState(repo);
    check(`${tag}: escalation names the spent adapter budget`,
      state.phase === "escalated" && state.step === "adapterRetryBudget_exhausted",
      {phase: state.phase, step: state.step});
    const launched = implementerLaunchedIds(repo);
    check(`${tag}: exactly 1 T1 launch — the failure spent the whole budget`,
      launched.length === 1, launched);
    const budgetKey = "adapterRetryBudget:adapter:cursor:implementer";
    check(`${tag}: the budget ledger shows the single spent use`,
      state.failureBudgets?.[budgetKey] === 1, state.failureBudgets);
  } finally {
    cleanup(repo, binDir);
  }
}

await runRecoverCase("speckit", "speckit", "impl_missing_sentinel_once");
await runRecoverCase("speckit", "speckit", "impl_malformed_sentinel_once");
await runExhaustedCase();

await runRecoverCase("standalone", "standalone", "impl_missing_sentinel_once");

console.log(`\n${ok} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
