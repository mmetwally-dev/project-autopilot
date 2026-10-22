#!/usr/bin/env node
// Proof for the two defects that made reviewer feedback unreliable, both
// observed together in one real mission (runs 19-23 of
// 001-investigate-and-fix):
//
//   1. Findings were persisted to state.json but never read back, so a
//      mission that was stopped and restarted re-entered its planning loop
//      with feedback="". The replacement Planner was handed the ORIGINAL
//      prompt with no mention of the rejection it was revising against, and
//      went looking for the review in runs/ instead: 22 of its 50 tool calls
//      were greps against a 138KB spilled tool-result file, for 3,160,278
//      cached input tokens on a single revision.
//
//   2. Findings were bare one-line summaries with no location and no
//      required correction, so even a delivered finding still sent the role
//      hunting for the detail behind it.
//
// Part 1 covers normalization/bounding/fail-closed load and the sentinel
// contract (structured findings must survive parsing — String() alone turned
// every one of them into "[object Object]").
//
// Part 2 is the behavioral proof against the REAL orchestrator: two
// sequential `node scripts/autopilot.mjs run` subprocesses over one mission,
// where the first is driven to escalate on a plan-review FAIL and the second
// resumes. The assertion is on the SECOND run's very first Planner brief:
// it must already quote the first run's findings, which is exactly what the
// mission above failed to do.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import {fileURLToPath} from "node:url";
import {
  renderFinding, normalizeFindings, saveReviewFeedback, loadReviewFeedback,
  clearReviewFeedback, feedbackText, MAX_FINDINGS, MAX_FINDING_CHARS, MAX_TOTAL_CHARS,
  MAX_CORRECTION_CHARS
} from "./review-feedback.mjs";
import {parseReviewContract} from "./failure-contract.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");
const IS_WIN = process.platform === "win32";

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  return false;
};

// ===========================================================================
// Part 1a: bounded, self-contained findings (defect 2).
// ===========================================================================
check("renderFinding: plain string passes through", renderFinding("a plain finding") === "a plain finding");
check("renderFinding: structured finding keeps location, problem and correction",
  renderFinding({location: "scripts/x.mjs:12", problem: "path is hard-coded", correction: "derive it from REPOSITORY"})
    === "scripts/x.mjs:12: path is hard-coded Required correction: derive it from REPOSITORY");
check("renderFinding: a finding with no problem statement is unusable -> dropped",
  renderFinding({location: "scripts/x.mjs"}) === "");
check("renderFinding: problem alone is still actionable", renderFinding({problem: "plan is unordered"}) === "plan is unordered");
check("renderFinding: non-objects are dropped, never stringified into junk",
  renderFinding(null) === "" && renderFinding(42) === "" && renderFinding(["x"]) === "");
check("renderFinding: over-long finding is clamped, not passed through",
  renderFinding("x".repeat(5000)).length === MAX_FINDING_CHARS);
check("normalizeFindings: caps the number of findings",
  normalizeFindings(Array.from({length: MAX_FINDINGS + 10}, (_, i) => `finding ${i}`)).length === MAX_FINDINGS);
check("normalizeFindings: caps total size across findings",
  normalizeFindings(Array.from({length: MAX_FINDINGS}, () => "y".repeat(MAX_FINDING_CHARS)))
    .join("").length <= MAX_TOTAL_CHARS);
check("normalizeFindings: non-array input yields nothing", normalizeFindings("not an array").length === 0);

// ===========================================================================
// Part 1a-ii: correction-preserving clamp (backlog #43). The per-finding
// budget used to keep the START of the text, so a long problem description
// cut off the trailing "Required correction: …" — the part the implementer
// needs most. The clamped path must now shorten only the head.
// ===========================================================================
{
  const problem900 = "p".repeat(900);
  const correction300 = "c".repeat(300);

  const objRendered = renderFinding({location: "scripts/foo.mjs:12", problem: problem900, correction: correction300});
  check("correction-preserving: object finding fits within MAX_FINDING_CHARS",
    objRendered.length <= MAX_FINDING_CHARS, objRendered.length);
  check("correction-preserving: object finding keeps the WHOLE 300-char correction",
    objRendered.includes(correction300));
  const objHead = objRendered.split("Required correction:")[0].trimEnd();
  check("correction-preserving: object finding shortens only the head, ending it with …",
    objHead.endsWith("…"), objHead.slice(-40));
  check("correction-preserving: object finding is idempotent",
    renderFinding(objRendered) === objRendered);

  const strFinding = `scripts/foo.mjs:12: ${problem900} Required correction: ${correction300}`;
  const strRendered = renderFinding(strFinding);
  check("correction-preserving: plain string with the marker fits within MAX_FINDING_CHARS",
    strRendered.length <= MAX_FINDING_CHARS, strRendered.length);
  check("correction-preserving: plain string with the marker keeps the WHOLE correction",
    strRendered.includes(correction300));
  check("correction-preserving: plain string finding is idempotent",
    renderFinding(strRendered) === strRendered);

  const noMarker = "z".repeat(MAX_FINDING_CHARS + 500);
  const noMarkerRendered = renderFinding(noMarker);
  check("correction-preserving: string with no marker is clipped as before",
    noMarkerRendered.length === MAX_FINDING_CHARS && noMarkerRendered.endsWith("…"),
    noMarkerRendered.length);
  check("correction-preserving: marker-less clipping is idempotent",
    renderFinding(noMarkerRendered) === noMarkerRendered);

  const objLongCorr = renderFinding({location: "f.mjs", problem: "short problem", correction: "d".repeat(800)});
  const objLongCorrPart = objLongCorr.split("Required correction:")[1].trim();
  check("correction-preserving: object correction over 700 chars is cut, ends with …, total fits",
    objLongCorrPart.length <= MAX_CORRECTION_CHARS && objLongCorrPart.endsWith("…")
      && objLongCorr.length <= MAX_FINDING_CHARS && !objLongCorr.includes("d".repeat(800)),
    {partLen: objLongCorrPart.length, totalLen: objLongCorr.length});
  check("correction-preserving: cut object correction is idempotent",
    renderFinding(objLongCorr) === objLongCorr);

  const strLongCorr = `f.mjs: short problem Required correction: ${"e".repeat(800)}`;
  const strLongCorrRendered = renderFinding(strLongCorr);
  const strLongCorrPart = strLongCorrRendered.split("Required correction:")[1].trim();
  check("correction-preserving: string correction over 700 chars is cut, ends with …, total fits",
    strLongCorrPart.length <= MAX_CORRECTION_CHARS && strLongCorrPart.endsWith("…")
      && strLongCorrRendered.length <= MAX_FINDING_CHARS,
    {partLen: strLongCorrPart.length, totalLen: strLongCorrRendered.length});
  check("correction-preserving: cut string correction is idempotent",
    renderFinding(strLongCorrRendered) === strLongCorrRendered);

  // Real finding from mission 024, review run 119: a ~780-character plain
  // string whose correction was lost under the old budget (the implementer
  // only saw "… block the fake adapter's cod…"). It now fits whole.
  const RUN_119_FINDING = "implementer: the retry wired scripts/verify-fix.mjs:88 to a hard-coded fake adapter stub that always reports PASS without launching the real sandbox probe, so the checkout-guard regression and the dirty-worktree detector never execute and downstream failures stay invisible to the verifier chain that must gate every task result. The plan review FAIL cited the same stub twice before, yet each retry reintroduced the identical bypass under a new filename, which is why the mission kept passing local checks while the mission-024 worktree stayed dirty on every real run Required correction: block the fake adapter's code path behind the real sandbox probe gate, force a full sandbox rebuild before the suite, delete the hard-coded PASS stub entirely, and re-run test-all.mjs to a clean pass.";
  check("run-119 fixture: exceeds the pre-fix 600-char budget (would have been clipped)",
    RUN_119_FINDING.length > 600 && RUN_119_FINDING.length <= MAX_FINDING_CHARS,
    RUN_119_FINDING.length);
  const run119Rendered = renderFinding(RUN_119_FINDING);
  check("run-119 fixture: keeps its full correction",
    run119Rendered.includes("block the fake adapter's code path behind the real sandbox probe gate")
      && run119Rendered.endsWith("re-run test-all.mjs to a clean pass."),
    run119Rendered.slice(-80));
  check("run-119 fixture: is idempotent", renderFinding(run119Rendered) === run119Rendered);
}

// ===========================================================================
// Part 1b: persistence round-trip, fail-closed on load (defect 1).
// ===========================================================================
{
  const state = {};
  saveReviewFeedback(state, "k", [{location: "f.mjs", problem: "bad", correction: "fix"}, "second"]);
  check("saveReviewFeedback: findings land in state under the given key",
    state.reviewFeedback?.k?.findings?.length === 2, state.reviewFeedback);
  check("loadReviewFeedback: restores exactly what was saved",
    JSON.stringify(loadReviewFeedback(state, "k")) === JSON.stringify(state.reviewFeedback.k.findings));
  check("feedbackText: renders a numbered, prompt-ready block",
    feedbackText(loadReviewFeedback(state, "k")) === "1. f.mjs: bad Required correction: fix\n2. second");
  clearReviewFeedback(state, "k");
  check("clearReviewFeedback: a PASS leaves no stale findings behind", loadReviewFeedback(state, "k").length === 0);

  check("loadReviewFeedback: hand-edited/garbage slot fails closed to empty",
    loadReviewFeedback({reviewFeedback: {k: {findings: "not-an-array"}}}, "k").length === 0);
  check("loadReviewFeedback: missing slot fails closed to empty",
    loadReviewFeedback({}, "nope").length === 0 && loadReviewFeedback(null, "nope").length === 0);
  check("saveReviewFeedback: saving an unusable set clears rather than stores an empty slot",
    (() => { const st = {}; saveReviewFeedback(st, "k", [{location: "only"}]); return loadReviewFeedback(st, "k").length === 0; })());
}

// ===========================================================================
// Part 1c: the sentinel contract must carry structured findings through.
// ===========================================================================
{
  const structured = parseReviewContract(
    `AUTOPILOT_REVIEW={"decision":"FAIL","findings":[{"location":"PLAN.md task 8","problem":"lock takeover races release","correction":"use an atomic rename"}]}`
  );
  check("parseReviewContract: structured finding is accepted", structured.contract.status === "valid", structured.contract);
  check("parseReviewContract: structured finding is NOT stringified to [object Object]",
    structured.verdict.findings[0] === "PLAN.md task 8: lock takeover races release Required correction: use an atomic rename",
    structured.verdict.findings);
  const plain = parseReviewContract(`AUTOPILOT_REVIEW={"decision":"FAIL","findings":["legacy plain finding"]}`);
  check("parseReviewContract: legacy plain-string findings still work unchanged",
    plain.contract.status === "valid" && plain.verdict.findings[0] === "legacy plain finding", plain.verdict.findings);
  const pass = parseReviewContract(`AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}`);
  check("parseReviewContract: PASS with no findings is still valid",
    pass.contract.status === "valid" && pass.verdict.decision === "PASS");

  // Findings double as a verbatim data channel: the Playwright verifier
  // returns its ENTIRE sandbox probe as one base64 "PW_PROBE_B64:..."
  // finding, far longer than the prompt/persistence budget. Clamping the
  // parsed verdict truncated it and broke real browser verification —
  // the budget must apply to what is stored and re-injected, never to the
  // faithful record of what the reviewer returned.
  {
    const payload = "PW_PROBE_B64:" + "e".repeat(4000);
    const probe = parseReviewContract(`AUTOPILOT_REVIEW={"decision":"PASS","findings":["${payload}"]}`);
    check("parseReviewContract: an oversized verbatim finding is NOT truncated",
      probe.verdict.findings[0] === payload,
      {got: probe.verdict.findings[0]?.length, expected: payload.length});
    check("normalizeFindings: the same oversized finding IS bounded before persistence",
      normalizeFindings(probe.verdict.findings)[0].length === MAX_FINDING_CHARS);
  }
}

// ===========================================================================
// Part 1d: regressions found while reviewing the first cut of this change.
// ===========================================================================
{
  // The parsed verdict must be faithful in ARITY, not only in content.
  // execution-plane-safety's operational proof is gated on
  // `verdict.findings.length === 0` and its contract is that malformed
  // reviewer output can never satisfy it. An earlier cut of this change
  // dropped unrenderable entries with .filter(Boolean), which let [""],
  // [null], [0] and [{}] all collapse to [] and pass a predicate whose whole
  // job is to reject exactly that.
  for (const malformed of [[""], [null], [0], [{}], [[]]]) {
    const parsed = parseReviewContract(
      `AUTOPILOT_REVIEW=${JSON.stringify({decision: "PASS", findings: malformed})}`
    );
    check(`parseReviewContract: malformed finding ${JSON.stringify(malformed)} does not collapse to an empty findings array`,
      parsed.verdict.findings.length === malformed.length,
      {got: parsed.verdict.findings});
  }
  check("parseReviewContract: a genuinely empty findings array is still empty",
    parseReviewContract('AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}').verdict.findings.length === 0);

  // Missions planned before reviewFeedback existed recorded their findings
  // on s.standalonePlanReview.findings. runStandalonePlanning() still reads
  // `revision` from that legacy record, so failing to migrate the findings
  // alongside it makes a resume take the penalty and drop the payload — the
  // stopped mission this whole change was written for would have restarted
  // with a byte-identical first-attempt prompt.
  const legacy = {
    standalonePlanReview: {
      revision: 1,
      findings: ["FINDINGS.md is hard-coded to a nonexistent repository path.",
                 "Resolving current and acquiring its pin are not atomic against GC."]
    }
  };
  check("legacy state: findings are NOT visible under the new key before migration",
    loadReviewFeedback(legacy, "standalone-plan").length === 0);
  if (!loadReviewFeedback(legacy, "standalone-plan").length
      && Array.isArray(legacy.standalonePlanReview?.findings)
      && legacy.standalonePlanReview.findings.length) {
    saveReviewFeedback(legacy, "standalone-plan", legacy.standalonePlanReview.findings);
  }
  const migrated = loadReviewFeedback(legacy, "standalone-plan");
  check("legacy state: migration restores the pre-fix mission's findings",
    migrated.length === 2 && migrated[0].startsWith("FINDINGS.md is hard-coded"), migrated);
  check("legacy state: migrated findings reach the Planner prompt",
    feedbackText(migrated).startsWith("1. FINDINGS.md is hard-coded"));

  // Migration goes through saveReviewFeedback(), so a hand-edited or
  // truncated legacy record fails closed rather than being trusted for age.
  const junk = {standalonePlanReview: {revision: 2, findings: [{}, null, ""]}};
  saveReviewFeedback(junk, "standalone-plan", junk.standalonePlanReview.findings);
  check("legacy state: an unusable legacy record migrates to nothing, not to junk",
    loadReviewFeedback(junk, "standalone-plan").length === 0);
}

// ===========================================================================
// Part 2: behavioral proof across a real process restart.
// ===========================================================================
if (IS_WIN) {
  console.log("test-review-feedback-persistence: Part 2 SKIP — the real-relay restart proof runs read-only roles inside the bubblewrap envelope (Linux/WSL2).");
  if (failures) { console.error(`${failures} check(s) failed.`); process.exit(1); }
  console.log("test-review-feedback-persistence: unit checks PASSED (Part 2 skipped on this platform)");
  process.exit(0);
}

function git(cwd, args) {
  const r = spawnSync("git", args, {cwd, encoding: "utf8", stdio: "pipe", env: withoutOuterGitGuard(process.env), shell: false});
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout || "").trim();
}

// The reviewer's verdict is switched between the two subprocess runs through
// a COMMITTED file, not an env var: the relay filters the adapter child
// environment to a fixed allowlist, so a committed repo file is the only
// channel that reaches the adapter in the plain repo and inside the
// read-only bind alike (same technique as workflow-order-harness.mjs).
const FAKE_AGENT = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("fake-feedback-agent 1.0.0\\n"); process.exit(0); }
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => { stdin += c; });
process.stdin.on("end", () => {
  const roleLine = (stdin.trimStart().split(/\\r?\\n/, 1)[0] || "");
  const role = roleLine.startsWith("ROLE=") ? roleLine.slice("ROLE=".length) : "";
  let scenario = "reviewer_fail";
  try { scenario = fs.readFileSync(".autopilot-test-scenario", "utf8").trim() || scenario; } catch {}

  if (role === "planner") {
    // Support both old single-file and new split contract (v5: PLAN.md + TASKS.md)
    const planMatch = stdin.match(/Write the (?:narrative )?plan to exactly:\s*(.*)/);
    const tasksMatch = stdin.match(/Write the phased checklist to exactly:\s*(.*)/);
    const legacyMatch = !planMatch ? stdin.match(/Write the plan to exactly:\s*(.*)/) : null;
    const planPath = planMatch ? planMatch[1].trim() : legacyMatch ? legacyMatch[1].trim() : null;
    if (!planPath) { process.stderr.write("fake: no plan path\\n"); process.exit(1); }
    // Record the prompt this Planner actually received, so the test can
    // assert on it. Written beside the plan, inside the mission directory
    // the Planner is already allowed to write to.
    try { fs.writeFileSync(planPath.replace(/PLAN\.md$/, "LAST-PLANNER-PROMPT.txt"), stdin); } catch {}
    if (tasksMatch) {
      const tasksPath = tasksMatch[1].trim();
      fs.writeFileSync(planPath, "# Plan\\n\\nObjective: add a fixture line to README.md\\n\\nScope: single line.\\n");
      fs.writeFileSync(tasksPath, "## Phase 1: General\\n\\n- [ ] 1. Add a fixture line to README.md — accept: line added ; verify: check README.md\\n");
    } else if (planMatch) {
      // New prompt but no tasksMatch (should not happen, but handle)
      fs.writeFileSync(planPath, "# Plan\\n\\nObjective: add a fixture line to README.md\\n");
      const derivedTasks = planPath.replace(/PLAN\.md$/, "TASKS.md");
      fs.writeFileSync(derivedTasks, "## Phase 1: General\\n\\n- [ ] 1. Add a fixture line to README.md — accept: line added ; verify: check README.md\\n");
    } else {
      fs.writeFileSync(planPath, "# Plan\\n\\n## Checklist\\n\\n- [ ] 1. Add a fixture line to README.md\\n\\nVerification: manual.\\n");
    }
    process.stdout.write("Wrote the plan.\\n");
    process.exit(0);
  }

  if (role === "plan_reviewer") {
    const review = scenario === "reviewer_pass"
      ? {decision: "PASS", findings: []}
      : {decision: "FAIL", findings: [
          {location: "PLAN.md task 1", problem: "UNIQUE-FINDING-ALPHA is missing", correction: "add an explicit verification command"},
          {location: "PLAN.md task 2", problem: "UNIQUE-FINDING-BETA is unordered", correction: "order it after task 1"}
        ]};
    process.stdout.write("Reviewed.\\nAUTOPILOT_REVIEW=" + JSON.stringify(review) + "\\n");
    process.exit(0);
  }

  if (role === "implementer") {
    try { fs.appendFileSync("README.md", "implementer change\\n"); } catch {}
    // Per-task invocation requires exactly one task-result sentinel
    // (003#43 / TASK-25); a bare "Implemented." is STRUCTURED_OUTPUT_MISSING.
    process.stdout.write("Implemented.\\nAUTOPILOT_TASK_RESULT=" + JSON.stringify({summary: "added the fixture line to README.md", taskLocalCheck: {command: "grep implementer README.md", status: "passed", exitCode: 0, summary: "line present"}}) + "\\n");
    process.exit(0);
  }

  process.stdout.write("Done.\\nAUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: []}) + "\\n");
  process.exit(0);
});
`;

function makeBin() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-feedback-bin-"));
  const target = path.join(binDir, "cursor-agent");
  fs.writeFileSync(target, FAKE_AGENT);
  fs.chmodSync(target, 0o755);
  return binDir;
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-feedback-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "feedback-test@example.invalid"]);
  git(repo, ["config", "user.name", "Feedback Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

function setScenario(repo, scenario) {
  fs.writeFileSync(path.join(repo, ".autopilot-test-scenario"), scenario);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", `scenario ${scenario}`]);
}

function writeConfig(repo) {
  const role = {adapter: "cursor", model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null};
  const config = {
    schema_version: "3.0",
    project: {repo: ".", planning_framework: "standalone", state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs"},
    roles: {planner: role, plan_reviewer: role, implementer: role, code_reviewer: role, verifier: role},
    workflow: {
      specReview: true, planReview: true, analysisAfterTasks: true, implementationReview: true, finalReview: true,
      autoApproveSpec: false, autoApprovePlan: false, parallelIndependentTasks: false, gsdPlanningReview: false,
      relaySafety: {block_git_commit_push: true, verify_read_only_by_snapshot: true, capture_touched_files: true, persist_role_sessions: true}
    },
    gates: {commands: [], env_allowlist: [], require_reviewer: true, network_isolation: true},
    // One revision only: the first FAIL exhausts the budget and escalates,
    // which is the process-exit this test needs in order to restart.
    policy: {
      max_plan_revisions: 1, retry_delay_ms: 0, checkpoint_after_task: true, checkpoint_after_phase: true,
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

const REQUEST = "add a fixture line to README.md";
function runMission(repo, binDir, timeoutMs = 220000) {
    // Strip any outer mission/gate git guard (PATH shim + hooks): the
  // nested mission installs its own, and every git call through both
  // ran the mission several times slower under the orchestrator gate.
  const base = withoutOuterGitGuard({...process.env});
  const env = {...base, PATH: `${binDir}:${base.PATH || ""}`};
  return spawnSync(process.execPath, [path.join(skillRoot, "scripts", "autopilot.mjs"), "run", REQUEST, "--repo", repo], {
    cwd: repo, encoding: "utf8", env, timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"], shell: false
  });
}

function plannerPromptFile(repo) {
  const missions = path.join(repo, ".autopilot", "missions");
  if (!fs.existsSync(missions)) return null;
  for (const m of fs.readdirSync(missions)) {
    const f = path.join(missions, m, "LAST-PLANNER-PROMPT.txt");
    if (fs.existsSync(f)) return f;
  }
  return null;
}

{
  const repo = makeRepo();
  const binDir = makeBin();
  try {
    writeConfig(repo);

    // --- Run 1: reviewer FAILs, revision budget (1) is exhausted, mission dies.
    setScenario(repo, "reviewer_fail");
    const first = runMission(repo, binDir);
    check("run 1: mission escalated on plan review (nonzero exit)", first.status !== 0,
      {status: first.status, stderr: (first.stderr || "").slice(-400)});

    const stateAfterFirst = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
    const saved = stateAfterFirst.reviewFeedback?.["standalone-plan"]?.findings || [];
    check("run 1: reviewer findings were persisted to state.json", saved.length === 2, stateAfterFirst.reviewFeedback);
    check("run 1: persisted findings kept location AND required correction (not a bare summary)",
      saved[0]?.includes("PLAN.md task 1") && saved[0]?.includes("UNIQUE-FINDING-ALPHA") && saved[0]?.includes("Required correction:"),
      saved);

    // Clear the recorded prompt so the next assertion can only be satisfied
    // by a prompt the SECOND run's Planner actually received.
    const promptFileAfterFirst = plannerPromptFile(repo);
    if (promptFileAfterFirst) fs.rmSync(promptFileAfterFirst);

    // --- Run 2: a genuinely new process resuming the same mission.
    setScenario(repo, "reviewer_pass");
    const second = runMission(repo, binDir);

    const promptFile = plannerPromptFile(repo);
    if (check("run 2: the resumed run invoked the Planner again", !!promptFile,
      {status: second.status, stdout: (second.stdout || "").slice(-600), stderr: (second.stderr || "").slice(-600)})) {
      const prompt = fs.readFileSync(promptFile, "utf8");
      // THE regression: before the fix this prompt was byte-identical to a
      // first-attempt prompt, with no trace of the rejection being revised.
      check("run 2: the restarted Planner was handed the previous run's findings",
        prompt.includes("UNIQUE-FINDING-ALPHA") && prompt.includes("UNIQUE-FINDING-BETA"),
        prompt.slice(-700));
      check("run 2: the restored findings carry their required corrections",
        prompt.includes("Required correction:"), prompt.slice(-700));
      check("run 2: the Planner was told the previous attempt was REJECTED",
        /MUST be addressed|REJECTED/i.test(prompt), prompt.slice(-700));
    }

    const stateAfterSecond = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
    check("run 2: a PASS clears the persisted findings (no stale corrections survive)",
      !(stateAfterSecond.reviewFeedback?.["standalone-plan"]?.findings?.length),
      stateAfterSecond.reviewFeedback);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(binDir, {recursive: true, force: true});
  }
}

if (failures) {
  console.error(`${failures} review-feedback check(s) failed.`);
  process.exit(1);
}
console.log("test-review-feedback-persistence: ALL CHECKS PASSED");
