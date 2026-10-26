// Pure plan-approval pause state for standalone and SpecKit planning.
//
// `workflow.pause_for_plan_approval: true` (runtime
// `workflow.pauseForPlanApproval`) turns the end of planning into a resumable
// pause. The state module here owns only the decision and the state fields;
// callers save/print/refresh the watch report. `ap run` on a paused mission is
// the approval and consumes the pause via `resumePlanApproval`.

export const PLAN_APPROVAL_PHASE = "plan_approval";
export const PLAN_APPROVAL_STEP = "approve_plan";

// true only for an explicit runtime `workflow.pauseForPlanApproval === true`.
// false/undefined (and a missing workflow) keep today's auto-continue.
export function planApprovalRequired(workflow) {
  return Boolean(workflow) && workflow.pauseForPlanApproval === true;
}

export function isPlanApprovalPaused(state) {
  return Boolean(state) && state.phase === PLAN_APPROVAL_PHASE;
}

// Repo-relative artifact paths, in display order. Accepts an array, a single
// string, or a `{plan, tasks, ...}` object so both loops can pass what they
// already have.
function artifactPaths(artifacts) {
  if (artifacts == null) return [];
  if (typeof artifacts === "string") return artifacts ? [artifacts] : [];
  if (Array.isArray(artifacts)) return artifacts.filter((p) => typeof p === "string" && p);
  if (typeof artifacts === "object") {
    return Object.values(artifacts).filter((p) => typeof p === "string" && p);
  }
  return [];
}

function frameworkLabel(framework) {
  if (framework === "speckit") return "SpecKit";
  if (framework === "standalone") return "Standalone";
  return framework ? String(framework) : "Planning";
}

export function planApprovalPauseLines({ framework, artifacts } = {}) {
  const paths = artifactPaths(artifacts);
  const lines = [
    `PLAN APPROVAL REQUIRED — ${frameworkLabel(framework)} planning is complete.`,
  ];
  if (paths.length) {
    lines.push("Planning artifacts:");
    for (const p of paths) lines.push(`  - ${p}`);
  }
  lines.push("Run `ap run` to approve the plan and continue — continuing counts as approval.");
  return lines;
}

// Mark the mission as waiting for plan approval and return the operator lines.
export function beginPlanApprovalPause(state, { framework, artifacts, at } = {}) {
  if (!state || typeof state !== "object") {
    throw new TypeError("beginPlanApprovalPause requires a state object");
  }
  state.phase = PLAN_APPROVAL_PHASE;
  state.step = PLAN_APPROVAL_STEP;
  state.planApproval = {
    status: "awaiting",
    framework: framework ?? null,
    artifacts: artifactPaths(artifacts),
    at: at ?? new Date().toISOString(),
  };
  return planApprovalPauseLines({ framework, artifacts });
}

// Consume a pending pause. Returns true only when the mission was paused; any
// other phase is left untouched so a genuinely new request is never mistaken
// for an approval.
export function resumePlanApproval(state) {
  if (!isPlanApprovalPaused(state)) return false;
  delete state.planApproval;
  state.phase = "tasks_ready";
  state.step = "tasks_ready";
  return true;
}
