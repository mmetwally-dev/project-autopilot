#!/usr/bin/env node
// TASK-40: full suite as an orchestrator gate; gate output is captured,
// logged, and handed to the Verifier. Covers:
//  1. The output-capturing guarded command executor (exit code, duration,
//     tail, log file, console streaming still live).
//  2. Verifier brief (both loops): "Gate result" section present on PASS
//     and on FAIL (tail + failing command), absent and byte-identical when
//     gates.commands is [].
//  3. E2E standalone and SpecKit: a gate that fails round 1 and passes
//     round 2 → phase fails once, the Verifier's prompt carries the
//     failing tail, then the phase passes; gate log files exist.
//  4. Planner/plan-reviewer prompt wording switches only when gates set.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createGitMutationGuard, guardedCommandEnv} from "./relay-guards.mjs";
import {createShellGuard} from "./shell-guard.mjs";
import {runGuardedCommand} from "./guarded-command.mjs";
import {shouldRefusePassForEvidence, normalizeLinkedResult, linkedVerifyCommandsForPhase, reviewerLinkedToolResults} from "./failure-contract.mjs";
import {buildStandaloneHandoff, formatGateResult} from "./standalone-handoff.mjs";
import {makeFixtureRepo, makeFixtureBin, makeSpecKitPhaseFixture, setScenario, writeConfig, runAutopilot, readObservedEvents, cleanup} from "./test-fixtures/workflow-order-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const autopilotSource = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");

let failures = 0;
function check(name, condition) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ap-gate-${prefix}-`));
}

// ---- 1. Capture executor: passing and failing fake commands ----
// Mirrors how gates() builds its env/guard (same createGitMutationGuard +
// createShellGuard + guardedCommandEnv), with network isolation opted out
// so the unit runs without unshare; the decideExecution guard path itself
// is still exercised.
{
  const root = tempDir("exec");
  const logDir = tempDir("execlog");
  try {
    const guard = createGitMutationGuard(root, root);
    const shellGuard = createShellGuard(root);
    shellGuard.networkIsolationEnabled = false;
    const env = guardedCommandEnv(guard, {}, []);

    // Passing command: status 0, duration recorded, tail contains the
    // marker, log file has the marker, console streaming still visible
    // (captured in-process via process.stdout.write).
    {
      const logFile = path.join(logDir, "pass.log");
      const originalWrite = process.stdout.write.bind(process.stdout);
      let streamed = "";
      process.stdout.write = (chunk, ...rest) => { streamed += chunk; return true; };
      let p;
      try {
        p = await runGuardedCommand(root, "echo gate-pass-marker", env, shellGuard, {label: "gates.commands", capture: true, logFile});
      } finally {
        process.stdout.write = originalWrite;
      }
      check("capture/pass: status 0", p.status === 0);
      check("capture/pass: durationMs is a non-negative number", Number.isFinite(p.durationMs) && p.durationMs >= 0);
      check("capture/pass: tail contains the marker", typeof p.tail === "string" && p.tail.includes("gate-pass-marker"));
      check("capture/pass: log file contains the marker", fs.existsSync(logFile) && fs.readFileSync(logFile, "utf8").includes("gate-pass-marker"));
      check("capture/pass: console still streamed the marker", streamed.includes("gate-pass-marker"));
    }

    // Failing command: status 3, tail carries the failing output, log file
    // written, console streamed.
    {
      const logFile = path.join(logDir, "fail.log");
      const originalWrite = process.stderr.write.bind(process.stderr);
      let streamed = "";
      process.stderr.write = (chunk, ...rest) => { streamed += chunk; return true; };
      let p;
      try {
        p = await runGuardedCommand(root, "echo gate-fail-marker >&2; exit 3", env, shellGuard, {label: "gates.commands", capture: true, logFile});
      } finally {
        process.stderr.write = originalWrite;
      }
      check("capture/fail: status 3", p.status === 3);
      check("capture/fail: durationMs is a non-negative number", Number.isFinite(p.durationMs) && p.durationMs >= 0);
      check("capture/fail: tail contains the marker", typeof p.tail === "string" && p.tail.includes("gate-fail-marker"));
      check("capture/fail: log file contains the marker", fs.existsSync(logFile) && fs.readFileSync(logFile, "utf8").includes("gate-fail-marker"));
      check("capture/fail: console still streamed the marker", streamed.includes("gate-fail-marker"));
    }

    // Default mode is untouched: still returns the buffered spawn result
    // synchronously with stdio inherit.
    {
      const p = runGuardedCommand(root, "true", env, shellGuard, "gates.commands");
      check("capture/default unchanged: sync result with status", typeof p.status === "number");
      check("capture/default unchanged: no tail field", !("tail" in p));
    }
  } finally {
    cleanup(root, logDir);
  }
}

// ---- 2. Verifier brief section ----
function baseHandoffOpts(overrides = {}) {
  return {
    kind: "PHASE_VERIFY",
    phaseName: "Phase 1: Fixture",
    phaseIndex: 0,
    phaseTotal: 1,
    phaseTasks: [{text: "do the fixture task", file: "tasks.md", line: 3}],
    attempt: 1,
    deltaChunks: [{path: "tasks.md", text: "+delta line"}],
    baselineKey: "baseline-key",
    declaredPaths: [],
    implementationSummary: "",
    ...overrides,
  };
}

{
  const passGate = {ok: true, exitCode: 0, durationMs: 123, logFile: "/tmp/gates/phase-1-1.log", tail: "all tests passed", results: [{command: "node scripts/test-all.mjs", ok: true, exitCode: 0, durationMs: 123, logFile: "/tmp/gates/phase-1-1.log", tail: "all tests passed"}]};
  const failGate = {ok: false, command: "node scripts/test-all.mjs", exitCode: 1, durationMs: 456, logFile: "/tmp/gates/phase-1-2.log", tail: "FAILING-TAIL-MARKER\nmore output", results: [{command: "node scripts/test-all.mjs", ok: false, exitCode: 1, durationMs: 456, logFile: "/tmp/gates/phase-1-2.log", tail: "FAILING-TAIL-MARKER\nmore output"}]};

  const vPass = buildStandaloneHandoff(baseHandoffOpts({gateResult: passGate}));
  check("brief/PASS: Gate result section present", vPass.text.includes("Gate result"));
  check("brief/PASS: command listed", vPass.text.includes("node scripts/test-all.mjs"));
  check("brief/PASS: exit code + duration present", vPass.text.includes("exit 0") && vPass.text.includes("123 ms"));
  check("brief/PASS: log path present", vPass.text.includes("/tmp/gates/phase-1-1.log"));
  check("brief/PASS: tail present", vPass.text.includes("all tests passed"));
  check("brief/PASS: do-not-rerun instruction", vPass.text.includes("Do not re-run the whole suite") || vPass.text.includes("do not re-run it"));
  check("brief/PASS: header switched to gate-aware", vPass.text.includes("The full test suite already ran as the phase gate"));

  const vFail = buildStandaloneHandoff(baseHandoffOpts({gateResult: failGate}));
  check("brief/FAIL: section present", vFail.text.includes("Gate result"));
  check("brief/FAIL: failing command named", vFail.text.includes("Failing command: node scripts/test-all.mjs"));
  check("brief/FAIL: failing tail present", vFail.text.includes("FAILING-TAIL-MARKER"));
  check("brief/FAIL: red-gate verdict rule", vFail.text.includes("On gate FAIL, return FAIL at once with the failing files"));

  const vEmpty = buildStandaloneHandoff(baseHandoffOpts({gateResult: {ok: true}}));
  check("brief/empty gates: no Gate result section", !vEmpty.text.includes("Gate result"));
  const vNone = buildStandaloneHandoff(baseHandoffOpts());
  check("brief/empty gates: byte-identical to no gateResult ({ok:true} un-set)", vEmpty.text === vNone.text);
  check("brief/empty gates: header unchanged", vNone.text.includes("Run the full test suite yourself end-to-end"));

  check("formatGateResult: empty for {ok:true}", formatGateResult({ok: true}) === "");
  const section = formatGateResult(failGate);
  check("formatGateResult: section includes failing tail", section.includes("FAILING-TAIL-MARKER"));
}

// ---- 3. E2E standalone + SpecKit ----
const GATE_CMD = 'ATTEMPT=$(cat .autopilot/.autopilot-test-attempt 2>/dev/null || echo 0); if [ "$ATTEMPT" -le 1 ]; then echo FAILING-TAIL-MARKER; exit 1; else echo GATE-OK; exit 0; fi';

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function gateLogsUnder(repo) {
  const root = path.join(repo, ".autopilot", "missions");
  if (!fs.existsSync(root)) return [];
  return walk(root).filter((f) => f.includes(`${path.sep}gates${path.sep}`) && f.endsWith(".log"));
}

function verifierResults(events) {
  return events.filter((e) => e.role === "verifier").map((e) => JSON.parse(fs.readFileSync(e.file, "utf8")));
}

{
  const repo = makeFixtureRepo("gate-standalone");
  const binDir = makeFixtureBin("gate-standalone");
  try {
    writeConfig(repo, {planningFramework: "standalone", gatesCommands: [GATE_CMD]});
    setScenario(repo, "gate_result_report");
    const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: 120000});
    const events = readObservedEvents(repo);
    const verifiers = verifierResults(events);

    check("e2e/standalone: mission completed (exit 0)", run.status === 0);
    check("e2e/standalone: verifier ran twice (gate FAIL then PASS round)", verifiers.length === 2);
    check("e2e/standalone: round-1 verifier brief had Gate result section", verifiers[0]?.review?.findings?.includes("gate_section=yes"));
    check("e2e/standalone: round-1 verifier brief carried failing tail", verifiers[0]?.review?.findings?.includes("tail_marker=yes"));
    check("e2e/standalone: round-1 verifier brief carried log path", verifiers[0]?.review?.findings?.includes("log_path=yes"));
    check("e2e/standalone: round-2 verifier brief still has the section", verifiers[1]?.review?.findings?.includes("gate_section=yes"));
    check("e2e/standalone: round-2 brief carries no failing tail", verifiers[1]?.review?.findings?.includes("tail_marker=no"));
    const logs = gateLogsUnder(repo);
    check("e2e/standalone: gate log files exist under the mission", logs.length >= 2);
    check("e2e/standalone: a gate log contains the failing marker", logs.some((f) => fs.readFileSync(f, "utf8").includes("FAILING-TAIL-MARKER")));
    check("e2e/standalone: round-1 verifier PASS on red gate recorded as FAIL (red_gate override), round 2 PASS", verifiers[0]?.review?.decision === "FAIL" && verifiers[0]?.verdictOverride === "red_gate" && verifiers[1]?.review?.decision === "PASS");
  } finally {
    cleanup(repo, binDir);
  }
}

{
  const repo = makeFixtureRepo("gate-speckit");
  const binDir = makeFixtureBin("gate-speckit");
  try {
    makeSpecKitPhaseFixture(repo);
    writeConfig(repo, {planningFramework: "speckit", gatesCommands: [GATE_CMD], networkIsolation: process.platform !== "win32"});
    setScenario(repo, "gate_result_report");
    const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: 120000});
    const events = readObservedEvents(repo);
    const verifiers = verifierResults(events);

    check("e2e/speckit: mission completed (exit 0)", run.status === 0);
    check("e2e/speckit: verifier ran twice", verifiers.length === 2);
    check("e2e/speckit: round-1 verifier brief had Gate result section", verifiers[0]?.review?.findings?.includes("gate_section=yes"));
    check("e2e/speckit: round-1 verifier brief carried failing tail", verifiers[0]?.review?.findings?.includes("tail_marker=yes"));
    check("e2e/speckit: round-1 verifier brief carried log path", verifiers[0]?.review?.findings?.includes("log_path=yes"));
    check("e2e/speckit: round-2 brief still has the section", verifiers[1]?.review?.findings?.includes("gate_section=yes"));
    check("e2e/speckit: round-2 brief carries no failing tail", verifiers[1]?.review?.findings?.includes("tail_marker=no"));
    const logs = gateLogsUnder(repo);
    check("e2e/speckit: gate log files exist under the mission", logs.length >= 2);
    check("e2e/speckit: a gate log contains the failing marker", logs.some((f) => fs.readFileSync(f, "utf8").includes("FAILING-TAIL-MARKER")));
  } finally {
    cleanup(repo, binDir);
  }
}

// ---- 4. Planner / plan-reviewer prompt wording ----
{
  check("prompts: tasksLine switches to orchestrator-gate wording when gates set",
    autopilotSource.includes('the orchestrator runs the full suite as a gate after code review, and the verifier analyses its result'));
  check("prompts: tasksLine keeps the empty-gates sentence for the no-gates case",
    autopilotSource.includes("the full suite is the verifier's job after the phase"));
  check("prompts: plan-reviewer switches when gates set",
    autopilotSource.includes('is run by the orchestrator as a gate after code review'));
  check("prompts: plan-reviewer keeps the empty-gates sentence",
    autopilotSource.includes('"belongs to the verifier"'));
  check("prompts: never make the suite a task still present",
    autopilotSource.includes("Never make running the whole test suite a task"));
}

// ---- 5. Refusal predicate wired to both evidence channels ----
{
  const gateTimeout = {command: "node scripts/test-all.mjs", exitCode: 124, ok: false};
  const toolTimeout = {command: "node scripts/test-all.mjs", status: 124, exitCode: 124, signal: null, timedOut: false};
  const rGate = shouldRefusePassForEvidence({gateResults: [gateTimeout], toolResults: []});
  check("refusal/both-channels: gate-shaped 124 refuses", rGate?.refuse === true && rGate?.reason === "timed-out");
  const rTool = shouldRefusePassForEvidence({gateResults: [], toolResults: [toolTimeout]});
  check("refusal/both-channels: tool-shaped 124 refuses", rTool?.refuse === true && rTool?.reason === "timed-out");
  check("refusal/both-channels: same refusal across channels",
    rGate?.reason === rTool?.reason && rGate?.status === rTool?.status && rGate?.exitCode === rTool?.exitCode);

  const gateFail = {command: "node scripts/test-all.mjs", exitCode: 1, ok: false};
  const rFail = shouldRefusePassForEvidence({gateResults: [gateFail], toolResults: []});
  check("refusal/both-channels: gate-shaped non-zero refuses as failed", rFail?.refuse === true && rFail?.reason === "failed");

  const cleanGate = {command: "node scripts/test-all.mjs", exitCode: 0, ok: true};
  const cleanTool = {command: "node scripts/test-all.mjs", status: 0, exitCode: 0, signal: null, timedOut: false};
  check("refusal/both-channels: clean gate+tool passes",
    shouldRefusePassForEvidence({gateResults: [cleanGate], toolResults: [cleanTool]}) === null);

  const mixed = shouldRefusePassForEvidence({gateResults: [cleanGate], toolResults: [toolTimeout]});
  check("refusal/both-channels: mixed gate+tool refuses (first refusal wins)",
    mixed?.refuse === true && mixed?.reason === "timed-out" && mixed?.index === 1);

  check("refusal/both-channels: tool metadata.exit normalizes",
    normalizeLinkedResult({command: "vitest", metadata: {exit: 2}}).status === 2);

  // OpenCode tool-part shape: string status must not shadow metadata.exit.
  check("refusal/both-channels: string completed + exit 0 is clean",
    shouldRefusePassForEvidence({gateResults: [], toolResults: [{command: "node scripts/test-all.mjs", status: "completed", metadata: {exit: 0}}]}) === null);
  const rStringTimeout = shouldRefusePassForEvidence({gateResults: [], toolResults: [{command: "node scripts/test-all.mjs", status: "completed", metadata: {exit: 124}}]});
  check("refusal/both-channels: string completed + exit 124 refuses as timed-out",
    rStringTimeout?.refuse === true && rStringTimeout?.reason === "timed-out");
}

// ---- 6. Standalone regression: timed-out review cannot PASS, failed review cannot PASS ----
{
  // Mission 025 task 2.3: extraction fixtures run through the real
  // reviewerLinkedToolResults() helper (scripts/failure-contract.mjs),
  // the exact shape the standalone reviewer path feeds into
  // shouldRefusePassForEvidence() at autopilot.mjs:5546.
  const linked = linkedVerifyCommandsForPhase([{text: "x ; verify: node scripts/test-all.mjs"}], []);
  check("standalone-refusal/linked commands extracted", linked.length === 1 && linked[0] === "node scripts/test-all.mjs");

  const opencodeBash = (command, exit) => ({
    observations: [{event: {type: "tool", part: {tool: "bash", state: {input: {command}, metadata: {exit}}}}}],
  });
  const codexExec = (command, exit_code) => ({
    observations: [{event: {item: {type: "command_execution", command, exit_code}}}],
  });

  // OpenCode: linked verify exiting 124 must refuse as timed-out.
  const ocTimeout = reviewerLinkedToolResults(opencodeBash("node scripts/test-all.mjs", 124), linked);
  check("standalone-refusal/opencode 124 extracts one linked result", ocTimeout.length === 1);
  const rTimedOut = shouldRefusePassForEvidence({gateResults: [], toolResults: ocTimeout});
  check("standalone-refusal/timed-out review cannot PASS", rTimedOut?.refuse === true);
  check("standalone-refusal/timed-out reason", rTimedOut?.reason === "timed-out");

  // OpenCode: linked verify exiting 1 must refuse as failed.
  const ocFailed = reviewerLinkedToolResults(opencodeBash("node scripts/test-all.mjs", 1), linked);
  check("standalone-refusal/opencode 1 extracts one linked result", ocFailed.length === 1);
  const rFailed = shouldRefusePassForEvidence({gateResults: [], toolResults: ocFailed});
  check("standalone-refusal/failed review cannot PASS", rFailed?.refuse === true);
  check("standalone-refusal/failed reason", rFailed?.reason === "failed");

  // OpenCode: non-verify command (grep) exiting 1 must NOT refuse.
  const ocInspect = reviewerLinkedToolResults(opencodeBash("grep -r marker src", 1), linked);
  check("standalone-refusal/non-verify command extracts nothing", ocInspect.length === 0);
  check("standalone-refusal/non-verify command cannot refuse",
    shouldRefusePassForEvidence({gateResults: [], toolResults: ocInspect}) === null);

  // Codex: same trio over command_execution events.
  const cxTimeout = reviewerLinkedToolResults(codexExec("node scripts/test-all.mjs", 124), linked);
  check("standalone-refusal/codex 124 extracts one linked result", cxTimeout.length === 1);
  const rCxTimeout = shouldRefusePassForEvidence({gateResults: [], toolResults: cxTimeout});
  check("standalone-refusal/codex timed-out review cannot PASS",
    rCxTimeout?.refuse === true && rCxTimeout?.reason === "timed-out");

  const cxFailed = reviewerLinkedToolResults(codexExec("node scripts/test-all.mjs", 1), linked);
  check("standalone-refusal/codex 1 extracts one linked result", cxFailed.length === 1);
  const rCxFailed = shouldRefusePassForEvidence({gateResults: [], toolResults: cxFailed});
  check("standalone-refusal/codex failed review cannot PASS",
    rCxFailed?.refuse === true && rCxFailed?.reason === "failed");

  const cxInspect = reviewerLinkedToolResults(codexExec("grep -r marker src", 1), linked);
  check("standalone-refusal/codex non-verify extracts nothing", cxInspect.length === 0);
  check("standalone-refusal/codex non-verify cannot refuse",
    shouldRefusePassForEvidence({gateResults: [], toolResults: cxInspect}) === null);

  // Wiring guard: the standalone reviewer enforcement is present in the
  // orchestrator (refusal routes to feedback/retry, never to PASS).
  check("standalone-refusal/reviewer enforcement present",
    autopilotSource.includes("toolResults:reviewerLinkedToolResults(rv,linkedVerifyCommandsForPhase"));
  check("standalone-refusal/reviewer refusal recorded with reason",
    autopilotSource.includes("Reviewer PASS refused"));
}

// ---- 7. Standalone final review cannot PASS on failed linked evidence ----
{
  // Mission 025 task 2.4: both mission-final reviewer blocks (no-pending
  // early path and post-loop final block) feed
  // reviewerLinkedToolResults(final, linkedVerifyCommandsForPhase(...)) into
  // shouldRefusePassForEvidence(); a 124, non-zero, or killed linked result
  // escalates instead of completing the mission, while non-verify inspection
  // commands never refuse. Fixtures run through the real extraction helper.
  const missionLinked = linkedVerifyCommandsForPhase([{text: "x ; verify: node scripts/test-all.mjs"}], []);
  const finalBash = (command, exit) => ({
    observations: [{event: {type: "tool", part: {tool: "bash", state: {input: {command}, metadata: {exit}}}}}],
  });
  const finalTimeout = reviewerLinkedToolResults(finalBash("node scripts/test-all.mjs", 124), missionLinked);
  const rFinalTimeout = shouldRefusePassForEvidence({gateResults: [], toolResults: finalTimeout});
  check("standalone-final-refusal/124 linked result cannot PASS", rFinalTimeout?.refuse === true && rFinalTimeout?.reason === "timed-out");

  const finalFailed = reviewerLinkedToolResults(finalBash("node scripts/test-all.mjs", 1), missionLinked);
  const rFinalFailed = shouldRefusePassForEvidence({gateResults: [], toolResults: finalFailed});
  check("standalone-final-refusal/non-zero linked result cannot PASS", rFinalFailed?.refuse === true && rFinalFailed?.reason === "failed");

  const finalKilled = [{command: "node scripts/test-all.mjs", status: null, exitCode: null, signal: "SIGKILL", timedOut: false}];
  const rFinalKilled = shouldRefusePassForEvidence({gateResults: [], toolResults: finalKilled});
  check("standalone-final-refusal/killed linked result cannot PASS", rFinalKilled?.refuse === true && rFinalKilled?.reason === "timed-out");

  const finalInspect = reviewerLinkedToolResults(finalBash("grep -r marker src", 1), missionLinked);
  check("standalone-final-refusal/non-verify command extracts nothing", finalInspect.length === 0);
  check("standalone-final-refusal/non-verify command cannot refuse",
    shouldRefusePassForEvidence({gateResults: [], toolResults: finalInspect}) === null);

  // Wiring guard: both standalone final-review refusals are present in the
  // orchestrator (refusal escalates, never reaching finalizeMissionComplete).
  check("standalone-final-refusal/final enforcement present",
    autopilotSource.includes("toolResults:reviewerLinkedToolResults(final,linkedVerifyCommandsForPhase"));
}

// ---- 8. SpecKit regression: timed-out review cannot PASS, failed review cannot PASS ----
{
  // Mission 025 task 3.3: mirrors the standalone fixtures in section 6
  // through the same real extraction helper
  // (reviewerLinkedToolResults() in scripts/failure-contract.mjs), the
  // exact shape the SpecKit reviewer path feeds into
  // shouldRefusePassForEvidence() at autopilot.mjs:6595 and the SpecKit
  // verifier path at autopilot.mjs:6680 (joint gate+verdict check).
  const linked = linkedVerifyCommandsForPhase([{text: "x ; verify: node scripts/test-all.mjs"}], []);
  check("speckit-refusal/linked commands extracted", linked.length === 1 && linked[0] === "node scripts/test-all.mjs");

  const opencodeBash = (command, exit) => ({
    observations: [{event: {type: "tool", part: {tool: "bash", state: {input: {command}, metadata: {exit}}}}}],
  });
  const codexExec = (command, exit_code) => ({
    observations: [{event: {item: {type: "command_execution", command, exit_code}}}],
  });

  // OpenCode: linked verify exiting 124 must refuse as timed-out.
  const ocTimeout = reviewerLinkedToolResults(opencodeBash("node scripts/test-all.mjs", 124), linked);
  check("speckit-refusal/opencode 124 extracts one linked result", ocTimeout.length === 1);
  const rTimedOut = shouldRefusePassForEvidence({gateResults: [], toolResults: ocTimeout});
  check("speckit-refusal/timed-out review cannot PASS", rTimedOut?.refuse === true);
  check("speckit-refusal/timed-out reason", rTimedOut?.reason === "timed-out");

  // OpenCode: linked verify exiting 1 must refuse as failed.
  const ocFailed = reviewerLinkedToolResults(opencodeBash("node scripts/test-all.mjs", 1), linked);
  check("speckit-refusal/opencode 1 extracts one linked result", ocFailed.length === 1);
  const rFailed = shouldRefusePassForEvidence({gateResults: [], toolResults: ocFailed});
  check("speckit-refusal/failed review cannot PASS", rFailed?.refuse === true);
  check("speckit-refusal/failed reason", rFailed?.reason === "failed");

  // OpenCode: non-verify command (grep) exiting 1 must NOT refuse.
  const ocInspect = reviewerLinkedToolResults(opencodeBash("grep -r marker src", 1), linked);
  check("speckit-refusal/non-verify command extracts nothing", ocInspect.length === 0);
  check("speckit-refusal/non-verify command cannot refuse",
    shouldRefusePassForEvidence({gateResults: [], toolResults: ocInspect}) === null);

  // Codex: same trio over command_execution events.
  const cxTimeout = reviewerLinkedToolResults(codexExec("node scripts/test-all.mjs", 124), linked);
  check("speckit-refusal/codex 124 extracts one linked result", cxTimeout.length === 1);
  const rCxTimeout = shouldRefusePassForEvidence({gateResults: [], toolResults: cxTimeout});
  check("speckit-refusal/codex timed-out review cannot PASS",
    rCxTimeout?.refuse === true && rCxTimeout?.reason === "timed-out");

  const cxFailed = reviewerLinkedToolResults(codexExec("node scripts/test-all.mjs", 1), linked);
  check("speckit-refusal/codex 1 extracts one linked result", cxFailed.length === 1);
  const rCxFailed = shouldRefusePassForEvidence({gateResults: [], toolResults: cxFailed});
  check("speckit-refusal/codex failed review cannot PASS",
    rCxFailed?.refuse === true && rCxFailed?.reason === "failed");

  const cxInspect = reviewerLinkedToolResults(codexExec("grep -r marker src", 1), linked);
  check("speckit-refusal/codex non-verify extracts nothing", cxInspect.length === 0);
  check("speckit-refusal/codex non-verify cannot refuse",
    shouldRefusePassForEvidence({gateResults: [], toolResults: cxInspect}) === null);

  // SpecKit verifier joint gate+verdict check: a failed gate result alone
  // refuses PASS even when the verifier ran no linked tools.
  const rGateFail = shouldRefusePassForEvidence({gateResults: [{command: "node scripts/test-all.mjs", exitCode: 1, ok: false}], toolResults: []});
  check("speckit-refusal/verifier gate-shaped non-zero cannot PASS",
    rGateFail?.refuse === true && rGateFail?.reason === "failed");
  const rGateTimeout = shouldRefusePassForEvidence({gateResults: [{command: "node scripts/test-all.mjs", exitCode: 124, ok: false}], toolResults: []});
  check("speckit-refusal/verifier gate-shaped 124 cannot PASS",
    rGateTimeout?.refuse === true && rGateTimeout?.reason === "timed-out");

  // Wiring guards: both SpecKit enforcements are present in the
  // orchestrator (refusals route to feedback/retry, never to PASS). The
  // task markers pin the SpecKit blocks (not the standalone twins), and
  // the rv/vv enforcement call sites must exist in both loops.
  check("speckit-refusal/reviewer enforcement present",
    autopilotSource.includes("Mission 025 task 3.1"));
  check("speckit-refusal/verifier enforcement present",
    autopilotSource.includes("Mission 025 task 3.2"));
  check("speckit-refusal/reviewer enforcement in both loops",
    autopilotSource.split("toolResults:reviewerLinkedToolResults(rv,linkedVerifyCommandsForPhase").length - 1 >= 2);
  check("speckit-refusal/verifier enforcement in both loops",
    autopilotSource.split("toolResults:reviewerLinkedToolResults(vv,linkedVerifyCommandsForPhase").length - 1 >= 2);
  check("speckit-refusal/reviewer refusal recorded with reason",
    autopilotSource.includes("Reviewer PASS refused"));
  check("speckit-refusal/verifier refusal recorded with reason",
    autopilotSource.includes("Verifier PASS refused"));
}

// ---- 9. SpecKit final review cannot PASS on failed linked evidence ----
{
  // Mission 025 task 3.4: mirrors the standalone final-review fixtures in
  // section 7 through the real extraction helper
  // (reviewerLinkedToolResults() in scripts/failure-contract.mjs), the
  // exact shape the SpecKit mission-final reviewer feeds into
  // shouldRefusePassForEvidence(). A 124, non-zero, or killed linked result
  // escalates instead of completing the mission, while non-verify
  // inspection commands never refuse.
  const missionLinked = linkedVerifyCommandsForPhase([{text: "x ; verify: node scripts/test-all.mjs"}], []);
  const finalBash = (command, exit) => ({
    observations: [{event: {type: "tool", part: {tool: "bash", state: {input: {command}, metadata: {exit}}}}}],
  });
  const finalTimeout = reviewerLinkedToolResults(finalBash("node scripts/test-all.mjs", 124), missionLinked);
  const rFinalTimeout = shouldRefusePassForEvidence({gateResults: [], toolResults: finalTimeout});
  check("speckit-final-refusal/124 linked result cannot PASS", rFinalTimeout?.refuse === true && rFinalTimeout?.reason === "timed-out");

  const finalFailed = reviewerLinkedToolResults(finalBash("node scripts/test-all.mjs", 1), missionLinked);
  const rFinalFailed = shouldRefusePassForEvidence({gateResults: [], toolResults: finalFailed});
  check("speckit-final-refusal/non-zero linked result cannot PASS", rFinalFailed?.refuse === true && rFinalFailed?.reason === "failed");

  const finalKilled = [{command: "node scripts/test-all.mjs", status: null, exitCode: null, signal: "SIGKILL", timedOut: false}];
  const rFinalKilled = shouldRefusePassForEvidence({gateResults: [], toolResults: finalKilled});
  check("speckit-final-refusal/killed linked result cannot PASS", rFinalKilled?.refuse === true && rFinalKilled?.reason === "timed-out");

  const finalInspect = reviewerLinkedToolResults(finalBash("grep -r marker src", 1), missionLinked);
  check("speckit-final-refusal/non-verify command extracts nothing", finalInspect.length === 0);
  check("speckit-final-refusal/non-verify command cannot refuse",
    shouldRefusePassForEvidence({gateResults: [], toolResults: finalInspect}) === null);

  // Wiring guards: the SpecKit mission-final refusal is present in the
  // orchestrator (refusal escalates, never reaching finalizeMissionComplete).
  // The task marker pins the SpecKit final block (not the standalone twin),
  // and the mission-wide final enforcement call sites exist in both loops.
  check("speckit-final-refusal/final enforcement present",
    autopilotSource.includes("Mission 025 task 3.4"));
  check("speckit-final-refusal/final enforcement in both loops",
    autopilotSource.split("toolResults:reviewerLinkedToolResults(final,linkedVerifyCommandsForPhase").length - 1 >= 2);
}

// ---- 10. Standalone verifier gate-result cache: infra retry reuses, FAIL re-runs ----
{
  const INFRA_COUNT_GATE = 'mkdir -p .autopilot; echo x >> .autopilot/gate-count; echo GATE-OK; exit 0';
  const FAIL_COUNT_GATE = 'mkdir -p .autopilot; echo x >> .autopilot/gate-count; S=$(cat .autopilot/.autopilot-test-standalone-attempt 2>/dev/null || echo 0); if [ "$S" -le 1 ]; then echo FAIL-MARKER; exit 1; else echo GATE-OK; exit 0; fi';
  const gateCount = (repo) => {
    const f = path.join(repo, ".autopilot", "gate-count");
    if (!fs.existsSync(f)) return 0;
    return fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim().length > 0).length;
  };

  // Infra retry: always-passing counting gate; verifier infra-fails once and
  // retries with the same delta, so the second verifier pass must reuse the
  // cached passing result (gate executes exactly once).
  {
    const repo = makeFixtureRepo("gate-cache-infra");
    const binDir = makeFixtureBin("gate-cache-infra");
    try {
      writeConfig(repo, {planningFramework: "standalone", gatesCommands: [INFRA_COUNT_GATE]});
      setScenario(repo, "standalone_verifier_infra_once");
      const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: 120000});
      check("cache-infra: mission completed (exit 0)", run.status === 0);
      check("cache-infra: gate executed once (cached on verifier retry)", gateCount(repo) === 1);
    } finally {
      cleanup(repo, binDir);
    }
  }

  // Functional FAIL: counting gate fails while standalone-attempt <= 1; the
  // real verifier FAIL goes back through the implementer with the delta
  // unchanged, so the second verifier pass must re-run the gate (failed
  // results are never cached): count === 2 and the mission completes.
  {
    const repo = makeFixtureRepo("gate-cache-fail");
    const binDir = makeFixtureBin("gate-cache-fail");
    try {
      writeConfig(repo, {planningFramework: "standalone", gatesCommands: [FAIL_COUNT_GATE]});
      setScenario(repo, "standalone_verifier_fail_once");
      const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: 120000});
      check("cache-fail: mission completed (exit 0)", run.status === 0);
      check("cache-fail: gate re-ran after FAIL (failed result not cached)", gateCount(repo) === 2);
    } finally {
      cleanup(repo, binDir);
    }
  }

  // Delta change: verifier FAILs once, then the retry's Implementer edits
  // an in-scope file (output/delta-change.txt via the
  // standalone_verifier_delta_change adapter scenario), so the retry's
  // scoped delta differs — new cacheKey, no cache hit. An always-passing
  // counting gate must therefore execute twice.
  {
    const repo = makeFixtureRepo("gate-cache-delta");
    const binDir = makeFixtureBin("gate-cache-delta");
    try {
      writeConfig(repo, {planningFramework: "standalone", gatesCommands: [INFRA_COUNT_GATE]});
      setScenario(repo, "standalone_verifier_delta_change");
      const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: 120000});
      check("cache-delta: mission completed (exit 0)", run.status === 0);
      check("cache-delta: gate re-ran after delta change (new cacheKey, no cache hit)", gateCount(repo) === 2);
    } finally {
      cleanup(repo, binDir);
    }
  }

  // File-writing gate: verifier infra-fails once and retries with the same
  // implementer delta, but the gate itself writes an in-scope file
  // (output/gate-wrote.txt). The post-gate refreshed deltaDigest cache
  // entry covers that write, so the retry's pre-gate lookup hits it and
  // the gate executes exactly once.
  {
    const FILE_WRITE_COUNT_GATE = 'mkdir -p .autopilot output; echo x >> .autopilot/gate-count; echo gate-output >> output/gate-wrote.txt; echo GATE-OK; exit 0';
    const repo = makeFixtureRepo("gate-cache-filewrite");
    const binDir = makeFixtureBin("gate-cache-filewrite");
    try {
      writeConfig(repo, {planningFramework: "standalone", gatesCommands: [FILE_WRITE_COUNT_GATE]});
      setScenario(repo, "standalone_verifier_infra_once");
      const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: 120000});
      check("cache-filewrite: mission completed (exit 0)", run.status === 0);
      check("cache-filewrite: gate executed once (post-gate cache hit on retry)", gateCount(repo) === 1);
    } finally {
      cleanup(repo, binDir);
    }
  }

  check("cache-wiring: standalone verifier looks up cached gate result",
    autopilotSource.includes("getCachedGateResult(checkpoint,preGateCacheKey)"));
  check("cache-wiring: standalone verifier stores passing gate result",
    autopilotSource.includes("setCachedGateResult(checkpoint,preGateCacheKey,g)"));
}

// ---- 11. SpecKit verifier gate-result cache: infra retry reuses, FAIL re-runs ----
{
  const INFRA_COUNT_GATE = 'mkdir -p .autopilot; echo x >> .autopilot/gate-count; echo GATE-OK; exit 0';
  const FAIL_COUNT_GATE = 'mkdir -p .autopilot; echo x >> .autopilot/gate-count; S=$(cat .autopilot/.autopilot-test-standalone-attempt 2>/dev/null || echo 0); if [ "$S" -le 1 ]; then echo FAIL-MARKER; exit 1; else echo GATE-OK; exit 0; fi';
  const gateCount = (repo) => {
    const f = path.join(repo, ".autopilot", "gate-count");
    if (!fs.existsSync(f)) return 0;
    return fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim().length > 0).length;
  };

  // Infra retry: always-passing counting gate; verifier infra-fails once and
  // retries with the same delta, so the second verifier pass must reuse the
  // cached passing result (gate executes exactly once).
  {
    const repo = makeFixtureRepo("gate-cache-speckit-infra");
    const binDir = makeFixtureBin("gate-cache-speckit-infra");
    try {
      makeSpecKitPhaseFixture(repo);
      writeConfig(repo, {planningFramework: "speckit", gatesCommands: [INFRA_COUNT_GATE]});
      setScenario(repo, "speckit_verifier_infra_once");
      const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: 120000});
      check("speckit-cache-infra: mission completed (exit 0)", run.status === 0);
      check("speckit-cache-infra: gate executed once (cached on verifier retry)", gateCount(repo) === 1);
    } finally {
      cleanup(repo, binDir);
    }
  }

  // Functional FAIL: counting gate fails while standalone-attempt <= 1 (the
  // speckit_verifier_fail_once adapter scenario keys off the same
  // Implementer-maintained counter file); the real verifier FAIL goes back
  // through the implementer with the delta unchanged, so the second verifier
  // pass must re-run the gate (failed results are never cached).
  {
    const repo = makeFixtureRepo("gate-cache-speckit-fail");
    const binDir = makeFixtureBin("gate-cache-speckit-fail");
    try {
      makeSpecKitPhaseFixture(repo);
      writeConfig(repo, {planningFramework: "speckit", gatesCommands: [FAIL_COUNT_GATE]});
      setScenario(repo, "speckit_verifier_fail_once");
      const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: 120000});
      check("speckit-cache-fail: mission completed (exit 0)", run.status === 0);
      check("speckit-cache-fail: gate re-ran after FAIL (failed result not cached)", gateCount(repo) === 2);
    } finally {
      cleanup(repo, binDir);
    }
  }

  // Delta change: verifier FAILs once, then the retry's Implementer edits
  // an in-scope file (output/delta-change.txt via the
  // speckit_verifier_delta_change adapter scenario), so the retry's
  // scoped delta differs — new cacheKey, no cache hit. An always-passing
  // counting gate must therefore execute twice.
  {
    const repo = makeFixtureRepo("gate-cache-speckit-delta");
    const binDir = makeFixtureBin("gate-cache-speckit-delta");
    try {
      makeSpecKitPhaseFixture(repo);
      writeConfig(repo, {planningFramework: "speckit", gatesCommands: [INFRA_COUNT_GATE]});
      setScenario(repo, "speckit_verifier_delta_change");
      const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: 120000});
      check("speckit-cache-delta: mission completed (exit 0)", run.status === 0);
      check("speckit-cache-delta: gate re-ran after delta change (new cacheKey, no cache hit)", gateCount(repo) === 2);
    } finally {
      cleanup(repo, binDir);
    }
  }

  // File-writing gate: verifier infra-fails once and retries with the same
  // implementer delta, but the gate itself writes an in-scope file
  // (output/gate-wrote.txt). The post-gate refreshed deltaDigest cache
  // entry covers that write, so the retry's pre-gate lookup hits it and
  // the gate executes exactly once.
  {
    const FILE_WRITE_COUNT_GATE = 'mkdir -p .autopilot output; echo x >> .autopilot/gate-count; echo gate-output >> output/gate-wrote.txt; echo GATE-OK; exit 0';
    const repo = makeFixtureRepo("gate-cache-speckit-filewrite");
    const binDir = makeFixtureBin("gate-cache-speckit-filewrite");
    try {
      makeSpecKitPhaseFixture(repo);
      writeConfig(repo, {planningFramework: "speckit", gatesCommands: [FILE_WRITE_COUNT_GATE]});
      setScenario(repo, "speckit_verifier_infra_once");
      const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: 120000});
      check("speckit-cache-filewrite: mission completed (exit 0)", run.status === 0);
      check("speckit-cache-filewrite: gate executed once (post-gate cache hit on retry)", gateCount(repo) === 1);
    } finally {
      cleanup(repo, binDir);
    }
  }
}

if (failures) {
  console.error(`${failures} orchestrator-gate check(s) failed.`);
  process.exit(1);
}
console.log("orchestrator-gate tests passed");
