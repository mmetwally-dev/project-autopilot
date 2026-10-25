// Backlog #100: plan-review round discipline (no hard round limit).
import fs from "node:fs";
import {
  PLAN_REVIEW_EXHAUSTIVE_LINE, PLAN_REVIEW_VERIFY_LINE, PLAN_REVIEW_FULL_LINE,
  planReviewerRoundLines, plannerEarlierRoundsText, recordPlanReviewRound,
  seedPlanReviewHistory, clearPlanReviewHistory, planReviewRoundCount,
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
