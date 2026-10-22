#!/usr/bin/env node
// TASK 15.6 — Native Windows Full SpecKit Workflow Verification.
//
// Proves the complete SpecKit workflow works on Native Windows using the
// saved execution.runtime_mode = "windows-compatibility", in the required
// order:
//
//   Planning -> Plan Review PASS -> Implementation
//     -> Code Review PASS -> Verification PASS
//     -> Human commit required
//
// Drives the REAL public entrypoint:
//
//   node bin/ap.cjs run "<request>" --repo <disposable-fixture-repo>
//
// Never calls internal workflow functions directly, never patches canonical
// production files, never launches a real installed agent CLI, never touches
// /home/user/my-app.
//
// Fixture configuration (requirement 5):
//   - SpecKit framework (explicit planning_framework: "speckit")
//   - Windows Compatibility (execution.runtime_mode: "windows-compatibility")
//   - Planner + Implementer invoke the fake adapter in WRITABLE mode
//     (cursor write args: -p --force)
//   - Plan Reviewer + Code Reviewer + Verifier invoke the SAME fake adapter
//     binary in READ-ONLY mode (cursor read_only args: -p --read-only)
//     The distinction is observed, not assumed: every invocation logs its
//     argv, and this test asserts writable roles saw --force while
//     read-only roles saw --read-only.
//
// For each read-only role the fake deliberately attempts (requirement 7):
//   - a relative write in its working directory (disposable copy only)
//   - a write in its supplied scratch directory (must succeed)
// and this test proves:
//   - the relative write affects only the disposable reviewer copy
//   - the official fixture repository is unchanged by reviewer writes
//   - scratch writes succeed
//   - reviewer disposable copies are deleted after completion
//   - no .git metadata exists in reviewer copies
//   - each reviewer receives the current expected project state
//
// Disposable-copy isolation is compatibility isolation, NOT OS-enforced
// containment: it protects the official repository through a throwaway copy,
// not against a malicious process that already knows and directly targets
// the absolute official path. This test never claims otherwise and asserts
// the truthful windows-disposable-copy/compatibility metadata.
//
// Preserved and verified (requirement 9):
//   - failure-loop behavior (Code Review FAIL on attempt 1 -> automatic
//     retry -> PASS on attempt 2, Verifier only after the PASS)
//   - Task 14 checkbox rules (Implementer poisons every tasks.md checkbox
//     on every attempt; reviewers independently observe [ ] because
//     Autopilot neutralizes before review; Autopilot alone marks [x] only
//     after Implementer + Code Review PASS + gates + Verifier PASS)
//   - preflight probe deduplication (one probe for the single shared adapter)
//   - no WSL delegation when Windows Compatibility is selected
//   - no Playwright requirement unless the fixture requests browser work
//     (this fixture requests none: no browser annotation, no browser file,
//     empty gates.commands, require_browser: when-task-requires)
//
// Test-process requirements (requirement 10):
//   - hard deadline via runWindowsProcessTreeBounded (whole-tree taskkill)
//   - bounded stdout/stderr by bytes (runner sinks)
//   - single settlement (runner settled guard)
//   - cleanup in finally blocks (repo + binDir + leak sweep)
//   - fail if any owned fixture/process remains (temp sweep + survivor scan)
//
// Observable state only: workflow state.json, on-disk artifacts,
// result.json role decisions, and ordering by run-seq. Never prompt prose.
//
// Windows-only: no-op PASS on any other platform (the production condition
// is itself gated to process.platform === "win32"). WSL/Linux bubblewrap
// coverage already exists elsewhere and is untouched.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import { runWindowsProcessTreeBounded } from "./test-fixtures/windows-process-tree-runner.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");
const CANONICAL_AP = path.join(skillRoot, "bin", "ap.cjs");
const CANONICAL_AUTOPILOT = path.join(skillRoot, "scripts", "autopilot.mjs");

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 3000)}` : ""}`);
  return false;
};

if (process.platform !== "win32") {
  console.log("SKIP: task 15.6 Native Windows full SpecKit workflow — not running on win32.");
  process.exit(0);
}

function sha256File(f) {
  return crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
}
function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: "pipe", env: withoutOuterGitGuard(process.env), shell: false });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim().slice(0, 2000)}`);
  return (r.stdout || "").trim();
}
function cleanup(...targets) {
  for (const dir of targets) {
    if (!dir) continue;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
function assertCleanRun(label, result) {
  return check(`${label}: process completed cleanly (no timeout, output overflow, or termination failure)`,
    !result.timedOut && !result.outputLimitExceeded && !result.terminationFailed,
    { timedOut: result.timedOut, outputLimitExceeded: result.outputLimitExceeded, terminationFailed: result.terminationFailed, stdoutTail: (result.stdout || "").slice(-1200), stderrTail: (result.stderr || "").slice(-1200) });
}
function repoStatusExcludingAutopilot(repo) {
  return git(repo, ["status", "--porcelain"]).split("\n").filter(l => l && !l.includes(".autopilot")).sort().join("\n");
}
function listLeakedTemp(prefixes) {
  // Fail closed: directory enumeration failure must never look like "no
  // leak" (an empty list). Throw so the caller records an explicit failure.
  const root = os.tmpdir();
  const names = fs.readdirSync(root);
  return names.filter(n => prefixes.some(p => n.startsWith(p))).map(n => path.join(root, n));
}

// ---------------------------------------------------------------------
// Hermetic PATH: identical rationale to test-preflight-deduplication.mjs.
// Windows ranks .exe ahead of .cmd globally, so prefix-first is not enough;
// the fixture PATH must contain NO directory able to supply ANY manifest
// agent binary outside the disposable fixture dir. System32 is kept so
// where.exe still resolves; git/node remain reachable via the filtered
// original PATH.
// ---------------------------------------------------------------------
const AGENT_BINARIES = ["claude", "opencode", "codex", "agy", "cursor-agent"];
const WIN_EXTS = [".exe", ".com", ".cmd", ".bat", ""];
function dirSuppliesAgent(dir) {
  for (const name of AGENT_BINARIES) {
    for (const ext of WIN_EXTS) {
      try { if (fs.existsSync(path.join(dir, name + ext))) return true; } catch { /* unreadable */ }
    }
  }
  return false;
}
function missionFixturePath(binDir) {
  const original = (process.env.PATH || "").split(";").filter(Boolean);
  return [binDir, ...original.filter(d => !dirSuppliesAgent(d))].join(";");
}
function resolveUnderPath(binary, envPath) {
  const r = spawnSync("where.exe", [binary], { encoding: "utf8", env: { ...process.env, PATH: envPath }, stdio: ["ignore", "pipe", "ignore"], shell: false });
  if (r.status !== 0) return [];
  return String(r.stdout || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------
// Fixture repository: starts with NO SpecKit feature (planning must create
// it), plus workflow.yml, CLAUDE.md baseline with markers, .gitignore with
// an ignored fixture file, and a tracked README.
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

const FEATURE_SLUG = "001-win-full-workflow";
const TASK_TEXT = "Implement the windows verification task";

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-win-full-speckit-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "win-full-workflow-test@example.invalid"]);
  git(repo, ["config", "user.name", "Windows Full Workflow Test"]);
  fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n");
  fs.writeFileSync(path.join(repo, "README.md"), "# Win Full Workflow Fixture\n\nInitial tracked content.\n");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "original-tracked-content\n");
  const wfDir = path.join(repo, ".specify", "workflows", "speckit");
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, "workflow.yml"), WORKFLOW_YML);
  fs.writeFileSync(path.join(repo, "CLAUDE.md"), [
    "# CLAUDE.md",
    "",
    "Project instructions (outside the Autopilot-controlled section).",
    "",
    "<!-- SPECKIT START -->",
    "(no active SpecKit feature)",
    "<!-- SPECKIT END -->",
    "",
    "More project instructions.",
    ""
  ].join("\n"));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init: windows full-workflow fixture before planning"]);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "modified-tracked-content\n");
  fs.writeFileSync(path.join(repo, "untracked.txt"), "untracked-content\n");
  fs.writeFileSync(path.join(repo, "ignored.txt"), "ignored-content\n");
  return repo;
}

function writeConfig(repo) {
  const config = {
    schema_version: "3.0",
    project: { repo: ".", planning_framework: "speckit", state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs" },
    execution: { runtime_mode: "windows-compatibility", wsl_distro: null },
    roles: Object.fromEntries(["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"].map(role => [
      role, { adapter: "cursor", model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null }
    ])),
    workflow: {
      specReview: true, planReview: true, analysisAfterTasks: false, implementationReview: true, finalReview: true,
      autoApproveSpec: false, autoApprovePlan: false, parallelIndependentTasks: false, gsdPlanningReview: false,
      relaySafety: { block_git_commit_push: true, verify_read_only_by_snapshot: true, capture_touched_files: true, persist_role_sessions: true }
    },
    gates: { commands: [], env_allowlist: [], require_reviewer: true, network_isolation: true },
    policy: {
      max_plan_revisions: 1, retry_delay_ms: 0, checkpoint_after_task: true, checkpoint_after_phase: true,
      require_human_commit: true, fail_closed_on_relay_violation: true,
      failure_budgets: { implementationFailureBudget: 5, verificationFailureBudget: 5, adapterRetryBudget: 5, infrastructureRetryBudget: 5 }
    },
    safety: { allow_git_commit: false, allow_git_push: false, allow_destructive_operations: false },
    planning: {
      speckit: { workflow_file: ".specify/workflows/speckit/workflow.yml", task_candidates: [".specify/tasks.md", "specs/*/tasks.md", "specs/*/tasks/*.md"] },
      gsd: {
        phase_root: ".planning/phases", run_plan_verify: true, run_state_validate: true, write_summary_artifacts: true,
        write_verification_artifacts: true, write_uat_artifact: true, use_gsd_tools_when_available: false,
        parallelization: { enabled: false, plan_level: false, task_level: false, max_concurrent_agents: 1, min_plans_for_parallel: 99 },
        planning_review: { enabled: false, review_after_each_stage: true, stages: ["discuss", "research", "plan", "plan-check"], max_revisions: 3, read_only_reviewer: true }
      }
    },
    capabilities: { project_defaults: [], role_requirements: {}, safety_denied: [], legacy_text_inference: false, verification: { browser: "native", require_browser: "when-task-requires" } }
  };
  fs.mkdirSync(path.join(repo, ".autopilot"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), JSON.stringify(config, null, 2));
}

// ---------------------------------------------------------------------
// Fake adapter: single cursor-agent.cmd trampoline around a Node script.
// Plain-text protocol (cursor has no registered driver), hermetic, and
// self-logging to invocations.log in its own binDir (outside the repo).
//
// Planner creates the real SpecKit contracts for exactly one NEW feature.
// Implementer writes the authorized output plus a premature checkbox poison
// (Task 14 proof). Each read-only role probes disposable isolation and
// returns PASS/FAIL from OBSERVED repository state only.
// ---------------------------------------------------------------------
function adapterScript(logFile) {
  const L = JSON.stringify(logFile);
  const F = JSON.stringify(FEATURE_SLUG);
  const T = JSON.stringify(TASK_TEXT);
  return [
    `import fs from "node:fs";`,
    `import path from "node:path";`,
    `const LOG = ${L};`,
    `const FEATURE_SLUG = ${F};`,
    `const TASK_TEXT = ${T};`,
    `function log(e){ fs.appendFileSync(LOG, JSON.stringify(e) + "\\n"); }`,
    `function readStdin(){ return new Promise((res, rej)=>{ let d=""; process.stdin.setEncoding("utf8"); process.stdin.on("data",c=>{d+=c;}); process.stdin.on("end",()=>res(d)); process.stdin.on("error",rej); }); }`,
    // Stable runtime scratch signal: AUTOPILOT_GIT_GUARD_LOG is always
    // <effective-scratch>/git-guard/blocked.log (see relay-guards.mjs
    // createGitMutationGuard + guardedEnv). Derived here, never parsed from
    // prompt prose. Missing/malformed signal fails the fake role closed.
    `function scratchFromGuardLog(){ const g = process.env.AUTOPILOT_GIT_GUARD_LOG || null; if (typeof g !== "string" || !g || !path.isAbsolute(g)) return {ok:false, reason:"guard log missing or not absolute", guardLog:g}; if (path.basename(g) !== "blocked.log") return {ok:false, reason:"guard log basename is not blocked.log", guardLog:g}; const gd = path.dirname(g); if (path.basename(gd) !== "git-guard") return {ok:false, reason:"guard log parent is not git-guard", guardLog:g}; const sc = path.dirname(gd); let st = null; try { st = fs.statSync(sc); } catch { st = null; } if (!st || !st.isDirectory()) return {ok:false, reason:"derived scratch directory does not exist", guardLog:g, scratch:sc}; return {ok:true, scratch:sc, guardLog:g}; }`,
    `const args = process.argv.slice(2);`,
    `if (args[0] === "--version") { log({kind:"probe", args, at:Date.now()}); console.log("fake-windows-full-workflow-cursor-agent 1.0.0"); process.exit(0); }`,
    `const PROMPT = await readStdin();`,
    `const firstLine = PROMPT.split(/\\r?\\n/, 1)[0] || "";`,
    `const role = firstLine.startsWith("ROLE=") ? firstLine.slice("ROLE=".length).trim() : "";`,
    `log({kind:"invocation", role, args, at:Date.now()});`,
    `function extractLine(prefix){ const re = new RegExp("^" + prefix + "(.*)$", "m"); const m = PROMPT.match(re); return m ? m[1].trim() : null; }`,
    // ---- planner: stage from observable filesystem state, never prompt ----
    `if (role === "planner") {`,
    `  const featureDir = "specs/" + FEATURE_SLUG;`,
    `  const specP = path.join(featureDir, "spec.md");`,
    `  const planP = path.join(featureDir, "plan.md");`,
    `  const tasksP = path.join(featureDir, "tasks.md");`,
    `  const hasSpec = fs.existsSync(specP);`,
    `  const hasPlan = fs.existsSync(planP);`,
    `  const hasTasks = fs.existsSync(tasksP);`,
    `  if (!hasSpec) {`,
    `    fs.mkdirSync(".specify", {recursive:true});`,
    `    fs.writeFileSync(path.join(".specify","feature.json"), JSON.stringify({feature_directory: featureDir}));`,
    `    fs.mkdirSync(path.join(featureDir,"checklists"), {recursive:true});`,
    `    fs.writeFileSync(path.join(featureDir,"spec.md"), "# Spec\\n\\nWindows full workflow feature.\\n");`,
    `    fs.writeFileSync(path.join(featureDir,"checklists","requirements.md"), "# Requirements checklist\\n\\n- [ ] Requirement A\\n");`,
    `  } else if (!hasPlan) {`,
    `    fs.mkdirSync(path.join(featureDir,"contracts"), {recursive:true});`,
    `    fs.writeFileSync(path.join(featureDir,"plan.md"), "# Plan\\n\\nWindows full workflow plan.\\n");`,
    `    fs.writeFileSync(path.join(featureDir,"research.md"), "# Research\\n\\nFindings.\\n");`,
    `    fs.writeFileSync(path.join(featureDir,"data-model.md"), "# Data Model\\n\\nEntities.\\n");`,
    `    fs.writeFileSync(path.join(featureDir,"quickstart.md"), "# Quickstart\\n\\nSteps.\\n");`,
    `    fs.writeFileSync(path.join(featureDir,"contracts","health.md"), "# Health contract\\n\\nGET /health\\n");`,
    `    try {`,
    `      if (fs.existsSync("CLAUDE.md")) {`,
    `        const cur = fs.readFileSync("CLAUDE.md","utf8");`,
    `        const b = "<!-- SPECKIT START -->"; const e = "<!-- SPECKIT END -->";`,
    `        const bi = cur.indexOf(b); const ei = cur.indexOf(e);`,
    `        if (bi !== -1 && ei !== -1 && ei > bi) {`,
    `          const next = cur.slice(0, bi + b.length) + "\\nActive feature: " + FEATURE_SLUG + "\\n" + cur.slice(ei);`,
    `          fs.writeFileSync("CLAUDE.md", next);`,
    `        }`,
    `      }`,
    `    } catch {} `,
    `  } else if (!hasTasks) {`,
    `    fs.mkdirSync(featureDir, {recursive:true});`,
    `    fs.writeFileSync(path.join(featureDir,"tasks.md"), "## Phase 1: Implement the windows verification task\\n\\n- [ ] " + TASK_TEXT + "\\n");`,
    `  } else {`,
    `    console.error("fake planner: unexpected filesystem state (spec+plan+tasks all present) — failing closed"); process.exit(1);`,
    `  }`,
    `  console.log("planner ok"); process.exit(0);`,
    `}`,
    // ---- implementer (writable) ----
    `if (role === "implementer") {`,
    `  const cwdNow = process.cwd();`,
    `  const counterFile = path.join(cwdNow, ".autopilot-impl-attempts");`,
    `  let n = 1; try { n = parseInt(fs.readFileSync(counterFile,"utf8").trim(),10) + 1; } catch {} `,
    `  fs.writeFileSync(counterFile, String(n));`,
    `  fs.writeFileSync(path.join(cwdNow, "implementer-output.txt"), "implementer-attempt-" + n + "\\n");`,
    // premature checkbox poison across every tasks.md (Task 14 proof)
    `  try {`,
    `    const specsRoot = path.join(cwdNow, "specs");`,
    `    if (fs.existsSync(specsRoot)) {`,
    `      for (const d of fs.readdirSync(specsRoot)) {`,
    `        const f = path.join(specsRoot, d, "tasks.md");`,
    `        if (fs.existsSync(f)) {`,
    `          const cur = fs.readFileSync(f,"utf8");`,
    `          fs.writeFileSync(f, cur.replaceAll("- [ ]", "- [x]"));`,
    `        }`,
    `      }`,
    `    }`,
    `  } catch {} `,
      `  console.log("implementer ok attempt=" + n);`,
      // TASK-19 Phase 4 (task 12): per-task Implementer invocation sentinel.
      `  console.log("AUTOPILOT_TASK_RESULT=" + JSON.stringify({summary: "implementer ok attempt=" + n, taskLocalCheck: {command: "true", status: "passed", exitCode: 0, summary: "fixture"}}));`,
      `  process.exit(0);`,
    `}`,
    // ---- shared read-only probe helper (inlined per role below) ----
    // plan_reviewer (scratch from stable AUTOPILOT_GIT_GUARD_LOG signal)
    `if (role === "plan_reviewer") {`,
    `  const cwdAtStart = process.cwd();`,
    `  const workspaceRoot = path.dirname(cwdAtStart);`,
    `  const repository = extractLine("REPOSITORY=");`,
    `  const derived = scratchFromGuardLog();`,
    `  if (!derived.ok) { const dj = JSON.stringify({cwd: cwdAtStart, scratchDerivationFailed: derived.reason, guardLog: derived.guardLog || null}); console.log("PROBE:" + dj); console.log("AUTOPILOT_REVIEW=" + JSON.stringify({decision:"FAIL", findings:[dj]})); process.exit(0); }`,
    `  const scratchPath = derived.scratch;`,
    `  const probe = { cwd: cwdAtStart, workspaceRoot, repositoryFromPrompt: repository, pwdEnv: process.env.PWD || null, initCwdEnv: process.env.INIT_CWD || null, safeDirectoryValueEnv: process.env.GIT_CONFIG_VALUE_1 || null, guardLog: derived.guardLog, role: "plan_reviewer" };`,
    `  try { probe.trackedContent = fs.readFileSync("tracked.txt","utf8"); } catch(e){ probe.trackedContent = null; probe.trackedError = String((e&&e.code)||e); }`,
    `  try { probe.untrackedContent = fs.readFileSync("untracked.txt","utf8"); } catch(e){ probe.untrackedContent = null; }`,
    `  probe.ignoredExists = fs.existsSync("ignored.txt");`,
    `  probe.gitDirExists = fs.existsSync(".git");`,
    `  try { probe.topLevelEntries = fs.readdirSync(".").sort(); } catch(e){ probe.topLevelEntries = ["READDIR_FAILED"]; }`,
    `  try { probe.specExists = fs.existsSync(path.join("specs", FEATURE_SLUG, "spec.md")); } catch { probe.specExists = false; }`,
    `  try { probe.specContent = fs.existsSync(path.join("specs", FEATURE_SLUG, "spec.md")) ? fs.readFileSync(path.join("specs", FEATURE_SLUG, "spec.md"),"utf8").slice(0,200) : null; } catch { probe.specContent = null; }`,
    `  try { probe.tasksRaw = fs.existsSync(path.join("specs", FEATURE_SLUG, "tasks.md")) ? fs.readFileSync(path.join("specs", FEATURE_SLUG, "tasks.md"),"utf8") : null; } catch { probe.tasksRaw = null; }`,
    `  try { fs.writeFileSync("plan-reviewer-relative-write.txt", "written-by-plan-reviewer"); probe.relativeWrite = "SUCCEEDED"; } catch(e){ probe.relativeWrite = "FAILED:" + String((e&&e.code)||e); }`,
    `  try { fs.writeFileSync(path.join(scratchPath, "scratch-write-plan-reviewer.txt"), "scratch-ok"); probe.scratchWrite = "SUCCEEDED"; } catch(e){ probe.scratchWrite = "FAILED:" + String((e&&e.code)||e); }`,
    `  const js = JSON.stringify(probe); console.log("PROBE:" + js);`,
    `  console.log("AUTOPILOT_REVIEW=" + JSON.stringify({decision:"PASS", findings:[js]})); process.exit(0);`,
    `}`,
    // code_reviewer (repair from observed implementer bytes only; no prompt prose)
    `if (role === "code_reviewer") {`,
    `  const cwdAtStart = process.cwd();`,
    `  const workspaceRoot = path.dirname(cwdAtStart);`,
    `  const repository = extractLine("REPOSITORY=");`,
    `  const derived = scratchFromGuardLog();`,
    `  if (!derived.ok) { const dj = JSON.stringify({cwd: cwdAtStart, scratchDerivationFailed: derived.reason, guardLog: derived.guardLog || null}); console.log("PROBE:" + dj); console.log("AUTOPILOT_REVIEW=" + JSON.stringify({decision:"FAIL", findings:[dj]})); process.exit(0); }`,
    `  const scratchPath = derived.scratch;`,
    `  const probe = { cwd: cwdAtStart, workspaceRoot, repositoryFromPrompt: repository, pwdEnv: process.env.PWD || null, initCwdEnv: process.env.INIT_CWD || null, safeDirectoryValueEnv: process.env.GIT_CONFIG_VALUE_1 || null, guardLog: derived.guardLog, role: "code_reviewer" };`,
    `  try { probe.implContent = fs.readFileSync("implementer-output.txt","utf8"); } catch(e){ probe.implContent = null; }`,
    `  try { probe.tasksRaw = fs.readFileSync(path.join("specs", FEATURE_SLUG, "tasks.md"),"utf8"); } catch(e){ probe.tasksRaw = null; }`,
    `  try { probe.trackedContent = fs.readFileSync("tracked.txt","utf8"); } catch(e){ probe.trackedContent = null; }`,
    `  probe.ignoredExists = fs.existsSync("ignored.txt");`,
    `  probe.gitDirExists = fs.existsSync(".git");`,
    `  try { probe.topLevelEntries = fs.readdirSync(".").sort(); } catch(e){ probe.topLevelEntries = ["READDIR_FAILED"]; }`,
    `  try { fs.writeFileSync("code-reviewer-relative-write.txt", "written-by-code-reviewer"); probe.relativeWrite = "SUCCEEDED"; } catch(e){ probe.relativeWrite = "FAILED:" + String((e&&e.code)||e); }`,
    `  try { fs.writeFileSync(path.join(scratchPath, "scratch-write-code-reviewer.txt"), "scratch-ok"); probe.scratchWrite = "SUCCEEDED"; } catch(e){ probe.scratchWrite = "FAILED:" + String((e&&e.code)||e); }`,
    `  const js2 = JSON.stringify(probe); console.log("PROBE:" + js2);`,
    // repair loop driven by OBSERVED implementer bytes only: attempt 1 FAIL,
    // any later observed state PASS (covers the phase retry and the final
    // repository review, which both observe attempt-2 bytes).
    `  let decision = "PASS";`,
    `  if (probe.implContent === "implementer-attempt-1\\n") decision = "FAIL";`,
    `  console.log("AUTOPILOT_REVIEW=" + JSON.stringify({decision, findings:[js2]})); process.exit(0);`,
    `}`,
    // verifier (scratch from stable AUTOPILOT_GIT_GUARD_LOG signal)
    `if (role === "verifier") {`,
    `  const cwdAtStart = process.cwd();`,
    `  const workspaceRoot = path.dirname(cwdAtStart);`,
    `  const repository = extractLine("REPOSITORY=");`,
    `  const derived = scratchFromGuardLog();`,
    `  if (!derived.ok) { const dj = JSON.stringify({cwd: cwdAtStart, scratchDerivationFailed: derived.reason, guardLog: derived.guardLog || null}); console.log("PROBE:" + dj); console.log("AUTOPILOT_REVIEW=" + JSON.stringify({decision:"FAIL", findings:[dj]})); process.exit(0); }`,
    `  const scratchPath = derived.scratch;`,
    `  const probe = { cwd: cwdAtStart, workspaceRoot, repositoryFromPrompt: repository, pwdEnv: process.env.PWD || null, initCwdEnv: process.env.INIT_CWD || null, safeDirectoryValueEnv: process.env.GIT_CONFIG_VALUE_1 || null, guardLog: derived.guardLog, role: "verifier" };`,
    `  try { probe.implContent = fs.readFileSync("implementer-output.txt","utf8"); } catch(e){ probe.implContent = null; }`,
    `  try { probe.tasksRaw = fs.readFileSync(path.join("specs", FEATURE_SLUG, "tasks.md"),"utf8"); } catch(e){ probe.tasksRaw = null; }`,
    `  try { probe.trackedContent = fs.readFileSync("tracked.txt","utf8"); } catch(e){ probe.trackedContent = null; }`,
    `  try { probe.untrackedContent = fs.readFileSync("untracked.txt","utf8"); } catch(e){ probe.untrackedContent = null; }`,
    `  probe.ignoredExists = fs.existsSync("ignored.txt");`,
    `  probe.gitDirExists = fs.existsSync(".git");`,
    `  try { probe.topLevelEntries = fs.readdirSync(".").sort(); } catch(e){ probe.topLevelEntries = ["READDIR_FAILED"]; }`,
    `  try { fs.writeFileSync("verifier-relative-write.txt", "written-by-verifier"); probe.relativeWrite = "SUCCEEDED"; } catch(e){ probe.relativeWrite = "FAILED:" + String((e&&e.code)||e); }`,
    `  try { fs.writeFileSync("implementer-output.txt", "verifier-tampered\\n"); probe.relativeOverwrite = "SUCCEEDED"; } catch(e){ probe.relativeOverwrite = "FAILED:" + String((e&&e.code)||e); }`,
    `  try { fs.writeFileSync(path.join(scratchPath, "scratch-write-verifier.txt"), "scratch-ok"); probe.scratchWrite = "SUCCEEDED"; } catch(e){ probe.scratchWrite = "FAILED:" + String((e&&e.code)||e); }`,
    `  const js3 = JSON.stringify(probe); console.log("PROBE:" + js3);`,
    `  console.log("AUTOPILOT_REVIEW=" + JSON.stringify({decision:"PASS", findings:[js3]})); process.exit(0);`,
    `}`,
    `console.error("fake-windows-full-workflow-adapter: unknown ROLE '" + role + "'"); process.exit(1);`
  ].join("\n");
}

function makeBin() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-win-full-bin-"));
  const logFile = path.join(binDir, "invocations.log");
  fs.writeFileSync(logFile, "");
  const scriptPath = path.join(binDir, "windows-full-workflow-adapter.mjs");
  fs.writeFileSync(scriptPath, adapterScript(logFile));
  fs.writeFileSync(path.join(binDir, "cursor-agent.cmd"), `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\nexit /b %errorlevel%\r\n`);
  return { binDir, logFile, scriptPath };
}

function readLog(logFile) {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, "utf8").split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
}

function runMission(repo, binDir, request, timeoutMs) {
  const base = withoutOuterGitGuard({...process.env});
  const env = { ...base, PATH: missionFixturePath(binDir) };
  return runWindowsProcessTreeBounded(process.execPath, [CANONICAL_AP, "run", request, "--repo", repo], { cwd: repo, env, timeoutMs });
}

function readAllResults(repo) {
  const root = path.join(repo, ".autopilot");
  const files = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === "result.json") files.push(full);
    }
  })(root);
  return files.map(file => ({ file, data: JSON.parse(fs.readFileSync(file, "utf8")) }));
}
function sortBySeq(results) {
  // Chronological order by the orchestrator's own timestamps (startedAt),
  // not by per-mission run-seq directory names: planning runs live under
  // .autopilot/missions/planning/runs/ while implementation runs live under
  // .autopilot/missions/<seq>-<name>/runs/, each with its own 01,02,...
  // sequence that is not globally comparable. This mirrors
  // test-fixtures/workflow-order-harness.mjs's readObservedEvents().
  return [...results].sort((a, b) => {
    const ta = Date.parse(a.data.startedAt || 0) || 0;
    const tb = Date.parse(b.data.startedAt || 0) || 0;
    if (ta !== tb) return ta - tb;
    const fa = Date.parse(a.data.finishedAt || 0) || 0;
    const fb = Date.parse(b.data.finishedAt || 0) || 0;
    return fa - fb;
  });
}
function extractProbe(resultData) {
  const findings = resultData?.review?.findings || resultData?.verdict?.findings || [];
  for (const f of findings) {
    try {
      const p = JSON.parse(f);
      if (p && typeof p === "object" && "cwd" in p) return p;
    } catch { /* not probe */ }
  }
  return null;
}
function isInsideOfficial(candidate, officialReal) {
  if (typeof candidate !== "string" || !candidate) return false;
  const c = path.resolve(candidate).toLowerCase();
  const o = officialReal.toLowerCase();
  return c === o || c.startsWith(o + path.sep);
}

// ---------------------------------------------------------------------
// Main: one full SpecKit mission from scratch through the PUBLIC entry.
// ---------------------------------------------------------------------
async function main() {
  const overallStart = Date.now();
  const leakPrefixes = ["ap-win-full-speckit-", "ap-win-full-bin-", "autopilot-reviewer-"];
  const preExisting = new Set(listLeakedTemp(leakPrefixes));

  const canonicalHashBefore = sha256File(CANONICAL_AUTOPILOT);
  const apHashBefore = sha256File(CANONICAL_AP);

  const repo = makeRepo();
  const { binDir, logFile } = makeBin();
  const owned = [repo, binDir];
  try {
    writeConfig(repo);

    // Hermetic PATH proof before the mission (not assumed).
    const fixturePath = missionFixturePath(binDir);
    const escapes = [];
    for (const name of AGENT_BINARIES) {
      for (const hit of resolveUnderPath(name, fixturePath)) {
        if (!path.resolve(hit).toLowerCase().startsWith(path.resolve(binDir).toLowerCase())) escapes.push({ name, hit });
      }
    }
    check("hermetic PATH: no manifest agent binary resolves outside the disposable fixture dir", escapes.length === 0, escapes);
    check("hermetic PATH: the fixture cursor-agent resolves inside it", resolveUnderPath("cursor-agent", fixturePath).length > 0, resolveUnderPath("cursor-agent", fixturePath));

    const headBefore = git(repo, ["rev-parse", "HEAD"]);
    const statusBefore = repoStatusExcludingAutopilot(repo);

    // Warmup outside the mission budget (AV first-scan cost). Truncate the
    // shared invocations.log afterward so the mission's own preflight
    // deduplication count starts from zero (warmup's own --version probe
    // would otherwise be miscounted as a second mission probe).
    const warmup = await runWindowsProcessTreeBounded("cmd.exe", ["/d", "/s", "/c", path.join(binDir, "cursor-agent.cmd"), "--version"], { timeoutMs: 60000 });
    check("warmup: fixture adapter answers --version", warmup.status === 0 && !warmup.timedOut, warmup);
    try { fs.writeFileSync(logFile, ""); } catch { /* best-effort */ }

    const request = "Add windows full workflow verification feature";
    const result = await runMission(repo, binDir, request, 420000);
    if (!assertCleanRun("full-workflow mission", result)) {
      check("full-workflow mission: clean run required before further assertions", false, { timedOut: result.timedOut, overflow: result.outputLimitExceeded, termFail: result.terminationFailed });
      return;
    }
    const combined = `${result.stdout || ""}\n${result.stderr || ""}`;

    // --- Runtime reports Windows Compatibility, no delegation ---
    check("runtime reports Windows Compatibility (disposable-copy isolation; not OS-enforced)", /Runtime: Windows Compatibility \(SpecKit disposable-copy isolation; not OS-enforced\)/.test(combined), combined.slice(-2500));
    check("no WSL delegation occurred (no WSL2 Strong label, no delegation language)", !/Runtime: WSL2 Strong/.test(combined) && !/delegat/i.test(combined), combined.slice(-2000));
    check("no READ_ONLY_CONTAINMENT_UNAVAILABLE anywhere in this SpecKit mission", !/READ_ONLY_CONTAINMENT_UNAVAILABLE/.test(combined), combined.slice(-1500));
    check("no OS-enforced envelope claim anywhere", !/OS-enforced bubblewrap/.test(combined) || /not OS-enforced/.test(combined), combined.slice(-1500));

    // --- Preflight deduplication: one probe for the single shared adapter ---
    const entries = readLog(logFile);
    const probes = entries.filter(e => e.kind === "probe");
    const invocations = entries.filter(e => e.kind === "invocation");
    check("preflight deduplication: exactly ONE availability probe for five roles sharing one adapter", probes.length === 1, { probes: probes.length, entries: entries.length });
    check("preflight deduplication: the single probe happened BEFORE any role invocation", entries.length > 0 && entries[0].kind === "probe", entries.slice(0, 3));
    check("preflight deduplication: real role invocations occurred (planning + implementation)", invocations.length >= 8, { count: invocations.length, roles: invocations.map(i => i.role) });
    // Writable vs read-only adapter modes observed via argv.
    const byRole = {};
    for (const inv of invocations) { (byRole[inv.role] = byRole[inv.role] || []).push(inv); }
    const writableOk = (byRole.planner || []).every(e => e.args.includes("--force")) && (byRole.implementer || []).every(e => e.args.includes("--force"));
    const readonlyOk = (byRole.plan_reviewer || []).every(e => e.args.includes("--read-only")) && (byRole.code_reviewer || []).every(e => e.args.includes("--read-only")) && (byRole.verifier || []).every(e => e.args.includes("--read-only"));
    check("writable adapter mode: planner+implementer invoked with write args (-p --force)", (byRole.planner || []).length > 0 && (byRole.implementer || []).length > 0 && writableOk, byRole);
    check("read-only adapter mode: reviewers+verifier invoked with read-only args (-p --read-only)", (byRole.plan_reviewer || []).length > 0 && (byRole.code_reviewer || []).length > 0 && (byRole.verifier || []).length > 0 && readonlyOk, byRole);
    // Hermetic proof that no outside CLI answered: the pre-mission where.exe
    // sweep already proved nothing outside binDir resolves, and the single
    // shared-adapter probe plus per-role argv checks above prove every real
    // invocation went through the fixture binary in its expected mode. The
    // invocation log must contain ONLY the five expected roles, each with
    // the manifest argv for its mode — any foreign binary or unexpected
    // role would appear here.
    check("all logged invocations are the expected fixture roles with manifest argv", invocations.length > 0 && invocations.every(e => ["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"].includes(e.role) && Array.isArray(e.args) && e.args.includes("-p") && (e.args.includes("--force") !== e.args.includes("--read-only"))), invocations);

    // --- Planning created valid SpecKit artifacts ---
    const featureDir = path.join(repo, "specs", FEATURE_SLUG);
    const specFile = path.join(featureDir, "spec.md");
    const planFile = path.join(featureDir, "plan.md");
    const tasksFile = path.join(featureDir, "tasks.md");
    const featureJsonPath = path.join(repo, ".specify", "feature.json");
    check("planning created specs/<feature>/spec.md", fs.existsSync(specFile) && fs.readFileSync(specFile, "utf8").includes("Windows full workflow feature"), fs.existsSync(specFile) ? fs.readFileSync(specFile, "utf8").slice(0, 300) : null);
    check("planning created specs/<feature>/plan.md", fs.existsSync(planFile), null);
    check("planning created specs/<feature>/research.md + data-model.md + quickstart.md + contracts/", fs.existsSync(path.join(featureDir, "research.md")) && fs.existsSync(path.join(featureDir, "data-model.md")) && fs.existsSync(path.join(featureDir, "quickstart.md")) && fs.existsSync(path.join(featureDir, "contracts", "health.md")));
    check("planning created specs/<feature>/tasks.md with exactly one unchecked-then-checked task", fs.existsSync(tasksFile), null);
    let featureJsonOk = false;
    try {
      const fj = JSON.parse(fs.readFileSync(featureJsonPath, "utf8"));
      featureJsonOk = fj.feature_directory === `specs/${FEATURE_SLUG}` && Object.keys(fj).length === 1;
    } catch {}
    check("planning wrote exact .specify/feature.json schema (single feature_directory field)", featureJsonOk, fs.existsSync(featureJsonPath) ? fs.readFileSync(featureJsonPath, "utf8") : null);
    check("planning touched exactly one NEW feature directory", (() => { try { const dirs = fs.readdirSync(path.join(repo, "specs")).filter(d => fs.statSync(path.join(repo, "specs", d)).isDirectory()); return dirs.length === 1 && dirs[0] === FEATURE_SLUG; } catch { return false; } })(), (() => { try { return fs.readdirSync(path.join(repo, "specs")); } catch { return null; } })());

    // --- No Playwright requirement (fixture requests none) ---
    const tasksRawFinal = fs.existsSync(tasksFile) ? fs.readFileSync(tasksFile, "utf8") : "";
    check("fixture requests no browser verification (no autopilot-requires: browser annotation)", !/autopilot-requires:\s*browser/i.test(tasksRawFinal), tasksRawFinal.slice(0, 500));
    check("fixture has empty gates.commands (no browser gate command)", (() => { try { return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "config.json"), "utf8")).gates.commands.length === 0; } catch { return false; } })());
    // No browser work was requested and none was required: the mission
    // succeeded end to end (exit 0 + ALL WORK COMPLETE, asserted below) with
    // empty gates.commands and no browser annotation, so no Playwright
    // install/launch could have been on the critical path. Fail on any
    // Playwright/browser error signal in the mission output.
    check("mission completed with no Playwright/browser error signal", !/playwright/i.test(combined) && !/browser.*(not found|missing|required|failed|unavailable)/i.test(combined), combined.slice(-1500));

    // --- Observed role ordering via result.json seq ---
    const results = sortBySeq(readAllResults(repo));
    const roles = results.map(r => r.data.role);
    const planners = results.filter(r => r.data.role === "planner");
    const planReviewers = results.filter(r => r.data.role === "plan_reviewer");
    const implementers = results.filter(r => r.data.role === "implementer");
    const codeReviewers = results.filter(r => r.data.role === "code_reviewer");
    const verifiers = results.filter(r => r.data.role === "verifier");
    check("planning ran (at least 3 planner calls for specify/plan/tasks)", planners.length >= 3, roles);
    check("plan review ran (at least 3 plan_reviewer gates)", planReviewers.length >= 3, roles);
    check("all plan_reviewer gates PASSED", planReviewers.length > 0 && planReviewers.every(r => r.data.status === "completed" && r.data.verdict?.decision === "PASS"), planReviewers.map(r => r.data.verdict));
    check("implementation ran (at least 2 implementer attempts for the repair loop)", implementers.length === 2, { count: implementers.length, roles });
    // Phase code reviews: first FAIL, second PASS, plus final PASS.
    check("code review ran (2 phase attempts + 1 final)", codeReviewers.length === 3, { count: codeReviewers.length, roles });
    const seqIdx = e => results.indexOf(e);
    if (codeReviewers.length >= 2 && implementers.length >= 2) {
      check("failure-loop ordering: implementer(1) -> code_reviewer(1,FAIL) -> implementer(2) -> code_reviewer(2,PASS)",
        seqIdx(implementers[0]) < seqIdx(codeReviewers[0]) && seqIdx(codeReviewers[0]) < seqIdx(implementers[1]) && seqIdx(implementers[1]) < seqIdx(codeReviewers[1]),
        { impl: implementers.map(seqIdx), cr: codeReviewers.map(seqIdx) });
      check("first phase code review FAILed on observed attempt-1 bytes", codeReviewers[0].data.verdict?.decision === "FAIL", codeReviewers[0].data.verdict);
      check("second phase code review PASSED on observed attempt-2 bytes", codeReviewers[1].data.status === "completed" && codeReviewers[1].data.verdict?.decision === "PASS", codeReviewers[1].data.verdict);
    }
    check("verification ran exactly once (only after the PASS, never for the failed attempt)", verifiers.length === 1, { count: verifiers.length, roles });
    if (verifiers.length === 1 && codeReviewers.length >= 2) {
      check("verification starts only after Code Review PASS (seq ordering)", seqIdx(verifiers[0]) > seqIdx(codeReviewers[1]), { v: seqIdx(verifiers[0]), crPass: seqIdx(codeReviewers[1]) });
      check("verifier PASSED", verifiers[0].data.status === "completed" && verifiers[0].data.verdict?.decision === "PASS", verifiers[0].data.verdict);
    }
    if (planners.length > 0 && planReviewers.length > 0 && implementers.length > 0) {
      const lastPlanPass = planReviewers[planReviewers.length - 1];
      check("implementation starts only after Plan Review PASS (last gate PASS before first implementer)", seqIdx(lastPlanPass) < seqIdx(implementers[0]), { gate: seqIdx(lastPlanPass), impl: seqIdx(implementers[0]) });
      check("plan review runs after planning (first planner before first gate)", seqIdx(planners[0]) < seqIdx(planReviewers[0]), { planner: seqIdx(planners[0]), gate: seqIdx(planReviewers[0]) });
    }
    if (codeReviewers.length >= 3 && verifiers.length === 1) {
      const finalCR = codeReviewers[codeReviewers.length - 1];
      check("final repository code review runs after Verification PASS", seqIdx(verifiers[0]) < seqIdx(finalCR), { v: seqIdx(verifiers[0]), fin: seqIdx(finalCR) });
      check("final review PASSED", finalCR.data.status === "completed" && finalCR.data.verdict?.decision === "PASS", finalCR.data.verdict);
    }

    // --- Task 14 checkbox rules: only after Verification PASS ---
    const phaseCRProbes = codeReviewers.slice(0, 2).map(r => extractProbe(r.data));
    const verifierProbe = verifiers.length ? extractProbe(verifiers[0].data) : null;
    check("phase code reviewers both observed the task UNCHECKED (premature poison neutralized before review)", phaseCRProbes.length === 2 && phaseCRProbes.every(p => !!p && /- \[ \] /.test(p.tasksRaw || "")), phaseCRProbes.map(p => p?.tasksRaw?.slice(0, 200)));
    check("verifier observed the task UNCHECKED (marking happens only after its own PASS)", !!verifierProbe && /- \[ \] /.test(verifierProbe.tasksRaw || ""), verifierProbe?.tasksRaw?.slice(0, 300));
    check("after Verification PASS, Autopilot alone marked the task [x]", tasksRawFinal.includes(`- [x] ${TASK_TEXT}`) && !/- \[ \] /.test(tasksRawFinal), tasksRawFinal.slice(0, 500));
    const state = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
    check("mission state reaches phase=complete", state.phase === "complete", state);
    check("mission completion requires step=human_commit", state.step === "human_commit", state);
    check("mission finishes with HUMAN COMMIT REQUIRED", result.status === 0 && /ALL WORK COMPLETE/.test(combined) && /HUMAN COMMIT REQUIRED/.test(combined), { status: result.status, tail: combined.slice(-800) });

    // --- Per-role disposable isolation ---
    const officialReal = fs.realpathSync(repo);
    function checkReviewerIsolation(label, runEntry) {
      const d = runEntry.data;
      const probe = extractProbe(d);
      if (!check(`${label}: probe recovered`, !!probe, d)) return;
      const cwdIsDisposable = typeof probe.cwd === "string" && probe.cwd.length > 0 && !isInsideOfficial(probe.cwd, officialReal);
      check(`${label}: cwd is a disposable copy (not the official repo)`, cwdIsDisposable, probe.cwd);
      check(`${label}: REPOSITORY equals the disposable cwd`, probe.repositoryFromPrompt === probe.cwd, probe);
      check(`${label}: PWD/INIT_CWD point at the disposable copy`, probe.pwdEnv === probe.cwd && probe.initCwdEnv === probe.cwd, { pwd: probe.pwdEnv, init: probe.initCwdEnv, cwd: probe.cwd });
      check(`${label}: safe.directory points at the disposable copy`, probe.safeDirectoryValueEnv === probe.cwd, probe);
      check(`${label}: stable scratch signal guardLog is absolute <scratch>/git-guard/blocked.log`, typeof probe.guardLog === "string" && path.isAbsolute(probe.guardLog) && path.basename(probe.guardLog) === "blocked.log" && path.basename(path.dirname(probe.guardLog)) === "git-guard", probe.guardLog);
      check(`${label}: no .git metadata in the disposable copy`, probe.gitDirExists === false && Array.isArray(probe.topLevelEntries) && !probe.topLevelEntries.includes(".git"), probe.topLevelEntries);
      check(`${label}: ignored file absent from the disposable copy`, probe.ignoredExists === false, probe);
      check(`${label}: relative write SUCCEEDED inside the disposable copy`, probe.relativeWrite === "SUCCEEDED", probe);
      if ("relativeOverwrite" in probe) check(`${label}: relative OVERWRITE SUCCEEDED inside the disposable copy`, probe.relativeOverwrite === "SUCCEEDED", probe);
      check(`${label}: scratch write SUCCEEDED`, probe.scratchWrite === "SUCCEEDED", probe);
      check(`${label}: no official-repo mutation observed by the relay`, d.treeChanged === false && d.readOnlyViolation === false && d.commitDetected === false && d.policyViolation === null, { treeChanged: d.treeChanged, ro: d.readOnlyViolation, commit: d.commitDetected, policy: d.policyViolation });
      check(`${label}: truthful compatibility metadata (windows-disposable-copy/compatibility, no envelope)`, d.executionPlaneSafety?.mechanism === "windows-disposable-copy" && d.executionPlaneSafety?.strength === "compatibility" && d.executionPlaneSafety?.envelopeApplied === false && d.executionPlaneSafety?.officialRepositoryUsedAsCwd === false && d.executionPlaneSafety?.scratchRetained === false, d.executionPlaneSafety);
      check(`${label}: disposable scratch deleted afterward`, typeof d.scratchDir === "string" && !fs.existsSync(d.scratchDir), d.scratchDir);
      if (typeof d.scratchDir === "string") check(`${label}: disposable workspace root deleted afterward`, !fs.existsSync(path.dirname(d.scratchDir)), path.dirname(d.scratchDir));
      if (probe.workspaceRoot) check(`${label}: probe workspaceRoot no longer exists`, !fs.existsSync(probe.workspaceRoot), probe.workspaceRoot);
      check(`${label}: probe cwd no longer exists`, !fs.existsSync(probe.cwd), probe.cwd);
    }
    if (planReviewers.length > 0) {
      // Prove the LAST gate saw the complete planning state (spec+tasks).
      const lastProbe = extractProbe(planReviewers[planReviewers.length - 1].data);
      check("plan reviewer received current expected project state (modified tracked bytes visible)", lastProbe?.trackedContent === "modified-tracked-content\n", lastProbe);
      check("plan reviewer received untracked non-ignored file", lastProbe?.untrackedContent === "untracked-content\n", lastProbe);
      checkReviewerIsolation("plan reviewer", planReviewers[planReviewers.length - 1]);
    }
    if (codeReviewers.length >= 2) {
      const secondProbe = extractProbe(codeReviewers[1].data);
      check("code reviewer received current expected project state (implementer attempt-2 bytes)", secondProbe?.implContent === "implementer-attempt-2\n", secondProbe);
      checkReviewerIsolation("code reviewer", codeReviewers[1]);
    }
    if (verifiers.length === 1) {
      check("verifier received current expected project state (implementer attempt-2 bytes + tracked + untracked)", verifierProbe?.implContent === "implementer-attempt-2\n" && verifierProbe?.trackedContent === "modified-tracked-content\n" && verifierProbe?.untrackedContent === "untracked-content\n", verifierProbe);
      checkReviewerIsolation("verifier", verifiers[0]);
    }

    // --- Official repo: authorized output present, reviewer writes absent ---
    check("authorized Implementer output preserved in the official repo (final attempt bytes)", fs.existsSync(path.join(repo, "implementer-output.txt")) && fs.readFileSync(path.join(repo, "implementer-output.txt"), "utf8") === "implementer-attempt-2\n", fs.existsSync(path.join(repo, "implementer-output.txt")) ? fs.readFileSync(path.join(repo, "implementer-output.txt"), "utf8") : null);
    check("official repo: no plan-reviewer-relative-write.txt", !fs.existsSync(path.join(repo, "plan-reviewer-relative-write.txt")));
    check("official repo: no code-reviewer-relative-write.txt", !fs.existsSync(path.join(repo, "code-reviewer-relative-write.txt")));
    check("official repo: no verifier-relative-write.txt", !fs.existsSync(path.join(repo, "verifier-relative-write.txt")));
    check("official repo: implementer-output was NOT overwritten by the verifier (still attempt-2)", fs.readFileSync(path.join(repo, "implementer-output.txt"), "utf8") === "implementer-attempt-2\n");
    check("official repo reviewer writes = ZERO", !fs.existsSync(path.join(repo, "plan-reviewer-relative-write.txt")) && !fs.existsSync(path.join(repo, "code-reviewer-relative-write.txt")) && !fs.existsSync(path.join(repo, "verifier-relative-write.txt")));

    // --- Autopilot never commits or pushes ---
    const headAfter = git(repo, ["rev-parse", "HEAD"]);
    check("Autopilot does not commit (HEAD unchanged)", headBefore === headAfter, { before: headBefore, after: headAfter });
    check("no autopilot commit message in log", !/autopilot/i.test(git(repo, ["log", "--oneline", "-5"])), git(repo, ["log", "--oneline", "-5"]));
    const allHaveNoGitMutation = results.every(r => r.data.policyViolation === null && r.data.commitDetected === false);
    check("no relay reported a git policy violation or commit", allHaveNoGitMutation, results.filter(r => r.data.policyViolation !== null || r.data.commitDetected !== false).map(r => ({ role: r.data.role, policy: r.data.policyViolation, commit: r.data.commitDetected })));

    // --- Canonical production files untouched ---
    check("canonical scripts/autopilot.mjs byte-identical (SHA256 before===after)", sha256File(CANONICAL_AUTOPILOT) === canonicalHashBefore);
    check("canonical bin/ap.cjs byte-identical (SHA256 before===after)", sha256File(CANONICAL_AP) === apHashBefore);
  } finally {
    cleanup(...owned);
  }

  // Explicit owned-path verification: every temporary repository/bin path
  // this test created must be absent after cleanup (fail closed — existence
  // is a leak even if the prefix sweep somehow misses it).
  check("owned fixture repository removed after cleanup", !fs.existsSync(repo), repo);
  check("owned fixture bin directory removed after cleanup", !fs.existsSync(binDir), binDir);

  let leaked = null;
  let leakError = null;
  try {
    leaked = listLeakedTemp(leakPrefixes).filter(p => ![...preExisting].includes(p));
  } catch (e) {
    leakError = String((e && e.message) || e);
  }
  check("temporary workspace enumeration succeeded (no silent empty-list on failure)", leakError === null, leakError);
  if (leakError === null) check("temporary workspace cleanup (no owned fixture remains)", leaked.length === 0, leaked);

  const survivorCheck = spawnSync("powershell", ["-NoProfile", "-Command",
    `(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*windows-full-workflow-adapter.mjs*' -or $_.CommandLine -like '*ap-win-full-bin-*' } | Measure-Object).Count`
  ], { encoding: "utf8" });
  const survivorText = String(survivorCheck.stdout || "").trim();
  const survivorValid = survivorCheck.status === 0 && /^\d+$/.test(survivorText);
  check("process-tree survivor query succeeded with strictly valid integer output", survivorValid, { status: survivorCheck.status, stdout: survivorText, stderr: String(survivorCheck.stderr || "").slice(0, 500) });
  if (survivorValid) check("process-tree cleanup (no surviving adapter descendant)", Number(survivorText) === 0, { survivors: survivorText });

  const elapsed = ((Date.now() - overallStart) / 1000).toFixed(1);
  console.log(`\n(total runtime: ${elapsed}s)`);
  if (failures) {
    console.error(`\n${failures} windows full-speckit-workflow check(s) failed.`);
    process.exit(1);
  }
  console.log("\nwindows full-speckit-workflow PASS (planning -> plan-review PASS -> implementation w/ repair -> code-review PASS -> verification PASS -> human commit)");
}

await main();
