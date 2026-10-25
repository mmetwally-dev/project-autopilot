#!/usr/bin/env node
// Task 1.8: the watch report renders the final review as SKIPPED when the
// workflow switch (workflow.final_review=false) marked the mission, and renders
// no final-review section at all for an unmarked mission.
import { buildReportModel, renderFinalReviewStage } from "./watch-report.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
};

const phases = [{ number: 1, name: "Phase 1 — Work", done: true, tasks: [{ text: "T1.1", done: true }] }];
const state = { mission: "098-implement-backlog-items", phase: "complete", step: "complete", phaseIndex: 0 };
const skippedLine = "=== FINAL REVIEW STAGE ===  – SKIPPED (workflow.final_review=false)";

// Marked mission: final review explicitly skipped by the workflow switch.
{
  const model = buildReportModel({ state: { ...state, finalReviewSkipped: true }, runs: [], events: [], phases, policy: {} });
  check("marked: final review status is skipped", model.finalReview?.status === "skipped", model.finalReview?.status);
  const text = renderFinalReviewStage(model);
  check("marked: renders the SKIPPED line", text === skippedLine, text);
  check("marked: renders exactly one line", text.split("\n").length === 1, text);
}

// Unmarked mission: the final-review section does not exist yet.
{
  const model = buildReportModel({ state: { ...state }, runs: [], events: [], phases, policy: {} });
  const text = renderFinalReviewStage(model);
  check("unmarked: renders no final-review section", text === "", text);
  check("unmarked: no SKIPPED line", !text.includes("SKIPPED"), text);
  check("unmarked: no FINAL REVIEW header", !text.includes("FINAL REVIEW"), text);
}

// Direct model shape (as produced by buildReportModel) stays supported.
{
  const text = renderFinalReviewStage({ finalReview: { status: "skipped", rounds: [], runs: [] }, policy: {} });
  check("direct skipped model: renders the SKIPPED line", text === skippedLine, text);
}

if (failures.length) {
  console.error(`\nFAILED (${failures.length}): ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nAll checks passed.");
