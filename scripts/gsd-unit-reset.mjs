// Mission 085 Phase 1 task 1.3 — GSD per-unit reset carry helpers.
//
// The per-unit failure decision runs on a deep copy (`localState` in
// runGsdPlanUnit), so a live `ap reset` it honours (disk request consumed,
// counter restarted, `lastReset` stamped) must be carried back to the outer
// state: `failureRecords` is the only channel into `executeWave`'s outer
// re-record. These two functions are the REAL production derivation and
// propagation, shared by scripts/autopilot.mjs and
// scripts/test-reset-budget-consume.mjs (case C calls them directly —
// autopilot.mjs executes main() at import and cannot be imported).
//
// - deriveGsdUnitResetRecord(): captures the applied reset (cleared budget
//   keys + `lastReset`) after the unit-side decision. Pure apart from reading
//   its arguments.
// - applyCarriedGsdReset(): re-applies the carried reset to the outer state
//   before its own `recordFailureBudget`. Deliberately performs NO queue IO:
//   the unit already consumed the disk entries, and a same-key or global
//   request queued AFTER the unit applied the first one must stay queued
//   until its own decision arrives — deleting it here would silently lose
//   the operator's reset.
export function deriveGsdUnitResetRecord({budgetsBefore, resetBefore, localState, recorded}){
  const budgetsAfter = localState.failureBudgets || {};
  const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);
  // Keys the live reset cleared inside this decision: spent before, gone after
  // (sibling budget families cleared alongside the decision key, or a global
  // reset clearing everything).
  const cleared = Object.keys(budgetsBefore).filter((k) =>
    Number(budgetsBefore[k]) > 0 && !has(budgetsAfter, k));
  // The decision key itself when its counter restarted: the reset deleted it
  // and the record below re-created it at 1, so it is present-after — the
  // changed `lastReset` stamp is what distinguishes restart from increment.
  const decisionKey = recorded?.budget?.budget ? `${recorded.budget.budget}:${recorded.scope}` : null;
  if(decisionKey && localState.lastReset !== resetBefore
    && Number(budgetsBefore[decisionKey]) > 0 && Number(budgetsAfter[decisionKey]) === 1
    && !cleared.includes(decisionKey)) cleared.push(decisionKey);
  return {failure: recorded.failure, scope: recorded.scope,
    ...(cleared.length ? {appliedResetKeys: cleared} : {}),
    ...(localState.lastReset !== resetBefore ? {lastReset: {...localState.lastReset}} : {})};
}

// Mirror of clearAllSpentCounters (scripts/autopilot.mjs): every counter the
// unit's global reset cleared must be cleared on the outer state too —
// failureBudgets alone is not enough (continuationBudgets,
// noProgressGenerations, rolloverDeadEnds, standalonePlanReview.revision and
// lastContinuation would otherwise survive while the disk request is gone).
function clearCarriedGlobalCounters(s){
  for(const k of Object.keys(s.failureBudgets || {})) delete s.failureBudgets[k];
  if(s.continuationBudgets) for(const k of Object.keys(s.continuationBudgets)) delete s.continuationBudgets[k];
  if(s.noProgressGenerations) for(const k of Object.keys(s.noProgressGenerations)) delete s.noProgressGenerations[k];
  if(s.rolloverDeadEnds) for(const k of Object.keys(s.rolloverDeadEnds)) delete s.rolloverDeadEnds[k];
  const rev = s.standalonePlanReview;
  if(rev && typeof rev === "object" && Object.prototype.hasOwnProperty.call(rev, "revision")) delete rev.revision;
  delete s.lastContinuation;
}

export function applyCarriedGsdReset(s, record){
  for(const key of record.appliedResetKeys || []){
    if(s.failureBudgets && Object.prototype.hasOwnProperty.call(s.failureBudgets, key)) delete s.failureBudgets[key];
  }
  if(record.lastReset && record.lastReset.scope === "global") clearCarriedGlobalCounters(s);
  if(record.lastReset) s.lastReset = {...record.lastReset};
}
