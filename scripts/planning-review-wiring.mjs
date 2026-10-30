// Planning-review attempt wiring — extracted from scripts/autopilot.mjs.
//
// Owns `resolvePlanningReviewAttempt` plus its FULL transitive local
// dependencies (`recordAttemptFailure`, `failureBudgetScope`,
// `applyPendingBudgetReset`, `retryDelay`, and the passthrough set re-derived
// from `PLANNING_REVIEW_PASSTHROUGH_CLASSES`). The already-imported pure
// contracts (`decidePlanningReview`, `decideEscalationName`,
// `selectAttemptFailure`, `failure`, `recordFailureBudget`) are re-imported,
// never re-implemented.
//
// All filesystem/config/state access arrives as explicit injected accessors
// on the options object (`saveState`, `readResetRequests`,
// `consumeResetRequest`, `getConfiguredBudget`, `now`) alongside the `fatal`
// callback that replaces the local `die()`. This module never closes over
// `repo`, `statePath`, `cfg()`/`cfgPath`, or the reset-request file, never
// touches `fs`/`path` itself, has no import-time side effects, and never
// calls `process.exit` (dying paths go through the injected `fatal`).
import {decidePlanningReview, PLANNING_REVIEW_PASSTHROUGH_CLASSES} from "./planning-review-decision.mjs";
import {decideEscalationName} from "./escalation-naming.mjs";
import {failure, selectAttemptFailure, recordFailureBudget} from "./failure-contract.mjs";

// Re-derived from the already-imported task 1 decision set — never a
// duplicated list, so the pre-record skip below cannot drift from it.
const PLANNING_REVIEW_PASSTHROUGH_SET=new Set(PLANNING_REVIEW_PASSTHROUGH_CLASSES);

function failureBudgetScope(observedFailure,taskScope,sourceResult){
  if(observedFailure.domain==="adapter") return `adapter:${sourceResult?.adapter||"unknown"}:${sourceResult?.role||"unknown"}`;
  if(observedFailure.domain==="infrastructure") return "mission";
  return `task:${taskScope}`;
}

// The live-reset side channel, honouring staged `ap reset` requests HERE at
// the one decision point every role's failure passes through, for the scope
// about to be recorded — so the counter starts from zero and the mission
// retries instead of escalating. All IO arrives via `io`:
// - `io.readResetRequests()` replaces the
//   `readResetRequests(pendingResetPath())` read: the WHOLE queue
//   (scripts/reset-request-queue.mjs, `{requests:[…]}`-backed with legacy
//   single-object normalization). Throwing/absent means "nothing armed",
//   exactly like the caught read failure before extraction.
// - `io.getConfiguredBudget(name)` replaces the `cfg()` lookup (config
//   migration + validation live behind that callback in the caller);
// - `io.now()` replaces the local `now()`;
// - `io.consumeResetRequest(key)` replaces the per-key
//   `removeResetRequest(pendingResetPath(),key)` removal (best-effort,
//   exactly as before; the queue file disappears only with its last entry).
function applyPendingBudgetReset(s,scope,io){
  // The WHOLE queue, not one request: many budget keys share one scope (every
  // infrastructure key uses `mission`; implementationFailureBudget and
  // verificationFailureBudget both use `task:<taskScope>`), so a single entry
  // per file would silently drop the operator's other armed resets.
  let requests=null;
  try{ requests=io.readResetRequests(); }catch{ return false; }
  if(!Array.isArray(requests)||requests.length===0) return false;
  let applied=0;
  for(const request of requests){
    // Match the BUDGET KEY and the scope of the decision about to be recorded:
    // `failureBudgets` is keyed `<budgetName>:<scope>` (e.g.
    // `infrastructureRetryBudget:mission`), while the scope alone is just
    // `mission`. `ap reset` writes both, taken from the recorded failure's own
    // `budget` + `scope`. A request for another scope (or another budget family
    // under a shared scope) stays queued until its own decision arrives.
    if(!request||request.scope!==scope) continue;
    const key=request.key;
    if(!key||!String(key).endsWith(`:${scope}`)) continue;
    const used=s.failureBudgets?.[key];
    // Nothing recorded yet → keep the request QUEUED rather than consuming it.
    // Otherwise an operator who arms a reset before the first failure would have it
    // spent on a counter that is already zero, doing nothing — and it would be gone
    // by the time the count actually mattered.
    if(!Number.isFinite(Number(used))||Number(used)<=0) continue;
    // The limit, for the LIVE path: `recordFailureBudget` has not run yet, so read it
    // the same way that function does — the budget name is the key's first segment
    // and the configured value wins over the built-in default. Unreadable config
    // renders as "?" rather than inventing a number.
    let limit=null;
    try{
      const name=String(key).split(":")[0];
      const raw=io.getConfiguredBudget(name);
      const configured=(raw===undefined||raw===null||typeof raw==="boolean"||(typeof raw==="string"&&raw.trim()===""))?null:Number(raw);
      if(Number.isInteger(configured)&&configured>=0) limit=configured;
    }catch{ /* leave as "?" */ }
    delete s.failureBudgets[key];
    const f=s.lastFailure||null;
    s.lastReset={at:io.now(),scope:key,clearedUsed:used,clearedLimit:limit,
      failure:f?`${f.class}/${f.domain}`:null,role:f?.sourceRole||null,adapter:f?.adapter||null,appliedLive:true};
    // Only THIS key leaves the queue; every other queued request stays armed.
    // The file itself disappears only when this was its last entry.
    try{ io.consumeResetRequest(key); }catch{ /* best-effort */ }
    console.log(`[autopilot] live reset applied for '${key}': cleared ${used}/${limit??"?"} recorded use(s) — continuing instead of escalating.`);
    applied++;
  }
  return applied>0;
}

// Sleep before a retry attempt so transient failures (e.g. network drops
// that take 1-4 minutes to recover) do not burn every attempt into a dead
// connection. Delay is configurable via policy.retry_delay_ms (default 60s).
async function retryDelay(c,attempt){
  if(attempt<=1) return;
  const ms=c.policy?.retry_delay_ms ?? 60000;
  if(ms<=0) return;
  console.log(`  Retry delay: waiting ${ms/1000}s before attempt ${attempt} (transient failure recovery)...`);
  await new Promise(r=>setTimeout(r,ms));
}

function recordAttemptFailure(c,s,taskScope,results,gate,io,{persist=true}={}){
  let observedFailure=selectAttemptFailure({results,gate});
  if(!observedFailure) observedFailure=failure("INTERNAL_CONTRACT_ERROR","orchestrator",false,[{source:"attempt",message:"Attempt failed without a classified cause."}]);
  const sourceResult=results.find(result=>result?.failure===observedFailure)||null;
  observedFailure={...observedFailure,sourceRole:sourceResult?.role||null,adapter:sourceResult?.adapter||null};
  const scope=failureBudgetScope(observedFailure,taskScope,sourceResult);
  // A live `ap reset` request is honoured HERE, at the one decision point every
  // role's failure passes through, for the scope about to be recorded — so the
  // counter starts from zero and the mission retries instead of escalating.
  applyPendingBudgetReset(s,scope,io);
  const budget=recordFailureBudget(s,c.policy,observedFailure,scope);
  s.lastFailure=observedFailure;
  s.lastFailureBudget=budget;
  if(persist) io.saveState(s);
  return {failure:observedFailure,budget,scope};
}

// Immediate escalation shared by the in-helper RATE_LIMITED guard below and
// the standalone/SpecKit callers in autopilot.mjs (through the exported
// guard). Persists phase/step and dies WITHOUT recording anything: the
// failure never touches failureBudgets/lastFailure, so no gate revision is
// spent. The resume hint in the shared detail tells the operator to re-run
// once the provider limit lifts. This holds the module's single naming call
// and its single shared-detail use; every escalation path delegates here.
function escalate(recorded,{state,saveState,fatal,escalatePrefix,cause}){
  const naming=decideEscalationName({failureClass:recorded.failure.class,retryable:recorded.failure.retryable,used:recorded.budget.used,limit:recorded.budget.limit,budget:recorded.budget.budget,evidence:recorded.failure.evidence});
  // Persist the escalation exactly as enforceAttemptFailure() does, so
  // state.json carries the real reason. This branch used to die() leaving
  // phase:"planning" and step:"standalone-plan" — naming neither the
  // escalation nor its cause, and disagreeing with the die() message it
  // printed right beside it.
  state.phase="escalated";
  state.step=naming.step;
  saveState(state);
  fatal(`${escalatePrefix} failed: ${cause} (${recorded.scope}): ${naming.detail}; human intervention required.`);
}

// Caller-facing immediate-escalation guard (imported by scripts/autopilot.mjs).
// Returns false when the result is neither RATE_LIMITED nor AUTH_REQUIRED;
// otherwise escalates at once through the shared helper above and never
// returns (the injected fatal throws). Both classes are non-retryable and
// spend zero failure budget: a provider limit lifts later, and a logged-out
// CLI can only be fixed by the operator. Forces retryable:false on the
// recorded-shaped object so the shared naming takes its immediate-escalation
// step even if the relay marked the failure retryable, and writes zero
// failure-budget state.
export function escalateIfRateLimited(config,state,taskScope,result,{fatal,saveState,escalatePrefix}={}){
  const failureClass=result?.failure?.class;
  if(failureClass!=="RATE_LIMITED"&&failureClass!=="AUTH_REQUIRED") return false;
  const failureRecord={...result.failure,class:failureClass,retryable:false};
  const scope=failureBudgetScope(failureRecord,taskScope,result);
  escalate({failure:failureRecord,budget:{allowed:false,budget:null,used:0,limit:0,scope},scope},
    {state,saveState:typeof saveState==="function"?saveState:()=>{},fatal:typeof fatal==="function"?fatal:(m)=>{throw new Error(String(m));},escalatePrefix,cause:`${failureRecord.class}/${failureRecord.domain}`});
  return true;
}

// TASK-14 (planning-review infra/functional split), call sites 1-2:
// classify-then-record-then-decide for a non-PASS `plan_reviewer` outcome.
// Takes the latest review result and a zero-argument re-invocation of the
// SAME reviewer call (reviewer only, fresh session), and resolves to the
// outcome the caller's unchanged behavior should evaluate:
// - Passthrough classes (PLANNING_REJECTED only, exactly the task 1 decision function's
//   passthrough set) skip recording entirely: returned unchanged, so the
//   caller's existing revision/escalation behavior runs byte-for-byte as
//   today and no such failure is ever recorded.
//   Recovered-path-error passthrough: STRUCTURED_OUTPUT_MISSING and
//   STRUCTURED_OUTPUT_INVALID with a clean adapter exit (process.exitCode
//   === 0) are also treated as passthrough (plan revision), not adapter
//   retries — returned unchanged with nothing recorded, so the caller's
//   existing revision behavior runs. Without a clean exit they remain
//   retryable adapter failures recorded and retried under the adapter
//   budget via the path below.
// - Anything else is recorded ONCE via the generic recordAttemptFailure()
//   (never enforceAttemptFailure(), which would die() itself on budget
//   exhaustion instead of letting the decision function decide, and never
//   the lower-level recordFailureBudget() directly, which would duplicate
//   recordAttemptFailure()'s selection/enrichment/scope/persist logic),
//   then fed to the task 1 decision function: "retry" waits
//   retryDelay(c, budget.used + 1) and re-invokes the reviewer only;
//   "escalate" dies naming the failure's class and domain; "passthrough"
//   returns the outcome unchanged for the caller's existing behavior.
// `budget.used` counts failures already recorded at this scope INCLUDING the
// one just recorded (1 after the first failure); the upcoming attempt is one
// ordinal further (budget.used + 1, i.e. 2 after the first failure), which is
// what retryDelay() must receive — passing budget.used alone reproduces
// retryDelay()'s own attempt<=1 no-op on the very first retry, silently
// skipping the delay every time under the default two-attempt budget. Never
// s.attempt here: that counter is scoped to the implementation loop's
// phase-stage checkpoint and carries no meaning for plan-review retries.
export async function resolvePlanningReviewAttempt(config,state,taskScope,reviewResult,rerunReviewer,opts={}){
  const {policyMessage,escalatePrefix}=opts;
  const fatal=typeof opts.fatal==="function"?opts.fatal:(m)=>{throw new Error(String(m));};
  const io={
    saveState:typeof opts.saveState==="function"?opts.saveState:()=>{},
    readResetRequests:typeof opts.readResetRequests==="function"?opts.readResetRequests:()=>[],
    consumeResetRequest:typeof opts.consumeResetRequest==="function"?opts.consumeResetRequest:()=>{},
    getConfiguredBudget:typeof opts.getConfiguredBudget==="function"?opts.getConfiguredBudget:()=>undefined,
    now:typeof opts.now==="function"?opts.now:()=>new Date().toISOString()
  };
  let current=reviewResult;
  for(;;){
    // RATE_LIMITED short-circuits before every other check (policy, PASS,
    // passthrough set) and before any recording: it escalates at once with
    // zero failure-budget writes. A non-throwing fatal falls through to the
    // return so the loop cannot spin on the same result.
    if(escalateIfRateLimited(config,state,taskScope,current,{fatal,saveState:io.saveState,escalatePrefix})) return current;
    if(current.policyViolation) fatal(policyMessage);
    if(current.status==="completed" && current.review?.decision==="PASS") return current;
    // Recovered-path-error passthrough: a reviewer relay whose adapter
    // process exited cleanly (exit 0) but whose sentinel is missing or
    // malformed is a plan-revision outcome, not an adapter retry. The clean
    // exit is itself trustworthy completion evidence (same authority
    // classifyObservedFailure() gives it), so return unchanged with nothing
    // recorded and let the caller's revision behavior run.
    if((current.failure?.class==="STRUCTURED_OUTPUT_MISSING"||current.failure?.class==="STRUCTURED_OUTPUT_INVALID")&&current.process?.exitCode===0){
      return current;
    }
    if(!PLANNING_REVIEW_PASSTHROUGH_SET.has(current.failure?.class)){
      const recorded=recordAttemptFailure(config,state,taskScope,[current],null,io,{persist:true});
      const decision=decidePlanningReview(recorded);
      if(decision.action==="retry"){
        await retryDelay(config,recorded.budget.used+1);
        current=await rerunReviewer();
        continue;
      }
      if(decision.action==="escalate"){
        escalate(recorded,{state,saveState:io.saveState,fatal,escalatePrefix,cause:`${recorded.failure.class}/${recorded.failure.domain}`});
      }
    }
    return current;
  }
}
