#!/usr/bin/env node
// Mission 094 Phase 1 task 1.3 — PIPELINE STATE + PLANNING STAGE renderer
// (`scripts/watch-report.mjs`). The main fixture mirrors the watcher.md
// "## Example" mission 021 so the golden fragments can be asserted verbatim;
// a speckit and a GSD fixture prove the sections render without either
// framework crashing and that planning never leaks under Phase 1.
import {
  buildReportModel,
  renderReport,
  renderPipelineState,
  renderPlanningStage,
  renderImplementationStage,
  runStatusCell,
  gateStatusText,
  formatTokens,
  formatClock,
} from "./watch-report.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
};

const run = (o) => ({ status: "completed", decision: null, findings: [], ...o });

// ── 1. the watcher.md Example (mission 021) ─────────────────────────────────
{
  const phases = [
    { number: 1, name: "Phase 1 — Reproduce and locate", done: true, tasks: [{ text: "T1.1", done: true }] },
    { number: 2, name: "Phase 2 — Narrow the fingerprint exclusion", done: false, tasks: [{ text: "T2.1", done: false }] },
    { number: 3, name: "Phase 3 — Regression test and suite green", done: false, tasks: [{ text: "T3.1", done: false }] },
  ];
  const state = {
    mission: "021-fix-backlog-item",
    phase: "implementing",
    step: "implement",
    phaseIndex: 1,
    attempt: 2,
    planningStartedAt: "2026-09-28T23:38:26+03:00",
    failureBudgets: { "verificationFailureBudget:task:T2.1": 1 },
    planningDetection: { framework: "standalone" },
  };
  const planning = [
    run({ id: "01-planner-fb10c618", role: "planner", phase: "1", attempt: "0", taskRef: "standalone-planning-planner", planRevision: 0,
      status: "completed", resolvedModel: "claude-muse-spark-1.3", duration: "00:03:03", duration_ms: 183000,
      started_at: "2026-09-28T23:38:26+03:00", snapshot: "2:23/1:10", note: "wrote PLAN.md, TASKS.md",
      usage: { priceWeighted: 67500, turns: 5, peakContext: 31400 } }),
    run({ id: "02-plan_reviewer-b0662bd2", role: "plan_reviewer", phase: "1", attempt: "0", taskRef: "standalone-planning-plan_reviewer", planRevision: 0,
      status: "interrupted", resolvedModel: "claude-opus-5", duration: null, duration_ms: null,
      started_at: "2026-09-28T23:41:33+03:00", snapshot: "-", note: "stopped: model name fix",
      usage: null }),
    run({ id: "03-plan_reviewer-2b30f8c0", role: "plan_reviewer", phase: "1", attempt: "0", taskRef: "standalone-planning-plan_reviewer", planRevision: 0,
      status: "completed", decision: "FAIL", resolvedModel: "claude-opus-5", duration: "00:03:04", duration_ms: 184000,
      started_at: "2026-09-28T23:46:54+03:00", snapshot: "2:05/1:02",
      findings: ["TASKS 2.1: exclusion applied after git lists (listing cost stays)", "TASKS 3.2: \"git status clean\" can't pass (9 pre-existing files)"],
      usage: { priceWeighted: 80200, turns: 9, peakContext: 36000 } }),
    run({ id: "04-planner-28c643db", role: "planner", phase: "1", attempt: "0", taskRef: "standalone-planning-planner", planRevision: 1,
      status: "completed", resolvedModel: "claude-muse-spark-1.3", duration: "00:03:33", duration_ms: 213000,
      started_at: "2026-09-28T23:52:03+03:00", snapshot: "2:01/1:05", note: "fixed 2 of 2 findings",
      usage: { priceWeighted: 79800, turns: 13, peakContext: 34800 } }),
    run({ id: "05-plan_reviewer-c11ca0d5", role: "plan_reviewer", phase: "1", attempt: "0", taskRef: "standalone-planning-plan_reviewer", planRevision: 1,
      status: "completed", decision: "PASS", resolvedModel: "claude-opus-5-5", duration: "00:02:41", duration_ms: 161000,
      started_at: "2026-09-28T23:57:47+03:00", snapshot: "2:06/1:00",
      usage: { priceWeighted: 42800, turns: 3, peakContext: 29100 } }),
  ];
  const impl = [
    run({ id: "06-implementer-359c6a9c", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", usage: { priceWeighted: 492900, turns: 6 } }),
    run({ id: "10-implementer-7f2a91e0", role: "implementer", phase: "2", attempt: "1", taskRef: "T2.1", usage: { priceWeighted: 800900, turns: 5 } }),
    run({ id: "10b-verifier-7f2a91e0", role: "verifier", phase: "2", attempt: "1", taskRef: "T2.1", decision: "FAIL" }),
    run({ id: "16-implementer-3ebe846e", role: "implementer", phase: "2", attempt: "2", taskRef: "T2.2" }),
  ];
  const events = [
    { type: "operator", reason: "stop", scope: "mission", at: "2026-09-29T01:30:12+03:00" },
    { type: "operator", reason: "resume", scope: "mission", at: "2026-09-29T01:34:40+03:00" },
  ];
  const policy = {
    max_plan_revisions: 8,
    failure_budgets: { implementationFailureBudget: 3, verificationFailureBudget: 3, adapterRetryBudget: 2, infrastructureRetryBudget: 2 },
    caps: {
      planner: { max_tokens: 750000 }, plan_reviewer: { max_tokens: 300000 }, implementer: { max_tokens: 500000 },
      code_reviewer: { max_tokens: 300000 }, verifier: { max_tokens: 500000 },
    },
  };
  const layout = {
    roles: { free_models: { max_turns: 25 } },
    caps: {
      planner: { max_tokens: 750000, max_turns: 40, extra_sessions: 2 },
      plan_reviewer: { max_tokens: 300000, max_turns: 30, extra_sessions: 1 },
      implementer: { max_tokens: 500000, max_turns: 45, extra_sessions: 1 },
      code_reviewer: { max_tokens: 300000, max_turns: 30, extra_sessions: 1 },
      verifier: { max_tokens: 500000, max_turns: 35, extra_sessions: 0 },
    },
    retries: {
      plan_revisions: 8, implementation: 3, verification: 3, final_review_fix_rounds: 2,
      cli_errors: 2, infrastructure: 2, no_progress_sessions: 3, extra_sessions_per_task: 1,
    },
    time_limits: { call_backstop_minutes: 90 },
  };
  const model = buildReportModel({
    state, runs: [...planning, ...impl], events, phases, policy, layout,
    now: "2026-09-29T01:48:30+03:00",
    skill: { mode: "production", path: "/mnt/c/Users/user/.agents/skills/project-autopilot", syncedAt: "2026-09-28T22:10:00+03:00" },
  });
  const report = renderReport(model, { stamp: "2026-09-29 01:48:30" });
  const has = (name, frag) => check(`example: ${name}`, report.includes(frag), frag);

  has("pipeline header", "=== 2026-09-29 01:48:30 — PIPELINE STATE ===");
  has("mission", "Mission: 021-fix-backlog-item");
  has("status", "Status:  RUNNING");
  has("stage", "Stage:   IMPLEMENTATION — Phase 2/3 \"Narrow the fingerprint exclusion\" · attempt 2 of 4");
  has("retries", "Retries: plan_revisions=1/8 · implementation=0/3 · verification=1/3 · final_review_fix_rounds=0/2 · extra_sessions_per_task=1");
  has("total", "Total:   1.56M · elapsed 02:10:04 wall (call backstop 90m) (planning 270.3K · phase 1 492.9K · phase 2 800.9K so far)");
  has("caps", "Caps:    planner 750K/40t/2s · plan_reviewer 300K/30t/1s · implementer 500K/45t/1s · code_reviewer 300K/30t/1s · verifier 500K/35t/0s (tokens/turns/sessions per session) · free-model max turns: 25");
  has("skill", "Skill:   production · /mnt/c/Users/user/.agents/skills/project-autopilot (synced 2026-09-28 22:10)");
  has("events", "Events:  STOPPED 2026-09-29 01:30:12 (ap stop) → RESUMED 2026-09-29 01:34:40 (ap run)");
  has("blank between sections", "Events:  STOPPED 2026-09-29 01:30:12 (ap stop) → RESUMED 2026-09-29 01:34:40 (ap run)\n\n=== PLANNING STAGE ===");
  has("planning result line", "=== PLANNING STAGE ===  ✓ PASSED at 2026-09-29 00:00:28 · 270.3K · 00:12:21 (2 review rounds, 1 revision of 8)");
  has("round 1", "  Round 1");
  has("round 2 revision", "  Round 2 (revision 1 of 8)");
  has("planner row", "01-planner");
  has("planner completed", "muse-spark-1.3");
  has("interrupted reviewer", "02-plan_reviewer");
  has("interrupted status", "INTERRUPTED");
  has("denied reviewer", "DENIED");
  check("example: passed planning hides findings 1", !report.includes("findings → 1. TASKS 2.1"), report);
  check("example: passed planning hides findings 2", !report.includes("2. TASKS 3.2"), report);
  has("reviewer finding count", "2 findings");
  has("pass reviewer", "APPROVED");
  has("zero findings note", "0 findings");
  has("model shortening opus-5.5", "opus-5.5");
  check("example: no raw JSON object", !/\{\s*"/.test(report), report);
  check("example: planning not under Phase 1", !/Phase 1[^\n]*planned/.test(report), report);

  // header/table alignment: the header's MODEL starts at the same column as a row's.
  const lines = report.split("\n");
  const headerLine = lines.find((l) => l.trim().startsWith("ROLE"));
  const rowLine = lines.find((l) => l.includes("01-planner"));
  check("example: header and row share MODEL column", headerLine && rowLine && headerLine.indexOf("MODEL") === rowLine.indexOf("muse-spark-1.3"), { headerLine, rowLine });

  // pipeline and planning render independently
  check("example: renderPipelineState alone", renderPipelineState(model).startsWith("=== PIPELINE STATE ==="));
  check("example: renderPlanningStage starts with the section line", renderPlanningStage(model).startsWith("=== PLANNING STAGE ==="));
  check("example: planning stage excludes pipeline", !renderPlanningStage(model).includes("PIPELINE STATE"));
}

// ── 2. speckit ──────────────────────────────────────────────────────────────
{
  const phases = [
    { number: 1, name: "Phase 1 — Foundation", done: true, tasks: [{ text: "T001", done: true }] },
    { number: 2, name: "Phase 2 — Wiring", done: false, tasks: [{ text: "T002", done: false }] },
  ];
  const state = { mission: "010-speckit", phase: "planning", step: "plan_review", phaseIndex: 0, attempt: 1, planningDetection: { framework: "speckit" } };
  const runs = [
    run({ id: "01-planner-sp01", role: "planner", phase: "1", attempt: "0", taskRef: "speckit-planning-planner", planRevision: 0,
      resolvedModel: "claude-sonnet-4-5", duration_ms: 120000, started_at: "2026-09-28T23:00:00+03:00", usage: { priceWeighted: 100000, turns: 4 } }),
    run({ id: "02-plan_reviewer-sp02", role: "plan_reviewer", phase: "1", attempt: "0", taskRef: "speckit-planning-plan_reviewer", planRevision: 0,
      decision: "PASS", resolvedModel: "claude-opus-4-5", duration_ms: 60000, started_at: "2026-09-28T23:02:00+03:00", usage: { priceWeighted: 50000, turns: 2 } }),
  ];
  const model = buildReportModel({ state, runs, events: [], phases, policy: { max_plan_revisions: 5 } });
  const report = renderReport(model, { stamp: "2026-09-29 00:10:00" });
  check("speckit: mission", report.includes("Mission: 010-speckit"), report);
  check("speckit: planning stage", report.includes("=== PLANNING STAGE ==="));
  check("speckit: planning passed", /=== PLANNING STAGE ===  ✓ PASSED/.test(report), report.split("\n")[0]);
  check("speckit: round present", report.includes("  Round 1"));
  check("speckit: reviewer pass", report.includes("APPROVED"));
  check("speckit: no raw JSON", !/\{\s*"/.test(report));
  check("speckit: skill degrades", report.includes("Skill:   unknown · skill copy location not recorded"), report);
}

// ── 3. GSD: planning not started, no crash ──────────────────────────────────
{
  const phases = [{ index: 0, name: "01-foundation" }, { index: 1, name: "02-feature" }];
  const state = { mission: "011-gsd", phase: "planning", step: "plan", phaseIndex: 0, attempt: 1, planningDetection: { framework: "gsd" } };
  const model = buildReportModel({ state, runs: [], events: [], phases, policy: {} });
  const report = renderReport(model, { stamp: "2026-09-29 00:00:00" });
  check("gsd: mission", report.includes("Mission: 011-gsd"));
  check("gsd: no planning section before it starts", !report.includes("=== PLANNING STAGE ==="), report);
  check("gsd: no not-started placeholder", !report.includes("○ NOT STARTED"), report);
  check("gsd: no rounds", !report.includes("  Round 1"));
  check("gsd: no raw JSON", !/\{\s*"/.test(report));
}

// ── 4. final review fix round: Stage line carries `fix round k of N` ────────
// The reviewer finding: buildFinalReview must count the rounds holding an
// implementer run and expose it as `finalReview.fixRoundsUsed`, so both the
// PIPELINE STATE `Stage:` line and the CURRENT RUN `stage:` line read
// `FINAL REVIEW · fix round 1 of 2` during a running fix pass. Built through
// buildReportModel (not a hand-made model) so the wiring is covered.
{
  const phases = [
    { number: 1, name: "Phase 1 — Reproduce and locate", done: true, tasks: [{ text: "T1.1", done: true }] },
    { number: 2, name: "Phase 2 — Narrow the fingerprint exclusion", done: true, tasks: [{ text: "T2.1", done: true }] },
  ];
  const state = {
    mission: "021-fix-backlog-item", phase: "final_review", step: "final_review", phaseIndex: 2, attempt: 1,
    planningDetection: { framework: "standalone" },
  };
  const runs = [
    run({ id: "20-code_reviewer-aaaaaaaa", role: "code_reviewer", status: "completed", decision: "FAIL",
      findings: ["T2.1: exclusion leak"], started_at: "2026-09-29T03:00:00+03:00", usage: { priceWeighted: 40000, turns: 3 } }),
    run({ id: "21-implementer-bbbbbbbb", role: "implementer", status: "running", taskRef: null, pid: 4242,
      started_at: "2026-09-29T03:05:00+03:00", updated_at: "2026-09-29T03:06:00+03:00", usage: { priceWeighted: 10000, turns: 2 } }),
  ];
  const policy = { final_review_fix_rounds: 2, max_plan_revisions: 8, caps: {} };
  const model = buildReportModel({ state, runs, events: [], phases, policy, now: "2026-09-29T03:06:30+03:00" });
  check("fix round: model counts one fix round", model.finalReview.fixRoundsUsed === 1, model.finalReview);
  check("fix round: stage is FINAL REVIEW", model.stage === "FINAL REVIEW", model.stage);
  const report = renderReport(model, { stamp: "2026-09-29 03:06:30" });
  check("fix round: Stage line", /^Stage:\s+FINAL REVIEW · fix round 1 of 2$/m.test(report),
    report.split("\n").find((l) => l.startsWith("Stage:")));
  check("fix round: CURRENT RUN stage line", /^stage:\s+FINAL REVIEW · fix round 1 of 2$/m.test(report),
    report.split("\n").find((l) => l.startsWith("stage:")));
}

// ── 5. terminal mission: stage/phase/attempt headers carry the mission status ─
// (backlog #5) A cancelled/stopped/escalated mission whose stage never passed
// must not keep reading `● IN PROGRESS`; the header instead names the status.
{
  const planner = (status = "interrupted") => run({
    id: "01-planner-8dc646d0", dirName: "01-planner-8dc646d0", role: "planner", phase: "1", attempt: "0",
    taskRef: "standalone-planning-planner", planRevision: 0, status, usage: { priceWeighted: 425000 },
  });
  const PH = [{ number: 1, name: "Phase 1 — Reproduce and locate", done: false, tasks: [{ text: "T1.1", done: false }] }];

  // CANCELLED + interrupted planner (mission 095): planning header is not IN PROGRESS.
  {
    const state = {
      mission: "095-home-linux-projects", phase: "cancelled", step: "cancelled",
      lastCancelled: { mission: "095-home-linux-projects", at: "2026-10-17T12:50:47+03:00", reason: "operator" },
    };
    const model = buildReportModel({ state, runs: [planner()], events: [], phases: PH, policy: {}, now: "2026-10-17T12:51:00+03:00" });
    check("cancel: mission status CANCELLED", model.status === "CANCELLED", model.status);
    check("cancel: planning status cancelled", model.planning.status === "cancelled", model.planning.status);
    const report = renderReport(model, { stamp: "2026-10-17 12:51:00" });
    const head = report.split("\n").find((l) => l.startsWith("=== PLANNING STAGE"));
    check("cancel: planning header not IN PROGRESS", head && !head.includes("IN PROGRESS"), head);
    check("cancel: planning header names CANCELLED + price", /=== PLANNING STAGE ===  ✗ CANCELLED · 425K/.test(report), head);
    check("cancel: no CURRENT RUN", !report.includes("=== CURRENT RUN ==="), report);
    check("cancel: Stage line reads done", /^Stage:\s+done$/m.test(report), report.split("\n").find((l) => l.startsWith("Stage:")));
  }

  // COMPLETED: Stage line reads done (backlog #43).
  {
    const state = { mission: "095-done", phase: "complete", step: "complete", phaseIndex: 0 };
    const model = buildReportModel({ state, runs: [], events: [], phases: PH, policy: {}, now: "2026-10-17T12:51:00+03:00" });
    check("completed: mission status COMPLETED", model.status === "COMPLETED", model.status);
    const report = renderReport(model, { stamp: "2026-10-17 12:51:00" });
    check("completed: Stage line reads done", /^Stage:\s+done$/m.test(report), report.split("\n").find((l) => l.startsWith("Stage:")));
  }

  // STOPPED (idle) + interrupted implementer: phase header is resumable, not IN PROGRESS.
  {
    const state = { mission: "095-x", phase: "idle", step: "implement", phaseIndex: 0, attempt: 1 };
    const model = buildReportModel({
      state,
      runs: [run({ id: "02-implementer-aaaa", dirName: "02-implementer-aaaa", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", status: "interrupted", usage: { priceWeighted: 12000 } })],
      events: [], phases: PH, policy: {},
    });
    check("stop: mission status STOPPED", model.status === "STOPPED", model.status);
    check("stop: phase status stopped", model.phases[0].status === "stopped", model.phases[0].status);
    const impl = renderImplementationStage(model);
    const head = impl.split("\n").find((l) => l.startsWith("  Phase 1/1"));
    check("stop: phase header not IN PROGRESS", head && !head.includes("IN PROGRESS"), head);
    check("stop: phase header names STOPPED (resumable)", /■ STOPPED · 12K \(resumable\)/.test(impl), head);
  }

  // ESCALATED: planning and final-review headers read ESCALATED.
  {
    const state = { mission: "095-x", phase: "escalated", step: "standalone_task_no_progress", planningDetection: { framework: "standalone" } };
    const model = buildReportModel({
      state,
      runs: [
        planner("completed"),
        run({ id: "09-code_reviewer-bbbb", dirName: "09-code_reviewer-bbbb", role: "code_reviewer", status: "interrupted", taskRef: null, usage: { priceWeighted: 8000 } }),
      ],
      events: [], phases: PH, policy: {},
    });
    check("escalated: mission status ESCALATED", model.status === "ESCALATED", model.status);
    const report = renderReport(model, { stamp: "2026-10-17 13:00:00" });
    check("escalated: planning header names ESCALATED", /=== PLANNING STAGE ===  ✗ ESCALATED · 425K/.test(report), report.split("\n").find((l) => l.startsWith("=== PLANNING")));
    check("escalated: final review header names ESCALATED", /=== FINAL REVIEW STAGE ===  ✗ ESCALATED · 8K/.test(report), report.split("\n").find((l) => l.startsWith("=== FINAL REVIEW")));
  }

  // A passed stage still reads PASSED even on a terminal mission.
  {
    const state = { mission: "095-x", phase: "cancelled", lastCancelled: { mission: "095-x", reason: "operator" } };
    const model = buildReportModel({
      state,
      runs: [
        run({ id: "p1", dirName: "p1", role: "planner", taskRef: "standalone-planning-planner", planRevision: 0 }),
        run({ id: "r1", dirName: "r1", role: "plan_reviewer", taskRef: "standalone-planning-plan_reviewer", planRevision: 0, decision: "PASS" }),
      ],
      events: [], phases: PH, policy: {},
    });
    check("cancel+passed: planning status passed", model.planning.status === "passed", model.planning.status);
    check("cancel+passed: planning header PASSED", renderPlanningStage(model).startsWith("=== PLANNING STAGE ===  ✓ PASSED"));
  }
}

// ── 6. helpers ──────────────────────────────────────────────────────────────
{
  check("formatTokens 270300", formatTokens(270300) === "270.3K", formatTokens(270300));
  check("formatTokens 750000", formatTokens(750000) === "750K", formatTokens(750000));
  check("formatTokens 1564100", formatTokens(1564100) === "1.56M", formatTokens(1564100));
  check("formatTokens small", formatTokens(9) === "9", formatTokens(9));
  check("formatTokens null", formatTokens(null) === "-", formatTokens(null));
  check("formatClock 7804000", formatClock(7804000) === "02:10:04", formatClock(7804000));
  check("formatClock 741000", formatClock(741000) === "00:12:21", formatClock(741000));
  check("formatClock bad", formatClock(-1) === "-", formatClock(-1));
}

// STATUS mapping (backlog #109)
{
  const s = (role, status, decision) => runStatusCell({ role, status, decision });
  for (const role of ["plan_reviewer", "code_reviewer", "verifier"]) {
    check(`status: ${role} PASS -> APPROVED`, s(role, "completed", "PASS") === "APPROVED", s(role, "completed", "PASS"));
    check(`status: ${role} FAIL -> DENIED`, s(role, "completed", "FAIL") === "DENIED", s(role, "completed", "FAIL"));
    check(`status: ${role} INCOMPLETE kept`, s(role, "completed", "INCOMPLETE") === "INCOMPLETE", s(role, "completed", "INCOMPLETE"));
    for (const st of ["failed", "killed", "interrupted", "running"]) {
      const got = s(role, st, "PASS");
      check(`status: ${role} ${st} keeps run status`, got === st.toUpperCase(), got);
    }
    check(`status: ${role} capped keeps run status`, runStatusCell({ role, status: "capped", decision: "FAIL", cap: { used: 5, limit: 4 } }) === "CAPPED (5/4)");
  }
  for (const role of ["implementer", "planner"]) {
    check(`status: ${role} -> COMPLETED`, s(role, "completed", null) === "COMPLETED", s(role, "completed", null));
    check(`status: ${role} failed`, s(role, "failed", null) === "FAILED");
  }
  check("status: gate pass", gateStatusText({ status: "completed", ok: true }) === "PASS");
  check("status: gate fail", gateStatusText({ status: "completed", ok: false }) === "FAIL");
  check("status: gate running", gateStatusText({ status: "running" }) === "RUNNING");
}


// ── 5. R1 layout: shared columns, live planning duration, attempt windows ───
{
  const phases = [
    { number: 1, name: "Phase 1 — Tasks", done: false, tasks: ["T1.1", "T1.2", "T1.3", "T1.4", "T1.5"].map((text) => ({ text, done: false })) },
    { number: 2, name: "Phase 2 — Next", done: false, tasks: [{ text: "T2.1", done: false }] },
  ];
  const state = {
    mission: "r1-layout", phase: "implementing", step: "implement", phaseIndex: 0, attempt: 5,
    failureBudgets: { implementationFailureBudget: 4 },
    planningDetection: { framework: "standalone" },
  };
  const runs = [
    run({ id: "01-planner-r1", role: "planner", taskRef: "standalone-planning-planner", status: "running",
      started_at: "2026-09-29T00:50:30+03:00", duration: "00:00:00", resolvedModel: "claude-muse-spark-1.3" }),
    run({ id: "10-implementer-r1", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1",
      started_at: "2026-09-29T01:00:00+03:00", duration: "00:01:00", resolvedModel: "claude-muse-spark-1.3" }),
    run({ id: "11-implementer-r1", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.2",
      started_at: "2026-09-29T01:01:00+03:00", duration: "00:01:00", resolvedModel: "claude-muse-spark-1.3" }),
    run({ id: "12-code_reviewer-r1", role: "code_reviewer", phase: "1", attempt: "1", taskRef: "T1.1 > T1.5",
      decision: "PASS", started_at: "2026-09-29T01:02:00+03:00", duration: "00:01:00", resolvedModel: "claude-opus-5-5" }),
    run({ id: "13-verifier-r1", role: "verifier", phase: "1", attempt: "1", taskRef: "T1.1, T1.3, T1.5",
      decision: "FAIL", started_at: "2026-09-29T01:05:00+03:00", duration: "00:01:00", resolvedModel: "claude-nemotron-3",
      findings: ["T1.1: still broken"], carriedForwardTasks: ["standalone:P1:T0:4ab4c18bb44b"] }),
    run({ id: "14-implementer-r1", role: "implementer", phase: "1", attempt: "2", taskRef: "T1.1",
      started_at: "2026-09-29T01:10:00+03:00", duration: "00:01:00", resolvedModel: "claude-muse-spark-1.3" }),
  ];
  const events = [
    { type: "operator", reason: "reset", scope: "failure-budget", key: "implementationFailureBudget:phase:1", at: "2026-09-29T01:04:00+03:00" },
    { type: "gate_start", phase: 1, at: "2026-09-29T01:04:30+03:00" },
    { type: "gate_result", phase: 1, ok: true, durationMs: 90000, at: "2026-09-29T01:06:00+03:00" },
  ];
  const policy = {
    max_plan_revisions: 8,
    failure_budgets: { implementationFailureBudget: 3, verificationFailureBudget: 3, adapterRetryBudget: 2, infrastructureRetryBudget: 2 },
  };
  const model = buildReportModel({ state, runs, events, phases, policy, now: "2026-09-29T01:00:30+03:00" });
  const planning = renderPlanningStage(model);
  const impl = renderImplementationStage(model);
  const report = renderReport(model, { stamp: "2026-09-29 01:00:30" });

  check("R1: planning running marker", planning.includes("  › 01-planner-r1"));
  check("R1: planning live DURATION", planning.includes("plan/tasks") && planning.includes("00:10:00"), planning);
  check("R1: planning TASK plan/tasks", planning.includes("plan/tasks"));
  const planningHeader = planning.split("\n").find((l) => l.trim().startsWith("ROLE"));
  const implHeader = impl.split("\n").find((l) => l.trim().startsWith("ROLE"));
  const order = "ROLE MODEL TASK STATUS TURNS CONTEXT TOKENS STARTED DURATION NOTE";
  const columns = (header) => header.trim().split(/\s+/).join(" ");
  check("R1: shared column order", columns(planningHeader) === order && columns(implHeader) === order, { planningHeader, implHeader });
  check("R1: whole-phase TASK range", impl.includes("T1.1 > T1.5"));
  check("R1: partial TASK list", impl.includes("T1.1, T1.3, T1.5"));
  check("R1: gate TASK phase range", impl.split("\n").some((l) => l.includes("GATE (orchestrator)") && l.includes("T1.1 > T1.5")), impl);
  check("R1: no PENDING row", !report.includes("PENDING"));
  check("R1: no CARRIED FORWARD row", !report.includes("CARRIED FORWARD"));
  check("R1: carried id shown as task", impl.includes("carried forward → T1.1"), impl);
  check("R1: gate STARTED is its start", impl.split("\n").some((l) => l.includes("GATE (orchestrator)") && l.includes("01:04")), impl.split("\n").filter((l) => l.includes("GATE")));
  const gateLine = impl.split("\n").find((l) => l.includes("GATE (orchestrator)"));
  const nextAttempt = impl.split("\n").find((l) => l.includes("Attempt 2"));
  check("R1: review gate stays in review attempt", impl.indexOf(gateLine) < impl.indexOf(nextAttempt), { gateLine, nextAttempt });
  check("R1: reset attempt label", report.includes("attempt 5 (limit 4, reset by operator)"), report.split("\n").find((l) => l.startsWith("Stage:")));
  check("R1: reset budget label", report.includes("implementation=4 (limit 3, reset by operator)"), report.split("\n").find((l) => l.startsWith("Retries:")));
}

// ── 6. R1 layout: a running gate is a live shared-table row ────────────────
{
  const phases = [{ number: 1, name: "Phase 1", done: false, tasks: [{ text: "T1.1", done: false }] }];
  const state = { mission: "r1-gate", phase: "implementing", step: "implement", phaseIndex: 0, attempt: 1 };
  const runs = [run({ id: "01-implementer-gate", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1",
    started_at: "2026-09-29T01:00:00+03:00", duration: "00:01:00", resolvedModel: "claude-muse-spark-1.3" })];
  const events = [{ type: "gate_start", phase: 1, at: "2026-09-29T01:05:00+03:00" }];
  const model = buildReportModel({ state, runs, events, phases, policy: {}, now: "2026-09-29T01:10:00+03:00" });
  const impl = renderImplementationStage(model);
  const gateLine = impl.split("\n").find((l) => l.includes("GATE (orchestrator)"));
  check("R1: running gate marker", gateLine && gateLine.startsWith("  › GATE (orchestrator)"), gateLine);
  check("R1: running gate live DURATION", gateLine && gateLine.includes("00:05:00"), gateLine);
}

// ── 7. R1 layout: a gate after a verifier DENIED starts the next attempt ───
{
  const phases = [{ number: 1, name: "Phase 1", done: false, tasks: [{ text: "T1.1", done: false }, { text: "T1.2", done: false }] }];
  const state = { mission: "r1-gate-window", phase: "implementing", step: "implement", phaseIndex: 0, attempt: 5 };
  const runs = [
    run({ id: "49-code_reviewer-r1", role: "code_reviewer", phase: "1", attempt: "3", taskRef: "T1.1 > T1.2",
      decision: "PASS", started_at: "2026-09-29T00:18:00+03:00", duration: "00:01:00", resolvedModel: "claude-opus-5-5" }),
    run({ id: "50-verifier-r1", role: "verifier", phase: "1", attempt: "3", taskRef: "T1.1 > T1.2",
      decision: "FAIL", started_at: "2026-09-29T00:48:00+03:00", duration: "00:01:00", resolvedModel: "claude-nemotron-3" }),
    run({ id: "51-verifier-r1", role: "verifier", phase: "1", attempt: "5", taskRef: "T1.1 > T1.2",
      status: "running", started_at: "2026-09-29T01:16:00+03:00", duration: "00:00:00", resolvedModel: "claude-nemotron-3" }),
  ];
  const events = [
    { type: "gate_start", phase: 1, at: "2026-09-29T00:23:00+03:00" },
    { type: "gate_result", phase: 1, ok: false, durationMs: 1500000, at: "2026-09-29T00:48:00+03:00" },
    { type: "gate_start", phase: 1, at: "2026-09-29T00:51:00+03:00" },
    { type: "gate_result", phase: 1, ok: true, durationMs: 1500000, at: "2026-09-29T01:16:00+03:00" },
  ];
  const model = buildReportModel({ state, runs, events, phases, policy: {}, now: "2026-09-29T01:20:00+03:00" });
  const impl = renderImplementationStage(model);
  const attempt3 = impl.indexOf("Attempt 1");
  const attempt5 = impl.indexOf("Attempt 2");
  const gates = impl.split("\n").filter((l) => l.includes("GATE (orchestrator)"));
  check("R1: two gates split across attempts", gates.length === 2
    && impl.indexOf(gates[0]) > attempt3 && impl.indexOf(gates[0]) < attempt5
    && impl.indexOf(gates[1]) > attempt5, { attempt3, attempt5, gates });
  check("R1: next-attempt gate is before its verifier", gates[1] && impl.indexOf(gates[1]) < impl.indexOf("51-verifier-r1"), impl);
}

// ── 8. Backlog #6 and #8: retries line, table columns, header, started ──────
{
  // (a) standalone + spec on shows spec_revisions=x/y first; SpecKit and standalone with standalone_spec:false don't show it
  const specState = {
    mission: "spec-test", phase: "planning", step: "planning",
    planningDetection: { framework: "standalone" },
    standaloneSpecReview: { revision: 2 },
  };
  const specLayout = {
    retries: { spec_revisions: 3, plan_revisions: 10, implementation: 4, verification: 4, final_review_fix_rounds: 2, extra_sessions_per_task: 5 },
  };
  const modelSpecOn = buildReportModel({ state: specState, runs: [], events: [], phases: [], layout: specLayout, workflow: { standalone_spec: true } });
  const reportSpecOn = renderPipelineState(modelSpecOn);
  const retriesSpecOn = reportSpecOn.split("\n").find((l) => l.startsWith("Retries:"));
  check("new: standalone + spec on shows spec_revisions=2/3 first",
    retriesSpecOn && retriesSpecOn.startsWith("Retries: spec_revisions=2/3 · plan_revisions="), retriesSpecOn);

  const modelSpeckit = buildReportModel({
    state: { ...specState, planningDetection: { framework: "speckit" } },
    runs: [], events: [], phases: [], layout: specLayout,
  });
  const retriesSpeckit = renderPipelineState(modelSpeckit).split("\n").find((l) => l.startsWith("Retries:"));
  check("new: SpecKit does not show spec_revisions",
    retriesSpeckit && !retriesSpeckit.includes("spec_revisions"), retriesSpeckit);

  const modelSpecOff = buildReportModel({
    state: specState, runs: [], events: [], phases: [], layout: specLayout,
    workflow: { standalone_spec: false },
  });
  const retriesSpecOff = renderPipelineState(modelSpecOff).split("\n").find((l) => l.startsWith("Retries:"));
  check("new: standalone with standalone_spec: false does not show spec_revisions",
    retriesSpecOff && !retriesSpecOff.includes("spec_revisions"), retriesSpecOff);

  // Task C: spec runs with planRevision 0,1,2 + approved state without revision → spec_revisions=2/3
  const runsSpecApproved = [
    run({ id: "01-planner-s0", role: "planner", taskRef: "standalone-spec-planner", planRevision: 0, started_at: "2026-09-28T10:00:00+03:00", duration: "00:01:00" }),
    run({ id: "02-planner-s1", role: "planner", taskRef: "standalone-spec-planner", planRevision: 1, started_at: "2026-09-28T10:05:00+03:00", duration: "00:01:00" }),
    run({ id: "03-planner-s2", role: "planner", taskRef: "standalone-spec-planner", planRevision: 2, started_at: "2026-09-28T10:10:00+03:00", duration: "00:01:00" }),
  ];
  const modelSpecApproved = buildReportModel({
    state: {
      mission: "spec-appr", phase: "planning", step: "planning",
      planningDetection: { framework: "standalone" },
      standaloneSpecReview: { approved: true, notes: [] },
    },
    runs: runsSpecApproved, events: [], phases: [],
    layout: { retries: { spec_revisions: 3, plan_revisions: 10 } },
  });
  const retriesSpecApproved = renderPipelineState(modelSpecApproved).split("\n").find((l) => l.startsWith("Retries:"));
  check("Task C: spec runs 0,1,2 with approved state without revision shows spec_revisions=2/3",
    retriesSpecApproved && retriesSpecApproved.includes("spec_revisions=2/3"), retriesSpecApproved);

  // Task C: standalone with no spec runs and no setting → no spec_revisions key
  const modelNoSpecNoSetting = buildReportModel({
    state: {
      mission: "no-spec", phase: "planning", step: "planning",
      planningDetection: { framework: "standalone" },
    },
    runs: [], events: [], phases: [],
    layout: { retries: { spec_revisions: 3, plan_revisions: 10 } },
  });
  const retriesNoSpecNoSetting = renderPipelineState(modelNoSpecNoSetting).split("\n").find((l) => l.startsWith("Retries:"));
  check("Task C: standalone with no spec runs and no setting omits spec_revisions key",
    retriesNoSpecNoSetting && !retriesNoSpecNoSetting.includes("spec_revisions"), retriesNoSpecNoSetting);

  // (b) adapter hidden at used 0, shown as adapter=1/3 at used 1
  const modelAdapter0 = buildReportModel({
    state: { mission: "ad-0", phase: "implementing", step: "implement", failureBudgets: {} },
    runs: [], events: [], phases: [],
    policy: { failure_budgets: { adapterRetryBudget: 3 } },
    layout: { retries: { plan_revisions: 10, implementation: 4, verification: 4 } },
  });
  const retriesAdapter0 = renderPipelineState(modelAdapter0).split("\n").find((l) => l.startsWith("Retries:"));
  check("new: adapter hidden at used 0", retriesAdapter0 && !retriesAdapter0.includes("adapter="), retriesAdapter0);

  const modelAdapter1 = buildReportModel({
    state: { mission: "ad-1", phase: "implementing", step: "implement", failureBudgets: { "adapterRetryBudget:adapter:test": 1 } },
    runs: [], events: [], phases: [],
    policy: { failure_budgets: { adapterRetryBudget: 3 } },
    layout: { retries: { plan_revisions: 10, implementation: 4, verification: 4 } },
  });
  const retriesAdapter1 = renderPipelineState(modelAdapter1).split("\n").find((l) => l.startsWith("Retries:"));
  check("new: adapter shown at used 1", retriesAdapter1 && retriesAdapter1.includes("adapter=1/3"), retriesAdapter1);

  // (c) "(N in earlier phases)" suffix appears on implementation
  const modelEarlier = buildReportModel({
    state: {
      mission: "earlier", phase: "implementing", step: "implement", phaseIndex: 1,
      failureBudgets: {
        "implementationFailureBudget:task:standalone:phase-0": 2,
        "implementationFailureBudget:task:standalone:phase-1": 1,
      },
    },
    runs: [], events: [], phases: [{ number: 1 }, { number: 2 }],
    policy: { failure_budgets: { implementationFailureBudget: 4 } },
    layout: { retries: { plan_revisions: 10, implementation: 4, verification: 4 } },
  });
  const retriesEarlier = renderPipelineState(modelEarlier).split("\n").find((l) => l.startsWith("Retries:"));
  check("new: (N in earlier phases) suffix appears on implementation",
    retriesEarlier && retriesEarlier.includes("implementation=1/4 (2 in earlier phases)"), retriesEarlier);

  // (d) no Budgets: line anywhere in the report
  const fullReport = renderReport(modelEarlier, { stamp: "2026-09-29 01:00:00" });
  check("new: no Budgets: line anywhere in report", !fullReport.includes("Budgets:"), fullReport);

  // (e) Bug 2b: spec runs at planRevision 2 + plan runs at 1 → "1 revision of 10" and spec_revisions=2/3
  const runs2b = [
    run({ id: "01-planner-s1", role: "planner", taskRef: "standalone-spec-planner", planRevision: 2, started_at: "2026-09-28T10:00:00+03:00", duration: "00:01:00" }),
    run({ id: "02-planner-p1", role: "planner", taskRef: "standalone-planning-planner", planRevision: 1, started_at: "2026-09-28T10:05:00+03:00", duration: "00:01:00" }),
  ];
  const model2b = buildReportModel({
    state: { mission: "bug2b", phase: "planning", step: "planning", planningDetection: { framework: "standalone" }, standaloneSpecReview: { revision: 2 } },
    runs: runs2b, events: [], phases: [],
    layout: { retries: { spec_revisions: 3, plan_revisions: 10 } },
  });
  const planningSection2b = renderPlanningStage(model2b);
  const retries2b = renderPipelineState(model2b).split("\n").find((l) => l.startsWith("Retries:"));
  check("new: planning header shows 1 revision of 10", planningSection2b.includes("1 revision of 10"), planningSection2b);
  check("new: retries line shows spec_revisions=2/3 and plan_revisions=1/10",
    retries2b && retries2b.includes("spec_revisions=2/3") && retries2b.includes("plan_revisions=1/10"), retries2b);

  // #8 checks:
  const runs8 = [
    run({
      id: "01-planner-fc36877f", dirName: "01-planner-fc36877f", role: "planner", phase: "1", attempt: "0",
      taskRef: "standalone-planning-planner", planRevision: 0,
      started_at: "2026-09-28T23:50:00+03:00", duration: "00:02:00",
      usage: { priceWeighted: 10000, turns: 4, peakContext: 5000 },
      snapshotBeforeStartedAt: "2026-09-28T23:49:48+03:00", snapshotBeforeAt: "2026-09-28T23:50:00+03:00",
    }),
    run({
      id: "02-plan_reviewer-b0662bd2", dirName: "02-plan_reviewer-b0662bd2", role: "plan_reviewer", phase: "1", attempt: "0",
      taskRef: "standalone-planning-plan_reviewer", planRevision: 0,
      started_at: "2026-09-29T00:10:00+03:00", duration: "00:02:00",
      usage: { priceWeighted: 15000, turns: 6, peakContext: 8000 },
      snapshotBeforeStartedAt: "2026-09-29T00:09:51+03:00", snapshotBeforeAt: "2026-09-29T00:10:00+03:00",
      note: "full re-check",
      findings: ["f1", "f2", "f3", "f4", "f5", "f6"],
      notes: ["n1", "n2", "n3", "n4", "n5"],
    }),
  ];
  const model8 = buildReportModel({
    state: {
      mission: "m-8", phase: "planning", step: "planning",
      planningStartedAt: "2026-09-28T23:50:00+03:00",
    },
    runs: runs8, events: [], phases: [], policy: {},
  });
  const rep8 = renderReport(model8, { stamp: "2026-09-29 01:00:00" });
  const lines8 = rep8.split("\n");

  check("new: top line has the full date", /^=== \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} — PIPELINE STATE ===$/.test(lines8[0]), lines8[0]);

  const missionIdx = lines8.findIndex((l) => l.startsWith("Mission:"));
  check("new: Started: line directly follows Mission:",
    missionIdx >= 0 && lines8[missionIdx + 1].startsWith("Started:"), lines8.slice(missionIdx, missionIdx + 2));
  check("new: live mission has Started: without finished",
    lines8[missionIdx + 1].includes("Started: 2026-09-28 23:50") && !lines8[missionIdx + 1].includes("finished"), lines8[missionIdx + 1]);

  const model8Done = buildReportModel({
    state: {
      mission: "m-8-done", phase: "completed", step: "completed",
      planningStartedAt: "2026-09-28T23:50:00+03:00",
    },
    runs: runs8, events: [], phases: [], policy: {},
    now: "2026-09-29T01:30:00+03:00",
  });
  const rep8Done = renderReport(model8Done, { stamp: "2026-09-29 01:30:00" });
  const startedLineDone = rep8Done.split("\n").find((l) => l.startsWith("Started:"));
  check("new: finished mission has · finished in Started: line",
    startedLineDone && startedLineDone.includes(" · finished "), startedLineDone);

  check("new: no SNAPSHOT header anywhere in report", !rep8.split("\n").some((l) => l.trim().startsWith("ROLE") && l.includes("SNAPSHOT")), rep8);

  const tableHeader = lines8.find((l) => l.trim().startsWith("ROLE"));
  const expectedHeaderWords = ["ROLE", "MODEL", "TASK", "STATUS", "TURNS", "CONTEXT", "TOKENS", "STARTED", "DURATION", "NOTE"];
  check("new: table header order exact",
    tableHeader && tableHeader.trim().split(/\s+/).join(" ") === expectedHeaderWords.join(" "), tableHeader);

  const tokensHeaderOffset = tableHeader.indexOf("TOKENS");
  const rowPlanner = lines8.find((l) => l.includes("01-planner"));
  const rowReviewer = lines8.find((l) => l.includes("02-plan_reviewer"));
  check("new: planner row TOKENS starts at header offset",
    rowPlanner && rowPlanner.indexOf("10.0K") === tokensHeaderOffset, { rowPlanner, tokensHeaderOffset });
  check("new: reviewer row TOKENS starts at header offset",
    rowReviewer && rowReviewer.indexOf("15.0K") === tokensHeaderOffset, { rowReviewer, tokensHeaderOffset });

  check("new: ROLE 01-planner without hex", rowPlanner && !rowPlanner.includes("01-planner-fc36877f"), rowPlanner);
  check("new: ROLE 02-plan_reviewer without hex", rowReviewer && !rowReviewer.includes("02-plan_reviewer-b0662bd2"), rowReviewer);

  check("new: row 1 STARTED is HH:MM (23:50)", rowPlanner && rowPlanner.includes("23:50"), rowPlanner);
  check("new: row 2 STARTED is MM-DD HH:MM on day change", rowReviewer && rowReviewer.includes("09-29 00:10"), rowReviewer);

  check("new: slow snapshot 12s in planner row NOTE", rowPlanner && rowPlanner.includes("slow snapshot 12s"), rowPlanner);
  check("new: 9s snapshot not in reviewer row NOTE", rowReviewer && !rowReviewer.includes("slow snapshot"), rowReviewer);

  check("new: plan_reviewer note with findings and minor notes",
    rowReviewer && rowReviewer.includes("full re-check · 6 findings · notes: 5 minor"), rowReviewer);
}

// ── Backlog item #9: planning-only mission that finished ───────────────────
{
  const planningRuns = [
    run({
      id: "01-planner-11111111",
      role: "planner",
      status: "completed",
      started_at: "2026-10-01T10:00:00+03:00",
      ended_at: "2026-10-01T10:05:00+03:00",
      duration_ms: 300000,
    }),
    run({
      id: "02-plan_reviewer-22222222",
      role: "plan_reviewer",
      status: "completed",
      decision: "PASS",
      started_at: "2026-10-01T10:05:00+03:00",
      ended_at: "2026-10-01T10:08:00+03:00",
      duration_ms: 180000,
    }),
  ];

  // (a) tasks_ready + command {name:"run", stopAfter:"planning"} + only planner/plan_reviewer runs + ownerAlive true
  // → Status line `STOPPED — planning done (tasks ready) · next: ap run`, Stage `PLANNING — done (tasks ready)`, Started line has ` · finished`;
  const modelA = buildReportModel({
    state: {
      mission: "m-9a",
      phase: "tasks_ready",
      step: "tasks_ready",
      command: { name: "run", stopAfter: "planning" },
      planningStartedAt: "2026-10-01T10:00:00+03:00",
    },
    runs: planningRuns,
    events: [],
    phases: [{ number: 1, name: "Phase 1", tasks: [], done: false }],
    ownerAlive: true,
  });
  const repA = renderReport(modelA);
  const linesA = repA.split("\n");
  const statusLineA = linesA.find((l) => l.startsWith("Status:"));
  const stageLineA = linesA.find((l) => l.startsWith("Stage:"));
  const startedLineA = linesA.find((l) => l.startsWith("Started:"));

  check(
    "backlog 9 (a): status line is STOPPED — planning done (tasks ready) · next: ap run",
    statusLineA === "Status:  STOPPED — planning done (tasks ready) · next: ap run",
    statusLineA
  );
  check(
    "backlog 9 (a): stage line is PLANNING — done (tasks ready)",
    stageLineA === "Stage:   PLANNING — done (tasks ready)",
    stageLineA
  );
  check(
    "backlog 9 (a): started line has · finished",
    startedLineA && startedLineA.includes(" · finished 2026-10-01 10:08"),
    startedLineA
  );

  // (b) the same with the `ap plan` command shape;
  const modelB = buildReportModel({
    state: {
      mission: "m-9b",
      phase: "tasks_ready",
      step: "tasks_ready",
      command: { name: "plan", stopAfter: "planning" },
      planningStartedAt: "2026-10-01T10:00:00+03:00",
    },
    runs: planningRuns,
    events: [],
    phases: [{ number: 1, name: "Phase 1", tasks: [], done: false }],
    ownerAlive: true,
  });
  const repB = renderReport(modelB);
  const linesB = repB.split("\n");
  const statusLineB = linesB.find((l) => l.startsWith("Status:"));
  const stageLineB = linesB.find((l) => l.startsWith("Stage:"));
  const startedLineB = linesB.find((l) => l.startsWith("Started:"));

  check(
    "backlog 9 (b): status line is STOPPED — planning done (tasks ready) · next: ap run",
    statusLineB === "Status:  STOPPED — planning done (tasks ready) · next: ap run",
    statusLineB
  );
  check(
    "backlog 9 (b): stage line is PLANNING — done (tasks ready)",
    stageLineB === "Stage:   PLANNING — done (tasks ready)",
    stageLineB
  );
  check(
    "backlog 9 (b): started line has · finished",
    startedLineB && startedLineB.includes(" · finished 2026-10-01 10:08"),
    startedLineB
  );

  // (c) tasks_ready + command {name:"run"} (no stopAfter) + orchestrator alive → unchanged (RUNNING / IMPLEMENTATION);
  const modelC = buildReportModel({
    state: {
      mission: "m-9c",
      phase: "tasks_ready",
      step: "tasks_ready",
      command: { name: "run" },
      planningStartedAt: "2026-10-01T10:00:00+03:00",
    },
    runs: planningRuns,
    events: [],
    phases: [{ number: 1, name: "Phase 1", tasks: [], done: false }],
    ownerAlive: true,
  });
  const repC = renderReport(modelC);
  const linesC = repC.split("\n");
  const statusLineC = linesC.find((l) => l.startsWith("Status:"));
  const stageLineC = linesC.find((l) => l.startsWith("Stage:"));
  const startedLineC = linesC.find((l) => l.startsWith("Started:"));

  check(
    "backlog 9 (c): status line is RUNNING",
    statusLineC === "Status:  RUNNING",
    statusLineC
  );
  check(
    "backlog 9 (c): stage line is IMPLEMENTATION",
    stageLineC && stageLineC.startsWith("Stage:   IMPLEMENTATION"),
    stageLineC
  );
  check(
    "backlog 9 (c): started line does NOT have · finished",
    startedLineC && !startedLineC.includes(" · finished"),
    startedLineC
  );

  // (d) tasks_ready + stopAfter planning but an implementer run exists → unchanged.
  const implRuns = [
    ...planningRuns,
    run({
      id: "03-implementer-33333333",
      role: "implementer",
      status: "running",
      started_at: "2026-10-01T10:08:00+03:00",
    }),
  ];
  const modelD = buildReportModel({
    state: {
      mission: "m-9d",
      phase: "tasks_ready",
      step: "tasks_ready",
      command: { name: "run", stopAfter: "planning" },
      planningStartedAt: "2026-10-01T10:00:00+03:00",
    },
    runs: implRuns,
    events: [],
    phases: [{ number: 1, name: "Phase 1", tasks: [], done: false }],
    ownerAlive: true,
  });
  const repD = renderReport(modelD);
  const linesD = repD.split("\n");
  const statusLineD = linesD.find((l) => l.startsWith("Status:"));
  const stageLineD = linesD.find((l) => l.startsWith("Stage:"));

  check(
    "backlog 9 (d): status line remains RUNNING when implementer exists",
    statusLineD === "Status:  RUNNING",
    statusLineD
  );
  check(
    "backlog 9 (d): stage line remains IMPLEMENTATION when implementer exists",
    stageLineD && stageLineD.startsWith("Stage:   IMPLEMENTATION"),
    stageLineD
  );
}

if (failures.length) { console.error(`${failures.length} render-pipeline check(s) failed.`); process.exit(1); }
console.log("All render-pipeline checks passed.");
