#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as speckit from "../adapters/speckit.mjs";
import {
  makeFixtureRepo, makeFixtureBin, makeClaudeMdBaseline,
  setScenario, writeConfig, runAutopilot, readObservedEvents, cleanup
} from "./test-fixtures/workflow-order-harness.mjs";
import {fixtureGit} from "./test-fixtures/fixture-git.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures.push(name);
    console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`);
  }
};

const tempDirs = new Set();
process.on("exit", () => {
  for (const d of tempDirs) {
    try { fs.rmSync(d, {recursive: true, force: true}); } catch {}
  }
});

function createTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speckit-analyze-gate-"));
  tempDirs.add(dir);
  return dir;
}

function writeWorkflow(repo, stepsYml) {
  const dir = path.join(repo, ".specify", "workflows", "speckit");
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, "workflow.yml"), stepsYml);
}

function readBriefs(repo) {
  const root = path.join(repo, ".autopilot");
  const out = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === "brief.txt") out.push(fs.readFileSync(full, "utf8"));
    }
  })(root);
  return out;
}

// ── a. inspect() injects review-tasks after tasks step ──────────────────────
{
  const repo = createTempRepo();
  const wf = [
    "- id: specify",
    "  type: command",
    "  command: /speckit.specify",
    "- id: review-spec",
    "  type: gate",
    "  message: Review the spec",
    "- id: plan",
    "  type: command",
    "  command: /speckit.plan",
    "- id: review-plan",
    "  type: gate",
    "  message: Review the plan",
    "- id: tasks",
    "  type: command",
    "  command: /speckit.tasks",
    "- id: implement",
    "  type: command",
    "  command: /speckit.implement",
    ""
  ].join("\n");
  writeWorkflow(repo, wf);

  const info = speckit.inspect(repo);
  const stepIds = info.steps.map(s => s.id);
  const expectedIds = ["specify", "review-spec", "plan", "review-plan", "tasks", "review-tasks", "implement"];
  check("a: step ids match expected list", JSON.stringify(stepIds) === JSON.stringify(expectedIds), {stepIds, expectedIds});

  const reviewTasks = info.steps.find(s => s.id === "review-tasks");
  check("a: review-tasks has type gate and injected true",
    reviewTasks?.type === "gate" && reviewTasks?.injected === true, reviewTasks);

  const inGates = info.gates.some(g => g.id === "review-tasks" && g.type === "gate" && g.injected === true);
  check("a: review-tasks is present in info.gates", inGates, info.gates);
}

// ── b. existing review-tasks gate: not duplicated ───────────────────────────
{
  const repo = createTempRepo();
  const wf = [
    "- id: specify",
    "  type: command",
    "  command: /speckit.specify",
    "- id: review-spec",
    "  type: gate",
    "  message: Review the spec",
    "- id: plan",
    "  type: command",
    "  command: /speckit.plan",
    "- id: review-plan",
    "  type: gate",
    "  message: Review the plan",
    "- id: tasks",
    "  type: command",
    "  command: /speckit.tasks",
    "- id: review-tasks",
    "  type: gate",
    "  message: Existing review tasks gate",
    "- id: implement",
    "  type: command",
    "  command: /speckit.implement",
    ""
  ].join("\n");
  writeWorkflow(repo, wf);

  const info = speckit.inspect(repo);
  const stepIds = info.steps.map(s => s.id);
  const expectedIds = ["specify", "review-spec", "plan", "review-plan", "tasks", "review-tasks", "implement"];
  check("b: step list unchanged when review-tasks already present",
    JSON.stringify(stepIds) === JSON.stringify(expectedIds), stepIds);

  const tasksGates = info.gates.filter(g => String(g.id || "").includes("tasks"));
  check("b: count of tasks gates is exactly 1", tasksGates.length === 1, tasksGates);

  const reviewTasks = info.steps.find(s => s.id === "review-tasks");
  check("b: existing review-tasks does not have injected true", reviewTasks?.injected !== true, reviewTasks);
}

// ── c. workflow without tasks step: no review-tasks added ───────────────────
{
  const repo = createTempRepo();
  const wf = [
    "- id: specify",
    "  type: command",
    "  command: /speckit.specify",
    "- id: review-spec",
    "  type: gate",
    "  message: Review the spec",
    "- id: plan",
    "  type: command",
    "  command: /speckit.plan",
    "- id: review-plan",
    "  type: gate",
    "  message: Review the plan",
    "- id: implement",
    "  type: command",
    "  command: /speckit.implement",
    ""
  ].join("\n");
  writeWorkflow(repo, wf);

  const info = speckit.inspect(repo);
  const stepIds = info.steps.map(s => s.id);
  const expectedIds = ["specify", "review-spec", "plan", "review-plan", "implement"];
  check("c: no review-tasks added when no tasks step exists",
    JSON.stringify(stepIds) === JSON.stringify(expectedIds), stepIds);

  const hasReviewTasks = info.steps.some(s => s.id === "review-tasks");
  check("c: review-tasks absent from steps", !hasReviewTasks);
}

// ── d. analyzeCommandFile with injected exists ──────────────────────────────
{
  const mockRepo = "/mock/repo";
  // Candidate 2 and candidate 4 exist -> returns candidate 2 (first match in order)
  const existsSecondAndFourth = (p) => {
    return p === path.join(mockRepo, ".agents/skills/speckit-analyze/SKILL.md") ||
           p === path.join(mockRepo, ".claude/commands/speckit.analyze.md");
  };
  const first = speckit.analyzeCommandFile(mockRepo, existsSecondAndFourth);
  check("d: returns the first match in list order", first === ".agents/skills/speckit-analyze/SKILL.md", first);

  // Candidate 1 and candidate 3 exist -> returns candidate 1
  const existsFirstAndThird = (p) => {
    return p === path.join(mockRepo, ".claude/skills/speckit-analyze/SKILL.md") ||
           p === path.join(mockRepo, ".opencode/command/speckit.analyze.md");
  };
  const veryFirst = speckit.analyzeCommandFile(mockRepo, existsFirstAndThird);
  check("d: returns the very first match if present", veryFirst === ".claude/skills/speckit-analyze/SKILL.md", veryFirst);

  // When nothing exists -> returns null
  const none = speckit.analyzeCommandFile(mockRepo, () => false);
  check("d: returns null when nothing exists", none === null, none);
}

// ── e. tasks gate prompt and order during execution ─────────────────────────
{
  const repo = makeFixtureRepo("speckit-analyze");
  const binDir = makeFixtureBin("speckit-analyze");
  try {
    // Fixture WITHOUT a review-tasks gate in workflow.yml
    const workflowDir = path.join(repo, ".specify", "workflows", "speckit");
    fs.mkdirSync(workflowDir, {recursive: true});
    fs.writeFileSync(path.join(workflowDir, "workflow.yml"), [
      "- id: specify",
      "  type: command",
      "  command: /speckit.specify",
      "- id: review-spec",
      "  type: gate",
      "  message: Review the spec",
      "- id: plan",
      "  type: command",
      "  command: /speckit.plan",
      "- id: review-plan",
      "  type: gate",
      "  message: Review the plan",
      "- id: tasks",
      "  type: command",
      "  command: /speckit.tasks",
      "- id: implement",
      "  type: command",
      "  command: /speckit.implement",
      ""
    ].join("\n"));
    fixtureGit(["add", "-A"], {cwd: repo});
    fixtureGit(["commit", "-q", "-m", "speckit workflow without tasks gate"], {cwd: repo});

    // Fixture WITH .claude/skills/speckit-analyze/SKILL.md
    const skillDir = path.join(repo, ".claude", "skills", "speckit-analyze");
    fs.mkdirSync(skillDir, {recursive: true});
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# SpecKit Analyze\nRun analyze check on spec, plan and tasks.\n");
    fixtureGit(["add", "-A"], {cwd: repo});
    fixtureGit(["commit", "-q", "-m", "speckit-analyze command file"], {cwd: repo});

    makeClaudeMdBaseline(repo);
    writeConfig(repo, {planningFramework: "speckit"});
    setScenario(repo, "speckit_full_contract");

    const run = runAutopilot(repo, binDir, {request: "smoke test speckit analyze gate", timeoutMs: 120000});
    check("e: autopilot execution completed successfully", run.status === 0, {status: run.status, stderr: run.stderr.slice(-800)});

    const briefs = readBriefs(repo);
    const tasksGateBrief = briefs.find(b => b.includes('SpecKit gate "review-tasks"'));
    const expectedSentence = "Also run SpecKit's analyze check exactly as defined in .claude/skills/speckit-analyze/SKILL.md";
    check("e: tasks gate reviewer brief found", !!tasksGateBrief, briefs.length);
    check("e: tasks-gate reviewer prompt contains analyze sentence",
      Boolean(tasksGateBrief && tasksGateBrief.includes(expectedSentence)), tasksGateBrief?.slice(-1000));

    const events = readObservedEvents(repo);
    const tasksGateIdx = events.findIndex(e =>
      e.role === "plan_reviewer" &&
      fs.readFileSync(path.join(path.dirname(e.file), "brief.txt"), "utf8").includes('SpecKit gate "review-tasks"')
    );
    const tasksStepIdx = events.findLastIndex((e, i) => i < tasksGateIdx && e.role === "planner");
    const implIdx = events.findIndex(e => e.role === "implementer");

    check("e: review-tasks gate event observed", tasksGateIdx !== -1, events.map(e => e.role));
    check("e: tasks planner step ran before review-tasks gate", tasksStepIdx !== -1 && tasksStepIdx < tasksGateIdx, {tasksStepIdx, tasksGateIdx});
    check("e: implementer ran after review-tasks gate", implIdx !== -1 && tasksGateIdx < implIdx, {tasksGateIdx, implIdx});
  } finally {
    cleanup(repo, binDir);
  }
}

if (failures.length) {
  console.error(`${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("All speckit analyze gate tests passed.");

