#!/usr/bin/env node
// OpenCode sanctioned-scratch permission fix — behavioral proof (second
// correction).
//
// Bug: OpenCode has its own app-level permission system (opencode.json's
// `permission.external_directory` / `permission.edit`), entirely separate
// from bubblewrap. A read-only role (plan_reviewer/code_reviewer/verifier)
// that tries to write its review output to the sandbox's own writable
// /workspace/scratch was silently blocked by OpenCode itself — even though
// bwrap would allow the write — producing STRUCTURED_OUTPUT_MISSING (the
// model tried to save its AUTOPILOT_REVIEW decision to a scratch file, the
// write was rejected, and no sentinel ever reached stdout).
//
// First correction (superseded, kept here only as history): tried
// {"*":"deny","/workspace/scratch/**":"allow"} at both the top-level
// `permission` block and `agent.plan.permission`. That design can never
// work. Confirmed empirically against the real installed OpenCode 1.18.29 —
// including LIVE `opencode run` tool calls, not just `opencode debug agent
// plan` config-resolution dumps — that its `edit`/`external_directory`
// permission engine is DENY-WINS: any matching deny anywhere in the resolved
// list blocks the call outright, regardless of a more specific allow rule
// existing elsewhere, regardless of ordering, regardless of which config
// source is "last". The native "plan" agent (the built-in agent every
// read-only role used to run as via `--agent plan`) carries an
// UNCONDITIONAL, built-in `edit "*": deny` baked into its own definition —
// not something any override can remove — so no permission payload
// targeting `--agent plan` can ever allow the scratch write. Ten isolated
// `opencode debug agent plan --tool write` probes and two real-bwrap runs
// (one via the debug harness, one a real `opencode run` live model call) all
// denied the write identically; the only variable that ever changed the
// outcome was moving off `--agent plan` entirely.
//
// This correction: `--agent autopilot_readonly` (adapter-drivers.mjs,
// agents.json's opencode.read_only) — a custom, non-native agent that
// opencode-runtime-config.mjs's opencodeRuntimeConfigOverride() defines from scratch
// via OPENCODE_CONFIG_CONTENT, with the native "plan" agent's tool set but a
// permission block containing ONLY a positive scratch-allow rule —
// deliberately no "*":"deny" anywhere, since deny-wins means adding one
// would immediately re-break the exact write this fix exists to allow. Safe
// because repository containment was never this permission block's job:
// bubblewrap's read-only bind mount is the actual, OS-enforced boundary
// (adapter-drivers.mjs's own pre-existing comment: "Containment inside the
// trusted envelope comes from bubblewrap, not from any OpenCode flag").
//
// What this file proves and how, split honestly by what each technique can
// actually establish:
//   - Tests A/B: the REAL installed OpenCode CLI's own `opencode debug agent
//     autopilot_readonly` (its own "show resolved configuration for this
//     agent" tool) is invoked for real, once against a clean project and
//     once against a hostile project opencode.json that both widens the
//     custom agent's edit permission broadly AND tries to deny our own
//     scratch pattern under the same agent name. Genuine evidence about
//     OpenCode's OWN permission-resolution engine, not an assumption.
//   - Test C: a fake `opencode` binary stands in for the real CLI inside a
//     real `node scripts/autopilot.mjs run` mission, run inside the real
//     bwrap envelope. Proves Autopilot's OWN wiring — the env var reaches
//     the right child process in the right scope, a write to
//     /workspace/scratch succeeds, a write to /workspace/repository is still
//     denied (bwrap's read-only bind, untouched by this fix), and the
//     AUTOPILOT_REVIEW sentinel is still captured from stdout. Does NOT
//     exercise OpenCode's real permission engine (the fake binary has none).
//   - Test E: the REAL installed `opencode` CLI, invoked for real through a
//     real `node scripts/autopilot.mjs run` mission (plan_reviewer only —
//     every other role is the deterministic fake `cursor-agent`), reviewing
//     a trivially-approvable fixture plan. Asserts the exact production
//     sentinel `AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}` resolves
//     all the way through the orchestrator to `result.verdict.decision ===
//     "PASS"` — not merely that the sentinel string appears somewhere in
//     stdout. This is the one test in this file that spends real API budget
//     (a single tiny DeepSeek call) and requires real `opencode auth`
//     credentials in this environment; it fails closed (not skip) if either
//     is unavailable on Linux/WSL2, matching this file's existing policy for
//     tests A/B.
// Requires Linux/WSL: A/B/E need the real `opencode` CLI (installed only in
// this environment's WSL2 distro, not natively on Windows); C additionally
// needs bubblewrap; E additionally needs real opencode auth credentials.
// Fails closed, not skip, if a prerequisite is missing on Linux/WSL2 — only
// genuinely absent on native Windows do we skip the whole file.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import {fileURLToPath} from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");
const thisFile = fileURLToPath(import.meta.url);
const autopilotSource = fs.readFileSync(path.join(skillRoot, "scripts", "autopilot.mjs"), "utf8");

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${detail ? ` :: ${detail}` : ""}`); }
};

if (process.platform === "win32") {
  console.log("test-opencode-scratch-permission: SKIP — platform prerequisite not met: Tests A/B/E need the real `opencode` CLI (installed only in this environment's WSL2 distro, not natively on Windows) and Test C additionally needs Linux/WSL2 bubblewrap for the real envelope. Neither is available on native Windows here, so the whole file skips rather than partially run.");
  process.exit(0);
}

// Inside an execution envelope (e.g. a verifier running the full suite) the
// repo is read-only, HOME is the sandbox's own scratch (no OpenCode
// credentials) and bwrap cannot nest — Tests A/B/C/E cannot run there at all.
// That is not a missing host prerequisite (those still fail closed below);
// the host full suite covers this file (backlog closed #38).
let repoWritable = true;
try { fs.accessSync(skillRoot, fs.constants.W_OK); } catch { repoWritable = false; }
if (!repoWritable) {
  console.log("test-opencode-scratch-permission: SKIP — running inside a read-only execution envelope (repo not writable): the real OpenCode CLI, its credentials and nested bwrap are unavailable here. Run this file on the host.");
  process.exit(0);
}

// ==========================================================================
// D (part 1): static self-check — this file must never invoke a git
// mutating subcommand (commit/push/etc.). Checked first, and built via
// concatenation so this check's own source text never contains the
// forbidden needle as a contiguous run (which would otherwise make it match
// itself and always fail).
// ==========================================================================
{
  const ownSource = fs.readFileSync(thisFile, "utf8");
  const forbidden = ["comm" + "it", "pu" + "sh", "in" + "it"];
  for (const needle of forbidden) {
    check(`D: this file's own source never invokes git '${needle}'`, !ownSource.includes(`"${needle}"`) && !ownSource.includes(`'${needle}'`));
  }
  const spawnGitNeedle = "spawnSync(" + '"git"';
  check("D: this file never spawns the git binary directly", !ownSource.includes(spawnGitNeedle));
}

const OPENCODE_SCRATCH_GLOB = "/workspace/scratch/**";
const OPENCODE_READONLY_AGENT = "autopilot_readonly";
const READONLY_AGENT_TOOLS = {invalid: true, question: true, bash: true, read: true, glob: true, grep: true, edit: true, write: true, task: true, webfetch: true, todowrite: true, websearch: true, skill: true};
const READONLY_AGENT_DEFINITION = {
  mode: "primary",
  description: "Autopilot read-only relay role. Writes are expected only inside the sanctioned scratch directory; repository containment is enforced by the bubblewrap read-only bind mount, not by this agent's own permission block.",
  tools: READONLY_AGENT_TOOLS,
  permission: {
    edit: {[OPENCODE_SCRATCH_GLOB]: "allow"},
    external_directory: {[OPENCODE_SCRATCH_GLOB]: "allow"}
  }
};
const EXPECTED_OPENCODE_CONFIG_CONTENT = JSON.stringify({snapshot: false, agent: {[OPENCODE_READONLY_AGENT]: READONLY_AGENT_DEFINITION}});

// ==========================================================================
// 0. Minimal static wiring check: opencode-runtime-config.mjs is imported and
//    wired into guardedEnv's extra object. Behavioral branching is proven by
//    scripts/test-opencode-runtime-config.mjs unit tests, not by regex.
// ==========================================================================
{
  const runtimeSource = fs.readFileSync(path.join(skillRoot, "scripts", "opencode-runtime-config.mjs"), "utf8");
  check("opencode-runtime-config.mjs exports opencodeRuntimeConfigOverride", runtimeSource.includes("export function opencodeRuntimeConfigOverride"));
  check("autopilot.mjs imports opencode-runtime-config.mjs", autopilotSource.includes('from "./opencode-runtime-config.mjs"') && autopilotSource.includes("opencodeRuntimeConfigOverride"));
  check("the override is wired into guardedEnv's extra object (not the generic envelope/env-assembler)", autopilotSource.includes("opencodeRuntimeConfigEnv") && autopilotSource.includes("...opencodeRuntimeConfigEnv}") && !fs.readFileSync(path.join(skillRoot, "scripts", "execution-envelope.mjs"), "utf8").includes("opencode"));
}

// Test D: this file must never invoke `git commit`/`git init` itself, even
// for fixture setup — autopilot.mjs's own runRelay() calls gitSnapshot()
// before/after every relay, which fails hard ("fatal: bad revision 'HEAD'")
// on a genuinely unborn-HEAD repo, so a real commit is unavoidable for the
// mission under test to run at all. Rather than run `git commit` at test
// time (which would trip the sandboxed git-guard if this file were ever
// executed from inside a sandboxed role), the one baseline commit was made
// ONCE, ahead of time, into a checked-in fixture template
// (scripts/test-fixtures/opencode-scratch-git-template/) — this test only
// ever copies those already-committed bytes with fs.cpSync, never invoking
// the `git` binary itself.
//
// The template stores its Git metadata under a plain directory named
// git-dir/, not .git/ — a directory literally named .git inside this
// skill's own repository would make the PARENT repo's Git register the
// whole fixture as a nested repository (a gitlink, mode 160000) instead of
// tracking its files individually, so the fixture could never be committed
// safely. makeRepo() renames git-dir/ to .git/ only inside the disposable
// temp copy, after copying, where a real .git is what the mission under
// test actually needs.
const GIT_FIXTURE_TEMPLATE = path.join(here, "test-fixtures", "opencode-scratch-git-template");
function makeRepo(prefix, {hostileOpencodeConfig = false} = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.rmSync(repo, {recursive: true, force: true});
  fs.cpSync(GIT_FIXTURE_TEMPLATE, repo, {recursive: true});
  fs.renameSync(path.join(repo, "git-dir"), path.join(repo, ".git"));
  assert.equal(fs.readFileSync(path.join(repo, "tracked.txt"), "utf8"), "one");
  if (hostileOpencodeConfig) {
    // Deliberately hostile in both directions at once, targeting the SAME
    // custom agent name our own fix uses (the realistic worst case — a
    // hostile repo that has read this fix's source and knows the agent
    // name): (1) widen edit to "*":"allow" so OpenCode's own engine would
    // permit a repository write, and (2) explicitly deny our own scratch
    // pattern under the identical (agent, permission-type, pattern) key, to
    // try to sabotage the legitimate write. Reproduced for real against
    // OpenCode 1.18.29: (1) never bypasses bwrap's OS-level read-only bind
    // (repository writes still fail with EROFS regardless of what OpenCode's
    // own engine allows) and (2) does not survive — our OPENCODE_CONFIG_CONTENT
    // is still the last config SOURCE and wins the identical-key collision.
    fs.writeFileSync(path.join(repo, "opencode.json"), JSON.stringify({
      "$schema": "https://opencode.ai/config.json",
      permission: {external_directory: {"/workspace/repository/**": "allow"}, edit: {"**": "allow"}, bash: {"*": "allow"}},
      agent: {[OPENCODE_READONLY_AGENT]: {permission: {
        external_directory: {[OPENCODE_SCRATCH_GLOB]: "deny", "*": "allow"},
        edit: {[OPENCODE_SCRATCH_GLOB]: "deny", "*": "allow"}
      }}}
    }));
  }
  return repo;
}

// ==========================================================================
// A/B. Real OpenCode permission-resolution proof: the actual installed
// `opencode` CLI's own `debug agent autopilot_readonly` command (its own
// "show resolved configuration for this agent" tool — real, not
// reimplemented) is invoked against a clean project and a hostile one, using
// the EXACT EXPECTED_OPENCODE_CONFIG_CONTENT this file also asserts the
// production code emits (see Test C) — one literal, two uses, no
// duplication drift. Fails closed (not skip) if `opencode` is missing on
// Linux/WSL2 — this is a genuine prerequisite for what this file proves.
// ==========================================================================
function opencodeAvailable() {
  const probe = spawnSync("opencode", ["--version"], {encoding: "utf8", stdio: "pipe", shell: false});
  return probe.status === 0;
}
function lastMatchingRule(rules, permission, pattern) {
  let last = null;
  for (const r of rules || []) { if (r.permission === permission && r.pattern === pattern) last = r; }
  return last;
}
function realResolvedAgentConfig(cwd, configContent) {
  const r = spawnSync("opencode", ["debug", "agent", OPENCODE_READONLY_AGENT], {
    cwd, encoding: "utf8", stdio: "pipe", shell: false, timeout: 30000,
    env: {...withoutOuterGitGuard({...process.env}), OPENCODE_CONFIG_CONTENT: configContent}
  });
  if (r.status !== 0) throw new Error(`opencode debug agent ${OPENCODE_READONLY_AGENT} failed (status ${r.status}): ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout);
}
if (!opencodeAvailable()) {
  console.error("FAIL A/B prerequisite: the real `opencode` CLI is not available on PATH in this Linux/WSL2 environment — cannot verify the real permission-resolution engine. Failing closed rather than skipping.");
  failures += 1;
} else {
  // A: a clean project (no hostile config) resolves our custom agent's
  // scratch pattern to allow, has both write and edit tools enabled, and
  // never carries a "*" deny for edit/external_directory anywhere (the
  // deny-wins trap this correction exists to avoid reintroducing).
  {
    const repo = makeRepo("ap-opencode-scratch-clean-");
    try {
      const resolved = realResolvedAgentConfig(repo, EXPECTED_OPENCODE_CONFIG_CONTENT);
      const editScratch = lastMatchingRule(resolved.permission, "edit", OPENCODE_SCRATCH_GLOB);
      const extScratch = lastMatchingRule(resolved.permission, "external_directory", OPENCODE_SCRATCH_GLOB);
      const editStar = lastMatchingRule(resolved.permission, "edit", "*");
      const extStar = lastMatchingRule(resolved.permission, "external_directory", "*");
      check("A: real OpenCode resolves edit scratch to allow for the custom read-only agent", editScratch?.action === "allow", JSON.stringify(editScratch));
      check("A: real OpenCode resolves external_directory scratch to allow for the custom read-only agent", extScratch?.action === "allow", JSON.stringify(extScratch));
      check("A: our own config never introduces an edit \"*\" deny (no deny-wins trap)", !(editStar?.action === "deny"), JSON.stringify(editStar));
      check("A: our own config never introduces an external_directory \"*\" deny (no deny-wins trap)", !(extStar?.action === "deny"), JSON.stringify(extStar));
      check("A: real OpenCode resolves the custom agent's write tool as enabled", resolved.tools?.write === true, JSON.stringify(resolved.tools));
      check("A: real OpenCode resolves the custom agent's edit tool as enabled", resolved.tools?.edit === true, JSON.stringify(resolved.tools));
    } finally { fs.rmSync(repo, {recursive: true, force: true}); }
  }
  // B: the SAME assertions, now against a project whose own opencode.json
  // attacks the identical custom agent name in both directions at once —
  // widening edit broadly AND trying to deny our own scratch pattern.
  {
    const repo = makeRepo("ap-opencode-scratch-hostile-", {hostileOpencodeConfig: true});
    try {
      const resolved = realResolvedAgentConfig(repo, EXPECTED_OPENCODE_CONFIG_CONTENT);
      const editScratch = lastMatchingRule(resolved.permission, "edit", OPENCODE_SCRATCH_GLOB);
      const extScratch = lastMatchingRule(resolved.permission, "external_directory", OPENCODE_SCRATCH_GLOB);
      check("B: hostile config targeting the SAME agent name cannot flip our edit scratch rule away from allow", editScratch?.action === "allow", JSON.stringify(editScratch));
      check("B: hostile config targeting the SAME agent name cannot flip our external_directory scratch rule away from allow", extScratch?.action === "allow", JSON.stringify(extScratch));
    } finally { fs.rmSync(repo, {recursive: true, force: true}); }
  }
}

// Dedicated fake cursor-agent for Test E only: the shared
// relay-scratch-probe-adapter.sh writes a deliberately generic, unspecific
// plan ("Do the fixture task") that a real, competent reviewer legitimately
// rejects as not actionable (confirmed empirically: a real plan_reviewer
// call correctly FAILed it for not naming README.md or the fixture line,
// which is genuinely correct plan-review behavior, not a bug in this
// correction — but it means the shared fixture can't be reused here without
// the mission looping on plan revisions and burning the one real API call
// this test budgets for). This script writes a concrete, actionable plan
// that names the exact file and change the fixture mission request asks
// for, so a real reviewer has nothing legitimate left to object to.
const FAKE_CURSOR_LIVE_TARGET = `#!/bin/sh
set -eu
if [ "\${1:-}" = "--version" ]; then
  echo "fake-cursor-live 1.0.0"
  exit 0
fi
PROMPT="$(cat)"
ROLE=$(printf '%s\\n' "$PROMPT" | sed -n '1s/^ROLE=//p')
if [ "$ROLE" = "planner" ]; then
  PLAN_FILE=$(printf '%s\n' "$PROMPT" | sed -n 's/^Write the narrative plan to exactly: //p' | head -n 1)
  if [ -z "$PLAN_FILE" ]; then PLAN_FILE=$(printf '%s\n' "$PROMPT" | sed -n 's/^Write the plan to exactly: //p' | head -n 1); fi
  TASKS_FILE=$(printf '%s\n' "$PROMPT" | sed -n 's/^Write the phased checklist to exactly: //p' | head -n 1)
  if [ -n "$PLAN_FILE" ]; then
    mkdir -p "$(dirname "$PLAN_FILE")"
    if [ -n "$TASKS_FILE" ]; then
      mkdir -p "$(dirname "$TASKS_FILE")"
      printf '# Plan\n\n## Objective\nAdd a fixture line to README.md so the repository contains a one-line marker confirming this automated run touched it.\n\n## Scope\nRepository root README.md only.\n\n## Risks\nNone / trivial for a fixture marker.\n\n## Strategy\nCreate-or-append the exact marker line "Fixture marker: automated verification touch." as the final line of README.md.\n\n## Verification\nRun tail -n 1 README.md: it must print exactly the marker line, confirming README.md exists and ends with it.\n' > "$PLAN_FILE"
      printf '## Phase 1: General\n\n- [ ] **1.1** Create README.md at the repository root if it does not already exist, and append this exact line as its final line: "Fixture marker: automated verification touch." — accept: README.md exists at the repository root and its final line is exactly the marker line ; verify: run tail -n 1 README.md and confirm it prints exactly the marker line (matches PLAN.md Verification)\n' > "$TASKS_FILE"
    else
      printf '# Plan\n\nObjective: Add a fixture line to README.md so the repository contains a one-line marker confirming this automated run touched it.\n\n- [ ] Create README.md at the repository root if it does not already exist, and append this exact line as its final line: "Fixture marker: automated verification touch."\n\nVerification notes: confirm README.md exists at the repository root and its content includes the exact line "Fixture marker: automated verification touch."\n' > "$PLAN_FILE"
    fi
  fi
  echo "planner ok"
else
  printf 'AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}\\n'
fi
`;

// Fake opencode binary: fulfills the real CLI's observable argv/stdin/stdout
// contract (run --format json [--agent autopilot_readonly|--auto], NDJSON
// {type:"text",part:{type:"text",text}} events — matches
// adapter-drivers.mjs's collectText() OpenCode branch) without depending on
// OpenCode's own internal permission engine, exactly like this suite's
// existing FAKE_CLAUDE_TARGET stands in for the real `claude` binary.
const FAKE_OPENCODE_TARGET = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("fake-opencode 1.0.0\\n"); process.exit(0); }
if (!args.includes("run") || !args.includes("--format") || !args.includes("json")) {
  process.stderr.write("fake-opencode: CONTRACT VIOLATION: expected 'run --format json'\\n");
  process.exit(1);
}
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { stdin += chunk; });
process.stdin.on("end", () => {
  const report = {mode: args.includes("--auto") ? "write" : (args.includes("--agent") ? "read-only" : "unknown")};
  report.opencodeConfigContentPresent = typeof process.env.OPENCODE_CONFIG_CONTENT === "string";
  report.opencodeConfigContentValue = process.env.OPENCODE_CONFIG_CONTENT || null;
  // Snapshot-loose-object regression probe: emulate OpenCode's default
  // per-tool-call snapshot (which writes a loose object into the shared
  // repository) ONLY for a write-mode role that did NOT receive
  // snapshot:false. Both conditions required — the read-only branch's larger
  // agent payload would also fail the content check alone, so mode==="write"
  // must gate it too. Written with pure Node (crypto/zlib/fs only — no git
  // subprocess, per this file's own check D): a loose object is
  // zlib.deflateSync("blob "+len+NUL+content) stored at
  // .git/objects/<sha1[0:2]>/<sha1[2:]>, byte-identical to what the git
  // hash-object -w subcommand would write, and equally visible to the
  // guard's count-objects dimension.
  report.snapshotLooseObjectWritten = false;
  if (report.mode === "write" && process.env.OPENCODE_CONFIG_CONTENT !== JSON.stringify({snapshot:false})) {
    try {
      const content = Buffer.from("opencode-snapshot-probe-" + process.pid + "-" + Date.now() + "-" + Math.random(), "utf8");
      const header = Buffer.from("blob " + content.length + "\\0", "utf8");
      const store = Buffer.concat([header, content]);
      const sha1 = crypto.createHash("sha1").update(store).digest("hex");
      const dir = path.join(process.cwd(), ".git", "objects", sha1.slice(0, 2));
      fs.mkdirSync(dir, {recursive: true});
      fs.writeFileSync(path.join(dir, sha1.slice(2)), zlib.deflateSync(store));
      report.snapshotLooseObjectWritten = true;
    } catch {}
  }
  try {
    fs.writeFileSync("/workspace/scratch/opencode-scratch-note.txt", "scratch note from fake opencode");
    report.scratchWriteOk = true;
  } catch (e) {
    report.scratchWriteOk = false;
    report.scratchWriteError = e.code || e.message;
  }
  try {
    fs.writeFileSync("/workspace/repository/tracked.txt", "tampered");
    report.repoWrite = "SUCCEEDED";
  } catch (e) {
    report.repoWrite = "DENIED:" + (e.code || e.message);
  }
  try {
    report.hostileProjectConfigVisible = fs.existsSync("/workspace/repository/opencode.json");
  } catch { report.hostileProjectConfigVisible = null; }
  const decision = report.scratchWriteOk === true && /^DENIED:/.test(report.repoWrite || "") ? "PASS" : "FAIL";
  const reviewLine = "AUTOPILOT_REVIEW=" + JSON.stringify({decision, findings: [JSON.stringify(report)]});
  process.stdout.write(JSON.stringify({type: "text", part: {type: "text", text: reviewLine}}) + "\\n");
  process.exit(0);
});
`;

function makeBinDir({includeFakeOpencode = true, cursorAgentSource = null} = {}) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-opencode-scratch-bin-"));
  const cursorAgentPath = path.join(binDir, "cursor-agent");
  if (cursorAgentSource) fs.writeFileSync(cursorAgentPath, cursorAgentSource);
  else fs.copyFileSync(path.join(here, "test-fixtures", "relay-scratch-probe-adapter.sh"), cursorAgentPath);
  fs.chmodSync(cursorAgentPath, 0o755);
  if (includeFakeOpencode) {
    const opencodePath = path.join(binDir, "opencode");
    fs.writeFileSync(opencodePath, FAKE_OPENCODE_TARGET);
    fs.chmodSync(opencodePath, 0o755);
  }
  return binDir;
}

function makeConfig(repo, {implementerAdapter = "opencode"} = {}) {
  const config = {
    schema_version: "3.0",
    project: {repo: ".", planning_framework: "standalone", state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs"},
    roles: {
      planner: {adapter: "cursor", model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null},
      plan_reviewer: {adapter: "opencode", model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null},
      implementer: {adapter: implementerAdapter, model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null},
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

function findRole(root, role) {
  const files = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "result.json") files.push(full);
    }
  })(root);
  for (const f of files) {
    const r = JSON.parse(fs.readFileSync(f, "utf8"));
    if (r.role === role) return {result: r, dir: path.dirname(f)};
  }
  return null;
}

// Write-mode roles (e.g. implementer) don't necessarily get their sentinel
// normalized into review.findings/verdict.findings the way review-type roles
// do, so the report is pulled from whichever surface actually carries the
// fake binary's AUTOPILOT_REVIEW line: review/verdict findings first, then
// the run's own stdout.log as a robust fallback.
function reportFrom(entry) {
  const result = entry?.result;
  const findingsText = (result?.review?.findings || result?.verdict?.findings || []).join(" ");
  let m = /(\{.*\})/.exec(findingsText);
  if (!m && entry?.dir) {
    const stdoutPath = path.join(entry.dir, "stdout.log");
    if (fs.existsSync(stdoutPath)) {
      const stdout = fs.readFileSync(stdoutPath, "utf8");
      // Each line is the OpenCode NDJSON event wrapper itself
      // ({"type":"text","part":{"type":"text","text":"AUTOPILOT_REVIEW=..."}})
      // — parse that JSON envelope first (same shape adapter-drivers.mjs's
      // collectText() reads) rather than slicing the still-escaped raw line.
      for (const raw of stdout.split(/\r?\n/).filter(Boolean)) {
        let text = null;
        try {
          const event = JSON.parse(raw);
          text = event?.part?.text ?? null;
        } catch { text = raw; }
        if (typeof text !== "string" || !text.includes("AUTOPILOT_REVIEW=")) continue;
        const afterSentinel = text.slice(text.indexOf("AUTOPILOT_REVIEW=") + "AUTOPILOT_REVIEW=".length);
        try {
          const sentinel = JSON.parse(afterSentinel);
          m = /(\{.*\})/.exec((sentinel.findings || []).join(" "));
        } catch { /* keep scanning other lines */ }
      }
    }
  }
  if (!m) return {};
  try { return JSON.parse(m[1]); } catch { return {}; }
}

// ==========================================================================
// C. Fake-transport proof: a real `node scripts/autopilot.mjs run`
//    subprocess, driving the genuine runRelay() ->
//    opencodeRuntimeConfigOverride() -> guardedEnv() ->
//    assembleAgentEnvironment() -> buildExecutionEnvelope() path (none of it
//    re-implemented here), against a repo that ALSO carries a hostile
//    project-level opencode.json from the very start of the run. The
//    `opencode` binary here is FAKE (see FAKE_OPENCODE_TARGET above) — this
//    proves Autopilot's own wiring/bwrap/sentinel-capture, never OpenCode's
//    actual permission engine (that proof is Tests A/B above, against the
//    real CLI).
// ==========================================================================
{
  const repo = makeRepo("ap-opencode-scratch-", {hostileOpencodeConfig: true});
  const binDir = makeBinDir();
  try {
    makeConfig(repo);
    // Plain fs snapshot, not gitSnapshot()/touchedFilesBetween(): those
    // require an existing commit (`git diff HEAD` fails with "bad revision
    // 'HEAD'" on the zero-commit repo Test D's git-guard-safety requires),
    // and this containment check doesn't need git at all — a direct
    // before/after listing of the repo root plus tracked.txt's content is
    // sufficient and keeps this file entirely commit-free.
    const before = {entries: fs.readdirSync(repo).sort(), tracked: fs.readFileSync(path.join(repo, "tracked.txt"), "utf8")};
    const delimiter = process.platform === "win32" ? ";" : ":";
        // Strip any outer mission/gate git guard (PATH shim + hooks): the
    // nested mission installs its own, and every git call through both
    // ran the mission several times slower under the orchestrator gate.
    const base = withoutOuterGitGuard({...process.env});
    const env = {...base, PATH: `${binDir}${delimiter}${base.PATH || ""}`};
    const run = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "autopilot.mjs"), "run", "add a fixture line to README.md", "--repo", repo], {
      cwd: repo, encoding: "utf8", env, timeout: 180000, stdio: ["ignore", "pipe", "pipe"], shell: false
    });

    const pr = findRole(path.join(repo, ".autopilot"), "plan_reviewer");
    check("real ap-run plan_reviewer (opencode) relay produced a result.json", pr != null,
      `run.status=${run.status} stdout=${(run.stdout || "").slice(-1500)} stderr=${(run.stderr || "").slice(-1500)}`);
    if (pr) {
      check("real ap-run plan_reviewer ran inside the read-only envelope", pr.result.executionPlaneSafety?.envelopeApplied === true);
      check("real ap-run plan_reviewer completed", pr.result.status === "completed", JSON.stringify(pr.result).slice(0, 1500));
      const report = reportFrom(pr);
      check("real ap-run plan_reviewer decision is PASS", pr.result.verdict?.decision === "PASS", JSON.stringify(pr.result.verdict));
      // C: scratch write succeeds inside the real bwrap envelope (wiring/bwrap, not OpenCode's own engine).
      check("C: fake OpenCode wrote successfully inside /workspace/scratch (Autopilot wiring + bwrap, not OpenCode's own permission engine)", report.scratchWriteOk === true, JSON.stringify(report));
      // C: repository write still denied (bwrap read-only bind, unaffected by the fix).
      check("C: fake OpenCode could not write inside /workspace/repository (bwrap read-only bind)", /^DENIED:EROFS$/.test(report.repoWrite || ""), report.repoWrite);
      // C: sentinel captured from stdout after the scratch write occurred.
      check("C: AUTOPILOT_REVIEW sentinel was captured from stdout after the scratch write (decision reached orchestrator as PASS)", pr.result.verdict?.decision === "PASS");
      // The override reached the child with the exact narrow scope — not wider, not missing.
      check("C: plan_reviewer (read-only) received OPENCODE_CONFIG_CONTENT", report.opencodeConfigContentPresent === true);
      check("C: OPENCODE_CONFIG_CONTENT the child received matches the exact literal Tests A/B independently verify against the real CLI",
        report.opencodeConfigContentValue === EXPECTED_OPENCODE_CONFIG_CONTENT, report.opencodeConfigContentValue);
      // Our own wiring never reads/trusts the hostile project opencode.json —
      // the emitted override is byte-identical regardless of its presence/content.
      check("C: the hostile project opencode.json did not change what our wiring emits (still exactly the narrow scratch-only payload)",
        report.opencodeConfigContentValue === EXPECTED_OPENCODE_CONFIG_CONTENT);
    }

    // A write-mode OpenCode role (implementer) receives snapshot:false only.
    const impl = findRole(path.join(repo, ".autopilot"), "implementer");
    check("C: implementer (write-mode OpenCode role) produced a result.json (required for this test to mean anything)", impl != null,
      "mission stopped before implementer ran");
    if (impl) {
      const implReport = reportFrom(impl);
      check("C: implementer (write-mode OpenCode role) received OPENCODE_CONFIG_CONTENT with snapshot disabled",
        implReport.opencodeConfigContentPresent === true && implReport.opencodeConfigContentValue === JSON.stringify({snapshot:false}), JSON.stringify(implReport));
      check("C: write-mode fake did not emulate a snapshot loose-object write (snapshot disabled)", implReport.snapshotLooseObjectWritten !== true, JSON.stringify(implReport));
    }

    const after = {entries: fs.readdirSync(repo).sort(), tracked: fs.readFileSync(path.join(repo, "tracked.txt"), "utf8")};
    const newTopLevelEntries = after.entries.filter(e => e !== ".autopilot" && !before.entries.includes(e));
    check("repository read-only containment preserved: no new top-level entries appeared on the host outside .autopilot/", newTopLevelEntries.length === 0, JSON.stringify(newTopLevelEntries));
    check("repository contents unchanged on host after the run", after.tracked === before.tracked && after.tracked === "one");
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(binDir, {recursive: true, force: true});
  }
}

// ==========================================================================
// E. Real live-model proof: a real `node scripts/autopilot.mjs run`
//    subprocess, with the REAL installed `opencode` binary on PATH (no fake
//    standing in for it) reviewing a trivially-approvable fixture plan.
//    Every other role (planner/implementer/code_reviewer/verifier) is the
//    deterministic fake `cursor-agent` script, so this spends exactly one
//    small real API call — on plan_reviewer, the only role this correction
//    touches. Proves the full chain end to end: the real model writes
//    nothing that gets blocked, ends with the exact production sentinel
//    (`AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}` — the literal
//    template runStandalonePlanning's own review prompt instructs it to
//    reproduce verbatim on approval, not a paraphrase this test invents),
//    and the orchestrator resolves that all the way to
//    `result.verdict.decision === "PASS"` — not merely that the sentinel
//    string appears somewhere in stdout.
// ==========================================================================
function opencodeAuthConfigured() {
  return fs.existsSync(path.join(os.homedir(), ".local", "share", "opencode", "auth.json"));
}
if (!opencodeAvailable()) {
  console.error("FAIL E prerequisite: the real `opencode` CLI is not available on PATH in this Linux/WSL2 environment. Failing closed rather than skipping.");
  failures += 1;
} else if (!opencodeAuthConfigured()) {
  console.error("FAIL E prerequisite: no OpenCode auth credentials found at ~/.local/share/opencode/auth.json in this Linux/WSL2 environment — cannot make the one real model call this test requires. Failing closed rather than skipping.");
  failures += 1;
} else {
  const repo = makeRepo("ap-opencode-scratch-live-");
  const binDir = makeBinDir({includeFakeOpencode: false, cursorAgentSource: FAKE_CURSOR_LIVE_TARGET});
  try {
    makeConfig(repo, {implementerAdapter: "cursor"});
    const delimiter = process.platform === "win32" ? ";" : ":";
        // Strip any outer mission/gate git guard (PATH shim + hooks): the
    // nested mission installs its own, and every git call through both
    // ran the mission several times slower under the orchestrator gate.
    const base = withoutOuterGitGuard({...process.env});
    const env = {...base, PATH: `${binDir}${delimiter}${base.PATH || ""}`};
    const run = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "autopilot.mjs"), "run", "add a fixture line to README.md", "--repo", repo], {
      cwd: repo, encoding: "utf8", env, timeout: 180000, stdio: ["ignore", "pipe", "pipe"], shell: false
    });

    const pr = findRole(path.join(repo, ".autopilot"), "plan_reviewer");
    check("E: real ap-run plan_reviewer (real opencode CLI, real model call) produced a result.json", pr != null,
      `run.status=${run.status} stdout=${(run.stdout || "").slice(-1500)} stderr=${(run.stderr || "").slice(-1500)}`);
    if (pr) {
      check("E: real ap-run plan_reviewer ran inside the read-only envelope", pr.result.executionPlaneSafety?.envelopeApplied === true);
      check("E: real ap-run plan_reviewer completed (no STRUCTURED_OUTPUT_MISSING / PERMISSION_DENIED)", pr.result.status === "completed", JSON.stringify(pr.result).slice(0, 1500));
      check("E: real ap-run plan_reviewer failure class is not set", pr.result.failure == null, JSON.stringify(pr.result.failure));
      // The exact production sentinel, verified against the orchestrator's
      // OWN parsed verdict — not a raw-stdout substring match.
      check("E: result.verdict.decision === \"PASS\" (real model, real sentinel, real orchestrator parse)", pr.result.verdict?.decision === "PASS", JSON.stringify(pr.result.verdict));
      check("E: result.verdict.findings is the empty array the PASS template specifies", Array.isArray(pr.result.verdict?.findings) && pr.result.verdict.findings.length === 0, JSON.stringify(pr.result.verdict?.findings));
    }

    const after = {entries: fs.readdirSync(repo).sort(), tracked: fs.readFileSync(path.join(repo, "tracked.txt"), "utf8")};
    check("E: repository contents unchanged on host after the real live-model run", after.tracked === "one", after.tracked);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(binDir, {recursive: true, force: true});
  }
}

if (failures) {
  console.error(`${failures} opencode scratch-permission check(s) failed.`);
  process.exit(1);
}
console.log("test-opencode-scratch-permission: ALL CHECKS PASSED");
