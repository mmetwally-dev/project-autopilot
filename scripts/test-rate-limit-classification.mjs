#!/usr/bin/env node
// Regression proof for the false-classification bug demonstrated live by
// Mission 001 (001-investigate-and-fix) runs 27 and 28:
//
//   Run 27: Implementer (opencode) completed successfully, exit 0. The
//   mission's own subject is bubblewrap read-only sandboxing, so its own
//   investigation naturally produced text like "read-only file system" in
//   its output. classifyObservedFailure() scanned raw stdout+stderr text
//   unconditionally and misclassified this as PERMISSION_DENIED/adapter/
//   retryable:false — despite the process having genuinely succeeded.
//
//   Run 28: code_reviewer (claude, opus) hit a REAL Anthropic rate-limit
//   rejection (`{"type":"rate_limit_event","rate_limit_info":{"status":
//   "rejected",...}}`, captured live). The same raw-text scan also matched
//   an unrelated, already-recovered "No such file or directory" tool result
//   elsewhere in the transcript, and misclassified the run as
//   PATH_UNSUPPORTED/infrastructure/retryable:false — never recognizing the
//   rate limit as a failure at all.
//
//   selectAttemptFailure() then preferred Run 27's false ADAPTER-domain
//   failure over Run 28's false INFRASTRUCTURE-domain one (adapter ranks
//   first). Both were retryable:false, so a 2-attempt budget escalated the
//   ENTIRE MISSION on the very first occurrence of what was, underneath,
//   an ordinary transient rate limit a 60s retry delay would likely have
//   absorbed.
//
// Root cause and fix: raw model prose, file contents, successful tool
// output, and complete stdout transcripts were treated as authoritative
// failure evidence. They never are. See failure-contract.mjs's
// classifyObservedFailure() docblock for the corrected precedence.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import {fileURLToPath} from "node:url";
import {classifyObservedFailure, selectAttemptFailure, recordFailureBudget, failure} from "./failure-contract.mjs";
import {decideEscalationName} from "./escalation-naming.mjs";
import {adapterDriver} from "./adapter-drivers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  return false;
};

// ===========================================================================
// Part 1: direct classifyObservedFailure() / selectAttemptFailure() proofs.
// ===========================================================================

// --- Exact Run 27 shape ---------------------------------------------------
{
  const run27 = classifyObservedFailure({
    exitCode: 0,
    stdout: "Investigating the sandbox: attempted write returned permission denied.\n" +
      "The mount is not permitted to write outside scratch.\n" +
      "Confirmed: the bind is a read-only file system, exactly as designed.\n" +
      "implementer ok",
    stderr: "", startError: null, timedOut: false, evidence: [], driverless: false
  });
  check("Run 27 exact shape: exit 0 with 'permission denied'/'not permitted'/'read-only file system' in stdout => failure null",
    run27 === null, run27);
}

// --- Exact Run 28 shape -----------------------------------------------------
{
  const rateLimitedEvidence = [
    {type: "rate_limited", source: "cli_event", reason: "rate_limit_event_rejected", event: {type: "rate_limit_event", rate_limit_info: {status: "rejected"}}}
  ];
  const run28 = classifyObservedFailure({
    exitCode: 1,
    stdout: "Reviewed most of the diff.\ncat: docs/some-file.md: No such file or directory\n(incidental, already recovered)",
    stderr: "", startError: null, timedOut: false, evidence: rateLimitedEvidence, driverless: false
  });
  check("Run 28 exact shape: exit 1 + incidental 'No such file or directory' + structured rate-limit => RATE_LIMITED",
    run28?.class === "RATE_LIMITED", run28);
  check("Run 28 exact shape: domain is infrastructure", run28?.domain === "infrastructure", run28);
  check("Run 28 exact shape: retryable is false (backlog #38b: stop at once, no retry)", run28?.retryable === false, run28);
}

// --- Successful tool output containing path/server/permission phrases never affects classification ---
{
  const phrases = [
    "permission denied", "not permitted", "read-only file system",
    "no such file or directory", "cannot find the path", "invalid cwd",
    "ECONNREFUSED", "server unavailable"
  ];
  for (const phrase of phrases) {
    for (const driverless of [true, false]) {
      for (const channel of ["stdout", "stderr"]) {
        const observation = {exitCode: 0, stdout: "", stderr: "", startError: null, timedOut: false, evidence: [], driverless};
        observation[channel] = `Everything succeeded. Incidentally: ${phrase}. Continuing normally.`;
        const result = classifyObservedFailure(observation);
        check(`successful output containing "${phrase}" on ${channel} (driverless:${driverless}) never affects classification`,
          result === null, result);
      }
    }
  }
}

// --- A rejected rate-limit event wins over incidental path text -----------
{
  const withPathTextOnStdout = classifyObservedFailure({
    exitCode: 1, stdout: "cat: missing.md: No such file or directory", stderr: "",
    startError: null, timedOut: false, driverless: false,
    evidence: [{type: "rate_limited", event: {}}]
  });
  check("rejected rate-limit event wins over incidental path text on stdout",
    withPathTextOnStdout?.class === "RATE_LIMITED", withPathTextOnStdout);

  const withPathTextOnStderr = classifyObservedFailure({
    exitCode: 1, stdout: "", stderr: "cannot find the path specified",
    startError: null, timedOut: false, driverless: true,
    evidence: [{type: "rate_limited", event: {}}]
  });
  check("rejected rate-limit event wins over incidental path text on stderr, even for a driverless adapter",
    withPathTextOnStderr?.class === "RATE_LIMITED", withPathTextOnStderr);
}

// --- allowed / allowed_warning rate-limit events do not create failures ---
{
  const allowedEvents = [
    {type: "rate_limit_event", rate_limit_info: {status: "allowed", resetsAt: 1789450200, rateLimitType: "five_hour"}},
    {type: "assistant", message: {role: "assistant", content: [{type: "text", text: "ok"}]}}
  ];
  const allowedWarningEvents = [
    {type: "rate_limit_event", rate_limit_info: {status: "allowed_warning", resetsAt: 1789450200, utilization: 0.97}},
    {type: "assistant", message: {role: "assistant", content: [{type: "text", text: "ok"}]}}
  ];
  const rejectedEvents = [
    {type: "rate_limit_event", rate_limit_info: {status: "rejected", resetsAt: 1789450200}}
  ];
  const claude = adapterDriver("claude");
  check("driver: 'allowed' rate-limit status produces NO rate_limited observation",
    !claude.observe(allowedEvents, {}).some(o => o.type === "rate_limited"));
  check("driver: 'allowed_warning' rate-limit status produces NO rate_limited observation",
    !claude.observe(allowedWarningEvents, {}).some(o => o.type === "rate_limited"));
  check("driver: 'rejected' rate-limit status DOES produce a rate_limited observation",
    claude.observe(rejectedEvents, {}).some(o => o.type === "rate_limited"));

  const allowedClassified = classifyObservedFailure({
    exitCode: 0, stdout: "", stderr: "", startError: null, timedOut: false, driverless: false,
    evidence: claude.observe(allowedEvents, {})
  });
  check("classifyObservedFailure: 'allowed' rate-limit + exit 0 => no failure", allowedClassified === null, allowedClassified);
  const allowedWarningClassified = classifyObservedFailure({
    exitCode: 0, stdout: "", stderr: "", startError: null, timedOut: false, driverless: false,
    evidence: claude.observe(allowedWarningEvents, {})
  });
  check("classifyObservedFailure: 'allowed_warning' rate-limit + exit 0 => no failure", allowedWarningClassified === null, allowedWarningClassified);
}

// --- error=="rate_limit" and api_error_status==429 structured shapes ------
{
  const claude = adapterDriver("claude");
  const errorShape = claude.observe([{type: "error", error: "rate_limit"}], {});
  check("driver: top-level error:\"rate_limit\" produces a rate_limited observation", errorShape.some(o => o.type === "rate_limited"), errorShape);
  const statusShape = claude.observe([{type: "api_error", api_error_status: 429}], {});
  check("driver: top-level api_error_status:429 produces a rate_limited observation", statusShape.some(o => o.type === "rate_limited"), statusShape);
}

// --- Genuine failures remain correctly classified --------------------------
{
  const permission = classifyObservedFailure({exitCode: 1, stdout: "", stderr: "", evidence: [{type: "permission_denied"}], driverless: false});
  check("genuine: structured permission_denied => PERMISSION_DENIED/adapter/non-retryable",
    permission?.class === "PERMISSION_DENIED" && permission.domain === "adapter" && permission.retryable === false, permission);

  const driverlessPermission = classifyObservedFailure({exitCode: 1, stdout: "irrelevant", stderr: "permission denied by policy", evidence: [], driverless: true});
  check("genuine: driverless stderr permission text (nonzero exit) => PERMISSION_DENIED",
    driverlessPermission?.class === "PERMISSION_DENIED", driverlessPermission);

  const driverlessPath = classifyObservedFailure({exitCode: 2, stdout: "", stderr: "cat: x: No such file or directory", evidence: [], driverless: true});
  check("genuine: driverless stderr path text (nonzero exit) => PATH_UNSUPPORTED",
    driverlessPath?.class === "PATH_UNSUPPORTED", driverlessPath);

  const driverlessServer = classifyObservedFailure({exitCode: 1, stdout: "", stderr: "connect ECONNREFUSED 127.0.0.1:443", evidence: [], driverless: true});
  check("genuine: driverless stderr server text (nonzero exit) => SERVER_UNAVAILABLE, retryable",
    driverlessServer?.class === "SERVER_UNAVAILABLE" && driverlessServer.retryable === true, driverlessServer);

  const timeout = classifyObservedFailure({exitCode: null, timedOut: true, evidence: []});
  check("genuine: timeout => TIMEOUT/infrastructure/retryable", timeout?.class === "TIMEOUT" && timeout.retryable === true, timeout);

  const start = classifyObservedFailure({exitCode: null, startError: "spawn ENOENT", timedOut: false, evidence: []});
  check("genuine: start error => PROCESS_START_FAILED/adapter/retryable", start?.class === "PROCESS_START_FAILED" && start.retryable === true, start);

  const exitNonzero = classifyObservedFailure({exitCode: 3, stdout: "", stderr: "", evidence: [], driverless: false});
  check("genuine: unexplained nonzero exit => PROCESS_EXIT_NONZERO/adapter/retryable",
    exitNonzero?.class === "PROCESS_EXIT_NONZERO" && exitNonzero.retryable === true, exitNonzero);

  const policy = classifyObservedFailure({exitCode: 0, policyViolation: "git_mutation_blocked", evidence: []});
  check("genuine: policy violation => GIT_MUTATION_BLOCKED/policy regardless of exit 0", policy?.class === "GIT_MUTATION_BLOCKED" && policy.domain === "policy", policy);

  const clean = classifyObservedFailure({exitCode: 0, stdout: "all good", stderr: "", evidence: [], driverless: true});
  check("genuine: clean exit 0, nothing else => no failure", clean === null, clean);
}

// --- selectAttemptFailure: ignore stale text-fallback noise on a completed
// result, but retain legitimate reviewer FAIL and policy failures. ---------
{
  // The exact Run 27 shape as it would arrive wrapped in a relay result:
  // status "completed" (buildRuntimeResult only looks at exit code + policy,
  // never at .failure), no policy violation, but somehow still carrying a
  // stderr_text_fallback-tagged failure (defense in depth against whatever
  // future path might produce this combination — classifyObservedFailure
  // itself can no longer produce it, since that fallback only ever fires on
  // a nonzero exit).
  const staleImplementerResult = {
    role: "implementer", status: "completed", policy: {violation: null},
    failure: failure("PERMISSION_DENIED", "adapter", false, [{source: "stderr_text_fallback", pattern: "permission", text: "..."}])
  };
  const legitimateReviewerFail = {
    role: "code_reviewer", status: "completed", policy: {violation: null},
    failure: failure("IMPLEMENTATION_REJECTED", "implementation", true, ["fix the bug"])
  };
  const selected1 = selectAttemptFailure({results: [staleImplementerResult, legitimateReviewerFail]});
  check("selectAttemptFailure: a stale text-fallback failure on a completed, policy-clean result is ignored",
    selected1?.class === "IMPLEMENTATION_REJECTED", selected1);

  const genuinePolicyViolation = {
    role: "implementer", status: "failed", policy: {violation: "git_mutation_blocked"},
    failure: failure("GIT_MUTATION_BLOCKED", "policy", false, [])
  };
  const selected2 = selectAttemptFailure({results: [staleImplementerResult, genuinePolicyViolation]});
  check("selectAttemptFailure: a genuine policy violation is retained even alongside stale noise",
    selected2?.class === "GIT_MUTATION_BLOCKED", selected2);

  // A TRUSTED structured failure (not text-fallback-tagged) on a completed
  // result must survive — only the text-fallback tag is distrusted.
  const trustedOnCompleted = {
    role: "implementer", status: "completed", policy: {violation: null},
    failure: failure("PERMISSION_DENIED", "adapter", false, [{type: "permission_denied"}])
  };
  const selected3 = selectAttemptFailure({results: [trustedOnCompleted]});
  check("selectAttemptFailure: a TRUSTED structured failure on a completed result is NOT dropped",
    selected3?.class === "PERMISSION_DENIED", selected3);

  // A RATE_LIMITED (infrastructure) result recorded as "failed" (the
  // realistic shape, since the fallback only fires on nonzero exit — which
  // buildRuntimeResult always maps to status "failed") must still win over
  // an unrelated, correctly-null sibling.
  const rateLimitedResult = {
    role: "code_reviewer", status: "failed", policy: {violation: null},
    failure: failure("RATE_LIMITED", "infrastructure", true, [{type: "rate_limited"}])
  };
  const cleanImplementer = {role: "implementer", status: "completed", policy: {violation: null}, failure: null};
  const selected4 = selectAttemptFailure({results: [cleanImplementer, rateLimitedResult]});
  check("selectAttemptFailure: RATE_LIMITED from the genuinely failed role is selected",
    selected4?.class === "RATE_LIMITED", selected4);
}

// --- Budget: RATE_LIMITED never consumes the budget (immediate escalation) ---
{
  const state = {};
  const policy = {failure_budgets: {infrastructureRetryBudget: 2}};
  const rl = failure("RATE_LIMITED", "infrastructure", false, [{type: "rate_limited"}]);
  const first = recordFailureBudget(state, policy, rl, "mission");
  check("budget: first RATE_LIMITED occurrence is denied (immediate escalation, no retry)", first.allowed === false, first);
  check("budget: RATE_LIMITED leaves infrastructureRetryBudget:mission unset",
    state.failureBudgets?.["infrastructureRetryBudget:mission"] === undefined, state.failureBudgets);
}

// ===========================================================================
// Part 2: integration coverage through real relay execution — Standalone,
// SpecKit, and GSD. Proves the fix end to end: a role that hits the exact
// Run 28 shape (rate limit + incidental path text) on its first attempt
// is classified RATE_LIMITED and the mission stops AT ONCE — no retry into
// the same model (backlog #38 part b). Uses a real two-hop "claude" shim (same technique as
// test-claude-pass-recognition.mjs / test-relay-session-continuity.mjs) so
// the real decodeEvents/observe/classifyObservedFailure/selectAttemptFailure
// production path is exercised, not a reimplementation.
// ===========================================================================
if (process.platform === "win32") {
  console.log("test-rate-limit-classification: Part 2 SKIP — requires Linux/WSL2 (bubblewrap) for the \"claude\" adapter.");
  if (failures) { console.error(`${failures} check(s) failed.`); process.exit(1); }
  console.log("test-rate-limit-classification: unit checks PASSED (Part 2 skipped on this platform)");
  process.exit(0);
}

function git(cwd, args) {
  const r = spawnSync("git", args, {cwd, encoding: "utf8", stdio: "pipe", env: withoutOuterGitGuard(process.env), shell: false});
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout || "").trim();
}

const FAKE_CLAUDE_LAUNCHER = `#!/bin/sh
# Disposable fake claude launcher, generated at test runtime by
# test-rate-limit-classification.mjs (not a committed fixture).
# real target: "claude.com"
set -eu
exec "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/claude.com" "$@"
`;

// One dispatcher, by ROLE (the prompt's own "ROLE=<role>" first line — the
// same real, permanent convention scripts/autopilot.mjs's relay() always
// uses, not a test-only marker). A committed ".rate-limit-marker" file (the
// only channel that reaches the adapter identically in the plain repo, a
// GSD worktree, and the read-only bubblewrap bind — env vars are filtered)
// makes the FIRST call for a given role hit the Run 28 shape and every
// subsequent call succeed normally, so the mission proves an actual retry
// occurred rather than being told to.
const FAKE_CLAUDE_TARGET = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("fake-claude-rate-limit 1.0.0\\n"); process.exit(0); }

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => { stdin += c; });
process.stdin.on("end", () => {
  const roleLine = (stdin.trimStart().split(/\\r?\\n/, 1)[0] || "");
  const role = roleLine.startsWith("ROLE=") ? roleLine.slice("ROLE=".length) : "";
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
  const finishOk = (sessionId, text) => {
    emit({type: "system", subtype: "init", session_id: sessionId});
    emit({type: "assistant", message: {role: "assistant", content: [{type: "text", text}]}});
    emit({type: "result", subtype: "success", is_error: false, result: text, terminal_reason: "completed"});
    process.exit(0);
  };
  // Which role gets the Run 28 shape on its first call is configurable via
  // a committed file (env vars never reach the sandboxed adapter) — the
  // real bug was on code_reviewer; GSD's phase-level code_reviewer shares
  // real, persisted state.json (unlike its worktree-isolated plan-unit
  // implementer), so GSD targets code_reviewer while Standalone/SpecKit
  // target implementer. Either way it is the SAME shared classifier/budget
  // code path being proven.
  let rateLimitedRole = "implementer";
  try { rateLimitedRole = fs.readFileSync(".rate-limit-role", "utf8").trim() || rateLimitedRole; } catch {}
  const markerPath = ".rate-limit-marker-" + role;

  if (role === rateLimitedRole && !fs.existsSync(markerPath)) {
    // Exact Run 28 shape: a rejected rate-limit event PLUS an unrelated,
    // already-recovered "No such file or directory" tool result, then a
    // nonzero exit. Marker written FIRST so a retry (even if this process
    // is killed right after) does not repeat the failure forever.
    fs.writeFileSync(markerPath, "1");
    emit({type: "system", subtype: "init", session_id: "fake-" + role + "-session"});
    emit({type: "user", message: {role: "user", content: [{type: "tool_result", content: "cat: docs/some-file.md: No such file or directory"}]}});
    emit({type: "rate_limit_event", rate_limit_info: {status: "rejected", resetsAt: 1789450200, rateLimitType: "five_hour"}});
    process.stderr.write("fake-claude: rate limited\\n");
    process.exit(1);
  }

  if (role === "implementer") {
    try { fs.appendFileSync("README.md", "implementer change\\n"); } catch {}
    // The per-task Implementer loop (standalone AND speckit) requires the
    // AUTOPILOT_TASK_RESULT sentinel as the final non-empty response line
    // (scripts/task-result-contract.mjs) — without it the loop escalates with
    // STRUCTURED_OUTPUT_MISSING even though the relay itself succeeded.
    // Same shape as test-relay-session-continuity.mjs's fake implementer.
    const taskResult = "AUTOPILOT_TASK_RESULT=" + JSON.stringify({summary: "Added a fixture line to README.md.", taskLocalCheck: {command: "check", status: "passed", exitCode: 0, summary: "fixture check passed"}});
    return finishOk("fake-implementer-session-2", "Implemented the task.\\n" + taskResult);
  }

  if (role === "planner") {
    // Standalone shape - supports both old single-file and new split contract (v5: PLAN.md + TASKS.md)
    const planMatch = stdin.match(/Write the (?:narrative )?plan to exactly:\s*(.*)/);
    const tasksMatch = stdin.match(/Write the phased checklist to exactly:\s*(.*)/);
    const legacyMatch = !planMatch ? stdin.match(/Write the plan to exactly:\s*(.*)/) : null;
    if (planMatch || legacyMatch) {
      const planPath = planMatch ? planMatch[1].trim() : legacyMatch[1].trim();
      if (tasksMatch) {
        fs.writeFileSync(planPath, "# Plan\\n\\nObjective: add a fixture line to README.md\\n");
        fs.writeFileSync(tasksMatch[1].trim(), "## Phase 1: General\\n\\n- [ ] 1. Add a fixture line to README.md\\n");
      } else if (planMatch) {
        fs.writeFileSync(planPath, "# Plan\\n\\nObjective: add a fixture line to README.md\\n");
        fs.writeFileSync(planPath.replace(/PLAN\.md$/, "TASKS.md"), "## Phase 1: General\\n\\n- [ ] 1. Add a fixture line to README.md\\n");
      } else {
        fs.writeFileSync(planPath, "# Plan\\n\\n## Checklist\\n\\n- [ ] 1. Add a fixture line to README.md\\n\\nVerification: manual.\\n");
      }
      return finishOk("fake-planner-session", "Wrote the plan.");
    }
    // SpecKit shape: "Planning phase: specify|plan|tasks". The feature
    // directory is chosen freely on "specify" (the contract note only
    // offers a placeholder, since nothing has been resolved yet); "plan"
    // and "tasks" run AFTER production has resolved the real one from the
    // feature.json this same planner wrote, and the prompt's own artifact
    // contract note always names it explicitly — extracted here rather
    // than assumed, so this stays correct regardless of naming.
    const featureFromPrompt = stdin.match(/specs\\/([^\\/\\s]+)\\//);
    if (/Planning phase: specify/.test(stdin)) {
      const dir = "specs/999-fixture-feature";
      fs.mkdirSync(dir, {recursive: true});
      fs.writeFileSync(dir + "/spec.md", "# Spec\\n\\nAdd a fixture line to README.\\n");
      fs.mkdirSync(".specify", {recursive: true});
      fs.writeFileSync(".specify/feature.json", JSON.stringify({feature_directory: dir}));
      return finishOk("fake-planner-specify-session", "Wrote the spec.");
    }
    if (/Planning phase: plan/.test(stdin) && featureFromPrompt) {
      fs.writeFileSync("specs/" + featureFromPrompt[1] + "/plan.md", "# Plan\\n\\nAdd a fixture line to README.\\n");
      return finishOk("fake-planner-plan-session", "Wrote the plan.");
    }
    if (/Planning phase: tasks/.test(stdin) && featureFromPrompt) {
      fs.writeFileSync("specs/" + featureFromPrompt[1] + "/tasks.md",
        "## Phase 1: Fixture\\n\\n- [ ] Add a fixture line to README.md (README.md:1)\\n");
      return finishOk("fake-planner-tasks-session", "Wrote the tasks.");
    }
    return finishOk("fake-planner-session", "Wrote the plan.");
  }

  // Every review-shaped role always PASSes — this test is about the
  // rate-limited role's own retry behavior, not review cycling.
  const sentinel = "AUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: []});
  return finishOk("fake-" + role + "-session", sentinel);
});
`;

function makeBin() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-rate-limit-bin-"));
  const claudeLauncherPath = path.join(binDir, "claude");
  fs.writeFileSync(claudeLauncherPath, FAKE_CLAUDE_LAUNCHER);
  fs.chmodSync(claudeLauncherPath, 0o755);
  const claudeTargetPath = path.join(binDir, "claude.com");
  fs.writeFileSync(claudeTargetPath, FAKE_CLAUDE_TARGET);
  fs.chmodSync(claudeTargetPath, 0o755);
  return binDir;
}

function baseConfig(planningFramework, overrides = {}) {
  const claudeRole = {adapter: "claude", model: "sonnet", reasoning: "low", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null};
  return {
    schema_version: "3.0",
    project: {repo: ".", planning_framework: planningFramework, state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs"},
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
      failure_budgets: {implementationFailureBudget: 5, verificationFailureBudget: 5, adapterRetryBudget: 5, infrastructureRetryBudget: 2}
    },
    safety: {allow_git_commit: false, allow_git_push: false, allow_destructive_operations: false},
    planning: {
      speckit: {workflow_file: ".specify/workflows/speckit/workflow.yml", task_candidates: [".specify/tasks.md", "specs/*/tasks.md", "specs/*/tasks/*.md"]},
      gsd: {phase_root: ".planning/phases", run_plan_verify: false, run_state_validate: false, write_summary_artifacts: true, write_verification_artifacts: true, write_uat_artifact: true, use_gsd_tools_when_available: false, parallelization: {enabled: false, plan_level: false, task_level: false, max_concurrent_agents: 1, min_plans_for_parallel: 99}, planning_review: {enabled: false, review_after_each_stage: true, stages: ["discuss", "research", "plan", "plan-check"], max_revisions: 3, read_only_reviewer: true}}
    },
    capabilities: {project_defaults: [], role_requirements: {}, safety_denied: [], legacy_text_inference: false, verification: {browser: "native", require_browser: "when-task-requires"}},
    ...overrides
  };
}

function makeRepo(prefix) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `ap-rate-limit-${prefix}-`));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "rate-limit-test@example.invalid"]);
  git(repo, ["config", "user.name", "Rate Limit Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

function runMission(repo, binDir, request, timeoutMs = 590000) {
  // 220s was enough on a fast disk, but each relay hop spawns a sandboxed
  // adapter and the full speckit mission (6 planning hops + a rate-limited
  // implementer retry + reviews) needs ~330s on a slow filesystem — keep the
  // fail-fast timeout, just sized for slow disks.
    // Strip any outer mission/gate git guard (PATH shim + hooks): the
  // nested mission installs its own, and every git call through both
  // ran the mission several times slower under the orchestrator gate.
  const base = withoutOuterGitGuard({...process.env});
  const env = {...base, PATH: `${binDir}:${base.PATH || ""}`};
  return spawnSync(process.execPath, [path.join(skillRoot, "scripts", "autopilot.mjs"), "run", request, "--repo", repo], {
    cwd: repo, encoding: "utf8", env, timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"], shell: false
  });
}

function readAllResults(root) {
  const results = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "result.json") results.push(JSON.parse(fs.readFileSync(full, "utf8")));
    }
  })(root);
  return results;
}

function assertImmediateEscalation(label, repo, run) {
  const dump = () => ({status: run.status, timedOut: run.error?.code === "ETIMEDOUT", stdout: (run.stdout || "").slice(-1500), stderr: (run.stderr || "").slice(-1500)});
  check(`${label}: mission stopped with a non-zero exit (rate limit is not retried)`, run.status !== 0 && run.error?.code !== "ETIMEDOUT", dump());
  check(`${label}: stderr names RATE_LIMITED as not retryable`, /RATE_LIMITED is not retryable/.test(run.stderr || ""), dump());
  // The escalation detail carries the resume instruction (the CLI-driver
  // evidence carries no provider/model, so the fallback wording applies —
  // provider/model naming is covered by the escalation-naming unit cases).
  check(`${label}: stderr carries the resume instruction`, /ap run/.test(run.stderr || ""), dump());

  const results = readAllResults(path.join(repo, ".autopilot"));
  const implRuns = results.filter(r => r.role === "implementer").sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  check(`${label}: exactly one implementer attempt (no retry)`, implRuns.length === 1, implRuns.map(r => ({status: r.status, failure: r.failure})));
  if (implRuns.length >= 1) {
    check(`${label}: attempt 1 classified as RATE_LIMITED`, implRuns[0].failure?.class === "RATE_LIMITED", implRuns[0].failure);
    check(`${label}: attempt 1 domain is infrastructure, not retryable`, implRuns[0].failure?.domain === "infrastructure" && implRuns[0].failure?.retryable === false, implRuns[0].failure);
  }

  // Immediate escalation persists the rate_limited_escalation step without
  // consuming infrastructureRetryBudget.
  let persisted = null;
  try { persisted = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8")); }
  catch (error) { persisted = {readError: String(error?.message || error)}; }
  check(`${label}: persisted step is rate_limited_escalation`, persisted?.step === "rate_limited_escalation", {step: persisted?.step, phase: persisted?.phase});
  check(`${label}: infrastructureRetryBudget:mission left unset`,
    persisted?.failureBudgets?.["infrastructureRetryBudget:mission"] === undefined, persisted?.failureBudgets);
}

// --- Standalone -------------------------------------------------------------
{
  const repo = makeRepo("standalone");
  const binDir = makeBin();
  try {
    fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
    fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), JSON.stringify(baseConfig("standalone"), null, 2));
    const run = runMission(repo, binDir, "add a fixture line to README.md");
    assertImmediateEscalation("standalone", repo, run);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(binDir, {recursive: true, force: true});
  }
}

// --- SpecKit ------------------------------------------------------------
{
  const repo = makeRepo("speckit");
  const binDir = makeBin();
  try {
    const workflowDir = path.join(repo, ".specify", "workflows", "speckit");
    fs.mkdirSync(workflowDir, {recursive: true});
    fs.writeFileSync(path.join(workflowDir, "workflow.yml"), [
      "- id: specify", "  type: command", "  command: /speckit.specify",
      "- id: review-spec", "  type: gate", "  message: Review the spec",
      "- id: plan", "  type: command", "  command: /speckit.plan",
      "- id: review-plan", "  type: gate", "  message: Review the plan",
      "- id: tasks", "  type: command", "  command: /speckit.tasks",
      "- id: review-tasks", "  type: gate", "  message: Review the tasks",
      "- id: implement", "  type: command", "  command: /speckit.implement", ""
    ].join("\n"));
    // A pre-existing, already-complete SpecKit feature: ensurePlanningReady()
    // then takes the existing-planning-review path (one PASS) and goes
    // straight to implementation, where the rate-limit/retry proof runs —
    // this test is about the Implementer's retry behavior, not planning.
    const featureDir = path.join(repo, "specs", "001-fixture-feature");
    fs.mkdirSync(featureDir, {recursive: true});
    fs.writeFileSync(path.join(featureDir, "spec.md"), "# Spec\n\nAdd a fixture line to README.\n");
    fs.writeFileSync(path.join(featureDir, "plan.md"), "# Plan\n\nAdd a fixture line to README.\n");
    fs.writeFileSync(path.join(featureDir, "tasks.md"), [
      "## Phase 1: Fixture", "", "- [ ] Add a fixture line to README.md (README.md:1)", ""
    ].join("\n"));
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "speckit fixture"]);

    fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
    fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), JSON.stringify(baseConfig("speckit"), null, 2));
    const run = runMission(repo, binDir, "add a fixture line to README.md");
    assertImmediateEscalation("speckit", repo, run);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(binDir, {recursive: true, force: true});
  }
}

// --- GSD (generic regression coverage) --------------------------------------
// A full real-relay GSD mission is NOT attempted here: GSD plan-unit
// execution always runs the Implementer/Code Reviewer inside a linked Git
// worktree (autopilot.mjs's runGsdPlanUnit -> createWorktree), and
// relay-guards.mjs's assertSupportedTopology() unconditionally rejects a
// linked worktree ("Unsupported Git topology: linked worktree..."), so no
// GSD plan-unit relay call can complete AT ALL today. Confirmed directly
// (a throwaway repro reproduced the exact same rejection). This is a
// separate, pre-existing bug — already excluded from test-all.mjs's own
// suite for exactly this reason (see that file's
// excludedPendingUnrelatedBug/test-workflow-order-gsd.mjs entry) — and
// strictly out of scope for a failure-classification fix.
//
// What GSD's own code actually does, structurally: executeWave() re-records
// each plan-unit's failureRecords against the shared state via the SAME
// recordFailureBudget()/selectAttemptFailure() this file already proves
// correct above, using failureBudgetScope()'s own scope convention — an
// infrastructure-domain failure (RATE_LIMITED, TIMEOUT, ...) always scopes
// to the literal string "mission", regardless of which phase/plan it came
// from. This exercises exactly that scope shape, generically — no worktree,
// no relay, no dependency on the excluded bug above.
{
  const state = {};
  const policy = {failure_budgets: {infrastructureRetryBudget: 2}};
  const rl = failure("RATE_LIMITED", "infrastructure", false, [{type: "rate_limited"}]);
  // GSD's own scope convention for an infrastructure-domain failure,
  // regardless of which phase/plan produced it (failureBudgetScope() maps
  // EVERY infrastructure-domain failure to the literal "mission" scope).
  const gsdScope = "mission";
  const first = recordFailureBudget(state, policy, rl, gsdScope);
  check("gsd generic: first RATE_LIMITED occurrence under GSD's own \"mission\" scope is denied (immediate escalation, no retry)", first.allowed === false, first);
  check("gsd generic: RATE_LIMITED leaves the mission-scope key unset",
    state.failureBudgets?.["infrastructureRetryBudget:mission"] === undefined, state.failureBudgets);
  const naming = decideEscalationName({failureClass: rl.class, retryable: rl.retryable, used: first.used, limit: first.limit, budget: first.budget, evidence: rl.evidence});
  check("gsd generic: escalation step is rate_limited_escalation", naming?.step === "rate_limited_escalation", naming);
  check("gsd generic: escalation detail carries the resume instruction", /ap run/.test(naming?.detail || ""), naming);

  // The exact results shape executeWave() builds for one plan unit: the
  // Implementer's result carries the failure, the Code Reviewer's is null
  // (never reached, or reviewed a partial diff and passed it trivially).
  const gsdImplResult = {role: "implementer", status: "failed", policy: {violation: null}, failure: rl};
  const gsdReviewResult = {role: "code_reviewer", status: "completed", policy: {violation: null}, failure: null};
  const selected = selectAttemptFailure({results: [gsdImplResult, gsdReviewResult]});
  check("gsd generic: selectAttemptFailure picks the Implementer's RATE_LIMITED over its null sibling",
    selected?.class === "RATE_LIMITED", selected);
}

if (failures) {
  console.error(`${failures} rate-limit-classification check(s) failed.`);
  process.exit(1);
}
console.log("test-rate-limit-classification: ALL CHECKS PASSED");
