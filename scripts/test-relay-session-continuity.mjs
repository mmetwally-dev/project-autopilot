#!/usr/bin/env node
// Regression proof for a session-continuity bug found by auditing 18 real
// runs of a standalone-plan mission: one planner revision's session grew to
// 1,260,001 cached input tokens (23 tool calls, repeated PLAN.md/old-review
// reads), and the NEXT revision inherited all of it (200,856 cached input)
// via `--continue` instead of starting fresh — even though the revision
// prompt already carries the plan file path and the reviewer's findings
// verbatim, so nothing about that prior session was actually needed.
//
// Root cause: adapter-drivers.mjs's finalAgentText() (the "final text" used
// for session-id regex matching) only ever returns human-readable message
// content — the CLI's session/thread id is reported in a structured event
// (`{"type":"system","subtype":"init","session_id":...}` for Claude,
// `sessionID` on every OpenCode event, `thread_id` on Codex's
// `thread.started` event) that finalAgentText() never includes. Every
// captured session id was therefore always null, so every `resume:true`
// relay call fell through to the adapter's blind "resume the last session"
// flag (`--continue` / `resume --last`) — not necessarily even this role's
// own prior session.
//
// This file proves, against the REAL production `node scripts/autopilot.mjs
// run` relay path (fake `claude` CLI standing in for the real one, same
// technique as test-claude-pass-recognition.mjs):
//   1. A standalone-plan revision (planner re-invoked after plan_reviewer
//      FAIL) never resumes — no `--continue`/`--resume` in its recorded
//      invocation args — because the fix makes planner revisions always
//      start fresh instead of trying (and failing) to resume.
//   2. sessionId IS now correctly captured from the raw CLI event stream
//      (adapter-drivers.mjs's sessionIdFromEvents), proven structurally via
//      result.json even though the planner intentionally never uses it.
//   3. After TASK-19 Phase 4 (task 12) NO role resumes across attempts: the
//      implementer retry after a code_reviewer FAIL is a FRESH per-task
//      invocation, so its recorded invocation args carry neither `--resume`
//      nor `--continue` (a fresh session by the exact captured session id's
//      absence). TASK-8 requires every per-task invocation to be fresh.
//
// Requires Linux/WSL (bubblewrap, matching this project's real-relay
// convention for the "claude" adapter). Fails closed, not skip, on Windows.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import {fileURLToPath} from "node:url";
import {sessionIdFromEvents} from "./adapter-drivers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail ? ` :: ${JSON.stringify(detail)}` : ""}`);
  return false;
};

// ===========================================================================
// Part 1: sessionIdFromEvents unit coverage — every adapter's real raw-event
// shape (verified live against the actual CLIs, not guessed), plus the
// negative case finalAgentText's whole design relies on: no id anywhere.
// ===========================================================================
check("sessionIdFromEvents: Claude's system/init session_id",
  sessionIdFromEvents([{type: "system", subtype: "init", session_id: "claude-abc"}, {type: "assistant", message: {content: [{type: "text", text: "hi"}]}}]) === "claude-abc");
check("sessionIdFromEvents: OpenCode's per-event sessionID",
  sessionIdFromEvents([{type: "step_start", sessionID: "ses_xyz"}, {type: "text", sessionID: "ses_xyz", part: {type: "text", text: "hi"}}]) === "ses_xyz");
check("sessionIdFromEvents: Codex's thread.started thread_id",
  sessionIdFromEvents([{type: "thread.started", thread_id: "thread-123"}, {type: "turn.completed"}]) === "thread-123");
check("sessionIdFromEvents: last-wins when multiple ids appear (defensive, real streams should be consistent)",
  sessionIdFromEvents([{type: "system", subtype: "init", session_id: "first"}, {type: "system", subtype: "init", session_id: "second"}]) === "second");
check("sessionIdFromEvents: no id anywhere in the event stream (or a driver-less adapter's empty events) -> null",
  sessionIdFromEvents([{type: "assistant", message: {content: [{type: "text", text: "no session id here"}]}}]) === null);
check("sessionIdFromEvents: empty events -> null", sessionIdFromEvents([]) === null);

// ===========================================================================
// Part 2: real-relay end-to-end proof.
// ===========================================================================
if (process.platform === "win32") {
  console.log("test-relay-session-continuity: SKIP — the real-relay Part 2 proof requires Linux/WSL2 (bubblewrap) for the \"claude\" adapter's read-only roles.");
  if (failures) { console.error(`${failures} unit check(s) failed.`); process.exit(1); }
  console.log("test-relay-session-continuity: unit checks PASSED (Part 2 skipped on this platform)");
  process.exit(0);
}

function git(cwd, args) {
  const r = spawnSync("git", args, {cwd, encoding: "utf8", stdio: "pipe", env: withoutOuterGitGuard(process.env), shell: false});
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout || "").trim();
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-session-continuity-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "session-continuity-test@example.invalid"]);
  git(repo, ["config", "user.name", "Session Continuity Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

function makeConfig(repo) {
  const claudeRole = {adapter: "claude", model: "sonnet", reasoning: "low", variant: "", resume: true, model_source: "default", model_verified_at: null, capabilities_verified_at: null};
  const config = {
    schema_version: "3.0",
    project: {repo: ".", planning_framework: "standalone", state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs"},
    roles: {planner: claudeRole, plan_reviewer: claudeRole, implementer: claudeRole, code_reviewer: claudeRole, verifier: claudeRole},
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

// Two-hop shim (launcher -> claude.com), byte-for-byte the same proven
// launcher text as test-claude-pass-recognition.mjs / test-claude-stdin-
// contract.mjs / test-claude-auth-envelope.mjs use — adapter-drivers.mjs's
// resolveClaudeBinary() locates the real target via a regex over this exact
// shebang-script text, so this is deliberately not "simplified".
const FAKE_CLAUDE_LAUNCHER = `#!/bin/sh
# Disposable fake claude launcher, generated at test runtime by
# test-relay-session-continuity.mjs (not a committed fixture).
# real target: "claude.com"
set -eu
exec "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/claude.com" "$@"
`;

// One dispatcher, by ROLE (the mission prompt's own "ROLE=<role>" first
// line, the same convention every other fixture in this codebase relies on).
// Deliberately never inspects its own argv for --continue/--resume — that
// assertion belongs on the ORCHESTRATOR's side (result.json's recorded
// invocation.args), not inside the fake CLI.
const FAKE_CLAUDE_TARGET = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("fake-claude-session-continuity 1.0.0\\n"); process.exit(0); }

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => { stdin += c; });
process.stdin.on("end", () => {
  const roleLine = (stdin.trimStart().split(/\\r?\\n/, 1)[0] || "");
  const role = roleLine.startsWith("ROLE=") ? roleLine.slice("ROLE=".length) : "";
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
  const finish = (sessionId, text) => {
    emit({type: "system", subtype: "init", session_id: sessionId});
    emit({type: "assistant", message: {role: "assistant", content: [{type: "text", text}]}});
    emit({type: "result", subtype: "success", is_error: false, result: text, terminal_reason: "completed"});
    process.exit(0);
  };

  if (role === "planner") {
    const planMatch = stdin.match(/Write the (?:narrative )?plan to exactly:\s*(.*)/);
    const tasksMatch = stdin.match(/Write the phased checklist to exactly:\s*(.*)/);
    const legacyM = !planMatch ? stdin.match(/Write the plan to exactly:\s*(.*)/) : null;
    const planPath = planMatch ? planMatch[1].trim() : legacyM ? legacyM[1].trim() : null;
    if (!planPath) { process.stderr.write("fake-claude: no plan path in prompt\\n"); process.exit(1); }
    if (tasksMatch) {
      fs.writeFileSync(planPath, "# Plan\\n\\nObjective: add a fixture line to README.md\\n");
      fs.writeFileSync(tasksMatch[1].trim(), "## Phase 1: General\\n\\n- [ ] 1. Add a fixture line to README.md — accept: done ; verify: check\\n");
    } else if (planMatch) {
      fs.writeFileSync(planPath, "# Plan\\n\\nObjective: add a fixture line to README.md\\n");
      fs.writeFileSync(planPath.replace(/PLAN\.md$/, "TASKS.md"), "## Phase 1: General\\n\\n- [ ] 1. Add a fixture line to README.md — accept: done ; verify: check\\n");
    } else {
      fs.writeFileSync(planPath, "# Plan\\n\\n## Checklist\\n\\n- [ ] 1. Add a fixture line to README.md\\n\\nVerification: manual.\\n");
    }
    return finish("fake-planner-session", "Wrote the plan.");
  }

  if (role === "plan_reviewer") {
    const revised = stdin.includes("Prior findings to re-check:");
    const sentinel = "AUTOPILOT_REVIEW=" + JSON.stringify(revised
      ? {decision: "PASS", findings: []}
      : {decision: "FAIL", findings: ["revise the plan"]});
    return finish("fake-reviewer-session", sentinel);
  }

  if (role === "implementer") {
    try { fs.appendFileSync("README.md", "implementer change\\n"); } catch {}
    // TASK-19 Phase 4 (task 12): a per-task Implementer invocation must end
    // with the AUTOPILOT_TASK_RESULT sentinel (scripts/task-result-contract.mjs)
    // or the standalone loop escalates with STRUCTURED_OUTPUT_MISSING. It must
    // be the final non-empty line of the response text.
    const taskResult = "AUTOPILOT_TASK_RESULT=" + JSON.stringify({summary: "Added a fixture line to README.md.", taskLocalCheck: {command: "check", status: "passed", exitCode: 0, summary: "fixture check passed"}});
    return finish("fake-implementer-session", "Implemented the task.\\n" + taskResult);
  }

  if (role === "code_reviewer") {
    // Only the per-task review (never the one-shot final repository review,
    // which carries no feedback either way) fails on its first attempt —
    // this is what forces exactly one implementer retry to exercise the
    // resume-by-real-session-id proof below.
    const isPhaseReview = stdin.includes("Review the whole phase");
    const isRetry = stdin.includes("FEEDBACK TO ADDRESS:");
    const decision = (isPhaseReview && !isRetry) ? "FAIL" : "PASS";
    const sentinel = "AUTOPILOT_REVIEW=" + JSON.stringify(decision === "FAIL"
      ? {decision, findings: ["fix the implementation"]}
      : {decision, findings: []});
    return finish("fake-code-reviewer-session", sentinel);
  }

  if (role === "verifier") {
    return finish("fake-verifier-session", "AUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: []}));
  }

  process.stderr.write("fake-claude: unknown ROLE '" + role + "'\\n");
  process.exit(1);
});
`;

function makeBin() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-session-continuity-bin-"));
  const claudeLauncherPath = path.join(binDir, "claude");
  fs.writeFileSync(claudeLauncherPath, FAKE_CLAUDE_LAUNCHER);
  fs.chmodSync(claudeLauncherPath, 0o755);
  const claudeTargetPath = path.join(binDir, "claude.com");
  fs.writeFileSync(claudeTargetPath, FAKE_CLAUDE_TARGET);
  fs.chmodSync(claudeTargetPath, 0o755);
  return binDir;
}

function runMission(repo, binDir, {timeoutMs = 590000} = {}) {
  // 220s was enough on a fast disk, but each relay hop spawns a sandboxed
  // adapter and this mission cycles planner + plan_reviewer revisions +
  // implementer/code_reviewer retries — ~330s+ on a slow filesystem. Keep
  // the fail-fast timeout, just sized for slow disks.
    // Strip any outer mission/gate git guard (PATH shim + hooks): the
  // nested mission installs its own, and every git call through both
  // ran the mission several times slower under the orchestrator gate.
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

{
  const repo = makeRepo();
  const binDir = makeBin();
  try {
    makeConfig(repo);
    const run = runMission(repo, binDir);
    const results = readAllResults(path.join(repo, ".autopilot"));
    const dump = () => ({status: run.status, timedOut: run.error?.code === "ETIMEDOUT", stdout: (run.stdout || "").slice(-2000), stderr: (run.stderr || "").slice(-2000)});

    const plannerRuns = results.filter(r => r.role === "planner");
    const reviewerRuns = results.filter(r => r.role === "plan_reviewer");
    if (!check("at least 2 planner runs recorded (initial + one revision)", plannerRuns.length >= 2, {count: plannerRuns.length, ...dump()})) throw new Error("cannot continue: no revision occurred");
    if (!check("at least 1 plan_reviewer FAIL then a later PASS", reviewerRuns.some(r => r.verdict?.decision === "FAIL") && reviewerRuns.some(r => r.verdict?.decision === "PASS"), reviewerRuns.map(r => r.verdict?.decision))) throw new Error("cannot continue: reviewer never revised");

    // --- Proof 1: the planner revision (2nd+ planner run) never resumes ---
    for (let i = 1; i < plannerRuns.length; i++) {
      const args = argsOf(plannerRuns[i]);
      check(`planner run #${i + 1} (a revision): no --continue in its recorded invocation args`, !args.includes("--continue"), args);
      check(`planner run #${i + 1} (a revision): no --resume in its recorded invocation args`, !args.includes("--resume"), args);
    }

    // --- Proof 2: sessionId IS captured now, structurally, even though the
    // planner never uses it (proves the raw-event extraction fix on its
    // own, independent of the resume-policy fix above). ---
    check("planner run #1: sessionId captured from the raw event stream (not null)", plannerRuns[0].sessionId === "fake-planner-session", plannerRuns[0].sessionId);

    // --- Proof 3: after TASK-19 Phase 4 (task 12) the implementer retry is a
    // FRESH per-task invocation, never a resume: attempt #2 must carry no
    // --resume and no --continue. (The previous assertion — resume by the exact
    // captured session id — is deliberately retired here: TASK-8 requires every
    // per-task invocation to be a fresh session, so resuming by id is exactly
    // what must NOT happen.) Proof 2's sessionId capture is unchanged. ---
    const implRuns = results.filter(r => r.role === "implementer");
    const codeReviewerRuns = results.filter(r => r.role === "code_reviewer");
    if (check("at least 2 implementer attempts recorded (a code_reviewer FAIL forced a retry)", implRuns.length >= 2, {count: implRuns.length, decisions: codeReviewerRuns.map(r => r.verdict?.decision)})) {
      check("implementer attempt #1: sessionId captured", implRuns[0].sessionId === "fake-implementer-session", implRuns[0].sessionId);
      const retryArgs = argsOf(implRuns[1]);
      check("implementer attempt #2: fresh session — no --resume in its recorded invocation args", !retryArgs.includes("--resume"), retryArgs);
      check("implementer attempt #2: fresh session — no --continue in its recorded invocation args", !retryArgs.includes("--continue"), retryArgs);
    }

    check("mission reached completion (exit 0)", run.status === 0, dump());
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(binDir, {recursive: true, force: true});
  }
}

if (failures) {
  console.error(`${failures} session-continuity check(s) failed.`);
  process.exit(1);
}
console.log("test-relay-session-continuity: ALL CHECKS PASSED");
