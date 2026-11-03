import assert from "node:assert/strict";
import {adapterDriver} from "./adapter-drivers.mjs";
import {classifyObservedFailure} from "./failure-contract.mjs";

const root = "/workspace";
const probe = {
  root,
  readPath: `${root}/input.txt`,
  productionWritePath: `${root}/output.txt`,
  outsideWritePath: "/outside/output.txt"
};

const driver = adapterDriver("codex");
assert.ok(driver, "codex adapter driver must be available");

// ── Test (a): exit 126 "Permission denied" then successful command ─────────────
// The role encountered a non-executable script (exit 126), worked around it, and succeeded.
// Must not emit permission_denied observation, and classifyObservedFailure must not return PERMISSION_DENIED.
{
  const events = [
    {
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "/bin/bash -lc 'scripts/check.ps1 -Json'",
        status: "failed",
        exit_code: 126,
        aggregated_output: "/bin/bash: line 1: scripts/check.ps1: Permission denied\n"
      }
    },
    {
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "pwsh -NoProfile -File scripts/check.ps1 -Json",
        status: "completed",
        exit_code: 0,
        aggregated_output: '{"status":"ok"}'
      }
    }
  ];

  const observations = driver.observe(events, probe);
  assert.equal(
    observations.some(o => o.type === "permission_denied"),
    false,
    "recovered bash exec-permission error (exit 126) followed by successful command must not emit permission_denied"
  );

  const classified = classifyObservedFailure({
    exitCode: 0,
    stdout: "",
    stderr: "",
    evidence: observations,
    driverless: false
  });
  assert.notEqual(
    classified?.class,
    "PERMISSION_DENIED",
    "recovered denial followed by success must not classify as PERMISSION_DENIED"
  );
}

// ── Test (b): Sandbox-style denial that is the LAST command ───────────────────
// Terminal denial (e.g. Operation not permitted / Read-only file system) must still emit permission_denied
// and classify as PERMISSION_DENIED.
{
  const events = [
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

  const observations = driver.observe(events, probe);
  assert.equal(
    observations.some(o => o.type === "permission_denied"),
    true,
    "terminal sandbox-style denial must emit permission_denied"
  );

  const classified = classifyObservedFailure({
    exitCode: 1,
    stdout: "",
    stderr: "",
    evidence: observations,
    driverless: false
  });
  assert.equal(
    classified?.class,
    "PERMISSION_DENIED",
    "terminal sandbox-style denial must classify as PERMISSION_DENIED"
  );
}

// ── Test (c): Sandbox-style denial followed by a successful command ───────────
// A sandbox-style denial that the role worked around must not be tagged.
{
  const events = [
    {
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "touch /outside/output.txt",
        status: "failed",
        exit_code: 1,
        aggregated_output: "touch: cannot touch '/outside/output.txt': Read-only file system\n"
      }
    },
    {
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "touch /workspace/scratch/output.txt",
        status: "completed",
        exit_code: 0,
        aggregated_output: ""
      }
    }
  ];

  const observations = driver.observe(events, probe);
  assert.equal(
    observations.some(o => o.type === "permission_denied"),
    false,
    "sandbox-style denial followed by a successful command must not emit permission_denied"
  );
}

// ── Test (d): Terminal bash exec-permission error (exit 126) ───────────────────
// Plain exec-permission error is a command error (command_failed), not permission_denied — even when terminal.
{
  const events = [
    {
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "/bin/bash -lc 'scripts/check.ps1'",
        status: "failed",
        exit_code: 126,
        aggregated_output: "/bin/bash: line 1: scripts/check.ps1: Permission denied\n"
      }
    }
  ];

  const observations = driver.observe(events, probe);
  assert.equal(
    observations.some(o => o.type === "permission_denied"),
    false,
    "bash exec-permission error (exit 126) must not emit permission_denied even when terminal"
  );
  assert.equal(
    observations.some(o => o.type === "command_failed"),
    true,
    "bash exec-permission error (exit 126) must emit command_failed"
  );

  const classified = classifyObservedFailure({
    exitCode: 126,
    stdout: "",
    stderr: "",
    evidence: observations,
    driverless: false
  });
  assert.notEqual(
    classified?.class,
    "PERMISSION_DENIED",
    "terminal bash exit 126 must not classify as PERMISSION_DENIED"
  );
}

// ── Test (e): Denial followed by a review verdict (sentinel token) ────────────
// A denial followed by a valid verdict message is not terminal.
{
  const events = [
    {
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "cat /etc/shadow",
        status: "failed",
        exit_code: 1,
        aggregated_output: "cat: /etc/shadow: Permission denied\n"
      }
    },
    {
      type: "agent_message",
      text: 'AUTOPILOT_REVIEW: {"decision":"FAIL","findings":["could not read file"]}'
    }
  ];

  const observations = driver.observe(events, probe);
  assert.equal(
    observations.some(o => o.type === "permission_denied"),
    false,
    "denial followed by verdict must not emit permission_denied"
  );
}

console.log("codex recovered denial tests passed");
