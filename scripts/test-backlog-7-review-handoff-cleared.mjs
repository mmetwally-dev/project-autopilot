#!/usr/bin/env node
// Backlog b7: phase code_reviewer / verifier hand-off note must be cleared when
// a non-capped session finishes (PASS, FAIL, or failure ending the attempt),
// and code_reviewer vs verifier notes must be role-separated so a capped
// reviewer's note is never read by the verifier (or vice versa).
//
// Exercises the real orchestrator (`node scripts/autopilot.mjs run`) with a
// fake opencode adapter:
// (a) capped verifier -> note kept -> next verifier brief is a continuation;
// (b) that continuation completes (FAIL) -> note removed -> the next verifier
//     brief has NO "Prior verifier handoff note" and NO "carry the Findings
//     without re-verifying" line;
// (c) a capped code_reviewer note is not shown to the verifier.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  makeFixtureRepo, makeFixtureBin, writeConfig, setScenario, runAutopilot,
  cleanup,
} from "./test-fixtures/workflow-order-harness.mjs";
import {resolveAgentBinary} from "./agent-process.mjs";
import {handoffNoteRelPath} from "./per-task-budget.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MISSION = "001-b7-review-clear";
const TASKS = "## Phase 1: General\n\n- [ ] Do the fixture task\n";
const PLAN = "# Plan\n\nObjective: verify review/verifier hand-off clearing.\n";
const REVIEWER_MARKER = "REVIEWER-CAPPED-B7-MARKER";
const VERIFIER_MARKER = "VERIFIER-CAPPED-B7-MARKER";
const VERIFIER_FINDING = "Verifier finding 1: missing check in README.md";

// Hermetic-binary gate: opencode must resolve to our fixture shim.
{
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-b7-probe-"));
  try {
    if (process.platform === "win32") {
      fs.writeFileSync(path.join(probeDir, "opencode.cmd"), "@echo off\r\necho probe\r\n");
    } else {
      const shim = path.join(probeDir, "opencode");
      fs.writeFileSync(shim, "#!/bin/sh\necho probe\n");
      fs.chmodSync(shim, 0o755);
    }
    const savedPath = process.env.PATH || "";
    process.env.PATH = probeDir + (process.platform === "win32" ? ";" : ":") + savedPath;
    let resolved = null;
    try { resolved = resolveAgentBinary("opencode"); } catch { resolved = null; }
    process.env.PATH = savedPath;
    const wins = typeof resolved === "string" &&
      path.resolve(resolved).toLowerCase().startsWith(path.resolve(probeDir).toLowerCase());
    if (!wins) {
      console.log(`test-backlog-7-review-handoff-cleared: SKIP — a real opencode binary (${resolved}) outscores the fixture shim.`);
      process.exit(0);
    }
  } finally {
    try { fs.rmSync(probeDir, {recursive: true, force: true}); } catch {}
  }
}

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

const fakeAdapterCode = `
import fs from "node:fs";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("fake-b7-adapter 1.0.0\\n");
  process.exit(0);
}
if (args.includes("--help")) {
  process.stdout.write("Usage: opencode [command]\\n  run [message..]\\n    -m, --model <model>\\n    --variant <level>\\n    --agent <agent>\\n");
  process.exit(0);
}
if (args[0] === "models") {
  process.stdout.write("opencode/fake-b7-model\\n");
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
    } catch { resolve(data); }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tiny = {input: 10, output: 5, reasoning: 0, cache: {read: 0, write: 0}};
function emit(obj) {
  if (obj && typeof obj === "object" && !("session_id" in obj) && !("sessionID" in obj)) {
    obj.session_id = "fixture-b7-session";
  }
  process.stdout.write(JSON.stringify(obj) + "\\n");
}
function stepFinish() {
  emit({type: "step_finish", part: {type: "step-finish", tokens: tiny}});
}
async function spinToCap() {
  emit({type: "step_start", part: {type: "step-start"}});
  for (let i = 0; i < 45; i += 1) {
    stepFinish();
    await sleep(80);
  }
}

const prompt = (await readStdin()) + " " + args.join(" ");

if (prompt.includes("Write your hand-off note NOW")) {
  const m = /Write your hand-off note NOW to (\\S+)/.exec(prompt);
  if (m) {
    const notePath = m[1].replace(/[.,;:]+$/, "");
    const marker = notePath.includes("code_reviewer") ? ${JSON.stringify(REVIEWER_MARKER)} : ${JSON.stringify(VERIFIER_MARKER)};
    fs.mkdirSync(notePath.split("/").slice(0, -1).join("/") || ".", {recursive: true});
    fs.writeFileSync(notePath, [
      "1. Checked and clear — README.md:1-1",
      "2. Findings (final) — " + marker + ": checked partial scope",
      "3. Remaining — rest of phase",
      "4. Dead ends — none",
      "",
    ].join("\\n"));
  }
  emit({type: "step_start", part: {type: "step-start"}});
  stepFinish();
  await sleep(50);
  emit({type: "text", part: {type: "text", text: "wrap-up note written"}});
  process.exit(0);
}

if (prompt.includes("Verify this phase after implementation and code review.")) {
  if (prompt.includes("Progress: phase 1/1; attempt 2") || prompt.includes("impl 2 fix done")) {
    emit({type: "step_start", part: {type: "step-start"}});
    stepFinish();
    emit({type: "text", part: {type: "text", text: 'AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}'}});
    process.exit(0);
  }
  if (prompt.includes("Prior verifier handoff note")) {
    emit({type: "step_start", part: {type: "step-start"}});
    stepFinish();
    emit({type: "text", part: {type: "text", text: 'AUTOPILOT_REVIEW={"decision":"FAIL","findings":[${JSON.stringify(VERIFIER_FINDING)}]}'}});
    process.exit(0);
  }
  await spinToCap();
  process.exit(0);
}

if (prompt.includes("Review the whole phase") || prompt.includes("Re-review after a fix")) {
  if (prompt.includes("Re-review after a fix")) {
    emit({type: "step_start", part: {type: "step-start"}});
    stepFinish();
    emit({type: "text", part: {type: "text", text: 'AUTOPILOT_REVIEW={"decision":"PASS","findings":[],"previous":[{"finding":${JSON.stringify(VERIFIER_FINDING)},"status":"fixed"}]}'}});
    process.exit(0);
  }
  if (prompt.includes("Prior reviewer handoff note")) {
    emit({type: "step_start", part: {type: "step-start"}});
    stepFinish();
    emit({type: "text", part: {type: "text", text: 'AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}'}});
    process.exit(0);
  }
  await spinToCap();
  process.exit(0);
}

// Implementer
emit({type: "step_start", part: {type: "step-start"}});
stepFinish();
if (prompt.includes(${JSON.stringify(VERIFIER_FINDING)})) {
  fs.appendFileSync("README.md", "fix applied\\n");
  emit({type: "text", part: {type: "text", text: 'AUTOPILOT_TASK_RESULT={"summary":"impl 2 fix done","taskLocalCheck":{"command":"true","status":"passed","exitCode":0,"summary":"ok"}}'}});
} else {
  fs.appendFileSync("README.md", "initial impl\\n");
  emit({type: "text", part: {type: "text", text: 'AUTOPILOT_TASK_RESULT={"summary":"impl 1 done","taskLocalCheck":{"command":"true","status":"passed","exitCode":0,"summary":"ok"}}'}});
}
`;

const repo = makeFixtureRepo("b7-review-handoff-cleared");
const binDir = makeFixtureBin("b7-review-handoff-cleared");

try {
  const adapterB64 = Buffer.from(fakeAdapterCode, "utf8").toString("base64");
  const runner = `await import("data:text/javascript;base64,"+process.env.ADAPTER_B64)`;
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "opencode.cmd"),
      `@echo off\r\nset "ADAPTER_B64=${adapterB64}"\r\n"${process.execPath}" --input-type=module -e '${runner}' opencode %*\r\nexit /b %errorlevel%\r\n`);
  } else {
    fs.writeFileSync(path.join(binDir, "opencode"),
      `#!/bin/sh\nADAPTER_B64='${adapterB64}'\nexport ADAPTER_B64\nexec "${process.execPath}" --input-type=module -e '${runner}' opencode "$@"\n`);
    fs.chmodSync(path.join(binDir, "opencode"), 0o755);
  }

  writeConfig(repo, {planningFramework: "standalone", maxPlanRevisions: 2});
  const configPath = path.join(repo, ".autopilot", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.roles.implementer.adapter = "opencode";
  config.roles.code_reviewer.adapter = "opencode";
  config.roles.verifier.adapter = "opencode";
  config.workflow.finalReview = false;
  config.gates = {commands: []};
  config.policy = {
    ...config.policy,
    per_task_timeout_ms: 60000,
    per_task_max_turns: 30,
    verification_failure_budget: 3,
    caps: {
      implementer: {max_turns: 30, max_tokens: 200000, extra_sessions: 1},
      code_reviewer: {max_turns: 4, max_tokens: 200000, extra_sessions: 2},
      verifier: {max_turns: 4, max_tokens: 200000, extra_sessions: 2},
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  setScenario(repo, "b7_review_handoff_cleared");

  const missionDir = path.join(repo, ".autopilot", "missions", MISSION);
  fs.mkdirSync(missionDir, {recursive: true});
  fs.writeFileSync(path.join(missionDir, "PLAN.md"), PLAN);
  fs.writeFileSync(path.join(missionDir, "TASKS.md"), TASKS);
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
    version: 1,
    phase: "tasks_ready",
    step: "tasks_ready",
    phaseIndex: 0,
    attempt: 1,
    mission: MISSION,
    planningRequest: "b7 review handoff cleared probe",
  }, null, 2));

  const run = runAutopilot(repo, binDir, {
    request: "b7 review handoff cleared probe",
    timeoutMs: process.platform === "win32" ? 240000 : 180000,
  });
  const output = `${run.stdout}\n${run.stderr}`;

  const runsDir = path.join(missionDir, "runs");
  const runDirs = fs.existsSync(runsDir)
    ? fs.readdirSync(runsDir).sort((a, b) => a.localeCompare(b, undefined, {numeric: true}))
    : [];
  const runs = runDirs.map((d) => {
    const dir = path.join(runsDir, d);
    const brief = fs.existsSync(path.join(dir, "brief.txt")) ? fs.readFileSync(path.join(dir, "brief.txt"), "utf8") : "";
    const result = fs.existsSync(path.join(dir, "result.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8")) : {};
    return {dir: d, brief, result};
  });

  const isWrapUpBrief = (r) => r.brief.includes("Write your hand-off note NOW");
  const reviewerRuns = runs.filter((r) => r.result?.role === "code_reviewer" && !isWrapUpBrief(r));
  const verifierRuns = runs.filter((r) => r.result?.role === "verifier" && !isWrapUpBrief(r));

  check("mission completed", run.status === 0, {status: run.status, tail: output.slice(-800)});
  check("code_reviewer ran 3 times (capped -> continuation PASS -> attempt 2 PASS)",
    reviewerRuns.length === 3, reviewerRuns.map((r) => ({dir: r.dir, capped: r.result?.capped, decision: r.result?.review?.decision})));
  check("verifier ran 3 times (capped -> continuation FAIL -> attempt 2 PASS)",
    verifierRuns.length === 3, verifierRuns.map((r) => ({dir: r.dir, capped: r.result?.capped, decision: r.result?.review?.decision})));

  if (reviewerRuns.length >= 2 && verifierRuns.length >= 3) {
    // (c) Capped code_reviewer note is continued by code_reviewer, never shown to verifier
    check("(c) capped code_reviewer continuation received reviewer note",
      reviewerRuns[1].brief.includes("Prior reviewer handoff note")
      && reviewerRuns[1].brief.includes(REVIEWER_MARKER),
      reviewerRuns[1].brief.slice(0, 400));
    check("(c) verifier briefs never contain the capped code_reviewer note",
      verifierRuns.every((r) => !r.brief.includes(REVIEWER_MARKER) && !r.brief.includes("Prior reviewer handoff note")),
      verifierRuns.map((r) => r.brief.includes(REVIEWER_MARKER)));

    // (a) Capped verifier -> note kept -> next verifier brief is a continuation
    check("(a) first verifier run was capped", Boolean(verifierRuns[0].result?.capped), verifierRuns[0].result);
    check("(a) second verifier brief is a continuation with Prior verifier handoff note",
      verifierRuns[1].brief.includes("Prior verifier handoff note")
      && verifierRuns[1].brief.includes(VERIFIER_MARKER)
      && verifierRuns[1].brief.includes("carry the Findings without re-verifying them"),
      verifierRuns[1].brief.slice(0, 600));
    check("(a) second verifier run completed with FAIL",
      verifierRuns[1].result?.status === "completed" && verifierRuns[1].result?.review?.decision === "FAIL",
      verifierRuns[1].result);

    // (b) Continuation completes (FAIL) -> note removed -> next verifier brief is fresh
    check("(b) third verifier brief (new attempt) has NO Prior verifier handoff note",
      !verifierRuns[2].brief.includes("Prior verifier handoff note")
      && !verifierRuns[2].brief.includes(VERIFIER_MARKER),
      verifierRuns[2].brief.slice(0, 600));
    check("(b) third verifier brief (new attempt) has NO carry-the-Findings rule line",
      !verifierRuns[2].brief.includes("carry the Findings without re-verifying"),
      verifierRuns[2].brief.slice(0, 600));
    check("(b) third verifier run completed with PASS",
      verifierRuns[2].result?.status === "completed" && verifierRuns[2].result?.review?.decision === "PASS",
      verifierRuns[2].result);
  }

  // Note files on disk are gone after completion
  const reviewerNoteAbs = path.join(repo, handoffNoteRelPath(MISSION, "T1:code_reviewer"));
  const verifierNoteAbs = path.join(repo, handoffNoteRelPath(MISSION, "T1:verifier"));
  const legacyNoteAbs = path.join(repo, handoffNoteRelPath(MISSION, "T1"));
  check("role-separated reviewer note is removed from disk", !fs.existsSync(reviewerNoteAbs), reviewerNoteAbs);
  check("role-separated verifier note is removed from disk", !fs.existsSync(verifierNoteAbs), verifierNoteAbs);
  check("role-separated paths are distinct", reviewerNoteAbs !== verifierNoteAbs && verifierNoteAbs !== legacyNoteAbs);
} finally {
  cleanup(repo, binDir);
}

if (failures) {
  console.error(`${failures} backlog b7 review handoff clear check(s) failed.`);
  process.exit(1);
}
console.log("backlog b7 review handoff clear tests passed");
