#!/usr/bin/env node
// Backlog #6: adhoc reviews must not crash the read-only snapshot when the
// relay runs from the adhoc output dir (.autopilot/adhoc/<ts>-<role>/).
//
// Before the fix, `git ls-files --others --ignored --directory -- .
// ':(exclude).autopilot/**'` (relay-guards.mjs gitSnapshot) aborted with
// "fatal: git ls-files: internal error - directory entry not superset of
// prefix" (exit 128) because the run's cwd — the adhoc output dir — sits
// inside the wholly-ignored, excluded .autopilot tree. The identical command
// from the repository top level exits 0. gitSnapshot now pins the repository
// top level for every git call.
//
// Two layers of coverage:
//   1. Direct: gitSnapshot(adhocDir) succeeds in a real temp repo whose
//      .autopilot/ is IGNORED, and yields the same fingerprint as
//      gitSnapshot(repoRoot).
//   2. End to end: `ap verify-file` runs through the real runner/relay with
//      the same ignored .autopilot/ fixture and reaches the fake model,
//      writing summary.md.
// Fixtures live under $TMPDIR, outside the project repo.
// Run: node scripts/test-adhoc-snapshot-repo-root.mjs
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

let failed = 0;
let ran = 0;
const check = (name, fn) => {
  ran++;
  try {
    const r = fn();
    if (r && typeof r.then === "function") return r.then(
      () => console.log(`PASS ${name}`),
      (e) => { failed++; console.log(`FAIL ${name} :: ${e?.message || String(e)}`); },
    );
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name} :: ${e?.message || String(e)}`);
  }
};

const skillRoot = process.cwd();
const apCjs = path.join(skillRoot, "bin", "ap.cjs");

// Fake adapter (same pattern as test-091-adhoc-roles-e2e.mjs): answers
// --version and emits AUTOPILOT_REVIEW per ROLE= stdin line.
const FAKE_AGENT = `#!/usr/bin/env node
"use strict";
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("fake-snapshot-root-agent 1.0.0\\n"); process.exit(0); }
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => { stdin += c; });
process.stdin.on("end", () => {
  const roleLine = (stdin.trimStart().split(/\\r?\\n/, 1)[0] || "");
  const role = roleLine.startsWith("ROLE=") ? roleLine.slice("ROLE=".length).trim() : "";
  const review = role === "verifier"
    ? {decision: "PASS", findings: ["criterion 1: PASS SNAPSHOT-ROOT-CRITERION"]}
    : {decision: "PASS", findings: []};
  process.stdout.write("Done.\\nAUTOPILOT_REVIEW=" + JSON.stringify(review) + "\\n");
  process.exit(0);
});
`;

function git(repo, args) {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe", shell: false });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
}

// Real temp git repo whose .autopilot/ is IGNORED (the precondition for the
// crash). Secrets-free standalone config + disposable review input.
function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "adhoc-snapshot-root-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "adhoc-snapshot@example.invalid"]);
  git(repo, ["config", "user.name", "Adhoc Snapshot"]);
  fs.writeFileSync(path.join(repo, ".gitignore"), ".autopilot/\n");
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  const role = { adapter: "cursor", model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null };
  const config = {
    schema_version: "3.0",
    project: { repo: ".", planning_framework: "standalone", state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs" },
    roles: Object.fromEntries(["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"].map((r) => [r, { ...role }])),
    workflow: {
      specReview: true, planReview: true, analysisAfterTasks: true, implementationReview: true, finalReview: true,
      autoApproveSpec: false, autoApprovePlan: false, parallelIndependentTasks: false, gsdPlanningReview: false,
      relaySafety: { block_git_commit_push: true, verify_read_only_by_snapshot: true, capture_touched_files: true, persist_role_sessions: true },
    },
    gates: { commands: [], env_allowlist: [], require_reviewer: true, network_isolation: true },
    policy: {
      max_plan_revisions: 3, retry_delay_ms: 0, checkpoint_after_task: true, checkpoint_after_phase: true,
      require_human_commit: true, fail_closed_on_relay_violation: true,
      failure_budgets: { implementationFailureBudget: 5, verificationFailureBudget: 5, adapterRetryBudget: 5, infrastructureRetryBudget: 5 },
    },
    safety: { allow_git_commit: false, allow_git_push: false, allow_destructive_operations: false },
  };
  fs.mkdirSync(path.join(repo, ".autopilot"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(repo, "CRITERIA.md"), "# Acceptance criteria\n\n- [ ] SNAPSHOT-ROOT-CRITERION the widget renders\n");
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "adhoc-snapshot-root-bin-"));
  const target = path.join(binDir, "cursor-agent");
  fs.writeFileSync(target, FAKE_AGENT);
  fs.chmodSync(target, 0o755);
  return { repo, binDir };
}

const { repo, binDir } = makeRepo();
try {
  const adhocDir = path.join(repo, ".autopilot", "adhoc", "20260101T000000-verifier");
  fs.mkdirSync(adhocDir, { recursive: true });

  await check("gitSnapshot from the adhoc output dir (ignored .autopilot/) succeeds", async () => {
    const { gitSnapshot } = await import("./relay-guards.mjs");
    const snap = gitSnapshot(adhocDir);
    assert.ok(snap && typeof snap.fingerprint === "string" && snap.fingerprint.length > 0, "snapshot must carry a fingerprint");
  });

  await check("adhoc-dir snapshot fingerprint equals the repo-root snapshot", async () => {
    const { gitSnapshot } = await import("./relay-guards.mjs");
    assert.equal(gitSnapshot(adhocDir).fingerprint, gitSnapshot(repo).fingerprint, "both cwds must fingerprint the same repository state");
  });

  await check("ap verify-file e2e reaches the model and writes summary.md (ignored .autopilot/)", () => {
    const env = { ...process.env, PATH: `${binDir}:${process.env.PATH || ""}` };
    const r = spawnSync(process.execPath, [apCjs, "verify-file", "CRITERIA.md", "--cmd", "echo SNAPSHOT-ROOT-CMD-OK"], {
      cwd: repo, encoding: "utf8", env, timeout: 180000, shell: false, stdio: ["ignore", "pipe", "pipe"],
    });
    assert.ok(!r.error, `spawn failed: ${r.error?.message || r.error}`);
    assert.equal(r.status, 0, `exit=${r.status} stderr=${String(r.stderr || "").slice(-800)}`);
    assert.ok(String(r.stdout || "").includes("Verdict: PASS"), "printed verdict must be PASS");
    const base = path.join(repo, ".autopilot", "adhoc");
    const parents = fs.readdirSync(base).filter((e) => e.endsWith("-verifier"));
    assert.ok(parents.length >= 1, `no verifier adhoc dir under ${base}`);
    parents.sort();
    const parent = path.join(base, parents[parents.length - 1]);
    const summary = fs.readFileSync(path.join(parent, "summary.md"), "utf8");
    assert.ok(summary.includes("Verdict: PASS"), "summary.md must record the verdict");
    assert.ok(summary.includes("SNAPSHOT-ROOT-CRITERION"), "summary.md must record the model findings");
  });
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(binDir, { recursive: true, force: true });
}

console.log(`\n${ran - failed}/${ran} passed`);
if (failed > 0) process.exit(1);
