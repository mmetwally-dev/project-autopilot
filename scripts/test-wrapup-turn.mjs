#!/usr/bin/env node
// Backlog #8: wrap-up turn = resume the SAME CLI session for one short turn
// that writes the hand-off note, then fall back to the orchestrator note.
//
// Part A (pure): runModelWrapUpTurn() branches - resumed turn wrote a fresh
// note (model_wrote), turn left it stale, turn failed / threw, not resumable
// (no spawn at all), and the note-fresh path never reaches it (static order).
// Part B (real relay, Linux/WSL, read-only role): a capped plan_reviewer
// (fake claude) writes NO note; the orchestrator resumes the session
// (--resume <id>) for a wrap-up turn that writes the SCRATCH note, which is
// copied to the repo hand-off path; status model_wrote, no fallback note.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {runModelWrapUpTurn, WRAPUP_MAX_TURNS} from "./per-task-budget.mjs";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");
let failures = 0;
const check = (name, condition, detail) => {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`); }
};

// ── Part A ──
{
  let spawned = 0;
  const wrote = await runModelWrapUpTurn({
    resumable: true,
    spawnTurn: async () => { spawned += 1; return {status: "completed", usage: {turns: 1}}; },
    noteIsFresh: () => spawned === 1
  });
  check("A1: resumed turn + fresh note -> wrote", wrote.wrote === true && wrote.reason === "resumed_session" && spawned === 1 && wrote.usage?.turns === 1, wrote);

  spawned = 0;
  const stale = await runModelWrapUpTurn({
    resumable: true,
    spawnTurn: async () => { spawned += 1; return {status: "completed", usage: {turns: 2}}; },
    noteIsFresh: () => false
  });
  check("A2: turn completed but note still stale -> fallback signal", stale.wrote === false && stale.reason === "note_still_stale" && spawned === 1, stale);

  const failed = await runModelWrapUpTurn({
    resumable: true,
    spawnTurn: async () => ({status: "failed"}),
    noteIsFresh: () => false
  });
  check("A3: failed turn, stale note -> fallback signal", failed.wrote === false && failed.reason === "turn_failed", failed);

  const threw = await runModelWrapUpTurn({
    resumable: true,
    spawnTurn: async () => { throw new Error("boom"); },
    noteIsFresh: () => true
  });
  check("A4: spawn throws -> never throws, fallback signal", threw.wrote === false && threw.reason.startsWith("turn_error:boom"), threw);

  const timedOutButWrote = await runModelWrapUpTurn({
    resumable: true,
    spawnTurn: async () => ({status: "failed"}),
    noteIsFresh: () => true
  });
  check("A5: turn failed/timed out but a fresh note exists -> still wrote", timedOutButWrote.wrote === true, timedOutButWrote);

  spawned = 0;
  const noResume = await runModelWrapUpTurn({
    resumable: false,
    spawnTurn: async () => { spawned += 1; return {status: "completed"}; },
    noteIsFresh: () => true
  });
  check("A6: not resumable -> no spawn, straight to fallback", noResume.wrote === false && noResume.reason === "not_resumable" && spawned === 0, noResume);

  const throwsFresh = await runModelWrapUpTurn({
    resumable: true,
    spawnTurn: async () => ({status: "completed"}),
    noteIsFresh: () => { throw new Error("stat failed"); }
  });
  check("A7: freshness check throwing counts as stale", throwsFresh.wrote === false, throwsFresh);

  const src = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
  const i = src.indexOf("const runWrapUp=async()=>{");
  const closure = src.slice(i, src.indexOf("result.wrapUp=await runWrapUp();"));
  check("A8: freshness is checked before any turn is spawned (note_fresh skip first)",
    closure.indexOf('reason:"note_fresh"') !== -1 && closure.indexOf('reason:"note_fresh"') < closure.indexOf("runModelWrapUpTurn("));
  check("A9: wrap-up turn is bounded (WRAPUP_MAX_TURNS ceiling, wall clock) and never re-triggers a wrap-up",
    WRAPUP_MAX_TURNS === 3 && /timeoutMs:WRAPUP_TIMEOUT_MS/.test(closure) && /isWrapUp:true/.test(closure)
    && /capEnabled && !isWrapUp && capBreach\?\.wrapUp/.test(src));
}

// ── Part B ──
if (process.platform === "win32") {
  console.log("test-wrapup-turn: Part B SKIP - requires Linux/WSL2 with bubblewrap.");
} else {
  function git(cwd, args) {
    const r = spawnSync("git", args, {cwd, encoding: "utf8", stdio: "pipe", env: withoutOuterGitGuard(process.env), shell: false});
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
    return (r.stdout || "").trim();
  }

  function makeRepo() {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-wrapup-turn-"));
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "claude-scratch-note@example.invalid"]);
    git(repo, ["config", "user.name", "Claude Scratch Note Test"]);
    fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "init"]);
    return repo;
  }

  function makeConfig(repo) {
    const config = {
      schema_version: "3.0",
      project: {repo: ".", planning_framework: "standalone", state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs"},
      roles: {
        planner: {adapter: "cursor", model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null},
        plan_reviewer: {adapter: "claude", model: "sonnet", reasoning: "low", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null},
        implementer: {adapter: "cursor", model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null},
        code_reviewer: {adapter: "cursor", model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null},
        verifier: {adapter: "cursor", model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null}
      },
      workflow: {
        specReview: true, planReview: true, analysisAfterTasks: true, implementationReview: true, finalReview: true,
        autoApproveSpec: false, autoApprovePlan: false, parallelIndependentTasks: false, gsdPlanningReview: false, standaloneSpec: false,
        relaySafety: {block_git_commit_push: true, verify_read_only_by_snapshot: true, capture_touched_files: true, persist_role_sessions: true}
      },
      gates: {commands: [], env_allowlist: [], require_reviewer: true, network_isolation: true},
      policy: {
        max_plan_revisions: 3, retry_delay_ms: 0, checkpoint_after_task: true, checkpoint_after_phase: true,
        require_human_commit: true, fail_closed_on_relay_violation: true,
        failure_budgets: {implementationFailureBudget: 5, verificationFailureBudget: 5, adapterRetryBudget: 5, infrastructureRetryBudget: 5},
        caps: {plan_reviewer: {max_turns: 2, max_tokens: 300000, extra_sessions: 0}}
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

  function makeBin() {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-wrapup-turn-bin-"));
    const cursorAgentPath = path.join(binDir, "cursor-agent");
    fs.copyFileSync(path.join(here, "test-fixtures", "relay-scratch-probe-adapter.sh"), cursorAgentPath);
    fs.chmodSync(cursorAgentPath, 0o755);

    const claudeLauncherPath = path.join(binDir, "claude");
    fs.copyFileSync(path.join(here, "test-fixtures", "fake-claude-launcher.sh"), claudeLauncherPath);
    fs.chmodSync(claudeLauncherPath, 0o755);
    const claudeTargetPath = path.join(binDir, "claude.com");
    fs.copyFileSync(path.join(here, "test-fixtures", "fake-claude-wrapup-target.cjs"), claudeTargetPath);
    fs.chmodSync(claudeTargetPath, 0o755);
    return binDir;
  }

  function runMission(repo, binDir) {
    const delimiter = process.platform === "win32" ? ";" : ":";
    const base = withoutOuterGitGuard({...process.env});
    const env = {...base, PATH: `${binDir}${delimiter}${base.PATH || ""}`};
    return spawnSync(process.execPath, [path.join(skillRoot, "scripts", "autopilot.mjs"), "run", "add a fixture line to README.md", "--repo", repo], {
      cwd: repo, encoding: "utf8", env, timeout: 180000, stdio: ["ignore", "pipe", "pipe"], shell: false
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
    return files;
  }

  function findRole(root, role) {
    for (const file of readAllResults(root)) {
      const result = JSON.parse(fs.readFileSync(file, "utf8"));
      if (result.role === role) return {file, result};
    }
    return null;
  }

  function findFile(root, predicate) {
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

  const repo = makeRepo();
  const binDir = makeBin();
  try {
    makeConfig(repo);
    const run = runMission(repo, binDir);
    const pr = findRole(path.join(repo, ".autopilot"), "plan_reviewer");
    check("plan_reviewer relay produced a result.json", pr != null,
      `run.status=${run.status} stdout=${(run.stdout || "").slice(-1500)} stderr=${(run.stderr || "").slice(-1500)}`);
    if (pr) {
      check("read-only role was capped with the wrap-up flag", pr.result.capped?.wrapUp === true, pr.result.capped);
      check("wrap-up recorded model_wrote (resumed session wrote the scratch note)",
        pr.result.wrapUp?.status === "model_wrote" && pr.result.wrapUp?.resumedSession === true, pr.result.wrapUp);
      const runDir = path.dirname(pr.file);
      const progress = fs.existsSync(path.join(runDir, "progress.log")) ? fs.readFileSync(path.join(runDir, "progress.log"), "utf8") : "";
      check("progress log records the model_wrote path", /WRAP_UP \| STATUS=model_wrote/.test(progress) && /PATH=model_wrote/.test(progress));
      const resumeRecords = findFile(path.join(repo, ".autopilot"), (_f, name) => name === "wrapup-resume.json");
      const rec = resumeRecords.length ? JSON.parse(fs.readFileSync(resumeRecords[0], "utf8")) : null;
      check("the SAME session was resumed (--resume fixture-claude-session)", rec?.resumeId === "fixture-claude-session", rec);
      check("the prompt pointed at the scratch note path (/workspace/scratch/...)", typeof rec?.notePath === "string" && rec.notePath.startsWith("/workspace/scratch/") && rec.notePath.endsWith("standalone-planning-plan_reviewer.md"), rec);
      const wrapRuns = readAllResults(path.join(repo, ".autopilot")).map(f => JSON.parse(fs.readFileSync(f, "utf8"))).filter(r => r.role === "plan_reviewer");
      const wrapStatus = findFile(path.join(repo, ".autopilot"), (_f, name) => name === "status.json")
        .map(f => JSON.parse(fs.readFileSync(f, "utf8"))).filter(s => s.note === "wrap-up");
      check("exactly one wrap-up run recorded for the capped run", wrapStatus.length === 1, wrapStatus.length);
      const repoNotes = findFile(path.join(repo, ".autopilot", "missions"), (_f, name) => name === "standalone-planning-plan_reviewer.md");
      check("scratch note copied to the repo hand-off path", repoNotes.length > 0, repoNotes);
      if (repoNotes.length > 0) {
        const copied = fs.readFileSync(repoNotes[0], "utf8");
        check("repo note is the model's (marker present)", copied.includes("WRAPUP-RESUME-MARKER"), copied.slice(0, 300));
        check("repo note is not the orchestrator fallback", !/orchestrator fallback/i.test(copied), copied.slice(0, 300));
      }
      void wrapRuns;
    }
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(binDir, {recursive: true, force: true});
  }
}

if (failures) {
  console.error(`${failures} wrap-up turn check(s) failed.`);
  process.exit(1);
}
console.log("test-wrapup-turn: ALL CHECKS PASSED");
