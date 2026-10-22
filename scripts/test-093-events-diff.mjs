#!/usr/bin/env node
// Mission 093 Part 1 task 3.4: integration test for diff_stat event capture at
// the real sites (standalone implementer attempt, phase gate pass and fail),
// driven through real `autopilot run` subprocesses on the workflow-order
// harness. Reads the per-mission watch-events.jsonl the run wrote.
import fs from "node:fs";
import path from "node:path";
import { makeFixtureRepo, makeFixtureBin, writeConfig, setScenario, runAutopilot, cleanup } from "./test-fixtures/workflow-order-harness.mjs";

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

function readMissionEvents(repo) {
  const root = path.join(repo, ".autopilot", "missions");
  assert(fs.existsSync(root), "missions dir should exist");
  const dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory());
  assert(dirs.length === 1, `expected exactly 1 mission dir, got ${dirs.length}`);
  const file = path.join(root, dirs[0].name, "watch-events.jsonl");
  assert(fs.existsSync(file), "watch-events.jsonl should exist");
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function checkDiffEvent(e, who) {
  assert(typeof e.phase === "number" && Number.isFinite(e.phase), `${who}: phase should be numeric, got ${e.phase}`);
  assert(typeof e.attempt === "number" && Number.isFinite(e.attempt), `${who}: attempt should be numeric, got ${e.attempt}`);
  assert(typeof e.at === "string" && !Number.isNaN(Date.parse(e.at)), `${who}: at should be a timestamp, got ${e.at}`);
  assert(typeof e.stat === "string" && /\d+ files? changed/.test(e.stat), `${who}: stat should hold git diff --stat text, got ${JSON.stringify(e.stat)}`);
}

function runMission(prefix, { gate, failureBudgets }) {
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  writeConfig(repo, { planningFramework: "standalone", gatesCommands: [gate], failureBudgets });
  setScenario(repo, "standalone_basic");
  const run = runAutopilot(repo, binDir, { request: "implement the fixture task", timeoutMs: 90000 });
  return { repo, binDir, run };
}

console.log("Test 1: passing gate -> implementer diff_stat (taskRef set) and gate diff_stat (taskRef null)");
{
  const { repo, binDir, run } = runMission("diff-pass", { gate: "true", failureBudgets: {} });
  try {
    assert(run.status === 0, `run should exit 0, got ${run.status}`);
    const diffs = readMissionEvents(repo).filter(e => e.type === "diff_stat");
    const impl = diffs.filter(e => e.taskRef !== null);
    const gate = diffs.filter(e => e.taskRef === null);
    assert(impl.length >= 1, `expected an implementer diff_stat, got ${diffs.length} diff events`);
    assert(gate.length >= 1, `expected a gate diff_stat, got ${diffs.length} diff events`);
    impl.forEach(e => { assert(typeof e.taskRef === "string" && e.taskRef.length > 0, "implementer taskRef should be a non-empty string"); checkDiffEvent(e, "implementer"); });
    gate.forEach(e => checkDiffEvent(e, "gate"));
    impl.concat(gate).forEach(e => assert(e.attempt >= 1, `attempt should be 1-based, got ${e.attempt}`));
    assert(impl[0].attempt === gate[0].attempt, `implementer and gate diff_stat of the same round should share attempt (${impl[0].attempt} vs ${gate[0].attempt})`);
    console.log(`  ${impl.length} implementer + ${gate.length} gate diff_stat events`);
    console.log("  PASS");
  } finally { cleanup(repo, binDir); }
}

console.log("Test 2: failing gate -> gate failure site also emits diff_stat (taskRef null), implementer retries emit too");
{
  const { repo, binDir, run } = runMission("diff-fail", { gate: "false", failureBudgets: { verificationFailureBudget: 2 } });
  try {
    assert(run.status !== 0, "failing-gate run should exit non-zero");
    const events = readMissionEvents(repo);
    const failedResults = events.filter(e => e.type === "gate_result" && e.ok === false);
    assert(failedResults.length >= 1, "expected a failed gate_result");
    const diffs = events.filter(e => e.type === "diff_stat");
    const gate = diffs.filter(e => e.taskRef === null);
    const impl = diffs.filter(e => e.taskRef !== null);
    assert(gate.length >= failedResults.length, `each failed gate should emit a diff_stat (${gate.length} vs ${failedResults.length})`);
    assert(impl.length >= 1, "expected implementer diff_stat events");
    // the failure-site diff_stat directly follows its gate_result
    const idx = events.findIndex(e => e.type === "gate_result" && e.ok === false);
    assert(events[idx + 1]?.type === "diff_stat" && events[idx + 1].taskRef === null, "diff_stat should follow the failed gate_result");
    gate.forEach(e => checkDiffEvent(e, "gate(fail)"));
    impl.forEach(e => checkDiffEvent(e, "implementer(retry)"));
    console.log("  PASS");
  } finally { cleanup(repo, binDir); }
}

console.log("\nAll diff_stat capture tests passed.");
