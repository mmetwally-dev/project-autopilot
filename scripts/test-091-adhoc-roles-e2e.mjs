#!/usr/bin/env node
// Mission 091 task 3.4: adhoc role-dispatch end-to-end coverage.
//
// Accept: one fake-adapter end-to-end per command (plan-review, code-review,
// verify-file) through the real runner+relay (bin/ap.cjs -> adhoc-runner ->
// runAdhocReview -> runRelay) with disposable fixtures + spawnSync, reusing
// the existing fake-adapter pattern (a committed-file-free static fake
// `cursor-agent` that answers --version and emits AUTOPILOT_REVIEW per ROLE=
// stdin line, as in test-review-feedback-persistence.mjs).
// Verdict+findings must be printed and saved per role; the verifier must
// report PASS/FAIL per criterion with --cmd evidence.
// Fixtures live under $TMPDIR, outside the project repo.
// Run: node scripts/test-091-adhoc-roles-e2e.mjs
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

// The reviewer's verdict switches per ROLE= stdin first line (the relay
// prefixes the prompt with ROLE=<role>). Static per role: no committed
// scenario file needed because each adhoc command maps to exactly one role.
const FAKE_AGENT = `#!/usr/bin/env node
"use strict";
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("fake-091-e2e-agent 1.0.0\\n"); process.exit(0); }
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => { stdin += c; });
process.stdin.on("end", () => {
  const roleLine = (stdin.trimStart().split(/\\r?\\n/, 1)[0] || "");
  const role = roleLine.startsWith("ROLE=") ? roleLine.slice("ROLE=".length).trim() : "";
  let review;
  if (role === "plan_reviewer") review = {decision: "PASS", findings: ["E2E-PLAN-FINDING: the fixture plan covers its scope"]};
  else if (role === "code_reviewer") review = {decision: "PASS", findings: ["E2E-DIFF-FINDING: the fixture diff is clean"]};
  else if (role === "verifier") review = {decision: "PASS", findings: ["criterion 1: PASS E2E-CRITERION-ONE rendered", "criterion 2: PASS E2E-CRITERION-TWO saved"]};
  else review = {decision: "PASS", findings: []};
  process.stdout.write("Done.\\nAUTOPILOT_REVIEW=" + JSON.stringify(review) + "\\n");
  process.exit(0);
});
`;

function git(repo, args) {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe", shell: false });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "091-adhoc-roles-e2e-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "adhoc-e2e@example.invalid"]);
  git(repo, ["config", "user.name", "Adhoc E2E"]);
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
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "091-adhoc-roles-e2e-bin-"));
  const target = path.join(binDir, "cursor-agent");
  fs.writeFileSync(target, FAKE_AGENT);
  fs.chmodSync(target, 0o755);
  // Disposable review inputs.
  fs.writeFileSync(path.join(repo, "PLAN.md"), "# Plan\n\nDo the fixture thing.\n");
  fs.writeFileSync(path.join(repo, "change.diff"), "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n");
  fs.writeFileSync(path.join(repo, "CRITERIA.md"), "# Acceptance criteria\n\n- [ ] E2E-CRITERION-ONE the widget renders\n- [ ] E2E-CRITERION-TWO the widget saves\n");
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

// Latest parent adhoc dir for a role: .autopilot/adhoc/*-<role>/.
function findParentAdhocDir(repo, role) {
  const base = path.join(repo, ".autopilot", "adhoc");
  const entries = fs.readdirSync(base).filter((e) => e.endsWith(`-${role}`));
  assert.ok(entries.length >= 1, `no parent adhoc dir for ${role} in ${base} (got [${entries}])`);
  entries.sort();
  return path.join(base, entries[entries.length - 1]);
}

function checkNestedRunDir(parent, role) {
  const entries = fs.readdirSync(parent).filter((e) => /^\d{2,}-.+-[0-9a-fA-F]{8}$/.test(e));
  assert.equal(entries.length, 1, `parent must hold exactly the nested run dir (got [${entries}])`);
  assert.ok(entries[0].includes(role), `nested dir ${entries[0]} must name ${role}`);
  const nested = path.join(parent, entries[0]);
  assert.ok(fs.existsSync(path.join(nested, "result.json")), "relay result.json must exist");
  return nested;
}

check("ap.cjs + adhoc modules parse (node --check)", () => {
  for (const f of ["bin/ap.cjs", "scripts/adhoc-runner.mjs", "scripts/autopilot.mjs"]) {
    const r = spawnSync(process.execPath, ["--check", path.join(skillRoot, f)], { encoding: "utf8" });
    assert.equal(r.status, 0, `node --check ${f} failed: ${r.stderr || ""}`);
  }
});

const { repo, binDir } = makeRepo();
let planOut; let diffOut; let verifyOut;
try {
  await check("plan-review e2e: exit 0, verdict+findings printed", async () => {
    planOut = runAp(repo, binDir, ["plan-review", "PLAN.md"]);
    assert.equal(planOut.status, 0, `exit=${planOut.status} stderr=${planOut.stderr.slice(-500)}`);
    assert.ok(planOut.stdout.includes("Verdict: PASS"), "printed verdict must be PASS");
    assert.ok(planOut.stdout.includes("E2E-PLAN-FINDING"), "printed findings must carry the fake plan_reviewer marker");
  });

  await check("plan-review e2e: summary saved beside the nested run dir", async () => {
    const parent = findParentAdhocDir(repo, "plan_reviewer");
    const nested = checkNestedRunDir(parent, "plan_reviewer");
    const summary = fs.readFileSync(path.join(parent, "summary.md"), "utf8");
    assert.ok(summary.includes("Verdict: PASS"), "summary must record the verdict");
    assert.ok(summary.includes("E2E-PLAN-FINDING"), "summary must save the findings");
    assert.ok(summary.includes(path.basename(nested)), "summary must record the nested run-dir path");
    const verdictLine = planOut.stdout.split("\n").find((l) => l.startsWith("Verdict:"));
    assert.ok(verdictLine && summary.includes(verdictLine), "printed verdict must match the saved summary");
  });

  await check("code-review e2e: exit 0, verdict+findings printed and saved", async () => {
    diffOut = runAp(repo, binDir, ["code-review", "change.diff"]);
    assert.equal(diffOut.status, 0, `exit=${diffOut.status} stderr=${diffOut.stderr.slice(-500)}`);
    assert.ok(diffOut.stdout.includes("Verdict: PASS"), "printed verdict must be PASS");
    assert.ok(diffOut.stdout.includes("E2E-DIFF-FINDING"), "printed findings must carry the fake code_reviewer marker");
    const parent = findParentAdhocDir(repo, "code_reviewer");
    const nested = checkNestedRunDir(parent, "code_reviewer");
    const summary = fs.readFileSync(path.join(parent, "summary.md"), "utf8");
    assert.ok(summary.includes("Verdict: PASS") && summary.includes("E2E-DIFF-FINDING"), "summary must save verdict+findings");
    assert.ok(summary.includes(path.basename(nested)), "summary must record the nested run-dir path");
  });

  await check("verify-file e2e: exit 0, per-criterion PASS/FAIL printed with --cmd evidence", async () => {
    verifyOut = runAp(repo, binDir, ["verify-file", "CRITERIA.md", "--cmd", "echo E2E-CMD-OK"]);
    assert.equal(verifyOut.status, 0, `exit=${verifyOut.status} stderr=${verifyOut.stderr.slice(-500)}`);
    assert.ok(verifyOut.stdout.includes("Verdict: PASS"), "printed verdict must be PASS");
    assert.ok(/criterion 1:\s*PASS/i.test(verifyOut.stdout), "printed findings must give criterion 1 PASS/FAIL");
    assert.ok(/criterion 2:\s*PASS/i.test(verifyOut.stdout), "printed findings must give criterion 2 PASS/FAIL");
    assert.ok(verifyOut.stdout.includes("E2E-CRITERION-ONE") && verifyOut.stdout.includes("E2E-CRITERION-TWO"), "per-criterion lines must name the criteria");
  });

  await check("verify-file e2e: summary + cmd-evidence.txt saved in the parent adhoc dir", async () => {
    const parent = findParentAdhocDir(repo, "verifier");
    const nested = checkNestedRunDir(parent, "verifier");
    const evidence = fs.readFileSync(path.join(parent, "cmd-evidence.txt"), "utf8");
    assert.ok(evidence.includes("echo E2E-CMD-OK"), "cmd-evidence.txt must record the --cmd string");
    assert.ok(evidence.includes("E2E-CMD-OK"), "cmd-evidence.txt must capture the --cmd stdout");
    assert.ok(/exit_code:\s*0/.test(evidence), "cmd-evidence.txt must capture the exit code");
    const summary = fs.readFileSync(path.join(parent, "summary.md"), "utf8");
    assert.ok(summary.includes("Verdict: PASS"), "summary must record the verdict");
    assert.ok(/criterion 1:\s*PASS/i.test(summary) && /criterion 2:\s*PASS/i.test(summary), "summary must save per-criterion PASS/FAIL");
    assert.ok(summary.includes("echo E2E-CMD-OK") && summary.includes("E2E-CMD-OK"), "summary must carry the --cmd evidence");
    assert.ok(summary.includes(path.basename(nested)), "summary must record the nested run-dir path");
  });
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(binDir, { recursive: true, force: true });
}

console.log(`\n${ran - failed}/${ran} passed`);
if (failed > 0) process.exit(1);
