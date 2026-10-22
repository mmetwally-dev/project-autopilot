#!/usr/bin/env node
// Backlog #5: adhoc reviews must mount the REAL repository as the envelope's
// /workspace/repository, never the adhoc output dir. Without this fix the
// reviewer sees .autopilot/adhoc/<ts>-<role>/ (which holds only the nested
// NN-<role>-<id8>/ run dir) and verdicts are meaningless.
//
// This drives the REAL runner+relay (bin/ap.cjs -> adhoc-runner ->
// runAdhocReview -> runRelay) with a disposable git repo + a fake adapter
// that lists /workspace/repository and reports the listing. Accept:
//   - the listing shows the repo's README.md (the repo is visible), and
//   - the listing does NOT contain the nested NN-<role>-<id8>/ run dir
//     (the adhoc output dir is NOT masquerading as the repository).
// Requires the bwrap envelope (WSL/Linux); skips otherwise.
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

if (process.platform !== "linux") {
  console.log("test-adhoc-repo-bind: SKIP — requires Linux (bwrap envelope).");
  process.exit(0);
}
{
  const bwrap = spawnSync("bwrap", ["--version"], { stdio: "ignore", shell: false });
  if (bwrap.status !== 0) {
    console.error("test-adhoc-repo-bind: SKIP — bwrap not available; the envelope cannot bind /workspace/repository.");
    process.exit(0);
  }
}

const skillRoot = process.cwd();
const apCjs = path.join(skillRoot, "bin", "ap.cjs");

// Fake adapter: lists the envelope repository dir (/workspace/repository) and
// reports the listing back as a review finding, so the test can assert exactly
// what the reviewer saw.
const FAKE_AGENT = `#!/usr/bin/env node
"use strict";
const { execSync } = require("child_process");
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("fake-adhoc-repo-bind 1.0.0\\n"); process.exit(0); }
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => { stdin += c; });
process.stdin.on("end", () => {
  let listing = "";
  try { listing = execSync("ls -1 /workspace/repository", { encoding: "utf8" }).trim(); }
  catch (e) { listing = "ERR:" + (e?.message || String(e)); }
  process.stdout.write("Done.\\nAUTOPILOT_REVIEW=" + JSON.stringify({ decision: "PASS", findings: ["REPO-LISTING:" + listing] }) + "\\n");
  process.exit(0);
});
`;

function git(repo, args) {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe", shell: false });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "adhoc-repo-bind-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "adhoc-repo-bind@example.invalid"]);
  git(repo, ["config", "user.name", "Adhoc Repo Bind"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture repo\n\nThe reviewer must see this file.\n");
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
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "adhoc-repo-bind-bin-"));
  const target = path.join(binDir, "cursor-agent");
  fs.writeFileSync(target, FAKE_AGENT);
  fs.chmodSync(target, 0o755);
  fs.writeFileSync(path.join(repo, "CRITERIA.md"), "# Acceptance criteria\n\n- [ ] README.md exists at the repository root\n");
  return { repo, binDir };
}

function runAp(repo, binDir, args) {
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH || ""}` };
  const r = spawnSync(process.execPath, [apCjs, ...args], {
    cwd: repo, encoding: "utf8", env, timeout: 180000, shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(!r.error, `spawn failed: ${r.error?.message || r.error}`);
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function latestAdhocDir(repo, role) {
  const base = path.join(repo, ".autopilot", "adhoc");
  const entries = fs.readdirSync(base).filter((e) => e.endsWith(`-${role}`));
  assert.ok(entries.length >= 1, `no adhoc dir for ${role} in ${base} (got [${entries}])`);
  entries.sort();
  return path.join(base, entries[entries.length - 1]);
}

const { repo, binDir } = makeRepo();
try {
  await check("verify-file: reviewer sees the REAL repo (README.md visible, output dir is not the repo)", async () => {
    const out = runAp(repo, binDir, ["verify-file", "CRITERIA.md"]);
    assert.equal(out.status, 0, `exit=${out.status} stderr=${out.stderr.slice(-500)}`);
    const listing = out.stdout.split("\n").find((l) => l.includes("REPO-LISTING:"));
    assert.ok(listing, "reviewer must report a /workspace/repository listing");
    const seen = listing.slice("REPO-LISTING:".length).trim();
    assert.ok(!seen.startsWith("ERR:"), `listing must succeed, got: ${seen}`);
    // The real repo's README.md is visible to the reviewer.
    assert.ok(seen.split(/\s+/).includes("README.md"), `reviewer must see README.md in /workspace/repository, saw: ${seen}`);
    // The adhoc output dir (nested NN-<role>-<id8>/) is NOT the repo root.
    assert.ok(!/verifier-[0-9a-f]{8}/.test(seen), `reviewer must NOT see the adhoc output dir as the repo, saw: ${seen}`);
    assert.ok(!/summary\.md/.test(seen), `reviewer must NOT see the adhoc summary as a repo file, saw: ${seen}`);
  });

  await check("verify-file: run artifacts still land in the adhoc output dir, not the repo", async () => {
    const parent = latestAdhocDir(repo, "verifier");
    const nested = fs.readdirSync(parent).filter((e) => /^\d{2,}-verifier-[0-9a-fA-F]{8}$/.test(e));
    assert.equal(nested.length, 1, `parent must hold exactly the nested run dir (got [${nested}])`);
    assert.ok(fs.existsSync(path.join(parent, nested[0], "result.json")), "relay result.json must exist in the adhoc output dir");
    assert.ok(fs.existsSync(path.join(parent, "summary.md")), "summary.md must exist in the adhoc output dir");
    // The repo itself must not gain a verifier run dir.
    assert.ok(!/verifier-[0-9a-f]{8}/.test(fs.readdirSync(repo).join(" ")), "repo must not hold a verifier run dir");
  });
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(binDir, { recursive: true, force: true });
}

console.log(`\n${ran - failed}/${ran} passed`);
if (failed > 0) process.exit(1);
console.log("test-adhoc-repo-bind: ALL CHECKS PASSED");
