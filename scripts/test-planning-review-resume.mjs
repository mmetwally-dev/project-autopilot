#!/usr/bin/env node
// TASK-14 Phase 2+3 — planning-review attempt-failure wiring for all four
// call sites (standalone plan-review loop, SpecKit initial gate review,
// SpecKit post-revision re-review, reviewExistingPlanning) plus the
// cross-mission budget-lifetime, escalation-message, and policy-violation
// regressions.
//
// Drives real `node scripts/autopilot.mjs run ...` subprocesses
// the same way test-phase-stage-resume.mjs does — never by importing
// `autopilot.mjs` (it runs `main()` at import with no guard) — against the
// shared fake-adapter ecosystem (fake-workflow-adapter.sh, scenario-driven
// via a committed `.autopilot/.autopilot-test-scenario` file, plus
// workflow-order-harness.mjs helpers). Every behavioral case asserts the
// observed role-launch sequence / exit code / persisted budget record
// reconstructed from the orchestrator's own result.json files and state.json
// — never prompt wording.
//
// Cases (standalone call site 1, then SpecKit call site 2):
//   S1. Infra-retryable failure retries the reviewer only (no planner
//       relaunch), preceded by a persisted budget record, with a real
//       (non-no-op) retry delay — the one case run with nonzero
//       policy.retry_delay_ms, proving retryDelay() was called and waited.
//   S2. Non-retryable infra failure escalates immediately, naming
//       class+domain (new behavior at these two sites — pinned explicitly).
//   S3. An output-contract failure (missing sentinel) still consumes a
//       revision and re-invokes the planner, unchanged, with nothing recorded.
//   S4. A genuine functional FAIL is unaffected (revision + planner
//       re-invocation, planning passes, nothing recorded — stopped right
//       after planning passes; S1 already proves end-to-end completion).
//   K1-K4. The same four shapes at the SpecKit initial gate review.
// Call site 3 (SpecKit post-revision re-review — zero revisions left here):
//   R1. Infra-retryable failure retries the reviewer only (no second
//       revision: planner ran exactly initial + one revision), preceded by
//       a persisted budget record, with a real retry delay (second nonzero
//       retry_delay_ms proof). Stopped right after the re-review PASS.
//   R2. Non-retryable infra failure escalates unchanged, naming
//       class+domain; reviewer ran initial + re-review only (no retry).
//   R3. Output-contract failure (missing/malformed sentinel) escalates
//       unchanged with the pre-existing message, nothing recorded.
//   R4. Policy violation at the re-review dies immediately with the
//       policy message, no retry, nothing recorded.
// Call site 4 (reviewExistingPlanning — immediate die, no revision, for
// functional/output-contract outcomes regardless of framework):
//   E1. Infra-retryable failure retries at "complete" standalone status
//       (no-request run against a pre-seeded complete mission); planner
//       ran zero times; stopped right after the review PASS.
//   E2. The same at "partial" SpecKit status (an earlier draft only
//       covered complete-state).
//   E3. An output-contract failure (missing/malformed sentinel) also
//       escalates immediately, exactly like the functional-FAIL case —
//       asserted as its own case, never inferred from R3.
//   E4. GSD regression: framework "gsd" with a RETRYABLE infra failure
//       still hard-escalates with zero retry and zero budget recorded
//       (the sole evidence backing "GSD untouched").
// Cross-mission budget lifetime (a new mission starts with cleared failure
// counters via clearInheritedFailureCounters — retry available from the
// start — while `ap cancel` itself keeps them and same-mission resume keeps
// accumulating in the same repo state):
//   XA. Shared infrastructure budget exhausted by a prior mission is
//       cleared for the new mission, so it retries once then re-exhausts
//       fresh (two reviewer calls: fail + retry, escalation naming
//       class+domain+exhaustion, budget back at the limit).
//   XB1. The same for the adapter budget under plan_reviewer's own
//       adapter:<adapter>:plan_reviewer key (cleared: fail + retry, then
//       fresh exhaustion).
//   XB2. An exhausted adapter budget under a DIFFERENT role's key
//       (adapter:<adapter>:implementer) is cleared for the new mission too,
//       so plan_reviewer's own adapter retry proceeds on a fresh key (two
//       reviewer calls: fail + retry) and the implementer key is absent,
//       not still exhausted.
// Policy violations (one live case per call site — all four route through
// the same helper, pinned statically too):
//   P1 (site 1), P2 (site 2), R4 (site 3), E5 (site 4): each dies
//       immediately with the policy message, no retry attempted, no
//       infra/adapter budget touched.
// Plus static contract checks: the retried reviewer call uses a fresh
// session (resume:false), the delay derivation is budget.used+1 (never
// s.attempt, never budget.used alone), recording goes through
// recordAttemptFailure() (never enforceAttemptFailure(), never
// recordFailureBudget() directly), call site 4 is gated by the positive
// allowlist predicate (never a negative framework check), and the
// allowlist predicate itself is unit-tested in
// test-planning-review-decision.mjs (a real `ap run` can never reach
// reviewExistingPlanning() with a malformed framework value, so a
// subprocess test of that case would prove nothing).
//
// Runtime budget (binding per the task brief): a full fixture mission costs
// minutes on a slow box (~25s orchestrator-side overhead per relay here, so
// a 6-relay standalone completion is ~3min and a Speckit completion longer),
// so this file (a) calibrates once — the S2 escalation probe doubles as the
// measured baseline its own assertions are read off, and every other
// mission's subprocess timeout is derived from that measurement with
// headroom (8x, i.e. >= 2x a single observed run — never a fixed 3
// minutes); (b) reads several assertions off each single mission run
// instead of re-spawning per case; (c) runs the wave of independent
// scenarios concurrently, with the three cross-mission pairs pipelined
// into the same wave (each pair's second mission starts the moment its
// own first mission resolves, not after the whole wave); (d)
// stops R1/E1/E2/K1/S4/XB2-M2 as soon as planning passes
// (their assertions only need the planning phase) instead of running full
// completions, keeping S1's full run as the one end-to-end proof.
// Measured wall clock on this box is ~8 minutes for the ~80 relays the
// mandated cases require (17 new missions on top of task 7's eight —
// every mechanism above is applied, and no case can share a mission with
// another since the scenario selector is repo-global); the "about 5
// minutes" task-7 calibration predates this file's tripled case count.
// A long runtime here is expected and is NOT a hang.
import fs from "node:fs";
import path from "node:path";
import {spawn} from "node:child_process";
import {
  makeFixtureRepo, makeFixtureBin, makeSpecKitPhaseFixture, makeGsdPhaseFixture,
  writeConfig, setScenario, readObservedEvents, cleanup, skillRoot, withoutOuterGitGuard
} from "./test-fixtures/workflow-order-harness.mjs";
import {runTreeUntilMarker} from "./test-fixtures/posix-process-runner.mjs";
import {callsWithOptions, importNames, bodyAfter, callArgs} from "./test-fixtures/source-scan.mjs";


const FILE_T0 = Date.now();
// Hang backstop for the single calibration run only — not a mission
// timeout. Every assertion-bearing timeout below (FULL_TIMEOUT_MS) is
// derived from the calibration measurement with headroom.
// Backlog #27: this file spawns real missions; under a loaded box its
// subprocess waits can exceed the derived wall clocks. `test-all` sets
// AP_TEST_TIMEOUT_FACTOR (default 2) so every timeout scales together;
// standalone runs keep factor 1 unless the operator sets it.
const TIMEOUT_FACTOR = (() => {
  const value = Number(process.env.AP_TEST_TIMEOUT_FACTOR);
  return Number.isFinite(value) && value > 0 ? value : 1;
})();
const PROBE_CEILING_MS = Math.ceil(600000 * TIMEOUT_FACTOR);
const REQUEST = "fixture request";

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

function readState(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
}

function roleCounts(repo) {
  const counts = {};
  for (const e of readObservedEvents(repo)) counts[e.role] = (counts[e.role] || 0) + 1;
  return counts;
}

// Full parsed result.json payloads for one role, oldest first.
function roleResults(repo, role) {
  const out = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "result.json") {
        try {
          const data = JSON.parse(fs.readFileSync(full, "utf8"));
          if (data.role === role) out.push(data);
        } catch { /* ignore */ }
      }
    }
  })(path.join(repo, ".autopilot"));
  out.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || Date.parse(a.finishedAt) - Date.parse(b.finishedAt));
  return out;
}

function budgetKeys(repo) {
  try {
    return readState(repo).failureBudgets || {};
  } catch {
    return {};
  }
}

// Cross-mission cases run two missions in one repo state, so role launches
// must be scoped to one mission's own run ledger
// (.autopilot/missions/<mission>/runs/...) instead of repo-wide —
// readObservedEvents()/roleCounts() above would merge both missions.
function missionDirs(repo) {
  const root = path.join(repo, ".autopilot", "missions");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, {withFileTypes: true})
    .filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

function missionRoleCounts(repo, mission) {
  const counts = {};
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "result.json") {
        try {
          const data = JSON.parse(fs.readFileSync(full, "utf8"));
          counts[data.role] = (counts[data.role] || 0) + 1;
        } catch { /* ignore */ }
      }
    }
  })(path.join(repo, ".autopilot", "missions", mission));
  return counts;
}

function missionRoleResults(repo, mission, role) {
  const out = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "result.json") {
        try {
          const data = JSON.parse(fs.readFileSync(full, "utf8"));
          if (data.role === role) out.push(data);
        } catch { /* ignore */ }
      }
    }
  })(path.join(repo, ".autopilot", "missions", mission));
  out.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || Date.parse(a.finishedAt) - Date.parse(b.finishedAt));
  return out;
}

// writeConfig() pins retry_delay_ms: 0; exactly one case (the retryDelay
// proof, S1) overrides it to a small nonzero value afterwards.
function setRetryDelayMs(repo, ms) {
  const configPath = path.join(repo, ".autopilot", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.policy = config.policy || {};
  config.policy.retry_delay_ms = ms;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function setupStandalone(prefix, scenario, {maxPlanRevisions = 3, retryDelayMs = 0, failureBudgets = {}} = {}) {
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  writeConfig(repo, {planningFramework: "standalone", maxPlanRevisions, failureBudgets});
  if (retryDelayMs) setRetryDelayMs(repo, retryDelayMs);
  setScenario(repo, scenario);
  return {repo, binDir};
}

function setupSpeckit(prefix, scenario, {maxPlanRevisions = 3, retryDelayMs = 0, failureBudgets = {}} = {}) {
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  makeSpecKitPhaseFixture(repo);
  writeConfig(repo, {planningFramework: "speckit", maxPlanRevisions, failureBudgets});
  if (retryDelayMs) setRetryDelayMs(repo, retryDelayMs);
  setScenario(repo, scenario);
  return {repo, binDir};
}

// A pre-seeded COMPLETE standalone mission plus seeded state so a
// no-request `ap run --repo` resolves that mission and takes the
// reviewExistingPlanning() path (a fresh `ap run <request>` is always a
// NEW planning request and would plan from scratch instead). The TASKS.md
// is fully checked, which is standalone.state()'s own "complete"
// definition.
function setupStandaloneComplete(prefix, scenario) {
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  writeConfig(repo, {planningFramework: "standalone", maxPlanRevisions: 3});
  const missionDir = path.join(repo, ".autopilot", "missions", "001-fixture-feature");
  fs.mkdirSync(missionDir, {recursive: true});
  fs.writeFileSync(path.join(missionDir, "PLAN.md"), "# Plan\n\nObjective: fixture task.\n");
  fs.writeFileSync(path.join(missionDir, "TASKS.md"),
    "## Phase 1: General\n\n- [x] Do the fixture task — accept: done ; verify: none <!-- autopilot-requires: nothing -->\n");
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
    version: 1, phase: "idle", step: "idle",
    planningRequest: "fixture request", mission: "001-fixture-feature", missionSeq: "001"
  }));
  setScenario(repo, scenario);
  return {repo, binDir};
}

// A pre-seeded PARTIAL SpecKit feature (spec.md only — no plan.md/tasks.md,
// which is specKitState()'s own "partial" definition) plus the workflow
// file, so a no-request run validates the completed portion via
// reviewExistingPlanning() instead of planning from scratch.
function setupSpeckitPartial(prefix, scenario) {
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  makeSpecKitPhaseFixture(repo);
  const featureDir = path.join(repo, "specs", "002-partial-feature");
  fs.mkdirSync(featureDir, {recursive: true});
  fs.writeFileSync(path.join(featureDir, "spec.md"), "# Spec\n\nPartial fixture feature.\n");
  writeConfig(repo, {planningFramework: "speckit", maxPlanRevisions: 3});
  setScenario(repo, scenario);
  return {repo, binDir};
}

function setupGsd(prefix, scenario) {
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  makeGsdPhaseFixture(repo);
  writeConfig(repo, {planningFramework: "gsd", maxPlanRevisions: 3});
  setScenario(repo, scenario);
  return {repo, binDir};
}

function missionEnv(binDir) {
  const delimiter = process.platform === "win32" ? ";" : ":";
  // Fixture missions run their own git guard; inherit none from an outer
  // mission (the orchestrator gate runs this file under its guard), or the
  // fixture's blocked attempts are classified "unproven" (backlog #49).
  const base = withoutOuterGitGuard(process.env);
  return {...base, PATH: `${binDir}${delimiter}${base.PATH || ""}`};
}

function autopilotArgs(repo) {
  return [path.join(skillRoot, "scripts", "autopilot.mjs"), "run", REQUEST, "--repo", repo];
}

// No explicit request text: this is what makes ensurePlanningReady() take
// the reviewExistingPlanning() path against a pre-seeded complete/partial
// fixture instead of starting new planning (classifyPlanningRequest maps
// an empty request to a resume).
function autopilotArgsNoRequest(repo) {
  return [path.join(skillRoot, "scripts", "autopilot.mjs"), "run", "--repo", repo];
}

// Cross-mission pairs (task 11) run two DIFFERENT requests in one repo
// state so the second is a genuinely new mission (new mission dir) that
// starts with cleared failure counters (clearInheritedFailureCounters resets
// failureBudgets at each new-mission start, so the retry budget is
// available again).
function autopilotArgsRequest(repo, request) {
  return [path.join(skillRoot, "scripts", "autopilot.mjs"), "run", request, "--repo", repo];
}

// Async variant of the harness's (blocking) runAutopilot, so independent
// scenarios can run concurrently. Same shape:
// {status, signal, timedOut, stdout, stderr}.
function runMissionAsync(repo, binDir, {timeoutMs, args = null}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args || autopilotArgs(repo), {
      cwd: repo, env: missionEnv(binDir), stdio: ["ignore", "pipe", "pipe"], shell: false
    });
    let stdout = "", stderr = "", timedOut = false, settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => finish({status: null, signal: null, timedOut, stdout, stderr, error: String(e && e.message || e)}));
    child.on("close", (code, signal) => finish({status: code, signal, timedOut, stdout, stderr}));
  });
}

// ---------------------------------------------------------------------
// Static contract checks: recording authority, delay derivation, session
// semantics, fixture mechanism. These pin call semantics (which function,
// which argument), never prompt wording.
// ---------------------------------------------------------------------
const autopilotSrc = fs.readFileSync(path.join("scripts", "autopilot.mjs"), "utf8");
{
  // The shared helper exists and both call sites route through it with
  // distinct task scopes.
  check("contract: resolvePlanningReviewAttempt defined", autopilotSrc.includes("async function resolvePlanningReviewAttempt"));
  check("contract: standalone call site scope", autopilotSrc.includes('"standalone-plan-review"'));
  check("contract: speckit call site scope", autopilotSrc.includes('"speckit-gate-review"'));

  // Recording authority inside the helper (comment-stripped so the docblock
  // naming the forbidden functions does not false-positive): exactly one
  // recordAttemptFailure() call, never enforceAttemptFailure(), never the
  // lower-level recordFailureBudget() directly.
  // The helper body moved into planning-review-wiring.mjs (commit 023d992);
  // autopilot.mjs keeps a thin wrapper that only injects I/O. Pin the
  // wrapper's delegation, then read the real body from the module (its
  // parameters are named config/state there, not c/s).
  const wiringSrc = fs.readFileSync(path.join("scripts", "planning-review-wiring.mjs"), "utf8").replace(/\r\n/g, "\n");
  check("contract: autopilot.mjs wrapper delegates to the wiring module",
    /async function resolvePlanningReviewAttempt\([^)]*\)\{\s*return resolvePlanningReviewAttemptWired\(c,s,taskScope,reviewResult,rerunReviewer,/.test(autopilotSrc.replace(/\r\n/g, "\n")));
  const helperStart = wiringSrc.indexOf("export async function resolvePlanningReviewAttempt(");
  const helperEnd = wiringSrc.indexOf("\n}\n", helperStart);
  const helperCode = wiringSrc.slice(helperStart, helperEnd).replace(/\/\/.*$/gm, "");
  check("contract: helper records via recordAttemptFailure()",
    /\brecordAttemptFailure\s*\(\s*config\s*,\s*state\s*,\s*taskScope\s*,\s*\[current\]\s*,\s*null\b/.test(helperCode), helperCode.slice(0, 400));
  check("contract: helper never calls enforceAttemptFailure()",
    !/\benforceAttemptFailure\s*\(/.test(helperCode));
  check("contract: helper never calls recordFailureBudget() directly",
    !/\brecordFailureBudget\s*\(/.test(helperCode));
  check("contract: helper decides via decidePlanningReview(recorded)",
    helperCode.includes("decidePlanningReview(recorded)"));

  // Delay derivation: budget.used + 1 (the upcoming attempt ordinal), never
  // s.attempt, never budget.used alone.
  check("contract: retry waits retryDelay(config, budget.used + 1)",
    helperCode.includes("retryDelay(config,recorded.budget.used+1)"));
  check("contract: helper never derives the delay from state.attempt",
    !helperCode.includes("state.attempt") && !helperCode.includes("s.attempt"));

  // Classify-before-record against the task 1 passthrough set (imported, not
  // duplicated).
  check("contract: helper imports the task 1 passthrough set",
    wiringSrc.includes("PLANNING_REVIEW_PASSTHROUGH_CLASSES"));
  check("contract: helper pre-classifies before recording",
    helperCode.includes("PLANNING_REVIEW_PASSTHROUGH_SET.has(current.failure?.class)"));

  // Session semantics: the standalone retry re-invokes the reviewer with an
  // explicit fresh session; the SpecKit path reuses review(), which already
  // passes resume:false by construction.
  // The closure keeps resume:false; trailing relay options (e.g. the
  // planRevision scope field) may be appended after taskRef.
  // Retry closures: an arrow wrapping the relayAsync call (`()=>relayAsync("plan_reviewer",...)`)
  // whose options carry resume:false plus the read-only review shape; other options tolerated.
  const retryClosures = callsWithOptions(autopilotSrc, 'relayAsync("plan_reviewer",', ["readOnly:true", "review:true", "resume:false", "capEnabled:true", "taskRef:'standalone-planning-plan_reviewer'"])
    .filter((call) => autopilotSrc.includes("()=>" + call));
  check("contract: standalone retry uses a fresh session (resume:false)",
    retryClosures.length >= 1);
  check("contract: review() helper passes resume:false",
    /return relay\(reviewer,task\+\(feedback\?[^)]*\),c,s,\{readOnly:true,review:true,resume:false/.test(autopilotSrc));

  // Escalation names the failure's class and domain.
  check("contract: escalation message carries class and domain",
    helperCode.includes("recorded.failure.class") && helperCode.includes("recorded.failure.domain"));
}

// ---------------------------------------------------------------------
// Static contract checks for call sites 3-4: same helper, same recording
// authority, same delay derivation (the helper block above already pins
// the semantics — here each site is pinned to actually route through it),
// plus call site 4's positive allowlist gating.
// ---------------------------------------------------------------------
{
  // All four call sites route through the shared helper with distinct
  // task scopes.
  const sites = (autopilotSrc.match(/await resolvePlanningReviewAttempt\(c,s,/g) || []).length;
  // Four call sites plus the SpecKit gate confirmation full review (a fifth
  // reviewer call routed through the same helper).
  check("contract: all four call sites (+ SpecKit confirmation review) route through resolvePlanningReviewAttempt", sites === 5, {sites});
  check("contract: post-revision re-review scope", autopilotSrc.includes('"speckit-gate-review"'));
  check("contract: existing-planning scope", autopilotSrc.includes('"existing-planning-review"'));

  // Call site 3 re-invokes the SAME re-review prompt (review() already
  // passes resume:false by construction — pinned above) and escalates
  // with a re-review prefix naming class/domain via the helper.
  check("contract: re-review prompt hoisted for the retry closure",
    autopilotSrc.includes("const reReviewPrompt=`Re-review the SpecKit gate"));
  check("contract: re-review retries via the same capped reviewer call",
    autopilotSrc.includes("()=>runCappedReview(reReviewPrompt)"));

  // Call site 4: positive allowlist gating — never a negative check.
  check("contract: decision module exports the allowlist predicate",
    autopilotSrc.includes("isPlanningReviewRetryFramework"));
  const reviewExistingStart = autopilotSrc.indexOf("async function reviewExistingPlanning");
  const reviewExistingEnd = autopilotSrc.indexOf("\n}\n", reviewExistingStart);
  const reviewExistingCode = autopilotSrc.slice(reviewExistingStart, reviewExistingEnd).replace(/\/\/.*$/gm, "");
  check("contract: call site 4 gated by the positive allowlist",
    reviewExistingCode.includes("isPlanningReviewRetryFramework(framework)"));
  check("contract: call site 4 never uses a negative framework check",
    !reviewExistingCode.includes('framework!=="gsd"') && !reviewExistingCode.includes("framework !== \"gsd\""));
  check("contract: call site 4 retry re-invokes the same reviewer closure",
    reviewExistingCode.includes("runReview,") && reviewExistingCode.includes("const runReview=()=>relayAsync(\"plan_reviewer\""));
  // relayAsync's own default is resume:false (fresh session), so the
  // closure above retries with a fresh session without restating it.
  check("contract: relayAsync defaults to a fresh session (resume:false)",
    /const \{cwd=repo,readOnly=false,resume=false/.test(autopilotSrc));
  // GSD's path is byte-for-byte today's behavior: policy check then the
  // unchanged die — the helper (recording, retry, budget) is unreachable.
  check("contract: GSD keeps the unchanged policy check + die",
    reviewExistingCode.includes("} else if(rr.policyViolation)"));
}

const shSrc = fs.readFileSync(path.join("scripts", "test-fixtures", "fake-workflow-adapter.sh"), "utf8");
const winSrc = fs.readFileSync(path.join("scripts", "test-fixtures", "fake-workflow-adapter-win.mjs"), "utf8");
{
  for (const scenario of ["plan_review_infra_retryable", "plan_review_infra_non_retryable"]) {
    check(`fixture: sh adapter handles ${scenario}`, shSrc.includes(scenario));
    check(`fixture: win adapter handles ${scenario}`, winSrc.includes(scenario));
  }
  // Phase 3 position-specific scenarios: the re-review, existing-planning,
  // always-fail, adapter-failure, and policy-violation shapes.
  for (const scenario of [
    "plan_review_infra_retryable_always", "plan_review_adapter_retryable_always",
    "plan_review_adapter_retryable_second",
    "plan_review_policy_violation",
    "speckit_rereview_infra_retryable", "speckit_rereview_infra_non_retryable",
    "speckit_rereview_output_contract", "speckit_rereview_policy_violation",
    "existing_planning_infra_retryable", "existing_planning_infra_retryable_always",
    "existing_planning_output_contract", "existing_planning_policy_violation",
    "implementer_adapter_retryable_always",
  ]) {
    check(`fixture: sh adapter handles ${scenario}`, shSrc.includes(scenario));
    check(`fixture: win adapter handles ${scenario}`, winSrc.includes(scenario));
  }
  check("fixture: win adapter ports both scenarios", /plan_review_infra_retryable/.test(winSrc) && /plan_review_infra_non_retryable/.test(winSrc)
    && winSrc.includes("PORTED_SCENARIOS"));
  check("fixture: win adapter ports the phase 3 scenarios",
    winSrc.includes("speckit_rereview_infra_retryable") && winSrc.includes("existing_planning_infra_retryable_always")
    && winSrc.includes("plan_review_policy_violation") && winSrc.includes("implementer_adapter_retryable_always")
    && winSrc.includes("plan_review_adapter_retryable_second")
    && /"speckit_rereview_infra_retryable"/.test(winSrc));
  // Selectable via the committed .autopilot-test-scenario file, never an
  // env var: the new branches key off $SCENARIO/scenario (the file-fed
  // selector the fixture header documents), and reference no environment
  // channel of their own.
  for (const [label, src, start] of [["sh", shSrc, shSrc.indexOf("plan_review_infra_retryable")], ["win", winSrc, winSrc.indexOf("plan_review_infra_retryable")]]) {
    const slice = src.slice(Math.max(0, start - 200), start + 2200);
    check(`fixture: ${label} retryable branch reads no env var`,
      !/process\.env|getenv|\bENV\b/.test(slice), slice.slice(0, 200));
  }
}

// ---------------------------------------------------------------------
// Calibration: the S2 escalation probe runs first and doubles as the S2
// case itself (several assertions read off this one run). Its measured
// wall clock derives every other mission's subprocess timeout (8x —
// comfortably above the binding >= 2x headroom over a single observed
// mission run). Fixture setup for the wave proceeds while the probe runs,
// since setup is local-only and shares no state with it.
// ---------------------------------------------------------------------
const s2 = setupStandalone("planning-review-s2", "plan_review_infra_non_retryable");
const probeT0 = Date.now();
const probeP = runMissionAsync(s2.repo, s2.binDir, {timeoutMs: PROBE_CEILING_MS});
// Wave fixtures are independent tmp repos — set them up while the probe
// mission runs instead of paying for setup serially afterwards.
const s1 = setupStandalone("planning-review-s1", "plan_review_infra_retryable", {retryDelayMs: 200});
const s3 = setupStandalone("planning-review-s3", "plan_review_missing_sentinel_with_path_error", {maxPlanRevisions: 2});
const s4 = setupStandalone("planning-review-s4", "plan_review_fail");
const k1 = setupSpeckit("planning-review-k1", "plan_review_infra_retryable");
const k2 = setupSpeckit("planning-review-k2", "plan_review_infra_non_retryable");
const k3 = setupSpeckit("planning-review-k3", "plan_review_missing_sentinel_with_path_error");
const k4 = setupSpeckit("planning-review-k4", "plan_review_fail");
// Call site 3 (post-revision re-review): R1 proves the retry with a real
// delay (second nonzero-delay proof, this time past a revision), R2-R4 run
// to escalation. Call site 4 (reviewExistingPlanning): E1/E2 stop right
// after the retried review passes (tight poll — the next relay is 10s+
// away, so planner counts stay exact); E3/E4/E5 run to escalation.
// Policy violations: P1 (site 1) and P2 (site 2) die fast.
// Cross-mission pairs (task 11): each pair's FIRST mission joins this wave
// (independent repos); the second mission of each pair runs afterwards
// against the same repo state.
const v1 = setupSpeckit("planning-review-r1", "speckit_rereview_infra_retryable", {retryDelayMs: 200});
const v2 = setupSpeckit("planning-review-r2", "speckit_rereview_infra_non_retryable");
const v3 = setupSpeckit("planning-review-r3", "speckit_rereview_output_contract");
const v4 = setupSpeckit("planning-review-r4", "speckit_rereview_policy_violation");
const e1 = setupStandaloneComplete("planning-review-e1", "existing_planning_infra_retryable");
const e2 = setupSpeckitPartial("planning-review-e2", "existing_planning_infra_retryable");
const e3 = setupStandaloneComplete("planning-review-e3", "existing_planning_output_contract");
const e4 = setupGsd("planning-review-e4", "existing_planning_infra_retryable_always");
const e5 = setupStandaloneComplete("planning-review-e5", "existing_planning_policy_violation");
const p1 = setupStandalone("planning-review-p1", "plan_review_policy_violation");
const p2 = setupSpeckit("planning-review-p2", "plan_review_policy_violation");
const xa = setupStandalone("planning-review-xa", "plan_review_infra_retryable_always", {failureBudgets: {infrastructureRetryBudget: 2}});
const xb1 = setupStandalone("planning-review-xb1", "plan_review_adapter_retryable_always", {failureBudgets: {adapterRetryBudget: 2}});
const xb2 = setupStandalone("planning-review-xb2", "implementer_adapter_retryable_always", {failureBudgets: {adapterRetryBudget: 2}});
const probeRun = await probeP;
const probeElapsed = Date.now() - probeT0;
// A 2-relay escalation is the shortest mission shape here; every wave case
// runs at most ~4x its relay count, so 8x the measured wall clock leaves
// >= 2x headroom even if box load doubles per-relay cost mid-file.
const FULL_TIMEOUT_MS = Math.ceil(probeElapsed * 8 * TIMEOUT_FACTOR);
console.log(`timing: calibration probe (S2) elapsed=${(probeElapsed / 1000).toFixed(1)}s -> derived wave timeout=${(FULL_TIMEOUT_MS / 1000).toFixed(0)}s`);
check("budget: derived wave timeout has >=2x headroom over the observed run",
  FULL_TIMEOUT_MS >= probeElapsed * 2, {probeElapsed, FULL_TIMEOUT_MS});

// ---------------------------------------------------------------------
// S2: standalone non-retryable infra failure escalates immediately
// (asserted off the calibration probe run — no second spawn).
// ---------------------------------------------------------------------
{
  const run = probeRun;
  const {repo, binDir} = s2;
  try {
    check("s2: probe did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
    check("s2: mission escalates (nonzero exit)", run.status !== 0, {status: run.status});
    check("s2: escalation names the failure class", (run.stderr || "").includes("PATH_UNSUPPORTED"), (run.stderr || "").slice(-500));
    check("s2: escalation names the failure domain", (run.stderr || "").includes("infrastructure"), (run.stderr || "").slice(-500));
    const counts = roleCounts(repo);
    check("s2: reviewer ran exactly once (no retry)", counts.plan_reviewer === 1, counts);
    check("s2: planner ran exactly once (no relaunch)", counts.planner === 1, counts);
    const budgets = budgetKeys(repo);
    check("s2: budget record persisted before the escalation", (budgets["infrastructureRetryBudget:mission"] || 0) >= 1, budgets);
  } finally {
    cleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// Wave: the remaining independent scenarios run concurrently. K1 and S4
// stop as soon as planning passes (tree-killed via a self-written marker
// once the expected reviewer PASS is on disk) — their assertions only need
// the planning phase, and full completions would dominate the file's
// runtime. S1 keeps its full completion: it is the one end-to-end proof
// that a mission with a retried review still completes healthily. If a
// stopped mission completes first anyway, the same assertions hold off the
// completed run.
// ---------------------------------------------------------------------
async function runUntilPlanningPass({repo, binDir}, timeoutMs, {minReviewers, markerName, extraReady = null, pollMs = 1000, args = null}) {
  const marker = path.join(repo, ".autopilot", markerName);
  let settled = false;
  const runP = runTreeUntilMarker(process.execPath, args || autopilotArgs(repo), {
    cwd: repo, env: missionEnv(binDir), markerFile: marker, pollMs: 100, timeoutMs
  }).then((r) => { settled = true; return r; });
  const watchP = (async () => {
    for (;;) {
      await new Promise((r) => setTimeout(r, pollMs));
      try {
        const reviews = roleResults(repo, "plan_reviewer");
        // Stop only once the PASS is fully processed, not merely written:
        // result.json lands just before the caller's PASS state-save, so an
        // extraReady gate (when given) closes the kill-in-between race.
        if (reviews.length >= minReviewers && reviews[reviews.length - 1]?.review?.decision === "PASS"
            && (!extraReady || extraReady(repo))) {
          fs.writeFileSync(marker, "stop");
          return "stopped-after-planning-pass";
        }
      } catch { /* repo mid-write; retry */ }
      if (settled) return "mission-settled-first";
    }
  })();
  const [run, watchReason] = await Promise.all([runP, watchP]);
  return {
    status: run.status ?? run.code ?? null, killed: !!run.killed,
    markerObserved: !!run.markerObserved, timedOut: !!run.timedOut,
    stdout: run.stdout || "", stderr: run.stderr || "", watchReason
  };
}

async function sweepCleanup(repo, binDir) {
  // A tree-kill can still be reaping descendants when the run settles; if
  // the first sweep meets a busy cwd, wait briefly and sweep once more so
  // repeated runs do not litter /tmp.
  cleanup(repo, binDir);
  if (fs.existsSync(repo) || fs.existsSync(binDir)) {
    await new Promise((r) => setTimeout(r, 2000));
    cleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// Cross-mission pairs (task 11). Each pair is self-contained — both
// missions, all assertions, and cleanup in one async function — so the
// three pairs pipeline with the main wave below instead of serializing a
// second wave after it. The budgets under test live in each pair's own
// repo state, which is never cleaned between its two missions.
// ---------------------------------------------------------------------
async function xaPair() {
  // XA mission 1: exhaust the shared infrastructure budget (limit 2: one
  // retry, then escalation) so the second mission's cleared start is
  // meaningful (retry available again, then fresh re-exhaustion).
  const {repo, binDir} = xa;
  const m1 = await runMissionAsync(repo, binDir, {timeoutMs: FULL_TIMEOUT_MS, args: autopilotArgsRequest(repo, "first cross mission alpha")});
  let xaM1Dir;
  {
    const run = m1;
    check("xa-m1: mission did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
    check("xa-m1: mission escalates (nonzero exit)", run.status !== 0, {status: run.status});
    check("xa-m1: escalation names class+domain and exhaustion",
      (run.stderr || "").includes("SERVER_UNAVAILABLE/infrastructure") && (run.stderr || "").includes("exhausted"),
      (run.stderr || "").slice(-500));
    const dirs = missionDirs(repo).filter((d) => d !== "planning");
    check("xa-m1: exactly one mission ran", dirs.length === 1, dirs);
    xaM1Dir = dirs[0];
    const counts = missionRoleCounts(repo, xaM1Dir);
    check("xa-m1: reviewer ran twice (fail + retry, then exhausted)", counts.plan_reviewer === 2, counts);
    check("xa-m1: planner ran once", counts.planner === 1, counts);
    const budgets = budgetKeys(repo);
    check("xa-m1: shared infrastructure budget exhausted", budgets["infrastructureRetryBudget:mission"] === 2, budgets);
  }
  // XA mission 2: the prior mission's exhausted shared infrastructure
  // budget was cleared at the new-mission start
  // (clearInheritedFailureCounters), so the retry is available again: the
  // new mission fails once, retries once, then re-exhausts its fresh budget.
  const m2 = await runMissionAsync(repo, binDir, {timeoutMs: FULL_TIMEOUT_MS, args: autopilotArgsRequest(repo, "second cross mission beta")});
  {
    const run = m2;
    try {
      check("xa-m2: mission did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
      check("xa-m2: mission escalates after retrying on a fresh budget (nonzero exit)", run.status !== 0, {status: run.status});
      check("xa-m2: escalation names class+domain and exhaustion",
        (run.stderr || "").includes("SERVER_UNAVAILABLE/infrastructure") && (run.stderr || "").includes("exhausted"),
        (run.stderr || "").slice(-500));
      const m2Dir = missionDirs(repo).filter((d) => d !== "planning" && d !== xaM1Dir)[0];
      check("xa-m2: a new mission dir was created", !!m2Dir, missionDirs(repo));
      const counts = missionRoleCounts(repo, m2Dir);
      check("xa-m2: new mission planned fresh (planner ran once)", counts.planner === 1, counts);
      check("xa-m2: reviewer ran twice on the cleared budget (fail + retry, then re-exhausted)", counts.plan_reviewer === 2, counts);
      const budgets = budgetKeys(repo);
      check("xa-m2: shared budget re-exhausted fresh from the cleared start", budgets["infrastructureRetryBudget:mission"] === 2, budgets);
    } finally {
      cleanup(repo, binDir);
    }
  }
}

async function xb1Pair() {
  // XB1 mission 1: exhaust plan_reviewer's own adapter budget key
  // (adapter:cursor:plan_reviewer) under a shrunken limit of 2.
  const {repo, binDir} = xb1;
  const m1 = await runMissionAsync(repo, binDir, {timeoutMs: FULL_TIMEOUT_MS, args: autopilotArgsRequest(repo, "first adapter mission alpha")});
  let xb1M1Dir;
  {
    const run = m1;
    check("xb1-m1: mission did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
    check("xb1-m1: mission escalates (nonzero exit)", run.status !== 0, {status: run.status});
    check("xb1-m1: escalation names class+domain and exhaustion",
      (run.stderr || "").includes("PROCESS_EXIT_NONZERO/adapter") && (run.stderr || "").includes("exhausted"),
      (run.stderr || "").slice(-500));
    const dirs = missionDirs(repo).filter((d) => d !== "planning");
    check("xb1-m1: exactly one mission ran", dirs.length === 1, dirs);
    xb1M1Dir = dirs[0];
    const counts = missionRoleCounts(repo, xb1M1Dir);
    check("xb1-m1: reviewer ran twice (fail + retry, then exhausted)", counts.plan_reviewer === 2, counts);
    const reviews = missionRoleResults(repo, xb1M1Dir, "plan_reviewer");
    check("xb1-m1: both failures were adapter-domain retryable",
      reviews.length === 2 && reviews.every((r) => r.failure?.class === "PROCESS_EXIT_NONZERO" && r.failure?.domain === "adapter" && r.failure?.retryable === true),
      reviews.map((r) => r.failure));
    const budgets = budgetKeys(repo);
    check("xb1-m1: plan_reviewer adapter budget exhausted", budgets["adapterRetryBudget:adapter:cursor:plan_reviewer"] === 2, budgets);
  }
  // XB1 mission 2: the prior mission's exhausted plan_reviewer adapter key
  // was cleared at the new-mission start, so the retry is available again:
  // fail once, retry once, then re-exhaust the fresh key.
  const m2 = await runMissionAsync(repo, binDir, {timeoutMs: FULL_TIMEOUT_MS, args: autopilotArgsRequest(repo, "second adapter mission beta")});
  {
    const run = m2;
    try {
      check("xb1-m2: mission did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
      check("xb1-m2: mission escalates after retrying on a fresh budget (nonzero exit)", run.status !== 0, {status: run.status});
      check("xb1-m2: escalation names class+domain and exhaustion",
        (run.stderr || "").includes("PROCESS_EXIT_NONZERO/adapter") && (run.stderr || "").includes("exhausted"),
        (run.stderr || "").slice(-500));
      const m2Dir = missionDirs(repo).filter((d) => d !== "planning" && d !== xb1M1Dir)[0];
      check("xb1-m2: a new mission dir was created", !!m2Dir, missionDirs(repo));
      const counts = missionRoleCounts(repo, m2Dir);
      check("xb1-m2: new mission planned fresh (planner ran once)", counts.planner === 1, counts);
      check("xb1-m2: reviewer ran twice on the cleared budget (fail + retry, then re-exhausted)", counts.plan_reviewer === 2, counts);
      const budgets = budgetKeys(repo);
      check("xb1-m2: plan_reviewer adapter key re-exhausted fresh from the cleared start", budgets["adapterRetryBudget:adapter:cursor:plan_reviewer"] === 2, budgets);
    } finally {
      cleanup(repo, binDir);
    }
  }
}

async function xb2Pair() {
  // XB2 mission 1: exhaust a DIFFERENT role's adapter key
  // (adapter:cursor:implementer) — planning itself passes cleanly.
  const {repo, binDir} = xb2;
  const m1 = await runMissionAsync(repo, binDir, {timeoutMs: FULL_TIMEOUT_MS, args: autopilotArgsRequest(repo, "first implementer mission alpha")});
  let xb2M1Dir;
  {
    const run = m1;
    check("xb2-m1: mission did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
    check("xb2-m1: mission escalates (nonzero exit)", run.status !== 0, {status: run.status});
    const dirs = missionDirs(repo).filter((d) => d !== "planning");
    check("xb2-m1: exactly one mission ran", dirs.length === 1, dirs);
    xb2M1Dir = dirs[0];
    const counts = missionRoleCounts(repo, xb2M1Dir);
    check("xb2-m1: planning passed (planner + passing reviewer)", counts.planner === 1 && counts.plan_reviewer === 1, counts);
    check("xb2-m1: implementer ran twice (fail + retry, then exhausted)", counts.implementer === 2, counts);
    const impls = missionRoleResults(repo, xb2M1Dir, "implementer");
    check("xb2-m1: both implementer failures were adapter-domain retryable",
      impls.length === 2 && impls.every((r) => r.failure?.class === "PROCESS_EXIT_NONZERO" && r.failure?.domain === "adapter"),
      impls.map((r) => r.failure));
    const budgets = budgetKeys(repo);
    check("xb2-m1: implementer adapter budget exhausted", budgets["adapterRetryBudget:adapter:cursor:implementer"] === 2, budgets);
    check("xb2-m1: plan_reviewer adapter key untouched",
      !Object.keys(budgets).some((k) => k === "adapterRetryBudget:adapter:cursor:plan_reviewer"), budgets);
  }
  // Between missions (same repo state — the manual checkpoint edit below
  // preserves failureBudgets as-is; the new-mission start itself then clears
  // them via clearInheritedFailureCounters): switch
  // to the plan_reviewer adapter shape, and clear TASK-11's
  // implementation-resume checkpoint (only that key) so the new request
  // reaches planning at all — that feature's own settled precedence would
  // otherwise resume mission 1's checkpoint, skipping planning entirely
  // and ignoring the new request. The preserved budgets are verified here;
  // the cleared start is asserted on mission 2's own keys below.
  setScenario(repo, "plan_review_adapter_retryable_second");
  {
    const statePath = path.join(repo, ".autopilot", "state.json");
    const st = JSON.parse(fs.readFileSync(statePath, "utf8"));
    check("xb2-setup: phase-stage checkpoint present to clear", !!st.phaseExecutionCheckpoint, Object.keys(st));
    delete st.phaseExecutionCheckpoint;
    fs.writeFileSync(statePath, JSON.stringify(st, null, 2));
    const kept = JSON.parse(fs.readFileSync(statePath, "utf8")).failureBudgets || {};
    check("xb2-setup: budgets preserved while clearing the checkpoint",
      kept["adapterRetryBudget:adapter:cursor:implementer"] === 2, kept);
  }
  // XB2 mission 2: the new mission starts with cleared failure counters,
  // so the exhausted implementer key from mission 1 is gone and
  // plan_reviewer's own adapter retry proceeds on a fresh key — the review
  // fails once and is retried, on a fresh key. Stopped right after
  // planning passes (the planner never runs again on this path, so the
  // tight poll keeps counts exact).
  const m2 = await runUntilPlanningPass({repo, binDir}, FULL_TIMEOUT_MS, {minReviewers: 3, markerName: "xb2-m2-stop-marker", pollMs: 250,
    args: autopilotArgsRequest(repo, "second implementer mission beta")});
  {
    const run = m2;
    try {
      check("xb2-m2: mission did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
      check("xb2-m2: stopped after planning pass (or completed)", run.watchReason === "stopped-after-planning-pass" || run.status === 0,
        {watchReason: run.watchReason, status: run.status, killed: run.killed});
      const m2Dir = missionDirs(repo).filter((d) => d !== "planning" && d !== xb2M1Dir)[0];
      check("xb2-m2: a new mission dir was created", !!m2Dir, missionDirs(repo));
      const counts = missionRoleCounts(repo, m2Dir);
      check("xb2-m2: new mission planned fresh (planner ran once)", counts.planner === 1, counts);
      check("xb2-m2: reviewer retried (fail + pass)", counts.plan_reviewer === 2, counts);
      const reviews = missionRoleResults(repo, m2Dir, "plan_reviewer");
      check("xb2-m2: first review failed adapter-retryable",
        reviews[0]?.status === "failed" && reviews[0]?.failure?.class === "PROCESS_EXIT_NONZERO" && reviews[0]?.failure?.domain === "adapter",
        reviews[0]?.failure);
      check("xb2-m2: retried review passed", reviews[1]?.review?.decision === "PASS", reviews[1]?.review);
      const budgets = budgetKeys(repo);
      check("xb2-m2: plan_reviewer adapter key is fresh (used once, retry allowed)",
        budgets["adapterRetryBudget:adapter:cursor:plan_reviewer"] === 1, budgets);
      check("xb2-m2: implementer adapter key cleared for the new mission (absent, not exhausted)",
        !Object.keys(budgets).some((k) => k === "adapterRetryBudget:adapter:cursor:implementer"), budgets);
    } finally {
      await sweepCleanup(repo, binDir);
    }
  }
}

const [r1, r3, r4, rk1, rk2, rk3, rk4,
  rr1, rr2, rr3, rr4, re1, re2, re3, re4, re5, rp1, rp2] = await Promise.all([
  runMissionAsync(s1.repo, s1.binDir, {timeoutMs: FULL_TIMEOUT_MS}),
  runMissionAsync(s3.repo, s3.binDir, {timeoutMs: FULL_TIMEOUT_MS}),
  runUntilPlanningPass(s4, FULL_TIMEOUT_MS, {minReviewers: 2, markerName: "s4-stop-marker",
    // The revision record is cleared in the same state-save that processes
    // the PASS, microseconds after result.json lands — require the cleared
    // state on disk before stopping so the kill cannot land in between.
    extraReady: (repo) => { try { return !readState(repo).standalonePlanReview; } catch { return false; } }}),
  runUntilPlanningPass(k1, FULL_TIMEOUT_MS, {minReviewers: 4, markerName: "k1-stop-marker"}),
  runMissionAsync(k2.repo, k2.binDir, {timeoutMs: FULL_TIMEOUT_MS}),
  runMissionAsync(k3.repo, k3.binDir, {timeoutMs: FULL_TIMEOUT_MS}),
  runMissionAsync(k4.repo, k4.binDir, {timeoutMs: FULL_TIMEOUT_MS}),
  // R1 stops the moment the re-review PASS lands (third reviewer result):
  // planner count then proves zero additional revisions, and a
  // spawned-but-incomplete plan-stage run carries no result.json yet.
  runUntilPlanningPass(v1, FULL_TIMEOUT_MS, {minReviewers: 3, markerName: "r1-stop-marker", pollMs: 250}),
  runMissionAsync(v2.repo, v2.binDir, {timeoutMs: FULL_TIMEOUT_MS}),
  runMissionAsync(v3.repo, v3.binDir, {timeoutMs: FULL_TIMEOUT_MS}),
  runMissionAsync(v4.repo, v4.binDir, {timeoutMs: FULL_TIMEOUT_MS}),
  // E1/E2 stop once the retried existing-planning review has fully passed
  // (result.json lands just before reviewExistingPlanning()'s own PASS
  // state-save — require that save via extraReady, same race as S4).
  runUntilPlanningPass(e1, FULL_TIMEOUT_MS, {minReviewers: 2, markerName: "e1-stop-marker", pollMs: 250,
    args: autopilotArgsNoRequest(e1.repo),
    extraReady: (repo) => { try { return readState(repo).planningStateReview?.status === "passed"; } catch { return false; } }}),
  runUntilPlanningPass(e2, FULL_TIMEOUT_MS, {minReviewers: 2, markerName: "e2-stop-marker", pollMs: 250,
    args: autopilotArgsNoRequest(e2.repo),
    extraReady: (repo) => { try { return readState(repo).planningStateReview?.status === "passed"; } catch { return false; } }}),
  runMissionAsync(e3.repo, e3.binDir, {timeoutMs: FULL_TIMEOUT_MS, args: autopilotArgsNoRequest(e3.repo)}),
  runMissionAsync(e4.repo, e4.binDir, {timeoutMs: FULL_TIMEOUT_MS, args: autopilotArgsNoRequest(e4.repo)}),
  runMissionAsync(e5.repo, e5.binDir, {timeoutMs: FULL_TIMEOUT_MS, args: autopilotArgsNoRequest(e5.repo)}),
  runMissionAsync(p1.repo, p1.binDir, {timeoutMs: FULL_TIMEOUT_MS}),
  runMissionAsync(p2.repo, p2.binDir, {timeoutMs: FULL_TIMEOUT_MS}),
  // The three cross-mission pairs pipeline here: each runs its own two
  // missions back-to-back (its M2 starts the moment its own M1 resolves)
  // instead of serializing a second wave after this one.
  xaPair(),
  xb1Pair(),
  xb2Pair()
]);

// ---------------------------------------------------------------------
// S1: standalone infra-retryable failure retries the reviewer only, with a
// real retry delay (the retryDelay() proof case: retry_delay_ms=200).
// ---------------------------------------------------------------------
{
  const run = r1;
  const {repo, binDir} = s1;
  try {
    check("s1: mission did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
    check("s1: mission completes (exit 0)", run.status === 0, {status: run.status, stderrTail: (run.stderr || "").slice(-800)});
    const counts = roleCounts(repo);
    check("s1: planner ran exactly once (no relaunch)", counts.planner === 1, counts);
    check("s1: reviewer ran exactly twice (fail + retry)", counts.plan_reviewer === 2, counts);
    const reviews = roleResults(repo, "plan_reviewer");
    check("s1: first review attempt failed without a verdict", reviews.length === 2 && reviews[0].status === "failed", reviews.map((r) => ({status: r.status, failure: r.failure?.class})));
    check("s1: first failure classified SERVER_UNAVAILABLE/infrastructure",
      reviews[0]?.failure?.class === "SERVER_UNAVAILABLE" && reviews[0]?.failure?.domain === "infrastructure", reviews[0]?.failure);
    check("s1: retried review passed", reviews[1]?.status === "completed" && reviews[1]?.review?.decision === "PASS", reviews[1]?.review);
    // retryDelay() proof: it prints only when it actually waits (ms > 0 and
    // attempt > 1), so this line distinguishes "called and waited" from both
    // "never called" and "called but no-opped".
    check("s1: retry delay was real (log line present)", /Retry delay: waiting/.test(run.stdout), (run.stdout || "").slice(-500));
    // Fresh-session retry, observed from the persisted results (the static
    // contract block above pins the resume:false call semantics; here the
    // launch sequence itself: two distinct runs, neither carrying a resumed
    // session id — the fake adapter yields none, and a resumed call would
    // have carried the first attempt's forward).
    check("s1: retry was a distinct run (run_ids differ)",
      reviews.length === 2 && reviews[0]?.run_id != null && reviews[1]?.run_id != null && reviews[0].run_id !== reviews[1].run_id,
      reviews.map((r) => r.run_id));
    check("s1: neither attempt carries a resumed session",
      reviews.length === 2 && reviews[0]?.sessionId == null && reviews[1]?.sessionId == null,
      reviews.map((r) => r.sessionId));
    // The retried call was preceded by a persisted budget record.
    const budgets = budgetKeys(repo);
    check("s1: infrastructure budget record persisted", (budgets["infrastructureRetryBudget:mission"] || 0) >= 1, budgets);
  } finally {
    cleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// S3: standalone output-contract failure still consumes a revision and
// re-invokes the planner, unchanged, with nothing recorded.
// ---------------------------------------------------------------------
{
  const run = r3;
  const {repo, binDir} = s3;
  try {
    check("s3: mission did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
    check("s3: mission escalates after revisions (nonzero exit)", run.status !== 0, {status: run.status});
    check("s3: escalation is the unchanged revision-exhaustion path",
      /failed review after 2 revision\(s\)/.test(run.stderr || ""), (run.stderr || "").slice(-500));
    const counts = roleCounts(repo);
    check("s3: planner re-invoked (ran twice)", counts.planner === 2, counts);
    check("s3: reviewer ran twice", counts.plan_reviewer === 2, counts);
    const state = readState(repo);
    check("s3: revision counter consumed (revision 2)", state.standalonePlanReview?.revision === 2, state.standalonePlanReview);
    check("s3: output-contract failure never recorded", Object.keys(budgetKeys(repo)).length === 0, budgetKeys(repo));
  } finally {
    cleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// S4: standalone functional FAIL is unaffected (revision + planner
// re-invocation, planning passes, nothing recorded). Stopped right after
// planning passes — the implementation phase adds nothing S4-specific
// (S1 already proves a mission with a retried review completes end to end).
// ---------------------------------------------------------------------
{
  const run = r4;
  const {repo, binDir} = s4;
  try {
    check("s4: mission did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
    check("s4: stopped after planning pass (or completed)", run.watchReason === "stopped-after-planning-pass" || run.status === 0,
      {watchReason: run.watchReason, status: run.status, killed: run.killed});
    const counts = roleCounts(repo);
    check("s4: planner re-invoked (ran twice)", counts.planner === 2, counts);
    // FAIL, scoped re-review PASS, then the confirmation full review PASS.
    check("s4: reviewer ran three times (fail, scoped pass, confirmation pass)", counts.plan_reviewer === 3, counts);
    const reviews = roleResults(repo, "plan_reviewer");
    check("s4: first review was a functional FAIL",
      reviews[0]?.review?.decision === "FAIL" && reviews[0]?.failure?.class === "PLANNING_REJECTED",
      {review: reviews[0]?.review, failure: reviews[0]?.failure});
    check("s4: second review passed", reviews[1]?.review?.decision === "PASS", reviews[1]?.review);
    const state = readState(repo);
    check("s4: revision record cleared on pass", !state.standalonePlanReview, state.standalonePlanReview);
    check("s4: functional failure never recorded", Object.keys(budgetKeys(repo)).length === 0, budgetKeys(repo));
  } finally {
    await sweepCleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// K1: SpecKit initial gate infra-retryable failure retries the reviewer
// only (no planner relaunch). Stopped right after planning passes.
// ---------------------------------------------------------------------
{
  const run = rk1;
  const {repo, binDir} = k1;
  try {
    check("k1: mission did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
    check("k1: stopped after planning pass (or completed)", run.watchReason === "stopped-after-planning-pass" || run.status === 0,
      {watchReason: run.watchReason, status: run.status, killed: run.killed});
    const counts = roleCounts(repo);
    check("k1: planner ran exactly the three stages (no relaunch)", counts.planner === 3, counts);
    check("k1: initial gate reviewer retried (four reviews total)", counts.plan_reviewer === 4, counts);
    const reviews = roleResults(repo, "plan_reviewer");
    check("k1: first review attempt failed without a verdict",
      reviews.length >= 1 && reviews[0].status === "failed", reviews.map((r) => ({status: r.status, failure: r.failure?.class})));
    check("k1: retried reviews passed", reviews.length === 4 && reviews.slice(1).every((r) => r.review?.decision === "PASS"),
      reviews.map((r) => r.review?.decision));
    const budgets = budgetKeys(repo);
    check("k1: infrastructure budget record persisted", (budgets["infrastructureRetryBudget:mission"] || 0) >= 1, budgets);
  } finally {
    await sweepCleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// K2: SpecKit initial gate non-retryable infra failure escalates
// immediately.
// ---------------------------------------------------------------------
{
  const run = rk2;
  const {repo, binDir} = k2;
  try {
    check("k2: mission did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
    check("k2: mission escalates (nonzero exit)", run.status !== 0, {status: run.status});
    check("k2: escalation names the failure class", (run.stderr || "").includes("PATH_UNSUPPORTED"), (run.stderr || "").slice(-500));
    check("k2: escalation names the failure domain", (run.stderr || "").includes("infrastructure"), (run.stderr || "").slice(-500));
    const counts = roleCounts(repo);
    check("k2: reviewer ran exactly once (no retry)", counts.plan_reviewer === 1, counts);
    check("k2: planner ran exactly once (specify only, no revision)", counts.planner === 1, counts);
  } finally {
    cleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// K3: SpecKit initial gate output-contract failure still consumes a
// revision and re-invokes the planner, unchanged, with nothing recorded.
// ---------------------------------------------------------------------
{
  const run = rk3;
  const {repo, binDir} = k3;
  try {
    check("k3: mission did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
    check("k3: mission escalates (nonzero exit)", run.status !== 0, {status: run.status});
    const counts = roleCounts(repo);
    check("k3: planner re-invoked (specify ran twice)", counts.planner === 2, counts);
    check("k3: output-contract failure never recorded", Object.keys(budgetKeys(repo)).length === 0, budgetKeys(repo));
  } finally {
    cleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// K4: SpecKit initial gate functional FAIL is unaffected (revision +
// planner re-invocation, then today's post-revision escalation, nothing
// recorded).
// ---------------------------------------------------------------------
{
  const run = rk4;
  const {repo, binDir} = k4;
  try {
    check("k4: mission did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
    check("k4: mission escalates (nonzero exit)", run.status !== 0, {status: run.status});
    const counts = roleCounts(repo);
    check("k4: planner re-invoked (specify ran twice)", counts.planner === 2, counts);
    check("k4: functional failure never recorded", Object.keys(budgetKeys(repo)).length === 0, budgetKeys(repo));
  } finally {
    cleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// R1: SpecKit post-revision re-review infra-retryable failure retries the
// reviewer only — zero additional revisions — with a real retry delay.
// ---------------------------------------------------------------------
{
  const run = rr1;
  const {repo, binDir} = v1;
  try {
    check("r1: mission did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
    check("r1: stopped after re-review pass (or completed)", run.watchReason === "stopped-after-planning-pass" || run.status === 0,
      {watchReason: run.watchReason, status: run.status, killed: run.killed});
    // Review-spec-gate counting: later SpecKit gates (plan/tasks planner
    // runs, review-plan/review-tasks initial reviews) land after the
    // review-spec gate PASS, so count only events up to and including the
    // first plan_reviewer PASS instead of repo-wide totals.
    const r1Events = readObservedEvents(repo);
    const r1GateIdx = r1Events.findIndex((e) => e.role === "plan_reviewer" && e.decision === "PASS");
    const r1Gated = r1GateIdx === -1 ? r1Events : r1Events.slice(0, r1GateIdx + 1);
    const counts = {};
    for (const e of r1Gated) counts[e.role] = (counts[e.role] || 0) + 1;
    check("r1: planner ran exactly twice (initial + one revision, zero more from the retry)", counts.planner === 2, counts);
    check("r1: reviewer ran exactly three times (initial fail + re-review fail + retry pass)", counts.plan_reviewer === 3, counts);
    const reviews = roleResults(repo, "plan_reviewer");
    check("r1: initial review was a functional FAIL",
      reviews[0]?.review?.decision === "FAIL" && reviews[0]?.failure?.class === "PLANNING_REJECTED",
      {review: reviews[0]?.review, failure: reviews[0]?.failure});
    check("r1: re-review failed retryable without a verdict",
      reviews[1]?.status === "failed" && reviews[1]?.failure?.class === "SERVER_UNAVAILABLE" && reviews[1]?.failure?.domain === "infrastructure",
      reviews[1]?.failure);
    check("r1: retried re-review passed", reviews[2]?.review?.decision === "PASS", reviews[2]?.review);
    check("r1: retry delay was real (log line present)", /Retry delay: waiting/.test(run.stdout), (run.stdout || "").slice(-500));
    const budgets = budgetKeys(repo);
    check("r1: only the infra failure was recorded (functional FAIL never recorded)",
      budgets["infrastructureRetryBudget:mission"] === 1 && Object.keys(budgets).length === 1, budgets);
  } finally {
    await sweepCleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// R2: SpecKit post-revision re-review non-retryable infra failure
// escalates unchanged (no revision left at this position).
// ---------------------------------------------------------------------
{
  const run = rr2;
  const {repo, binDir} = v2;
  try {
    check("r2: mission did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
    check("r2: mission escalates (nonzero exit)", run.status !== 0, {status: run.status});
    check("r2: escalation names the failure class", (run.stderr || "").includes("PATH_UNSUPPORTED"), (run.stderr || "").slice(-500));
    check("r2: escalation names the failure domain", (run.stderr || "").includes("infrastructure"), (run.stderr || "").slice(-500));
    const counts = roleCounts(repo);
    check("r2: reviewer ran exactly twice (initial + re-review, no retry)", counts.plan_reviewer === 2, counts);
    check("r2: planner ran exactly twice (initial + one revision)", counts.planner === 2, counts);
    const budgets = budgetKeys(repo);
    check("r2: re-review failure recorded before the escalation", (budgets["infrastructureRetryBudget:mission"] || 0) === 1, budgets);
  } finally {
    cleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// R3: SpecKit post-revision re-review output-contract failure escalates
// with the pre-existing message, nothing recorded. This is call site 3's
// own shape — never inferred from E3 below.
// ---------------------------------------------------------------------
{
  const run = rr3;
  const {repo, binDir} = v3;
  try {
    check("r3: mission did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
    check("r3: mission escalates (nonzero exit)", run.status !== 0, {status: run.status});
    check("r3: escalation is the unchanged immediate die (no revision left)",
      (run.stderr || "").includes("SpecKit gate review-spec failed."), (run.stderr || "").slice(-500));
    const counts = roleCounts(repo);
    check("r3: reviewer ran exactly twice (initial + re-review, no retry)", counts.plan_reviewer === 2, counts);
    check("r3: planner ran exactly twice (initial + one revision)", counts.planner === 2, counts);
    check("r3: output-contract failure never recorded", Object.keys(budgetKeys(repo)).length === 0, budgetKeys(repo));
  } finally {
    cleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// R4: policy violation at the post-revision re-review dies immediately.
// ---------------------------------------------------------------------
{
  const run = rr4;
  const {repo, binDir} = v4;
  try {
    check("r4: mission did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
    check("r4: mission escalates (nonzero exit)", run.status !== 0, {status: run.status});
    check("r4: escalation is the policy message", (run.stderr || "").includes("reviewer violated read-only relay policy."), (run.stderr || "").slice(-500));
    const counts = roleCounts(repo);
    check("r4: reviewer ran exactly twice (initial + violating re-review, no retry)", counts.plan_reviewer === 2, counts);
    check("r4: planner ran exactly twice (initial + one revision)", counts.planner === 2, counts);
    const reviews = roleResults(repo, "plan_reviewer");
    check("r4: re-review carried the policy violation",
      reviews[1]?.policyViolation === "git_mutation_blocked", {policyViolation: reviews[1]?.policyViolation, policy: reviews[1]?.policy});
    check("r4: no infra/adapter budget touched", Object.keys(budgetKeys(repo)).length === 0, budgetKeys(repo));
  } finally {
    cleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// E1: reviewExistingPlanning() infra-retryable failure retries at
// "complete" standalone status. Stopped right after the review passes —
// the planner never runs on this path, so planner zero is exact.
// ---------------------------------------------------------------------
{
  const run = re1;
  const {repo, binDir} = e1;
  try {
    check("e1: mission did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
    check("e1: stopped after review pass (or completed)", run.watchReason === "stopped-after-planning-pass" || run.status === 0,
      {watchReason: run.watchReason, status: run.status, killed: run.killed});
    const counts = roleCounts(repo);
    check("e1: reviewer ran exactly twice (fail + retry)", counts.plan_reviewer === 2, counts);
    check("e1: planner never ran", (counts.planner || 0) === 0, counts);
    const reviews = roleResults(repo, "plan_reviewer");
    check("e1: first validation failed retryable without a verdict",
      reviews[0]?.status === "failed" && reviews[0]?.failure?.class === "SERVER_UNAVAILABLE" && reviews[0]?.failure?.domain === "infrastructure",
      reviews[0]?.failure);
    check("e1: retried validation passed", reviews[1]?.review?.decision === "PASS", reviews[1]?.review);
    const budgets = budgetKeys(repo);
    check("e1: infrastructure budget record persisted", (budgets["infrastructureRetryBudget:mission"] || 0) >= 1, budgets);
    check("e1: review recorded against the standalone framework",
      readState(repo).planningStateReview?.framework === "standalone", readState(repo).planningStateReview);
  } finally {
    await sweepCleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// E2: the same at "partial" SpecKit status (an earlier draft only
// covered complete-state — both entry statuses are asserted).
// ---------------------------------------------------------------------
{
  const run = re2;
  const {repo, binDir} = e2;
  try {
    check("e2: mission did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
    check("e2: stopped after review pass (or completed)", run.watchReason === "stopped-after-planning-pass" || run.status === 0,
      {watchReason: run.watchReason, status: run.status, killed: run.killed});
    const counts = roleCounts(repo);
    check("e2: reviewer ran exactly twice (fail + retry)", counts.plan_reviewer === 2, counts);
    check("e2: planner never ran before the kill", (counts.planner || 0) === 0, counts);
    const reviews = roleResults(repo, "plan_reviewer");
    check("e2: first validation failed retryable without a verdict",
      reviews[0]?.status === "failed" && reviews[0]?.failure?.class === "SERVER_UNAVAILABLE" && reviews[0]?.failure?.domain === "infrastructure",
      reviews[0]?.failure);
    check("e2: retried validation passed", reviews[1]?.review?.decision === "PASS", reviews[1]?.review);
    const budgets = budgetKeys(repo);
    check("e2: infrastructure budget record persisted", (budgets["infrastructureRetryBudget:mission"] || 0) >= 1, budgets);
    check("e2: review recorded against the speckit framework",
      readState(repo).planningStateReview?.framework === "speckit", readState(repo).planningStateReview);
  } finally {
    await sweepCleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// E3: reviewExistingPlanning() output-contract failure escalates
// immediately, exactly like the functional-FAIL case — asserted as its
// own case, never inferred from R3 above.
// ---------------------------------------------------------------------
{
  const run = re3;
  const {repo, binDir} = e3;
  try {
    check("e3: mission did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
    check("e3: mission escalates (nonzero exit)", run.status !== 0, {status: run.status});
    check("e3: escalation is the unchanged immediate die",
      (run.stderr || "").includes("Existing standalone planning is not ready for execution."), (run.stderr || "").slice(-500));
    const counts = roleCounts(repo);
    check("e3: reviewer ran exactly once (no retry)", counts.plan_reviewer === 1, counts);
    check("e3: planner never ran", (counts.planner || 0) === 0, counts);
    check("e3: output-contract failure never recorded", Object.keys(budgetKeys(repo)).length === 0, budgetKeys(repo));
  } finally {
    cleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// E4: GSD regression — framework "gsd" with a RETRYABLE infra failure
// still hard-escalates with zero retry and zero budget recorded. The
// failure shape is deliberately retryable (SERVER_UNAVAILABLE): with the
// wiring applied this would have retried, so one reviewer call proves
// GSD takes none of the new branches.
// ---------------------------------------------------------------------
{
  const run = re4;
  const {repo, binDir} = e4;
  try {
    check("e4: mission did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
    check("e4: mission escalates (nonzero exit)", run.status !== 0, {status: run.status});
    check("e4: escalation is the unchanged message",
      (run.stderr || "").includes("Existing gsd planning is not ready for execution."), (run.stderr || "").slice(-500));
    const counts = roleCounts(repo);
    check("e4: reviewer ran exactly once (zero retry)", counts.plan_reviewer === 1, counts);
    const reviews = roleResults(repo, "plan_reviewer");
    check("e4: the unretried failure was retryable-shaped",
      reviews[0]?.failure?.class === "SERVER_UNAVAILABLE" && reviews[0]?.failure?.domain === "infrastructure"
      && reviews[0]?.failure?.retryable === true, reviews[0]?.failure);
    check("e4: GSD touched no failure budget", Object.keys(budgetKeys(repo)).length === 0, budgetKeys(repo));
  } finally {
    cleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// E5: policy violation inside reviewExistingPlanning() dies immediately.
// ---------------------------------------------------------------------
{
  const run = re5;
  const {repo, binDir} = e5;
  try {
    check("e5: mission did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
    check("e5: mission escalates (nonzero exit)", run.status !== 0, {status: run.status});
    check("e5: escalation is the policy message", (run.stderr || "").includes("violated relay policy"), (run.stderr || "").slice(-500));
    const counts = roleCounts(repo);
    check("e5: reviewer ran exactly once (no retry)", counts.plan_reviewer === 1, counts);
    check("e5: planner never ran", (counts.planner || 0) === 0, counts);
    const reviews = roleResults(repo, "plan_reviewer");
    check("e5: validation carried the policy violation",
      reviews[0]?.policyViolation === "git_mutation_blocked", {policyViolation: reviews[0]?.policyViolation});
    check("e5: no infra/adapter budget touched", Object.keys(budgetKeys(repo)).length === 0, budgetKeys(repo));
  } finally {
    cleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// P1: policy violation in the standalone plan-review loop (call site 1)
// dies immediately.
// ---------------------------------------------------------------------
{
  const run = rp1;
  const {repo, binDir} = p1;
  try {
    check("p1: mission did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
    check("p1: mission escalates (nonzero exit)", run.status !== 0, {status: run.status});
    check("p1: escalation is the policy message",
      (run.stderr || "").includes("Standalone plan reviewer violated relay policy."), (run.stderr || "").slice(-500));
    const counts = roleCounts(repo);
    check("p1: reviewer ran exactly once (no retry)", counts.plan_reviewer === 1, counts);
    check("p1: planner ran exactly once (no relaunch)", counts.planner === 1, counts);
    const reviews = roleResults(repo, "plan_reviewer");
    check("p1: review carried the policy violation",
      reviews[0]?.policyViolation === "git_mutation_blocked", {policyViolation: reviews[0]?.policyViolation});
    check("p1: no infra/adapter budget touched", Object.keys(budgetKeys(repo)).length === 0, budgetKeys(repo));
  } finally {
    cleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// P2: policy violation at the SpecKit initial gate review (call site 2)
// dies immediately.
// ---------------------------------------------------------------------
{
  const run = rp2;
  const {repo, binDir} = p2;
  try {
    check("p2: mission did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
    check("p2: mission escalates (nonzero exit)", run.status !== 0, {status: run.status});
    check("p2: escalation is the policy message",
      (run.stderr || "").includes("reviewer violated read-only relay policy."), (run.stderr || "").slice(-500));
    const counts = roleCounts(repo);
    check("p2: reviewer ran exactly once (no retry)", counts.plan_reviewer === 1, counts);
    check("p2: planner ran exactly once (specify only, no revision)", counts.planner === 1, counts);
    const reviews = roleResults(repo, "plan_reviewer");
    check("p2: review carried the policy violation",
      reviews[0]?.policyViolation === "git_mutation_blocked", {policyViolation: reviews[0]?.policyViolation});
    check("p2: no infra/adapter budget touched", Object.keys(budgetKeys(repo)).length === 0, budgetKeys(repo));
  } finally {
    cleanup(repo, binDir);
  }
}

// (XB2's missions live in xb2Pair() above, pipelined with the wave.)

console.log(`timing: whole file elapsed=${((Date.now() - FILE_T0) / 1000).toFixed(1)}s`);
if (failures) {
  console.error(`${failures} planning-review-resume check(s) failed.`);
  process.exit(1);
}
console.log("Planning-review-resume behavioral tests (all four call sites + budget lifetime): PASS");
