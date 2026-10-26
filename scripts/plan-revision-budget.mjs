// Plan-revision budget resolution (backlog #100, phase 1).
//
// Pure module: no filesystem, process, or network access.
//
// A configured `max_plan_revisions` of 0 is a real limit: the first
// plan-review FAIL escalates without running a planner revision. Only an
// absent, invalid, or negative value falls back to the built-in default.
export const PLAN_REVISION_DEFAULT = 8;

export function resolvePlanRevisionBudget(policy) {
  const raw = policy?.max_plan_revisions;
  if (raw === undefined || raw === null) return PLAN_REVISION_DEFAULT;
  if (typeof raw === "boolean") return PLAN_REVISION_DEFAULT;
  if (typeof raw === "string" && raw.trim() === "") return PLAN_REVISION_DEFAULT;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : PLAN_REVISION_DEFAULT;
}
