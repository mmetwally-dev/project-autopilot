#!/usr/bin/env node
// Backlog #9i: SpecKit final review runs with taskRef `final-review-<framework>`
// and `final-fix-<framework>-round-<n>` are recognized as FINAL REVIEW runs,
// never create a fake placeholder Phase, show no task ref, read ✓ PASSED when
// the last review passed, and post-implementation interrupted plan_reviewer runs
// do not reopen the PLANNING stage.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildReportModel, renderReport, isFinalReviewRun, runEndAt, formatStamp } from "./watch-report.mjs";
import { resolveMissionPhases } from "./run-history.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures.push(name);
    console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`);
  }
};

// 1. Direct isFinalReviewRun checks for taskRef prefixes
check("isFinalReviewRun: final-review-speckit", isFinalReviewRun({ role: "code_reviewer", taskRef: "final-review-speckit" }, 13));
check("isFinalReviewRun: final-fix-speckit-round-1", isFinalReviewRun({ role: "implementer", taskRef: "final-fix-speckit-round-1" }, 13));
check("isFinalReviewRun: phase run rejected", !isFinalReviewRun({ role: "implementer", taskRef: "T001", phase: "1" }, 13));

// 2. Full SpecKit mission fixture with 13 phases and runs 659-664
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "speckit-fr-taskref-"));
const feature = path.join(repo, "specs", "002-feature");
fs.mkdirSync(feature, { recursive: true });
let tasks = "# Tasks\n\n";
for (let p = 1; p <= 13; p++) {
  tasks += `## Phase ${p}: Work ${p}\n\n- [x] T${String(p).padStart(3, "0")} Do thing ${p}\n\n`;
}
fs.writeFileSync(path.join(feature, "tasks.md"), tasks);

const state = {
  mission: "002-feature",
  phase: "complete",
  step: "human_commit",
  phaseIndex: 12,
  planningDetection: { framework: "speckit" },
  speckitFeatureDir: "002-feature",
};
const phases = resolveMissionPhases(repo, "002-feature", { project: { planning_framework: "speckit" } }, state);
check("fixture resolves 13 phases", phases.length === 13, phases.length);

const t = (n) => `2026-11-08T10:${String(n).padStart(2, "0")}:00.000Z`;
const runs = [];

// Planning stage runs
runs.push({
  id: "p-1", dirName: "01-planner", role: "planner", status: "completed",
  attempt: 1, started_at: t(1), duration_ms: 5000,
});
runs.push({
  id: "p-2", dirName: "02-plan_reviewer", role: "plan_reviewer", status: "completed",
  decision: "PASS", attempt: 1, started_at: t(2), duration_ms: 5000,
});

// Implementation runs: phases 1..13
for (let p = 1; p <= 13; p++) {
  runs.push({
    id: `impl-${p}`, dirName: `${p + 2}-implementer`, role: "implementer", status: "completed",
    phase: String(p), task: `T${String(p).padStart(3, "0")}`, taskRef: `T${String(p).padStart(3, "0")}`,
    attempt: 1, started_at: t(p + 2), duration_ms: 1000,
  });
}

// Final reviews matching the real issue:
// 659: code_reviewer (INCOMPLETE, phase "14", taskRef null)
runs.push({
  id: "r659", dirName: "659-code_reviewer", role: "code_reviewer", status: "incomplete",
  phase: "14", taskRef: null, attempt: 1, started_at: t(20), duration_ms: 1000,
});
// 660, 661, 662: implementer fix round 1 (phase "14", taskRef null; 660/661 rate limited, 662 FAILED)
runs.push({
  id: "r660", dirName: "660-implementer", role: "implementer", status: "failed",
  phase: "14", taskRef: null, note: "rate limited", attempt: 1, started_at: t(21), duration_ms: 1000,
});
runs.push({
  id: "r661", dirName: "661-implementer", role: "implementer", status: "failed",
  phase: "14", taskRef: null, note: "rate limited", attempt: 1, started_at: t(22), duration_ms: 1000,
});
runs.push({
  id: "r662", dirName: "662-implementer", role: "implementer", status: "failed",
  phase: "14", taskRef: null, attempt: 1, started_at: t(23), duration_ms: 1000,
});
// 663: plan_reviewer (INTERRUPTED, phase "14", taskRef "speckit-planning-plan_reviewer")
runs.push({
  id: "r663", dirName: "663-plan_reviewer", role: "plan_reviewer", status: "interrupted",
  phase: "14", taskRef: "speckit-planning-plan_reviewer", attempt: 1, started_at: t(24), duration_ms: 1000,
});
// 664: code_reviewer (completed, decision PASS, phase "14", taskRef "final-review-speckit")
runs.push({
  id: "r664", dirName: "664-code_reviewer", role: "code_reviewer", status: "completed",
  decision: "PASS", phase: "14", taskRef: "final-review-speckit", attempt: 1, started_at: t(25), duration_ms: 1000,
});

const model = buildReportModel({ state, runs, events: [], phases, policy: {} });
const text = renderReport(model, { stamp: "2026-11-08T11:00:00.000Z" });

// Verification requirements:
// 1. no Phase 14
check("no Phase 14 anywhere in report", !/Phase 14/.test(text), text.match(/.*Phase 14.*/)?.[0]);

// 2. real phases read Phase 13/13
check("real phases read Phase 13/13", /Phase 13\/13/.test(text) && !/\/14/.test(text));
check("model has 13 phases", model.phases.length === 13, model.phases.length);

// 3. 659-664 (except 663 per smaller change) under FINAL REVIEW
const frIds = model.finalReview.runs.map((r) => r.id).sort().join(",");
check("final review holds 659, 660, 661, 662, 664", frIds === "r659,r660,r661,r662,r664", frIds);

// 4. FINAL REVIEW stage reads ✓ PASSED
check("final review stage is passed", model.finalReview.status === "passed", model.finalReview.status);
check("FINAL REVIEW header has ✓ PASSED", /=== FINAL REVIEW STAGE ===\s+✓ PASSED/.test(text), text.match(/=== FINAL REVIEW STAGE ===.*/)?.[0]);

// 5. PLANNING not IN PROGRESS, with approving reviewer end time (not run 663)
check("planning stage is passed", model.planning.status === "passed", model.planning.status);
check("PLANNING not IN PROGRESS", !/=== PLANNING STAGE ===.*● IN PROGRESS/.test(text), text.match(/=== PLANNING STAGE ===.*/)?.[0]);
check("PLANNING header has ✓ PASSED", /=== PLANNING STAGE ===\s+✓ PASSED/.test(text), text.match(/=== PLANNING STAGE ===.*/)?.[0]);

const p2Run = runs.find((r) => r.id === "p-2");
const r663Run = runs.find((r) => r.id === "r663");
const p2EndStamp = formatStamp(runEndAt(p2Run));
const r663EndStamp = formatStamp(runEndAt(r663Run));
check("PLANNING header time equals approving reviewer end time", text.includes(`=== PLANNING STAGE ===  ✓ PASSED at ${p2EndStamp}`), text.match(/=== PLANNING STAGE ===.*/)?.[0]);
check("PLANNING header time does not equal run 663 end time", !text.includes(`at ${r663EndStamp}`), r663EndStamp);
check("PLANNING stage duration does not stretch to run 663", text.includes("00:00:10") && !text.includes("00:00:11"), text.match(/=== PLANNING STAGE ===.*/)?.[0]);

// 6. no final-review-speckit task text anywhere in report
check("no final-review-speckit task text in report", !/final-review-speckit/.test(text), text.match(/.*final-review-speckit.*/)?.[0]);

// 7. note says final review, not phase review
const frSection = text.slice(text.indexOf("=== FINAL REVIEW STAGE ==="));
check("final review row note says final review", /final review/.test(frSection));
check("final review row note does not say phase review", !/phase review/.test(frSection));

fs.rmSync(repo, { recursive: true, force: true });
if (failures.length) {
  console.error(`\nFAILED (${failures.length}): ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nAll watch-report-final-review-taskref checks passed.");
