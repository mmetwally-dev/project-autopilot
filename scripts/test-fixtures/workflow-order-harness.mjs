// Shared harness for the workflow-order behavioral tests
// (test-workflow-order-*.mjs). Builds a disposable git fixture repo wired to
// scripts/test-fixtures/fake-workflow-adapter.sh (the "cursor" adapter,
// which has no registered driver, so raw stdin/stdout is the whole
// protocol), runs a real `node scripts/autopilot.mjs run ...` subprocess
// against it, then reconstructs the OBSERVED role-invocation order and
// PASS/FAIL outcomes from the result.json files the orchestrator itself
// writes for every relay call (scripts/autopilot.mjs's makeRelayResult /
// runRelay). This is real behavioral evidence, not a source-string check.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {runTreeUntilMarker} from "./posix-process-runner.mjs";
import {CLAUDE_MD_MARKER_BEGIN, CLAUDE_MD_MARKER_END} from "../planning-boundary.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const skillRoot = path.resolve(here, "..", "..");
const stubSource = path.join(here, "fake-workflow-adapter.sh");
const IS_WIN = process.platform === "win32";
// TASK 16.3B: fake-workflow-adapter.sh is deliberately a single POSIX shell
// file with no sibling dependencies (required by the WSL/Linux bubblewrap
// externalBinary bind-mount path — see that file's own header comment). It
// cannot be spawned directly on Native Windows (no extension Windows can
// resolve, and no shell interpreter to run it even with one). On win32 only,
// makeFixtureBin() below writes fake-workflow-adapter-win.mjs (a Node port
// covering ONLY the "success" scenario — the one used by
// test-workflow-order-speckit.mjs) plus a ".cmd" trampoline, matching the
// same pattern already used by test-playwright-verification.mjs and
// test-verifier-playwright-discovery.mjs. POSIX behavior/content is
// unchanged.
const winStubSource = path.join(here, "fake-workflow-adapter-win.mjs");

export function makeFixtureRepo(prefix) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `ap-wf-${prefix}-`));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "autopilot-workflow-test@example.invalid"]);
  git(repo, ["config", "user.name", "Autopilot Workflow Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

// The relay launch filters the child environment to a fixed safe allowlist
// (scripts/relay-guards.mjs's guardedEnv()/filteredProcessEnv()), so a
// custom env var never reaches the fake adapter CLI. The scenario selector
// must instead be a COMMITTED repo file, readable from the plain repo, a
// GSD worktree checked out from the same commit, and the read-only
// bubblewrap bind alike. Call this after makeFixtureRepo() and before
// runAutopilot(); commits so it is visible from any worktree.
//
// The selector lives under ".autopilot/" (already excluded from every
// scoped delta) rather than the repository root: switching the scenario
// between two runs of the same mission rewrites this file without touching
// any deliverable, and a root-level rewrite would surface in the scoped
// delta and read as approval drift at the next checkpoint gate. Force-add:
// setup writes ".autopilot/" to .gitignore, so a plain `git add -A` would
// skip it.
export function setScenario(repo, scenario) {
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", ".autopilot-test-scenario"), scenario);
  git(repo, ["add", "-A"]);
  git(repo, ["add", "-f", ".autopilot/.autopilot-test-scenario"]);
  git(repo, ["commit", "-q", "-m", `test scenario: ${scenario}`]);
}

// Explicit override carrying the exact test-owned external snapshot
// directory for external-snapshot scenarios (see setSnapshotDir callers).
// Committed like the scenario selector: the production relay launch filters
// the adapter child environment to a fixed safe allowlist, so a committed
// repo file is the only channel that reaches the adapter everywhere it can
// run (plain repo, worktree, read-only bind).
export function setSnapshotDir(repo, dir) {
  fs.writeFileSync(path.join(repo, ".autopilot-test-snapdir"), String(dir));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "test snapshot dir override"]);
}

// A minimal, already-planned GSD phase: gsdState() classifies a phase with
// a complete PLAN as "complete", so ensurePlanningReady() takes the
// existing-planning-review path (one read-only plan_reviewer PASS) instead
// of generating new planning artifacts — adapters/planning-state.mjs's
// gsdState()/phaseEvidence() is what this fixture shape satisfies.
export function makeGsdPhaseFixture(repo) {
  const planningDir = path.join(repo, ".planning");
  fs.mkdirSync(planningDir, {recursive: true});
  fs.writeFileSync(path.join(planningDir, "ROADMAP.md"), "# Roadmap\n\n## Phase 1\n");
  fs.writeFileSync(path.join(planningDir, "STATE.md"), "# State\n");
  const phaseDir = path.join(planningDir, "phases", "phase-1");
  fs.mkdirSync(phaseDir, {recursive: true});
  fs.writeFileSync(path.join(phaseDir, "plan-a-PLAN.md"), [
    "---",
    "phase: phase-1",
    "plan: plan-a",
    "wave: 1",
    "---",
    "",
    "<objective>Fixture objective.</objective>",
    "",
    "<task>",
    "<name>do-fixture-task</name>",
    "<action>Do the fixture task.</action>",
    "<done>The fixture task is done.</done>",
    "</task>",
    ""
  ].join("\n"));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "gsd phase-1 fixture"]);
}

// A minimal SpecKit feature: one phase with one unchecked task, matching
// adapters/speckit.mjs's `## Phase N: <name>` + checklist parsing and
// adapters/planning-state.mjs's specKitState() "complete" classification
// (spec.md + plan.md + a tasks.md checklist all present).
//
// TASK 15.6B: the feature content is NOT pre-committed here. A fresh `ap
// run` is always a NEW planning request, and a new session's planner must
// create its OWN feature — pre-committing specs/001-fixture-feature would
// freeze it as a pre-existing (unrelated) directory that the specify
// postcondition must reject. The fake adapter
// (fake-workflow-adapter.sh's default Speckit planning branch) writes this
// exact content as the new session feature during the specify/plan/tasks
// stages. Only the workflow file (which defines the SpecKit framework
// itself) is committed up front — without it, speckit inspect() returns no
// steps at all.
//
// ensurePlanningReady() calls runSpecKitPlanning() unconditionally (even
// when planning is already "complete") — its step loop needs
// .specify/workflows/speckit/workflow.yml to exist so
// adapters/speckit.mjs's inspect() returns a real `steps` array; with the
// fixture's entryIndex landing at steps.length (nothing pending), the
// loop itself does not execute, but the file must exist for inspect() to
// return steps: [] instead of undefined.
export function makeSpecKitPhaseFixture(repo) {
  const workflowDir = path.join(repo, ".specify", "workflows", "speckit");
  fs.mkdirSync(workflowDir, {recursive: true});
  fs.writeFileSync(path.join(workflowDir, "workflow.yml"), [
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
  ].join("\n"));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "speckit fixture workflow"]);
  // Returned for callers that reference the planner-created feature path.
  return path.join(repo, "specs", "001-fixture-feature");
}

// A three-phase SpecKit feature used by the Task 14 checkbox-marking tests
// (test-task14-speckit-task-marking.mjs): Phase 1 is ALREADY fully checked
// (proves an already-done phase is skipped and left byte-for-byte alone —
// idempotency/isolation), Phase 2 has two unchecked tasks (one with
// non-ASCII text, proving Unicode task text survives the checkbox
// mutation), Phase 3 has one unchecked task (a distinct, later phase used
// to prove partial-completion cases: earlier phases can get marked while a
// later phase's task is still pending). The file uses CRLF line endings
// throughout, to prove the checkbox mutation preserves the file's existing
// line-ending style instead of normalizing it.
//
// TASK 15.6B: the feature content is NOT pre-committed here (see
// makeSpecKitPhaseFixture above for why): the fake adapter's default
// Speckit planning branch writes this exact content — same bytes, same
// CRLF style, same Unicode text — as the NEW session feature
// (specs/003-multi-task-feature) during specify/plan/tasks. Only the
// workflow file is committed up front. The returned path is where the
// planner will have created the feature by the time implementation runs.
export function makeSpecKitMultiTaskFixture(repo) {
  const workflowDir = path.join(repo, ".specify", "workflows", "speckit");
  fs.mkdirSync(workflowDir, {recursive: true});
  fs.writeFileSync(path.join(workflowDir, "workflow.yml"), [
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
  ].join("\n"));
  const featureDir = path.join(repo, "specs", "003-multi-task-feature");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "speckit multi-task fixture workflow"]);
  return featureDir;
}

// The canonical 7-step SpecKit workflow file alone, committed, with no
// feature fixtures: a real SpecKit repo always has this file (without it
// the framework would not be SpecKit at all), while the session feature
// itself must be created NEW by the planner (see makeSpecKitPhaseFixture).
export function makeSpecKitWorkflowOnly(repo) {
  const workflowDir = path.join(repo, ".specify", "workflows", "speckit");
  fs.mkdirSync(workflowDir, {recursive: true});
  fs.writeFileSync(path.join(workflowDir, "workflow.yml"), [
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
  ].join("\n"));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "speckit workflow file"]);
}

// An UNRELATED, already-complete SpecKit feature — used by the
// new-request-isolation tests (test-speckit-new-request-isolation.mjs) to
// reproduce the observed bug shape: a repo that already has a complete,
// unrelated feature (e.g. "002-dashboard-design-prototype") must never be
// reused/modified merely because a NEW, different request arrives.
export function makeSpecKitUnrelatedFeatureFixture(repo, featureDirName = "002-dashboard-design-prototype") {
  const workflowDir = path.join(repo, ".specify", "workflows", "speckit");
  fs.mkdirSync(workflowDir, {recursive: true});
  fs.writeFileSync(path.join(workflowDir, "workflow.yml"), [
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
  ].join("\n"));
  const featureDir = path.join(repo, "specs", featureDirName);
  fs.mkdirSync(featureDir, {recursive: true});
  fs.writeFileSync(path.join(featureDir, "spec.md"), "# Spec\n\nUnrelated pre-existing feature.\n");
  fs.writeFileSync(path.join(featureDir, "plan.md"), "# Plan\n\nUnrelated pre-existing feature.\n");
  fs.writeFileSync(path.join(featureDir, "tasks.md"), [
    "## Phase 1: Unrelated pre-existing task",
    "",
    "- [ ] Do the unrelated pre-existing task",
    ""
  ].join("\n"));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", `unrelated pre-existing speckit feature: ${featureDirName}`]);
  return featureDir;
}

// A committed CLAUDE.md that already has the controlled SPECKIT marker
// section — the baseline the plan-stage write-boundary check requires
// before it can prove a later edit stayed scoped to that section (see
// planning-boundary.mjs's validateClaudeMdEdit / claudeMdBaseline).
export function makeClaudeMdBaseline(repo) {
  const file = path.join(repo, "CLAUDE.md");
  fs.writeFileSync(file, [
    "# CLAUDE.md",
    "",
    "Project instructions (outside the Autopilot-controlled section).",
    "",
    CLAUDE_MD_MARKER_BEGIN,
    "(no active SpecKit feature)",
    CLAUDE_MD_MARKER_END,
    "",
    "More project instructions.",
    ""
  ].join("\n"));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "CLAUDE.md baseline with SPECKIT marker section"]);
  return file;
}

// TASK 15.6C: a committed .specify/feature.json holding an INVENTED
// multi-field schema — the real observed Native Windows incident, where an
// exit-zero Planner left behind an invalid feature.json (extra fields the
// real speckit-specify schema does not have) from a confused prior attempt.
// Paired with a scenario that does NOT touch this file during the specify
// relay call itself (only spec.md), so the write-boundary check — which
// only inspects TOUCHED paths — never sees it; only the specify
// postcondition (speckit-planning-postconditions.mjs, which always reads
// feature.json straight off disk) can catch it, exactly like production.
export function makeInventedFeatureJsonFixture(repo, featureDirValue = "specs/999-smoke-test") {
  const dir = path.join(repo, ".specify");
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, "feature.json"), JSON.stringify({
    feature_directory: featureDirValue,
    feature_name: "smoke-test",
    feature_number: "999",
    branch: "999-smoke-test",
    created_at: "2026-01-01T00:00:00Z",
    author: "claude",
    status: "draft"
  }));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "pre-existing invented feature.json (invalid schema)"]);
}

function git(cwd, args) {
  const r = spawnSync("git", args, {cwd, encoding: "utf8", shell: false});
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout || "").trim();
}

export function makeFixtureBin(prefix) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), `ap-wf-bin-${prefix}-`));
  if (IS_WIN) {
    const scriptPath = path.join(binDir, "fake-workflow-adapter-win.mjs");
    fs.copyFileSync(winStubSource, scriptPath);
    fs.writeFileSync(path.join(binDir, "cursor-agent.cmd"), `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\nexit /b %errorlevel%\r\n`);
    return binDir;
  }
  const target = path.join(binDir, "cursor-agent");
  fs.copyFileSync(stubSource, target);
  fs.chmodSync(target, 0o755);
  return binDir;
}

// Every role points at the "cursor" adapter (no registered driver in
// scripts/adapter-drivers.mjs, so the orchestrator sends/receives plain
// text — no protocol the fixture has to emulate). gates.network_isolation
// defaults to true, unchanged for every existing caller (unrelated to this
// task; the fake CLI has real network access regardless), but gates.commands
// is set per-test by the caller.
//
// TASK 16.3B: `networkIsolation` is an explicit opt-out ONLY — its default
// (true) is byte-identical to every call site's prior behavior. It exists
// because scripts/shell-guard.mjs's networkIsolationPrefix() returns null on
// any non-Linux platform (there is no Windows equivalent of Linux's
// `unshare`), which makes decideExecution() permanently and deterministically
// refuse ANY gates.commands entry on Native Windows when network_isolation is
// true — not a bug, the documented fail-closed behavior for a genuinely
// unavailable isolation mechanism (see decideExecution's own "isolation-
// unavailable" message: "Set gates.network_isolation=false to accept running
// without network isolation"). A caller that needs its gate command to
// actually execute on Native Windows (where pure command-ordering, not
// network-isolation enforcement, is what the test cares about) passes
// networkIsolation:false explicitly; every other existing caller is
// unaffected.
// `failureBudgets` shallow-merges into policy.failure_budgets (e.g. to
// shrink a budget to 1 so a deliberately-always-failing scenario escalates
// after a single attempt instead of the default 5 — see
// test-task14-speckit-task-marking.mjs).
export function writeConfig(repo, {planningFramework, gatesCommands = [], maxPlanRevisions = 3, gsdOverrides = {}, failureBudgets = {}, networkIsolation = true} = {}) {
  const config = {
    schema_version: "3.0",
    project: {repo: ".", planning_framework: planningFramework, state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs"},
    roles: Object.fromEntries(["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"].map(role => [
      role, {adapter: "cursor", model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null}
    ])),
    workflow: {
      specReview: true, planReview: true, analysisAfterTasks: true, implementationReview: true, finalReview: true,
      autoApproveSpec: false, autoApprovePlan: false, parallelIndependentTasks: false, gsdPlanningReview: false,
      relaySafety: {block_git_commit_push: true, verify_read_only_by_snapshot: true, capture_touched_files: true, persist_role_sessions: true}
    },
    gates: {commands: gatesCommands, env_allowlist: [], require_reviewer: true, network_isolation: networkIsolation},
    policy: {
      max_plan_revisions: maxPlanRevisions, retry_delay_ms: 0, checkpoint_after_task: true, checkpoint_after_phase: true,
      require_human_commit: true, fail_closed_on_relay_violation: true,
      failure_budgets: {implementationFailureBudget: 5, verificationFailureBudget: 5, adapterRetryBudget: 5, infrastructureRetryBudget: 5, ...failureBudgets}
    },
    safety: {allow_git_commit: false, allow_git_push: false, allow_destructive_operations: false},
    planning: {
      speckit: {workflow_file: ".specify/workflows/speckit/workflow.yml", task_candidates: [".specify/tasks.md", "specs/*/tasks.md", "specs/*/tasks/*.md"]},
      gsd: {
        phase_root: ".planning/phases", run_plan_verify: true, run_state_validate: true, write_summary_artifacts: true,
        write_verification_artifacts: true, write_uat_artifact: true, use_gsd_tools_when_available: false,
        parallelization: {enabled: false, plan_level: false, task_level: false, max_concurrent_agents: 1, min_plans_for_parallel: 99},
        planning_review: {enabled: false, review_after_each_stage: true, stages: ["discuss", "research", "plan", "plan-check"], max_revisions: 3, read_only_reviewer: true},
        ...gsdOverrides
      }
    },
    capabilities: {project_defaults: [], role_requirements: {}, safety_denied: [], legacy_text_inference: false, verification: {browser: "native", require_browser: "when-task-requires"}}
  };
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), JSON.stringify(config, null, 2));
}

// Runs `node scripts/autopilot.mjs run "<request>" --repo <repo>` as a real
// subprocess. Never expected to exit 0 in every scenario (an escalated/died
// mission is a normal, assertable outcome) — callers inspect result.json
// events rather than relying on the process exit code alone.
//
// NOTE on test-owned inputs: the production relay launch filters the ADAPTER
// child environment to a fixed safe allowlist, so a custom variable set on
// the mission subprocess environment intentionally does NOT reach adapter
// children. Adapter-visible test inputs travel exclusively via committed
// repo files (setScenario, setSnapshotDir) — the only channel the production
// design allows. There is deliberately no extraEnv option here: it would
// suggest a transport mechanism that production provably does not provide.
// A fixture orchestrator must not inherit an OUTER mission's git guard. When
// the suite runs inside a live mission (the implementer's full-suite gate),
// process.env carries that run's guard: a `git` PATH shim (starts node on
// every call — ~600ms vs ~5ms, measured) plus GIT_CONFIG_* hooks scoped to
// the real repo. The nested orchestrator makes dozens of git calls, so
// scenarios blew past their spawn timeout (mission 022 T3.3:
// test-cap-breach-rollover s3 failed only in-mission). The child works on a
// temp fixture repo and builds its own guard for its own roles, so dropping
// the outer one changes nothing it is allowed to do.
export function withoutOuterGitGuard(env) {
  const delimiter = process.platform === "win32" ? ";" : ":";
  const out = {...env};
  const isGuardDir = (dir) => {
    try {
      const shim = path.join(dir, process.platform === "win32" ? "git.cmd" : "git");
      return fs.existsSync(shim) && fs.readFileSync(shim, "utf8").includes("AUTOPILOT GIT GUARD");
    } catch { return false; }
  };
  out.PATH = String(env.PATH || "").split(delimiter).filter((dir) => dir && !isGuardDir(dir)).join(delimiter);
  const count = Number(env.GIT_CONFIG_COUNT) || 0;
  for (let i = 0; i < Math.max(count, 8); i += 1) { delete out[`GIT_CONFIG_KEY_${i}`]; delete out[`GIT_CONFIG_VALUE_${i}`]; }
  delete out.GIT_CONFIG_COUNT;
  delete out.AUTOPILOT_GIT_GUARD_LOG;
  delete out.AUTOPILOT_NO_GIT_MUTATIONS;
  return out;
}

export function runAutopilot(repo, binDir, {request = "fixture request", timeoutMs = 60000, extraPath = ""} = {}) {
  const delimiter = process.platform === "win32" ? ";" : ":";
  const base = withoutOuterGitGuard(process.env);
  const env = {
    ...base,
    PATH: `${binDir}${delimiter}${extraPath ? extraPath + delimiter : ""}${base.PATH || ""}`
  };
  const result = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "autopilot.mjs"), "run", request, "--repo", repo], {
    cwd: repo, encoding: "utf8", env, timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"], shell: false
  });
  return {status: result.status, timedOut: !!result.error && result.error.code === "ETIMEDOUT", stdout: result.stdout || "", stderr: result.stderr || ""};
}

// Runs `node scripts/autopilot.mjs run "<request>"` and interrupts the
// COMPLETE subprocess tree as soon as `markerFile` appears, simulating a
// real interruption (process killed/crashed mid-planning) rather than a
// clean exit. This is deterministic, not a timing race: fixture adapters
// that use this helper create markerFile and only THEN do something slow
// (e.g. sleep), so there is a wide, guaranteed window between the marker
// appearing and the process being allowed to continue.
//
// Tree termination (not just the direct child PID) is load-bearing: killing
// only the parent leaves a sleeping fake-adapter descendant alive, which
// can then write plan artifacts after the interruption and corrupt the
// resumed run. Termination of the whole group is confirmed before return;
// output is byte-bounded; settlement happens exactly once. Result:
// {markerObserved, killed, status, code, signal, timedOut,
// terminationConfirmed, terminationFailed, outputLimitExceeded,
// stdout, stderr, error}.
export async function runAutopilotUntilMarker(repo, binDir, {request, markerFile, pollMs = 50, timeoutMs = 30000} = {}) {
  const delimiter = process.platform === "win32" ? ";" : ":";
  const base = withoutOuterGitGuard(process.env);
  const env = {...base, PATH: `${binDir}${delimiter}${base.PATH || ""}`};
  const result = await runTreeUntilMarker(
    process.execPath,
    [path.join(skillRoot, "scripts", "autopilot.mjs"), "run", request, "--repo", repo],
    {cwd: repo, env, markerFile, pollMs, timeoutMs}
  );
  return {
    markerObserved: result.markerObserved,
    killed: result.killed,
    status: result.status,
    code: result.status,
    signal: result.signal,
    timedOut: result.timedOut,
    terminationConfirmed: result.terminationConfirmed,
    terminationFailed: result.terminationFailed,
    outputLimitExceeded: result.outputLimitExceeded,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error
  };
}

// Recursively finds every result.json the orchestrator wrote for this run,
// and returns the observed role invocations in real chronological order
// (by the timestamps autopilot.mjs itself records — startedAt/finishedAt —
// not by directory naming, since per-mission run sequence numbers reset
// across separate mission folders and would not interleave correctly).
export function readObservedEvents(repo) {
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
  const events = files.map(file => {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      role: data.role || null,
      decision: data.verdict?.decision ?? null,
      status: data.status ?? null,
      startedAt: data.startedAt,
      finishedAt: data.finishedAt,
      file
    };
  });
  events.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || Date.parse(a.finishedAt) - Date.parse(b.finishedAt));
  return events;
}

export function cleanup(...dirs) {
  for (const dir of dirs) {
    try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* best-effort */ }
  }
}
