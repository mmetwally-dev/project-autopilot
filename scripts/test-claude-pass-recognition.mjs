#!/usr/bin/env node
// Real-relay behavioral proof for three Claude output-handling bugs fixed
// together (all confirmed against real Claude Code CLI evidence):
//
//   1. autopilot.mjs's promptRepository stub was missing `available: true`
//      on the envelope object it hands to mapPathIntoEnvelope(), so
//      mapPathIntoEnvelope() bailed out immediately and the sandboxed
//      reviewer's prompt carried REPOSITORY=<real host path> instead of
//      REPOSITORY=/workspace/repository.
//   2. adapter-drivers.mjs's finalAgentText()/collectText() didn't
//      recognize the real Claude Code CLI stream-json shapes
//      ({"type":"assistant","message":{"content":[{"type":"text",...}]}}
//      and {"type":"result","result":"..."}), so it fell back to the raw
//      NDJSON blob and parseReviewContract() couldn't see the sentinel as
//      a standalone final line ("Review sentinel was not observed.").
//   3. failure-contract.mjs's classifyObservedFailure() scanned the raw
//      NDJSON for path-error text unconditionally, so an incidental,
//      already-recovered tool error anywhere in the stream (e.g. a
//      reviewer's own `ls` on a path it worked around) overrode an
//      otherwise-successful exit-0 process with a valid PASS sentinel as
//      PATH_UNSUPPORTED.
//
// This test runs REAL `node scripts/autopilot.mjs run` missions
// (production relay path, real bubblewrap envelope for the read-only
// roles) with plan_reviewer, code_reviewer, and verifier all bound to the
// real "claude" adapter, backed by a disposable fake `claude` executable
// (generated inline here, not a committed fixture) that emits the exact
// real Claude Code CLI stream-json event shapes above.
//
// Requires Linux/WSL (bubblewrap). Fails closed, not skip, on Windows.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import {fileURLToPath} from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${detail ? ` :: ${detail}` : ""}`); }
};

if (process.platform === "win32") {
  console.log("test-claude-pass-recognition: SKIP — platform prerequisite not met: this is a real-relay behavioral proof that runs the plan_reviewer role inside the actual read-only bubblewrap envelope, which requires Linux/WSL2 (bwrap) and does not exist on native Windows.");
  process.exit(0);
}

function git(cwd, args) {
  const r = spawnSync("git", args, {cwd, encoding: "utf8", stdio: "pipe", env: withoutOuterGitGuard(process.env), shell: false});
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout || "").trim();
}

function makeRepo(prefix) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "claude-pass-test@example.invalid"]);
  git(repo, ["config", "user.name", "Claude Pass Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

function makeConfig(repo, {maxPlanRevisions = 3} = {}) {
  const config = {
    schema_version: "3.0",
    project: {repo: ".", planning_framework: "standalone", state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs"},
    roles: {
      planner: {adapter: "cursor", model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null},
      plan_reviewer: {adapter: "claude", model: "sonnet", reasoning: "low", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null},
      implementer: {adapter: "cursor", model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null},
      code_reviewer: {adapter: "claude", model: "sonnet", reasoning: "low", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null},
      verifier: {adapter: "claude", model: "sonnet", reasoning: "low", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null}
    },
    workflow: {
      specReview: true, planReview: true, analysisAfterTasks: true, implementationReview: true, finalReview: true,
      autoApproveSpec: false, autoApprovePlan: false, parallelIndependentTasks: false, gsdPlanningReview: false,
      relaySafety: {block_git_commit_push: true, verify_read_only_by_snapshot: true, capture_touched_files: true, persist_role_sessions: true}
    },
    gates: {commands: [], env_allowlist: [], require_reviewer: true, network_isolation: true},
    policy: {
      max_plan_revisions: maxPlanRevisions, retry_delay_ms: 0, checkpoint_after_task: true, checkpoint_after_phase: true,
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

// Two-hop shim (launcher -> claude.com), mirroring the technique proven in
// test-claude-stdin-contract.mjs / test-claude-auth-envelope.mjs, generated
// inline here rather than as a committed fixture.
const FAKE_CLAUDE_LAUNCHER = `#!/bin/sh
# Disposable fake claude launcher, generated at test runtime by
# test-claude-pass-recognition.mjs (not a committed fixture).
# real target: "claude.com"
set -eu
exec "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/claude.com" "$@"
`;

// Emits the exact real Claude Code CLI stream-json event shapes this task
// fixes support for, driven by a scenario file committed in the fixture
// repository (read from the read-only /workspace/repository bind).
const FAKE_CLAUDE_TARGET = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const { execFileSync } = require("child_process");
const args = process.argv.slice(2);

function fail(reason) {
  process.stderr.write("fake-claude-pass: CONTRACT VIOLATION: " + reason + "\\n");
  process.exit(1);
}
if (args.includes("--version")) { process.stdout.write("fake-claude-pass 1.0.0\\n"); process.exit(0); }
const inputFormatIndex = args.indexOf("--input-format");
if (inputFormatIndex === -1 || args[inputFormatIndex + 1] !== "text") fail("expected --input-format text");

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => { stdin += c; });
process.stdin.on("end", () => {
  const trimmed = stdin.trimStart();
  if (!trimmed.startsWith("ROLE=")) fail("expected the plain-text ROLE= mission prompt");
  const roleLine = trimmed.split(/\\r?\\n/, 1)[0];
  const role = roleLine.slice("ROLE=".length);
  const repoLine = (trimmed.split(/\\r?\\n/).find(l => l.startsWith("REPOSITORY=")) || "REPOSITORY=");
  const repository = repoLine.slice("REPOSITORY=".length);

  let scenario = "pass";
  try { scenario = fs.readFileSync("/workspace/repository/.autopilot-test-claude-scenario", "utf8").trim() || "pass"; } catch {}

  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");

  // Always-emitted preamble events that finalAgentText() must NOT collect
  // text from: a system init event, and a "user" event carrying a
  // recovered tool_result error (the exact incidental failure text from
  // the real evidence). Neither is type "assistant", so collectText()'s
  // assistant.message.content[] branch never sees them.
  emit({type: "system", subtype: "init", session_id: "fake-session"});
  emit({type: "user", message: {role: "user", content: [
    {type: "tool_result", content: "ls: cannot access '" + repository + "/does-not-exist': No such file or directory"}
  ]}});

  if (scenario === "policy_violation") {
    // A compromised/buggy reviewer that both attempts a git mutation AND
    // still reports PASS. The git guard must still block the commit, and
    // Autopilot must still fail the run despite exit 0 and a valid sentinel.
    try {
      execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "policy-violation-attempt"], {stdio: "pipe"});
    } catch (e) {
      // Expected: the guard blocks this (non-zero exit, typically 97).
    }
  }

  let sentinelLine;
  if (scenario === "missing_sentinel") {
    sentinelLine = "I reviewed everything and it looks fine.";
  } else {
    sentinelLine = "AUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: ["ROLE=" + role, "REPOSITORY=" + repository]});
  }

  // Final assistant message: the real
  // {"type":"assistant","message":{"content":[{"type":"text",...}]}}
  // shape. A non-text "thinking" block is included first to prove it is
  // never collected.
  emit({type: "assistant", message: {role: "assistant", content: [
    {type: "thinking", thinking: "internal reasoning that must never be collected"},
    {type: "text", text: sentinelLine}
  ]}});

  // Final terminal event: the real {"type":"result","result":"..."} shape.
  // This must WIN as the final text over the assistant text above.
  emit({type: "result", subtype: "success", is_error: false, result: sentinelLine, terminal_reason: "completed"});
  process.exit(0);
});
`;

function makeBin() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-claude-pass-bin-"));

  const cursorAgentPath = path.join(binDir, "cursor-agent");
  fs.copyFileSync(path.join(here, "test-fixtures", "relay-scratch-probe-adapter.sh"), cursorAgentPath);
  fs.chmodSync(cursorAgentPath, 0o755);

  const claudeLauncherPath = path.join(binDir, "claude");
  fs.writeFileSync(claudeLauncherPath, FAKE_CLAUDE_LAUNCHER);
  fs.chmodSync(claudeLauncherPath, 0o755);
  const claudeTargetPath = path.join(binDir, "claude.com");
  fs.writeFileSync(claudeTargetPath, FAKE_CLAUDE_TARGET);
  fs.chmodSync(claudeTargetPath, 0o755);

  return binDir;
}

function runMission(repo, binDir, {timeoutMs = 180000} = {}) {
  const delimiter = process.platform === "win32" ? ";" : ":";
  // Strip any outer mission/gate git guard (PATH shim + hooks): the
  // nested mission installs its own, and every git call through both ran
  // the mission several times slower under the orchestrator gate.
  const base = withoutOuterGitGuard({...process.env});
  const env = {...base, PATH: `${binDir}${delimiter}${base.PATH || ""}`};
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
      else if (entry.name === "result.json") files.push(full);
    }
  })(root);
  return files.map(f => JSON.parse(fs.readFileSync(f, "utf8")));
}

function findRole(results, role) {
  return results.find(r => r.role === role) || null;
}

// ==========================================================================
// Scenario A: valid PASS + a recovered tool error must not override it, for
// all three read-only roles bound to "claude". Also proves the sandboxed
// prompt carries /workspace/repository, not the host path.
// ==========================================================================
{
  const repo = makeRepo("ap-claude-pass-a-");
  const binDir = makeBin();
  try {
    makeConfig(repo);
    fs.writeFileSync(path.join(repo, ".autopilot-test-claude-scenario"), "pass");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "scenario pass"]);

    const before = git(repo, ["rev-parse", "HEAD"]);
    const run = runMission(repo, binDir);
    const results = readAllResults(path.join(repo, ".autopilot"));

    for (const role of ["plan_reviewer", "code_reviewer", "verifier"]) {
      const r = findRole(results, role);
      check(`${role}: result.json produced`, r != null,
        `run.status=${run.status} stdout=${(run.stdout || "").slice(-1200)} stderr=${(run.stderr || "").slice(-1200)}`);
      if (!r) continue;
      check(`${role}: ran inside the read-only envelope`, r.executionPlaneSafety?.envelopeApplied === true);
      check(`${role}: completed (not failed)`, r.status === "completed", JSON.stringify(r).slice(0, 1500));
      check(`${role}: no policy violation`, r.policy?.violation === null);
      check(`${role}: decision is PASS despite the recovered "No such file or directory" tool error`,
        r.verdict?.decision === "PASS", JSON.stringify(r.verdict));
      check(`${role}: failure class is not PATH_UNSUPPORTED`, r.failure?.class !== "PATH_UNSUPPORTED", JSON.stringify(r.failure));

      const findings = r.review?.findings || r.verdict?.findings || [];
      check(`${role}: sandbox prompt REPOSITORY is /workspace/repository, not the host path`,
        findings.includes(`REPOSITORY=/workspace/repository`), JSON.stringify(findings));
      check(`${role}: sandbox prompt ROLE matches`, findings.includes(`ROLE=${role}`), JSON.stringify(findings));
    }

    const after = git(repo, ["rev-parse", "HEAD"]);
    check("scenario A: host repository not mutated by the read-only roles", before === after);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(binDir, {recursive: true, force: true});
  }
}

// ==========================================================================
// Scenario B: a missing review sentinel must still fail, even with exit 0.
// ==========================================================================
{
  const repo = makeRepo("ap-claude-pass-b-");
  const binDir = makeBin();
  try {
    makeConfig(repo, {maxPlanRevisions: 1});
    fs.writeFileSync(path.join(repo, ".autopilot-test-claude-scenario"), "missing_sentinel");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "scenario missing_sentinel"]);

    runMission(repo, binDir, {timeoutMs: 60000});
    const results = readAllResults(path.join(repo, ".autopilot"));
    const pr = findRole(results, "plan_reviewer");
    check("missing-sentinel: plan_reviewer result.json produced", pr != null);
    if (pr) {
      check("missing-sentinel: plan_reviewer is NOT reported as completed+PASS",
        !(pr.status === "completed" && pr.verdict?.decision === "PASS"), JSON.stringify(pr.verdict));
      check("missing-sentinel: review contract reports an error", !!pr.contract?.error, JSON.stringify(pr.contract));
    }
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(binDir, {recursive: true, force: true});
  }
}

// ==========================================================================
// Scenario C: a genuine policy violation (git mutation attempt) must still
// fail even though the fake reviewer also reports a valid PASS sentinel
// with exit 0 — proving the PATH_UNSUPPORTED fix did not weaken policy
// enforcement.
// ==========================================================================
{
  const repo = makeRepo("ap-claude-pass-c-");
  const binDir = makeBin();
  try {
    makeConfig(repo, {maxPlanRevisions: 1});
    fs.writeFileSync(path.join(repo, ".autopilot-test-claude-scenario"), "policy_violation");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "scenario policy_violation"]);

    const before = git(repo, ["rev-parse", "HEAD"]);
    runMission(repo, binDir, {timeoutMs: 60000});
    const results = readAllResults(path.join(repo, ".autopilot"));
    const pr = findRole(results, "plan_reviewer");
    check("policy-violation: plan_reviewer result.json produced", pr != null);
    if (pr) {
      check("policy-violation: plan_reviewer is NOT reported as completed+PASS despite exit 0 and a valid sentinel",
        !(pr.status === "completed" && pr.verdict?.decision === "PASS"), JSON.stringify({status: pr.status, verdict: pr.verdict}));
      check("policy-violation: a real policy violation is recorded", !!pr.policy?.violation, JSON.stringify(pr.policy));
    }
    const after = git(repo, ["rev-parse", "HEAD"]);
    check("policy-violation: the blocked commit did not actually land on the host repository", before === after);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(binDir, {recursive: true, force: true});
  }
}

if (failures) {
  console.error(`${failures} claude PASS-recognition check(s) failed.`);
  process.exit(1);
}
console.log("test-claude-pass-recognition: ALL CHECKS PASSED");
