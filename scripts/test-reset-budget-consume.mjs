#!/usr/bin/env node
// Mission 085 Phase 1 task 1.1 — queued live reset must be honored at failure decisions.
//
// Focused test through the REAL CLI (queue side) and the REAL failure decision
// (record side). Seed shape: `lastFailureBudget` carries an UNRELATED scope
// (infrastructure `mission`) while `failureBudgets` already holds uses for the
// implementation key under test. A real `ap reset --scope <full-budget-key>`
// is then issued while a live owner-PID decoy exists (precedent
// `scripts/test-owner-pid-file.mjs:533-608`), so the request is QUEUED rather
// than applied directly.
//
//   case A — drives real failure decisions for the QUEUED key to its limit.
//     Fixed in task 1.2 (queue-time scope resolution in `resetTargetKey`,
//     `scripts/autopilot.mjs:1056-1068`): the queued entry carries the key's
//     own decision scope (`task:standalone:phase-0`), so the apply-time matcher
//     (`applyPendingBudgetReset`, `scripts/autopilot.mjs:1003-1050`) fires —
//     the counter restarts from zero (mission continues) and the entry leaves
//     the queue. Asserts scope equality, consumption, and the extra allowed
//     decision.
//   case B — queues a DIFFERENT-key request (same scope, another budget family,
//     nothing recorded for it — the same-scope-decoy precedent from
//     `scripts/test-live-reset-mission.mjs` case b) and proves it stays queued
//     via the zero-use guard while the first key's decisions run. Green both
//     pre- and post-fix.
//   case C — the GSD plan-unit round trip (task 1.3): the per-unit decision
//     runs on a deep copy (runGsdPlanUnit, scripts/autopilot.mjs) which
//     consumes the disk request, then the outer executeWave re-record must
//     restart from the carried reset instead of incrementing past the limit.
//     Queues via the real CLI for the GSD plan-unit budget key
//     (`implementationFailureBudget:task:gsd:1:plan-a`, scope derived from
//     the key itself per task 1.2) plus a same-scope different-family decoy,
//     runs the REAL unit-side decision on a deep copy (persist:false, real
//     queue IO), derives the failureRecord with the REAL production
//     `deriveGsdUnitResetRecord` and propagates it with the REAL production
//     `applyCarriedGsdReset` (both from `scripts/gsd-unit-reset.mjs`, the
//     same module `recordGsdUnitFailure`/`executeWave` call — autopilot.mjs
//     executes main() at import so it cannot be imported directly), then the
//     REAL `recordFailureBudget` re-record — asserting mission-continues,
//     consumption, decoy-stays-queued, a late same-key re-queue surviving the
//     outer propagation (no queue IO there), global-carry clearing of every
//     spent counter, and preserved escalate-at-limit order.
//
// The "real failure decision" is `resolvePlanningReviewAttempt` from
// `scripts/planning-review-wiring.mjs` — the production-extracted decision
// helper whose `recordAttemptFailure`/`applyPendingBudgetReset` are the same
// code the running mission executes (autopilot.mjs itself cannot be imported:
// it executes its CLI `main()` at import). Its reset-queue IO is wired to the
// REAL `reset-request.json` file via `scripts/reset-request-queue.mjs`, the
// budget limit comes from the REAL fixture config, and state is the REAL
// fixture `state.json`.
//
// Fixture repos live under $TMPDIR (os.tmpdir via makeFixtureRepo), never
// inside the project repo.
import fs from "node:fs";
import path from "node:path";
import {spawn, spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {writeOwnerPid, readOwnerPid, verifyOwnerPid} from "./owner-pid.mjs";
import {
  makeFixtureRepo, writeConfig, withoutOuterGitGuard, cleanup, makeGsdPhaseFixture,
} from "./test-fixtures/workflow-order-harness.mjs";
import {readResetRequests, removeResetRequest, enqueueResetRequest} from "./reset-request-queue.mjs";
import {resolvePlanningReviewAttempt} from "./planning-review-wiring.mjs";
import {failure, recordFailureBudget} from "./failure-contract.mjs";
import {deriveGsdUnitResetRecord, applyCarriedGsdReset} from "./gsd-unit-reset.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const AUTOPILOT = path.join(here, "autopilot.mjs");
const ENV = withoutOuterGitGuard(process.env);

// The key under test and its real decision scope: `failureBudgets` is keyed
// `<budgetName>:<scope>` while `failureBudgetScope` (autopilot.mjs:1752-1756)
// maps an implementation-domain failure to `task:<taskScope>`.
const TARGET_KEY = "implementationFailureBudget:task:standalone:phase-0";
const TASK_SCOPE = "standalone:phase-0";
const DECISION_SCOPE = `task:${TASK_SCOPE}`;
// Case B: same decision scope, another budget family with nothing recorded —
// must stay queued (zero-use guard) while the TARGET key's decisions run.
const OTHER_KEY = "verificationFailureBudget:task:standalone:phase-0";
const LIMIT = 2;
// Case C: the GSD plan-unit budget key (unit label `gsd:1:plan-a`, the shape
// runGsdPlanUnit records with) plus a same-scope different-family decoy.
const GSD_TASK_SCOPE = "gsd:1:plan-a";
const GSD_DECISION_SCOPE = `task:${GSD_TASK_SCOPE}`;
const GSD_KEY = `implementationFailureBudget:${GSD_DECISION_SCOPE}`;
const GSD_DECOY = `verificationFailureBudget:${GSD_DECISION_SCOPE}`;

let ok = 0, failed = 0;
function check(name, condition, detail){
  if(condition){ ok++; console.log(`PASS ${name}`); return; }
  failed++;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}
function note(msg){ console.log(`NOTE ${msg}`); }

const statePath = (repo) => path.join(repo, ".autopilot", "state.json");
const requestPath = (repo) => path.join(repo, ".autopilot", "reset-request.json");
const configPath = (repo) => path.join(repo, ".autopilot", "config.json");
const readState = (repo) => JSON.parse(fs.readFileSync(statePath(repo), "utf8"));
const writeState = (repo, s) => fs.writeFileSync(statePath(repo), JSON.stringify(s, null, 2));
const readQueue = (repo) => { try{ return readResetRequests(requestPath(repo)); }catch{ return null; } };

// Seed: lastFailureBudget carries the UNRELATED infrastructure scope while the
// implementation key under test already holds `seededUsed` recorded uses.
function seedState(targetKey, seededUsed, otherKey = null){
  const failureBudgets = {[targetKey]: seededUsed};
  if(otherKey) failureBudgets[otherKey] = seededUsed;
  return {
    version: 1, phase: "implementing", step: "implementing",
    mission: "085-test-mission", planningRequest: "fixture request",
    lastFailure: {schema: "autopilot-failure.v1", class: "SERVER_UNAVAILABLE", domain: "infrastructure",
      retryable: true, evidence: [], sourceRole: "implementer", adapter: "cursor"},
    lastFailureBudget: {allowed: true, budget: "infrastructureRetryBudget", used: 1, limit: 2, scope: "mission"},
    failureBudgets,
  };
}

// Live-PID decoy (precedent test-owner-pid-file.mjs:519-531): named
// autopilot.mjs but launched with `full`, so it is invisible to the /proc
// command scan — queueing proves the live verdict came from the verified
// owner PID file.
function spawnFullDecoy(repo){
  const fake = path.join(repo, "autopilot.mjs");
  fs.writeFileSync(fake, "setTimeout(()=>{}, 120000);\n");
  return spawn(process.execPath, [fake, "full"], {cwd: repo, stdio: "ignore"});
}
async function waitLive(repo){
  const deadline = Date.now() + 15000;
  while(Date.now() < deadline){
    try{ if(verifyOwnerPid(readOwnerPid(repo), repo) === true) return true; }catch{ /* not yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}
function reap(child){
  return new Promise((resolve) => {
    if(!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(resolve, 15000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}
function runReset(repo, scope){
  return spawnSync(process.execPath,
    [AUTOPILOT, "reset", "--scope", scope, "--yes", "--repo", repo],
    {cwd: repo, encoding: "utf8", env: ENV, timeout: 60000, shell: false});
}

// Drive REAL failure decisions for the TARGET key until its counter reaches
// the configured limit. Each call records exactly one failure through the
// real apply-then-record path and then escalates (implementation domain never
// retries on the planning-review path), so the injected fatal is caught and
// the loop re-reads the persisted state.
async function driveToLimit(repo, targetKey, limit){
  let decisions = 0;
  for(let i = 0; i < 6; i++){
    const before = readState(repo);
    if((before.failureBudgets?.[targetKey] || 0) >= limit) break;
    const config = JSON.parse(fs.readFileSync(configPath(repo), "utf8"));
    const state = readState(repo);
    const result = {role: "implementer", adapter: "cursor",
      failure: failure("IMPLEMENTATION_REJECTED", "implementation", true,
        [{source: "test", message: "085 focused reset test: simulated implementation failure"}])};
    const io = {
      saveState: (s) => writeState(repo, s),
      readResetRequests: () => readResetRequests(requestPath(repo)),
      consumeResetRequest: (key) => removeResetRequest(requestPath(repo), key),
      getConfiguredBudget: (name) => config.policy?.failure_budgets?.[name],
      now: () => new Date().toISOString(),
    };
    try{
      await resolvePlanningReviewAttempt(config, state, TASK_SCOPE, result,
        async () => result,
        {...io, fatal: (m) => { throw new Error(String(m)); }, escalatePrefix: "085 reset test decision"});
    }catch{ /* escalation fatal — expected once the budget is spent */ }
    decisions++;
  }
  return decisions;
}

const created = [];
if(process.platform === "win32"){
  console.log("SKIP reset budget-consume integration on win32");
}else{
  // ---- case A: queued request for the key whose decisions run to the limit ----
  {
    const repo = makeFixtureRepo("reset-budget-consume-a-"); created.push(repo);
    writeConfig(repo, {planningFramework: "standalone",
      failureBudgets: {implementationFailureBudget: LIMIT, verificationFailureBudget: LIMIT, infrastructureRetryBudget: LIMIT}});
    writeState(repo, seedState(TARGET_KEY, 1));
    let child = spawnFullDecoy(repo);
    try{
      writeOwnerPid(child.pid, repo);
      check("case A precondition: PID file verifies live",
        await waitLive(repo));
      const q = runReset(repo, TARGET_KEY);
      const qOut = `${q.stdout || ""}${q.stderr || ""}`;
      check("case A: real `ap reset --scope <full-budget-key>` queues while live (exit 0 + REQUESTED)",
        q.status === 0 && qOut.includes("REQUESTED"), {status: q.status, tail: qOut.slice(-400)});
      const queued = readQueue(repo);
      check("case A: queued entry carries the decision key",
        Array.isArray(queued) && queued.length === 1 && queued[0]?.key === TARGET_KEY, queued);
      const queuedScope = Array.isArray(queued) && queued[0]?.scope;
      note(`case A queue-time scope: queued scope '${queuedScope}' vs decision scope '${DECISION_SCOPE}' for key '${TARGET_KEY}'`);
      check("case A: queued entry scope equals the decision scope for the key",
        queuedScope === DECISION_SCOPE, {queuedScope, DECISION_SCOPE});
      try{ child.kill("SIGKILL"); }catch{}
      await reap(child);
      child = null;
      const decisions = await driveToLimit(repo, TARGET_KEY, LIMIT);
      const after = readState(repo);
      check("case A: real failure decisions drove the queued key to its limit",
        (after.failureBudgets?.[TARGET_KEY] || 0) >= LIMIT && decisions >= 1,
        {used: after.failureBudgets?.[TARGET_KEY], decisions, budget: after.lastFailureBudget});
      const remaining = readQueue(repo);
      const consumed = remaining === null || (Array.isArray(remaining) && !remaining.some(r => r?.key === TARGET_KEY));
      // Fixed behaviour (task 1.2): the queued reset for the driven key is
      // applied at its failure decision — the counter restarts from zero so at
      // least one post-reset decision continues (2 decisions to reach the limit
      // from 1 seeded use: clear→1→2) and the entry leaves the queue.
      check(`case A: queued reset for '${TARGET_KEY}' was consumed at the failure decision (mission continued instead of bypassing the reset)`,
        consumed, {remaining, decisions});
      check("case A: post-reset mission continued before exhausting (extra allowed decision)",
        decisions >= 2, {decisions});
    }finally{
      try{ if(child && child.exitCode === null) child.kill("SIGKILL"); }catch{}
    }
  }
  // ---- case B: a different-key request stays queued while TARGET decisions run ----
  {
    const repo = makeFixtureRepo("reset-budget-consume-b-"); created.push(repo);
    writeConfig(repo, {planningFramework: "standalone",
      failureBudgets: {implementationFailureBudget: LIMIT, verificationFailureBudget: LIMIT, infrastructureRetryBudget: LIMIT}});
    writeState(repo, seedState(TARGET_KEY, 1));
    let child = spawnFullDecoy(repo);
    try{
      writeOwnerPid(child.pid, repo);
      check("case B precondition: PID file verifies live",
        await waitLive(repo));
      const q = runReset(repo, OTHER_KEY);
      const qOut = `${q.stdout || ""}${q.stderr || ""}`;
      check("case B: real `ap reset --scope <other-key>` queues while live (exit 0 + REQUESTED)",
        q.status === 0 && qOut.includes("REQUESTED"), {status: q.status, tail: qOut.slice(-400)});
      const queued = readQueue(repo);
      check("case B: queued entry carries the other key",
        Array.isArray(queued) && queued.length === 1 && queued[0]?.key === OTHER_KEY, queued);
      try{ child.kill("SIGKILL"); }catch{}
      await reap(child);
      child = null;
      await driveToLimit(repo, TARGET_KEY, LIMIT);
      const after = readState(repo);
      check("case B: TARGET key decisions still reached the limit",
        (after.failureBudgets?.[TARGET_KEY] || 0) >= LIMIT,
        {used: after.failureBudgets?.[TARGET_KEY]});
      const remaining = readQueue(repo);
      check("case B: the different-key request stays queued (never clobbered, never applied)",
        Array.isArray(remaining) && remaining.length === 1 && remaining[0]?.key === OTHER_KEY,
        {exists: fs.existsSync(requestPath(repo)), remaining});
    }finally{
      try{ if(child && child.exitCode === null) child.kill("SIGKILL"); }catch{}
    }
  }
  // ---- case C: the GSD plan-unit copy/re-record round trip ----
  {
    const repo = makeFixtureRepo("reset-budget-consume-c-"); created.push(repo);
    makeGsdPhaseFixture(repo);
    writeConfig(repo, {planningFramework: "gsd",
      failureBudgets: {implementationFailureBudget: LIMIT, verificationFailureBudget: LIMIT, infrastructureRetryBudget: LIMIT}});
    writeState(repo, seedState(GSD_KEY, 1));
    // Production wiring: autopilot.mjs executes main() at import, so the
    // shared module is pinned as the single derivation/propagation
    // implementation used by recordGsdUnitFailure/executeWave.
    const apSrc = fs.readFileSync(AUTOPILOT, "utf8");
    check("case C wiring: production derives/propagates via gsd-unit-reset.mjs",
      apSrc.includes("gsd-unit-reset.mjs")
        && apSrc.includes("deriveGsdUnitResetRecord")
        && apSrc.includes("applyCarriedGsdReset"),
      "recordGsdUnitFailure/executeWave share the tested module");
    let child = spawnFullDecoy(repo);
    try{
      writeOwnerPid(child.pid, repo);
      check("case C precondition: PID file verifies live",
        await waitLive(repo));
      const q1 = runReset(repo, GSD_KEY);
      const q1Out = `${q1.stdout || ""}${q1.stderr || ""}`;
      check("case C: real `ap reset --scope <gsd-key>` queues while live (exit 0 + REQUESTED)",
        q1.status === 0 && q1Out.includes("REQUESTED"), {status: q1.status, tail: q1Out.slice(-400)});
      const q2 = runReset(repo, GSD_DECOY);
      const q2Out = `${q2.stdout || ""}${q2.stderr || ""}`;
      check("case C: real `ap reset --scope <gsd-decoy>` queues while live (exit 0 + REQUESTED)",
        q2.status === 0 && q2Out.includes("REQUESTED"), {status: q2.status, tail: q2Out.slice(-400)});
      const queued = readQueue(repo);
      check("case C: both entries queued, GSD entry scope derived from the key itself",
        Array.isArray(queued) && queued.length === 2
          && queued.some(r => r?.key === GSD_KEY && r?.scope === GSD_DECISION_SCOPE)
          && queued.some(r => r?.key === GSD_DECOY),
        queued);
      try{ child.kill("SIGKILL"); }catch{}
      await reap(child);
      child = null;
      // Unit side on a deep copy — mirrors runGsdPlanUnit: the REAL failure
      // decision with persist:false and REAL queue IO. The rerun passes, so
      // exactly one unit-side failure is recorded (then the unit continues).
      const config = JSON.parse(fs.readFileSync(configPath(repo), "utf8"));
      const localState = JSON.parse(JSON.stringify(readState(repo)));
      const resetBefore = localState.lastReset;
      const budgetsBefore = {...(localState.failureBudgets || {})};
      const observed = {role: "implementer", adapter: "cursor",
        failure: failure("IMPLEMENTATION_REJECTED", "implementation", true,
          [{source: "test", message: "085 GSD round trip: simulated plan-unit failure"}])};
      // Mirror recordGsdUnitFailure's real recordAttemptFailure call: the
      // REAL wiring decision (same code the running mission executes)
      // applied to the deep copy with REAL queue IO.
      const unitIo = {
        saveState: () => {},
        readResetRequests: () => readResetRequests(requestPath(repo)),
        consumeResetRequest: (key) => removeResetRequest(requestPath(repo), key),
        getConfiguredBudget: (name) => config.policy?.failure_budgets?.[name],
        now: () => new Date().toISOString(),
      };
      await resolvePlanningReviewAttempt(config, localState, GSD_TASK_SCOPE, observed,
        async () => ({status: "completed", review: {decision: "PASS"}}),
        {...unitIo, fatal: (m) => { throw new Error(String(m)); }, escalatePrefix: "085 GSD round trip"});
      // The REAL production derivation (same function recordGsdUnitFailure
      // calls): carry the unit's applied reset into the failureRecord.
      const recordedShape = {failure: localState.lastFailure, scope: localState.lastFailureBudget?.scope ?? GSD_DECISION_SCOPE,
        budget: localState.lastFailureBudget};
      const unitRecord = deriveGsdUnitResetRecord({budgetsBefore, resetBefore, localState, recorded: recordedShape});
      check("case C: production derivation carries the applied reset key",
        Array.isArray(unitRecord.appliedResetKeys) && unitRecord.appliedResetKeys.includes(GSD_KEY)
          && unitRecord.lastReset?.scope === GSD_KEY,
        unitRecord);
      check("case C: unit-side decision recorded under the GSD decision scope",
        localState.lastFailureBudget?.scope === GSD_DECISION_SCOPE, localState.lastFailureBudget);
      check("case C: unit side applied the queued reset (counter restarted on the copy, lastReset stamped)",
        (localState.failureBudgets?.[GSD_KEY] || 0) === 1 && localState.lastReset?.scope === GSD_KEY,
        {budgets: localState.failureBudgets, lastReset: localState.lastReset});
      const remainingUnit = readQueue(repo);
      check("case C: unit side consumed the GSD entry while the decoy stays queued",
        Array.isArray(remainingUnit) && remainingUnit.length === 1 && remainingUnit[0]?.key === GSD_DECOY,
        {exists: fs.existsSync(requestPath(repo)), remainingUnit});
      // Outer side — the REAL production propagation (same function
      // executeWave calls), then the REAL recordFailureBudget re-record for
      // the same failure. Pre-fix this was a bare re-record: used would hit
      // the limit and the mission would escalate despite the queued reset.
      // A late same-key request armed AFTER the unit consumed the first one
      // (e.g. while a later attempt runs) must survive the outer step: the
      // propagation performs no queue IO.
      enqueueResetRequest(requestPath(repo),
        {key: GSD_KEY, scope: GSD_DECISION_SCOPE, at: new Date().toISOString(), requestedBy: "085 case C late re-arm", requestedPid: process.pid});
      const outer = readState(repo);
      applyCarriedGsdReset(outer, unitRecord);
      const budget = recordFailureBudget(outer, config.policy, unitRecord.failure, unitRecord.scope);
      outer.lastFailure = unitRecord.failure;
      outer.lastFailureBudget = budget;
      writeState(repo, outer);
      check("case C: outer re-record restarts instead of escalating (mission continues)",
        budget.allowed === true && budget.used === 1, budget);
      check("case C: outer lastReset carries the unit's applied reset",
        outer.lastReset?.scope === GSD_KEY, outer.lastReset);
      const remainingOuter = readQueue(repo);
      check("case C: non-matching entry still queued after the round trip",
        Array.isArray(remainingOuter) && remainingOuter.some(r => r?.key === GSD_DECOY),
        {exists: fs.existsSync(requestPath(repo)), remainingOuter});
      check("case C: late same-key re-queue survives the outer propagation (never deleted without being applied)",
        Array.isArray(remainingOuter) && remainingOuter.some(r => r?.key === GSD_KEY),
        {exists: fs.existsSync(requestPath(repo)), remainingOuter});
      // Carried global reset: the REAL propagation clears every spent
      // counter on the outer state, mirroring what the unit cleared.
      const globalOuter = {failureBudgets: {[GSD_KEY]: 1, [GSD_DECOY]: 1},
        continuationBudgets: {"continuationAllowance:task:gsd:1:plan-a": 1},
        noProgressGenerations: {"continuationAllowance:task:gsd:1:plan-a": 2},
        rolloverDeadEnds: {"continuationAllowance:task:gsd:1:plan-a": ["a"]},
        standalonePlanReview: {revision: 1}, lastContinuation: {scope: "task:gsd:1:plan-a"}};
      applyCarriedGsdReset(globalOuter,
        {failure: unitRecord.failure, scope: unitRecord.scope, appliedResetKeys: [GSD_KEY, GSD_DECOY],
          lastReset: {at: new Date().toISOString(), scope: "global"}});
      check("case C: carried global reset clears every spent counter on the outer state (budgets, continuations, dead-ends, revision)",
        Object.keys(globalOuter.failureBudgets || {}).length === 0
          && Object.keys(globalOuter.continuationBudgets || {}).length === 0
          && Object.keys(globalOuter.rolloverDeadEnds || {}).length === 0
          && !("revision" in (globalOuter.standalonePlanReview || {}))
          && !("lastContinuation" in globalOuter)
          && globalOuter.lastReset?.scope === "global",
        globalOuter);
      // Per-record escalate-and-die order preserved: the next failure with
      // nothing queued exhausts the restarted counter.
      const exhausted = recordFailureBudget(outer, config.policy, outer.lastFailure, GSD_DECISION_SCOPE);
      check("case C: post-reset exhaustion still escalates (allowed=false at the limit)",
        exhausted.allowed === false && exhausted.used === LIMIT, exhausted);
    }finally{
      try{ if(child && child.exitCode === null) child.kill("SIGKILL"); }catch{}
    }
  }
  cleanup(...created);
}

if(failed){
  console.error(`${failed} reset-budget-consume check(s) failed (${ok} passed).`);
  process.exit(1);
}
console.log(`test-reset-budget-consume: ALL CHECKS PASSED (${ok} passed)`);
