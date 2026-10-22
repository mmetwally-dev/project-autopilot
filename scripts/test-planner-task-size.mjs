#!/usr/bin/env node
// Mission 026 Phase 2 task 2.3 — both-loops planner task-size regression test.
//
// Pins that the build-then-wire split rule is present in all four planning
// prompts (standalone planner, standalone plan-reviewer, SpecKit tasks-stage
// planner contract, SpecKit review-tasks gate) and that the 10-tasks-per-phase
// rule still appears alongside it in the standalone planner (both revision
// and fresh branches). Static source pins fail if any prompt drops its rule.
import fs from "node:fs";

let failures = 0;
function check(name, condition) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
}

const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
const count = (re) => [...src.matchAll(re)].length;

const SPLIT_TAG = "build-then-wire";
const SPLIT_WIRE = "build, then wire";
const TEN_TASKS = "Keep each phase to at most ${MAX_PHASE_TASKS} tasks";

// ── Region slices (one per prompt; a global-only contains() would not catch
// a single prompt dropping the rule while another keeps it) ──
function sliceBetween(startMarker, endMarker, fromIndex = 0) {
  const start = src.indexOf(startMarker, fromIndex);
  if (start < 0) return "";
  const end = src.indexOf(endMarker, start + startMarker.length);
  if (end < 0) return "";
  return src.slice(start, end + endMarker.length);
}

// Standalone planner function body (both prompt branches live here).
const plannerFn = sliceBetween("runStandalonePlanning", "const STEP_LABELS");
// Standalone reviewer prompt array (inside the planner function, after it).
const reviewerPrompt = sliceBetween("const reviewPrompt=[", '.filter(Boolean).join("\\n\\n")');
// SpecKit tasks-stage planner contract (artifactContractNoteFor tasks branch).
const tasksContractFn = sliceBetween("function artifactContractNoteFor", "Previous attempt at this stage failed validation");
const tasksBranch = sliceBetween('if(step==="tasks") return `', "return \"\";", src.indexOf("function artifactContractNoteFor"));
// SpecKit review-tasks gate reviewer note.
const gateNote = sliceBetween("const tasksGateNote", ': "";');

check("regions: all four prompt regions located",
  plannerFn.length > 0 && reviewerPrompt.length > 0 && tasksBranch.length > 0 && gateNote.length > 0);

// ── 1. Standalone planner: canonical split line defined once ──
const taskSizeDef = sliceBetween('const taskSizeLine="', '";');
check("standalone-planner: taskSizeLine carries the build-then-wire split rule",
  taskSizeDef.includes(SPLIT_TAG) && taskSizeDef.includes(SPLIT_WIRE)
  && taskSizeDef.includes("never combine both in a single task"));
check("standalone-planner: taskSizeLine wired into both prompt branches (def + 2 uses)",
  count(/taskSizeLine/g) >= 3
  && plannerFn.includes("taskSizeLine,")
  && (plannerFn.match(/taskSizeLine,/g) || []).length >= 2);

// ── 2. Standalone planner: 10-tasks-per-phase rule untouched, alongside split ──
check("standalone-planner: 10-tasks-per-phase rule present in both branches",
  (plannerFn.match(/phaseTaskLimitLine,/g) || []).length >= 2
  && plannerFn.includes(TEN_TASKS));
check("standalone-planner: split rule appears alongside the 10-tasks rule",
  plannerFn.includes(SPLIT_TAG) && plannerFn.includes(TEN_TASKS));

// ── 3. Standalone plan-reviewer: FAILs an oversized single task by numeric ID ──
check("standalone-reviewer: split rule present (FAIL build-then-wire single task)",
  reviewerPrompt.includes(SPLIT_TAG) && reviewerPrompt.includes(SPLIT_WIRE));
check("standalone-reviewer: cites the oversized task by numeric ID",
  reviewerPrompt.includes("numeric ID") && reviewerPrompt.includes("TASKS.md 2.3"));

// ── 4. SpecKit tasks-stage planner contract ──
check("speckit-tasks: split rule present in the tasks artifact contract",
  tasksContractFn.includes(SPLIT_TAG) && tasksBranch.includes(SPLIT_TAG)
  && tasksBranch.includes(SPLIT_WIRE));

// ── 5. SpecKit review-tasks gate reviewer prompt ──
check("speckit-gate: split rule present in the review-tasks gate note",
  gateNote.includes(SPLIT_TAG) && gateNote.includes(SPLIT_WIRE));
check("speckit-gate: gate cites the oversized task by its ID",
  gateNote.includes("cite the oversized task by its ID"));

// ── 6. Over-splitting guard (merge tiny tasks, no file-less tasks) ──
check("standalone-planner: merge rule in both variants",
  (plannerFn.match(/mergeTasksLine,/g) || []).length === 2
  && src.includes("Do not create a task that only runs tests or") && src.includes("a new phase is for a separate deliverable, not a separate file"));
check("standalone-reviewer: FAIL file-less tasks, never small ones",
  reviewerPrompt.includes("FAIL a task that changes no files") && reviewerPrompt.includes("Do NOT FAIL small tasks")
  && !reviewerPrompt.includes("tiny tasks or phases that should be merged"));
check("standalone-planner: phaseBoundaryLine in both variants with its text",
  (plannerFn.match(/phaseBoundaryLine,/g) || []).length === 2
  && src.includes("Phases are cut by deliverable: a new phase is for a separate deliverable, not a separate file.")
  && src.includes("write the reason for each phase boundary in PLAN.md under 'Phase boundaries'."));
check("standalone-reviewer: never pushes tasks bigger for fewer phases",
  reviewerPrompt.includes("task size wins over phase count")
  && !reviewerPrompt.includes("plan of 5 or fewer tasks split into several phases"));

if (failures) {
  console.error(`${failures} planner-task-size check(s) failed.`);
  process.exit(1);
}
console.log("planner-task-size tests passed");
