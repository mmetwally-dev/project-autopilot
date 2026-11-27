#!/usr/bin/env node
// Backlog rv #4 tests: same-file split rule in both standalone planner brief
// and SpecKit tasks contract, plus plan-review [RULE: task size] rule for >=4
// tasks editing the same non-test file in both plan reviews + confirmation demotion.
import fs from "node:fs";
import {
  SAME_FILE_SPLIT_RULE,
  taskSizeReviewText,
} from "./per-task-budget.mjs";
import { demoteUnchangedTaskSizeFindings } from "./plan-review-rounds.mjs";

let passed = 0;
let failed = 0;
function check(name, condition, evidence) {
  if (condition) {
    console.log(`PASS ${name}`);
    passed += 1;
    return;
  }
  console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(evidence)}` : ""}`);
  failed += 1;
}

const EXPECTED_PLANNER_RULE = "Do not grow one source file through many tasks ('part 1a', 'part 1b', …): when 3 or more tasks of a phase would extend the same non-test file, split the work into one module per concern (e.g. a folder with one file per step plus a thin entry file) so each task owns its own file.";

// ── 1. Canonical planner rule text ──
check("SAME_FILE_SPLIT_RULE matches required canonical wording",
  SAME_FILE_SPLIT_RULE === EXPECTED_PLANNER_RULE,
  SAME_FILE_SPLIT_RULE);

// ── 2. Plan-review size text covers >=4 tasks editing the same non-test file ──
const reviewText = taskSizeReviewText(30);
check("taskSizeReviewText raises [RULE: task size] when 4 or more tasks in one phase edit the same non-test file",
  reviewText.includes("[RULE: task size]")
  && reviewText.includes("4 or more tasks in one phase edit the same non-test file")
  && reviewText.includes("one module per concern"),
  reviewText);

// ── 3. Standalone planner brief + SpecKit tasks contract + both plan reviews in autopilot.mjs ──
const autoSrc = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");

check("autopilot.mjs imports SAME_FILE_SPLIT_RULE",
  autoSrc.includes("SAME_FILE_SPLIT_RULE"));

// SpecKit tasks-stage artifact contract
const tasksContractStart = autoSrc.indexOf('if(step==="tasks") return `');
const tasksContractEnd = autoSrc.indexOf("return \"\";", tasksContractStart);
const tasksContract = tasksContractStart >= 0 && tasksContractEnd > tasksContractStart
  ? autoSrc.slice(tasksContractStart, tasksContractEnd)
  : "";
check("SpecKit tasks-stage artifact contract includes SAME_FILE_SPLIT_RULE",
  tasksContract.includes("${SAME_FILE_SPLIT_RULE}"),
  tasksContract.slice(0, 400));

// Standalone planner brief (both revision and fresh prompts)
check("standalone planner defines sameFileSplitLine from SAME_FILE_SPLIT_RULE",
  autoSrc.includes("const sameFileSplitLine=SAME_FILE_SPLIT_RULE;"));
const standaloneUses = (autoSrc.match(/\bsameFileSplitLine,/g) || []).length;
check("standalone planner includes sameFileSplitLine in BOTH revision and fresh prompts",
  standaloneUses === 2,
  standaloneUses);

// Both standalone and SpecKit plan reviews use taskSizeReviewText
const reviewUses = (autoSrc.match(/taskSizeReviewText\(resolveTaskSizeTargetTurns\(c\.policy\)\)/g) || []).length;
check("both standalone and SpecKit plan review briefs call taskSizeReviewText",
  reviewUses >= 2,
  reviewUses);

// ── 4. Confirmation-round demotion still works for the new [RULE: task size] finding ──
{
  const finding = {
    location: "TASKS.md Phase 6",
    problem: "[RULE: task size] T044, T045, T046, T047 all edit apps/web/src/lib/admin/provisioning/workflow.ts",
    correction: "Split workflow.ts into workflow/precheck.ts, workflow/step2-auth.ts, workflow/step3-invite.ts",
  };
  const demoted = demoteUnchangedTaskSizeFindings({ decision: "FAIL", findings: [finding], notes: [] }, ["T010"]);
  check("confirmation demotion: moves unchanged 4-task same-file [RULE: task size] finding to notes",
    demoted.moved === 1 && demoted.review.findings.length === 0 && demoted.review.notes.length === 1,
    demoted);

  const kept = demoteUnchangedTaskSizeFindings({ decision: "FAIL", findings: [finding], notes: [] }, ["T046"]);
  check("confirmation demotion: keeps 4-task same-file [RULE: task size] finding when any cited task changed",
    kept.moved === 0 && kept.review.findings.length === 1,
    kept);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("backlog #4 same-file split tests passed");
