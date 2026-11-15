#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderWatchReport, resolveMissionPhases } from "./run-history.mjs";

const failures = [];
const check = (name, cond, detail) => {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  }
};

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-standalone-gate-tasks-"));
try {
  const mission = "001-demo";
  const missionDir = path.join(repo, ".autopilot", "missions", mission);
  fs.mkdirSync(missionDir, { recursive: true });
  fs.writeFileSync(
    path.join(missionDir, "TASKS.md"),
    [
      "# Tasks",
      "",
      "## Phase 1: Setup",
      "",
      "- [x] **1.1** First standalone task",
      "- [x] **1.2** Second standalone task",
      "- [x] **1.3** Third standalone task",
      "",
    ].join("\n"),
    "utf8"
  );

  // Also create a SpecKit feature and .specify/feature.json + workflow.yml
  const speckitDir = path.join(repo, "specs", "001-x");
  fs.mkdirSync(speckitDir, { recursive: true });
  fs.writeFileSync(
    path.join(speckitDir, "tasks.md"),
    [
      "# Tasks",
      "",
      "## Phase 1: SpecKit Phase",
      "",
      "- [x] T001 SpecKit first",
      "- [x] T005 SpecKit mid",
      "- [x] T009 SpecKit last",
      "",
    ].join("\n"),
    "utf8"
  );
  fs.mkdirSync(path.join(repo, ".specify", "workflows", "speckit"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".specify", "workflows", "speckit", "workflow.yml"), "name: speckit\n", "utf8");
  fs.writeFileSync(path.join(repo, ".specify", "feature.json"), JSON.stringify({ feature_directory: "specs/001-x" }), "utf8");

  // State belongs to another mission or has no speckit framework for this mission
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
    mission,
    phase: "complete",
  }), "utf8");

  const runDir = path.join(missionDir, "runs", "01-implementer-demo");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
    status: "completed",
    run_id: "00000000-0000-0000-0000-000000000001",
    role: "implementer",
    phase: "1",
    attempt: "1",
    taskRef: "T1.1",
    started_at: "2026-11-14T09:50:00Z",
    finished_at: "2026-11-14T09:55:00Z",
  }), "utf8");

  const resolved = resolveMissionPhases(repo, mission);
  check("resolved phase 1 has 3 standalone tasks", resolved.length === 1 && resolved[0].tasks.length === 3, resolved);

  const report = renderWatchReport(repo, mission, {
    events: [
      { type: "gate_start", phase: 1, command: "npm test", at: "2026-11-14T10:00:00Z" },
      { type: "gate_result", phase: 1, ok: true, durationMs: 5000, at: "2026-11-14T10:00:05Z" },
    ],
    now: "2026-11-14T10:01:00Z",
  });
  const gateLine = report.split("\n").find((l) => l.includes("GATE (orchestrator)"));
  check("phase-1 gate row shows T1.1 > T1.3", gateLine?.includes("T1.1 > T1.3"), gateLine);
  check("phase-1 gate row does not show SpecKit T001/T009", !/T00[1-9]/.test(gateLine || ""), gateLine);
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
