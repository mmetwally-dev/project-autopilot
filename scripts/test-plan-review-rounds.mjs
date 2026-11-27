// Backlog #100: plan-review round discipline (no hard round limit).
import fs from "node:fs";
import {
  PLAN_REVIEW_EXHAUSTIVE_LINE, PLAN_REVIEW_VERIFY_LINE, PLAN_REVIEW_FULL_LINE,
  PLAN_REVIEW_CONFIRMATION_LINE,
  planReviewerRoundLines, plannerEarlierRoundsText,
  recordPlanReviewRound, seedPlanReviewHistory, clearPlanReviewHistory, planReviewRoundCount,
  planReviewPassNeedsConfirmation, planReviewConfirmationPending, planReviewConfirmationFailed,
  markPlanReviewConfirmationPending, markPlanReviewConfirmationFailed, clearPlanReviewConfirmation,
  isFullPlanReviewRound,
} from "./plan-review-rounds.mjs";

let failed = 0;
const check = (name, ok) => { console.log(`${ok ? "PASS" : "FAIL"} ${name}`); if (!ok) failed++; };
const K = "standalone-plan";
const s = {};

// Round 1: exhaustive instruction, no previous findings.
const r1 = planReviewerRoundLines(s, K).join("\n");
check("round-1 brief has the exhaustive instruction", r1.includes(PLAN_REVIEW_EXHAUSTIVE_LINE) && /every problem/.test(r1) && /Later rounds will only verify/.test(r1));
check("round-1 brief has no verify rule", !r1.includes(PLAN_REVIEW_VERIFY_LINE));

recordPlanReviewRound(s, K, ["TASKS.md 1.1: alpha problem. Required correction: fix alpha"]);
recordPlanReviewRound(s, K, [{location: "PLAN.md Scope 2", problem: "beta problem", correction: "fix beta"}]);
check("two rounds recorded", planReviewRoundCount(s, K) === 2);

// Round 2+: verify-then-new-only-if rule, previous findings listed.
const r3 = planReviewerRoundLines(s, K).join("\n");
check("round-2+ brief lists all previous findings", r3.includes("alpha problem") && r3.includes("beta problem"));
check("round-2+ brief has verify + new-only-if rule", r3.includes(PLAN_REVIEW_VERIFY_LINE) && /introduced/.test(r3) && /actually break execution/.test(r3));
check("round-2+ brief drops the exhaustive line", !r3.includes(PLAN_REVIEW_EXHAUSTIVE_LINE));

// Planner revision brief: cumulative earlier rounds (round 3 findings are the "current" feedback).
recordPlanReviewRound(s, K, ["TASKS.md 3.1: gamma problem"]);
const pl = plannerEarlierRoundsText(s, K);
check("planner brief contains rounds 1 and 2 findings", pl.includes("alpha problem") && pl.includes("beta problem") && /Round 1/.test(pl) && /Round 2/.test(pl));
check("planner brief leaves latest round to the feedback block", !pl.includes("gamma problem"));
check("no earlier rounds -> empty planner text", plannerEarlierRoundsText({}, K) === "");

// Convergence enabled explicitly (and by default) keeps today's behaviour.
check("explicit convergence keeps round-1 brief unchanged", planReviewerRoundLines({}, K, true).join("\n") === planReviewerRoundLines({}, K).join("\n") && planReviewerRoundLines({}, K, true).join("\n").includes(PLAN_REVIEW_EXHAUSTIVE_LINE));
check("explicit convergence keeps round-2+ brief unchanged", planReviewerRoundLines(s, K, true).join("\n") === planReviewerRoundLines(s, K).join("\n") && planReviewerRoundLines(s, K, true).join("\n").includes(PLAN_REVIEW_VERIFY_LINE));
check("explicit convergence keeps planner carry-over", plannerEarlierRoundsText(s, K, true) === plannerEarlierRoundsText(s, K) && plannerEarlierRoundsText(s, K, true).includes("alpha problem"));

// Convergence disabled: full-plan re-review every round, no convergence-only lines.
const sFull = {};
const full1 = planReviewerRoundLines(sFull, K, false).join("\n");
recordPlanReviewRound(sFull, K, ["divergent finding"]);
const full2 = planReviewerRoundLines(sFull, K, false).join("\n");
check("convergence off: full-review line on rounds 1 and 2", full1.includes(PLAN_REVIEW_FULL_LINE) && full2.includes(PLAN_REVIEW_FULL_LINE));
check("convergence off: no exhaustive or verify-only lines", !full1.includes(PLAN_REVIEW_EXHAUSTIVE_LINE) && !full2.includes(PLAN_REVIEW_EXHAUSTIVE_LINE) && !full1.includes(PLAN_REVIEW_VERIFY_LINE) && !full2.includes(PLAN_REVIEW_VERIFY_LINE));
check("convergence off: empty planner carry-over", plannerEarlierRoundsText(sFull, K, false) === "");

// Seed from legacy resume state only when empty.
const s2 = {};
seedPlanReviewHistory(s2, K, ["legacy finding"]);
seedPlanReviewHistory(s2, K, ["other"]);
check("seed records once", planReviewRoundCount(s2, K) === 1);

// Backlog #8: every full round must list all blocking problems at once.
check("round-1 brief asks for the whole plan in one round",
  /go through the WHOLE plan/.test(PLAN_REVIEW_EXHAUSTIVE_LINE)
  && /not one batch at a time/.test(PLAN_REVIEW_EXHAUSTIVE_LINE));
check("full brief demands every blocking problem in one round",
  /go through the WHOLE plan/.test(PLAN_REVIEW_FULL_LINE)
  && /EVERY blocking problem in this one round/.test(PLAN_REVIEW_FULL_LINE)
  && /not one batch at a time/.test(PLAN_REVIEW_FULL_LINE));
check("confirmation brief demands every blocking problem in one round",
  /go through the WHOLE plan/.test(PLAN_REVIEW_CONFIRMATION_LINE)
  && /EVERY blocking problem in this one round/.test(PLAN_REVIEW_CONFIRMATION_LINE)
  && /not one batch at a time/.test(PLAN_REVIEW_CONFIRMATION_LINE));
check("full and confirmation say a later full round raising unchanged text means this round missed it",
  [PLAN_REVIEW_FULL_LINE, PLAN_REVIEW_CONFIRMATION_LINE].every(t => /later full round/.test(t) && /unchanged since this round means this round missed it/.test(t)));
check("full and confirmation keep findings BLOCKING-only and send minor points to notes",
  [PLAN_REVIEW_FULL_LINE, PLAN_REVIEW_CONFIRMATION_LINE].every(t => /only BLOCKING problems in "findings"/.test(t) && /do not pad them with small issues/.test(t) && /minor points in "notes"/.test(t)));
check("verify brief checks the fix text itself, not just old-finding status",
  /re-read the section\(s\) the revision changed to fix it/.test(PLAN_REVIEW_VERIFY_LINE)
  && /check the new text is itself correct and complete/.test(PLAN_REVIEW_VERIFY_LINE)
  && /A defect in the fix text is a NEW finding introduced by this revision/.test(PLAN_REVIEW_VERIFY_LINE));
check("verify brief still does not re-review unchanged parts",
  /do not re-review the unchanged parts of the plan/.test(PLAN_REVIEW_VERIFY_LINE)
  && /"previous"/.test(PLAN_REVIEW_VERIFY_LINE));

// Backlog #8: after a confirmation FAIL every later round is a FULL review
// that also lists the previous findings; its PASS needs no confirmation.
{
  const cf = {};
  const CFK = "standalone-plan-cf";
  recordPlanReviewRound(cf, CFK, ["PLAN.md Scope 2: confirmation finding alpha"]);
  markPlanReviewConfirmationPending(cf, CFK);
  check("confirmation-pending marker is set", planReviewConfirmationPending(cf, CFK) === true);
  markPlanReviewConfirmationFailed(cf, CFK);
  check("a failed confirmation clears the pending marker and sets the failed marker",
    planReviewConfirmationPending(cf, CFK) === false && planReviewConfirmationFailed(cf, CFK) === true);
  const reloaded = JSON.parse(JSON.stringify(cf));
  check("the confirmation-failed marker survives a state save/load", planReviewConfirmationFailed(reloaded, CFK) === true);
  const full = planReviewerRoundLines(reloaded, CFK);
  check("after a confirmation FAIL the next brief is the full line plus previous findings",
    full[0] === PLAN_REVIEW_FULL_LINE && isFullPlanReviewRound(full)
    && full.join("\n").includes("Previous findings from all earlier review rounds")
    && full.join("\n").includes("confirmation finding alpha"));
  check("after a confirmation FAIL the full brief also asks to verify each previous finding",
    full.join("\n").includes('"previous"') && full.join("\n").includes("Also verify each previous finding"));
  check("a PASS after a confirmation FAIL is accepted without another confirmation",
    planReviewPassNeedsConfirmation(reloaded, CFK) === false);
  clearPlanReviewConfirmation(reloaded, CFK);
  check("clearPlanReviewConfirmation clears only the pending marker", planReviewConfirmationFailed(reloaded, CFK) === true);
  clearPlanReviewHistory(reloaded, CFK);
  check("clearing the key clears both confirmation markers",
    planReviewConfirmationFailed(reloaded, CFK) === false && planReviewConfirmationPending(reloaded, CFK) === false);
  check("a cleared key asks for the exhaustive first review again",
    planReviewerRoundLines(reloaded, CFK)[0] === PLAN_REVIEW_EXHAUSTIVE_LINE);
}

// Convergence off: the confirmation failure marker changes nothing (never set
// there, and a full round is already the brief).
{
  const sOffCf = {};
  recordPlanReviewRound(sOffCf, K, ["off finding"]);
  markPlanReviewConfirmationFailed(sOffCf, K);
  check("convergence off ignores the confirmation-failed marker",
    planReviewerRoundLines(sOffCf, K, false)[0] === PLAN_REVIEW_FULL_LINE
    && !planReviewerRoundLines(sOffCf, K, false).includes("Previous findings"));
  check("convergence off never needs a confirmation",
    planReviewPassNeedsConfirmation(sOffCf, K, false) === false);
}

// PASS clears the key; unrelated keys survive.
recordPlanReviewRound(s, "speckit-stage:plan", ["x"]);
clearPlanReviewHistory(s, K);
check("PASS clears the plan key only", planReviewRoundCount(s, K) === 0 && planReviewRoundCount(s, "speckit-stage:plan") === 1);

// Wiring (source-anchored).
const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
check("new mission clears the cumulative list", src.includes("delete s.reviewFeedback;\n    delete s.planReviewHistory;"));
check("standalone reviewer + planner briefs use the round helpers",
  src.includes("...planReviewerRoundLines(s,STANDALONE_PLAN_FEEDBACK_KEY,c.workflow?.plan_review_convergence!==false)") && src.includes("plannerEarlierRoundsText(s,STANDALONE_PLAN_FEEDBACK_KEY,c.workflow?.plan_review_convergence!==false)"));
check("standalone records both deterministic and reviewer FAIL rounds",
  (src.match(/recordPlanReviewRound\(s,STANDALONE_PLAN_FEEDBACK_KEY/g) || []).length === 2);
check("speckit gate uses round helpers and records both rounds",
  (src.match(/recordPlanReviewRound\(s,speckitStageFeedbackKey\(gateStage\)/g) || []).length === 2
  && (src.match(/planReviewerRoundLines\(s,speckitStageFeedbackKey\(gateStage\),c\.workflow\?\.plan_review_convergence!==false\)/g) || []).length === 2
  && src.includes("plannerEarlierRoundsText(s,speckitStageFeedbackKey(step),c.workflow?.plan_review_convergence!==false)"));

process.exit(failed ? 1 : 0);
