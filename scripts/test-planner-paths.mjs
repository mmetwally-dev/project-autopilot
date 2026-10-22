#!/usr/bin/env node
// Mission 031 Phase 9 task 9.1 — planner prompts use exact sandbox-visible paths.
//
// Pins that every planner prompt (standalone fresh + revision branches,
// SpecKit planning phase, GSD planning stage, SpecKit tasks artifact
// contract) carries the canonical PLANNER_PATHS_LINE exact-paths guidance,
// that the standalone prompts cite the absolute plan/tasks path variables,
// and that no planner prompt region contains the forbidden sandbox-invisible
// cite forms ("re-read backlog item N", ".autopilot/tasks/"). Static source
// pins fail if any prompt drops the guidance or reintroduces a forbidden cite.
import fs from "node:fs";

let failures = 0;
function check(name, condition) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
}

const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");

// ── Region slices (one per planner prompt; a global-only scan would not
// catch a single prompt dropping the guidance while another keeps it) ──
function sliceBetween(startMarker, endMarker, fromIndex = 0) {
  const start = src.indexOf(startMarker, fromIndex);
  if (start < 0) return "";
  const end = src.indexOf(endMarker, start + startMarker.length);
  if (end < 0) return "";
  return src.slice(start, end + endMarker.length);
}

// Standalone planner function body (both prompt branches live here).
const plannerFn = sliceBetween("async function runStandalonePlanning", "const STEP_LABELS");
// SpecKit planning-phase task builder (runPlanningPhase). End marker is the
// planner relay call — an earlier end marker (enforcePlanningWriteBoundary)
// appears inside a function comment and would truncate the slice before the
// task template literal that carries ${PLANNER_PATHS_LINE}.
const speckitPhaseTask = sliceBetween("async function runPlanningPhase", 'const r=await relay("planner"');
// GSD planning-stage prompt array (gsdPlanningStage).
const gsdStagePrompt = sliceBetween("async function gsdPlanningStage", "const r=await relayAsync");
// SpecKit tasks artifact contract branch (artifactContractNoteFor, tasks step).
const tasksBranch = sliceBetween('if(step==="tasks") return `', "return \"\";", src.indexOf("function artifactContractNoteFor"));
// Standalone revision prompt branch (feedback non-empty).
const revisionBranch = sliceBetween("This is a REVISION round", "Plan reviewer feedback that MUST be addressed");

check("regions: all five planner prompt regions located",
  plannerFn.length > 0 && speckitPhaseTask.length > 0 && gsdStagePrompt.length > 0
  && tasksBranch.length > 0 && revisionBranch.length > 0);

// ── 1. Forbidden patterns: no planner prompt may cite sandbox-invisible
// artifacts (legacy per-task directories or remembered backlog numbers) ──
const FORBIDDEN = [
  [/re-read backlog/i, "re-read backlog"],
  [/backlog item \d+/i, "backlog item N"],
  [/\.autopilot\/tasks/, ".autopilot/tasks/"],
];
for (const [region, regionName] of [
  [plannerFn, "standalone"],
  [speckitPhaseTask, "speckit-phase"],
  [gsdStagePrompt, "gsd-stage"],
  [tasksBranch, "speckit-tasks-contract"],
  [revisionBranch, "standalone-revision"],
]) {
  for (const [re, label] of FORBIDDEN) {
    check(`${regionName}: no forbidden cite "${label}"`, !re.test(region));
  }
}

// ── 2. Canonical exact-paths line: defined once, worded to name the plan
// and task artifacts and to demand absolute sandbox-visible paths ──
check("canonical line: PLANNER_PATHS_LINE defined exactly once at module level",
  (src.match(/const PLANNER_PATHS_LINE="/) || []).length === 1);
check("canonical line: requires absolute sandbox-visible artifact paths",
  /const PLANNER_PATHS_LINE="[^"]*absolute sandbox-visible/.test(src));
check("canonical line: names the plan and task artifacts",
  /const PLANNER_PATHS_LINE="[^"]*PLAN\.md and TASKS\.md/.test(src));

// ── 3. The canonical line is wired into every planner prompt ──
check("standalone-planner: PLANNER_PATHS_LINE wired into both prompt branches",
  plannerFn.includes("PLANNER_PATHS_LINE,")
  && (plannerFn.match(/PLANNER_PATHS_LINE,/g) || []).length >= 2);
check("speckit-phase: PLANNER_PATHS_LINE in the planning-phase task",
  speckitPhaseTask.includes("${PLANNER_PATHS_LINE}"));
check("gsd-stage: PLANNER_PATHS_LINE in the GSD planning-stage prompt",
  gsdStagePrompt.includes("PLANNER_PATHS_LINE,"));
check("speckit-tasks-contract: PLANNER_PATHS_LINE in the tasks artifact contract",
  tasksBranch.includes("PLANNER_PATHS_LINE"));

// ── 4. Standalone prompts cite the exact absolute path variables ──
check("standalone-planner: both branches cite the exact plan/tasks path variables",
  plannerFn.includes("to exactly: ${file}") && plannerFn.includes("to exactly: ${tasksFile}"));
// The revision read line must be a template literal (backticks) so the real
// absolute paths are interpolated — a double-quoted "${file}" would hand the
// planner the literal text '${file}'. Match the backtick form so a
// double-quoted regression fails.
check("standalone-revision: read-in-full line cites ${file} and ${tasksFile} via a template literal",
  /`This is a REVISION round[^`]*\$\{file\}[^`]*\$\{tasksFile\}/.test(revisionBranch)
  || /`This is a REVISION round[^`]*\$\{file\}[^`]*\$\{tasksFile\}/.test(src));

// ── 5. SpecKit/GSD prompts cite real absolute artifact paths above
// PLANNER_PATHS_LINE, so "read the exact paths above" resolves ──
check("speckit-phase: cites absolute spec/plan/tasks artifact paths",
  speckitPhaseTask.includes("speckitPathsLine")
  && speckitPhaseTask.includes("${speckitPlanAbs}")
  && speckitPhaseTask.includes("${speckitTasksAbs}")
  && speckitPhaseTask.includes('path.join(repo,"specs"'));
check("speckit-tasks-contract: cites absolute tasks.md and companion plan.md paths",
  tasksBranch.includes("${absFeature}/tasks.md")
  && tasksBranch.includes("${absFeature}/plan.md"));
check("speckit-plan-contract: cites absolute plan.md and companion tasks.md paths",
  src.includes("${absFeature}/plan.md") && src.includes("${absFeature}/tasks.md"));
check("gsd-stage: cites absolute planning dir and target phase dir",
  gsdStagePrompt.includes("gsdPathsLine")
  && (gsdStagePrompt.includes("${gsdPhaseAbs}") || gsdStagePrompt.includes("planning dir:")));

if (failures) {
  console.error(`${failures} planner-paths check(s) failed.`);
  process.exit(1);
}
console.log("planner-paths tests passed");
