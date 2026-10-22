#!/usr/bin/env node
// TASK 15.6F — Native Windows behavioral proof for the git-invisible-phase guard.
//
// The real incident: Phase 1's only task created an empty docs/ directory.
// Git cannot represent empty directories, so the Implementer exited 0 with
// an empty delta, the disposable-copy Verifier could never observe it, and
// Autopilot burned five attempts plus three verification budget units.
//
// Drives the REAL public entrypoint (node bin/ap.cjs run --repo <fixture>)
// with a Node-based fake cursor-agent.cmd adapter. Three disposable missions:
//
//   M-runtime: implementer creates ONLY the empty docs/ dir -> die
//     GIT_INVISIBLE_PHASE after the first attempt: exactly 1 implementer
//     result, ZERO phase code-reviewer/verifier results, budgets untouched,
//     tasks unmarked, later-phase file absent.
//   M-gate: reviewer FAILs the review-tasks gate on observability grounds ->
//     gate failure before any implementation; the review-tasks brief proves
//     the strengthened contract was delivered.
//   M-normal: implementer writes a real file -> full PASS to HUMAN COMMIT
//     REQUIRED (ordering + marking intact).
//
// Windows-only: no-op PASS elsewhere (POSIX coverage in
// test-speckit-git-invisible-phase-behavior.mjs).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {runWindowsProcessTreeBounded} from "./test-fixtures/windows-process-tree-runner.mjs";
import {ensureBaseline, scopedDelta, listWorktreeEntries} from "./implementation-baseline.mjs";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import {gitSnapshot} from "./relay-guards.mjs";
import {createReviewerWorkspace} from "./reviewer-workspace.mjs";

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

// ── Cross-platform CRLF sections (mission 024 T3.3): run on EVERY
// platform, including POSIX/WSL. Fixtures use direct byte rewrites
// (platform-independent) with repo-local core.autocrlf=false, mirroring
// a Windows CRLF checkout without depending on ambient gitconfig.
//   (a) speckit disposable-copy path: CRLF-only rewrite leaves
//       ensureBaseline/scopedDelta clean and createReviewerWorkspace
//       byte-identical; a real CRLF-preserving edit still surfaces.
//   (b) standalone WSL snapshot path: gitSnapshot fingerprint stable
//       across a CRLF-only rewrite, mission-opt scopedDelta clean,
//       listWorktreeEntries unchanged by CRLF but changed by an empty
//       dir (the invisible-phase guard still fires for empty dirs).
{
  const crlfGit = (cwd, args) => {
    const r = spawnSync("git", args, {cwd, encoding: "utf8", stdio: "pipe", env: withoutOuterGitGuard(process.env), shell: false});
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim().slice(0, 500)}`);
    return (r.stdout || "").trim();
  };
  const makeCrlfRepo = (tag) => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), `ap-win-crlf-${tag}-`));
    crlfGit(repo, ["init", "-q"]);
    crlfGit(repo, ["config", "user.email", "crlf-invisible-test@example.invalid"]);
    crlfGit(repo, ["config", "user.name", "CRLF Invisible Test"]);
    crlfGit(repo, ["config", "core.autocrlf", "false"]);
    const lines = Array.from({length: 50}, (_, i) => `crlf-line-${String(i + 1).padStart(3, "0")}`);
    fs.writeFileSync(path.join(repo, "file.txt"), `${lines.join("\n")}\n`);
    crlfGit(repo, ["add", "-A"]);
    crlfGit(repo, ["commit", "-q", "-m", "init: lf fixture"]);
    return repo;
  };
  const toCrlfBytes = (repo, name = "file.txt") => {
    const abs = path.join(repo, name);
    const lf = fs.readFileSync(abs, "utf8");
    fs.writeFileSync(abs, lf.replace(/\n/g, "\r\n"));
  };
  // (a) speckit disposable-copy path
  {
    const repo = makeCrlfRepo("disposable");
    let ws = null;
    try {
      ensureBaseline(repo, "speckit-phase-test");
      const entriesBefore = listWorktreeEntries(repo);
      toCrlfBytes(repo);
      check("CRLF-A: scopedDelta clean on CRLF-only rewrite", scopedDelta(repo, "speckit-phase-test") === "");
      ws = await createReviewerWorkspace({repository: repo});
      const srcBytes = fs.readFileSync(path.join(repo, "file.txt"));
      const copyBytes = fs.readFileSync(path.join(ws.reviewRepository, "file.txt"));
      check("CRLF-A: disposable copy byte-identical on CRLF fixture", srcBytes.equals(copyBytes), `${srcBytes.length} vs ${copyBytes.length}`);
      check("CRLF-A: worktree listing unchanged by CRLF rewrite",
        JSON.stringify(listWorktreeEntries(repo)) === JSON.stringify(entriesBefore));
      // A real CRLF-preserving edit must still surface (no over-normalization).
      const raw = fs.readFileSync(path.join(repo, "file.txt"), "utf8");
      const edited = raw.replace("crlf-line-010", "crlf-line-010-EDITED");
      fs.writeFileSync(path.join(repo, "file.txt"), edited);
      check("CRLF-A: scopedDelta non-empty on real CRLF edit", scopedDelta(repo, "speckit-phase-test").trim() !== "");
    } finally {
      try { if (ws) await ws.cleanup(); } catch {}
      fs.rmSync(repo, {recursive: true, force: true});
    }
  }
  // (b) standalone WSL snapshot path
  {
    const repo = makeCrlfRepo("wsl");
    try {
      const mission = "standalone-crlf-test";
      ensureBaseline(repo, "standalone-phase-test", {mission, declaredPaths: []});
      const snapBefore = gitSnapshot(repo);
      const entriesBefore = listWorktreeEntries(repo);
      toCrlfBytes(repo);
      const snapAfter = gitSnapshot(repo);
      check("CRLF-B: gitSnapshot fingerprint stable on CRLF-only rewrite",
        snapBefore.fingerprint === snapAfter.fingerprint);
      check("CRLF-B: mission-opt scopedDelta clean on CRLF-only rewrite",
        scopedDelta(repo, "standalone-phase-test", {mission, declaredPaths: []}).trim() === "");
      check("CRLF-B: worktree listing unchanged by CRLF rewrite",
        JSON.stringify(listWorktreeEntries(repo)) === JSON.stringify(entriesBefore));
      // Guard contrast: an empty dir IS a worktree change git cannot see.
      fs.mkdirSync(path.join(repo, "docs"), {recursive: true});
      const deltaEmpty = scopedDelta(repo, "standalone-phase-test", {mission, declaredPaths: []}).trim() === "";
      const listingChanged = JSON.stringify(listWorktreeEntries(repo)) !== JSON.stringify(entriesBefore);
      check("CRLF-B: empty dir keeps delta empty (guard precondition)", deltaEmpty);
      check("CRLF-B: empty dir changes worktree listing (guard still fires)", listingChanged);
    } finally {
      fs.rmSync(repo, {recursive: true, force: true});
    }
  }
}

if (process.platform !== "win32") {
  // Cross-platform CRLF sections below already ran; the M-runtime/M-gate/
  // M-normal missions above are Windows-only.
  console.log("SKIP: task 15.6F Windows git-invisible-phase missions — not running on win32.");
  if (failures) {
    console.error(`\n${failures} windows git-invisible-phase check(s) failed.`);
    process.exit(1);
  }
  console.log("\ncross-platform CRLF invisible-phase PASS (disposable copy + WSL snapshot clean on CRLF fixtures)");
  process.exit(0);
}

const FEATURE = "001-invisible-phase";
const INCIDENT_TASKS = [
  "## Phase 1: Setup",
  "",
  "- [ ] T001 Create the docs/ directory at the repository root",
  "",
  "## Phase 2: Documentation Authoring",
  "",
  "- [ ] T002 Write docs/FINAL-SMOKE.md with the required sections",
  ""
].join("\n");

function git(cwd, args) {
  const r = spawnSync("git", args, {cwd, encoding: "utf8", stdio: "pipe", env: withoutOuterGitGuard(process.env), shell: false});
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim().slice(0, 1000)}`);
  return (r.stdout || "").trim();
}

const WORKFLOW_YML = [
  "- id: specify", "  type: command", "  command: /speckit.specify",
  "- id: review-spec", "  type: gate", "  message: Review the specification",
  "- id: plan", "  type: command", "  command: /speckit.plan",
  "- id: review-plan", "  type: gate", "  message: Review the plan",
  "- id: tasks", "  type: command", "  command: /speckit.tasks",
  "- id: review-tasks", "  type: gate", "  message: Review the tasks",
  "- id: implement", "  type: command", "  command: /speckit.implement",
  ""
].join("\n");

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-win-invisible-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "win-invisible-test@example.invalid"]);
  git(repo, ["config", "user.name", "Windows Invisible Phase Test"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# Invisible Phase Fixture\n");
  const wfDir = path.join(repo, ".specify", "workflows", "speckit");
  fs.mkdirSync(wfDir, {recursive: true});
  fs.writeFileSync(path.join(wfDir, "workflow.yml"), WORKFLOW_YML);
  fs.writeFileSync(path.join(repo, "CLAUDE.md"), ["# CLAUDE.md", "", "<!-- SPECKIT START -->", "(no active SpecKit feature)", "<!-- SPECKIT END -->", ""].join("\n"));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init: invisible-phase fixture"]);
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

// mode: "mkdir-only" (incident reproduction), "write-file" (normal control).
// gateMode: "pass" or "reject-tasks" (review-tasks FAIL on observability).
function adapterScript(mode, gateMode) {
  return [
    `import fs from "node:fs";`,
    `import path from "node:path";`,
    `const MODE = ${JSON.stringify(mode)};`,
    `const GATE = ${JSON.stringify(gateMode)};`,
    `function readStdin(){ return new Promise((res, rej)=>{ let d=""; process.stdin.setEncoding("utf8"); process.stdin.on("data",c=>{d+=c;}); process.stdin.on("end",()=>res(d)); process.stdin.on("error",rej); }); }`,
    `const args = process.argv.slice(2);`,
    `if (args[0] === "--version") { console.log("fake-windows-invisible-phase 1.0.0"); process.exit(0); }`,
    `const PROMPT = await readStdin();`,
    `const firstLine = PROMPT.split(/\\r?\\n/, 1)[0] || "";`,
    `const role = firstLine.startsWith("ROLE=") ? firstLine.slice("ROLE=".length).trim() : "";`,
    `const stepMatch = PROMPT.match(/^Planning phase: (.*)\\.$/m);`,
    `const STEP = stepMatch ? stepMatch[1].trim() : "";`,
    `const F = ${JSON.stringify(FEATURE)};`,
    `if (role === "planner") {`,
    `  if (STEP === "specify") {`,
    `    fs.mkdirSync(".specify", {recursive:true});`,
    `    fs.writeFileSync(path.join(".specify","feature.json"), JSON.stringify({feature_directory: "specs/" + F}));`,
    `    fs.mkdirSync(path.join("specs", F), {recursive:true});`,
    `    fs.writeFileSync(path.join("specs", F, "spec.md"), "# Spec\\n\\nFixture.\\n");`,
    `  } else if (STEP === "plan") {`,
    `    fs.writeFileSync(path.join("specs", F, "plan.md"), "# Plan\\n\\nFixture plan.\\n");`,
    `    try {`,
    `      const cur = fs.readFileSync("CLAUDE.md","utf8");`,
    `      const b = "<!-- SPECKIT START -->"; const e = "<!-- SPECKIT END -->";`,
    `      const bi = cur.indexOf(b); const ei = cur.indexOf(e);`,
    `      if (bi !== -1 && ei !== -1 && ei > bi) fs.writeFileSync("CLAUDE.md", cur.slice(0, bi + b.length) + "\\nActive feature: " + F + "\\n" + cur.slice(ei));`,
    `    } catch {}`,
    `  } else if (STEP === "tasks") {`,
    `    fs.writeFileSync(path.join("specs", F, "tasks.md"), ${JSON.stringify(INCIDENT_TASKS)});`,
    `  } else { console.error("fake planner: unexpected STEP"); process.exit(1); }`,
    `  console.log("planner ok"); process.exit(0);`,
    `}`,
    `if (role === "implementer") {`,
    `  if (MODE === "write-file") {`,
    `    fs.mkdirSync("docs", {recursive:true});`,
    `    fs.writeFileSync(path.join("docs","FINAL-SMOKE.md"), "# Smoke\\n\\nContent.\\n");`,
    `  } else {`,
    `    fs.mkdirSync("docs", {recursive:true});`,
    `  }`,
      `  console.log("implementer ok");`,
      // TASK-19 Phase 4 (task 12): the per-task Implementer invocation must end
      // with the AUTOPILOT_TASK_RESULT sentinel as its final non-empty line.
      `  console.log("AUTOPILOT_TASK_RESULT=" + JSON.stringify({summary: "implementer ok", taskLocalCheck: {command: "true", status: "passed", exitCode: 0, summary: "fixture"}}));`,
      `  process.exit(0);`,
    `}`,
    `if (role === "plan_reviewer") {`,
    `  if (GATE === "reject-tasks" && PROMPT.includes('SpecKit gate "review-tasks"')) {`,
    `    console.log("AUTOPILOT_REVIEW=" + JSON.stringify({decision:"FAIL", findings:["Phase 1 has no Git-observable deliverable: creating an empty directory is git-invisible, so this phase could never be verified. Fold it into the file-creating phase."]})); process.exit(0);`,
    `  }`,
    `  console.log("AUTOPILOT_REVIEW=" + JSON.stringify({decision:"PASS", findings:[]})); process.exit(0);`,
    `}`,
    `if (role === "code_reviewer" || role === "verifier") {`,
    `  console.log("AUTOPILOT_REVIEW=" + JSON.stringify({decision:"PASS", findings:[]})); process.exit(0);`,
    `}`,
    `console.error("fake adapter: unknown ROLE"); process.exit(1);`
  ].join("\n");
}

function makeBin(mode, gateMode) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-win-invisible-bin-"));
  const scriptPath = path.join(binDir, "windows-invisible-adapter.mjs");
  fs.writeFileSync(scriptPath, adapterScript(mode, gateMode));
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
    .sort((a, b) => (Date.parse(a.data.startedAt || 0) || 0) - (Date.parse(b.data.startedAt || 0) || 0));
}
function readBriefs(repo) {
  const out = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === "brief.txt") out.push(fs.readFileSync(full, "utf8"));
    }
  })(path.join(repo, ".autopilot"));
  return out;
}
function readState(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
}
function cleanup(...targets) {
  for (const dir of targets) {
    if (!dir) continue;
    try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* best-effort */ }
  }
}
function listLeakedTemp(prefixes) {
  return fs.readdirSync(os.tmpdir()).filter(n => prefixes.some(p => n.startsWith(p))).map(n => path.join(os.tmpdir(), n));
}
function tasksContent(repo) {
  return fs.readFileSync(path.join(repo, "specs", FEATURE, "tasks.md"), "utf8");
}
async function main() {
  const overallStart = Date.now();
  const leakPrefixes = ["ap-win-invisible-", "autopilot-reviewer-"];
  const preExisting = new Set(listLeakedTemp(leakPrefixes));
  const owned = [];
  try {
    // ── M-runtime: mkdir-only implementer dies GIT_INVISIBLE_PHASE ──────
    {
      const repo = makeRepo();
      const {binDir} = makeBin("mkdir-only", "pass");
      owned.push(repo, binDir);
      writeConfig(repo);
      const headBefore = git(repo, ["rev-parse", "HEAD"]);
      const warmup = await runWindowsProcessTreeBounded("cmd.exe", ["/d", "/s", "/c", path.join(binDir, "cursor-agent.cmd"), "--version"], {timeoutMs: 60000});
      check("R: warmup answers --version", warmup.status === 0 && !warmup.timedOut, warmup);
      const run = await runMission(repo, binDir, "Add invisible phase feature", 180000);
      check("R: process completed cleanly", !run.timedOut && !run.outputLimitExceeded && !run.terminationFailed, run);
      const combined = `${run.stdout || ""}\n${run.stderr || ""}`;
      check("R: nonzero exit", run.status !== 0, run.status);
      check("R: precise GIT_INVISIBLE_PHASE failure", /GIT_INVISIBLE_PHASE/.test(combined), combined.slice(-1200));
      check("R: names the phase", /Phase 1/.test(combined), combined.slice(-1200));
      check("R: names the affected task", /tasks\.md:/.test(combined), combined.slice(-1200));
      const events = readAllResults(repo);
      const roles = events.map(e => e.data.role);
      check("R: exactly 1 implementer attempt (stops after first no-op)", roles.filter(r => r === "implementer").length === 1, roles);
      // The mission dies inside Phase 1, so no phase-level and no final
      // code_reviewer/verifier can exist either — zero of both roles total.
      const phaseReviews = events.filter(e => ["code_reviewer", "verifier"].includes(e.data.role));
      check("R: ZERO code_reviewer/verifier results", phaseReviews.length === 0, roles);
      check("R: 3 gate reviewers ran (spec/plan/tasks gates PASS)", roles.filter(r => r === "plan_reviewer").length === 3, roles);
      const state = readState(repo);
      check("R: escalated git_invisible_phase", state.phase === "escalated" && state.step === "git_invisible_phase", {phase: state.phase, step: state.step});
      check("R: attempt stayed at 1 (no retry loop)", state.attempt === 1, state.attempt);
      check("R: failure budgets untouched", state.failureBudgets == null, state.failureBudgets);
      check("R: phase identity recorded", state.gitInvisiblePhase?.phase === "Phase 1 — Setup" || /Phase 1/.test(state.gitInvisiblePhase?.phase || ""), state.gitInvisiblePhase);
      check("R: implementer touched nothing git-visible", events.find(e => e.data.role === "implementer")?.data.touchedFiles?.length === 0, events.find(e => e.data.role === "implementer")?.data.touchedFiles);
      check("R: empty docs/ dir exists in official repo (fs changed, git blind)",
        fs.existsSync(path.join(repo, "docs")) && fs.statSync(path.join(repo, "docs")).isDirectory() && fs.readdirSync(path.join(repo, "docs")).length === 0, fs.existsSync(path.join(repo, "docs")) && fs.readdirSync(path.join(repo, "docs")));
      check("R: tasks.md unmarked (all still [ ])", !/- \[x\]/.test(tasksContent(repo)));
      check("R: later-phase file absent (not skipped)", !fs.existsSync(path.join(repo, "docs", "FINAL-SMOKE.md")));
      check("R: HEAD unchanged", git(repo, ["rev-parse", "HEAD"]) === headBefore);
    }
    // ── M-gate: review-tasks rejects the invisible phase ────────────────
    {
      const repo = makeRepo();
      const {binDir} = makeBin("mkdir-only", "reject-tasks");
      owned.push(repo, binDir);
      writeConfig(repo);
      const run = await runMission(repo, binDir, "Add invisible phase feature", 180000);
      check("G: process completed cleanly", !run.timedOut && !run.outputLimitExceeded && !run.terminationFailed, run);
      const combined = `${run.stdout || ""}\n${run.stderr || ""}`;
      check("G: nonzero exit", run.status !== 0, run.status);
      check("G: review-tasks gate failure surfaced", /SpecKit gate review-tasks failed/.test(combined), combined.slice(-800));
      const events = readAllResults(repo);
      const roles = events.map(e => e.data.role);
      check("G: implementer NEVER launched", !roles.includes("implementer"), roles);
      check("G: code_reviewer/verifier NEVER launched", !roles.includes("code_reviewer") && !roles.includes("verifier"), roles);
      const gateBriefs = readBriefs(repo).filter(b => b.includes('SpecKit gate "review-tasks"'));
      check("G: gate brief exists", gateBriefs.length >= 1, gateBriefs.length);
      check("G: strengthened contract delivered to reviewer", gateBriefs.some(b => b.includes("Git-observable") && b.includes("empty directory")), gateBriefs.length);
      check("G: tasks unmarked", !/- \[x\]/.test(tasksContent(repo)));
    }
    // ── M-normal: real-file phase completes in order ─────────────────────
    {
      const repo = makeRepo();
      const {binDir} = makeBin("write-file", "pass");
      owned.push(repo, binDir);
      writeConfig(repo);
      const headBefore = git(repo, ["rev-parse", "HEAD"]);
      const run = await runMission(repo, binDir, "Add invisible phase feature", 180000);
      check("N: process completed cleanly", !run.timedOut && !run.outputLimitExceeded && !run.terminationFailed, run);
      const combined = `${run.stdout || ""}\n${run.stderr || ""}`;
      check("N: exit 0", run.status === 0, {status: run.status, tail: combined.slice(-600)});
      check("N: HUMAN COMMIT REQUIRED", /HUMAN COMMIT REQUIRED/.test(combined), combined.slice(-400));
      const events = readAllResults(repo);
      const roles = events.map(e => e.data.role);
      check("N: implementer ran", roles.includes("implementer"), roles);
      check("N: code review + verifier ran", roles.includes("code_reviewer") && roles.includes("verifier"), roles);
      const state = readState(repo);
      check("N: complete/human_commit", state.phase === "complete" && state.step === "human_commit", {phase: state.phase, step: state.step});
      check("N: deliverable file exists", fs.existsSync(path.join(repo, "docs", "FINAL-SMOKE.md")));
      check("N: tasks marked [x] after verification", /- \[x\] T002/.test(tasksContent(repo)));
      check("N: HEAD unchanged", git(repo, ["rev-parse", "HEAD"]) === headBefore);
    }
  } finally {
    cleanup(...owned);
  }
  check("owned fixtures removed", owned.every(d => !fs.existsSync(d)), owned.filter(d => fs.existsSync(d)));
  let leaked = null;
  let leakError = null;
  try {
    leaked = listLeakedTemp(leakPrefixes).filter(p => ![...preExisting].includes(p));
  } catch (e) {
    leakError = String((e && e.message) || e);
  }
  check("temp enumeration succeeded", leakError === null, leakError);
  if (leakError === null) check("temp cleanup (no owned fixture remains)", leaked.length === 0, leaked);
  const survivorCheck = spawnSync("powershell", ["-NoProfile", "-Command",
    `(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*windows-invisible-adapter.mjs*' -or $_.CommandLine -like '*ap-win-invisible-bin-*' } | Measure-Object).Count`
  ], {encoding: "utf8"});
  const survivorText = String(survivorCheck.stdout || "").trim();
  const survivorValid = survivorCheck.status === 0 && /^\d+$/.test(survivorText);
  check("survivor query valid", survivorValid, {status: survivorCheck.status, stdout: survivorText});
  if (survivorValid) check("no surviving adapter descendant", Number(survivorText) === 0, {survivors: survivorText});
  console.log(`\n(total runtime: ${((Date.now() - overallStart) / 1000).toFixed(1)}s)`);
  if (failures) {
    console.error(`\n${failures} windows git-invisible-phase check(s) failed.`);
    process.exit(1);
  }
  console.log("\nwindows git-invisible-phase PASS (mkdir-only dies GIT_INVISIBLE_PHASE; gate rejects; normal file phase completes)");
}
await main();
