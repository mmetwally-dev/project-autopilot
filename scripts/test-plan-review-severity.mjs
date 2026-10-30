#!/usr/bin/env node
// Backlog #8: a plan review may FAIL only on BLOCKING problems. MINOR points
// (line anchors, wording, cross-reference nits, nice-to-have coverage) ride
// along as "notes" and never fail the round, so a fresh full re-check cannot
// keep looping on cosmetic findings.
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  PLAN_REVIEW_SEVERITY_LINE, PLAN_REVIEW_EXHAUSTIVE_LINE, PLAN_REVIEW_VERIFY_LINE,
  PLAN_REVIEW_CONFIRMATION_LINE, PLAN_REVIEW_FULL_LINE,
  planReviewerRoundLines, planReviewerConfirmationLines, recordPlanReviewRound,
  recordPlanReviewNotes, planReviewNotes, planReviewNotesText, clearPlanReviewHistory,
} from "./plan-review-rounds.mjs";
import { parseReviewContract } from "./failure-contract.mjs";

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${detail ?? ""}`}`);
  if (!ok) failed++;
};
const K = "standalone-plan";
const hasSeverityRule = (text) =>
  text.includes(PLAN_REVIEW_SEVERITY_LINE)
  && /BLOCKING/.test(text)
  && /MINOR/.test(text)
  && /"notes"/.test(text);

check("the shared severity rule names BLOCKING and MINOR and the notes field",
  hasSeverityRule(PLAN_REVIEW_SEVERITY_LINE));
check("round-1 exhaustive brief carries the severity rule",
  hasSeverityRule(planReviewerRoundLines({}, K).join("\n")) && PLAN_REVIEW_EXHAUSTIVE_LINE.includes(PLAN_REVIEW_SEVERITY_LINE));
check("later-round verify brief carries the severity rule",
  hasSeverityRule(PLAN_REVIEW_VERIFY_LINE) && PLAN_REVIEW_VERIFY_LINE.includes(PLAN_REVIEW_SEVERITY_LINE)
  && /"previous"/.test(PLAN_REVIEW_VERIFY_LINE));
check("confirmation brief carries the severity rule",
  hasSeverityRule(PLAN_REVIEW_CONFIRMATION_LINE)
  && hasSeverityRule(planReviewerConfirmationLines().join("\n")));
check("confirmation brief reviews everything but no longer demands every problem",
  /review the whole plan again from scratch/.test(PLAN_REVIEW_CONFIRMATION_LINE)
  && !/EXHAUSTIVE/.test(PLAN_REVIEW_CONFIRMATION_LINE)
  && !/report every problem/.test(PLAN_REVIEW_CONFIRMATION_LINE));
check("convergence-off full brief carries the severity rule", hasSeverityRule(PLAN_REVIEW_FULL_LINE));

// Sentinel: optional notes array (strings) is parsed and kept.
const fail = parseReviewContract('AUTOPILOT_REVIEW={"decision":"FAIL","findings":["wrong API contract"],"notes":["line anchor is off by one","prefer clearer wording"]}');
check("FAIL sentinel with notes parses", fail.verdict.status === "available" && fail.verdict.decision === "FAIL", fail.contract?.error);
check("FAIL sentinel keeps every note", JSON.stringify(fail.verdict.notes) === JSON.stringify(["line anchor is off by one", "prefer clearer wording"]), fail.verdict.notes);
check("FAIL sentinel keeps blocking findings separate", JSON.stringify(fail.verdict.findings) === JSON.stringify(["wrong API contract"]), fail.verdict.findings);

const pass = parseReviewContract('AUTOPILOT_REVIEW={"decision":"PASS","findings":[],"notes":["cross-reference nit"]}');
check("PASS sentinel with notes is still PASS", pass.verdict.decision === "PASS" && pass.verdict.status === "available", pass.verdict);
check("PASS sentinel keeps its notes", JSON.stringify(pass.verdict.notes) === JSON.stringify(["cross-reference nit"]), pass.verdict.notes);

const malformed = parseReviewContract('AUTOPILOT_REVIEW={"decision":"PASS","findings":[],"notes":["ok",{"bad":true},7,""]}');
check("non-string notes are dropped, not crashed", JSON.stringify(malformed.verdict.notes) === JSON.stringify(["ok"]), malformed.verdict.notes);

const missing = parseReviewContract('AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}');
check("missing notes parses as an empty array", Array.isArray(missing.verdict.notes) && missing.verdict.notes.length === 0, missing.verdict.notes);

// Notes are recorded for the next planner revision and cleared with the round state.
const s = {};
recordPlanReviewRound(s, K, ["blocking finding"]);
recordPlanReviewNotes(s, K, ["minor one", "minor two"]);
check("notes are stored per review key", planReviewNotes(s, K).length === 2);
const notesText = planReviewNotesText(s, K);
check("planner notes text is optional and cheap",
  notesText.startsWith("Minor notes (optional, fix if cheap):")
  && notesText.includes("1. minor one") && notesText.includes("2. minor two"), notesText);
recordPlanReviewNotes(s, K, []);
check("a review with no notes clears the old notes", planReviewNotesText(s, K) === "");
recordPlanReviewNotes(s, K, ["again"]);
clearPlanReviewHistory(s, K);
check("clearing the round state clears its notes", planReviewNotesText(s, K) === "");

// Wiring: every plan-review loop records notes and passes them to its planner.
const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
check("standalone reviewer records notes and the planner brief carries them",
  src.includes("recordPlanReviewNotes(s,STANDALONE_PLAN_FEEDBACK_KEY,reviewResult.review?.notes)")
  && src.includes("planReviewNotesText(s,STANDALONE_PLAN_FEEDBACK_KEY)"));
check("SpecKit gate records notes and its planner brief carries them",
  (src.match(/recordPlanReviewNotes\(s,speckitStageFeedbackKey\(gateStage\),rr\.review\?\.notes\)/g) || []).length === 2
  && src.includes("const gateNotes=planReviewNotesText(s,speckitStageFeedbackKey(step))"));
check("GSD review prompt carries the severity rule and revision carries notes",
  src.includes("PLAN_REVIEW_SEVERITY_LINE")
  && src.includes("recordPlanReviewNotes(s,notesKey,rr.review?.notes)")
  && src.includes("planReviewNotesText(s,notesKey)"));

const watch = fs.readFileSync(new URL("./watch-report.mjs", import.meta.url), "utf8");
check("watch report shows the minor-note count for a plan_reviewer", watch.includes("notes: ${notes} minor"));

process.exit(failed ? 1 : 0);
