#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildReportModel, renderReport, enrichRun } from "./watch-report.mjs";
import { rebuildSummary } from "./watch-summary.mjs";

const failures = [];
const check = (name, cond, detail) => {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.error(`FAIL ${name} :: ${JSON.stringify(detail)}`);
  }
};

const run = (o) => ({ status: "completed", decision: null, findings: [], ...o });

const phases = [
  { number: 1, name: "Phase 1 — Work", done: false, tasks: [{ text: "T1.1", done: false }] },
];

const runs = [
  // 1. review-tasks reviewer
  run({
    id: "01-plan_reviewer-aaaaaaaa",
    dirName: "01-plan_reviewer-aaaaaaaa",
    role: "plan_reviewer",
    taskRef: "speckit-planning-plan_reviewer",
    planningStage: "review-tasks",
    decision: "FAIL",
    findings: ["specs/001-test/tasks.md:501-504: invalid task; specs/001-test/plan.md:645-656: plan drift"],
    started_at: "2026-10-26T09:00:00+00:00",
  }),
  // 2. planner fixing findings citing tasks.md + plan.md
  run({
    id: "02-planner-bbbbbbbb",
    dirName: "02-planner-bbbbbbbb",
    role: "planner",
    taskRef: "speckit-planning-planner",
    planningStage: "tasks",
    planRevision: 1,
    findings: ["specs/001-test/tasks.md:501-504: invalid task; specs/001-test/plan.md:645-656: plan drift"],
    started_at: "2026-10-26T09:05:00+00:00",
  }),
  // 3. planner with no findings info
  run({
    id: "03-planner-cccccccc",
    dirName: "03-planner-cccccccc",
    role: "planner",
    taskRef: "speckit-planning-planner",
    planningStage: "tasks",
    planRevision: 0,
    started_at: "2026-10-26T09:10:00+00:00",
  }),
  // 4. implementer
  run({
    id: "04-implementer-dddddddd",
    dirName: "04-implementer-dddddddd",
    role: "implementer",
    phase: "1",
    attempt: "1",
    taskRef: "T1.1",
    started_at: "2026-10-26T09:20:00+00:00",
  }),
];

const state = {
  mission: "test-task-files",
  phase: "implementing",
  step: "implement",
  phaseIndex: 0,
  attempt: 1,
  planningStartedAt: "2026-10-26T08:55:00+00:00",
  planningDetection: { framework: "speckit" },
  reviewFeedback: {
    "speckit-stage:tasks": {
      findings: ["specs/001-test/tasks.md:501-504: invalid task; specs/001-test/plan.md:645-656: plan drift"],
    },
  },
};

const model = buildReportModel({
  state,
  runs,
  events: [],
  phases,
  policy: { max_plan_revisions: 8 },
  now: "2026-10-26T09:35:00+00:00",
});

const report = renderReport(model, { stamp: "2026-10-26 09:35:00" });

const headers = report.split("\n").filter((line) => line.trim().split(/\s+/)[0] === "ROLE" && line.includes("MODEL"));
check("report has planning and implementation tables", headers.length >= 2, { count: headers.length });

const words = ["ROLE", "MODEL", "TASK", "STATUS", "TURNS", "CONTEXT", "TOKENS", "STARTED", "DURATION", "NOTE"];
const offsets = Object.fromEntries(words.map((w) => [w, headers[0].indexOf(w)]));

function getCell(line, colName) {
  const start = offsets[colName];
  if (start === undefined || start < 0) return "";
  const idx = words.indexOf(colName);
  const nextCol = words[idx + 1];
  const end = nextCol ? offsets[nextCol] : undefined;
  const chunk = end !== undefined ? line.slice(start, end) : line.slice(start);
  return chunk.trim();
}

function findRowByPrefix(prefix) {
  const line = report.split("\n").find((l) => l.trim().startsWith(prefix) || l.trim().startsWith(`› ${prefix}`));
  return line || null;
}

const rowReviewer = findRowByPrefix("01-plan_reviewer");
const reviewerTask = rowReviewer ? getCell(rowReviewer, "TASK") : null;
check("review-tasks reviewer shows spec/plan/tasks", reviewerTask === "spec/plan/tasks", { row: rowReviewer, task: reviewerTask });

const rowPlannerFixing = findRowByPrefix("02-planner");
const plannerFixingTask = rowPlannerFixing ? getCell(rowPlannerFixing, "TASK") : null;
check("planner fixing findings citing tasks.md + plan.md shows plan/tasks", plannerFixingTask === "plan/tasks", { row: rowPlannerFixing, task: plannerFixingTask });

const rowPlannerNoInfo = findRowByPrefix("03-planner");
const plannerNoInfoTask = rowPlannerNoInfo ? getCell(rowPlannerNoInfo, "TASK") : null;
check("planner with no findings info shows stage name", plannerNoInfoTask === "tasks", { row: rowPlannerNoInfo, task: plannerNoInfoTask });

const rowImplementer = findRowByPrefix("04-implementer");
const implementerTask = rowImplementer ? getCell(rowImplementer, "TASK") : null;
check("implementer keeps task id", implementerTask === "T1.1", { row: rowImplementer, task: implementerTask });

// Alignment checks
headers.forEach((header, i) => {
  for (const word of words) {
    check(`header ${i + 1}: ${word} at shared offset`, header.indexOf(word) === offsets[word], {
      header,
      word,
      found: header.indexOf(word),
      expected: offsets[word],
    });
  }
});

const taskWidth = offsets.STATUS - offsets.TASK - 2;
check("TASK column width fits spec/plan/tasks", taskWidth >= "spec/plan/tasks".length, { taskWidth, minNeeded: "spec/plan/tasks".length });

const trailingSpaces = report.split("\n").filter((l) => l !== l.replace(/\s+$/, ""));
check("no trailing spaces", trailingSpaces.length === 0, trailingSpaces);

// Enriched run and summary entry with 25 KB brief fixture: no "brief" key and JSON size < 2 KB
const fixtureRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-brief-fixture-"));
try {
  const missionDir = path.join(fixtureRepo, ".autopilot", "missions", "test-fixture-mission", "runs", "01-planner-11111111");
  fs.mkdirSync(missionDir, { recursive: true });
  const bigPadding = "x".repeat(25 * 1024);
  const briefContent = `SpecKit gate "review-tasks"\n\nThe plan reviewer REJECTED this stage:\n- specs/001-test/tasks.md:501-504: invalid task\n- specs/001-test/plan.md:645-656: plan drift\n\n${bigPadding}\n`;
  fs.writeFileSync(path.join(missionDir, "brief.txt"), briefContent);
  fs.writeFileSync(path.join(missionDir, "status.json"), JSON.stringify({
    status: "completed",
    run_id: "01-planner-11111111",
    role: "planner",
    taskRef: "speckit-planning-planner",
    planningStage: "tasks",
    planRevision: 1,
    started_at: "2026-10-26T09:05:00+00:00",
  }, null, 2));

  // 1. Check enriched run via enrichRun
  const rawRun = {
    id: "01-planner-11111111",
    dir: missionDir,
    role: "planner",
    started_at: "2026-10-26T09:05:00+00:00",
  };
  const enriched = enrichRun(rawRun);
  check("enriched run has no brief key", !("brief" in enriched), { keys: Object.keys(enriched) });
  check("enriched run derived gate", enriched.gate === "review-tasks", enriched.gate);
  check("enriched run derived briefArtifacts", enriched.briefArtifacts === "plan/tasks", enriched.briefArtifacts);

  const enrichedJson = JSON.stringify(enriched);
  const enrichedSize = Buffer.byteLength(enrichedJson, "utf8");
  check("enriched run JSON size is small (< 2 KB for a 25 KB brief)", enrichedSize < 2048, { enrichedSize });
  check("enriched run JSON size is real (> 50 bytes)", enrichedSize > 50, { enrichedSize });

  // 2. Check summary entry via rebuildSummary
  const summary = rebuildSummary(fixtureRepo, "test-fixture-mission");
  const summaryEntry = summary.runs[0];
  check("summary entry has no brief key", !("brief" in summaryEntry), { keys: Object.keys(summaryEntry) });
  const summaryJson = JSON.stringify(summaryEntry);
  const summarySize = Buffer.byteLength(summaryJson, "utf8");
  check("summary entry JSON size is small (< 2 KB for a 25 KB brief)", summarySize < 2048, { summarySize });
  check("summary entry JSON size is real (> 50 bytes)", summarySize > 50, { summarySize });
} finally {
  fs.rmSync(fixtureRepo, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("All task-files checks passed.");
