#!/usr/bin/env node
// Per-adapter proof (correction pass on top of test-relay-session-continuity.mjs)
// that exact-session resume is constructed correctly for OpenCode and, most
// importantly, that Codex NEVER attempts to resume at all.
//
// Root cause for Codex, confirmed live against the real installed CLI
// (codex-cli 0.150.1, WSL2):
//   1. `codex exec resume` is a SIBLING subcommand of `exec`, not a flag
//      addable onto `exec`'s own arg list. Appending resume_session
//      (["exec","resume"]) after the base write/read_only args
//      (["exec","--json","--ephemeral","--sandbox","workspace-write"])
//      produces a malformed, duplicated invocation.
//   2. `codex exec resume --help` does not accept `--sandbox` at all:
//      `error: unexpected argument '--sandbox' found`.
//   3. Every codex invocation in this codebase carries `--ephemeral`
//      ("run without persisting session files to disk"), and a session
//      started with --ephemeral cannot be resumed by id — proven live:
//        $ codex exec --json --ephemeral ...        -> thread.started <id>
//        $ codex exec resume --json --ephemeral <id> ...
//        Error: thread/resume: thread/resume failed: no rollout found for
//        thread id <id> (code -32600)
//      Without --ephemeral, the identical resume DOES work (context carries
//      over) — the incompatibility is with --ephemeral specifically, not
//      with codex resume in general.
//   4. --ephemeral must not be removed (explicit constraint), so codex
//      resume is unsupported in this deployment: adapters/agents.json no
//      longer declares resume_session for codex, so buildRelayArgs's
//      generic `if(sid && a.resume_session?.length)` guard naturally never
//      fires for codex — every codex invocation starts fresh, with no
//      special-casing by adapter name anywhere in autopilot.mjs.
//
// Drives real `node scripts/autopilot.mjs run` subprocesses (same technique
// as test-relay-session-continuity.mjs) with fake "opencode" and "codex"
// binaries standing in for the real ones — both resolved directly via
// resolveAgentBinary() (no two-hop shim needed, unlike Claude).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  return false;
};

if (process.platform === "win32") {
  console.log("test-exact-resume-adapters: SKIP — requires Linux/WSL2 (bubblewrap) for read-only roles.");
  process.exit(0);
}

function git(cwd, args) {
  const r = spawnSync("git", args, {cwd, encoding: "utf8", stdio: "pipe", shell: false});
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout || "").trim();
}

function makeRepo(prefix) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `ap-exact-resume-${prefix}-`));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "exact-resume-test@example.invalid"]);
  git(repo, ["config", "user.name", "Exact Resume Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

function makeConfig(repo, adapter) {
  const role = {adapter, model: "", reasoning: "", variant: "", resume: true, model_source: "default", model_verified_at: null, capabilities_verified_at: null};
  const config = {
    schema_version: "3.0",
    project: {repo: ".", planning_framework: "standalone", state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs"},
    roles: {planner: role, plan_reviewer: role, implementer: role, code_reviewer: role, verifier: role},
    workflow: {
      specReview: true, planReview: true, analysisAfterTasks: true, implementationReview: true, finalReview: true,
      autoApproveSpec: false, autoApprovePlan: false, parallelIndependentTasks: false, gsdPlanningReview: false,
      relaySafety: {block_git_commit_push: true, verify_read_only_by_snapshot: true, capture_touched_files: true, persist_role_sessions: true}
    },
    gates: {commands: [], env_allowlist: [], require_reviewer: true, network_isolation: true},
    policy: {
      max_plan_revisions: 3, retry_delay_ms: 0, checkpoint_after_task: true, checkpoint_after_phase: true,
      require_human_commit: true, fail_closed_on_relay_violation: true,
      failure_budgets: {implementationFailureBudget: 5, verificationFailureBudget: 5, adapterRetryBudget: 5, infrastructureRetryBudget: 5}
    },
    safety: {allow_git_commit: false, allow_git_push: false, allow_destructive_operations: false},
    planning: {
      speckit: {workflow_file: ".specify/workflows/speckit/workflow.yml", task_candidates: [".specify/tasks.md", "specs/*/tasks.md", "specs/*/tasks/*.md"]},
      gsd: {phase_root: ".planning/phases", run_plan_verify: true, run_state_validate: true, write_summary_artifacts: true, write_verification_artifacts: true, write_uat_artifact: true, use_gsd_tools_when_available: false, parallelization: {enabled: false, plan_level: false, task_level: false, max_concurrent_agents: 1, min_plans_for_parallel: 99}, planning_review: {enabled: false, review_after_each_stage: true, stages: ["discuss", "research", "plan", "plan-check"], max_revisions: 3, read_only_reviewer: true}}
    },
    capabilities: {project_defaults: [], role_requirements: {}, safety_denied: [], legacy_text_inference: false, verification: {browser: "native", require_browser: "when-task-requires"}}
  };
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), JSON.stringify(config, null, 2));
}

function runMission(repo, binDir, {timeoutMs = 220000} = {}) {
  // Strip any outer mission/gate git guard: the nested mission installs its
  // own, and running every git call through both made it ~8x slower.
  const base = withoutOuterGitGuard({...process.env});
  const env = {...base, PATH: `${binDir}:${base.PATH || ""}`};
  return spawnSync(process.execPath, [path.join(skillRoot, "scripts", "autopilot.mjs"), "run", "add a fixture line to README.md", "--repo", repo], {
    cwd: repo, encoding: "utf8", env, timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"], shell: false
  });
}

function readAllResults(root) {
  const files = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "result.json") files.push({file: full, mtimeMs: fs.statSync(full).mtimeMs, data: JSON.parse(fs.readFileSync(full, "utf8"))});
    }
  })(root);
  return files.sort((a, b) => a.mtimeMs - b.mtimeMs).map(f => f.data);
}

function argsOf(result) {
  return result?.invocation?.args || result?.execution?.delivered || [];
}

// ===========================================================================
// OpenCode: after TASK-19 Phase 4 (task 12) the implementer retry is a FRESH
// per-task invocation — its recorded args must carry neither `--session`
// (opencode's declared resume_session) nor the blind `--continue` fallback.
// (The pre-task-12 "resumes by exact --session id" assertion is deliberately
// retired: TASK-8 requires every per-task invocation to be a fresh session.)
// ===========================================================================
const FAKE_OPENCODE = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("fake-opencode-exact-resume 1.0.0\\n"); process.exit(0); }

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => { stdin += c; });
process.stdin.on("end", () => {
  const roleLine = (stdin.trimStart().split(/\\r?\\n/, 1)[0] || "");
  const role = roleLine.startsWith("ROLE=") ? roleLine.slice("ROLE=".length) : "";
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
  const finish = (sessionId, text) => {
    emit({type: "step_start", sessionID: sessionId});
    emit({type: "text", sessionID: sessionId, part: {type: "text", text}});
    emit({type: "step_finish", sessionID: sessionId});
    process.exit(0);
  };

  if (role === "planner") {
    const planMatch = stdin.match(/Write the (?:narrative )?plan to exactly:\s*(.*)/);
    const tasksMatch = stdin.match(/Write the phased checklist to exactly:\s*(.*)/);
    const legacyM = !planMatch ? stdin.match(/Write the plan to exactly:\s*(.*)/) : null;
    const planPath = planMatch ? planMatch[1].trim() : legacyM ? legacyM[1].trim() : null;
    if (!planPath) { process.stderr.write("fake-opencode: no plan path in prompt\\n"); process.exit(1); }
    if (tasksMatch) {
      fs.writeFileSync(planPath, "# Plan\\n\\nObjective: add a fixture line to README.md\\n");
      fs.writeFileSync(tasksMatch[1].trim(), "## Phase 1: General\\n\\n- [ ] 1. Add a fixture line to README.md\\n");
    } else if (planMatch) {
      fs.writeFileSync(planPath, "# Plan\\n\\nObjective: add a fixture line to README.md\\n");
      fs.writeFileSync(planPath.replace(/PLAN\.md$/, "TASKS.md"), "## Phase 1: General\\n\\n- [ ] 1. Add a fixture line to README.md\\n");
    } else {
      fs.writeFileSync(planPath, "# Plan\\n\\n## Checklist\\n\\n- [ ] 1. Add a fixture line to README.md\\n\\nVerification: manual.\\n");
    }
    return finish("fake-opencode-planner-session", "Wrote the plan.");
  }
  if (role === "plan_reviewer") {
    const sentinel = "AUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: []});
    return finish("fake-opencode-reviewer-session", sentinel);
  }
  if (role === "implementer") {
    try { fs.appendFileSync("README.md", "implementer change\\n"); } catch {}
    const taskResult = "AUTOPILOT_TASK_RESULT=" + JSON.stringify({summary: "Added a fixture line to README.md.", taskLocalCheck: {command: "check", status: "passed", exitCode: 0, summary: "fixture check passed"}});
    return finish("fake-opencode-implementer-session", "Implemented the task.\\n" + taskResult);
  }
  if (role === "code_reviewer") {
    const isPhaseReview = stdin.includes("Review the whole phase");
    const isRetry = stdin.includes("FEEDBACK TO ADDRESS:");
    const decision = (isPhaseReview && !isRetry) ? "FAIL" : "PASS";
    const sentinel = "AUTOPILOT_REVIEW=" + JSON.stringify(decision === "FAIL"
      ? {decision, findings: ["fix the implementation"]}
      : {decision, findings: []});
    return finish("fake-opencode-code-reviewer-session", sentinel);
  }
  if (role === "verifier") {
    return finish("fake-opencode-verifier-session", "AUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: []}));
  }
  process.stderr.write("fake-opencode: unknown ROLE '" + role + "'\\n");
  process.exit(1);
});
`;

// ===========================================================================
// Codex: must NEVER emit any resume-shaped args, even though role.resume is
// true and a real thread_id gets captured every attempt — proving the fix
// starts fresh unconditionally rather than attempting (and breaking on) an
// exact resume that --ephemeral makes unreachable.
// ===========================================================================
const FAKE_CODEX = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("fake-codex-exact-resume 1.0.0\\n"); process.exit(0); }

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => { stdin += c; });
process.stdin.on("end", () => {
  const roleLine = (stdin.trimStart().split(/\\r?\\n/, 1)[0] || "");
  const role = roleLine.startsWith("ROLE=") ? roleLine.slice("ROLE=".length) : "";
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
  const finish = (threadId, text) => {
    emit({type: "thread.started", thread_id: threadId});
    emit({type: "turn.started"});
    emit({type: "item.completed", item: {id: "item_0", type: "agent_message", text}});
    emit({type: "turn.completed"});
    process.exit(0);
  };

  if (role === "planner") {
    const planMatch = stdin.match(/Write the (?:narrative )?plan to exactly:\s*(.*)/);
    const tasksMatch = stdin.match(/Write the phased checklist to exactly:\s*(.*)/);
    const legacyM = !planMatch ? stdin.match(/Write the plan to exactly:\s*(.*)/) : null;
    const planPath = planMatch ? planMatch[1].trim() : legacyM ? legacyM[1].trim() : null;
    if (!planPath) { process.stderr.write("fake-codex: no plan path in prompt\\n"); process.exit(1); }
    if (tasksMatch) {
      fs.writeFileSync(planPath, "# Plan\\n\\nObjective: add a fixture line to README.md\\n");
      fs.writeFileSync(tasksMatch[1].trim(), "## Phase 1: General\\n\\n- [ ] 1. Add a fixture line to README.md\\n");
    } else if (planMatch) {
      fs.writeFileSync(planPath, "# Plan\\n\\nObjective: add a fixture line to README.md\\n");
      fs.writeFileSync(planPath.replace(/PLAN\.md$/, "TASKS.md"), "## Phase 1: General\\n\\n- [ ] 1. Add a fixture line to README.md\\n");
    } else {
      fs.writeFileSync(planPath, "# Plan\\n\\n## Checklist\\n\\n- [ ] 1. Add a fixture line to README.md\\n\\nVerification: manual.\\n");
    }
    return finish("fake-codex-planner-thread", "Wrote the plan.");
  }
  if (role === "plan_reviewer") {
    const sentinel = "AUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: []});
    return finish("fake-codex-reviewer-thread", sentinel);
  }
  if (role === "implementer") {
    try { fs.appendFileSync("README.md", "implementer change\\n"); } catch {}
    const taskResult = "AUTOPILOT_TASK_RESULT=" + JSON.stringify({summary: "Added a fixture line to README.md.", taskLocalCheck: {command: "check", status: "passed", exitCode: 0, summary: "fixture check passed"}});
    return finish("fake-codex-implementer-thread", "Implemented the task.\\n" + taskResult);
  }
  if (role === "code_reviewer") {
    const isPhaseReview = stdin.includes("Review the whole phase");
    const isRetry = stdin.includes("FEEDBACK TO ADDRESS:");
    const decision = (isPhaseReview && !isRetry) ? "FAIL" : "PASS";
    const sentinel = "AUTOPILOT_REVIEW=" + JSON.stringify(decision === "FAIL"
      ? {decision, findings: ["fix the implementation"]}
      : {decision, findings: []});
    return finish("fake-codex-code-reviewer-thread", sentinel);
  }
  if (role === "verifier") {
    return finish("fake-codex-verifier-thread", "AUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: []}));
  }
  process.stderr.write("fake-codex: unknown ROLE '" + role + "'\\n");
  process.exit(1);
});
`;

function makeBin(binaryName, source) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), `ap-exact-resume-bin-${binaryName}-`));
  const target = path.join(binDir, binaryName);
  fs.writeFileSync(target, source);
  fs.chmodSync(target, 0o755);
  // codex declares a required runtime sibling (adapters/agents.json's
  // runtime_siblings: ["codex-code-mode-host"]) that execution-envelope.mjs
  // checks for next to the resolved binary before admitting the CLI at all
  // — real codex installs ship it; the fake fixture needs a placeholder.
  if (binaryName === "codex") fs.writeFileSync(path.join(binDir, "codex-code-mode-host"), "#!/usr/bin/env node\n");
  return binDir;
}

function runAdapterScenario(adapterName, binaryName, source) {
  const repo = makeRepo(adapterName);
  const binDir = makeBin(binaryName, source);
  try {
    makeConfig(repo, adapterName);
    const run = runMission(repo, binDir);
    const results = readAllResults(path.join(repo, ".autopilot"));
    const dump = () => ({status: run.status, timedOut: run.error?.code === "ETIMEDOUT", stdout: (run.stdout || "").slice(-2000), stderr: (run.stderr || "").slice(-2000)});

    const implRuns = results.filter(r => r.role === "implementer");
    const codeReviewerRuns = results.filter(r => r.role === "code_reviewer");
    if (!check(`${adapterName}: at least 2 implementer attempts recorded (a code_reviewer FAIL forced a retry)`, implRuns.length >= 2, {count: implRuns.length, decisions: codeReviewerRuns.map(r => r.verdict?.decision)})) {
      check(`${adapterName}: mission reached completion (exit 0)`, run.status === 0, dump());
      return;
    }

    if (adapterName === "opencode") {
      // TASK-19 Phase 4 (task 12): the implementer retry is a FRESH per-task
      // invocation, so it must carry neither `--session` nor `--continue`.
      const retryArgs = argsOf(implRuns[1]);
      check("opencode implementer attempt #2: fresh session — no --session in its recorded invocation args",
        !retryArgs.includes("--session"), retryArgs);
      check("opencode implementer attempt #2: fresh session — no --continue in its recorded invocation args",
        !retryArgs.includes("--continue"), retryArgs);
    }

    if (adapterName === "codex") {
      for (let i = 0; i < implRuns.length; i++) {
        const a = argsOf(implRuns[i]);
        check(`codex implementer attempt #${i + 1}: no "resume" token anywhere in its args (exact resume unsupported under --ephemeral)`,
          !a.includes("resume"), a);
        check(`codex implementer attempt #${i + 1}: no "--continue" (resume-last fallback) either`, !a.includes("--continue"), a);
        check(`codex implementer attempt #${i + 1}: still carries --ephemeral (never removed)`, a.includes("--ephemeral"), a);
      }
      // Every attempt is a fresh exec invocation: base args identical modulo
      // no resume flags ever appended, proving "start fresh" rather than a
      // silently-broken malformed resume attempt.
      check("codex: implementer attempt #1 and #2 have byte-identical base invocation shape (both fresh)",
        JSON.stringify(argsOf(implRuns[0])) === JSON.stringify(argsOf(implRuns[1])),
        {attempt1: argsOf(implRuns[0]), attempt2: argsOf(implRuns[1])});
    }

    check(`${adapterName}: mission reached completion (exit 0)`, run.status === 0, dump());
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(binDir, {recursive: true, force: true});
  }
}

runAdapterScenario("opencode", "opencode", FAKE_OPENCODE);
runAdapterScenario("codex", "codex", FAKE_CODEX);

// ===========================================================================
// Tampering: Implementer appends a new checkbox — must escalate.
// ===========================================================================
{
  const FAKE_TAMPER = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("fake-tamper 1.0.0\\n"); process.exit(0); }

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => { stdin += c; });
process.stdin.on("end", () => {
  const roleLine = (stdin.trimStart().split(/\\r?\\n/, 1)[0] || "");
  const role = roleLine.startsWith("ROLE=") ? roleLine.slice("ROLE=".length) : "";
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
  const finish = (sessionId, text) => {
    emit({type: "step_start", sessionID: sessionId});
    emit({type: "text", sessionID: sessionId, part: {type: "text", text}});
    emit({type: "step_finish", sessionID: sessionId});
    process.exit(0);
  };

  if (role === "planner") {
    const planMatch = stdin.match(/Write the (?:narrative )?plan to exactly:\\s*(.*)/);
    const tasksMatch = stdin.match(/Write the phased checklist to exactly:\\s*(.*)/);
    const planPath = planMatch ? planMatch[1].trim() : null;
    if (!planPath) { process.stderr.write("fake-tamper: no plan path\\n"); process.exit(1); }
    if (tasksMatch) {
      fs.writeFileSync(planPath, "# Plan\\n\\nObjective: add a fixture line to README.md\\n");
      fs.writeFileSync(tasksMatch[1].trim(), "## Phase 1: General\\n\\n- [ ] 1. Add a fixture line to README.md\\n");
    } else {
      fs.writeFileSync(planPath, "# Plan\\n\\n## Checklist\\n\\n- [ ] 1. Add a fixture line to README.md\\n\\nVerification: manual.\\n");
    }
    return finish("fake-tamper-planner", "Wrote the plan.");
  }
  if (role === "plan_reviewer") {
    return finish("fake-tamper-reviewer", "AUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: []}));
  }
  if (role === "implementer") {
    try { fs.appendFileSync("README.md", "implementer change\\n"); } catch {}
    // Tamper: append a new checkbox line to TASKS.md (find it in .autopilot/missions/)
    const repo = process.cwd();
    const missionDirs = fs.readdirSync(path.join(repo, ".autopilot", "missions")).filter(d => !d.startsWith("."));
    for (const md of missionDirs) {
      const tp = path.join(repo, ".autopilot", "missions", md, "TASKS.md");
      if (fs.existsSync(tp)) {
        fs.appendFileSync(tp, "- [ ] TAMPERED: unauthorized task\\n");
        break;
      }
    }
    return finish("fake-tamper-implementer", "Implemented the task.\\n" + "AUTOPILOT_TASK_RESULT=" + JSON.stringify({summary: "Tampered fixture implementation.", taskLocalCheck: {command: "check", status: "passed", exitCode: 0, summary: "fixture check passed"}}));
  }
  if (role === "code_reviewer") {
    const sentinel = "AUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: []});
    return finish("fake-tamper-code-reviewer", sentinel);
  }
  if (role === "verifier") {
    return finish("fake-tamper-verifier", "AUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: []}));
  }
  process.stderr.write("fake-tamper: unknown ROLE '" + role + "'\\n");
  process.exit(1);
});
`;
  const repo = makeRepo("tamper");
  const binDir = makeBin("opencode", FAKE_TAMPER);
  try {
    makeConfig(repo, "opencode");
    const run = runMission(repo, binDir);
    const stateFile = path.join(repo, ".autopilot", "state.json");
    const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : null;
    check("tamper: mission did NOT reach completion (escalated)",
      run.status !== 0 || (state && state.phase === "escalated"), {status: run.status, phase: state?.phase, step: state?.step});
    check("tamper: escalation reason is appended_task_tampering",
      state && state.step === "standalone_appended_task_tampering", {step: state?.step});
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(binDir, {recursive: true, force: true});
  }
}

if (failures) {
  console.error(`${failures} exact-resume-adapters check(s) failed.`);
  process.exit(1);
}
console.log("test-exact-resume-adapters: ALL CHECKS PASSED");
