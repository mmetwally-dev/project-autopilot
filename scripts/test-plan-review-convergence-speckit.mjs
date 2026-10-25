// Backlog #16: SpecKit planning must honour workflow.plan_review_convergence,
// exactly like the standalone path. With convergence disabled (false) each
// plan-review round is a full-plan re-review and the planner gets no
// earlier-round carry-over. The flag defaults to enabled.
import fs from "node:fs";
import {
  PLAN_REVIEW_EXHAUSTIVE_LINE, PLAN_REVIEW_VERIFY_LINE, PLAN_REVIEW_FULL_LINE,
  planReviewerRoundLines, plannerEarlierRoundsText, recordPlanReviewRound,
} from "./plan-review-rounds.mjs";

let failed = 0;
const check = (name, ok) => { console.log(`${ok ? "PASS" : "FAIL"} ${name}`); if (!ok) failed++; };
const K = "speckit-gate";
const FLAG = "c.workflow?.plan_review_convergence!==false";

// Default (undefined flag) keeps convergence enabled.
const sDefault = {};
recordPlanReviewRound(sDefault, K, ["TASKS.md 1.1: alpha. Required correction: fix alpha"]);
check("undefined flag (default) keeps exhaustive round 1", planReviewerRoundLines({}, K, undefined).join("\n").includes(PLAN_REVIEW_EXHAUSTIVE_LINE));
check("undefined flag (default) keeps verify round 2+", planReviewerRoundLines(sDefault, K, undefined).join("\n").includes(PLAN_REVIEW_VERIFY_LINE));
check("undefined flag (default) keeps planner carry-over", plannerEarlierRoundsText({ ...sDefault, planReviewHistory: { [K]: [{ round: 1, findings: ["old"] }, { round: 2, findings: ["current"] }] } }, K, undefined).includes("old"));

// Explicit true behaves like the default.
check("true keeps convergence round-1 brief", planReviewerRoundLines({}, K, true).join("\n") === planReviewerRoundLines({}, K).join("\n"));
check("true keeps planner carry-over", plannerEarlierRoundsText(sDefault, K, true) === plannerEarlierRoundsText(sDefault, K));

// Convergence false: full-plan re-review on every round, no earlier-round carry-over.
const sOff = {};
const off1 = planReviewerRoundLines(sOff, K, false).join("\n");
recordPlanReviewRound(sOff, K, ["divergent finding"]);
recordPlanReviewRound(sOff, K, ["another finding"]);
const off3 = planReviewerRoundLines(sOff, K, false).join("\n");
check("convergence off: full-plan line on round 1", off1.includes(PLAN_REVIEW_FULL_LINE));
check("convergence off: full-plan line on later rounds", off3.includes(PLAN_REVIEW_FULL_LINE));
check("convergence off: no exhaustive-only line", !off3.includes(PLAN_REVIEW_EXHAUSTIVE_LINE));
check("convergence off: no verify-only line and no prior findings", !off3.includes(PLAN_REVIEW_VERIFY_LINE) && !off3.includes("divergent finding") && !off3.includes("another finding"));
check("convergence off: planner carry-over omitted", plannerEarlierRoundsText(sOff, K, false) === "");

// Wiring (source-anchored): the SpecKit reviewer (initial + re-review) and the
// revising planner all receive the workflow convergence flag.
const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
const reviewerCall = `planReviewerRoundLines(s,speckitStageFeedbackKey(gateStage),${FLAG}).join("\\n")`;
const plannerCall = `plannerEarlierRoundsText(s,speckitStageFeedbackKey(step),${FLAG})`;
const count = (needle) => src.split(needle).length - 1;
check("SpecKit initial review passes the workflow convergence flag", count(reviewerCall) === 2);
check("SpecKit planner passes the workflow convergence flag", count(plannerCall) === 1);
check("no SpecKit reviewer call remains unflagged",
  !src.includes(`planReviewerRoundLines(s,speckitStageFeedbackKey(gateStage)).join`));
check("no SpecKit planner call remains unflagged",
  !src.includes(`plannerEarlierRoundsText(s,speckitStageFeedbackKey(step))`));

// The GSD native path keeps its own unchanged wiring: it reads the flag from
// the native .planning/config.json workflow and gates plan review once.
check("GSD native path unchanged",
  src.includes("const planReviewEnabled=workflow.plan_review_convergence!==false && c.workflow?.planReview!==false && c.workflow?.gsdPlanningReview!==false && localPlanningReview.enabled!==false;"));

process.exit(failed ? 1 : 0);
