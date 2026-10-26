#!/usr/bin/env node
// Backlog #23: one set of column widths for the whole WATCH-REPORT, so a
// planner-only round and a later round holding a plan_reviewer (and an
// implementation phase with code_reviewer/verifier rows) line up.
import { buildReportModel, renderReport } from "./watch-report.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
};

const run = (o) => ({ status: "completed", decision: null, findings: [], ...o });

const phases = [
  { number: 1, name: "Phase 1 — Work", done: false, tasks: [{ text: "T1.1", done: true }, { text: "T1.2", done: false }] },
];
const runs = [
  run({ id: "01-planner-aaaaaaaa", dirName: "01-planner-aaaaaaaa", role: "planner", phase: "1", attempt: "0", taskRef: "standalone-planning-planner", planRevision: 0, resolvedModel: "muse-spark-1.3", duration: "00:01:00", started_at: "2026-10-26T09:00:00+00:00" }),
  run({ id: "02-planner-bbbbbbbb", dirName: "02-planner-bbbbbbbb", role: "planner", phase: "1", attempt: "0", taskRef: "standalone-planning-planner", planRevision: 1, resolvedModel: "muse-spark-1.3", duration: "00:01:00", started_at: "2026-10-26T09:05:00+00:00" }),
  run({ id: "03-plan_reviewer-cccccccc", dirName: "03-plan_reviewer-cccccccc", role: "plan_reviewer", phase: "1", attempt: "0", taskRef: "standalone-planning-plan_reviewer", planRevision: 1, decision: "PASS", resolvedModel: "opus-5.5", duration: "00:01:00", started_at: "2026-10-26T09:10:00+00:00" }),
  run({ id: "04-implementer-dddddddd", dirName: "04-implementer-dddddddd", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", resolvedModel: "muse-spark-1.3", duration: "00:01:00", started_at: "2026-10-26T09:20:00+00:00" }),
  run({ id: "05-code_reviewer-eeeeeeee", dirName: "05-code_reviewer-eeeeeeee", role: "code_reviewer", phase: "1", attempt: "1", taskRef: "T1.1 > T1.2", decision: "PASS", resolvedModel: "opus-5.5", duration: "00:01:00", started_at: "2026-10-26T09:25:00+00:00" }),
  run({ id: "06-verifier-ffffffff", dirName: "06-verifier-ffffffff", role: "verifier", phase: "1", attempt: "1", taskRef: "T1.1 > T1.2", decision: "PASS", resolvedModel: "nemotron-3", duration: "00:01:00", started_at: "2026-10-26T09:30:00+00:00" }),
];
const state = {
  mission: "100-column-widths", phase: "implementing", step: "implement", phaseIndex: 0, attempt: 1,
  planningStartedAt: "2026-10-26T08:55:00+00:00", planningDetection: { framework: "standalone" },
};
const model = buildReportModel({ state, runs, events: [], phases, policy: { max_plan_revisions: 8 }, now: "2026-10-26T09:35:00+00:00" });
const report = renderReport(model, { stamp: "2026-10-26 09:35:00" });

const headers = report.split("\n").filter((line) => line.trim().split(/\s+/)[0] === "ROLE" && line.includes("MODEL"));
check("report has the planning and implementation tables", headers.length >= 2, report);
check("planning round 1 is planner-only", !model.planning.rounds[0].runs.some((r) => r.role === "plan_reviewer"), model.planning.rounds[0].runs.map((r) => r.role));
check("a later round holds the plan_reviewer", model.planning.rounds.slice(1).some((round) => round.runs.some((r) => r.role === "plan_reviewer")), model.planning.rounds.map((round) => round.runs.map((r) => r.role)));

const words = ["ROLE", "MODEL", "TASK", "STATUS", "DURATION", "SNAPSHOT", "PRICE", "CONTEXT", "TURNS", "STARTED", "NOTE"];
const expected = Object.fromEntries(words.map((word) => [word, headers[0].indexOf(word)]));
headers.forEach((header, i) => {
  for (const word of words) {
    check(`header ${i + 1}: ${word} at the shared offset`, header.indexOf(word) === expected[word], { header, word, found: header.indexOf(word), expected: expected[word] });
  }
});

const roleWidth = expected.MODEL - expected.ROLE - 2;
check("ROLE column is at least 25 wide", roleWidth >= 25, { roleWidth, header: headers[0] });
check("STATUS column fits the longest status word", expected.DURATION - expected.STATUS - 2 >= "INTERRUPTED".length, { statusWidth: expected.DURATION - expected.STATUS - 2, header: headers[0] });
check("no trailing spaces", report.split("\n").every((line) => line === line.replace(/\s+$/, "")), report.split("\n").find((line) => line !== line.replace(/\s+$/, "")));

if (failures.length) { console.error(`${failures.length} column-width check(s) failed.`); process.exit(1); }
console.log("All column-width checks passed.");
