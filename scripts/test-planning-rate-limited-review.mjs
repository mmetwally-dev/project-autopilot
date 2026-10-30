#!/usr/bin/env node
// Backlog #54 task 1.2: standalone RATE_LIMITED escalation via the exported guard.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {escalateIfRateLimited, resolvePlanningReviewAttempt} from "./planning-review-wiring.mjs";
import {failure} from "./failure-contract.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const autopilotSrc = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");

// Fake reviewer emitting a 429 rate-limit event.
function rateLimitedResult() {
  return {
    status: "failed",
    role: "plan_reviewer",
    adapter: "opencode",
    failure: failure("RATE_LIMITED", "infrastructure", false, [
      {source: "relay", api_error_status: 429, provider: "opencode", model: "m"}
    ])
  };
}

// 1. Exported guard escalates once, writes only phase/step, leaves
//    standalonePlanReview + failureBudgets unchanged, rerun never called.
{
  const state = {
    phase: "planning",
    step: "standalone-plan",
    standalonePlanReview: {revision: 2, findings: ["keep me"]},
    failureBudgets: {"adapterRetryBudget:task:standalone-plan-review": 1}
  };
  const beforeReview = JSON.stringify(state.standalonePlanReview);
  const beforeBudgets = JSON.stringify(state.failureBudgets);
  let fatals = 0;
  let fatalMsg = "";
  let saves = 0;
  let reruns = 0;
  const rerun = async () => { reruns += 1; return rateLimitedResult(); };
  try {
    await resolvePlanningReviewAttempt(
      {policy: {retry_delay_ms: 0}}, state, "standalone-plan-review", rateLimitedResult(), rerun,
      {
        policyMessage: "Standalone plan reviewer violated relay policy.",
        escalatePrefix: "Standalone plan review",
        fatal: (m) => { fatals += 1; fatalMsg = String(m); throw new Error(`FATAL:${m}`); },
        saveState: () => { saves += 1; },
        readResetRequests: () => { throw new Error("must not read resets"); },
        consumeResetRequest: () => { throw new Error("must not consume resets"); },
        getConfiguredBudget: () => undefined,
        now: () => "2026-01-01T00:00:00.000Z"
      }
    );
    assert.fail("RATE_LIMITED must escalate via fatal");
  } catch (e) {
    assert.ok(String(e?.message || e).startsWith("FATAL:"), "escalation goes through fatal");
  }
  assert.equal(fatals, 1, "escalates exactly once");
  assert.equal(reruns, 0, "rerun callback called zero times");
  assert.equal(state.phase, "escalated", "phase escalated");
  assert.equal(state.step, "rate_limited_escalation", "step is rate_limited_escalation");
  assert.ok(fatalMsg.includes("ap run"), "fatal carries the resume hint");
  assert.ok(fatalMsg.includes("RATE_LIMITED"), "fatal names the class");
  assert.equal(JSON.stringify(state.standalonePlanReview), beforeReview, "standalonePlanReview unchanged");
  assert.equal(JSON.stringify(state.failureBudgets), beforeBudgets, "failureBudgets unchanged");
  assert.equal(saves, 1, "exactly one persist (the escalation itself)");
  console.log("PASS guard-escalates-once-state-untouched-rerun-zero");
}

// 2. Non-rate-limited result is a no-op.
{
  let fatalCalled = false;
  const out = escalateIfRateLimited({policy: {}}, {}, "standalone-plan-review",
    {status: "completed", review: {decision: "PASS"}},
    {fatal: () => { fatalCalled = true; throw new Error("x"); }, saveState: () => { throw new Error("x"); }, escalatePrefix: "Standalone plan review"});
  assert.equal(out, false, "guard returns false for non-rate-limited");
  assert.equal(fatalCalled, false, "fatal not called for non-rate-limited");
  console.log("PASS guard-noop-non-rate-limited");
}

// 3. Static source-order pins in the standalone loop.
{
  assert.ok(autopilotSrc.includes("escalateIfRateLimited") && autopilotSrc.includes("planning-review-wiring.mjs"),
    "autopilot imports the exported guard from planning-review-wiring");
  const plannerRelay = autopilotSrc.indexOf('const planner=await relayAsync("planner"');
  const reviewerRelay = autopilotSrc.indexOf('let reviewResult=await relayAsync("plan_reviewer"');
  const wiring = autopilotSrc.indexOf('reviewResult=await resolvePlanningReviewAttempt(');
  const plannerDie = autopilotSrc.indexOf('if(planner.status!=="completed"');
  assert.ok(plannerRelay !== -1 && reviewerRelay !== -1 && wiring !== -1 && plannerDie !== -1, "standalone sites present");
  // Standalone region for the never-decideEscalationName pin.
  const regionStart = plannerRelay;
  const revisionMarker = 'revision++;\n    const planFindings=saveReviewFeedback(s,STANDALONE_PLAN_FEEDBACK_KEY,reviewResult.review';
  const revisionIdxAbs = autopilotSrc.indexOf(revisionMarker);
  assert.ok(revisionIdxAbs !== -1, "standalone revision++ present");
  const region = autopilotSrc.slice(regionStart, revisionIdxAbs);
  const plannerGuard = region.indexOf('escalateIfRateLimited(c,s,"standalone-plan-review",planner');
  const reviewerGuard = region.indexOf('escalateIfRateLimited(c,s,"standalone-plan-review",reviewResult');
  assert.ok(plannerGuard !== -1, "planner guard present");
  assert.ok(reviewerGuard !== -1, "reviewer guard present");
  assert.ok(!region.includes("decideEscalationName("), "standalone region never calls decideEscalationName");
  // Continuation branches precede each guard; die/wiring/revision follow.
  const plannerCapped = region.indexOf("Planner hit the");
  const plannerIncomplete = region.indexOf("Planner stopped voluntarily as incomplete");
  const reviewerCapped = region.indexOf("Plan reviewer hit the");
  const reviewerIncomplete = region.indexOf("Plan reviewer stopped early (incomplete)");
  const plannerDieRel = region.indexOf('if(planner.status!=="completed"');
  const wiringRel = region.indexOf("reviewResult=await resolvePlanningReviewAttempt(");
  assert.ok(plannerCapped !== -1 && plannerIncomplete !== -1 && reviewerCapped !== -1 && reviewerIncomplete !== -1, "capped/INCOMPLETE branches present");
  assert.ok(plannerRelay !== -1, "planner relay present");
  assert.ok(plannerCapped < plannerGuard && plannerIncomplete < plannerGuard, "planner guard after capped/INCOMPLETE branches");
  assert.ok(plannerGuard < plannerDieRel, "planner guard before status die");
  assert.ok(reviewerCapped < reviewerGuard && reviewerIncomplete < reviewerGuard, "reviewer guard after capped/INCOMPLETE branches");
  assert.ok(reviewerGuard < wiringRel, "reviewer guard before wiring call");
  assert.ok(plannerGuard < reviewerGuard && reviewerGuard < region.length, "guards precede revision++ (region end)");
  assert.ok(region.slice(plannerGuard).includes('escalatePrefix:"Standalone planner"'), "planner guard prefix");
  assert.ok(region.slice(reviewerGuard).includes('escalatePrefix:"Standalone plan review"'), "reviewer guard prefix");
  console.log("PASS standalone-source-order-guards-pinned");
}

// 4. SpecKit source-order pins: planner site, initial-review wiring,
//    pre-revision checkpoint, re-review wiring.
{
  // Planner site in runPlanningPhase: guard between relay and status die.
  const plannerRelay = autopilotSrc.indexOf('const r=await relay("planner",task,c,s,{resume:false,capEnabled:true,taskRef,planRevision});');
  const plannerDie = autopilotSrc.indexOf('Planner failed or violated relay policy in phase');
  const plannerGuard = autopilotSrc.indexOf('escalateIfRateLimited(c,s,"speckit-gate-review",r,');
  assert.ok(plannerRelay !== -1 && plannerDie !== -1 && plannerGuard !== -1, "speckit planner relay/guard/die present");
  assert.ok(plannerRelay < plannerGuard && plannerGuard < plannerDie, "planner guard between relay and status die");

  // Initial-review wiring site.
  const initialWiring = autopilotSrc.indexOf('rr=await resolvePlanningReviewAttempt(c,s,"speckit-gate-review",rr,');
  assert.ok(initialWiring !== -1, "initial-review wiring present");
  const initialGuard = autopilotSrc.lastIndexOf('escalateIfRateLimited(c,s,"speckit-gate-review",rr,', initialWiring);
  assert.ok(initialGuard !== -1 && initialGuard < initialWiring, "initial guard before wiring call");
  const policyDie = autopilotSrc.lastIndexOf("reviewer violated read-only relay policy.", initialWiring);
  assert.ok(policyDie !== -1 && policyDie < initialGuard, "initial guard after policyViolation die");

  // Revision site: guard before saveReviewFeedback / planner_revision checkpoint / revision runPlanningPhase.
  const revisionFeedback = autopilotSrc.indexOf("saveReviewFeedback(s,speckitStageFeedbackKey(gateStage),rr.review", initialWiring);
  const revisionCheckpoint = autopilotSrc.indexOf("SPECKIT_PLANNER_REVISION", initialWiring);
  const revisionRun = autopilotSrc.indexOf("await runPlanningPhase(c,gateStage,request,s,planReviewRevisionCount(s,gateKey));", initialWiring);
  assert.ok(revisionFeedback !== -1 && revisionCheckpoint !== -1 && revisionRun !== -1, "revision feedback/checkpoint/run present");
  const revisionGuard = autopilotSrc.slice(initialWiring, revisionFeedback).lastIndexOf('escalateIfRateLimited(c,s,"speckit-gate-review",rr,');
  assert.ok(revisionGuard !== -1, "revision guard before saveReviewFeedback/planner_revision/runPlanningPhase");
  const revisionGuardAbs = initialWiring + revisionGuard;
  assert.ok(revisionGuardAbs < revisionFeedback && revisionGuardAbs < revisionCheckpoint && revisionGuardAbs < revisionRun,
    "revision guard precedes feedback write, checkpoint write, and planner re-invocation");

  // Re-review wiring site.
  const reWiring = autopilotSrc.indexOf('retry=await resolvePlanningReviewAttempt(c,s,"speckit-gate-review",retry,');
  assert.ok(reWiring !== -1, "re-review wiring present");
  const reGuard = autopilotSrc.lastIndexOf('escalateIfRateLimited(c,s,"speckit-gate-review",retry,', reWiring);
  assert.ok(reGuard !== -1 && reGuard < reWiring, "re-review guard before wiring call");
  assert.ok(reGuard > revisionRun, "re-review guard after the revision planner call");

  // SpecKit gate region never calls decideEscalationName directly.
  const speckitRegion = autopilotSrc.slice(plannerRelay, reWiring + 200);
  assert.ok(!speckitRegion.includes("decideEscalationName("), "speckit region never calls decideEscalationName");
  console.log("PASS speckit-source-order-guards-pinned");
}

// 5. SpecKit behavioral: guard with speckit scope escalates once with no
//    gate revision spent and planner not re-invoked.
{
  const state = {
    phase: "planning",
    step: "specify",
    failureBudgets: {"adapterRetryBudget:task:speckit-gate-review": 1}
  };
  const beforeBudgets = JSON.stringify(state.failureBudgets);
  let fatals = 0;
  let fatalMsg = "";
  let saves = 0;
  let reruns = 0;
  const rerun = async () => { reruns += 1; return rateLimitedResult(); };
  try {
    await resolvePlanningReviewAttempt(
      {policy: {retry_delay_ms: 0}}, state, "speckit-gate-review", rateLimitedResult(), rerun,
      {
        policyMessage: "SpecKit gate gate reviewer violated read-only relay policy.",
        escalatePrefix: "SpecKit gate gate plan review",
        fatal: (m) => { fatals += 1; fatalMsg = String(m); throw new Error(`FATAL:${m}`); },
        saveState: () => { saves += 1; },
        readResetRequests: () => { throw new Error("must not read resets"); },
        consumeResetRequest: () => { throw new Error("must not consume resets"); },
        getConfiguredBudget: () => undefined,
        now: () => "2026-01-01T00:00:00.000Z"
      }
    );
    assert.fail("RATE_LIMITED must escalate via fatal");
  } catch (e) {
    assert.ok(String(e?.message || e).startsWith("FATAL:"), "escalation goes through fatal");
  }
  assert.equal(fatals, 1, "escalates exactly once");
  assert.equal(reruns, 0, "planner/reviewer not re-invoked");
  assert.equal(state.phase, "escalated", "phase escalated");
  assert.equal(state.step, "rate_limited_escalation", "step is rate_limited_escalation");
  assert.ok(fatalMsg.includes("ap run"), "fatal carries the resume hint");
  assert.equal(JSON.stringify(state.failureBudgets), beforeBudgets, "failureBudgets unchanged (no gate revision spent)");
  assert.equal(saves, 1, "exactly one persist (the escalation itself)");
  assert.ok(!("speckitPlanningCheckpoint" in state), "no planner_revision checkpoint written");
  console.log("PASS speckit-guard-escalates-once-no-revision-no-reinvoke");
}

// 6. Existing-planning-review (3353): standalone/speckit escalate through the
//    helper instead of the existing-planning-review-failed die; GSD stays generic.
{
  const gateIdx = autopilotSrc.indexOf("isPlanningReviewRetryFramework(framework)");
  assert.ok(gateIdx !== -1, "isPlanningReviewRetryFramework gate present");
  const existingWiring = autopilotSrc.indexOf('resolvePlanningReviewAttempt(c,s,"existing-planning-review",rr,', gateIdx);
  assert.ok(existingWiring !== -1, "existing-planning-review wiring present inside the gate");
  const genericDie = autopilotSrc.indexOf("existing-planning-review-failed", gateIdx);
  assert.ok(genericDie !== -1 && existingWiring < genericDie, "generic die follows the gated wiring");
  // No caller-side guard at 3353: the in-helper guard covers it.
  const gateRegion = autopilotSrc.slice(gateIdx, genericDie);
  assert.ok(!gateRegion.includes("escalateIfRateLimited"), "3353 needs no caller edit (in-helper guard covers it)");
  // GSD stays on the generic path: the else branch has no helper call.
  assert.ok(gateRegion.includes('} else if(rr.policyViolation)'), "GSD else branch present without helper");

  // Behavioral: the 3353 helper path escalates RATE_LIMITED with
  // rate_limited_escalation, never the generic step.
  const state = {phase: "planning", step: "planning", failureBudgets: {}};
  let fatalMsg = "";
  try {
    await resolvePlanningReviewAttempt(
      {policy: {retry_delay_ms: 0}}, state, "existing-planning-review", rateLimitedResult(),
      async () => { throw new Error("must not rerun"); },
      {
        policyMessage: "Existing planning reviewer violated relay policy.",
        escalatePrefix: "Existing standalone planning review",
        fatal: (m) => { fatalMsg = String(m); throw new Error(`FATAL:${m}`); },
        saveState: () => {},
        readResetRequests: () => { throw new Error("must not read resets"); },
        consumeResetRequest: () => { throw new Error("must not consume resets"); },
        getConfiguredBudget: () => undefined,
        now: () => "2026-01-01T00:00:00.000Z"
      }
    );
    assert.fail("RATE_LIMITED must escalate via the helper");
  } catch (e) {
    assert.ok(String(e?.message || e).startsWith("FATAL:"), "helper escalation goes through fatal");
  }
  assert.equal(state.phase, "escalated", "3353 helper path escalates phase");
  assert.equal(state.step, "rate_limited_escalation", "3353 helper path uses rate_limited_escalation, not existing-planning-review-failed");
  assert.ok(fatalMsg.includes("RATE_LIMITED"), "fatal names the class");
  console.log("PASS existing-planning-review-helper-escalation-gsd-generic");
}

console.log("test-planning-rate-limited-review: all cases passed");
