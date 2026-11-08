#!/usr/bin/env node
// Test for Backlog #9:
// (a) pure helper resumeTarget({state, phaseCount, phasesComplete}) -> "final_review" | "planning_review" | "implementation"
// (b) source checks: SpecKit and standalone resume paths call it before reviewExistingPlanning and skip it for "final_review"
// (c) SpecKit digest skip: unchanged digest -> skipped, changed tasks checkbox only -> skipped (normalised), changed task text -> reviewed

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { resumeTarget } from "./resume-target.mjs";
import { planningArtifactDigest, canSkipPlanningStateReview } from "./planning-artifact-digest.mjs";

console.log("Starting test-resume-after-final-review...");

// ---------------------------------------------------------------------------
// (a) Pure helper: resumeTarget({state, phaseCount, phasesComplete})
// ---------------------------------------------------------------------------

// 1. Mission 002 real stopped state fixture
const realShapeState = {
  phase: "escalated",
  step: "relay_policy_violation",
  phaseIndex: 13,
  attempt: 17,
  planningDetection: {
    framework: "speckit",
    status: "complete",
    entryIndex: 7,
    evidence: {
      spec: true,
      plan: true,
      tasks: true
    },
    taskFiles: [
      "/repo/specs/001-core-mvp/tasks.md",
      "/repo/specs/002-customer-visibility-dedup/tasks.md",
      "/repo/specs/004-profile-dynamic-data/tasks.md",
      "/repo/specs/005-notification-system/tasks.md",
      "/repo/specs/006-reports-hub/tasks.md",
      "/repo/specs/007-invoicing-checkout/tasks.md",
      "/repo/specs/008-payment-refund-workflows/tasks.md",
      "/repo/specs/009-receipt-uat-go-live/tasks.md",
      "/repo/specs/010-dynamic-shop-orders/tasks.md"
    ],
    requiresValidation: true,
    confidence: "high",
    reason: "spec, plan, and tasks artifacts detected"
  },
  speckitFeatureDir: "010-dynamic-shop-orders",
  planApproval: null,
  phaseExecutionCheckpoint: "absent",
  speckitPlanningCheckpoint: null,
  finalReviewFixRoundsUsed: 1
};

assert.equal(
  resumeTarget({ state: realShapeState, phaseCount: 13, phasesComplete: true }),
  "final_review",
  "Real-shape fixture resumes to final_review"
);

// Even without phaseCount/phasesComplete, finalReviewFixRoundsUsed already signals final review started
assert.equal(
  resumeTarget({ state: realShapeState }),
  "final_review",
  "Real-shape fixture resumes to final_review via finalReviewFixRoundsUsed"
);

// 2. Final review targets
// When all phases passed (phaseIndex >= phaseCount and phasesComplete is true)
assert.equal(
  resumeTarget({ state: { phaseIndex: 5 }, phaseCount: 5, phasesComplete: true }),
  "final_review",
  "all phases passed (phaseIndex == phaseCount) -> final_review"
);
assert.equal(
  resumeTarget({ state: { phaseIndex: 7 }, phaseCount: 5, phasesComplete: true }),
  "final_review",
  "past last phase (phaseIndex > phaseCount) -> final_review"
);

// Explicit final review markers in state
assert.equal(
  resumeTarget({ state: { finalReviewStarted: true } }),
  "final_review",
  "finalReviewStarted: true -> final_review"
);
assert.equal(
  resumeTarget({ state: { phase: "final_review" } }),
  "final_review",
  "phase: 'final_review' -> final_review"
);
assert.equal(
  resumeTarget({ state: { phase: "escalated", step: "final_review" } }),
  "final_review",
  "step: 'final_review' -> final_review"
);
assert.equal(
  resumeTarget({ state: { phase: "escalated", step: "final_review_not_converging" } }),
  "final_review",
  "step: 'final_review_not_converging' -> final_review"
);
assert.equal(
  resumeTarget({ state: { phase: "escalated", step: "relay_policy_violation", finalReviewStarted: true } }),
  "final_review",
  "relay_policy_violation with finalReviewStarted -> final_review"
);

// 3. Implementation targets
assert.equal(
  resumeTarget({ state: { phase: "implementing", phaseIndex: 2 }, phaseCount: 5, phasesComplete: false }),
  "implementation",
  "implementing phase mid-mission -> implementation"
);
assert.equal(
  resumeTarget({ state: { phase: "tasks_ready", phaseIndex: 0 }, phaseCount: 5, phasesComplete: false }),
  "implementation",
  "tasks_ready -> implementation"
);
assert.equal(
  resumeTarget({ state: { phase: "escalated", step: "task_marking_failed", phaseIndex: 2 }, phaseCount: 5, phasesComplete: false }),
  "implementation",
  "escalated during implementation -> implementation"
);
assert.equal(
  resumeTarget({ state: { phaseExecutionCheckpoint: { stage: "mark_tasks" } }, phaseCount: 5, phasesComplete: false }),
  "implementation",
  "active phase checkpoint -> implementation"
);

// 4. Planning review targets
assert.equal(
  resumeTarget({ state: { phase: "planning" }, phaseCount: 0, phasesComplete: false }),
  "planning_review",
  "planning state -> planning_review"
);
assert.equal(
  resumeTarget({ state: { phase: "escalated", step: "existing-planning-review-failed" } }),
  "planning_review",
  "escalated during existing-planning-review -> planning_review"
);
assert.equal(
  resumeTarget({ state: {} }),
  "planning_review",
  "fresh state -> planning_review"
);
assert.equal(
  resumeTarget(null),
  "planning_review",
  "null state -> planning_review"
);

console.log("PASS: (a) pure helper resumeTarget unit tests passed");

// ---------------------------------------------------------------------------
// (b) Source checks: SpecKit and standalone resume paths call it before
// reviewExistingPlanning and skip it for "final_review"
// ---------------------------------------------------------------------------

const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");

// 1. resumeTarget import
assert.match(src, /import\s*\{[^}]*resumeTarget[^}]*\}\s*from\s*["']\.\/resume-target\.mjs["']/, "imports resumeTarget");

// 2. MISSION_SCOPED_STATE_KEYS contains finalReviewStarted
const missionScopedMatch = src.match(/const\s+MISSION_SCOPED_STATE_KEYS\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/);
assert.ok(missionScopedMatch, "MISSION_SCOPED_STATE_KEYS definition found");
assert.ok(missionScopedMatch[1].includes('"finalReviewStarted"'), "finalReviewStarted is in MISSION_SCOPED_STATE_KEYS");

// 3. Cleared on new mission / complete
assert.match(src, /delete\s+s\.finalReviewStarted/, "clears finalReviewStarted");

// 4. finalReviewStarted=true set when final review begins
assert.ok(
  (src.match(/s\.finalReviewStarted\s*=\s*true/g) || []).length >= 3,
  "finalReviewStarted=true is recorded at final review start sites (standalone early/post-loop + speckit)"
);

// 5. SpecKit and standalone resume paths call it before reviewExistingPlanning and skip it for final_review
assert.match(src, /resolvePlanningResumeTarget/, "autopilot defines resolvePlanningResumeTarget");
assert.match(src, /if\(!startNewPlanning\s*&&\s*resumeDecision\s*===\s*["']final_review["']\)/, "skips planning review when resumeDecision is final_review");

// In ensurePlanningReady, both resume paths and complete-artifacts path guard reviewExistingPlanning with resumeDecision !== "final_review"
assert.ok(
  (src.match(/resumeDecision\s*!==\s*["']final_review["']\s*\)\s*await\s+reviewExistingPlanning/g) || []).length >= 2,
  "SpecKit and standalone resume paths guard reviewExistingPlanning with resumeDecision !== 'final_review'"
);

console.log("PASS: (b) source checks passed");

// ---------------------------------------------------------------------------
// (c) SpecKit digest skip:
// unchanged digest -> skipped,
// changed tasks checkbox only -> skipped (normalised),
// changed task text -> reviewed
// ---------------------------------------------------------------------------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "speckit-digest-test-"));
try {
  const specFile = path.join(tmpDir, "spec.md");
  const planFile = path.join(tmpDir, "plan.md");
  const tasksFile = path.join(tmpDir, "tasks.md");

  const SPEC = "# Specification\nFeature: Core MVP\nFR-001: Customers must have unique IDs.\n";
  const PLAN = "# Plan\nArchitecture: Clean Architecture\nPhased delivery.\n";
  const TASKS = "## Phase 1: Core Setup\n- [ ] **1.1** Initialize DB — accept: db connects ; verify: npm test\n- [ ] **1.2** Add Order model — accept: model validates ; verify: npm test\n";

  fs.writeFileSync(specFile, SPEC);
  fs.writeFileSync(planFile, PLAN);
  fs.writeFileSync(tasksFile, TASKS);

  const d0 = planningArtifactDigest(specFile, planFile, tasksFile);
  assert.ok(typeof d0 === "string" && d0.length === 64, "planningArtifactDigest returns sha256 hex string");

  const stored = {
    status: "passed",
    framework: "speckit",
    at: "2026-11-08T12:00:00.000Z",
    artifactDigest: d0
  };

  // 1. Unchanged digest -> skipped
  assert.equal(
    canSkipPlanningStateReview(stored, d0),
    true,
    "unchanged digest -> skipped"
  );

  // 2. Changed tasks checkbox only (- [ ] -> - [x] or - [X]) -> skipped (normalised)
  const checkedTasks = TASKS
    .replace("- [ ] **1.1**", "- [x] **1.1**")
    .replace("- [ ] **1.2**", "- [X] **1.2**");
  fs.writeFileSync(tasksFile, checkedTasks);
  const dCheckboxFlipped = planningArtifactDigest(specFile, planFile, tasksFile);
  assert.equal(
    dCheckboxFlipped,
    d0,
    "checkbox state normalised so digest matches d0"
  );
  assert.equal(
    canSkipPlanningStateReview(stored, dCheckboxFlipped),
    true,
    "changed tasks checkbox only -> skipped"
  );

  // 3. Changed task text -> reviewed
  const modifiedTaskText = TASKS.replace("Initialize DB", "Initialize PostgreSQL DB");
  fs.writeFileSync(tasksFile, modifiedTaskText);
  const dModifiedTask = planningArtifactDigest(specFile, planFile, tasksFile);
  assert.notEqual(dModifiedTask, d0, "task text modification changes digest");
  assert.equal(
    canSkipPlanningStateReview(stored, dModifiedTask),
    false,
    "changed task text -> reviewed (not skipped)"
  );
  // Restore tasks
  fs.writeFileSync(tasksFile, TASKS);

  // 4. Changed plan text -> reviewed
  fs.writeFileSync(planFile, PLAN + "\nExtra plan detail\n");
  const dModifiedPlan = planningArtifactDigest(specFile, planFile, tasksFile);
  assert.notEqual(dModifiedPlan, d0, "plan modification changes digest");
  assert.equal(
    canSkipPlanningStateReview(stored, dModifiedPlan),
    false,
    "changed plan text -> reviewed (not skipped)"
  );
  // Restore plan
  fs.writeFileSync(planFile, PLAN);

  // 5. Changed spec text -> reviewed
  fs.writeFileSync(specFile, SPEC + "\nFR-002: Extra requirement\n");
  const dModifiedSpec = planningArtifactDigest(specFile, planFile, tasksFile);
  assert.notEqual(dModifiedSpec, d0, "spec modification changes digest");
  assert.equal(
    canSkipPlanningStateReview(stored, dModifiedSpec),
    false,
    "changed spec text -> reviewed (not skipped)"
  );
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("PASS: (c) SpecKit digest skip tests passed");
console.log("All test-resume-after-final-review checks passed.");
