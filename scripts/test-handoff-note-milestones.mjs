#!/usr/bin/env node
// Mission 027 Phase 2 task 2.2 — implementer brief milestone wording tests.
//
// Pins the hand-off note section in role-progress-prompt.mjs: exact task
// path, the overwrite discipline, and the four note sections with milestone
// triggers (after every important finding, before every edit, after the task
// verify), for both standalone **1.1** and SpecKit T001 refs.
import {buildTaskPrompt, SECTION} from "./role-progress-prompt.mjs";
import {emptyRoleProgress} from "./phase-stage-checkpoint.mjs";

let failures = 0;
function check(name, condition, evidence) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(evidence)}` : ""}`); }
}

const DIGEST = "sha256:" + "d".repeat(64);

function optsFor(framework, mission, taskId, task) {
  const progress = emptyRoleProgress();
  progress.implementer.status = "running";
  progress.implementer.taskCursor = 0;
  progress.implementer.currentTaskId = taskId;
  return {
    framework,
    mission,
    phaseIndex: 0,
    phaseNumber: 1,
    phaseName: "P1",
    phaseTotal: 1,
    revision: 1,
    role: "implementer",
    phaseTaskDigest: DIGEST,
    taskIds: [taskId],
    tasks: [task],
    currentTaskId: taskId,
    roleProgress: progress,
  };
}

function noteSection(text) {
  const marker = `## ${SECTION.handoffNote}`;
  const idx = text.indexOf(marker);
  return idx === -1 ? "" : text.slice(idx);
}

// ── Standalone **1.1** ref ──
const standaloneTaskId = "standalone:P2:T1:abc123";
const standaloneTask = {id: standaloneTaskId, text: "**1.1** Do the first thing", file: ".autopilot/missions/027-fix-backlog-cut/TASKS.md", line: 11};
const standaloneBuilt = buildTaskPrompt(optsFor("standalone", "027-fix-backlog-cut", standaloneTaskId, standaloneTask));
const standalonePath = ".autopilot/missions/027-fix-backlog-cut/handoff/T1.1.md";
check("standalone: implementer prompt assembles", standaloneBuilt.ok === true, standaloneBuilt);
const standaloneSection = standaloneBuilt.ok ? noteSection(standaloneBuilt.text) : "";
check("standalone: note section names the exact task path",
  standaloneBuilt.ok && standaloneBuilt.text.includes(`Keep a hand-off note at ${standalonePath}`), standalonePath);
check("standalone: note section pins the overwrite discipline",
  standaloneSection.includes("OVERWRITE it (never append)"), standaloneSection.slice(0, 300));
check("standalone: note section names the milestone triggers",
  /after every important finding/i.test(standaloneSection)
  && /before every edit/i.test(standaloneSection)
  && /after the task verify/i.test(standaloneSection), standaloneSection.slice(0, 400));
check("standalone: note section lists the four note sections",
  standaloneSection.includes("1. Done") && standaloneSection.includes("2. Found")
  && standaloneSection.includes("3. Next") && standaloneSection.includes("4. Dead ends"),
  standaloneSection.slice(0, 600));

// ── SpecKit T001 ref ──
const speckitTaskId = "speckit:P2:T0:def456";
const speckitTask = {id: speckitTaskId, text: "T001 Do the first thing", file: "specs/001-x/tasks.md", line: 5};
const speckitBuilt = buildTaskPrompt(optsFor("speckit", "027-fix-backlog-cut", speckitTaskId, speckitTask));
const speckitPath = ".autopilot/missions/027-fix-backlog-cut/handoff/T001.md";
check("speckit: implementer prompt assembles", speckitBuilt.ok === true, speckitBuilt);
const speckitSection = speckitBuilt.ok ? noteSection(speckitBuilt.text) : "";
check("speckit: note section names the exact task path",
  speckitBuilt.ok && speckitBuilt.text.includes(`Keep a hand-off note at ${speckitPath}`), speckitPath);
check("speckit: note section pins the overwrite discipline",
  speckitSection.includes("OVERWRITE it (never append)"), speckitSection.slice(0, 300));
check("speckit: note section names the milestone triggers",
  /after every important finding/i.test(speckitSection)
  && /before every edit/i.test(speckitSection)
  && /after the task verify/i.test(speckitSection), speckitSection.slice(0, 400));
check("speckit: note section lists the four note sections",
  speckitSection.includes("1. Done") && speckitSection.includes("2. Found")
  && speckitSection.includes("3. Next") && speckitSection.includes("4. Dead ends"),
  speckitSection.slice(0, 600));

if (failures) {
  console.error(`${failures} handoff-note-milestones check(s) failed.`);
  process.exit(1);
}
console.log("handoff-note-milestones tests passed");
