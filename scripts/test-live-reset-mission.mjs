#!/usr/bin/env node
// F2 (live half) — end-to-end proof that `ap reset` applies INSIDE a running
// mission, at the failure decision, and buys the extra attempt it promises.
//
// Method: a real `ap run` subprocess against the fake adapter, on a scenario
// that fails the plan reviewer with a RETRYABLE INFRASTRUCTURE failure every
// time (`plan_review_infra_retryable_always`). Infrastructure-domain failures
// always scope to the shared literal `mission`, so the counter key is
// predictable: `infrastructureRetryBudget:mission` (note: the KEY carries the
// budget name; `lastFailureBudget.scope` alone is just `mission`).
//
// With the default limit of 2:
//   control (no request):  failure 1 -> used 1, retry | failure 2 -> used 2, escalate => 2 relays
//   armed (request queued): failure 1 -> nothing to clear yet, request stays QUEUED, used 1, retry
//                           failure 2 -> LIVE RESET clears 1 -> used 1, retry
//                           failure 3 -> used 2, escalate                          => 3 relays
//
// The relay count is therefore the discriminator, and `lastReset.appliedLive`
// plus the consumed request file are the mechanism — asserted, not inferred.
//
// The escalation is asserted by its MESSAGE, not by `state.step`: the
// planning-review path leaves `step: "standalone-plan"` and reports the cause in
// the die() text (a naming gap noted in the mission report, not this test's job).
//
// Backlog #56 (live reset-request QUEUE, scripts/reset-request-queue.mjs): the
// side channel used to hold ONE request, so a second `ap reset` for another
// budget key clobbered the first while a run was live. Two cases below the
// legacy one prove the queue end-to-end:
//   (a) ONE queue holding two requests for DIFFERENT keys —
//       `infrastructureRetryBudget:mission` (scope `mission`) and
//       `adapterRetryBudget:adapter:cursor:plan_reviewer` (scope
//       `adapter:cursor:plan_reviewer`, the plan_reviewer's own adapter key
//       under the fixture's `cursor` adapter). The first mission fails in the
//       INFRASTRUCTURE domain, so only that request matches and applies (its
//       own log line, its own lastReset); the adapter request must stay QUEUED
//       — never clobbered, never applied. A second mission in the SAME repo,
//       switched to `plan_review_adapter_retryable_always` (resume pattern from
//       scripts/test-planning-review-resume.mjs), fails in the ADAPTER domain
//       and applies the still-queued adapter reset by its own log line. Each
//       run's reviewer relay count proves its own extra attempt.
//   (b) a same-scope DECOY — `implementationFailureBudget:mission`, a key no
//       scenario records (used 0) — queued IN FRONT of the matching
//       infrastructure request: the applier must not stop at the first
//       same-scope entry, and the decoy must survive queued.
import fs from "node:fs";
import path from "node:path";
import {
  makeFixtureRepo, makeFixtureBin, writeConfig, setScenario, runAutopilot, readObservedEvents, cleanup
} from "./test-fixtures/workflow-order-harness.mjs";
import {renderWatchReport} from "./run-history.mjs";
import {enqueueResetRequest, readResetRequests} from "./reset-request-queue.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

const KEY = "infrastructureRetryBudget:mission";   // the failureBudgets key
const SCOPE = "mission";                            // lastFailureBudget.scope
// The plan_reviewer's OWN adapter key: a failure-budget key is
// `<budgetName>:<scope>` and an adapter-domain failure scopes to
// `adapter:<adapter>:<role>` — the fixture adapter is `cursor` (cf.
// scripts/test-planning-review-resume.mjs's XB1 assertions).
const ADAPTER_KEY = "adapterRetryBudget:adapter:cursor:plan_reviewer";
const ADAPTER_SCOPE = "adapter:cursor:plan_reviewer";
// A decoy sharing the infrastructure scope but a key NO scenario records, so
// its counter never leaves 0 and the request must never be applied.
const DECOY_KEY = "implementationFailureBudget:mission";
// The escalation MESSAGE uses the budget NAME, not the key: `recordFailureBudget`
// returns `budget: "infrastructureRetryBudget"` and the die() text is
// "<budget> exhausted (used/limit)". The key (name:scope) is what `failureBudgets`
// is keyed by and what `ap reset` targets — the two forms are genuinely different.
const EXHAUSTED = "infrastructureRetryBudget exhausted (2/2)";
const EXHAUSTED_ADAPTER = "adapterRetryBudget exhausted (2/2)";
const TIMEOUT_MS = process.platform === "win32" ? 240000 : 120000;

function setup(prefix) {
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  // Both budgets at 2: the queue case's second mission fails the reviewer in
  // the ADAPTER domain, so that key needs a real (small) limit too.
  writeConfig(repo, {planningFramework: "standalone", failureBudgets: {infrastructureRetryBudget: 2, adapterRetryBudget: 2}});
  setScenario(repo, "plan_review_infra_retryable_always");
  return {repo, binDir};
}
function readState(repo){ return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8")); }
function requestPath(repo){ return path.join(repo, ".autopilot", "reset-request.json"); }
function reviewerRelays(repo){ return readObservedEvents(repo).filter(e => e.role === "plan_reviewer").length; }
function combined(r){ return `${r.stdout || ""}${r.stderr || ""}`; }
// How many `live reset applied for '<key>'` lines one run printed — each key is
// applied at most once per run, and only its own key's line may appear.
function resetLogLines(output, key){ return output.split(`live reset applied for '${key}'`).length - 1; }
// Seed ONE queue through the real enqueue path — exactly what two `ap reset`
// commands leave on disk — rather than hand-writing the file (the same-key
// dedupe is driven by the real enqueueResetRequest in
// scripts/test-reset-request-queue.mjs, so it is not re-proven here).
function queueResetRequests(repo, entries) {
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  const at = new Date().toISOString();
  for (const {key, scope} of entries) enqueueResetRequest(requestPath(repo), {key, scope, at, requestedBy: "test"});
}

const created = [];
function track(ctx){ created.push(ctx.repo, ctx.binDir); return ctx; }

try {
  // ---- control: no request -> 2 relay attempts, then escalation ------------
  let controlRelays = null;
  {
    const {repo, binDir} = track(setup("live-reset-control"));
    const run = runAutopilot(repo, binDir, {request: "live reset control", timeoutMs: TIMEOUT_MS});
    const state = readState(repo);
    const output = combined(run);
    controlRelays = reviewerRelays(repo);
    check("control: the mission escalates naming the exhausted infrastructure budget",
      run.status !== 0 && output.includes(EXHAUSTED),
      {status: run.status, tail: output.slice(-400)});
    check("control: no reset is recorded and no request file exists",
      !("lastReset" in state) && !fs.existsSync(requestPath(repo)), {lastReset: state.lastReset});
    check("control: exactly the two budgeted attempts ran",
      controlRelays === 2 && state.lastFailureBudget?.used === 2 && state.lastFailureBudget?.limit === 2,
      {relays: controlRelays, budget: state.lastFailureBudget});
  }

  // ---- armed: the request is honoured live and buys one more attempt -------
  {
    const {repo, binDir} = track(setup("live-reset-armed"));
    fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
    fs.writeFileSync(requestPath(repo), JSON.stringify({key: KEY, scope: SCOPE, at: new Date().toISOString(), requestedBy: "test"}));

    const run = runAutopilot(repo, binDir, {request: "live reset armed", timeoutMs: TIMEOUT_MS});
    const state = readState(repo);
    const relays = reviewerRelays(repo);
    const output = combined(run);

    check("armed: the running mission applied the reset (log line present)",
      output.includes(`live reset applied for '${KEY}'`), output.slice(-600));
    check("armed: state records it as a LIVE application for the right key and count",
      state.lastReset?.appliedLive === true && state.lastReset?.scope === KEY && state.lastReset?.clearedUsed === 1,
      state.lastReset);
    check("armed: the request file was consumed", !fs.existsSync(requestPath(repo)));
    check("armed: the reset bought exactly one extra reviewer attempt",
      relays === controlRelays + 1, {armed: relays, control: controlRelays});
    check("armed: the mission still escalates afterwards (a reset is not immortality)",
      run.status !== 0 && output.includes(EXHAUSTED), {status: run.status, tail: output.slice(-400)});
    check("armed: the escalation is PERSISTED, not just printed (planning branch used to leave step:standalone-plan)",
      state.phase === "escalated" && state.step === "infrastructureRetryBudget_exhausted",
      {phase: state.phase, step: state.step});

    // Chain check: the counter was zeroed by the RUNNING mission, so the watch
    // report must carry that fact — not merely the log line and state.json. The
    // live path reads the limit from policy, so the count renders like the idle
    // path's.
    const report = renderWatchReport(repo, state.mission || "mission", {tail: 5});
    check("armed: the WATCH REPORT shows the live reset under Events, after the counter was zeroed",
      report.includes("Events:") && report.includes(`operator reset retries (${KEY})`),
      report.slice(0, 700));
  }

  // ---- queue (backlog #56, case a): ONE queue, two keys, one scope each ---
  {
    const {repo, binDir} = track(setup("live-reset-queue"));
    queueResetRequests(repo, [
      {key: KEY, scope: SCOPE},
      {key: ADAPTER_KEY, scope: ADAPTER_SCOPE}
    ]);

    const run = runAutopilot(repo, binDir, {request: "live reset queue", timeoutMs: TIMEOUT_MS});
    const state = readState(repo);
    const relays = reviewerRelays(repo);
    const output = combined(run);
    const queued = readResetRequests(requestPath(repo));

    check("queue: the infrastructure reset is applied live, by its OWN log line, exactly once",
      resetLogLines(output, KEY) === 1 && resetLogLines(output, ADAPTER_KEY) === 0, output.slice(-600));
    check("queue: state.lastReset records the infrastructure application",
      state.lastReset?.appliedLive === true && state.lastReset?.scope === KEY && state.lastReset?.clearedUsed === 1,
      state.lastReset);
    check("queue: the not-yet-matching adapter request survives QUEUED (file exists, holds only its key)",
      fs.existsSync(requestPath(repo)) && queued.length === 1 && queued[0]?.key === ADAPTER_KEY && queued[0]?.scope === ADAPTER_SCOPE,
      {exists: fs.existsSync(requestPath(repo)), queued});
    check("queue: the infrastructure reset bought exactly one extra reviewer attempt",
      relays === controlRelays + 1, {relays, control: controlRelays});
    check("queue: the mission still escalates afterwards (the queued adapter reset cannot help this domain)",
      run.status !== 0 && output.includes(EXHAUSTED), {status: run.status, tail: output.slice(-400)});

    // Second mission in the SAME repo (resume pattern from
    // scripts/test-planning-review-resume.mjs): switch the scenario to the
    // adapter-domain shape and run a NEW request, so the still-queued adapter
    // request finally meets its own decision point. readObservedEvents is
    // repo-wide, so relay counts are deltas over this mission's predecessors.
    const relaysAfterInfra = relays;
    setScenario(repo, "plan_review_adapter_retryable_always");
    const run2 = runAutopilot(repo, binDir, {request: "live reset queue adapter", timeoutMs: TIMEOUT_MS});
    const state2 = readState(repo);
    const relays2 = reviewerRelays(repo) - relaysAfterInfra;
    const output2 = combined(run2);

    check("queue: the second mission escalates naming the exhausted adapter budget",
      run2.status !== 0 && output2.includes(EXHAUSTED_ADAPTER), {status: run2.status, tail: output2.slice(-400)});
    check("queue: the adapter reset is applied live, by its OWN log line, exactly once",
      resetLogLines(output2, ADAPTER_KEY) === 1 && resetLogLines(output2, KEY) === 0, output2.slice(-600));
    check("queue: state.lastReset records the adapter application",
      state2.lastReset?.appliedLive === true && state2.lastReset?.scope === ADAPTER_KEY && state2.lastReset?.clearedUsed === 1,
      state2.lastReset);
    check("queue: the adapter reset also bought exactly one extra reviewer attempt",
      relays2 === controlRelays + 1, {relays2, control: controlRelays});
    check("queue: the queue file is gone once its last applied key was consumed",
      !fs.existsSync(requestPath(repo)));
  }

  // ---- queue (backlog #56, case b): a same-scope DECOY must not block -----
  {
    const {repo, binDir} = track(setup("live-reset-decoy"));
    // The decoy is queued IN FRONT of the matching request: the applier must
    // not stop at the first same-scope entry, and must not consume an entry
    // whose counter has never been recorded.
    queueResetRequests(repo, [
      {key: DECOY_KEY, scope: SCOPE},
      {key: KEY, scope: SCOPE}
    ]);

    const run = runAutopilot(repo, binDir, {request: "live reset decoy", timeoutMs: TIMEOUT_MS});
    const state = readState(repo);
    const relays = reviewerRelays(repo);
    const output = combined(run);
    const queued = readResetRequests(requestPath(repo));

    check("decoy: only the infrastructure reset is applied, by its own log line",
      resetLogLines(output, KEY) === 1 && resetLogLines(output, DECOY_KEY) === 0, output.slice(-600));
    check("decoy: state.lastReset is the infrastructure key",
      state.lastReset?.appliedLive === true && state.lastReset?.scope === KEY && state.lastReset?.clearedUsed === 1,
      state.lastReset);
    check("decoy: the decoy stays queued (file exists, holds exactly that key, never applied)",
      fs.existsSync(requestPath(repo)) && queued.length === 1 && queued[0]?.key === DECOY_KEY && queued[0]?.scope === SCOPE,
      {exists: fs.existsSync(requestPath(repo)), queued});
    check("decoy: the reset still bought exactly one extra reviewer attempt",
      relays === controlRelays + 1, {relays, control: controlRelays});
    check("decoy: the mission still escalates afterwards",
      run.status !== 0 && output.includes(EXHAUSTED), {status: run.status, tail: output.slice(-400)});
  }
} finally {
  cleanup(...created);
}

if (failures) {
  console.error(`${failures} live-reset check(s) failed.`);
  process.exit(1);
}
console.log("test-live-reset-mission: ALL CHECKS PASSED");
