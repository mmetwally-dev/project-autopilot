#!/usr/bin/env node
// Backlog #6: Rule-sweep and fix-coverage rules for plan reviews and planner revisions.
// Verifies:
// 1. PLAN_REVIEW_DEFECT_PATTERN_INSTRUCTION, PLAN_REVIEW_FIX_COVERAGE_LINE, and
//    PLAN_REVIEW_DEFECT_PATTERN_FIX_INSTRUCTION contain the new rule-sweep / fix-coverage text.
// 2. SpecKit gate reviewer briefs (full round, verify round, round 1, confirmation, continuation)
//    and standalone plan review briefs contain the sweep sentence and (for verify/full rounds)
//    the fix-coverage line.
// 3. All three planner revision briefs (SpecKit gate, standalone spec, standalone plan)
//    contain the "apply each fix to every task, route, trigger and caller" text.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PLAN_REVIEW_DEFECT_PATTERN_INSTRUCTION,
  PLAN_REVIEW_DEFECT_PATTERN_FIX_INSTRUCTION,
  PLAN_REVIEW_FIX_COVERAGE_LINE,
  PLAN_REVIEW_SEVERITY_LINE,
  PLAN_REVIEW_EXHAUSTIVE_LINE,
  PLAN_REVIEW_VERIFY_LINE,
  PLAN_REVIEW_FULL_LINE,
  PLAN_REVIEW_CONFIRMATION_LINE,
  PLAN_REVIEW_CONFIRMATION_CONTINUATION_LINE,
  planReviewerRoundLines,
  planReviewerConfirmationLines,
  recordPlanReviewRound,
  markPlanReviewConfirmationFailed,
  formatReviewBriefForContinuation,
} from "./plan-review-rounds.mjs";

import { saveReviewFeedback } from "./review-feedback.mjs";
import {
  speckitGateNote,
  standalonePlanFeedbackNote,
  standaloneSpecFeedbackNote,
} from "./revision-files-changed.mjs";

let ok = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
    ok += 1;
    return;
  }
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${String(detail).slice(0, 400)}` : ""}`);
  failed += 1;
}

const SWEEP_SNIPPET =
  "check EVERY task, route, trigger and caller the same rule applies to and name all affected places in that ONE finding with the correction for each; do not report one route or trigger now and its sibling in a later round.";
const FIX_COVERAGE_SNIPPET =
  "A previous finding counts as fixed only when the fix covers every place the same rule applies to (all routes, triggers, callers and tasks); if the revision fixed only the place the finding quoted, mark it not_fixed and list the missing places in that finding.";
const PLANNER_SWEEP_SNIPPET =
  "apply each fix to every task, route, trigger and caller the same rule covers, not only the place the finding quotes";

// ── 1. The three constants contain the new text ──────────────────────────────
check(
  "PLAN_REVIEW_DEFECT_PATTERN_INSTRUCTION contains rule-sweep sentence",
  typeof PLAN_REVIEW_DEFECT_PATTERN_INSTRUCTION === "string"
    && PLAN_REVIEW_DEFECT_PATTERN_INSTRUCTION.includes("When a finding is about a rule")
    && PLAN_REVIEW_DEFECT_PATTERN_INSTRUCTION.includes(SWEEP_SNIPPET),
  PLAN_REVIEW_DEFECT_PATTERN_INSTRUCTION
);

check(
  "PLAN_REVIEW_FIX_COVERAGE_LINE contains fix-coverage rule",
  typeof PLAN_REVIEW_FIX_COVERAGE_LINE === "string"
    && PLAN_REVIEW_FIX_COVERAGE_LINE.includes(FIX_COVERAGE_SNIPPET),
  PLAN_REVIEW_FIX_COVERAGE_LINE
);

check(
  "PLAN_REVIEW_DEFECT_PATTERN_FIX_INSTRUCTION contains planner sweep clause (lowercase, parenthetical)",
  typeof PLAN_REVIEW_DEFECT_PATTERN_FIX_INSTRUCTION === "string"
    && PLAN_REVIEW_DEFECT_PATTERN_FIX_INSTRUCTION.includes(`; and ${PLANNER_SWEEP_SNIPPET}`)
    && /^[a-z]/.test(PLAN_REVIEW_DEFECT_PATTERN_FIX_INSTRUCTION)
    && !PLAN_REVIEW_DEFECT_PATTERN_FIX_INSTRUCTION.endsWith("."),
  PLAN_REVIEW_DEFECT_PATTERN_FIX_INSTRUCTION
);

check(
  "PLAN_REVIEW_SEVERITY_LINE embeds rule-sweep sentence",
  PLAN_REVIEW_SEVERITY_LINE.includes(SWEEP_SNIPPET)
);
check(
  "PLAN_REVIEW_EXHAUSTIVE_LINE embeds rule-sweep sentence",
  PLAN_REVIEW_EXHAUSTIVE_LINE.includes(SWEEP_SNIPPET)
);
check(
  "PLAN_REVIEW_VERIFY_LINE embeds rule-sweep sentence and PLAN_REVIEW_FIX_COVERAGE_LINE",
  PLAN_REVIEW_VERIFY_LINE.includes(SWEEP_SNIPPET)
    && PLAN_REVIEW_VERIFY_LINE.includes(PLAN_REVIEW_FIX_COVERAGE_LINE)
);
check(
  "PLAN_REVIEW_FULL_LINE embeds rule-sweep sentence and PLAN_REVIEW_FIX_COVERAGE_LINE",
  PLAN_REVIEW_FULL_LINE.includes(SWEEP_SNIPPET)
    && PLAN_REVIEW_FULL_LINE.includes(PLAN_REVIEW_FIX_COVERAGE_LINE)
);
check(
  "PLAN_REVIEW_CONFIRMATION_LINE and continuation embed rule-sweep sentence",
  PLAN_REVIEW_CONFIRMATION_LINE.includes(SWEEP_SNIPPET)
    && PLAN_REVIEW_CONFIRMATION_CONTINUATION_LINE.includes(SWEEP_SNIPPET)
);

// ── 2. SpecKit gate reviewer briefs (full round AND verify round) ────────────
for (const gateKey of ["speckit-stage:specify", "speckit-stage:plan", "speckit-stage:tasks"]) {
  // Round 1 (exhaustive)
  const round1Brief = planReviewerRoundLines({}, gateKey, true).join("\n");
  check(
    `SpecKit ${gateKey} round-1 reviewer brief contains sweep sentence`,
    round1Brief.includes(SWEEP_SNIPPET),
    round1Brief
  );

  // Verify round (round 2+ with convergence on)
  const verifyState = {};
  recordPlanReviewRound(verifyState, gateKey, [
    "tasks.md T052c: row-4 Auth conflict on CREATE/REINVITE must map to 409 DUPLICATE_EMAIL",
  ]);
  const verifyBrief = planReviewerRoundLines(verifyState, gateKey, true).join("\n");
  check(
    `SpecKit ${gateKey} verify-round reviewer brief contains sweep sentence and fix-coverage line`,
    verifyBrief.includes(SWEEP_SNIPPET) && verifyBrief.includes(PLAN_REVIEW_FIX_COVERAGE_LINE),
    verifyBrief
  );

  // Full round (convergence off)
  const fullOffBrief = planReviewerRoundLines(verifyState, gateKey, false).join("\n");
  check(
    `SpecKit ${gateKey} full-round (convergence off) reviewer brief contains sweep sentence and fix-coverage line`,
    fullOffBrief.includes(SWEEP_SNIPPET) && fullOffBrief.includes(PLAN_REVIEW_FIX_COVERAGE_LINE),
    fullOffBrief
  );

  // Full round (post-confirmation FAIL)
  const postConfFailState = {};
  recordPlanReviewRound(postConfFailState, gateKey, [
    "tasks.md T052c: row-4 Auth conflict on CREATE/REINVITE must map to 409 DUPLICATE_EMAIL",
  ]);
  markPlanReviewConfirmationFailed(postConfFailState, gateKey);
  const postConfFullBrief = planReviewerRoundLines(postConfFailState, gateKey, true).join("\n");
  check(
    `SpecKit ${gateKey} full-round (post-confirmation FAIL) reviewer brief contains sweep sentence and fix-coverage line`,
    postConfFullBrief.includes(SWEEP_SNIPPET) && postConfFullBrief.includes(PLAN_REVIEW_FIX_COVERAGE_LINE),
    postConfFullBrief
  );

  // Continuation variant of full round
  const fullContinuationBrief = formatReviewBriefForContinuation(
    `${postConfFullBrief}\n\nPrior reviewer handoff note (continuation context): 1. Checked and clear`
  );
  check(
    `SpecKit ${gateKey} continuation reviewer brief preserves sweep sentence and fix-coverage line`,
    fullContinuationBrief.includes(SWEEP_SNIPPET) && fullContinuationBrief.includes(PLAN_REVIEW_FIX_COVERAGE_LINE),
    fullContinuationBrief
  );
}

// Confirmation rounds (standard + continuation)
const confBrief = planReviewerConfirmationLines(false).join("\n");
const confContBrief = planReviewerConfirmationLines(true).join("\n");
check(
  "Confirmation reviewer brief (standard + continuation) contains sweep sentence",
  confBrief.includes(SWEEP_SNIPPET) && confContBrief.includes(SWEEP_SNIPPET)
);

// ── 3. Standalone plan review brief (verify round + full round) ──────────────
{
  const key = "standalone-plan";
  const round1 = planReviewerRoundLines({}, key, true).join("\n");
  check(
    "Standalone plan round-1 reviewer brief contains sweep sentence",
    round1.includes(SWEEP_SNIPPET),
    round1
  );

  const sVerify = {};
  recordPlanReviewRound(sVerify, key, ["TASKS.md 2.1: error mapping incomplete"]);
  const verifyBrief = planReviewerRoundLines(sVerify, key, true).join("\n");
  check(
    "Standalone plan verify-round reviewer brief contains sweep sentence and fix-coverage line",
    verifyBrief.includes(SWEEP_SNIPPET) && verifyBrief.includes(PLAN_REVIEW_FIX_COVERAGE_LINE),
    verifyBrief
  );

  const fullBrief = planReviewerRoundLines(sVerify, key, false).join("\n");
  check(
    "Standalone plan full-round reviewer brief contains sweep sentence and fix-coverage line",
    fullBrief.includes(SWEEP_SNIPPET) && fullBrief.includes(PLAN_REVIEW_FIX_COVERAGE_LINE),
    fullBrief
  );
}

// ── 4. Three planner revision briefs contain the planner sweep clause ────────
const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-test-backlog-6-sweep-"));
try {
  const s = {};

  saveReviewFeedback(s, "speckit-stage:tasks", [
    "tasks.md T052c: row-4 Auth conflict on CREATE/REINVITE must map to 409 DUPLICATE_EMAIL",
  ]);
  const skBrief = speckitGateNote(s, "tasks", tmpRepo, {});
  check(
    "SpecKit gate planner revision brief contains planner sweep clause",
    skBrief.includes(PLANNER_SWEEP_SNIPPET) && skBrief.includes(PLAN_REVIEW_DEFECT_PATTERN_FIX_INSTRUCTION),
    skBrief
  );

  saveReviewFeedback(s, "standalone-spec", [
    "SPEC.md FR-004: row-4 Auth conflict on CREATE/REINVITE must map to 409 DUPLICATE_EMAIL",
  ]);
  const saSpecBrief = standaloneSpecFeedbackNote(s, tmpRepo, "test-mission", {});
  check(
    "Standalone spec planner revision brief contains planner sweep clause",
    saSpecBrief.includes(PLANNER_SWEEP_SNIPPET) && saSpecBrief.includes(PLAN_REVIEW_DEFECT_PATTERN_FIX_INSTRUCTION),
    saSpecBrief
  );

  saveReviewFeedback(s, "standalone-plan", [
    "TASKS.md 2.3: row-4 Auth conflict on CREATE/REINVITE must map to 409 DUPLICATE_EMAIL",
  ]);
  const saPlanBrief = standalonePlanFeedbackNote(s, tmpRepo, "test-mission", {});
  check(
    "Standalone plan planner revision brief contains planner sweep clause",
    saPlanBrief.includes(PLANNER_SWEEP_SNIPPET) && saPlanBrief.includes(PLAN_REVIEW_DEFECT_PATTERN_FIX_INSTRUCTION),
    saPlanBrief
  );
} finally {
  fs.rmSync(tmpRepo, { recursive: true, force: true });
}

// ── 5. Source-anchored wiring in scripts/autopilot.mjs ───────────────────────
const autopilotSrc = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
const sliceAfter = (marker, len = 1800) => {
  const idx = autopilotSrc.indexOf(marker);
  return idx >= 0 ? autopilotSrc.slice(idx, idx + len) : "";
};

check(
  "autopilot.mjs standalone spec reviewer uses PLAN_REVIEW_FULL_LINE",
  sliceAfter("Review the feature specification before planning starts.").includes("PLAN_REVIEW_FULL_LINE")
);
check(
  "autopilot.mjs standalone plan reviewer uses planReviewerRoundLines",
  sliceAfter("const reviewRoundLines=planReviewerRoundLines(s,STANDALONE_PLAN_FEEDBACK_KEY", 3200).includes("...reviewRoundLines")
);
check(
  "autopilot.mjs SpecKit gate initial & confirmation & re-review briefs use planReviewerRoundLines / planReviewerConfirmationLines",
  sliceAfter("const initialReviewPrompt=").includes("planReviewerRoundLines(s,speckitStageFeedbackKey(gateStage)")
    && sliceAfter("const confirmationPrompt=").includes("planReviewerConfirmationLines()")
    && sliceAfter("const reReviewPrompt=").includes("planReviewerRoundLines(s,speckitStageFeedbackKey(gateStage)")
);
check(
  "autopilot.mjs existing-planning-state reviewer includes PLAN_REVIEW_DEFECT_PATTERN_INSTRUCTION",
  sliceAfter("Validate the existing ${subject}").includes("PLAN_REVIEW_DEFECT_PATTERN_INSTRUCTION")
);
check(
  "autopilot.mjs all three planner revision briefs embed PLAN_REVIEW_DEFECT_PATTERN_FIX_INSTRUCTION",
  autopilotSrc.includes("Address every finding (${PLAN_REVIEW_DEFECT_PATTERN_FIX_INSTRUCTION})")
    && autopilotSrc.includes("Spec reviewer feedback that MUST be addressed (${PLAN_REVIEW_DEFECT_PATTERN_FIX_INSTRUCTION})")
    && autopilotSrc.includes("Plan reviewer feedback that MUST be addressed (${PLAN_REVIEW_DEFECT_PATTERN_FIX_INSTRUCTION})")
);

console.log(`\nChecks passed: ${ok}/${ok + failed}`);
if (failed > 0) process.exit(1);
