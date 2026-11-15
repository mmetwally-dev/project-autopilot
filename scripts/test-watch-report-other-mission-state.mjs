#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderWatchReport, sameMission } from "./run-history.mjs";

const failures = [];
const check = (name, cond, detail) => {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  }
};

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-other-mission-state-"));
try {
  fs.mkdirSync(path.join(repo, ".autopilot", "missions", "001-old"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".autopilot", "missions", "002-new"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".autopilot", "state.json"),
    JSON.stringify({ mission: "002-new", phase: "idle", step: "idle" }, null, 2),
    "utf8"
  );

  // 1. 001-old log ends with ALL WORK COMPLETE -> COMPLETED + Stage: done
  const oldLog = path.join(repo, ".autopilot", "missions", "001-old", "orchestrator.log");
  fs.writeFileSync(oldLog, "[info] phase 1 finished\nALL WORK COMPLETE — HUMAN COMMIT REQUIRED\n", "utf8");
  const report1 = renderWatchReport(repo, "001-old", { now: "2026-11-14T10:00:00Z" });
  check("001-old ALL WORK COMPLETE -> Status COMPLETED", /Status:\s+COMPLETED/.test(report1), report1.slice(0, 300));
  check("001-old ALL WORK COMPLETE -> Stage done", /Stage:\s+done/.test(report1), report1.slice(0, 300));

  // 2. 001-old log ends with escalation -> ESCALATED
  fs.writeFileSync(oldLog, "[info] verifier failed\nESCALATED — STOP — human intervention required\n", "utf8");
  const report2 = renderWatchReport(repo, "001-old", { now: "2026-11-14T10:00:00Z" });
  check("001-old escalation -> Status ESCALATED", /Status:\s+ESCALATED/.test(report2), report2.slice(0, 300));

  // 3. 001-old log ends with PLANNING COMPLETE -> STOPPED planning done
  fs.writeFileSync(oldLog, "[info] planner finished\nPLANNING COMPLETE\n", "utf8");
  const report3 = renderWatchReport(repo, "001-old", { now: "2026-11-14T10:00:00Z" });
  check("001-old PLANNING COMPLETE -> STOPPED planning done", /Status:\s+STOPPED — planning done/.test(report3), report3.slice(0, 300));

  // 4. 001-old log has generic line -> STOPPED
  fs.writeFileSync(oldLog, "[info] interrupted mid-run\n", "utf8");
  const report4 = renderWatchReport(repo, "001-old", { now: "2026-11-14T10:00:00Z" });
  check("001-old generic log -> Status STOPPED", /Status:\s+STOPPED/.test(report4), report4.slice(0, 300));

  // 5. 002-new still uses live state.json (phase idle -> STOPPED)
  const reportNew = renderWatchReport(repo, "002-new", { now: "2026-11-14T10:00:00Z" });
  check("002-new live idle state -> Status STOPPED", /Status:\s+STOPPED/.test(reportNew), reportNew.slice(0, 300));

  // 6. Renamed live mission (same numeric prefix) uses live state, not derived from log
  fs.mkdirSync(path.join(repo, ".autopilot", "missions", "002-old-name"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".autopilot", "missions", "002-new-name"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".autopilot", "state.json"),
    JSON.stringify({ mission: "002-new-name", phase: "idle", step: "idle" }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(repo, ".autopilot", "missions", "002-old-name", "orchestrator.log"),
    "[info] phase 1 finished\nALL WORK COMPLETE — HUMAN COMMIT REQUIRED\n",
    "utf8"
  );
  const reportRenamedOld = renderWatchReport(repo, "002-old-name", { now: "2026-11-14T10:00:00Z" });
  const reportRenamedNew = renderWatchReport(repo, "002-new-name", { now: "2026-11-14T10:00:00Z" });
  check("002-old-name with 002-new-name live idle state -> Status STOPPED", /Status:\s+STOPPED/.test(reportRenamedOld), reportRenamedOld.slice(0, 300));
  check("002-old-name does not derive COMPLETED from log", !/Status:\s+COMPLETED/.test(reportRenamedOld), reportRenamedOld.slice(0, 300));
  check("002-new-name live idle state -> Status STOPPED", /Status:\s+STOPPED/.test(reportRenamedNew), reportRenamedNew.slice(0, 300));

  // 7. Unit checks for sameMission
  check('sameMission("006-a", "006-b") === true', sameMission("006-a", "006-b") === true);
  check('sameMission("006-a", "007-a") === false', sameMission("006-a", "007-a") === false);
  check('sameMission("abc", "abc") === true', sameMission("abc", "abc") === true);
  check('sameMission("abc", "006-abc") === false', sameMission("abc", "006-abc") === false);
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
