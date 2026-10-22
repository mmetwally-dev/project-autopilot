#!/usr/bin/env node
// Mission 094 Phase 1 task 1.1 — core report model (`scripts/watch-report.mjs`).
// Asserts the stage/phase/attempt/taskRef tree for a standalone, a speckit and
// a GSD fixture mission, plus a legacy run record (a plain `task` field, no
// `taskRef`, no events) which must not crash.
import { buildReportModel, normalizePhases, runRef } from "./watch-report.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
};

const run = (o) => ({ status: "completed", decision: null, findings: [], ...o });

// ── 1. standalone ────────────────────────────────────────────────────────
{
  const phases = [
    { number: 1, name: "Phase 1 — Reproduce and locate", done: true, tasks: [{ text: "T1.1 do a", done: true }, { text: "T1.2 do b", done: true }] },
    { number: 2, name: "Phase 2 — Narrow the fingerprint exclusion", done: false, tasks: [{ text: "T2.1 do c", done: true }, { text: "T2.2 do d", done: false }] },
    { number: 3, name: "Phase 3 — Regression test and suite green", done: false, tasks: [{ text: "T3.1 do e", done: false }] },
  ];
  const state = { mission: "021-fix-backlog-item", phase: "implementing", step: "implement", phaseIndex: 1, attempt: 2, planningDetection: { framework: "standalone" } };
  const runs = [
    run({ id: "p1", role: "planner", phase: "1", attempt: "0", taskRef: "standalone-planning-planner", planRevision: 0 }),
    run({ id: "r1", role: "plan_reviewer", phase: "1", attempt: "0", taskRef: "standalone-planning-plan_reviewer", planRevision: 0, decision: "FAIL", findings: ["TASKS 2.1: exclusion applied after git lists", "TASKS 3.2: git status clean can't pass"] }),
    run({ id: "p2", role: "planner", phase: "1", attempt: "0", taskRef: "standalone-planning-planner", planRevision: 1 }),
    run({ id: "r2", role: "plan_reviewer", phase: "1", attempt: "0", taskRef: "standalone-planning-plan_reviewer", planRevision: 1, decision: "PASS" }),
    run({ id: "i1", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", decision: null }),
    run({ id: "i2", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.2" }),
    run({ id: "c1", role: "code_reviewer", phase: "1", attempt: "1", taskRef: "T1.1 > T1.2", decision: "PASS" }),
    run({ id: "v1", role: "verifier", phase: "1", attempt: "1", taskRef: "T1.1 > T1.2", decision: "PASS" }),
    run({ id: "i3", role: "implementer", phase: "2", attempt: "1", taskRef: "T2.1" }),
    run({ id: "v2", role: "verifier", phase: "2", attempt: "1", taskRef: "T2.1 > T2.3", decision: "FAIL", findings: ["T2.3: timing fixture lacks top-level node_modules", "T2.1: pathspec excludes nothing"], carriedForwardTasks: ["T2.2"] }),
    run({ id: "i4", role: "implementer", phase: "2", attempt: "2", taskRef: "T2.1", status: "running" }),
    run({ id: "f1", role: "code_reviewer", phase: "4", attempt: "1", taskRef: null, decision: "PASS" }),
  ];
  const model = buildReportModel({ state, runs, events: [], phases });

  check("standalone: mission", model.mission === "021-fix-backlog-item", model.mission);
  check("standalone: framework", model.framework === "standalone", model.framework);
  check("standalone: stage IMPLEMENTATION", model.stage === "IMPLEMENTATION", model.stage);
  check("standalone: phase name from list", model.phaseName === "Phase 2 — Narrow the fingerprint exclusion", model.phaseName);

  check("standalone: planning rounds = 2", model.planning.rounds.length === 2, model.planning.rounds.length);
  check("standalone: planning round 1 has 2 reviewer findings", model.planning.rounds[0].findings.length === 2, model.planning.rounds[0].findings);
  check("standalone: planning round 2 revision 1", model.planning.rounds[1].revision === 1, model.planning.rounds[1].revision);
  check("standalone: planning status passed", model.planning.status === "passed", model.planning.status);

  check("standalone: 3 phases", model.phases.length === 3, model.phases.length);
  check("standalone: phase1 passed", model.phases[0].status === "passed", model.phases[0].status);
  check("standalone: phase2 in_progress", model.phases[1].status === "in_progress", model.phases[1].status);
  check("standalone: phase3 not_started", model.phases[2].status === "not_started", model.phases[2].status);

  const p2 = model.phases[1];
  check("standalone: phase2 attempts = 2", p2.attempts.length === 2, p2.attempts.length);
  check("standalone: attempt1 DENIED", p2.attempts[0].result === "DENIED", p2.attempts[0].result);
  check("standalone: attempt1 findings = 2", p2.attempts[0].findings.length === 2, p2.attempts[0].findings.length);
  check("standalone: attempt1 carriedForward T2.2", p2.attempts[0].carriedForward.includes("T2.2"), p2.attempts[0].carriedForward);
  check("standalone: attempt2 IN_PROGRESS", p2.attempts[1].result === "IN_PROGRESS", p2.attempts[1].result);
  check("standalone: attempt2 has running run",
    p2.attempts[1].runs.some((r) => r.id === "i4" && r.status === "running"), p2.attempts[1].runs.map((r) => r.id));

  const p1refs = model.phases[0].attempts[0].tasks.map((g) => g.taskRef).sort();
  check("standalone: phase1 grouped by taskRef",
    JSON.stringify(p1refs) === JSON.stringify(["T1.1", "T1.1 > T1.2", "T1.2"]), p1refs);

  check("standalone: final review passed", model.finalReview.status === "passed", model.finalReview.status);
  check("standalone: final review has 1 run", model.finalReview.runs.length === 1, model.finalReview.runs.length);
  check("standalone: final review not inside a phase",
    model.phases.every((p) => p.runs.every((r) => r.role !== "code_reviewer" || Number(r.phase) <= phases.length)),
    model.phases.map((p) => p.runs.map((r) => r.id)));
}

// ── 2. speckit ───────────────────────────────────────────────────────────
{
  const phases = [
    { number: 1, name: "Phase 1 — Foundation", done: true, tasks: [{ text: "T001 create the schema", done: true }] },
    { number: 2, name: "Phase 2 — Wiring", done: false, tasks: [{ text: "T002 wire it", done: false }] },
  ];
  const state = { mission: "010-speckit", phase: "implementing", step: "implement", phaseIndex: 0, attempt: 1, planningDetection: { framework: "speckit" } };
  const runs = [
    run({ id: "sp", role: "planner", phase: "1", taskRef: "speckit-planning-planner", planRevision: 0 }),
    run({ id: "sr", role: "plan_reviewer", phase: "1", taskRef: "speckit-planning-plan_reviewer", planRevision: 0, decision: "PASS" }),
    run({ id: "si", role: "implementer", phase: "1", attempt: "1", taskRef: "T001" }),
    run({ id: "sv", role: "verifier", phase: "1", attempt: "1", taskRef: "T001", decision: "PASS" }),
  ];
  const model = buildReportModel({ state, runs, events: [], phases });
  check("speckit: framework", model.framework === "speckit", model.framework);
  check("speckit: phase1 name", model.phases[0].name === "Phase 1 — Foundation", model.phases[0].name);
  check("speckit: phase1 passed", model.phases[0].status === "passed", model.phases[0].status);
  check("speckit: phase1 attempt task ref", model.phases[0].attempts[0].tasks[0].taskRef === "T001", model.phases[0].attempts[0].tasks[0].taskRef);
  check("speckit: phase2 not_started", model.phases[1].status === "not_started", model.phases[1].status);
  check("speckit: planning passed", model.planning.status === "passed", model.planning.status);
}

// ── 3. GSD ───────────────────────────────────────────────────────────────
{
  const phases = [
    { index: 0, name: "01-foundation" },
    { index: 1, name: "02-feature" },
  ];
  const state = { mission: "011-gsd", phase: "implementing", step: "implement", phaseIndex: 0, attempt: 1, planningDetection: { framework: "gsd" } };
  const runs = [
    run({ id: "gi", role: "implementer", phase: "1", attempt: "1", taskRef: "T1" }),
    run({ id: "gv", role: "verifier", phase: "1", attempt: "1", taskRef: "T1", decision: "PASS" }),
    run({ id: "gf", role: "code_reviewer", phase: null, attempt: "1", taskRef: null, decision: "PASS" }),
  ];
  const model = buildReportModel({ state, runs, events: [], phases });
  check("gsd: framework", model.framework === "gsd", model.framework);
  check("gsd: normalizePhases index -> 1-based", model.phases[0].number === 1 && model.phases[1].number === 2, model.phases.map((p) => p.number));
  check("gsd: phase names from dir ids", model.phases[0].name === "01-foundation" && model.phases[1].name === "02-feature", model.phases.map((p) => p.name));
  check("gsd: phase1 passed", model.phases[0].status === "passed", model.phases[0].status);
  check("gsd: phase2 not_started", model.phases[1].status === "not_started", model.phases[1].status);
  check("gsd: mission final review separated", model.finalReview.runs.length === 1 && model.finalReview.runs[0].id === "gf", model.finalReview.runs.map((r) => r.id));
}

// ── 4. legacy run record (plain `task`, no taskRef, no events) ─────────────
{
  const legacy = { role: "implementer", phase: "1", attempt: "2", task: "T006", status: "completed", decision: null };
  let model = null;
  let threw = null;
  try {
    model = buildReportModel({ state: null, runs: [legacy], events: undefined, phases: [{ number: 1, name: "Phase 1", tasks: [{ text: "x", done: true }], done: true }] });
  } catch (e) { threw = e; }
  check("legacy: does not throw", threw === null, threw && String(threw));
  check("legacy: buckets the run", model && model.phases[0].runs.length === 1, model && model.phases[0].runs.length);
  check("legacy: falls back to `task` as ref", model && model.phases[0].attempts[0].tasks[0].taskRef === "T006", model && model.phases[0].attempts[0].tasks[0].taskRef);
  check("legacy: attempt number is the budget attempt (1)", model && model.phases[0].attempts[0].number === 1, model && model.phases[0].attempts[0].number);
  check("legacy: status passed from done phase", model && model.phases[0].status === "passed", model && model.phases[0].status);

  let bare = null;
  let threw2 = null;
  try { bare = buildReportModel({ state: null, runs: [legacy] }); } catch (e) { threw2 = e; }
  check("legacy: no phases/events does not throw", threw2 === null, threw2 && String(threw2));
  check("legacy: synthesises phase 1", bare && bare.phases.length === 1 && bare.phases[0].number === 1, bare && bare.phases.map((p) => p.number));
}

// ── 5. helpers ─────────────────────────────────────────────────────────────
{
  check("runRef prefers taskRef", runRef({ taskRef: "T1.1", task: "old" }) === "T1.1");
  check("runRef falls back to task", runRef({ task: "T006" }) === "T006");
  check("runRef null when neither", runRef({}) === null);
  const np = normalizePhases([{ index: 2, name: "X" }, { number: 5, name: "Y", tasks: [{ text: "a", done: true }] }]);
  check("normalizePhases: index -> 3", np[0].number === 3, np[0].number);
  check("normalizePhases: done from tasks", np[1].done === true, np[1].done);
}

if (failures.length) { console.error(`${failures.length} model-core check(s) failed.`); process.exit(1); }
console.log("All model-core checks passed.");
