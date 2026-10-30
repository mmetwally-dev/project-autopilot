#!/usr/bin/env node
// Backlog item 9: three watch-report/progress display gaps.
//  1. Stage must be derived at render time (STARTING when unknown, PLANNING
//     before state.phase is written) and a phase/step transition must refresh.
//  2. A pre-run run must say PREPARE (with its real start PID only) instead of
//     an early START with PID=- while the snapshot runs.
//  3. A plan-review FAIL whose findings live only on verdict.findings must
//     still show a count and the first lines in the watch summary.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import { buildReportModel, renderCurrentRun, renderPipelineState, renderReport, stageText } from "./watch-report.mjs";
import { renderWatchReport } from "./run-history.mjs";
import { initRun, setRunPreparing, prepareRun } from "./run-observability.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
};
const row = (text, needle) => String(text).split("\n").find((l) => l.includes(needle)) || "";

const tmpRoots = [];
const mkroot = (prefix) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(root);
  return root;
};

// ── 1. Stage classification at render time ─────────────────────────────────
{
  const empty = buildReportModel({ state: {}, runs: [], events: [], phases: [], policy: {}, now: "2026-10-28T00:24:12+00:00" });
  check("stage: no phase/step/run -> STARTING", empty.stage === "STARTING", empty.stage);
  check("stage: STARTING renders STARTING", /Stage:\s+STARTING/.test(renderPipelineState(empty)), row(renderPipelineState(empty), "Stage:"));
  check("stage: never renders IMPLEMENTATION when unknown", !/Stage:\s+IMPLEMENTATION/.test(renderPipelineState(empty)), row(renderPipelineState(empty), "Stage:"));

  const planning = buildReportModel({ state: { phase: "planning", step: "standalone-plan" }, runs: [], events: [], phases: [], policy: {}, now: "2026-10-28T00:24:13+00:00" });
  check("stage: phase planning -> PLANNING", planning.stage === "PLANNING", planning.stage);
  check("stage: planning renders PLANNING", /Stage:\s+PLANNING/.test(renderPipelineState(planning)), row(renderPipelineState(planning), "Stage:"));

  // state.phase can still be absent while the first planner run already exists
  // (the exact mission-start race in the report).
  const plannerRun = { id: "01-planner", dirName: "01-planner", role: "planner", status: "running", started_at: "2026-10-28T00:24:11+00:00" };
  const early = buildReportModel({ state: { phase: "idle", step: "idle" }, runs: [plannerRun], events: [], phases: [], policy: {}, now: "2026-10-28T00:24:12+00:00" });
  check("stage: latest planner run -> PLANNING before phase set", early.stage === "PLANNING", early.stage);
  check("stage: status text follows the derived stage", stageText(early) === "PLANNING", stageText(early));

  // A real transition (not an ordinary save) must call the refresh hook. Run
  // the shipped saveState body against stubs so this asserts behaviour, not
  // just source text.
  const source = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
  const block = source.match(/let lastStatePhaseStep=null;[\s\S]*?const saveState=s=>\{[\s\S]*?\n\};/);
  check("stage: saveState transition block found", Boolean(block));
  if (block) {
    const refreshes = [];
    const context = {
      read: () => JSON.stringify({ phase: "idle", step: "idle" }),
      statePath: path.join(mkroot("autopilot-save-"), "state.json"),
      atomicWriteFileSync: () => {},
      linkDetachedOrchestratorLog: () => {},
      now: () => "2026-10-28T00:24:13.000Z",
      refreshHook: (s, tag) => refreshes.push(`${s.phase}/${s.step}/${tag}`),
    };
    vm.createContext(context);
    vm.runInContext(`${block[0]}\n;globalThis.__saveState = saveState;`, context);
    context.__saveState({ phase: "idle", step: "idle", taskIndex: 1 });
    check("stage: unchanged phase/step does not re-render", refreshes.length === 0, refreshes);
    context.__saveState({ phase: "planning", step: "standalone-plan" });
    check("stage: phase change triggers one re-render", refreshes.length === 1 && refreshes[0].includes("state-transition"), refreshes);
    context.__saveState({ phase: "planning", step: "standalone-plan", taskIndex: 2 });
    check("stage: later same-phase save does not re-render again", refreshes.length === 1, refreshes);
  }
}

// ── 2. PREPARE lines before START, real PID only on START ──────────────────
{
  const dir = path.join(mkroot("autopilot-prepare-"), "01-planner");
  initRun(dir, { role: "planner", runId: "run-prepare", phase: "0", taskRef: "standalone-planning-planner", deferStart: true, last_action: "preparing: setup" });
  let status = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8"));
  check("prepare: seed status is running with no pid", status.status === "running" && status.pid === null, status);
  check("prepare: seed names the setup phase", status.last_action === "preparing: setup", status.last_action);
  check("prepare: seed writes no START line", !fs.readFileSync(path.join(dir, "progress.log"), "utf8").includes("START |"), fs.readFileSync(path.join(dir, "progress.log"), "utf8"));

  setRunPreparing(dir, "git-guard");
  status = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8"));
  check("prepare: status says preparing git-guard", status.last_action === "preparing: git-guard", status.last_action);
  prepareRun(dir, { action: "git-guard", durationMs: 1200 });

  setRunPreparing(dir, "snapshot-before");
  status = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8"));
  check("prepare: status says preparing snapshot-before before the CLI", status.last_action === "preparing: snapshot-before", status.last_action);
  prepareRun(dir, { action: "snapshot-before", detail: "fresh", durationMs: 300000 });

  initRun(dir, { pid: 43210, role: "planner", runId: "run-prepare", phase: "0", taskRef: "standalone-planning-planner", snapshotBeforeStartedAt: "2026-10-28T00:24:14+00:00", snapshotBeforeAt: "2026-10-28T00:29:14+00:00" });
  const progress = fs.readFileSync(path.join(dir, "progress.log"), "utf8").split(/\r?\n/).filter(Boolean);
  const prepares = progress.filter((l) => l.includes("PREPARE |"));
  const starts = progress.filter((l) => l.includes("START |"));
  check("prepare: two PREPARE lines precede START", prepares.length === 2 && progress.indexOf(prepares[1]) < progress.indexOf(starts[0]), progress);
  check("prepare: git-guard PREPARE line names the step and duration", prepares[0].includes("PREPARE | git-guard | DURATION="), prepares[0]);
  check("prepare: snapshot PREPARE line is fresh with its duration", prepares[1].includes("PREPARE | snapshot-before (fresh) | DURATION=00:05:00"), prepares[1]);
  check("prepare: exactly one START line", starts.length === 1, starts);
  check("prepare: START carries the real PID", /START \| ROLE=planner \| PHASE=0 \| TASK=standalone-planning-planner \| ATTEMPT=- \| PID=43210$/.test(starts[0]), starts[0]);
  status = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8"));
  check("prepare: final status has the real PID and started action", status.pid === 43210 && status.last_action === "started", status);

  // The watch report must name the preparing step instead of showing a silent
  // "running" run with pid null.
  const prepModel = buildReportModel({
    state: { phase: "planning", step: "standalone-plan" },
    runs: [{ id: "prep", dirName: "prep", role: "planner", status: "running", pid: null, last_action: "preparing: snapshot-before", started_at: "2026-10-28T00:24:14+00:00", updated_at: "2026-10-28T00:24:40+00:00" }],
    events: [], phases: [], policy: {}, now: "2026-10-28T00:25:00+00:00",
  });
  check("prepare: watch CURRENT RUN prints PREPARING snapshot-before", renderCurrentRun(prepModel).includes("PREPARING snapshot-before (no CLI process yet)"), renderCurrentRun(prepModel));
}

// ── 3. Plan-review FAIL findings from verdict.findings ─────────────────────
{
  const root = mkroot("autopilot-plan-findings-");
  const mission = "101-plan-review-fail";
  const missionDir = path.join(root, ".autopilot", "missions", mission);
  const runsDir = path.join(missionDir, "runs");
  const writeJson = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
  };
  writeJson(path.join(root, ".autopilot", "state.json"), {
    near: true, phase: "planning", step: "standalone-plan-review", mission,
    planningStartedAt: "2026-10-28T00:00:00+00:00",
  });
  writeJson(path.join(root, ".autopilot", "config.json"), { policy: {} });

  const findings = Array.from({ length: 10 }, (_, i) => `Finding ${i + 1}: the plan must name its verification command.`);
  const plannerDir = path.join(runsDir, "01-planner-aaaaaaaa");
  writeJson(path.join(plannerDir, "status.json"), {
    status: "completed", run_id: "aaaaaaaa-0000-0000-0000-000000000001", role: "planner",
    phase: "0", attempt: "0", taskRef: "standalone-planning-planner", planRevision: 0,
    started_at: "2026-10-28T00:00:00+00:00", updated_at: "2026-10-28T00:05:00+00:00", last_action: "finished",
  });
  writeJson(path.join(plannerDir, "result.json"), { role: "planner", status: "completed", decision: "PASS" });

  const reviewDir = path.join(runsDir, "02-plan_reviewer-bbbbbbbb");
  writeJson(path.join(reviewDir, "status.json"), {
    status: "completed", run_id: "bbbbbbbb-0000-0000-0000-000000000002", role: "plan_reviewer",
    phase: "0", attempt: "0", taskRef: "standalone-planning-plan_reviewer", planRevision: 0,
    started_at: "2026-10-28T00:05:00+00:00", updated_at: "2026-10-28T00:06:00+00:00", last_action: "finished",
  });
  writeJson(path.join(reviewDir, "result.json"), {
    role: "plan_reviewer", status: "completed",
    verdict: { status: "available", decision: "FAIL", findings },
    // The real failure shape: the rendered review array was empty even though
    // the verdict carried the findings.
    review: { decision: "FAIL", findings: [] },
  });
  fs.mkdirSync(missionDir, { recursive: true });
  fs.writeFileSync(path.join(missionDir, "watch-events.jsonl"), "");

  const report = renderWatchReport(root, mission, { now: "2026-10-28T00:06:01+00:00", tail: 10 });
  const reviewerRow = report.split("\n").find((l) => l.includes("02-plan_reviewer-bbbbbbbb")) || "";
  check("findings: plan-review FAIL row shows the count", reviewerRow.includes("10 findings"), reviewerRow);
  check("findings: first finding line is shown", report.includes("Finding 1: the plan must name its verification command."), report.split("\n").filter((l) => l.includes("findings →")));
  check("findings: second finding line is shown", report.includes("Finding 2: the plan must name its verification command."));
  check("findings: overflow points at result.json", report.includes("+8 more →"), report.split("\n").filter((l) => l.includes("+8 more")));
}

for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });

if (failures.length) {
  console.error(`${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("All watch-report display-gap checks passed.");
