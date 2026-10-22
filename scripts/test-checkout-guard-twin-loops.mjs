#!/usr/bin/env node
// 024 Phase 4 task 4.3 — the worktree-restore guard event (reason
// worktree-restore, recorded block-plus-observation per PLAN.md Strategy)
// must surface through BOTH twin loops: standalone
// runStandaloneImplementation and the SpecKit implementation loop. Both
// funnel the Implementer through the shared runRelay()/makeRelayResult()
// path, so this is primarily proof per loop, not new production logic:
//
//   denied (per loop): implementer attempts `git checkout -- README.md`
//     (README.md is committed by the fixture and untouched by the role —
//     foreign by definition) → relay FAIL, policyViolation
//     git_mutation_blocked, failure class GIT_MUTATION_BLOCKED,
//     gitGuardEvents holds a worktree-restore entry, and neither
//     code_reviewer nor verifier launches.
//   allowed (per loop): implementer runs only read-only queries
//     (status/log/diff/symbolic-ref HEAD) → relay completed, zero guard
//     events, reviewers run.
//
// Real `node scripts/autopilot.mjs run` missions via the workflow-order
// harness + fake adapter (same pattern as
// test-relay-git-mutation-verdict.mjs). POSIX adapter + read-only
// containment require Linux/WSL: SKIP the mission sections on native
// Windows (suite precedent).
import fs from "node:fs";
import path from "node:path";
import {makeFixtureRepo, makeFixtureBin, makeSpecKitWorkflowOnly, setScenario, writeConfig, runAutopilot, withoutOuterGitGuard, cleanup} from "./test-fixtures/workflow-order-harness.mjs";

{ const clean = withoutOuterGitGuard(process.env); for (const k of Object.keys(process.env)) if (!(k in clean)) delete process.env[k]; process.env.PATH = clean.PATH; }

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${detail ? " -- " + detail : ""}`); }
}

function readResults(repo) {
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
  return files.map((f) => ({file: f, data: JSON.parse(fs.readFileSync(f, "utf8"))}));
}
function firstFor(results, role) {
  const matches = results
    .filter((r) => (r.data.role || null) === role)
    .sort((a, b) => Date.parse(a.data.startedAt) - Date.parse(b.data.startedAt));
  return matches.length ? matches[0].data : null;
}
function rolesPresent(results) {
  return [...new Set(results.map((r) => r.data.role || "?"))].sort();
}
function readState(repo) {
  try { return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8")); }
  catch { return null; }
}

function setupRepo(prefix, framework) {
  const repo = makeFixtureRepo(`checkout-twin-${prefix}`);
  const binDir = makeFixtureBin(`checkout-twin-${prefix}`);
  if (framework === "speckit") makeSpecKitWorkflowOnly(repo);
  writeConfig(repo, {planningFramework: framework});
  return {repo, binDir};
}

function assertDenied(label, repo, run, results) {
  const impl = firstFor(results, "implementer");
  check(`${label}: top-level ap run exits nonzero`, run.status !== 0, `run.status=${run.status}`);
  check(`${label}: implementer result.json produced`, impl != null, `run.status=${run.status}`);
  if (impl) {
    check(`${label}: child process itself exited 0 (deliberate)`, impl.process?.exitCode === 0,
      JSON.stringify(impl.process));
    check(`${label}: relay status is failed despite exit 0`, impl.status === "failed", impl.status);
    check(`${label}: policyViolation is git_mutation_blocked`, impl.policy?.violation === "git_mutation_blocked",
      JSON.stringify(impl.policy));
    check(`${label}: failure class is GIT_MUTATION_BLOCKED`, impl.failure?.class === "GIT_MUTATION_BLOCKED",
      JSON.stringify(impl.failure));
    const restoreDenials = (impl.gitGuardEvents || []).filter((e) => e.reason === "worktree-restore");
    check(`${label}: gitGuardEvents holds a worktree-restore entry`, restoreDenials.length > 0,
      JSON.stringify(impl.gitGuardEvents));
    check(`${label}: child diagnostics visible in output`, /AUTOPILOT GIT GUARD/.test(impl.finalMessage || ""),
      (impl.finalMessage || "").slice(-300));
  }
  check(`${label}: code_reviewer never launched`, firstFor(results, "code_reviewer") == null,
    rolesPresent(results).join(","));
  check(`${label}: verifier never launched`, firstFor(results, "verifier") == null,
    rolesPresent(results).join(","));
  const state = readState(repo);
  check(`${label}: mission escalated via relay_policy_violation`, state?.step === "relay_policy_violation",
    state ? `${state.phase}/${state.step}` : "no state.json");
}

function assertAllowed(label, repo, run, results) {
  const impl = firstFor(results, "implementer");
  check(`${label}: mission completed end to end (exit 0)`, run.status === 0, `run.status=${run.status}`);
  check(`${label}: implementer result.json produced`, impl != null);
  if (impl) {
    check(`${label}: implementer status is completed`, impl.status === "completed", impl.status);
    check(`${label}: no policy violation`, impl.policy?.violation == null, JSON.stringify(impl.policy));
    check(`${label}: failure is null`, impl.failure === null, JSON.stringify(impl.failure));
    check(`${label}: zero guard events`, (impl.gitGuardEvents || []).length === 0, JSON.stringify(impl.gitGuardEvents));
  }
  check(`${label}: code_reviewer launched after success`, firstFor(results, "code_reviewer") != null,
    rolesPresent(results).join(","));
  check(`${label}: verifier launched after success`, firstFor(results, "verifier") != null,
    rolesPresent(results).join(","));
}

if (process.platform === "win32") {
  console.log("SKIP twin-loop sections: fake POSIX adapter + read-only containment require Linux/WSL (suite precedent)");
} else {
  for (const framework of ["standalone", "speckit"]) {
    // SpecKit planning stages (specify/plan/tasks + reviews) add real
    // subprocess launches before the implementer runs; the standalone loop
    // reaches the implementer directly.
    const timeoutMs = framework === "speckit" ? 240000 : 120000;

    // Denied: foreign-file path restore surfaces per loop.
    {
      const {repo, binDir} = setupRepo(`${framework}-denied`, framework);
      try {
        setScenario(repo, "implementer_checkout_foreign_restore");
        const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs});
        assertDenied(`${framework}/foreign-restore`, repo, run, readResults(repo));
      } finally {
        cleanup(repo, binDir);
      }
    }

    // Allowed: read-only queries stay clean per loop.
    {
      const {repo, binDir} = setupRepo(`${framework}-readonly`, framework);
      try {
        setScenario(repo, "implementer_checkout_readonly_queries");
        const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs});
        assertAllowed(`${framework}/readonly-queries`, repo, run, readResults(repo));
      } finally {
        cleanup(repo, binDir);
      }
    }
  }
}

if (failures) {
  console.error(`${failures} checkout-guard twin-loop check(s) failed.`);
  process.exit(1);
}
console.log("checkout-guard twin-loop behavioral tests passed");
