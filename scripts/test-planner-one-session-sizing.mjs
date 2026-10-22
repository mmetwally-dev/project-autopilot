#!/usr/bin/env node
// Mission 027 Phase 1 task 1.4 — all-four-prompts plus oversized-fixture pin.
//
// Pins that the one-session sizing line is present in both standalone planner
// prompt branches (fresh + revision) reusing the taskSizeLine pattern, and
// that the 10-tasks-per-phase and build-then-wire lines remain alongside it.
// Static source pins fail if any prompt drops its rule.
import fs from "node:fs";
import {taskSizingRuleText, taskSizeReviewText} from "./per-task-budget.mjs";

let failures = 0;
function check(name, condition) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
}

const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
const count = (re) => [...src.matchAll(re)].length;

const TEN_TASKS = "Keep each phase to at most ${MAX_PHASE_TASKS} tasks";
const SPLIT_TAG = "build-then-wire";

function sliceBetween(startMarker, endMarker, fromIndex = 0) {
  const start = src.indexOf(startMarker, fromIndex);
  if (start < 0) return "";
  const end = src.indexOf(endMarker, start + startMarker.length);
  if (end < 0) return "";
  return src.slice(start, end + endMarker.length);
}

// Backlog #111: the sizing/review wording lives in per-task-budget.mjs helpers
// (target = policy.task_size_target_turns); expand the helper calls to their
// default text so the wording pins below keep checking what the prompt carries.
const expand = (r) => r
  .replace(/taskSizingRuleText\(/g, () => taskSizingRuleText(30) + " //(")
  .replace(/taskSizeReviewText\(/g, () => taskSizeReviewText(30) + " //(");

// Standalone planner function body (both prompt branches live here).
const plannerFn = sliceBetween("runStandalonePlanning", "const STEP_LABELS");
const plannerFnRaw = plannerFn;
// Standalone reviewer prompt array (inside the planner function, after it).
const reviewerPrompt = expand(sliceBetween("const reviewPrompt=[", '.filter(Boolean).join("\\n\\n")'));
// SpecKit twins: tasks-stage artifact contract + review-tasks gate note.
const speckitTasksContract = expand(sliceBetween("function artifactContractNoteFor", "function sanitizedPostconditionFeedback"));
const speckitGateNote = expand(sliceBetween("const tasksGateNote", ': "";'));

check("regions: standalone planner region located", plannerFn.length > 0);
check("regions: standalone reviewer region located", reviewerPrompt.length > 0);
check("regions: speckit tasks-contract region located", speckitTasksContract.length > 0);
check("regions: speckit gate-note region located", speckitGateNote.length > 0);

// ── 1. Standalone planner: canonical one-session sizing line defined once ──
const sizingDef = expand(sliceBetween("const oneSessionLine=", ";\n"));
check("standalone-planner: oneSessionLine carries the one-session sizing rule",
  sizingDef.includes("one implementer session")
  && sizingDef.includes("one implementer session")
  && sizingDef.includes("Task size wins over phase count"));
check("standalone-planner: oneSessionLine wired into both prompt branches (def + 2 uses)",
  count(/oneSessionLine/g) >= 3
  && plannerFn.includes("oneSessionLine,")
  && (plannerFn.match(/oneSessionLine,/g) || []).length >= 2);

// ── 2. Standalone planner: 10-tasks and build-then-wire lines intact alongside ──
check("standalone-planner: 10-tasks-per-phase rule present in both branches",
  (plannerFn.match(/phaseTaskLimitLine,/g) || []).length >= 2
  && plannerFn.includes(TEN_TASKS));
check("standalone-planner: build-then-wire line present in both branches",
  plannerFn.includes(SPLIT_TAG)
  && (plannerFn.match(/taskSizeLine,/g) || []).length >= 2);
check("standalone-planner: sizing rule appears alongside the 10-tasks and split rules",
  plannerFn.includes(TEN_TASKS) && plannerFn.includes(SPLIT_TAG)
  && plannerFn.includes("oneSessionLine"));

// ── 3. Standalone plan-reviewer: FAILs a task likely to exceed one session ──
check("standalone-reviewer: FAILs a task that breaks the concrete size rule",
  reviewerPrompt.includes("FAIL") && reviewerPrompt.includes("more than 3 distinct changes")
  && reviewerPrompt.includes("more than 2 files to edit"));
check("standalone-reviewer: cites the oversized task by numeric ID",
  reviewerPrompt.includes("numeric ID") && reviewerPrompt.includes("TASKS.md 2.3"));
check("standalone-reviewer: gives the concrete size rule (count changes/files)",
  reviewerPrompt.includes("more than 3 distinct changes")
  && reviewerPrompt.includes("more than 2 files to edit"));

// ── 4. SpecKit tasks-stage artifact contract: sizes every task to one session ──
check("speckit-tasks: sizes every task to one implementer session",
  speckitTasksContract.includes("ONE concrete action")
  && speckitTasksContract.includes("about ONE file")
  && speckitTasksContract.includes("Task size wins over phase count"));
check("speckit-tasks: build-then-wire line intact alongside the sizing rule",
  speckitTasksContract.includes(SPLIT_TAG)
  && speckitTasksContract.includes("ONE concrete action"));

// ── 5. SpecKit review-tasks gate: FAILs oversized tasks citing ID as written ──
check("speckit-gate: FAILs a task that breaks the concrete size rule",
  speckitGateNote.includes("FAIL") && speckitGateNote.includes("more than 3 distinct changes")
  && speckitGateNote.includes("more than 2 files to edit"));
check("speckit-gate: cites the oversized task by ID as written (e.g. T001)",
  speckitGateNote.includes("T001") && speckitGateNote.includes("exactly as written"));
check("speckit-gate: build-then-wire line intact alongside the sizing rule",
  speckitGateNote.includes(SPLIT_TAG) && speckitGateNote.includes("more than 3 distinct changes"));

// ── 6. Oversized fixture: every prompt must carry a rule that rejects it ──
// Fixture is deliberately oversized: spans many files and many sequential
// steps so it cannot fit one implementer session under the per-task caps.
const OVERSIZED_FIXTURE = [
  "T999/9.9 Rewrite all 40 modules across 25 files with 12 sequential",
  "migration steps, touching many files with many sequential dependencies,",
  "far beyond one implementer session under the per-task turn/token caps.",
].join(" ");
check("oversized-fixture: fixture itself is oversized beyond one session",
  OVERSIZED_FIXTURE.includes("many files")
  && OVERSIZED_FIXTURE.includes("many sequential")
  && OVERSIZED_FIXTURE.includes("one implementer session"));

// Per-prompt rejection predicates mirror the sizing rules pinned above: a
// prompt rejects the oversized fixture only while it keeps its sizing line.
function plannerRejects(region) {
  return region.includes("oneSessionLine")
    && sizingDef.includes("one implementer session")
    && sizingDef.includes("Task size wins over phase count")
    && (region.match(/oneSessionLine,/g) || []).length >= 2;
}
function reviewerRejects(region) {
  return region.includes("FAIL") && region.includes("more than 3 distinct changes")
    && region.includes("more than 2 files to edit") && region.includes("numeric ID");
}
function tasksContractRejects(region) {
  return region.includes("ONE concrete action") && region.includes("more than 3 distinct changes");
}
function gateRejects(region) {
  return region.includes("FAIL") && region.includes("more than 3 distinct changes")
    && region.includes("more than 2 files to edit") && region.includes("T001");
}
function withoutNeedle(region, needle) {
  return region.split(needle).join("");
}

check("oversized-fixture: standalone planner (both branches) rejects it",
  plannerRejects(plannerFn));
check("oversized-fixture: standalone planner misses it when any branch drops the line",
  !plannerRejects(withoutNeedle(plannerFn, "oneSessionLine,"))
  && !plannerRejects(withoutNeedle(sizingDef, "one implementer session")));
check("oversized-fixture: standalone reviewer rejects it",
  reviewerRejects(reviewerPrompt));
check("oversized-fixture: standalone reviewer misses it when the rule is dropped",
  !reviewerRejects(withoutNeedle(reviewerPrompt, "more than 3 distinct changes"))
  && !reviewerRejects(withoutNeedle(reviewerPrompt, "FAIL")));
check("oversized-fixture: speckit tasks contract rejects it",
  tasksContractRejects(speckitTasksContract));
check("oversized-fixture: speckit tasks contract misses it when the rule is dropped",
  !tasksContractRejects(withoutNeedle(speckitTasksContract, "ONE concrete action")));
check("oversized-fixture: speckit gate rejects it",
  gateRejects(speckitGateNote));
check("oversized-fixture: speckit gate misses it when the rule is dropped",
  !gateRejects(withoutNeedle(speckitGateNote, "more than 3 distinct changes"))
  && !gateRejects(withoutNeedle(speckitGateNote, "FAIL")));
check("oversized-fixture: all four prompts reject the oversized fixture",
  plannerRejects(plannerFn) && reviewerRejects(reviewerPrompt)
  && tasksContractRejects(speckitTasksContract) && gateRejects(speckitGateNote));

if (failures) {
  console.error(`${failures} planner-one-session-sizing check(s) failed.`);
  process.exit(1);
}
console.log("planner-one-session-sizing tests passed");
