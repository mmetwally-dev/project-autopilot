#!/usr/bin/env node
// TASK 15.6E — pure unit tests for the executable-phase tasks contract.
//
// The real Native Windows incident: the Planner produced a tasks.md with 5
// unchecked loose checkboxes and NO recognized `## Phase N` heading. The
// tasks-stage postcondition (flat-checkbox rule) accepted it, Tasks Review
// passed, and Implementation died before the Implementer with
// "No unchecked SpecKit tasks found" — because production executes PHASES
// (adapters/speckit.mjs phases()), not loose checkboxes.
//
// This file proves, on disposable directories (no agent CLI, no mission):
//   1. the defect shape (flat unchecked tasks, zero executable phases),
//   2. the strengthened postcondition rejects it as tasks_no_executable_phases,
//   3. orphan unchecked tasks are rejected even beside valid phases,
//   4. valid single/multi-phase formats still pass byte-for-byte unmutated,
//   5. pre-existing reason codes (missing/empty/unparseable/checked-only)
//      are unchanged.
// Companion to the behavioral tests (Windows + POSIX mission runs): those
// prove stage ordering, correction feedback, and legacy recovery; THIS file
// proves the validator's exact reason matrix.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {validateTasksPostcondition} from "./speckit-planning-postconditions.mjs";
import {tasks as parseSpecTasks, phases as parseSpecPhases} from "../adapters/speckit.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const NEW = "999-smoke-test";

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ap-tasks-phases-unit-"));
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
function seedValidSpecPlan(repo) {
  writeFeatureJson(repo, NEW);
  write(repo, `specs/${NEW}/spec.md`, "# Spec\n\nContent.\n");
  write(repo, `specs/${NEW}/plan.md`, "# Plan\n\nContent.\n");
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

// The exact real-incident shape: 5 unchecked tasks under a non-phase
// heading. The flat parser sees actionable work; the production phase
// parser sees nothing executable.
const INCIDENT_TASKS = [
  "# Tasks: Windows Autopilot Final Smoke Documentation",
  "",
  "## Tasks",
  "",
  "- [ ] T001 Create the docs/ directory",
  "",
  "- [ ] T002 Write docs/WINDOWS-AUTOPILOT-FINAL-SMOKE.md",
  "",
  "- [ ] T003 Cross-check every factual claim",
  "",
  "- [ ] T004 Confirm no out-of-scope file changes",
  "",
  "- [ ] T005 Run the manual verification checklist",
  ""
].join("\n");

// ── 1. defect reproduction: flat-vs-phase parser gap ─────────────────────
{
  const repo = makeRepo();
  try {
    seedValidSpecPlan(repo);
    write(repo, `specs/${NEW}/tasks.md`, INCIDENT_TASKS);
    const rel = `specs/${NEW}/tasks.md`;
    const flat = parseSpecTasks(repo, [rel]).filter(t => !t.done);
    assert.equal(flat.length, 5, "flat parser must see the 5 unchecked incident tasks");
    const executable = parseSpecPhases(repo, [rel]).filter(p => p.tasks.some(t => !t.done));
    assert.equal(executable.length, 0, "production phase parser must see zero executable phases");
    const v = validateTasksPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    assert.equal(v.ok, false, "postcondition must reject the incident shape");
    assert.equal(v.reason, "tasks_no_executable_phases", `precise reason, got ${v.reason}`);
    assert.equal(v.artifact, "tasks.md");
    assert.equal(v.expected, rel);
    assert.ok(typeof v.detail === "string" && v.detail.length > 0, "detail must explain the phase gap");
  } finally {
    rmRepo(repo);
  }
  console.log("PASS incident shape rejected with tasks_no_executable_phases");
}

// ── 2. orphan unchecked tasks beside a valid phase ───────────────────────
{
  const repo = makeRepo();
  try {
    seedValidSpecPlan(repo);
    write(repo, `specs/${NEW}/tasks.md`, [
      "- [ ] Orphan task before any heading",
      "",
      "## Phase 1: Real work",
      "",
      "- [ ] Real phased task",
      ""
    ].join("\n"));
    const v = validateTasksPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "tasks_no_executable_phases", `orphans rejected, got ${v.reason}`);
    assert.ok(/orphan/i.test(v.detail || ""), `detail names orphans, got ${v.detail}`);
    assert.ok(/specs\/999-smoke-test\/tasks\.md:1/.test(v.detail || ""), `detail uses a repo-relative location, got ${v.detail}`);
  } finally {
    rmRepo(repo);
  }
  console.log("PASS orphan unchecked tasks rejected beside a valid phase");
}

// ── 3. checked orphans are inert (only unchecked orphans block) ──────────
{
  const repo = makeRepo();
  try {
    seedValidSpecPlan(repo);
    write(repo, `specs/${NEW}/tasks.md`, [
      "- [x] Already-done note outside any phase",
      "",
      "## Phase 1: Real work",
      "",
      "- [ ] Real phased task",
      ""
    ].join("\n"));
    const v = validateTasksPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    assert.equal(v.ok, true, `checked orphans must not block, got ${JSON.stringify(v)}`);
  } finally {
    rmRepo(repo);
  }
  console.log("PASS checked orphans outside phases do not block");
}

// ── 4. valid formats still pass, unmutated ────────────────────────────────
{
  const repo = makeRepo();
  try {
    seedValidSpecPlan(repo);
    // Single phase.
    write(repo, `specs/${NEW}/tasks.md`, "## Phase 1: Work\n\n- [x] Done part\n- [ ] Remaining part\n");
    let before = snapshot(repo);
    let v = validateTasksPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    assert.equal(v.ok, true);
    assert.equal(v.featureDir, NEW);
    assert.deepEqual(snapshot(repo), before, "validation must not mutate the repository");

    // Multi-phase, CRLF line endings, unicode task text (production shape).
    write(repo, `specs/${NEW}/tasks.md`, [
      "## Phase 1: Already complete phase",
      "",
      "- [x] Pre-existing already completed task",
      "",
      "## Phase 2: Build the widgets",
      "",
      "- [ ] Build the first widget",
      "- [ ] Build the w\u00eddget with \u00fcn\u00efc\u00f6d\u00e9 \u2705",
      "",
      "## Phase 3: Ship the widgets",
      "",
      "- [ ] Ship the widgets",
      ""
    ].join("\r\n"));
    before = snapshot(repo);
    v = validateTasksPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    assert.equal(v.ok, true, `CRLF multi-phase must pass, got ${JSON.stringify(v)}`);
    assert.deepEqual(snapshot(repo), before, "validation must not normalize line endings");

    // Completed + future classification via the production parser.
    const rel = `specs/${NEW}/tasks.md`;
    const phased = parseSpecPhases(repo, [rel]);
    assert.equal(phased.length, 3);
    assert.equal(phased[0].done, true, "fully-checked phase classifies done");
    assert.equal(phased[1].done, false, "phase with unchecked tasks classifies open");
    assert.equal(phased[1].tasks.filter(t => !t.done).length, 2);
    assert.equal(phased[2].tasks.filter(t => !t.done).length, 1);

    // Colon-less heading is the production syntax too (colon optional).
    write(repo, `specs/${NEW}/tasks.md`, "## Phase 2\n\n- [ ] Colon-less but recognized\n");
    v = validateTasksPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    assert.equal(v.ok, true, `colon-less '## Phase N' must pass, got ${JSON.stringify(v)}`);

    // Single-# headings are NOT recognized phases (exact structure required).
    write(repo, `specs/${NEW}/tasks.md`, "# Phase 1: Not a phase heading\n\n- [ ] Orphan task\n");
    v = validateTasksPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "tasks_no_executable_phases");

    // Fenced phase headings do not count (both production parsers skip fences).
    write(repo, `specs/${NEW}/tasks.md`, "# Tasks\n\n```\n## Phase 1: Fenced\n\n- [ ] Fenced task\n```\n");
    v = validateTasksPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "tasks_no_parseable_tasks");
  } finally {
    rmRepo(repo);
  }
  console.log("PASS valid formats pass unmutated; near-miss headings rejected");
}

// ── 5. pre-existing reason codes unchanged ────────────────────────────────
{
  const repo = makeRepo();
  try {
    seedValidSpecPlan(repo);
    let v = validateTasksPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "tasks_md_missing");

    write(repo, `specs/${NEW}/tasks.md`, "   \n  \n");
    v = validateTasksPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "tasks_md_empty");

    write(repo, `specs/${NEW}/tasks.md`, "# Tasks\n\nJust do everything soon.\n");
    v = validateTasksPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "tasks_no_parseable_tasks");

    write(repo, `specs/${NEW}/tasks.md`, "## Phase 1: Done\n\n- [x] Finished\n- [X] Also finished\n");
    v = validateTasksPostcondition({repo, sessionFeatureDir: NEW, preexistingFeatureDirs: []});
    assert.equal(v.ok, false);
    assert.equal(v.reason, "tasks_no_unchecked_actionable_tasks");
  } finally {
    rmRepo(repo);
  }
  console.log("PASS pre-existing reason codes unchanged");
}

// ── 6. production hygiene: no duplicated phase-heading regex ──────────────
// The validator must reuse adapters/speckit.mjs — a second copy of the
// `## Phase` pattern here would drift from production.
{
  const source = fs.readFileSync(path.join(here, "speckit-planning-postconditions.mjs"), "utf8");
  assert.ok(!source.includes("Phase\\s"), "no duplicated phase-heading pattern in the validator");
  assert.ok(source.includes("parseSpecPhases"), "validator uses the production phase parser");
  console.log("PASS no duplicated parsing rules in the validator");
}

console.log("test-speckit-tasks-executable-phases: ALL CHECKS PASSED");
