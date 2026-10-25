#!/usr/bin/env node
// Task 1.7: a mission with workflow.final_review=false reports the final review
// as skipped in the watch-report model and keeps the FINAL REVIEW stage.
import { buildReportModel } from "./watch-report.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
};

const phases = [{ number: 1, name: "Phase 1 — Work", done: true, tasks: [{ text: "T1.1", done: true }] }];
const state = { mission: "098-implement-backlog-items", phase: "complete", step: "complete", phaseIndex: 0 };

// Marked mission: the final review was explicitly skipped by the workflow switch.
{
  const model = buildReportModel({ state: { ...state, finalReviewSkipped: true }, runs: [], events: [], phases, policy: {} });
  check("marked: final review status is skipped", model.finalReview?.status === "skipped", model.finalReview?.status);
  check("marked: stage is FINAL REVIEW", model.stage === "FINAL REVIEW", model.stage);
}

// Unmarked mission: no marker, no final-review runs -> the final review never started.
{
  const model = buildReportModel({ state: { ...state }, runs: [], events: [], phases, policy: {} });
  check("unmarked: final review status is not skipped", model.finalReview?.status !== "skipped", model.finalReview?.status);
  check("unmarked: final review status is not_started", model.finalReview?.status === "not_started", model.finalReview?.status);
  check("unmarked: stage is not FINAL REVIEW", model.stage !== "FINAL REVIEW", model.stage);
}

if (failures.length) {
  console.error(`\nFAILED (${failures.length}): ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nAll checks passed.");
