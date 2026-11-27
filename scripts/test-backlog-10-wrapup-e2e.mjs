#!/usr/bin/env node
// Backlog #10 end-to-end test (requires Linux/WSL2 bubblewrap):
// 1. Fake `claude` adapter keeps sessions under $HOME/.claude/projects/repo/.
//    Wrap-up resume (--resume <sid>) finds the capped run's session (no
//    "No conversation found") and writes a fresh note -> next session PASSes.
// 2. Unchanged fallback note twice in a row -> stops with CODE_REVIEW_CAPPED_TWICE
//    instead of starting another identical session.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {loadAndMigrateConfig} from "./config-migration.mjs";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");
let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`); }
};

if (process.platform === "win32") {
  console.log("test-backlog-10-wrapup-e2e: SKIP - requires Linux/WSL2 with bubblewrap.");
  process.exit(0);
}

function git(cwd, args) {
  const r = spawnSync("git", args, {cwd, encoding: "utf8", stdio: "pipe", env: withoutOuterGitGuard(process.env), shell: false});
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout || "").trim();
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-b10-e2e-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "b10@example.invalid"]);
  git(repo, ["config", "user.name", "Backlog 10 Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "init\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

function makeFakeClaude(binDir, mode) {
  const launcherPath = path.join(binDir, "claude");
  fs.copyFileSync(path.join(here, "test-fixtures", "fake-claude-launcher.sh"), launcherPath);
  fs.chmodSync(launcherPath, 0o755);

  const targetPath = path.join(binDir, "claude.com");
  fs.writeFileSync(targetPath, `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write("2.1.0 (Claude Code)\\n");
  process.exit(0);
}

const home = process.env.HOME;
const store = path.join(home, ".claude", "projects", "repo");
const resumeIdx = args.indexOf("--resume");
const mode = ${JSON.stringify(mode)};

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { stdin += chunk; });
process.stdin.on("end", () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const emit = obj => process.stdout.write(JSON.stringify(obj) + "\\n");
  const usage = {input_tokens: 500, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0};

  (async () => {
    if (resumeIdx !== -1) {
      const sid = args[resumeIdx + 1];
      const sfile = path.join(store, sid + ".jsonl");
      if (!fs.existsSync(sfile)) {
        emit({type: "result", is_error: true, errors: ["No conversation found with session ID: " + sid]});
        process.exit(1);
      }
      if (mode === "wrapup_writes_note") {
        const match = /Write your hand-off note NOW to (\\S+)/.exec(stdin);
        if (match) {
          const notePath = match[1].replace(/[.,;:]+$/, "");
          fs.mkdirSync(path.dirname(notePath), {recursive: true});
          fs.writeFileSync(notePath, "## Checked\\n- README.md (WRAPUP-E2E-NOTE-MARKER)\\n\\n## Next\\nEmit final PASS.\\n");
          fs.writeFileSync(path.join(path.dirname(notePath), "wrapup-resume.json"), JSON.stringify({resumeId: sid, notePath}));
        }
        emit({type: "assistant", message: {id: "msg-w1", usage, content: [{type: "text", text: "wrote note"}]}});
        emit({type: "result", session_id: sid, result: "wrote note"});
        process.exit(0);
      }
      // mode === "unchanged_twice": wrap-up fails without writing note
      emit({type: "result", is_error: true, errors: ["wrap-up refused"]});
      process.exit(1);
    }

    const sid = "b10-sess-" + process.pid;
    fs.mkdirSync(store, {recursive: true});
    fs.writeFileSync(path.join(store, sid + ".jsonl"), '{"type":"assistant"}\\n');
    emit({type: "system", subtype: "init", session_id: sid});

    const roleLine = (stdin.trimStart().split(/\\r?\\n/, 1)[0] || "");
    const role = roleLine.startsWith("ROLE=") ? roleLine.slice("ROLE=".length) : "";

    const finish = text => {
      emit({type: "assistant", message: {id: "msg-1", usage, content: [{type: "text", text}]}});
      emit({type: "result", session_id: sid, subtype: "success", is_error: false, result: text, terminal_reason: "completed"});
      process.exit(0);
    };

    if (role === "planner") {
      const planMatch = stdin.match(/Write the (?:narrative )?plan to exactly:\\s*(.*)/);
      const tasksMatch = stdin.match(/Write the phased checklist to exactly:\\s*(.*)/);
      const legacyM = !planMatch ? stdin.match(/Write the plan to exactly:\\s*(.*)/) : null;
      const planPath = planMatch ? planMatch[1].trim() : legacyM ? legacyM[1].trim() : null;
      if (!planPath) { process.stderr.write("fake-claude: no plan path in prompt\\n"); process.exit(1); }
      if (tasksMatch) {
        fs.writeFileSync(planPath, "# Plan\\n\\nObjective: add a fixture line to README.md\\n");
        fs.writeFileSync(tasksMatch[1].trim(), "## Phase 1: General\\n\\n- [ ] 1. Add a fixture line to README.md — accept: done ; verify: check\\n");
      } else if (planMatch) {
        fs.writeFileSync(planPath, "# Plan\\n\\nObjective: add a fixture line to README.md\\n");
        fs.writeFileSync(planPath.replace(/PLAN\\.md$/, "TASKS.md"), "## Phase 1: General\\n\\n- [ ] 1. Add a fixture line to README.md — accept: done ; verify: check\\n");
      } else {
        fs.writeFileSync(planPath, "# Plan\\n\\n## Checklist\\n\\n- [ ] 1. Add a fixture line to README.md\\n\\nVerification: manual.\\n");
      }
      return finish("Wrote the plan.");
    }

    if (role === "plan_reviewer") {
      return finish("AUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: []}));
    }

    if (role === "implementer") {
      try { fs.appendFileSync("README.md", "implementer change\\n"); } catch {}
      const taskResult = "AUTOPILOT_TASK_RESULT=" + JSON.stringify({
        summary: "Added a fixture line to README.md.",
        taskLocalCheck: {command: "check", status: "passed", exitCode: 0, summary: "fixture check passed"}
      });
      return finish("Implemented the task.\\n" + taskResult);
    }

    if (role === "code_reviewer") {
      if (mode === "wrapup_writes_note" && stdin.includes("WRAPUP-E2E-NOTE-MARKER")) {
        return finish("AUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: []}));
      }
      // Emit 3 assistant turns to trigger caps.final_review_max_turns=2 and hold open for the 1s cap monitor.
      for (let i = 1; i <= 3; i += 1) {
        emit({type: "assistant", message: {id: "msg-" + i, usage, content: [{type: "text", text: "turn " + i}]}});
        await sleep(30);
      }
      await sleep(4000);
      return finish("AUTOPILOT_REVIEW=" + JSON.stringify({decision: "INCOMPLETE", findings: []}));
    }

    if (role === "verifier") {
      return finish("AUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: []}));
    }

    process.stderr.write("fake-claude: unknown ROLE '" + role + "'\\n");
    process.exit(1);
  })();
});
`, "utf8");
  fs.chmodSync(targetPath, 0o755);
}

function makeConfig(repo, {finalReviewMaxTurns = 2} = {}) {
  const claudeRole = {adapter: "claude", model: "sonnet", reasoning: "low", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null};
  const cfg = {
    schema_version: "3.0",
    project: {repo: ".", planning_framework: "standalone", state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs"},
    roles: {planner: claudeRole, plan_reviewer: claudeRole, implementer: claudeRole, code_reviewer: claudeRole, verifier: claudeRole},
    workflow: {
      specReview: true, planReview: true, analysisAfterTasks: true, implementationReview: false, finalReview: true,
      autoApproveSpec: false, autoApprovePlan: false, parallelIndependentTasks: false, gsdPlanningReview: false, standaloneSpec: false,
      relaySafety: {block_git_commit_push: true, verify_read_only_by_snapshot: true, capture_touched_files: true, persist_role_sessions: true}
    },
    gates: {commands: [], env_allowlist: [], require_reviewer: true, network_isolation: true},
    policy: {
      max_plan_revisions: 3, retry_delay_ms: 0, checkpoint_after_task: true, checkpoint_after_phase: true,
      require_human_commit: true, fail_closed_on_relay_violation: true,
      failure_budgets: {implementationFailureBudget: 5, verificationFailureBudget: 5, adapterRetryBudget: 5, infrastructureRetryBudget: 5},
      caps: {code_reviewer: {max_turns: 1, max_tokens: 250000, extra_sessions: 3, wrap_up_at_tokens: 225000}},
      final_review_max_turns: finalReviewMaxTurns,
    },
    safety: {allow_git_commit: false, allow_git_push: false, allow_destructive_operations: false},
    planning: {
      speckit: {workflow_file: ".specify/workflows/speckit/workflow.yml", task_candidates: [".specify/tasks.md", "specs/*/tasks.md", "specs/*/tasks/*.md"]},
      gsd: {phase_root: ".planning/phases", run_plan_verify: true, run_state_validate: true, write_summary_artifacts: true, write_verification_artifacts: true, write_uat_artifact: true, use_gsd_tools_when_available: false, parallelization: {enabled: false, plan_level: false, task_level: false, max_concurrent_agents: 1, min_plans_for_parallel: 99}, planning_review: {enabled: false, review_after_each_stage: true, stages: ["discuss", "research", "plan", "plan-check"], max_revisions: 3, read_only_reviewer: true}}
    },
    capabilities: {project_defaults: [], role_requirements: {}, safety_denied: [], legacy_text_inference: false, verification: {browser: "native", require_browser: "when-task-requires"}}
  };
  const cfgFile = path.join(repo, ".autopilot", "config.json");
  fs.mkdirSync(path.dirname(cfgFile), {recursive: true});
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  loadAndMigrateConfig(cfgFile, {persist: true});
}

function findFiles(root, predicate) {
  const found = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (predicate(full, entry.name)) found.push(full);
    }
  })(root);
  return found;
}

// Scenario 1: wrap-up resume finds capped session in wrap-up sandbox and writes fresh note
{
  const repo = makeRepo();
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-b10-bin1-"));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ap-b10-home1-"));
  try {
    makeConfig(repo, {finalReviewMaxTurns: 2});
    makeFakeClaude(binDir, "wrapup_writes_note");
    const env = {...withoutOuterGitGuard({...process.env}), HOME: fakeHome, PATH: `${binDir}:${process.env.PATH || ""}`};
    const r = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "autopilot.mjs"), "run", "add a fixture line to README.md", "--repo", repo], {
      cwd: repo, env, encoding: "utf8", timeout: 180000, stdio: ["ignore", "pipe", "pipe"], shell: false
    });
    const combinedOut = `${r.stdout || ""}\n${r.stderr || ""}`;
    check("e2e wrap-up resume: mission completes (exit 0)", r.status === 0, {status: r.status, stderr: r.stderr?.slice(-600), stdout: r.stdout?.slice(-600)});
    check("e2e wrap-up resume: no 'No conversation found' error", !/No conversation found/i.test(combinedOut));

    const results = findFiles(path.join(repo, ".autopilot"), (_f, n) => n === "result.json")
      .map(f => ({file: f, data: JSON.parse(fs.readFileSync(f, "utf8"))}));
    const cappedCr = results.find(x => x.data.role === "code_reviewer" && x.data.capped?.wrapUp === true);
    check("e2e wrap-up resume: capped code_reviewer run recorded", Boolean(cappedCr), results.filter(x => x.data.role === "code_reviewer").map(x => x.data));
    if (cappedCr) {
      check("e2e wrap-up resume: wrap-up status is model_wrote with resumedSession=true",
        cappedCr.data.wrapUp?.status === "model_wrote" && cappedCr.data.wrapUp?.resumedSession === true,
        cappedCr.data.wrapUp);
      const progressPath = path.join(path.dirname(cappedCr.file), "progress.log");
      const progress = fs.existsSync(progressPath) ? fs.readFileSync(progressPath, "utf8") : "";
      check("e2e wrap-up resume: progress log records model_wrote",
        /WRAP_UP \| STATUS=model_wrote/.test(progress) && /PATH=model_wrote/.test(progress));
      const wrapUpRuns = findFiles(path.join(repo, ".autopilot"), (_f, n) => n === "status.json")
        .filter(f => {
          try { return JSON.parse(fs.readFileSync(f, "utf8")).note === "wrap-up"; } catch { return false; }
        })
        .map(f => {
          const rFile = path.join(path.dirname(f), "result.json");
          return fs.existsSync(rFile) ? JSON.parse(fs.readFileSync(rFile, "utf8")) : null;
        })
        .filter(Boolean);
      const wrapArgs = wrapUpRuns[0]?.invocation?.args || [];
      const rIdx = wrapArgs.indexOf("--resume");
      const resumedSid = rIdx !== -1 ? wrapArgs[rIdx + 1] : null;
      check("e2e wrap-up resume: resumed the capped session ID",
        Boolean(resumedSid) && resumedSid === cappedCr.data.sessionId,
        {resumedSid, sessionId: cappedCr.data.sessionId, wrapArgs});
    }
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(binDir, {recursive: true, force: true});
    fs.rmSync(fakeHome, {recursive: true, force: true});
  }
}

// Scenario 2: unchanged fallback note twice in a row -> stops with CODE_REVIEW_CAPPED_TWICE
{
  const repo = makeRepo();
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-b10-bin2-"));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ap-b10-home2-"));
  try {
    makeConfig(repo, {finalReviewMaxTurns: 2});
    makeFakeClaude(binDir, "unchanged_twice");
    const env = {...withoutOuterGitGuard({...process.env}), HOME: fakeHome, PATH: `${binDir}:${process.env.PATH || ""}`};
    const r = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "autopilot.mjs"), "run", "add a fixture line to README.md", "--repo", repo], {
      cwd: repo, env, encoding: "utf8", timeout: 180000, stdio: ["ignore", "pipe", "pipe"], shell: false
    });
    const combinedOut = `${r.stdout || ""}\n${r.stderr || ""}`;
    check("e2e unchanged-twice: mission stops non-zero", r.status !== 0, {status: r.status});
    check("e2e unchanged-twice: no 'No conversation found' error", !/No conversation found/i.test(combinedOut));

    const stateFiles = findFiles(path.join(repo, ".autopilot"), (_f, n) => n === "state.json");
    const states = stateFiles.map(f => JSON.parse(fs.readFileSync(f, "utf8")));
    const escalated = states.find(s => s.phaseCheckpointError?.code === "CODE_REVIEW_CAPPED_TWICE");
    check("e2e unchanged-twice: escalated with CODE_REVIEW_CAPPED_TWICE",
      Boolean(escalated) && escalated.phase === "escalated" && escalated.step === "final_review_not_converging",
      states.map(s => ({phase: s.phase, step: s.step, err: s.phaseCheckpointError})));

    const crRuns = findFiles(path.join(repo, ".autopilot"), (_f, n) => n === "result.json")
      .filter(f => {
        const sFile = path.join(path.dirname(f), "status.json");
        try { if (fs.existsSync(sFile) && JSON.parse(fs.readFileSync(sFile, "utf8")).note === "wrap-up") return false; } catch {}
        return true;
      })
      .map(f => JSON.parse(fs.readFileSync(f, "utf8")))
      .filter(d => d.role === "code_reviewer");
    check("e2e unchanged-twice: stopped after 3 capped sessions (did not start a 4th)",
      crRuns.length === 3, crRuns.length);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(binDir, {recursive: true, force: true});
    fs.rmSync(fakeHome, {recursive: true, force: true});
  }
}

if (failures) {
  console.error(`${failures} backlog-10 e2e check(s) failed.`);
  process.exit(1);
}
console.log("backlog-10 e2e checks passed");
