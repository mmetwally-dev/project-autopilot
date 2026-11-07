#!/usr/bin/env node
// Test for Backlog #11 parts (a) and (b):
// (1) copy / carriedScratchDir / deleteCarriedScratch helpers:
//     - temp scratch with a.log, .autopilot-home/x, a 2 MB file -> carried dir has a.log only;
//     - second call replaces the old copy;
//     - carriedScratchDir and deleteCarriedScratch adhere to fixed (repo, mission, taskRef) signature;
// (2) seed helper:
//     - carried dir -> new scratch gets previous-session/a.log;
//     - returns true when at least one file exists, false when empty/missing;
// (3) brief checks:
//     - (a) source check that both phase code_reviewer review(...) prompts in autopilot.mjs
//           contain CODE_REVIEWER_TARGETED_TESTS_LINE up to closing backtick;
//     - (b) CODE_REVIEWER_TARGETED_TESTS_LINE exact text matches specification;
//     - (c) readOnlyContinuationNote source check in autopilot.mjs;
// (4) source-wiring checks:
//     - clearContinuationRound sites delete carried dir;
//     - clearHandoffNote deletes carried dir;
//     - copyCarriedScratch in wrap-up;
//     - seedPreviousScratch before spawn.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {fileURLToPath} from "node:url";
import {
  carriedScratchDir,
  copyCarriedScratch,
  seedPreviousScratch,
  deleteCarriedScratch
} from "./per-task-budget.mjs";
import {
  CODE_REVIEWER_TARGETED_TESTS_LINE
} from "./offline-gate-brief.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
    return;
  }
  failures++;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

const tmpDirs = [];
function makeTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

try {
  // ── (1) Copy helper & fixed signature checks ──
  {
    const srcScratch = makeTmpDir("test-scratch-src-");
    const destCarried = path.join(makeTmpDir("test-scratch-dest-parent-"), "carried-scratch");

    fs.writeFileSync(path.join(srcScratch, "a.log"), "sample log content");
    fs.mkdirSync(path.join(srcScratch, ".autopilot-home"), {recursive: true});
    fs.writeFileSync(path.join(srcScratch, ".autopilot-home", "x"), "home content");
    fs.writeFileSync(path.join(srcScratch, "big.bin"), Buffer.alloc(2 * 1024 * 1024)); // 2 MB

    const res1 = copyCarriedScratch(srcScratch, destCarried);
    check("(1) copyCarriedScratch returns copied count > 0", res1.copied >= 1, res1);
    check("(1) carried dir contains a.log", fs.existsSync(path.join(destCarried, "a.log")));
    check("(1) carried dir skips .autopilot-home/x", !fs.existsSync(path.join(destCarried, ".autopilot-home")));
    check("(1) carried dir skips 2 MB file", !fs.existsSync(path.join(destCarried, "big.bin")));

    const filesInDest1 = fs.readdirSync(destCarried);
    check("(1) carried dir has a.log only", filesInDest1.length === 1 && filesInDest1[0] === "a.log", filesInDest1);

    // Second call replaces the old copy
    fs.unlinkSync(path.join(srcScratch, "a.log"));
    fs.writeFileSync(path.join(srcScratch, "b.log"), "second call content");

    const res2 = copyCarriedScratch(srcScratch, destCarried);
    check("(1) second copy call returns copied count > 0", res2.copied >= 1, res2);
    check("(1) second call removes old a.log", !fs.existsSync(path.join(destCarried, "a.log")));
    check("(1) second call adds new b.log", fs.existsSync(path.join(destCarried, "b.log")));

    const filesInDest2 = fs.readdirSync(destCarried);
    check("(1) second call replaces old copy with b.log only", filesInDest2.length === 1 && filesInDest2[0] === "b.log", filesInDest2);

    // carriedScratchDir and deleteCarriedScratch with fixed signature (repo, mission, taskRef)
    const testRepo = makeTmpDir("test-repo-");
    const testMission = "mission-042";
    const testRef = "T1.2";
    const expectedPath = path.join(testRepo, ".autopilot", "missions", testMission, "handoff", "T1.2-scratch");
    const calculatedPath = carriedScratchDir(testRepo, testMission, testRef);
    check("(1) carriedScratchDir fixed signature (repo, mission, taskRef)", calculatedPath === expectedPath, {calculatedPath, expectedPath});

    fs.mkdirSync(calculatedPath, {recursive: true});
    fs.writeFileSync(path.join(calculatedPath, "temp.log"), "data");
    check("(1) deleteCarriedScratch deletes carried dir", deleteCarriedScratch(testRepo, testMission, testRef) === true);
    check("(1) carried dir removed after deleteCarriedScratch", !fs.existsSync(calculatedPath));
    check("(1) deleteCarriedScratch on missing dir returns false", deleteCarriedScratch(testRepo, testMission, testRef) === false);
  }

  // ── (2) Seed helper: carried dir -> new scratch gets previous-session/a.log ──
  {
    const carriedDir = makeTmpDir("test-carried-dir-");
    fs.writeFileSync(path.join(carriedDir, "a.log"), "preserved log from session 1");

    const newScratchDir = makeTmpDir("test-new-scratch-");
    const seeded = seedPreviousScratch(carriedDir, newScratchDir);

    check("(2) seedPreviousScratch returns true when file exists", seeded === true);
    check("(2) new scratch gets previous-session/a.log", fs.existsSync(path.join(newScratchDir, "previous-session", "a.log")));
    check("(2) seeded file content matches original", fs.readFileSync(path.join(newScratchDir, "previous-session", "a.log"), "utf8") === "preserved log from session 1");

    // Empty carried dir returns false
    const emptyCarriedDir = makeTmpDir("test-empty-carried-");
    const emptyScratchDir = makeTmpDir("test-empty-scratch-");
    const seededEmpty = seedPreviousScratch(emptyCarriedDir, emptyScratchDir);
    check("(2) seedPreviousScratch returns false when no files exist", seededEmpty === false);

    // Replaces previous content on next seed
    fs.unlinkSync(path.join(carriedDir, "a.log"));
    fs.writeFileSync(path.join(carriedDir, "c.log"), "replaced content");
    const seededAgain = seedPreviousScratch(carriedDir, newScratchDir);
    check("(2) second seed returns true", seededAgain === true);
    check("(2) old previous-session/a.log removed", !fs.existsSync(path.join(newScratchDir, "previous-session", "a.log")));
    check("(2) new previous-session/c.log present", fs.existsSync(path.join(newScratchDir, "previous-session", "c.log")));
  }

  // ── (3) Brief checks ──
  {
    // (b) Exact text of CODE_REVIEWER_TARGETED_TESTS_LINE
    const expectedLine = "Run only the tests for the files in this delta (targeted test files); never run the full repository gate, scripts/test-all.mjs or the whole test suite, and never wait on or poll a long-running suite — the orchestrator runs the gate after the review and the verifier judges it.";
    check("(3) CODE_REVIEWER_TARGETED_TESTS_LINE matches expected text", CODE_REVIEWER_TARGETED_TESTS_LINE === expectedLine);

    // (a) Source check that both phase code_reviewer review(...) prompts contain CODE_REVIEWER_TARGETED_TESTS_LINE
    const autopilotSrc = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");

    function extractReviewTemplate(source, blockMarker) {
      const blockIdx = source.indexOf(blockMarker);
      if (blockIdx === -1) return null;
      const reviewCallIdx = source.indexOf('review("code_reviewer",', blockIdx);
      if (reviewCallIdx === -1) return null;
      const start = source.indexOf("`", reviewCallIdx);
      if (start === -1) return null;
      let i = start + 1;
      let exprDepth = 0;
      const stack = ["TEMPLATE"];
      while (i < source.length && stack.length > 0) {
        const currentMode = stack[stack.length - 1];
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (currentMode === "TEMPLATE") {
          if (source[i] === "`") {
            stack.pop();
            if (stack.length === 0) {
              return source.slice(start, i + 1);
            }
          } else if (source[i] === "$" && source[i + 1] === "{") {
            stack.push("EXPR");
            i += 2;
            continue;
          }
        } else if (currentMode === "EXPR") {
          if (source[i] === "{") {
            exprDepth++;
          } else if (source[i] === "}") {
            if (exprDepth === 0) {
              stack.pop();
            } else {
              exprDepth--;
            }
          } else if (source[i] === "`") {
            stack.push("TEMPLATE");
          }
        }
        i++;
      }
      return null;
    }

    const standaloneTemplate = extractReviewTemplate(autopilotSrc, "tasksFilePathForReview");
    check("(3) standalone phase review template extracted", Boolean(standaloneTemplate));
    check("(3) standalone phase review prompt contains CODE_REVIEWER_TARGETED_TESTS_LINE",
      Boolean(standaloneTemplate && standaloneTemplate.includes("CODE_REVIEWER_TARGETED_TESTS_LINE")));
    check("(3) standalone phase review prompt places line before reviewBudget.note",
      Boolean(standaloneTemplate && standaloneTemplate.indexOf("CODE_REVIEWER_TARGETED_TESTS_LINE") < standaloneTemplate.indexOf("${reviewBudget.note}")));

    const speckitTemplate = extractReviewTemplate(autopilotSrc, "reviewTaskRef(s,speckitPhaseFeedbackKey");
    check("(3) speckit phase review template extracted", Boolean(speckitTemplate));
    check("(3) speckit phase review prompt contains CODE_REVIEWER_TARGETED_TESTS_LINE",
      Boolean(speckitTemplate && speckitTemplate.includes("CODE_REVIEWER_TARGETED_TESTS_LINE")));
    check("(3) speckit phase review prompt places line before reviewBudget.note",
      Boolean(speckitTemplate && speckitTemplate.indexOf("CODE_REVIEWER_TARGETED_TESTS_LINE") < speckitTemplate.indexOf("${reviewBudget.note}")));

    // Check readOnlyContinuationNote via source
    check("(3) readOnlyContinuationNote defined in autopilot.mjs",
      /function readOnlyContinuationNote\(note,\s*repoPath,\s*missionName,\s*ref/.test(autopilotSrc));
    check("(3) readOnlyContinuationNote calls carriedScratchDir(repoPath,missionName,ref)",
      autopilotSrc.includes("carriedScratchDir(repoPath,missionName,ref)"));
    check("(3) readOnlyContinuationNote appends previous-session line when seeded",
      autopilotSrc.includes("The previous session's scratch files (logs, configs, copies) are in /workspace/scratch/previous-session/ — reuse what the note cites instead of redoing it."));
  }

  // ── (4) Source-wiring checks that clearContinuationRound sites delete carried dir ──
  {
    const autopilotSrc = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");

    function extractEnclosingFunction(source, needle) {
      const idx = source.indexOf(needle);
      if (idx === -1) return null;
      const fnStart = source.lastIndexOf("async function ", idx) !== -1
        ? source.lastIndexOf("async function ", idx)
        : source.lastIndexOf("function ", idx);
      if (fnStart === -1) return null;

      const openBrace = source.indexOf("{", fnStart);
      if (openBrace === -1) return null;
      let depth = 1;
      let pos = openBrace + 1;
      while (pos < source.length && depth > 0) {
        if (source[pos] === "{") depth++;
        else if (source[pos] === "}") depth--;
        pos++;
      }
      return source.slice(fnStart, pos);
    }

    const standaloneReviewNeedle = "clearContinuationRound(s,`task:standalone:phase-${s.phaseIndex}:code_reviewer`)";
    const standaloneVerifyNeedle = "clearContinuationRound(s,`task:standalone:phase-${s.phaseIndex}:verifier`)";
    const speckitReviewNeedle = "clearContinuationRound(s,`task:speckit:phase-${s.phaseIndex}:code_reviewer`)";
    const speckitVerifyNeedle = "clearContinuationRound(s,`task:speckit:phase-${s.phaseIndex}:verifier`)";

    const standaloneFn = extractEnclosingFunction(autopilotSrc, standaloneReviewNeedle);
    check("(4) standalone function body found", Boolean(standaloneFn));
    check("(4) standalone code_reviewer clearContinuationRound site deletes carried dir",
      Boolean(standaloneFn && standaloneFn.includes("deleteCarriedScratch(repo,mission,reviewRef)")));
    check("(4) standalone verifier clearContinuationRound site deletes carried dir",
      Boolean(standaloneFn && standaloneFn.includes("deleteCarriedScratch(repo,mission,verifyRef)")));

    const speckitFn = extractEnclosingFunction(autopilotSrc, speckitReviewNeedle);
    check("(4) speckit function body found", Boolean(speckitFn));
    check("(4) speckit code_reviewer clearContinuationRound site deletes carried dir",
      Boolean(speckitFn && speckitFn.includes("deleteCarriedScratch(repo,missionIdentity,reviewRef)")));
    check("(4) speckit verifier clearContinuationRound site deletes carried dir",
      Boolean(speckitFn && speckitFn.includes("deleteCarriedScratch(repo,missionIdentity,verifyRef)")));

    check("(4) clearHandoffNote calls deleteCarriedScratch(repo,missionName,taskRef)",
      autopilotSrc.includes("deleteCarriedScratch(repo,missionName,taskRef)"));

    // Check carriedScratchDir helper exported from per-task-budget.mjs
    const budgetSrc = fs.readFileSync(path.join(here, "per-task-budget.mjs"), "utf8");
    check("(4) per-task-budget exports carriedScratchDir", /export function carriedScratchDir\b/.test(budgetSrc));
    check("(4) per-task-budget exports copyCarriedScratch", /export function copyCarriedScratch\b/.test(budgetSrc));
    check("(4) per-task-budget exports seedPreviousScratch", /export function seedPreviousScratch\b/.test(budgetSrc));
    check("(4) per-task-budget exports deleteCarriedScratch", /export function deleteCarriedScratch\b/.test(budgetSrc));

    // Check wrap-up copies carried scratch in autopilot.mjs
    check("(4) autopilot.mjs calls copyCarriedScratch in wrap-up block",
      autopilotSrc.includes("copyCarriedScratch(effectiveScratchDir,carriedDest)"));
    // Check autopilot.mjs seeds carried scratch before spawn
    check("(4) autopilot.mjs seeds carried scratch before spawn",
      autopilotSrc.includes("seedPreviousScratch(carriedPath,effectiveScratchDir)"));
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, {recursive: true, force: true}); } catch {}
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll reviewer scratch carry tests passed!");
