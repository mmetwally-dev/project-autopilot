#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyStatus } from "./watch-report.mjs";
import { renderWatchReport } from "./run-history.mjs";

const failures = [];
const check = (name, cond, detail) => {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  }
};

// 1. state phase "planning" + operatorEvents [stop, reset] + runs all ended/interrupted → STOPPED
{
  const res = classifyStatus(
    { phase: "planning" },
    {
      operatorEvents: [
        { type: "operator", reason: "stop", at: "2026-11-04T04:00:00Z" },
        { type: "operator", reason: "reset", at: "2026-11-04T04:05:00Z" },
      ],
      runs: [
        { id: "01", status: "interrupted", started_at: "2026-11-04T03:50:00Z" },
      ],
    }
  );
  check(
    "state phase planning + operatorEvents [stop, reset] + runs all ended/interrupted -> STOPPED",
    res.status === "STOPPED",
    res.status
  );
}

// 2. same + a run started after the stop and live → RUNNING
{
  const res = classifyStatus(
    { phase: "planning" },
    {
      operatorEvents: [
        { type: "operator", reason: "stop", at: "2026-11-04T04:00:00Z" },
        { type: "operator", reason: "reset", at: "2026-11-04T04:05:00Z" },
      ],
      runs: [
        { id: "01", status: "interrupted", started_at: "2026-11-04T03:50:00Z" },
        { id: "02", status: "running", pid: 12345, started_at: "2026-11-04T04:10:00Z" },
      ],
      isAlive: (pid) => pid === 12345,
    }
  );
  check(
    "same + a run started after the stop and live -> RUNNING",
    res.status === "RUNNING",
    res.status
  );
}

// 3. ownerAlive true → RUNNING
{
  const res = classifyStatus(
    { phase: "planning" },
    {
      ownerAlive: true,
      operatorEvents: [
        { type: "operator", reason: "stop", at: "2026-11-04T04:00:00Z" },
        { type: "operator", reason: "reset", at: "2026-11-04T04:05:00Z" },
      ],
      runs: [
        { id: "01", status: "interrupted", started_at: "2026-11-04T03:50:00Z" },
      ],
    }
  );
  check(
    "ownerAlive true -> RUNNING",
    res.status === "RUNNING",
    res.status
  );
}

// 4. renderWatchReport on a fixture mission dir after stop → "Status:  STOPPED"
{
  const fixtureRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-stop-watch-"));
  try {
    const mission = "fixture-mission";
    const missionDir = path.join(fixtureRepo, ".autopilot", "missions", mission);
    const runsDir = path.join(missionDir, "runs", "01-planner-11111111");
    fs.mkdirSync(runsDir, { recursive: true });

    fs.writeFileSync(
      path.join(fixtureRepo, ".autopilot", "state.json"),
      JSON.stringify({ mission, phase: "planning", step: "plan" })
    );

    fs.writeFileSync(
      path.join(runsDir, "status.json"),
      JSON.stringify({
        id: "11111111",
        role: "planner",
        status: "interrupted",
        started_at: "2026-11-04T04:00:00Z",
      })
    );

    fs.writeFileSync(
      path.join(missionDir, "watch-events.jsonl"),
      JSON.stringify({ type: "operator", reason: "stop", at: "2026-11-04T04:01:00Z" }) + "\n" +
      JSON.stringify({ type: "operator", reason: "reset", at: "2026-11-04T04:02:00Z" }) + "\n"
    );

    const report = renderWatchReport(fixtureRepo, mission);
    const statusLine = report.split("\n").find((l) => l.startsWith("Status:"));
    check(
      'renderWatchReport on a fixture mission dir after stop -> "Status:  STOPPED"',
      statusLine !== undefined && statusLine.includes("Status:  STOPPED"),
      statusLine
    );
  } finally {
    fs.rmSync(fixtureRepo, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error(`${failures.length} test(s) failed`);
  process.exit(1);
} else {
  console.log("All test-watch-report-stopped checks passed");
}
