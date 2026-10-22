#!/usr/bin/env node
// Mission 087 task 2.2: at-once re-run on a fallback switch.
// Source-level (autopilot.mjs runs main() on import, so it cannot be
// imported) plus a functional simulation through the Phase 1 module using
// the exact call shapes the runRelay retry wiring uses, driven by a fake
// adapter that fails RATE_LIMITED once then succeeds.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  decideRoleFallback,
  resolveEffectiveRoleModel,
  decideRoleFallbackRetry,
} from "./role-fallback.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
const runRelay = src.slice(src.indexOf("async function runRelay("), src.indexOf("function guardedShell("));
assert.ok(runRelay.length > 0, "runRelay body must be bounded for inspection");

// 1. The retry wiring exists: resume-rule helper imported and used, the
//    re-run re-invokes runRelay with the rule's resume flag, a new session
//    clears the stored sid, and recursion is depth-guarded.
{
  assert.ok(src.includes('from "./role-fallback.mjs"'), "autopilot must import the role-fallback module");
  assert.ok(src.includes("decideRoleFallbackRetry"), "autopilot must use decideRoleFallbackRetry");
  assert.ok(runRelay.includes("__fallbackDepth"), "runRelay must carry a fallback retry depth guard");
  assert.ok(runRelay.includes("decideRoleFallbackRetry({from:result.fallbackSwitch.from"),
    "retry must decide same-session vs new-session from the switch marker");
  assert.ok(runRelay.includes("clearRoleSession(s,roleName)"), "new-session retry must clear the stored session");
  assert.ok(/return runRelay\(roleName,(?:task|appendFailureHandoff\(task,[^)]*\)),c,s,\{[^}]*resume:retry\.resume/.test(runRelay),
    "retry must re-invoke runRelay for the same run");
  assert.ok(runRelay.includes("resume:retry.resume"), "re-run must use the resume-rule flag");
  assert.ok(runRelay.includes("!result.sessionId"),
    "same-session retry only when the RATE_LIMITED run recorded a sessionId (else stale sid resume)");
  console.log("PASS retry-wiring-present");
}

// 2. Only the final result is returned: the intermediate RATE_LIMITED run
//    is finalized to its own run dir first, so callers never see it and no
//    failure budget is spent on it. Exhausted fallbacks carry no switch
//    marker, so they return today's RATE_LIMITED result (escalate-and-stop).
{
  const resultWrite = runRelay.indexOf('write(path.join(dir,"result.json")');
  const retryGate = runRelay.indexOf("result?.fallbackSwitch?.to");
  assert.ok(resultWrite > 0 && retryGate > resultWrite,
    "retry must happen after the intermediate run is finalized to its own dir");
  assert.ok(!/recordFailureBudget\(/.test(runRelay),
    "runRelay must not record failure budgets itself (only the returned final result reaches the callers' budgets)");
  console.log("PASS no-budget-on-intermediate");
}

// Simulates one runRelay attempt tail (the choke point + the retry gate)
// using the exact call shapes the wiring uses. `spawnOnce` returns the
// attempt's failure class (null = success). Returns what runRelay returns.
function driveToSettled({s, roleName, roleConfig, fakeAgents, spawnOnce, budgets}) {
  let depth = 0;
  for (;;) {
    const failureClass = spawnOnce({s, depth, effective: resolveEffectiveRoleModel(roleConfig, s.activeRoleModels?.[roleName] ?? null)});
    if (failureClass !== "RATE_LIMITED") {
      if (failureClass) budgets.push(failureClass); // caller records only the RETURNED failure
      return {status: failureClass ? "failed" : "completed", failureClass};
    }
    const from = resolveEffectiveRoleModel(roleConfig, s.activeRoleModels?.[roleName] ?? null);
    const decision = decideRoleFallback({
      role: roleName, roleConfig, activeModel: s.activeRoleModels?.[roleName] ?? null, failureClass,
    });
    if (decision?.action !== "switch" || !decision.next) {
      budgets.push(failureClass); // exhausted: today's escalate-and-stop records the budget
      return {status: "failed", failureClass, escalate: true, reason: decision?.reason ?? null};
    }
    s.activeRoleModels = {...(s.activeRoleModels || {}), [roleName]: decision.next};
    const retry = decideRoleFallbackRetry({
      from, to: decision.next,
      resumeSupported: Boolean(fakeAgents[decision.next.adapter]?.resume_session?.length),
    });
    if (!retry.resume && s.sessions) delete s.sessions[roleName];
    depth += 1;
    assert.ok(depth < 8, "retry depth guard must terminate");
    // The intermediate RATE_LIMITED is finalized, never recorded: loop
    // continues with the same brief/inputs (spawnOnce sees them) and the
    // rule's session mode. `lastRetry` exposes the honoured rule.
    var lastRetry = retry;
  }
}

// 3. Fake adapter failing RATE_LIMITED once then succeeding (same adapter
//    with resume support): no escalation, no budget spent, same session.
{
  const roleConfig = {
    adapter: "opencode", model: "primary",
    fallbacks: [{adapter: "opencode", model: "fallback-one"}],
  };
  const fakeAgents = {opencode: {resume_session: ["--resume", "SID"]}};
  const s = {activeRoleModels: {}, sessions: {implementer: {sessionId: "sid-1"}}, failureBudgets: {}};
  const budgets = [];
  let calls = 0;
  const seen = [];
  const out = driveToSettled({
    s, roleName: "implementer", roleConfig, fakeAgents, budgets,
    spawnOnce: ({effective}) => {
      calls += 1;
      seen.push({...effective});
      return calls === 1 ? "RATE_LIMITED" : null;
    },
  });
  assert.equal(out.status, "completed", "retry must succeed");
  assert.equal(out.escalate, undefined, "no escalation on a switched-then-succeeded run");
  assert.deepEqual(budgets, [], "no failure budget spent (intermediate RATE_LIMITED never recorded)");
  assert.deepEqual(s.activeRoleModels.implementer, {adapter: "opencode", model: "fallback-one"},
    "state records the fallback active model");
  assert.deepEqual(seen[0], {adapter: "opencode", model: "primary"}, "first attempt uses the primary");
  assert.deepEqual(seen[1], {adapter: "opencode", model: "fallback-one"}, "re-run uses the fallback effective model");
  assert.equal(s.sessions.implementer?.sessionId, "sid-1", "same-session retry keeps the stored sid");
  const rule = decideRoleFallbackRetry({
    from: {adapter: "opencode", model: "primary"}, to: {adapter: "opencode", model: "fallback-one"}, resumeSupported: true,
  });
  assert.equal(rule.mode, "same-session", "same adapter + resume support resumes");
  assert.equal(rule.resume, true, "same-session retry resumes");
  console.log("PASS fake-adapter-rate-limited-once-then-succeeds");
}

// 4. Resume/new-session rule honoured: different adapter, or no resume
//    support, starts a new session (stored sid cleared, resume false).
{
  const diff = decideRoleFallbackRetry({
    from: {adapter: "opencode", model: "primary"}, to: {adapter: "claude", model: "other"}, resumeSupported: true,
  });
  assert.equal(diff.mode, "new-session", "adapter change starts a new session");
  assert.equal(diff.resume, false, "new-session retry does not resume");
  const noResume = decideRoleFallbackRetry({
    from: {adapter: "opencode", model: "primary"}, to: {adapter: "opencode", model: "fallback-one"}, resumeSupported: false,
  });
  assert.equal(noResume.mode, "new-session", "no resume support starts a new session");
  assert.equal(noResume.resume, false, "new-session retry does not resume");
  // Wiring clears the sid on the new-session path.
  const s = {activeRoleModels: {}, sessions: {implementer: {sessionId: "sid-1"}}};
  const retry = decideRoleFallbackRetry({
    from: {adapter: "opencode", model: "primary"}, to: {adapter: "claude", model: "other"}, resumeSupported: true,
  });
  if (!retry.resume && s.sessions) delete s.sessions.implementer;
  assert.equal(s.sessions.implementer, undefined, "new-session retry clears the stored sid");
  console.log("PASS resume-new-session-rule");
}

// 5. Exhausted fallbacks keep today's escalate-and-stop: no retry, the
//    RATE_LIMITED failure is returned (and recorded) as before.
{
  const roleConfig = {
    adapter: "opencode", model: "primary",
    fallbacks: [{adapter: "opencode", model: "fallback-one"}],
  };
  const fakeAgents = {opencode: {resume_session: ["--resume", "SID"]}};
  const s = {activeRoleModels: {implementer: {adapter: "opencode", model: "fallback-one"}}, sessions: {}, failureBudgets: {}};
  const budgets = [];
  const out = driveToSettled({
    s, roleName: "implementer", roleConfig, fakeAgents, budgets,
    spawnOnce: () => "RATE_LIMITED",
  });
  assert.equal(out.status, "failed", "exhausted fallbacks stay failed");
  assert.equal(out.escalate, true, "exhausted fallbacks escalate as today");
  assert.deepEqual(budgets, ["RATE_LIMITED"], "the returned RATE_LIMITED is recorded exactly once, as today");
  console.log("PASS exhausted-escalates-as-today");
}

// 6. Same-session only with a recorded sessionId: a RATE_LIMITED run with
//    no sessionId (rate-limited before a session was emitted, or the caller
//    asked resume:false) clears the stored sid and re-runs as a new session
//    instead of resuming a stale sid from an earlier run.
{
  // Mirror the runRelay gating exactly: same adapter + resume support still
  // forces resume:false when the failed attempt recorded no sessionId.
  const gate = (retry, sessionId) =>
    (retry?.resume === true && !sessionId)
      ? {...retry, mode: "new-session", resume: false}
      : retry;
  const sameAdapter = decideRoleFallbackRetry({
    from: {adapter: "opencode", model: "primary"},
    to: {adapter: "opencode", model: "fallback-one"},
    resumeSupported: true,
  });
  assert.equal(sameAdapter.resume, true, "rule alone allows same-session on matching adapter");
  const gatedNoSid = gate(sameAdapter, null);
  assert.equal(gatedNoSid.mode, "new-session", "no sessionId forces a new session");
  assert.equal(gatedNoSid.resume, false, "no sessionId re-runs with resume:false");
  const gatedWithSid = gate(sameAdapter, "sid-live");
  assert.equal(gatedWithSid.mode, "same-session", "recorded sessionId keeps same-session");
  assert.equal(gatedWithSid.resume, true, "recorded sessionId re-runs with resume:true");
  // Wiring clears the stale sid on the forced new-session path.
  const s = {sessions: {implementer: {sessionId: "sid-stale"}}};
  const forced = gate(sameAdapter, null);
  if (!forced.resume && s.sessions) delete s.sessions.implementer;
  assert.equal(s.sessions.implementer, undefined, "missing sessionId clears the stale stored sid");
  console.log("PASS no-session-id-forces-new-session");
}

// 7. Non-RATE_LIMITED never switches and never retries.
{
  const decision = decideRoleFallback({
    role: "implementer",
    roleConfig: {adapter: "opencode", model: "primary", fallbacks: [{adapter: "opencode", model: "fallback-one"}]},
    activeModel: null, failureClass: "TIMEOUT",
  });
  assert.equal(decision.action, "none", "non-RATE_LIMITED never switches");
  console.log("PASS non-rate-limited-untouched");
}

console.log("test-role-fallback-wiring: all cases passed");
