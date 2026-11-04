#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildReportModel,
  renderPlanningStage,
  renderImplementationStage,
  planningNote,
  implementationNote,
  enrichRun,
  readRunExtras,
} from "./watch-report.mjs";
import { readRunMeta } from "./run-history.mjs";

const failures = [];
function check(name, cond, detail) {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  }
}

// ── 1. Pure model rendering tests ───────────────────────────────────────────

// Case 1: codex plan_reviewer running, no decision -> note has no "finding"
{
  const runningReviewer = {
    id: "02-plan_reviewer-c1",
    dirName: "02-plan_reviewer",
    role: "plan_reviewer",
    model: "codex",
    status: "running",
    decision: null,
    note: "full re-check",
    taskRef: "standalone-planning-plan_reviewer",
    planRevision: 0,
    findings: [],
  };
  const model = buildReportModel({
    state: { mission: "test-m1", phase: "planning", step: "planning" },
    runs: [
      { id: "01-planner", role: "planner", status: "completed", planRevision: 0 },
      runningReviewer,
    ],
    events: [],
    phases: [],
    policy: {},
  });
  const text = renderPlanningStage(model);
  const line = text.split("\n").find((l) => l.includes("02-plan_reviewer")) || "";
  const noteVal = planningNote(runningReviewer, model);

  check("codex running: note has no finding", !noteVal.includes("finding"), { noteVal, line });
  check("codex running: line still has full re-check", line.includes("full re-check"), { line });
  check("codex running: line has no finding", !line.includes("finding"), { line });
}

// Case 2: capped without decision -> no "finding", still "full re-check"
{
  const cappedReviewer = {
    id: "02-plan_reviewer-c2",
    dirName: "02-plan_reviewer",
    role: "plan_reviewer",
    model: "codex",
    status: "capped",
    decision: null,
    note: "full re-check",
    taskRef: "standalone-planning-plan_reviewer",
    planRevision: 0,
    findings: [],
  };
  const model = buildReportModel({
    state: { mission: "test-m2", phase: "planning", step: "planning" },
    runs: [
      { id: "01-planner", role: "planner", status: "completed", planRevision: 0 },
      cappedReviewer,
    ],
    events: [],
    phases: [],
    policy: {},
  });
  const text = renderPlanningStage(model);
  const line = text.split("\n").find((l) => l.includes("02-plan_reviewer")) || "";
  const noteVal = planningNote(cappedReviewer, model);

  check("capped without decision: note has no finding", !noteVal.includes("finding"), { noteVal });
  check("capped without decision: note still has full re-check", noteVal.includes("full re-check"), { noteVal });
  check("capped without decision: line still has full re-check", line.includes("full re-check"), { line });
  check("capped without decision: line has no finding", !line.includes("finding"), { line });
}

// Case 3: FAIL with 2 findings -> "2 findings"
{
  const failedReviewer = {
    id: "02-plan_reviewer-c3",
    dirName: "02-plan_reviewer",
    role: "plan_reviewer",
    model: "codex",
    status: "completed",
    decision: "FAIL",
    note: "full re-check",
    taskRef: "standalone-planning-plan_reviewer",
    planRevision: 0,
    findings: ["Finding 1: missing requirements", "Finding 2: tests failing"],
  };
  const model = buildReportModel({
    state: { mission: "test-m3", phase: "planning", step: "planning" },
    runs: [
      { id: "01-planner", role: "planner", status: "completed", planRevision: 0 },
      failedReviewer,
    ],
    events: [],
    phases: [],
    policy: {},
  });
  const text = renderPlanningStage(model);
  const line = text.split("\n").find((l) => l.includes("02-plan_reviewer")) || "";
  const noteVal = planningNote(failedReviewer, model);

  check("FAIL with 2 findings: note has 2 findings", noteVal.includes("2 findings"), { noteVal });
  check("FAIL with 2 findings: line has 2 findings", line.includes("2 findings"), { line });
  check("FAIL with 2 findings: line has full re-check", line.includes("full re-check"), { line });
}

// Case 4: PASS with 0 -> "0 findings"
{
  const passReviewer = {
    id: "02-plan_reviewer-c4",
    dirName: "02-plan_reviewer",
    role: "plan_reviewer",
    model: "codex",
    status: "completed",
    decision: "PASS",
    note: "full re-check",
    taskRef: "standalone-planning-plan_reviewer",
    planRevision: 0,
    findings: [],
  };
  const model = buildReportModel({
    state: { mission: "test-m4", phase: "planning", step: "planning" },
    runs: [
      { id: "01-planner", role: "planner", status: "completed", planRevision: 0 },
      passReviewer,
    ],
    events: [],
    phases: [],
    policy: {},
  });
  const text = renderPlanningStage(model);
  const line = text.split("\n").find((l) => l.includes("02-plan_reviewer")) || "";
  const noteVal = planningNote(passReviewer, model);

  check("PASS with 0: note has 0 findings", noteVal.includes("0 findings"), { noteVal });
  check("PASS with 0: line has 0 findings", line.includes("0 findings"), { line });
  check("PASS with 0: line has full re-check", line.includes("full re-check"), { line });
}

// Case 5: claude reviewer rows unchanged
{
  // Claude plan_reviewer running with no decision
  const claudeRunningPlan = {
    id: "02-plan_reviewer-claude-run",
    dirName: "02-plan_reviewer",
    role: "plan_reviewer",
    model: "claude-opus-5",
    status: "running",
    decision: null,
    note: "full re-check",
    taskRef: "standalone-planning-plan_reviewer",
    planRevision: 0,
    findings: [],
  };
  const noteClaudePlanRun = planningNote(claudeRunningPlan, null);
  check("claude plan_reviewer running: no finding", !noteClaudePlanRun.includes("finding"), { noteClaudePlanRun });
  check("claude plan_reviewer running: has full re-check", noteClaudePlanRun.includes("full re-check"), { noteClaudePlanRun });

  // Claude plan_reviewer PASS with 0 findings
  const claudePassPlan = {
    id: "02-plan_reviewer-claude-pass",
    dirName: "02-plan_reviewer",
    role: "plan_reviewer",
    model: "claude-opus-5",
    status: "completed",
    decision: "PASS",
    taskRef: "standalone-planning-plan_reviewer",
    planRevision: 0,
    findings: [],
  };
  const noteClaudePlanPass = planningNote(claudePassPlan, null);
  check("claude plan_reviewer PASS: 0 findings", noteClaudePlanPass.includes("0 findings"), { noteClaudePlanPass });

  // Claude code_reviewer running in implementation phase
  const claudeRunningCR = {
    id: "05-code_reviewer-claude",
    dirName: "05-code_reviewer",
    role: "code_reviewer",
    model: "claude-opus-5.5",
    status: "running",
    decision: null,
    taskRef: "T1.1 > T1.2",
    findings: [],
  };
  const noteClaudeCRRun = implementationNote(claudeRunningCR, null);
  check("claude code_reviewer running: phase review", noteClaudeCRRun === "phase review", { noteClaudeCRRun });
  check("claude code_reviewer running: no finding text", !noteClaudeCRRun.includes("finding"), { noteClaudeCRRun });

  // Claude code_reviewer PASS in implementation phase
  const claudePassCR = {
    id: "06-code_reviewer-claude-pass",
    dirName: "06-code_reviewer",
    role: "code_reviewer",
    model: "claude-opus-5.5",
    status: "completed",
    decision: "PASS",
    taskRef: "T1.1 > T1.2",
    findings: [],
  };
  const noteClaudeCRPass = implementationNote(claudePassCR, null);
  check("claude code_reviewer PASS: phase review", noteClaudeCRPass === "phase review", { noteClaudeCRPass });
  check("claude code_reviewer PASS: no finding text", !noteClaudeCRPass.includes("finding"), { noteClaudeCRPass });

  // Claude code_reviewer FAIL with 2 findings
  const claudeFailCR = {
    id: "07-code_reviewer-claude-fail",
    dirName: "07-code_reviewer",
    role: "code_reviewer",
    model: "claude-opus-5.5",
    status: "completed",
    decision: "FAIL",
    taskRef: "T1.1 > T1.2",
    findings: ["Finding 1", "Finding 2"],
  };
  const noteClaudeCRFail = implementationNote(claudeFailCR, null);
  check("claude code_reviewer FAIL: 2 findings", noteClaudeCRFail.includes("2 findings"), { noteClaudeCRFail });
}

// ── 2. Disk enrichment tests (readRunMeta and enrichRun) ────────────────────
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "watch-report-no-verdict-"));
  try {
    // 2a. Running codex plan_reviewer dir
    const runDir1 = path.join(tmpRoot, "01-plan_reviewer-11111111");
    fs.mkdirSync(runDir1, { recursive: true });
    fs.writeFileSync(path.join(runDir1, "status.json"), JSON.stringify({
      status: "running",
      role: "plan_reviewer",
      model: "codex",
      note: "full re-check",
    }));

    const meta1 = readRunMeta(runDir1, "01-plan_reviewer-11111111");
    const enriched1 = enrichRun(meta1);
    const note1 = planningNote(enriched1, null);
    check("disk running: decision is null", enriched1.decision == null, { decision: enriched1.decision });
    check("disk running: note has no finding", !note1.includes("finding"), { note1 });
    check("disk running: note has full re-check", note1.includes("full re-check"), { note1 });

    // 2b. Capped codex plan_reviewer dir (result.verdict.decision is null)
    const runDir2 = path.join(tmpRoot, "02-plan_reviewer-22222222");
    fs.mkdirSync(runDir2, { recursive: true });
    fs.writeFileSync(path.join(runDir2, "status.json"), JSON.stringify({
      status: "capped",
      role: "plan_reviewer",
      model: "codex",
      note: "full re-check",
    }));
    fs.writeFileSync(path.join(runDir2, "result.json"), JSON.stringify({
      status: "capped",
      role: "plan_reviewer",
      verdict: { status: "not_applicable", decision: null, findings: [] },
      note: "full re-check",
    }));

    const meta2 = readRunMeta(runDir2, "02-plan_reviewer-22222222");
    const enriched2 = enrichRun(meta2);
    const note2 = planningNote(enriched2, null);
    check("disk capped: decision is null", enriched2.decision == null, { decision: enriched2.decision });
    check("disk capped: note has no finding", !note2.includes("finding"), { note2 });
    check("disk capped: note has full re-check", note2.includes("full re-check"), { note2 });

    // 2c. Completed FAIL codex plan_reviewer with 2 findings
    const runDir3 = path.join(tmpRoot, "03-plan_reviewer-33333333");
    fs.mkdirSync(runDir3, { recursive: true });
    fs.writeFileSync(path.join(runDir3, "status.json"), JSON.stringify({
      status: "completed",
      role: "plan_reviewer",
      model: "codex",
      decision: "FAIL",
    }));
    fs.writeFileSync(path.join(runDir3, "result.json"), JSON.stringify({
      status: "completed",
      role: "plan_reviewer",
      verdict: { status: "available", decision: "FAIL", findings: ["Find A", "Find B"] },
    }));

    const meta3 = readRunMeta(runDir3, "03-plan_reviewer-33333333");
    const enriched3 = enrichRun(meta3);
    const note3 = planningNote(enriched3, null);
    check("disk FAIL: decision is FAIL", enriched3.decision === "FAIL", { decision: enriched3.decision });
    check("disk FAIL: note has 2 findings", note3.includes("2 findings"), { note3 });

    // 2d. Completed PASS codex plan_reviewer with 0 findings
    const runDir4 = path.join(tmpRoot, "04-plan_reviewer-44444444");
    fs.mkdirSync(runDir4, { recursive: true });
    fs.writeFileSync(path.join(runDir4, "status.json"), JSON.stringify({
      status: "completed",
      role: "plan_reviewer",
      model: "codex",
      decision: "PASS",
    }));
    fs.writeFileSync(path.join(runDir4, "result.json"), JSON.stringify({
      status: "completed",
      role: "plan_reviewer",
      verdict: { status: "available", decision: "PASS", findings: [] },
    }));

    const meta4 = readRunMeta(runDir4, "04-plan_reviewer-44444444");
    const enriched4 = enrichRun(meta4);
    const note4 = planningNote(enriched4, null);
    check("disk PASS: decision is PASS", enriched4.decision === "PASS", { decision: enriched4.decision });
    check("disk PASS: note has 0 findings", note4.includes("0 findings"), { note4 });
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("All watch-report no-verdict findings checks passed.");
