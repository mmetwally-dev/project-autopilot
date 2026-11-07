#!/usr/bin/env node
// Backlog #4: unapplied minor notes from PASSing plan-review rounds are carried
// over in state.planPassNotes, included in the first implementer brief of each
// phase, rendered in the final report under "Plan-review notes not applied",
// and cleared on mission reset.
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  recordPlanPassNotes, planPassNotes, allPlanPassNotes, planPassNotesText,
  clearPlanPassNotes, clearPlanReviewHistory, recordPlanReviewNotes, planReviewNotes,
  firstTaskPassNotes, firstGsdUnitPassNotes
} from "./plan-review-rounds.mjs";
import { buildReportModel, renderReport, renderPlanPassNotes } from "./watch-report.mjs";

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${detail ?? ""}`}`);
  if (!ok) failed++;
};

const STANDALONE_KEY = "standalone-plan";
const SPECKIT_KEY = "speckit-plan";
const GSD_KEY = "gsd-plan-review:discuss:1";
const GSD_FINAL_KEY = "gsd-plan-review:plan-check:1";

// ---------------------------------------------------------------------------
// 1. Notes carried over on PASS (per key) for standalone, SpecKit, and GSD
// ---------------------------------------------------------------------------
const s = {};
recordPlanPassNotes(s, STANDALONE_KEY, ["standalone anchor nit", "reword section 2"]);
recordPlanPassNotes(s, SPECKIT_KEY, ["speckit edge case clarification"]);
recordPlanPassNotes(s, GSD_KEY, ["gsd architecture note"]);
recordPlanPassNotes(s, GSD_FINAL_KEY, ["gsd final plan-check nit"]);

check("standalone notes stored under standalone key",
  JSON.stringify(planPassNotes(s, STANDALONE_KEY)) === JSON.stringify(["standalone anchor nit", "reword section 2"]),
  planPassNotes(s, STANDALONE_KEY));

check("SpecKit notes stored under SpecKit key",
  JSON.stringify(planPassNotes(s, SPECKIT_KEY)) === JSON.stringify(["speckit edge case clarification"]),
  planPassNotes(s, SPECKIT_KEY));

check("GSD stage notes stored under GSD stage key",
  JSON.stringify(planPassNotes(s, GSD_KEY)) === JSON.stringify(["gsd architecture note"]),
  planPassNotes(s, GSD_KEY));

check("GSD plan-check notes stored under GSD plan-check key",
  JSON.stringify(planPassNotes(s, GSD_FINAL_KEY)) === JSON.stringify(["gsd final plan-check nit"]),
  planPassNotes(s, GSD_FINAL_KEY));

const allNotes = allPlanPassNotes(s);
check("allPlanPassNotes aggregates notes across all keys",
  allNotes.length === 5
  && allNotes.includes("standalone anchor nit")
  && allNotes.includes("speckit edge case clarification")
  && allNotes.includes("gsd architecture note")
  && allNotes.includes("gsd final plan-check nit"),
  allNotes);

// PASS round preserves planPassNotes while clearPlanReviewHistory clears planReviewNotes
recordPlanReviewNotes(s, STANDALONE_KEY, ["fail note that planner already resolved"]);
check("planReviewNotes holds fail round note",
  planReviewNotes(s, STANDALONE_KEY).length === 1);
clearPlanReviewHistory(s, STANDALONE_KEY);
check("clearPlanReviewHistory on PASS clears planReviewNotes",
  planReviewNotes(s, STANDALONE_KEY).length === 0);
check("clearPlanReviewHistory on PASS preserves planPassNotes (carried over on PASS)",
  JSON.stringify(planPassNotes(s, STANDALONE_KEY)) === JSON.stringify(["standalone anchor nit", "reword section 2"]),
  planPassNotes(s, STANDALONE_KEY));

// Non-string or empty notes sanitized
const dirtyState = {};
recordPlanPassNotes(dirtyState, STANDALONE_KEY, ["valid note", 123, null, "", { nit: true }]);
check("non-string and empty notes are filtered out",
  JSON.stringify(planPassNotes(dirtyState, STANDALONE_KEY)) === JSON.stringify(["valid note"]),
  planPassNotes(dirtyState, STANDALONE_KEY));

// clearPlanPassNotes per-key and all
clearPlanPassNotes(s, SPECKIT_KEY);
check("clearPlanPassNotes per key clears only that key",
  planPassNotes(s, SPECKIT_KEY).length === 0 && planPassNotes(s, STANDALONE_KEY).length === 2);
clearPlanPassNotes(s);
check("clearPlanPassNotes without key clears all pass notes",
  allPlanPassNotes(s).length === 0 && !s.planPassNotes);

// ---------------------------------------------------------------------------
// 2. Formatting of planPassNotesText
// ---------------------------------------------------------------------------
const fmtState = {};
recordPlanPassNotes(fmtState, STANDALONE_KEY, ["anchor nit", "docstring typo"]);
const formattedText = planPassNotesText(fmtState);
check("planPassNotesText formatting matches optional text header and numbered list",
  formattedText.startsWith("Plan-review notes (optional — consider them only when they touch your task):\n")
  && formattedText.includes("1. anchor nit\n2. docstring typo"),
  formattedText);

check("planPassNotesText with empty notes returns empty string",
  planPassNotesText({}) === "");

// ---------------------------------------------------------------------------
// 3. First implementer brief contains notes; later task or retry does not
// ---------------------------------------------------------------------------
const phaseState = {};
recordPlanPassNotes(phaseState, STANDALONE_KEY, ["keep function signature backwards compatible"]);

const firstTaskBriefNotes = firstTaskPassNotes(phaseState, {
  taskIndex: 0,
  attempts: 0,
  completedTaskIds: []
});
check("first task brief of phase contains plan pass notes",
  firstTaskBriefNotes.includes("Plan-review notes (optional — consider them only when they touch your task):")
  && firstTaskBriefNotes.includes("1. keep function signature backwards compatible"),
  firstTaskBriefNotes);

const laterTaskBriefNotes = firstTaskPassNotes(phaseState, {
  taskIndex: 1,
  attempts: 0,
  completedTaskIds: ["task-0"]
});
check("later task brief in phase does NOT contain plan pass notes",
  laterTaskBriefNotes === "");

const retryTaskBriefNotes = firstTaskPassNotes(phaseState, {
  taskIndex: 0,
  attempts: 1,
  completedTaskIds: []
});
check("task retry brief does NOT contain plan pass notes",
  retryTaskBriefNotes === "");

// GSD: phase 1 vs phase 2 notes isolation, plus later unit / retry
const gsdState = {};
recordPlanPassNotes(gsdState, "gsd-plan-review:discuss:1", ["phase 1 note"]);
recordPlanPassNotes(gsdState, "gsd-plan-review:discuss:2", ["phase 2 note"]);

const gsdPhase1Notes = firstGsdUnitPassNotes(gsdState, 1, { isFirstOfPhase: true, attempt: 1 });
check("GSD phase 1 first unit contains phase 1 notes",
  gsdPhase1Notes.includes("phase 1 note") && !gsdPhase1Notes.includes("phase 2 note"),
  gsdPhase1Notes);

const gsdPhase2Notes = firstGsdUnitPassNotes(gsdState, 2, { isFirstOfPhase: true, attempt: 1 });
check("GSD phase 2 brief does NOT contain phase 1's notes",
  gsdPhase2Notes.includes("phase 2 note") && !gsdPhase2Notes.includes("phase 1 note"),
  gsdPhase2Notes);

const gsdLaterUnitBriefNotes = firstGsdUnitPassNotes(gsdState, 1, { isFirstOfPhase: false, attempt: 1 });
check("GSD later plan unit brief does NOT contain plan pass notes",
  gsdLaterUnitBriefNotes === "");

const gsdRetryBriefNotes = firstGsdUnitPassNotes(gsdState, 1, { isFirstOfPhase: true, attempt: 2 });
check("GSD retry brief does NOT contain plan pass notes",
  gsdRetryBriefNotes === "");

// ---------------------------------------------------------------------------
// 4. Final report lists notes under "Plan-review notes not applied"
// ---------------------------------------------------------------------------
const reportState = {
  command: "ap run",
  phase: "complete",
  step: "human_commit",
  planPassNotes: {
    [STANDALONE_KEY]: ["unapplied minor point 1"],
    [SPECKIT_KEY]: ["unapplied minor point 2"]
  }
};

const modelWithNotes = buildReportModel({ state: reportState });
check("buildReportModel carries planPassNotes into the report model",
  Array.isArray(modelWithNotes.planPassNotes)
  && modelWithNotes.planPassNotes.some((e) => (e.text || e) === "unapplied minor point 1")
  && modelWithNotes.planPassNotes.some((e) => (e.text || e) === "unapplied minor point 2"),
  modelWithNotes.planPassNotes);

const renderedNotesSection = renderPlanPassNotes(modelWithNotes);
check("renderPlanPassNotes renders heading and numbered list",
  renderedNotesSection.startsWith("=== Plan-review notes ===\n")
  && renderedNotesSection.includes("1. unapplied minor point 1")
  && renderedNotesSection.includes("2. unapplied minor point 2"),
  renderedNotesSection);

const fullReport = renderReport(modelWithNotes);
check("renderReport includes '=== Plan-review notes ===' section",
  fullReport.includes("=== Plan-review notes ===")
  && fullReport.includes("1. unapplied minor point 1")
  && fullReport.includes("2. unapplied minor point 2"));

// No section when there are no notes
const emptyReportModel = buildReportModel({ state: { command: "ap run", phase: "complete" } });
check("renderPlanPassNotes returns empty string when model has no notes",
  renderPlanPassNotes(emptyReportModel) === "");

const emptyFullReport = renderReport(emptyReportModel);
check("renderReport omits 'Plan-review notes' heading when no notes",
  !emptyFullReport.includes("Plan-review notes"));

// ---------------------------------------------------------------------------
// 5. Wiring assertions in autopilot.mjs
// ---------------------------------------------------------------------------
const apSrc = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");

check("autopilot imports planPassNotes helpers",
  apSrc.includes("recordPlanPassNotes")
  && apSrc.includes("firstTaskPassNotes")
  && apSrc.includes("firstGsdUnitPassNotes")
  && apSrc.includes("allPlanPassNotes"));

check("standalone PASS records planPassNotes",
  apSrc.includes("recordPlanPassNotes(s,STANDALONE_PLAN_FEEDBACK_KEY,reviewResult.review?.notes)"));

check("SpecKit PASS records planPassNotes",
  (apSrc.match(/recordPlanPassNotes\(s,speckitStageFeedbackKey\(gateStage\),rr\.review\?\.notes\)/g) || []).length >= 1);

check("GSD stage PASS records planPassNotes",
  apSrc.includes("recordPlanPassNotes(s,notesKey,rr.review?.notes)"));

check("GSD plan-check PASS records planPassNotes",
  apSrc.includes("recordPlanPassNotes(s,finalNotesKey,finalReview.review?.notes)"));

check("standalone implementer brief appends passNotes on first task of phase",
  apSrc.includes("const passNotes=firstTaskPassNotes(s,{taskIndex,attempts:checkpoint?.attempts?.implementer??0,completedTaskIds:checkpoint?.roleProgress?.implementer?.completedTaskIds});"));

check("SpecKit implementer brief appends passNotes on first task of phase",
  apSrc.includes("const passNotes=firstTaskPassNotes(s,{taskIndex,attempts:checkpoint?.attempts?.implementer??0,completedTaskIds:checkpoint?.roleProgress?.implementer?.completedTaskIds});"));

check("GSD implementer brief receives passNotes for first unit of phase attempt 1",
  apSrc.includes("const passNotes=firstGsdUnitPassNotes(localState,phase,{isFirstOfPhase,attempt});"));

check("mission reset clears planPassNotes alongside planReviewNotes",
  apSrc.includes("delete s.planReviewNotes;\n    delete s.planPassNotes;"));

check("finalizeMissionComplete calls reportPlanPassNotes",
  apSrc.includes("reportPlanPassNotes(s);"));

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (failed) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll plan-pass-notes checks passed.");
  process.exit(0);
}
