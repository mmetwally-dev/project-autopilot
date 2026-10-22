#!/usr/bin/env node
// TASK-29 (003#41) — pause before a stage retry only after an
// infrastructure failure.
//
// Unit: retryPauseStageOf()/shouldRetryPause() from
// scripts/phase-stage-checkpoint.mjs.
//
// Behavioural: real `node scripts/autopilot.mjs run` missions with
// policy.retry_delay_ms=1500, asserting on the `Retry delay:` log line —
// never by importing autopilot.mjs (it runs main() at import):
//  1. Functional FAIL → implementer re-run → re-review: NO `Retry delay:`
//     line before the re-run or before the re-review.
//  2. Infrastructure/adapter failure → same stage retried: EXACTLY ONE
//     `Retry delay:` line before the retry, labelled `infrastructure
//     retry` (never `transient`).
//  3. After that retry succeeds, a later stage transition does not pause
//     (the field is cleared) — covered by the exactly-one assertion: the
//     whole run contains a single pause line.
import fs from "node:fs";
import path from "node:path";
import {
  retryPauseStageOf,
  shouldRetryPause,
} from "./phase-stage-checkpoint.mjs";
import {
  makeFixtureRepo, makeFixtureBin, makeSpecKitPhaseFixture,
  writeConfig, setScenario, runAutopilot, readObservedEvents, cleanup,
} from "./test-fixtures/workflow-order-harness.mjs";
import * as standalone from "../adapters/standalone.mjs";

const RETRY_DELAY_MS = 1500;
const STANDALONE_MISSION = "001-retry-pause";
const STANDALONE_REQUEST = "fixture request";
const SPECKIT_REQUEST = "implement the fixture task";
const STANDALONE_TIMEOUT_MS = 120000;
const SPECKIT_TIMEOUT_MS = process.platform === "win32" ? 240000 : 180000;
const SINGLE_PHASE_TASKS = "## Phase 1: General\n\n- [ ] Do the fixture task\n";

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

// ── Unit: retryPauseStageOf ─────────────────────────────────────────────
check("pause-of: retry maps to the retried stage",
  retryPauseStageOf({ok: true, action: "retry", nextStage: "code_reviewer"}) === "code_reviewer");
check("pause-of: restart maps to null",
  retryPauseStageOf({ok: true, action: "restart", nextStage: "implementer"}) === null);
check("pause-of: advance maps to null",
  retryPauseStageOf({ok: true, action: "advance", nextStage: "verifier"}) === null);
check("pause-of: complete maps to null",
  retryPauseStageOf({ok: true, action: "complete", nextStage: null}) === null);
check("pause-of: non-ok transition maps to null",
  retryPauseStageOf({ok: false, action: "retry", nextStage: "verifier"}) === null);
check("pause-of: missing transition maps to null",
  retryPauseStageOf(null) === null && retryPauseStageOf({}) === null);

// ── Unit: shouldRetryPause ──────────────────────────────────────────────
check("should-pause: exact stage match pauses",
  shouldRetryPause({retryPauseStage: "verifier"}, "verifier") === true);
check("should-pause: different stage does not pause",
  shouldRetryPause({retryPauseStage: "implementer"}, "code_reviewer") === false);
check("should-pause: null field does not pause",
  shouldRetryPause({retryPauseStage: null}, "implementer") === false);
check("should-pause: old checkpoint without the field does not pause",
  shouldRetryPause({nextStage: "implementer", attempts: {implementer: 1}}) === false
  && shouldRetryPause({}, "implementer") === false
  && shouldRetryPause(null, "implementer") === false);

// ── E2E helpers ─────────────────────────────────────────────────────────
function setRetryDelayMs(repo, ms) {
  const file = path.join(repo, ".autopilot", "config.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  config.policy.retry_delay_ms = ms;
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}

function writeStandaloneMission(repo) {
  const planFile = standalone.planPath(repo, STANDALONE_MISSION);
  const tasksFile = standalone.tasksPath(repo, STANDALONE_MISSION);
  fs.mkdirSync(path.dirname(planFile), {recursive: true});
  fs.writeFileSync(planFile, "# Plan\n\nObjective: fixture task.\n");
  fs.writeFileSync(tasksFile, SINGLE_PHASE_TASKS);
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
    version: 1, phase: "tasks_ready", step: "tasks_ready",
    phaseIndex: 0, attempt: 1, mission: STANDALONE_MISSION, planningRequest: STANDALONE_REQUEST,
  }));
  return tasksFile;
}

function setupStandalone(prefix, scenario) {
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  writeConfig(repo, {planningFramework: "standalone"});
  setRetryDelayMs(repo, RETRY_DELAY_MS);
  setScenario(repo, scenario);
  const tasksFile = writeStandaloneMission(repo);
  return {repo, binDir, tasksFile};
}

function setupSpeckit(prefix, scenario) {
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  makeSpecKitPhaseFixture(repo);
  writeConfig(repo, {planningFramework: "speckit"});
  setRetryDelayMs(repo, RETRY_DELAY_MS);
  setScenario(repo, scenario);
  return {repo, binDir};
}

function speckitTasksFile(repo) {
  const matches = [];
  for (const entry of fs.readdirSync(path.join(repo, "specs"))) {
    const candidate = path.join(repo, "specs", entry, "tasks.md");
    if (fs.existsSync(candidate)) matches.push(candidate);
  }
  if (matches.length !== 1) throw new Error(`expected exactly one SpecKit tasks.md, found ${matches.length}`);
  return matches[0];
}

function roleCounts(repo) {
  const counts = {};
  for (const e of readObservedEvents(repo)) counts[e.role] = (counts[e.role] || 0) + 1;
  return counts;
}

function retryDelayLines(output) {
  return String(output || "").split(/\r?\n/).filter((line) => line.includes("Retry delay:"));
}

// ── E2E 1 (standalone): functional FAIL → re-run → re-review, no pause ──
{
  const {repo, binDir, tasksFile} = setupStandalone("rp-standalone-fail", "standalone_reviewer_fail_once");
  try {
    const run = runAutopilot(repo, binDir, {request: STANDALONE_REQUEST, timeoutMs: STANDALONE_TIMEOUT_MS});
    const tasksText = fs.readFileSync(tasksFile, "utf8");
    const output = `${run.stdout}\n${run.stderr}`;
    check("standalone/functional-fail: mission completed", run.status === 0 && !/^- \[ \]/m.test(tasksText),
      {status: run.status, tail: output.slice(-400)});
    const counts = roleCounts(repo);
    check("standalone/functional-fail: implementer re-ran and was re-reviewed",
      counts.implementer === 2 && counts.code_reviewer === 3 && counts.verifier === 1, counts);
    check("standalone/functional-fail: no Retry delay: line before the re-run or the re-review",
      retryDelayLines(output).length === 0, retryDelayLines(output));
  } finally {
    cleanup(repo, binDir);
  }
}

// ── E2E 2 (standalone): infra failure → same-stage retry pauses once ────
{
  const {repo, binDir, tasksFile} = setupStandalone("rp-standalone-infra", "standalone_reviewer_infra_once");
  try {
    const t0 = Date.now();
    const run = runAutopilot(repo, binDir, {request: STANDALONE_REQUEST, timeoutMs: STANDALONE_TIMEOUT_MS});
    const elapsed = Date.now() - t0;
    const tasksText = fs.readFileSync(tasksFile, "utf8");
    const output = `${run.stdout}\n${run.stderr}`;
    check("standalone/infra-retry: mission completed", run.status === 0 && !/^- \[ \]/m.test(tasksText),
      {status: run.status, tail: output.slice(-400)});
    const lines = retryDelayLines(output);
    check("standalone/infra-retry: exactly one Retry delay: line (cleared afterwards, so later stages do not pause)",
      lines.length === 1, lines);
    check("standalone/infra-retry: labelled infrastructure retry, never transient",
      lines.length === 1 && lines[0].includes("infrastructure retry") && !output.includes("transient"),
      lines[0]);
    check("standalone/infra-retry: the pause actually waited", elapsed >= 1000, {elapsed});
  } finally {
    cleanup(repo, binDir);
  }
}

// ── E2E 1 (speckit): functional FAIL → re-run → re-review, no pause ─────
{
  const {repo, binDir} = setupSpeckit("rp-speckit-fail", "speckit_reviewer_fail_once");
  try {
    const run = runAutopilot(repo, binDir, {request: SPECKIT_REQUEST, timeoutMs: SPECKIT_TIMEOUT_MS});
    const tasksText = fs.readFileSync(speckitTasksFile(repo), "utf8");
    const output = `${run.stdout}\n${run.stderr}`;
    check("speckit/functional-fail: mission completed", run.status === 0 && !/^- \[ \]/m.test(tasksText),
      {status: run.status, tail: output.slice(-400)});
    const counts = roleCounts(repo);
    check("speckit/functional-fail: implementer re-ran and was re-reviewed",
      counts.implementer === 2 && counts.code_reviewer >= 2 && counts.verifier === 1, counts);
    check("speckit/functional-fail: no Retry delay: line before the re-run or the re-review",
      retryDelayLines(output).length === 0, retryDelayLines(output));
  } finally {
    cleanup(repo, binDir);
  }
}

// ── E2E 2 (speckit): infra failure → same-stage retry pauses once ────────
{
  const {repo, binDir} = setupSpeckit("rp-speckit-infra", "speckit_reviewer_infra_once");
  try {
    const t0 = Date.now();
    const run = runAutopilot(repo, binDir, {request: SPECKIT_REQUEST, timeoutMs: SPECKIT_TIMEOUT_MS});
    const elapsed = Date.now() - t0;
    const tasksText = fs.readFileSync(speckitTasksFile(repo), "utf8");
    const output = `${run.stdout}\n${run.stderr}`;
    check("speckit/infra-retry: mission completed", run.status === 0 && !/^- \[ \]/m.test(tasksText),
      {status: run.status, tail: output.slice(-400)});
    const lines = retryDelayLines(output);
    check("speckit/infra-retry: exactly one Retry delay: line (cleared afterwards, so later stages do not pause)",
      lines.length === 1, lines);
    check("speckit/infra-retry: labelled infrastructure retry, never transient",
      lines.length === 1 && lines[0].includes("infrastructure retry") && !output.includes("transient"),
      lines[0]);
    check("speckit/infra-retry: the pause actually waited", elapsed >= 1000, {elapsed});
  } finally {
    cleanup(repo, binDir);
  }
}

console.log(`\n${ok} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
