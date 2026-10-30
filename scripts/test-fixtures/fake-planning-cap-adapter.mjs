#!/usr/bin/env node
// Planning-cap behavioural fixture in the opencode NDJSON wire shape.
// First planner/reviewer generation for a stage spins past the turn cap;
// the continuation generation writes the stage artifacts (planner) or
// returns PASS (reviewer). Generation detection is prompt-local: every
// continuation prompt quotes the prior dead ends.
import fs from "node:fs";

const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("fake-planning-cap-adapter 1.0.0\n"); process.exit(0); }
if (args.includes("--help")) {
  process.stdout.write("Usage: opencode [command]\n  run [message..]\n    -m, --model <model>\n    --variant <level>\n");
  process.exit(0);
}
if (args[0] === "models") { process.stdout.write("opencode/fake-planning-cap-model\n"); process.exit(0); }

const prompt = await new Promise((resolve) => {
  let data = "";
  try {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { data += c; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  } catch { resolve(data); }
});

const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const step = () => emit({type: "step_finish", part: {type: "step-finish", tokens: {input: 10, output: 5, reasoning: 0, cache: {read: 0, write: 0}}}});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const continuation = prompt.includes("Prior dead ends (continuation context");
const reviewer = prompt.includes("Review the current artifact state at the SpecKit gate");
const stage = /Planning phase: (specify|plan|tasks)/.exec(prompt)?.[1] || null;
const featureDir = "001-planning-cap";
const featureRel = `specs/${featureDir}`;

function writeArtifacts() {
  if (stage === "specify") {
    fs.mkdirSync(".specify", {recursive: true});
    fs.mkdirSync(featureRel, {recursive: true});
    fs.writeFileSync(".specify/feature.json", JSON.stringify({feature_directory: featureRel}));
    fs.writeFileSync(`${featureRel}/spec.md`, "# Spec\n\nPlanning-cap fixture feature.\n");
  } else if (stage === "plan") {
    fs.mkdirSync(featureRel, {recursive: true});
    fs.writeFileSync(`${featureRel}/plan.md`, "# Plan\n\nPlanning-cap fixture plan.\n");
  } else if (stage === "tasks") {
    fs.mkdirSync(featureRel, {recursive: true});
    fs.writeFileSync(`${featureRel}/tasks.md`, "## Phase 1: Do the fixture task\n\n- [ ] Do the fixture task\n");
  }
}

if (reviewer) {
  emit({type: "step_start", part: {type: "step-start"}});
  if (!continuation) {
    for (let i = 0; i < 45; i += 1) { step(); await sleep(80); }
    process.exit(0);
  }
  for (let i = 0; i < 2; i += 1) { step(); await sleep(10); }
  emit({type: "text", part: {type: "text", text: 'AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}'}});
  process.exit(0);
}

if (stage) {
  emit({type: "step_start", part: {type: "step-start"}});
  if (!continuation) {
    const m = /Keep a hand-off note at (\S+)/.exec(prompt);
    if (m) {
      const notePath = m[1].replace(/[.,;:]+$/, "");
      try {
        fs.mkdirSync(notePath.split("/").slice(0, -1).join("/"), {recursive: true});
        fs.writeFileSync(notePath, "1. Done — generation 1.\n2. Found — CAP-PLANNER-NOTE.\n3. Next — write the stage artifact.\n4. Dead ends — none.\n");
      } catch { /* scratch may be absent outside the sandbox */ }
    }
    for (let i = 0; i < 45; i += 1) { step(); await sleep(80); }
    process.exit(0);
  }
  writeArtifacts();
  const m = /Keep a hand-off note at (\S+)/.exec(prompt);
  if (m) {
    const notePath = m[1].replace(/[.,;:]+$/, "");
    try {
      fs.mkdirSync(notePath.split("/").slice(0, -1).join("/"), {recursive: true});
      fs.writeFileSync(notePath, "1. Done — generation 2 wrote the artifact.\n2. Found — GEN2-PLANNER-NOTE.\n3. Next — review.\n4. Dead ends — none.\n");
    } catch { /* scratch may be absent outside the sandbox */ }
  }
  for (let i = 0; i < 2; i += 1) { step(); await sleep(10); }
  emit({type: "text", part: {type: "text", text: "planning generation complete"}});
  process.exit(0);
}

// Anything else (implementation, etc.) is out of scope for this fixture.
emit({type: "step_start", part: {type: "step-start"}});
step();
emit({type: "text", part: {type: "text", text: 'AUTOPILOT_TASK_RESULT={"summary":"fixture done","taskLocalCheck":{"command":"node cap-probe","status":"passed","exitCode":0,"summary":"done"}}'}});
