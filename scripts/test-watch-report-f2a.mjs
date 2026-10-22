#!/usr/bin/env node
// Task F2a — the run NOTE names a failure's reason (#29) and the SNAPSHOT cell
// prints seconds for sub-minute snapshots (#31).
//
// #29: a FAILED/KILLED/INTERRUPTED row whose result.json carries
// `failure.class` shows the class in plain lower words after `session k of N`,
// appending `→ <model>` only when the NEXT run of the same role and task used a
// different model. #31: a snapshot under one minute prints `0.9s/0.5s`, from
// one minute up `m:ss`, a missing part `-`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildReportModel,
  renderImplementationStage,
  snapshotCell,
  runStatusCell,
  failureClassText,
  failureReasonText,
} from "./watch-report.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(scriptDir, ".f2a-scratch-"));
const write = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(data, null, 2)); };
const runDir = (name, status, result) => {
  const dir = path.join(root, name);
  write(path.join(dir, "status.json"), status);
  if (result) write(path.join(dir, "result.json"), result);
  return dir;
};
const run = (o) => ({ status: "completed", decision: null, findings: [], ...o });
const implModel = (runs, policy = { continuation_allowance: 5 }) => buildReportModel({
  state: { mission: "096-implement-backlog-item", phase: "implementing", step: "implement", phaseIndex: 0, attempt: 1, planningDetection: { framework: "standalone" } },
  runs,
  phases: [],
  policy,
});

try {
  // ── #29: RATE_LIMITED + a next run on another model ──────────────────────
  {
    const dir72 = runDir("72-implementer-ef459bde", {
      status: "failed", role: "implementer", phase: "4", taskRef: "T4.1", attempt: "1",
      sessionNumber: 1, configuredModel: "opencode/deepseek-v4.1-flash-free", resolvedModel: "deepseek-v4.1-flash-free",
      started_at: "2026-10-19T20:40:00+03:00",
    }, { failure: { schema: "autopilot-failure.v1", class: "RATE_LIMITED", domain: "infrastructure", retryable: false } });
    const dir73 = runDir("73-implementer-36ac7026", {
      status: "capped", role: "implementer", phase: "4", taskRef: "T4.1", attempt: "1",
      sessionNumber: 1, configuredModel: "opencode/nemotron-3-ultra-free", resolvedModel: "nemotron-3-ultra-free",
      started_at: "2026-10-19T20:42:00+03:00",
    });
    const model = implModel([
      run({ dir: dir72, id: "72-implementer-ef459bde", dirName: "72-implementer-ef459bde", role: "implementer", phase: "4", attempt: "1", taskRef: "T4.1", status: "failed", sessionNumber: 1, resolvedModel: "deepseek-v4.1-flash-free", started_at: "2026-10-19T20:40:00+03:00" }),
      run({ dir: dir73, id: "73-implementer-36ac7026", dirName: "73-implementer-36ac7026", role: "implementer", phase: "4", attempt: "1", taskRef: "T4.1", status: "capped", sessionNumber: 1, resolvedModel: "nemotron-3-ultra-free", started_at: "2026-10-19T20:42:00+03:00" }),
    ]);
    const report = renderImplementationStage(model);
    check("f2a: failed row keeps session first then the reason", report.includes("session 1 of 6 · rate limited → nemotron-3-ultra-free"), report);
    check("f2a: helper returns the arrow reason", failureReasonText(model.runs[0], model.runs) === "rate limited → nemotron-3-ultra-free", failureReasonText(model.runs[0], model.runs));
    check("f2a: capped next row has no failure reason", failureReasonText(model.runs[1], model.runs) === null, failureReasonText(model.runs[1], model.runs));
  }

  // ── #29: same model next -> no arrow ─────────────────────────────────────
  {
    const dirA = runDir("a-implementer-aaaa1111", {
      status: "failed", role: "implementer", phase: "1", taskRef: "T1.1", attempt: "1",
      sessionNumber: 1, resolvedModel: "muse", started_at: "2026-10-19T20:40:00+03:00",
    }, { failure: { class: "RATE_LIMITED" } });
    const dirB = runDir("b-implementer-bbbb2222", {
      status: "capped", role: "implementer", phase: "1", taskRef: "T1.1", attempt: "1",
      sessionNumber: 1, resolvedModel: "muse", started_at: "2026-10-19T20:42:00+03:00",
    });
    const model = implModel([
      run({ dir: dirA, id: "a-implementer-aaaa1111", dirName: "a-implementer-aaaa1111", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", status: "failed", sessionNumber: 1, resolvedModel: "muse", started_at: "2026-10-19T20:40:00+03:00" }),
      run({ dir: dirB, id: "b-implementer-bbbb2222", dirName: "b-implementer-bbbb2222", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", status: "capped", sessionNumber: 1, resolvedModel: "muse", started_at: "2026-10-19T20:42:00+03:00" }),
    ]);
    const report = renderImplementationStage(model);
    check("f2a: same-model next shows the class without an arrow", report.includes("session 1 of 6 · rate limited") && !report.includes("session 1 of 6 · rate limited →"), report);
    check("f2a: helper has no arrow for a same-model next", failureReasonText(model.runs[0], model.runs) === "rate limited", failureReasonText(model.runs[0], model.runs));
  }

  // ── #29: no failure class -> no reason text ──────────────────────────────
  {
    const dir = runDir("c-implementer-cccc3333", {
      status: "failed", role: "implementer", phase: "1", taskRef: "T1.1", attempt: "1",
      sessionNumber: 1, resolvedModel: "muse", started_at: "2026-10-19T20:40:00+03:00",
    });
    const model = implModel([
      run({ dir, id: "c-implementer-cccc3333", dirName: "c-implementer-cccc3333", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", status: "failed", sessionNumber: 1, resolvedModel: "muse", started_at: "2026-10-19T20:40:00+03:00" }),
    ]);
    check("f2a: no failure class -> no reason", failureReasonText(model.runs[0], model.runs) === null, failureReasonText(model.runs[0], model.runs));
  }

  // ── #29: class wording map + fallback ───────────────────────────────────
  check("f2a: RATE_LIMITED -> rate limited", failureClassText("RATE_LIMITED") === "rate limited", failureClassText("RATE_LIMITED"));
  check("f2a: PROVIDER_ERROR -> provider error", failureClassText("PROVIDER_ERROR") === "provider error", failureClassText("PROVIDER_ERROR"));
  check("f2a: TIMEOUT -> timed out", failureClassText("TIMEOUT") === "timed out", failureClassText("TIMEOUT"));
  check("f2a: unknown class falls back lowercased", failureClassText("SOME_UNKNOWN_CLASS") === "some unknown class", failureClassText("SOME_UNKNOWN_CLASS"));
  check("f2a: empty class is null", failureClassText(null) === null, failureClassText(null));

  // ── #29b: long status label -> bare STATUS + reason in NOTE ─────────────
  {
    const dir75 = runDir("75-implementer-9166ac99", {
      status: "running", role: "implementer", phase: "4", taskRef: "T4.1", attempt: "1",
      sessionNumber: 3, configuredModel: "opencode/nemotron-3-ultra-free", resolvedModel: "nemotron-3-ultra-free",
      started_at: "2026-10-19T20:46:36+03:00",
    });
    const model = implModel([
      run({ dir: dir75, id: "75-implementer-9166ac99", dirName: "75-implementer-9166ac99", role: "implementer", phase: "4", attempt: "1", taskRef: "T4.1", status: "interrupted (orchestrator not running)", sessionNumber: 3, resolvedModel: "nemotron-3-ultra-free", started_at: "2026-10-19T20:46:36+03:00" }),
    ]);
    const report = renderImplementationStage(model);
    const row = report.split("\n").find((l) => l.includes("75-implementer-9166ac99"));
    check("f2a: bare status cell for a long label", runStatusCell(model.runs[0]) === "INTERRUPTED", runStatusCell(model.runs[0]));
    check("f2a: reason moved to the NOTE after the session", Boolean(row && row.includes("session 3 of 6 · orchestrator not running")), row);
    check("f2a: long reason not in the STATUS cell", Boolean(row && !row.includes("ORCHESTRATOR NOT RUNNING")), row);
  }

  // ── #31: SNAPSHOT seconds ────────────────────────────────────────────────
  const base = "2026-10-19T20:40:00.000Z";
  check("f2a: sub-minute snapshot prints seconds", snapshotCell({
    snapshotBeforeStartedAt: base, snapshotBeforeAt: "2026-10-19T20:40:00.900Z",
    snapshotAfterStartedAt: base, snapshotAfterAt: "2026-10-19T20:40:00.500Z",
  }) === "0.9s/0.5s", snapshotCell({
    snapshotBeforeStartedAt: base, snapshotBeforeAt: "2026-10-19T20:40:00.900Z",
    snapshotAfterStartedAt: base, snapshotAfterAt: "2026-10-19T20:40:00.500Z",
  }));
  check("f2a: minute snapshot prints m:ss", snapshotCell({
    snapshotBeforeStartedAt: base, snapshotBeforeAt: "2026-10-19T20:41:15.000Z",
  }) === "1:15/-", snapshotCell({ snapshotBeforeStartedAt: base, snapshotBeforeAt: "2026-10-19T20:41:15.000Z" }));
  check("f2a: missing snapshot prints -", snapshotCell({}) === "-", snapshotCell({}));

  {
    const dirS = runDir("s-implementer-dddd4444", {
      status: "completed", role: "implementer", phase: "1", taskRef: "T1.1", attempt: "1",
      resolvedModel: "muse", started_at: base,
      snapshotBeforeStartedAt: base, snapshotBeforeAt: "2026-10-19T20:40:00.900Z",
      snapshotAfterStartedAt: base, snapshotAfterAt: "2026-10-19T20:40:00.500Z",
    });
    const model = implModel([
      run({ dir: dirS, id: "s-implementer-dddd4444", dirName: "s-implementer-dddd4444", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", status: "completed", resolvedModel: "muse", started_at: base }),
    ]);
    const report = renderImplementationStage(model);
    check("f2a: rendered row shows the seconds snapshot", report.includes("0.9s/0.5s"), report);
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

if (failures.length) { console.error(`${failures.length} f2a check(s) failed.`); process.exit(1); }
console.log("All f2a checks passed.");
