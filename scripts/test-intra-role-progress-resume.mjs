#!/usr/bin/env node
// TASK-19 Phase 4 task 13 — subprocess-driven Implementer per-task dispatch
// tests (`scripts/autopilot.mjs run`, never an import of autopilot.mjs).
//
// The Implementer is a WRITABLE role, so every case here runs natively: a
// pre-seeded phase-stage checkpoint resumes the mission directly at the
// Implementer stage, which skips planning and its read-only plan reviewer
// entirely. The mission then reaches the read-only Code Reviewer only AFTER
// the Implementer work this file asserts, so its outcome is irrelevant and
// never observed here.
//
// Platform note (recorded, not hidden): the Code Reviewer / Verifier
// per-task cases named in TASK-8's Tests 2, 3, and 4 are implemented by
// tasks 17/19 and need WSL2/Linux bubblewrap (or the SpecKit disposable
// path); they are deliberately NOT asserted here rather than faked.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  makeFixtureRepo, makeFixtureBin, setScenario, writeConfig,
  runAutopilot, runAutopilotUntilMarker, readObservedEvents, cleanup,
} from "./test-fixtures/workflow-order-harness.mjs";
import {ensureBaseline, sanitizeKeySegment} from "./implementation-baseline.mjs";
import {phaseTaskDigest, CHECKPOINT_STATE_KEY} from "./phase-stage-checkpoint.mjs";
import * as standalone from "../adapters/standalone.mjs";

const REQUEST = "intra role fixture request";
const MISSION = "001-intra-role";
const RUN_TIMEOUT_MS = 300000;

let ok = 0;
let failed = 0;
function check(name, condition, evidence) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(evidence)}` : ""}`);
  failed += 1;
}

function tenTaskPhase() {
  const lines = ["## Phase 1: Ten tasks", ""];
  for (let i = 1; i <= 10; i += 1) lines.push(`- [ ] Task number ${i}`);
  return `${lines.join("\n")}\n`;
}

// Backlog #83: the orchestrator deletes the phase checkpoint on phase PASS, so
// checkpoint reads must happen while the Code Reviewer is running. The fake
// Code Reviewer (hold-file knob) blocks; a read-only role cannot drop a marker
// file, so the test creates the marker itself once the reviewer's run
// directory appears, and runAutopilotUntilMarker then kills the whole tree.
function reviewerRunStarted(repo) {
  const missions = path.join(repo, ".autopilot", "missions");
  try {
    for (const m of fs.readdirSync(missions)) {
      const runs = path.join(missions, m, "runs");
      if (fs.existsSync(runs) && fs.readdirSync(runs).some((d) => /^\d+-code_reviewer-/.test(d))) return true;
    }
  } catch { /* not created yet */ }
  return false;
}
// The sandboxed reviewer's `sleep` lives in a process group the harness's tree
// kill does not reach; reap it (identified by its unique duration) so no fake
// process outlives the test.
function reapHeldReviewer() {
  for (const pid of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      if (fs.readFileSync(`/proc/${pid}/cmdline`, "utf8") !== "sleep\x007301\x00") continue;
      const pgid = fs.readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "").split(" ")[2];
      try { process.kill(-Number(pgid), "SIGKILL"); } catch { /* group already gone */ }
      process.kill(Number(pid), "SIGKILL");
    } catch { /* process vanished or not ours */ }
  }
}
async function runUntilReviewer(repo, binDir) {
  const markerFile = `${repo}-reviewer-marker`; // outside the repo tree
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", ".autopilot-test-reviewer-hold"), "");
  const watcher = setInterval(() => {
    if (reviewerRunStarted(repo)) fs.writeFileSync(markerFile, "");
  }, 25);
  try {
    return await runAutopilotUntilMarker(repo, binDir, {request: REQUEST, markerFile, timeoutMs: RUN_TIMEOUT_MS});
  } finally { clearInterval(watcher); fs.rmSync(markerFile, {force: true}); reapHeldReviewer(); }
}

function readState(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
}

// Seed a valid revision-1 checkpoint at the Implementer stage so the shared
// planning gate resumes and skips planning/review (TASK-7 behaviour). The
// digest is computed exactly as the orchestrator computes it.
function seedImplementerCheckpoint(repo, tasksContent) {
  const planFile = standalone.planPath(repo, MISSION);
  const tasksFile = standalone.tasksPath(repo, MISSION);
  fs.mkdirSync(path.dirname(planFile), {recursive: true});
  fs.writeFileSync(planFile, "# Plan\n\nObjective: intra-role fixture.\n");
  fs.writeFileSync(tasksFile, tasksContent);
  const phases = standalone.phases(repo, MISSION);
  const phase = phases[0];
  const digest = phaseTaskDigest({
    framework: "standalone", mission: MISSION, phaseIndex: 0,
    phaseName: phase.name, tasks: phase.tasks.map((t) => ({file: t.file, text: t.text})), repoRoot: repo,
  });
  const missionKey = `mission-${sanitizeKeySegment(MISSION)}`;
  ensureBaseline(repo, missionKey, {mission: MISSION, declaredPaths: []});
  ensureBaseline(repo, `${missionKey}-phase-0`, {mission: MISSION, declaredPaths: []});
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
    version: 1, phase: "tasks_ready", step: "tasks_ready",
    phaseIndex: 0, attempt: 1, mission: MISSION, planningRequest: REQUEST,
    [CHECKPOINT_STATE_KEY]: {
      version: 1, framework: "standalone", mission: MISSION, phaseIndex: 0,
      phaseName: phase.name, phaseTaskDigest: digest, revision: 1,
      nextStage: "implementer", runningStage: "implementer",
      attempts: {implementer: 0, code_reviewer: 0, verifier: 0},
      baselineKey: `${missionKey}-phase-0`, deltaDigest: null,
      implementer: null, codeReviewer: null, verifier: null,
      updatedAt: new Date().toISOString(),
    },
  }, null, 2));
}

function setup(prefix, scenario = "intra_role_ten", tasksContent = tenTaskPhase()) {
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  writeConfig(repo, {planningFramework: "standalone"});
  setScenario(repo, scenario);
  seedImplementerCheckpoint(repo, tasksContent);
  return {repo, binDir};
}

function implementerEvents(repo) {
  return readObservedEvents(repo).filter((e) => e.role === "implementer");
}

function implementerBriefs(repo) {
  return implementerEvents(repo).map((e) => {
    try { return fs.readFileSync(path.join(path.dirname(e.file), "brief.txt"), "utf8"); }
    catch { return ""; }
  });
}

// ── Case A: ten tasks => exactly ten fresh task-local Implementer sessions ─
{
  const {repo, binDir} = setup("intra-a");
  try {
    const run = await runUntilReviewer(repo, binDir);
    check("A: the run reached the Code Reviewer and was killed there", run.markerObserved && run.killed, run);
    const events = implementerEvents(repo);
    check("A: exactly ten Implementer invocations for a ten-task phase", events.length === 10, {count: events.length});
    const briefs = implementerBriefs(repo);
    const taskIds = briefs.map((b) => (/^currentTaskId: (.*)$/m.exec(b) ?? [])[1]).filter(Boolean);
    check("A: each invocation names a distinct current task", new Set(taskIds).size === 10, taskIds);
    check("A: no invocation carries a prior task's session id",
      !briefs.some((b) => /sessionId|resume the previous/i.test(b)), {sample: briefs[0]?.slice(0, 200)});
    const progress = readState(repo)[CHECKPOINT_STATE_KEY]?.roleProgress?.implementer;
    check("A: the cursor records all ten completed task IDs", progress?.completedTaskIds?.length === 10, progress);
    const facts = progress?.factsByTask ?? {};
    const outputFiles = Object.values(facts).flatMap((f) => f.files ?? []).filter((p) => p.startsWith("output/"));
    check("A: per-task files were attributed from the tree, not the model",
      Object.keys(facts).length === 10 && outputFiles.length === 10, {facts: Object.keys(facts).length, outputFiles: outputFiles.length});
    check("A: task-local checks were recorded", Object.values(progress?.factsByTask ?? {}).every((f) => f.taskLocalCheck?.status === "passed"));
  } finally { cleanup(repo, binDir); }
}

// ── Case B: kill during the fresh T8 call resumes T8; T1-T7 never rerun ───
{
  const {repo, binDir} = setup("intra-b");
  try {
    const marker = path.join(repo, ".autopilot-test-intra-t8-marker");
    const first = await runAutopilotUntilMarker(repo, binDir, {request: REQUEST, markerFile: marker, timeoutMs: RUN_TIMEOUT_MS});
    check("B: the T8 marker was observed and the tree was killed", first.markerObserved && first.killed, first);
    const afterKill = implementerEvents(repo);
    check("B: the kill landed inside the eighth invocation (seven durable results)", afterKill.length === 7, {count: afterKill.length});

    const second = await runUntilReviewer(repo, binDir);
    check("B: the resumed run reached the Code Reviewer and was killed there", second.markerObserved && second.killed, second);
    const total = implementerEvents(repo);
    check("B: resume repeats only T8-T10 (ten durable results total, no T1-T7 relaunch)", total.length === 10, {count: total.length});
    const progress = readState(repo)[CHECKPOINT_STATE_KEY]?.roleProgress?.implementer;
    check("B: T8 is present exactly once in completedTaskIds",
      progress?.completedTaskIds?.filter((id) => id.endsWith(":T7:") || /:T7:/.test(id)).length <= 1 && progress?.completedTaskIds?.length === 10, progress?.completedTaskIds);
  } finally { cleanup(repo, binDir); }
}

// ── Case C: no progress helper, journal, env channel, or model-written state ─
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const wiring = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
  check("C: no progress journal environment variable exists", !/AUTOPILOT_PROGRESS|PROGRESS_JOURNAL/i.test(wiring));
  check("C: no model-written state path exists", !/model.*state\.json|state\.json.*model/i.test(wiring));
  const modules = ["role-progress-commit.mjs", "task-result-contract.mjs", "task-attribution.mjs"];
  for (const file of modules) {
    const src = fs.readFileSync(path.join(here, file), "utf8");
    check(`C: ${file} does not write state`, !src.includes("writeFileSync") && !src.includes("process.env"));
  }
}

// ── Case D: work-ahead signal is recorded, evidence-only, never a die() ───
{
  const tasks = [
    "## Phase 1: Ahead", "",
    "- [ ] Task one", "- [ ] Task two", "- [ ] Task three",
    "- [ ] Task four edits output/ahead.txt", "",
  ].join("\n");
  const {repo, binDir} = setup("intra-d", "intra_role_work_ahead", tasks);
  try {
    const run = await runUntilReviewer(repo, binDir);
    check("D: the run reached the Code Reviewer and was killed there", run.markerObserved && run.killed, run);
    const checkpoint = readState(repo)[CHECKPOINT_STATE_KEY];
    const ahead = checkpoint?.roleProgressWorkAhead ?? [];
    const paths = ahead.flatMap((entry) => (entry.workAhead ?? []).map((h) => h.path));
    check("D: a path named by a later task is recorded as a work-ahead fact",
      paths.includes("output/ahead.txt"), ahead);
    check("D: the work-ahead fact names the task that produced it",
      ahead.some((entry) => /:T0:/.test(entry.taskId)), ahead);
    check("D: work-ahead is evidence-only — the phase advanced to code review, never died",
      checkpoint?.nextStage === "code_reviewer", checkpoint?.nextStage);
    check("D: the producing task still checkpointed normally",
      checkpoint?.roleProgress?.implementer?.completedTaskIds?.length === 4, checkpoint?.roleProgress?.implementer);
  } finally { cleanup(repo, binDir); }
}

// ── Case E: crash AFTER the role returns, BEFORE the checkpoint persists ──
// The adapter exits 0 normally and the ORCHESTRATOR is killed by the
// test-only marker in the narrow window after the child returned and before
// commitTaskResult/saveState — the window an adapter-side sleep cannot reach.
{
  const {repo, binDir} = setup("intra-e", "intra_role_crash_after_role");
  try {
    const first = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: RUN_TIMEOUT_MS});
    check("E: the post-return crash terminated the orchestrator", first.status === 137, {status: first.status});
    const mid = readState(repo)[CHECKPOINT_STATE_KEY]?.roleProgress?.implementer;
    check("E: the cursor is left on the current task, un-advanced",
      typeof mid?.currentTaskId === "string" && !mid.completedTaskIds.includes(mid.currentTaskId), mid);
    check("E: only the two prior tasks were durably committed before the crash",
      mid?.completedTaskIds?.length === 2, mid?.completedTaskIds);
    const crashed = mid?.currentTaskId;

    const second = await runUntilReviewer(repo, binDir);
    check("E: the resumed run reached the Code Reviewer and was killed there", second.markerObserved && second.killed, second);
    const done = readState(repo)[CHECKPOINT_STATE_KEY]?.roleProgress?.implementer;
    check("E: resume commits all ten tasks exactly once",
      done?.completedTaskIds?.length === 10 && new Set(done.completedTaskIds).size === 10, done?.completedTaskIds);
    check("E: the crashed task appears exactly once in completedTaskIds",
      done?.completedTaskIds?.filter((id) => id === crashed).length === 1, {crashed});
    check("E: the crashed task ran twice (returned then repeated), every other task once",
      implementerEvents(repo).length === 11, {count: implementerEvents(repo).length});
  } finally { cleanup(repo, binDir); }
}

// ── Case F: SpecKit ten-task phase => ten fresh Implementer sessions ─────
// TASK-19 Phase 8 task 20 ("run the full matrix across both Standalone and
// SpecKit"). SpecKit shares task 12's per-task Implementer dispatch wiring;
// this case proves it through the same fixture scenario, seeded directly at
// `tasks_ready` (the shape adapters/planning-state.mjs classifies as complete)
// so planning and its read-only reviewer are skipped. Assertions read the
// OBSERVED invocations (events + briefs), not the post-mission checkpoint, so
// the case holds whether the mission halts at the read-only reviewer or runs
// to completion.
{
  const repo = makeFixtureRepo("intra-f");
  const binDir = makeFixtureBin("intra-f");
  try {
    const featureDir = path.join(repo, "specs", "001-intra-role");
    fs.mkdirSync(featureDir, {recursive: true});
    const workflowDir = path.join(repo, ".specify", "workflows", "speckit");
    fs.mkdirSync(workflowDir, {recursive: true});
    fs.writeFileSync(path.join(workflowDir, "workflow.yml"), [
      "- id: specify", "  type: command", "  command: /speckit.specify",
      "- id: review-spec", "  type: gate", "  message: Review the spec",
      "- id: plan", "  type: command", "  command: /speckit.plan",
      "- id: review-plan", "  type: gate", "  message: Review the plan",
      "- id: tasks", "  type: command", "  command: /speckit.tasks",
      "- id: review-tasks", "  type: gate", "  message: Review the tasks",
      "- id: implement", "  type: command", "  command: /speckit.implement",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(repo, ".specify", "feature.json"), JSON.stringify({feature_directory: "specs/001-intra-role"}));
    fs.writeFileSync(path.join(featureDir, "spec.md"), "# Spec\n\nintra-role speckit fixture.\n");
    fs.writeFileSync(path.join(featureDir, "plan.md"), "# Plan\n\nintra-role speckit fixture.\n");
    fs.writeFileSync(path.join(featureDir, "tasks.md"), tenTaskPhase());
    writeConfig(repo, {planningFramework: "speckit"});
    setScenario(repo, "intra_role_ten");
    fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
    fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
      version: 1, phase: "tasks_ready", step: "tasks_ready",
      taskIndex: 0, phaseIndex: 0, attempt: 0, mission: MISSION,
      planningIntent: {kind: "new", reason: "no prior active request"},
      planningRequest: REQUEST,
      planningDetection: {
        framework: "speckit", status: "complete", entryIndex: 7,
        evidence: {spec: true, plan: true, tasks: true},
        taskFiles: [path.join(featureDir, "tasks.md")],
        requiresValidation: true, confidence: "high",
        reason: "spec, plan, and tasks artifacts detected",
      },
      sessions: {},
      planningStateReview: {status: "passed", framework: "speckit", phase: null, at: new Date().toISOString()},
    }, null, 2));
    runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: RUN_TIMEOUT_MS});
    const events = implementerEvents(repo);
    check("F: SpecKit ten-task phase uses exactly ten Implementer invocations", events.length === 10, {count: events.length});
    const briefs = implementerBriefs(repo);
    const taskIds = briefs.map((b) => (/^currentTaskId: (.*)$/m.exec(b) ?? [])[1]).filter(Boolean);
    check("F: SpecKit each invocation names a distinct current task", new Set(taskIds).size === 10, taskIds);
    check("F: SpecKit no invocation carries a prior task's session id",
      !briefs.some((b) => /sessionId|resume the previous/i.test(b)), {sample: briefs[0]?.slice(0, 200)});
  } finally { cleanup(repo, binDir); }
}

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
