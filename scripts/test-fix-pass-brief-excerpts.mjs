#!/usr/bin/env node
// Mission 050 Phase 1 task 1.1 — fix-pass brief excerpt unit test.
//
// Pins the pure fix-pass block renderer in finding-task-locality.mjs:
// all three citation forms (colon `path:N-M` via the reused
// handoffNoteCitedExcerpts, the space-tilde `path ~N-M` extension, and the
// parenthesised `path (line N)` / `path (lines N-M)` extension),
// bounds enforcement (delegated maxRanges/maxLines), and
// skip-unreadable behaviour. Every case also pins the single trailing
// edit-first instruction.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fixPassBriefExcerpts,
  FIX_PASS_EDIT_FIRST_INSTRUCTION,
} from "./finding-task-locality.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, evidence) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(String(evidence).slice(0, 500))}` : ""}`);
  failed += 1;
}

const LINES = Array.from({length: 200}, (_, i) => `L${i + 1} content line ${i + 1}`);
const reader = (rel) => (rel === "scripts/a.mjs" ? LINES.join("\n") : null);

check("helper exported with the edit-first instruction",
  typeof fixPassBriefExcerpts === "function"
  && FIX_PASS_EDIT_FIRST_INSTRUCTION === "edit these locations first; read other code only if the fix needs it");

// ── Both citation forms ──
const colon = fixPassBriefExcerpts(["Broken range in scripts/a.mjs:10-20, please fix."], reader, {context: 0});
check("colon form cites path, range and excerpt plus instruction",
  colon.includes("scripts/a.mjs:10-20") && colon.includes("10: L10 content line 10")
  && colon.includes("20: L20 content line 20")
  && colon.includes(FIX_PASS_EDIT_FIRST_INSTRUCTION), colon.slice(0, 300));

const tilde = fixPassBriefExcerpts(["Broken range in scripts/a.mjs ~10-20, please fix."], reader, {context: 0});
check("space-tilde form cites path, range and excerpt plus instruction",
  tilde.includes("scripts/a.mjs:10-20") && tilde.includes("10: L10 content line 10")
  && tilde.includes("20: L20 content line 20")
  && tilde.includes(FIX_PASS_EDIT_FIRST_INSTRUCTION), tilde.slice(0, 300));

const tildeSingle = fixPassBriefExcerpts(["See scripts/a.mjs ~15 for details."], reader, {context: 0});
check("space-tilde single line cites the line",
  tildeSingle.includes("scripts/a.mjs:15-15") && tildeSingle.includes("15: L15 content line 15"),
  tildeSingle.slice(0, 300));

// ── Parenthesised `(line N)` / `(lines N-M)` form ──
const parenLine = fixPassBriefExcerpts(
  ["Missing check in scripts/a.mjs finalizeMissionComplete (line 103) breaks the fix."], reader, {context: 0});
const colonLine = fixPassBriefExcerpts(["Missing check in scripts/a.mjs:103 breaks the fix."], reader, {context: 0});
check("(line N) form cites path, line and excerpt plus instruction",
  parenLine.includes("scripts/a.mjs:103-103") && parenLine.includes("103: L103 content line 103")
  && parenLine.includes(FIX_PASS_EDIT_FIRST_INSTRUCTION), parenLine.slice(0, 300));
check("(line N) form yields the same excerpt block as the colon form",
  parenLine === colonLine, `${parenLine.slice(0, 200)} :: ${colonLine.slice(0, 200)}`);

const parenLines = fixPassBriefExcerpts(
  ["Broken range in scripts/a.mjs normalizeFinding (lines 103-107), please fix."], reader, {context: 0});
const colonLines = fixPassBriefExcerpts(["Broken range in scripts/a.mjs:103-107, please fix."], reader, {context: 0});
check("(lines N-M) form yields the same excerpt block as the colon form",
  parenLines === colonLines
  && parenLines.includes("103: L103 content line 103") && parenLines.includes("107: L107 content line 107")
  && parenLines.includes(FIX_PASS_EDIT_FIRST_INSTRUCTION), parenLines.slice(0, 300));

const parenUnreadable = fixPassBriefExcerpts(
  ["Fix scripts/a.mjs (line 10) plus scripts/missing.mjs (line 10), /etc/passwd.txt (line 1) and ../x.mjs (line 3)."],
  reader, {context: 0});
check("(line N) form skips unreadable/absolute/parent refs, valid ref kept",
  parenUnreadable.includes("scripts/a.mjs:10-10") && parenUnreadable.includes("10: L10 content line 10")
  && !parenUnreadable.includes("missing.mjs") && !parenUnreadable.includes("passwd") && !parenUnreadable.includes("x.mjs"),
  parenUnreadable.slice(0, 300));

const parenMany = ["## Next", ...Array.from({length: 6}, (_, i) => `scripts/a.mjs (line ${i * 3 + 1})`)].join(" ");
const parenCapped = fixPassBriefExcerpts([parenMany], reader, {context: 0, maxRanges: 3});
check("bounds: maxRanges caps the (line N) excerpt count",
  (parenCapped.match(/^scripts\/a\.mjs:/gm) || []).length === 3
  && parenCapped.includes(FIX_PASS_EDIT_FIRST_INSTRUCTION), parenCapped.slice(0, 300));

// The gap between the path and the `(line …)` marker must not be able to
// swallow a second file path, otherwise the line is attached to the wrong
// file and points the fix pass at code it does not own.
const twoFileReader = (rel) => (rel === "scripts/a.mjs" || rel === "scripts/b.mjs"
  ? Array.from({length: 200}, (_, i) => `${rel}:L${i + 1} content line ${i + 1}`).join("\n")
  : null);
const twoPathsOneMarker = fixPassBriefExcerpts(
  ["See scripts/a.mjs and the helper in scripts/b.mjs (line 50)."], twoFileReader, {context: 0});
check("gap may not contain a second path: (line N) attaches to the path nearest the marker",
  twoPathsOneMarker.includes("scripts/b.mjs:50-50")
  && twoPathsOneMarker.includes("50: scripts/b.mjs:L50 content line 50")
  && !twoPathsOneMarker.includes("scripts/a.mjs")
  && twoPathsOneMarker.includes(FIX_PASS_EDIT_FIRST_INSTRUCTION), twoPathsOneMarker.slice(0, 400));

const markerBeforeOtherPath = fixPassBriefExcerpts(
  ["Fix scripts/a.mjs (line 10) and also check scripts/b.mjs first."], twoFileReader, {context: 0});
check("gap may not contain a second path: a marker after b.mjs-free text keeps its own path",
  markerBeforeOtherPath.includes("scripts/a.mjs:10-10")
  && markerBeforeOtherPath.includes("10: scripts/a.mjs:L10 content line 10")
  && !markerBeforeOtherPath.includes("scripts/b.mjs"), markerBeforeOtherPath.slice(0, 400));

const proseGap = fixPassBriefExcerpts(
  ["Missing check in scripts/a.mjs finalizeMissionComplete inside the helper (line 103) breaks the fix."],
  reader, {context: 0});
check("prose gap still tolerated: several non-path words before (line N)",
  proseGap === colonLine, proseGap.slice(0, 300));

const parenBig = fixPassBriefExcerpts(["Fix scripts/a.mjs (lines 1-60) now."], reader, {context: 0, maxLines: 10});
check("bounds: maxLines caps the quoted (lines N-M) lines",
  (parenBig.match(/^\d+: /gm) || []).length === 10
  && parenBig.includes(FIX_PASS_EDIT_FIRST_INSTRUCTION), parenBig.slice(0, 300));

check("no double normalization: colon form unchanged by the new pass",
  fixPassBriefExcerpts(["Fix scripts/a.mjs:10-20."], reader, {context: 0})
  === fixPassBriefExcerpts(["Fix scripts/a.mjs ~10-20."], reader, {context: 0}));
const mixedForms = fixPassBriefExcerpts(
  ["Fix scripts/a.mjs:10 (line 20) plus scripts/a.mjs ~15 and scripts/a.mjs (lines 30-32)."], reader, {context: 0});
check("no double normalization: colon ref plus trailing (line N) keeps the colon ref only",
  mixedForms.includes("scripts/a.mjs:10-10") && mixedForms.includes("10: L10 content line 10")
  && !mixedForms.includes("20-20")
  && (mixedForms.match(/^scripts\/a\.mjs:/gm) || []).length === 3
  && mixedForms.includes("30-32") && mixedForms.includes("32: L32 content line 32"),
  mixedForms.slice(0, 400));
check("no double normalization: object-form findings cite the (line N) form",
  fixPassBriefExcerpts([{location: "scripts/a.mjs finalizeMissionComplete (line 103)"}], reader, {context: 0})
  === fixPassBriefExcerpts([{location: "scripts/a.mjs:103"}], reader, {context: 0}));

// ── Bounds enforced (delegated) ──
const many = ["## Next", ...Array.from({length: 20}, (_, i) => `scripts/a.mjs:${i * 3 + 1}`)].join(" ");
const capped = fixPassBriefExcerpts([many], reader, {context: 0, maxRanges: 3});
check("bounds: maxRanges caps the excerpt count",
  (capped.match(/^scripts\/a\.mjs:/gm) || []).length === 3
  && capped.includes(FIX_PASS_EDIT_FIRST_INSTRUCTION), capped.slice(0, 300));

const big = fixPassBriefExcerpts(["Fix scripts/a.mjs:1-60 now."], reader, {context: 0, maxLines: 10});
check("bounds: maxLines caps the quoted lines",
  (big.match(/^\d+: /gm) || []).length === 10
  && big.includes(FIX_PASS_EDIT_FIRST_INSTRUCTION), big.slice(0, 300));

// ── Skip-unreadable behaviour ──
const stale = fixPassBriefExcerpts(
  ["Fix scripts/a.mjs:10 plus scripts/missing.mjs:10, /etc/passwd.txt:1, ../x.mjs:3 and scripts/a.mjs:9999."],
  reader, {context: 0});
let threw = false;
try {
  fixPassBriefExcerpts(["Fix scripts/a.mjs:10."], () => { throw new Error("x"); }, {context: 0});
} catch { threw = true; }
check("skip: unreadable/absolute/parent/out-of-range refs skipped, valid ref kept",
  stale.includes("scripts/a.mjs:10-10") && stale.includes("10: L10 content line 10")
  && !stale.includes("missing.mjs") && !stale.includes("passwd") && !stale.includes("x.mjs")
  && !stale.includes("9999"), stale.slice(0, 300));
check("skip: throwing reader degrades to the instruction, no throw",
  threw === false
  && fixPassBriefExcerpts(["Fix scripts/a.mjs:10."], () => { throw new Error("x"); }, {context: 0}) === FIX_PASS_EDIT_FIRST_INSTRUCTION);

// ── No-location finding: instruction only ──
const bare = fixPassBriefExcerpts(["Something is wrong but no location is given."], reader, {context: 0});
check("no-location finding renders only the instruction",
  bare === FIX_PASS_EDIT_FIRST_INSTRUCTION, bare);

// ── Mission 050 Phase 1 task 1.2: both fix-pass assembly sites wired ──
const autopilotSource = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "autopilot.mjs"), "utf8");
check("1.2: autopilot imports the 1.1 helper",
  /from\s+"\.\/finding-task-locality\.mjs"/.test(autopilotSource)
  && /fixPassBriefExcerpts/.test(autopilotSource.split("from \"./finding-task-locality.mjs\"")[0].slice(-2000)));
const helperCalls = (autopilotSource.match(/fixPassBriefExcerpts\(\[/g) || []).length;
check("1.2: both sites (standalone + SpecKit) call the helper",
  helperCalls === 2, helperCalls);
const speckitAnchor = autopilotSource.indexOf("TASK-24 step 4, SpecKit twin");
check("1.2: one call per loop (standalone before SpecKit anchor, twin after)",
  speckitAnchor !== -1
  && autopilotSource.slice(0, speckitAnchor).includes("fixPassBriefExcerpts([")
  && autopilotSource.slice(speckitAnchor).includes("fixPassBriefExcerpts(["), speckitAnchor);
check("1.2: fallback and empty-findings branches keep raw feedback text",
  (autopilotSource.match(/if\(taskFindings\.length===0\)\{/g) || []).length === 2
  && (autopilotSource.match(/if\(grouped\.fallback\)\{/g) || []).length === 2
  && !/if\(taskFindings\.length===0\)\{[^}]*fixPassBriefExcerpts/s.test(autopilotSource)
  && !/if\(grouped\.fallback\)\{[^}]*fixPassBriefExcerpts/s.test(autopilotSource));
check("1.2: hand-off pointer defined once, note text not duplicated in the block",
  (autopilotSource.match(/FIX_PASS_HANDOFF_POINTER=/g) || []).length === 1
  && (autopilotSource.match(/\$\{FIX_PASS_HANDOFF_POINTER\}/g) || []).length === 1);
// Mission 050 final-review fix: the pointer is added only when a note exists.
{
  const fnMatch = autopilotSource.match(/function fixPassHandoffPointer\(noteText\)\{\n\s*return ([^\n]+);\n\}/);
  const POINTER_TEXT = (autopilotSource.match(/FIX_PASS_HANDOFF_POINTER='([^']+)'/) || [])[1];
  const fixPassHandoffPointer = fnMatch
    ? new Function("FIX_PASS_HANDOFF_POINTER", "noteText", `return ${fnMatch[1]};`).bind(null, POINTER_TEXT)
    : null;
  check("fix: pointer helper exists",
    typeof fixPassHandoffPointer === "function" && typeof POINTER_TEXT === "string");
  check("fix: no pointer when the task has no hand-off note",
    fixPassHandoffPointer?.(null) === "" && fixPassHandoffPointer?.("") === "" && fixPassHandoffPointer?.("  \n") === "");
  check("fix: pointer present when a note exists",
    fixPassHandoffPointer?.("Next: edit a.mjs") === `${POINTER_TEXT}\n`);
  check("fix: both fix-pass sites gate the pointer on the task's own note",
    (autopilotSource.match(/fixPassHandoffPointer\(readHandoffNote\(mission,taskDisplayRef\(phaseTasks\[taskIndex\],taskIndex\)\)\)/g) || []).length === 1
    && (autopilotSource.match(/fixPassHandoffPointer\(readHandoffNote\(missionIdentity,taskDisplayRef\(phaseTasks\[taskIndex\],taskIndex\)\)\)/g) || []).length === 1);
}
check("1.2: no process exit hooks added",
  !autopilotSource.includes('process.on("exit")') && !autopilotSource.includes("process.on('exit')"));

// ── Mission 050 Phase 1 task 1.3: three brief-mandated cases, helper called directly ──
// Each case assembles a simulated final implementer prompt
// (`basePrompt + fix-pass block`, mirroring autopilot.mjs
// `${promptBuilt.text}${taskRetryFindings}`) from fixPassBriefExcerpts output.
const NOTE_TEXT = "Next: rewrite the retry loop in scripts/a.mjs unique-note-marker-050";
const baseWithNote = `## Hand-off note from the previous session\n${NOTE_TEXT}\n## Current task\nDo the fix.`;
const POINTER = "FIX_PASS_HANDOFF_POINTER placeholder: prior hand-off note section above, not repeated here.";

const cited = fixPassBriefExcerpts(["Broken range in scripts/a.mjs ~10-20, please fix."], reader, {context: 0});
const citedPrompt = `${baseWithNote}\n${POINTER}\n${cited}`;
check("1.3: tilde ~10-20 prompt contains path, range and excerpt",
  citedPrompt.includes("scripts/a.mjs") && citedPrompt.includes("10-20")
  && citedPrompt.includes("10: L10 content line 10")
  && citedPrompt.includes("20: L20 content line 20")
  && citedPrompt.includes(FIX_PASS_EDIT_FIRST_INSTRUCTION), citedPrompt.slice(0, 300));

const bareBlock = fixPassBriefExcerpts(["Something is wrong but no location is given."], reader, {context: 0});
const bareBase = "## Current task\nDo the fix.";
const barePrompt = `${bareBase}\n${bareBlock}`;
check("1.3: no-location prompt unchanged except the instruction",
  bareBlock === FIX_PASS_EDIT_FIRST_INSTRUCTION
  && barePrompt === `${bareBase}\n${FIX_PASS_EDIT_FIRST_INSTRUCTION}`, barePrompt);

const noteBlock = fixPassBriefExcerpts(["Broken range in scripts/a.mjs ~10-20, please fix."], reader, {context: 0});
const notePrompt = `${baseWithNote}\n${POINTER}\n${noteBlock}`;
const noteCount = notePrompt.split(NOTE_TEXT).length - 1;
check("1.3: note text appears exactly once in the final implementer prompt",
  noteCount === 1 && !noteBlock.includes(NOTE_TEXT), `count=${noteCount} :: ${notePrompt.slice(0, 300)}`);

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("fix-pass brief excerpts tests passed");
