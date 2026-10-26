// TASK 16.3B (extended by TASK 16.3E): Native Windows companion to
// fake-workflow-adapter.sh.
//
// fake-workflow-adapter.sh is deliberately a single, self-contained POSIX
// shell script with no sibling-file dependencies, because on WSL/Linux a
// read-only role (plan_reviewer/code_reviewer/verifier) runs it inside a
// real bubblewrap sandbox where only that one file is bind-mounted in
// (execution-envelope.mjs's "externalBinary" path) — no Node.js runtime is
// reachable there, so a Node helper script could never be exec'd from
// inside it. That constraint is specific to the bubblewrap envelope: it
// does not apply on Native Windows, where a SpecKit read-only role instead
// runs inside the disposable-copy compatibility bridge (a plain writable
// directory copy, no bind-mount, no single-file restriction) — see
// scripts/autopilot.mjs's useDisposableReviewerWorkspace/attemptEnvelope.
// A Windows-native Node sibling is therefore both possible and the
// established pattern this codebase already uses for every other
// dual-platform fixture (see test-playwright-verification.mjs,
// test-verifier-playwright-discovery.mjs).
//
// TASK 16.3E: originally this file implemented ONLY the "success" scenario.
// It now also ports every scenario branch actually exercised by an ACTIVE
// Native Windows test (test-dirty-worktree-isolation.mjs,
// test-speckit-new-request-isolation.mjs,
// test-speckit-write-boundary-recoverable.mjs,
// test-speckit-plan-review-resume.mjs, test-task14-speckit-task-marking.mjs,
// test-speckit-planning-postcondition.mjs — added by the 16.3E CORRECTION
// pass) — mirroring fake-workflow-adapter.sh's logic for exactly those
// scenario names, branch for branch. The standalone_resume_* branches below
// are additionally dual-ported branch-for-branch for TASK-11 Phase 4; the
// suite exercising them (test-phase-stage-resume.mjs) skips on native
// Windows — standalone read-only roles need Linux/WSL2 bubblewrap
// containment — and runs them under WSL/Linux via this same file. Scenarios owned only by a WSL/Linux-only
// test (documented as such in that test's own header, e.g.
// test-speckit-git-invisible-phase-behavior.mjs) are deliberately NOT
// ported here: every unported scenario value still refuses loudly and
// deterministically (nonzero exit, clear stderr) rather than silently
// approximating shell behavior it does not faithfully reproduce. This is a
// real fixture with a precisely bounded scope — never a stub that fakes
// success.
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const PORTED_SCENARIOS = new Set([
  "success",
  "standalone_impl_interrupted",
  "standalone_reviewer_hang", "standalone_reviewer_infra_once", "standalone_reviewer_fail_once",
  "standalone_verifier_hang", "standalone_verifier_infra_once", "standalone_verifier_fail_once", "standalone_verifier_delta_change",
  "speckit_verifier_delta_change",
  "standalone_attempts_survive",
  "speckit_full_contract", "speckit_resume", "speckit_spec_review_fail", "speckit_spec_review_pass",
  "speckit_write_boundary_invented_feature_json", "speckit_write_boundary_invented_feature_json_mixed",
  "dirty_worktree_changes", "dirty_worktree_zero_change",
  "task14_premature_checkbox_fail", "task14_policy_violation_with_marking", "task14_crash_before_reconcile",
  "task14_observe_unchecked", "task14_review_always_fail", "task14_verify_always_fail", "task14_phase_verify_fail",
  "implementer_recovered_path_error", "implementer_unrecovered_path_error", "implementer_genuine_failure",
  "implementer_policy_violation",   "plan_review_missing_sentinel_with_path_error",
  "plan_review_fail",
  "plan_review_infra_retryable", "plan_review_infra_non_retryable",
  "plan_review_infra_retryable_always", "plan_review_adapter_retryable_always",
  "plan_review_adapter_retryable_second",
  "plan_review_policy_violation",
  "speckit_rereview_infra_retryable", "speckit_rereview_infra_non_retryable",
  "speckit_rereview_output_contract", "speckit_rereview_policy_violation",
  "existing_planning_infra_retryable", "existing_planning_infra_retryable_always",
  "existing_planning_output_contract", "existing_planning_policy_violation",
  "implementer_adapter_retryable_always",
  "intra_role_ten",
  "intra_role_work_ahead",
  "intra_role_crash_after_role",
  "finding_task_locality",
  "carry_forward_tagged", "carry_forward_untagged", "carry_forward_overlap", "carry_forward_gate", "carry_forward_phasewide",
  "scoped_rereview", "scoped_rereview_fallback",
  "findings_per_task", "findings_per_task_phasewide",
  "impl_missing_sentinel_once", "impl_missing_sentinel_always", "impl_malformed_sentinel_once",
  "speckit_reviewer_infra_once", "speckit_reviewer_fail_once",
  "role_deadline_breach",
  "speckit_boundary_violation", "speckit_wrong_stage_specify", "speckit_wrong_stage_plan",
  "speckit_arbitrary_file", "speckit_bad_feature_json", "speckit_claude_md_violation",
  "speckit_postcondition_no_output", "speckit_postcondition_empty_spec", "speckit_postcondition_empty_plan",
  "speckit_postcondition_checked_tasks", "speckit_postcondition_missing_tasks",
  "speckit_postcondition_spec_without_feature_json", "speckit_postcondition_invented_feature_json_schema",
  "speckit_postcondition_symlink_escape"
]);

const FEATURE_DIR = path.join("specs", "999-smoke-test");
const CLAUDE_MD_MARKER_BEGIN = "<!-- SPECKIT START -->";
const CLAUDE_MD_MARKER_END = "<!-- SPECKIT END -->";

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function firstLineMatch(text, pattern) {
  for (const line of text.split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (match) return match[1];
  }
  return null;
}

function reviewOutput(decision, finding) {
  const findings = finding ? [finding] : [];
  console.log(`AUTOPILOT_REVIEW=${JSON.stringify({decision, findings})}`);
}

// TASK-19 Phase 4: the per-task Implementer result contract (mirrors
// fake-workflow-adapter.sh's emit_task_result). The final non-empty line must
// be exactly one AUTOPILOT_TASK_RESULT sentinel; changed files are derived by
// the orchestrator from the tree, so only summary + task-local check are
// reported here.
function emitTaskResult() {
  console.log("implementer ok");
  console.log(`AUTOPILOT_TASK_RESULT=${JSON.stringify({summary: "implementer ok", taskLocalCheck: {command: "true", status: "passed", exitCode: 0, summary: "fixture"}})}`);
}

// Mirrors fake-workflow-adapter.sh's scoped_delta_contains_forbidden_marker:
// extract ONLY the text between the stable prompt-contract delimiters
// (never surrounding prose), then look for the literal marker.
function scopedDeltaContainsForbiddenMarker(prompt) {
  let inside = false;
  const collected = [];
  for (const line of prompt.split(/\r?\n/)) {
    if (/<<<AUTOPILOT_SCOPED_DELTA_BEGIN:/.test(line)) { inside = true; continue; }
    if (/<<<AUTOPILOT_SCOPED_DELTA_END>>>/.test(line)) { inside = false; continue; }
    if (inside) collected.push(line);
  }
  return collected.join("\n").includes("FORBIDDEN_BASELINE_MARKER");
}

function hasFeatureJsonSchemaCorrection(prompt) {
  const marker = 'AUTOPILOT_PLANNING_CORRECTION={"stage":"specify","artifact":".specify/feature.json","expected":".specify/feature.json","reason":"feature_json_unexpected_shape","detail":null}';
  return prompt.includes(marker);
}

// TASK-11 Phase 4: a per-phase Implementer/Reviewer/Verifier call, as
// opposed to the single whole-mission final review: phase handoffs always
// carry a "Phase: " line, the MISSION_FINAL handoff never does.
function isPhaseReviewCall(prompt) {
  return /^Phase: /m.test(prompt);
}

function hasFeedbackMarker(prompt) {
  return /FEEDBACK TO ADDRESS|Prior findings to re-check|Previous failure|previous failure/i.test(prompt);
}

// TASK-14 Phase 3: mirrors fake-workflow-adapter.sh's is_rereview_prompt /
// is_existing_planning_prompt — position-specific plan_reviewer branches
// key off the orchestrator's own prompt text (the post-revision re-review
// sends "Re-review the SpecKit gate ...", reviewExistingPlanning() sends
// "Validate the existing ..."), never on timing or mutable state.
function isReReviewPrompt(prompt) {
  return /Re-review the SpecKit gate/.test(prompt);
}

function isExistingPlanningPrompt(prompt) {
  return /Validate the existing/.test(prompt);
}

// TASK-14 Phase 3: mirrors fake-workflow-adapter.sh's role_result_count —
// number of persisted relay results naming `role`, so a failure targeted
// at a later call site can observe an earlier position's result.
function reviewerResultCount(role) {
  let found = 0;
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "result.json") {
        try { if (JSON.parse(fs.readFileSync(full, "utf8")).role === role) found += 1; } catch { /* ignore */ }
      }
    }
  })(path.join(".autopilot"));
  return found;
}

// TASK-11 Phase 4: true when a persisted relay result already names `role`
// (completed OR failed relays — result.json is written unconditionally at
// completion). Reads only.
function priorRoleResult(role) {
  let found = false;
  (function walk(dir) {
    if (found || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "result.json") {
        try { if (JSON.parse(fs.readFileSync(full, "utf8")).role === role) found = true; } catch { /* ignore */ }
      }
    }
  })(path.join(".autopilot"));
  return found;
}

// TASK-11 Phase 4: number of relay run dirs naming `role` whose status.json
// exists but which have no result.json yet — i.e. interrupted runs plus
// this very call's own dir (created at spawn; result written only at
// completion). A hang gated on "count <= 1" therefore hangs exactly once
// per role per mission: the resume observes count 2 and PASSes.
function unfinishedRoleRuns(role) {
  let statusCount = 0;
  let resultCount = 0;
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.name === "status.json") {
        try { if (JSON.parse(fs.readFileSync(full, "utf8")).role === role) statusCount += 1; } catch { /* ignore */ }
      } else if (entry.name === "result.json") {
        try { if (JSON.parse(fs.readFileSync(full, "utf8")).role === role) resultCount += 1; } catch { /* ignore */ }
      }
    }
  })(path.join(".autopilot"));
  return statusCount - resultCount;
}

// TASK-11 Phase 4 standalone counter, maintained by the (writable)
// Implementer under .autopilot/ and read by the read-only roles. Never the
// repo-root counter: a retried Implementer must not perturb the recorded
// phase delta digest.
function standaloneAttempt() {
  const file = path.join(".autopilot", ".autopilot-test-standalone-attempt");
  let n = 0;
  try { n = parseInt(fs.readFileSync(file, "utf8"), 10) || 0; } catch { /* absent */ }
  return n;
}

function writeFeatureJson() {
  fs.mkdirSync(".specify", {recursive: true});
  fs.writeFileSync(path.join(".specify", "feature.json"), JSON.stringify({feature_directory: "specs/999-smoke-test"}));
}

// TASK 15.6C correction: the exact real observed Native Windows incident
// shape — a confused Planner invents its own 7-field feature.json instead
// of the real speckit-specify schema.
function writeInventedFeatureJson() {
  fs.mkdirSync(".specify", {recursive: true});
  fs.writeFileSync(path.join(".specify", "feature.json"), JSON.stringify({
    feature_directory: "specs/999-smoke-test",
    feature_name: "smoke-test",
    feature_number: "999",
    branch: "999-smoke-test",
    created_at: "2026-01-01T00:00:00Z",
    author: "claude",
    status: "draft"
  }));
}

// An extra, invented field ("branch") — must fail feature.json's exact
// single-field schema validation even though the path itself is allowed.
function writeBadFeatureJson() {
  fs.mkdirSync(".specify", {recursive: true});
  fs.writeFileSync(path.join(".specify", "feature.json"), JSON.stringify({
    feature_directory: "specs/999-smoke-test",
    branch: "999-smoke-test"
  }));
}

// Violation: edits content OUTSIDE the controlled marker section.
function updateClaudeMdOutsideMarker() {
  fs.appendFileSync("CLAUDE.md", "\nTAMPERED LINE OUTSIDE THE MARKER SECTION\n");
}

function writeSpec() {
  fs.mkdirSync(path.join(FEATURE_DIR, "checklists"), {recursive: true});
  fs.writeFileSync(path.join(FEATURE_DIR, "spec.md"), "# Spec\n\nSmoke test feature.\n");
  fs.writeFileSync(path.join(FEATURE_DIR, "checklists", "requirements.md"), "# Requirements checklist\n\n- [ ] Requirement A\n");
}

function writePlanArtifacts() {
  fs.mkdirSync(path.join(FEATURE_DIR, "contracts"), {recursive: true});
  fs.writeFileSync(path.join(FEATURE_DIR, "plan.md"), "# Plan\n\nSmoke test plan.\n");
  fs.writeFileSync(path.join(FEATURE_DIR, "research.md"), "# Research\n\nFindings.\n");
  fs.writeFileSync(path.join(FEATURE_DIR, "data-model.md"), "# Data Model\n\nEntities.\n");
  fs.writeFileSync(path.join(FEATURE_DIR, "quickstart.md"), "# Quickstart\n\nSteps.\n");
  fs.writeFileSync(path.join(FEATURE_DIR, "contracts", "health.md"), "# Health contract\n\nGET /health\n");
}

function writeTasks() {
  fs.writeFileSync(path.join(FEATURE_DIR, "tasks.md"), "## Phase 1: Do the smoke test task\n\n- [ ] Do the smoke test task\n");
}

// Legitimate CLAUDE.md update: rewrite ONLY the line(s) between the
// controlled markers — everything before CLAUDE_MD_MARKER_BEGIN and from
// CLAUDE_MD_MARKER_END onward is preserved byte-for-byte (mirrors the
// POSIX awk implementation's effect), matching what
// planning-boundary.mjs's markerSpan()/validateClaudeMdEdit() requires.
function updateClaudeMdInMarker() {
  if (!fs.existsSync("CLAUDE.md")) return;
  const content = fs.readFileSync("CLAUDE.md", "utf8");
  const beginIdx = content.indexOf(CLAUDE_MD_MARKER_BEGIN);
  const endIdx = content.indexOf(CLAUDE_MD_MARKER_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) return;
  const before = content.slice(0, beginIdx + CLAUDE_MD_MARKER_BEGIN.length);
  const after = content.slice(endIdx);
  fs.writeFileSync("CLAUDE.md", `${before}\nActive feature: 999-smoke-test\n${after}`);
}

function planNewFeature(prompt, step, scenario) {
  const featureLocked = firstLineMatch(prompt, /^Feature '([^']*)'/);
  let wantDir, wantStyle;
  if (featureLocked && featureLocked !== "<new-feature>") {
    wantDir = featureLocked;
    wantStyle = wantDir === "003-multi-task-feature" ? "multi" : "single";
  } else {
    if (/multi-task/.test(prompt)) { wantDir = "003-multi-task-feature"; wantStyle = "multi"; }
    else { wantDir = "001-fixture-feature"; wantStyle = "single"; }
    if (fs.existsSync(path.join("specs", wantDir))) {
      let n = 999;
      while (fs.existsSync(path.join("specs", `${n}-smoke-test`))) n -= 1;
      wantDir = `${n}-smoke-test`;
      wantStyle = "single";
    }
  }

  if (step === "specify") {
    fs.mkdirSync(".specify", {recursive: true});
    fs.mkdirSync(path.join("specs", wantDir), {recursive: true});
    fs.writeFileSync(path.join(".specify", "feature.json"), JSON.stringify({feature_directory: `specs/${wantDir}`}));
    fs.writeFileSync(path.join("specs", wantDir, "spec.md"),
      wantStyle === "multi" ? "# Spec\n\nMulti-task fixture feature.\n" : "# Spec\n\nFixture feature.\n");
  } else if (step === "plan") {
    fs.writeFileSync(path.join("specs", wantDir, "plan.md"),
      wantStyle === "multi" ? "# Plan\n\nMulti-task fixture plan.\n" : "# Plan\n\nFixture plan.\n");
  } else if (step === "tasks") {
    if (wantStyle === "multi") {
      fs.writeFileSync(path.join("specs", wantDir, "tasks.md"), [
        "## Phase 1: Already complete phase", "",
        "- [x] Pre-existing already completed task", "",
        "## Phase 2: Build the widgets", "",
        "- [ ] Build the first widget",
        "- [ ] Build the wídget with ünïcödé ✅", "",
        "## Phase 3: Ship the widgets", "",
        "- [ ] Ship the widgets", ""
      ].join("\r\n"));
    } else {
      // TASK-20: this scenario's phase needs MORE THAN ONE task, otherwise the
      // "affected is exactly one task" assertion on the persisted record is
      // vacuous — one candidate always "wins". Every other scenario keeps the
      // original single-task byte shape.
      //
      // TASK-21: the carry_forward_* scenarios need THREE tasks, so a FAIL
      // naming one task leaves two carry candidates (one of which the
      // overlap scenario re-touches).
      // TASK-23: the scoped_rereview* scenarios need the same three tasks.
      const second = scenario === "finding_task_locality" ? "- [ ] Do the second fixture task\n" : "";
      const sentinelTasks = ["impl_missing_sentinel_once", "impl_missing_sentinel_always", "impl_malformed_sentinel_once"].includes(scenario)
        ? "## Phase 1: Do the fixture task\n\n- [ ] Do the first sentinel task\n- [ ] Do the second sentinel task\n"
        : null;
      const carryTasks = ["carry_forward_tagged", "carry_forward_untagged", "carry_forward_overlap", "carry_forward_gate", "carry_forward_phasewide", "scoped_rereview", "scoped_rereview_fallback", "findings_per_task", "findings_per_task_phasewide"].includes(scenario)
        ? "## Phase 1: Do the fixture task\n\n- [ ] Do the first carry-forward task\n- [ ] Do the second carry-forward task\n- [ ] Do the third carry-forward task\n"
        : null;
      fs.writeFileSync(path.join("specs", wantDir, "tasks.md"), carryTasks ?? sentinelTasks ??
        `## Phase 1: Do the fixture task\n\n- [ ] Do the fixture task\n${second}`);
    }
  }
}

// TASK 16.3E: marks every unchecked checkbox complete in every specs/*/
// tasks.md (current AND future phases) — mirrors the POSIX
// `for f in specs/*/tasks.md; do awk '{gsub(/- \[ \]/,"- [x]"); print}' ...`
// loop used by the task14_premature_checkbox_fail/
// task14_policy_violation_with_marking/task14_crash_before_reconcile
// scenarios.
function markEveryUncheckedTaskComplete() {
  const specsRoot = "specs";
  if (!fs.existsSync(specsRoot)) return;
  for (const entry of fs.readdirSync(specsRoot, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    const tasksFile = path.join(specsRoot, entry.name, "tasks.md");
    if (!fs.existsSync(tasksFile)) continue;
    const content = fs.readFileSync(tasksFile, "utf8");
    fs.writeFileSync(tasksFile, content.replaceAll("- [ ]", "- [x]"));
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// TASK 16.3E CORRECTION 2: the junction TARGET directory must live somewhere
// that is (a) genuinely outside the fixture repository (repo-containment is
// exactly what this scenario proves gets rejected) and (b) already owned and
// cleaned up by the test harness — never a bare os.tmpdir() mkdtemp, which
// this adapter process (a short-lived spawned child with no reference back
// into the parent test's cleanup()) can never remove itself, leaking one
// directory per run forever. binDir (this very script's own directory —
// makeFixtureBin() copies this file to <binDir>/fake-workflow-adapter-
// win.mjs) is exactly such a directory: the test's cleanup(repo, binDir)
// already fs.rmSync()s it after every scenario, PASS or FAIL. The fixed
// subdirectory name below is a plain literal, independently duplicated in
// test-speckit-planning-postcondition.mjs (not imported — the two files
// share no module boundary), so the test can compute the exact same path
// deterministically and assert on it without any marker-file IPC.
const SYMLINK_ESCAPE_TARGET_DIRNAME = "symlink-escape-target";

// TASK 16.3E CORRECTION: real symlink-escape fixture for Native Windows.
// fs.symlinkSync's 'file'/'dir' types require SeCreateSymbolicLinkPrivilege
// (Developer Mode or elevation) — genuinely unavailable on a default Windows
// install, which is why the caller probes 'junction' capability separately
// before ever invoking this. A directory junction is the real, safe
// Windows-native equivalent (not an approximation): it needs no elevated
// privilege, and speckit-planning-postconditions.mjs's readRequiredFile
// documents that its component walk (fs.lstatSync().isSymbolicLink(), true
// for a junction on Windows) and its realpathSync containment check both
// treat a junction exactly like a POSIX symlink escape.
function writeSymlinkEscapeSpec() {
  const binDir = path.dirname(fileURLToPath(import.meta.url));
  const outsideDir = path.join(binDir, SYMLINK_ESCAPE_TARGET_DIRNAME);
  fs.mkdirSync(outsideDir, {recursive: true});
  fs.mkdirSync("specs", {recursive: true});
  if (fs.existsSync(FEATURE_DIR)) fs.rmSync(FEATURE_DIR, {recursive: true, force: true});
  fs.symlinkSync(outsideDir, FEATURE_DIR, "junction");
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--version") {
    console.log("fake-cursor-agent 1.0.0");
    process.exit(0);
  }

  const prompt = await readStdin();
  const role = firstLineMatch(prompt, /^ROLE=(.*)$/) || "";
  // Scenario channel mirrors fake-workflow-adapter.sh: the committed copy
  // under .autopilot/ wins (delta-invisible, so mid-mission switches never
  // read as approval drift); a legacy root-level file is the fallback.
  const scenario = fs.existsSync(path.join(".autopilot", ".autopilot-test-scenario"))
    ? fs.readFileSync(path.join(".autopilot", ".autopilot-test-scenario"), "utf8").trim()
    : fs.existsSync(".autopilot-test-scenario")
      ? fs.readFileSync(".autopilot-test-scenario", "utf8").trim()
      : "success";

  if (!PORTED_SCENARIOS.has(scenario)) {
    console.error(`fake-workflow-adapter-win: scenario '${scenario}' is not ported for Native Windows; run this test under WSL/Linux.`);
    process.exit(1);
  }

  if (role === "planner") {
    const step = firstLineMatch(prompt, /^Planning phase: (.+)\.$/);
    if (["speckit_full_contract", "speckit_resume", "speckit_spec_review_fail", "speckit_spec_review_pass"].includes(scenario)) {
      if (step === "specify") { writeFeatureJson(); writeSpec(); }
      else if (step === "plan") {
        if (scenario === "speckit_resume") {
          fs.writeFileSync("./.autopilot-test-plan-started", "");
          await sleep(3000);
        }
        writePlanArtifacts(); updateClaudeMdInMarker();
      } else if (step === "tasks") { writeTasks(); }
    } else if (scenario === "speckit_write_boundary_invented_feature_json") {
      if (step === "specify") {
        writeSpec();
        if (hasFeatureJsonSchemaCorrection(prompt)) writeFeatureJson();
        else writeInventedFeatureJson();
      } else if (step === "plan") { writePlanArtifacts(); updateClaudeMdInMarker(); }
      else if (step === "tasks") { writeTasks(); }
    } else if (scenario === "speckit_write_boundary_invented_feature_json_mixed") {
      if (step === "specify") {
        writeSpec();
        writeInventedFeatureJson();
        fs.mkdirSync("docs", {recursive: true});
        fs.writeFileSync(path.join("docs", "AUTOPILOT-SMOKE-TEST.md"), "# Smoke test results\n\nran ok\n");
      } else if (step === "plan") { writePlanArtifacts(); updateClaudeMdInMarker(); }
      else if (step === "tasks") { writeTasks(); }
    } else if (scenario === "speckit_boundary_violation") {
      // The real observed bug: the Planner also creates the implementation
      // deliverable itself, outside specs/ entirely, during the Spec stage.
      if (step === "specify") {
        writeFeatureJson(); writeSpec();
        fs.mkdirSync("docs", {recursive: true});
        fs.writeFileSync(path.join("docs", "AUTOPILOT-SMOKE-TEST.md"), "# Smoke test results\n\nran ok\n");
      } else if (step === "plan") { writePlanArtifacts(); updateClaudeMdInMarker(); }
      else if (step === "tasks") { writeTasks(); }
    } else if (scenario === "speckit_wrong_stage_specify") {
      // Wrong-stage file INSIDE the correct feature directory: plan.md
      // written during specify.
      if (step === "specify") {
        writeFeatureJson(); writeSpec();
        fs.writeFileSync(path.join(FEATURE_DIR, "plan.md"), "# Plan (written too early)\n");
      } else if (step === "plan") { writePlanArtifacts(); updateClaudeMdInMarker(); }
      else if (step === "tasks") { writeTasks(); }
    } else if (scenario === "speckit_wrong_stage_plan") {
      // Wrong-stage file INSIDE the correct feature directory: tasks.md
      // written during plan.
      if (step === "specify") { writeFeatureJson(); writeSpec(); }
      else if (step === "plan") {
        writePlanArtifacts();
        fs.writeFileSync(path.join(FEATURE_DIR, "tasks.md"), "## Phase 1: written too early\n\n- [ ] written too early\n");
      } else if (step === "tasks") { writeTasks(); }
    } else if (scenario === "speckit_arbitrary_file") {
      // An arbitrary file INSIDE the correct feature directory that is
      // never part of any stage's contract.
      if (step === "specify") {
        writeFeatureJson(); writeSpec();
        fs.writeFileSync(path.join(FEATURE_DIR, "implementation.js"), 'console.log("not a planning artifact");\n');
      } else if (step === "plan") { writePlanArtifacts(); updateClaudeMdInMarker(); }
      else if (step === "tasks") { writeTasks(); }
    } else if (scenario === "speckit_bad_feature_json") {
      if (step === "specify") { writeBadFeatureJson(); writeSpec(); }
      else if (step === "plan") { writePlanArtifacts(); updateClaudeMdInMarker(); }
      else if (step === "tasks") { writeTasks(); }
    } else if (scenario === "speckit_claude_md_violation") {
      if (step === "specify") { writeFeatureJson(); writeSpec(); }
      else if (step === "plan") { writePlanArtifacts(); updateClaudeMdOutsideMarker(); }
      else if (step === "tasks") { writeTasks(); }
    } else if (scenario === "speckit_postcondition_no_output") {
      // TASK 15.6B: the real Native Windows failure — an exit-zero planner
      // that writes nothing at any planning stage. Deliberately no-op.
    } else if (scenario === "speckit_postcondition_empty_spec") {
      if (step === "specify") {
        writeFeatureJson();
        fs.mkdirSync(FEATURE_DIR, {recursive: true});
        fs.writeFileSync(path.join(FEATURE_DIR, "spec.md"), "");
      } else if (step === "plan") { writePlanArtifacts(); updateClaudeMdInMarker(); }
      else if (step === "tasks") { writeTasks(); }
    } else if (scenario === "speckit_postcondition_empty_plan") {
      if (step === "specify") { writeFeatureJson(); writeSpec(); }
      else if (step === "plan") {
        fs.mkdirSync(path.join(FEATURE_DIR, "contracts"), {recursive: true});
        fs.writeFileSync(path.join(FEATURE_DIR, "plan.md"), "");
        fs.writeFileSync(path.join(FEATURE_DIR, "research.md"), "# Research\n\nFindings.\n");
        updateClaudeMdInMarker();
      } else if (step === "tasks") { writeTasks(); }
    } else if (scenario === "speckit_postcondition_checked_tasks") {
      if (step === "specify") { writeFeatureJson(); writeSpec(); }
      else if (step === "plan") { writePlanArtifacts(); updateClaudeMdInMarker(); }
      else if (step === "tasks") {
        fs.writeFileSync(path.join(FEATURE_DIR, "tasks.md"), "## Phase 1: Already done\n\n- [x] Finished task\n- [X] Another finished task\n");
      }
    } else if (scenario === "speckit_postcondition_missing_tasks") {
      if (step === "specify") { writeFeatureJson(); writeSpec(); }
      else if (step === "plan") { writePlanArtifacts(); updateClaudeMdInMarker(); }
      else if (step === "tasks") { /* no-op: tasks.md never written */ }
    } else if (scenario === "speckit_postcondition_spec_without_feature_json") {
      if (step === "specify") {
        fs.mkdirSync(FEATURE_DIR, {recursive: true});
        fs.writeFileSync(path.join(FEATURE_DIR, "spec.md"), "# Spec\n\nOrphan spec without feature.json.\n");
      } else if (step === "plan") { writePlanArtifacts(); updateClaudeMdInMarker(); }
      else if (step === "tasks") { writeTasks(); }
    } else if (scenario === "speckit_postcondition_invented_feature_json_schema") {
      if (step === "specify") {
        writeSpec();
        if (hasFeatureJsonSchemaCorrection(prompt)) writeFeatureJson();
      } else if (step === "plan") { writePlanArtifacts(); updateClaudeMdInMarker(); }
      else if (step === "tasks") { writeTasks(); }
    } else if (scenario === "speckit_postcondition_symlink_escape") {
      if (step === "specify") { writeFeatureJson(); writeSymlinkEscapeSpec(); }
      else if (step === "plan") { writePlanArtifacts(); updateClaudeMdInMarker(); }
      else if (step === "tasks") { writeTasks(); }
    } else if (scenario.startsWith("speckit_rereview_")) {
      // TASK-14 Phase 3: idempotent single-feature planning for the
      // post-revision re-review scenarios — mirrors the sh adapter's
      // speckit_rereview_* planner branch (same 001-fixture-feature bytes
      // plan_new_feature writes for the single-task shape). A
      // specify-stage REVISION must rewrite the SAME feature, never mint
      // a fresh one, or the revision planner trips the stage write
      // boundary before the re-review call under test.
      const dir001 = path.join("specs", "001-fixture-feature");
      if (step === "specify") {
        fs.mkdirSync(".specify", {recursive: true});
        fs.mkdirSync(dir001, {recursive: true});
        fs.writeFileSync(path.join(".specify", "feature.json"), JSON.stringify({feature_directory: "specs/001-fixture-feature"}));
        fs.writeFileSync(path.join(dir001, "spec.md"), "# Spec\n\nFixture feature.\n");
      } else if (step === "plan") {
        fs.writeFileSync(path.join(dir001, "plan.md"), "# Plan\n\nFixture plan.\n");
      } else if (step === "tasks") {
        fs.writeFileSync(path.join(dir001, "tasks.md"), "## Phase 1: Do the fixture task\n\n- [ ] Do the fixture task\n");
      }
    } else if (step) {
      // dirty_worktree_*/task14_*/success: no special planner support in
      // the POSIX reference either — a fresh NEW feature per plan_new_feature.
      planNewFeature(prompt, step, scenario);
    } else {
      // Standalone planning: mirror fake-workflow-adapter.sh's `*` branch —
      // the narrative plan prompt ("Write the narrative plan to exactly:") is
      // the standalone form; the SpecKit/legacy form has no "narrative".
      const planFile = firstLineMatch(prompt, /^Write the narrative plan to exactly: (.*)$/)
        || firstLineMatch(prompt, /^Write the plan to exactly: (.*)$/);
      const tasksFile = firstLineMatch(prompt, /^Write the phased checklist to exactly: (.*)$/);
      if (planFile) {
        fs.mkdirSync(path.dirname(planFile), {recursive: true});
        if (tasksFile) {
          fs.mkdirSync(path.dirname(tasksFile), {recursive: true});
          fs.writeFileSync(planFile, "# Plan\n\nObjective: fixture task.\n");
          // TASK-20: two tasks in the reviewed phase, so "affected is exactly
          // one of them" proves something (see planNewFeature's twin note).
          // TASK-21: three tasks for the carry_forward_* scenarios (twin of
          // the POSIX branch).
          // TASK-23: the scoped_rereview* scenarios need the same three tasks.
          const secondTask = scenario === "finding_task_locality" ? "- [ ] Do the second fixture task — accept: done ; verify: none\n" : "";
          const sentinelTasksFile = ["impl_missing_sentinel_once", "impl_missing_sentinel_always", "impl_malformed_sentinel_once"].includes(scenario)
            ? "## Phase 1: General\n\n- [ ] Do the first sentinel task — accept: done ; verify: none\n- [ ] Do the second sentinel task — accept: done ; verify: none\n"
            : null;
          const carryTasksFile = ["carry_forward_tagged", "carry_forward_untagged", "carry_forward_overlap", "carry_forward_gate", "carry_forward_phasewide", "scoped_rereview", "scoped_rereview_fallback", "findings_per_task", "findings_per_task_phasewide"].includes(scenario)
            ? "## Phase 1: General\n\n- [ ] Do the first carry-forward task — accept: done ; verify: none\n- [ ] Do the second carry-forward task — accept: done ; verify: none\n- [ ] Do the third carry-forward task — accept: done ; verify: none\n"
            : null;
          fs.writeFileSync(tasksFile, carryTasksFile ?? sentinelTasksFile ??
            `## Phase 1: General\n\n- [ ] Do the fixture task — accept: done ; verify: none\n${secondTask}`);
        } else {
          fs.writeFileSync(planFile, "# Plan\n\nObjective: fixture task.\n\n- [ ] Do the fixture task\n\nVerification notes: none required.\n");
        }
      }
    }
    console.log("planner ok");
    process.exit(0);
  }

  if (role === "plan_reviewer") {
    if (scenario === "plan_review_missing_sentinel_with_path_error") {
      // TASK 13 / Problem A regression: an incidental, already-recovered
      // path error mixed into otherwise-normal output must NOT rescue a
      // genuinely missing/malformed review sentinel. Deliberately no
      // AUTOPILOT_REVIEW= line at all.
      console.log("cat: docs/does-not-exist-yet.md: No such file or directory");
      console.log("I looked at everything and it looks fine.");
    } else if (scenario === "plan_review_infra_retryable" && !priorRoleResult("plan_reviewer")) {
      // TASK-14 planning-review attempt-failure regression: a retryable
      // infrastructure failure (nonzero exit, no sentinel), exactly once —
      // the retry observes the first failure's persisted result.json and
      // PASSes below. Stderr matches failure-contract.mjs's serverPattern,
      // classifying as SERVER_UNAVAILABLE/infrastructure (retryable).
      console.error("plan_review_infra_retryable: simulated infrastructure failure");
      console.error("server unavailable: upstream model endpoint refused the connection");
      process.exit(1);
    } else if (scenario === "plan_review_infra_non_retryable") {
      // TASK-14 planning-review attempt-failure regression: a non-retryable
      // infrastructure failure (nonzero exit, no sentinel), every time.
      // Stderr matches failure-contract.mjs's pathPattern, classifying as
      // PATH_UNSUPPORTED/infrastructure (escalates immediately).
      console.error("plan_review_infra_non_retryable: simulated path failure");
      console.error("cat: docs/plan-draft.md: No such file or directory");
      process.exit(1);
    } else if (scenario === "plan_review_infra_retryable_always") {
      // TASK-14 Phase 3 cross-mission regression: retryable infrastructure
      // failure, every time (same SERVER_UNAVAILABLE/infrastructure
      // classification as plan_review_infra_retryable, but never passing).
      console.error("plan_review_infra_retryable_always: simulated infrastructure failure");
      console.error("server unavailable: upstream model endpoint refused the connection");
      process.exit(1);
    } else if (scenario === "plan_review_adapter_retryable_always") {
      // TASK-14 Phase 3 cross-mission regression: retryable ADAPTER
      // failure, every time. Pattern-free stderr classifies as generic
      // PROCESS_EXIT_NONZERO/adapter, scoped to
      // adapter:<adapter>:plan_reviewer.
      console.error("plan_review_adapter_retryable_always: simulated adapter failure");
      console.error("adapter transport exploded: unexpected EOF from backend");
      process.exit(1);
    } else if (scenario === "plan_review_adapter_retryable_second") {
      // TASK-14 Phase 3 (XB2 mission 2): the same adapter-domain retryable
      // failure, but only while fewer than two plan_reviewer results exist
      // repo-wide (the prior mission left exactly one passing review) —
      // mirrors the sh adapter's role_result_count gate.
      if (reviewerResultCount("plan_reviewer") < 2) {
        console.error("plan_review_adapter_retryable_second: simulated adapter failure");
        console.error("adapter transport exploded: unexpected EOF from backend");
        process.exit(1);
      } else {
        reviewOutput("PASS", "");
      }
    } else if (scenario === "plan_review_policy_violation") {
      // TASK-14 Phase 3 policy-violation regression: attempt a git commit
      // (blocked/logged by the relay git guard) so the relay records
      // policyViolation=git_mutation_blocked even though a PASS sentinel
      // follows — the orchestrator must die immediately.
      spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "policy-violation-attempt"], {stdio: "ignore", shell: false});
      reviewOutput("PASS", "");
    } else if (scenario === "speckit_rereview_infra_retryable") {
      // TASK-14 Phase 3 call site 3: initial FAIL once functionally, then
      // the re-review fails once retryable (one persisted reviewer result
      // visible), then PASSes.
      if (isReReviewPrompt(prompt)) {
        if (reviewerResultCount("plan_reviewer") < 2) {
          console.error("speckit_rereview_infra_retryable: simulated infrastructure failure");
          console.error("server unavailable: upstream model endpoint refused the connection");
          process.exit(1);
        } else {
          reviewOutput("PASS", "");
        }
      } else if (!hasFeedbackMarker(prompt)) {
        reviewOutput("FAIL", "spec needs revision");
      } else {
        reviewOutput("PASS", "");
      }
    } else if (scenario === "speckit_rereview_infra_non_retryable") {
      // TASK-14 Phase 3 call site 3: initial FAIL once, then the re-review
      // fails every time with PATH_UNSUPPORTED — escalates unchanged.
      if (isReReviewPrompt(prompt)) {
        console.error("speckit_rereview_infra_non_retryable: simulated path failure");
        console.error("cat: docs/plan-draft.md: No such file or directory");
        process.exit(1);
      } else if (!hasFeedbackMarker(prompt)) {
        reviewOutput("FAIL", "spec needs revision");
      } else {
        reviewOutput("PASS", "");
      }
    } else if (scenario === "speckit_rereview_output_contract") {
      // TASK-14 Phase 3 call site 3: initial FAIL once, then the re-review
      // returns no sentinel — passes through unrecorded, escalates
      // unchanged.
      if (isReReviewPrompt(prompt)) {
        console.log("cat: docs/does-not-exist-yet.md: No such file or directory");
        console.log("I looked at everything and it looks fine.");
      } else if (!hasFeedbackMarker(prompt)) {
        reviewOutput("FAIL", "spec needs revision");
      } else {
        reviewOutput("PASS", "");
      }
    } else if (scenario === "speckit_rereview_policy_violation") {
      // TASK-14 Phase 3 policy-violation regression at call site 3.
      if (isReReviewPrompt(prompt)) {
        spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "policy-violation-attempt"], {stdio: "ignore", shell: false});
        reviewOutput("PASS", "");
      } else if (!hasFeedbackMarker(prompt)) {
        reviewOutput("FAIL", "spec needs revision");
      } else {
        reviewOutput("PASS", "");
      }
    } else if (scenario === "existing_planning_infra_retryable") {
      // TASK-14 Phase 3 call site 4: the existing-planning validation
      // fails once retryable, then PASSes; every other prompt PASSes.
      if (isExistingPlanningPrompt(prompt) && !priorRoleResult("plan_reviewer")) {
        console.error("existing_planning_infra_retryable: simulated infrastructure failure");
        console.error("server unavailable: upstream model endpoint refused the connection");
        process.exit(1);
      } else {
        reviewOutput("PASS", "");
      }
    } else if (scenario === "existing_planning_infra_retryable_always") {
      // TASK-14 Phase 3 GSD regression: existing-planning validation fails
      // every time with a RETRYABLE infrastructure failure — GSD must
      // still hard-escalate with zero retry.
      if (isExistingPlanningPrompt(prompt)) {
        console.error("existing_planning_infra_retryable_always: simulated infrastructure failure");
        console.error("server unavailable: upstream model endpoint refused the connection");
        process.exit(1);
      } else {
        reviewOutput("PASS", "");
      }
    } else if (scenario === "existing_planning_output_contract") {
      // TASK-14 Phase 3 call site 4: existing-planning validation with no
      // sentinel — escalates immediately, unrecorded, as its own case.
      if (isExistingPlanningPrompt(prompt)) {
        console.log("cat: docs/does-not-exist-yet.md: No such file or directory");
        console.log("I looked at everything and it looks fine.");
      } else {
        reviewOutput("PASS", "");
      }
    } else if (scenario === "existing_planning_policy_violation") {
      // TASK-14 Phase 3 policy-violation regression at call site 4.
      if (isExistingPlanningPrompt(prompt)) {
        spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "policy-violation-attempt"], {stdio: "ignore", shell: false});
        reviewOutput("PASS", "");
      } else {
        reviewOutput("PASS", "");
      }
    } else if (scopedDeltaContainsForbiddenMarker(prompt)) {
      reviewOutput("FAIL", "forbidden baseline marker present in scoped delta");
    } else if (scenario === "plan_review_fail" && !hasFeedbackMarker(prompt)) {
      // Platform parity with fake-workflow-adapter.sh's own plan_review_fail
      // case. Without it this scenario had no branch here at all, so a native
      // Windows run of any suite that selects it (test-planning-review-resume,
      // test-workflow-order-standalone, test-speckit-planning-review-resume)
      // fell through to a non-zero exit instead of the scripted FAIL — which
      // exercises the adapter retry budget, never the assertion under test.
      // FAILs once and PASSes on the retry that carries feedback.
      reviewOutput("FAIL", "needs more detail");
    } else if (scenario === "speckit_spec_review_fail") {
      reviewOutput("FAIL", "spec needs improvement");
    } else if (scenario === "speckit_spec_review_pass") {
      reviewOutput("PASS", "");
    } else {
      reviewOutput("PASS", "");
    }
    process.exit(0);
  }

  if (role === "implementer") {
    if (scenario === "implementer_adapter_retryable_always") {
      // TASK-14 Phase 3 cross-mission regression (adapter budget,
      // different-role key): the Implementer fails every time with a
      // retryable ADAPTER failure, exhausting
      // adapter:<adapter>:implementer while plan_reviewer's own key stays
      // untouched.
      console.error("implementer_adapter_retryable_always: simulated adapter failure");
      console.error("adapter transport exploded: unexpected EOF from backend");
      process.exit(1);
    }
    if (scenario === "dirty_worktree_zero_change") {
      emitTaskResult();
      process.exit(0);
    }
    if (scenario === "intra_role_ten" || scenario === "intra_role_work_ahead" || scenario === "intra_role_crash_after_role") {
      // TASK-19 Phase 4 native parity: one file per task, plus a deterministic
      // kill window on the 8th call (mirrors fake-workflow-adapter.sh). The
      // work-ahead variant creates a file named by a LATER task on the first
      // call.
      const taskId = firstLineMatch(prompt, /^currentTaskId: (.*)$/) || "task";
      const safe = taskId.replace(/[: |]/g, "_");
      fs.mkdirSync("output", {recursive: true});
      fs.writeFileSync(path.join("output", `${safe}.txt`), "task output\n");
      if (scenario === "intra_role_work_ahead" && /:T0:/.test(taskId)) {
        fs.writeFileSync(path.join("output", "ahead.txt"), "work ahead output\n");
      }
      const countFile = path.join(".autopilot", ".autopilot-test-intra-count");
      let count = 0;
      if (fs.existsSync(countFile)) count = parseInt(fs.readFileSync(countFile, "utf8"), 10) || 0;
      count += 1;
      fs.mkdirSync(".autopilot", {recursive: true});
      fs.writeFileSync(countFile, String(count));
      if (scenario === "intra_role_ten" && count === 8) {
        fs.writeFileSync("./.autopilot-test-intra-t8-marker", "");
        await sleep(5000);
      }
      if (scenario === "intra_role_crash_after_role" && count === 3) {
        // TASK-19 Phase 4: the orchestrator performs the crash (child exits 0
        // normally); autopilot.mjs's maybeInjectPostRoleCrash() exits after
        // the role returns but before the completion checkpoint is persisted.
        fs.mkdirSync(path.join(".autopilot"), {recursive: true});
        fs.writeFileSync(path.join(".autopilot", ".autopilot-test-crash-after-role"), "");
      }
      emitTaskResult();
      process.exit(0);
    }
    if (scenario.startsWith("standalone_") || scenario === "speckit_verifier_delta_change") {
      // TASK-11 Phase 4: standalone resume scenarios keep every runtime
      // artifact under .autopilot/ (invisible to scoped phase deltas) and
      // never bump the repo-root ./.autopilot-test-attempt counter, so a
      // retried Implementer cannot perturb the recorded delta digest.
      // Mission 040 task 3.2: speckit_verifier_delta_change shares this
      // branch so its verifier FAIL-once key (standaloneAttempt() <= 1)
      // and delta rewrite work the same as the standalone twin.
      const sFile = path.join(".autopilot", ".autopilot-test-standalone-attempt");
      const sAttempt = standaloneAttempt() + 1;
      fs.writeFileSync(sFile, String(sAttempt));
      if (scenario === "standalone_impl_interrupted" && sAttempt <= 1) {
        // Interrupted Implementer: leave partial work in the tree and sleep
        // so the harness kills the tree mid-Implementer. Later invocations
        // return immediately — the resume continues the partial work.
        // partial-work.txt is written once, before any delta is recorded
        // for the phase, so later digest comparisons stay stable.
        fs.writeFileSync("partial-work.txt", "partial implementation output\n");
        fs.writeFileSync(path.join(".autopilot", ".autopilot-test-impl-crash-marker"), "");
        await sleep(5000);
      }
      if (scenario === "standalone_verifier_delta_change" || scenario === "speckit_verifier_delta_change") {
        // Mission 040 tasks 2.2/3.2: simulate an implementer fix between
        // verifier runs — deterministic per-attempt content in an
        // in-scope file, so the retry's scoped delta differs.
        fs.mkdirSync("output", {recursive: true});
        fs.writeFileSync(path.join("output", "delta-change.txt"), `delta-change attempt ${sAttempt}\n`);
      }
      emitTaskResult();
      process.exit(0);
    }
    // Generic attempt counter lives under .autopilot/ (excluded from every
    // scoped delta) so counter bumps never perturb a recorded digest.
    const attemptFile = path.join(".autopilot", ".autopilot-test-attempt");
    let attempt = 0;
    if (fs.existsSync(attemptFile)) attempt = parseInt(fs.readFileSync(attemptFile, "utf8"), 10) || 0;
    fs.mkdirSync(".autopilot", {recursive: true});
    fs.writeFileSync(attemptFile, String(attempt + 1));

    if (scenario === "finding_task_locality") {
      // TASK-20: the first Implementer call finishes normally. The RETRY that
      // the code-review FAIL sends back drops a marker and sleeps, so the
      // harness can kill the whole tree at exactly "after the FAIL, before the
      // retry does any work" — that is the only moment at which the persisted
      // finding→task record, the wiped roleProgress, and the retry brief that
      // carries every finding are all on disk at once. Mirrors the POSIX
      // fake-workflow-adapter.sh branch of the same name.
      if (prompt.includes("Reviewer feedback from the previous attempt")) {
        fs.writeFileSync("./.autopilot-test-finding-task-locality-retry", "");
        await sleep(45000);
      }
      emitTaskResult();
      process.exit(0);
    }
    if (["scoped_rereview", "scoped_rereview_fallback"].includes(scenario)) {
      // TASK-23: per-task Implementer like the carry branch (one
      // ordinal-derived file per task), but the retry writes CHANGED content
      // — an identical rewrite would be invisible to tree attribution and
      // the re-review's fix diff would be empty. The fallback scenario's
      // retry additionally deletes the previous review's baseline manifest,
      // so the re-review falls back to the whole-phase handoff. Mirrors the
      // POSIX branch of the same name.
      const taskId = firstLineMatch(prompt, /^currentTaskId: (.*)$/) || "task";
      const ordMatch = /:T(\d+):/.exec(taskId);
      const ord = ordMatch ? ordMatch[1] : "x";
      fs.mkdirSync("output", {recursive: true});
      if (prompt.includes("Reviewer feedback from the previous attempt")) {
        fs.writeFileSync(path.join("output", `carry-T${ord}.txt`), "task output retry\n");
        if (scenario === "scoped_rereview_fallback") {
          for (const dir of fs.existsSync(path.join(".autopilot", "baseline")) ? fs.readdirSync(path.join(".autopilot", "baseline")) : []) {
            if (dir.endsWith("-review-r1")) {
              try { fs.rmSync(path.join(".autopilot", "baseline", dir, "manifest.json")); } catch { /* already gone */ }
            }
          }
        }
      } else {
        fs.writeFileSync(path.join("output", `carry-T${ord}.txt`), "task output\n");
      }
      const attemptFile = path.join(".autopilot", ".autopilot-test-attempt");
      let attempt = 0;
      if (fs.existsSync(attemptFile)) attempt = parseInt(fs.readFileSync(attemptFile, "utf8"), 10) || 0;
      fs.mkdirSync(".autopilot", {recursive: true});
      fs.writeFileSync(attemptFile, String(attempt + 1));
      emitTaskResult();
      process.exit(0);
    }
    if (["carry_forward_tagged", "carry_forward_untagged", "carry_forward_overlap", "carry_forward_gate", "carry_forward_phasewide", "findings_per_task", "findings_per_task_phasewide"].includes(scenario)) {
      // TASK-21: per-task Implementer writing one ordinal-derived file per
      // task (the intra_role_ten mechanism: the path derives from the
      // prompt's currentTaskId, so the orchestrator's tree attribution gives
      // every task a known owned file). The overlap scenario's T1 retry
      // additionally rewrites T3's file (output/carry-T2.txt). The generic
      // attempt counter is maintained too, exactly like the branch below.
      // Mirrors the POSIX branch of the same name.
      const taskId = firstLineMatch(prompt, /^currentTaskId: (.*)$/) || "task";
      const ordMatch = /:T(\d+):/.exec(taskId);
      const ord = ordMatch ? ordMatch[1] : "x";
      fs.mkdirSync("output", {recursive: true});
      fs.writeFileSync(path.join("output", `carry-T${ord}.txt`), "task output\n");
      if (scenario === "carry_forward_overlap" && prompt.includes("Reviewer feedback from the previous attempt") && /:T0:/.test(taskId)) {
        // Changed content (not an identical rewrite): the orchestrator's
        // tree attribution only reports CHANGED paths, so an identical
        // rewrite would be invisible and the overlap rule would have
        // nothing to fire on.
        fs.writeFileSync(path.join("output", "carry-T2.txt"), "task output retry\n");
      }
      const attemptFile = path.join(".autopilot", ".autopilot-test-attempt");
      let attempt = 0;
      if (fs.existsSync(attemptFile)) attempt = parseInt(fs.readFileSync(attemptFile, "utf8"), 10) || 0;
      fs.mkdirSync(".autopilot", {recursive: true});
      fs.writeFileSync(attemptFile, String(attempt + 1));
      emitTaskResult();
      process.exit(0);
    }
    if (["impl_missing_sentinel_once", "impl_missing_sentinel_always", "impl_malformed_sentinel_once"].includes(scenario)) {
      // TASK-25: per-task Implementer that ALWAYS edits its ordinal-derived
      // file, but skips or corrupts the AUTOPILOT_TASK_RESULT sentinel line
      // per scenario. The `once` variants skip/corrupt only the first T1
      // launch (tracked by a flag file under .autopilot/, invisible to every
      // scoped delta); the relaunch prints a valid line. The `always`
      // variant never prints one, so the mission must escalate on the
      // adapter budget. Mirrors the POSIX branch of the same name.
      const taskId = firstLineMatch(prompt, /^currentTaskId: (.*)$/) || "task";
      const ordMatch = /:T(\d+):/.exec(taskId);
      const ord = ordMatch ? ordMatch[1] : "x";
      fs.mkdirSync("output", {recursive: true});
      fs.writeFileSync(path.join("output", `sentinel-T${ord}.txt`), "task output\n");
      const flagFile = path.join(".autopilot", ".autopilot-test-sentinel-skipped");
      const alreadySkipped = fs.existsSync(flagFile);
      if (scenario === "impl_missing_sentinel_always" || (!alreadySkipped && /:T0:/.test(taskId))) {
        if (scenario !== "impl_missing_sentinel_always") {
          fs.mkdirSync(".autopilot", {recursive: true});
          fs.writeFileSync(flagFile, "skipped");
        }
        if (scenario === "impl_malformed_sentinel_once") {
          console.log("implementer ok");
          console.log("AUTOPILOT_TASK_RESULT={not json}");
        } else {
          console.log("implementer ok without a result line");
        }
        process.exit(0);
      }
      emitTaskResult();
      process.exit(0);
    }
    if (scenario === "dirty_worktree_changes") {
      fs.mkdirSync("output", {recursive: true});
      fs.writeFileSync(path.join("output", "notes.md"), "implementation output\n");
      fs.appendFileSync("existing-modified.txt", "mission-change\n");
    } else if (scenario === "task14_premature_checkbox_fail") {
      markEveryUncheckedTaskComplete();
    } else if (scenario === "task14_policy_violation_with_marking") {
      markEveryUncheckedTaskComplete();
      spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "policy-violation-attempt"], {stdio: "ignore", shell: false});
    } else if (scenario === "task14_crash_before_reconcile") {
      markEveryUncheckedTaskComplete();
      fs.writeFileSync("./.autopilot-test-crash-marker", "");
      await sleep(5000);
    }
    emitTaskResult();
    process.exit(0);
  }

  if (role === "code_reviewer" || role === "verifier") {
    const attemptFile = path.join(".autopilot", ".autopilot-test-attempt");
    let attempt = 0;
    if (fs.existsSync(attemptFile)) attempt = parseInt(fs.readFileSync(attemptFile, "utf8"), 10) || 0;

    let fixtureTaskAlreadyChecked = false;
    try {
      fixtureTaskAlreadyChecked = /^- \[x\] Do the fixture task/m.test(fs.readFileSync(path.join("specs", "001-fixture-feature", "tasks.md"), "utf8"));
    } catch { /* file absent — treat as not yet checked */ }

    if (scopedDeltaContainsForbiddenMarker(prompt)) {
      reviewOutput("FAIL", "forbidden baseline marker present in scoped delta");
    } else if (role === "code_reviewer" && fs.existsSync(path.join(".autopilot", ".autopilot-test-reviewer-hold"))) {
      // Backlog #83: opt-in block (mirrors the POSIX branch); a read-only
      // role cannot drop a marker, the test watches the run directory.
      await sleep(300000);
      reviewOutput("PASS", "");
    } else if (role === "code_reviewer" && scenario === "finding_task_locality" && isPhaseReviewCall(prompt)) {
      // TASK-20: a STRUCTURED finding that names its task by the reviewer
      // label the phase handoff now shows (`[T1]`). reviewOutput() only emits
      // plain-string findings, so the tagged shape is emitted here verbatim.
      // Mirrors the POSIX fake-workflow-adapter.sh branch of the same name.
      console.log(`AUTOPILOT_REVIEW=${JSON.stringify({decision: "FAIL", findings: [{
        tasks: ["T1"],
        location: "docs/finding-task-locality.md",
        problem: "Task T1 ships a stub with no implementation.",
        correction: "Replace the stub with the real implementation.",
      }]})}`);
    } else if (role === "code_reviewer" && ["carry_forward_tagged", "carry_forward_untagged", "carry_forward_overlap"].includes(scenario) && isPhaseReviewCall(prompt)) {
      // TASK-21: FAIL once (tagged ["T2"], a plain string, or tagged ["T1"]
      // per scenario), hang once so the harness can kill the tree on
      // deadline mid-review to observe the post-retry state, then PASS.
      // Mirrors the POSIX branches of the same names.
      if (!priorRoleResult("code_reviewer")) {
        if (scenario === "carry_forward_untagged") {
          reviewOutput("FAIL", "carry forward untagged finding with nowhere in particular");
        } else {
          const tag = scenario === "carry_forward_overlap" ? "T1" : "T2";
          console.log(`AUTOPILOT_REVIEW=${JSON.stringify({decision: "FAIL", findings: [{
            tasks: [tag],
            location: "docs/carry-forward.md",
            problem: `Task ${tag} ships a stub with no implementation.`,
            correction: "Replace the stub with the real implementation.",
          }]})}`);
        }
      } else if (unfinishedRoleRuns("code_reviewer") <= 1) {
        await sleep(300000);
        console.error(`${scenario}: hang window elapsed without interruption`);
        process.exit(124);
      } else {
        reviewOutput("PASS", "");
      }
    } else if (role === "code_reviewer" && scenario === "carry_forward_phasewide" && isPhaseReviewCall(prompt)) {
      // TASK-22: FAIL once with one finding tagged ["T2"] and one explicitly
      // phase-wide (`tasks: []`), hang once, then PASS. Mirrors the POSIX
      // branch of the same name.
      if (!priorRoleResult("code_reviewer")) {
        console.log(`AUTOPILOT_REVIEW=${JSON.stringify({decision: "FAIL", findings: [{
          tasks: ["T2"],
          location: "docs/carry-forward.md",
          problem: "Task T2 ships a stub with no implementation.",
          correction: "Replace the stub with the real implementation.",
        }, {
          tasks: [],
          location: "docs/carry-forward.md",
          problem: "The cross-task wiring is inconsistent.",
          correction: "Make the wiring consistent across tasks.",
        }]})}`);
      } else if (unfinishedRoleRuns("code_reviewer") <= 1) {
        await sleep(300000);
        console.error(`${scenario}: hang window elapsed without interruption`);
        process.exit(124);
      } else {
        reviewOutput("PASS", "");
      }
    } else if (role === "code_reviewer" && ["scoped_rereview", "scoped_rereview_fallback"].includes(scenario) && isPhaseReviewCall(prompt)) {
      // TASK-23: FAIL once with a finding tagged ["T2"], then PASS (no hang
      // needed — the whole mission completes in one run). The retry re-runs
      // T2 only with a new change; the second review must be the scoped
      // re-review (FIX marker, fix-only delta, FEEDBACK TO ADDRESS). Mirrors
      // the POSIX branch of the same name.
      if (!priorRoleResult("code_reviewer")) {
        console.log(`AUTOPILOT_REVIEW=${JSON.stringify({decision: "FAIL", findings: [{
          tasks: ["T2"],
          location: "docs/scoped-rereview.md",
          problem: "Task T2 ships a stub with no implementation.",
          correction: "Replace the stub with the real implementation.",
        }]})}`);
      } else {
        reviewOutput("PASS", "");
      }
    } else if (role === "code_reviewer" && scenario === "findings_per_task" && isPhaseReviewCall(prompt)) {
      // TASK-24: FAIL once with two findings — T1 and T3 — then PASS (no
      // hang; the mission completes in one run). The retry re-runs T1+T3
      // and carries T2. Mirrors the POSIX branch of the same name.
      if (!priorRoleResult("code_reviewer")) {
        console.log(`AUTOPILOT_REVIEW=${JSON.stringify({decision: "FAIL", findings: [{
          tasks: ["T1"],
          location: "docs/findings-per-task.md",
          problem: "FINDING-ONE",
          correction: "Fix the first task.",
        }, {
          tasks: ["T3"],
          location: "docs/findings-per-task.md",
          problem: "FINDING-THREE",
          correction: "Fix the third task.",
        }]})}`);
      } else {
        reviewOutput("PASS", "");
      }
    } else if (role === "code_reviewer" && scenario === "findings_per_task_phasewide" && isPhaseReviewCall(prompt)) {
      // TASK-24: FAIL once with one phase-wide ([]) plus one ["T2"]
      // finding, then PASS. allMapped is false so all 3 re-run. Mirrors
      // the POSIX branch of the same name.
      if (!priorRoleResult("code_reviewer")) {
        console.log(`AUTOPILOT_REVIEW=${JSON.stringify({decision: "FAIL", findings: [{
          tasks: [],
          location: "docs/findings-per-task.md",
          problem: "FINDING-PHASEWIDE",
          correction: "Rewire the phase.",
        }, {
          tasks: ["T2"],
          location: "docs/findings-per-task.md",
          problem: "FINDING-TWO",
          correction: "Fix the second task.",
        }]})}`);
      } else {
        reviewOutput("PASS", "");
      }
    } else if (role === "code_reviewer" && scenario === "standalone_reviewer_hang" && isPhaseReviewCall(prompt) && unfinishedRoleRuns("code_reviewer") <= 1) {
      // TASK-11 Phase 4 case 1: hang exactly once — the harness kills the
      // tree on deadline mid-review; the resume observes count 2 and PASSes.
      await sleep(45000);
      console.error("standalone_reviewer_hang: hang window elapsed without interruption");
      process.exit(124);
    } else if (role === "code_reviewer" && scenario === "standalone_reviewer_infra_once" && isPhaseReviewCall(prompt) && !priorRoleResult("code_reviewer")) {
      // TASK-11 Phase 4 case 4: infrastructure failure exactly once — the
      // prior result exists on retry, so the retry PASSes.
      console.error("standalone_reviewer_infra_once: simulated infrastructure failure");
      process.exit(1);
    } else if (role === "code_reviewer" && scenario === "standalone_reviewer_fail_once" && isPhaseReviewCall(prompt) && !hasFeedbackMarker(prompt)) {
      // TASK-11 Phase 4 case 5: functional FAIL with exact findings once;
      // the retry carries FEEDBACK TO ADDRESS and PASSes.
      reviewOutput("FAIL", "fix the widget alignment");
    } else if (role === "code_reviewer" && scenario === "speckit_reviewer_infra_once" && isPhaseReviewCall(prompt) && !priorRoleResult("code_reviewer")) {
      // TASK-29 (mirrors the POSIX branch of the same name): infrastructure
      // failure exactly once — the prior result exists on retry, so the
      // retry PASSes. Must retry only the Reviewer.
      console.error("speckit_reviewer_infra_once: simulated infrastructure failure");
      process.exit(1);
    } else if (role === "code_reviewer" && scenario === "speckit_reviewer_fail_once" && isPhaseReviewCall(prompt) && !hasFeedbackMarker(prompt)) {
      // TASK-29 (mirrors the POSIX branch of the same name): functional FAIL
      // with exact findings once; the retry carries FEEDBACK TO ADDRESS and
      // PASSes. Must return to the Implementer with the findings.
      reviewOutput("FAIL", "realign the widget grid");
    } else if (role === "code_reviewer" && scenario === "standalone_attempts_survive" && isPhaseReviewCall(prompt)) {
      // TASK-11 Phase 4 case 10 (reviewer third): exit 1 on the first
      // invocation, hang on the retry (killed on deadline), PASS on the
      // post-kill resume — proving attempt counters survive the restart.
      if (!priorRoleResult("code_reviewer") && unfinishedRoleRuns("code_reviewer") <= 1) {
        console.error("standalone_attempts_survive: simulated infrastructure failure");
        process.exit(1);
      } else if (unfinishedRoleRuns("code_reviewer") <= 1) {
        await sleep(45000);
        console.error("standalone_attempts_survive: hang window elapsed without interruption");
        process.exit(124);
      } else {
        reviewOutput("PASS", "");
      }
    } else if (role === "verifier" && scenario === "standalone_verifier_hang" && isPhaseReviewCall(prompt) && unfinishedRoleRuns("verifier") <= 1) {
      // TASK-11 Phase 4 case 2: hang exactly once; the resume PASSes.
      await sleep(45000);
      console.error("standalone_verifier_hang: hang window elapsed without interruption");
      process.exit(124);
    } else if (role === "verifier" && scenario === "standalone_verifier_infra_once" && isPhaseReviewCall(prompt) && !priorRoleResult("verifier")) {
      // TASK-11 Phase 4 case 3: infrastructure failure exactly once. The
      // second stderr line matches failure-contract.mjs's serverPattern, so
      // this is a real SERVER_UNAVAILABLE/infrastructure failure (retryable),
      // matching the POSIX fixture.
      console.error("standalone_verifier_infra_once: simulated infrastructure failure");
      console.error("server unavailable: upstream model endpoint refused the connection");
      process.exit(1);
    } else if (role === "verifier" && scenario === "standalone_verifier_fail_once" && isPhaseReviewCall(prompt) && standaloneAttempt() <= 1) {
      // TASK-11 Phase 4 case 6: functional FAIL once, keyed off the
      // Implementer-maintained standalone counter.
      reviewOutput("FAIL", "coverage gap");
    } else if (role === "verifier" && scenario === "standalone_verifier_delta_change" && isPhaseReviewCall(prompt) && standaloneAttempt() <= 1) {
      // Mission 040 task 2.2: functional FAIL once — the retry's
      // Implementer rewrites output/delta-change.txt, so the retry's
      // scoped delta differs (new cacheKey, no cache hit).
      reviewOutput("FAIL", "coverage gap");
    } else if (role === "verifier" && scenario === "speckit_verifier_delta_change" && isPhaseReviewCall(prompt) && standaloneAttempt() <= 1) {
      // Mission 040 task 3.2: SpecKit twin of standalone_verifier_delta_change
      // — functional FAIL once; the retry's Implementer rewrites
      // output/delta-change.txt, so the retry's scoped delta differs
      // (new cacheKey, no cache hit).
      reviewOutput("FAIL", "coverage shortfall");
    } else if (role === "verifier" && scenario === "standalone_attempts_survive" && isPhaseReviewCall(prompt) && unfinishedRoleRuns("verifier") <= 1) {
      // TASK-11 Phase 4 case 10 (verifier half): hang exactly once.
      await sleep(45000);
      console.error("standalone_attempts_survive: hang window elapsed without interruption");
      process.exit(124);
    } else if (role === "code_reviewer" && scenario === "task14_observe_unchecked" && /^Phase: /m.test(prompt) && fixtureTaskAlreadyChecked) {
      reviewOutput("FAIL", "task14 fixture: code reviewer observed the task already checked before verification");
    } else if (role === "verifier" && scenario === "task14_observe_unchecked" && fixtureTaskAlreadyChecked) {
      reviewOutput("FAIL", "task14 fixture: verifier observed the task already checked before its own PASS");
    } else if (role === "code_reviewer" && (scenario === "task14_review_always_fail" || scenario === "task14_premature_checkbox_fail")) {
      reviewOutput("FAIL", "task14 fixture: code review always fails");
    } else if (role === "verifier" && scenario === "task14_verify_always_fail") {
      reviewOutput("FAIL", "task14 fixture: verifier always fails");
    } else if (role === "verifier" && scenario === "task14_phase_verify_fail" && /^Phase: Phase 3/m.test(prompt)) {
      reviewOutput("FAIL", "task14 fixture: phase 3 verification always fails");
    } else if (role === "code_reviewer" && attempt <= 1 && scenario === "dirty_worktree_changes") {
      reviewOutput("FAIL", "fix the bug");
    } else if (role === "verifier" && scenario === "role_deadline_breach" && isPhaseReviewCall(prompt)) {
      // TASK-26: sleep past the tiny seeded derived deadline (the test sets
      // a 4s deadline via seeded samples + role_deadline_floor_ms), then
      // PASS. The first attempt times out (breach flag set); the retry runs
      // under the relay ceiling and completes. Mirrors the POSIX branch.
      await sleep(20000);
      reviewOutput("PASS", "");
    } else if (role === "verifier" && scenario === "carry_forward_gate" && isPhaseReviewCall(prompt)) {
      // TASK-21: the code reviewer always PASSes for this scenario; the
      // Verifier FAILs once tagged ["T1"] while the gate command also fails,
      // hangs once so the harness can kill the tree on deadline
      // mid-verification, then PASSes. Mirrors the POSIX branch.
      if (!priorRoleResult("verifier")) {
        console.log(`AUTOPILOT_REVIEW=${JSON.stringify({decision: "FAIL", findings: [{
          tasks: ["T1"],
          location: "docs/carry-forward.md",
          problem: "Task T1 fails the gate check.",
          correction: "Make the gate check pass.",
        }]})}`);
      } else if (unfinishedRoleRuns("verifier") <= 1) {
        await sleep(300000);
        console.error(`${scenario}: hang window elapsed without interruption`);
        process.exit(124);
      } else {
        reviewOutput("PASS", "");
      }
    } else {
      reviewOutput("PASS", "");
    }
    process.exit(0);
  }

  console.error(`fake-workflow-adapter-win: unknown ROLE '${role}'`);
  process.exit(1);
}

await main();
