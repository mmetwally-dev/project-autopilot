#!/usr/bin/env node
// Test for Backlog #11: When the escalation model's CLI/adapter is down,
// the mission switches back to the normal implementer instead of stopping.
//
// Verifies:
// 1. markEscalationUnavailable flags budgetEscalations and clears escalationPending.
// 2. formatEscalationUnavailableLog formats "escalation model unavailable → back to <model>".
// 3. maybeSwitchFromUnavailableEscalation detects adapter/infrastructure failures on
//    escalated runs and marks the escalation model unavailable, switching back to normal.
// 4. maybeSwitchFromUnavailableEscalation ignores functional rejections (review FAIL)
//    and normal (non-escalated) runs.
// 5. enforceAttemptFailure does NOT die when adapter retry budget is exhausted on an
//    escalation model, but does die when exhausted on the normal model.
// 6. Escalation adapter failure 3× → next try uses normal model, mission does not stop.
// 7. WATCH-REPORT NOTE renders "escalation model unavailable → back to <model>".

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  scheduleEscalation,
  pendingEscalationModel,
  budgetEscalationModel,
  implementerModelFor,
  markEscalationUnavailable,
  formatEscalationUnavailableLog,
  clearBudgetEscalation,
} from "./escalation-model.mjs";
import {
  maybeSwitchFromUnavailableEscalationForTests,
  enforceAttemptFailureForTests,
} from "./autopilot.mjs";
import {
  extractEscalations,
  formatEscalationReason,
} from "./watch-report.mjs";
import { failure } from "./failure-contract.mjs";
import {
  decideTransition,
  createCheckpoint,
} from "./phase-stage-checkpoint.mjs";

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

const NORMAL_MODEL = { adapter: "mock-synth-adapter", model: "model-normal-alpha" };
const ESCALATION_MODEL = { adapter: "mock-synth-adapter", model: "model-escalated-beta" };
const FALLBACK_MODEL = { adapter: "mock-synth-adapter", model: "model-fallback-gamma" };

const syntheticConfig = {
  roles: {
    implementer: {
      adapter: NORMAL_MODEL.adapter,
      model: NORMAL_MODEL.model,
      escalation_model: ESCALATION_MODEL,
      fallbacks: [FALLBACK_MODEL],
    },
    code_reviewer: {
      adapter: NORMAL_MODEL.adapter,
      model: NORMAL_MODEL.model,
    },
  },
  policy: {
    adapterRetryBudget: 3,
  },
};

// ── 1. Unit: markEscalationUnavailable and formatEscalationUnavailableLog ──
{
  const state = {
    budgetEscalations: {
      "standalone:phase-0": {
        role: "implementer",
        from: NORMAL_MODEL,
        to: ESCALATION_MODEL,
        budget: "verificationFailureBudget",
        used: 2,
        limit: 4,
      },
    },
    escalationPending: {
      implementer: {
        scopeKey: "standalone:phase-0",
        to: ESCALATION_MODEL,
      },
    },
  };

  check("initial pending escalation returns escalation model",
    pendingEscalationModel(state, syntheticConfig, "implementer")?.model === ESCALATION_MODEL.model
  );
  check("initial budget escalation returns escalation model",
    budgetEscalationModel(state, syntheticConfig, "standalone:phase-0")?.model === ESCALATION_MODEL.model
  );
  check("implementerModelFor selects escalation model",
    implementerModelFor(state, syntheticConfig, "standalone:phase-0")?.model === ESCALATION_MODEL.model
  );

  markEscalationUnavailable(state, "implementer", "standalone:phase-0");

  check("markEscalationUnavailable marks budgetEscalation unavailable",
    state.budgetEscalations["standalone:phase-0"].unavailable === true
  );
  check("markEscalationUnavailable clears escalationPending",
    state.escalationPending === undefined
  );
  check("pendingEscalationModel returns null after unavailable mark",
    pendingEscalationModel(state, syntheticConfig, "implementer") === null
  );
  check("budgetEscalationModel returns null after unavailable mark",
    budgetEscalationModel(state, syntheticConfig, "standalone:phase-0") === null
  );
  check("implementerModelFor falls back to normal model after unavailable mark",
    implementerModelFor(state, syntheticConfig, "standalone:phase-0")?.model === NORMAL_MODEL.model
  );

  const formattedLog = formatEscalationUnavailableLog(NORMAL_MODEL);
  check("formatEscalationUnavailableLog formats correct message",
    formattedLog === `escalation model unavailable → back to ${NORMAL_MODEL.adapter}/${NORMAL_MODEL.model}`,
    formattedLog
  );
}

// ── 2. maybeSwitchFromUnavailableEscalation behavior ──
{
  // Case A: Escalated implementer fails with adapter error (PROCESS_EXIT_NONZERO)
  const stateA = {
    mission: "synthetic-mission-fixture",
    budgetEscalations: {
      "standalone:phase-1": {
        role: "implementer",
        from: NORMAL_MODEL,
        to: ESCALATION_MODEL,
        budget: "verificationFailureBudget",
        used: 2,
        limit: 4,
      },
    },
  };
  const escalatedAdapterFail = {
    role: "implementer",
    adapter: ESCALATION_MODEL.adapter,
    model: ESCALATION_MODEL.model,
    escalated: true,
    status: "failed",
    failure: failure("PROCESS_EXIT_NONZERO", "adapter", true, [{ message: "connection refused" }]),
  };

  const switchedA = maybeSwitchFromUnavailableEscalationForTests(
    stateA,
    syntheticConfig,
    "standalone:phase-1",
    escalatedAdapterFail,
    "implementer"
  );
  check("maybeSwitch switches on escalated adapter failure", switchedA === true);
  check("state records escalationUnavailable entry",
    stateA.escalationUnavailable?.["standalone:phase-1"]?.to === `${NORMAL_MODEL.adapter}/${NORMAL_MODEL.model}`
  );
  check("subsequent implementerModelFor returns normal model",
    implementerModelFor(stateA, syntheticConfig, "standalone:phase-1")?.model === NORMAL_MODEL.model
  );

  // Case B: Escalated implementer has functional rejection (review FAIL) -> do NOT switch
  const stateB = {
    mission: "synthetic-mission-fixture",
    budgetEscalations: {
      "standalone:phase-1": {
        role: "implementer",
        from: NORMAL_MODEL,
        to: ESCALATION_MODEL,
        budget: "verificationFailureBudget",
        used: 2,
        limit: 4,
      },
    },
  };
  const functionalReject = {
    role: "implementer",
    adapter: ESCALATION_MODEL.adapter,
    model: ESCALATION_MODEL.model,
    escalated: true,
    status: "completed",
    review: { verdict: "FAIL", summary: "tests failed" },
    failure: failure("IMPLEMENTATION_REJECTED", "verification", true, [{ message: "review failed" }]),
  };
  const switchedB = maybeSwitchFromUnavailableEscalationForTests(
    stateB,
    syntheticConfig,
    "standalone:phase-1",
    functionalReject,
    "implementer"
  );
  check("maybeSwitch does NOT switch on functional rejection", switchedB === false);
  check("escalation stays active after functional rejection",
    implementerModelFor(stateB, syntheticConfig, "standalone:phase-1")?.model === ESCALATION_MODEL.model
  );

  // Case C: Normal (non-escalated) run fails on adapter error -> do NOT switch
  const stateC = {
    mission: "synthetic-mission-fixture",
  };
  const normalAdapterFail = {
    role: "implementer",
    adapter: NORMAL_MODEL.adapter,
    model: NORMAL_MODEL.model,
    escalated: false,
    status: "failed",
    failure: failure("PROCESS_EXIT_NONZERO", "adapter", true, [{ message: "connection refused" }]),
  };
  const switchedC = maybeSwitchFromUnavailableEscalationForTests(
    stateC,
    syntheticConfig,
    "standalone:phase-1",
    normalAdapterFail,
    "implementer"
  );
  check("maybeSwitch does NOT switch on normal model adapter failure", switchedC === false);
  check("escalationUnavailable remains unset for normal run", stateC.escalationUnavailable === undefined);

  // Case D: Role fallback integration - switches to active fallback model if set
  const stateD = {
    mission: "synthetic-mission-fixture",
    activeRoleModels: {
      implementer: FALLBACK_MODEL,
    },
    budgetEscalations: {
      "standalone:phase-1": {
        role: "implementer",
        from: FALLBACK_MODEL,
        to: ESCALATION_MODEL,
        budget: "verificationFailureBudget",
        used: 2,
        limit: 4,
      },
    },
  };
  const switchedD = maybeSwitchFromUnavailableEscalationForTests(
    stateD,
    syntheticConfig,
    "standalone:phase-1",
    escalatedAdapterFail,
    "implementer"
  );
  check("maybeSwitch switches back to active role fallback model",
    switchedD === true &&
    stateD.escalationUnavailable?.["standalone:phase-1"]?.to === `${FALLBACK_MODEL.adapter}/${FALLBACK_MODEL.model}`
  );

  // Case E: Calling maybeSwitchFromUnavailableEscalation twice for one failure -> true then false, one watch event
  const tmpWatchDir = fs.mkdtempSync(path.join(os.tmpdir(), "backlog-11-watch-test-"));
  const eventsFile = path.join(tmpWatchDir, "watch-events.jsonl");

  const stateTwice = {
    mission: "synthetic-mission-twice",
    missionDir: tmpWatchDir,
    budgetEscalations: {
      "standalone:phase-twice": {
        role: "implementer",
        from: NORMAL_MODEL,
        to: ESCALATION_MODEL,
        budget: "verificationFailureBudget",
        used: 2,
        limit: 4,
      },
    },
  };
  const failTwice = {
    role: "implementer",
    adapter: ESCALATION_MODEL.adapter,
    model: ESCALATION_MODEL.model,
    escalated: true,
    status: "failed",
    failure: failure("PROCESS_EXIT_NONZERO", "adapter", true, [{ message: "connection refused" }]),
  };

  const firstCall = maybeSwitchFromUnavailableEscalationForTests(
    stateTwice,
    syntheticConfig,
    "standalone:phase-twice",
    failTwice,
    "implementer"
  );
  check("calling maybeSwitch first time returns true", firstCall === true);

  const secondCall = maybeSwitchFromUnavailableEscalationForTests(
    stateTwice,
    syntheticConfig,
    "standalone:phase-twice",
    failTwice,
    "implementer"
  );
  check("calling maybeSwitch second time returns false", secondCall === false);

  const eventLines = fs.existsSync(eventsFile)
    ? fs.readFileSync(eventsFile, "utf8").trim().split("\n").filter(Boolean)
    : [];
  const switchEvents = eventLines
    .map(line => JSON.parse(line))
    .filter(ev => ev.type === "model_escalation" && ev.source === "escalation_unavailable");
  check("calling maybeSwitch twice emits watch event exactly once", switchEvents.length === 1);

  fs.rmSync(tmpWatchDir, { recursive: true, force: true });
}

// ── 3. enforceAttemptFailure does NOT die when adapter retry budget exhausts on escalation model ──
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "backlog-11-test-"));
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "backlog-11-repo-"));

  // Subcase A: Normal model exhausts adapter retry budget (limit 3, used 3) -> returns escalation to die
  const stateNormal = {
    mission: "synthetic-mission-fixture",
    missionDir: tmpDir,
    projectDir: tmpRepo,
    failureBudgets: {
      [`adapterRetryBudget:adapter:${NORMAL_MODEL.adapter}:implementer`]: 2, // 2 prior failures, 3rd will hit limit
    },
  };
  const normalFailResult = {
    role: "implementer",
    adapter: NORMAL_MODEL.adapter,
    model: NORMAL_MODEL.model,
    escalated: false,
    failure: failure("PROCESS_EXIT_NONZERO", "adapter", true, [{ source: "attempt", message: "crash" }]),
  };

  const normalRecorded = enforceAttemptFailureForTests(
    syntheticConfig,
    stateNormal,
    "synthetic-scope",
    [normalFailResult],
    "mock_gate",
    { returnEscalation: true }
  );

  check("normal model attempt failure exhausts budget and triggers escalation",
    normalRecorded.budget.allowed === false && normalRecorded.escalate !== undefined
  );
  check("normal model escalation message indicates human intervention required",
    normalRecorded.escalate?.message.includes("adapter/PROCESS_EXIT_NONZERO") &&
    normalRecorded.escalate?.message.includes("human intervention required")
  );

  // Subcase B: Escalated model exhausts adapter retry budget (limit 3, used 3)
  // Guard taken once: switch performed inside guard, allowed: true returned with escalationUnavailable marker
  const stateEscalated = {
    mission: "synthetic-mission-fixture",
    missionDir: tmpDir,
    projectDir: tmpRepo,
    budgetEscalations: {
      "synthetic-scope": {
        role: "implementer",
        from: NORMAL_MODEL,
        to: ESCALATION_MODEL,
        budget: "verificationFailureBudget",
        used: 2,
        limit: 4,
      },
    },
    failureBudgets: {
      [`adapterRetryBudget:adapter:${ESCALATION_MODEL.adapter}:implementer`]: 2, // 2 prior failures, 3rd hits limit
    },
  };
  const escalatedFailResult = {
    role: "implementer",
    adapter: ESCALATION_MODEL.adapter,
    model: ESCALATION_MODEL.model,
    escalated: true,
    status: "failed",
    failure: failure("PROCESS_EXIT_NONZERO", "adapter", true, [{ source: "attempt", message: "CLI crashed" }]),
  };

  const escalatedRecorded = enforceAttemptFailureForTests(
    syntheticConfig,
    stateEscalated,
    "synthetic-scope",
    [escalatedFailResult],
    "mock_gate",
    { returnEscalation: true }
  );

  check("guard taken once: enforceAttemptFailure does NOT escalate on exhausted adapter budget for escalated model",
    escalatedRecorded.escalate === undefined
  );
  check("guard taken once: enforceAttemptFailure returns copy with budget.allowed: true and escalationUnavailable marker",
    escalatedRecorded.budget.allowed === true && escalatedRecorded.budget.escalationUnavailable === true
  );
  check("guard taken once: stored budget counter in state is still 3 (exhausted)",
    stateEscalated.failureBudgets[`adapterRetryBudget:adapter:${ESCALATION_MODEL.adapter}:implementer`] === 3
  );
  check("guard taken once: escalation marked unavailable in state",
    stateEscalated.escalationUnavailable?.["synthetic-scope"] !== undefined &&
    stateEscalated.budgetEscalations["synthetic-scope"].unavailable === true
  );
  check("guard taken once: pendingEscalationModel returns null for that scope",
    pendingEscalationModel(stateEscalated, syntheticConfig, "implementer") === null
  );
  check("guard taken once: budgetEscalationModel returns null for that scope",
    budgetEscalationModel(stateEscalated, syntheticConfig, "synthetic-scope") === null
  );

  // Pass through decideTransition with a real checkpoint
  const realCheckpoint = createCheckpoint({
    framework: "standalone",
    mission: "synthetic-mission-fixture",
    phaseIndex: 0,
    phaseNumber: 1,
    phaseName: "Phase 1",
    tasks: ["task 1"],
    repoRoot: tmpRepo,
    baselineKey: "synthetic-baseline",
    at: new Date().toISOString(),
  });
  realCheckpoint.runningStage = "implementer";

  const transition = decideTransition(realCheckpoint, escalatedRecorded);
  check("decideTransition gives ok: true for escalated adapter exhaustion", transition.ok === true);
  check("decideTransition gives action retry", transition.action === "retry");
  check("decideTransition gives nextStage implementer", transition.nextStage === "implementer");

  // Calling maybeSwitchFromUnavailableEscalation again (as existing call sites do) returns false and does not double-switch
  const secondSwitchCall = maybeSwitchFromUnavailableEscalationForTests(
    stateEscalated,
    syntheticConfig,
    "synthetic-scope",
    escalatedFailResult,
    "implementer"
  );
  check("subsequent maybeSwitch call at call site returns false because already marked", secondSwitchCall === false);

  // Subcase C: Same scope, exhausted again (now on the normal model or with escalation already unavailable)
  // enforceAttemptFailure MUST escalate (returnEscalation set), never a second allowed copy!
  stateEscalated.failureBudgets[`adapterRetryBudget:adapter:${NORMAL_MODEL.adapter}:implementer`] = 2; // 3rd will hit limit
  const secondExhaustResult = {
    role: "implementer",
    adapter: NORMAL_MODEL.adapter,
    model: NORMAL_MODEL.model,
    escalated: false,
    status: "failed",
    failure: failure("PROCESS_EXIT_NONZERO", "adapter", true, [{ source: "attempt", message: "normal CLI crashed" }]),
  };

  const secondExhaustRecorded = enforceAttemptFailureForTests(
    syntheticConfig,
    stateEscalated,
    "synthetic-scope",
    [secondExhaustResult],
    "mock_gate",
    { returnEscalation: true }
  );

  check("same scope exhausted again: enforceAttemptFailure escalates (never a second allowed copy)",
    secondExhaustRecorded.escalate !== undefined && secondExhaustRecorded.budget.allowed === false
  );
  check("same scope exhausted again: escalation message indicates human intervention required",
    secondExhaustRecorded.escalate?.message.includes("human intervention required")
  );

  // Also verify that passing normal model exhausted failure to decideTransition fails
  const normalTransition = decideTransition(realCheckpoint, normalRecorded);
  check("decideTransition for normal model budget exhausted gives ok: false",
    normalTransition.ok === false && normalTransition.code === "ADAPTERRETRYBUDGET_EXHAUSTED"
  );

  // Clean up tmp dirs
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(tmpRepo, { recursive: true, force: true });
}

// ── 4. Full sequence simulation: Escalation adapter fails 3x -> next try uses normal model ──
{
  const taskScope = "standalone:phase-3";
  const state = {
    mission: "synthetic-mission-sequence",
    budgetEscalations: {
      [taskScope]: {
        role: "implementer",
        from: NORMAL_MODEL,
        to: ESCALATION_MODEL,
        budget: "verificationFailureBudget",
        used: 2,
        limit: 4,
      },
    },
    failureBudgets: {},
  };

  // Try 1: Escalation model selected
  const model1 = implementerModelFor(state, syntheticConfig, taskScope);
  check("Try 1 selects escalation model", model1.model === ESCALATION_MODEL.model);
  const fail1 = {
    role: "implementer",
    adapter: model1.adapter,
    model: model1.model,
    escalated: true,
    status: "failed",
    failure: failure("PROCESS_EXIT_NONZERO", "adapter", true, [{ message: "adapter outage" }]),
  };
  // Simulate attempt recording and switch check
  maybeSwitchFromUnavailableEscalationForTests(state, syntheticConfig, taskScope, fail1, "implementer");
  // Escalation is marked unavailable immediately on adapter/infra failure
  check("Escalation marked unavailable after adapter failure",
    state.budgetEscalations[taskScope].unavailable === true
  );

  // Try 2 (next try of fix round): Model resolution reverts to normal implementer!
  const model2 = implementerModelFor(state, syntheticConfig, taskScope);
  check("Try 2 reverts to normal model", model2.model === NORMAL_MODEL.model);
  check("Mission did not stop and can proceed with normal model",
    model2.adapter === NORMAL_MODEL.adapter && model2.model === NORMAL_MODEL.model
  );
}

// ── 5. WATCH-REPORT NOTE renders "escalation model unavailable → back to <model>" ──
{
  const state = {
    mission: "synthetic-mission-watch",
    escalationUnavailable: {
      "standalone:phase-0": {
        role: "implementer",
        from: "mock-synth-adapter/model-escalated-beta",
        to: "mock-synth-adapter/model-normal-alpha",
        at: "2026-11-17T00:00:00.000Z",
      },
    },
  };

  const escalations = extractEscalations({ state, events: [] });
  check("extractEscalations extracts unavailable escalation", escalations.length === 1);
  check("extracted escalation has unavailable flag",
    escalations[0]?.unavailable === true && escalations[0]?.source === "escalation_unavailable"
  );

  const formattedReason = formatEscalationReason(escalations[0]);
  check("formatEscalationReason formats unavailable note correctly",
    formattedReason === "escalation model unavailable → back to model-normal-alpha",
    formattedReason
  );
}

// ── Summary ──
console.log("");
if (failed > 0) {
  console.error(`${failed} checks failed, ${ok} passed.`);
  process.exit(1);
} else {
  console.log(`All ${ok} checks passed.`);
  process.exit(0);
}
