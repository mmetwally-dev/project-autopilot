#!/usr/bin/env node
// Backlog #2 — Claude read-only roles must be able to write their scratch
// hand-off note, and a capped reviewer's fresh note must survive wrap-up.
//
// Part A (pure argv): every Claude read-only role (plan_reviewer,
// code_reviewer, verifier), on both the standalone and SpecKit refs, is
// launched in `--permission-mode default` with the read-only allow list
// (Read/Glob/Grep/Bash) plus Write/Edit rules scoped to the exact scratch
// path the prompt names — never plan mode and never a bare write tool.
//
// Part B (real relay, Linux/WSL only): a real `node scripts/autopilot.mjs
// run` mission with a fake `claude` plan_reviewer. The fake proves the repo
// stays unwritable, writes its scratch hand-off note, then streams enough
// turns to trip a low cap. The wrap-up path must pick the fresh note
// (reason `note_fresh`) and copy it to the repo hand-off path, rather than
// overwriting it with the orchestrator fallback.
//
// Requires Linux/WSL (bubblewrap filesystem containment for read-only
// roles). Skips on native Windows, where the disposable-copy path is used.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {buildRelayArgsForTests} from "./autopilot.mjs";
import {CLAUDE_READ_ONLY_ALLOWED_TOOLS} from "./adapter-drivers.mjs";
import {SCRATCH_HANDOFF_NOTE_DEFAULT_DIR, scratchHandoffNotePath} from "./per-task-budget.mjs";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${detail ? ` :: ${detail}` : ""}`); }
};

function allowedToolsOf(argv) {
  const tools = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== "--allowedTools") continue;
    for (let j = i + 1; j < argv.length && !String(argv[j]).startsWith("--"); j += 1) tools.push(argv[j]);
  }
  return tools;
}

function permissionModesOf(argv) {
  const modes = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--permission-mode") modes.push(argv[i + 1]);
  }
  return modes;
}

// ── Part A: launch argv for every read-only role/loop ───────────────────────
{
  const agents = JSON.parse(fs.readFileSync(path.join(skillRoot, "adapters", "agents.json"), "utf8")).adapters;
  const claude = agents.claude;
  assert.ok(claude, "claude adapter must exist in agents.json");

  const roleFor = name => ({
    adapter: "claude", model: "sonnet", reasoning: "low", variant: "", resume: false,
    model_source: "default", model_verified_at: null, capabilities_verified_at: null, name
  });
  const refs = {
    plan_reviewer: ["standalone-planning-plan_reviewer", "speckit-planning-plan_reviewer"],
    code_reviewer: ["standalone-phase-code_reviewer", "speckit-phase-code_reviewer"],
    verifier: ["standalone-task-verifier", "speckit-task-verifier"]
  };
  const scratch = SCRATCH_HANDOFF_NOTE_DEFAULT_DIR;
  const expectedScratchRules = ["Write(//workspace/scratch/**)", "Edit(//workspace/scratch/**)"];

  for (const [roleName, taskRefs] of Object.entries(refs)) {
    for (const taskRef of taskRefs) {
      const args = buildRelayArgsForTests(
        roleFor(roleName), claude, true, false, {}, {scratchPath: scratch}
      );
      const tools = allowedToolsOf(args);
      check(
        `${roleName}/${taskRef}: default mode exactly once`,
        permissionModesOf(args).length === 1 && permissionModesOf(args)[0] === "default",
        args.join(" ")
      );
      check(
        `${roleName}/${taskRef}: never plan mode`,
        !permissionModesOf(args).includes("plan"),
        args.join(" ")
      );
      check(
        `${roleName}/${taskRef}: read tools + Bash present`,
        CLAUDE_READ_ONLY_ALLOWED_TOOLS.every(tool => tools.includes(tool)),
        JSON.stringify(tools)
      );
      check(
        `${roleName}/${taskRef}: scratch-only Write/Edit rules, no bare Write/Edit`,
        expectedScratchRules.every(rule => tools.includes(rule))
          && !tools.includes("Write") && !tools.includes("Edit"),
        JSON.stringify(tools)
      );
      check(
        `${roleName}/${taskRef}: no write rule outside the scratch mount`,
        tools.filter(rule => /^(Write|Edit)\(/.test(rule)).every(rule => expectedScratchRules.includes(rule)),
        JSON.stringify(tools)
      );
      check(
        `${roleName}/${taskRef}: no bypass flag`,
        !args.some(arg => String(arg).toLowerCase().includes("dangerously-skip-permissions")
          || String(arg).toLowerCase().includes("bypasspermissions")),
        args.join(" ")
      );
      check(
        `${roleName}/${taskRef}: note path is under the granted scratch tree`,
        path.posix.dirname(scratchHandoffNotePath(scratch, taskRef)) === scratch,
        `${scratchHandoffNotePath(scratch, taskRef)} vs ${scratch}`
      );
    }
  }

  // Dynamic host path (Windows disposable workspaces use a real host dir):
  // the rule must be ONE argv element naming that exact tree, with no
  // hard-coded /workspace/scratch leftover.
  const hostScratch = path.join(os.tmpdir(), "ap claude scratch note", "scratch");
  const hostArgs = buildRelayArgsForTests(
    roleFor("plan_reviewer"), claude, true, false, {}, {scratchPath: hostScratch}
  );
  const hostTools = allowedToolsOf(hostArgs);
  const hostBase = `//${hostScratch.replace(/\\/g, "/").replace(/^\/+/, "")}`;
  check(
    "dynamic scratch path: Write/Edit rules name the exact host tree",
    hostTools.includes(`Write(${hostBase}/**)`) && hostTools.includes(`Edit(${hostBase}/**)`)
      && !hostTools.some(rule => rule.includes("/workspace/scratch/")),
    JSON.stringify(hostTools)
  );

  const noScratchArgs = buildRelayArgsForTests(roleFor("plan_reviewer"), claude, true, false, {}, {});
  check(
    "no scratch path: no Write/Edit grant at all",
    !allowedToolsOf(noScratchArgs).some(rule => /^(Write|Edit)\(/.test(rule)),
    JSON.stringify(allowedToolsOf(noScratchArgs))
  );
}

// ── Part B: capped real-relay run picks the fresh scratch note ──────────────
if (process.platform === "win32") {
  console.log("test-claude-readonly-scratch-note: Part B SKIP — requires Linux/WSL2 with bubblewrap (bwrap); native Windows uses the disposable-copy path.");
} else {
  function git(cwd, args) {
    const r = spawnSync("git", args, {cwd, encoding: "utf8", stdio: "pipe", env: withoutOuterGitGuard(process.env), shell: false});
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
    return (r.stdout || "").trim();
  }

  function makeRepo() {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-claude-scratch-note-"));
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
        autoApproveSpec: false, autoApprovePlan: false, parallelIndependentTasks: false, gsdPlanningReview: false,
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
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-claude-scratch-note-bin-"));
    const cursorAgentPath = path.join(binDir, "cursor-agent");
    fs.copyFileSync(path.join(here, "test-fixtures", "relay-scratch-probe-adapter.sh"), cursorAgentPath);
    fs.chmodSync(cursorAgentPath, 0o755);

    const claudeLauncherPath = path.join(binDir, "claude");
    fs.copyFileSync(path.join(here, "test-fixtures", "fake-claude-launcher.sh"), claudeLauncherPath);
    fs.chmodSync(claudeLauncherPath, 0o755);
    const claudeTargetPath = path.join(binDir, "claude.com");
    fs.copyFileSync(path.join(here, "test-fixtures", "fake-claude-scratch-note-target.cjs"), claudeTargetPath);
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
      `run.status=${run.status} stdout=${(run.stdout || "").slice(-2000)} stderr=${(run.stderr || "").slice(-2000)}`);

    if (pr) {
      const runDir = path.dirname(pr.file);
      const scratchDir = path.join(runDir, "scratch");
      const observationPath = path.join(scratchDir, "e2e-observation.json");
      const observation = fs.existsSync(observationPath)
        ? JSON.parse(fs.readFileSync(observationPath, "utf8"))
        : null;

      check("fake claude wrote its observation", observation != null, observationPath);
      check("fake claude wrote the scratch hand-off note", observation?.noteWritten === true, JSON.stringify(observation));
      check("repository stayed unwritable for the read-only role", observation?.repoWriteRefused === true, JSON.stringify(observation));
      check("fake claude saw default mode", permissionModesOf(observation?.argv || []).join(",") === "default", JSON.stringify(observation?.argv));
      check("fake claude saw the scratch-only Write/Edit grant",
        ["Write(//workspace/scratch/**)", "Edit(//workspace/scratch/**)"].every(rule => (observation?.allowedTools || []).includes(rule)),
        JSON.stringify(observation?.allowedTools));
      check("fake claude received the plan_reviewer prompt", String(observation?.stdinLength || 0) > 0, JSON.stringify(observation?.stdinLength));

      check("plan_reviewer run was capped", pr.result.capped != null, JSON.stringify(pr.result.capped));
      check("cap breach requested wrap-up", pr.result.capped?.wrapUp === true, JSON.stringify(pr.result.capped));
      check("wrap-up skipped because the scratch note was fresh", pr.result.wrapUp?.reason === "note_fresh",
        JSON.stringify(pr.result.wrapUp));

      const progressPath = path.join(runDir, "progress.log");
      const progress = fs.existsSync(progressPath) ? fs.readFileSync(progressPath, "utf8") : "";
      check("progress log records PATH=note_fresh", /WRAP_UP \| STATUS=skipped \| REASON=note_fresh \| PATH=note_fresh/.test(progress),
        progress.split(/\r?\n/).filter(line => line.includes("WRAP_UP")).join("\n"));

      const repoNotes = findFile(path.join(repo, ".autopilot", "missions"),
        (_full, name) => name === "standalone-planning-plan_reviewer.md");
      check("fresh scratch note was copied to the repo hand-off path", repoNotes.length > 0,
        JSON.stringify(repoNotes));
      if (repoNotes.length > 0) {
        const copied = fs.readFileSync(repoNotes[0], "utf8");
        check("copied hand-off note carries the reviewer's marker", copied.includes("E2E-SCRATCH-NOTE-MARKER"),
          copied.slice(0, 500));
        check("copied hand-off note is not the orchestrator fallback", !/orchestrator fallback/i.test(copied),
          copied.slice(0, 500));
      }
    }
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(binDir, {recursive: true, force: true});
  }
}

if (failures) {
  console.error(`${failures} claude read-only scratch-note check(s) failed.`);
  process.exit(1);
}
console.log("test-claude-readonly-scratch-note: ALL CHECKS PASSED");
