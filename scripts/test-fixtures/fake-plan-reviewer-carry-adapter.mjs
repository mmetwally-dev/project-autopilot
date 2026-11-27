#!/usr/bin/env node
// Self-contained opencode-shaped fixture for backlog #9's plan_reviewer
// continuation behaviour. The read-only sandbox binds only this executable,
// so every byte it needs (including the scenario selector) is read from the
// repo mount, never from a sibling fixture file.
//
// Scenario (committed .autopilot/.autopilot-test-scenario):
//   "carry"   session 1 writes scratch/report.md + an in-progress note, then
//             caps; session 2 checks the carried report was seeded and PASSes.
//   "verdict" session 1 writes scratch/report.md + a review-complete note
//             with a decided verdict, then caps; session 2 must be the short
//             verdict-only turn (the prompt carries VERDICT-ONLY TURN).
//   "double"  session 1 and session 2 both cap without a verdict and without
//             a review-complete note; the orchestrator must stop on #2.
import fs from "node:fs";

const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("fake-plan-reviewer-carry-adapter 1.0.0\n"); process.exit(0); }
if (args.includes("--help")) {
  process.stdout.write("Usage: opencode [command]\n  run [message..]\n    -m, --model <model>\n    --variant <level>\n");
  process.exit(0);
}
if (args[0] === "models") { process.stdout.write("opencode/fake-plan-reviewer-carry-model\n"); process.exit(0); }

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
const spinPastCap = async () => { for (let i = 0; i < 60; i += 1) { step(); await sleep(80); } };

let scenario = "";
try { scenario = fs.readFileSync(".autopilot/.autopilot-test-scenario", "utf8").trim(); } catch { scenario = ""; }
const continuation = prompt.includes("Prior dead ends (continuation context");
const verdictOnly = prompt.includes("VERDICT-ONLY TURN:");

function noteTarget() {
  const m = /Keep a hand-off note at (\S+)/.exec(prompt);
  if (!m) return null;
  const note = m[1].replace(/[.,;:]+$/, "");
  const slash = note.lastIndexOf("/");
  return {note, dir: slash >= 0 ? note.slice(0, slash) : "."};
}
function writeNote(text) {
  const target = noteTarget();
  if (!target) return;
  try { fs.mkdirSync(target.dir, {recursive: true}); fs.writeFileSync(target.note, text); } catch { /* scratch may be absent */ }
}
function writeReport(name, text) {
  const target = noteTarget();
  if (!target) return;
  try { fs.mkdirSync(target.dir, {recursive: true}); fs.writeFileSync(`${target.dir}/${name}`, text); } catch { /* scratch may be absent */ }
}
function seedEvidence() {
  const target = noteTarget();
  const dir = target?.dir || "/workspace/scratch";
  let seeded = false;
  try { seeded = fs.existsSync(`${dir}/previous-session/report.md`) && fs.statSync(`${dir}/previous-session/report.md`).size > 0; } catch { seeded = false; }
  return {seeded, pwshLine: prompt.includes("reuse it, do not download again")};
}
function emitReview(decision, notes) {
  emit({type: "text", part: {type: "text", text: `AUTOPILOT_REVIEW=${JSON.stringify({decision, findings: [], notes: notes || []})}`}});
}

if (!continuation && !verdictOnly) {
  emit({type: "step_start", part: {type: "step-start"}});
  writeReport("report.md", "REPORT-FROM-RUN1");
  if (scenario === "verdict") {
    writeNote("1. Done — full review finished.\n2. Found — Review complete, verdict FAIL. Findings in final sentinel.\n3. Next — none.\n4. Dead ends — none.\n");
  } else if (scenario === "double") {
    writeNote("1. Done — partial checks.\n2. Found — still reviewing; more checks remain.\n3. Next — continue checking.\n4. Dead ends — none.\n");
  } else {
    writeNote("1. Done — checked the gate.\n2. Found — REVIEW IN PROGRESS; report at /workspace/scratch/report.md.\n3. Next — finish the remaining checks.\n4. Dead ends — none.\n");
  }
  await spinPastCap();
  process.exit(0);
}

if (verdictOnly) {
  emit({type: "step_start", part: {type: "step-start"}});
  const evidence = seedEvidence();
  step();
  await sleep(10);
  for (let i = 0; i < 3; i += 1) { step(); await sleep(10); }
  emitReview("PASS", [`VERDICT_ONLY=yes`, `SEEDED=${evidence.seeded ? "yes" : "no"}`, `PWSH_LINE=${evidence.pwshLine ? "yes" : "no"}`]);
  process.exit(0);
}

if (continuation) {
  if (scenario === "double") {
    emit({type: "step_start", part: {type: "step-start"}});
    writeNote("1. Done — still checking.\n2. Found — still reviewing; no verdict yet.\n3. Next — continue checking.\n4. Dead ends — none.\n");
    await spinPastCap();
    process.exit(0);
  }
  if (scenario === "progress") {
    const target = noteTarget();
    const dir = target?.dir || "/workspace/scratch";
    const isRun2 = !fs.existsSync(`${dir}/previous-session/run-2.done`);
    if (isRun2) {
      emit({type: "step_start", part: {type: "step-start"}});
      writeReport("report.md", "REPORT-FROM-RUN1\n\n- Finding: Bug in auth module");
      writeReport("run-2.done", "yes");
      writeNote("1. Done — checked auth.mjs.\n2. Found — new findings in report.md.\n3. Next — continue checking.\n4. Dead ends — none.\n");
      await spinPastCap();
      process.exit(0);
    }
    emit({type: "step_start", part: {type: "step-start"}});
    step();
    await sleep(10);
    emitReview("PASS", ["SESSION_THREE=yes", "CONTINUATION=yes"]);
    process.exit(0);
  }
  emit({type: "step_start", part: {type: "step-start"}});
  const evidence = seedEvidence();
  step();
  await sleep(10);
  emitReview("PASS", [`CONTINUATION=yes`, `SEEDED=${evidence.seeded ? "yes" : "no"}`, `PWSH_LINE=${evidence.pwshLine ? "yes" : "no"}`]);
  process.exit(0);
}

// Not a plan review in this fixture's scope.
emit({type: "step_start", part: {type: "step-start"}});
step();
emit({type: "text", part: {type: "text", text: "fixture did nothing"}});
