#!/usr/bin/env node
// TASK 15.6D — behavioral SpecKit plan-stage regression for the real Native
// Windows incident: the Planner edits ONLY the controlled
// <!-- SPECKIT START/END --> marker section of CLAUDE.md, but its editor
// normalizes Windows/mixed line endings to LF across the whole file
// (observed baseline suffix "\n\r\n" becomes "\n").
//
// Proves against a real `node scripts/autopilot.mjs run` subprocess with
// the hermetic fake adapter (scenario
// `speckit_plan_claude_md_line_ending_normalization`, which performs the
// legitimate in-marker update and then strips CR bytes, emulating the
// Windows editor):
//   - Planner edits only the marker section (no other repo files touched
//     at the plan stage beyond the real plan artifact contract);
//   - line endings are normalized (CLAUDE.md on disk is LF-only after);
//   - Plan succeeds (no planning-write-boundary-violation, mission does
//     not escalate at plan);
//   - Plan Reviewer launches after the Plan-stage Planner (observed
//     ordering: the second plan_reviewer event occurs after the second
//     planner event with a PASS decision);
//   - unrelated files remain unchanged (pre-existing feature byte-identical,
//     outside-marker CLAUDE.md text preserved).
//
// POSIX-only (fake adapter is a shell script); runs in the WSL suite like
// its planning-boundary siblings. Never touches the real smoke repos or
// my-app: all state lives in disposable os.tmpdir() fixtures.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  makeFixtureRepo, makeFixtureBin,
  makeSpecKitUnrelatedFeatureFixture,
  setScenario, writeConfig, runAutopilot, readObservedEvents, cleanup, withoutOuterGitGuard
} from "./test-fixtures/workflow-order-harness.mjs";
import { CLAUDE_MD_MARKER_BEGIN, CLAUDE_MD_MARKER_END } from "./planning-boundary.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail)?.slice(0, 2000)}` : ""}`); }
}

if (process.platform === "win32") {
  console.log("SKIP: TASK 15.6D plan line-ending behavioral regression needs a POSIX shell for the fake adapter; unit coverage runs on win32 via test-planning-boundary.mjs.");
  process.exit(0);
}

const UNRELATED = "002-dashboard-design-prototype";
const NEW_FEATURE = "999-smoke-test";

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: withoutOuterGitGuard(process.env), shell: false });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim().slice(0, 1000)}`);
  return (r.stdout || "").trim();
}

const repo = makeFixtureRepo("plan-claude-md-eol");
const binDir = makeFixtureBin("plan-claude-md-eol");
try {
  const unrelatedDir = makeSpecKitUnrelatedFeatureFixture(repo, UNRELATED);
  // NOTE: makeSpecKitUnrelatedFeatureFixture already commits the canonical
  // SpecKit workflow file; do not re-create it (identical content would
  // leave nothing to commit).
  // Commit the exact observed mixed-ending baseline (overwrites nothing else).
  // NOTE: outside tail text after the markers exercises the non-terminal
  // encoding path (CRLF lines with real trailing content, not just EOF).
  const baselineWithTail = "# CLAUDE.md\n\nProject instructions (outside the Autopilot-controlled section).\n\n"
    + `${CLAUDE_MD_MARKER_BEGIN}\n(no active SpecKit feature)\n${CLAUDE_MD_MARKER_END}\n\r\nMore project instructions.\n`;
  fs.writeFileSync(path.join(repo, "CLAUDE.md"), baselineWithTail);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "CLAUDE.md mixed-ending baseline (observed Windows bytes)"]);

  const unrelatedBefore = {
    spec: fs.readFileSync(path.join(unrelatedDir, "spec.md"), "utf8"),
    plan: fs.readFileSync(path.join(unrelatedDir, "plan.md"), "utf8"),
    tasks: fs.readFileSync(path.join(unrelatedDir, "tasks.md"), "utf8")
  };

  writeConfig(repo, { planningFramework: "speckit" });
  setScenario(repo, "speckit_plan_claude_md_line_ending_normalization");
  const run = runAutopilot(repo, binDir, { request: "smoke test the health endpoint", timeoutMs: 120000 });

  check("plan-eol: mission completed (exit 0 — plan stage did not escalate)", run.status === 0, run.stderr.slice(-1500));

  const state = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
  check("plan-eol: no planning write-boundary violation recorded", state.step !== "planning-write-boundary-violation", state.step);
  check("plan-eol: mission did not escalate", state.phase !== "escalated", `${state.phase}/${state.step}`);
  check("plan-eol: session feature is the new feature", state.speckitFeatureDir === NEW_FEATURE, state.speckitFeatureDir);

  // Plan artifacts exist for the new feature only.
  const featureDir = path.join(repo, "specs", NEW_FEATURE);
  check("plan-eol: plan.md created for the new feature", fs.existsSync(path.join(featureDir, "plan.md")));

  // CLAUDE.md: marker section updated, outside text preserved, line endings normalized.
  const claudeAfter = fs.readFileSync(path.join(repo, "CLAUDE.md"), "utf8");
  check("plan-eol: marker section was updated", claudeAfter.includes("Active feature: 999-smoke-test") && claudeAfter.includes(CLAUDE_MD_MARKER_BEGIN) && claudeAfter.includes(CLAUDE_MD_MARKER_END));
  check("plan-eol: outside-marker head text preserved", claudeAfter.includes("Project instructions (outside the Autopilot-controlled section)."));
  check("plan-eol: outside-marker tail text preserved", claudeAfter.includes("More project instructions."));
  check("plan-eol: line endings normalized to LF (no CR remains)", !claudeAfter.includes("\r"), JSON.stringify(claudeAfter.slice(-80)));

  // Plan Review ordering from observable role events only (no prompt-prose
  // inspection, no duplication of production step-matching logic). In this
  // controlled happy-path scenario the planning sequence is specify,
  // review-spec, plan, review-plan, tasks, review-tasks: the first planner
  // / first reviewer are Spec / Spec Review, so the SECOND planner event is
  // the Plan-stage Planner and the SECOND reviewer event is Plan Review.
  const events = readObservedEvents(repo);
  const plannerEvents = events.filter(e => e.role === "planner");
  const reviewerEvents = events.filter(e => e.role === "plan_reviewer");
  check("plan-eol: planner ran", plannerEvents.length >= 1, events.map(e => e.role));
  check("plan-eol: Plan Reviewer launched", reviewerEvents.length >= 1, events.map(e => e.role));
  check("plan-eol: Plan-stage Planner exists (second planner event)", plannerEvents.length >= 2, events.map(e => e.role));
  check("plan-eol: Plan Review exists (second reviewer event)", reviewerEvents.length >= 2, events.map(e => e.role));
  const planPlanner = plannerEvents[1] || null;
  const planReview = reviewerEvents[1] || null;
  check("plan-eol: Plan Review occurs after the Plan-stage Planner",
    !!planPlanner && !!planReview && events.indexOf(planReview) > events.indexOf(planPlanner),
    events.map(e => `${e.role}:${e.decision ?? e.status}`));
  check("plan-eol: Plan Review decision is PASS", !!planReview && planReview.decision === "PASS", planReview && `${planReview.role}:${planReview.decision ?? planReview.status}`);

  // Unrelated files remain byte-for-byte unchanged.
  check("plan-eol: unrelated spec.md unchanged", fs.readFileSync(path.join(unrelatedDir, "spec.md"), "utf8") === unrelatedBefore.spec);
  check("plan-eol: unrelated plan.md unchanged", fs.readFileSync(path.join(unrelatedDir, "plan.md"), "utf8") === unrelatedBefore.plan);
  check("plan-eol: unrelated tasks.md unchanged", fs.readFileSync(path.join(unrelatedDir, "tasks.md"), "utf8") === unrelatedBefore.tasks);
} finally {
  cleanup(repo, binDir);
}

if (failures) {
  console.error(`${failures} plan line-ending behavioral check(s) failed.`);
  process.exit(1);
}
console.log("speckit plan CLAUDE.md line-ending behavioral regression: PASS");
