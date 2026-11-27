#!/usr/bin/env node
// Test for Backlog #10: WATCH-REPORT NOTE displays escalation reason.
//
// Verifies:
// 1. Escalated run shows reason (failure_budget, no-progress, operator).
// 2. Normal run NOTE is unchanged.
// 3. Fallback model (RATE_LIMITED) is not mislabeled as escalation.
// 4. Run started before escalation time is not labeled as escalated.
// 5. Phase / role mismatch is not labeled as escalated.
// 6. Existing NOTE text (session label, etc.) is preserved.

import assert from "node:assert/strict";
import {
  buildReportModel,
  implementationNote,
  renderImplementationStage,
  extractEscalations,
  findMatchingEscalation,
  formatEscalationReason,
} from "./watch-report.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, extra) {
  if (condition) {
    console.log(`PASS ${name}`);
    ok += 1;
  } else {
    console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`);
    failed += 1;
  }
}

const allowance = 5; // policy continuation_allowance = 5 -> "session k of 6"
const basePolicy = { continuation_allowance: allowance };

// ── 1. Failure budget escalation shows reason and keeps existing NOTE text ──
{
  const state = {
    mission: "neutral-fixture-01",
    phaseIndex: 4, // Phase 5
    budgetEscalations: {
      "standalone:phase-4": {
        role: "implementer",
        from: "opencode/deepseek-v4.1-flash-free",
        to: "claude/sonnet",
        budget: "verificationFailureBudget",
        used: 2,
        limit: 4,
        at: "2026-11-16T10:00:00.000Z",
      },
    },
  };

  const events = [
    {
      type: "model_escalation",
      role: "implementer",
      from: "opencode/deepseek-v4.1-flash-free",
      to: "claude/sonnet",
      source: "failure_budget",
      scope: "standalone:phase-4",
      phase: 5,
      at: "2026-11-16T10:00:00.000Z",
    },
  ];

  const runs = [
    // Pre-escalation normal run
    {
      dirName: "270-implementer-aaa111",
      role: "implementer",
      phase: "5",
      taskRef: "T038",
      attempt: "1",
      sessionNumber: 1,
      model: "opencode/deepseek-v4.1-flash-free",
      status: "completed",
      started_at: "2026-11-16T09:30:00.000Z",
    },
    // Escalated run (started after escalation at 10:00)
    {
      dirName: "275-implementer-bbb222",
      role: "implementer",
      phase: "5",
      taskRef: "T039",
      attempt: "2",
      sessionNumber: 1,
      model: "claude/sonnet",
      status: "completed",
      started_at: "2026-11-16T10:05:00.000Z",
    },
  ];

  const model = buildReportModel({
    state,
    events,
    runs,
    policy: basePolicy,
    phases: [{ number: 5, name: "Phase 5", tasks: [{ ref: "T038" }, { ref: "T039" }] }],
  });

  const normalRun = model.runs[0];
  const escalatedRun = model.runs[1];

  const normalNote = implementationNote(normalRun, model);
  const escalatedNote = implementationNote(escalatedRun, model);

  check("escalation: normal run NOTE is unchanged",
    normalNote === "session 1 of 6", normalNote);
  check("escalation: normal run does not contain escalated:",
    !normalNote.includes("escalated:"), normalNote);

  check("escalation: escalated run keeps existing NOTE text (session 1 of 6)",
    escalatedNote.includes("session 1 of 6"), escalatedNote);
  check("escalation: escalated run appends escalation reason",
    escalatedNote.includes("escalated: deepseek-v4.1-flash-free → sonnet (verification budget 2/4, last 2 fix rounds)"),
    escalatedNote);
  check("escalation: rendered table row carries escalation reason in NOTE column",
    renderImplementationStage(model).includes("session 1 of 6 · escalated: deepseek-v4.1-flash-free → sonnet (verification budget 2/4, last 2 fix rounds)"));
}

// ── 2. Other escalation sources (no-progress, operator, reviewer) ──────────
{
  const events = [
    {
      type: "model_escalation",
      role: "implementer",
      from: "free-model-x",
      to: "strong-model-y",
      source: "no_progress",
      scope: "phase-1",
      phase: 1,
      consecutive: 3,
      at: "2026-11-16T11:00:00.000Z",
    },
    {
      type: "model_escalation",
      role: "planner",
      from: "cheap-model-a",
      to: "smart-model-b",
      source: "operator",
      phase: null,
      at: "2026-11-16T11:10:00.000Z",
    },
    {
      type: "model_escalation",
      role: "implementer",
      from: "base-model",
      to: "expert-model",
      source: "code_reviewer",
      scope: "phase-2",
      phase: 2,
      at: "2026-11-16T11:20:00.000Z",
    },
  ];

  const escalations = extractEscalations({ events });
  check("sources: extractEscalations parses all events", escalations.length === 3);

  const noProgReason = formatEscalationReason(escalations[0]);
  check("sources: no-progress escalation reason text",
    noProgReason === "escalated: free-model-x → strong-model-y (no progress in 3 sessions)", noProgReason);

  const opReason = formatEscalationReason(escalations[1]);
  check("sources: operator escalation reason text",
    opReason === "escalated: cheap-model-a → smart-model-b (operator)", opReason);

  const crReason = formatEscalationReason(escalations[2]);
  check("sources: code_reviewer escalation reason text",
    crReason === "escalated: base-model → expert-model (code reviewer)", crReason);
}

// ── 3. Fallback model (RATE_LIMITED) is NOT mislabeled as escalation ────────
{
  const runs = [
    {
      dirName: "10-implementer-fail",
      role: "implementer",
      phase: "1",
      taskRef: "T1",
      sessionNumber: 1,
      model: "opencode/deepseek-v4.1-flash-free",
      status: "failed",
      started_at: "2026-11-16T12:00:00.000Z",
    },
    {
      dirName: "11-implementer-fallback",
      role: "implementer",
      phase: "1",
      taskRef: "T1",
      sessionNumber: 1,
      model: "opencode/nemotron-3-ultra-free",
      status: "completed",
      started_at: "2026-11-16T12:05:00.000Z",
    },
  ];

  // No model_escalation events or budgetEscalations exist for this fallback switch
  const model = buildReportModel({
    state: { mission: "fallback-test", phaseIndex: 0 },
    events: [],
    runs,
    policy: basePolicy,
    phases: [{ number: 1, name: "Phase 1", tasks: [{ ref: "T1" }] }],
  });

  const run1Note = implementationNote(model.runs[0], model);
  const run2Note = implementationNote(model.runs[1], model);

  check("fallback: failed run has no escalation reason", !run1Note.includes("escalated:"), run1Note);
  check("fallback: fallback run has no escalation reason", !run2Note.includes("escalated:"), run2Note);
  check("fallback: fallback run keeps normal session NOTE", run2Note === "session 1 of 6", run2Note);
}

// ── 4. Role or phase mismatch does not apply escalation ─────────────────────
{
  const state = {
    mission: "mismatch-test",
    phaseIndex: 0,
    budgetEscalations: {
      "standalone:phase-0": {
        role: "implementer",
        from: "model-a",
        to: "model-b",
        budget: "implementationFailureBudget",
        used: 3,
        limit: 5,
        at: "2026-11-16T13:00:00.000Z",
      },
    },
  };

  const runs = [
    // Verifier run on phase 1 on model-b (role mismatch: escalation was for implementer)
    {
      dirName: "20-verifier-v1",
      role: "verifier",
      phase: "1",
      taskRef: "T1-T2",
      model: "model-b",
      status: "completed",
      started_at: "2026-11-16T13:05:00.000Z",
    },
    // Implementer run on phase 2 on model-b (phase mismatch: escalation was for phase 1)
    {
      dirName: "21-implementer-p2",
      role: "implementer",
      phase: "2",
      taskRef: "T3",
      sessionNumber: 1,
      model: "model-b",
      status: "completed",
      started_at: "2026-11-16T13:10:00.000Z",
    },
  ];

  const model = buildReportModel({
    state,
    events: [],
    runs,
    policy: basePolicy,
    phases: [{ number: 1, name: "Phase 1", tasks: [] }, { number: 2, name: "Phase 2", tasks: [] }],
  });

  const verifierNote = implementationNote(model.runs[0], model);
  const phase2Note = implementationNote(model.runs[1], model);

  check("mismatch: verifier does not get implementer escalation reason",
    !verifierNote.includes("escalated:"), verifierNote);
  check("mismatch: phase 2 implementer does not get phase 1 escalation reason",
    !phase2Note.includes("escalated:"), phase2Note);
}

// ── 5. Old mission: event WITHOUT budget fields → no '?/?' ─────────────────
{
  const state = {
    mission: "old-mission-fixture",
    phaseIndex: 4,
    // In older missions, state.budgetEscalations only has the latest entry (e.g. at 12:00)
    // so an older escalation at 10:00 does not match its timestamp.
    budgetEscalations: {
      "standalone:phase-4": {
        role: "implementer",
        from: "opencode/deepseek-v4.1-flash-free",
        to: "claude/sonnet",
        budget: "verificationFailureBudget",
        used: 4,
        limit: 4,
        at: "2026-11-16T12:00:00.000Z",
      },
    },
  };

  const events = [
    {
      type: "model_escalation",
      role: "implementer",
      from: "opencode/deepseek-v4.1-flash-free",
      to: "claude/sonnet",
      adapter: "anthropic",
      source: "failure_budget",
      scope: "standalone:phase-4",
      phase: 5,
      at: "2026-11-16T10:00:00.000Z",
    },
  ];

  const runs = [
    {
      dirName: "275-implementer-old",
      role: "implementer",
      phase: "5",
      taskRef: "T039",
      sessionNumber: 1,
      model: "claude/sonnet",
      status: "completed",
      started_at: "2026-11-16T10:05:00.000Z",
    },
  ];

  const model = buildReportModel({
    state,
    events,
    runs,
    policy: basePolicy,
    phases: [{ number: 5, name: "Phase 5", tasks: [{ ref: "T039" }] }],
  });

  const note = implementationNote(model.runs[0], model);
  check("old mission: never prints '?/?'", !note.includes("?/?"), note);
  check("old mission: prints friendly fallback (failure budget, last fix rounds)",
    note.includes("escalated: deepseek-v4.1-flash-free → sonnet (failure budget, last fix rounds)"),
    note);
}

// ── 6. New mission: event WITH budget fields → numbers shown ───────────────
{
  // Even if state.budgetEscalations is empty, the event carries budget/used/limit
  const state = {
    mission: "new-mission-fixture",
    phaseIndex: 4,
    budgetEscalations: {},
  };

  const events = [
    {
      type: "model_escalation",
      role: "implementer",
      from: "opencode/deepseek-v4.1-flash-free",
      to: "claude/sonnet",
      adapter: "anthropic",
      source: "failure_budget",
      scope: "standalone:phase-4",
      phase: 5,
      budget: "verificationFailureBudget",
      used: 2,
      limit: 4,
      remaining: 2,
      at: "2026-11-16T10:00:00.000Z",
    },
  ];

  const runs = [
    {
      dirName: "276-implementer-new",
      role: "implementer",
      phase: "5",
      taskRef: "T039",
      sessionNumber: 1,
      model: "claude/sonnet",
      status: "completed",
      started_at: "2026-11-16T10:05:00.000Z",
    },
  ];

  const model = buildReportModel({
    state,
    events,
    runs,
    policy: basePolicy,
    phases: [{ number: 5, name: "Phase 5", tasks: [{ ref: "T039" }] }],
  });

  const note = implementationNote(model.runs[0], model);
  check("new mission: carries numbers from event",
    note.includes("escalated: deepseek-v4.1-flash-free → sonnet (verification budget 2/4, last 2 fix rounds)"),
    note);
  check("new mission: does not print '?/?'", !note.includes("?/?"), note);
}

// ── 7. Escalation model unavailable → back to <model> in WATCH-REPORT NOTE ─
{
  const state = {
    mission: "neutral-fixture-unavailable",
    phaseIndex: 4,
    escalationUnavailable: {
      "standalone:phase-4": {
        role: "implementer",
        from: "codex/model-x",
        to: "adapter-a/model-y",
        at: "2026-11-16T10:00:00.000Z",
      },
    },
  };

  const events = [
    {
      type: "model_escalation",
      role: "implementer",
      from: "codex/model-x",
      to: "adapter-a/model-y",
      source: "escalation_unavailable",
      unavailable: true,
      scope: "standalone:phase-4",
      phase: 5,
      at: "2026-11-16T10:00:00.000Z",
    },
  ];

  const runs = [
    // Next try runs on the normal model adapter-a/model-y
    {
      dirName: "277-implementer-normal",
      role: "implementer",
      phase: "5",
      taskRef: "T039",
      sessionNumber: 1,
      model: "adapter-a/model-y",
      status: "completed",
      started_at: "2026-11-16T10:05:00.000Z",
    },
  ];

  const model = buildReportModel({
    state,
    events,
    runs,
    policy: basePolicy,
    phases: [{ number: 5, name: "Phase 5", tasks: [{ ref: "T039" }] }],
  });

  const note = implementationNote(model.runs[0], model);
  check("unavailable: run on normal model carries escalation model unavailable note",
    note.includes("escalation model unavailable → back to model-y"),
    note);
}

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
} else {
  console.log(`\nAll ${ok} watch-report escalation note checks PASSED!`);
}
