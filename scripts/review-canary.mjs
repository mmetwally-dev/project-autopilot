#!/usr/bin/env node
// TASK-19 Phase 0 (continued), task 0: review-stage canary + Phase 6-7 GO/NO-GO
// gate. See .autopilot/tasks/TASK-19-intra-role-task-progress-tasks.md for the
// full design this implements.
//
// Deliberately NOT named test-*.mjs: scripts/test-all.mjs's auto-discovery
// picks up every /^test-.*\.mjs$/ file and runs it in the default suite. This
// file calls a REAL reviewer adapter (network-dependent, billable, and
// nondeterministic) — the opposite of what a regression suite is for. Run it
// explicitly:
//
//   node scripts/review-canary.mjs [--adapter=claude|opencode]
//
// What it does, in one real `ap run` mission plus one hand-assembled probe
// call (never more — the whole point is to measure, not to build Phases 6-7):
//
//   1. Drives a real `node scripts/autopilot.mjs run --repo <repo>` SpecKit
//      mission, seeded directly at the implementation checkpoint. Every role
//      except the reviewer runs on the existing fake-adapter fixture
//      ecosystem's pattern (a small embedded "cursor" stub, same convention
//      as scripts/test-fixtures/fake-workflow-adapter.sh); the Implementer
//      plants ONE deliberate, unambiguous defect (an inverted guard
//      predicate) and Code Reviewer is pointed at a REAL adapter — a fake
//      reviewer told to FAIL would prove nothing about whether phase-level
//      review actually catches defects.
//   2. Reads that single Code Reviewer result.json: the QUALITY outcome
//      (did it FAIL and name the defect) and, from task 0a's usage
//      breakdown, the PHASE-LEVEL COST baseline (price-weighted cost, turn
//      count) — this is the "before" reading Phases 6-7 must beat.
//   3. Assembles a per-task-shaped prompt BY HAND — this task's own contract
//      plus only its own file's delta hunk, the same slice task 9 would
//      produce — and runs the SAME real reviewer adapter on it ONCE more, a
//      direct CLI invocation (no mission wiring, no Phase 6 dispatch code,
//      because none of that exists yet). This is the sliced-brief turn
//      probe that makes the numeric gate a measurement instead of an
//      assumption.
//   4. Evaluates the gate from measured numbers (see printGate() below) and
//      prints a written GO or NO-GO plus everything needed to record it in
//      the task file, per task 0's accept criteria ("the quality outcome
//      AND the two cost readings ... are recorded here").
//
// Every fixture path below stays on a disposable temp directory; nothing
// here touches the real project repository this script lives in.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {adapterDriver, finalAgentText, accumulateUsage, USAGE_PRICE_WEIGHTS} from "./adapter-drivers.mjs";
import {spawnAgentSync} from "./agent-process.mjs";
import {parseReviewContract} from "./failure-contract.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");

const adapterArg = process.argv.find(a => a.startsWith("--adapter="));
const REVIEWER_ADAPTER = adapterArg ? adapterArg.slice("--adapter=".length) : "claude";
if (!["claude", "opencode"].includes(REVIEWER_ADAPTER)) {
  console.error(`review-canary: unsupported --adapter '${REVIEWER_ADAPTER}'. accumulateUsage() (task 0a) only decodes usage for claude/opencode, so those are the only adapters this canary can produce a non-null cost reading for.`);
  process.exit(2);
}

const MISSION_TIMEOUT_MS = Number(process.env.REVIEW_CANARY_MISSION_TIMEOUT_MS) || 40 * 60 * 1000;
const PROBE_TIMEOUT_MS = Number(process.env.REVIEW_CANARY_PROBE_TIMEOUT_MS) || 20 * 60 * 1000;

const MISSION = "900-review-canary";
const FEATURE_DIR_NAME = "specs/900-review-canary";
const TASK_TEXT = "Implement owner-only delete authorization in permission-guard.mjs.";
const TASK_ACCEPT = "canDeleteRecord(currentUser, record) returns true only when currentUser.id === record.ownerId, and false otherwise.";
const DEFECT_FILE = "src/permission-guard.mjs";
// The planted defect: an inverted guard predicate (task 0's own example of
// "something a competent reviewer must reject and a rubber stamp will
// miss"). As written, the record's OWNER is denied and every NON-owner is
// allowed to delete — the exact opposite of the task's own acceptance
// criteria above.
const DEFECT_CONTENT = [
  "// Only the record's owner may delete it.",
  "export function canDeleteRecord(currentUser, record) {",
  "  if (currentUser.id === record.ownerId) {",
  "    return false;",
  "  }",
  "  return true;",
  "}",
  ""
].join("\n");

const WORKFLOW_YML = [
  "- id: specify", "  type: command", "  command: /speckit.specify",
  "- id: review-spec", "  type: gate", "  message: Review the spec",
  "- id: plan", "  type: command", "  command: /speckit.plan",
  "- id: review-plan", "  type: gate", "  message: Review the plan",
  "- id: tasks", "  type: command", "  command: /speckit.tasks",
  "- id: review-tasks", "  type: gate", "  message: Review the tasks",
  "- id: implement", "  type: command", "  command: /speckit.implement",
  ""
].join("\n");

function git(cwd, args) {
  const r = spawnSync("git", args, {cwd, encoding: "utf8", shell: false});
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout || "").trim();
}

function cleanup(...dirs) {
  for (const dir of dirs) {
    if (!dir) continue;
    try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* best-effort */ }
  }
}

// ---------------------------------------------------------------------
// Fixture: a complete SpecKit feature (one phase, one task) seeded DIRECTLY
// at the implementation checkpoint (phase:"tasks_ready" in state.json — the
// exact shape adapters/planning-state.mjs's specKitState() classification
// requires, same convention test-windows-disposable-code-reviewer.mjs's
// seedSpecKitTasksReadyState() uses) so the mission proceeds straight to
// Implementer -> Code Reviewer with no Planner/Plan Reviewer launch at all.
// ---------------------------------------------------------------------
function makeCanaryRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-review-canary-repo-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "review-canary@example.invalid"]);
  git(repo, ["config", "user.name", "Review Canary"]);

  const workflowDir = path.join(repo, ".specify", "workflows", "speckit");
  fs.mkdirSync(workflowDir, {recursive: true});
  fs.writeFileSync(path.join(workflowDir, "workflow.yml"), WORKFLOW_YML);

  const featureDir = path.join(repo, FEATURE_DIR_NAME);
  fs.mkdirSync(featureDir, {recursive: true});
  fs.writeFileSync(path.join(repo, ".specify", "feature.json"), JSON.stringify({feature_directory: FEATURE_DIR_NAME}));
  fs.writeFileSync(path.join(featureDir, "spec.md"), `# Spec\n\nReview canary fixture feature.\n`);
  fs.writeFileSync(path.join(featureDir, "plan.md"), `# Plan\n\nReview canary fixture plan.\n`);
  fs.writeFileSync(path.join(featureDir, "tasks.md"), `## Phase 1: Review canary phase\n\n- [ ] ${TASK_TEXT}\n`);

  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init: review canary speckit fixture at the implementation checkpoint"]);

  const state = {
    version: 1, phase: "tasks_ready", step: "tasks_ready",
    taskIndex: 0, phaseIndex: 0, attempt: 0, mission: MISSION,
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
  };
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(state, null, 2));

  return {repo, featureDir};
}

// Every role runs on "cursor" (no registered driver — see
// adapter-drivers.mjs's DRIVERS map) EXCEPT code_reviewer, which is pointed
// at REVIEWER_ADAPTER. Failure budgets of 1 everywhere are load-bearing, not
// incidental: they guarantee the real reviewer is invoked EXACTLY ONCE by
// this mission regardless of its verdict — a FAIL escalates immediately
// (used=1, limit=1 -> not retried) instead of looping Implementer/Code
// Reviewer a second time at real-adapter cost, and a PASS proceeds to
// Verifier on the free "cursor" stub, never a second real-adapter call.
function writeCanaryConfig(repo) {
  const config = {
    schema_version: "3.0",
    project: {repo: ".", planning_framework: "speckit", state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs"},
    roles: Object.fromEntries(["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"].map(role => [
      role,
      {
        adapter: role === "code_reviewer" ? REVIEWER_ADAPTER : "cursor",
        model: "", reasoning: "", variant: "", resume: false,
        model_source: "default", model_verified_at: null, capabilities_verified_at: null
      }
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

// Minimal fake "cursor" adapter: an "implementer" branch (writes the
// planted defect, a tracked-file-free new file) and a "verifier" branch
// (always PASS — reached only if Code Review PASSes). "planner"/
// "plan_reviewer" are never expected (tasks_ready skips both) and, like
// test-windows-disposable-code-reviewer.mjs's own fixture, fall through to
// an "unknown ROLE" exit 1 so a regression there fails loudly instead of
// silently succeeding.
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
  console.log("fake-review-canary-cursor-agent 1.0.0");
  process.exit(0);
}

const PROMPT = await readStdin();
const firstLine = PROMPT.split(/\\r?\\n/, 1)[0] || "";
const role = firstLine.startsWith("ROLE=") ? firstLine.slice("ROLE=".length) : "";

if (role === "implementer") {
  const target = path.join(process.cwd(), ${JSON.stringify(DEFECT_FILE)});
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, ${JSON.stringify(DEFECT_CONTENT)});
  console.log("Implemented canDeleteRecord in " + ${JSON.stringify(DEFECT_FILE)} + ".");
  // TASK-8 Phase 4 requires a per-task Implementer invocation to end with the
  // AUTOPILOT_TASK_RESULT sentinel (scripts/task-result-contract.mjs): summary
  // + a truthful task-local check. It must be the FINAL non-empty line, and
  // the model never reports files (the orchestrator attributes them from the
  // tree), so this is all the fake needs to emit.
  console.log("AUTOPILOT_TASK_RESULT=" + JSON.stringify({
    summary: "Added canDeleteRecord to " + ${JSON.stringify(DEFECT_FILE)} + ".",
    taskLocalCheck: {command: "node --check " + ${JSON.stringify(DEFECT_FILE)}, status: "passed", exitCode: 0, summary: "syntax check passed"}
  }));
  process.exit(0);
}

if (role === "verifier") {
  console.log('AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}');
  process.exit(0);
}

console.error("review-canary fixture: unexpected ROLE '" + role + "' (only implementer/verifier are ever expected to reach the fake adapter)");
process.exit(1);
`;

function makeFixtureBin() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-review-canary-bin-"));
  if (process.platform === "win32") {
    const scriptPath = path.join(binDir, "fake-review-canary-adapter.mjs");
    fs.writeFileSync(scriptPath, ADAPTER_SCRIPT);
    fs.writeFileSync(path.join(binDir, "cursor-agent.cmd"), `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\nexit /b %errorlevel%\r\n`);
    return binDir;
  }
  const target = path.join(binDir, "cursor-agent");
  fs.writeFileSync(target, `#!/usr/bin/env node\n${ADAPTER_SCRIPT}`);
  fs.chmodSync(target, 0o755);
  return binDir;
}

function runMission(repo, binDir) {
  const delimiter = process.platform === "win32" ? ";" : ":";
  const env = {...process.env, PATH: `${binDir}${delimiter}${process.env.PATH || ""}`};
  // NO request text is passed, deliberately (same as
  // test-windows-disposable-code-reviewer.mjs's runMission): a supplied,
  // different description would trigger the new-mission takeover at
  // autopilot.mjs's `else if(hasUsableRequest(rawRequest) && ...)` branch,
  // clear the seeded `tasks_ready` checkpoint, and route back through
  // ensurePlanningReady() — launching the Planner (a role this fixture does
  // not implement) instead of proceeding straight to Implementation.
  const result = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "autopilot.mjs"), "run", "--repo", repo], {
    cwd: repo, encoding: "utf8", env, timeout: MISSION_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"], shell: false
  });
  return {status: result.status, timedOut: !!result.error && result.error.code === "ETIMEDOUT", stdout: result.stdout || "", stderr: result.stderr || ""};
}

function findCodeReviewerResult(repo) {
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
  const candidates = files
    .map(file => ({file, data: JSON.parse(fs.readFileSync(file, "utf8"))}))
    .filter(({data}) => data.role === "code_reviewer")
    .sort((a, b) => Date.parse(a.data.startedAt) - Date.parse(b.data.startedAt));
  return candidates[0] || null;
}

// ---------------------------------------------------------------------
// Measurement 3: the sliced-brief turn probe. Hand-assembles a per-task-
// shaped prompt (this task's own contract plus only its own file's diff —
// the same slice task 9 would produce) and runs REVIEWER_ADAPTER on it
// ONCE, directly (no mission wiring: Phase 6 dispatch code does not exist
// yet, so there is nothing to wire it through). The wrapper text (ROLE=,
// REPOSITORY=, the read-only notice, the AUTOPILOT_REVIEW sentinel
// instructions) is copied verbatim from runRelay()'s own rawRelayTaskText
// in scripts/autopilot.mjs so the comparison against the phase-level pass
// (measurement 1/2, which goes through that same wrapper) isolates the
// one thing this probe changes: the TASK content underneath it.
// ---------------------------------------------------------------------
function runSlicedBriefProbe(repo, fileDiff) {
  const driver = adapterDriver(REVIEWER_ADAPTER);
  const binary = REVIEWER_ADAPTER;
  const perTaskContract = [
    "PER-TASK REVIEW (single task in scope for this pass):",
    "",
    "Phase: Phase 1: Review canary phase (1 task total)",
    "Task list (titles only — later task titles are context, not authorization):",
    `  1. ${TASK_TEXT} [CURRENT TASK]`,
    "",
    "CURRENT TASK — the ONLY task this invocation may evaluate:",
    `  ${TASK_TEXT}`,
    `  Acceptance: ${TASK_ACCEPT}`,
    "",
    `Delta for this task's own files only (${DEFECT_FILE}):`,
    fileDiff
  ].join("\n");
  const wrapped = [
    "ROLE=code_reviewer", `REPOSITORY=${repo}`,
    "You are a delegated worker. The orchestrator owns Git history: never run git commit or git push, and never create git worktrees, branches, stashes or tags — the git guard blocks them and the mission stops. To see a committed version use `git show HEAD:<path>` or `git diff`.",
    `This is a READ-ONLY review. Do not modify any file in the repository.`,
    "", "TASK:", perTaskContract,
    '\nThis is a SINGLE-SHOT invocation: the process exits when your turn ends, and there is no later turn — nothing can notify you afterwards. Never end your turn waiting for a background task, a job, or a notification. Collect the result of any check you start in this same turn, or skip it and state that in your findings: a turn that ends while waiting produces no verdict at all, and the mission halts.\nEnd with exactly one line: AUTOPILOT_REVIEW={"decision":"PASS","findings":[]} or FAIL.\nEach finding must be self-contained and actionable WITHOUT reading this review again: give it as {"location":"<file, or artifact/section>","problem":"<what is wrong>","correction":"<what must change>"}. Keep each field to one or two sentences. Plain strings are still accepted, but then the string itself must carry all three.'
  ].join("\n");

  // Read-only enforcement for the probe is adapter-specific and deliberately
  // does NOT reuse the mission's machinery (this probe runs outside any
  // mission launch, with no bubblewrap envelope):
  //  - opencode: a probe-local agent defined via OPENCODE_CONFIG_CONTENT with
  //    edit denied and external_directory allowed. The native "plan" agent
  //    cannot be used here — it auto-rejects reads of the repo as
  //    "external_directory" when the process is not inside the mission's
  //    /workspace/repository envelope, so the review never happens and the
  //    probe silently produces no AUTOPILOT_REVIEW sentinel (observed live:
  //    "permission requested: external_directory (.../src/*); auto-rejecting").
  //  - claude: default mode + an explicit read-only allow list (same shape
  //    the production read-only roles launch with after backlog #2). No
  //    Write/Edit rule is granted: the canary probe has no scratch hand-off
  //    note to keep, so the probe stays read-only without plan mode.
  const PROBE_OPENCODE_AGENT = "review_canary_probe";
  const opencodeProbeConfig = JSON.stringify({
    "$schema": "https://opencode.ai/config.json",
    agent: {
      [PROBE_OPENCODE_AGENT]: {
        mode: "primary",
        permission: {edit: {"*": "deny"}, external_directory: {"**": "allow"}}
      }
    }
  });
  const baseArgs = REVIEWER_ADAPTER === "opencode"
    ? ["run", "--format", "json", "--agent", PROBE_OPENCODE_AGENT]
    : ["-p", "--output-format", "stream-json", "--input-format", "text", "--verbose", "--allowedTools", "Read", "Glob", "Grep", "Bash", "--disallowedTools", "Monitor", "TaskStop", "--settings", "{\"env\":{\"CLAUDE_CODE_DISABLE_BACKGROUND_TASKS\":\"1\"}}", "--permission-mode", "default"];

  // Every driver delivers the prompt on stdin (no driver declares a
  // transportPrompt prompt-as-CLI-argument path), so the prompt always goes
  // on stdin.
  const args = baseArgs;
  const spawnOptions = {cwd: repo, encoding: "utf8", timeout: PROBE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024};
  if (REVIEWER_ADAPTER === "opencode") spawnOptions.env = {...process.env, OPENCODE_CONFIG_CONTENT: opencodeProbeConfig};
  spawnOptions.input = wrapped;

  const probe = spawnAgentSync(binary, args, spawnOptions);
  const events = driver.decodeEvents(probe.stdout, probe.stderr);
  const text = finalAgentText(events, `${probe.stdout || ""}\n${probe.stderr || ""}`.trim());
  const contract = parseReviewContract(text);
  const usage = accumulateUsage(REVIEWER_ADAPTER, events);
  return {status: probe.status, timedOut: !!probe.error && probe.error.code === "ETIMEDOUT", verdict: contract.verdict, usage, rawText: text};
}

function fmtUsage(usage) {
  if (!usage) return "null (no usage signal decoded)";
  return `input=${usage.input} cacheCreation=${usage.cacheCreation} cacheRead=${usage.cacheRead} output=${usage.output} turns=${usage.turns} priceWeighted=${usage.priceWeighted.toFixed(2)}`;
}

// Task 0's own hard prerequisite #1: this canary calls a REAL read-only
// reviewer, and plan_reviewer/code_reviewer/verifier all fail closed with
// READ_ONLY_CONTAINMENT_UNAVAILABLE outside WSL/Linux bubblewrap containment.
// Detect it here rather than discovering it after paying for a mission launch
// that dies at the reviewer with a containment error. This canary is run
// inside WSL2 (process.platform === "linux", bwrap on PATH).
function preflightPlatform() {
  if (process.platform === "linux") return;
  console.error(`review-canary: FAIL -- read-only roles (code_reviewer here) require WSL/Linux bubblewrap containment, and this process is ${process.platform}. Task 0's prerequisite #1 says this canary cannot run on native Windows.`);
  console.error("Run it inside WSL2 instead, e.g.:");
  console.error("  wsl -e bash -lc 'cd /mnt/d/project-autopilot-dev && node scripts/review-canary.mjs'");
  process.exit(1);
}

// Mission 003 burned two reviewer launches and two 60-second retry delays on
// dead Claude OAuth before either one ever reached the model — the auth
// failure was only ever discovered AFTER paying for the launch attempt and
// its retry backoff. This canary drives exactly one (mission) plus one
// (probe) real reviewer call by design; losing either to unauthenticated
// Claude is the single most avoidable way to waste them. Check first, fail
// fast, spend nothing. OpenCode's driver declares no live auth-status check
// (detectProviderProfile is a hardcoded null — see opencodeDriver() in
// adapter-drivers.mjs), so there is nothing equivalent to preflight there;
// an opencode auth failure still surfaces at launch, same as before.
function preflightClaudeAuth() {
  if (REVIEWER_ADAPTER !== "claude") return;
  const driver = adapterDriver("claude");
  const profile = driver.detectProviderProfile({binary: "claude"});
  if (profile) {
    console.log(`review-canary: claude auth preflight OK (profile: ${profile})`);
    return;
  }
  console.error("review-canary: FAIL -- claude auth preflight did not report a recognized profile.");
  console.error("`claude auth status` returned no usable Anthropic API/OAuth session. Run `claude auth login` (or otherwise re-authenticate) and retry -- refusing to spend the mission/probe launches against dead auth (mission 003's exact failure mode).");
  process.exit(1);
}

async function main() {
  console.log(`review-canary: reviewer adapter = ${REVIEWER_ADAPTER}`);
  console.log(`review-canary: price weights (adapter-drivers.mjs USAGE_PRICE_WEIGHTS) = ${JSON.stringify(USAGE_PRICE_WEIGHTS)}`);
  preflightPlatform();
  preflightClaudeAuth();

  const {repo} = makeCanaryRepo();
  const binDir = makeFixtureBin();
  writeCanaryConfig(repo);

  let exitCode = 0;
  try {
    console.log("review-canary: running the phase-level mission (Implementer on the fake adapter, Code Reviewer on " + REVIEWER_ADAPTER + ")...");
    const mission = runMission(repo, binDir);
    if (mission.timedOut) {
      console.error(`review-canary: FAIL — mission timed out after ${MISSION_TIMEOUT_MS}ms`);
      process.exit(1);
    }

    const found = findCodeReviewerResult(repo);
    if (!found) {
      console.error("review-canary: FAIL — no code_reviewer result.json was produced by the mission");
      console.error("mission stdout tail:\n" + mission.stdout.slice(-2000));
      console.error("mission stderr tail:\n" + mission.stderr.slice(-2000));
      process.exit(1);
    }
    const cr = found.data;
    const decision = cr.review?.decision ?? cr.verdict?.decision ?? null;
    const findings = cr.review?.findings ?? cr.verdict?.findings ?? [];
    const caught = decision === "FAIL" && Array.isArray(findings) && findings.length > 0;

    console.log("\n==== Measurement 1: quality outcome (planted defect) ====");
    console.log(`decision: ${decision}`);
    console.log(`findings: ${JSON.stringify(findings, null, 2)}`);
    console.log(caught
      ? "GO-signal: the phase-level Code Reviewer caught the planted defect (functional FAIL)."
      : "STOP-signal: the phase-level Code Reviewer did NOT catch the planted defect. Per task 0's own rule, stop and raise this before building Phases 6-7 — a review stage that rubber-stamps a defect this unambiguous should not be multiplied elevenfold.");

    console.log("\n==== Measurement 2: phase-level cost baseline (task 0a usage) ====");
    console.log(`usage: ${fmtUsage(cr.usage)}`);

    // Measurement 3 only makes sense to run at all if we have a real diff to
    // slice — always true here (the Implementer always writes DEFECT_FILE
    // before Code Review runs), but guarded rather than assumed.
    let fileDiff = "";
    try {
      git(repo, ["add", "-A"]);
      fileDiff = git(repo, ["diff", "--cached", "--", DEFECT_FILE]);
    } catch (error) {
      console.error(`review-canary: could not compute the sliced diff for the probe: ${error.message}`);
    }

    console.log("\n==== Measurement 3: sliced-brief turn probe ====");
    if (fileDiff) {
      console.log(`review-canary: running the sliced-brief probe directly against ${REVIEWER_ADAPTER} (no mission wiring)...`);
      const probe = runSlicedBriefProbe(repo, fileDiff);
      if (probe.timedOut) {
        console.error(`review-canary: sliced-brief probe timed out after ${PROBE_TIMEOUT_MS}ms`);
      } else {
        console.log(`probe decision: ${probe.verdict?.decision ?? "(none)"}`);
        console.log(`probe findings: ${JSON.stringify(probe.verdict?.findings ?? [], null, 2)}`);
        console.log(`usage: ${fmtUsage(probe.usage)}`);
        if (!probe.verdict?.decision) {
          // A (none) verdict means no valid AUTOPILOT_REVIEW sentinel survived
          // finalAgentText/parseReviewContract (e.g. the built-in `plan` agent
          // added prose after the sentinel, or emitted none). The COST reading
          // is still valid — the invocation ran — but print the raw tail so a
          // future reader can tell a real "no review happened" from a parser
          // gap instead of guessing.
          console.log(`probe raw text tail: ${JSON.stringify((probe.rawText || "").slice(-600))}`);
        }
      }

      console.log("\n==== Recorded outcome (paste into TASK-19's task 0 bullet) ====");
      const at = new Date().toISOString();
      console.log([
        `Reviewer adapter under test: ${REVIEWER_ADAPTER}`,
        `Run at: ${at}`,
        `Quality outcome: ${caught ? "PASS (defect caught)" : "FAIL (defect NOT caught -- STOP, do not proceed to Phase 6-7 without re-examining this stage)"}`,
        `Phase-level baseline usage: ${fmtUsage(cr.usage)}`,
        `Sliced-brief probe usage: ${probe.timedOut ? "TIMED OUT" : fmtUsage(probe.usage)}`,
        `Gate inputs -- B (per-invocation base, from the probe's price-weighted figure), T (probe turn count), K=1 (this fixture's task count): compute the phase-6-7 gate per task 0's own formula using these two readings before writing GO/NO-GO.`
      ].join("\n"));
    } else {
      console.error("review-canary: no diff available -- Measurement 3 (sliced-brief probe) was skipped");
    }

    if (!caught) exitCode = 1;
  } finally {
    cleanup(repo, binDir);
  }
  process.exit(exitCode);
}

main().catch(error => {
  console.error(`review-canary: unexpected error: ${error?.stack || error}`);
  process.exit(1);
});
