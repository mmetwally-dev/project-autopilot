#!/usr/bin/env node
// Mission 026 Phase 1 task 1.4 — both-loops continuation-excerpt regression test.
//
// Pins that standalone AND SpecKit continuation briefs inline ~40 lines around
// each cited ref (fresh repo reads, within budget, stale refs skipped) while
// first-generation briefs omit the section. Static wiring pins fail if either
// loop drops the excerpts; functional checks drive the pure helpers
// (handoffNoteCitedExcerpts + buildTaskPrompt) the loops call.
import fs from "node:fs";
import {
  handoffNoteCitedExcerpts,
  NOTE_EXCERPT_MAX_RANGES,
  NOTE_EXCERPT_CONTEXT,
  NOTE_EXCERPT_MAX_LINES,
  NOTE_EXCERPT_MAX_CHARS,
} from "./per-task-budget.mjs";
import {buildTaskPrompt, SECTION} from "./role-progress-prompt.mjs";
import {emptyRoleProgress} from "./phase-stage-checkpoint.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, evidence) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(String(evidence).slice(0, 500))}` : ""}`);
  failed += 1;
}

const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");

// ── Static wiring: both loops quote the note's cited code into the brief ──
check("wiring: excerpts helper imported from the pure budget module",
  /handoffNoteCitedExcerpts/.test(src) && /from "\.\/per-task-budget\.mjs"/.test(src));
check("wiring: handoffNoteExcerptsFor helper defined (continuation-only, best-effort)",
  /function handoffNoteExcerptsFor\(missionName,\s*taskRef\)/.test(src)
  && /const note=readHandoffNote\(missionName,\s*taskRef\);\s*\n\s*if\(!note\) return ""/.test(src));
check("wiring: excerpt reads confined to the repo",
  /function handoffNoteExcerptsFor[\s\S]*?abs!==root && !abs\.startsWith\(root\+path\.sep\)/.test(src));
check("wiring: standalone loop passes excerpts at its per-task prompt build",
  /handoffNoteExcerpts:handoffNoteExcerptsFor\(mission,taskDisplayRef\(phaseTasks\[taskIndex\],taskIndex\)\)/.test(src));
check("wiring: speckit loop passes excerpts at its per-task prompt build",
  /handoffNoteExcerpts:handoffNoteExcerptsFor\(missionIdentity,taskDisplayRef\(phaseTasks\[taskIndex\],taskIndex\)\)/.test(src));

// ── Functional: ~40-line window, budget, stale-ref skips ──
const LINES = Array.from({length: 100}, (_, i) => `L${i + 1} content line ${i + 1}`);
const reader = (rel) => (rel === "scripts/a.mjs" ? LINES.join("\n") : null);

check("window: defaults are ±20 context bounded to 5 refs / 210 lines / 15000 chars",
  NOTE_EXCERPT_CONTEXT === 20 && NOTE_EXCERPT_MAX_RANGES === 5
  && NOTE_EXCERPT_MAX_LINES === 210 && NOTE_EXCERPT_MAX_CHARS === 15000,
  {NOTE_EXCERPT_CONTEXT, NOTE_EXCERPT_MAX_RANGES, NOTE_EXCERPT_MAX_LINES, NOTE_EXCERPT_MAX_CHARS});

const note = ["# T1.4 handoff", "## 3. Next", "Edit scripts/a.mjs:50 then verify."].join("\n");
const excerpts = handoffNoteCitedExcerpts(note, reader);
const numbered = excerpts.match(/^\d+: /gm) || [];
check("continuation: single cite inlines ~40 lines around the ref (50 → 30-70)",
  excerpts.includes("scripts/a.mjs:30-70") && numbered.length === 41
  && excerpts.includes("30: L30 content line 30") && excerpts.includes("70: L70 content line 70"), excerpts.slice(0, 200));
check("continuation: excerpts stay within the line/char budget",
  numbered.length <= NOTE_EXCERPT_MAX_LINES && excerpts.length <= NOTE_EXCERPT_MAX_CHARS,
  `${numbered.length} lines, ${excerpts.length} chars`);

const staleNote = ["## 3. Next", "Edit scripts/a.mjs:50; also scripts/a.mjs:9999 and scripts/missing.mjs:10."].join("\n");
let staleOut = null;
let threw = false;
try { staleOut = handoffNoteCitedExcerpts(staleNote, reader); } catch { threw = true; }
check("continuation: stale (out-of-range/missing) refs skipped, valid ref kept, no throw",
  threw === false && typeof staleOut === "string"
  && staleOut.includes("scripts/a.mjs:30-70")
  && !staleOut.includes("missing.mjs") && !staleOut.includes("9999"), staleOut?.slice(0, 200));
check("first-generation: empty note renders nothing",
  handoffNoteCitedExcerpts("", reader) === "" && handoffNoteCitedExcerpts("   ", reader) === "");

// ── Prompt rendering: continuation inlines, first generation omits (both loops) ──
const DIGEST = "sha256:" + "c".repeat(64);
function optsFor(framework, {handoffNoteExcerpts} = {}) {
  const prefix = framework === "standalone" ? "standalone" : "speckit";
  const taskIds = [`${prefix}:P1:T3:135c99e28d73`];
  return {
    framework,
    mission: "026-fix-backlog-continuation",
    phaseIndex: 0,
    phaseNumber: 1,
    phaseName: "Phase 1",
    phaseTotal: 2,
    revision: 1,
    role: "implementer",
    phaseTaskDigest: DIGEST,
    taskIds,
    tasks: [{id: taskIds[0], text: "Add the excerpts regression test", file: "scripts/test-continuation-brief-excerpts.mjs"}],
    currentTaskId: taskIds[0],
    roleProgress: emptyRoleProgress(),
    handoffNote: note,
    ...(handoffNoteExcerpts !== undefined ? {handoffNoteExcerpts} : {}),
  };
}
for (const framework of ["standalone", "speckit"]) {
  const cont = buildTaskPrompt(optsFor(framework, {handoffNoteExcerpts: excerpts}));
  check(`[${framework}] continuation brief inlines the excerpt section with live lines`,
    cont.ok && cont.text.includes(SECTION.handoffNoteCode)
    && cont.text.includes("scripts/a.mjs:30-70") && cont.text.includes("50: L50 content line 50"),
    cont.ok ? cont.text.slice(0, 200) : cont);
  const first = buildTaskPrompt(optsFor(framework, {handoffNoteExcerpts: ""}));
  check(`[${framework}] first-generation brief (empty excerpts) omits the section`,
    first.ok && !first.text.includes(SECTION.handoffNoteCode));
  const absent = buildTaskPrompt(optsFor(framework));
  check(`[${framework}] first-generation brief (no excerpts opt) omits the section`,
    absent.ok && !absent.text.includes(SECTION.handoffNoteCode));
}

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("continuation-brief excerpts tests passed");
