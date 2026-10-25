// Backlog #16: standalone planning must honour workflow.plan_review_convergence.
// With convergence disabled (false) every round is a full-plan re-review and the
// planner gets no earlier-round carry-over. The flag defaults to enabled.
import fs from "node:fs";
import {
  PLAN_REVIEW_EXHAUSTIVE_LINE, PLAN_REVIEW_VERIFY_LINE, PLAN_REVIEW_FULL_LINE,
  planReviewerRoundLines, plannerEarlierRoundsText, recordPlanReviewRound,
} from "./plan-review-rounds.mjs";

let failed = 0;
const check = (name, ok) => { console.log(`${ok ? "PASS" : "FAIL"} ${name}`); if (!ok) failed++; };
const K = "standalone-plan";
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

// Wiring (source-anchored): both standalone helpers receive the workflow flag.
const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
check("standalone reviewer passes the workflow convergence flag",
  src.includes(`...planReviewerRoundLines(s,STANDALONE_PLAN_FEEDBACK_KEY,${FLAG})`));
check("standalone planner passes the workflow convergence flag",
  src.includes(`plannerEarlierRoundsText(s,STANDALONE_PLAN_FEEDBACK_KEY,${FLAG})`));

process.exit(failed ? 1 : 0);
