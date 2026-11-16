#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  rebuildTaskOwnership,
  loadTaskOwnership,
  recordTaskOwnership,
  recordFindingTasks,
  loadFindingTasks,
} from "./finding-task-locality.mjs";
import { stableTaskId } from "./role-progress-ids.mjs";
import { saveReviewFeedback } from "./review-feedback.mjs";

console.log("Running rebuild-task-ownership tests (#10)...");

const testDir = path.resolve(".autopilot", "test-rebuild-runs-" + Date.now());
const runsDir = path.join(testDir, "runs");
fs.mkdirSync(runsDir, { recursive: true });

try {
  // Phase list fixture for neutral standalone/speckit phases
  const phaseList = [
    {
      name: "Setup Phase",
      tasks: [
        { text: "**1.1** Setup config module", file: "plan.md" },
        { text: "**1.2** Add helper utilities", file: "plan.md" },
      ],
    },
    {
      name: "Core Phase",
      tasks: [
        { text: "**2.1** Build core engine", file: "plan.md" },
      ],
    },
    {
      name: "App Phase",
      tasks: [
        { text: "**3.1** Implement application features", file: "plan.md" },
      ],
    },
  ];

  const mission = "test-mission";
  const repoRoot = testDir;

  const expectedTaskId1_1 = stableTaskId(
    { framework: "standalone", mission, phaseIndex: 0, phaseNumber: 1, phaseName: "Setup Phase", repoRoot },
    { file: "plan.md", text: "**1.1** Setup config module" },
    0
  );
  const expectedTaskId1_2 = stableTaskId(
    { framework: "standalone", mission, phaseIndex: 0, phaseNumber: 1, phaseName: "Setup Phase", repoRoot },
    { file: "plan.md", text: "**1.2** Add helper utilities" },
    1
  );
  const expectedTaskId2_1 = stableTaskId(
    { framework: "standalone", mission, phaseIndex: 1, phaseNumber: 2, phaseName: "Core Phase", repoRoot },
    { file: "plan.md", text: "**2.1** Build core engine" },
    0
  );

  // Helper to write a run directory with result.json
  function writeRunResult(dirName, resultData) {
    const runDir = path.join(runsDir, dirName);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify(resultData, null, 2), "utf8");
  }

  // Populate runs dir:
  // 1. Valid completed implementer run for Phase 1 Task 1
  writeRunResult("01-implementer-run1", {
    role: "implementer",
    status: "completed",
    phase: "1",
    taskRef: "T1.1",
    touchedFiles: ["src/config/setup.ts"],
    mission,
  });

  // 2. Another completed implementer run for Phase 1 Task 1 (merges files across runs)
  writeRunResult("02-implementer-run2", {
    role: "implementer",
    status: "completed",
    phase: "1",
    taskRef: "T1.1",
    touchedFiles: ["src/config/env.ts"],
    mission,
  });

  // 3. Valid completed implementer run for Phase 1 Task 2
  writeRunResult("03-implementer-run3", {
    role: "implementer",
    status: "completed",
    phase: "1",
    taskRef: "T1.2",
    touchedFiles: ["src/utils/helpers.ts"],
    mission,
  });

  // 4. Valid completed implementer run for Phase 2 Task 1
  writeRunResult("04-implementer-run4", {
    role: "implementer",
    status: "completed",
    phase: "2",
    taskRef: "T2.1",
    touchedFiles: ["src/core/engine.ts"],
    mission,
  });

  // 5. Run with failed status -> ignored
  writeRunResult("05-implementer-failed", {
    role: "implementer",
    status: "failed",
    phase: "1",
    taskRef: "T1.1",
    touchedFiles: ["src/failed.ts"],
    mission,
  });

  // 6. Run with other role (verifier) -> ignored
  writeRunResult("06-verifier-run", {
    role: "verifier",
    status: "completed",
    phase: "1",
    taskRef: "T1.1",
    touchedFiles: ["src/verifier.ts"],
    mission,
  });

  // 7. Run with other role (code_reviewer) -> ignored
  writeRunResult("07-code_reviewer-run", {
    role: "code_reviewer",
    status: "completed",
    phase: "1",
    taskRef: "T1.1",
    touchedFiles: ["src/reviewer.ts"],
    mission,
  });

  // 8. Run for current phase (phase 3 >= current phase number 3) -> ignored
  writeRunResult("08-implementer-current-phase", {
    role: "implementer",
    status: "completed",
    phase: "3",
    taskRef: "T3.1",
    touchedFiles: ["src/current_p3.ts"],
    mission,
  });

  // 9. Run with unmappable taskRef -> skipped and counted
  writeRunResult("09-implementer-unmatched", {
    role: "implementer",
    status: "completed",
    phase: "1",
    taskRef: "T99.99",
    touchedFiles: ["src/unmatched.ts"],
    mission,
  });

  // --------------------------------------------------------------------------
  // Test 1: Resumed state at Phase 3 with empty taskOwnership -> rebuilt with
  // the right stable ids and files, and cross-phase finding routes to targeted repair.
  // --------------------------------------------------------------------------
  {
    const logs = [];
    const log = (msg) => logs.push(msg);

    const state = {
      phaseIndex: 2, // Resumed at Phase 3 (0-based index 2)
      taskOwnership: {},
      mission,
    };

    const count = rebuildTaskOwnership(state, {
      phaseIndex: 2,
      phaseList,
      runsDir,
      framework: "standalone",
      mission,
      repoRoot,
      log,
    });

    assert.equal(count, 3, "Should rebuild exactly 3 tasks from earlier phases");
    assert.ok(
      logs.some((l) => l.includes("task ownership rebuilt for 3 tasks from earlier phases (1 runs skipped: no task match)")),
      `Expected log message with 3 tasks rebuilt and 1 run skipped, got: ${logs.join("\n")}`
    );

    const ownership = loadTaskOwnership(state);

    // Verify Phase 1 Task 1: stable ID and merged touched files
    assert.ok(ownership[expectedTaskId1_1], "Phase 1 Task 1 should have ownership entry");
    assert.equal(ownership[expectedTaskId1_1].phaseIndex, 0);
    assert.equal(ownership[expectedTaskId1_1].phaseNumber, 1);
    assert.deepEqual(
      ownership[expectedTaskId1_1].files.sort(),
      ["src/config/env.ts", "src/config/setup.ts"].sort(),
      "Touched files from runs 01 and 02 should be merged"
    );

    // Verify Phase 1 Task 2
    assert.ok(ownership[expectedTaskId1_2], "Phase 1 Task 2 should have ownership entry");
    assert.equal(ownership[expectedTaskId1_2].phaseIndex, 0);
    assert.deepEqual(ownership[expectedTaskId1_2].files, ["src/utils/helpers.ts"]);

    // Verify Phase 2 Task 1
    assert.ok(ownership[expectedTaskId2_1], "Phase 2 Task 1 should have ownership entry");
    assert.equal(ownership[expectedTaskId2_1].phaseIndex, 1);
    assert.deepEqual(ownership[expectedTaskId2_1].files, ["src/core/engine.ts"]);

    // Verify ignored files are not present
    const allFiles = Object.values(ownership).flatMap((e) => e.files);
    assert.ok(!allFiles.includes("src/failed.ts"), "Failed run files must be ignored");
    assert.ok(!allFiles.includes("src/verifier.ts"), "Verifier run files must be ignored");
    assert.ok(!allFiles.includes("src/reviewer.ts"), "Reviewer run files must be ignored");
    assert.ok(!allFiles.includes("src/current_p3.ts"), "Current phase files must not be captured in earlier rebuild");
    assert.ok(!allFiles.includes("src/unmatched.ts"), "Unmatched run files must be ignored");

    // Cross-phase finding: cited file in src/config/setup.ts
    const currentTaskIds = ["standalone:P3:T0:currtask"];
    const key = "standalone-phase:2";
    const digest = "phase-3-digest";
    const findings = [
      {
        location: "src/config/setup.ts:20:1",
        problem: "Missing parameter validation in setup configuration.",
        correction: "Validate configuration options in setup.ts",
      },
    ];

    saveReviewFeedback(state, key, findings);
    recordFindingTasks(state, key, {
      phaseTaskDigest: digest,
      findings,
      taskIds: currentTaskIds,
      factsByTask: {
        [currentTaskIds[0]]: { files: ["src/app/main.ts"], summary: "implemented app feature" },
      },
      revision: 1,
      carryAllowed: true,
      taskOwnership: loadTaskOwnership(state),
    });

    const record = loadFindingTasks(state, key, { phaseTaskDigest: digest });
    assert.equal(record?.entries?.[0]?.source, "cross-phase", "Finding should resolve as cross-phase");
    assert.equal(record?.entries?.[0]?.taskIds?.[0], expectedTaskId1_1, "Finding should map to Phase 1 Task 1");
    assert.equal(record?.allMapped, true, "allMapped should be true");
    assert.equal(record?.affected?.length, 0, "Current phase task should not be in affected");
    assert.ok(Array.isArray(record?.crossPhase) && record.crossPhase.length === 1, "Should produce 1 crossPhase repair");
    assert.equal(record.crossPhase[0].taskId, expectedTaskId1_1);
    console.log("PASS: resumed state rebuilt ownership and cross-phase finding routed to targeted repair");
  }

  // --------------------------------------------------------------------------
  // Test 2: Existing entries kept (merge without overwriting)
  // --------------------------------------------------------------------------
  {
    const logs = [];
    const log = (msg) => logs.push(msg);

    const state = {
      phaseIndex: 2,
      taskOwnership: {},
      mission,
    };

    // Pre-populate an existing entry for Phase 1 Task 1 with an existing file
    recordTaskOwnership(state, {
      taskId: expectedTaskId1_1,
      phaseIndex: 0,
      phaseNumber: 1,
      phaseName: "Setup Phase",
      taskText: "Pre-existing setup text",
      files: ["src/config/preexisting.ts"],
      summary: "pre-existing summary",
    });

    // Also pre-populate an entry for an unrelated task
    recordTaskOwnership(state, {
      taskId: "custom:unrelated:task",
      phaseIndex: 0,
      phaseNumber: 1,
      phaseName: "Old",
      taskText: "Custom task",
      files: ["src/custom/existing.ts"],
      summary: "custom task summary",
    });

    const count = rebuildTaskOwnership(state, {
      phaseIndex: 2,
      phaseList,
      runsDir,
      framework: "standalone",
      mission,
      repoRoot,
      log,
      force: true, // Force rebuild to test merging with existing entries
    });

    assert.equal(count, 3, "Should rebuild candidates and merge");
    const ownership = loadTaskOwnership(state);

    // Verify existing file from preexisting entry is preserved alongside new run files
    assert.ok(
      ownership[expectedTaskId1_1].files.includes("src/config/preexisting.ts"),
      "Existing file must be kept in merged files"
    );
    assert.ok(
      ownership[expectedTaskId1_1].files.includes("src/config/setup.ts"),
      "New run file must be merged"
    );
    assert.ok(
      ownership[expectedTaskId1_1].files.includes("src/config/env.ts"),
      "New run file must be merged"
    );

    // Unrelated existing task remains completely intact
    assert.ok(ownership["custom:unrelated:task"], "Unrelated existing entry must be kept");
    assert.deepEqual(ownership["custom:unrelated:task"].files, ["src/custom/existing.ts"]);
    console.log("PASS: existing entries are kept and files are merged");
  }

  // --------------------------------------------------------------------------
  // Test 3: No per-task file data exists -> logs once and does nothing
  // --------------------------------------------------------------------------
  {
    const logs = [];
    const log = (msg) => logs.push(msg);
    const emptyRunsDir = path.join(testDir, "empty_runs");
    fs.mkdirSync(emptyRunsDir, { recursive: true });

    const state = {
      phaseIndex: 2,
      taskOwnership: {},
      mission,
    };

    const count1 = rebuildTaskOwnership(state, {
      phaseIndex: 2,
      phaseList,
      runsDir: emptyRunsDir,
      log,
    });
    assert.equal(count1, 0);
    assert.equal(logs.length, 1);
    assert.ok(logs[0].includes("no per-task file data exists for old phases; skipping task ownership rebuild"));

    // Second call: does nothing, logs nothing (already attempted)
    const count2 = rebuildTaskOwnership(state, {
      phaseIndex: 2,
      phaseList,
      runsDir: emptyRunsDir,
      log,
    });
    assert.equal(count2, 0);
    assert.equal(logs.length, 1, "Should log only once");
    console.log("PASS: empty runs dir logs once and skips");
  }

  console.log("All rebuild-task-ownership tests PASSED!");
} finally {
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {}
}
