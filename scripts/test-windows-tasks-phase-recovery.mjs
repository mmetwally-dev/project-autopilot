#!/usr/bin/env node
// TASK 15.6E — Native Windows behavioral proof for the executable-phase
// tasks contract.
//
// The real incident: the Planner produced a tasks.md with unchecked loose
// checkboxes and NO recognized `## Phase N` heading. The old flat-checkbox
// postcondition accepted it, Tasks Review passed, and Implementation died
// before the Implementer with "No unchecked SpecKit tasks found".
//
// Drives the REAL public entrypoint:
//
//   node bin/ap.cjs run "<request>" --repo <disposable-fixture-repo>
//
// with a Node-based fake `cursor-agent.cmd` adapter (no real agent CLI, no
// PATH mutation beyond the child env, never touches my-app). Proves:
//
//   A. New planning: orphan tasks rejected at the tasks command itself (no
//      "Tasks ready", no Tasks Review, no Implementer); the same-request
//      retry receives the structured AUTOPILOT_PLANNING_CORRECTION sentinel,
//      corrects tasks.md, then review -> implement -> code-review ->
//      verification run in order to HUMAN COMMIT REQUIRED.
//   B. Legacy tasks_ready: a seeded tasks_ready mission holding the exact
//      incident tasks.md returns to Tasks correction instead of dying at
//      Implementation; same mission and feature preserved; review and
//      implementation run only after correction; Autopilot never rewrites
//      tasks.md itself.
//
// Windows-only: no-op PASS on any other platform (POSIX coverage lives in
// test-speckit-tasks-phase-postcondition.mjs).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import {runWindowsProcessTreeBounded} from "./test-fixtures/windows-process-tree-runner.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");
const CANONICAL_AP = path.join(skillRoot, "bin", "ap.cjs");

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 2000)}` : ""}`);
  return false;
};

if (process.platform !== "win32") {
  console.log("SKIP: task 15.6E Windows tasks-phase recovery — not running on win32.");
  process.exit(0);
}

const FEATURE = "001-tasks-phase";
const REQUEST_A = "Add tasks phase contract verification feature";
const REQUEST_B = "Recover the legacy tasks_ready incident feature";
const TASKS_SENTINEL_STAGE = '"stage":"tasks"';
const TASKS_SENTINEL_REASON = '"reason":"tasks_no_executable_phases"';

function git(cwd, args) {
  const r = spawnSync("git", args, {cwd, encoding: "utf8", stdio: "pipe", env: withoutOuterGitGuard(process.env), shell: false});
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim().slice(0, 1000)}`);
  return (r.stdout || "").trim();
}

const WORKFLOW_YML = [
  "- id: specify",
  "  type: command",
  "  command: /speckit.specify",
  "- id: review-spec",
  "  type: gate",
  "  message: Review the specification",
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

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-win-tasks-phase-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "win-tasks-phase-test@example.invalid"]);
  git(repo, ["config", "user.name", "Windows Tasks Phase Test"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# Tasks Phase Fixture\n");
  const wfDir = path.join(repo, ".specify", "workflows", "speckit");
  fs.mkdirSync(wfDir, {recursive: true});
  fs.writeFileSync(path.join(wfDir, "workflow.yml"), WORKFLOW_YML);
  fs.writeFileSync(path.join(repo, "CLAUDE.md"), [
    "# CLAUDE.md",
    "",
    "<!-- SPECKIT START -->",
    "(no active SpecKit feature)",
    "<!-- SPECKIT END -->",
    ""
  ].join("\n"));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init: tasks-phase fixture"]);
  return repo;
}

function writeConfig(repo) {
  const config = {
    schema_version: "3.0",
    project: {repo: ".", planning_framework: "speckit", state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs"},
    execution: {runtime_mode: "windows-compatibility", wsl_distro: null},
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
      max_plan_revisions: 1, retry_delay_ms: 0, checkpoint_after_task: true, checkpoint_after_phase: true,
      require_human_commit: true, fail_closed_on_relay_violation: true,
      failure_budgets: {implementationFailureBudget: 5, verificationFailureBudget: 5, adapterRetryBudget: 5, infrastructureRetryBudget: 5}
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

// Fake adapter: planner writes valid spec/plan but orphan tasks until it
// observes the EXACT structured tasks correction sentinel (never generic
// feedback prose); reviewers/implementer/verifier behave deterministically.
function adapterScript() {
  return [
    `import fs from "node:fs";`,
    `import path from "node:path";`,
    `function readStdin(){ return new Promise((res, rej)=>{ let d=""; process.stdin.setEncoding("utf8"); process.stdin.on("data",c=>{d+=c;}); process.stdin.on("end",()=>res(d)); process.stdin.on("error",rej); }); }`,
    `const args = process.argv.slice(2);`,
    `if (args[0] === "--version") { console.log("fake-windows-tasks-phase-cursor-agent 1.0.0"); process.exit(0); }`,
    `const PROMPT = await readStdin();`,
    `const firstLine = PROMPT.split(/\\r?\\n/, 1)[0] || "";`,
    `const role = firstLine.startsWith("ROLE=") ? firstLine.slice("ROLE=".length).trim() : "";`,
    `const stepMatch = PROMPT.match(/^Planning phase: (.*)\\.$/m);`,
    `const STEP = stepMatch ? stepMatch[1].trim() : "";`,
    `const lockMatch = PROMPT.match(/^Feature '([^']*)'/m);`,
    `const LOCKED = lockMatch ? lockMatch[1] : "";`,
    `const FEATURE = (LOCKED && LOCKED !== "<new-feature>") ? LOCKED : ${JSON.stringify(FEATURE)};`,
    `const hasTasksCorrection = PROMPT.includes("AUTOPILOT_PLANNING_CORRECTION=") && PROMPT.includes(${JSON.stringify(TASKS_SENTINEL_STAGE)}) && PROMPT.includes(${JSON.stringify(TASKS_SENTINEL_REASON)});`,
    `if (role === "planner") {`,
    `  if (STEP === "specify") {`,
    `    fs.mkdirSync(".specify", {recursive:true});`,
    `    fs.writeFileSync(path.join(".specify","feature.json"), JSON.stringify({feature_directory: "specs/" + FEATURE}));`,
    `    fs.mkdirSync(path.join("specs", FEATURE, "checklists"), {recursive:true});`,
    `    fs.writeFileSync(path.join("specs", FEATURE, "spec.md"), "# Spec\\n\\nTasks phase feature.\\n");`,
    `    fs.writeFileSync(path.join("specs", FEATURE, "checklists","requirements.md"), "# Requirements\\n\\n- [ ] Requirement A\\n");`,
    `  } else if (STEP === "plan") {`,
    `    fs.mkdirSync(path.join("specs", FEATURE, "contracts"), {recursive:true});`,
    `    fs.writeFileSync(path.join("specs", FEATURE, "plan.md"), "# Plan\\n\\nTasks phase plan.\\n");`,
    `    fs.writeFileSync(path.join("specs", FEATURE, "research.md"), "# Research\\n\\nFindings.\\n");`,
    `    fs.writeFileSync(path.join("specs", FEATURE, "data-model.md"), "# Data Model\\n\\nEntities.\\n");`,
    `    fs.writeFileSync(path.join("specs", FEATURE, "quickstart.md"), "# Quickstart\\n\\nSteps.\\n");`,
    `    fs.writeFileSync(path.join("specs", FEATURE, "contracts","health.md"), "# Health\\n\\nGET /health\\n");`,
    `    try {`,
    `      if (fs.existsSync("CLAUDE.md")) {`,
    `        const cur = fs.readFileSync("CLAUDE.md","utf8");`,
    `        const b = "<!-- SPECKIT START -->"; const e = "<!-- SPECKIT END -->";`,
    `        const bi = cur.indexOf(b); const ei = cur.indexOf(e);`,
    `        if (bi !== -1 && ei !== -1 && ei > bi) {`,
    `          fs.writeFileSync("CLAUDE.md", cur.slice(0, bi + b.length) + "\\nActive feature: " + FEATURE + "\\n" + cur.slice(ei));`,
    `        }`,
    `      }`,
    `    } catch {}`,
    `  } else if (STEP === "tasks") {`,
    `    fs.mkdirSync(path.join("specs", FEATURE), {recursive:true});`,
    `    if (hasTasksCorrection) {`,
    `      fs.writeFileSync(path.join("specs", FEATURE, "tasks.md"), "## Phase 1: Do the tasks phase task\\n\\n- [ ] Do the tasks phase task\\n");`,
    `    } else {`,
    `      fs.writeFileSync(path.join("specs", FEATURE, "tasks.md"), "# Tasks\\n\\n## Tasks\\n\\n- [ ] Do the first orphan task\\n\\n- [ ] Do the second orphan task\\n");`,
    `    }`,
    `  } else { console.error("fake planner: unexpected STEP '" + STEP + "'"); process.exit(1); }`,
    `  console.log("planner ok"); process.exit(0);`,
    `}`,
    `if (role === "implementer") {`,
      `  fs.writeFileSync("implementer-output.txt", "implementer ok\\n");`,
      `  console.log("implementer ok");`,
      // TASK-19 Phase 4 (task 12): the per-task Implementer invocation must end
      // with the AUTOPILOT_TASK_RESULT sentinel as its final non-empty line.
      `  console.log("AUTOPILOT_TASK_RESULT=" + JSON.stringify({summary: "implementer ok", taskLocalCheck: {command: "true", status: "passed", exitCode: 0, summary: "fixture"}}));`,
      `  process.exit(0);`,
    `}`,
    `if (role === "plan_reviewer" || role === "code_reviewer" || role === "verifier") {`,
    `  console.log("AUTOPILOT_REVIEW=" + JSON.stringify({decision:"PASS", findings:[]})); process.exit(0);`,
    `}`,
    `console.error("fake-windows-tasks-phase-adapter: unknown ROLE '" + role + "'"); process.exit(1);`
  ].join("\n");
}

function makeBin() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-win-tasks-phase-bin-"));
  const scriptPath = path.join(binDir, "windows-tasks-phase-adapter.mjs");
  fs.writeFileSync(scriptPath, adapterScript());
  fs.writeFileSync(path.join(binDir, "cursor-agent.cmd"), `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\nexit /b %errorlevel%\r\n`);
  return {binDir, scriptPath};
}

const AGENT_BINARIES = ["claude", "opencode", "codex", "agy", "cursor-agent"];
const WIN_EXTS = [".exe", ".com", ".cmd", ".bat", ""];
function dirSuppliesAgent(dir) {
  for (const name of AGENT_BINARIES) for (const ext of WIN_EXTS) {
    try { if (fs.existsSync(path.join(dir, name + ext))) return true; } catch { /* unreadable */ }
  }
  return false;
}
function missionEnv(binDir) {
  // Strip any outer mission/gate git guard (PATH shim + hooks): the nested
  // mission installs its own, and every git call through both ran the
  // mission several times slower under the orchestrator gate.
  const base = withoutOuterGitGuard({...process.env});
  const original = (base.PATH || "").split(";").filter(Boolean);
  return {...base, PATH: [binDir, ...original.filter(d => !dirSuppliesAgent(d))].join(";")};
}
function runMission(repo, binDir, request, timeoutMs) {
  return runWindowsProcessTreeBounded(process.execPath, [CANONICAL_AP, "run", request, "--repo", repo], {cwd: repo, env: missionEnv(binDir), timeoutMs});
}
function readAllResults(repo) {
  const root = path.join(repo, ".autopilot");
  const files = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === "result.json") files.push(full);
    }
  })(root);
  return files.map(file => ({file, data: JSON.parse(fs.readFileSync(file, "utf8"))}))
    .sort((a, b) => (Date.parse(a.data.startedAt || 0) || 0) - (Date.parse(b.data.startedAt || 0) || 0) ||
      (Date.parse(a.data.finishedAt || 0) || 0) - (Date.parse(b.data.finishedAt || 0) || 0));
}
function readBriefs(repo) {
  const root = path.join(repo, ".autopilot");
  const out = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === "brief.txt") out.push(fs.readFileSync(full, "utf8"));
    }
  })(root);
  return out;
}
function tasksCorrectionBriefs(repo) {
  return readBriefs(repo).filter(b =>
    b.includes("Planning phase: tasks.") && b.includes("AUTOPILOT_PLANNING_CORRECTION=") &&
    b.includes(TASKS_SENTINEL_STAGE) && b.includes(TASKS_SENTINEL_REASON));
}
function readState(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
}
function missionDirs(repo) {
  const dir = path.join(repo, ".autopilot", "missions");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(d => fs.statSync(path.join(dir, d)).isDirectory()).sort();
}
function cleanup(...targets) {
  for (const dir of targets) {
    if (!dir) continue;
    try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* best-effort */ }
  }
}
function assertCleanRun(label, result) {
  return check(`${label}: process completed cleanly`,
    !result.timedOut && !result.outputLimitExceeded && !result.terminationFailed,
    {timedOut: result.timedOut, outputLimitExceeded: result.outputLimitExceeded, terminationFailed: result.terminationFailed});
}
function listLeakedTemp(prefixes) {
  const names = fs.readdirSync(os.tmpdir());
  return names.filter(n => prefixes.some(p => n.startsWith(p))).map(n => path.join(os.tmpdir(), n));
}

async function main() {
  const overallStart = Date.now();
  const leakPrefixes = ["ap-win-tasks-phase-", "autopilot-reviewer-"];
  const preExisting = new Set(listLeakedTemp(leakPrefixes));
  const owned = [];

  try {
    // ── Mission A: new planning rejects orphans, then recovers ──────────
    {
      const repo = makeRepo();
      const {binDir} = makeBin();
      owned.push(repo, binDir);
      writeConfig(repo);
      const headBefore = git(repo, ["rev-parse", "HEAD"]);

      const warmup = await runWindowsProcessTreeBounded("cmd.exe", ["/d", "/s", "/c", path.join(binDir, "cursor-agent.cmd"), "--version"], {timeoutMs: 60000});
      check("A: warmup adapter answers --version", warmup.status === 0 && !warmup.timedOut, warmup);

      const run1 = await runMission(repo, binDir, REQUEST_A, 180000);
      if (!assertCleanRun("A run1", run1)) return;
      const combined1 = `${run1.stdout || ""}\n${run1.stderr || ""}`;
      check("A run1: nonzero exit", run1.status !== 0, run1.status);
      check("A run1: precise tasks_no_executable_phases reason", /tasks_no_executable_phases/.test(combined1), combined1.slice(-1500));
      check("A run1: NOT the old implementation death", !/No unchecked SpecKit tasks found/.test(combined1), combined1.slice(-500));
      check("A run1: Tasks ready NOT printed", !/Tasks ready/.test(run1.stdout || ""), (run1.stdout || "").slice(-500));

      const events1 = readAllResults(repo);
      const roles1 = events1.map(e => e.data.role);
      check("A run1: 3 planners (specify/plan/tasks)", roles1.filter(r => r === "planner").length === 3, roles1);
      check("A run1: exactly 2 reviewers (spec+plan gates only, no Tasks Review)",
        roles1.filter(r => r === "plan_reviewer").length === 2, roles1);
      check("A run1: implementer never ran", !roles1.includes("implementer"), roles1);
      check("A run1: code_reviewer never ran", !roles1.includes("code_reviewer"), roles1);
      check("A run1: verifier never ran", !roles1.includes("verifier"), roles1);

      const state1 = readState(repo);
      check("A run1: recoverable tasks checkpoint",
        state1.speckitPlanningCheckpoint?.step === "tasks" &&
        state1.speckitPlanningCheckpoint?.reason === "planning-stage-postcondition" &&
        state1.speckitPlanningCheckpoint?.postcondition?.reason === "tasks_no_executable_phases",
        state1.speckitPlanningCheckpoint);
      check("A run1: same feature preserved", state1.speckitFeatureDir === FEATURE, state1.speckitFeatureDir);
      check("A run1: orphan tasks.md untouched (still phaseless)",
        !/^## Phase /m.test(fs.readFileSync(path.join(repo, "specs", FEATURE, "tasks.md"), "utf8")));
      check("A run1: no correction sentinel yet", tasksCorrectionBriefs(repo).length === 0);

      const run2 = await runMission(repo, binDir, REQUEST_A, 240000);
      if (!assertCleanRun("A run2", run2)) return;
      const combined2 = `${run2.stdout || ""}\n${run2.stderr || ""}`;
      check("A run2: exit 0", run2.status === 0, {status: run2.status, tail: combined2.slice(-800)});
      check("A run2: HUMAN COMMIT REQUIRED", /HUMAN COMMIT REQUIRED/.test(combined2), combined2.slice(-500));
      const state2 = readState(repo);
      check("A run2: resume intent", state2.planningIntent?.kind === "resume", state2.planningIntent);
      check("A run2: complete/human_commit", state2.phase === "complete" && state2.step === "human_commit", {phase: state2.phase, step: state2.step});
      check("A run2: same feature end to end", state2.speckitFeatureDir === FEATURE, state2.speckitFeatureDir);
      check("A run2: checkpoint cleared", !state2.speckitPlanningCheckpoint, state2.speckitPlanningCheckpoint);
      check("A run2: tasks.md corrected to phased form",
        /^## Phase 1/m.test(fs.readFileSync(path.join(repo, "specs", FEATURE, "tasks.md"), "utf8")));
      check("A run2: structured correction sentinel reached the planner",
        tasksCorrectionBriefs(repo).length >= 1, tasksCorrectionBriefs(repo).length);

      const events2 = readAllResults(repo);
      const roles2 = events2.map(e => e.data.role);
      const implIdx = roles2.indexOf("implementer");
      check("A run2: implementer ran after correction", implIdx !== -1, roles2);
      const reviewersBefore = implIdx === -1 ? [] : roles2.slice(0, implIdx).filter(r => r === "plan_reviewer");
      check("A run2: 3 gate reviews before implementer (spec/plan/tasks)", reviewersBefore.length >= 3, roles2);
      check("A run2: code review ran", roles2.includes("code_reviewer"), roles2);
      check("A run2: verifier ran", roles2.includes("verifier"), roles2);
      const verifiers = events2.filter(e => e.data.role === "verifier");
      check("A run2: verifier PASS", verifiers.length > 0 && verifiers.every(v => v.data.verdict?.decision === "PASS"), verifiers.map(v => v.data.verdict));
      check("A run2: task marked [x] after verification",
        /- \[x\] Do the tasks phase task/.test(fs.readFileSync(path.join(repo, "specs", FEATURE, "tasks.md"), "utf8")));
      check("A run2: HEAD unchanged (no commit)", git(repo, ["rev-parse", "HEAD"]) === headBefore);
      // Mission identity is the stable sequence (assigned once when the new
      // planning session starts, never reassigned on resume): folder names
      // additionally unify toward request/feature words by pre-existing
      // missionFor/persistDetectedMission rules, which this task does not
      // change, so singularity of folder names is not asserted — session
      // continuity (same seq, same feature) is.
      check("A run2: same mission sequence across the retry (no forked session)",
        state2.missionSeq === state1.missionSeq, {before: state1.missionSeq, after: state2.missionSeq});
      check("A run2: final mission folder exists", missionDirs(repo).includes(state2.mission), {mission: state2.mission, dirs: missionDirs(repo)});
      for (const r of events2.filter(e => ["plan_reviewer", "code_reviewer", "verifier"].includes(e.data.role))) {
        check(`A run2: ${r.data.role} scratch cleaned`, typeof r.data.scratchDir === "string" && !fs.existsSync(r.data.scratchDir), r.data.scratchDir);
      }
    }

    // ── Mission B: legacy tasks_ready recovers to Tasks correction ──────
    {
      const repo = makeRepo();
      const {binDir} = makeBin();
      owned.push(repo, binDir);
      const featureDir = path.join(repo, "specs", FEATURE);
      fs.mkdirSync(featureDir, {recursive: true});
      fs.writeFileSync(path.join(featureDir, "spec.md"), "# Spec\n\nLegacy feature.\n");
      fs.writeFileSync(path.join(featureDir, "plan.md"), "# Plan\n\nLegacy plan.\n");
      fs.writeFileSync(path.join(featureDir, "tasks.md"), "# Tasks: legacy tasks\n\n## Tasks\n\n- [ ] Do the first orphan task\n\n- [ ] Do the second orphan task\n");
      fs.writeFileSync(path.join(repo, ".specify", "feature.json"), JSON.stringify({feature_directory: `specs/${FEATURE}`}));
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "seed legacy incident state"]);
      writeConfig(repo);
      const headBefore = git(repo, ["rev-parse", "HEAD"]);
      // Mission name already unified to the feature words (as in the real
      // incident: mission 002-...-doc with feature 001-...-doc), so recovery
      // preserves it byte-for-byte instead of unifying it.
      fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
        version: 1, phase: "tasks_ready", step: "tasks_ready",
        taskIndex: 0, phaseIndex: 0, attempt: 0,
        mission: "002-tasks-phase", missionSeq: "002",
        planningStartedAt: new Date().toISOString(), planningRequest: REQUEST_B,
        planningStepIndex: 4, planningPreexistingFeatureDirs: [],
        speckitFeatureDir: FEATURE, sessions: {}
      }, null, 2));

      const run1 = await runMission(repo, binDir, REQUEST_B, 180000);
      if (!assertCleanRun("B run1", run1)) return;
      const combined1 = `${run1.stdout || ""}\n${run1.stderr || ""}`;
      check("B run1: nonzero exit", run1.status !== 0, run1.status);
      check("B run1: recoverable postcondition, not the old death",
        /tasks_no_executable_phases/.test(combined1) && !/No unchecked SpecKit tasks found/.test(combined1),
        combined1.slice(-1200));

      const events1 = readAllResults(repo);
      check("B run1: ZERO relays before the block (dies before any role)",
        events1.length === 0, events1.map(e => e.data.role));

      const state1 = readState(repo);
      check("B run1: recoverable tasks checkpoint",
        state1.speckitPlanningCheckpoint?.step === "tasks" &&
        state1.speckitPlanningCheckpoint?.reason === "planning-stage-postcondition" &&
        state1.speckitPlanningCheckpoint?.postcondition?.reason === "tasks_no_executable_phases",
        state1.speckitPlanningCheckpoint);
      check("B run1: same mission preserved", state1.mission === "002-tasks-phase", state1.mission);
      check("B run1: same feature preserved", state1.speckitFeatureDir === FEATURE, state1.speckitFeatureDir);
      check("B run1: routed to planning/tasks",
        state1.phase === "planning" && state1.step === "tasks", {phase: state1.phase, step: state1.step});
      check("B run1: Autopilot did NOT rewrite tasks.md",
        !/^## Phase /m.test(fs.readFileSync(path.join(repo, "specs", FEATURE, "tasks.md"), "utf8")));

      const run2 = await runMission(repo, binDir, REQUEST_B, 240000);
      if (!assertCleanRun("B run2", run2)) return;
      const combined2 = `${run2.stdout || ""}\n${run2.stderr || ""}`;
      check("B run2: exit 0", run2.status === 0, {status: run2.status, tail: combined2.slice(-800)});
      check("B run2: HUMAN COMMIT REQUIRED", /HUMAN COMMIT REQUIRED/.test(combined2), combined2.slice(-500));
      const state2 = readState(repo);
      check("B run2: resume intent", state2.planningIntent?.kind === "resume", state2.planningIntent);
      check("B run2: complete/human_commit", state2.phase === "complete" && state2.step === "human_commit", {phase: state2.phase, step: state2.step});
      check("B run2: same mission through recovery", state2.mission === "002-tasks-phase", state2.mission);
      check("B run2: same feature through recovery", state2.speckitFeatureDir === FEATURE, state2.speckitFeatureDir);
      check("B run2: single mission folder (no fork)",
        missionDirs(repo).length === 1 && missionDirs(repo)[0] === "002-tasks-phase", missionDirs(repo));
      check("B run2: structured correction sentinel reached the planner",
        tasksCorrectionBriefs(repo).length >= 1, tasksCorrectionBriefs(repo).length);

      const events2 = readAllResults(repo);
      const roles2 = events2.map(e => e.data.role);
      const implIdx = roles2.indexOf("implementer");
      check("B run2: implementation only after correction", implIdx !== -1, roles2);
      const reviewersBefore = implIdx === -1 ? [] : roles2.slice(0, implIdx).filter(r => r === "plan_reviewer");
      check("B run2: Tasks Review gate before implementer", reviewersBefore.length >= 1, roles2);
      check("B run2: task marked [x] after verification",
        /- \[x\] Do the tasks phase task/.test(fs.readFileSync(path.join(repo, "specs", FEATURE, "tasks.md"), "utf8")));
      check("B run2: HEAD unchanged (no commit)", git(repo, ["rev-parse", "HEAD"]) === headBefore);
    }
  } finally {
    cleanup(...owned);
  }

  check("owned fixtures removed after cleanup", owned.every(d => !fs.existsSync(d)), owned.filter(d => fs.existsSync(d)));

  let leaked = null;
  let leakError = null;
  try {
    leaked = listLeakedTemp(leakPrefixes).filter(p => ![...preExisting].includes(p));
  } catch (e) {
    leakError = String((e && e.message) || e);
  }
  check("temporary workspace enumeration succeeded", leakError === null, leakError);
  if (leakError === null) check("temporary workspace cleanup (no owned fixture remains)", leaked.length === 0, leaked);

  const survivorCheck = spawnSync("powershell", ["-NoProfile", "-Command",
    `(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*windows-tasks-phase-adapter.mjs*' -or $_.CommandLine -like '*ap-win-tasks-phase-bin-*' } | Measure-Object).Count`
  ], {encoding: "utf8"});
  const survivorText = String(survivorCheck.stdout || "").trim();
  const survivorValid = survivorCheck.status === 0 && /^\d+$/.test(survivorText);
  check("process-tree survivor query valid", survivorValid, {status: survivorCheck.status, stdout: survivorText});
  if (survivorValid) check("process-tree cleanup (no surviving adapter descendant)", Number(survivorText) === 0, {survivors: survivorText});

  const elapsed = ((Date.now() - overallStart) / 1000).toFixed(1);
  console.log(`\n(total runtime: ${elapsed}s)`);
  if (failures) {
    console.error(`\n${failures} windows tasks-phase-recovery check(s) failed.`);
    process.exit(1);
  }
  console.log("\nwindows tasks-phase-recovery PASS (orphan tasks rejected -> structured correction -> ordered recovery; legacy tasks_ready recovered)");
}

await main();