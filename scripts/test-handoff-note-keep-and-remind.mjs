#!/usr/bin/env node
// Backlog #15 parts 4 and 2 — the two hand-off-note budget checkpoints
// (85%/95% of the per-task turn cap) and the fallback/previous-note merge.
//
// Part 4 (pure): handoffReminderTurns()/handoffBudgetReminder() and the
// implementer brief they extend (built through the SAME buildTaskPrompt the
// orchestrator uses, never a copy of the string).
// Part 2 (pure): mergeFallbackWithPreviousNote() — a real model note is
// carried under a fixed heading, a previous fallback is never nested again,
// and the total respects the note budget by trimming only the previous part.
import {
  handoffReminderTurns, handoffBudgetReminder, mergeFallbackWithPreviousNote,
  buildOrchestratorFallbackNote, HANDOFF_PREVIOUS_NOTE_HEADING,
} from "./per-task-budget.mjs";
import {buildTaskPrompt} from "./role-progress-prompt.mjs";
import {emptyRoleProgress} from "./phase-stage-checkpoint.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, evidence) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(evidence)}` : ""}`);
  failed += 1;
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// ── (i) handoffReminderTurns: 85%/95% floors, null outside a real cap ──────
check("turns: 45 -> {a:38,b:42}", eq(handoffReminderTurns(45), {a: 38, b: 42}), handoffReminderTurns(45));
check("turns: 30 -> {a:25,b:28}", eq(handoffReminderTurns(30), {a: 25, b: 28}), handoffReminderTurns(30));
check("turns: 40 (default implementer cap) -> {a:34,b:38}", eq(handoffReminderTurns(40), {a: 34, b: 38}), handoffReminderTurns(40));
check("turns: 0 -> null", handoffReminderTurns(0) === null, handoffReminderTurns(0));
check("turns: 3 -> null", handoffReminderTurns(3) === null, handoffReminderTurns(3));
check("turns: 2.5 -> null", handoffReminderTurns(2.5) === null, handoffReminderTurns(2.5));
check("turns: undefined -> null", handoffReminderTurns(undefined) === null, handoffReminderTurns(undefined));
check("turns: null -> null", handoffReminderTurns(null) === null, handoffReminderTurns(null));

// ── (ii) the implementer brief carries the checkpoint sentence ─────────────
function makePromptFixture() {
  const taskIds = ["standalone:P1:T0:aaaa", "standalone:P1:T1:bbbb"];
  const tasks = [
    {id: taskIds[0], text: "Build the widget\n\nCURRENT_TASK accept: ok ; verify: node --check scripts/a.mjs", file: "scripts/a.mjs", line: 3},
    {id: taskIds[1], text: "Ship the widget", file: "scripts/b.mjs", line: 4},
  ];
  const progress = emptyRoleProgress();
  progress.implementer.status = "running";
  progress.implementer.completedTaskIds = [];
  progress.implementer.taskCursor = 0;
  return {taskIds, tasks, progress};
}
function buildBrief(extra) {
  const f = makePromptFixture();
  return buildTaskPrompt({
    framework: "standalone", mission: "001-example", phaseIndex: 0, phaseNumber: 1,
    phaseName: "Foundation", phaseTotal: 1, revision: 1, role: "implementer",
    phaseTaskDigest: "sha256:" + "d".repeat(64),
    taskIds: f.taskIds, tasks: f.tasks, currentTaskId: f.taskIds[0], roleProgress: f.progress,
    phaseBriefPath: null, ...extra,
  });
}
{
  const capped = buildBrief({handoffPerTaskMaxTurns: 45});
  const text = capped.ok ? capped.text : "";
  check("brief: 45-turn implementer brief assembles", capped.ok, capped);
  check("brief: keeps the hand-off note text (unchanged head)",
    text.includes("Keep a hand-off note at .autopilot/") && text.includes("OVERWRITE it (never append)"), text.slice(0, 200));
  check("brief: carries the exact budget-checkpoint sentence for a 45-turn cap",
    text.includes("Budget checkpoints: at turn 38 and again at turn 42 of 45, stop and overwrite the hand-off note (Done / Found / Next / Dead ends) before anything else — your session ends at turn 45 and anything not in the note is lost."),
    text.slice(text.indexOf("Budget checkpoints"), text.indexOf("Budget checkpoints") + 260));
  check("brief: contains turn 38, turn 42 and of 45",
    text.includes("turn 38") && text.includes("turn 42") && text.includes("of 45"));

  const uncapped = buildBrief({});
  check("brief: no cap figure -> no checkpoint sentence",
    uncapped.ok && !uncapped.text.includes("Budget checkpoints"), uncapped.text.slice(0, 200));
}

// ── (iii) merge: fallback first, model note under the heading ──────────────
const FALLBACK = buildOrchestratorFallbackNote("T1", [], "opencode", "/repo", "a.mjs | 4 ++++");
const MODEL_NOTE = "1. Done — a.mjs, b.mjs.\n2. Found — a.mjs:10 helper(); b.mjs:4 caller.\n3. Next — edit b.mjs:12.\n4. Dead ends — none.";
{
  const merged = mergeFallbackWithPreviousNote(FALLBACK, MODEL_NOTE, 4000);
  const headingAt = merged.indexOf(HANDOFF_PREVIOUS_NOTE_HEADING);
  const modelAt = merged.indexOf("a.mjs:10 helper()");
  check("merge: result starts with the intact fallback", merged.startsWith(FALLBACK), merged.slice(0, 120));
  check("merge: fallback precedes the previous-note heading",
    headingAt > 0 && headingAt === FALLBACK.length + 2, {headingAt, fallbackLen: FALLBACK.length});
  check("merge: model note is kept under the heading",
    modelAt > headingAt && merged.includes("4. Dead ends — none."), merged.slice(headingAt, headingAt + 200));
  check("merge: the heading appears exactly once",
    merged.split(HANDOFF_PREVIOUS_NOTE_HEADING).length - 1 === 1);
}
{
  // A previous note that is itself an orchestrator fallback is never nested.
  const prevFallback = buildOrchestratorFallbackNote("T1", [], "opencode", "/repo", "b.mjs | 2 ++");
  const merged = mergeFallbackWithPreviousNote(FALLBACK, prevFallback, 4000);
  check("merge: a previous fallback is not nested (result === new fallback)", merged === FALLBACK, merged);
  check("merge: no previous-note heading added for a plain fallback",
    !merged.includes(HANDOFF_PREVIOUS_NOTE_HEADING), merged);
}
{
  // Fallback-with-previous-section + a new fallback carries the model note
  // over exactly once (several fallbacks in a row cannot stack or lose it).
  const first = mergeFallbackWithPreviousNote(FALLBACK, MODEL_NOTE, 4000);
  const second = mergeFallbackWithPreviousNote(FALLBACK, first, 4000);
  check("merge: model-note section survives a second fallback",
    second.includes("a.mjs:10 helper()") && second.includes("4. Dead ends — none."), second.slice(-220));
  check("merge: model-note section carried over exactly once",
    second.split(HANDOFF_PREVIOUS_NOTE_HEADING).length - 1 === 1
    && second.split("a.mjs:10 helper()").length - 1 === 1, second);
  check("merge: second fallback still leads", second.startsWith(FALLBACK), second.slice(0, 80));
}

// ── (iv) budget: previous part trimmed, fallback intact, total <= maxChars ──
{
  const fallback = "FALLBACK-SENTINEL:\n" + "f".repeat(200);
  const longPrev = "MODEL-START:" + "x".repeat(5000);
  const maxChars = 400;
  const merged = mergeFallbackWithPreviousNote(fallback, longPrev, maxChars);
  check("budget: result within maxChars", merged.length <= maxChars, {len: merged.length, maxChars});
  check("budget: fallback part is intact", merged.startsWith(fallback), merged.slice(0, 60));
  check("budget: previous part trimmed with the marker", merged.includes("…(trimmed)"), merged.slice(-80));
  check("budget: trimmed previous part keeps its beginning",
    merged.includes("MODEL-START:") && !merged.includes("x".repeat(500)), merged.slice(-80));
  // A short previous note under the same budget is not trimmed.
  const shortMerged = mergeFallbackWithPreviousNote(fallback, "SHORT-MODEL-NOTE", maxChars);
  check("budget: short previous note is kept whole, no marker",
    shortMerged.endsWith("SHORT-MODEL-NOTE") && !shortMerged.includes("…(trimmed)"), shortMerged.slice(-80));
  // No previous note at all -> the bare fallback, always within budget.
  const noPrev = mergeFallbackWithPreviousNote(fallback, "", 10);
  check("budget: empty previous note yields the fallback alone (bounded)",
    noPrev === fallback.slice(0, 10), noPrev);
}

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
