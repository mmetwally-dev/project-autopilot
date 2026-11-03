// Task #6: WATCH-REPORT after a resume: a dead run still shows RUNNING
// and the header keeps the old ESCALATED status.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

import {
  displayStatus,
  displayStatusLabel,
  renderWatchReport,
  readRunMeta,
} from "./run-history.mjs";
import {
  classifyStatus,
} from "./watch-report.mjs";
import {
  recordLaunchFailure,
} from "./autopilot.mjs";

console.log("Running test-resume-dead-run-display...");

// (1) runs dir with 100 (running, pid null, no result) + 101 (running, live pid = process.pid)
// -> 100 renders INTERRUPTED/FAILED, 101 RUNNING.
// Never two RUNNING rows when only one process exists.
{
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-test-dead-run-"));
  const missionName = "002-test-mission";
  const missionDir = path.join(tmpRepo, ".autopilot", "missions", missionName);
  const runsDir = path.join(missionDir, "runs");
  fs.mkdirSync(runsDir, { recursive: true });

  const run100Dir = path.join(runsDir, "100-plan_reviewer-aaaaaaaa");
  const run101Dir = path.join(runsDir, "101-plan_reviewer-bbbbbbbb");
  fs.mkdirSync(run100Dir, { recursive: true });
  fs.mkdirSync(run101Dir, { recursive: true });

  // Run 100: died before launch, status "running", pid null, no result.json
  fs.writeFileSync(
    path.join(run100Dir, "status.json"),
    JSON.stringify({
      id: "aaaaaaaa",
      run_id: "aaaaaaaa",
      role: "plan_reviewer",
      status: "running",
      pid: null,
      started_at: "2026-11-03T10:00:00+00:00",
      updated_at: "2026-11-03T10:00:00+00:00",
      planningStage: "tasks",
    }, null, 2)
  );

  // Run 101: live run, status "running", live pid = process.pid
  fs.writeFileSync(
    path.join(run101Dir, "status.json"),
    JSON.stringify({
      id: "bbbbbbbb",
      run_id: "bbbbbbbb",
      role: "plan_reviewer",
      status: "running",
      pid: process.pid,
      started_at: "2026-11-03T10:05:00+00:00",
      updated_at: "2026-11-03T10:05:00+00:00",
      planningStage: "tasks",
    }, null, 2)
  );

  // Mission state and config
  fs.writeFileSync(
    path.join(tmpRepo, ".autopilot", "state.json"),
    JSON.stringify({
      mission: missionName,
      phase: "planning",
      step: "review-tasks",
      planningStartedAt: "2026-11-03T10:00:00+00:00",
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(tmpRepo, ".autopilot", "owner.pid"),
    JSON.stringify({ pid: process.pid })
  );
  fs.writeFileSync(
    path.join(tmpRepo, ".autopilot", "config.json"),
    JSON.stringify({ project: { planning_framework: "speckit" } }, null, 2)
  );

  const report = renderWatchReport(tmpRepo, missionName, {
    isOwnerAlive: () => true,
    isAlive: (p) => p === process.pid,
  });

  const lines = report.split("\n");
  const row100 = lines.find((l) => l.includes("100-plan_reviewer"));
  const row101 = lines.find((l) => l.includes("101-plan_reviewer"));

  assert.ok(row100, `row 100 must exist in report:\n${report}`);
  assert.ok(row101, `row 101 must exist in report:\n${report}`);

  // 100 must NOT be RUNNING; it must be INTERRUPTED or FAILED
  assert.ok(
    !/\bRUNNING\b/.test(row100),
    `row 100 must not render RUNNING when a newer run exists, got:\n${row100}`
  );
  assert.ok(
    /\bINTERRUPTED\b|\bFAILED\b/.test(row100),
    `row 100 must render INTERRUPTED or FAILED, got:\n${row100}`
  );

  // 101 must be RUNNING with marker ›
  assert.ok(
    /\bRUNNING\b/.test(row101),
    `row 101 must render RUNNING, got:\n${row101}`
  );
  assert.ok(
    row101.includes("›"),
    `row 101 must have active marker ›, got:\n${row101}`
  );
  assert.ok(
    !row100.includes("›"),
    `row 100 must NOT have active marker ›, got:\n${row100}`
  );

  // Now test variant where run 100 recorded an error -> renders FAILED with error in NOTE
  fs.writeFileSync(
    path.join(run100Dir, "status.json"),
    JSON.stringify({
      id: "aaaaaaaa",
      run_id: "aaaaaaaa",
      role: "plan_reviewer",
      status: "running",
      pid: null,
      started_at: "2026-11-03T10:00:00+00:00",
      updated_at: "2026-11-03T10:00:00+00:00",
      planningStage: "tasks",
      failure_reason: "READ_ONLY_CONTAINMENT_UNAVAILABLE: bubblewrap missing",
      note: "READ_ONLY_CONTAINMENT_UNAVAILABLE: bubblewrap missing",
    }, null, 2)
  );

  const reportWithError = renderWatchReport(tmpRepo, missionName, {
    isOwnerAlive: () => true,
    isAlive: (p) => p === process.pid,
  });
  const row100WithError = reportWithError.split("\n").find((l) => l.includes("100-plan_reviewer"));
  assert.ok(row100WithError, "row 100 with error must exist");
  assert.ok(
    /\bFAILED\b/.test(row100WithError),
    `row 100 with error recorded must render FAILED, got:\n${row100WithError}`
  );
  assert.ok(
    row100WithError.includes("READ_ONLY_CONTAINMENT_UNAVAILABLE"),
    `row 100 NOTE must contain recorded error, got:\n${row100WithError}`
  );

  fs.rmSync(tmpRepo, { recursive: true, force: true });
  console.log("PASS (1) dead run 100 renders INTERRUPTED/FAILED while 101 is RUNNING");
}

// (2) denied launch -> terminal status.json only, NO result.json, rendered as FAILED
{
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-test-denied-launch-"));
  const missionName = "m1";
  const runDir = path.join(tmpRepo, ".autopilot", "missions", missionName, "runs", "100-plan_reviewer-aaaaaaaa");
  fs.mkdirSync(runDir, { recursive: true });

  // Initially status.json is written as "running" with pid null before spawn
  fs.writeFileSync(
    path.join(runDir, "status.json"),
    JSON.stringify({
      status: "running",
      pid: null,
      role: "plan_reviewer",
      started_at: "2026-11-03T10:00:00+00:00",
      updated_at: "2026-11-03T10:00:00+00:00",
    }, null, 2)
  );

  const denialReason = "READ_ONLY_CONTAINMENT_UNAVAILABLE: adapter_runtime_file_missing (bwrap)";
  const recorded = recordLaunchFailure(runDir, denialReason, {
    id: "aaaaaaaa",
    role: "plan_reviewer",
    meta: { taskRef: "tasks", phase: "planning", attempt: 1 },
  });

  assert.equal(recorded, true, "recordLaunchFailure should succeed");

  const status = JSON.parse(fs.readFileSync(path.join(runDir, "status.json"), "utf8"));
  assert.equal(status.status, "failed", "status.json must be terminal 'failed', not 'running'");
  assert.equal(status.last_action, "launch_denied", "status.json must record last_action 'launch_denied'");
  assert.ok(
    status.note && status.note.includes("READ_ONLY_CONTAINMENT_UNAVAILABLE"),
    `status.json must record denial note, got: ${status.note}`
  );
  assert.ok(
    status.failure_reason && status.failure_reason.includes("READ_ONLY_CONTAINMENT_UNAVAILABLE"),
    `status.json must record failure_reason, got: ${status.failure_reason}`
  );

  // result.json must NOT exist (role subprocess was never launched)
  assert.equal(
    fs.existsSync(path.join(runDir, "result.json")),
    false,
    "result.json must NOT be written for denied launch (subprocess never launched)"
  );

  // Renderer check: readRunMeta and renderWatchReport show FAILED with denial reason
  const meta = readRunMeta(runDir, "100-plan_reviewer-aaaaaaaa");
  assert.equal(meta.status, "failed", "readRunMeta must report status 'failed'");
  assert.ok(
    meta.note && meta.note.includes("READ_ONLY_CONTAINMENT_UNAVAILABLE"),
    `readRunMeta must expose denial reason in note: ${meta.note}`
  );

  fs.writeFileSync(
    path.join(tmpRepo, ".autopilot", "state.json"),
    JSON.stringify({
      mission: missionName,
      phase: "planning",
      step: "review-tasks",
      planningStartedAt: "2026-11-03T10:00:00+00:00",
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(tmpRepo, ".autopilot", "config.json"),
    JSON.stringify({ project: { planning_framework: "speckit" } }, null, 2)
  );

  const report = renderWatchReport(tmpRepo, missionName, {
    isOwnerAlive: () => false,
  });
  const row = report.split("\n").find((l) => l.includes("100-plan_reviewer"));
  assert.ok(row, `report must include 100-plan_reviewer row:\n${report}`);
  assert.ok(
    /\bFAILED\b/.test(row),
    `row must render status FAILED, got:\n${row}`
  );
  assert.ok(
    row.includes("READ_ONLY_CONTAINMENT_UNAVAILABLE"),
    `row NOTE must include denial reason, got:\n${row}`
  );

  fs.rmSync(tmpRepo, { recursive: true, force: true });
  console.log("PASS (2) denied launch writes terminal status.json, result.json absent, rendered FAILED");
}

// (3) display rule: classifyStatus treats state.phase "escalated" as RUNNING
// when orchestrator owner is alive AND a run newer than state.updatedAt is running (live pid)
{
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-test-resume-escalated-"));
  const missionName = "002-test-mission";
  const missionDir = path.join(tmpRepo, ".autopilot", "missions", missionName);
  const runsDir = path.join(missionDir, "runs");
  fs.mkdirSync(runsDir, { recursive: true });

  const statePath = path.join(tmpRepo, ".autopilot", "state.json");
  const escalatedState = {
    mission: missionName,
    phase: "escalated",
    step: "review-tasks",
    planningStepIndex: 2,
    updatedAt: "2026-11-03T10:00:00+00:00",
    lastFailure: {
      domain: "orchestrator",
      class: "INTERNAL_CONTRACT_ERROR",
      message: "Attempt failed without a classified cause",
    },
    lastFailureBudget: { budget: "adapterRetryBudget", scope: "plan_reviewer" },
    relayPolicyViolation: null,
  };
  fs.writeFileSync(statePath, JSON.stringify(escalatedState, null, 2));

  fs.writeFileSync(
    path.join(tmpRepo, ".autopilot", "config.json"),
    JSON.stringify({ project: { planning_framework: "speckit" } }, null, 2)
  );

  // Run 101: started AFTER state.updatedAt (10:05 > 10:00), status running, live pid
  const run101Dir = path.join(runsDir, "101-plan_reviewer-bbbbbbbb");
  fs.mkdirSync(run101Dir, { recursive: true });
  fs.writeFileSync(
    path.join(run101Dir, "status.json"),
    JSON.stringify({
      id: "bbbbbbbb",
      run_id: "bbbbbbbb",
      role: "plan_reviewer",
      status: "running",
      pid: process.pid,
      started_at: "2026-11-03T10:05:00+00:00",
      updated_at: "2026-11-03T10:05:00+00:00",
      planningStage: "tasks",
    }, null, 2)
  );

  // Owner PID is alive
  fs.writeFileSync(
    path.join(tmpRepo, ".autopilot", "owner.pid"),
    JSON.stringify({ pid: process.pid })
  );

  // When owner is alive and run 101 is newer than state.updatedAt and running:
  // Watch report header must show Status: RUNNING, not ESCALATED
  const reportRunning = renderWatchReport(tmpRepo, missionName, {
    isOwnerAlive: () => true,
    isAlive: (p) => p === process.pid,
  });

  assert.ok(
    !reportRunning.includes("Status:  ESCALATED"),
    `Header must not show ESCALATED when resumed run is live, got:\n${reportRunning}`
  );
  assert.ok(
    reportRunning.includes("Status:  RUNNING"),
    `Header must show Status: RUNNING when resumed run is live, got:\n${reportRunning}`
  );

  // Unit-level classifyStatus check:
  const run101Meta = {
    dir: run101Dir,
    status: "running",
    pid: process.pid,
    started_at: "2026-11-03T10:05:00+00:00",
  };
  const classifiedRunning = classifyStatus(escalatedState, {
    runs: [run101Meta],
    ownerAlive: true,
    isAlive: (p) => p === process.pid,
  });
  assert.equal(classifiedRunning.status, "RUNNING", "classifyStatus must return RUNNING when owner alive and run newer");
  assert.equal(classifiedRunning.humanRequired, false, "humanRequired must be false when running");

  // When owner is dead: classifyStatus treats as ESCALATED
  const classifiedOwnerDead = classifyStatus(escalatedState, {
    runs: [run101Meta],
    ownerAlive: false,
    isAlive: (p) => p === process.pid,
  });
  assert.equal(classifiedOwnerDead.status, "ESCALATED", "classifyStatus must return ESCALATED when owner is dead");

  // When the run is NOT newer than state.updatedAt: classifyStatus treats as ESCALATED
  const runOldMeta = {
    dir: run101Dir,
    status: "running",
    pid: process.pid,
    started_at: "2026-11-03T09:55:00+00:00",
  };
  const classifiedOldRun = classifyStatus(escalatedState, {
    runs: [runOldMeta],
    ownerAlive: true,
    isAlive: (p) => p === process.pid,
  });
  assert.equal(classifiedOldRun.status, "ESCALATED", "classifyStatus must return ESCALATED when run is older than state.updatedAt");

  fs.rmSync(tmpRepo, { recursive: true, force: true });
  console.log("PASS (3) classifyStatus treats state.phase escalated as RUNNING when owner alive and newer run live");
}

console.log("ALL CHECKS PASSED");
