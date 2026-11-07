#!/usr/bin/env node
// Backlog #12: Plan-review pass notes tracking with stable status map,
// marking done/skipped, open notes in implementer briefs, and review decisions.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  recordPlanPassNotes,
  allPlanPassNotes,
  planPassNoteEntries,
  markPlanPassNote,
  parsePlanPassNoteMarks,
  applyPlanPassNoteMarks,
  planPassNotesText,
  phaseCodeReviewPassNotesText,
  finalReviewPassNotesText,
  clearPlanPassNotes,
  formatPlanPassNotesLines,
} from "./plan-review-rounds.mjs";
import { buildReportModel, renderReport, renderPlanPassNotes } from "./watch-report.mjs";
import { reportPlanPassNotes } from "./autopilot.mjs";

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${detail ?? ""}`}`);
  if (!ok) failed++;
};

// ---------------------------------------------------------------------------
// 1. Parsing lines: all forms, case-insensitivity, dash variants, backticks
// ---------------------------------------------------------------------------
const sampleReviewText = `
Here is my review:
PASS-NOTE 1: applied
pass-note 2: applied
PASS-NOTE 3: APPLIED
PASS-NOTE 4: skipped — obsolete after schema redesign
pass-note 5: skipped - redundant with existing unit test
Pass-Note 6: skipped : not feasible in this architecture
PASS-NOTE 7: skipped – using en-dash
\`PASS-NOTE 8: applied\`
\`PASS-NOTE 9: skipped — backtick wrapped\`
Random line with PASS-NOTE 10: applied inside prose should not match if not a line marker
PASS-NOTE abc: applied
PASS-NOTE 11: skipped without reason
`;

const parsedMarks = parsePlanPassNoteMarks(sampleReviewText);
check("parsePlanPassNoteMarks parses applied lines (standard and case-insensitive)",
  parsedMarks.some((m) => m.n === 1 && m.status === "done")
  && parsedMarks.some((m) => m.n === 2 && m.status === "done")
  && parsedMarks.some((m) => m.n === 3 && m.status === "done")
  && parsedMarks.some((m) => m.n === 8 && m.status === "done"));

check("parsePlanPassNoteMarks parses skipped lines with em-dash (—)",
  parsedMarks.some((m) => m.n === 4 && m.status === "skipped" && m.reason === "obsolete after schema redesign"));

check("parsePlanPassNoteMarks parses skipped lines with hyphen (-)",
  parsedMarks.some((m) => m.n === 5 && m.status === "skipped" && m.reason === "redundant with existing unit test"));

check("parsePlanPassNoteMarks parses skipped lines with colon (:)",
  parsedMarks.some((m) => m.n === 6 && m.status === "skipped" && m.reason === "not feasible in this architecture"));

check("parsePlanPassNoteMarks parses skipped lines with en-dash (–)",
  parsedMarks.some((m) => m.n === 7 && m.status === "skipped" && m.reason === "using en-dash"));

check("parsePlanPassNoteMarks parses backtick-wrapped skipped lines",
  parsedMarks.some((m) => m.n === 9 && m.status === "skipped" && m.reason === "backtick wrapped"));

check("parsePlanPassNoteMarks rejects skipped lines without reason or invalid n",
  !parsedMarks.some((m) => m.n === 11) && !parsedMarks.some((m) => isNaN(m.n)));

// ---------------------------------------------------------------------------
// 2. Marking notes: unknown n ignored, reason required for skipped, numbering stable
// ---------------------------------------------------------------------------
const s = {};
recordPlanPassNotes(s, "standalone-plan", ["first note", "second note", "third note"]);

const notesBefore = allPlanPassNotes(s);
check("initial notes are all present and unmodified",
  notesBefore.length === 3 && notesBefore[0] === "first note" && notesBefore[2] === "third note");

// Unknown n is ignored
check("markPlanPassNote ignores n = 0", markPlanPassNote(s, 0, { status: "done" }) === null);
check("markPlanPassNote ignores n = 4 (out of bounds)", markPlanPassNote(s, 4, { status: "done" }) === null);
check("markPlanPassNote ignores non-integer n", markPlanPassNote(s, "abc", { status: "done" }) === null);
check("markPlanPassNote ignores negative n", markPlanPassNote(s, -1, { status: "done" }) === null);

// "done" needs no reason
const markDoneResult = markPlanPassNote(s, 1, { status: "done", phase: 1 });
check("markPlanPassNote marks 'done' without reason",
  markDoneResult?.status === "done" && markDoneResult?.phase === 1);

// "skipped" requires a reason
check("markPlanPassNote ignores 'skipped' with missing reason",
  markPlanPassNote(s, 2, { status: "skipped" }) === null);
check("markPlanPassNote ignores 'skipped' with empty whitespace reason",
  markPlanPassNote(s, 2, { status: "skipped", reason: "   " }) === null);

const markSkippedResult = markPlanPassNote(s, 2, { status: "skipped", reason: "superseded by feature X" });
check("markPlanPassNote marks 'skipped' with valid reason",
  markSkippedResult?.status === "skipped" && markSkippedResult?.reason === "superseded by feature X");

// Numbering and stored strings in allPlanPassNotes remain stable
const notesAfter = allPlanPassNotes(s);
check("allPlanPassNotes remains completely unchanged in length, order, and strings after marks",
  JSON.stringify(notesBefore) === JSON.stringify(notesAfter));

const entries = planPassNoteEntries(s);
check("planPassNoteEntries returns correct status and keeps stable 1-based numbering",
  entries.length === 3
  && entries[0].n === 1 && entries[0].status === "done" && entries[0].phase === 1
  && entries[1].n === 2 && entries[1].status === "skipped" && entries[1].reason === "superseded by feature X"
  && entries[2].n === 3 && entries[2].status === "open");

// ---------------------------------------------------------------------------
// 2b. applyPlanPassNoteMarks: applying marks from review results
// ---------------------------------------------------------------------------
const sApply = {};
recordPlanPassNotes(sApply, "standalone-plan", [
  "first pass note",
  "second pass note",
  "third pass note",
  "fourth pass note",
]);

// done
const appliedDoneCount = applyPlanPassNoteMarks(sApply, {
  output: "PASS-NOTE 1: applied",
}, { phase: 1 });
const entriesAfterDone = planPassNoteEntries(sApply);
check("applyPlanPassNoteMarks marks note done and returns applied count",
  appliedDoneCount === 1
  && entriesAfterDone[0].n === 1
  && entriesAfterDone[0].status === "done"
  && entriesAfterDone[0].phase === 1);

// skipped
const appliedSkippedCount = applyPlanPassNoteMarks(sApply, {
  finalMessage: "PASS-NOTE 2: skipped — superseded by design",
}, { phase: "final", allowSkip: true });
const entriesAfterSkipped = planPassNoteEntries(sApply);
check("applyPlanPassNoteMarks marks note skipped with reason and returns applied count",
  appliedSkippedCount === 1
  && entriesAfterSkipped[1].n === 2
  && entriesAfterSkipped[1].status === "skipped"
  && entriesAfterSkipped[1].reason === "superseded by design");

// allowSkip:false ignores skipped
const appliedIgnoredCount = applyPlanPassNoteMarks(sApply, {
  output: "PASS-NOTE 3: skipped — obsolete",
}, { phase: 2, allowSkip: false });
const entriesAfterIgnored = planPassNoteEntries(sApply);
check("applyPlanPassNoteMarks with allowSkip:false ignores skipped marks",
  appliedIgnoredCount === 0
  && entriesAfterIgnored[2].n === 3
  && entriesAfterIgnored[2].status === "open");

// result without text -> 0
check("applyPlanPassNoteMarks returns 0 for result without text (null, empty, or missing text)",
  applyPlanPassNoteMarks(sApply, null) === 0
  && applyPlanPassNoteMarks(sApply, {}) === 0
  && applyPlanPassNoteMarks(sApply, { finalMessage: "", output: null, review: { notes: [] } }) === 0);

// marks in review.notes
const appliedNotesCount = applyPlanPassNoteMarks(sApply, {
  review: { notes: ["PASS-NOTE 4: applied"] },
}, { phase: "final" });
const entriesAfterNotes = planPassNoteEntries(sApply);
check("applyPlanPassNoteMarks applies marks found in review.notes",
  appliedNotesCount === 1
  && entriesAfterNotes[3].n === 4
  && entriesAfterNotes[3].status === "done"
  && entriesAfterNotes[3].phase === "final");

// ---------------------------------------------------------------------------
// 3. planPassNotesText shows ONLY open notes and keeps original numbers
// ---------------------------------------------------------------------------
const textOnlyOpen = planPassNotesText(s);
check("planPassNotesText lists only open note 3 with original number '3.'",
  textOnlyOpen.includes("3. third note")
  && !textOnlyOpen.includes("1. first note")
  && !textOnlyOpen.includes("2. second note")
  && !textOnlyOpen.includes("1. third note")); // Must NOT renumber note 3 to 1

check("planPassNotesText includes the instruction line about code reviewer recording it",
  textOnlyOpen.includes("If your change applies a note, the code reviewer will record it."));

// When all notes are marked, planPassNotesText returns empty string
markPlanPassNote(s, 3, { status: "done", phase: 2 });
check("planPassNotesText returns empty string when all notes are marked",
  planPassNotesText(s) === "");

// ---------------------------------------------------------------------------
// 4. renderPlanPassNotes ordering and markers
// ---------------------------------------------------------------------------
const renderState = {};
recordPlanPassNotes(renderState, "speckit-stage:plan", [
  "note one",
  "note two",
  "note three",
  "note four",
]);
// Mark note 2 as done in Phase 1
markPlanPassNote(renderState, 2, { status: "done", phase: 1 });
// Mark note 3 as skipped
markPlanPassNote(renderState, 3, { status: "skipped", reason: "covered elsewhere" });
// Mark note 4 as done in final
markPlanPassNote(renderState, 4, { status: "done", phase: "final" });
// Note 1 remains open

const reportModel = buildReportModel({ state: renderState });
const renderedNotes = renderPlanPassNotes(reportModel);

check("renderPlanPassNotes uses title '=== Plan-review notes ==='",
  renderedNotes.startsWith("=== Plan-review notes ===\n"));

check("renderPlanPassNotes lists open notes as 'N. text'",
  renderedNotes.includes("1. note one"));

check("renderPlanPassNotes lists done notes with '✓ N. text (done, Phase P)'",
  renderedNotes.includes("✓ 2. note two (done, Phase 1)")
  && renderedNotes.includes("✓ 4. note four (done, Phase final)"));

check("renderPlanPassNotes lists skipped notes with '– N. text (skipped — reason)'",
  renderedNotes.includes("– 3. note three (skipped — covered elsewhere)"));

const openPos = renderedNotes.indexOf("1. note one");
const donePos = renderedNotes.indexOf("✓ 2. note two");
const skippedPos = renderedNotes.indexOf("– 3. note three");
check("renderPlanPassNotes orders open notes first, then done, then skipped",
  openPos !== -1 && donePos !== -1 && skippedPos !== -1 && openPos < donePos && donePos < skippedPos);

// ---------------------------------------------------------------------------
// 5. REPORT.md section replacement on a second write (temp dir)
// ---------------------------------------------------------------------------
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-test-report-"));
const tempReportFile = path.join(tempDir, "REPORT.md");

try {
  const initialContent = "# Mission 001 Report\n\nExisting report content here.\n";
  fs.writeFileSync(tempReportFile, initialContent, "utf8");

  // First write: note 1 open, note 2 open
  const reportTestState = {};
  recordPlanPassNotes(reportTestState, "standalone-plan", ["item A", "item B"]);
  reportPlanPassNotes(reportTestState, { reportFile: tempReportFile });

  const afterFirstWrite = fs.readFileSync(tempReportFile, "utf8");
  check("first write creates 'Plan-review notes:' section with open notes",
    afterFirstWrite.includes("Plan-review notes:\n1. item A\n2. item B")
    && afterFirstWrite.includes("Existing report content here."));

  // Second write: note 1 marked done in Phase 1, note 2 marked skipped
  markPlanPassNote(reportTestState, 1, { status: "done", phase: 1 });
  markPlanPassNote(reportTestState, 2, { status: "skipped", reason: "not needed" });
  reportPlanPassNotes(reportTestState, { reportFile: tempReportFile });

  const afterSecondWrite = fs.readFileSync(tempReportFile, "utf8");
  check("second write replaces the section rather than appending a duplicate",
    (afterSecondWrite.match(/Plan-review notes:/g) || []).length === 1);

  check("second write reflects the updated marks in REPORT.md",
    afterSecondWrite.includes("✓ 1. item A (done, Phase 1)")
    && afterSecondWrite.includes("– 2. item B (skipped — not needed)")
    && !afterSecondWrite.includes("Plan-review notes:\n1. item A\n2. item B"));

  check("second write preserves existing report content outside the section",
    afterSecondWrite.includes("Existing report content here."));
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 6. Source checks: both loops' phase-review and final-review paths call applyPlanPassNoteMarks
// ---------------------------------------------------------------------------
function extractFunctionBody(source, functionName) {
  const match = source.match(new RegExp(`(?:async\\s+)?function\\s+${functionName}\\s*\\([^)]*\\)\\s*\\{`));
  if (!match) throw new Error(`Function ${functionName} not found`);
  const startIndex = match.index + match[0].length;
  let depth = 1;
  let i = startIndex;
  while (i < source.length && depth > 0) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
    i++;
  }
  return source.slice(startIndex, i - 1);
}

const apSource = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");

// Standalone loop: runStandaloneImplementation contains both phase review and final review
const standaloneBody = extractFunctionBody(apSource, "runStandaloneImplementation");

check("runStandaloneImplementation body is non-empty",
  typeof standaloneBody === "string" && standaloneBody.length > 500);

// Check that Standalone phase review path calls applyPlanPassNoteMarks
const standalonePhaseReviewSection = standaloneBody.slice(
  standaloneBody.indexOf('stage==="code_reviewer"'),
  standaloneBody.indexOf('if(rv.status==="completed"){')
);
check("standalone phase-review path calls applyPlanPassNoteMarks on whole function body slice",
  standalonePhaseReviewSection.includes("applyPlanPassNoteMarks"));

// Check that Standalone final review path calls applyPlanPassNoteMarks
const standaloneFinalReviewSection = standaloneBody.slice(
  standaloneBody.indexOf('s.phase="final_review"')
);
check("standalone final-review path calls applyPlanPassNoteMarks on whole function body slice",
  standaloneFinalReviewSection.includes("applyPlanPassNoteMarks"));

// SpecKit loop: runImplementation contains both phase review and final review
const speckitBody = extractFunctionBody(apSource, "runImplementation");

check("runImplementation body is non-empty",
  typeof speckitBody === "string" && speckitBody.length > 500);

// Check that SpecKit phase review path calls applyPlanPassNoteMarks
const speckitPhaseReviewSection = speckitBody.slice(
  speckitBody.indexOf('stage==="code_reviewer"'),
  speckitBody.indexOf('if(rv.status==="completed"){')
);
check("speckit phase-review path calls applyPlanPassNoteMarks on whole function body slice",
  speckitPhaseReviewSection.includes("applyPlanPassNoteMarks"));

// Check that SpecKit final review path calls applyPlanPassNoteMarks
const speckitFinalReviewSection = speckitBody.slice(
  speckitBody.indexOf('Perform final repository review against the planning artifacts')
);
check("speckit final-review path calls applyPlanPassNoteMarks on whole function body slice",
  speckitFinalReviewSection.includes("applyPlanPassNoteMarks"));

// Check that clearPlanPassNotes clears planPassNoteStatus
const clearState = {};
recordPlanPassNotes(clearState, "standalone-plan", ["note to clear"]);
markPlanPassNote(clearState, 1, { status: "done", phase: 1 });
check("state has planPassNoteStatus before clearPlanPassNotes",
  Boolean(clearState.planPassNoteStatus));
clearPlanPassNotes(clearState);
check("clearPlanPassNotes deletes planPassNoteStatus",
  !clearState.planPassNoteStatus && !clearState.planPassNotes);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll plan-pass-note-status checks passed.");
