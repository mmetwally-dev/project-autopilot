#!/usr/bin/env node
// Mission 094 Phase 1 task 1.2 — the enriched report model
// (`scripts/watch-report.mjs`). Asserts gate rows, live rows, CAPPED
// sessions, changed-files lines, `Events:` lines, stop-line classification,
// current-run detection (incl. a running gate), decoded LIVE PROGRESS and the
// model shortening + mismatch flag — for standalone, speckit and GSD fixtures.
import {
  buildReportModel,
  classifyStatus,
  buildOperatorEvents,
  buildGateEntries,
  gateStatusText,
  decodeLiveProgress,
  detectCurrent,
  parseDiffStat,
  shortenModel,
  modelDisplay,
  providerTroubleLabel,
  formatStamp,
} from "./watch-report.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
};

const run = (o) => ({ status: "completed", decision: null, findings: [], ...o });

// ── 1. standalone: gates, capped session, changed files, events ────────────
{
  const phases = [
    { number: 1, name: "Phase 1 — Foundation", done: true, tasks: [{ text: "a", done: true }] },
    { number: 2, name: "Phase 2 — Feature", done: false, tasks: [{ text: "b", done: false }] },
    { number: 3, name: "Phase 3 — Regression", done: false, tasks: [{ text: "c", done: false }] },
  ];
  const state = { mission: "094-fixture", phase: "implementing", step: "implement", phaseIndex: 1, attempt: 2, planningDetection: { framework: "standalone" } };
  const runs = [
    run({ id: "p1", role: "planner", phase: "1", attempt: "0", taskRef: "standalone-planning-planner", planRevision: 0 }),
    run({ id: "r1", role: "plan_reviewer", phase: "1", attempt: "0", taskRef: "standalone-planning-plan_reviewer", planRevision: 0, decision: "PASS" }),
    run({ id: "i1", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", resolvedModel: "claude-muse-spark-1.3" }),
    run({ id: "i2", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.2", configuredModel: "claude-opus-4-5" }),
    run({ id: "c1", role: "code_reviewer", phase: "1", attempt: "1", taskRef: "T1.1 > T1.2", decision: "PASS" }),
    run({ id: "v1", role: "verifier", phase: "1", attempt: "1", taskRef: "T1.1 > T1.2", decision: "PASS" }),
    run({ id: "i3", role: "implementer", phase: "2", attempt: "1", taskRef: "T2.1" }),
    run({ id: "i4", role: "implementer", phase: "2", attempt: "1", taskRef: "T2.3", status: "capped", sessionNumber: 1 }),
    run({ id: "v2", role: "verifier", phase: "2", attempt: "1", taskRef: "T2.1 > T2.3", decision: "FAIL", findings: ["T2.1: x"], carriedForwardTasks: ["T2.2"] }),
    run({ id: "i5", role: "implementer", phase: "2", attempt: "2", taskRef: "T2.3", status: "running", sessionNumber: 2, configuredModel: "opus", resolvedModel: "claude-sonnet-4-5", modelMismatch: true, note: "ProviderHeaderTimeout" }),
  ];
  const stat1 = " scripts/relay-guards.mjs | 15 +++++++++++---\n 1 file changed, 12 insertions(+), 3 deletions(-)";
  const stat2 = " scripts/autopilot.mjs | 20 +++++-----\n 1 file changed, 10 insertions(+), 10 deletions(-)";
  const events = [
    { type: "operator", reason: "stop", scope: "mission", at: "2026-09-29T01:30:12+03:00" },
    { type: "operator", reason: "resume", scope: "mission", at: "2026-09-29T01:34:40+03:00" },
    { type: "operator", reason: "reset", scope: "plan-revision", at: "2026-09-29T01:35:00+03:00" },
    { type: "operator", reason: "rebase", scope: "phase-checkpoint", note: "hand-fix", at: "2026-09-29T01:36:00+03:00" },
    { type: "gate_start", phase: 1, command: null, durationMs: null, ok: null, at: "2026-09-29T00:16:00+03:00" },
    { type: "gate_progress", phase: 1, command: "node scripts/test-all.mjs --skip-live", durationMs: 135000, ok: true, passed: 204, total: 204, failed: 0, at: "2026-09-29T00:16:10+03:00" },
    { type: "gate_result", phase: 1, command: null, durationMs: 135000, ok: true, at: "2026-09-29T00:16:30+03:00" },
    { type: "diff_stat", phase: 1, attempt: 1, taskRef: "T1.2", stat: stat1, at: "2026-09-29T00:16:31+03:00" },
    { type: "gate_start", phase: 2, command: null, durationMs: null, ok: null, at: "2026-09-29T01:22:00+03:00" },
    { type: "gate_progress", phase: 2, command: "node scripts/test-all.mjs --skip-live", durationMs: 125000, ok: true, passed: 204, total: 204, failed: 0, at: "2026-09-29T01:22:10+03:00" },
    { type: "gate_result", phase: 2, command: null, durationMs: 125000, ok: true, at: "2026-09-29T01:22:55+03:00" },
    { type: "diff_stat", phase: 2, attempt: 2, taskRef: null, stat: stat2, at: "2026-09-29T01:22:56+03:00" },
    { type: "prep", role: "implementer", phase: 2, taskRef: "T2.3", attempt: 2, at: "2026-09-29T01:41:55+03:00" },
    { type: "start", role: "implementer", phase: 2, taskRef: "T2.3", attempt: 2, pid: 81234, at: "2026-09-29T01:44:02+03:00" },
    { type: "warn", text: "⚠ ProviderHeaderTimeout (transient, opencode retrying)", at: "2026-09-29T01:45:02+03:00" },
  ];
  const model = buildReportModel({ state, runs, events, phases, policy: { continuation_allowance: 5 } });

  // gate rows
  check("standalone: 2 gate rows", model.gates.length === 2, model.gates.length);
  check("standalone: gate 1 PASS", gateStatusText(model.gates[0]) === "PASS", gateStatusText(model.gates[0]));
  check("standalone: gate 1 command", model.gates[0].command === "node scripts/test-all.mjs --skip-live", model.gates[0].command);
  check("standalone: gate 1 progress", model.gates[0].progress.passed === 204 && model.gates[0].progress.total === 204, model.gates[0].progress);
  check("standalone: gate 2 mapped to attempt 1 by start", model.gates[1].attempt === 1, model.gates[1].attempt);
  check("standalone: phase1 carries its gate", model.phases[0].gates.length === 1 && model.phases[0].attempts[0].gates.length === 1);

  // changed files (rule 13)
  check("standalone: phase1 changed-files text", model.phases[0].attempts[0].changedFilesText === "changed files → scripts/relay-guards.mjs +12/−3 (1 file)", model.phases[0].attempts[0].changedFilesText);
  check("standalone: changed files parsed", model.changedFiles.length === 2 && model.changedFiles[0].fileCount === 1, model.changedFiles.length);

  // No synthesized PENDING rows (rule 4).
  check("standalone: no pending rows", model.phases[1].attempts[1].pending === undefined, model.phases[1].attempts[1].pending);

  // CAPPED + session k of N
  const capped = model.phases[1].attempts[0].runs.find((r) => r.id === "i4");
  check("standalone: capped session label", capped.sessionLabel === "session 1 of 6", capped.sessionLabel);
  check("standalone: running session label", model.runs.find((r) => r.id === "i5").sessionLabel === "session 2 of 6");

  // Events line (rule 12)
  check("standalone: 4 operator events", model.operatorEvents.length === 4, model.operatorEvents.length);
  check("standalone: events line stop/resume", model.eventsLine.startsWith("STOPPED 2026-09-29 01:30:12 (ap stop) → RESUMED 2026-09-29 01:34:40 (ap run)"), model.eventsLine);
  check("standalone: events line reset label", model.eventsLine.includes("operator reset plan revision counter"), model.eventsLine);
  check("standalone: events line rebase", model.eventsLine.includes("operator rebase phase checkpoint — hand-fix"), model.eventsLine);

  // status + current run
  check("standalone: status RUNNING", model.status === "RUNNING" && model.stopLine === null, model.status);
  check("standalone: current is running implementer", model.current && model.current.kind === "run" && model.current.role === "implementer", model.current);
  check("standalone: current taskRef T2.3", model.current.taskRef === "T2.3", model.current.taskRef);

  // model shortening + mismatch
  check("standalone: mismatch display", model.runs.find((r) => r.id === "i5").displayModel === "opus→sonnet-4.5 !", model.runs.find((r) => r.id === "i5").displayModel);
  check("standalone: resolved display", model.runs.find((r) => r.id === "i1").displayModel === "muse-spark-1.3", model.runs.find((r) => r.id === "i1").displayModel);
  check("standalone: configured-until-resolved display", model.runs.find((r) => r.id === "i2").displayModel === "opus-4.5", model.runs.find((r) => r.id === "i2").displayModel);
  check("standalone: current model display", model.current.model === "opus→sonnet-4.5 !", model.current.model);

  // provider trouble + live progress
  check("standalone: provider trouble on run", model.providerTrouble.length === 1 && model.providerTrouble[0].label === "ProviderHeaderTimeout", model.providerTrouble);
  const kinds = model.liveProgress.map((l) => l.kind);
  check("standalone: live PREP/START/WARN decoded", kinds.includes("PREP") && kinds.includes("START") && kinds.includes("WARN"), kinds);
  check("standalone: live GATE decoded", kinds.includes("GATE"), kinds);
  check("standalone: live progress has no raw JSON", model.liveProgress.every((l) => !l.text.startsWith("{")), model.liveProgress.map((l) => l.text));
}

// ── 2. speckit: completed stop line ─────────────────────────────────────────
{
  const phases = [
    { number: 1, name: "Phase 1 — Foundation", done: true, tasks: [{ text: "T001", done: true }] },
    { number: 2, name: "Phase 2 — Wiring", done: false, tasks: [{ text: "T002", done: false }] },
  ];
  const state = { mission: "010-speckit", phase: "complete", step: "done", phaseIndex: 1, attempt: 1, planningDetection: { framework: "speckit" } };
  const runs = [
    run({ id: "si", role: "implementer", phase: "1", attempt: "1", taskRef: "T001" }),
    run({ id: "sv", role: "verifier", phase: "1", attempt: "1", taskRef: "T001", decision: "PASS" }),
  ];
  const model = buildReportModel({ state, runs, events: [], phases });
  check("speckit: framework", model.framework === "speckit", model.framework);
  check("speckit: status COMPLETED", model.status === "COMPLETED", model.status);
  check("speckit: stop line COMPLETED", model.stopLine === "COMPLETED", model.stopLine);
  check("speckit: no current run", model.current === null, model.current);
  check("speckit: no gates", model.gates.length === 0 && model.phases[0].gates.length === 0);
}

// ── 3. GSD: no events, no crash, final review separated ─────────────────────
{
  const phases = [{ index: 0, name: "01-foundation" }, { index: 1, name: "02-feature" }];
  const state = { mission: "011-gsd", phase: "implementing", step: "implement", phaseIndex: 0, attempt: 1, planningDetection: { framework: "gsd" } };
  const runs = [
    run({ id: "gi", role: "implementer", phase: "1", attempt: "1", taskRef: "T1" }),
    run({ id: "gv", role: "verifier", phase: "1", attempt: "1", taskRef: "T1", decision: "PASS" }),
    run({ id: "gf", role: "code_reviewer", phase: null, attempt: "1", taskRef: null, decision: "PASS" }),
  ];
  const model = buildReportModel({ state, runs, events: [], phases });
  check("gsd: framework", model.framework === "gsd", model.framework);
  check("gsd: phase1 passed", model.phases[0].status === "passed", model.phases[0].status);
  check("gsd: final review separated", model.finalReview.runs.length === 1 && model.finalReview.runs[0].id === "gf");
  check("gsd: empty changed files / pending", model.changedFiles.length === 0 && model.phases[0].attempts[0].pending === undefined);
  check("gsd: events line null", model.eventsLine === null, model.eventsLine);
}

// ── 4. stop-line states ─────────────────────────────────────────────────────
{
  const idle = classifyStatus({ mission: "m", phase: "idle" }, { operatorEvents: [] });
  check("stop: idle -> STOPPED", idle.status === "STOPPED" && idle.stopLine.startsWith("STOPPED"), idle);

  const stoppedEvents = buildOperatorEvents([{ type: "operator", reason: "stop", scope: "mission", at: "2026-09-29T01:30:12+03:00" }]);
  const stopped = classifyStatus({ mission: "m", phase: "implementing" }, { operatorEvents: stoppedEvents });
  check("stop: operator stop -> STOPPED", stopped.status === "STOPPED" && stopped.stopLine.includes("2026-09-29 01:30:12"), stopped);

  const cancelled = classifyStatus({ mission: "m", phase: "cancelled", lastCancelled: { mission: "m", at: "2026-09-29T02:00:00+03:00", reason: "operator abort" } });
  check("stop: cancelled with reason", cancelled.status === "CANCELLED" && cancelled.stopLine === "CANCELLED at 2026-09-29 02:00:00 — reason: operator abort", cancelled.stopLine);

  const notCarried = classifyStatus({ mission: "new-mission", phase: "cancelled", lastCancelled: { mission: "old-mission", at: "2026-09-29T02:00:00+03:00", reason: "old" } });
  check("stop: cancel not carried across missions", notCarried.status === "CANCELLED" && notCarried.at === null && notCarried.stopLine === "CANCELLED", notCarried);

  const escalated = classifyStatus({ mission: "m", phase: "escalated", step: "standalone_task_no_progress", lastContinuation: { at: "2026-09-29T03:00:00+03:00" }, lastFailure: { code: "NO_PROGRESS" } });
  check("stop: escalated line", escalated.status === "ESCALATED" && escalated.stopLine.includes("standalone_task_no_progress") && escalated.stopLine.includes("human intervention required"), escalated.stopLine);

  // escalation / cancellation suppress CURRENT even with a stale running run
  const staleRun = run({ id: "x", role: "implementer", phase: "1", attempt: "1", taskRef: "T1", status: "running" });
  const escModel = buildReportModel({ state: { mission: "m", phase: "escalated", step: "x", phaseIndex: 0 }, runs: [staleRun], events: [], phases: [{ number: 1, name: "P1" }] });
  check("stop: no current after escalation", escModel.current === null, escModel.current);
}

// ── 5. GATE-running current run ─────────────────────────────────────────────
{
  const phases = [{ number: 1, name: "Phase 1 — Foundation", done: true, tasks: [{ text: "a", done: true }] }];
  const state = { mission: "094-gate", phase: "implementing", step: "gate", phaseIndex: 0, attempt: 1, planningDetection: { framework: "standalone" } };
  const runs = [
    run({ id: "i1", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1" }),
    run({ id: "c1", role: "code_reviewer", phase: "1", attempt: "1", taskRef: "T1.1", decision: "PASS" }),
  ];
  const events = [
    { type: "gate_start", phase: 1, command: null, durationMs: null, ok: null, at: "2026-09-29T02:01:10+03:00" },
    { type: "gate_progress", phase: 1, command: "node scripts/test-all.mjs --skip-live", durationMs: 1000, ok: true, passed: 96, total: 204, failed: 0, at: "2026-09-29T02:08:52+03:00" },
  ];
  const model = buildReportModel({ state, runs, events, phases });
  check("gate-current: current is the gate", model.current && model.current.kind === "gate", model.current);
  check("gate-current: command", model.current.command === "node scripts/test-all.mjs --skip-live", model.current.command);
  check("gate-current: progress", model.current.progress.passed === 96 && model.current.progress.total === 204, model.current.progress);
  const gateLines = model.liveProgress.filter((l) => l.kind === "GATE");
  check("gate-current: live GATE lines", gateLines.length === 2 && gateLines[1].text.includes("96/204 runs"), gateLines.map((l) => l.text));
}

// ── 6. helpers ──────────────────────────────────────────────────────────────
{
  check("helper: shortenModel claude-opus-4-5", shortenModel("claude-opus-4-5") === "opus-4.5", shortenModel("claude-opus-4-5"));
  check("helper: shortenModel provider prefix", shortenModel("opencode/deepseek-v4.1-flash-free") === "deepseek-v4.1-flash-free", shortenModel("opencode/deepseek-v4.1-flash-free"));
  check("helper: shortenModel dated", shortenModel("claude-sonnet-4-5-20250929") === "sonnet-4.5", shortenModel("claude-sonnet-4-5-20250929"));
  check("helper: modelDisplay mismatch", modelDisplay({ configuredModel: "opus", resolvedModel: "claude-sonnet-4-5", modelMismatch: true }) === "opus→sonnet-4.5 !");
  check("helper: modelDisplay until resolved", modelDisplay({ configuredModel: "claude-opus-4-5", resolvedModel: null }) === "opus-4.5");
  check("helper: formatStamp offset", formatStamp("2026-09-29T01:48:22+03:00") === "2026-09-29 01:48:22", formatStamp("2026-09-29T01:48:22+03:00"));
  check("helper: providerTrouble rate limit", providerTroubleLabel("AI_APICallError: Rate limit exceeded.") === "Rate limit exceeded");
  check("helper: providerTrouble none", providerTroubleLabel("the model wrote: Rate limit exceeded") === "Rate limit exceeded");

  const parsed = parseDiffStat(" scripts/a.mjs | 5 +++--\n scripts/b.mjs | 3 +--\n 2 files changed, 6 insertions(+), 2 deletions(-)");
  check("helper: parseDiffStat files", parsed.files.length === 2 && parsed.fileCount === 2, parsed);
  check("helper: parseDiffStat split", parsed.files[0].added === 3 && parsed.files[0].removed === 2, parsed.files[0]);
  check("helper: parseDiffStat summary", parsed.insertions === 6 && parsed.deletions === 2, parsed);
  check("helper: parseDiffStat empty", parseDiffStat("").text === null && parseDiffStat(null).files.length === 0);
}

if (failures.length) { console.error(`${failures.length} model-enrich check(s) failed.`); process.exit(1); }
console.log("All model-enrich checks passed.");
