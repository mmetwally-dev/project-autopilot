#!/usr/bin/env node
// Test for scoped review rounds: round-based verification boundary and deduplication.
import assert from "node:assert/strict";
import {
  recordPlanReviewRound,
  planReviewerRoundLines,
  PLAN_REVIEW_VERIFY_LINE,
  PLAN_REVIEW_EXHAUSTIVE_LINE,
} from "./plan-review-rounds.mjs";
import {
  recordCodeReviewRound,
  codeReviewerRoundLines,
  CODE_REVIEW_VERIFY_LINE,
  CODE_REVIEW_EXHAUSTIVE_LINE,
} from "./code-review-rounds.mjs";

function countOccurrences(text, searchStr) {
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(searchStr, pos)) !== -1) {
    count++;
    pos += searchStr.length;
  }
  return count;
}

// ── 1. Plan Review: Single round (one round only → unchanged output) ──────────
{
  const s = {};
  const K = "test-plan-1";
  assert.deepEqual(planReviewerRoundLines(s, K), [PLAN_REVIEW_EXHAUSTIVE_LINE]);

  recordPlanReviewRound(s, K, ["TASKS.md 1.1: alpha problem"]);
  const lines = planReviewerRoundLines(s, K);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], PLAN_REVIEW_VERIFY_LINE);
  assert.equal(
    lines[1],
    "Previous findings from all earlier review rounds (verify each):\nRound 1:\n1. TASKS.md 1.1: alpha problem"
  );
  assert.equal(lines[1].includes("were already verified in round"), false);
}

// ── 2. Code Review: Single round (one round only → unchanged output) ──────────
{
  const s = {};
  const K = "phase:0";
  assert.deepEqual(codeReviewerRoundLines(s, K), [CODE_REVIEW_EXHAUSTIVE_LINE]);

  recordCodeReviewRound(s, K, ["src/app.js:10: syntax error"]);
  const lines = codeReviewerRoundLines(s, K);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], CODE_REVIEW_VERIFY_LINE);
  assert.equal(
    lines[1],
    "Previous findings from all earlier review rounds (verify each):\nRound 1:\n1. src/app.js:10: syntax error"
  );
  assert.equal(lines[1].includes("were already verified in round"), false);
}

// ── 3. Plan Review: 10 rounds, previous non-empty at rounds 5 and 8 ───────────
{
  const s = {};
  const K = "test-plan-10";

  const F1 = "TASKS.md:101 problem 1";
  const F2 = "TASKS.md:102 problem 2";
  const F3 = "TASKS.md:103 problem 3";
  const F4 = "TASKS.md:104 problem 4";
  const F5 = "TASKS.md:105 problem 5";
  const F6 = "TASKS.md:106 problem 6";
  const F7 = "TASKS.md:107 problem 7";
  const F8 = "TASKS.md:108 problem 8";
  const F8b = "TASKS.md:108b problem 8b";
  const F9 = "TASKS.md:109 problem 9";
  const F10 = "TASKS.md:110 problem 10";
  const F11 = "TASKS.md:111 problem 11";

  // Rounds 1-7 contain 8 distinct findings: F1..F8
  recordPlanReviewRound(s, K, [F1, F2]);
  recordPlanReviewRound(s, K, [F3]);
  recordPlanReviewRound(s, K, [F4]);
  recordPlanReviewRound(s, K, [F5]);
  // Round 5: previous non-empty
  recordPlanReviewRound(s, K, [F6], [{ finding: "Round 4 problem", status: "fixed" }]);
  recordPlanReviewRound(s, K, [F7]);
  recordPlanReviewRound(s, K, [F8]);

  // Round 8: previous non-empty (last round with non-empty previous => V = round 8)
  recordPlanReviewRound(s, K, [F8b, F9], [{ finding: "Round 7 problem", status: "fixed" }]);
  // Round 9: repeats F9, adds F10
  recordPlanReviewRound(s, K, [F9, F10], []);
  // Round 10: repeats F10, adds F11
  recordPlanReviewRound(s, K, [F10, F11], []);

  const lines = planReviewerRoundLines(s, K);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], PLAN_REVIEW_VERIFY_LINE);

  const expectedHeader = "Previous findings from all earlier review rounds (verify each):\n";
  assert.equal(lines[1].startsWith(expectedHeader), true);

  // Exact N = 8 distinct findings in rounds 1-7; exact round numbers (rounds 1-7) and round 8
  const expectedLine =
    "8 earlier findings (rounds 1-7) were already verified in round 8; do not re-check them unless this revision touched their lines.";
  assert.equal(lines[1].includes(expectedLine), true);

  // Line must appear first right after header
  assert.equal(lines[1].startsWith(`${expectedHeader}${expectedLine}`), true);

  // Only rounds 8..10 listed
  for (let r = 1; r <= 7; r++) {
    assert.equal(lines[1].includes(`Round ${r}:`), false);
  }
  assert.equal(lines[1].includes("Round 8:"), true);
  assert.equal(lines[1].includes("Round 9:"), true);
  assert.equal(lines[1].includes("Round 10:"), true);

  // Findings from rounds 1-7 not listed
  assert.equal(lines[1].includes(F1), false);
  assert.equal(lines[1].includes(F2), false);
  assert.equal(lines[1].includes(F3), false);
  assert.equal(lines[1].includes(F4), false);
  assert.equal(lines[1].includes(F5), false);
  assert.equal(lines[1].includes(F6), false);
  assert.equal(lines[1].includes(F7), false);
  assert.equal(lines[1].includes(F8), false);

  // Deduped across rounds 8..10: each listed once
  assert.equal(countOccurrences(lines[1], F8b), 1);
  assert.equal(countOccurrences(lines[1], F9), 1);
  assert.equal(countOccurrences(lines[1], F10), 1);
  assert.equal(countOccurrences(lines[1], F11), 1);

  // F9 kept in Round 9 (deduped from Round 8); F10 kept in Round 10 (deduped from Round 9)
  const r8Block = lines[1].slice(lines[1].indexOf("Round 8:"), lines[1].indexOf("Round 9:"));
  assert.equal(r8Block.includes(F8b), true);
  assert.equal(r8Block.includes(F9), false);

  const r9Block = lines[1].slice(lines[1].indexOf("Round 9:"), lines[1].indexOf("Round 10:"));
  assert.equal(r9Block.includes(F9), true);
  assert.equal(r9Block.includes(F10), false);

  const r10Block = lines[1].slice(lines[1].indexOf("Round 10:"));
  assert.equal(r10Block.includes(F10), true);
  assert.equal(r10Block.includes(F11), true);
}

// ── 4. Code Review: 10 rounds, previous non-empty at rounds 5 and 8 ───────────
{
  const s = {};
  const K = "phase:1";

  const F1 = "lib/f1.js:1: err 1";
  const F2 = "lib/f2.js:2: err 2";
  const F3 = "lib/f3.js:3: err 3";
  const F4 = "lib/f4.js:4: err 4";
  const F5 = "lib/f5.js:5: err 5";
  const F6 = "lib/f6.js:6: err 6";
  const F7 = "lib/f7.js:7: err 7";
  const F8 = "lib/f8.js:8: err 8";
  const F8b = "lib/f8b.js:8: err 8b";
  const F9 = "lib/f9.js:9: err 9";
  const F10 = "lib/f10.js:10: err 10";
  const F11 = "lib/f11.js:11: err 11";

  // Rounds 1-7 contain 8 distinct findings: F1..F8
  recordCodeReviewRound(s, K, [F1, F2]);
  recordCodeReviewRound(s, K, [F3]);
  recordCodeReviewRound(s, K, [F4]);
  recordCodeReviewRound(s, K, [F5]);
  // Round 5: previous non-empty
  recordCodeReviewRound(s, K, [F6], [{ finding: "lib/f4.js:4", status: "fixed" }]);
  recordCodeReviewRound(s, K, [F7]);
  recordCodeReviewRound(s, K, [F8]);

  // Round 8: previous non-empty (last round with non-empty previous => V = round 8)
  recordCodeReviewRound(s, K, [F8b, F9], [{ finding: "lib/f7.js:7", status: "fixed" }]);
  // Round 9: repeats F9, adds F10
  recordCodeReviewRound(s, K, [F9, F10], []);
  // Round 10: repeats F10, adds F11
  recordCodeReviewRound(s, K, [F10, F11], []);

  const lines = codeReviewerRoundLines(s, K);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], CODE_REVIEW_VERIFY_LINE);

  const expectedHeader = "Previous findings from all earlier review rounds (verify each):\n";
  assert.equal(lines[1].startsWith(expectedHeader), true);

  // Exact N = 8 distinct findings in rounds 1-7; exact round numbers (rounds 1-7) and round 8
  const expectedLine =
    "8 earlier findings (rounds 1-7) were already verified in round 8; do not re-check them unless this revision touched their lines.";
  assert.equal(lines[1].includes(expectedLine), true);

  // Line must appear first right after header
  assert.equal(lines[1].startsWith(`${expectedHeader}${expectedLine}`), true);

  // Only rounds 8..10 listed
  for (let r = 1; r <= 7; r++) {
    assert.equal(lines[1].includes(`Round ${r}:`), false);
  }
  assert.equal(lines[1].includes("Round 8:"), true);
  assert.equal(lines[1].includes("Round 9:"), true);
  assert.equal(lines[1].includes("Round 10:"), true);

  // Findings from rounds 1-7 not listed
  assert.equal(lines[1].includes(F1), false);
  assert.equal(lines[1].includes(F2), false);
  assert.equal(lines[1].includes(F3), false);
  assert.equal(lines[1].includes(F4), false);
  assert.equal(lines[1].includes(F5), false);
  assert.equal(lines[1].includes(F6), false);
  assert.equal(lines[1].includes(F7), false);
  assert.equal(lines[1].includes(F8), false);

  // Deduped across rounds 8..10: each listed once
  assert.equal(countOccurrences(lines[1], F8b), 1);
  assert.equal(countOccurrences(lines[1], F9), 1);
  assert.equal(countOccurrences(lines[1], F10), 1);
  assert.equal(countOccurrences(lines[1], F11), 1);
}

// ── 5. Plan Review: no previous anywhere → all rounds deduped ─────────────────
{
  const s = {};
  const K = "test-plan-noprev";

  const F1 = "TASKS.md:1 dup problem";
  const F2 = "TASKS.md:2 shared problem";
  const F3 = "TASKS.md:3 another problem";
  const F4 = "TASKS.md:4 latest problem";

  recordPlanReviewRound(s, K, [F1, F2], []);
  recordPlanReviewRound(s, K, [F2, F3], []);
  recordPlanReviewRound(s, K, [F3, F4], []);

  const lines = planReviewerRoundLines(s, K);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], PLAN_REVIEW_VERIFY_LINE);

  // No verified line since no previous anywhere
  assert.equal(lines[1].includes("were already verified in round"), false);

  // All 3 rounds listed
  assert.equal(lines[1].includes("Round 1:"), true);
  assert.equal(lines[1].includes("Round 2:"), true);
  assert.equal(lines[1].includes("Round 3:"), true);

  // Deduped: each finding appears exactly once
  assert.equal(countOccurrences(lines[1], F1), 1);
  assert.equal(countOccurrences(lines[1], F2), 1);
  assert.equal(countOccurrences(lines[1], F3), 1);
  assert.equal(countOccurrences(lines[1], F4), 1);

  // F2 kept in Round 2, F3 kept in Round 3
  const r1Block = lines[1].slice(lines[1].indexOf("Round 1:"), lines[1].indexOf("Round 2:"));
  assert.equal(r1Block.includes(F1), true);
  assert.equal(r1Block.includes(F2), false);

  const r2Block = lines[1].slice(lines[1].indexOf("Round 2:"), lines[1].indexOf("Round 3:"));
  assert.equal(r2Block.includes(F2), true);
  assert.equal(r2Block.includes(F3), false);

  const r3Block = lines[1].slice(lines[1].indexOf("Round 3:"));
  assert.equal(r3Block.includes(F3), true);
  assert.equal(r3Block.includes(F4), true);
}

// ── 6. Code Review: no previous anywhere → all rounds deduped ─────────────────
{
  const s = {};
  const K = "phase:noprev";

  const F1 = "src/a.js:1 bug";
  const F2 = "src/b.js:2 bug";
  const F3 = "src/c.js:3 bug";
  const F4 = "src/d.js:4 bug";

  recordCodeReviewRound(s, K, [F1, F2], []);
  recordCodeReviewRound(s, K, [F2, F3], []);
  recordCodeReviewRound(s, K, [F3, F4], []);

  const lines = codeReviewerRoundLines(s, K);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], CODE_REVIEW_VERIFY_LINE);

  // No verified line since no previous anywhere
  assert.equal(lines[1].includes("were already verified in round"), false);

  // All 3 rounds listed
  assert.equal(lines[1].includes("Round 1:"), true);
  assert.equal(lines[1].includes("Round 2:"), true);
  assert.equal(lines[1].includes("Round 3:"), true);

  // Deduped: each finding appears exactly once
  assert.equal(countOccurrences(lines[1], F1), 1);
  assert.equal(countOccurrences(lines[1], F2), 1);
  assert.equal(countOccurrences(lines[1], F3), 1);
  assert.equal(countOccurrences(lines[1], F4), 1);
}

console.log("ALL CHECKS PASSED in test-review-rounds-scoped-dedupe.mjs");
