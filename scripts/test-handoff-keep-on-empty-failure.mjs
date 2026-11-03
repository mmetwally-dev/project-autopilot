import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildOrchestratorFallbackNote,
  mergeFallbackWithPreviousNote,
  HANDOFF_PREVIOUS_NOTE_HEADING,
  formatEmptyRunFailureLine,
  parseAppendedFailureLines,
  appendFailureLineToNote,
  fallbackNoteHasNothingToReport,
} from "./per-task-budget.mjs";

console.log("Running test-handoff-keep-on-empty-failure.mjs...");

const WORKING_NOTE = `# Handoff Note — Task-Generic
1. Done — generic-a.mjs
2. Found — generic-b.mjs:10 helperFunc()
3. Next — generic-b.mjs:20
4. Dead ends — none`;

const EMPTY_FALLBACK = buildOrchestratorFallbackNote("Task-Generic", [], "opencode", "/repo/generic", "");
const FAILED_WITH_EDITS_FALLBACK = buildOrchestratorFallbackNote(
  "Task-Generic",
  [],
  "opencode",
  "/repo/generic",
  " generic-file.mjs | 5 +++++",
  null,
  ["generic-file.mjs"]
);

// ── Helpers check ─────────────────────────────────────────────────────────
assert.equal(typeof formatEmptyRunFailureLine, "function", "formatEmptyRunFailureLine is exported");
assert.equal(typeof parseAppendedFailureLines, "function", "parseAppendedFailureLines is exported");
assert.equal(typeof appendFailureLineToNote, "function", "appendFailureLineToNote is exported");
assert.equal(typeof fallbackNoteHasNothingToReport, "function", "fallbackNoteHasNothingToReport is exported");

assert.equal(fallbackNoteHasNothingToReport(EMPTY_FALLBACK), true, "empty fallback has nothing to report");
assert.equal(fallbackNoteHasNothingToReport(FAILED_WITH_EDITS_FALLBACK), false, "fallback with diff has something to report");

// ── (a) existing note from working run + empty failed run ───────────────────
// Note text kept + one appended line naming the failure class.
{
  const merged = mergeFallbackWithPreviousNote(EMPTY_FALLBACK, WORKING_NOTE, 4000, {
    runNumber: 101,
    adapter: "antigravity",
    model: "generic-model-a",
    failureClass: "PERMISSION_DENIED",
  });

  assert.ok(merged.startsWith(WORKING_NOTE), "existing note text kept at the start");
  assert.ok(merged.includes("PERMISSION_DENIED"), "appended line names failure class");
  assert.ok(
    merged.includes("- Run 101 (antigravity/generic-model-a) ended PERMISSION_DENIED without changes; the note above is still current."),
    "exact formatted failure line is appended"
  );
  assert.ok(!merged.includes(HANDOFF_PREVIOUS_NOTE_HEADING), "no previous note heading used when note kept intact");
  assert.ok(!merged.includes("This session changed no files."), "empty fallback text does not overwrite note");
}

// (a2) multiple consecutive empty failed runs stack in order
{
  const firstMerged = mergeFallbackWithPreviousNote(EMPTY_FALLBACK, WORKING_NOTE, 4000, {
    runNumber: 101,
    adapter: "antigravity",
    model: "generic-model-a",
    failureClass: "PERMISSION_DENIED",
  });
  const secondMerged = mergeFallbackWithPreviousNote(EMPTY_FALLBACK, firstMerged, 4000, {
    runNumber: 102,
    adapter: "opencode",
    model: "generic-model-b",
    failureClass: "RATE_LIMITED",
  });

  assert.ok(secondMerged.startsWith(WORKING_NOTE), "base working note text still leads");
  assert.ok(secondMerged.includes("Run 101"), "run 101 line present");
  assert.ok(secondMerged.includes("Run 102"), "run 102 line present");
  const idx1 = secondMerged.indexOf("Run 101");
  const idx2 = secondMerged.indexOf("Run 102");
  assert.ok(idx1 < idx2, "run 101 precedes run 102");
}

// (a3) budget bounding: drops oldest appended line first
{
  const line1 = "- Run 1 (a/m) ended RATE_LIMITED without changes; the note above is still current.";
  const line2 = "- Run 2 (a/m) ended TIMEOUT without changes; the note above is still current.";
  const line3 = "- Run 3 (a/m) ended PERMISSION_DENIED without changes; the note above is still current.";

  const base = "Short generic note.";
  // Room for base + 2 lines, but not 3
  const budget = base.length + 2 + line2.length + 1 + line3.length + 5;
  const withTwo = `${base}\n\n${line1}\n${line2}`;
  const merged = mergeFallbackWithPreviousNote(EMPTY_FALLBACK, withTwo, budget, {
    line: line3,
    emptyRun: true,
  });

  assert.ok(merged.length <= budget, "bounded to maxChars");
  assert.ok(!merged.includes("Run 1"), "oldest appended line (Run 1) dropped first");
  assert.ok(merged.includes("Run 2"), "newer line (Run 2) kept");
  assert.ok(merged.includes("Run 3"), "newest line (Run 3) kept");
  assert.ok(merged.startsWith(base), "base note preserved");
}

// ── (b) failed run WITH edits → note replaced/merged as today ──────────────
{
  const merged = mergeFallbackWithPreviousNote(FAILED_WITH_EDITS_FALLBACK, WORKING_NOTE, 4000, {
    runNumber: 104,
    adapter: "opencode",
    model: "generic-model",
    failureClass: "PROCESS_EXIT_NONZERO",
  });

  assert.ok(merged.startsWith(FAILED_WITH_EDITS_FALLBACK), "run with edits: new fallback leads as today");
  assert.ok(merged.includes(HANDOFF_PREVIOUS_NOTE_HEADING), "previous model note carried under heading as today");
  assert.ok(merged.includes("1. Done — generic-a.mjs"), "previous model note content carried over");
  assert.ok(!merged.includes("ended PROCESS_EXIT_NONZERO without changes"), "no empty-run line added");
}

// ── (c) no existing note + empty failed run → fallback note string returned ─
// Note: autopilot runRelay will NOT write this to disk if !didWork and no previous note exists;
// this test verifies the string-level behavior of mergeFallbackWithPreviousNote when called directly.
{
  const mergedEmpty = mergeFallbackWithPreviousNote(EMPTY_FALLBACK, "", 4000, {
    runNumber: 105,
    adapter: "opencode",
    model: "generic-model",
    failureClass: "LAUNCH_FAILED",
  });

  assert.equal(mergedEmpty, EMPTY_FALLBACK, "bare fallback returned when no previous note exists");
  assert.ok(!mergedEmpty.includes("ended LAUNCH_FAILED without changes"), "no failure append when no previous note");

  const mergedNull = mergeFallbackWithPreviousNote(EMPTY_FALLBACK, null, 4000, {
    runNumber: 106,
    adapter: "opencode",
    model: "generic-model",
    failureClass: "LAUNCH_FAILED",
  });
  assert.equal(mergedNull, EMPTY_FALLBACK, "bare fallback returned when previous note is null");
}

// ── (d) explicit options.hasWork decides whether to merge or append failure line ─
{
  const mergedWithWork = mergeFallbackWithPreviousNote(EMPTY_FALLBACK, WORKING_NOTE, 4000, {
    hasWork: true,
    failureClass: "x",
    runNumber: 1,
  });
  const expectedMerged = `${EMPTY_FALLBACK}\n\n${HANDOFF_PREVIOUS_NOTE_HEADING}\n${WORKING_NOTE}`;
  assert.equal(mergedWithWork, expectedMerged, "empty-looking fallback with hasWork:true must MERGE");
  assert.ok(!mergedWithWork.includes("ended x without changes"), "no failure append line when hasWork is true");

  const mergedWithoutWork = mergeFallbackWithPreviousNote(FAILED_WITH_EDITS_FALLBACK, WORKING_NOTE, 4000, {
    hasWork: false,
    failureClass: "x",
    runNumber: 1,
  });
  const expectedAppended = `${WORKING_NOTE}\n\n- Run 1 (unknown) ended x without changes; the note above is still current.`;
  assert.equal(mergedWithoutWork, expectedAppended, "non-empty looking fallback with hasWork:false must append only failure line");
  assert.ok(!mergedWithoutWork.includes(HANDOFF_PREVIOUS_NOTE_HEADING), "no previous note heading when hasWork is false");
}

// ── (e) no-work + no-previous-note: autopilot runRelay gates fallback write ─
// At pure string-merge level, an empty fallback with empty previous note returns
// the fallback string, but autopilot runRelay guards the disk write with
// `(didWork || hasPreviousNote)` so no note is written when a run did no work
// and had no previous note (verified end-to-end by test-planner-handoff-clear.mjs).
{
  const apSrc = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
  const idx = apSrc.indexOf("Backlog #116:");
  assert.ok(idx > 0, "Backlog #116 block found in autopilot.mjs");
  const blk = apSrc.slice(idx, idx + 2400);
  assert.ok(
    blk.includes("(didWork || hasPreviousNote)"),
    "autopilot runRelay guards failed-run handoff write with (didWork || hasPreviousNote)"
  );
}

console.log("PASS test-handoff-keep-on-empty-failure.mjs");
