#!/usr/bin/env node
// Mission 086 Phase 1 task 1.1 — standalone plan-revision reset helpers.
//
// The revision counter (`s.standalonePlanReview.revision`, consumed by the
// runStandalonePlanning loop in scripts/autopilot.mjs) needs its own reset
// scope: the GLOBAL form clears it alongside every other counter, but there
// was no way to clear ONLY the counter (offline) or to hand a live run one
// more revision (queued). This module owns that scope. It has no import-time
// side effects so unit tests import it directly (autopilot.mjs executes
// main() at import and cannot be imported).
//
// Queue entries carry {key, scope, mission, ...}: `mission` binds the request
// to the mission that was live when the operator armed it, so a stale request
// from an earlier mission can never fire into a later one. The key/scope
// string is deliberately colon-free, so it can never collide with a failure
// budget key (`<budget>:<scope>`), a continuation key
// (`continuationAllowance:…`) or the global key (`__global__`).
import {readResetRequests, removeResetRequest} from "./reset-request-queue.mjs";

export const PLAN_REVISION_RESET_SCOPE = "standalone-plan-revision";
export const PLAN_REVISION_RESET_KEY = "standalone-plan-revision";

// Offline clear: delete ONLY the revision counter. Findings, reviewFeedback,
// failure/continuation budgets, dead-ends, checkpoints and every other field
// are untouched by construction (only `revision` is deleted). Returns the
// cleared revision number, or null when nothing was spent.
export function clearPlanRevisionCounter(s){
  const rev = s?.standalonePlanReview;
  if(!rev || typeof rev !== "object") return null;
  if(!Object.prototype.hasOwnProperty.call(rev, "revision")) return null;
  const used = Number(rev.revision);
  delete rev.revision;
  return Number.isFinite(used) ? used : null;
}

// Build the queue entry the live path arms. `mission` (state.mission) binds
// the request; extra fields (at, requestedBy, requestedPid) are stamped by
// the caller or defaulted here.
export function planRevisionResetRequest(mission, extra = {}){
  return {key: PLAN_REVISION_RESET_KEY, scope: PLAN_REVISION_RESET_SCOPE,
    mission: mission ?? null, at: new Date().toISOString(),
    requestedBy: "ap reset", requestedPid: process.pid, ...extra};
}

function isPlanRevisionRequest(request){
  if(!request || typeof request !== "object") return false;
  return request.key === PLAN_REVISION_RESET_KEY || request.scope === PLAN_REVISION_RESET_SCOPE;
}

// Live consume: apply one queued plan-revision request to the RUNNING
// mission's state. Returns the restarted revision (0) when a request fired,
// or null when nothing was queued, nothing is spent, or the only staged
// requests belong to another mission (they stay queued — a foreign request
// must never be consumed, and an early-armed request must survive until the
// counter it targets actually matters, mirroring the failure/continuation
// zero-use guards). Only the matching entry leaves the queue; every other
// armed request stays queued.
export function applyPendingPlanRevisionReset(s, queueFile){
  let requests = null;
  try{ requests = readResetRequests(queueFile); }catch{ return null; }
  if(!Array.isArray(requests) || requests.length === 0) return null;
  const candidates = requests.filter(isPlanRevisionRequest);
  if(candidates.length === 0) return null;
  const ownMission = s?.mission ?? null;
  const usable = candidates.find((request) => {
    if(request?.mission != null && ownMission != null
      && String(request.mission) !== String(ownMission)) return false;
    return true;
  });
  if(!usable) return null;
  const rev = s?.standalonePlanReview;
  const used = Number(rev?.revision);
  if(!rev || typeof rev !== "object" || !Number.isFinite(used) || used <= 0) return null;
  clearPlanRevisionCounter(s);
  try{ removeResetRequest(queueFile, usable.key ?? PLAN_REVISION_RESET_KEY); }catch{ /* best-effort */ }
  s.lastReset = {at: new Date().toISOString(), scope: PLAN_REVISION_RESET_KEY,
    clearedUsed: used, clearedLimit: null, failure: null, role: null,
    adapter: null, appliedLive: true};
  return 0;
}
