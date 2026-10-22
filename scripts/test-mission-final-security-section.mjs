#!/usr/bin/env node
// Mission 067 task 1.3 — MISSION_FINAL security section tests.
//
// Asserts: MISSION_FINAL carries the generic-only section verbatim when no
// project file exists; project items from a temp
// `.autopilot/security-checklist.md` appear in MISSION_FINAL; phase
// invariants hold (PHASE_REVIEW, PHASE_REREVIEW and PHASE_VERIFY never
// contain the whole-diff line; PHASE_VERIFY has no '### Security checklist';
// PHASE_REVIEW/PHASE_REREVIEW keep exactly one checklist section).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {buildSecurityChecklistSection} from "./security-checklist.mjs";
import {buildStandaloneHandoff, MISSION_FINAL_SECURITY_LINE} from "./standalone-handoff.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  failed += 1;
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  return text.split(needle).length - 1;
}

const CHECKLIST_HEADING = "### Security checklist";
const TASKS = [{file: "/repo/TASKS.md", line: 3, text: "Do the thing"}];

function missionFinalBase(extra = {}) {
  return {
    kind: "MISSION_FINAL",
    deltaChunks: [],
    baselineKey: "mission-final-sec",
    declaredPaths: [],
    planPath: "/repo/PLAN.md",
    tasksPath: "/repo/TASKS.md",
    implementationSummary: "",
    ...extra,
  };
}

function phaseBase(kind, extra = {}) {
  return {
    kind,
    phaseName: "P",
    phaseIndex: 0,
    phaseTotal: 1,
    phaseTasks: TASKS,
    attempt: 1,
    deltaChunks: [],
    baselineKey: "mission-final-sec-phase",
    declaredPaths: [],
    implementationSummary: "",
    ...extra,
  };
}

// ── MISSION_FINAL generic-only without project file ───────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-sec-generic-"));
  const expected = buildSecurityChecklistSection(dir);
  const built = buildStandaloneHandoff(missionFinalBase({repoRoot: dir}));
  check("MISSION_FINAL includes generic section verbatim", built.text.includes(expected), expected.length);
  check("MISSION_FINAL generic-only has no project part",
    !built.text.includes("Project-specific checks:"), null);
  check("MISSION_FINAL carries the whole-diff line",
    built.text.includes(MISSION_FINAL_SECURITY_LINE), null);
  check("MISSION_FINAL appends whole-diff line after the section",
    built.text.includes(`${expected}\n${MISSION_FINAL_SECURITY_LINE}`), null);
  check("MISSION_FINAL keeps exactly one checklist section",
    countOccurrences(built.text, CHECKLIST_HEADING) === 1,
    countOccurrences(built.text, CHECKLIST_HEADING));
  // Absent repoRoot also yields the generic section, never throws.
  let noRoot;
  let threw = false;
  try { noRoot = buildStandaloneHandoff(missionFinalBase()); } catch { threw = true; }
  const generic = buildSecurityChecklistSection(undefined);
  check("MISSION_FINAL without repoRoot still returns generic section, no throw",
    !threw && noRoot.text.includes(generic) && !noRoot.text.includes("Project-specific checks:"), null);
  fs.rmSync(dir, {recursive: true, force: true});
}

// ── MISSION_FINAL project items via temp .autopilot/security-checklist.md ──
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-sec-project-"));
  fs.mkdirSync(path.join(dir, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(dir, ".autopilot", "security-checklist.md"), "- check CSRF on project forms\n");
  const expected = buildSecurityChecklistSection(dir);
  const built = buildStandaloneHandoff(missionFinalBase({repoRoot: dir}));
  check("MISSION_FINAL includes project section verbatim", built.text.includes(expected), expected.length);
  check("MISSION_FINAL project items appear", built.text.includes("Project-specific checks:")
    && built.text.includes("check CSRF on project forms"), null);
  check("MISSION_FINAL with project file keeps the whole-diff line",
    built.text.includes(MISSION_FINAL_SECURITY_LINE), null);
  check("MISSION_FINAL with project file keeps exactly one checklist section",
    countOccurrences(built.text, CHECKLIST_HEADING) === 1,
    countOccurrences(built.text, CHECKLIST_HEADING));
  fs.rmSync(dir, {recursive: true, force: true});
}

// ── Phase invariants ──────────────────────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-sec-phase-"));
  fs.mkdirSync(path.join(dir, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(dir, ".autopilot", "security-checklist.md"), "- check CSRF on project forms\n");
  const review = buildStandaloneHandoff(phaseBase("PHASE_REVIEW", {repoRoot: dir}));
  const rereview = buildStandaloneHandoff(phaseBase("PHASE_REREVIEW", {repoRoot: dir, changedFiles: []}));
  const verify = buildStandaloneHandoff(phaseBase("PHASE_VERIFY", {repoRoot: dir}));
  check("PHASE_REVIEW never contains the whole-diff line",
    !review.text.includes(MISSION_FINAL_SECURITY_LINE), null);
  check("PHASE_REREVIEW never contains the whole-diff line",
    !rereview.text.includes(MISSION_FINAL_SECURITY_LINE), null);
  check("PHASE_VERIFY never contains the whole-diff line",
    !verify.text.includes(MISSION_FINAL_SECURITY_LINE), null);
  check("PHASE_VERIFY has no '### Security checklist'",
    !verify.text.includes(CHECKLIST_HEADING), null);
  check("PHASE_VERIFY has no project checklist content",
    !verify.text.includes("check CSRF on project forms")
    && !verify.text.includes("Project-specific checks:"), null);
  check("PHASE_REVIEW keeps exactly one checklist section",
    countOccurrences(review.text, CHECKLIST_HEADING) === 1,
    countOccurrences(review.text, CHECKLIST_HEADING));
  check("PHASE_REREVIEW keeps exactly one checklist section",
    countOccurrences(rereview.text, CHECKLIST_HEADING) === 1,
    countOccurrences(rereview.text, CHECKLIST_HEADING));
  fs.rmSync(dir, {recursive: true, force: true});
}

console.log(`\n${ok} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
