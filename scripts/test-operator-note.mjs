#!/usr/bin/env node
// Backlog #11: `ap note "<decision>"` — a mission-level operator decision that
// reaches the PLANNING stage (planner + plan reviewer), not only the
// implementer/code-review briefs. Real `autopilot.mjs` / `ap.cjs` subprocesses
// with a fake agent that reports whether its brief carried the block.
// Run: node scripts/test-operator-note.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn, spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import {operatorDecisionsBlock, withOperatorDecisions, addOperatorDecision, OPERATOR_DECISIONS_HEADER} from "./operator-decisions.mjs";
import {renderOperatorDecisions} from "./watch-report.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
function check(name, ok, detail) {
  if (ok) { console.log(`PASS ${name}`); return true; }
  failures++; console.log(`FAIL ${name}${detail === undefined ? "" : " :: " + (typeof detail === "string" ? detail : JSON.stringify(detail))}`); return false;
}

function git(cwd, args) {
  const r = spawnSync("git", args, {cwd, encoding: "utf8", stdio: "pipe", env: withoutOuterGitGuard(process.env), shell: false});
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout || "").trim();
}

// The reviewer's verdict is switched between the two subprocess runs through
// a COMMITTED file, not an env var: the relay filters the adapter child
// environment to a fixed allowlist, so a committed repo file is the only
// channel that reaches the adapter in the plain repo and inside the
// read-only bind alike (same technique as workflow-order-harness.mjs).
const FAKE_AGENT = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("fake-feedback-agent 1.0.0\\n"); process.exit(0); }
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => { stdin += c; });
process.stdin.on("end", () => {
  const roleLine = (stdin.trimStart().split(/\\r?\\n/, 1)[0] || "");
  const role = roleLine.startsWith("ROLE=") ? roleLine.slice("ROLE=".length) : "";
  const sawDecision = stdin.includes("Operator decisions (binding");

  if (role === "planner") {
    // Support both old single-file and new split contract (v5: PLAN.md + TASKS.md)
    const planMatch = stdin.match(/Write the (?:narrative )?plan to exactly:\s*(.*)/);
    const tasksMatch = stdin.match(/Write the phased checklist to exactly:\s*(.*)/);
    const legacyMatch = !planMatch ? stdin.match(/Write the plan to exactly:\s*(.*)/) : null;
    const planPath = planMatch ? planMatch[1].trim() : legacyMatch ? legacyMatch[1].trim() : null;
    if (!planPath) { process.stderr.write("fake: no plan path\\n"); process.exit(1); }
    // Record the prompt this Planner actually received, so the test can
    // assert on it. Written beside the plan, inside the mission directory
    // the Planner is already allowed to write to.
    try { fs.writeFileSync(planPath.replace(/PLAN\.md$/, "LAST-PLANNER-PROMPT.txt"), stdin); } catch {}
    if (tasksMatch) {
      const tasksPath = tasksMatch[1].trim();
      fs.writeFileSync(planPath, "# Plan\\n\\nObjective: add a fixture line to README.md\\n\\nScope: single line.\\n");
      fs.writeFileSync(tasksPath, "## Phase 1: General\\n\\n- [ ] 1. Add a fixture line to README.md — accept: line added ; verify: check README.md\\n");
    } else if (planMatch) {
      // New prompt but no tasksMatch (should not happen, but handle)
      fs.writeFileSync(planPath, "# Plan\\n\\nObjective: add a fixture line to README.md\\n");
      const derivedTasks = planPath.replace(/PLAN\.md$/, "TASKS.md");
      fs.writeFileSync(derivedTasks, "## Phase 1: General\\n\\n- [ ] 1. Add a fixture line to README.md — accept: line added ; verify: check README.md\\n");
    } else {
      fs.writeFileSync(planPath, "# Plan\\n\\n## Checklist\\n\\n- [ ] 1. Add a fixture line to README.md\\n\\nVerification: manual.\\n");
    }
    process.stdout.write("Wrote the plan.\\n");
    process.exit(0);
  }

  if (role === "plan_reviewer") {
    const review = {decision: "FAIL", findings: [
      {location: "PLAN.md task 1", problem: "REVIEWER-" + (sawDecision ? "SAW" : "MISSED") + "-DECISION" + (stdin.includes("use the simple protocol") ? "-TEXT" : ""), correction: "add an explicit verification command"}
    ]};
    process.stdout.write("Reviewed.\\nAUTOPILOT_REVIEW=" + JSON.stringify(review) + "\\n");
    process.exit(0);
  }

  if (role === "implementer") {
    try { fs.appendFileSync("README.md", "implementer change\\n"); } catch {}
    // Per-task invocation requires exactly one task-result sentinel
    // (003#43 / TASK-25); a bare "Implemented." is STRUCTURED_OUTPUT_MISSING.
    process.stdout.write("Implemented.\\nAUTOPILOT_TASK_RESULT=" + JSON.stringify({summary: "added the fixture line to README.md", taskLocalCheck: {command: "grep implementer README.md", status: "passed", exitCode: 0, summary: "line present"}}) + "\\n");
    process.exit(0);
  }

  process.stdout.write("Done.\\nAUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: []}) + "\\n");
  process.exit(0);
});
`;

function makeBin() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-feedback-bin-"));
  const target = path.join(binDir, "cursor-agent");
  fs.writeFileSync(target, FAKE_AGENT);
  fs.chmodSync(target, 0o755);
  return binDir;
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-feedback-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "feedback-test@example.invalid"]);
  git(repo, ["config", "user.name", "Feedback Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}


function writeConfig(repo) {
  const role = {adapter: "cursor", model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null};
  const config = {
    schema_version: "3.0",
    project: {repo: ".", planning_framework: "standalone", state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs"},
    roles: {planner: role, plan_reviewer: role, implementer: role, code_reviewer: role, verifier: role},
    workflow: {
      specReview: true, planReview: true, analysisAfterTasks: true, implementationReview: true, finalReview: true,
      autoApproveSpec: false, autoApprovePlan: false, parallelIndependentTasks: false, gsdPlanningReview: false, standaloneSpec: false,
      relaySafety: {block_git_commit_push: true, verify_read_only_by_snapshot: true, capture_touched_files: true, persist_role_sessions: true}
    },
    gates: {commands: [], env_allowlist: [], require_reviewer: true, network_isolation: true},
    // One revision only: the first FAIL exhausts the budget and escalates,
    // which is the process-exit this test needs in order to restart.
    policy: {
      max_plan_revisions: 1, retry_delay_ms: 0, checkpoint_after_task: true, checkpoint_after_phase: true,
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


const REQUEST = "add a fixture line to README.md";
const DECISION = "use the simple protocol, no handshake";
const env = (binDir) => { const base = withoutOuterGitGuard({...process.env}); return {...base, PATH: `${binDir}:${base.PATH || ""}`}; };
function runMission(repo, binDir, request = null) {
  const args = [path.join(skillRoot, "scripts", "autopilot.mjs"), "run", ...(request ? [request] : []), "--repo", repo];
  return spawnSync(process.execPath, args, {cwd: repo, encoding: "utf8", env: env(binDir), timeout: 220000, stdio: ["ignore", "pipe", "pipe"], shell: false});
}
function ap(repo, binDir, args) {
  return spawnSync(process.execPath, [path.join(skillRoot, "bin", "ap.cjs"), ...args, "--repo", repo], {cwd: repo, encoding: "utf8", env: env(binDir), timeout: 60000, stdio: ["ignore", "pipe", "pipe"], shell: false});
}
const stateOf = (repo) => JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
const planFindings = (repo) => (stateOf(repo).reviewFeedback?.["standalone-plan"]?.findings || []).join("\n");
const queueFile = (repo) => path.join(repo, ".autopilot", "operator-decisions-queue.json");
function plannerPrompt(repo) {
  const missions = path.join(repo, ".autopilot", "missions");
  const out = [];
  for (const m of fs.existsSync(missions) ? fs.readdirSync(missions) : []) {
    const f = path.join(missions, m, "LAST-PLANNER-PROMPT.txt");
    if (fs.existsSync(f)) out.push(fs.readFileSync(f, "utf8"));
  }
  return out;
}
function clearPlannerPrompts(repo) {
  const missions = path.join(repo, ".autopilot", "missions");
  for (const m of fs.existsSync(missions) ? fs.readdirSync(missions) : []) fs.rmSync(path.join(missions, m, "LAST-PLANNER-PROMPT.txt"), {force: true});
}

// --- pure helpers (real functions)
{
  check("no decisions: no block, brief unchanged", operatorDecisionsBlock({}) === "" && withOperatorDecisions("brief", {}) === "brief");
  const s = {};
  addOperatorDecision(s, "pick design A", "2026-11-19T10:00:00.000Z");
  addOperatorDecision(s, "no new deps", "2026-11-20T10:00:00.000Z");
  const block = operatorDecisionsBlock(s);
  check("block has the exact header and dated lines", block === `${OPERATOR_DECISIONS_HEADER}\n- pick design A (2026-11-19)\n- no new deps (2026-11-20)`, block);
  check("header text is the specified one", OPERATOR_DECISIONS_HEADER === "Operator decisions (binding — reviewers judge the work against them, never against alternatives they rule out):");
  const once = withOperatorDecisions("brief", s);
  check("withOperatorDecisions appends once (idempotent)", once.startsWith("brief\n\n") && withOperatorDecisions(once, s) === once);
  const rep = renderOperatorDecisions({operatorDecisions: s.operatorDecisions});
  check("WATCH-REPORT section lists the decisions", rep.includes("=== Operator decisions ===") && rep.includes("- pick design A (2026-11-19)") && rep.includes("- no new deps (2026-11-20)"), rep);
  check("no decisions: section omitted", renderOperatorDecisions({}) === "");
}

// --- end to end
{
  const repo = makeRepo();
  const binDir = makeBin();
  let decoy = null;
  try {
    writeConfig(repo);
    const first = runMission(repo, binDir, REQUEST);
    check("run 1: mission escalated on plan review", first.status !== 0, {status: first.status, stderr: (first.stderr || "").slice(-300)});
    check("run 1: reviewer saw no decision block", planFindings(repo).includes("REVIEWER-MISSED-DECISION"), planFindings(repo));

    // validation
    const bare = ap(repo, binDir, ["note", "--yes"]);
    check("ap note without text or --clear is a usage error", bare.status === 2 && /usage: ap note/.test(bare.stderr), bare);
    const noYes = ap(repo, binDir, ["note", DECISION]);
    check("ap note without --yes and no TTY refuses, state untouched", noYes.status === 1 && /--yes/.test(noYes.stderr) && !stateOf(repo).operatorDecisions, noYes);

    // record (no live run -> state written directly)
    const rec = ap(repo, binDir, ["note", DECISION, "--yes"]);
    check("ap note records the decision in state", rec.status === 0 && stateOf(repo).operatorDecisions?.length === 1 && stateOf(repo).operatorDecisions[0].text === DECISION && !!stateOf(repo).operatorDecisions[0].at, {rec, d: stateOf(repo).operatorDecisions});
    const rec2 = ap(repo, binDir, ["note", "second decision", "--yes"]);
    check("ap note appends", rec2.status === 0 && stateOf(repo).operatorDecisions.length === 2, stateOf(repo).operatorDecisions);
    const clr = ap(repo, binDir, ["note", "--clear", "--yes"]);
    check("ap note --clear removes every decision", clr.status === 0 && !stateOf(repo).operatorDecisions, clr);
    ap(repo, binDir, ["note", DECISION, "--yes"]);

    // planner + plan reviewer briefs of the resumed mission carry the block
    clearPlannerPrompts(repo);
    runMission(repo, binDir);
    const prompts = plannerPrompt(repo);
    check("planner brief carries the block with the decision and date",
      prompts.length > 0 && prompts.every((p) => p.includes(OPERATOR_DECISIONS_HEADER) && p.includes(`- ${DECISION} (${new Date().toISOString().slice(0, 10)})`)), prompts.map((p) => p.slice(-300)));
    check("plan reviewer brief carries the block", planFindings(repo).includes("REVIEWER-SAW-DECISION-TEXT"), planFindings(repo));
    check("decision survives the run in state", stateOf(repo).operatorDecisions?.length === 1);

    // live run: the CLI queues instead of touching state.json
    decoy = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)", path.join(skillRoot, "scripts", "autopilot.mjs"), "run", "--repo", repo], {cwd: repo, stdio: "ignore"});
    await new Promise((r) => setTimeout(r, 400));
    const before = fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8");
    const live = ap(repo, binDir, ["note", "live decision about ordering", "--yes"]);
    check("live: ap note queues the decision and says so", live.status === 0 && /queued for the live run/.test(live.stdout) && fs.existsSync(queueFile(repo)), live);
    check("live: state.json is not touched by the CLI", fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8") === before);
    decoy.kill("SIGKILL"); decoy = null;
    await new Promise((r) => setTimeout(r, 300));
    clearPlannerPrompts(repo);
    runMission(repo, binDir);
    const livePrompts = plannerPrompt(repo);
    check("live: the next brief drains the queue into the block",
      livePrompts.length > 0 && livePrompts.every((p) => p.includes("live decision about ordering") && p.includes(DECISION)) && !fs.existsSync(queueFile(repo)), livePrompts.map((p) => p.slice(-300)));
    check("live: the drained decision is persisted in state", stateOf(repo).operatorDecisions?.some((d) => d.text === "live decision about ordering"), stateOf(repo).operatorDecisions);

    // a new mission clears decisions and any queued leftovers
    fs.writeFileSync(queueFile(repo), JSON.stringify({ops: [{op: "add", text: "stale queued", at: new Date().toISOString()}]}));
    clearPlannerPrompts(repo);
    runMission(repo, binDir, "add a different fixture line to README.md please");
    const fresh = plannerPrompt(repo);
    check("new mission: briefs carry no old decisions", fresh.length > 0 && fresh.every((p) => !p.includes(OPERATOR_DECISIONS_HEADER) && !p.includes(DECISION) && !p.includes("stale queued")), fresh.map((p) => p.slice(-200)));
    check("new mission: state and queue are clear", !stateOf(repo).operatorDecisions && !fs.existsSync(queueFile(repo)), stateOf(repo).operatorDecisions);
  } finally {
    if (decoy) decoy.kill("SIGKILL");
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(binDir, {recursive: true, force: true});
  }
}

{
  const help = spawnSync(process.execPath, [path.join(skillRoot, "bin", "ap.cjs"), "help"], {encoding: "utf8"});
  check("help lists ap note", /ap note "<decision>" \[--yes\] \[--repo <path>\]/.test(help.stdout), help.stdout.slice(0, 200));
  const skill = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
  check("SKILL.md documents ap note", skill.includes("### `ap note \"<decision>\" [--yes]` / `ap note --clear`"));
}

if (failures) { console.error(`${failures} operator-note check(s) failed.`); process.exit(1); }
console.log("test-operator-note: ALL CHECKS PASSED");
