#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { plannerEarlierRoundsText } from "./plan-review-rounds.mjs";
import { implementerEarlierRoundsText } from "./code-review-rounds.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${detail}` : ""}`);
  failed += 1;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const DO_NOT_RECHECK_LINE = "Do not re-check these unless your edit touches their lines.";
const REVISION_LINE = "Revision: make the cited edits, update the hand-off note, then end your turn. Do not re-run git status/git log or re-read files you just edited to double-check.";

// ── Test 1: state with rounds [R7(10 findings), R8(same 10), R9(2 findings F1,F2), R10(F1,F2 = current)] ──
const r7Findings = Array.from({ length: 10 }, (_, i) => `tasks.md:${100 + i}: finding ${i + 1} detail. Required correction: fix finding ${i + 1}`);
const r8Findings = [...r7Findings];
const r9Findings = [
  "tasks.md:201: F1 problem. Required correction: fix F1",
  "tasks.md:202: F2 problem. Required correction: fix F2",
];
const r10Findings = [
  "tasks.md:201: F1 problem. Required correction: fix F1",
  "tasks.md:202: F2 problem. Required correction: fix F2",
];

const statePlan = {
  planReviewHistory: {
    "test-plan": [
      { round: 7, findings: r7Findings },
      { round: 8, findings: r8Findings },
      { round: 9, findings: r9Findings },
      { round: 10, findings: r10Findings },
    ]
  }
};

const planOutput = plannerEarlierRoundsText(statePlan, "test-plan");

// (1) output contains each R7 finding exactly once
for (let i = 0; i < r7Findings.length; i++) {
  const f = r7Findings[i];
  const count = (planOutput.match(new RegExp(escapeRegex(f), "g")) || []).length;
  check(`planOutput contains R7 finding ${i + 1} exactly once`, count === 1, `count=${count}`);
}

// (2) contains neither F1 nor F2
check("planOutput does not contain F1", !planOutput.includes("F1 problem"), planOutput);
check("planOutput does not contain F2", !planOutput.includes("F2 problem"), planOutput);

// (3) has the "Do not re-check" line
check("planOutput has 'Do not re-check' line", planOutput.includes(DO_NOT_RECHECK_LINE), planOutput);

// (4) round labels: Round 8 preserved, Round 7 and Round 9 dropped
check("planOutput keeps Round 8 label", planOutput.includes("Round 8:"), planOutput);
check("planOutput dropped Round 7 label", !planOutput.includes("Round 7:"), planOutput);
check("planOutput dropped Round 9 label", !planOutput.includes("Round 9:"), planOutput);

// Also test implementerEarlierRoundsText with the same round structure
const stateCode = {
  codeReviewHistory: {
    "phase:1": [
      { round: 7, findings: r7Findings },
      { round: 8, findings: r8Findings },
      { round: 9, findings: r9Findings },
      { round: 10, findings: r10Findings },
    ]
  }
};

const codeOutput = implementerEarlierRoundsText(stateCode, "phase:1");
for (let i = 0; i < r7Findings.length; i++) {
  const f = r7Findings[i];
  const count = (codeOutput.match(new RegExp(escapeRegex(f), "g")) || []).length;
  check(`codeOutput contains R7 finding ${i + 1} exactly once`, count === 1, `count=${count}`);
}
check("codeOutput does not contain F1", !codeOutput.includes("F1 problem"), codeOutput);
check("codeOutput does not contain F2", !codeOutput.includes("F2 problem"), codeOutput);
check("codeOutput has 'Do not re-check' line", codeOutput.includes(DO_NOT_RECHECK_LINE), codeOutput);

// ── Test 2: all-duplicates state → "" ──
const allDupPlanState = {
  planReviewHistory: {
    "test-plan": [
      { round: 1, findings: ["tasks.md:10: dup finding"] },
      { round: 2, findings: ["tasks.md:10: dup finding"] },
      { round: 3, findings: ["tasks.md:10: dup finding"] },
    ]
  }
};
check("all-duplicates plan state returns empty string", plannerEarlierRoundsText(allDupPlanState, "test-plan") === "", plannerEarlierRoundsText(allDupPlanState, "test-plan"));

const allDupCodeState = {
  codeReviewHistory: {
    "phase:1": [
      { round: 1, findings: ["src/app.js:5: error"] },
      { round: 2, findings: ["src/app.js:5: error"] },
    ]
  }
};
check("all-duplicates code state returns empty string", implementerEarlierRoundsText(allDupCodeState, "phase:1") === "", implementerEarlierRoundsText(allDupCodeState, "phase:1"));

// ── Test 3: distinct rounds unchanged except the added line ──
const distinctPlanState = {
  planReviewHistory: {
    "test-plan": [
      { round: 1, findings: ["tasks.md:10: distinct finding 1"] },
      { round: 2, findings: ["tasks.md:20: distinct finding 2"] },
      { round: 3, findings: ["tasks.md:30: current finding 3"] },
    ]
  }
};
const expectedDistinctPlan = `Findings from ALL earlier review rounds (already addressed once — keep them fixed; your fixes for the current findings must not reopen any of them):
Round 1:
1. tasks.md:10: distinct finding 1

Round 2:
1. tasks.md:20: distinct finding 2
${DO_NOT_RECHECK_LINE}`;
check("distinct rounds unchanged except added line", plannerEarlierRoundsText(distinctPlanState, "test-plan") === expectedDistinctPlan, plannerEarlierRoundsText(distinctPlanState, "test-plan"));

// ── Test 4: brief check that the revision line appears for a revision brief and not for first attempt or reviewer ──
const here = path.dirname(fileURLToPath(import.meta.url));
const autopilotSource = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");

const rawRelayMatch = autopilotSource.match(/const rawRelayTaskText\s*=\s*(\[[\s\S]*?\])\.filter\(Boolean\)\.join\("\\n"\);/);
if (!rawRelayMatch) {
  console.error("FAIL: could not locate rawRelayTaskText array in scripts/autopilot.mjs");
  process.exit(1);
}

const evaluateBrief = new Function(
  "roleName", "promptRepository", "mission", "role", "readOnly", "promptScratch", "disposableWorkspace", "relayTask", "review", "planRevision = null",
  `return (${rawRelayMatch[1]}).filter(Boolean).join("\\n");`
);

function buildBrief({
  roleName = "planner",
  role = { adapter: "antigravity" },
  readOnly = false,
  mission = "test-mission",
  promptRepository = "/workspace/repository",
  promptScratch = "/workspace/scratch",
  disposableWorkspace = false,
  relayTask = "task details",
  review = false,
  planRevision = null,
} = {}) {
  return evaluateBrief(roleName, promptRepository, mission, role, readOnly, promptScratch, disposableWorkspace, relayTask, review, planRevision);
}

// 4a. Planner revision brief with "REJECTED the previous attempt"
const plannerRevisionBrief = buildBrief({
  roleName: "planner",
  role: { adapter: "antigravity" },
  readOnly: false,
  relayTask: "The plan reviewer REJECTED the previous attempt at this stage. Address every finding:\n1. Problem",
});
check("planner revision brief contains revision finish line", plannerRevisionBrief.includes(REVISION_LINE), plannerRevisionBrief);

// 4b. Planner revision brief with other adapter (e.g. claude)
const claudePlannerRevisionBrief = buildBrief({
  roleName: "planner",
  role: { adapter: "claude" },
  readOnly: false,
  relayTask: "The plan reviewer REJECTED the previous attempt at this stage. Address every finding:\n1. Problem",
});
check("claude planner revision brief contains revision finish line", claudePlannerRevisionBrief.includes(REVISION_LINE), claudePlannerRevisionBrief);

// 4c. Implementer revision brief with "Reviewer feedback from the previous attempt that MUST be addressed"
const implementerRevisionBrief = buildBrief({
  roleName: "implementer",
  role: { adapter: "antigravity" },
  readOnly: false,
  relayTask: "Reviewer feedback from the previous attempt that MUST be addressed — fix every finding:\n1. Error",
});
check("implementer revision brief contains revision finish line", implementerRevisionBrief.includes(REVISION_LINE), implementerRevisionBrief);

// 4d. Planner first-attempt brief does NOT contain revision finish line
const plannerFirstAttemptBrief = buildBrief({
  roleName: "planner",
  role: { adapter: "antigravity" },
  readOnly: false,
  relayTask: "Create or continue an implementation plan for this project without relying on SpecKit or GSD.",
});
check("planner first attempt brief does NOT contain revision finish line", !plannerFirstAttemptBrief.includes(REVISION_LINE), plannerFirstAttemptBrief);

// 4e. Implementer first-attempt brief does NOT contain revision finish line
const implementerFirstAttemptBrief = buildBrief({
  roleName: "implementer",
  role: { adapter: "antigravity" },
  readOnly: false,
  relayTask: "Implement task 1.1",
});
check("implementer first attempt brief does NOT contain revision finish line", !implementerFirstAttemptBrief.includes(REVISION_LINE), implementerFirstAttemptBrief);

// 4f. Reviewer brief does NOT contain revision finish line even if task text contains rejection marker
const reviewerBrief = buildBrief({
  roleName: "plan_reviewer",
  role: { adapter: "antigravity" },
  readOnly: true,
  review: true,
  relayTask: "The plan reviewer REJECTED the previous attempt at this stage.",
});
check("reviewer brief does NOT contain revision finish line", !reviewerBrief.includes(REVISION_LINE), reviewerBrief);

if (failed > 0) {
  console.error(`FAILED: ${failed} check(s) failed`);
  process.exit(1);
}
console.log(`ALL CHECKS PASSED (${ok}/${ok})`);
