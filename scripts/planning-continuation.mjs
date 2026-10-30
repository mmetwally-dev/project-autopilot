// Mission 031 Phase 6 task 6.1: planning-continuation helper shared by the
// planner/plan_reviewer capped + voluntary paths in runStandalonePlanning.
// Thin wrapper over per-task-budget: resolves the role's
// continuationAllowance, consumes one generation on the planning scope,
// records the dead end with the trigger reason, and returns the
// continuation decision ({allowed, used, limit, scope}) — or null when a
// 'capped' trigger arrives without a cap breach (nothing to consume).
import {
  consumeContinuation,
  resolvePerRoleLimits,
  recordRolloverDeadEnd,
  readRolloverDeadEnds,
  deadEndTail,
  continuationBudgetKey,
  backstopLedgerKey,
  clearBackstopFirings,
} from "./per-task-budget.mjs";
import fs from "node:fs";
import { createHash } from "node:crypto";

export const PLANNING_CONTINUATION_TRIGGERS = ["capped", "incomplete"];

export function handlePlanningContinuation(s, roleName, relayResult, scope, policy = {}, trigger) {
  if (trigger !== "capped" && trigger !== "incomplete") {
    const err = new Error(`Invalid planning continuation trigger: ${String(trigger)} (expected 'capped' | 'incomplete')`);
    err.code = "INVALID_PLANNING_TRIGGER";
    throw err;
  }
  if (trigger === "capped" && !relayResult?.capped) return null;
  const allowance = resolvePerRoleLimits(roleName, policy).continuationAllowance;
  const cont = consumeContinuation(s, policy, scope, allowance);
  if (trigger === "capped") {
    const cap = relayResult.capped;
    recordRolloverDeadEnd(s, scope, {
      generation: cont.used,
      reason: cap.type,
      used: cap.used,
      limit: cap.limit,
      tail: deadEndTail({
        summary: `${roleName} capped (${cap.type} ${cap.used}/${cap.limit}); planning input unchanged — re-run planning.`,
        files: [],
      }),
    });
  } else {
    recordRolloverDeadEnd(s, scope, {
      generation: cont.used,
      reason: "incomplete",
      used: null,
      limit: null,
      tail: deadEndTail({
        summary: `${roleName} incomplete; planning input unchanged — re-run planning.`,
        files: [],
      }),
    });
  }
  return cont;
}

export { readRolloverDeadEnds };

// Mission 055 Phase 1 task 1.1: mission-boundary cleanup for planner
// continuation state. Planning scopes are fixed (standalone planning only);
// implementer/phase scopes and failureBudgets are never touched.
export const PLANNING_CONTINUATION_SCOPES = [
  "task:standalone:planning:planner",
  "task:standalone:planning:plan_reviewer",
  "task:speckit:planning:planner",
  "task:speckit:planning:plan_reviewer",
  "task:gsd:planning:planner",
  "task:gsd:planning:plan_reviewer",
];

// Shared spent-continuation predicate: true when the scope is a planning
// continuation scope. Reused by the mission-takeover/cancel paths (which
// must not introduce their own predicate) and by the clear helper below.
export function isPlanningContinuationScope(scope) {
  return PLANNING_CONTINUATION_SCOPES.includes(String(scope ?? ""));
}

// Shared spent-continuation predicate over state: true when any planning
// continuation state is present (any planning ledger key or a planning
// lastContinuation). Same reuse contract as isPlanningContinuationScope.
export function hasSpentPlanningContinuations(s) {
  if (!s || typeof s !== "object") return false;
  for (const scope of PLANNING_CONTINUATION_SCOPES) {
    const budgetKey = continuationBudgetKey(scope);
    if (s.continuationBudgets && typeof s.continuationBudgets === "object" && budgetKey in s.continuationBudgets) return true;
    if (s.noProgressGenerations && typeof s.noProgressGenerations === "object" && budgetKey in s.noProgressGenerations) return true;
    if (s.rolloverDeadEnds && typeof s.rolloverDeadEnds === "object" && budgetKey in s.rolloverDeadEnds) return true;
    if (s.planningProgressDigests && typeof s.planningProgressDigests === "object" && scope in s.planningProgressDigests) return true;
    const ledgerKey = backstopLedgerKey(scope);
    if (s.backstopFirings && typeof s.backstopFirings === "object" && ledgerKey in s.backstopFirings) return true;
  }
  if (s.lastContinuation && typeof s.lastContinuation === "object"
    && isPlanningContinuationScope(s.lastContinuation.scope)) return true;
  return false;
}

// Drop one planning role scope's continuation entries: the
// continuationBudgetKey(scope) entries from
// continuationBudgets/noProgressGenerations/rolloverDeadEnds, the bare-scope
// entry from planningProgressDigests, the backstopLedgerKey(scope) entry from
// backstopFirings (via the existing clearBackstopFirings), and
// lastContinuation when it names this scope. Implementer keys, failureBudgets
// and every OTHER planning scope survive. Returns the number of entries
// dropped. Called when that role finishes a run, so a new stage starts with a
// fresh continuation allowance instead of inheriting the previous stage's.
export function clearPlanningContinuationScope(s, scope) {
  if (!s || typeof s !== "object" || !isPlanningContinuationScope(scope)) return 0;
  let cleared = 0;
  const budgetKey = continuationBudgetKey(scope);
  if (s.continuationBudgets && typeof s.continuationBudgets === "object" && budgetKey in s.continuationBudgets) {
    delete s.continuationBudgets[budgetKey];
    cleared += 1;
  }
  if (s.noProgressGenerations && typeof s.noProgressGenerations === "object" && budgetKey in s.noProgressGenerations) {
    delete s.noProgressGenerations[budgetKey];
    cleared += 1;
  }
  if (s.rolloverDeadEnds && typeof s.rolloverDeadEnds === "object" && budgetKey in s.rolloverDeadEnds) {
    delete s.rolloverDeadEnds[budgetKey];
    cleared += 1;
  }
  if (s.planningProgressDigests && typeof s.planningProgressDigests === "object" && scope in s.planningProgressDigests) {
    delete s.planningProgressDigests[scope];
    cleared += 1;
  }
  if (clearBackstopFirings(s, scope)) cleared += 1;
  if (s.lastContinuation && typeof s.lastContinuation === "object"
    && s.lastContinuation.scope === scope) {
    delete s.lastContinuation;
    cleared += 1;
  }
  return cleared;
}

// Drop every planning continuation entry: the continuationBudgetKey(scope)
// entries from continuationBudgets/noProgressGenerations/rolloverDeadEnds,
// the bare-scope entries from planningProgressDigests, the
// backstopLedgerKey(scope) entries from backstopFirings (via the existing
// clearBackstopFirings), and lastContinuation when its scope is a planning
// scope. Implementer keys and failureBudgets survive. Returns the number of
// entries dropped.
export function clearPlanningContinuations(s) {
  if (!s || typeof s !== "object") return 0;
  let cleared = 0;
  for (const scope of PLANNING_CONTINUATION_SCOPES) {
    cleared += clearPlanningContinuationScope(s, scope);
  }
  return cleared;
}

// Mission 031 Phase 6 task 6b.2: role-appropriate progress signal for the
// planner no-progress stop in runStandalonePlanning. Planner generations edit
// PLAN.md/TASKS.md (never touchedFiles), so progress is a change in either
// artifact detected via file mtime + size + content hash. Returns the digest
// string for both files joined, or null when neither file is statable.
// Pure file IO; never throws.
export function planningArtifactDigest(planFile, tasksFile) {
  const parts = [];
  for (const f of [planFile, tasksFile]) {
    if (!f) continue;
    try {
      const st = fs.statSync(f);
      let hash = "";
      try {
        hash = createHash("sha1").update(fs.readFileSync(f)).digest("hex");
      } catch {
        hash = "";
      }
      parts.push(`${st.mtimeMs}:${st.size}:${hash}`);
    } catch {
      parts.push("missing");
    }
  }
  if (!parts.length || parts.every((p) => p === "missing")) return null;
  return parts.join("|");
}

// Maps the artifact digest onto the touchedFiles-shaped signal consumed by
// recordGenerationProgress via stopOnNoProgress: a generation whose digest
// changed returns a non-empty synthetic signal (resets the no-progress
// counter), an unchanged generation returns [] (counts toward the limit).
// Missing artifacts = no progress ([]). Per-scope last digest is cached on
// s.planningProgressDigests; a first sighting with existing files counts as
// progress (establishes the baseline). Pure IO except the state cache update;
// never throws.
export function planningNoProgressTouchedFiles(planFile, tasksFile, contScope, s) {
  let digest = null;
  try {
    digest = planningArtifactDigest(planFile, tasksFile);
  } catch {
    digest = null;
  }
  if (!digest) return [];
  s.planningProgressDigests =
    s.planningProgressDigests && typeof s.planningProgressDigests === "object"
      ? s.planningProgressDigests
      : {};
  const prev = s.planningProgressDigests[contScope];
  s.planningProgressDigests[contScope] = digest;
  if (typeof prev !== "string") return [`plan:${digest.slice(0, 16)}`];
  return digest !== prev ? [`plan:${prev.slice(0, 8)}->${digest.slice(0, 8)}`] : [];
}
