#!/usr/bin/env node
// 15.6J CORRECTION-2 (C) — Native Windows production-path regression: a
// trusted blocked official-repository mutation must fail the relay even when
// the child swallows the Git failure and exits 0.
//
// Drives the REAL production `node scripts/autopilot.mjs run --repo <repo>`
// subprocess against a minimal, disposable SpecKit fixture seeded directly
// at the tasks_ready implementation checkpoint (no Planner/Plan Reviewer
// involved — proven by absence below), using a hermetic Windows fake adapter
// (a .cmd trampoline around a Node script, the established
// test-windows-disposable-* convention — never an installed real agent CLI).
// The fake Implementer attempts an official-repository update-ref mutation
// with the REAL Git executable, receives the guard denial, deliberately
// swallows it, and exits 0. The mission must then:
//
//   - exit nonzero with GIT_MUTATION_BLOCKED;
//   - record status failed + policyViolation git_mutation_blocked on the
//     Implementer result despite the child exit code 0;
//   - preserve trusted official-scope hook evidence and child diagnostics;
//   - never launch Code Reviewer or Verifier (escalate relay_policy_violation);
//   - leave official HEAD, refs, files, and Git metadata unchanged.
//
// No production source is patched, copied, or instrumented, and no test-only
// hook exists in production. The mutation form (update-ref) is one already
// proven to trigger the existing guard on Git-for-Windows.
//
// Windows-only: the .cmd trampoline and disposable-copy workspace mechanics
// exercised here are themselves gated to process.platform === "win32" (suite
// precedent). No-op PASS elsewhere; WSL/Linux verdict coverage lives in
// test-relay-git-mutation-verdict.mjs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import {runWindowsProcessTreeBounded} from "./test-fixtures/windows-process-tree-runner.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");
const CANONICAL_AUTOPILOT = path.join(skillRoot, "scripts", "autopilot.mjs");

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  return false;
}

if (process.platform !== "win32") {
  console.log("SKIP: Native Windows relay-verdict coverage — not running on win32.");
  process.exit(0);
}

function git(cwd, args) {
  const r = spawnSync("git", args, {cwd, encoding: "utf8", stdio: "pipe", env: withoutOuterGitGuard(process.env), shell: false});
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout || "").trim();
}

function assertCleanRun(label, result) {
  return check(`${label}: process completed cleanly (no timeout, output overflow, or termination failure)`,
    !result.timedOut && !result.outputLimitExceeded && !result.terminationFailed,
    {timedOut: result.timedOut, outputLimitExceeded: result.outputLimitExceeded, terminationFailed: result.terminationFailed});
}

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

// Minimal SpecKit fixture seeded directly at the tasks_ready implementation
// checkpoint (same production state contract
// test-windows-disposable-code-reviewer.mjs seeds): the mission skips
// ensurePlanningReady() entirely and goes straight to Implementation.
function makeSpecKitRepo(prefix) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `ap-win-relayverdict-${prefix}-`));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "windows-relay-verdict@example.invalid"]);
  git(repo, ["config", "user.name", "Windows Relay Verdict Test"]);
  fs.writeFileSync(path.join(repo, "implementation.txt"), "not-yet-implemented\n");
  const workflowDir = path.join(repo, ".specify", "workflows", "speckit");
  fs.mkdirSync(workflowDir, {recursive: true});
  fs.writeFileSync(path.join(workflowDir, "workflow.yml"), WORKFLOW_YML);
  const featureDir = path.join(repo, "specs", "903-win-relay-verdict");
  fs.mkdirSync(featureDir, {recursive: true});
  fs.writeFileSync(path.join(repo, ".specify", "feature.json"), JSON.stringify({feature_directory: "specs/903-win-relay-verdict"}));
  fs.writeFileSync(path.join(featureDir, "spec.md"), "# Spec\n\nWindows relay verdict fixture feature.\n");
  fs.writeFileSync(path.join(featureDir, "plan.md"), "# Plan\n\nWindows relay verdict fixture plan.\n");
  fs.writeFileSync(path.join(featureDir, "tasks.md"), "## Phase 1: Do the windows relay verdict task\n\n- [ ] Do the windows relay verdict task\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init: speckit fixture at the implementation checkpoint"]);
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
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
      taskFiles: [path.join(featureDir, "tasks.md")],
      requiresValidation: true, confidence: "high",
      reason: "spec, plan, and tasks artifacts detected"
    },
    sessions: {},
    planningStateReview: {status: "passed", framework: "speckit", phase: null, at: new Date().toISOString()}
  }, null, 2));
  return {repo, featureDir};
}

function writeSpecKitConfig(repo) {
  const config = {
    schema_version: "3.0",
    project: {repo: ".", planning_framework: "speckit", state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs"},
    roles: Object.fromEntries(["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"].map((role) => [
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

// Hermetic fake "cursor" adapter: .cmd trampoline around a Node script (the
// established Windows convention). Deliberately implements ONLY the
// implementer role: the seeded mission must die on the policy violation
// before any other role launches, so any other ROLE value falls through to
// the unknown-role branch and exits 1 (fail loud, never silently succeed).
//
// The implementer attempts an official-repository update-ref mutation with
// the REAL Git executable (resolved from PATH inside the relay launch —
// the guard hooks fire for update-ref on Git-for-Windows, as proven by the
// 15.6I/15.6J Windows runs), echoes the denial for diagnostics, swallows it,
// and deliberately exits 0.
const ADAPTER_SCRIPT = `
import fs from "node:fs";
import {spawnSync} from "node:child_process";
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
  console.log("fake-windows-relay-verdict-agent 1.0.0");
  process.exit(0);
}
const PROMPT = await readStdin();
const firstLine = PROMPT.split(/\\r?\\n/, 1)[0] || "";
const role = firstLine.startsWith("ROLE=") ? firstLine.slice("ROLE=".length) : "";
if (role === "implementer") {
  let denial = "";
  try {
    const r = spawnSync("git", ["update-ref", "refs/heads/evil-156j-win", "HEAD"], {encoding: "utf8", env: withoutOuterGitGuard(process.env), shell: false});
    denial = ((r.stdout || "") + "\\n" + (r.stderr || "")).trim();
  } catch (e) {
    denial = String((e && e.message) || e);
  }
    if (denial) console.log(denial);
    console.log("implementer ok");
    // TASK-19 Phase 4 (task 12): per-task Implementer invocation sentinel.
    console.log("AUTOPILOT_TASK_RESULT=" + JSON.stringify({summary: "implementer ok", taskLocalCheck: {command: "true", status: "passed", exitCode: 0, summary: "fixture"}}));
    process.exit(0);
  }
console.error("fake-windows-adapter: unknown ROLE '" + role + "'");
process.exit(1);
`;

function makeBin(prefix) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), `ap-win-relayverdict-bin-${prefix}-`));
  const scriptPath = path.join(binDir, "windows-relay-verdict-adapter.mjs");
  fs.writeFileSync(scriptPath, ADAPTER_SCRIPT);
  fs.writeFileSync(path.join(binDir, "cursor-agent.cmd"), `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\nexit /b %errorlevel%\r\n`);
  return binDir;
}

function systemRootDir() {
  return process.env.SystemRoot || process.env.windir || "C:\\Windows";
}

// Hermetic mission PATH (CORRECTION-3 C): exactly the fake-adapter bin dir,
// the real-Git directory, and Windows system entries — never the machine's
// original PATH, so no installed agent CLI can be discovered. Shape mirrors
// test-preflight-deduplication.mjs's hermeticFixturePath() (fixture bin +
// System32 + system root, which cannot supply an agent CLI) plus the
// directories this mission genuinely needs (real Git for the mutation
// probe; the guard hooks resolve it through this same PATH).
//
// TASK 16.3B correction: `git.exe`'s own directory alone is not enough. On
// a real Git for Windows install, `git.exe` (found via `where git.exe`, and
// on this exact layout resolving to "<root>\mingw64\bin\git.exe") can
// locate a dashed subcommand like `git submodule` via its own internal
// exec-path knowledge, but that subcommand is itself a POSIX shell script
// requiring `sh.exe` — which lives in a SIBLING directory
// ("<root>\bin\sh.exe" or "<root>\usr\bin\sh.exe"), never inside
// "mingw64\bin" alongside git.exe itself. Without that directory on PATH,
// git reports the exact real symptom this task reproduced verbatim:
// "fatal: 'submodule' appears to be a git command, but we were not able to
// execute it. Maybe git-submodule is broken?" — not a broken Git install,
// just an incomplete hermetic PATH. sh.exe's directory is derived the same
// hermetic way gitDir already is (from the real, resolved git.exe path —
// never the machine's ambient PATH beyond that one resolution), so a
// machine without Git for Windows at all still correctly resolves nothing
// extra here (shDir stays null, silently omitted) rather than guessing a
// path that doesn't exist.
function missionPath(binDir, gitDir, shDir) {
  const root = systemRootDir();
  return [binDir, gitDir, shDir, path.join(root, "System32"), root].filter(Boolean).join(";");
}

function resolveGitDir() {
  const whereExe = path.join(systemRootDir(), "System32", "where.exe");
  const probe = spawnSync(whereExe, ["git.exe"], {encoding: "utf8", shell: false});
  if (probe.status !== 0) return null;
  const first = (probe.stdout || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0];
  return first ? path.dirname(first) : null;
}

// Given gitDir (observed as either "<root>\mingw64\bin" or "<root>\cmd",
// depending on which git.exe a real install's PATH resolves first), the
// Git for Windows installation root is one level up from "<root>\cmd" but
// two levels up from "<root>\mingw64\bin" — both candidate roots are
// checked (never assuming a single fixed layout) for whichever sibling
// "bin" directory actually contains sh.exe (the interpreter git's own
// scripted dashed subcommands, e.g. git-submodule, require): "<root>\bin"
// (the layout every modern Git for Windows installer produces) or
// "<root>\usr\bin" (older/alternate layouts). Returns null (never a
// guessed, non-existent path) when none of these exist, e.g. gitDir did not
// come from a real Git for Windows tree.
function resolveGitShDir(gitDir) {
  if (!gitDir) return null;
  const roots = [path.dirname(gitDir), path.dirname(path.dirname(gitDir))];
  for (const root of roots) {
    for (const candidate of [path.join(root, "bin"), path.join(root, "usr", "bin")]) {
      if (fs.existsSync(path.join(candidate, "sh.exe"))) return candidate;
    }
  }
  return null;
}

function missionEnv(binDir, gitDir) {
  return {...withoutOuterGitGuard({...process.env}), PATH: missionPath(binDir, gitDir, resolveGitShDir(gitDir))};
}

// Fail-closed strict cleanup shared by every owned directory: each removal
// is attempted even if an earlier one failed; every removal error is
// recorded as a test failure (never swallowed); absence is asserted after.
function strictCleanup(label, ...dirs) {
  for (const dir of dirs) {
    if (!dir) { check(`${label}: cleanup target present`, false, "null"); continue; }
    try {
      fs.rmSync(dir, {recursive: true, force: true});
    } catch (error) {
      check(`${label}: cleanup succeeded`, false, `${dir}: ${error?.message || error}`);
    }
  }
  for (const dir of dirs) {
    if (!dir) continue;
    check(`${label}: owned directory removed`, !fs.existsSync(dir), dir);
  }
}

function runMission(repo, env, {timeoutMs}) {
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
  return files.map((file) => ({file, data: JSON.parse(fs.readFileSync(file, "utf8"))}));
}

function listLeakedTemp(prefix) {
  return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(prefix)).map((name) => path.join(os.tmpdir(), name));
}

async function main() {
  const overallStart = Date.now();
  const leakPrefixes = ["ap-win-relayverdict-", "autopilot-reviewer-"];
  const preExisting = new Set(leakPrefixes.flatMap(listLeakedTemp));
  // CORRECTION-3 A/B: no early returns anywhere below — every check records
  // into `failures`, and the outer finally + trailing gates always run, so
  // any timeout, missing state, missing result, or missing Implementer
  // result still reaches cleanup, leak detection, survivor detection, and
  // the final nonzero exit.
  let sharedBinDir = null;
  let repo = null;
  try {
    sharedBinDir = makeBin("shared");
    const cmdPath = path.join(sharedBinDir, "cursor-agent.cmd");
    const gitDir = resolveGitDir();
    check("real Git directory resolves before the mission", typeof gitDir === "string" && gitDir.length > 0, gitDir);
    const env = gitDir ? missionEnv(sharedBinDir, gitDir) : {...withoutOuterGitGuard({...process.env})};
    const whereExe = path.join(systemRootDir(), "System32", "where.exe");

    // Hermetic-PATH behavioral probes under the EXACT mission environment
    // (CORRECTION-3 C): the fixture resolves and nothing installed does.
    const whereAgent = spawnSync(whereExe, ["cursor-agent"], {cwd: os.tmpdir(), encoding: "utf8", env, shell: false, timeout: 60000});
    const agentHits = (whereAgent.stdout || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    check("cursor-agent resolves only to the test fixture",
      whereAgent.status === 0 && agentHits.length === 1 && agentHits[0].toLowerCase() === cmdPath.toLowerCase(),
      whereAgent.stdout);
    for (const name of ["claude", "codex", "opencode", "agy"]) {
      const probe = spawnSync(whereExe, [name], {cwd: os.tmpdir(), encoding: "utf8", env, shell: false, timeout: 60000});
      check(`installed agent CLI does not resolve: ${name}`, probe.status !== 0, probe.stdout);
    }
    const adapterProbe = spawnSync("cmd.exe", ["/d", "/s", "/c", cmdPath, "--version"], {encoding: "utf8", env, shell: false, timeout: 60000});
    check("fake adapter responds to --version under the mission environment", adapterProbe.status === 0, adapterProbe.status);
    const gitProbe = spawnSync("git", ["--version"], {cwd: os.tmpdir(), encoding: "utf8", env, shell: false, timeout: 60000});
    check("real Git remains available under the mission environment", gitProbe.status === 0, gitProbe.status);

    repo = makeSpecKitRepo("denied").repo;
    writeSpecKitConfig(repo);
    const headBefore = git(repo, ["rev-parse", "HEAD"]);
    const refsBefore = git(repo, ["for-each-ref", "--format=%(refname)%00%(objectname)"]);
    const filesBefore = {
      implementation: fs.readFileSync(path.join(repo, "implementation.txt"), "utf8"),
      tasks: fs.readFileSync(path.join(repo, "specs", "903-win-relay-verdict", "tasks.md"), "utf8"),
    };

    const result = await runMission(repo, env, {timeoutMs: 150000});
    assertCleanRun("mission", result);
    const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`;

    // Top-level failure contract (CORRECTION-2 B).
    check("mission exits nonzero", result.status !== 0, {status: result.status});
    check("mission escalated via relay_policy_violation", /Relay policy violation/i.test(combinedOutput), combinedOutput.slice(-1500));
    let missionState = null;
    try { missionState = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8")); } catch {}
    check("mission state step is relay_policy_violation", missionState?.step === "relay_policy_violation",
      missionState ? `${missionState.phase}/${missionState.step}` : "no state.json");

    let results = [];
    try {
      results = readAllResults(repo);
    } catch (error) {
      check("result.json files readable", false, String(error?.message || error));
    }
    const roles = results.map((r) => r.data.role);
    check("exactly one implementer run recorded", results.filter((r) => r.data.role === "implementer").length === 1, roles);
    check("no planner or plan_reviewer result was created (seeded at the implementation checkpoint)",
      !roles.includes("planner") && !roles.includes("plan_reviewer"), roles);
    check("Code Reviewer never launched", !roles.includes("code_reviewer"), roles);
    check("Verifier never launched", !roles.includes("verifier"), roles);
    // No installed agent CLI was invoked: every recorded relay used the
    // fixture adapter name, never a real product binary.
    check("every relay invocation used only the fixture adapter binary",
      results.length > 0 && results.every((r) => {
        const cli = typeof r.data.cli === "string" ? r.data.cli.toLowerCase() : "";
        return cli.includes("cursor-agent") && !/claude|codex|opencode|\bagy\b/.test(cli);
      }),
      results.map((r) => r.data.cli));

    const impl = (results.find((r) => r.data.role === "implementer") || {}).data;
    check("implementer result.json produced", impl != null);
    if (impl) {
      // Windows child exit-zero mutation (CORRECTION-2 C).
      check("child process itself exited 0 (deliberate)", impl.process?.exitCode === 0, impl.process);
      check("relay verdict is failed despite exit 0", impl.status === "failed", impl.status);
      check("policyViolation is git_mutation_blocked", impl.policy?.violation === "git_mutation_blocked", impl.policy);
      check("failure class is GIT_MUTATION_BLOCKED", impl.failure?.class === "GIT_MUTATION_BLOCKED", impl.failure);
      const hookDenials = (impl.gitGuardEvents || []).filter((e) => e.hook === "reference-transaction");
      check("trusted official-scope hook evidence preserved", hookDenials.length > 0 && hookDenials.every((e) => e.scope === "official"),
        impl.gitGuardEvents);
      check("denial diagnostics visible in relay output", /AUTOPILOT GIT GUARD/.test(impl.finalMessage || ""),
        (impl.finalMessage || "").slice(-400));
    }

    // Repository untouched (CORRECTION-2 C).
    check("official HEAD unchanged", git(repo, ["rev-parse", "HEAD"]) === headBefore);
    check("official refs unchanged", git(repo, ["for-each-ref", "--format=%(refname)%00%(objectname)"]) === refsBefore);
    check("tracked implementation file unchanged",
      fs.readFileSync(path.join(repo, "implementation.txt"), "utf8") === filesBefore.implementation);
    check("tasks file unchanged (never marked, never launched past the violation)",
      fs.readFileSync(path.join(repo, "specs", "903-win-relay-verdict", "tasks.md"), "utf8") === filesBefore.tasks);
    check("no evil branch created", !git(repo, ["for-each-ref", "--format=%(refname)"]).split("\n").includes("refs/heads/evil-156j-win"));
  } finally {
    // CORRECTION-3 B: unconditional fail-closed cleanup of every owned
    // directory, even when the scenario above threw or recorded failures.
    strictCleanup("verdict-cleanup", repo, sharedBinDir);
  }

  const leakedFixtures = leakPrefixes.flatMap(listLeakedTemp).filter((p) => !preExisting.has(p));
  check("no leftover fixture/bin/disposable-reviewer-workspace temp directories remain (beyond what pre-existed this run)", leakedFixtures.length === 0, leakedFixtures);

  // CORRECTION-3 D: fail-closed survivor probe — every probe defect fails
  // the test; an unparseable/missing count never becomes zero.
  const survivorCheck = spawnSync("powershell", ["-NoProfile", "-Command",
    `(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*windows-relay-verdict-adapter.mjs*' -or $_.CommandLine -like '*ap-win-relayverdict-bin-*' } | Measure-Object).Count`
  ], {encoding: "utf8", timeout: 60000});
  check("survivor probe spawned", survivorCheck.error == null,
    survivorCheck.error ? String(survivorCheck.error) : undefined);
  check("survivor probe exited 0", survivorCheck.error == null && survivorCheck.status === 0 && survivorCheck.signal == null,
    {status: survivorCheck.status, signal: survivorCheck.signal, stderr: survivorCheck.stderr});
  const survivorText = (survivorCheck.stdout || "").trim();
  check("survivor probe stdout is exactly a valid non-negative integer", /^\d+$/.test(survivorText), survivorText);
  const survivorCount = /^\d+$/.test(survivorText) ? parseInt(survivorText, 10) : -1;
  check("no surviving cmd.exe/node.exe descendant of this test's fake adapter remains", survivorCount === 0, {survivorCount, stderr: survivorCheck.stderr});

  console.log(`\n(total runtime: ${((Date.now() - overallStart) / 1000).toFixed(1)}s)`);
  if (failures) {
    console.error(`\n${failures} windows relay-verdict check(s) failed.`);
    process.exit(1);
  }
  console.log("\nwindows relay git-mutation verdict PASS");
}

await main();
