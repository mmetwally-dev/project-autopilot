#!/usr/bin/env node
// Backlog #8: SpecKit-analyze-style cross-check in standalone plan review's full rounds (when SPEC.md is on)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  STANDALONE_SPEC_ANALYZE_LINE,
  isFullPlanReviewRound,
  planReviewerRoundLines,
  planReviewerConfirmationLines,
  recordPlanReviewRound,
  PLAN_REVIEW_VERIFY_LINE,
  PLAN_REVIEW_EXHAUSTIVE_LINE,
  PLAN_REVIEW_CONFIRMATION_LINE,
  PLAN_REVIEW_FULL_LINE
} from "./plan-review-rounds.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS ${name}`);
  else {
    failures += 1;
    console.error(`FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

// 1. Unit: isFullPlanReviewRound
{
  const key = "standalone-plan";

  // Fresh state (round 1)
  const freshState = {};
  const round1Lines = planReviewerRoundLines(freshState, key);
  check(
    "unit: isFullPlanReviewRound is true for planReviewerRoundLines of fresh state (round 1)",
    isFullPlanReviewRound(round1Lines) === true && round1Lines[0] === PLAN_REVIEW_EXHAUSTIVE_LINE,
    round1Lines
  );

  // Confirmation lines
  const confirmLines = planReviewerConfirmationLines();
  check(
    "unit: isFullPlanReviewRound is true for planReviewerConfirmationLines()",
    isFullPlanReviewRound(confirmLines) === true && confirmLines[0] === PLAN_REVIEW_CONFIRMATION_LINE,
    confirmLines
  );

  // Convergence off
  const convOffState = {};
  const convOffLines = planReviewerRoundLines(convOffState, key, false);
  check(
    "unit: isFullPlanReviewRound is true for convergence off (planReviewerRoundLines(state,key,false))",
    isFullPlanReviewRound(convOffLines) === true && convOffLines[0] === PLAN_REVIEW_FULL_LINE,
    convOffLines
  );

  // False after one recorded reviewer round with no confirmation pending
  const recordedState = {};
  recordPlanReviewRound(recordedState, key, ["TASKS.md 1.1: problem to fix"]);
  const round2Lines = planReviewerRoundLines(recordedState, key);
  check(
    "unit: isFullPlanReviewRound is false after one recorded reviewer round with no confirmation pending",
    isFullPlanReviewRound(round2Lines) === false && round2Lines[0] === PLAN_REVIEW_VERIFY_LINE,
    round2Lines
  );

  // Non-array / empty handling
  check(
    "unit: isFullPlanReviewRound handles non-array input correctly",
    isFullPlanReviewRound(null) === false && isFullPlanReviewRound(undefined) === false && isFullPlanReviewRound("not-array") === false,
    null
  );
}

// 2. Unit: STANDALONE_SPEC_ANALYZE_LINE names SPEC.md, PLAN.md and TASKS.md and contains "BLOCKING" and "MINOR"
{
  const text = STANDALONE_SPEC_ANALYZE_LINE;
  const namesFiles = typeof text === "string" && text.includes("SPEC.md") && text.includes("PLAN.md") && text.includes("TASKS.md");
  const hasSeverities = typeof text === "string" && text.includes("BLOCKING") && text.includes("MINOR");
  check(
    "unit: STANDALONE_SPEC_ANALYZE_LINE names SPEC.md, PLAN.md and TASKS.md",
    namesFiles,
    text
  );
  check(
    "unit: STANDALONE_SPEC_ANALYZE_LINE contains BLOCKING and MINOR",
    hasSeverities,
    text
  );
}

// 3. Wiring: source check of scripts/autopilot.mjs
{
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const autopilotPath = path.join(HERE, "autopilot.mjs");
  const autopilotSrc = fs.readFileSync(autopilotPath, "utf8");

  // import check
  const importsAnalyzeLine = autopilotSrc.includes("STANDALONE_SPEC_ANALYZE_LINE");
  const importsIsFull = autopilotSrc.includes("isFullPlanReviewRound");
  check(
    "wiring: scripts/autopilot.mjs imports STANDALONE_SPEC_ANALYZE_LINE and isFullPlanReviewRound",
    importsAnalyzeLine && importsIsFull,
    { importsAnalyzeLine, importsIsFull }
  );

  // reviewPrompt computes reviewRoundLines once
  const computesRoundLines = autopilotSrc.includes("const reviewRoundLines=planReviewerRoundLines(s,STANDALONE_PLAN_FEEDBACK_KEY,c.workflow?.plan_review_convergence!==false,standaloneTaskSizeLine);");
  check(
    "wiring: scripts/autopilot.mjs computes reviewRoundLines before reviewPrompt",
    computesRoundLines,
    computesRoundLines
  );

  // the review prompt uses specOn&&isFullPlanReviewRound(reviewRoundLines)?[STANDALONE_SPEC_ANALYZE_LINE]:[]
  const hasAnalyzeSpread = autopilotSrc.includes("specOn&&isFullPlanReviewRound(reviewRoundLines)?[STANDALONE_SPEC_ANALYZE_LINE]:[]");
  check(
    "wiring: reviewPrompt uses specOn&&isFullPlanReviewRound(reviewRoundLines)?[STANDALONE_SPEC_ANALYZE_LINE]:[]",
    hasAnalyzeSpread,
    hasAnalyzeSpread
  );

  // and no longer calls planReviewerRoundLines( inside the reviewPrompt array
  const reviewPromptMatch = autopilotSrc.match(/const reviewPrompt=\s*\[([\s\S]*?)\]\.filter\(Boolean\)\.join\("\\n\\n"\);/);
  const insideReviewPrompt = reviewPromptMatch ? reviewPromptMatch[1] : "";
  const callsPlanReviewerInside = insideReviewPrompt.includes("planReviewerRoundLines(");
  check(
    "wiring: reviewPrompt no longer calls planReviewerRoundLines( inside the reviewPrompt array",
    reviewPromptMatch !== null && !callsPlanReviewerInside,
    { foundPrompt: Boolean(reviewPromptMatch), callsPlanReviewerInside }
  );
}

if (failures > 0) {
  console.error(`FAILED: ${failures} check(s) failed`);
  process.exit(1);
} else {
  console.log("ALL CHECKS PASSED");
}

