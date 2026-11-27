// Backlog #8: Phase-wide review findings routed to ONE task (not all).
// Standalone & SpecKit parity, real task ID labels, carry forward unaffected tasks.
import {
  mapFindingsToTasks,
  recordFindingTasks,
  loadFindingTasks,
  carryDecision,
  findingsForTask,
  renderHandledFindings,
  taskLabel,
  FINDING_TASKS_STATE_KEY,
  recordTaskOwnership,
  loadTaskOwnership,
} from "./finding-task-locality.mjs";
import { saveReviewFeedback } from "./review-feedback.mjs";

let ok = 0;
let failed = 0;

function check(name, condition, evidence) {
  if (condition) {
    console.log(`PASS ${name}`);
    ok += 1;
    return;
  }
  console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(evidence)}` : ""}`);
  failed += 1;
}

const TASK_IDS = [
  "speckit:P7:T0:a1b2c3d4e5f6",
  "speckit:P7:T1:b2c3d4e5f6a1",
  "speckit:P7:T2:c3d4e5f6a1b2",
];

const FACTS = {
  [TASK_IDS[0]]: {files: ["src/tenant/auth.ts"], summary: "auth logic"},
  [TASK_IDS[1]]: {files: ["src/tenant/dashboard.ts", "tests/unit/tenant-access.e2e-spec.test.ts"], summary: "dashboard & access test"},
  [TASK_IDS[2]]: {files: ["src/tenant/settings.ts"], summary: "settings page"},
};

// 1. Finding citing a file no mission task owns:
// Case 1a: The file WAS changed by task 1 in this phase -> goes to task 1
{
  const findings = [{location: "tests/unit/tenant-access.e2e-spec.test.ts", problem: "flaky assertion"}];
  const mapped = mapFindingsToTasks({
    findings,
    taskIds: TASK_IDS,
    factsByTask: FACTS,
    taskOwnership: {},
  });
  check("resolve: unowned cited file changed by task in phase goes to that task",
    mapped.length === 1 && mapped[0].taskIds.length === 1 && mapped[0].taskIds[0] === TASK_IDS[1],
    mapped);
}

// Case 1b: The file was NOT changed by any task in this phase -> goes to first task of phase
{
  const findings = [{location: "tests/unit/completely-unknown.spec.ts", problem: "fails"}];
  const mapped = mapFindingsToTasks({
    findings,
    taskIds: TASK_IDS,
    factsByTask: FACTS,
    taskOwnership: {},
  });
  check("resolve: unowned cited file not changed by any task goes to first task of phase",
    mapped.length === 1 && mapped[0].source === "phase" &&
    mapped[0].taskIds.length === 1 && mapped[0].taskIds[0] === TASK_IDS[0],
    mapped);
}

// 2. Explicit tasks:[] with no owner -> goes to first task
{
  const barePhase = mapFindingsToTasks({
    findings: [{tasks: [], problem: "Broad architectural violation"}],
    taskIds: TASK_IDS,
    factsByTask: FACTS,
    taskOwnership: {},
  });
  check("resolve: explicit tasks:[] with no location goes to first task",
    barePhase.length === 1 && barePhase[0].source === "phase" &&
    barePhase[0].taskIds.length === 1 && barePhase[0].taskIds[0] === TASK_IDS[0],
    barePhase);

  const unownedPhase = mapFindingsToTasks({
    findings: [{tasks: [], location: "unowned/config.yaml", problem: "bad config"}],
    taskIds: TASK_IDS,
    factsByTask: FACTS,
    taskOwnership: {},
  });
  check("resolve: explicit tasks:[] with unowned location goes to first task",
    unownedPhase.length === 1 && unownedPhase[0].source === "phase" &&
    unownedPhase[0].taskIds.length === 1 && unownedPhase[0].taskIds[0] === TASK_IDS[0],
    unownedPhase);

  const changedPhase = mapFindingsToTasks({
    findings: [{tasks: [], location: "src/tenant/dashboard.ts", problem: "component layout"}],
    taskIds: TASK_IDS,
    factsByTask: FACTS,
    taskOwnership: {},
  });
  check("resolve: explicit tasks:[] with file changed by task 1 goes to task 1",
    changedPhase.length === 1 && changedPhase[0].taskIds.length === 1 &&
    changedPhase[0].taskIds[0] === TASK_IDS[1],
    changedPhase);
}

// 3. Plain string or no location and no tasks:[] stays source "none"
{
  const plain = mapFindingsToTasks({
    findings: ["Plain string without path or tasks"],
    taskIds: TASK_IDS,
    factsByTask: FACTS,
    taskOwnership: {},
  });
  check("resolve: plain string without path stays source none",
    plain.length === 1 && plain[0].source === "none" && plain[0].taskIds.length === 0,
    plain);

  const noLoc = mapFindingsToTasks({
    findings: [{problem: "no location and no tasks"}],
    taskIds: TASK_IDS,
    factsByTask: FACTS,
    taskOwnership: {},
  });
  check("resolve: object with no location and missing tasks stays source none",
    noLoc.length === 1 && noLoc[0].source === "none" && noLoc[0].taskIds.length === 0,
    noLoc);
}

// 4. Carry decision and handled group with single unowned phase-wide finding
{
  const state = {};
  const key = "speckit-phase:6";
  const digest = "phase-7-digest";
  const findings = [{tasks: [], location: "tests/unit/tenant-access.e2e-spec.test.ts", problem: "T124 guard regression"}];

  // In this scenario, no task in factsByTask touched tenant-access:
  const FACTS_NO_TOUCH = {
    [TASK_IDS[0]]: {files: ["src/tenant/auth.ts"], summary: "auth logic"},
    [TASK_IDS[1]]: {files: ["src/tenant/dashboard.ts"], summary: "dashboard"},
    [TASK_IDS[2]]: {files: ["src/tenant/settings.ts"], summary: "settings page"},
  };

  const record = recordFindingTasks(state, key, {
    phaseTaskDigest: digest,
    findings,
    taskIds: TASK_IDS,
    factsByTask: FACTS_NO_TOUCH,
    revision: 1,
    carryAllowed: true,
    taskOwnership: {},
  });

  check("record: allMapped is true for phase-wide finding", record.allMapped === true);
  check("record: affected is exactly first task",
    JSON.stringify(record.affected) === JSON.stringify([TASK_IDS[0]]), record.affected);
  check("record: carry contains other tasks",
    Object.hasOwn(record.carry, TASK_IDS[1]) && Object.hasOwn(record.carry, TASK_IDS[2]) &&
    !Object.hasOwn(record.carry, TASK_IDS[0]));

  const progress = {implementer: {completedTaskIds: [], factsByTask: {}}};
  const c0 = carryDecision({record, taskId: TASK_IDS[0], progress, revision: 2, phaseTaskDigest: digest});
  const c1 = carryDecision({record, taskId: TASK_IDS[1], progress, revision: 2, phaseTaskDigest: digest});
  const c2 = carryDecision({record, taskId: TASK_IDS[2], progress, revision: 2, phaseTaskDigest: digest});

  check("carry: task 0 is affected and does not carry", c0.carry === false && c0.reason === "affected");
  check("carry: task 1 carries forward", c1.carry === true, c1);
  check("carry: task 2 carries forward", c2.carry === true, c2);

  // Brief findings for task 0 (the assigned owner): gets it in own
  const g0 = findingsForTask({findings: [findings[0].problem], record, taskId: TASK_IDS[0], revision: 2});
  check("brief: assigned owner task 0 gets finding in own",
    g0.own.length === 1 && g0.own[0] === findings[0].problem && g0.handled.length === 0,
    g0);

  // Brief findings for task 1 (non-owner): gets it in handled
  const g1 = findingsForTask({findings: [findings[0].problem], record, taskId: TASK_IDS[1], revision: 2});
  check("brief: non-owner task 1 gets finding in handled with T1 label",
    g1.own.length === 0 && g1.handled.length === 1 &&
    g1.handled[0].taskLabel === `T1 (${TASK_IDS[0]})`,
    g1);

  const renderedHandled = renderHandledFindings(g1.handled);
  check("brief: rendered handled text contains real task ID next to position label",
    renderedHandled.includes(`Already handled by T1 (${TASK_IDS[0]}) — do not fix it here:`),
    renderedHandled);
}

// 5. Mixed owned + unowned findings
{
  const state = {};
  const key = "standalone-phase:1";
  const digest = "standalone-p2-digest";
  const findings = [
    {tasks: ["T2"], location: "src/tenant/dashboard.ts", problem: "dashboard table layout broken"},
    {location: "tests/unit/tenant-access.e2e-spec.test.ts", problem: "T124 guard broken"},
  ];

  const FACTS_NO_TOUCH = {
    [TASK_IDS[0]]: {files: ["src/tenant/auth.ts"], summary: "auth logic"},
    [TASK_IDS[1]]: {files: ["src/tenant/dashboard.ts"], summary: "dashboard"},
    [TASK_IDS[2]]: {files: ["src/tenant/settings.ts"], summary: "settings page"},
  };

  const record = recordFindingTasks(state, key, {
    phaseTaskDigest: digest,
    findings,
    taskIds: TASK_IDS,
    factsByTask: FACTS_NO_TOUCH,
    revision: 1,
    carryAllowed: true,
    taskOwnership: {},
  });

  check("mixed: allMapped is true", record.allMapped === true);
  check("mixed: affected contains both T1 and T2",
    record.affected.length === 2 && record.affected.includes(TASK_IDS[0]) && record.affected.includes(TASK_IDS[1]),
    record.affected);
  check("mixed: unaffected T3 is in carry", !!record.carry[TASK_IDS[2]]);

  const progress = {implementer: {completedTaskIds: [], factsByTask: {}}};
  const c3 = carryDecision({record, taskId: TASK_IDS[2], progress, revision: 2, phaseTaskDigest: digest});
  check("mixed: unaffected T3 carries forward", c3.carry === true, c3);

  const g0 = findingsForTask({findings: findings.map(f => f.problem), record, taskId: TASK_IDS[0], revision: 2});
  check("mixed: T1 gets unowned finding in own, T2 finding in handled",
    g0.own.length === 1 && g0.own[0] === findings[1].problem &&
    g0.handled.length === 1 && g0.handled[0].taskLabel === `T2 (${TASK_IDS[1]})`,
    g0);

  const g1 = findingsForTask({findings: findings.map(f => f.problem), record, taskId: TASK_IDS[1], revision: 2});
  check("mixed: T2 gets declared finding in own, T1 finding in handled",
    g1.own.length === 1 && g1.own[0] === findings[0].problem &&
    g1.handled.length === 1 && g1.handled[0].taskLabel === `T1 (${TASK_IDS[0]})`,
    g1);

  const g2 = findingsForTask({findings: findings.map(f => f.problem), record, taskId: TASK_IDS[2], revision: 2});
  check("mixed: T3 gets no own findings and both in handled",
    g2.own.length === 0 && g2.handled.length === 2,
    g2);
}

// 6. Real task ID formatting in handled label: e.g. T1 (T056)
{
  const OWNED_TASK_IDS = ["T056", "T057", "T058"];
  const state = {};
  const key = "speckit-phase:7";
  const digest = "p8-digest";
  const findings = [{tasks: [], problem: "Broad spec regression"}];
  const record = recordFindingTasks(state, key, {
    phaseTaskDigest: digest,
    findings,
    taskIds: OWNED_TASK_IDS,
    factsByTask: {
      T056: {files: ["a.ts"], summary: "a"},
      T057: {files: ["b.ts"], summary: "b"},
      T058: {files: ["c.ts"], summary: "c"},
    },
    revision: 1,
    carryAllowed: true,
  });

  const g1 = findingsForTask({findings: ["Broad spec regression"], record, taskId: "T057", revision: 2});
  check("format: handled label shows T1 (T056)",
    g1.handled.length === 1 && g1.handled[0].taskLabel === "T1 (T056)",
    g1.handled);
  const text = renderHandledFindings(g1.handled);
  check("format: renderHandledFindings prints Already handled by T1 (T056)",
    text.includes("- Already handled by T1 (T056) — do not fix it here: Broad spec regression"),
    text);
}

// 7. Standalone & SpecKit parity
{
  const state = {};
  const digest = "parity-digest-b8";
  const findings = [{location: "tests/unit/tenant-access.e2e-spec.test.ts", problem: "T124 guard"}];

  saveReviewFeedback(state, "standalone-phase:0", findings);
  recordFindingTasks(state, "standalone-phase:0", {
    phaseTaskDigest: digest,
    findings,
    taskIds: TASK_IDS,
    factsByTask: FACTS,
    revision: 1,
    carryAllowed: true,
  });

  saveReviewFeedback(state, "speckit-phase:0", findings);
  recordFindingTasks(state, "speckit-phase:0", {
    phaseTaskDigest: digest,
    findings,
    taskIds: TASK_IDS,
    factsByTask: FACTS,
    revision: 1,
    carryAllowed: true,
  });

  const sRecord = loadFindingTasks(state, "standalone-phase:0", {phaseTaskDigest: digest});
  const spRecord = loadFindingTasks(state, "speckit-phase:0", {phaseTaskDigest: digest});
  delete sRecord.at;
  delete spRecord.at;
  check("parity: standalone and speckit records are identical for backlog #8",
    JSON.stringify(sRecord) === JSON.stringify(spRecord));
}

console.log(`\n${ok} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
