#!/usr/bin/env node
// TASK 15.6K — the relay's effective repository is authoritative for
// PWD/INIT_CWD on every role invocation.
//
// Production incident: OpenCode resolves relative tool paths against the
// PWD environment variable, not only the child process cwd. `ap run --repo
// <target>` launched from another directory used to override PWD/INIT_CWD
// only for Windows disposable reviewer workspaces, so Planner/Implementer
// relays inherited the launcher's PWD/INIT_CWD — and a real probe wrote a
// deliverable into the canonical skill tree instead of the target fixture.
// Production fix (scripts/autopilot.mjs runRelay): guardedEnv() always
// seeds {PWD: effectiveCwd, INIT_CWD: effectiveCwd}; the envelope mapper
// (scripts/execution-envelope.mjs) forces both to /workspace/repository
// inside the sandbox.
//
// What this file proves, through REAL `node scripts/autopilot.mjs run`
// missions launched with cwd+PWD+INIT_CWD all pointing at a decoy:
//   - the PWD-resolved deliverable lands ONLY in the official target repo;
//   - write-role probes show process.cwd()==PWD==INIT_CWD==official repo;
//   - reviewers still run in the correct read-only location (Windows:
//     disposable copy with PWD==INIT_CWD==that copy; WSL: bubblewrap with
//     all three == /workspace/repository and no host path exposed);
//   - decoy directory, canonical skill tree stay byte-identical;
//   - workflow ordering is unchanged; the mission completes end to end;
//   - the target path contains spaces and Unicode on both platforms.
// Plus a deterministic unit section pinning the envelope mapping for
// hostile inherited PWD/INIT_CWD values (all platforms, no subprocess).
//
// Deterministic: fake adapters only (Node .cmd on Windows, POSIX .sh on
// Linux). No live model, no network, no prompt-prose assertions.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {createGitMutationGuard, guardedEnv} from "./relay-guards.mjs";
import {mapEnvironmentIntoEnvelope} from "./execution-envelope.mjs";
// Production run-directory authority (scripts/run-history.mjs): the
// `<seq>-<role>-<8hex>` shape is defined once, here reused for the
// deterministic ordering below — never reimplemented.
import {parseRunDirName as parseProductionRunDirName} from "./run-history.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");
const CANONICAL_AP = path.join(skillRoot, "scripts", "autopilot.mjs");

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail)}` : ""}`);
  return false;
}
function git(cwd, args) {
  const r = spawnSync("git", args, {cwd, encoding: "utf8", stdio: "pipe", shell: false});
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim().slice(0, 1000)}`);
  return (r.stdout || "").trim();
}
function sha256Bytes(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }
// Recursive content snapshot: relpath -> sha256 for files, plus dir set.
// Skill snapshots exclude node_modules (third-party, never touched by a
// mission); everything else must be byte-identical before/after.
function snapshotTree(rootDir, excludeNames = []) {
  const files = new Map();
  const dirs = new Set();
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, {withFileTypes: true}); }
    catch { return; }
    for (const entry of entries) {
      if (excludeNames.includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(rootDir, full);
      if (entry.isDirectory()) { dirs.add(rel); walk(full); }
      else if (entry.isFile()) {
        try { files.set(rel, sha256Bytes(fs.readFileSync(full))); }
        catch { files.set(rel, "<unreadable>"); }
      }
    }
  };
  walk(rootDir);
  return {files, dirs};
}
function diffSnapshots(before, after) {
  const added = [], removed = [], changed = [];
  for (const [k, v] of after.files) {
    if (!before.files.has(k)) added.push(k);
    else if (before.files.get(k) !== v) changed.push(k);
  }
  for (const k of before.files.keys()) if (!after.files.has(k)) removed.push(k);
  return {added, removed, changed};
}
function snapshotSkill() { return snapshotTree(skillRoot, ["node_modules"]); }
// Strict fail-closed cleanup: every owned target is attempted even if an
// earlier one failed; every removal error is a recorded failure (never
// swallowed); absence is asserted afterward. Never any path from output.
function strictCleanup(label, targets) {
  for (const target of targets) {
    if (!target) continue;
    try { fs.rmSync(target, {recursive: true, force: true}); }
    catch (error) { check(`${label}: cleanup succeeded`, false, `${target}: ${error?.message || error}`); }
  }
  for (const target of targets) {
    if (!target) continue;
    check(`${label}: owned path removed after cleanup`, !fs.existsSync(target), target);
  }
}
function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}
// Deterministic workflow ordering (correction B): role order is derived
// from the PERSISTED numeric run-directory sequence —
// .autopilot/missions/<mission>/runs/<seq>-<role>-<shortid>/ — never from
// wall-clock startedAt/finishedAt timestamps. Run seq is unique per mission
// (oldest->newest) and stays the primary key; missions order by directory
// birthtime (creation-on-demand is causal order — load-bearing, because a
// fresh SpecKit mission observably spans same-rank mission folders and the
// numeric rank alone cannot order them). Fails closed (returns null after
// recording the defect) on: an unrunnable/unenumerable layout, unreadable
// mission birthtimes, tied mission birthtimes, a run directory without an
// exact <seq>-<role>-<8hex> shape (production run-history.mjs authority),
// duplicate seq within one mission, a missing/unreadable/invalid
// result.json, a dirname/result.json role or mission mismatch, or any
// unexpected layout (sequenced runs in the legacy flat bucket).
// Role-presence and the required
// planner < plan_reviewer < implementer < code_reviewer < verifier order are
// asserted by the callers on the returned sequence order.
const REQUIRED_ORDER = ["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"];
function parseRunDirName(base) {
  const parsed = parseProductionRunDirName(base);
  if (!parsed) return null;
  return {seq: parseInt(parsed.seq, 10), role: parsed.role, id: parsed.shortId};
}
function missionBirthMs(missionsRoot, mission) {
  let st = null;
  try { st = fs.statSync(path.join(missionsRoot, mission)); }
  catch (error) { return {ok: false, reason: `unstatable: ${error?.message || String(error)}`}; }
  const ms = st.birthtimeMs;
  if (!Number.isFinite(ms) || ms <= 0) return {ok: false, reason: `no usable birthtime (got ${ms})`};
  return {ok: true, ms};
}
function collectSequencedResults(repo, tag) {
  const missionsRoot = path.join(repo, ".autopilot", "missions");
  const flatRoot = path.join(repo, ".autopilot", "runs");
  const runsDirs = [];
  try {
    if (fs.existsSync(missionsRoot)) {
      for (const entry of fs.readdirSync(missionsRoot, {withFileTypes: true})) {
        if (!entry.isDirectory()) continue;
        runsDirs.push({mission: entry.name, runs: path.join(missionsRoot, entry.name, "runs")});
      }
    }
  } catch (error) {
    check(`${tag}: missions directory enumerable`, false, error?.message || String(error));
    return null;
  }
  try {
    if (fs.existsSync(flatRoot)) {
      const flatSequenced = [];
      for (const entry of fs.readdirSync(flatRoot, {withFileTypes: true})) {
        if (entry.isDirectory() && parseRunDirName(entry.name)) flatSequenced.push(entry.name);
      }
      if (flatSequenced.length > 0) {
        check(`${tag}: no sequenced runs in the legacy flat bucket (unexpected layout)`, false, flatSequenced);
        return null;
      }
    }
  } catch (error) {
    check(`${tag}: legacy runs bucket enumerable`, false, error?.message || String(error));
    return null;
  }
  const entries = [];
  const seenSeq = new Set();
  const missionBirth = new Map();
  for (const {mission, runs} of runsDirs) {
    // Mission directories are created on demand as the workflow advances,
    // so birthtime order is causal order. This is load-bearing: a fresh
    // SpecKit mission observably spans two same-rank mission folders (the
    // request-derived provisional folder hosting specify, plus the unified
    // feature-derived folder hosting the remaining stages), so the numeric
    // rank alone cannot order missions — the run-directory sequence stays
    // the primary key within each mission.
    let birth = missionBirth.get(mission);
    if (birth === undefined) {
      const probed = missionBirthMs(missionsRoot, mission);
      if (!probed.ok) {
        check(`${tag}: mission directory birthtime readable`, false, `${mission}: ${probed.reason}`);
        return null;
      }
      birth = probed.ms;
      missionBirth.set(mission, birth);
    }
    let names;
    try {
      names = fs.existsSync(runs) ? fs.readdirSync(runs, {withFileTypes: true}) : [];
    } catch (error) {
      check(`${tag}: mission runs directory enumerable`, false, `${runs}: ${error?.message || String(error)}`);
      return null;
    }
    for (const entry of names) {
      if (!entry.isDirectory()) continue;
      const parsed = parseRunDirName(entry.name);
      if (!parsed) {
        check(`${tag}: run directory carries a persisted numeric sequence prefix`, false, `${mission}/${entry.name}`);
        return null;
      }
      const key = JSON.stringify([mission, parsed.seq]);
      if (seenSeq.has(key)) {
        check(`${tag}: no duplicate sequence numbers within one mission`, false, `${mission}/${entry.name}`);
        return null;
      }
      seenSeq.add(key);
      const file = path.join(runs, entry.name, "result.json");
      let data = null;
      try { data = JSON.parse(fs.readFileSync(file, "utf8")); }
      catch (error) {
        check(`${tag}: result.json readable and valid`, false, `${mission}/${entry.name}: ${error?.message || String(error)}`);
        return null;
      }
      if (data == null || typeof data !== "object" || data.role !== parsed.role) {
        check(`${tag}: run dirname role matches result.json role`, false, {dir: `${mission}/${entry.name}`, role: data?.role});
        return null;
      }
      // result.mission is written by the same runDirFor() call that built
      // the directory path, so it must equal the enclosing mission folder.
      if (data.mission !== mission) {
        check(`${tag}: result.json mission matches the enclosing mission folder`, false,
          {dir: `${mission}/${entry.name}`, mission: data.mission});
        return null;
      }
      entries.push({file, data, seq: parsed.seq, missionBirthMs: birth, mission});
    }
  }
  const births = [...missionBirth.entries()];
  for (let i = 0; i < births.length; i += 1) {
    for (let j = i + 1; j < births.length; j += 1) {
      if (births[i][1] === births[j][1]) {
        check(`${tag}: mission directory birthtimes are distinct (order knowable)`, false,
          {a: births[i][0], b: births[j][0]});
        return null;
      }
    }
  }
  entries.sort((a, b) => (a.missionBirthMs - b.missionBirthMs) || (a.seq - b.seq));
  return entries;
}
function shortTag(run) {
  return `${run.mission || "?"}@${path.basename(path.dirname(run.file))}`;
}
function samePath(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const norm = (p) => path.resolve(p);
  return process.platform === "win32"
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b);
}
function isInside(parent, candidate) {
  if (typeof candidate !== "string" || !candidate || typeof parent !== "string" || !parent) return false;
  const rel = path.relative(path.resolve(parent), path.resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
function listLeakedTemp(prefixes) {
  let names;
  try { names = fs.readdirSync(os.tmpdir()); }
  catch (error) { throw new Error(`temp-dir enumeration failed (never report as no-leak): ${error?.message || error}`); }
  return names.filter((n) => prefixes.some((p) => n.startsWith(p))).map((n) => path.join(os.tmpdir(), n));
}

// =====================================================================
// Section U (all platforms, deterministic, no subprocess): the envelope
// mapping forces PWD/INIT_CWD to the sandbox repository even for hostile
// inherited values, and the guardedEnv override mechanism pins them.
// =====================================================================
function runUnitSection() {
  const mockEnvelope = {
    available: true,
    sandbox: {repository: "/workspace/repository", scratch: "/workspace/scratch"},
    args: [],
  };
  const hostRepo = path.join(os.tmpdir(), "ap-pwd-unit", "repo target");
  const hostScratch = path.join(hostRepo, ".autopilot", "runs", "r1", "scratch");
  const decoyHost = path.join(os.tmpdir(), "ap-pwd-unit", "decoy launcher");
  const hostile = {
    PATH: "/usr/bin:/bin",
    HOME: hostScratch,
    PWD: decoyHost,
    INIT_CWD: decoyHost,
    AUTOPILOT_GIT_GUARD_LOG: path.join(hostScratch, "git-guard", "blocked.log"),
    GIT_CONFIG_VALUE_1: hostRepo,
  };
  const mapped = mapEnvironmentIntoEnvelope(hostile, mockEnvelope, hostRepo, hostScratch);
  check("U.1: hostile inherited PWD maps to /workspace/repository", mapped.PWD === "/workspace/repository", mapped.PWD);
  check("U.2: hostile inherited INIT_CWD maps to /workspace/repository", mapped.INIT_CWD === "/workspace/repository", mapped.INIT_CWD);
  const seeded = mapEnvironmentIntoEnvelope(
    {...hostile, PWD: hostRepo, INIT_CWD: hostRepo}, mockEnvelope, hostRepo, hostScratch);
  check("U.3: correctly seeded PWD stays /workspace/repository", seeded.PWD === "/workspace/repository", seeded.PWD);
  check("U.4: correctly seeded INIT_CWD stays /workspace/repository", seeded.INIT_CWD === "/workspace/repository", seeded.INIT_CWD);
  for (const [name, value] of [["PWD", mapped.PWD], ["INIT_CWD", mapped.INIT_CWD], ["HOME", mapped.HOME]]) {
    check(`U.5: no host path exposed in envelope ${name}`,
      typeof value === "string" && !value.includes(hostRepo) && !value.includes(hostScratch) && !value.includes(decoyHost), value);
  }
  // The override mechanism production runRelay() relies on: extra wins over
  // any inherited process value.
  const guardDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-pwd-unit-guard-"));
  try {
    const guard = createGitMutationGuard(guardDir, hostRepo);
    const seededEnv = guardedEnv(guard, {PWD: hostRepo, INIT_CWD: hostRepo});
    check("U.6: guardedEnv extra PWD wins over inherited", seededEnv.PWD === hostRepo, seededEnv.PWD);
    check("U.7: guardedEnv extra INIT_CWD wins over inherited", seededEnv.INIT_CWD === hostRepo, seededEnv.INIT_CWD);
  } finally {
    strictCleanup("U", [guardDir]);
  }
}

// =====================================================================
// Shared mission scaffolding
// =====================================================================
const DELIVERABLE_NAME = "pwd-authority-deliverable.txt";
const DELIVERABLE_BYTES = "pwd-authority-ok\n";
const PLANNER_FILE_NAME = "pwd-authority-planner.txt";
const PLANNER_BYTES = "pwd-authority-planner-ok\n";

function makeDecoy(prefix) {
  const decoy = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(decoy, "decoy-marker.txt"), "decoy sentinel — no mission write may land here\n");
  fs.mkdirSync(path.join(decoy, "nested"), {recursive: true});
  fs.writeFileSync(path.join(decoy, "nested", "inner.txt"), "inner sentinel\n");
  return decoy;
}
// Target repository path contains spaces AND Unicode (both platforms).
function targetTmpPrefix() {
  return process.platform === "win32" ? "ap-win-pwd space-\u6210-" : "ap-pwd space-\u6210-";
}

function assertCleanRun(label, result) {
  return check(`${label}: process completed cleanly (no timeout, output overflow, or termination failure)`,
    !result.timedOut && !result.outputLimitExceeded && !result.terminationFailed,
    {timedOut: result.timedOut, outputLimitExceeded: result.outputLimitExceeded, terminationFailed: result.terminationFailed,
     stdoutTail: (result.stdout || "").slice(-1000), stderrTail: (result.stderr || "").slice(-1000)});
}

// =====================================================================
// Windows branch: full SpecKit mission (planner creates the feature, all
// three read-only roles run in disposable copies), launched from the decoy.
// =====================================================================
const WIN_FEATURE_SLUG = "901-pwd-authority";
const WIN_TASK_TEXT = "Prove the relay working directory is authoritative";

function winWorkflowYml() {
  return [
    "- id: specify", '  type: command', "  command: /speckit.specify",
    "- id: review-spec", "  type: gate", "  message: Review the spec",
    "- id: plan", "  type: command", "  command: /speckit.plan",
    "- id: review-plan", "  type: gate", "  message: Review the plan",
    "- id: tasks", "  type: command", "  command: /speckit.tasks",
    "- id: review-tasks", "  type: gate", "  message: Review the tasks",
    "- id: implement", "  type: command", "  command: /speckit.implement", ""
  ].join("\n");
}

function winMakeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), targetTmpPrefix()));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "pwd-authority-test@example.invalid"]);
  git(repo, ["config", "user.name", "PWD Authority Test"]);
  fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n");
  fs.writeFileSync(path.join(repo, "README.md"), "# PWD authority fixture\n");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "original-tracked-content\n");
  const wfDir = path.join(repo, ".specify", "workflows", "speckit");
  fs.mkdirSync(wfDir, {recursive: true});
  fs.writeFileSync(path.join(wfDir, "workflow.yml"), winWorkflowYml());
  fs.writeFileSync(path.join(repo, "CLAUDE.md"), [
    "# CLAUDE.md", "", "Project instructions (outside the Autopilot-controlled section).", "",
    "<!-- SPECKIT START -->", "(no active SpecKit feature)", "<!-- SPECKIT END -->", "", "More project instructions.", ""
  ].join("\n"));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init: pwd-authority fixture before planning"]);
  return repo;
}

function winWriteConfig(repo) {
  const config = {
    schema_version: "3.0",
    project: {repo: ".", planning_framework: "speckit", state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs"},
    execution: {runtime_mode: "windows-compatibility", wsl_distro: null},
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
      failure_budgets: {implementationFailureBudget: 5, verificationFailureBudget: 5, adapterRetryBudget: 5, infrastructureRetryBudget: 5}
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

// Hermetic PATH: Windows ranks .exe ahead of .cmd globally, so prefix-first
// is not enough — no directory able to supply any manifest agent binary may
// remain outside the fixture dir (suite precedent).
const WIN_AGENT_BINARIES = ["claude", "opencode", "codex", "agy", "cursor-agent"];
const WIN_EXTS = [".exe", ".com", ".cmd", ".bat", ""];
function winDirSuppliesAgent(dir) {
  for (const name of WIN_AGENT_BINARIES) {
    for (const ext of WIN_EXTS) {
      try { if (fs.existsSync(path.join(dir, name + ext))) return true; } catch { /* unreadable */ }
    }
  }
  return false;
}
function winMissionFixturePath(binDir) {
  const original = (process.env.PATH || "").split(";").filter(Boolean);
  return [binDir, ...original.filter((d) => !winDirSuppliesAgent(d))].join(";");
}

function winAdapterScript() {
  const F = JSON.stringify(WIN_FEATURE_SLUG);
  const T = JSON.stringify(WIN_TASK_TEXT);
  const D = JSON.stringify(DELIVERABLE_NAME);
  const DB = JSON.stringify(DELIVERABLE_BYTES);
  return [
    `import fs from "node:fs";`,
    `import path from "node:path";`,
    `const FEATURE_SLUG = ${F};`,
    `const TASK_TEXT = ${T};`,
    `function readStdin(){ return new Promise((res, rej)=>{ let d=""; process.stdin.setEncoding("utf8"); process.stdin.on("data",c=>{d+=c;}); process.stdin.on("end",()=>res(d)); process.stdin.on("error",rej); }); }`,
    `const args = process.argv.slice(2);`,
    `if (args[0] === "--version") { console.log("fake-pwd-authority-agent 1.0.0"); process.exit(0); }`,
    `const PROMPT = await readStdin();`,
    `const firstLine = PROMPT.split(/\\r?\\n/, 1)[0] || "";`,
    `const role = firstLine.startsWith("ROLE=") ? firstLine.slice("ROLE=".length).trim() : "";`,
    `function extractLine(prefix){ const re = new RegExp("^" + prefix + "(.*)$", "m"); const m = PROMPT.match(re); return m ? m[1].trim() : null; }`,
    `function probePayload(extra){ return { role, cwd: process.cwd(), pwdEnv: process.env.PWD || null, initCwdEnv: process.env.INIT_CWD || null, repositoryFromPrompt: extractLine("REPOSITORY="), safeDirectoryValueEnv: process.env.GIT_CONFIG_VALUE_1 || null, ...extra }; }`,
    // Planner: stage from observable filesystem state; every call also
    // performs the OpenCode-style PWD-resolved write plus a probe file.
    `if (role === "planner") {`,
    `  const featureDir = "specs/" + FEATURE_SLUG;`,
    `  const specP = path.join(featureDir, "spec.md");`,
    `  const planP = path.join(featureDir, "plan.md");`,
    `  const tasksP = path.join(featureDir, "tasks.md");`,
    `  if (!fs.existsSync(specP)) {`,
    `    fs.mkdirSync(".specify", {recursive:true});`,
    `    fs.writeFileSync(path.join(".specify","feature.json"), JSON.stringify({feature_directory: featureDir}));`,
    `    fs.mkdirSync(path.join(featureDir,"checklists"), {recursive:true});`,
    `    fs.writeFileSync(specP, "# Spec\\n\\nPWD authority feature.\\n");`,
    `    fs.writeFileSync(path.join(featureDir,"checklists","requirements.md"), "# Requirements\\n\\n- [ ] Requirement A\\n");`,
    `  } else if (!fs.existsSync(planP)) {`,
    `    fs.mkdirSync(path.join(featureDir,"contracts"), {recursive:true});`,
    `    fs.writeFileSync(planP, "# Plan\\n\\nPWD authority plan.\\n");`,
    `    fs.writeFileSync(path.join(featureDir,"research.md"), "# Research\\n\\nFindings.\\n");`,
    `    fs.writeFileSync(path.join(featureDir,"data-model.md"), "# Data Model\\n\\nEntities.\\n");`,
    `    fs.writeFileSync(path.join(featureDir,"quickstart.md"), "# Quickstart\\n\\nSteps.\\n");`,
    `    fs.writeFileSync(path.join(featureDir,"contracts","health.md"), "# Health\\n\\nGET /health\\n");`,
    `    try {`,
    `      if (fs.existsSync("CLAUDE.md")) {`,
    `        const cur = fs.readFileSync("CLAUDE.md","utf8");`,
    `        const b = "<!-- SPECKIT START -->"; const e = "<!-- SPECKIT END -->";`,
    `        const bi = cur.indexOf(b); const ei = cur.indexOf(e);`,
    `        if (bi !== -1 && ei !== -1 && ei > bi) fs.writeFileSync("CLAUDE.md", cur.slice(0, bi + b.length) + "\\nActive feature: " + FEATURE_SLUG + "\\n" + cur.slice(ei));`,
    `      }`,
    `    } catch {}`,
    `  } else if (!fs.existsSync(tasksP)) {`,
    `    fs.writeFileSync(tasksP, "## Phase 1: " + TASK_TEXT + "\\n\\n- [ ] " + TASK_TEXT + "\\n");`,
    `  } else { console.error("fake planner: spec+plan+tasks all present — failing closed"); process.exit(1); }`,
    // OpenCode-style observation: report the working-directory triple on
    // stdout (captured verbatim in result.json's finalMessage — cursor has
    // no registered driver, so there is no protocol normalization). This
    // MUST be stdout-only: SpecKit planning stages enforce an exact
    // per-stage write boundary (scripts/planning-boundary.mjs), so any
    // extra planner file at any path fails the mission by design. The
    // implementer (no such boundary) proves real file placement below.
    `  console.log(["PWDPROBE", process.cwd(), process.env.PWD || "", process.env.INIT_CWD || ""].join("\\t"));`,
    `  console.log("planner ok"); process.exit(0);`,
    `}`,
    // Implementer (writable): same PWD-resolved deliverable pattern.
    `if (role === "implementer") {`,
    `  const pwdBase = process.env.PWD || process.cwd();`,
    `  fs.writeFileSync(path.resolve(pwdBase, ${D}), ${DB});`,
      `  fs.writeFileSync(path.join(process.cwd(), "pwd-authority-probe-implementer.json"), JSON.stringify(probePayload({})));`,
      `  console.log("implementer ok");`,
      // TASK-19 Phase 4 (task 12): the per-task Implementer invocation must end
      // with the AUTOPILOT_TASK_RESULT sentinel as its final non-empty line.
      `  console.log("AUTOPILOT_TASK_RESULT=" + JSON.stringify({summary: "implementer ok", taskLocalCheck: {command: "true", status: "passed", exitCode: 0, summary: "fixture"}}));`,
      `  process.exit(0);`,
    `}`,
    // Read-only roles: probe the disposable copy, attempt one relative
    // write (must land in the disposable copy only), then PASS.
    `if (role === "plan_reviewer" || role === "code_reviewer" || role === "verifier") {`,
    `  const cwdAtStart = process.cwd();`,
    `  const fileName = "pwd-authority-" + role + "-relative.txt";`,
    `  let relativeWrite = "NOT_ATTEMPTED";`,
    `  try { fs.writeFileSync(fileName, "written-by-" + role); relativeWrite = "SUCCEEDED"; } catch(e){ relativeWrite = "FAILED:" + String((e&&e.code)||e); }`,
    `  const js = JSON.stringify(probePayload({workspaceRoot: path.dirname(cwdAtStart), relativeWrite}));`,
    `  console.log("PROBE:" + js);`,
    `  console.log("AUTOPILOT_REVIEW=" + JSON.stringify({decision:"PASS", findings:[js]})); process.exit(0);`,
    `}`,
    `console.error("fake-pwd-authority-adapter: unknown ROLE '" + role + "'"); process.exit(1);`
  ].join("\n");
}

function winMakeBin() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-win-pwd-bin-"));
  const scriptPath = path.join(binDir, "pwd-authority-adapter.mjs");
  fs.writeFileSync(scriptPath, winAdapterScript());
  fs.writeFileSync(path.join(binDir, "cursor-agent.cmd"), `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\nexit /b %errorlevel%\r\n`);
  return {binDir, scriptPath};
}

function winExtractProbes(resultData) {
  const findings = resultData?.review?.findings || resultData?.verdict?.findings || [];
  const probes = [];
  for (const finding of findings) {
    try {
      const parsed = JSON.parse(finding);
      if (parsed && typeof parsed === "object" && typeof parsed.cwd === "string" && typeof parsed.role === "string") probes.push(parsed);
    } catch { /* not the probe payload */ }
  }
  return probes;
}

async function runWindowsMission() {
  const {runWindowsProcessTreeBounded} = await import("./test-fixtures/windows-process-tree-runner.mjs");
  const target = winMakeRepo();
  const decoy = makeDecoy("ap-win-pwd-decoy-");
  const {binDir, scriptPath} = winMakeBin();
  const owned = [target, decoy, binDir];
  const targetReal = fs.realpathSync(target);
  const decoySnapBefore = snapshotTree(decoy);
  const headBefore = git(target, ["rev-parse", "HEAD"]);
  try {
    winWriteConfig(target);
    // Warmup outside the mission budget (suite precedent: Windows AV).
    const warmup = await runWindowsProcessTreeBounded("cmd.exe",
      ["/d", "/s", "/c", path.join(binDir, "cursor-agent.cmd"), "--version"], {timeoutMs: 60000});
    check("W.warmup: fake adapter responds to --version", warmup.status === 0 && !warmup.timedOut, warmup);
    // THE regression launch: outer cwd AND inherited PWD/INIT_CWD all
    // point at the decoy while --repo points at the target.
    const env = {...process.env, PATH: winMissionFixturePath(binDir), PWD: decoy, INIT_CWD: decoy};
    const result = await runWindowsProcessTreeBounded(process.execPath,
      [CANONICAL_AP, "run", "pwd authority fixture request", "--repo", target],
      {cwd: decoy, env, timeoutMs: 600000});
    // Correction A.4: NO early return on an unclean mission run. The
    // assertCleanRun failure is recorded, every assertion below fails
    // closed on its own against whatever the mission left behind, and the
    // decoy/survivor checks plus fixture cleanup (finally) always run.
    assertCleanRun("W.mission", result);
    const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
    check("W.1: mission completed successfully from outside the target (exit 0 + ALL WORK COMPLETE)",
      result.status === 0 && /ALL WORK COMPLETE/.test(combined), {status: result.status, tail: combined.slice(-800)});
    // Sequence-ordered results (correction B): null-tolerant — a structural
    // defect is recorded inside the collector and every dependent check
    // below fails closed on the empty set.
    const results = collectSequencedResults(target, "W") || [];
    const roles = results.map((r) => r.data.role);
    for (const need of ["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"]) {
      check(`W.2: role ${need} ran (ordering unchanged)`, roles.includes(need), roles);
    }
    const idx = (role) => roles.indexOf(role);
    check("W.3: ordering planner < plan_reviewer < implementer < code_reviewer < verifier",
      idx("planner") !== -1 && idx("planner") < idx("plan_reviewer")
      && idx("plan_reviewer") < idx("implementer") && idx("implementer") < idx("code_reviewer")
      && idx("code_reviewer") < idx("verifier"), roles);
    // Write-role deliverables: PWD-resolved writes landed in the target.
    // (Implementer; the planner proves its triple via stdout PWDPROBE —
    // it cannot write extra files under the exact stage boundary.)
    check("W.4: PWD-resolved implementer deliverable exists only via the target",
      fs.existsSync(path.join(target, DELIVERABLE_NAME))
      && fs.readFileSync(path.join(target, DELIVERABLE_NAME), "utf8") === DELIVERABLE_BYTES);
    // Planner probes: every planner run reported the triple on stdout.
    const plannerRuns = results.filter((r) => r.data.role === "planner");
    check("W.5: planner ran at least once", plannerRuns.length > 0, roles);
    let sawPlannerProbe = false;
    for (const run of plannerRuns) {
      const line = String(run.data.finalMessage || "").split("\n").find((l) => l.startsWith("PWDPROBE\t"));
      if (!line) continue;
      sawPlannerProbe = true;
      const [, cwd, pwd, init] = line.split("\t");
      const tag = `W.5: planner probe @${shortTag(run)}`;
      check(`${tag}: process.cwd() is the official target`, samePath(cwd, targetReal), cwd);
      check(`${tag}: PWD is the official target`, samePath(pwd, targetReal), pwd);
      check(`${tag}: INIT_CWD is the official target`, samePath(init, targetReal), init);
    }
    check("W.5: every planner run emitted its PWDPROBE triple", sawPlannerProbe && plannerRuns.every((run) =>
      String(run.data.finalMessage || "").split("\n").some((l) => l.startsWith("PWDPROBE\t"))), roles);
    // Implementer probe file (no write boundary on the implement role).
    {
      const probe = readJsonFile(path.join(target, "pwd-authority-probe-implementer.json"));
      check("W.6: implementer probe recovered", probe != null && probe.role === "implementer", probe);
      if (probe) {
        check("W.6: implementer process.cwd() is the official target", samePath(probe.cwd, targetReal), probe.cwd);
        check("W.6: implementer PWD is the official target", samePath(probe.pwdEnv, targetReal), probe.pwdEnv);
        check("W.6: implementer INIT_CWD is the official target", samePath(probe.initCwdEnv, targetReal), probe.initCwdEnv);
      }
    }
    // Read-only roles: every probe shows the disposable copy only.
    for (const role of ["plan_reviewer", "code_reviewer", "verifier"]) {
      const runs = results.filter((r) => r.data.role === role);
      check(`W.7: ${role} recorded at least one run`, runs.length > 0, roles);
      for (const run of runs) {
        for (const probe of winExtractProbes(run.data)) {
          const tag = `W.7: ${role} probe @${shortTag(run)}`;
          check(`${tag}: PWD equals the disposable cwd`, samePath(probe.pwdEnv, probe.cwd), probe);
          check(`${tag}: INIT_CWD equals the disposable cwd`, samePath(probe.initCwdEnv, probe.cwd), probe);
          check(`${tag}: REPOSITORY prompt equals the disposable cwd`, samePath(probe.repositoryFromPrompt, probe.cwd), probe);
          check(`${tag}: safe.directory equals the disposable cwd`, samePath(probe.safeDirectoryValueEnv, probe.cwd), probe);
          check(`${tag}: disposable cwd is outside the official repo`, !isInside(targetReal, probe.cwd), probe.cwd);
          check(`${tag}: disposable cwd is outside the decoy`, !isInside(decoy, probe.cwd), probe.cwd);
          check(`${tag}: disposable cwd is outside the skill tree`, !isInside(skillRoot, probe.cwd), probe.cwd);
          check(`${tag}: relative write succeeded inside the disposable copy`, probe.relativeWrite === "SUCCEEDED", probe);
        }
      }
      check(`W.7: ${role} left no relative write in the official repo`,
        !fs.existsSync(path.join(target, `pwd-authority-${role}-relative.txt`)));
    }
    // Official repo integrity: reviewers mutated nothing; HEAD untouched.
    const tasksFile = path.join(target, "specs", WIN_FEATURE_SLUG, "tasks.md");
    check("W.8: phase task marked [x] after verification", fs.existsSync(tasksFile) && /- \[x\] /.test(fs.readFileSync(tasksFile, "utf8")),
      fs.existsSync(tasksFile) ? fs.readFileSync(tasksFile, "utf8") : "tasks.md missing");
    check("W.8: official HEAD unchanged (no commits by any role)", git(target, ["rev-parse", "HEAD"]) === headBefore);
    check("W.8: official tracked.txt still the fixture bytes",
      fs.readFileSync(path.join(target, "tracked.txt"), "utf8") === "original-tracked-content\n");
    // Decoy byte-identical, deliverables absent.
    const decoyDiff = diffSnapshots(decoySnapBefore, snapshotTree(decoy));
    check("W.9: decoy directory byte-identical (no write escaped the target)",
      decoyDiff.added.length === 0 && decoyDiff.removed.length === 0 && decoyDiff.changed.length === 0, decoyDiff);
    check("W.9: no deliverable in the decoy", !fs.existsSync(path.join(decoy, DELIVERABLE_NAME)));
    check("W.9: no planner file in the decoy", !fs.existsSync(path.join(decoy, PLANNER_FILE_NAME)));
    // Survivor scan for this test's adapter processes.
    const survivor = spawnSync("powershell", ["-NoProfile", "-Command",
      `(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*pwd-authority-adapter.mjs*' -or $_.CommandLine -like '*ap-win-pwd-bin-*' } | Measure-Object).Count`
    ], {encoding: "utf8"});
    check("W.10: no surviving adapter descendant remains", (parseInt((survivor.stdout || "0").trim(), 10) || 0) === 0,
      {count: (survivor.stdout || "").trim(), stderr: (survivor.stderr || "").slice(0, 300)});
  } finally {
    strictCleanup("W", owned);
  }
  return {target: null, decoy: null, binDir: null, owned: []};
}

// =====================================================================
// Linux branch: standalone mission (planner + implementer writable in the
// official repo; read-only roles inside the real bubblewrap envelope),
// launched from the decoy. Requires bwrap; SKIPs the mission (not the
// deterministic units) when containment is unavailable.
// =====================================================================
function linMakeFixtureRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), targetTmpPrefix()));
  const g = (args) => {
    const r = spawnSync("git", args, {cwd: repo, encoding: "utf8", shell: false});
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  };
  g(["init", "-q"]);
  g(["config", "user.email", "pwd-authority-test@example.invalid"]);
  g(["config", "user.name", "PWD Authority Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);
  return repo;
}
function linMakeFixtureBin() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-wf-pwd-bin-"));
  const target = path.join(binDir, "cursor-agent");
  fs.copyFileSync(path.join(here, "test-fixtures", "fake-workflow-adapter.sh"), target);
  fs.chmodSync(target, 0o755);
  return binDir;
}
function linWriteConfig(repo) {
  const config = {
    schema_version: "3.0",
    project: {repo: ".", planning_framework: "standalone", state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs"},
    roles: Object.fromEntries(["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"].map((role) => [
      role, {adapter: "cursor", model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null}
    ])),
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
function linSetScenario(repo, scenario) {
  fs.writeFileSync(path.join(repo, ".autopilot-test-scenario"), scenario);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", `test scenario: ${scenario}`]);
}
function linParseProbeFile(file) {
  if (!fs.existsSync(file)) return null;
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}
function linExtractReviewProbes(resultData) {
  // Each probe datum is its own element of the findings array
  // (["role=...","cwd=...","pwd_env=...","init_cwd=...","scenario_present=..."]);
  // accumulate across all elements, then keep the complete probe objects.
  const findings = resultData?.review?.findings || resultData?.verdict?.findings || [];
  const probe = {};
  for (const finding of findings) {
    if (typeof finding !== "string" || !finding.includes("=")) continue;
    const i = finding.indexOf("=");
    probe[finding.slice(0, i)] = finding.slice(i + 1);
  }
  return probe.role && probe.cwd ? [probe] : [];
}
function linBubblewrapUsable() {
  const which = spawnSync("sh", ["-lc", "command -v bwrap"], {encoding: "utf8", shell: false});
  return which.status === 0 && String(which.stdout || "").trim().length > 0;
}

async function runLinuxMission() {
  if (!linBubblewrapUsable()) {
    console.log("SKIP L: bubblewrap not installed — WSL2 Strong envelope mission requires real bwrap (deterministic units above still ran)");
    return;
  }
  const target = linMakeFixtureRepo();
  const decoy = makeDecoy("ap-pwd-decoy-");
  const binDir = linMakeFixtureBin();
  const owned = [target, decoy, binDir];
  const targetReal = fs.realpathSync(target);
  const decoySnapBefore = snapshotTree(decoy);
  try {
    linWriteConfig(target);
    linSetScenario(target, "pwd_authority_probe");
    // headBefore is captured AFTER all fixture commits: only mission-caused
    // commits may move HEAD from here on.
    const headBefore = git(target, ["rev-parse", "HEAD"]);
    // THE regression launch through the production-quality POSIX
    // process-tree runner (correction A): outer cwd AND inherited
    // PWD/INIT_CWD all point at the decoy while --repo points at the
    // target. runPosixBounded owns the process group it creates: on
    // timeout, abnormal exit, or a normal leader exit with surviving
    // descendants, the COMPLETE tree is terminated (SIGTERM, then SIGKILL)
    // and confirmed dead before settlement; stdout/stderr stay byte-bounded
    // and settlement is single/backstopped by construction.
    const {runPosixBounded} = await import("./test-fixtures/posix-process-runner.mjs");
    const env = {...process.env, PATH: `${binDir}:${process.env.PATH || ""}`, PWD: decoy, INIT_CWD: decoy};
    const run = await runPosixBounded(process.execPath,
      [CANONICAL_AP, "run", "pwd authority fixture request", "--repo", target],
      {cwd: decoy, env, timeoutMs: 180000});
    // Correction A.2: every lifecycle term asserted separately (no
    // short-circuit — each check evaluates and records on its own), and
    // correction A.4: NO early return — dependent assertions fail closed on
    // their own while decoy/survivor checks and fixture cleanup always run.
    const combined = `${run.stdout || ""}\n${run.stderr || ""}`;
    check("L.mission: error is absent", run.error == null,
      run.error ? String(run.error?.code || run.error?.message || run.error) : undefined);
    check("L.mission: timedOut === false", run.timedOut === false, {timedOut: run.timedOut});
    check("L.mission: outputLimitExceeded === false", run.outputLimitExceeded === false,
      {outputLimitExceeded: run.outputLimitExceeded});
    check("L.mission: terminationFailed === false", run.terminationFailed === false,
      {terminationFailed: run.terminationFailed});
    check("L.mission: process exited with status 0", run.status === 0,
      {status: run.status, signal: run.signal});
    check("L.mission: ALL WORK COMPLETE was emitted", /ALL WORK COMPLETE/.test(combined),
      {status: run.status, tail: combined.slice(-800)});
    // No early return below (correction A.4): every dependent assertion
    // fails closed on its own against whatever the mission left behind.
    // Sequence-ordered results (correction B): null-tolerant — a structural
    // defect is recorded inside the collector and every dependent check
    // below fails closed on the empty set.
    const results = collectSequencedResults(target, "L") || [];
    const roles = results.map((r) => r.data.role);
    for (const need of ["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"]) {
      check(`L.2: role ${need} ran (ordering unchanged)`, roles.includes(need), roles);
    }
    const idx = (role) => roles.indexOf(role);
    check("L.3: ordering planner < plan_reviewer < implementer < code_reviewer < verifier",
      idx("planner") !== -1 && idx("planner") < idx("plan_reviewer")
      && idx("plan_reviewer") < idx("implementer") && idx("implementer") < idx("code_reviewer")
      && idx("code_reviewer") < idx("verifier"), roles);
    // Planner actually planned (per-mission standalone PLAN.md written to the target).
    check("L.3: standalone PLAN.md written in the target mission directory",
      fs.existsSync(path.join(target, ".autopilot", "missions", "001-pwd-authority-fixture-request", "PLAN.md"))
      && !fs.existsSync(path.join(target, ".autopilot", "standalone", "PLAN.md")));
    // Write-role deliverables: PWD-resolved writes landed in the target.
    check("L.4: PWD-resolved implementer deliverable exists in the target with exact bytes",
      fs.existsSync(path.join(target, DELIVERABLE_NAME))
      && fs.readFileSync(path.join(target, DELIVERABLE_NAME), "utf8") === DELIVERABLE_BYTES);
    check("L.5: PWD-resolved planner file exists in the target with exact bytes",
      fs.existsSync(path.join(target, PLANNER_FILE_NAME))
      && fs.readFileSync(path.join(target, PLANNER_FILE_NAME), "utf8") === PLANNER_BYTES);
    // Write-role probes: every observed value is the official repository.
    for (const [role, file] of [["planner", "pwd-authority-probe-planner.txt"], ["implementer", "pwd-authority-probe-implementer.txt"]]) {
      const probe = linParseProbeFile(path.join(target, file));
      check(`L.6: ${role} probe recovered`, probe != null && probe.role === role, probe);
      if (probe) {
        check(`L.6: ${role} process cwd is the official target`, samePath(probe.cwd, targetReal), probe.cwd);
        check(`L.6: ${role} PWD is the official target`, samePath(probe.pwd_env, targetReal), probe.pwd_env);
        check(`L.6: ${role} INIT_CWD is the official target`, samePath(probe.init_cwd, targetReal), probe.init_cwd);
      }
    }
    // Read-only roles: inside the real envelope, all three are exactly
    // /workspace/repository, the scenario file is visible, and no host
    // path (target, decoy) is exposed anywhere in the probe.
    for (const role of ["plan_reviewer", "code_reviewer", "verifier"]) {
      const runs = results.filter((r) => r.data.role === role);
      check(`L.7: ${role} recorded at least one run`, runs.length > 0, roles);
      let sawProbe = false;
      for (const run of runs) {
        for (const probe of linExtractReviewProbes(run.data)) {
          if (probe.role !== role) continue;
          sawProbe = true;
          const tag = `L.7: ${role} probe @${shortTag(run)}`;
          check(`${tag}: sandbox cwd is /workspace/repository`, probe.cwd === "/workspace/repository", probe);
          check(`${tag}: sandbox PWD is /workspace/repository`, probe.pwd_env === "/workspace/repository", probe);
          check(`${tag}: sandbox INIT_CWD is /workspace/repository`, probe.init_cwd === "/workspace/repository", probe);
          check(`${tag}: committed scenario visible inside the envelope`, probe.scenario_present === "yes", probe);
          check(`${tag}: no host target path exposed`, !Object.values(probe).some((v) => typeof v === "string" && v.includes(targetReal)), probe);
          check(`${tag}: no decoy path exposed`, !Object.values(probe).some((v) => typeof v === "string" && v.includes(decoy)), probe);
        }
      }
      check(`L.7: ${role} emitted its envelope probe`, sawProbe, roles);
    }
    // Official repo integrity + decoy byte-identity.
    check("L.8: official HEAD unchanged (no commits by any role)", git(target, ["rev-parse", "HEAD"]) === headBefore);
    const decoyDiff = diffSnapshots(decoySnapBefore, snapshotTree(decoy));
    check("L.9: decoy directory byte-identical (no write escaped the target)",
      decoyDiff.added.length === 0 && decoyDiff.removed.length === 0 && decoyDiff.changed.length === 0, decoyDiff);
    check("L.9: no deliverable in the decoy", !fs.existsSync(path.join(decoy, DELIVERABLE_NAME)));
    check("L.9: no planner file in the decoy", !fs.existsSync(path.join(decoy, PLANNER_FILE_NAME)));
    // Survivor scan for this test's adapter processes.
    let survivors = null;
    const pgrep = spawnSync("sh", ["-lc", "command -v pgrep"], {encoding: "utf8", shell: false});
    if (pgrep.status === 0) {
      const ps = spawnSync("pgrep", ["-f", "fake-workflow-adapter.sh"], {encoding: "utf8", shell: false});
      const pids = String(ps.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
      survivors = pids.filter((pid) => {
        try {
          const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
          return cmd.includes("ap-wf-pwd-bin-");
        } catch { return false; }
      });
      check("L.10: no surviving fake-adapter descendant remains", survivors.length === 0, survivors);
    } else {
      console.log("SKIP L.10: pgrep unavailable — survivor scan skipped (leak-prefix check below still applies)");
    }
  } finally {
    strictCleanup("L", owned);
  }
}

// =====================================================================
// Main: skill snapshot before/after around everything; no early returns.
// =====================================================================
async function main() {
  const leakPrefixes = process.platform === "win32"
    ? ["ap-win-pwd-", "autopilot-reviewer-"]
    : ["ap-pwd-", "ap-wf-pwd-", "ap-pwd-unit-", "autopilot-reviewer-"];
  let preExisting = [];
  try { preExisting = listLeakedTemp(leakPrefixes); } catch (error) {
    check("leak baseline enumerable", false, error?.message || String(error));
  }
  const preExistingSet = new Set(preExisting);
  const skillBefore = snapshotSkill();

  runUnitSection();
  // Correction A.4: an unexpected throw inside a mission phase (e.g. a git
  // helper failing on a clobbered fixture) becomes a recorded failure —
  // leak checks, skill-tree integrity, and final reporting below still run.
  try {
    if (process.platform === "win32") await runWindowsMission();
    else await runLinuxMission();
  } catch (error) {
    check("mission phase raised no unexpected exception (reporting continues)", false,
      error?.stack ? String(error.stack).slice(0, 2000) : String(error));
  }

  // No leftover fixtures beyond what pre-existed this run.
  let leaked = [];
  try { leaked = listLeakedTemp(leakPrefixes).filter((p) => !preExistingSet.has(p)); }
  catch (error) { check("leak scan enumerable", false, error?.message || String(error)); }
  check("no leftover fixture/disposable-reviewer temp directories remain", leaked.length === 0, leaked);
  // Canonical skill tree byte-identical.
  const skillDiff = diffSnapshots(skillBefore, snapshotSkill());
  check("canonical skill tree byte-identical (no deliverable escaped the target)",
    skillDiff.added.length === 0 && skillDiff.removed.length === 0 && skillDiff.changed.length === 0, skillDiff);

  if (failures) {
    console.error(`\n${failures} pwd-authority check(s) failed.`);
    process.exit(1);
  }
  console.log("\npwd-authority PASS");
}

await main();
