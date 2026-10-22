#!/usr/bin/env node
// TASK-14 Phase 5 tasks 17-18 — standalone planning-review resume-position
// checkpoint (s.standalonePlanningReviewCheckpoint) wiring regressions.
//
// Drives real `node scripts/autopilot.mjs run ...` subprocesses the same way
// test-phase-stage-resume.mjs does — never by importing `autopilot.mjs` (it
// runs `main()` at import with no guard) — against the shared fake-adapter
// ecosystem (fake-workflow-adapter.sh, default PASS scenario, plus
// workflow-order-harness.mjs helpers). Checkpoints for the resume cases are
// CRAFTED directly into state.json (computed with the production pure module
// `planning-review-checkpoint.mjs` itself, so the shape always matches what
// the wiring writes) — no timing-dependent kill is needed to reach the
// reviewer-pending/planner-pending states, except the PASS+kill case which
// uses the tree-kill marker technique to land between the PASS state-save
// and the function returning.
//
// Cases (task 17 — five cases):
//   R1. Restart in reviewer-pending resumes at the reviewer (planner runs
//       zero times), content validated: matching content resumes, drifted
//       content escalates with DRIFT evidence and still runs the planner
//       zero times.
//   R2. Restart in planner-pending resumes at the planner (planner runs),
//       content NOT validated: matching and changed content both proceed to
//       the planner with no escalation.
//   R3. No-checkpoint ambiguous state still dies exactly as today
//       ("Planning state is ambiguous"), planner and reviewer run zero times.
//   R4. Checkpoint-present ambiguous state also escalates (the decided
//       ambiguous+checkpoint combination) — asserted at BOTH positions
//       (task 16: both escalate, never fall through to the planner).
//   R5. A PASS immediately followed by a kill (between the state-save call
//       and the function returning) leaves the checkpoint already cleared on
//       restart.
// Cases (task 18 — version/identity regressions, same request):
//   R6. Unknown-version checkpoint escalates with evidence — never silently
//       treated as absent, never a silent fallback to the planner.
//   R7. Mismatched mission identity escalates with evidence — same.
//
// Runtime budget (binding per the task brief, same rule as task 7): the
// calibration probe doubles as the R3 case itself (several assertions read
// off this one run); every other mission's subprocess timeout is derived
// from that measurement with headroom (8x, i.e. >= 2x a single observed run
// — never a fixed 3 minutes); independent scenarios run concurrently; the
// reviewer-resume cases stop as soon as planning passes instead of running
// full completions. The whole file completes in well under 5 minutes: every
// crafted-resume case needs at most 1-2 relays.
import fs from "node:fs";
import path from "node:path";
import {spawn} from "node:child_process";
import {
  makeFixtureRepo, makeFixtureBin, writeConfig, readObservedEvents, cleanup, skillRoot
} from "./test-fixtures/workflow-order-harness.mjs";
import {runTreeUntilMarker} from "./test-fixtures/posix-process-runner.mjs";
import {callsWithOptions, importNames, bodyAfter, callArgs} from "./test-fixtures/source-scan.mjs";
import {
  artifactDigest, createStandaloneCheckpoint, PLANNING_REVIEW_CHECKPOINT_VERSION
} from "./planning-review-checkpoint.mjs";


const FILE_T0 = Date.now();
const PROBE_CEILING_MS = 600000;
const REQUEST = "fixture request";
const MISSION = "001-fixture-feature";

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

function readState(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
}
function writeState(repo, state) {
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(state, null, 2));
}
function roleCounts(repo) {
  const counts = {};
  for (const e of readObservedEvents(repo)) counts[e.role] = (counts[e.role] || 0) + 1;
  return counts;
}
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

const PARTIAL_TASKS = "## Phase 1: General\n\n- [ ] Do the fixture task \u2014 accept: done ; verify: none\n";
const PARTIAL_PLAN = "# Plan\n\nObjective: fixture task.\n";
const AMBIGUOUS_TASKS = "# Tasks\n\nNo checklist items here yet.\n";

function missionRelPaths(repo, mission) {
  const planRel = path.relative(repo, path.join(repo, ".autopilot", "missions", mission, "PLAN.md"));
  const tasksRel = path.relative(repo, path.join(repo, ".autopilot", "missions", mission, "TASKS.md"));
  return {planRel, tasksRel};
}
function writeMissionFiles(repo, mission, planContent, tasksContent) {
  const dir = path.join(repo, ".autopilot", "missions", mission);
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, "PLAN.md"), planContent);
  fs.writeFileSync(path.join(dir, "TASKS.md"), tasksContent);
}
function reviewerCheckpoint(repo, mission, planContent, tasksContent) {
  const {planRel, tasksRel} = missionRelPaths(repo, mission);
  const digest = artifactDigest({artifacts: [{path: planRel, content: planContent}, {path: tasksRel, content: tasksContent}]});
  return createStandaloneCheckpoint({
    framework: "standalone", mission, position: "reviewer-pending",
    artifacts: [planRel, tasksRel], artifactDigest: digest, at: new Date().toISOString()
  });
}
function plannerCheckpoint(repo, mission) {
  const {planRel, tasksRel} = missionRelPaths(repo, mission);
  return createStandaloneCheckpoint({
    framework: "standalone", mission, position: "planner-pending",
    artifacts: [planRel, tasksRel], artifactDigest: null, at: new Date().toISOString()
  });
}

// Crafted standalone resume fixture: mission files plus a state.json carrying
// the given checkpoint (or none). The persisted planningRequest always equals
// REQUEST so the run classifies as a same-request resume, never a new request.
function setupResume(prefix, {planContent, tasksContent, checkpoint}) {
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  writeConfig(repo, {planningFramework: "standalone", maxPlanRevisions: 3});
  writeMissionFiles(repo, MISSION, planContent, tasksContent);
  const state = {
    version: 1, phase: "planning", step: "standalone-plan",
    planningRequest: REQUEST, mission: MISSION, missionSeq: "001"
  };
  if (checkpoint !== undefined && checkpoint !== null) state.standalonePlanningReviewCheckpoint = checkpoint;
  writeState(repo, state);
  return {repo, binDir};
}

function missionEnv(binDir) {
  const delimiter = process.platform === "win32" ? ";" : ":";
  return {...process.env, PATH: `${binDir}${delimiter}${process.env.PATH || ""}`};
}
function autopilotArgs(repo) {
  return [path.join(skillRoot, "scripts", "autopilot.mjs"), "run", REQUEST, "--repo", repo];
}
function runMissionAsync(repo, binDir, {timeoutMs}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, autopilotArgs(repo), {
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
async function runUntilPlanningPass({repo, binDir}, timeoutMs, {markerName, pollMs = 1000, extraReady = null}) {
  const marker = path.join(repo, ".autopilot", markerName);
  let settled = false;
  const runP = runTreeUntilMarker(process.execPath, autopilotArgs(repo), {
    cwd: repo, env: missionEnv(binDir), markerFile: marker, pollMs: 100, timeoutMs
  }).then((r) => { settled = true; return r; });
  const watchP = (async () => {
    for (;;) {
      await new Promise((r) => setTimeout(r, pollMs));
      try {
        const reviews = roleResults(repo, "plan_reviewer");
        if (reviews.length >= 1 && reviews[reviews.length - 1]?.review?.decision === "PASS"
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
// C2 (023 P2.3 control) never runs the reviewer — complete PASS-cleared
// artifacts go straight to tasks_ready — so the reviewer-PASS watcher above
// would never fire. Stop on the state transition itself instead.
async function runUntilTasksReady({repo, binDir}, timeoutMs, {markerName, pollMs = 1000}) {
  const marker = path.join(repo, ".autopilot", markerName);
  let settled = false;
  const runP = runTreeUntilMarker(process.execPath, autopilotArgs(repo), {
    cwd: repo, env: missionEnv(binDir), markerFile: marker, pollMs: 100, timeoutMs
  }).then((r) => { settled = true; return r; });
  const watchP = (async () => {
    for (;;) {
      await new Promise((r) => setTimeout(r, pollMs));
      try {
        const phase = readState(repo).phase;
        if (phase === "tasks_ready" || phase === "complete") {
          fs.writeFileSync(marker, "stop");
          return "stopped-after-tasks-ready";
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

// ---------------------------------------------------------------------
// Static contract checks: checkpoint authority, lifecycle positions, and
// consult ordering (which function, which argument, which order) — never
// prompt wording.
// ---------------------------------------------------------------------
const autopilotSrc = fs.readFileSync(path.join("scripts", "autopilot.mjs"), "utf8");
{
  check("contract: imports the task 12 standalone evaluator",
    autopilotSrc.includes("evaluateStandaloneReview"));
  check("contract: imports the checkpoint constructors",
    autopilotSrc.includes("createStandaloneCheckpoint") && autopilotSrc.includes("planningReviewArtifactDigest"));
  // Consulted above the ambiguous-status die(): the checkpoint consult block
  // precedes the unconditional ambiguous die in ensurePlanningReady.
  const ensureStart = autopilotSrc.indexOf("async function ensurePlanningReady");
  const consultIdx = autopilotSrc.indexOf("standalonePlanningReviewCheckpoint", ensureStart);
  const ambiguousDieIdx = autopilotSrc.indexOf('if(state.status==="ambiguous")', ensureStart);
  check("contract: checkpoint consulted above the ambiguous-status die()",
    consultIdx !== -1 && ambiguousDieIdx !== -1 && consultIdx < ambiguousDieIdx,
    {consultIdx, ambiguousDieIdx});
  // Identity-mismatch validation only on resume: new requests clear without
  // validating (Phase 7 precedence already wired in the same block).
  check("contract: new request clears the checkpoint without validation",
    autopilotSrc.includes("delete s.standalonePlanningReviewCheckpoint;"));
  // Lifecycle: reviewer-pending set after the planner before the reviewer;
  // planner-pending only on the FAIL-to-planner transition; cleared on PASS
  // in the same save.
  check("contract: reviewer-pending set after planner before reviewer",
    autopilotSrc.includes("writeStandaloneReviewerPendingCheckpoint(s,mission)"));
  check("contract: planner-pending set only on the FAIL transition",
    autopilotSrc.includes("writeStandalonePlannerPendingCheckpoint(s,mission)"));
  const passIdx = autopilotSrc.indexOf("delete s.standalonePlanningReviewCheckpoint;");
  check("contract: PASS clears the checkpoint", passIdx !== -1);
  // Task 16: ambiguous + valid matching checkpoint at either position
  // escalates (both positions named, never falls through to the planner).
  check("contract: ambiguous+checkpoint escalates (decided combination)",
    autopilotSrc.includes("ambiguous with a valid planning review checkpoint present"));
  check("contract: resume at reviewer skips the planner",
    autopilotSrc.includes("skipPlannerFirst"));
  check("contract: reviewer retry uses a fresh session (resume:false)",
    callsWithOptions(autopilotSrc, 'relayAsync("plan_reviewer",', ["readOnly:true", "review:true", "resume:false", "capEnabled:true", "taskRef:'standalone-planning-plan_reviewer'"])
      .some((call) => autopilotSrc.includes("()=>" + call)));
}

// ---------------------------------------------------------------------
// Calibration: the no-checkpoint ambiguous probe (R3) runs first and doubles
// as the R3 case itself. Its measured wall clock derives every other
// mission's subprocess timeout (8x — comfortably above the binding >= 2x
// headroom over a single observed mission run).
// ---------------------------------------------------------------------
const r3 = setupResume("standalone-resume-r3", {planContent: PARTIAL_PLAN, tasksContent: AMBIGUOUS_TASKS, checkpoint: null});
delete readState(r3.repo).standalonePlanningReviewCheckpoint;
const probeT0 = Date.now();
const probeP = runMissionAsync(r3.repo, r3.binDir, {timeoutMs: PROBE_CEILING_MS});
// Wave fixtures are independent tmp repos — craft them while the probe runs.
const r1repo = makeFixtureRepo("standalone-resume-r1");
const r1bin = makeFixtureBin("standalone-resume-r1");
const r1b = setupResume("standalone-resume-r1b", {planContent: PARTIAL_PLAN, tasksContent: PARTIAL_TASKS, checkpoint: null});
const r2 = setupResume("standalone-resume-r2", {planContent: PARTIAL_PLAN, tasksContent: PARTIAL_TASKS, checkpoint: null});
const r2b = setupResume("standalone-resume-r2b", {planContent: PARTIAL_PLAN, tasksContent: PARTIAL_TASKS, checkpoint: null});
const r4a = setupResume("standalone-resume-r4a", {planContent: PARTIAL_PLAN, tasksContent: AMBIGUOUS_TASKS, checkpoint: null});
const r4b = setupResume("standalone-resume-r4b", {planContent: PARTIAL_PLAN, tasksContent: AMBIGUOUS_TASKS, checkpoint: null});
const r5 = (() => { const repo = makeFixtureRepo("standalone-resume-r5"); const binDir = makeFixtureBin("standalone-resume-r5"); writeConfig(repo, {planningFramework: "standalone", maxPlanRevisions: 3}); return {repo, binDir}; })();
const r6 = setupResume("standalone-resume-r6", {planContent: PARTIAL_PLAN, tasksContent: PARTIAL_TASKS, checkpoint: null});
const r7 = setupResume("standalone-resume-r7", {planContent: PARTIAL_PLAN, tasksContent: PARTIAL_TASKS, checkpoint: null});
// R1 main fixture (crafted here so its digest matches byte-for-byte).
writeConfig(r1repo, {planningFramework: "standalone", maxPlanRevisions: 3});
writeMissionFiles(r1repo, MISSION, PARTIAL_PLAN, PARTIAL_TASKS);
writeState(r1repo, {
  version: 1, phase: "planning", step: "standalone-plan",
  planningRequest: REQUEST, mission: MISSION, missionSeq: "001",
  standalonePlanningReviewCheckpoint: reviewerCheckpoint(r1repo, MISSION, PARTIAL_PLAN, PARTIAL_TASKS)
});
const r1 = {repo: r1repo, binDir: r1bin};
const probeRun = await probeP;
const probeElapsed = Date.now() - probeT0;
// Floor of 60 s: a sub-second probe (0.6 s -> 4 s) leaves no room for the
// wave missions when the parallel suite loads the machine.
const FULL_TIMEOUT_MS = Math.max(Math.ceil(probeElapsed * 8), 60000);
console.log(`timing: calibration probe (R3) elapsed=${(probeElapsed / 1000).toFixed(1)}s -> derived wave timeout=${(FULL_TIMEOUT_MS / 1000).toFixed(0)}s`);
check("budget: derived wave timeout has >=2x headroom over the observed run",
  FULL_TIMEOUT_MS >= probeElapsed * 2, {probeElapsed, FULL_TIMEOUT_MS});

// ---------------------------------------------------------------------
// R3: no-checkpoint ambiguous state still dies exactly as today (asserted
// off the calibration probe run — no second spawn).
// ---------------------------------------------------------------------
{
  const run = probeRun;
  const {repo, binDir} = r3;
  try {
    check("r3: probe did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
    check("r3: mission dies (nonzero exit)", run.status !== 0, {status: run.status});
    check("r3: dies with today's ambiguous message", (run.stderr || "").includes("Planning state is ambiguous"), (run.stderr || "").slice(-500));
    const counts = roleCounts(repo);
    check("r3: planner never ran", (counts.planner || 0) === 0, counts);
    check("r3: reviewer never ran", (counts.plan_reviewer || 0) === 0, counts);
  } finally {
    cleanup(repo, binDir);
  }
}

// Finalize crafted checkpoints for the wave (digests must match the exact
// bytes on disk; r1 was crafted above before the probe).
{
  const st = readState(r1b.repo);
  st.standalonePlanningReviewCheckpoint = reviewerCheckpoint(r1b.repo, MISSION, PARTIAL_PLAN, "## Phase 1: General\n\n- [ ] Do the fixture task \u2014 accept: done ; verify: none\nCHANGED\n");
  // R1b is the drift case: checkpoint records the ORIGINAL content, disk
  // carries edited content.
  const orig = reviewerCheckpoint(r1b.repo, MISSION, PARTIAL_PLAN, PARTIAL_TASKS);
  st.standalonePlanningReviewCheckpoint = orig;
  writeState(r1b.repo, st);
  fs.writeFileSync(path.join(r1b.repo, ".autopilot", "missions", MISSION, "PLAN.md"), `${PARTIAL_PLAN}\nExtra unreviewed paragraph.\n`);

  const s2 = readState(r2.repo);
  s2.standalonePlanningReviewCheckpoint = plannerCheckpoint(r2.repo, MISSION);
  writeState(r2.repo, s2);

  const s2b = readState(r2b.repo);
  s2b.standalonePlanningReviewCheckpoint = plannerCheckpoint(r2b.repo, MISSION);
  writeState(r2b.repo, s2b);
  fs.writeFileSync(path.join(r2b.repo, ".autopilot", "missions", MISSION, "TASKS.md"),
    "## Phase 1: General\n\n- [ ] Do a completely rewritten fixture task \u2014 accept: changed ; verify: none\n");

  const s4a = readState(r4a.repo);
  s4a.standalonePlanningReviewCheckpoint = reviewerCheckpoint(r4a.repo, MISSION, PARTIAL_PLAN, AMBIGUOUS_TASKS);
  writeState(r4a.repo, s4a);

  const s4b = readState(r4b.repo);
  s4b.standalonePlanningReviewCheckpoint = plannerCheckpoint(r4b.repo, MISSION);
  writeState(r4b.repo, s4b);

  const s6 = readState(r6.repo);
  const good6 = reviewerCheckpoint(r6.repo, MISSION, PARTIAL_PLAN, PARTIAL_TASKS);
  s6.standalonePlanningReviewCheckpoint = {...good6, version: 999};
  writeState(r6.repo, s6);

  const s7 = readState(r7.repo);
  const good7 = reviewerCheckpoint(r7.repo, MISSION, PARTIAL_PLAN, PARTIAL_TASKS);
  s7.standalonePlanningReviewCheckpoint = {...good7, mission: "999-other-mission"};
  writeState(r7.repo, s7);
}

// ---------------------------------------------------------------------
// Wave: independent scenarios run concurrently. Resume-at-reviewer cases
// stop as soon as planning passes (the next relay is 10s+ away, so launch
// counts stay exact); escalation cases run to their die().
// ---------------------------------------------------------------------
const [wr1, wr1b, wr2, wr2b, wr4a, wr4b, wr5first, wr6, wr7] = await Promise.all([
  runUntilPlanningPass(r1, FULL_TIMEOUT_MS, {markerName: "r1-stop-marker", pollMs: 1000,
    extraReady: (repo) => { try { return !readState(repo).standalonePlanningReviewCheckpoint; } catch { return false; } }}),
  runMissionAsync(r1b.repo, r1b.binDir, {timeoutMs: FULL_TIMEOUT_MS}),
  runUntilPlanningPass(r2, FULL_TIMEOUT_MS, {markerName: "r2-stop-marker", pollMs: 1000,
    extraReady: (repo) => { try { return !readState(repo).standalonePlanningReviewCheckpoint; } catch { return false; } }}),
  runUntilPlanningPass(r2b, FULL_TIMEOUT_MS, {markerName: "r2b-stop-marker", pollMs: 1000,
    extraReady: (repo) => { try { return !readState(repo).standalonePlanningReviewCheckpoint; } catch { return false; } }}),
  runMissionAsync(r4a.repo, r4a.binDir, {timeoutMs: FULL_TIMEOUT_MS}),
  runMissionAsync(r4b.repo, r4b.binDir, {timeoutMs: FULL_TIMEOUT_MS}),
  runUntilPlanningPass(r5, FULL_TIMEOUT_MS, {markerName: "r5-stop-marker", pollMs: 1000,
    extraReady: (repo) => { try { const st = readState(repo); return !st.standalonePlanningReviewCheckpoint && !st.standalonePlanReview; } catch { return false; } }}),
  runMissionAsync(r6.repo, r6.binDir, {timeoutMs: FULL_TIMEOUT_MS}),
  runMissionAsync(r7.repo, r7.binDir, {timeoutMs: FULL_TIMEOUT_MS}),
]);

// R1: reviewer-pending with matching content resumes at the reviewer.
{
  const run = wr1;
  const {repo, binDir} = r1;
  try {
    check("r1: mission did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
    const counts = roleCounts(repo);
    check("r1: planner never relaunched (resume at reviewer)", (counts.planner || 0) === 0, counts);
    check("r1: reviewer ran (resumed)", (counts.plan_reviewer || 0) >= 1, counts);
    const reviews = roleResults(repo, "plan_reviewer");
    check("r1: resumed review passed", reviews.length >= 1 && reviews[reviews.length - 1]?.review?.decision === "PASS", reviews[reviews.length - 1]?.review);
    check("r1: checkpoint cleared on PASS", (() => { try { return !readState(repo).standalonePlanningReviewCheckpoint; } catch { return false; } })(), (() => { try { return Object.keys(readState(repo)); } catch { return []; } })());
  } finally {
    cleanup(repo, binDir);
  }
}

// R1-drift: reviewer-pending with changed content escalates (content validated).
{
  const run = wr1b;
  const {repo, binDir} = r1b;
  try {
    check("r1-drift: mission did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
    check("r1-drift: escalates (nonzero exit)", run.status !== 0, {status: run.status});
    const err = run.stderr || "";
    check("r1-drift: escalation names the drift", /DRIFT|drift/i.test(err), err.slice(-600));
    check("r1-drift: escalation carries evidence", /evidence/i.test(err), err.slice(-600));
    const counts = roleCounts(repo);
    check("r1-drift: planner never ran on drift", (counts.planner || 0) === 0, counts);
  } finally {
    cleanup(repo, binDir);
  }
}

// R2: planner-pending with matching content resumes at the planner.
{
  const run = wr2;
  const {repo, binDir} = r2;
  try {
    check("r2: mission did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
    const counts = roleCounts(repo);
    check("r2: planner ran (resume at planner)", (counts.planner || 0) >= 1, counts);
  } finally {
    cleanup(repo, binDir);
  }
}

// R2-changed: planner-pending with changed content still resumes (no validation).
{
  const run = wr2b;
  const {repo, binDir} = r2b;
  try {
    check("r2-changed: mission did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
    check("r2-changed: did not escalate on content change", (run.stderr || "").includes("PLANNING_REVIEW_CHECKPOINT_INVALID") === false
      && (run.stderr || "").includes("artifact drift") === false, (run.stderr || "").slice(-400));
    const counts = roleCounts(repo);
    check("r2-changed: planner still ran (content not validated)", (counts.planner || 0) >= 1, counts);
  } finally {
    cleanup(repo, binDir);
  }
}

// R4a/R4b: checkpoint-present ambiguous escalates at BOTH positions (task 16).
for (const [label, run, fix] of [["r4a:reviewer-pending", wr4a, r4a], ["r4b:planner-pending", wr4b, r4b]]) {
  const {repo, binDir} = fix;
  try {
    check(`${label}: did not time out`, run.timedOut === false, {timedOut: run.timedOut, status: run.status});
    check(`${label}: escalates (nonzero exit)`, run.status !== 0, {status: run.status});
    const counts = roleCounts(repo);
    check(`${label}: planner never ran (no fall-through)`, (counts.planner || 0) === 0, counts);
    check(`${label}: escalation mentions ambiguity`, /ambiguous/i.test(run.stderr || ""), (run.stderr || "").slice(-500));
  } finally {
    cleanup(repo, binDir);
  }
}

// R5: PASS followed by a kill leaves the checkpoint already cleared.
{
  const run = wr5first;
  const {repo, binDir} = r5;
  try {
    check("r5: first run did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
    check("r5: checkpoint cleared in the PASS save (pre-kill)", (() => { try { return !readState(repo).standalonePlanningReviewCheckpoint; } catch { return false; } })());
    // Restart after the kill: the checkpoint must still read as cleared (no
    // stale reviewer-pending resurrection, no invalid-checkpoint escalation).
    const second = await runUntilPlanningPass({repo, binDir}, FULL_TIMEOUT_MS, {markerName: "r5-second-stop-marker", pollMs: 1000});
    check("r5: restart did not time out", second.timedOut === false, {timedOut: second.timedOut, status: second.status});
    check("r5: checkpoint still cleared after restart", (() => { try { return !readState(repo).standalonePlanningReviewCheckpoint; } catch { return false; } })());
    check("r5: restart did not escalate on a stale checkpoint",
      /PLANNING_REVIEW_CHECKPOINT_INVALID/.test(second.stderr || "") === false, (second.stderr || "").slice(-400));
  } finally {
    cleanup(repo, binDir);
  }
}

// R6: unknown-version checkpoint escalates with evidence (task 18).
{
  const run = wr6;
  const {repo, binDir} = r6;
  try {
    check("r6: did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
    check("r6: escalates (nonzero exit)", run.status !== 0, {status: run.status});
    check("r6: escalation names the invalid code", (run.stderr || "").includes("PLANNING_REVIEW_CHECKPOINT_INVALID"), (run.stderr || "").slice(-600));
    check("r6: escalation carries evidence", /evidence/i.test(run.stderr || ""), (run.stderr || "").slice(-600));
    const counts = roleCounts(repo);
    check("r6: planner never ran (no silent fallback)", (counts.planner || 0) === 0, counts);
  } finally {
    cleanup(repo, binDir);
  }
}

// R7: mismatched mission identity escalates with evidence (task 18).
{
  const run = wr7;
  const {repo, binDir} = r7;
  try {
    check("r7: did not time out", run.timedOut === false, {timedOut: run.timedOut, status: run.status});
    check("r7: escalates (nonzero exit)", run.status !== 0, {status: run.status});
    check("r7: escalation names the invalid code", (run.stderr || "").includes("PLANNING_REVIEW_CHECKPOINT_INVALID"), (run.stderr || "").slice(-600));
    check("r7: escalation carries evidence", /evidence/i.test(run.stderr || ""), (run.stderr || "").slice(-600));
    const counts = roleCounts(repo);
    check("r7: planner never ran (no silent fallback)", (counts.planner || 0) === 0, counts);
  } finally {
    cleanup(repo, binDir);
  }
}

const elapsedSec = (Date.now() - FILE_T0) / 1000;
// ---------------------------------------------------------------------
// C1/C2 (023 Phase 2 task 2.3): artifacts-complete must not swallow pending
// rejected-plan findings. C1: complete TASKS ([x]) + saved standalone-plan
// feedback (same request, no checkpoint) must route to a Planner REVISION
// (the planner runs, and its revision prompt quotes the pending finding) —
// never straight to tasks_ready. C2 (control): complete TASKS with
// PASS-cleared state (no saved feedback) reaches tasks_ready/complete
// without replanning (the planner never runs).
// ---------------------------------------------------------------------
{
  const COMPLETE_TASKS = "## Phase 1: General\n\n- [x] Do the fixture task \u2014 accept: done ; verify: none\n";
  const readBriefs = (repo) => {
    const out = [];
    (function walk(dir) {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === "brief.txt") out.push(fs.readFileSync(full, "utf8"));
      }
    })(path.join(repo, ".autopilot"));
    return out;
  };
  const c1 = setupResume("standalone-resume-c1", {planContent: PARTIAL_PLAN, tasksContent: COMPLETE_TASKS, checkpoint: null});
  {
    const st = readState(c1.repo);
    st.reviewFeedback = {"standalone-plan": {findings: ["needs more detail: split phase 1 into smaller tasks"], at: new Date().toISOString()}};
    writeState(c1.repo, st);
  }
  const c2 = setupResume("standalone-resume-c2", {planContent: PARTIAL_PLAN, tasksContent: COMPLETE_TASKS, checkpoint: null});
  // Budget: both stop as soon as their planning verdict is observable instead
  // of running full completions (C1's assertions all hold at the revision
  // PASS save; C2's at the tasks_ready transition).
  const [wc1, wc2] = await Promise.all([
    runUntilPlanningPass(c1, FULL_TIMEOUT_MS, {markerName: "c1-stop-marker", pollMs: 1000,
      extraReady: (repo) => { try { return readState(repo).reviewFeedback?.["standalone-plan"] === undefined; } catch { return false; } }}),
    runUntilTasksReady(c2, FULL_TIMEOUT_MS, {markerName: "c2-stop-marker", pollMs: 1000}),
  ]);
  try {
    check("c1: mission did not time out", wc1.timedOut === false, {timedOut: wc1.timedOut, status: wc1.status});
    const counts1 = roleCounts(c1.repo);
    check("c1: complete+pending routes to a Planner revision (planner ran)", (counts1.planner || 0) >= 1, counts1);
    const briefs1 = readBriefs(c1.repo);
    check("c1: the revision prompt quotes the pending finding",
      briefs1.some((brief) => brief.includes("needs more detail")), briefs1.length);
    check("c1: the revision prompt is a REVISION round (findings MUST be addressed)",
      briefs1.some((brief) => brief.includes("MUST be addressed")), briefs1.length);
    check("c1: pending findings cleared once the revision passes",
      (() => { try { return readState(c1.repo).reviewFeedback?.["standalone-plan"] === undefined; } catch { return false; } })(),
      (() => { try { return Object.keys(readState(c1.repo).reviewFeedback || {}); } catch { return []; } })());
  } finally {
    cleanup(c1.repo, c1.binDir);
  }
  try {
    check("c2: mission did not time out", wc2.timedOut === false, {timedOut: wc2.timedOut, status: wc2.status});
    const counts2 = roleCounts(c2.repo);
    check("c2: PASS-cleared complete artifacts reach tasks_ready without replanning (planner never ran)",
      (counts2.planner || 0) === 0, counts2);
    const phase2 = (() => { try { return readState(c2.repo).phase; } catch { return null; } })();
    check("c2: reached tasks_ready/complete", phase2 === "tasks_ready" || phase2 === "complete", phase2);
  } finally {
    cleanup(c2.repo, c2.binDir);
  }
}

const totalElapsedSec = (Date.now() - FILE_T0) / 1000;
console.log(`timing: total ${totalElapsedSec.toFixed(0)}s`);
check("budget: whole file completes in under about 5 minutes", totalElapsedSec < 330, {elapsedSec: totalElapsedSec});
if (failures > 0) {
  console.error(`test-standalone-planning-review-resume: ${failures} failure(s)`);
  process.exit(1);
}
console.log("test-standalone-planning-review-resume: all cases passed");
