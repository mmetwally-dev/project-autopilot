// Pure helper to determine the target stage when resuming a mission.
// Returns "final_review" | "planning_review" | "implementation".

import { readFinalReviewFixRoundsUsed } from "./final-review-fix-rounds.mjs";

export function resumeTarget(opts = {}) {
  const { state, phaseCount, phasesComplete } = opts || {};
  if (!state || typeof state !== "object") return "planning_review";

  const fixRoundsUsed = readFinalReviewFixRoundsUsed(state);
  const finalReviewStarted = Boolean(state.finalReviewStarted);
  const phase = String(state.phase || "");
  const step = String(state.step || "");
  const hasPhaseCount = typeof phaseCount === "number" && phaseCount > 0;
  const phaseIndex = typeof state.phaseIndex === "number" ? state.phaseIndex : null;
  const allPhasesPast = hasPhaseCount && phaseIndex !== null && phaseIndex >= phaseCount;

  // 1. Mission-final review indicators:
  // - finalReviewStarted flag recorded when final review began
  // - phase is explicitly final_review
  // - final review fix rounds were used (> 0)
  // - step was raised by final review or its fix rounds
  // - all phases passed and completed
  if (finalReviewStarted || phase === "final_review" || fixRoundsUsed > 0) {
    return "final_review";
  }
  if (step === "final_review" || step === "final_review_not_converging") {
    return "final_review";
  }
  if (hasPhaseCount && allPhasesPast && phasesComplete === true) {
    return "final_review";
  }
  if (step === "relay_policy_violation" && (finalReviewStarted || fixRoundsUsed > 0 || (hasPhaseCount && allPhasesPast && phasesComplete === true))) {
    return "final_review";
  }

  // 2. Implementation indicators:
  // - mid-implementation phase / checkpoint
  // - phase is implementing or tasks_ready
  if (phase === "implementing" || phase === "tasks_ready") {
    return "implementation";
  }
  if (state.phaseExecutionCheckpoint && state.phaseExecutionCheckpoint !== "absent") {
    return "implementation";
  }
  if (state.checkpoint && (state.checkpoint.type === "phase" || state.checkpoint.type === "standalone-phase")) {
    return "implementation";
  }
  if (phaseIndex !== null && phaseIndex > 0 && phasesComplete !== true) {
    return "implementation";
  }
  if (phase === "escalated" && phaseIndex !== null && phaseIndex > 0 && step !== "existing-planning-review-failed") {
    return "implementation";
  }

  // 3. Otherwise planning review
  return "planning_review";
}
