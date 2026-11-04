#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("fake-capped-revision-adapter 1.0.0\n");
  process.exit(0);
}
if (args.includes("--help")) {
  process.stdout.write("Usage: opencode [command]\n");
  process.exit(0);
}
if (args[0] === "models") {
  process.stdout.write("opencode/fake-model\n");
  process.exit(0);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    try {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => { data += c; });
      process.stdin.on("end", () => resolve(data));
      process.stdin.on("error", () => resolve(data));
    } catch {
      resolve(data);
    }
  });
}

const prompt = (await readStdin()) + " " + args.join(" ");

function scenario() {
  for (const candidate of [".autopilot/.autopilot-test-scenario", ".autopilot-test-scenario"]) {
    try {
      const text = fs.readFileSync(candidate, "utf8").trim();
      if (text) return text;
    } catch {}
  }
  return "";
}

const sc = scenario();
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const step = () => emit({type: "step_finish", part: {type: "step-finish", tokens: {input: 10, output: 5, reasoning: 0, cache: {read: 0, write: 0}}}});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function spinToCap() {
  emit({type: "step_start", part: {type: "step-start"}});
  for (let i = 0; i < 45; i++) {
    step();
    await sleep(80);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// SpecKit Stages
// ────────────────────────────────────────────────────────────────────────────
if (prompt.includes("Planning phase: specify")) {
  fs.mkdirSync(".specify", {recursive: true});
  fs.mkdirSync("specs/001-feat", {recursive: true});
  fs.writeFileSync(".specify/feature.json", JSON.stringify({feature_directory: "specs/001-feat"}));
  fs.writeFileSync("specs/001-feat/spec.md", "# Spec\n\nFixture spec.\n");
  emit({type: "step_start", part: {type: "step-start"}});
  step();
  emit({type: "text", part: {type: "text", text: "specify complete"}});
  process.exit(0);
}

if (prompt.includes('SpecKit gate "review-spec"')) {
  emit({type: "text", part: {type: "text", text: 'AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}'}});
  process.exit(0);
}

if (prompt.includes("Planning phase: plan")) {
  fs.mkdirSync("specs/001-feat", {recursive: true});
  fs.writeFileSync("specs/001-feat/plan.md", "# Plan\n\nFixture plan.\n");
  emit({type: "step_start", part: {type: "step-start"}});
  step();
  emit({type: "text", part: {type: "text", text: "plan complete"}});
  process.exit(0);
}

if (prompt.includes('SpecKit gate "review-plan"')) {
  emit({type: "text", part: {type: "text", text: 'AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}'}});
  process.exit(0);
}

if (prompt.includes("Planning phase: tasks")) {
  const isRevision = prompt.includes("The plan reviewer REJECTED");
  const isContinuation = prompt.includes("Prior dead ends (continuation context");

  if (!isRevision && !isContinuation) {
    fs.mkdirSync("specs/001-feat", {recursive: true});
    fs.writeFileSync("specs/001-feat/tasks.md", "## Phase 1: Test\n\n- [ ] Task 1 — accept: ok ; verify: none\n");
    emit({type: "step_start", part: {type: "step-start"}});
    step();
    emit({type: "text", part: {type: "text", text: "tasks complete"}});
    process.exit(0);
  }

  if (isRevision && !isContinuation) {
    if (sc === "case1_speckit_revision_capped_with_edit") {
      fs.writeFileSync("specs/001-feat/tasks.md", "## Phase 1: Test\n\n- [ ] Task 1 edited — accept: ok ; verify: none\n");
      await spinToCap();
      process.exit(0);
    }
    if (sc === "case2_speckit_revision_capped_no_edit") {
      await spinToCap();
      process.exit(0);
    }
  }

  if (isContinuation) {
    fs.writeFileSync("specs/001-feat/tasks.md", "## Phase 1: Test\n\n- [ ] Task 1 continuation — accept: ok ; verify: none\n");
    emit({type: "step_start", part: {type: "step-start"}});
    step();
    emit({type: "text", part: {type: "text", text: "tasks continuation complete"}});
    process.exit(0);
  }
}

if (prompt.includes('SpecKit gate "review-tasks"')) {
  if (prompt.includes("Prior findings to re-check") || prompt.includes("confirmation full review") || prompt.includes("Address every finding") || prompt.includes("earlier-stage artifact(s)") || prompt.includes("Re-review the SpecKit gate") || prompt.includes("after revision")) {
    emit({type: "text", part: {type: "text", text: 'AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}'}});
    process.exit(0);
  }
  emit({type: "text", part: {type: "text", text: 'AUTOPILOT_REVIEW={"decision":"FAIL","findings":["tasks.md: improve task 1"]}'}});
  process.exit(0);
}

// ────────────────────────────────────────────────────────────────────────────
// Standalone Planning Stages
// ────────────────────────────────────────────────────────────────────────────
if (prompt.includes("Create or continue an implementation plan")) {
  const isRevision = prompt.includes("This is a REVISION round") || prompt.includes("Plan reviewer feedback that MUST be addressed");
  const isContinuation = prompt.includes("Prior dead ends (continuation context");

  const tm = /Write the phased checklist to exactly: (\S+)/.exec(prompt);
  const tasksPath = tm ? tm[1].replace(/[.,;:]+$/, "") : null;
  const pm = /Write the narrative plan to exactly: (\S+)/.exec(prompt);
  const planPath = pm ? pm[1].replace(/[.,;:]+$/, "") : null;

  if (sc === "case3_standalone_revision_capped_with_edit") {
    if (isRevision && !isContinuation) {
      if (tasksPath) {
        fs.mkdirSync(path.dirname(tasksPath), {recursive: true});
        fs.writeFileSync(tasksPath, "## Phase 1: Test\n\n- [ ] **1.1** Task 1 edited — accept: ok ; verify: none\n");
      }
      await spinToCap();
      process.exit(0);
    } else if (isContinuation) {
      emit({type: "step_start", part: {type: "step-start"}});
      step();
      emit({type: "text", part: {type: "text", text: "standalone continuation complete"}});
      process.exit(0);
    } else {
      // Initial planning authoring
      if (planPath) {
        fs.mkdirSync(path.dirname(planPath), {recursive: true});
        fs.writeFileSync(planPath, "# Plan\n\nObjective: standalone test\n");
      }
      if (tasksPath) {
        fs.mkdirSync(path.dirname(tasksPath), {recursive: true});
        fs.writeFileSync(tasksPath, "## Phase 1: Test\n\n- [ ] **1.1** Task 1 — accept: ok ; verify: none\n");
      }
      emit({type: "step_start", part: {type: "step-start"}});
      step();
      emit({type: "text", part: {type: "text", text: "standalone initial complete"}});
      process.exit(0);
    }
  }

  if (sc === "case4_first_attempt_capped_with_edit") {
    if (!isContinuation) {
      if (planPath) {
        fs.mkdirSync(path.dirname(planPath), {recursive: true});
        fs.writeFileSync(planPath, "# Plan\n\nObjective: standalone test\n");
      }
      if (tasksPath) {
        fs.mkdirSync(path.dirname(tasksPath), {recursive: true});
        fs.writeFileSync(tasksPath, "## Phase 1: Test\n\n- [ ] **1.1** Task 1 — accept: ok ; verify: none\n");
      }
      await spinToCap();
      process.exit(0);
    } else {
      emit({type: "step_start", part: {type: "step-start"}});
      step();
      emit({type: "text", part: {type: "text", text: "standalone first-attempt continuation complete"}});
      process.exit(0);
    }
  }
}

if (prompt.includes("Review the standalone Autopilot plan before implementation")) {
  if (prompt.includes("Prior findings to re-check") || prompt.includes("full re-check")) {
    emit({type: "text", part: {type: "text", text: 'AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}'}});
    process.exit(0);
  }
  if (sc === "case3_standalone_revision_capped_with_edit") {
    emit({type: "text", part: {type: "text", text: 'AUTOPILOT_REVIEW={"decision":"FAIL","findings":["TASKS.md 1.1: improve task verification"]}'}});
    process.exit(0);
  }
  emit({type: "text", part: {type: "text", text: 'AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}'}});
  process.exit(0);
}

// Fallback
emit({type: "step_start", part: {type: "step-start"}});
step();
emit({type: "text", part: {type: "text", text: "ok"}});
process.exit(0);
