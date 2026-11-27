#!/usr/bin/env node
// Backlog #3 regression tests: tasks-stage revision may edit spec.md plus
// every plan-stage feature artifact (plan.md, research.md, data-model.md,
// quickstart.md, contracts/**) in the same feature directory, while
// non-revision tasks runs remain restricted to tasks.md, and .specify/feature.json,
// CLAUDE.md, and other feature directories remain rejected.
import fs from "node:fs";
import {
  evaluatePlanningWriteBoundary,
  CLAUDE_MD_MARKER_BEGIN,
  CLAUDE_MD_MARKER_END
} from "./planning-boundary.mjs";

let passed = 0;
let failures = 0;
function check(name, condition) {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}`);
  }
}

const featureDir = "013-tenant-provisioning-management";
const base = `specs/${featureDir}/`;

// 1. Tasks revision allows each plan-stage artifact + spec.md individually and combined.
for (const rel of [
  `${base}contracts/x.md`,
  `${base}contracts/route-inventory-delta.md`,
  `${base}contracts/nested/schema.yaml`,
  `${base}research.md`,
  `${base}data-model.md`,
  `${base}quickstart.md`,
  `${base}spec.md`,
  `${base}plan.md`
]) {
  const res = evaluatePlanningWriteBoundary({
    stage: "tasks",
    touchedFiles: [`${base}tasks.md`, rel],
    resolvedFeatureDir: featureDir,
    preexistingFeatureDirs: [],
    revision: true
  });
  check(`tasks (revision): allows editing ${rel}`, res.ok === true && res.violations.length === 0);
}

{
  const combined = evaluatePlanningWriteBoundary({
    stage: "tasks",
    touchedFiles: [
      `${base}tasks.md`,
      `${base}spec.md`,
      `${base}plan.md`,
      `${base}research.md`,
      `${base}data-model.md`,
      `${base}quickstart.md`,
      `${base}contracts/x.md`
    ],
    resolvedFeatureDir: featureDir,
    preexistingFeatureDirs: [],
    revision: true
  });
  check("tasks (revision): allows editing tasks.md with spec.md + all plan-stage artifacts together",
    combined.ok === true && combined.violations.length === 0);
}

// 2. Tasks NON-revision rejects plan-stage companion artifacts as wrong_stage_artifact.
for (const rel of [
  `${base}contracts/x.md`,
  `${base}research.md`,
  `${base}data-model.md`,
  `${base}quickstart.md`,
  `${base}spec.md`,
  `${base}plan.md`
]) {
  const res = evaluatePlanningWriteBoundary({
    stage: "tasks",
    touchedFiles: [`${base}tasks.md`, rel],
    resolvedFeatureDir: featureDir,
    preexistingFeatureDirs: [],
    revision: false
  });
  const v = res.violations.find((item) => item.path === rel);
  check(`tasks (non-revision): rejects ${rel} as wrong_stage_artifact`,
    res.ok === false && v?.reason === "wrong_stage_artifact");
}

// 3. Tasks revision still rejects .specify/feature.json and CLAUDE.md.
{
  const featureJsonRes = evaluatePlanningWriteBoundary({
    stage: "tasks",
    touchedFiles: [`${base}tasks.md`, ".specify/feature.json"],
    resolvedFeatureDir: featureDir,
    preexistingFeatureDirs: [],
    readFile: (p) => p === ".specify/feature.json" ? JSON.stringify({ feature_directory: `specs/${featureDir}` }) : null,
    revision: true
  });
  const v = featureJsonRes.violations.find((item) => item.path === ".specify/feature.json");
  check("tasks (revision): rejects .specify/feature.json",
    featureJsonRes.ok === false && v?.reason === "wrong_stage_artifact");
}

{
  const claudeBaseline = `# CLAUDE.md\n${CLAUDE_MD_MARKER_BEGIN}\nold\n${CLAUDE_MD_MARKER_END}\n`;
  const claudeEdited = `# CLAUDE.md\n${CLAUDE_MD_MARKER_BEGIN}\nnew\n${CLAUDE_MD_MARKER_END}\n`;
  const claudeRes = evaluatePlanningWriteBoundary({
    stage: "tasks",
    touchedFiles: [`${base}tasks.md`, "CLAUDE.md"],
    resolvedFeatureDir: featureDir,
    preexistingFeatureDirs: [],
    readFile: (p) => p === "CLAUDE.md" ? claudeEdited : null,
    claudeMdBaseline: claudeBaseline,
    revision: true
  });
  const v = claudeRes.violations.find((item) => item.path === "CLAUDE.md");
  check("tasks (revision): rejects CLAUDE.md even with valid marker edit",
    claudeRes.ok === false && v?.reason === "wrong_stage_artifact");
}

// 4. Tasks revision rejects edits in another feature directory (preexisting or different).
{
  const preexistingOther = evaluatePlanningWriteBoundary({
    stage: "tasks",
    touchedFiles: [`${base}tasks.md`, "specs/001-existing/contracts/x.md"],
    resolvedFeatureDir: featureDir,
    preexistingFeatureDirs: ["001-existing"],
    revision: true
  });
  const v = preexistingOther.violations.find((item) => item.path === "specs/001-existing/contracts/x.md");
  check("tasks (revision): rejects contracts/x.md in a preexisting other feature dir",
    preexistingOther.ok === false && v?.reason === "preexisting_feature_directory");

  const otherFeature = evaluatePlanningWriteBoundary({
    stage: "tasks",
    touchedFiles: [`${base}tasks.md`, "specs/014-other/research.md"],
    resolvedFeatureDir: featureDir,
    preexistingFeatureDirs: [],
    revision: true
  });
  const v2 = otherFeature.violations.find((item) => item.path === "specs/014-other/research.md");
  check("tasks (revision): rejects research.md in a different feature dir",
    otherFeature.ok === false && v2?.reason === "different_feature_directory");
}

// 5. Planner brief text in scripts/autopilot.mjs lists the full allowed set for tasks revision
//    and keeps plan-stage wording unchanged.
{
  const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
  const start = src.indexOf("function boundaryNoteFor(");
  if (start < 0) throw new Error("function boundaryNoteFor not found in autopilot.mjs");
  let depth = 0;
  let i = src.indexOf("{", src.indexOf(")", start));
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) break;
  }
  const fnText = src.slice(start, i + 1);
  const boundaryNoteFor = new Function(
    "CLAUDE_MD_MARKER_BEGIN",
    "CLAUDE_MD_MARKER_END",
    `${fnText}; return boundaryNoteFor;`
  )(CLAUDE_MD_MARKER_BEGIN, CLAUDE_MD_MARKER_END);

  const tasksRevNote = boundaryNoteFor("tasks", featureDir, { revision: true });
  check("brief (tasks, revision): lists spec.md, plan.md, research.md, data-model.md, quickstart.md, contracts/**",
    tasksRevNote.includes("Revision mode: you may also edit an earlier-stage artifact cited by a finding (spec.md, plan.md, research.md, data-model.md, quickstart.md, contracts/** during tasks)"));
  check("brief (tasks, revision): still forbids feature.json and CLAUDE.md",
    tasksRevNote.includes("Never edit feature.json or CLAUDE.md."));

  const tasksNonRevNote = boundaryNoteFor("tasks", featureDir, { revision: false });
  check("brief (tasks, non-revision): does not include Revision mode allowance",
    !tasksNonRevNote.includes("Revision mode"));

  const planRevNote = boundaryNoteFor("plan", featureDir, { revision: true });
  check("brief (plan, revision): keeps (spec.md during plan) wording unchanged",
    planRevNote.includes("Revision mode: you may also edit an earlier-stage artifact cited by a finding (spec.md during plan)"));
}

if (failures) {
  console.error(`${failures} backlog-3 tasks-revision-artifacts check(s) failed.`);
  process.exit(1);
}
console.log(`backlog-3 tasks-revision-artifacts tests: PASS (${passed}/${passed} checks)`);
