#!/usr/bin/env node
// Backlog #11: Spec review whack-a-mole on one design area
// Tests:
// 1. Reviewer brief contains root-flaw rule (both frameworks, every review stage)
// 2. Planner revision brief carries the matching fix rule
// 3. Two consecutive failed rounds on FR-015a/FR-020 -> redesign line with IDs
// 4. Consecutive failed rounds on different sections -> no redesign line
// 5. State cleared on pass
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  PLAN_REVIEW_DEFECT_PATTERN_INSTRUCTION,
  PLAN_REVIEW_ROOT_FLAW_INSTRUCTION,
  DEFECT_PATTERN_PLAN_REVIEW_INSTRUCTION,
  PLAN_REVIEW_DEFECT_PATTERN_FIX_INSTRUCTION,
  PLAN_DEFECT_PATTERN_FIX_INSTRUCTION,
  PLAN_REVIEW_SEVERITY_LINE,
  PLAN_REVIEW_EXHAUSTIVE_LINE,
  PLAN_REVIEW_VERIFY_LINE,
  PLAN_REVIEW_FULL_LINE,
  PLAN_REVIEW_CONFIRMATION_LINE,
  planReviewerRoundLines,
  planReviewerConfirmationLines,
  recordPlanReviewRound,
  clearPlanReviewHistory,
  extractSectionIds,
  sameSectionRedesignLine,
} from "./plan-review-rounds.mjs";

import {
  saveReviewFeedback,
  clearReviewFeedback,
} from "./review-feedback.mjs";

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

// ── 1. Constant exports and aliases ───────────────────────────────────────────
check("PLAN_REVIEW_DEFECT_PATTERN_INSTRUCTION is a non-empty string naming missing model",
  typeof PLAN_REVIEW_DEFECT_PATTERN_INSTRUCTION === "string"
  && PLAN_REVIEW_DEFECT_PATTERN_INSTRUCTION.includes("report ONE blocking finding that names the missing model")
  && PLAN_REVIEW_DEFECT_PATTERN_INSTRUCTION.includes("state × event table"));

check("aliases for root-flaw instruction are identical",
  PLAN_REVIEW_ROOT_FLAW_INSTRUCTION === PLAN_REVIEW_DEFECT_PATTERN_INSTRUCTION
  && DEFECT_PATTERN_PLAN_REVIEW_INSTRUCTION === PLAN_REVIEW_DEFECT_PATTERN_INSTRUCTION);

check("PLAN_REVIEW_DEFECT_PATTERN_FIX_INSTRUCTION is a non-empty string naming redesign",
  typeof PLAN_REVIEW_DEFECT_PATTERN_FIX_INSTRUCTION === "string"
  && PLAN_REVIEW_DEFECT_PATTERN_FIX_INSTRUCTION.includes("rewrite that section as a whole")
  && PLAN_REVIEW_DEFECT_PATTERN_FIX_INSTRUCTION.includes("complete table of states, events, owners, outcomes and crash points"));

check("aliases for fix instruction are identical",
  PLAN_DEFECT_PATTERN_FIX_INSTRUCTION === PLAN_REVIEW_DEFECT_PATTERN_FIX_INSTRUCTION);

// ── 2. Reviewer briefs carry the root-flaw rule in every stage and framework ──
check("PLAN_REVIEW_SEVERITY_LINE includes PLAN_REVIEW_DEFECT_PATTERN_INSTRUCTION",
  PLAN_REVIEW_SEVERITY_LINE.includes(PLAN_REVIEW_DEFECT_PATTERN_INSTRUCTION));

check("round-1 exhaustive brief includes root-flaw rule",
  PLAN_REVIEW_EXHAUSTIVE_LINE.includes(PLAN_REVIEW_DEFECT_PATTERN_INSTRUCTION));

check("verify brief includes root-flaw rule",
  PLAN_REVIEW_VERIFY_LINE.includes(PLAN_REVIEW_DEFECT_PATTERN_INSTRUCTION));

check("full review brief includes root-flaw rule",
  PLAN_REVIEW_FULL_LINE.includes(PLAN_REVIEW_DEFECT_PATTERN_INSTRUCTION));

check("confirmation brief includes root-flaw rule",
  PLAN_REVIEW_CONFIRMATION_LINE.includes(PLAN_REVIEW_DEFECT_PATTERN_INSTRUCTION));

// Test both frameworks across stages
const stages = ["speckit-stage:specify", "speckit-stage:plan", "speckit-stage:tasks", "standalone-plan"];
for (const stageKey of stages) {
  const round1Brief = planReviewerRoundLines({}, stageKey).join("\n");
  check(`Reviewer brief (round 1) for ${stageKey} contains root-flaw rule`,
    round1Brief.includes(PLAN_REVIEW_DEFECT_PATTERN_INSTRUCTION));

  const sWithHistory = {};
  recordPlanReviewRound(sWithHistory, stageKey, ["Some initial finding"]);
  const round2Brief = planReviewerRoundLines(sWithHistory, stageKey).join("\n");
  check(`Reviewer brief (round 2+) for ${stageKey} contains root-flaw rule`,
    round2Brief.includes(PLAN_REVIEW_DEFECT_PATTERN_INSTRUCTION));

  const confBrief = planReviewerConfirmationLines().join("\n");
  check(`Confirmation review brief for ${stageKey} contains root-flaw rule`,
    confBrief.includes(PLAN_REVIEW_DEFECT_PATTERN_INSTRUCTION));
}

// Standalone spec reviewer brief uses PLAN_REVIEW_FULL_LINE
check("Standalone spec reviewer brief contains root-flaw rule",
  PLAN_REVIEW_FULL_LINE.includes(PLAN_REVIEW_DEFECT_PATTERN_INSTRUCTION));

// ── 3. extractSectionIds unit coverage ─────────────────────────────────────────
check("extractSectionIds: handles FR-015a and FR-020 from strings",
  JSON.stringify(extractSectionIds("SPEC.md FR-015a/FR-020: lease expiry issue")) === JSON.stringify(["FR-015a", "FR-020"]));

check("extractSectionIds: handles structured finding object",
  JSON.stringify(extractSectionIds({ location: "SPEC.md FR-007", problem: "compensation issue" })) === JSON.stringify(["FR-007"]));

check("extractSectionIds: handles section symbols like §2.3",
  JSON.stringify(extractSectionIds("§2.3: missing transition")) === JSON.stringify(["§2.3"]));

check("extractSectionIds: handles markdown headings like ## Provisioning",
  JSON.stringify(extractSectionIds("## Provisioning: missing fencing")) === JSON.stringify(["## Provisioning"]));

check("extractSectionIds: handles named section like Section 2.3",
  JSON.stringify(extractSectionIds("Section 2.3: invalid state")) === JSON.stringify(["Section 2.3"]));

check("extractSectionIds: handles multiple findings in an array and dedupes/sorts",
  JSON.stringify(extractSectionIds([
    { location: "FR-020", problem: "crash point" },
    { location: "FR-015a", problem: "lease expiry" },
    { location: "FR-020", problem: "replay issue" },
  ])) === JSON.stringify(["FR-015a", "FR-020"]));

// ── 4. Planner revision brief carries the fix rule ────────────────────────────
const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-test-whack-a-mole-"));
try {
  const dummyState = {};

  // (a) SpecKit gate planner brief
  saveReviewFeedback(dummyState, "speckit-stage:specify", ["SPEC.md FR-015a: lease expiry"]);
  const skBrief = speckitGateNote(dummyState, "specify", tmpRepo, {});
  check("SpecKit gate planner revision brief carries fix rule",
    skBrief.includes(PLAN_REVIEW_DEFECT_PATTERN_FIX_INSTRUCTION));

  // (b) Standalone plan revision brief
  saveReviewFeedback(dummyState, "standalone-plan", ["TASKS.md 1.1: task error"]);
  const saPlanBrief = standalonePlanFeedbackNote(dummyState, tmpRepo, "test-mission", {});
  check("Standalone plan revision brief carries fix rule",
    saPlanBrief.includes(PLAN_REVIEW_DEFECT_PATTERN_FIX_INSTRUCTION));

  // (c) Standalone spec revision brief
  saveReviewFeedback(dummyState, "standalone-spec", ["SPEC.md FR-015a: lease expiry"]);
  const saSpecBrief = standaloneSpecFeedbackNote(dummyState, tmpRepo, "test-mission", {});
  check("Standalone spec revision brief carries fix rule",
    saSpecBrief.includes(PLAN_REVIEW_DEFECT_PATTERN_FIX_INSTRUCTION));
} finally {
  fs.rmSync(tmpRepo, { recursive: true, force: true });
}

// ── 5. Two consecutive rounds on FR-015a/FR-020 -> redesign line with IDs ─────
const testRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-test-whack-a-mole-two-rounds-"));
try {
  // Test across: speckit-stage:specify, standalone-plan, standalone-spec
  const testCases = [
    {
      framework: "speckit specify",
      key: "speckit-stage:specify",
      getBrief: (s) => speckitGateNote(s, "specify", testRepo, {}),
    },
    {
      framework: "standalone plan",
      key: "standalone-plan",
      getBrief: (s) => standalonePlanFeedbackNote(s, testRepo, "test-mission", {}),
    },
    {
      framework: "standalone spec",
      key: "standalone-spec",
      getBrief: (s) => standaloneSpecFeedbackNote(s, testRepo, "test-mission", {}),
    },
  ];

  for (const tc of testCases) {
    const s = {};

    // Round 1 FAIL on FR-015a, FR-020
    const r1Findings = [
      { location: "SPEC.md FR-015a", problem: "lease expiry vs compensation intent" },
      { location: "SPEC.md FR-020", problem: "ownership while FAILED/COMPENSATION_REQUIRED" },
    ];
    saveReviewFeedback(s, tc.key, r1Findings);
    recordPlanReviewRound(s, tc.key, r1Findings);

    // After round 1: exactly 1 failed round, so NO redesign line yet
    const briefAfterRound1 = tc.getBrief(s);
    check(`${tc.framework}: after round 1 FAIL, no redesign line yet`,
      !briefAfterRound1.includes("redesign this section as one complete table"));

    // Round 2 FAIL also on FR-015a, FR-020 (whack-a-mole next boundary cases)
    const r2Findings = [
      { location: "SPEC.md FR-015a", problem: "fencing for an external delete call" },
      { location: "SPEC.md FR-020", problem: "crash after committing intent" },
    ];
    saveReviewFeedback(s, tc.key, r2Findings);
    recordPlanReviewRound(s, tc.key, r2Findings);

    // After round 2: two consecutive failed rounds on FR-015a, FR-020 -> REDESIGN LINE
    const expectedRedesign =
      "Review rounds 1 and 2 both failed only on FR-015a, FR-020: redesign this section as one complete table of states, events, owners and crash points; do not patch single cases.";

    const redesignLine = sameSectionRedesignLine(s, tc.key);
    check(`${tc.framework}: sameSectionRedesignLine returns exact redesign line with IDs`,
      redesignLine === expectedRedesign, redesignLine);

    const briefAfterRound2 = tc.getBrief(s);
    check(`${tc.framework}: planner revision brief contains redesign line with IDs`,
      briefAfterRound2.includes(expectedRedesign), briefAfterRound2);

    // ── 6. State cleared on pass ──
    clearPlanReviewHistory(s, tc.key);
    clearReviewFeedback(s, tc.key);

    const redesignAfterPass = sameSectionRedesignLine(s, tc.key);
    check(`${tc.framework}: sameSectionRedesignLine returns empty after stage pass`,
      redesignAfterPass === "", redesignAfterPass);

    const briefAfterPass = tc.getBrief(s);
    check(`${tc.framework}: brief after pass contains no redesign line`,
      !briefAfterPass.includes("redesign this section as one complete table"), briefAfterPass);
  }
} finally {
  fs.rmSync(testRepo, { recursive: true, force: true });
}

// ── 7. Rounds on different sections -> no redesign line ────────────────────────
{
  const sDiff = {};
  const key = "speckit-stage:plan";

  // Round 1 on FR-001 (or §1.1)
  const r1Diff = [{ location: "SPEC.md FR-001", problem: "unspecified timeout" }];
  saveReviewFeedback(sDiff, key, r1Diff);
  recordPlanReviewRound(sDiff, key, r1Diff);

  // Round 2 on FR-002 (different section)
  const r2Diff = [{ location: "SPEC.md FR-002", problem: "missing error schema" }];
  saveReviewFeedback(sDiff, key, r2Diff);
  recordPlanReviewRound(sDiff, key, r2Diff);

  const diffRedesignLine = sameSectionRedesignLine(sDiff, key);
  check("rounds on different sections -> no redesign line",
    diffRedesignLine === "", diffRedesignLine);
}

// ── 8. Mixed sections (one round touches extra unrelated section) -> no line ──
{
  const sMixed = {};
  const key = "standalone-plan";

  // Round 1 on FR-015a
  const r1 = [{ location: "SPEC.md FR-015a", problem: "lease issue" }];
  saveReviewFeedback(sMixed, key, r1);
  recordPlanReviewRound(sMixed, key, r1);

  // Round 2 on FR-015a AND FR-099 (unrelated section)
  const r2 = [
    { location: "SPEC.md FR-015a", problem: "fence issue" },
    { location: "SPEC.md FR-099", problem: "unrelated logging requirement" },
  ];
  saveReviewFeedback(sMixed, key, r2);
  recordPlanReviewRound(sMixed, key, r2);

  const mixedRedesignLine = sameSectionRedesignLine(sMixed, key);
  check("rounds where one round has unrelated section -> no redesign line",
    mixedRedesignLine === "", mixedRedesignLine);
}

// ── 9. Quoted / slash format: FR-015a/FR-020 in single finding location ────────
{
  const sSlash = {};
  const key = "speckit-stage:tasks";

  const r1Slash = [{ location: "spec.md FR-015a/FR-020", problem: "state machine gap" }];
  saveReviewFeedback(sSlash, key, r1Slash);
  recordPlanReviewRound(sSlash, key, r1Slash);

  const r2Slash = [{ location: "spec.md FR-015a/FR-020", problem: "crash recovery gap" }];
  saveReviewFeedback(sSlash, key, r2Slash);
  recordPlanReviewRound(sSlash, key, r2Slash);

  const slashRedesignLine = sameSectionRedesignLine(sSlash, key);
  check("finding with FR-015a/FR-020 location triggers redesign line naming both IDs",
    slashRedesignLine === "Review rounds 1 and 2 both failed only on FR-015a, FR-020: redesign this section as one complete table of states, events, owners and crash points; do not patch single cases.",
    slashRedesignLine);
}

// ── 10. Headings and section symbols ──────────────────────────────────────────
{
  const sHeading = {};
  const key = "standalone-spec";

  const r1Heading = [{ location: "## Ownership Protocol", problem: "missing fencing" }];
  saveReviewFeedback(sHeading, key, r1Heading);
  recordPlanReviewRound(sHeading, key, r1Heading);

  const r2Heading = [{ location: "## Ownership Protocol", problem: "lease expiry undefined" }];
  saveReviewFeedback(sHeading, key, r2Heading);
  recordPlanReviewRound(sHeading, key, r2Heading);

  const headingRedesign = sameSectionRedesignLine(sHeading, key);
  check("findings with ## Section heading triggers redesign line naming ## heading",
    headingRedesign === "Review rounds 1 and 2 both failed only on ## Ownership Protocol: redesign this section as one complete table of states, events, owners and crash points; do not patch single cases.",
    headingRedesign);
}

console.log(`\nAll checks passed (${ok}/${ok})`);
if (failed > 0) process.exit(1);
