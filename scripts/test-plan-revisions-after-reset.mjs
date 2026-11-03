#!/usr/bin/env node
// Test plan revisions after reset (backlog #5)
// Asserts that:
// (a) SpecKit without planReviewRevisions shows 0/10 and 0 revisions of 10 even with old planner runs at 7
// (b) SpecKit with {"speckit-stage:tasks":3} shows 3/10 and 3 revisions of 10 even with old planner runs at 7
// (c) GSD with gsdPlanningReview.revision 2 shows 2/10 and 2 revisions of 10 even with old planner runs at 5
// (d) Standalone with standalonePlanReview.revision 1 shows 1/10 and 1 revision of 10 even with old planner runs at 4;
//     standalone without standalonePlanReview.revision keeps run high-water (4/10 and 4 revisions of 10).

import {
  buildReportModel,
  renderPipelineState,
  renderPlanningStage,
} from "./watch-report.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`);
  }
};

const run = (o) => ({
  status: "completed",
  decision: null,
  findings: [],
  started_at: "2026-11-03T10:00:00.000Z",
  duration: "00:01:00",
  duration_ms: 60000,
  ...o,
});

// (a) SpecKit, state without planReviewRevisions, planner runs with planRevision 7
//     → plan_revisions=0/10 and 0 revisions of 10
{
  const state = {
    mission: "speckit-after-reset",
    phase: "planning",
    step: "speckit-tasks",
    planningDetection: { framework: "speckit" },
  };
  const runs = [
    run({ id: "01-planner", role: "planner", taskRef: "speckit-tasks", planRevision: 7 }),
  ];
  const model = buildReportModel({
    state,
    runs,
    phases: [],
    layout: { retries: { plan_revisions: 10 } },
  });
  const retries = renderPipelineState(model).split("\n").find((l) => l.startsWith("Retries:"));
  const planningSection = renderPlanningStage(model);

  check("(a) SpecKit retries line shows plan_revisions=0/10 after reset",
    retries && retries.includes("plan_revisions=0/10"), retries);
  check("(a) SpecKit planning header shows 0 revisions of 10 after reset",
    planningSection.includes("0 revisions of 10"), planningSection.split("\n")[0]);
}

// (b) SpecKit state {"speckit-stage:tasks":3} with old runs at 7 → 3/10 and 3 revisions of 10
{
  const state = {
    mission: "speckit-stage-counter",
    phase: "planning",
    step: "speckit-tasks",
    planningDetection: { framework: "speckit" },
    planReviewRevisions: { "speckit-stage:tasks": 3 },
  };
  const runs = [
    run({ id: "01-planner", role: "planner", taskRef: "speckit-tasks", planRevision: 7 }),
  ];
  const model = buildReportModel({
    state,
    runs,
    phases: [],
    layout: { retries: { plan_revisions: 10 } },
  });
  const retries = renderPipelineState(model).split("\n").find((l) => l.startsWith("Retries:"));
  const planningSection = renderPlanningStage(model);

  check("(b) SpecKit retries line shows plan_revisions=3/10",
    retries && retries.includes("plan_revisions=3/10"), retries);
  check("(b) SpecKit planning header shows 3 revisions of 10",
    planningSection.includes("3 revisions of 10"), planningSection.split("\n")[0]);
}

// (c) GSD state gsdPlanningReview.revision 2 with old runs at 5 → 2/10 and 2 revisions of 10
{
  const state = {
    mission: "gsd-stage-counter",
    phase: "planning",
    step: "gsd-plan",
    planningDetection: { framework: "gsd" },
    gsdPlanningReview: { stage: "plan", revision: 2 },
  };
  const runs = [
    run({ id: "01-planner", role: "planner", taskRef: "gsd-planning-planner", planRevision: 5 }),
  ];
  const model = buildReportModel({
    state,
    runs,
    phases: [],
    layout: { retries: { plan_revisions: 10 } },
  });
  const retries = renderPipelineState(model).split("\n").find((l) => l.startsWith("Retries:"));
  const planningSection = renderPlanningStage(model);

  check("(c) GSD retries line shows plan_revisions=2/10",
    retries && retries.includes("plan_revisions=2/10"), retries);
  check("(c) GSD planning header shows 2 revisions of 10",
    planningSection.includes("2 revisions of 10"), planningSection.split("\n")[0]);
}

// (d) Standalone with standalonePlanReview.revision 1 and old runs at 4 → 1/10 and 1 revision of 10;
//     standalone without it → run high-water as today (4/10 and 4 revisions of 10).
{
  const stateWithRev = {
    mission: "standalone-reset-1",
    phase: "planning",
    step: "plan",
    planningDetection: { framework: "standalone" },
    standalonePlanReview: { revision: 1 },
  };
  const runs = [
    run({ id: "01-planner", role: "planner", taskRef: "standalone-planning-planner", planRevision: 4 }),
  ];
  const modelWithRev = buildReportModel({
    state: stateWithRev,
    runs,
    phases: [],
    layout: { retries: { plan_revisions: 10 } },
  });
  const retriesWithRev = renderPipelineState(modelWithRev).split("\n").find((l) => l.startsWith("Retries:"));
  const planningWithRev = renderPlanningStage(modelWithRev);

  check("(d) Standalone with standalonePlanReview.revision 1 shows plan_revisions=1/10",
    retriesWithRev && retriesWithRev.includes("plan_revisions=1/10"), retriesWithRev);
  check("(d) Standalone with standalonePlanReview.revision 1 shows 1 revision of 10",
    planningWithRev.includes("1 revision of 10"), planningWithRev.split("\n")[0]);

  // Standalone without standalonePlanReview.revision (absent / deleted after reset before new revision)
  const stateWithoutRev = {
    mission: "standalone-no-rev",
    phase: "planning",
    step: "plan",
    planningDetection: { framework: "standalone" },
  };
  const modelWithoutRev = buildReportModel({
    state: stateWithoutRev,
    runs,
    phases: [],
    layout: { retries: { plan_revisions: 10 } },
  });
  const retriesWithoutRev = renderPipelineState(modelWithoutRev).split("\n").find((l) => l.startsWith("Retries:"));
  const planningWithoutRev = renderPlanningStage(modelWithoutRev);

  check("(d) Standalone without standalonePlanReview.revision keeps run high-water plan_revisions=4/10",
    retriesWithoutRev && retriesWithoutRev.includes("plan_revisions=4/10"), retriesWithoutRev);
  check("(d) Standalone without standalonePlanReview.revision keeps run high-water 4 revisions of 10",
    planningWithoutRev.includes("4 revisions of 10"), planningWithoutRev.split("\n")[0]);
}

if (failures.length) {
  console.error(`\nFailed ${failures.length} check(s): ${failures.join(", ")}`);
  process.exit(1);
}

console.log("\nAll plan-revisions-after-reset checks passed.");
