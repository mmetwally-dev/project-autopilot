#!/usr/bin/env node
// Backlog #3 Part B: WATCH-REPORT shows tests not run in missions in one place only:
// directly under the phase that is currently running in the IMPLEMENTATION STAGE.
import fs from "node:fs";
import path from "node:path";

import { buildReportModel, renderReport } from "./watch-report.mjs";
import { renderWatchReport } from "./run-history.mjs";
import { formatNotRunInMissions } from "./command-probe.mjs";
import { makeFixtureRepo, cleanup } from "./test-fixtures/workflow-order-harness.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures.push(name);
    console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`);
  }
};

const run = (o) => ({ status: "completed", decision: null, findings: [], ...o });

const notRunList = [
  {
    reason: "server not running on :3000",
    files: ["tests/integration/a.test.ts", "tests/integration/b.test.ts"],
    command: "npm run test:integration",
  },
];
const notRunText = formatNotRunInMissions(notRunList);

const phases = [
  { number: 1, name: "Phase 1 — Setup", done: true, tasks: [{ text: "T1.1", done: true }] },
  { number: 2, name: "Phase 2 — Core", done: false, tasks: [{ text: "T2.1", done: false }, { text: "T2.2", done: false }] },
  { number: 3, name: "Phase 3 — Teardown", done: false, tasks: [{ text: "T3.1", done: false }] },
];

const runs = [
  run({ id: "01-implementer-p1", dirName: "01-implementer-p1", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", started_at: "2026-10-31T10:00:00+00:00" }),
  run({ id: "02-verifier-p1", dirName: "02-verifier-p1", role: "verifier", phase: "1", attempt: "1", taskRef: "T1.1", decision: "PASS", started_at: "2026-10-31T10:05:00+00:00" }),
  run({ id: "03-implementer-p2", dirName: "03-implementer-p2", role: "implementer", phase: "2", attempt: "1", taskRef: "T2.1", status: "running", started_at: "2026-10-31T10:10:00+00:00" }),
  run({ id: "04-implementer-p3", dirName: "04-implementer-p3", role: "implementer", phase: "3", attempt: "1", taskRef: "T3.1", started_at: "2026-10-31T10:15:00+00:00" }),
];

// ── (a) running phase 2 of 3 with notRunText ─────────────────────────────────
{
  const modelA = buildReportModel({
    state: { phase: "implementing", step: "implement", phaseIndex: 1, attempt: 1 },
    runs,
    events: [],
    phases,
    policy: { continuation_allowance: 3 },
    notRunText,
    now: "2026-10-31T10:20:00+00:00",
  });
  const reportA = renderReport(modelA);

  const headerNeedle = "Tests not run in missions (run them after the mission):";
  check("a: contains not-run header", reportA.includes(headerNeedle));
  check("a: contains reason", reportA.includes("server not running on :3000"));
  check("a: contains files list", reportA.includes("tests/integration/a.test.ts, tests/integration/b.test.ts"));
  check("a: contains run command", reportA.includes("npm run test:integration"));

  const occurrences = reportA.split(headerNeedle).length - 1;
  check("a: appears exactly once", occurrences === 1, { occurrences });

  const idxPhase1 = reportA.indexOf("Phase 1/3");
  const idxPhase2 = reportA.indexOf("Phase 2/3");
  const idxPhase3 = reportA.indexOf("Phase 3/3");
  const idxNotRun = reportA.indexOf(headerNeedle);
  const idxNext = reportA.indexOf("next:");

  check("a: appears after phase 2 header", idxNotRun > idxPhase2, { idxNotRun, idxPhase2 });
  check("a: appears before phase 3 header", idxNotRun < idxPhase3, { idxNotRun, idxPhase3 });
  if (idxNext !== -1 && idxNext > idxPhase2 && idxNext < idxPhase3) {
    check("a: appears after phase 2 next: line", idxNotRun > idxNext, { idxNotRun, idxNext });
  }

  check("a: indented with four spaces", reportA.includes(`    ${headerNeedle}`));
  check("a: reason line indented with four spaces", reportA.includes("    - server not running on :3000"));
  check("a: files line indented with six spaces", reportA.includes("      files: tests/integration/a.test.ts, tests/integration/b.test.ts"));
  check("a: run line indented with six spaces", reportA.includes("      run: npm run test:integration"));
}

// ── (b) empty notRunText -> no such text anywhere ────────────────────────────
{
  const modelB = buildReportModel({
    state: { phase: "implementing", step: "implement", phaseIndex: 1, attempt: 1 },
    runs,
    events: [],
    phases,
    notRunText: "",
    now: "2026-10-31T10:20:00+00:00",
  });
  const reportB = renderReport(modelB);
  check("b: empty notRunText -> no such text anywhere", !reportB.includes("Tests not run in missions"));

  const modelBDefault = buildReportModel({
    state: { phase: "implementing", step: "implement", phaseIndex: 1, attempt: 1 },
    runs,
    events: [],
    phases,
    now: "2026-10-31T10:20:00+00:00",
  });
  const reportBDefault = renderReport(modelBDefault);
  check("b: default notRunText -> no such text anywhere", !reportBDefault.includes("Tests not run in missions"));
}

// ── (c) mission still planning (no implementation phase running) ─────────────
{
  const modelC = buildReportModel({
    state: { phase: "planning", step: "standalone-plan" },
    runs: [run({ id: "01-planner", dirName: "01-planner", role: "planner", phase: "0", attempt: "0", taskRef: "standalone-planning-planner", status: "running" })],
    events: [],
    phases,
    notRunText,
    now: "2026-10-31T10:20:00+00:00",
  });
  const reportC = renderReport(modelC);
  check("c: mission planning -> no such text anywhere", !reportC.includes("Tests not run in missions"));
}

// ── (d) end-to-end through renderWatchReport (run-history.mjs) ────────────────
{
  const mission = "105-not-run-e2e";
  const repo = makeFixtureRepo("watch-report-not-run");
  try {
    const missionDir = path.join(repo, ".autopilot", "missions", mission);
    const runsDir = path.join(missionDir, "runs");
    const runDir = path.join(runsDir, "01-implementer-p1");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(missionDir, "watch-events.jsonl"), "");
    fs.writeFileSync(
      path.join(runDir, "status.json"),
      JSON.stringify({
        id: "01-implementer-p1",
        run_id: "01-implementer-p1",
        role: "implementer",
        phase: "1",
        attempt: "1",
        taskRef: "T1.1",
        status: "running",
        started_at: "2026-10-31T00:00:00+00:00",
      })
    );
    fs.writeFileSync(
      path.join(repo, ".autopilot", "state.json"),
      JSON.stringify({
        mission,
        phase: "implementing",
        step: "implement",
        phaseIndex: 0,
        attempt: 1,
      }, null, 2)
    );
    fs.writeFileSync(
      path.join(repo, ".autopilot", "config.json"),
      JSON.stringify({
        gates: {
          not_run_in_missions: [
            {
              reason: "needs running redis on :6379",
              files: ["tests/cache.test.ts"],
              command: "npm run test:cache",
            },
          ],
        },
      }, null, 2)
    );
    const phasesD = [
      { number: 1, name: "Phase 1 — Cache feature", done: false, tasks: [{ text: "T1.1", done: false }] },
    ];
    const reportD = renderWatchReport(repo, mission, {
      phases: phasesD,
      now: "2026-10-31T00:01:00+00:00",
      tail: 5,
    });
    check("d: e2e report contains Tests not run in missions header", reportD.includes("Tests not run in missions (run them after the mission):"));
    check("d: e2e report contains reason", reportD.includes("needs running redis on :6379"));
    check("d: e2e report contains files", reportD.includes("tests/cache.test.ts"));
    check("d: e2e report contains run command", reportD.includes("npm run test:cache"));
    const p1Idx = reportD.indexOf("Phase 1/1");
    const notRunIdx = reportD.indexOf("Tests not run in missions (run them after the mission):");
    check("d: appears under running phase 1", notRunIdx > p1Idx, { notRunIdx, p1Idx });
  } finally {
    cleanup(repo);
  }
}

if (failures.length) {
  console.error(`${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("All watch-report not-run checks passed.");
