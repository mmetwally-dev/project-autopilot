#!/usr/bin/env node
// TASK 15.6B — pure unit tests for scripts/speckit-planning-postconditions.mjs.
//
// Companion to scripts/test-speckit-planning-postcondition.mjs
// (behavioral): that file proves mission-level behavior through the real
// public entrypoint; THIS file proves the validator's exact reason matrix
// on disposable directories (missing/empty/whitespace/malformed artifacts,
// feature mismatches, pre-existing isolation, symlink/junction escapes,
// locked-session strictness). Neither file duplicates the other.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  validateSpecifyPostcondition, validatePlanPostcondition, validateTasksPostcondition,
  validatePlanningStagePostcondition, formatPostconditionError, SPECKIT_POSTCONDITION_STAGES
} from "./speckit-planning-postconditions.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ap-postcond-unit-"));
}
function rmRepo(repo) {
  fs.rmSync(repo, {recursive: true, force: true});
}
function write(repo, rel, content) {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), {recursive: true});
  fs.writeFileSync(abs, content);
}
function writeFeatureJson(repo, dirName) {
  write(repo, ".specify/feature.json", JSON.stringify({feature_directory: `specs/${dirName}`}));
}
function snapshot(repo) {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else out.push(path.relative(repo, f));
    }
  })(repo);
  return out.sort();
}

const NEW = "999-smoke-test";
const UNRELATED = "002-dashboard-design-prototype";

// ── specify ────────────────────────────────────────────────────────────────
{
  const repo = makeRepo();
  try {
    let v = validateSpecifyPostcondition({repo, sessionFeatureDir: null, preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "feature_json_missing");
    assert.equal(v.artifact, ".specify/feature.json");
    assert.equal(v.expected, ".specify/feature.json");

    write(repo, ".specify/feature.json", "{not json");
    v = validateSpecifyPostcondition({repo, sessionFeatureDir: null, preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "feature_json_invalid_json");

    write(repo, ".specify/feature.json", JSON.stringify({feature_directory: `specs/${NEW}`, branch: NEW}));
    v = validateSpecifyPostcondition({repo, sessionFeatureDir: null, preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "feature_json_unexpected_shape");

    writeFeatureJson(repo, NEW);
    v = validateSpecifyPostcondition({repo, sessionFeatureDir: "001-other", preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "feature_directory_mismatch");

    v = validateSpecifyPostcondition({repo, sessionFeatureDir: null, preexistingFeatureDirs: [NEW]});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "feature_directory_preexisting");

    v = validateSpecifyPostcondition({repo, sessionFeatureDir: null, preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "spec_md_missing");
    assert.equal(v.artifact, "spec.md");
    assert.equal(v.expected, `specs/${NEW}/spec.md`);

    write(repo, `specs/${NEW}/spec.md`, "");
    v = validateSpecifyPostcondition({repo, sessionFeatureDir: null, preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "spec_md_empty");

    write(repo, `specs/${NEW}/spec.md`, "  \n\t\n  ");
    v = validateSpecifyPostcondition({repo, sessionFeatureDir: null, preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "spec_md_empty");

    write(repo, `specs/${NEW}/spec.md`, "# Spec\n\nReal content.\n");
    const before = snapshot(repo);
    v = validateSpecifyPostcondition({repo, sessionFeatureDir: null, preexistingFeatureDirs: []});
    assert.equal(v.ok, true);
    assert.equal(v.featureDir, NEW);
    assert.deepEqual(snapshot(repo), before, "validation must not mutate the repository");

    // Locked session agreeing with the file passes too.
    v = validateSpecifyPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    assert.equal(v.ok, true);
    assert.equal(v.featureDir, NEW);
  } finally {
    rmRepo(repo);
  }
  console.log("PASS specify postcondition unit cases");
}

// ── specify: non-regular files and escapes ─────────────────────────────────
{
  const repo = makeRepo();
  try {
    writeFeatureJson(repo, NEW);
    fs.mkdirSync(path.join(repo, `specs/${NEW}/spec.md`), {recursive: true});
    let v = validateSpecifyPostcondition({repo, sessionFeatureDir: null, preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "spec_md_not_a_regular_file");

    fs.rmSync(path.join(repo, `specs/${NEW}/spec.md`), {recursive: true, force: true});
    let linkOk = true;
    try {
      fs.symlinkSync(path.join(repo, ".specify", "feature.json"), path.join(repo, `specs/${NEW}/spec.md`));
    } catch {
      linkOk = false;
    }
    if (linkOk) {
      v = validateSpecifyPostcondition({repo, sessionFeatureDir: null, preexistingFeatureDirs: []});
      assert.equal(v.ok, false);
      assert.equal(v.reason, "spec_md_symlink_rejected");
    } else {
      console.log("SKIP symlink case (symlink creation unsupported in this environment)");
    }
  } finally {
    rmRepo(repo);
  }
  console.log("PASS specify non-regular file cases");
}

// ── specify: a locked session never excuses a bad feature.json (finding 1)
{
  const repo = makeRepo();
  try {
    // Locked, but no feature.json at all.
    let v = validateSpecifyPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "feature_json_missing");

    // Locked, but the file is malformed.
    write(repo, ".specify/feature.json", "{not json");
    v = validateSpecifyPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "feature_json_invalid_json");

    // Locked, but the file disagrees with the lock.
    writeFeatureJson(repo, UNRELATED);
    v = validateSpecifyPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "feature_directory_mismatch");

    // Locked, and the file is a symlink: rejected, never followed.
    fs.rmSync(path.join(repo, ".specify", "feature.json"));
    write(repo, ".specify/real-feature.json", JSON.stringify({feature_directory: `specs/${NEW}`}));
    let linkOk = true;
    try {
      fs.symlinkSync(path.join(repo, ".specify", "real-feature.json"), path.join(repo, ".specify", "feature.json"));
    } catch {
      linkOk = false;
    }
    if (linkOk) {
      v = validateSpecifyPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
      assert.equal(v.ok, false);
      assert.equal(v.reason, "feature_json_symlink_rejected");
      fs.rmSync(path.join(repo, ".specify", "feature.json"));
    } else {
      console.log("SKIP symlinked feature.json case (symlink creation unsupported in this environment)");
    }

    // Locked, and the file validly agrees: the lock still works.
    writeFeatureJson(repo, NEW);
    write(repo, `specs/${NEW}/spec.md`, "# Spec\n\nContent.\n");
    v = validateSpecifyPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    assert.equal(v.ok, true);
    assert.equal(v.featureDir, NEW);

    // Same strictness surfaces through the plan/tasks stages: with the
    // feature.json deleted, the lock alone satisfies nothing.
    fs.rmSync(path.join(repo, ".specify", "feature.json"));
    v = validatePlanPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "feature_unresolved");
    v = validateTasksPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "feature_unresolved");
  } finally {
    rmRepo(repo);
  }
  console.log("PASS locked feature.json strictness cases");
}

// ── parent-directory symlink/junction escapes (finding 2) ─────────────────
// The final-file symlink check is not enough: a link in ANY parent
// component redirects the whole subtree. Canonicalization must prove the
// resolved artifact stays inside the repository and the active feature.
{
  const repo = makeRepo();
  try {
    writeFeatureJson(repo, NEW);

    // A symlinked feature directory pointing outside the repository.
    const outside = makeRepo();
    try {
      write(outside, "spec.md", "# Spec\n\nSmuggled from outside.\n");
      let linkOk = true;
      try {
        fs.symlinkSync(outside, path.join(repo, `specs/${NEW}`));
      } catch {
        linkOk = false;
      }
      if (linkOk) {
        const v = validateSpecifyPostcondition({repo, sessionFeatureDir: null, preexistingFeatureDirs: []});
        assert.equal(v.ok, false);
        assert.ok(v.reason === "spec_md_symlink_rejected" || v.reason === "spec_md_path_escape", `parent symlink escape rejected, got ${v.reason}`);
        fs.rmSync(path.join(repo, `specs/${NEW}`));
      } else {
        console.log("SKIP parent symlink cases (symlink creation unsupported in this environment)");
      }

      // A symlinked feature directory pointing at an UNRELATED feature
      // inside the same repository: still rejected, never read through.
      write(repo, `specs/${UNRELATED}/spec.md`, "# Spec\n\nUnrelated.\n");
      let innerOk = true;
      try {
        fs.symlinkSync(path.join(repo, `specs/${UNRELATED}`), path.join(repo, `specs/${NEW}`));
      } catch {
        innerOk = false;
      }
      if (innerOk) {
        const v = validateSpecifyPostcondition({repo, sessionFeatureDir: null, preexistingFeatureDirs: [UNRELATED]});
        assert.equal(v.ok, false);
        assert.ok(v.reason === "spec_md_symlink_rejected" || v.reason === "spec_md_outside_feature_directory", `intra-repo redirect rejected, got ${v.reason}`);
        fs.rmSync(path.join(repo, `specs/${NEW}`));
      }

      // A Windows junction pointing outside: lstat cannot see junctions,
      // so only canonical containment can reject it.
      let junctionOk = true;
      try {
        fs.symlinkSync(outside, path.join(repo, `specs/${NEW}`), "junction");
      } catch {
        junctionOk = false;
      }
      if (junctionOk) {
        const stats = fs.lstatSync(path.join(repo, `specs/${NEW}`));
        if (stats.isSymbolicLink()) {
          console.log("SKIP junction case (platform reports junctions as symlinks; covered by symlink cases)");
        } else {
          const v = validateSpecifyPostcondition({repo, sessionFeatureDir: null, preexistingFeatureDirs: []});
          assert.equal(v.ok, false);
          assert.equal(v.reason, "spec_md_path_escape");
        }
        fs.rmSync(path.join(repo, `specs/${NEW}`), {recursive: true, force: true});
      } else {
        console.log("SKIP junction case (junction creation unsupported in this environment)");
      }
    } finally {
      rmRepo(outside);
    }
  } finally {
    rmRepo(repo);
  }
  console.log("PASS parent-directory escape cases");
}

// ── specify: unrelated feature artifacts can never satisfy ─────────────────
{
  const repo = makeRepo();
  try {
    write(repo, `specs/${UNRELATED}/spec.md`, "# Spec\n\nUnrelated.\n");
    // No feature.json at all: the unrelated spec.md alone satisfies nothing.
    let v = validateSpecifyPostcondition({repo, sessionFeatureDir: null, preexistingFeatureDirs: [UNRELATED]});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "feature_json_missing");

    // feature.json aimed at the unrelated feature: rejected as pre-existing.
    writeFeatureJson(repo, UNRELATED);
    v = validateSpecifyPostcondition({repo, sessionFeatureDir: null, preexistingFeatureDirs: [UNRELATED]});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "feature_directory_preexisting");

    // feature.json aimed at the new feature, but the only spec.md lives
    // under the unrelated directory: the expected new path is missing.
    writeFeatureJson(repo, NEW);
    v = validateSpecifyPostcondition({repo, sessionFeatureDir: null, preexistingFeatureDirs: [UNRELATED]});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "spec_md_missing");
    assert.equal(v.expected, `specs/${NEW}/spec.md`);
  } finally {
    rmRepo(repo);
  }
  console.log("PASS specify unrelated-feature isolation cases");
}

// ── plan ───────────────────────────────────────────────────────────────────
{
  const repo = makeRepo();
  try {
    let v = validatePlanPostcondition({repo, sessionFeatureDir: null, preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "feature_unresolved");

    // A locked session never excuses a missing feature.json (finding 1).
    v = validatePlanPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "feature_unresolved");

    writeFeatureJson(repo, NEW);
    v = validatePlanPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "plan_md_missing");
    assert.equal(v.expected, `specs/${NEW}/plan.md`);

    write(repo, `specs/${NEW}/plan.md`, "");
    v = validatePlanPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "plan_md_empty");

    write(repo, `specs/${NEW}/plan.md`, " \r\n  \n");
    v = validatePlanPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "plan_md_empty");

    // Only the unrelated feature has a plan.md: must not satisfy.
    fs.rmSync(path.join(repo, `specs/${NEW}/plan.md`));
    write(repo, `specs/${UNRELATED}/plan.md`, "# Plan\n\nUnrelated.\n");
    v = validatePlanPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: [UNRELATED]});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "plan_md_missing");
    assert.equal(v.expected, `specs/${NEW}/plan.md`);

    write(repo, `specs/${NEW}/plan.md`, "# Plan\n\nReal plan.\n");
    const before = snapshot(repo);
    v = validatePlanPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: [UNRELATED]});
    assert.equal(v.ok, true);
    assert.equal(v.featureDir, NEW);
    assert.deepEqual(snapshot(repo), before, "validation must not mutate the repository");

    // Locked session disagreeing with the on-disk file fails closed
    // (surfaced as feature_unresolved for the plan stage).
    writeFeatureJson(repo, UNRELATED);
    v = validatePlanPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "feature_unresolved");

    // No locked session: the on-disk file identifies the session.
    fs.rmSync(path.join(repo, `specs/${NEW}/plan.md`));
    writeFeatureJson(repo, NEW);
    write(repo, `specs/${NEW}/plan.md`, "# Plan\n\nReal plan.\n");
    v = validatePlanPostcondition({repo, sessionFeatureDir: null, preexistingFeatureDirs: [UNRELATED]});
    assert.equal(v.ok, true);
    assert.equal(v.featureDir, NEW);
  } finally {
    rmRepo(repo);
  }
  console.log("PASS plan postcondition unit cases");
}

// ── tasks ──────────────────────────────────────────────────────────────────
{
  const repo = makeRepo();
  try {
    writeFeatureJson(repo, NEW);

    let v = validateTasksPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "tasks_md_missing");
    assert.equal(v.expected, `specs/${NEW}/tasks.md`);

    write(repo, `specs/${NEW}/tasks.md`, "");
    v = validateTasksPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "tasks_md_empty");

    write(repo, `specs/${NEW}/tasks.md`, "  \n   \n");
    v = validateTasksPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "tasks_md_empty");

    // Malformed: prose, no checkbox lines at all.
    write(repo, `specs/${NEW}/tasks.md`, "# Tasks\n\nJust do everything soon.\n");
    v = validateTasksPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "tasks_no_parseable_tasks");

    // Only fenced checkboxes: the real parser ignores fenced code blocks.
    write(repo, `specs/${NEW}/tasks.md`, "# Tasks\n\n```\n- [ ] fenced task\n```\n");
    v = validateTasksPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "tasks_no_parseable_tasks");

    // Completed-only: already-done tasks are not actionable.
    write(repo, `specs/${NEW}/tasks.md`, "## Phase 1: Done\n\n- [x] Finished task\n- [X] Another finished task\n");
    v = validateTasksPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "tasks_no_unchecked_actionable_tasks");

    // Whitespace-only task text is not actionable.
    write(repo, `specs/${NEW}/tasks.md`, "## Phase 1: Blank\n\n- [ ]   \n");
    v = validateTasksPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "tasks_no_unchecked_actionable_tasks");

    // Valid: one unchecked task among checked ones.
    write(repo, `specs/${NEW}/tasks.md`, "## Phase 1: Work\n\n- [x] Done part\n- [ ] Remaining part\n");
    const before = snapshot(repo);
    v = validateTasksPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    assert.equal(v.ok, true);
    assert.equal(v.featureDir, NEW);
    assert.deepEqual(snapshot(repo), before, "validation must not mutate the repository");

    // Unrelated feature's tasks.md cannot satisfy the new session.
    const repo2 = makeRepo();
    try {
      write(repo2, `specs/${UNRELATED}/tasks.md`, "## Phase 1: Other\n\n- [ ] Unrelated task\n");
      writeFeatureJson(repo2, NEW);
      v = validateTasksPostcondition({repo: repo2, sessionFeatureDir: NEW, preexistingFeatureDirs: [UNRELATED]});
      assert.equal(v.ok, false);
      assert.equal(v.reason, "tasks_md_missing");
      assert.equal(v.expected, `specs/${NEW}/tasks.md`);
    } finally {
      rmRepo(repo2);
    }
  } finally {
    rmRepo(repo);
  }
  console.log("PASS tasks postcondition unit cases");
}

// ── dispatcher, error format, and production hygiene ───────────────────────
{
  const repo = makeRepo();
  try {
    writeFeatureJson(repo, NEW);
    write(repo, `specs/${NEW}/spec.md`, "# Spec\n");
    write(repo, `specs/${NEW}/plan.md`, "# Plan\n");
    write(repo, `specs/${NEW}/tasks.md`, "## Phase 1: X\n\n- [ ] X\n");
    assert.deepEqual([...SPECKIT_POSTCONDITION_STAGES], ["specify", "plan", "tasks"]);
    for (const stage of SPECKIT_POSTCONDITION_STAGES) {
      const v = validatePlanningStagePostcondition({repo, stage, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
      assert.equal(v.ok, true, `dispatcher stage ${stage} should pass on valid fixtures`);
    }
    assert.throws(
      () => validatePlanningStagePostcondition({repo, stage: "implement", sessionFeatureDir: NEW, preexistingFeatureDirs: []}),
      /Unknown SpecKit planning stage/,
      "unknown stages fail closed"
    );

    const emptyRepo = makeRepo();
    try {
      const bad = validateSpecifyPostcondition({repo: emptyRepo, sessionFeatureDir: null, preexistingFeatureDirs: []});
      const message = formatPostconditionError("specify", bad);
      assert.ok(message.includes("'specify'"), "error names the stage");
      assert.ok(message.includes(".specify/feature.json"), "error names the artifact and expected path");
    } finally {
      rmRepo(emptyRepo);
    }

    fs.rmSync(path.join(repo, `specs/${NEW}/plan.md`));
    const missing = validatePlanPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    const planMessage = formatPostconditionError("plan", missing);
    assert.ok(planMessage.includes("'plan'") && planMessage.includes(`specs/${NEW}/plan.md`));

    // Production hygiene: no test-only hooks, scenario branches, or marker
    // files in the validator itself.
    const source = fs.readFileSync(path.join(here, "speckit-planning-postconditions.mjs"), "utf8");
    assert.ok(!source.includes(".autopilot-test-scenario"), "no scenario-file branches in production validator");
    assert.ok(!source.includes("AUTOPILOT_TEST"), "no test env hooks in production validator");
    assert.ok(!/process\.env\.(AP_|TEST_|SCENARIO)/.test(source), "no test env reads in production validator");
  } finally {
    rmRepo(repo);
  }
  console.log("PASS dispatcher, error format, and hygiene cases");
}

console.log("test-speckit-planning-postconditions: ALL CHECKS PASSED");
