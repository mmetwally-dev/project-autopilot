#!/usr/bin/env node
// Mission 068 Phase 1 task 1.1: unit tests for the pure no-progress
// escalation helpers in per-task-budget.mjs (no autopilot import —
// autopilot.mjs runs main() on import). Covers the trip predicate (fires at
// the limit) and the display-label builder (real task id wins; null-taskId
// range refs and planning-scope edge cases never render "task null").
import {
  noProgressDisplayLabel,
  shouldStopOnNoProgress,
  evaluateNoProgressStop,
} from "./per-task-budget.mjs";
import fs from "node:fs";

let ok = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  failed += 1;
}

// ── Trip predicate: fires at the limit ──
{
  check("trip: below limit does not fire",
    shouldStopOnNoProgress({consecutive: 1, limit: 2}) === false);
  check("trip: fires at the limit",
    shouldStopOnNoProgress({consecutive: 2, limit: 2}) === true);
  check("trip: fires above the limit",
    shouldStopOnNoProgress({consecutive: 3, limit: 2}) === true);
  check("trip: zero consecutive never fires",
    shouldStopOnNoProgress({consecutive: 0, limit: 2}) === false);
  check("trip: ambiguous input never fires",
    shouldStopOnNoProgress({}) === false
    && shouldStopOnNoProgress({consecutive: 2}) === false
    && shouldStopOnNoProgress({consecutive: 2, limit: 0}) === false
    && shouldStopOnNoProgress({consecutive: 2, limit: -1}) === false
    && shouldStopOnNoProgress({consecutive: -1, limit: 2}) === false
    && shouldStopOnNoProgress({consecutive: 1.5, limit: 2}) === false
    && shouldStopOnNoProgress({consecutive: "2", limit: "x"}) === false);
}

// ── Label: real task id wins ──
{
  check("label: real task id used",
    noProgressDisplayLabel({taskId: "T1.1", taskRef: "T1.1", framework: "standalone"}) === "task T1.1");
  check("label: real task id wins over range taskRef",
    noProgressDisplayLabel({taskId: "T2.2", taskRef: "T1.1 > T1.3", framework: "standalone"}) === "task T2.2");
  check("label: speckit prefix with real task id",
    noProgressDisplayLabel({taskId: "T1.1", taskRef: "T1.1", framework: "speckit"}) === "task T1.1");
}

// ── Label: null-taskId range refs ──
{
  check("label: null taskId range ref is plural tasks",
    noProgressDisplayLabel({taskId: null, taskRef: "T1.1 > T1.3", framework: "standalone"}) === "tasks T1.1 > T1.3");
  check("label: null taskId comma range is plural tasks",
    noProgressDisplayLabel({taskId: null, taskRef: "T1.1, T003", framework: "standalone"}) === "tasks T1.1, T003");
  check("label: null taskId single ref stays singular",
    noProgressDisplayLabel({taskId: null, taskRef: "T1.1", framework: "standalone"}) === "task T1.1");
  check("label: speckit range ref is plural tasks",
    noProgressDisplayLabel({taskId: null, taskRef: "T1.1 > T1.3", framework: "speckit"}) === "tasks T1.1 > T1.3");
}

// ── Label: planning-scope edge cases ──
{
  check("label: standalone-planning-planner short ref",
    noProgressDisplayLabel({taskId: null, taskRef: "standalone-planning-planner", framework: "standalone"}) === "Standalone planner");
  check("label: planning planner continuation scope",
    noProgressDisplayLabel({taskId: null, taskRef: "task:standalone:planning:planner", framework: "standalone"}) === "Standalone planner");
  check("label: standalone-planning-plan_reviewer short ref",
    noProgressDisplayLabel({taskId: null, taskRef: "standalone-planning-plan_reviewer", framework: "standalone"}) === "Standalone plan reviewer");
  check("label: planning plan_reviewer continuation scope",
    noProgressDisplayLabel({taskId: null, taskRef: "task:standalone:planning:plan_reviewer", framework: "standalone"}) === "Standalone plan reviewer");
  check("label: gsd planning planner continuation scope",
    noProgressDisplayLabel({taskId: null, taskRef: "task:gsd:planning:planner", framework: "gsd"}) === "GSD planner");
  check("label: gsd planning plan_reviewer continuation scope",
    noProgressDisplayLabel({taskId: null, taskRef: "task:gsd:planning:plan_reviewer", framework: "gsd"}) === "GSD plan reviewer");
  check("label: gsd framework fallback",
    noProgressDisplayLabel({taskId: null, taskRef: null, framework: "gsd"}) === "GSD task");
}

// ── Label: never "task null" ──
{
  const cases = [
    noProgressDisplayLabel({taskId: null, taskRef: null, framework: "standalone"}),
    noProgressDisplayLabel({taskId: null, taskRef: undefined, framework: "standalone"}),
    noProgressDisplayLabel({taskId: null, taskRef: "", framework: "standalone"}),
    noProgressDisplayLabel({taskId: null, taskRef: "T1.1 > T1.3", framework: "standalone"}),
    noProgressDisplayLabel({taskId: null, taskRef: "standalone-planning-planner", framework: "standalone"}),
    noProgressDisplayLabel({taskId: null, taskRef: null, framework: "speckit"}),
    noProgressDisplayLabel({}),
  ];
  check("label: never renders task null/undefined/empty",
    cases.every((l) => typeof l === "string" && l.length > 0 && !/task\s+(null|undefined)\b/i.test(l)
      && !/\bnull\b/i.test(l) && !/\bundefined\b/i.test(l)), cases);
  check("label: missing ref falls back to framework task",
    noProgressDisplayLabel({taskId: null, taskRef: null, framework: "standalone"}) === "Standalone task"
    && noProgressDisplayLabel({taskId: null, taskRef: null, framework: "speckit"}) === "SpecKit task");
}

// ── Combined decision helper ──
{
  const fired = evaluateNoProgressStop({consecutive: 2, limit: 2, taskId: null, taskRef: "T1.1 > T1.3", framework: "standalone"});
  check("combined: tripped with range label at limit",
    fired.tripped === true && fired.label === "tasks T1.1 > T1.3", fired);
  const pending = evaluateNoProgressStop({consecutive: 1, limit: 2, taskId: "T1.1", taskRef: "T1.1", framework: "standalone"});
  check("combined: not tripped below limit with real id label",
    pending.tripped === false && pending.label === "task T1.1", pending);
  const planning = evaluateNoProgressStop({consecutive: 2, limit: 2, taskId: null, taskRef: "standalone-planning-planner", framework: "standalone"});
  check("combined: planning scope label at limit",
    planning.tripped === true && planning.label === "Standalone planner", planning);
}

// ── Purity: no role param, no IO ──
{
  const paramsOf = (fn) => (fn.toString().split("{")[0] ?? "");
  check("purity: label takes no role param",
    noProgressDisplayLabel.length <= 1 && !/role/i.test(paramsOf(noProgressDisplayLabel)));
  check("purity: predicate takes no role param",
    !/role/i.test(paramsOf(shouldStopOnNoProgress)) && !/role/i.test(paramsOf(evaluateNoProgressStop)));
  const src = [noProgressDisplayLabel.toString(), shouldStopOnNoProgress.toString(), evaluateNoProgressStop.toString()].join("\n");
  check("purity: no IO (fs/process/require/import/Date/clock)",
    !/\b(fs|process|require|readFile|writeFile|Date\.now|fetch|setTimeout|setInterval)\b/.test(src), null);
}

// ── Wiring (068 1.2): helper label in stopOnNoProgress, read-only sites exempt ──
{
  const auto = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
  const count = (re) => [...auto.matchAll(re)].length;
  const stopFn = auto.slice(auto.indexOf("function stopOnNoProgress("));
  const stopBody = stopFn.slice(0, stopFn.indexOf("\nfunction clearHandoffNote("));
  check("wiring: autopilot imports noProgressDisplayLabel from per-task-budget",
    auto.includes("noProgressDisplayLabel,") && auto.includes('from "./per-task-budget.mjs"'));
  check("wiring: stopOnNoProgress builds its subject via noProgressDisplayLabel",
    /noProgressDisplayLabel\(\{taskId,taskRef,framework\}\)/.test(stopBody));
  const stopCode = stopBody.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  check("wiring: stopOnNoProgress never interpolates bare taskId (no task null)",
    !/task \$\{taskId\} changed no file/.test(stopCode) && !/task null/i.test(stopCode)
    && /die\(`\$\{noProgSubject\} changed no file/.test(stopCode));
  check("wiring: implementer sites unchanged (3 standalone + 3 speckit)",
    count(/stopOnNoProgress\(s,c,\{framework:"standalone",contScope,taskId,missionName:mission,taskRef:taskDisplayRef\(phaseTasks\[taskIndex\],taskIndex\),touchedFiles:taskImpl\.touchedFiles,checkpoint\}\)/g) === 3
    && count(/stopOnNoProgress\(s,c,\{framework:"speckit",contScope,taskId,missionName:missionIdentity,taskRef:taskDisplayRef\(phaseTasks\[taskIndex\],taskIndex\),touchedFiles:taskImpl\.touchedFiles,checkpoint\}\)/g) === 3);
  check("wiring: standalone reviewer/verifier read-only sites never escalate",
    count(/stopOnNoProgress\(s,c,\{framework:"standalone",contScope,taskId:null,missionName:mission,taskRef:(reviewRef|verifyRef),touchedFiles:reviewNoProgressTouchedFiles\(mission,(reviewRef|verifyRef),contScope,s\),checkpoint\}\)/g) === 0);
  check("wiring: speckit reviewer/verifier read-only sites never escalate",
    count(/stopOnNoProgress\(s,c,\{framework:"speckit",contScope,taskId:null,missionName:missionIdentity,taskRef:(reviewRef|verifyRef),touchedFiles:reviewNoProgressTouchedFiles\(missionIdentity,(reviewRef|verifyRef),contScope,s\),checkpoint\}\)/g) === 0);
  check("wiring: plan_reviewer capped sessions never escalate standalone_planning_no_progress (068 1.3)",
    count(/stopOnNoProgress\(s,c,\{framework:"standalone",contScope,taskId:null,missionName:mission,taskRef:'standalone-planning-plan_reviewer',touchedFiles:reviewNoProgressTouchedFiles\(mission,'standalone-planning-plan_reviewer',contScope,s\),checkpoint:s\[CHECKPOINT_STATE_KEY\],step:"standalone_planning_no_progress"\}\)/g) === 0);
  check("wiring: planner sites unchanged (capped + incomplete, 2 sites, 068 1.3)",
    count(/stopOnNoProgress\(s,c,\{framework:"standalone",contScope,taskId:null,missionName:mission,taskRef:'standalone-planning-planner',touchedFiles:planningNoProgressTouchedFiles\(file,tasksFile,contScope,s\),checkpoint:s\[CHECKPOINT_STATE_KEY\],step:"standalone_planning_no_progress"\}\)/g) === 2);
  check("wiring: helper + import kept (068 1.3)",
    /function reviewNoProgressTouchedFiles\(missionName, taskRef, contScope, s\)/.test(auto)
    && /parseFoundEntries/.test(auto) && auto.includes('from "./standalone-handoff.mjs"'));
  check("wiring: contScope resume-hint text unchanged",
    count(/Resume: ap reset --scope \$\{contScope\} then ap run/g) >= 8
    && count(/continuing as session \$\{cont\.used\+1\} of \$\{cont\.limit\+1\}/g) >= 8);
}

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
