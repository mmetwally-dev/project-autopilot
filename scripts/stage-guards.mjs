// Mission 090 task 1.2: stage-ordering guard for `--stage planning|implement|review|verify`.
//
// Pure, testable helper: given a requested CLI stage plus the current run
// state (`state.phase`/`state.step`) and the phase-stage checkpoint object
// (stored under CHECKPOINT_STATE_KEY, or null when absent), decide whether
// the stage may run or must be refused with a reason naming the missing
// prerequisite state. No filesystem, process, or network access; no
// autopilot.mjs edits — the run dispatch (task 1.4) calls this.
//
// Explicit CLI-to-checkpoint mapping (STAGE_CHECKPOINT_MAP):
//   planning  -> no checkpoint stage: position derives from state.phase/step
//                (+ plan approval), so planning has no prerequisites.
//   implement -> implementer
//   review    -> code_reviewer
//   verify    -> verifier + mark_tasks (the verifier step of the current
//                phase including its mark_tasks tail)
import {resumeStage, isApprovalReuseStage} from "./phase-stage-checkpoint.mjs";
import {hasUsableRequest} from "./mission-naming.mjs";

// Ordered CLI stages. Exported so the dispatch and tests share one list.
export const STAGE_ORDER = Object.freeze(["planning", "implement", "review", "verify"]);

// Explicit CLI-to-checkpoint mapping. `planning` maps to null (no checkpoint
// stage); `verify` maps to two checkpoint stages (verifier + mark_tasks).
export const STAGE_CHECKPOINT_MAP = Object.freeze({
  planning: null,
  implement: "implementer",
  review: "code_reviewer",
  verify: Object.freeze(["verifier", "mark_tasks"]),
});

// Phases at or past planning completion. Mirrors the runImplementation gate
// in scripts/autopilot.mjs (~line 7993): anything other than these phases
// still routes through ensurePlanningReady(), i.e. planning is not done.
// `plan_approval` (mission 099) belongs here: the plan is WRITTEN and only
// waiting for the operator's approval, and runImplementation consumes that
// pause on entry (a plain run or `--stage implement` IS the approval). So a
// paused mission has a plan to implement; refusing the stage would leave the
// pause reachable only through `ap run --stage planning`, which must not
// approve.
const PLANNING_COMPLETE_PHASES = Object.freeze([
  "plan_approval",
  "tasks_ready",
  "implementing",
  "final_review",
  "phase_complete",
]);

// Backlog open #5 (review): terminal mission phases. A mission that reached
// one of these is finished — its state describes a completed/cancelled
// mission, NOT unstarted work for a new request, so a later non-planning
// stage must not treat it as "planning complete". `escalated` is
// deliberately NOT here: an escalated mission is paused, not finished —
// `ap run` resumes it (autopilot.mjs keeps it resumable), so its remaining
// stages run as a normal resume. `complete` was removed from
// PLANNING_COMPLETE_PHASES above for the same reason: a completed mission's
// checkpoint belongs to the old mission and must not admit
// `--stage implement <new request>` into runImplementation (mission 095:
// the old guard let a planner run on the WHOLE backlog file as a request).
export const TERMINAL_PHASES = Object.freeze(["complete", "cancelled"]);

export function isTerminalPhase(state) {
  return TERMINAL_PHASES.includes(String(state?.phase ?? ""));
}

// Pure read of run state: has planning completed (plan approved, tasks
// ready or implementation under way)? Derives only from state.phase/step —
// never from the phase checkpoint, which planning does not use.
export function isPlanningComplete(state) {
  const phase = String(state?.phase ?? "");
  if (PLANNING_COMPLETE_PHASES.includes(phase)) return true;
  return false;
}

// Backlog open #5: how the state's mission relates to the run about to
// happen. `suppliedNew` mirrors runImplementation's own new-request decision
// (hasUsableRequest + different from the stored planningRequest — the bare
// `ap run` placeholder is NOT a new request); `terminal` is the old
// mission's phase. Both mean the stage guard must evaluate the mission that
// will actually run, not the recorded one.
function requestStartsNewMission(state, request) {
  const stored = String(state?.planningRequest ?? "");
  return hasUsableRequest(request) && String(request).trim() !== stored.trim();
}

// Pure refusal check for resume-style stages given TWO views of the world:
//   state    — the recorded mission's state (phase/step/planningRequest)
//   request  — the request text THIS invocation supplies ("" when none)
// Returns a refusal reason string, or null when the prerequisites are met.
function stageRefusal(stage, {state, checkpoint, request}) {
  const phase = String(state?.phase ?? "none");
  const terminal = isTerminalPhase(state);
  const newMission = requestStartsNewMission(state, request);
  // The new-request case runs first (a supplied request is the more
  // specific mismatch, the mission-095 shape); the bare terminal case gets
  // its own message that does not pretend a request was given (open #5
  // review fix 2: no empty "planning <request>" tail).
  const newMissionReason = {
    implement: `cannot run stage 'implement' with a request: no active mission matches it (state.phase=${JSON.stringify(phase)}) — the supplied request starts a NEW mission, which has no plan yet (the planner has not run for it); run 'ap run --stage planning ${request.trim()}' first`,
    review: `cannot run stage 'review' with a request: no active mission matches it (state.phase=${JSON.stringify(phase)}) — the supplied request starts a NEW mission, which has no implemented phase (the implementer stage has not run for it); run 'ap run --stage planning ${request.trim()}' first`,
    verify: `cannot run stage 'verify' with a request: no active mission matches it (state.phase=${JSON.stringify(phase)}) — the supplied request starts a NEW mission, which has no reviewed phase (the code_reviewer stage has not passed for it); run 'ap run --stage planning ${request.trim()}' first`,
  }[stage];
  if (newMission) {
    return newMissionReason;
  }
  if (terminal) {
    // Terminal mission, bare run: the recorded mission is over, there is
    // nothing left to resume.
    return `cannot run stage '${stage}': the last mission is ${phase} — start a new one with 'ap run --stage planning ${request.trim() || "<request>"}'`;
  }

  if (stage === "implement") {
    if (isPlanningComplete(state) || checkpointResumePosition(checkpoint) !== null) {
      return null;
    }
    return `cannot run stage 'implement': planning has not completed (state.phase=${JSON.stringify(phase)} state.step=${JSON.stringify(String(state?.step ?? "none"))}); run 'ap run --stage planning' first`;
  }

  if (stage === "review") {
    const resume = checkpointResumePosition(checkpoint);
    if (resume !== null && isApprovalReuseStage(resume)) return null;
    return `cannot run stage 'review': no implemented phase (checkpoint resume position is ${JSON.stringify(resume)}; the implementer stage has not completed); run 'ap run --stage implement' first`;
  }

  // stage === "verify": prerequisite is a completed code review, i.e. the
  // checkpoint resume position is verifier or mark_tasks (the two stages
  // this CLI stage covers).
  const resume = checkpointResumePosition(checkpoint);
  if (resume === "verifier" || resume === "mark_tasks") return null;
  return `cannot run stage 'verify': code review has not completed (checkpoint resume position is ${JSON.stringify(resume)}; the code_reviewer stage has not passed); run 'ap run --stage review' first`;
}

// Does a checkpoint exist with a readable resume position?
function checkpointResumePosition(checkpoint) {
  if (checkpoint === null || checkpoint === undefined) return null;
  return resumeStage(checkpoint);
}

// Guard one stage request. Extra optional context compared to 090: the
// request text this invocation supplies (`request`) so the guard can tell a
// NEW mission apart from a resume of the recorded one.
//   request — the AUTOPILOT_SPEC-worthy request string; ""/null = bare run.
// Returns:
//   {allowed: true, stage, checkpointStage, reason: null} — stage may run.
//   {allowed: false, stage, checkpointStage, reason}      — refuse; reason
//     names the missing prerequisite state (state.phase/step for planning,
//     implementer for review, code_reviewer for verify) or the new-mission/
//     terminal-mission mismatch (open #5).
export function guardStage(stage, {state = null, checkpoint = null, request = ""} = {}) {
  if (!STAGE_ORDER.includes(stage)) {
    return {
      allowed: false, stage, checkpointStage: null,
      reason: `Usage error: --stage requires one of ${STAGE_ORDER.join("|")} (got ${stage === null || stage === undefined ? "none" : JSON.stringify(stage)}). Use: ap run --stage <${STAGE_ORDER.join("|")}> [request]`,
    };
  }
  if (stage === "planning") {
    // First stage: no prerequisites (fresh runs start here).
    return {allowed: true, stage, checkpointStage: STAGE_CHECKPOINT_MAP.planning, reason: null};
  }

  // Backlog open #5: evaluate the guard against the mission that will
  // actually run. A supplied usable request that differs from the recorded
  // planningRequest starts a NEW mission (same trim-compare decision
  // runImplementation applies at autopilot.mjs:8478); a terminal mission
  // (complete/cancelled only — escalated stays resumable) has no active
  // work to stage into. Either way, implement/review/verify have no plan
  // to run against.
  const cleanState = state ?? {};
  const refusal = stageRefusal(stage, {
    state: cleanState,
    checkpoint,
    request: String(request ?? ""),
  });
  if (refusal !== null) {
    return {allowed: false, stage, checkpointStage: STAGE_CHECKPOINT_MAP[stage], reason: refusal};
  }
  return {allowed: true, stage, checkpointStage: STAGE_CHECKPOINT_MAP[stage], reason: null};
}
