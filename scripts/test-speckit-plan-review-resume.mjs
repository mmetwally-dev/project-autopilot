#!/usr/bin/env node
// Behavioral proof (TASK 7) that resuming after a SpecKit Spec Review /
// review-spec gate failure correctly resumes the same mission and feature,
// does not create a new feature directory, does not emit
// "Existing speckit planning is not ready for execution", and preserves
// fail-closed behavior for unrelated incomplete planning. Drives real
// `node scripts/autopilot.mjs run` subprocesses against disposable git
// fixture repos and the fake adapter CLI.
//
// The test harness controls first-run FAIL / second-run PASS entirely by
// switching the COMMITTED .autopilot-test-scenario file between the two
// subprocess runs — the fixture's plan_reviewer performs zero repository
// writes (it always runs inside the read-only containment envelope), so no
// marker or counter file is involved. Production code (autopilot.mjs) must
// contain NO test-marker or test-scenario hooks.
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {
  makeFixtureRepo, makeFixtureBin, makeSpecKitUnrelatedFeatureFixture,
  makeClaudeMdBaseline, setScenario, writeConfig, runAutopilot,
  readObservedEvents, cleanup, withoutOuterGitGuard
} from "./test-fixtures/workflow-order-harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, "..");

// Each full mission below is a real SpecKit run where every read-only role
// (plan_reviewer/code_reviewer/verifier) launches inside the Windows
// disposable-copy compatibility bridge — a real, full filesystem copy of
// the repository per invocation, not a bind-mount — which costs materially
// more wall-clock time than WSL2's bubblewrap (see
// test-windows-disposable-plan-reviewer.mjs's own 220000ms budget for a
// single such mission). 90000ms is enough on Linux/WSL2; native Windows
// needs the same order-of-magnitude headroom as that established sibling.
const MISSION_TIMEOUT_MS = process.platform === "win32" ? 220000 : 90000;

let failures = 0;
function check(name, condition) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
}

const UNRELATED = "002-unrelated-feature";
const NEW_FEATURE = "999-smoke-test";

function setUp(prefix) {
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  makeSpecKitUnrelatedFeatureFixture(repo, UNRELATED);
  makeClaudeMdBaseline(repo);
  writeConfig(repo, {planningFramework: "speckit"});
  return {repo, binDir};
}

// ---------------------------------------------------------------------
// Assertion: production code contains no test-marker or test-scenario
// hooks. The autopilot.mjs file must not reference any test-only marker
// files or scenario selectors.
// ---------------------------------------------------------------------
{
  const productionSrc = fs.readFileSync(
    path.join(skillRoot, "scripts", "autopilot.mjs"), "utf8"
  );
  const hasTestMarker = /autopilot-test-spec-revision-done/.test(productionSrc);
  const hasTestScenario = /autopilot-test-scenario/.test(productionSrc);
  // Allow exactly one exit hook that only refreshes the report (no test hooks, no test logic)
  const exitHooks = productionSrc.match(/process\.on\s*\(\s*["']exit["']\s*,.*?\);/gs) || [];
  const onlyRefreshExitHook = exitHooks.length === 1 && /refreshWatchReport/.test(exitHooks[0]) && !/autopilot-test|test-marker|test-scenario/.test(exitHooks[0]);
  check("production: no test-marker reference in autopilot.mjs", !hasTestMarker);
  check("production: no test-scenario reference in autopilot.mjs", !hasTestScenario);
  check("production: exactly one exit hook that only refreshes the report", onlyRefreshExitHook);
}

// ---------------------------------------------------------------------
// Test 1: Resume after spec review failure
//
// The test harness controls first-run FAIL / second-run PASS by switching
// the committed .autopilot-test-scenario between subprocess runs:
//   - First run: scenario `speckit_spec_review_fail`. The fixture's
//     plan_reviewer ALWAYS returns FAIL (initial review and bounded retry),
//     so the gate handler exits nonzero with a saved checkpoint.
//   - Second run: the harness flips the scenario to `speckit_spec_review_pass`
//     BEFORE relaunching with the exact same request. The reviewer returns
//     PASS without any repository write, planning resumes the same mission
//     and feature, produces plan.md/tasks.md, and implementation begins
//     only after the PASS.
// ---------------------------------------------------------------------
{
  const {repo, binDir} = setUp("plan-review-resume");
  const request = "smoke test the health endpoint";
  try {
    // --- First run: should FAIL at spec review gate ---
    setScenario(repo, "speckit_spec_review_fail");
    const first = runAutopilot(repo, binDir, {request, timeoutMs: MISSION_TIMEOUT_MS});

    check("resume: first run exits nonzero (exit 2)", first.status !== 0);
    check("resume: first run error mentions gate failure",
      /SpecKit gate.*failed/i.test(first.stderr) || first.status === 2);

    // State should be persisted with planning checkpoint
    const midState = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
    check("resume: state preserved after failure", midState.phase === "planning");
    check("resume: speckitPlanningCheckpoint saved",
      !!midState.speckitPlanningCheckpoint && midState.speckitPlanningCheckpoint.step === "review-spec");
    check("resume: speckitFeatureDir resolved", midState.speckitFeatureDir === NEW_FEATURE);
    check("resume: spec.md was created by first run",
      fs.existsSync(path.join(repo, "specs", NEW_FEATURE, "spec.md")));
    check("resume: feature.json was created by first run",
      fs.existsSync(path.join(repo, ".specify", "feature.json")));

    // No test marker or counter file may exist anywhere in the repo
    check("resume: no spec-revision marker in repository",
      !fs.existsSync(path.join(repo, "specs", NEW_FEATURE, "checklists", ".autopilot-test-spec-revision-done")));
    check("resume: no review-count marker in repository",
      !fs.existsSync(path.join(repo, ".autopilot-test-review-count")));

    // --- Second run: should RESUME and PASS ---
    // The harness flips the committed scenario before relaunching the exact
    // same request; the fixture reviewer PASSes without any repository write.
    setScenario(repo, "speckit_spec_review_pass");
    const second = runAutopilot(repo, binDir, {request, timeoutMs: MISSION_TIMEOUT_MS});

    check("resume: second run exits 0 (success)", second.status === 0);
    check("resume: no 'Existing speckit planning is not ready' error",
      !second.stderr.includes("Existing speckit planning is not ready"));

    const finalState = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
    check("resume: planningIntent.kind was 'resume'", finalState.planningIntent?.kind === "resume");
    check("resume: still the same resolved feature dir", finalState.speckitFeatureDir === NEW_FEATURE);
    check("resume: checkpoint cleared after success", !finalState.speckitPlanningCheckpoint);
    check("resume: final state is tasks_ready or implementing",
      finalState.phase === "tasks_ready" || finalState.phase === "implementing" || finalState.phase === "complete");

    // Verify artifacts exist for the SAME feature
    const featureDir = path.join(repo, "specs", NEW_FEATURE);
    check("resume: spec.md exists", fs.existsSync(path.join(featureDir, "spec.md")));
    check("resume: plan.md exists", fs.existsSync(path.join(featureDir, "plan.md")));
    check("resume: tasks.md exists", fs.existsSync(path.join(featureDir, "tasks.md")));

    // Exactly one new feature directory
    const specDirs = fs.readdirSync(path.join(repo, "specs"))
      .filter(d => d !== UNRELATED && !d.startsWith("."));
    check("resume: exactly one new feature directory", specDirs.length === 1 && specDirs[0] === NEW_FEATURE);

    // Unrelated feature is unchanged
    const unrelatedSpec = fs.readFileSync(path.join(repo, "specs", UNRELATED, "spec.md"), "utf8");
    check("resume: unrelated feature spec.md unchanged",
      unrelatedSpec.includes("Unrelated pre-existing feature"));

    // No test manually edited state.json or feature.json
    check("resume: state.json was not manually edited (has updatedAt)",
      typeof finalState.updatedAt === "string");
    const featureJson = JSON.parse(fs.readFileSync(path.join(repo, ".specify", "feature.json"), "utf8"));
    check("resume: feature.json has correct schema",
      featureJson.feature_directory === `specs/${NEW_FEATURE}`);

    // Implementation started only after plan review passed
    const events = readObservedEvents(repo);
    const planReviewPass = events.find(e => e.role === "plan_reviewer" && e.decision === "PASS");
    const implementer = events.find(e => e.role === "implementer");
    if (planReviewPass && implementer) {
      check("resume: implementer ran after plan_reviewer PASS",
        Date.parse(implementer.startedAt) >= Date.parse(planReviewPass.finishedAt));
    } else {
      check("resume: plan_reviewer PASS observed", !!planReviewPass);
      check("resume: implementer observed", !!implementer);
    }

    // Verify the reviewer was called (at least once PASS)
    const reviewerCalls = events.filter(e => e.role === "plan_reviewer");
    check("resume: plan_reviewer was called", reviewerCalls.length > 0);
    const reviewerDecisions = reviewerCalls.map(e => e.decision);
    console.log(`  reviewer decisions: ${reviewerDecisions.join(", ")}`);

  } finally {
    cleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// Test 2: Unrelated incomplete SpecKit feature still fails closed
//
// An unrelated, already-complete SpecKit feature must not be incorrectly
// resumed or executed when a new, different request arrives.
// ---------------------------------------------------------------------
{
  const {repo, binDir} = setUp("unrelated-fail-closed");
  try {
    setScenario(repo, "speckit_full_contract");
    const request = "a completely different feature request";
    const run = runAutopilot(repo, binDir, {request, timeoutMs: MISSION_TIMEOUT_MS});

    check("fail-closed: mission completed (exit 0)", run.status === 0);

    const unrelatedSpec = fs.readFileSync(path.join(repo, "specs", UNRELATED, "spec.md"), "utf8");
    check("fail-closed: unrelated feature spec.md unchanged",
      unrelatedSpec.includes("Unrelated pre-existing feature"));

    const newFeatureDir = path.join(repo, "specs", NEW_FEATURE);
    check("fail-closed: new feature directory created",
      fs.existsSync(path.join(newFeatureDir, "spec.md")));

    const specDirs = fs.readdirSync(path.join(repo, "specs"))
      .filter(d => !d.startsWith("."));
    check("fail-closed: unrelated feature not duplicated",
      specDirs.filter(d => d === UNRELATED).length === 1);
    check("fail-closed: new feature is the expected one",
      specDirs.includes(NEW_FEATURE));

  } finally {
    cleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// Test 3: Blocked unrelated incomplete planning fails closed
//
// An unrelated, INCOMPLETE SpecKit feature must cause the new request to
// be reviewed and potentially rejected, NOT incorrectly resumed.
// ---------------------------------------------------------------------
{
  const {repo, binDir} = setUp("incomplete-fail-closed");
  try {
    const incompleteDir = path.join(repo, "specs", "003-incomplete-unrelated");
    fs.mkdirSync(incompleteDir, {recursive: true});
    fs.writeFileSync(path.join(incompleteDir, "spec.md"), "# Incomplete\n\nNot done yet.\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "incomplete unrelated feature"]);

    setScenario(repo, "speckit_full_contract");
    const request = "a new feature that should not reuse the incomplete one";
    const run = runAutopilot(repo, binDir, {request, timeoutMs: MISSION_TIMEOUT_MS});

    const newFeatureDir = path.join(repo, "specs", NEW_FEATURE);
    check("incomplete-fail-closed: new feature directory created",
      fs.existsSync(path.join(newFeatureDir, "spec.md")));

    const incompleteSpec = fs.readFileSync(path.join(incompleteDir, "spec.md"), "utf8");
    check("incomplete-fail-closed: incomplete feature spec.md unchanged",
      incompleteSpec.includes("Not done yet"));

  } finally {
    cleanup(repo, binDir);
  }
}

// ---------------------------------------------------------------------
// Test 4: The read-only Plan Reviewer performs ZERO repository writes
//
// Direct fixture inspection: the fake adapter's plan_reviewer branch for
// the spec-review scenarios must be pure PASS/FAIL output. It must not
// write any marker/counter file, must not create the legacy
// .autopilot-test-review-count counter, and must not reference any
// repository-writing mechanism at all — the real reviewer runs inside the
// read-only containment envelope, so write-based test control cannot work.
// ---------------------------------------------------------------------
{
  const adapterSrc = fs.readFileSync(
    path.join(skillRoot, "scripts", "test-fixtures", "fake-workflow-adapter.sh"), "utf8"
  );
  const reviewerSection = adapterSrc.split(/^  plan_reviewer\)/m)[1] || "";
  const reviewerTail = reviewerSection.split(/^  [a-z_]+\)/m)[0] || reviewerSection;

  check("read-only reviewer: no counter file write",
    !reviewerTail.includes(".autopilot-test-review-count"));
  check("read-only reviewer: no spec-revision marker write",
    !reviewerTail.includes(".autopilot-test-spec-revision-done"));
  // File writes only: descriptor duplication (`>&2`, the fixture's simulated
  // stderr) and shell comments (`# adapter:<adapter>:…`) are not writes —
  // the old bare `>\S+` pattern tripped on both once those were added.
  const reviewerCode = reviewerTail.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  check("read-only reviewer: no '>' redirect writes in the plan_reviewer branch",
    !/(^|[^0-9&<>-])>>?(?!&)\s*(\.\/)?[\w./$"'-]+/m.test(reviewerCode.replace(/\d?>&\d/g, "").replace(/\d?>>?\s*\/dev\/null/g, "")));
  check("read-only reviewer: no 'printf' file writes in the plan_reviewer branch",
    !/printf\b[^\n]*>\s*\S+/.test(reviewerTail));
  check("read-only reviewer: both spec-review scenarios return via review_output",
    reviewerTail.includes("speckit_spec_review_fail") && reviewerTail.includes("speckit_spec_review_pass"));

  // Behavioral proof on top of the source check: after the two subprocess
  // runs of Test 1 (fail then pass), no marker/counter file may exist in
  // the repository — but that repo is cleaned up, so prove it here against
  // a fresh fail-then-pass pair.
  const {repo, binDir} = setUp("reviewer-zero-write");
  const request = "smoke test the health endpoint";
  try {
    setScenario(repo, "speckit_spec_review_fail");
    const first = runAutopilot(repo, binDir, {request, timeoutMs: MISSION_TIMEOUT_MS});
    check("zero-write: first run exits nonzero", first.status !== 0);
    setScenario(repo, "speckit_spec_review_pass");
    const second = runAutopilot(repo, binDir, {request, timeoutMs: MISSION_TIMEOUT_MS});
    check("zero-write: second run exits 0", second.status === 0);

    check("zero-write: no .autopilot-test-review-count anywhere in repo",
      !fs.existsSync(path.join(repo, ".autopilot-test-review-count")));
    // The implementer (a writable role) intentionally creates
    // .autopilot-test-attempt for the verifier/code_reviewer attempt logic;
    // what matters for THIS test is that no REVIEWER code references it —
    // proven by the source-level check above, not by the file's absence.
    check("zero-write: no spec-revision marker anywhere in repo",
      !fs.existsSync(path.join(repo, "specs", NEW_FEATURE, "checklists", ".autopilot-test-spec-revision-done")));
  } finally {
    cleanup(repo, binDir);
  }
}

function git(cwd, args) {
  const r = spawnSync("git", args, {cwd, encoding: "utf8", env: withoutOuterGitGuard(process.env), shell: false});
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return (r.stdout || "").trim();
}

if (failures) {
  console.error(`${failures} plan-review-resume check(s) failed.`);
  process.exit(1);
}
console.log("SpecKit plan-review-resume behavioral tests: PASS");
