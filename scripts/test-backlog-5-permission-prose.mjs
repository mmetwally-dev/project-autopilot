#!/usr/bin/env node
// Backlog #5 regression tests:
// 1. Bash exit 126 / "Permission denied" on executing a non-executable file is
//    command_failed only — never permission_denied.
// 2. Model prose on stderr (e.g. codex apply_patch verification dump mentioning
//    "(permission denied)") must never produce permission_denied.
// 3. A stream with a valid AUTOPILOT_REVIEW or AUTOPILOT_TASK_RESULT sentinel
//    anywhere must never be overridden to PERMISSION_DENIED (the verdict stands).
// 4. Real codex sandbox/approval denials still classify as PERMISSION_DENIED.
import assert from "node:assert/strict";
import {adapterDriver, finalAgentText} from "./adapter-drivers.mjs";
import {classifyObservedFailure, parseReviewContract, verdictFailure} from "./failure-contract.mjs";
import {parseTaskResultContract} from "./task-result-contract.mjs";

const probe = {
  root: "/workspace",
  readPath: "/workspace/input.txt",
  productionWritePath: "/workspace/output.txt",
  outsideWritePath: "/outside/output.txt"
};

const codex = adapterDriver("codex");
const claude = adapterDriver("claude");
const opencode = adapterDriver("opencode");
assert.ok(codex, "codex driver must be registered");
assert.ok(claude, "claude driver must be registered");
assert.ok(opencode, "opencode driver must be registered");

// ── 1. Run-75 shape: exit 126 + later successes + AUTOPILOT_REVIEW FAIL + trailing stderr prose ──
{
  const reviewSentinel = 'AUTOPILOT_REVIEW={"decision":"FAIL","findings":[{"location":"plan.md:45","problem":"[CRITICAL] Missing schema","correction":"Add ForgotPasswordRequestSchema"},{"location":"tasks.md:71","problem":"[HIGH] M3b split","correction":"Make M3b atomic"}]}';
  const stdoutLines = [
    JSON.stringify({type: "thread.started", thread_id: "01a1f9af-4355-7de1-9dd6-5275cc240a48"}),
    JSON.stringify({type: "turn.started"}),
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_2",
        type: "command_execution",
        command: "/bin/bash -lc '.specify/scripts/powershell/check-prerequisites.ps1 -Json -RequireTasks -IncludeTasks'",
        aggregated_output: "/bin/bash: line 1: .specify/scripts/powershell/check-prerequisites.ps1: Permission denied\n",
        exit_code: 126,
        status: "failed"
      }
    }),
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_3",
        type: "command_execution",
        command: "/bin/bash -lc 'pwsh -NoProfile -File .specify/scripts/powershell/check-prerequisites.ps1 -Json'",
        aggregated_output: "/bin/bash: line 1: pwsh: command not found\n",
        exit_code: 127,
        status: "failed"
      }
    }),
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_4",
        type: "command_execution",
        command: "/bin/bash -lc 'wc -l specs/013/tasks.md'",
        aggregated_output: "273 specs/013/tasks.md\n",
        exit_code: 0,
        status: "completed"
      }
    }),
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_26",
        type: "agent_message",
        text: `Review complete: blocking issues remain.\n\n${reviewSentinel}`
      }
    }),
    JSON.stringify({type: "turn.completed", usage: {input_tokens: 1000, output_tokens: 200}})
  ].join("\n");

  const stderrText = [
    "Reading prompt from stdin...",
    "2026-11-20T16:03:22.065572Z ERROR codex_core::tools::router: error=apply_patch verification failed: Failed to find expected lines in /workspace/scratch/speckit-planning-plan_reviewer.md:",
    "1. Checked and clear",
    "- `.claude/skills/speckit-analyze/SKILL.md`: read fully. Its required PowerShell prerequisite was attempted directly (permission denied) and through `pwsh` (not installed); artifact paths were therefore verified directly."
  ].join("\n");

  const events = codex.decodeEvents(stdoutLines, stderrText);
  const observations = codex.observe(events, probe);

  assert.equal(
    observations.some(o => o.type === "command_failed" && o.exit === 126),
    true,
    "exit 126 command_execution must be recorded as command_failed"
  );
  assert.equal(
    observations.some(o => o.type === "permission_denied"),
    false,
    "run-75 shape must never emit permission_denied"
  );

  const output = finalAgentText(events, "");
  const reviewContract = parseReviewContract(output);
  assert.equal(reviewContract.contract.status, "valid", "review sentinel must parse as valid");
  assert.equal(reviewContract.verdict.decision, "FAIL", "review verdict FAIL must be preserved");
  assert.equal(reviewContract.verdict.findings.length, 2, "all review findings must be preserved");

  const observedFailure = classifyObservedFailure({
    exitCode: 0,
    stdout: stdoutLines,
    stderr: stderrText,
    output,
    hasValidSentinel: reviewContract.contract.status === "valid",
    evidence: observations,
    driverless: false,
    adapter: "codex"
  });
  assert.equal(observedFailure, null, "run-75 shape must not produce an observed PERMISSION_DENIED failure");

  const relayFailure = observedFailure || reviewContract.failure || verdictFailure("plan_reviewer", reviewContract.verdict);
  assert.equal(relayFailure?.class, "PLANNING_REJECTED", "verdict FAIL must stand as PLANNING_REJECTED");
}

// ── 2. Terminal bash exit 126 without recovery or sentinel is command_failed only ──
{
  const events = [
    {
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "/bin/bash -lc '.specify/scripts/powershell/check-prerequisites.ps1'",
        aggregated_output: "/bin/bash: line 1: .specify/scripts/powershell/check-prerequisites.ps1: Permission denied\n",
        exit_code: 126,
        status: "failed"
      }
    }
  ];
  const observations = codex.observe(events, probe);
  assert.equal(observations.some(o => o.type === "command_failed" && o.exit === 126), true, "exit 126 must emit command_failed");
  assert.equal(observations.some(o => o.type === "permission_denied"), false, "exit 126 must never emit permission_denied");
}

// ── 3. Trailing stderr prose alone (without sentinel) must not trigger permission_denied (codex + claude) ──
{
  const proseStderr = "Its required PowerShell prerequisite was attempted directly (permission denied) and through `pwsh` (not installed).";
  for (const [name, driver] of [["codex", codex], ["claude", claude]]) {
    const events = driver.decodeEvents("", proseStderr);
    const observations = driver.observe(events, probe);
    assert.equal(
      observations.some(o => o.type === "permission_denied"),
      false,
      `${name}: model prose on stderr must never emit permission_denied`
    );
  }
}

// ── 4. Valid review or task-result sentinel anywhere overrides permission_denied in classifyObservedFailure ──
{
  const reviewStdout = JSON.stringify({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: 'Done.\nAUTOPILOT_REVIEW={"decision":"FAIL","findings":["issue 1"]}'
    }
  });
  const classifiedReview = classifyObservedFailure({
    exitCode: 0,
    stdout: reviewStdout,
    stderr: "",
    evidence: [{type: "permission_denied"}],
    driverless: false,
    adapter: "codex"
  });
  assert.equal(classifiedReview, null, "valid AUTOPILOT_REVIEW sentinel in stdout must prevent PERMISSION_DENIED");

  const taskOutput = 'Completed task.\nAUTOPILOT_TASK_RESULT={"summary":"done","taskLocalCheck":{"command":"node test.mjs","status":"passed","exitCode":0,"summary":"ok"}}';
  assert.equal(parseTaskResultContract(taskOutput).ok, true, "task-result fixture must be valid");
  const classifiedTask = classifyObservedFailure({
    exitCode: 0,
    stdout: "",
    stderr: "",
    output: taskOutput,
    evidence: [{type: "permission_denied"}],
    driverless: false,
    adapter: "codex"
  });
  assert.equal(classifiedTask, null, "valid AUTOPILOT_TASK_RESULT sentinel in output must prevent PERMISSION_DENIED");

  // OpenCode terminalDenial must also respect AUTOPILOT_TASK_RESULT sentinel anywhere in stream.
  const opencodeEvents = [
    {
      type: "tool_use",
      part: {
        type: "tool",
        tool: "bash",
        state: {
          status: "error",
          error: "Permission denied: blocked by policy",
          input: {command: "cat /outside"}
        }
      }
    },
    {type: "text", part: {type: "text", text: taskOutput}}
  ];
  const ocObs = opencode.observe(opencodeEvents, probe);
  assert.equal(
    ocObs.some(o => o.type === "permission_denied"),
    false,
    "opencode denial accompanied by valid AUTOPILOT_TASK_RESULT sentinel must not emit permission_denied"
  );
}

// ── 5. Real codex sandbox / approval denials still classify as PERMISSION_DENIED ──
{
  // (a) Structured declined command_execution
  const declinedEvents = [
    {
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "touch /outside/output.txt",
        status: "declined",
        exit_code: -1,
        aggregated_output: "blocked by policy"
      }
    }
  ];
  const declinedObs = codex.observe(declinedEvents, probe);
  assert.equal(declinedObs.some(o => o.type === "permission_denied"), true, "real declined codex command must emit permission_denied");
  const declinedFailure = classifyObservedFailure({
    exitCode: 1,
    stdout: "",
    stderr: "",
    evidence: declinedObs,
    driverless: false,
    adapter: "codex"
  });
  assert.equal(declinedFailure?.class, "PERMISSION_DENIED", "real declined codex command must classify PERMISSION_DENIED");
  assert.equal(declinedFailure?.domain, "adapter");
  assert.equal(declinedFailure?.retryable, false);

  // (b) Structured failed command_execution with Read-only file system (sandbox denial)
  const sandboxEvents = [
    {
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "touch /outside/output.txt",
        status: "failed",
        exit_code: 1,
        aggregated_output: "touch: cannot touch '/outside/output.txt': Read-only file system\n"
      }
    }
  ];
  const sandboxObs = codex.observe(sandboxEvents, probe);
  assert.equal(sandboxObs.some(o => o.type === "permission_denied"), true, "real codex sandbox denial must emit permission_denied");
  const sandboxFailure = classifyObservedFailure({
    exitCode: 1,
    stdout: "",
    stderr: "",
    evidence: sandboxObs,
    driverless: false,
    adapter: "codex"
  });
  assert.equal(sandboxFailure?.class, "PERMISSION_DENIED", "real codex sandbox denial must classify PERMISSION_DENIED");

  // (c) Structured codex stderr sandbox rejection (no sentinel)
  const structuredStderrEvents = codex.decodeEvents(
    "",
    "2026-11-20T16:03:22.065572Z ERROR codex_core::sandbox: sandbox execution failed: permission denied\n"
  );
  const structuredStderrObs = codex.observe(structuredStderrEvents, probe);
  assert.equal(
    structuredStderrObs.some(o => o.type === "permission_denied"),
    true,
    "structured codex sandbox stderr rejection must still emit permission_denied"
  );
  const structuredStderrFailure = classifyObservedFailure({
    exitCode: 1,
    stdout: "",
    stderr: "",
    evidence: structuredStderrObs,
    driverless: false,
    adapter: "codex"
  });
  assert.equal(structuredStderrFailure?.class, "PERMISSION_DENIED", "structured codex sandbox stderr rejection must classify PERMISSION_DENIED");
}

console.log("backlog #5 permission-prose regression tests passed");
