#!/usr/bin/env node
// Mission 056 Phase 1 task 1.3 — backlog #58 (b)(c) prompt-rule pins.
//
// Pins that the two canonical planning-prompt rules reach every in-scope
// prompt by constant reference, exactly once per region:
//   REVIEWER_ALL_FINDINGS_LINE — standalone reviewPrompt, SpecKit
//     initialReviewPrompt, SpecKit reReviewPrompt (one reference each);
//   PLANNER_READ_RANGE_LINE — standalone fresh branch, standalone revision
//     branch, runPlanningPhase task (one reference each), and NOT the
//     SpecKit tasks-stage artifact contract (so the rendered tasks-stage
//     prompt carries the rule exactly once via the task template).
// Static source assertions only: no imports, no fixtures, no clock. They
// fail if any prompt drops its rule or copies the wording inline.
import fs from "node:fs";

let failures = 0;
function check(name, condition) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
}

const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");

function sliceBetween(startMarker, endMarker, fromIndex = 0) {
  const start = src.indexOf(startMarker, fromIndex);
  if (start < 0) return "";
  const end = src.indexOf(endMarker, start + startMarker.length);
  if (end < 0) return "";
  return src.slice(start, end + endMarker.length);
}
function withoutNeedle(region, needle) {
  return region.split(needle).join("");
}
function countOf(region, needle) {
  return (region.split(needle).length - 1);
}

// ── Region slices (one per prompt; a global-only scan would not catch a
// single prompt dropping its rule while another keeps it) ──
const plannerFn = sliceBetween("async function runStandalonePlanning", "const STEP_LABELS");
const speckitPhaseTask = sliceBetween("async function runPlanningPhase", 'const r=await relay("planner"');
const reviewerPrompt = sliceBetween("const reviewPrompt=[", '.filter(Boolean).join("\\n\\n")');
const initialReviewPrompt = sliceBetween("const initialReviewPrompt=", "Return PASS or FAIL with findings.");
const reReviewPrompt = sliceBetween('const reReviewPrompt=`Re-review', "REVIEWER_ALL_FINDINGS_LINE}`");
// Standalone revision vs fresh branches: the constant references sit in each
// branch's array head (before the "REVISION round" / "Content for PLAN.md"
// strings), so the slices must span the whole branch arrays, not just the
// prose between those strings.
const _promptHead = src.indexOf("const prompt=feedback?[");
const _revEnd = src.indexOf('].filter(Boolean).join("\\n\\n")', _promptHead);
const revisionBranch = (_promptHead >= 0 && _revEnd >= 0)
  ? src.slice(_promptHead, _revEnd + '].filter(Boolean).join("\\n\\n")'.length)
  : "";
const _freshStart = src.indexOf('].filter(Boolean).join("\\n\\n"):[', _promptHead);
const _freshEnd = _freshStart >= 0 ? src.indexOf('].join("\\n\\n")', _freshStart) : -1;
const freshBranch = (_freshStart >= 0 && _freshEnd >= 0)
  ? src.slice(_freshStart, _freshEnd + '].join("\\n\\n")'.length)
  : "";
const tasksBranch = sliceBetween('if(step==="tasks") return `', 'return "";', src.indexOf("function artifactContractNoteFor"));
const rulesComment = sliceBetween("// Planning-prompt rules", 'const PLANNER_READ_RANGE_LINE="');

check("regions: all eight prompt regions located",
  plannerFn.length > 0 && speckitPhaseTask.length > 0 && reviewerPrompt.length > 0
  && initialReviewPrompt.length > 0 && reReviewPrompt.length > 0
  && revisionBranch.length > 0 && freshBranch.length > 0 && tasksBranch.length > 0);

// ── 1. Canonical constants: defined exactly once at module level ──
check("canonical: REVIEWER_ALL_FINDINGS_LINE defined exactly once",
  countOf(src, 'const REVIEWER_ALL_FINDINGS_LINE="') === 1);
check("canonical: PLANNER_READ_RANGE_LINE defined exactly once",
  countOf(src, 'const PLANNER_READ_RANGE_LINE="') === 1);
check("canonical: rules defined next to PLANNER_PATHS_LINE",
  src.indexOf('const PLANNER_PATHS_LINE="') > 0
  && src.indexOf('const REVIEWER_ALL_FINDINGS_LINE="') > src.indexOf('const PLANNER_PATHS_LINE="')
  && src.indexOf('const PLANNER_READ_RANGE_LINE="') > src.indexOf('const REVIEWER_ALL_FINDINGS_LINE="'));

// ── 2. Reviewer one-pass rule: one reference per reviewer prompt ──
check("reviewer: standalone reviewPrompt carries the rule exactly once",
  countOf(reviewerPrompt, "REVIEWER_ALL_FINDINGS_LINE") === 1);
check("reviewer: speckit initialReviewPrompt carries the rule exactly once",
  countOf(initialReviewPrompt, "REVIEWER_ALL_FINDINGS_LINE") === 1);
check("reviewer: speckit reReviewPrompt carries the rule exactly once",
  countOf(reReviewPrompt, "REVIEWER_ALL_FINDINGS_LINE") === 1);
check("reviewer: fails when the standalone review rule is dropped",
  !withoutNeedle(reviewerPrompt, "REVIEWER_ALL_FINDINGS_LINE").includes("REVIEWER_ALL_FINDINGS_LINE"));
check("reviewer: fails when the initial-review rule is dropped",
  !withoutNeedle(initialReviewPrompt, "REVIEWER_ALL_FINDINGS_LINE").includes("REVIEWER_ALL_FINDINGS_LINE"));
check("reviewer: fails when the re-review rule is dropped",
  !withoutNeedle(reReviewPrompt, "REVIEWER_ALL_FINDINGS_LINE").includes("REVIEWER_ALL_FINDINGS_LINE"));

// ── 3. Planner read-range rule: one reference per planner prompt ──
check("read-range: standalone revision branch carries the rule exactly once",
  countOf(revisionBranch, "PLANNER_READ_RANGE_LINE") === 1);
check("read-range: standalone fresh branch carries the rule exactly once",
  countOf(freshBranch, "PLANNER_READ_RANGE_LINE") === 1);
check("read-range: standalone planner carries one reference per branch (two total)",
  countOf(plannerFn, "PLANNER_READ_RANGE_LINE") === 2);
check("read-range: speckit runPlanningPhase task carries the rule exactly once",
  countOf(speckitPhaseTask, "PLANNER_READ_RANGE_LINE") === 1);
check("read-range: tasks-stage contract carries no duplicate (rendered prompt keeps exactly one)",
  !tasksBranch.includes("PLANNER_READ_RANGE_LINE"));
check("read-range: fails when the revision-branch rule is dropped",
  !withoutNeedle(revisionBranch, "PLANNER_READ_RANGE_LINE").includes("PLANNER_READ_RANGE_LINE"));
check("read-range: fails when the fresh-branch rule is dropped",
  !withoutNeedle(freshBranch, "PLANNER_READ_RANGE_LINE").includes("PLANNER_READ_RANGE_LINE"));
check("read-range: fails when the speckit-phase rule is dropped",
  !withoutNeedle(speckitPhaseTask, "PLANNER_READ_RANGE_LINE").includes("PLANNER_READ_RANGE_LINE"));

// ── 4. No inline wording copies: each rule's distinctive wording lives only
// in its const definition ──
check("no-inline: reviewer wording lives only in its const definition",
  countOf(src, "Report everything you can see in ONE pass") === 1);
check("no-inline: read-range wording lives only in its const definition",
  countOf(src, "never read a whole large file into context") === 1);

// ── 5. New comments and constant wording avoid legacy cite forms ──
for (const [region, regionName] of [
  [rulesComment, "rules-comment"],
  [reviewerPrompt, "standalone-review"],
  [initialReviewPrompt, "speckit-initial-review"],
  [reReviewPrompt, "speckit-re-review"],
  [revisionBranch, "standalone-revision"],
  [freshBranch, "standalone-fresh"],
  [speckitPhaseTask, "speckit-phase"],
]) {
  check(`${regionName}: no legacy cite "backlog item N"`, !/backlog item \d+/i.test(region));
  check(`${regionName}: no legacy cite ".autopilot/tasks/"`, !/\.autopilot\/tasks/.test(region));
}

if (failures) {
  console.error(`${failures} backlog-58bc-prompt-rule check(s) failed.`);
  process.exit(1);
}
console.log("backlog-58bc prompt-rule tests passed");
