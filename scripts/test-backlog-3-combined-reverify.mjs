#!/usr/bin/env node
// Backlog rv #3 tests: combined overlap re-verify session for >=2 overlap tasks,
// single-session path for 1 overlap task, per-task fallback on combined failure,
// complete roleProgress bookkeeping, and both standalone + SpecKit loop wiring.
import fs from "node:fs";
import {
  collectOverlapReverifyBatch,
  buildCombinedOverlapReverifyBrief,
  runCombinedOverlapReverify,
} from "./finding-task-locality.mjs";
import { prepareTaskInvocation } from "./role-progress-commit.mjs";
import { isReviewerFeedbackFixPass } from "./final-review-fix-rounds.mjs";

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

const DIGEST = "digest-phase-6";
const RUN_ID = "run-008";
const REVISION = 2;

function makeFixture({ taskIds, affected, carryFilesByTask, completedFixingIds = ["T044"], fixingTouchedFiles = ["apps/web/src/lib/admin/provisioning/workflow.ts"] }) {
  const carry = {};
  for (const [tid, files] of Object.entries(carryFilesByTask)) {
    carry[tid] = {
      summary: `Done ${tid}`,
      files,
      taskLocalCheck: { command: "npm test", status: "passed", exitCode: 0, summary: "ok" },
    };
  }
  const findingRecord = {
    revision: REVISION - 1,
    phaseTaskDigest: DIGEST,
    taskIds,
    affected,
    carry,
    entries: [
      { source: "declared", taskIds: completedFixingIds },
    ],
  };
  const factsByTask = {};
  for (const fid of completedFixingIds) {
    factsByTask[fid] = {
      summary: `Fixed ${fid}`,
      files: fixingTouchedFiles,
      taskLocalCheck: { command: "npm test", status: "passed", exitCode: 0, summary: "ok" },
    };
  }
  const progress = {
    implementer: {
      status: "running",
      taskCursor: completedFixingIds.length,
      currentTaskId: null,
      completedTaskIds: [...completedFixingIds],
      factsByTask,
    },
    codeReviewer: { status: "pending", taskCursor: 0, currentTaskId: null, completedTaskIds: [], phaseWidePassComplete: false, findingsByTask: {} },
    verifier: { status: "pending", taskCursor: 0, currentTaskId: null, completedTaskIds: [], phaseWidePassComplete: false, evidenceByTask: {} },
  };
  const taskFindings = ["T044: delete unused aliases in workflow.ts"];
  const phaseTasks = taskIds.map((id) => ({
    id,
    text: `${id} Extend workflow.ts — accept: ${id} works ; verify: node test-${id.toLowerCase()}.mjs`,
  }));
  return { findingRecord, progress, taskFindings, phaseTasks };
}

// ── 1. Three overlap tasks → ONE combined session listing all three + files ──
{
  const taskIds = ["T044", "T046", "T047", "T048"];
  const sharedFile = "apps/web/src/lib/admin/provisioning/workflow.ts";
  const { findingRecord, progress, taskFindings, phaseTasks } = makeFixture({
    taskIds,
    affected: ["T044"],
    carryFilesByTask: {
      T046: [sharedFile],
      T047: [sharedFile],
      T048: [sharedFile],
    },
  });

  const batch = collectOverlapReverifyBatch({
    phaseTaskIds: taskIds,
    startIndex: 1,
    findingRecord,
    taskFindings,
    progress,
    revision: REVISION,
    phaseTaskDigest: DIGEST,
  });

  check("3 overlap tasks: batch is eligible", batch.eligible === true, batch);
  check("3 overlap tasks: all 3 collected in order",
    JSON.stringify(batch.overlapTasks.map((t) => t.taskId)) === JSON.stringify(["T046", "T047", "T048"]),
    batch.overlapTasks.map((t) => t.taskId));
  check("3 overlap tasks: fixingTaskIds and changedFiles captured",
    JSON.stringify(batch.fixingTaskIds) === JSON.stringify(["T044"])
    && JSON.stringify(batch.changedFiles) === JSON.stringify([sharedFile]),
    { fixingTaskIds: batch.fixingTaskIds, changedFiles: batch.changedFiles });

  const brief = buildCombinedOverlapReverifyBrief({
    framework: "speckit",
    phaseNumber: 6,
    phaseName: "Provisioning workflow",
    phaseTotal: 6,
    phaseBriefPath: ".autopilot/missions/008/phase-6.md",
    phaseTaskIds: taskIds,
    phaseTasks,
    overlapTasks: batch.overlapTasks,
    fixingTaskIds: batch.fixingTaskIds,
    changedFiles: batch.changedFiles,
    handoffNotePath: ".autopilot/missions/008/handoff/overlap-reverify-phase-6.md",
  });

  check("combined brief lists all 3 task IDs + accept/verify lines",
    brief.includes("T046") && brief.includes("T047") && brief.includes("T048")
    && brief.includes("test-t046.mjs") && brief.includes("test-t047.mjs") && brief.includes("test-t048.mjs"),
    brief);
  check("combined brief lists changed file and fixing task id",
    brief.includes(sharedFile) && brief.includes("T044"),
    brief);
  check("combined brief carries required re-verify instruction",
    brief.includes("Re-verify each listed task; repair only what the change broke; do not redo the fix."),
    brief);
  check("combined brief is NOT classified as reviewer-feedback fix pass",
    isReviewerFeedbackFixPass(brief) === false);

  const initialPrep = prepareTaskInvocation({
    progress,
    role: "implementer",
    runId: RUN_ID,
    revision: REVISION,
    phaseTaskDigest: DIGEST,
    taskId: "T046",
    taskIds,
  });
  check("initialPrep succeeded for first overlap task", initialPrep.ok === true, initialPrep);

  let relayCalls = 0;
  const committedIds = [];
  const res = await runCombinedOverlapReverify({
    overlapBatch: batch,
    initialPrep,
    progress: initialPrep.progress,
    runId: RUN_ID,
    revision: REVISION,
    phaseTaskDigest: DIGEST,
    phaseTaskIds: taskIds,
    invokeRelay: async () => {
      relayCalls += 1;
      return {
        status: "completed",
        adapter: "opencode",
        finalMessage: 'AUTOPILOT_TASK_RESULT={"summary":"Re-verified T046, T047, T048 — all pass with no edits","taskLocalCheck":{"command":"npm test","status":"passed","exitCode":0,"summary":"all passed"}}',
      };
    },
    computeAttributedFiles: () => [],
    onCommitTask: (item) => committedIds.push(item.taskId),
  });

  check("3 overlap tasks: exactly ONE relay session launched", relayCalls === 1, relayCalls);
  check("3 overlap tasks: combined run succeeded", res.ok === true, res);
  check("3 overlap tasks: all 3 tasks committed via onCommitTask",
    JSON.stringify(committedIds) === JSON.stringify(["T046", "T047", "T048"]),
    committedIds);
  check("3 overlap tasks: roleProgress marks all tasks complete",
    res.progress.implementer.status === "complete"
    && JSON.stringify(res.progress.implementer.completedTaskIds) === JSON.stringify(["T044", "T046", "T047", "T048"])
    && res.progress.implementer.factsByTask.T046?.summary?.includes("Re-verified")
    && res.progress.implementer.factsByTask.T047?.summary?.includes("Re-verified")
    && res.progress.implementer.factsByTask.T048?.summary?.includes("Re-verified"),
    res.progress.implementer);
}

// ── 2. Single overlap task → keeps single per-task path ──
{
  const taskIds = ["T044", "T046", "T047"];
  const sharedFile = "apps/web/src/lib/admin/provisioning/workflow.ts";
  const { findingRecord, progress, taskFindings } = makeFixture({
    taskIds,
    affected: ["T044"],
    carryFilesByTask: {
      T046: [sharedFile],
      T047: ["apps/web/src/lib/other.ts"], // unrelated file → carry:true
    },
  });

  const batch = collectOverlapReverifyBatch({
    phaseTaskIds: taskIds,
    startIndex: 1,
    findingRecord,
    taskFindings,
    progress,
    revision: REVISION,
    phaseTaskDigest: DIGEST,
  });

  check("1 overlap task: batch is NOT eligible (uses single per-task path)",
    batch.eligible === false && batch.overlapTasks.length === 1,
    batch);
}

// ── 3. Combined failure → falls back to per-task re-runs without committing ──
{
  const taskIds = ["T044", "T046", "T047", "T048"];
  const sharedFile = "apps/web/src/lib/admin/provisioning/workflow.ts";
  const { findingRecord, progress, taskFindings } = makeFixture({
    taskIds,
    affected: ["T044"],
    carryFilesByTask: {
      T046: [sharedFile],
      T047: [sharedFile],
      T048: [sharedFile],
    },
  });

  const batch = collectOverlapReverifyBatch({
    phaseTaskIds: taskIds,
    startIndex: 1,
    findingRecord,
    taskFindings,
    progress,
    revision: REVISION,
    phaseTaskDigest: DIGEST,
  });

  const initialPrep = prepareTaskInvocation({
    progress,
    role: "implementer",
    runId: RUN_ID,
    revision: REVISION,
    phaseTaskDigest: DIGEST,
    taskId: "T046",
    taskIds,
  });

  let committedOnFailure = 0;
  const failRes = await runCombinedOverlapReverify({
    overlapBatch: batch,
    initialPrep,
    progress: initialPrep.progress,
    runId: RUN_ID,
    revision: REVISION,
    phaseTaskDigest: DIGEST,
    phaseTaskIds: taskIds,
    invokeRelay: async () => ({ status: "failed", finalMessage: "" }),
    onCommitTask: () => { committedOnFailure += 1; },
  });

  check("combined failure: returns fallback:true and ok:false",
    failRes.ok === false && failRes.fallback === true && failRes.reason === "status:failed",
    failRes);
  check("combined failure: no tasks committed on failure",
    committedOnFailure === 0 && initialPrep.progress.implementer.completedTaskIds.length === 1,
    { committedOnFailure, completed: initialPrep.progress.implementer.completedTaskIds });

  // Once fallbackTaskIds records those tasks, collectOverlapReverifyBatch skips them → per-task path
  const skipTaskIds = new Set(batch.overlapTasks.map((t) => t.taskId));
  const afterFallback = collectOverlapReverifyBatch({
    phaseTaskIds: taskIds,
    startIndex: 1,
    findingRecord,
    taskFindings,
    progress: initialPrep.progress,
    revision: REVISION,
    phaseTaskDigest: DIGEST,
    skipTaskIds,
  });
  check("after fallback: skipTaskIds disables batching so per-task runs execute",
    afterFallback.eligible === false,
    afterFallback);
}

// ── 4. Intervening carried task between two overlap tasks is carried in-order ──
{
  const taskIds = ["T044", "T046", "T047", "T048"];
  const sharedFile = "apps/web/src/lib/admin/provisioning/workflow.ts";
  const { findingRecord, progress, taskFindings } = makeFixture({
    taskIds,
    affected: ["T044"],
    carryFilesByTask: {
      T046: [sharedFile],
      T047: ["apps/web/src/lib/unrelated.ts"],
      T048: [sharedFile],
    },
  });

  const batch = collectOverlapReverifyBatch({
    phaseTaskIds: taskIds,
    startIndex: 1,
    findingRecord,
    taskFindings,
    progress,
    revision: REVISION,
    phaseTaskDigest: DIGEST,
  });
  check("intervening carry: batch eligible with 2 overlap tasks and 3-item span",
    batch.eligible === true
    && JSON.stringify(batch.overlapTasks.map((t) => t.taskId)) === JSON.stringify(["T046", "T048"])
    && JSON.stringify(batch.span.map((s) => `${s.kind}:${s.taskId}`)) === JSON.stringify(["overlap:T046", "carry:T047", "overlap:T048"]),
    batch.span);

  const initialPrep = prepareTaskInvocation({
    progress,
    role: "implementer",
    runId: RUN_ID,
    revision: REVISION,
    phaseTaskDigest: DIGEST,
    taskId: "T046",
    taskIds,
  });
  const carriedInSpan = [];
  const committedInSpan = [];
  const res = await runCombinedOverlapReverify({
    overlapBatch: batch,
    initialPrep,
    progress: initialPrep.progress,
    runId: RUN_ID,
    revision: REVISION,
    phaseTaskDigest: DIGEST,
    phaseTaskIds: taskIds,
    invokeRelay: async () => ({
      status: "completed",
      finalMessage: 'AUTOPILOT_TASK_RESULT={"summary":"Re-verified T046 and T048","taskLocalCheck":{"command":"npm test","status":"passed","exitCode":0,"summary":"ok"}}',
    }),
    onCarryTask: (item) => carriedInSpan.push(item.taskId),
    onCommitTask: (item) => committedInSpan.push(item.taskId),
  });
  check("intervening carry: commits all 3 in strict plan order",
    res.ok === true
    && JSON.stringify(carriedInSpan) === JSON.stringify(["T047"])
    && JSON.stringify(committedInSpan) === JSON.stringify(["T046", "T048"])
    && JSON.stringify(res.progress.implementer.completedTaskIds) === JSON.stringify(["T044", "T046", "T047", "T048"]),
    { carriedInSpan, committedInSpan, completed: res.progress?.implementer?.completedTaskIds });
}

// ── 5. Both loops' wiring in scripts/autopilot.mjs ──
{
  const autoSrc = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
  const count = (re) => (autoSrc.match(re) || []).length;
  check("wiring: autopilot.mjs imports combined overlap helpers",
    autoSrc.includes("collectOverlapReverifyBatch")
    && autoSrc.includes("buildCombinedOverlapReverifyBrief")
    && autoSrc.includes("runCombinedOverlapReverify"));
  check("wiring: both standalone and SpecKit loops declare combinedFallbackTaskIds",
    count(/const combinedFallbackTaskIds=new Set\(\);/g) === 2,
    count(/const combinedFallbackTaskIds=new Set\(\);/g));
  check("wiring: both loops call collectOverlapReverifyBatch",
    count(/collectOverlapReverifyBatch\(\{/g) === 2,
    count(/collectOverlapReverifyBatch\(\{/g));
  check("wiring: both loops call buildCombinedOverlapReverifyBrief (standalone + speckit)",
    autoSrc.includes('framework:"standalone"') && autoSrc.includes('framework:"speckit"')
    && count(/buildCombinedOverlapReverifyBrief\(\{/g) === 2,
    count(/buildCombinedOverlapReverifyBrief\(\{/g));
  check("wiring: both loops call runCombinedOverlapReverify",
    count(/await runCombinedOverlapReverify\(\{/g) === 2,
    count(/await runCombinedOverlapReverify\(\{/g));
  check("wiring: both loops fall back to per-task re-verify on combined failure",
    count(/falling back to per-task re-verify for/g) === 2,
    count(/falling back to per-task re-verify for/g));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("backlog #3 combined overlap re-verify tests passed");
