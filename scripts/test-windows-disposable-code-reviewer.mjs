#!/usr/bin/env node
// Task 15.4A behavioral proof: Native Windows SpecKit Code Reviewer running
// against the disposable reviewer-workspace copy (scripts/reviewer-workspace.mjs)
// instead of failing closed with READ_ONLY_CONTAINMENT_UNAVAILABLE — the same
// compatibility path task 15.3 gave Plan Reviewer, extended in
// scripts/autopilot.mjs's runRelay() to cover roleName==="code_reviewer" too
// (see the shared `useDisposableReviewerWorkspace` condition). This file does
// NOT re-implement or fork that mechanism — it drives the REAL production
// `node scripts/autopilot.mjs run --repo <repo>` subprocess and observes what
// the shared code path actually does for Code Reviewer specifically.
//
// Exhaustive Plan-Reviewer-side proof (file visibility, symlink handling,
// cleanup-failure junction substitution, malformed/nonzero/negative-control
// scenarios) already exists in test-windows-disposable-plan-reviewer.mjs and
// is not duplicated here — that coverage exercises the identical underlying
// createReviewerWorkspace()/cleanup() primitive this file's Code Reviewer
// calls also go through. This file focuses on what changed for task 15.4A:
// Code Reviewer's own full disposable-copy proof (Section A), the Code
// Review repair loop across two independent disposable workspaces (Section
// B), and the applicability boundary — Plan Reviewer still works (proven by
// the sibling file, not duplicated here), Code Reviewer works, and
// non-SpecKit frameworks still don't (Section C). Task 15.4B1 extended the
// same path to Verifier, so the former "Verifier still fails closed"
// assertions in Sections A and B are stale and have been replaced by the
// current truth; Verifier's own full behavioral proof lives in
// test-windows-disposable-verifier.mjs and is not duplicated here.
//
// Task 15.4A correction: Sections A and B are seeded DIRECTLY at a real
// SpecKit implementation checkpoint — a persisted .autopilot/state.json
// using the current production state contract (see
// seedSpecKitTasksReadyState(), whose shape is the exact one
// scripts/autopilot.mjs's reviewExistingPlanning() itself writes on success:
// phase/step "tasks_ready" plus planningIntent/planningRequest/
// planningDetection/planningStateReview) — rather than leaving state.json
// absent and letting ensurePlanningReady() run a real (if cheap)
// reviewExistingPlanning() gate first. scripts/autopilot.mjs's
// runImplementation() treats "tasks_ready" as already-open work and skips
// ensurePlanningReady() entirely (see its `activePhases` set), so Planner
// and Plan Reviewer are never invoked in these two scenarios — proven
// explicitly below, not just assumed. tasks.md drives exactly one SpecKit
// implementation phase, so the mission proceeds straight to
// Implementer -> Code Reviewer -> (Verifier).
//
// Windows-only: this whole file is a no-op PASS on any other platform (the
// production condition it exercises is itself gated to process.platform===
// "win32"). WSL/Linux bubblewrap coverage for code_reviewer already exists in
// test-relay-scratch-containment.mjs and friends and is unaffected by this
// task — see the task report for the WSL verification commands run instead.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import {runWindowsProcessTreeBounded} from "./test-fixtures/windows-process-tree-runner.mjs";
import {ensureStandaloneSplit} from "./mission-naming.mjs";
import {ensureBaseline, sanitizeKeySegment} from "./implementation-baseline.mjs";
import {declaredDeliverables} from "../adapters/standalone.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");
const CANONICAL_AUTOPILOT = path.join(skillRoot, "scripts", "autopilot.mjs");

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  return false;
};

if (process.platform !== "win32") {
  console.log("SKIP: task 15.4A Native Windows disposable-copy Code Reviewer coverage — not running on win32.");
  process.exit(0);
}

// ---------------------------------------------------------------------
// Small utilities (mirrors test-windows-disposable-plan-reviewer.mjs)
// ---------------------------------------------------------------------

function git(cwd, args) {
  const r = spawnSync("git", args, {cwd, encoding: "utf8", stdio: "pipe", env: withoutOuterGitGuard(process.env), shell: false});
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout || "").trim();
}

function cleanup(...targets) {
  for (const dir of targets) {
    if (!dir) continue;
    try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* best-effort */ }
  }
}

// Task 15.4A correction: the bounded Windows process-tree spawn now lives in
// the shared, independently-regression-tested
// scripts/test-fixtures/windows-process-tree-runner.mjs (see
// test-windows-process-tree-runner.mjs) instead of a local copy — the
// previous local copy called `taskkill` on deadline but never actually
// bounded the wait for it to take effect, so a `taskkill` failure or a child
// whose "close" event never arrived could leave the returned Promise
// pending forever.
//
// assertCleanRun() is the required "never report a timed-out, output-
// overflowed, or termination-failed process as a successful scenario" gate
// — called immediately after every runMission() before any
// scenario-specific assertion is made.
function assertCleanRun(label, result) {
  return check(`${label}: process completed cleanly (no timeout, output overflow, or termination failure)`,
    !result.timedOut && !result.outputLimitExceeded && !result.terminationFailed,
    {timedOut: result.timedOut, outputLimitExceeded: result.outputLimitExceeded, terminationFailed: result.terminationFailed, stdoutTail: (result.stdout || "").slice(-1000), stderrTail: (result.stderr || "").slice(-1000)});
}

// ---------------------------------------------------------------------
// SpecKit fixture (Sections A + B): an ALREADY-complete SpecKit feature at
// the implementation checkpoint (real spec.md/plan.md/tasks.md, no prior
// state.json), plus a TRACKED implementation.txt (so the Implementer's
// modification of it is a genuine tracked-file change, not a new file) and
// a gitignored fixture file (so the disposable copy's exclusion of it can
// be proven).
// ---------------------------------------------------------------------
const WORKFLOW_YML = [
  "- id: specify",
  "  type: command",
  "  command: /speckit.specify",
  "- id: review-spec",
  "  type: gate",
  "  message: Review the spec",
  "- id: plan",
  "  type: command",
  "  command: /speckit.plan",
  "- id: review-plan",
  "  type: gate",
  "  message: Review the plan",
  "- id: tasks",
  "  type: command",
  "  command: /speckit.tasks",
  "- id: review-tasks",
  "  type: gate",
  "  message: Review the tasks",
  "- id: implement",
  "  type: command",
  "  command: /speckit.implement",
  ""
].join("\n");

// The exact shape scripts/autopilot.mjs's reviewExistingPlanning() itself
// persists to .autopilot/state.json on a successful Plan Reviewer PASS at
// this checkpoint (captured directly from a real, live run of this same
// production code — see the task report). Seeding it directly means
// runImplementation()'s activePhases check ("tasks_ready" is open work) and
// its `s.phase!=="tasks_ready" && ...` guard both skip
// ensurePlanningReady() entirely — the mission goes straight to
// "[Implementation]" without ever invoking Planner or Plan Reviewer.
function seedSpecKitTasksReadyState(repo, featureDir) {
  const tasksFileAbsolute = path.join(featureDir, "tasks.md");
  const state = {
    version: 1,
    phase: "tasks_ready",
    step: "tasks_ready",
    taskIndex: 0,
    phaseIndex: 0,
    attempt: 0,
    planningIntent: {kind: "new", reason: "no prior active request"},
    planningRequest: "Use the current project request/context.",
    planningDetection: {
      framework: "speckit", status: "complete", entryIndex: 7,
      evidence: {spec: true, plan: true, tasks: true},
      taskFiles: [tasksFileAbsolute],
      requiresValidation: true, confidence: "high",
      reason: "spec, plan, and tasks artifacts detected"
    },
    sessions: {},
    planningStateReview: {status: "passed", framework: "speckit", phase: null, at: new Date().toISOString()}
  };
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(state, null, 2));
}

function makeSpecKitRepo(prefix) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `ap-win-cr-${prefix}-`));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "windows-cr-test@example.invalid"]);
  git(repo, ["config", "user.name", "Windows Code Reviewer Test"]);

  fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n");
  fs.writeFileSync(path.join(repo, "implementation.txt"), "not-yet-implemented\n");

  const workflowDir = path.join(repo, ".specify", "workflows", "speckit");
  fs.mkdirSync(workflowDir, {recursive: true});
  fs.writeFileSync(path.join(workflowDir, "workflow.yml"), WORKFLOW_YML);

  const featureDir = path.join(repo, "specs", "901-win-code-reviewer-checkpoint");
  fs.mkdirSync(featureDir, {recursive: true});
  fs.writeFileSync(path.join(repo, ".specify", "feature.json"), JSON.stringify({feature_directory: "specs/901-win-code-reviewer-checkpoint"}));
  fs.writeFileSync(path.join(featureDir, "spec.md"), "# Spec\n\nWindows Code Reviewer checkpoint fixture feature.\n");
  fs.writeFileSync(path.join(featureDir, "plan.md"), "# Plan\n\nWindows Code Reviewer checkpoint fixture plan.\n");
  fs.writeFileSync(path.join(featureDir, "tasks.md"), "## Phase 1: Do the windows code review checkpoint task\n\n- [ ] Do the windows code review checkpoint task\n");

  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init: complete speckit fixture at the implementation checkpoint"]);

  // Left uncommitted/untracked on purpose, AFTER the commit — this is the
  // ignored fixture file the disposable copy must exclude. It is never
  // touched by the Implementer.
  fs.writeFileSync(path.join(repo, "ignored.txt"), "ignored-content\n");

  // Seeded AFTER the commit (state.json itself is never committed — it's
  // Autopilot's own bookkeeping) so the mission resumes directly into
  // Implementation instead of running the planning-review gate.
  seedSpecKitTasksReadyState(repo, featureDir);
  return {repo, featureDir};
}

function setScenario(repo, scenario) {
  fs.writeFileSync(path.join(repo, ".autopilot-test-scenario"), scenario);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", `test scenario: ${scenario}`]);
}

function writeSpecKitConfig(repo) {
  const config = {
    schema_version: "3.0",
    project: {repo: ".", planning_framework: "speckit", state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs"},
    roles: Object.fromEntries(["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"].map(role => [
      role, {adapter: "cursor", model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null}
    ])),
    workflow: {
      specReview: true, planReview: true, analysisAfterTasks: false, implementationReview: true, finalReview: true,
      autoApproveSpec: false, autoApprovePlan: false, parallelIndependentTasks: false, gsdPlanningReview: false,
      relaySafety: {block_git_commit_push: true, verify_read_only_by_snapshot: true, capture_touched_files: true, persist_role_sessions: true}
    },
    gates: {commands: [], env_allowlist: [], require_reviewer: true, network_isolation: true},
    policy: {
      // implementationFailureBudget:2 (not the sibling file's 1) is
      // deliberate: Section B's repair loop needs the first Code Review
      // FAIL to be retried automatically WITHIN this one process, rather
      // than immediately escalating.
      max_plan_revisions: 1, retry_delay_ms: 0, checkpoint_after_task: true, checkpoint_after_phase: true,
      require_human_commit: true, fail_closed_on_relay_violation: true,
      failure_budgets: {implementationFailureBudget: 2, verificationFailureBudget: 1, adapterRetryBudget: 1, infrastructureRetryBudget: 1}
    },
    safety: {allow_git_commit: false, allow_git_push: false, allow_destructive_operations: false},
    planning: {
      speckit: {workflow_file: ".specify/workflows/speckit/workflow.yml", task_candidates: [".specify/tasks.md", "specs/*/tasks.md", "specs/*/tasks/*.md"]},
      gsd: {
        phase_root: ".planning/phases", run_plan_verify: true, run_state_validate: true, write_summary_artifacts: true,
        write_verification_artifacts: true, write_uat_artifact: true, use_gsd_tools_when_available: false,
        parallelization: {enabled: false, plan_level: false, task_level: false, max_concurrent_agents: 1, min_plans_for_parallel: 99},
        planning_review: {enabled: false, review_after_each_stage: true, stages: ["discuss", "research", "plan", "plan-check"], max_revisions: 3, read_only_reviewer: true}
      }
    },
    capabilities: {project_defaults: [], role_requirements: {}, safety_denied: [], legacy_text_inference: false, verification: {browser: "native", require_browser: "when-task-requires"}}
  };
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), JSON.stringify(config, null, 2));
}

// ---------------------------------------------------------------------
// Section C boundary fixture: a minimal STANDALONE-framework repository
// seeded directly at its own implementation checkpoint (phase="implementing"
// in state.json — a real, reachable production state; see
// runImplementation()'s activePhases set in scripts/autopilot.mjs, which
// treats "implementing" as open work and skips ensurePlanningReady()
// entirely, exactly like a genuine resumed mission would). This is cheaper
// than a GSD worktree fixture and exercises the SAME single boolean gate
// (`c.project?.planning_framework==="speckit"`) that GSD is also excluded
// by — there is no per-framework special-casing in that condition, so this
// is representative proof that Code Reviewer's Windows compatibility path
// was not accidentally broadened to standalone/GSD.
// ---------------------------------------------------------------------
function makeStandaloneRepo(prefix) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `ap-win-cr-${prefix}-`));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "windows-cr-boundary-test@example.invalid"]);
  git(repo, ["config", "user.name", "Windows Code Reviewer Boundary Test"]);
  const missionDir = path.join(repo, ".autopilot", "missions", "001-standalone-boundary");
  fs.mkdirSync(missionDir, {recursive: true});
  fs.writeFileSync(path.join(missionDir, "PLAN.md"), "# Standalone Plan\n\n- [ ] Do the standalone boundary task\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init: standalone fixture"]);
  return repo;
}

function writeStandaloneConfig(repo) {
  const config = {
    schema_version: "3.0",
    project: {repo: ".", planning_framework: "standalone", state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs"},
    roles: Object.fromEntries(["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"].map(role => [
      role, {adapter: "cursor", model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null}
    ])),
    workflow: {
      specReview: false, planReview: false, analysisAfterTasks: false, implementationReview: true, finalReview: true,
      autoApproveSpec: false, autoApprovePlan: false, parallelIndependentTasks: false, gsdPlanningReview: false,
      relaySafety: {block_git_commit_push: true, verify_read_only_by_snapshot: true, capture_touched_files: true, persist_role_sessions: true}
    },
    gates: {commands: [], env_allowlist: [], require_reviewer: true, network_isolation: true},
    policy: {
      max_plan_revisions: 1, retry_delay_ms: 0, checkpoint_after_task: true, checkpoint_after_phase: true,
      require_human_commit: true, fail_closed_on_relay_violation: true,
      failure_budgets: {implementationFailureBudget: 1, verificationFailureBudget: 1, adapterRetryBudget: 1, infrastructureRetryBudget: 1}
    },
    safety: {allow_git_commit: false, allow_git_push: false, allow_destructive_operations: false},
    planning: {
      speckit: {workflow_file: ".specify/workflows/speckit/workflow.yml", task_candidates: [".specify/tasks.md", "specs/*/tasks.md", "specs/*/tasks/*.md"]},
      gsd: {
        phase_root: ".planning/phases", run_plan_verify: true, run_state_validate: true, write_summary_artifacts: true,
        write_verification_artifacts: true, write_uat_artifact: true, use_gsd_tools_when_available: false,
        parallelization: {enabled: false, plan_level: false, task_level: false, max_concurrent_agents: 1, min_plans_for_parallel: 99},
        planning_review: {enabled: false, review_after_each_stage: true, stages: ["discuss", "research", "plan", "plan-check"], max_revisions: 3, read_only_reviewer: true}
      }
    },
    capabilities: {project_defaults: [], role_requirements: {}, safety_denied: [], legacy_text_inference: false, verification: {browser: "native", require_browser: "when-task-requires"}}
  };
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), JSON.stringify(config, null, 2));
}

function seedStandaloneImplementingState(repo) {
  const mission = "001-standalone-boundary";
  // A real resume into `implementing` always has a baseline: production
  // captures it at `tasks_ready` before the first implementation attempt ever
  // runs, and autopilot.mjs refuses to create one from `implementing`
  // (MIGRATION_BASELINE_MISSING). This fixture seeds `implementing` directly,
  // so simulate that prior capture here — the same pattern
  // test-preflight-deduplication.mjs's seedMissionBaseline() uses: split
  // PLAN.md -> TASKS.md through the production splitter, then capture the
  // mission-scoped baseline with the production declared deliverables.
  ensureStandaloneSplit(repo, {mission});
  ensureBaseline(repo, `mission-${sanitizeKeySegment(mission)}`, {mission, declaredPaths: declaredDeliverables(repo, mission)});
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
    version: 1, phase: "implementing", step: "implement", taskIndex: 0, phaseIndex: 0, attempt: 0,
    mission
  }, null, 2));
}

// ---------------------------------------------------------------------
// Fake "cursor" adapter CLI: a Windows .cmd trampoline around a Node
// script — identical resolution mechanism to
// test-windows-disposable-plan-reviewer.mjs (scripts/agent-process.mjs's
// resolveWindowsBinary()/winShimInvocation()).
//
// Task 15.4A correction: there is deliberately NO "planner"/"plan_reviewer"
// branch here. Sections A and B seed state.json directly at "tasks_ready"
// (seedSpecKitTasksReadyState()), so neither role should ever be invoked —
// if the fixture ever regressed and one WAS invoked, it falls through to
// the "unknown ROLE" branch at the bottom of this script and exits 1,
// making the mistake fail loudly (an unexpected mission failure and a
// missing expected result) rather than silently succeeding.
//
// - implementer: writes an "attempt N" value into implementation.txt (a
//   TRACKED file — modifying it, not creating it) and creates
//   new-feature.txt (untracked, non-ignored). N is derived from an
//   observable, persisted repository counter file, not an in-process
//   variable (each invocation is a fresh Node process).
// - code_reviewer: probes cwd/env/file-visibility/write behavior (the same
//   shape test-windows-disposable-plan-reviewer.mjs's probe uses), then
//   decides PASS/FAIL from what it actually reads: scenario "pass" always
//   PASSes; scenario "repair" FAILs only when it observes "attempt 1" and
//   PASSes otherwise — i.e. the repair loop is driven by real observed
//   repository state, never a reviewer-side counter.
// ---------------------------------------------------------------------
const ADAPTER_SCRIPT = `
import fs from "node:fs";
import path from "node:path";

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("fake-windows-cursor-agent 1.0.0");
  process.exit(0);
}

const PROMPT = await readStdin();
const firstLine = PROMPT.split(/\\r?\\n/, 1)[0] || "";
const role = firstLine.startsWith("ROLE=") ? firstLine.slice("ROLE=".length) : "";

function extractLine(prefix) {
  const re = new RegExp("^" + prefix + "(.*)$", "m");
  const m = PROMPT.match(re);
  return m ? m[1] : null;
}

if (role === "implementer") {
  const cwdNow = process.cwd();
  const counterFile = path.join(cwdNow, ".autopilot-impl-attempts");
  let attemptNum = 1;
  try { attemptNum = parseInt(fs.readFileSync(counterFile, "utf8").trim(), 10) + 1; } catch {}
  fs.writeFileSync(counterFile, String(attemptNum));
  fs.writeFileSync(path.join(cwdNow, "implementation.txt"), "attempt " + attemptNum + "\\n");
  fs.writeFileSync(path.join(cwdNow, "new-feature.txt"), "untracked-content\\n");
  console.log("implementer ok attempt=" + attemptNum);
  // TASK-19 Phase 4 (task 12): a per-task Implementer invocation must end with
  // the AUTOPILOT_TASK_RESULT sentinel (scripts/task-result-contract.mjs) as the
  // final non-empty line, or the SpecKit loop escalates with
  // STRUCTURED_OUTPUT_MISSING and this suite's Code Reviewer path is never
  // reached.
  console.log("AUTOPILOT_TASK_RESULT=" + JSON.stringify({summary: "implementer ok attempt=" + attemptNum, taskLocalCheck: {command: "true", status: "passed", exitCode: 0, summary: "fixture"}}));
  process.exit(0);
}

if (role === "code_reviewer") {
  const cwdAtStart = process.cwd();
  const workspaceRoot = path.dirname(cwdAtStart);
  let scenario = "pass";
  try { scenario = fs.readFileSync(path.join(cwdAtStart, ".autopilot-test-scenario"), "utf8").trim(); } catch {}

  const repository = extractLine("REPOSITORY=");
  const scratchMatch = PROMPT.match(/sanctioned scratch directory: (.*?) \\(/);
  const scratchPath = scratchMatch ? scratchMatch[1] : null;

  const probe = {
    cwd: cwdAtStart,
    workspaceRoot,
    repositoryFromPrompt: repository,
    pwdEnv: process.env.PWD || null,
    initCwdEnv: process.env.INIT_CWD || null,
    safeDirectoryKeyEnv: process.env.GIT_CONFIG_KEY_1 || null,
    safeDirectoryValueEnv: process.env.GIT_CONFIG_VALUE_1 || null,
    scratchPathSeen: scratchPath
  };

  try { probe.trackedContent = fs.readFileSync("implementation.txt", "utf8"); }
  catch (e) { probe.trackedContent = null; probe.trackedError = String(e.code || e.message); }
  try { probe.untrackedContent = fs.readFileSync("new-feature.txt", "utf8"); }
  catch (e) { probe.untrackedContent = null; probe.untrackedError = String(e.code || e.message); }
  probe.ignoredExists = fs.existsSync("ignored.txt");

  try {
    fs.writeFileSync("reviewer-relative-write.txt", "written-by-code-reviewer");
    probe.relativeWrite = "SUCCEEDED";
  } catch (e) {
    probe.relativeWrite = "FAILED:" + (e.code || e.message);
  }

  if (scratchPath) {
    try {
      fs.writeFileSync(path.join(scratchPath, "scratch-write.txt"), "scratch-ok");
      probe.scratchWrite = "SUCCEEDED";
    } catch (e) {
      probe.scratchWrite = "FAILED:" + (e.code || e.message);
    }
  } else {
    probe.scratchWrite = "NO_SCRATCH_PATH_FOUND";
  }

  const probeJson = JSON.stringify(probe);
  console.log("PROBE:" + probeJson);

  let decision = "PASS";
  if (scenario === "repair") {
    decision = probe.trackedContent === "attempt 1\\n" ? "FAIL" : "PASS";
  }
  console.log("AUTOPILOT_REVIEW=" + JSON.stringify({decision, findings: [probeJson]}));
  process.exit(0);
}

// Task 15.4B1: Verifier now runs via the same disposable-copy compatibility
// path. This file does NOT re-prove that path for Verifier (see
// test-windows-disposable-verifier.mjs) — it only needs the role to complete
// so the Code Review coverage above can be observed through to the end of a
// real mission.
if (role === "verifier") {
  console.log("AUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: []}));
  process.exit(0);
}

console.error("fake-windows-adapter: unknown ROLE '" + role + "'");
process.exit(1);
`;

function makeBin(prefix) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), `ap-win-cr-bin-${prefix}-`));
  const scriptPath = path.join(binDir, "windows-disposable-code-reviewer-adapter.mjs");
  fs.writeFileSync(scriptPath, ADAPTER_SCRIPT);
  const cmdPath = path.join(binDir, "cursor-agent.cmd");
  fs.writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\nexit /b %errorlevel%\r\n`);
  return binDir;
}

// ---------------------------------------------------------------------
// Mission runner: NO explicit request text is passed — this is what makes
// runImplementation() see openWork===true from the seeded phase ("tasks_ready"
// for the SpecKit fixtures, "implementing" for the standalone boundary
// fixture) and skip straight into Implementation, never calling
// ensurePlanningReady() at all.
// ---------------------------------------------------------------------
function runMission(repo, binDir, {timeoutMs}) {
    // Strip any outer mission/gate git guard (PATH shim + hooks): the
  // nested mission installs its own, and every git call through both
  // ran the mission several times slower under the orchestrator gate.
  const base = withoutOuterGitGuard({...process.env});
  const env = {...base, PATH: `${binDir};${base.PATH || ""}`};
  return runWindowsProcessTreeBounded(process.execPath, [CANONICAL_AUTOPILOT, "run", "--repo", repo], {cwd: repo, env, timeoutMs});
}

function readAllResults(repo) {
  const root = path.join(repo, ".autopilot");
  const files = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "result.json") files.push(full);
    }
  })(root);
  return files.map(file => ({file, data: JSON.parse(fs.readFileSync(file, "utf8"))}));
}

// Run directories are named "<seq>-<role>-<idshort>" (scripts/autopilot.mjs's
// runDirFor()/nextRunSeq()) — sorting by that numeric prefix recovers the
// TRUE chronological role-invocation order across the whole mission, which
// is exactly what Section B's ordering proof needs.
function sortResultsBySeq(results) {
  return [...results].sort((a, b) => {
    const seqOf = r => parseInt(path.basename(path.dirname(r.file)).split("-")[0], 10) || 0;
    return seqOf(a) - seqOf(b);
  });
}

function extractProbe(result) {
  const findings = result?.review?.findings || result?.verdict?.findings || [];
  for (const finding of findings) {
    try {
      const parsed = JSON.parse(finding);
      if (parsed && typeof parsed === "object" && "cwd" in parsed) return parsed;
    } catch { /* not the probe payload */ }
  }
  return null;
}

function listLeakedTempWorkspaces(prefix) {
  const root = os.tmpdir();
  return fs.readdirSync(root).filter(name => name.startsWith(prefix)).map(name => path.join(root, name));
}

// =======================================================================
// Section A: full disposable-copy proof for Code Reviewer, seeded directly
// at the implementation checkpoint (no Planner/Plan Reviewer involved),
// then Verifier is launched only after Code Review PASS (ordering proof —
// unchanged) and, since task 15.4B1, PASSes via the same path so the
// mission runs to completion.
// =======================================================================
async function runPassScenario(binDir) {
  const {repo} = makeSpecKitRepo("a-pass");
  try {
    writeSpecKitConfig(repo);
    setScenario(repo, "pass");

    const before = {head: git(repo, ["rev-parse", "HEAD"])};
    const implementationBefore = fs.readFileSync(path.join(repo, "implementation.txt"), "utf8");

    const result = await runMission(repo, binDir, {timeoutMs: 150000});
    if (!assertCleanRun("A", result)) return;
    const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`;

    const results = sortResultsBySeq(readAllResults(repo));
    const implementerRuns = results.filter(r => r.data.role === "implementer");
    const codeReviewerRuns = results.filter(r => r.data.role === "code_reviewer");
    const verifierRuns = results.filter(r => r.data.role === "verifier");

    check("A.0: no planner or plan_reviewer result was created (seeded directly at the implementation checkpoint)",
      !results.some(r => r.data.role === "planner" || r.data.role === "plan_reviewer"), results.map(r => r.data.role));
    if (!check("A.1: at least one implementer run recorded (ran against the official fixture repository)", implementerRuns.length > 0, {stdout: (result.stdout || "").slice(-2000), stderr: (result.stderr || "").slice(-2000), timedOut: result.timedOut})) return;
    if (!check("A.3: at least one code_reviewer run recorded (launched after the Implementer)", codeReviewerRuns.length > 0, results.map(r => r.data.role))) return;

    const implementationAfter = fs.readFileSync(path.join(repo, "implementation.txt"), "utf8");
    check("A.2: the Implementer created or modified the TRACKED implementation.txt in the official repository", implementationAfter !== implementationBefore && implementationAfter === "attempt 1\n", {implementationBefore, implementationAfter});

    const cr = codeReviewerRuns[0].data;
    const probe = extractProbe(cr);
    if (!check("A: code_reviewer probe payload recovered from findings", !!probe, cr)) return;

    const officialRepoReal = fs.realpathSync(repo);
    const cwdIsDisposable = typeof probe.cwd === "string" && probe.cwd.length > 0
      && path.resolve(probe.cwd) !== officialRepoReal
      && !path.resolve(probe.cwd).toLowerCase().startsWith(officialRepoReal.toLowerCase() + path.sep);
    check("A.4: Code Reviewer's real cwd is a disposable copy (not the official repo)", cwdIsDisposable, probe.cwd);
    check("A.5a: REPOSITORY in the received prompt equals the reviewer's real cwd (the disposable copy)", probe.repositoryFromPrompt === probe.cwd, probe);
    check("A.5b: official repository path not used as PWD", probe.pwdEnv === probe.cwd, {pwdEnv: probe.pwdEnv, cwd: probe.cwd});
    check("A.5c: official repository path not used as INIT_CWD", probe.initCwdEnv === probe.cwd, {initCwdEnv: probe.initCwdEnv, cwd: probe.cwd});
    check("A.5d: Git guard safe.directory points at the disposable copy, not the official repository", probe.safeDirectoryValueEnv === probe.cwd, probe);
    check("A.6: the reviewer sees the Implementer's current modified tracked-file bytes", probe.trackedContent === "attempt 1\n", probe);
    check("A.7: the reviewer sees an untracked non-ignored implementation file the Implementer created", probe.untrackedContent === "untracked-content\n", probe);
    check("A.8: the reviewer does not see the ignored fixture file", probe.ignoredExists === false, probe);
    check("A.9: a deliberate relative write inside the reviewer's own cwd succeeded (the disposable copy is a plain writable filesystem)", probe.relativeWrite === "SUCCEEDED", probe);
    check("A.10: a scratch write succeeded", probe.scratchWrite === "SUCCEEDED", probe);
    check("A.11a: the reviewer's relative write does not appear in the official repository", !fs.existsSync(path.join(repo, "reviewer-relative-write.txt")));
    check("A.11b: the reviewer's scratch write is not inside the official repository", typeof cr.scratchDir !== "string" || !cr.scratchDir.toLowerCase().startsWith(officialRepoReal.toLowerCase()));
    check("A.12: a valid AUTOPILOT_REVIEW PASS was recognized for Code Review", cr.status === "completed" && cr.verdict?.decision === "PASS", cr);
    check("A.13: the code_reviewer call itself left the official repository's Git state untouched",
      cr.treeChanged === false && cr.readOnlyViolation === false && cr.commitDetected === false && cr.policyViolation === null,
      {treeChanged: cr.treeChanged, readOnlyViolation: cr.readOnlyViolation, commitDetected: cr.commitDetected, policyViolation: cr.policyViolation});
    check("A.14a: the disposable scratch directory was removed afterward", typeof cr.scratchDir === "string" && !fs.existsSync(cr.scratchDir), cr.scratchDir);
    if (typeof cr.scratchDir === "string") {
      check("A.14b: the disposable workspace root was removed afterward", !fs.existsSync(path.dirname(cr.scratchDir)), path.dirname(cr.scratchDir));
    }

    const safety = cr.executionPlaneSafety || {};
    check("A.15a: executionPlaneSafety.mechanism truthfully reports windows-disposable-copy", safety.mechanism === "windows-disposable-copy", safety);
    check("A.15b: executionPlaneSafety.strength truthfully reports compatibility (not OS-enforced)", safety.strength === "compatibility", safety);
    check("A.15c: executionPlaneSafety.envelopeApplied is false (no bubblewrap envelope was used)", safety.envelopeApplied === false, safety);
    check("A.15d: executionPlaneSafety.officialRepositoryUsedAsCwd is false", safety.officialRepositoryUsedAsCwd === false, safety);
    check("A.15e: executionPlaneSafety.scratchRetained is false (truthful — scratch is deleted, never kept for audit)", safety.scratchRetained === false, safety);

    // A.16: Verifier is attempted only after Code Review PASS — proven by
    // sequence-number ordering, not prompt text.
    const crIndex = results.indexOf(codeReviewerRuns[0]);
    const verifierAfterCR = verifierRuns.length === 0 || results.indexOf(verifierRuns[0]) > crIndex;
    check("A.16: no verifier run occurs before the code_reviewer PASS", verifierAfterCR, {crIndex, verifierIndices: verifierRuns.map(r => results.indexOf(r))});
    check("A.16b: Verifier was in fact launched after Code Review PASS", combinedOutput.includes("[Implementation]") && verifierRuns.length > 0, {roles: results.map(r => r.data.role), tail: combinedOutput.slice(-2000)});

    // A.17 (task 15.4B1): Verifier is no longer blocked on native Windows —
    // it runs via the same disposable-copy compatibility path, so the
    // mission that Section A's Code Review PASS opened now runs to
    // completion instead of escalating. Verifier's own full proof is in
    // test-windows-disposable-verifier.mjs; here we only assert that Code
    // Review's PASS was not silently discarded downstream.
    check("A.17a: no read-only role reported READ_ONLY_CONTAINMENT_UNAVAILABLE in this SpecKit mission", !/READ_ONLY_CONTAINMENT_UNAVAILABLE/.test(combinedOutput), combinedOutput.slice(-1500));
    check("A.17b: Verifier completed with a PASS via the disposable-copy path", verifierRuns.length > 0 && verifierRuns[0].data.status === "completed" && verifierRuns[0].data.verdict?.decision === "PASS", verifierRuns[0]?.data);
    check("A.17c: mission process exited 0 (Code Review PASS carried through to a completed mission)", result.status === 0 && /ALL WORK COMPLETE/.test(combinedOutput), {status: result.status, timedOut: result.timedOut, tail: combinedOutput.slice(-1500)});
    check("A.17d: no run in this mission ever claims an OS-enforced containment envelope was applied",
      results.every(r => (r.data.executionPlaneSafety || {}).envelopeApplied !== true),
      results.map(r => ({role: r.data.role, safety: r.data.executionPlaneSafety})));

    const after = {head: git(repo, ["rev-parse", "HEAD"])};
    check("A: the official repository HEAD is unchanged throughout (Autopilot never commits)", before.head === after.head, {before, after});
  } finally {
    cleanup(repo);
  }
}

// =======================================================================
// Section B: Code Review repair loop, seeded directly at the implementation
// checkpoint (no Planner/Plan Reviewer involved) and driven entirely by
// observable repository state (the "attempt N" value each real Implementer
// run writes, and what each independent Code Reviewer disposable copy
// actually reads — never an in-process/reviewer-side counter).
// =======================================================================
async function runRepairLoopScenario(binDir) {
  const {repo} = makeSpecKitRepo("b-repair");
  try {
    writeSpecKitConfig(repo);
    setScenario(repo, "repair");

    // Twice the relay calls of Section A (two Implementer + two Code
    // Reviewer attempts, plus the Verifier failure) — a more generous
    // ceiling than Section A/C's. This is a per-mission SAFETY VALVE against
    // a genuine hang, not the expected runtime; see the task report for the
    // actual measured time on this machine.
    const result = await runMission(repo, binDir, {timeoutMs: 250000});
    if (!assertCleanRun("B", result)) return;
    const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`;

    const results = sortResultsBySeq(readAllResults(repo));
    const implementerRuns = results.filter(r => r.data.role === "implementer");
    const codeReviewerRuns = results.filter(r => r.data.role === "code_reviewer");
    const verifierRuns = results.filter(r => r.data.role === "verifier");

    check("B.0: no planner or plan_reviewer result was created (seeded directly at the implementation checkpoint)",
      !results.some(r => r.data.role === "planner" || r.data.role === "plan_reviewer"), results.map(r => r.data.role));
    if (!check("B: exactly two implementer attempts recorded", implementerRuns.length === 2, {stdout: (result.stdout || "").slice(-2500), stderr: (result.stderr || "").slice(-1500), timedOut: result.timedOut, roles: results.map(r => r.data.role)})) return;
    // Task 15.4B1: the mission no longer stops at the Verifier, so after the
    // second (PASS) phase Code Review the mission also runs its FINAL
    // repository code review — three code_reviewer runs in total. The two
    // phase attempts this section is about are still exactly the first two,
    // in sequence order.
    if (!check("B: exactly three code_reviewer runs recorded (two phase attempts, one per disposable workspace, plus the final repository review)", codeReviewerRuns.length === 3, results.map(r => r.data.role))) return;

    const firstCR = codeReviewerRuns[0].data;
    const secondCR = codeReviewerRuns[1].data;
    const firstProbe = extractProbe(firstCR);
    const secondProbe = extractProbe(secondCR);

    check("B: the first Implementer attempt wrote \"attempt 1\"", firstProbe?.trackedContent === "attempt 1\n", firstProbe);
    check("B: the first Code Reviewer copy observed attempt 1 and returned FAIL", firstCR.verdict?.decision === "FAIL", firstCR.verdict);
    check("B: the second Implementer attempt wrote \"attempt 2\"", secondProbe?.trackedContent === "attempt 2\n", secondProbe);
    check("B: the second Code Reviewer copy observed attempt 2 and returned PASS", secondCR.status === "completed" && secondCR.verdict?.decision === "PASS", secondCR.verdict);

    // Ordering: implementer(1) -> code_reviewer(1, FAIL) -> implementer(2) -> code_reviewer(2, PASS) -> (verifier).
    const seqIndexOf = entry => results.indexOf(entry);
    const orderingCorrect = seqIndexOf(implementerRuns[0]) < seqIndexOf(codeReviewerRuns[0])
      && seqIndexOf(codeReviewerRuns[0]) < seqIndexOf(implementerRuns[1])
      && seqIndexOf(implementerRuns[1]) < seqIndexOf(codeReviewerRuns[1]);
    check("B: ordering is correct — implementer(1) -> code_reviewer(1,FAIL) -> implementer(2) -> code_reviewer(2,PASS)", orderingCorrect,
      {implementer: implementerRuns.map(seqIndexOf), codeReviewer: codeReviewerRuns.map(seqIndexOf)});

    check("B: the two Code Reviewer runs used distinct disposable workspaces", !!firstProbe?.workspaceRoot && !!secondProbe?.workspaceRoot && firstProbe.workspaceRoot !== secondProbe.workspaceRoot,
      {first: firstProbe?.workspaceRoot, second: secondProbe?.workspaceRoot});

    check("B: the first disposable workspace's scratch dir was removed", typeof firstCR.scratchDir === "string" && !fs.existsSync(firstCR.scratchDir), firstCR.scratchDir);
    check("B: the first disposable workspace root was removed", typeof firstCR.scratchDir === "string" && !fs.existsSync(path.dirname(firstCR.scratchDir)), firstCR.scratchDir && path.dirname(firstCR.scratchDir));
    check("B: the second disposable workspace's scratch dir was removed", typeof secondCR.scratchDir === "string" && !fs.existsSync(secondCR.scratchDir), secondCR.scratchDir);
    check("B: the second disposable workspace root was removed", typeof secondCR.scratchDir === "string" && !fs.existsSync(path.dirname(secondCR.scratchDir)), secondCR.scratchDir && path.dirname(secondCR.scratchDir));

    // Official implementation changes preserved: the official repo reflects
    // the LATEST real Implementer write, never reverted by the failed
    // first attempt or by anything either disposable copy did.
    const finalImplementation = fs.readFileSync(path.join(repo, "implementation.txt"), "utf8");
    check("B: the official repository's implementation.txt reflects the final, successful attempt (\"attempt 2\")", finalImplementation === "attempt 2\n", finalImplementation);

    // Reviewer-relative writes from EITHER disposable copy never reach the
    // official repository.
    check("B: no reviewer-relative-write.txt exists in the official repository (neither disposable copy's write ever reached it)", !fs.existsSync(path.join(repo, "reviewer-relative-write.txt")));

    // Verifier must not launch before the second Code Review PASS.
    const verifierBeforeSecondPass = verifierRuns.some(r => seqIndexOf(r) < seqIndexOf(codeReviewerRuns[1]));
    check("B: Verifier never launches before the second Code Review PASS", !verifierBeforeSecondPass, {verifierIndices: verifierRuns.map(seqIndexOf), secondCRIndex: seqIndexOf(codeReviewerRuns[1])});
    check("B: Verifier was launched after the second Code Review PASS and (task 15.4B1) completed with a PASS instead of failing closed",
      verifierRuns.length > 0 && verifierRuns[verifierRuns.length - 1].data.status === "completed" && verifierRuns[verifierRuns.length - 1].data.verdict?.decision === "PASS",
      {verifierRuns: verifierRuns.map(r => r.data.verdict), tail: combinedOutput.slice(-1500)});
    check("B: no read-only role reported READ_ONLY_CONTAINMENT_UNAVAILABLE across the whole repair loop", !/READ_ONLY_CONTAINMENT_UNAVAILABLE/.test(combinedOutput), combinedOutput.slice(-1500));
  } finally {
    cleanup(repo);
  }
}

// =======================================================================
// Section C (requirement G.2): standalone missions now use the same
// disposable-copy compatibility path as SpecKit, broadened in task 15.3B
// to include both planning frameworks. The exact same condition that gates
// SpecKit (`useDisposableReviewerWorkspace` in scripts/autopilot.mjs's
// runRelay()) now covers both. This section verifies the broadened boundary
// works for standalone the same way it works for SpecKit.
// =======================================================================
async function runStandaloneBoundaryScenario(binDir) {
  const repo = makeStandaloneRepo("c-standalone");
  try {
    writeStandaloneConfig(repo);
    seedStandaloneImplementingState(repo);

    const result = await runMission(repo, binDir, {timeoutMs: 130000});
    if (!assertCleanRun("C", result)) return;
    const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`;

    check("C.1: standalone mission exits 0 via disposable-copy (same compatibility path as SpecKit)", result.status === 0, {status: result.status, timedOut: result.timedOut});
    check("C.2: disposable-copy compatibility language appears for the standalone framework",
      /disposable-copy compatibility isolation/.test(combinedOutput),
      combinedOutput.slice(-1500));

    const results = readAllResults(repo);
    check("C.3: code_reviewer run recorded a PASS for the standalone fixture", results.some(r => r.data.role === "code_reviewer" && r.data.verdict?.decision === "PASS"), results.map(r => r.data.role));
    check("C.4: mission completed with no READ_ONLY_CONTAINMENT_UNAVAILABLE error (read-only roles used disposable-copy path)", !/READ_ONLY_CONTAINMENT_UNAVAILABLE/.test(combinedOutput), combinedOutput.slice(-1500));
  } finally {
    cleanup(repo);
  }
}

// =======================================================================
// Run everything, then verify no process-tree/temp-workspace leaks remain.
// =======================================================================
async function main() {
  const overallStart = Date.now();

  const leakPrefixes = ["ap-win-cr-a-pass-", "ap-win-cr-b-repair-", "ap-win-cr-c-standalone-", "ap-win-cr-bin-", "autopilot-reviewer-"];
  const preExisting = new Set(leakPrefixes.flatMap(listLeakedTempWorkspaces));

  // A single shared bin directory for every scenario (same "cursor" binary
  // content for all three): minimizes AV first-scan/spawn setup overhead,
  // matching test-windows-disposable-plan-reviewer.mjs's sharedBinDir
  // convention. Safe to share across concurrently-running missions — the
  // fake adapter reads scenario state from ITS OWN invocation's cwd (each
  // scenario's own fixture repo/disposable copy), never from anything
  // global.
  const sharedBinDir = makeBin("shared");

  // Warmup: invoke the shared cursor-agent.cmd once, alone, before any
  // scenario starts. A fresh executable's FIRST invocation on Windows can
  // pay a real (sometimes substantial) antivirus real-time-scan cost that
  // subsequent invocations of the byte-identical, already-cleared file do
  // not — observed directly in this file's own development: whichever
  // scenario happened to launch its Implementer first paid that cost
  // unpredictably and could stall well past a generous per-scenario
  // deadline, while later scenarios sailed through fast. Paying it once
  // here, uncontended and outside any scenario's own timeout budget, means
  // no scenario's result depends on winning or losing that race.
  const warmup = await runWindowsProcessTreeBounded("cmd.exe", ["/d", "/s", "/c", path.join(sharedBinDir, "cursor-agent.cmd"), "--version"], {timeoutMs: 60000});
  check("warmup: the shared adapter binary responds to --version before any scenario starts", warmup.status === 0 && !warmup.timedOut, warmup);

  // Sequential, not concurrent: three `ap run` missions launching their own
  // preflight probes and relay-call subprocess trees at the same time was
  // measured (in this file's own development) to cause a FAR worse than
  // additive slowdown under real-time antivirus behavior monitoring — the
  // most expensive scenario (B) reliably completed in isolation but stalled
  // indefinitely when run concurrently with A and C. Running one mission at
  // a time is the predictable, boring choice: each scenario is bounded by
  // its own timeoutMs regardless, and the measured sequential total is what
  // gets reported below.
  await runRepairLoopScenario(sharedBinDir);
  await runPassScenario(sharedBinDir);
  await runStandaloneBoundaryScenario(sharedBinDir);

  cleanup(sharedBinDir);

  const leakedFixtures = leakPrefixes.flatMap(listLeakedTempWorkspaces).filter(p => !preExisting.has(p));
  check("no leftover fixture/bin/disposable-reviewer-workspace temp directories remain (beyond what pre-existed this run)", leakedFixtures.length === 0, leakedFixtures);

  const survivorCheck = spawnSync("powershell", ["-NoProfile", "-Command",
    `(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*windows-disposable-code-reviewer-adapter.mjs*' -or $_.CommandLine -like '*ap-win-cr-bin-*' } | Measure-Object).Count`
  ], {encoding: "utf8"});
  const survivorCount = parseInt((survivorCheck.stdout || "0").trim(), 10) || 0;
  check("no surviving cmd.exe/node.exe descendant of this test's fake adapter remains", survivorCount === 0, {survivorCount, stderr: survivorCheck.stderr});

  const elapsedSeconds = ((Date.now() - overallStart) / 1000).toFixed(1);
  console.log(`\n(total runtime: ${elapsedSeconds}s)`);

  if (failures) {
    console.error(`\n${failures} windows disposable code-reviewer check(s) failed.`);
    process.exit(1);
  }
  console.log("\nwindows disposable code-reviewer PASS (A + B + C)");
}

await main();
