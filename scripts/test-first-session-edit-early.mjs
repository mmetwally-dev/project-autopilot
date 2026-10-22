#!/usr/bin/env node
// Mission 077 Phase 1 task 1.2 — first-session edit-early rule tests.
//
// Pins the implementer brief rule in role-progress-prompt.mjs: the
// first-session (no handoffNote, no deadEnds) brief for both standalone and
// speckit contains the stable SECTION marker plus the rule prose, while
// continuation briefs (non-empty handoffNote or deadEnds entries) do not
// repeat it.
import {buildTaskPrompt, SECTION} from "./role-progress-prompt.mjs";
import {emptyRoleProgress} from "./phase-stage-checkpoint.mjs";

let failures = 0;
function check(name, condition, evidence) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(evidence)}` : ""}`); }
}

const DIGEST = "sha256:" + "e".repeat(64);
const MARKER = `## ${SECTION.firstSessionEditEarly}`;

function optsFor(framework, taskId, task, extra = {}) {
  const progress = emptyRoleProgress();
  progress.implementer.status = "running";
  progress.implementer.taskCursor = 0;
  progress.implementer.currentTaskId = taskId;
  return {
    framework,
    mission: "077-fix-backlog-item",
    phaseIndex: 0,
    phaseNumber: 1,
    phaseName: "First-session edit-early rule",
    phaseTotal: 1,
    revision: 1,
    role: "implementer",
    phaseTaskDigest: DIGEST,
    taskIds: [taskId],
    tasks: [task],
    currentTaskId: taskId,
    roleProgress: progress,
    ...extra,
  };
}

function rulePhrases(text) {
  return [
    /targeted grep/i.test(text),
    /line-range reads/i.test(text),
    /first few tool calls/i.test(text),
    /no whole-file surveys/i.test(text),
    /no zero-edit sessions/i.test(text),
  ];
}

const standaloneTaskId = "standalone:P1:T0:aaa111";
const standaloneTask = {id: standaloneTaskId, text: "**1.1** Do the first thing", file: ".autopilot/missions/077-fix-backlog-item/TASKS.md", line: 4};
const speckitTaskId = "speckit:P1:T0:bbb222";
const speckitTask = {id: speckitTaskId, text: "T001 Do the first thing", file: "specs/001-x/tasks.md", line: 5};

// ── First-session presence ──
for (const [label, framework, taskId, task] of [
  ["standalone", "standalone", standaloneTaskId, standaloneTask],
  ["speckit", "speckit", speckitTaskId, speckitTask],
]) {
  const built = buildTaskPrompt(optsFor(framework, taskId, task));
  check(`${label}: first-session implementer prompt assembles`, built.ok === true, built);
  const text = built.ok ? built.text : "";
  check(`${label}: first-session brief contains the rule marker`, text.includes(MARKER), MARKER);
  const phrases = rulePhrases(text);
  check(`${label}: first-session rule names targeted reads + early edits`,
    phrases.every(Boolean), phrases);
}

// ── Continuation absence (non-empty handoffNote) ──
for (const [label, framework, taskId, task] of [
  ["standalone", "standalone", standaloneTaskId, standaloneTask],
  ["speckit", "speckit", speckitTaskId, speckitTask],
]) {
  const built = buildTaskPrompt(optsFor(framework, taskId, task, {
    handoffNote: "Done: read files. Found: x. Next: edit y. Dead ends: none.",
  }));
  check(`${label}: continuation (handoffNote) prompt assembles`, built.ok === true, built);
  const text = built.ok ? built.text : "";
  check(`${label}: continuation (handoffNote) brief does not repeat the rule`,
    !text.includes(MARKER), MARKER);
}

// ── Continuation absence (deadEnds) ──
for (const [label, framework, taskId, task] of [
  ["standalone", "standalone", standaloneTaskId, standaloneTask],
  ["speckit", "speckit", speckitTaskId, speckitTask],
]) {
  const built = buildTaskPrompt(optsFor(framework, taskId, task, {
    deadEnds: [{generation: 1, reason: "tokens", used: 10, limit: 20, tail: "stopped early"}],
  }));
  check(`${label}: continuation (deadEnds) prompt assembles`, built.ok === true, built);
  const text = built.ok ? built.text : "";
  check(`${label}: continuation (deadEnds) brief does not repeat the rule`,
    !text.includes(MARKER), MARKER);
}

if (failures) {
  console.error(`${failures} first-session-edit-early check(s) failed.`);
  process.exit(1);
}
console.log("first-session-edit-early tests passed");
