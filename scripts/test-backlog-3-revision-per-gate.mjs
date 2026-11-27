#!/usr/bin/env node
import assert from "node:assert/strict";
import { buildReportModel, renderReport, renderPlanningStage } from "./watch-report.mjs";

const run = (o) => ({ status: "completed", decision: null, findings: [], ...o });

// ── 1. SpecKit two-gate planning: specify + plan ─────────────────────────────
// Gate 1 (specify / spec) has initial round + revision 1
// Gate 2 (plan) has initial round + revision 1
// Gate 2 must show "plan revision 1 of 10", NOT "revision 2 of 10" (no running total).
{
  const state = {
    mission: "001-two-gate-mission",
    phase: "planning",
    step: "plan_review",
    planningDetection: { framework: "speckit" },
    planReviewRevisions: {
      "speckit-stage:specify": 0,
      "speckit-stage:plan": 1,
    },
  };
  const runs = [
    // Gate 1: specify (spec)
    run({ id: "01-planner", role: "planner", gate: "specify", planningStage: "spec", planRevision: 0 }),
    run({ id: "02-plan_reviewer", role: "plan_reviewer", gate: "specify", planningStage: "spec", decision: "FAIL", findings: ["spec defect 1"] }),
    run({ id: "03-planner", role: "planner", gate: "specify", planningStage: "spec", planRevision: 1 }),
    run({ id: "04-plan_reviewer", role: "plan_reviewer", gate: "specify", planningStage: "spec", decision: "PASS" }),

    // Gate 2: plan
    run({ id: "05-planner", role: "planner", gate: "plan", planningStage: "plan", planRevision: 0 }),
    run({ id: "06-plan_reviewer", role: "plan_reviewer", gate: "plan", planningStage: "plan", decision: "FAIL", findings: ["plan defect 1"] }),
    run({ id: "07-planner", role: "planner", gate: "plan", planningStage: "plan", planRevision: 1 }),
    run({ id: "08-plan_reviewer", role: "plan_reviewer", gate: "plan", planningStage: "plan", decision: "PASS" }),
  ];

  const model = buildReportModel({ state, runs, events: [], phases: [], policy: { max_plan_revisions: 10 } });
  const rendered = renderPlanningStage(model);

  // Assertions
  assert.equal(model.planning.rounds.length, 4, "4 planning rounds created");
  assert.equal(model.planning.rounds[0].gate, "spec", "round 1 gate is spec");
  assert.equal(model.planning.rounds[1].gate, "spec", "round 2 gate is spec");
  assert.equal(model.planning.rounds[1].revision, 1, "round 2 revision is 1");
  assert.equal(model.planning.rounds[2].gate, "plan", "round 3 gate is plan");
  assert.equal(model.planning.rounds[3].gate, "plan", "round 4 gate is plan");
  assert.equal(model.planning.rounds[3].revision, 1, "round 4 revision is 1 (not running total 2)");

  assert.ok(rendered.includes("  Round 1"), "Round 1 header present");
  assert.ok(rendered.includes("  Round 2 (spec revision 1 of 10)"), "Round 2 header shows 'spec revision 1 of 10'");
  assert.ok(rendered.includes("  Round 3"), "Round 3 header present");
  assert.ok(rendered.includes("  Round 4 (plan revision 1 of 10)"), "Round 4 header shows 'plan revision 1 of 10'");
  assert.ok(!rendered.includes("revision 2 of 10"), "does NOT show running total 'revision 2 of 10'");
  console.log("PASS 1: SpecKit two gates, gate 2 shows revision 1 not the running total");
}

// ── 2. SpecKit when planRevision is omitted from runs (inferred per-gate) ────
{
  const state = {
    mission: "002-inferred-gate-mission",
    phase: "planning",
    step: "plan_review",
    planningDetection: { framework: "speckit" },
  };
  const runs = [
    // Gate 1: specify
    run({ id: "01-planner", role: "planner", taskRef: "speckit-planning-specify" }),
    run({ id: "02-plan_reviewer", role: "plan_reviewer", taskRef: "speckit-planning-plan_reviewer", planningStage: "spec", decision: "FAIL" }),
    run({ id: "03-planner", role: "planner", taskRef: "speckit-planning-specify" }),
    run({ id: "04-plan_reviewer", role: "plan_reviewer", taskRef: "speckit-planning-plan_reviewer", planningStage: "spec", decision: "PASS" }),

    // Gate 2: plan
    run({ id: "05-planner", role: "planner", taskRef: "speckit-planning-plan" }),
    run({ id: "06-plan_reviewer", role: "plan_reviewer", taskRef: "speckit-planning-plan_reviewer", planningStage: "plan", decision: "FAIL" }),
    run({ id: "07-planner", role: "planner", taskRef: "speckit-planning-plan" }),
    run({ id: "08-plan_reviewer", role: "plan_reviewer", taskRef: "speckit-planning-plan_reviewer", planningStage: "plan", decision: "PASS" }),
  ];

  const model = buildReportModel({ state, runs, events: [], phases: [], policy: { max_plan_revisions: 10 } });
  const rendered = renderPlanningStage(model);

  assert.equal(model.planning.rounds[1].gate, "spec");
  assert.equal(model.planning.rounds[1].revision, 1);
  assert.equal(model.planning.rounds[3].gate, "plan");
  assert.equal(model.planning.rounds[3].revision, 1, "inferred revision for gate 2 is 1, not 2");

  assert.ok(rendered.includes("  Round 2 (spec revision 1 of 10)"));
  assert.ok(rendered.includes("  Round 4 (plan revision 1 of 10)"));
  assert.ok(!rendered.includes("revision 2 of 10"));
  console.log("PASS 2: inferred per-gate revision counter");
}

// ── 3. Standalone with stages: standalone-spec + standalone-plan ─────────────
{
  const state = {
    mission: "003-standalone-stages",
    phase: "planning",
    planningDetection: { framework: "standalone" },
    workflow: { standalone_spec: true },
  };
  const runs = [
    run({ id: "01-planner", role: "planner", taskRef: "standalone-spec-planner", planRevision: 0 }),
    run({ id: "02-plan_reviewer", role: "plan_reviewer", taskRef: "standalone-spec-plan_reviewer", planRevision: 0, decision: "FAIL" }),
    run({ id: "03-planner", role: "planner", taskRef: "standalone-spec-planner", planRevision: 1 }),
    run({ id: "04-plan_reviewer", role: "plan_reviewer", taskRef: "standalone-spec-plan_reviewer", planRevision: 1, decision: "PASS" }),
    run({ id: "05-planner", role: "planner", taskRef: "standalone-planning-planner", planRevision: 0 }),
    run({ id: "06-plan_reviewer", role: "plan_reviewer", taskRef: "standalone-planning-plan_reviewer", planRevision: 0, decision: "FAIL" }),
    run({ id: "07-planner", role: "planner", taskRef: "standalone-planning-planner", planRevision: 1 }),
    run({ id: "08-plan_reviewer", role: "plan_reviewer", taskRef: "standalone-planning-plan_reviewer", planRevision: 1, decision: "PASS" }),
  ];

  const model = buildReportModel({ state, runs, events: [], phases: [], policy: { max_plan_revisions: 10 } });
  const rendered = renderPlanningStage(model);

  assert.equal(model.planning.rounds[1].gate, "spec");
  assert.equal(model.planning.rounds[1].revision, 1);
  assert.equal(model.planning.rounds[3].gate, "plan");
  assert.equal(model.planning.rounds[3].revision, 1);

  assert.ok(rendered.includes("  Round 2 (spec revision 1 of 10)"));
  assert.ok(rendered.includes("  Round 4 (plan revision 1 of 10)"));
  assert.ok(!rendered.includes("revision 2 of 10"));
  console.log("PASS 3: Standalone with stages shows per-stage revision");
}

// ── 4. Standalone without stages (single stage plan/tasks) ───────────────────
{
  const state = {
    mission: "004-standalone-single",
    phase: "planning",
    planningDetection: { framework: "standalone" },
  };
  const runs = [
    run({ id: "01-planner", role: "planner", taskRef: "standalone-planning-planner", planRevision: 0 }),
    run({ id: "02-plan_reviewer", role: "plan_reviewer", taskRef: "standalone-planning-plan_reviewer", planRevision: 0, decision: "FAIL" }),
    run({ id: "03-planner", role: "planner", taskRef: "standalone-planning-planner", planRevision: 1 }),
    run({ id: "04-plan_reviewer", role: "plan_reviewer", taskRef: "standalone-planning-plan_reviewer", planRevision: 1, decision: "PASS" }),
  ];

  const model = buildReportModel({ state, runs, events: [], phases: [], policy: { max_plan_revisions: 10 } });
  const rendered = renderPlanningStage(model);

  assert.equal(model.planning.rounds[1].gate, null, "single-stage standalone has null gate");
  assert.ok(rendered.includes("  Round 2 (revision 1 of 10)"), "Round 2 header shows 'revision 1 of 10' without gate prefix");
  console.log("PASS 4: Standalone without stages preserves legacy 'revision k of M' without gate prefix");
}

console.log("ALL test-backlog-3-revision-per-gate CHECKS PASSED");
