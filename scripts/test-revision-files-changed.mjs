#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import * as ap from "./autopilot.mjs";
import {
  stageFilesChangedSinceReview,
  stageFilesChangedLine,
  recordReviewFailSnapshot,
  speckitGateNote,
  standalonePlanFeedbackNote,
  standaloneSpecFeedbackNote,
} from "./revision-files-changed.mjs";
import { saveReviewFeedback } from "./review-feedback.mjs";

let ok = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
    ok += 1;
    return;
  }
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${String(detail).slice(0, 300)}` : ""}`);
  failed += 1;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const autopilotSource = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");

// ── Unit tests for pure function stageFilesChangedSinceReview ─────────────────
{
  const recorded = { "tasks.md": "hash_a", "plan.md": "hash_b" };
  const currentSame = { "tasks.md": "hash_a", "plan.md": "hash_b" };
  const changedNone = stageFilesChangedSinceReview(recorded, currentSame);
  check("stageFilesChangedSinceReview: returns empty array when files unchanged",
    Array.isArray(changedNone) && changedNone.length === 0, changedNone);

  const currentEdited = { "tasks.md": "hash_changed", "plan.md": "hash_b" };
  const changedTasks = stageFilesChangedSinceReview(recorded, currentEdited);
  check("stageFilesChangedSinceReview: detects edited file and returns file name",
    Array.isArray(changedTasks) && changedTasks.length === 1 && changedTasks[0] === "tasks.md", changedTasks);

  const formattedLine = stageFilesChangedLine(["tasks.md"]);
  const expectedLine = "The stage file(s) changed after this review (tasks.md): an earlier session already edited them. Check the cited lines first; some findings may already be fixed.";
  check("stageFilesChangedLine: formats exact expected sentence naming tasks.md",
    formattedLine === expectedLine, formattedLine);
}

// ── Test (1) & (2): SpecKit brief ─────────────────────────────────────────────
const tmpDirSk = fs.mkdtempSync(path.join(os.tmpdir(), "ap-test-sk-"));
try {
  const featureDir = "001-test-feature";
  const specsDir = path.join(tmpDirSk, "specs", featureDir);
  fs.mkdirSync(specsDir, { recursive: true });
  const tasksPath = path.join(specsDir, "tasks.md");
  fs.writeFileSync(tasksPath, "- [ ] 1.1 Initial tasks content\n");

  const s = {
    speckitFeatureDir: featureDir,
  };

  // FAIL review stored
  saveReviewFeedback(s, "speckit-stage:tasks", [
    { location: "tasks.md:1", problem: "Missing verify field", correction: "Add verify field" },
  ]);
  recordReviewFailSnapshot(s, "speckit-stage:tasks", [tasksPath], tmpDirSk);

  // (1) tasks.md unchanged -> brief has no "changed after this review" line
  const speckitBriefFn = ap.speckitGateNote || speckitGateNote;
  const brief1 = typeof speckitBriefFn === "function" ? speckitBriefFn(s, "tasks", tmpDirSk, {}) : "";
  const hasNoChangedLine1 = !brief1.includes("The stage file(s) changed after this review");
  const hasRejection1 = brief1.includes("The plan reviewer REJECTED the previous attempt at this stage");
  check("(1) SpecKit: FAIL review stored, tasks.md unchanged → brief has no 'changed after this review' line",
    hasNoChangedLine1 && hasRejection1, brief1);

  // (2) tasks.md edited after the FAIL -> brief has the line naming tasks.md, placed before the findings
  fs.writeFileSync(tasksPath, "- [ ] 1.1 Initial tasks content with fixes applied\n");
  const brief2 = typeof ap.speckitGateNote === "function" ? ap.speckitGateNote(s, "tasks", tmpDirSk, {}) : "";
  const expectedChangedLine = "The stage file(s) changed after this review (tasks.md): an earlier session already edited them. Check the cited lines first; some findings may already be fixed.";
  const hasChangedLine2 = brief2.includes(expectedChangedLine);
  const changedIdx2 = brief2.indexOf(expectedChangedLine);
  const findingIdx2 = brief2.indexOf("Missing verify field");
  const placedBeforeFindings2 = hasChangedLine2 && findingIdx2 > -1 && changedIdx2 < findingIdx2;
  check("(2) tasks.md edited after the FAIL → brief has the line naming tasks.md, placed before the findings",
    hasChangedLine2 && placedBeforeFindings2, brief2);
} finally {
  fs.rmSync(tmpDirSk, { recursive: true, force: true });
}

// ── Test (3): Standalone equivalent of (2) ────────────────────────────────────
const tmpDirSa = fs.mkdtempSync(path.join(os.tmpdir(), "ap-test-sa-"));
try {
  const planPath = path.join(tmpDirSa, "PLAN.md");
  const tasksPath = path.join(tmpDirSa, "TASKS.md");
  fs.writeFileSync(planPath, "# Initial Plan\n");
  fs.writeFileSync(tasksPath, "- [ ] 1.1 Initial standalone task\n");

  const s2 = {};
  saveReviewFeedback(s2, "standalone-plan", [
    { location: "TASKS.md:1", problem: "Task is underspecified", correction: "Add details" },
  ]);
  recordReviewFailSnapshot(s2, "standalone-plan", [planPath, tasksPath], tmpDirSa);

  // Edit TASKS.md after the FAIL
  fs.writeFileSync(tasksPath, "- [ ] 1.1 Edited standalone task with details\n");
  const briefSa = typeof ap.standalonePlanFeedbackNote === "function" ? ap.standalonePlanFeedbackNote(s2, tmpDirSa, "test-mission", {}) : "";
  const expectedChangedLineSa = "The stage file(s) changed after this review (TASKS.md): an earlier session already edited them. Check the cited lines first; some findings may already be fixed.";
  const hasChangedLineSa = briefSa.includes(expectedChangedLineSa);
  const changedIdxSa = briefSa.indexOf(expectedChangedLineSa);
  const findingIdxSa = briefSa.indexOf("Task is underspecified");
  const placedBeforeFindingsSa = hasChangedLineSa && findingIdxSa > -1 && changedIdxSa < findingIdxSa;
  check("(3) standalone equivalent of (2): brief has the line naming TASKS.md, placed before the findings",
    hasChangedLineSa && placedBeforeFindingsSa, briefSa);
} finally {
  fs.rmSync(tmpDirSa, { recursive: true, force: true });
}

// ── Test (4): runRelay revision line contains "already contains the required fix"
{
  const REQUIRED_SENTENCE = "If a cited location already contains the required fix, say so for that finding and do not edit or explore it further.";
  const REVISION_LINE_FULL = `Revision: make the cited edits, update the hand-off note, then end your turn. Do not re-run git status/git log or re-read files you just edited to double-check. ${REQUIRED_SENTENCE}`;

  const rawRelayMatch = autopilotSource.match(/const rawRelayTaskText\s*=\s*(\[[\s\S]*?\])\.filter\(Boolean\)\.join\("\\n"\);/);
  check("rawRelayTaskText array matched in autopilot.mjs", !!rawRelayMatch);

  const arraySource = rawRelayMatch ? rawRelayMatch[1] : "";
  check("(4) the runRelay revision line contains the 'already contains the required fix' sentence",
    arraySource.includes(REQUIRED_SENTENCE) && arraySource.includes(REVISION_LINE_FULL),
    arraySource.slice(0, 400));

  // Evaluate runRelay brief using Function (same methodology as test-earlier-rounds-dedupe)
  const evaluateBrief = new Function(
    "roleName", "promptRepository", "mission", "role", "readOnly", "promptScratch", "disposableWorkspace", "relayTask", "review", "planRevision = null",
    `return (${arraySource}).filter(Boolean).join("\\n");`
  );
  const revisionBrief = evaluateBrief(
    "planner", "/repo", "test-mission", { adapter: "antigravity" }, false,
    "/scratch", false, "The plan reviewer REJECTED the previous attempt at this stage.", false, 1
  );
  check("(4b) evaluated planner revision brief contains the full sentence",
    revisionBrief.includes(REVISION_LINE_FULL),
    revisionBrief.slice(0, 400));
}

// ── Source checks of call sites ───────────────────────────────────────────────
{
  check("source check: runPlanningPhase calls stageFilesChangedSinceReview and stageFilesChangedLine",
    autopilotSource.includes("stageFilesChangedSinceReview(") &&
    autopilotSource.includes("gateChangedLine") &&
    autopilotSource.includes("speckitStageFeedbackKey(step)"));

  check("source check: runStandaloneSpecStage calls stageFilesChangedSinceReview and stageFilesChangedLine",
    autopilotSource.includes("specStageChanged") &&
    autopilotSource.includes("specChangedLine"));

  check("source check: runStandalonePlanning calls stageFilesChangedSinceReview and stageFilesChangedLine",
    autopilotSource.includes("planStageChanged") &&
    autopilotSource.includes("planChangedLine"));

  check("source check: runGsdPlanning calls stageFilesChangedSinceReview and stageFilesChangedLine",
    autopilotSource.includes("gsdChanged") &&
    autopilotSource.includes("gsdChangedLine"));
}

if (failed > 0) {
  console.error(`FAILED: ${failed} check(s) failed`);
  process.exit(1);
}
console.log(`ALL CHECKS PASSED (${ok}/${ok})`);
