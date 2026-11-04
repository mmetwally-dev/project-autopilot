#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  planningOnlyDone,
  classifyStatus,
  classifyStage,
} from "./watch-report.mjs";
import {
  writeWatchReportFile,
  renderWatchReport,
} from "./run-history.mjs";

let failed = 0;
let passed = 0;
function check(name, condition, evidence) {
  if (condition) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(evidence)}` : ""}`);
  }
}

const skillRoot = path.dirname(fileURLToPath(import.meta.url));

// ── Case 1 & 2 directly: classifyStatus / planningOnlyDone / classifyStage ───

// Case 1: tasks_ready + stopAfter planning + an old implementer run older than the last planner run
// Expected: STOPPED, stage PLANNING
{
  const statePlanningDone = {
    mission: "mission-plan-done",
    phase: "tasks_ready",
    step: "tasks_ready",
    command: { name: "plan", stopAfter: "planning" },
  };

  const runsOldImpl = [
    {
      id: "run-01",
      role: "implementer",
      status: "interrupted",
      started_at: "2026-11-01T10:00:00.000Z",
    },
    {
      id: "run-02",
      role: "planner",
      status: "completed",
      started_at: "2026-11-04T17:00:00.000Z",
    },
  ];

  const planDone = planningOnlyDone(statePlanningDone, runsOldImpl);
  check(
    "planningOnlyDone ignores implementer runs older than latest planner run",
    planDone === true,
    planDone
  );

  const statusInfo = classifyStatus(statePlanningDone, {
    runs: runsOldImpl,
    ownerAlive: true,
  });
  check(
    "classifyStatus with old implementer run returns STOPPED (even when ownerAlive is true)",
    statusInfo.status === "STOPPED" && statusInfo.planningOnlyDone === true,
    statusInfo
  );

  const planningModel = { status: "passed", runs: [runsOldImpl[1]] };
  const phasesModel = [];
  const finalReviewModel = { status: "not_started", runs: [] };
  const stage = classifyStage(
    statePlanningDone,
    planningModel,
    phasesModel,
    finalReviewModel,
    runsOldImpl
  );
  check(
    "classifyStage with old implementer run returns PLANNING",
    stage === "PLANNING",
    stage
  );
}

// Case 2: an implementer run newer than the last planning run → unchanged behavior
// Expected: planningOnlyDone is false, classifyStatus is RUNNING (when owner alive), stage IMPLEMENTATION
{
  const statePlanningDone = {
    mission: "mission-impl-active",
    phase: "tasks_ready",
    step: "tasks_ready",
    command: { name: "plan", stopAfter: "planning" },
  };

  const runsNewImpl = [
    {
      id: "run-01",
      role: "planner",
      status: "completed",
      started_at: "2026-11-04T17:00:00.000Z",
    },
    {
      id: "run-02",
      role: "implementer",
      status: "running",
      started_at: "2026-11-04T18:00:00.000Z",
    },
  ];

  const planDone = planningOnlyDone(statePlanningDone, runsNewImpl);
  check(
    "planningOnlyDone does not ignore implementer run newer than latest planner run",
    planDone === false,
    planDone
  );

  const statusInfoLive = classifyStatus(statePlanningDone, {
    runs: runsNewImpl,
    ownerAlive: true,
  });
  check(
    "classifyStatus with newer implementer run retains RUNNING when owner is alive",
    statusInfoLive.status === "RUNNING" && statusInfoLive.planningOnlyDone === false,
    statusInfoLive
  );

  const statusInfoDead = classifyStatus(statePlanningDone, {
    runs: runsNewImpl,
    ownerAlive: false,
  });
  check(
    "classifyStatus with newer implementer run retains STOPPED when owner is dead",
    statusInfoDead.status === "STOPPED" && statusInfoDead.planningOnlyDone === false,
    statusInfoDead
  );

  const planningModel = { status: "passed", runs: [runsNewImpl[0]] };
  const phasesModel = [{ runs: [runsNewImpl[1]] }];
  const finalReviewModel = { status: "not_started", runs: [] };
  const stage = classifyStage(
    statePlanningDone,
    planningModel,
    phasesModel,
    finalReviewModel,
    runsNewImpl
  );
  check(
    "classifyStage with newer implementer run returns IMPLEMENTATION",
    stage === "IMPLEMENTATION",
    stage
  );
}

// ── Case 3: exit-path render with a live own pid → not RUNNING ───────────────
// When the exit hook fires, ownerAlive is set to false (via shuttingDown=true).
// Even if owner.pid matches the live process PID, the report rendered on the exit
// path must NOT report Status: RUNNING.
{
  const fixtureRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-exit-render-"));
  try {
    const mission = "001-exit-render-test";
    const missionDir = path.join(fixtureRepo, ".autopilot", "missions", mission);
    const runDir = path.join(missionDir, "runs", "01-implementer-11111111");
    fs.mkdirSync(runDir, { recursive: true });

    // Live owner PID recorded on disk (points to this running node process)
    fs.writeFileSync(
      path.join(fixtureRepo, ".autopilot", "owner.pid"),
      `${process.pid}\n`
    );

    // Mission state is implementing (which would normally show RUNNING if owner was alive)
    fs.writeFileSync(
      path.join(fixtureRepo, ".autopilot", "state.json"),
      JSON.stringify({
        mission,
        phase: "implementing",
        step: "implement",
      })
    );

    fs.writeFileSync(
      path.join(runDir, "status.json"),
      JSON.stringify({
        id: "11111111",
        role: "implementer",
        status: "running",
        started_at: "2026-11-04T18:00:00.000Z",
      })
    );

    // 1. Without the exit-path fix (ownerAlive undefined / true), the live PID would show RUNNING:
    const liveReport = renderWatchReport(fixtureRepo, mission);
    const liveStatusLine = liveReport.split("\n").find((l) => l.startsWith("Status:"));
    check(
      "baseline: default render with live PID on disk produces RUNNING",
      liveStatusLine !== undefined && liveStatusLine.includes("RUNNING"),
      liveStatusLine
    );

    // 2. On the exit path, shuttingDown=true causes ownerAlive: false to be passed:
    const exitOutFile = writeWatchReportFile(fixtureRepo, mission, { ownerAlive: false });
    const exitReport = fs.readFileSync(exitOutFile, "utf8");
    const exitStatusLine = exitReport.split("\n").find((l) => l.startsWith("Status:"));
    check(
      "exit-path render with live own pid produces STOPPED (not RUNNING)",
      exitStatusLine !== undefined && exitStatusLine.includes("STOPPED") && !exitStatusLine.includes("RUNNING"),
      exitStatusLine
    );

    // Direct classifyStatus verification of the exit flag:
    const exitStatus = classifyStatus(
      { phase: "implementing" },
      { ownerAlive: false }
    );
    check(
      "classifyStatus on exit path (ownerAlive=false) is STOPPED and not RUNNING",
      exitStatus.status === "STOPPED",
      exitStatus.status
    );
  } finally {
    fs.rmSync(fixtureRepo, { recursive: true, force: true });
  }
}

// ── Behavioral test of the exit hook in a real exiting node subprocess ────────
{
  const fixtureRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-exit-behavior-"));
  try {
    const mission = "002-exit-behavior-test";
    const missionDir = path.join(fixtureRepo, ".autopilot", "missions", mission);
    fs.mkdirSync(missionDir, { recursive: true });

    fs.writeFileSync(
      path.join(fixtureRepo, ".autopilot", "state.json"),
      JSON.stringify({
        mission,
        phase: "tasks_ready",
        command: { name: "plan", stopAfter: "planning" },
      })
    );

    // Spawn a subprocess that writes its own PID to owner.pid and exits with the exit hook installed
    const script = `
      import fs from "node:fs";
      import path from "node:path";
      import { writeWatchReportFile } from ${JSON.stringify(path.join(skillRoot, "run-history.mjs"))};

      const repo = ${JSON.stringify(fixtureRepo)};
      const mission = ${JSON.stringify(mission)};
      fs.writeFileSync(path.join(repo, ".autopilot", "owner.pid"), String(process.pid) + "\\n");

      let shuttingDown = false;
      const activeRelayState = { mission, phase: "tasks_ready", command: { name: "plan", stopAfter: "planning" } };
      function refreshWatchReport(s, opts = {}) {
        const o = (shuttingDown && opts.ownerAlive === undefined) ? { ...opts, ownerAlive: false } : opts;
        writeWatchReportFile(repo, s.mission, o);
      }

      // Exact exit hook pattern as in autopilot.mjs:2298:
      process.on("exit", () => {
        shuttingDown = true;
        if (activeRelayState) refreshWatchReport(activeRelayState);
      });
      process.exit(0);
    `;

    const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: fixtureRepo,
      encoding: "utf8",
    });

    check("behavioral exit subprocess exited 0", res.status === 0, res.stderr);

    const reportPath = path.join(missionDir, "WATCH-REPORT.md");
    check("behavioral exit subprocess wrote WATCH-REPORT.md", fs.existsSync(reportPath));

    if (fs.existsSync(reportPath)) {
      const content = fs.readFileSync(reportPath, "utf8");
      const statusLine = content.split("\n").find((l) => l.startsWith("Status:"));
      check(
        "behavioral exit render produces STOPPED, not RUNNING",
        statusLine !== undefined && statusLine.includes("STOPPED") && !statusLine.includes("RUNNING"),
        statusLine
      );
    }
  } finally {
    fs.rmSync(fixtureRepo, { recursive: true, force: true });
  }
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${passed} test-watch-report-plan-done-exit checks passed.`);
