#!/usr/bin/env node
// Mission 094 Phase 1 task 1.4 — IMPLEMENTATION STAGE + FINAL REVIEW STAGE
// renderers (`scripts/watch-report.mjs`). The standalone fixture mirrors the
// watcher.md "## Example" mission 021 so the golden fragments can be asserted
// verbatim; a speckit and a GSD fixture prove the sections render without
// either framework crashing. Asserts the per-phase ✓/●/○ blocks, per-attempt
// tables (result/findings/carried-forward/changed-files), live rows, CAPPED
// "session k of N", GATE (orchestrator) rows, the `›` running marker (no
// `<- CURRENT`), the NOTE-column `⚠ high usage` and provider-trouble marks, and
// that the final review is named FINAL REVIEW (never `Phase N`) with its own
// `Total:` entry.
import {
  buildReportModel,
  renderReport,
  renderImplementationStage,
  renderFinalReviewStage,
  formatCellTokens,
} from "./watch-report.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
};

const run = (o) => ({ status: "completed", decision: null, findings: [], ...o });
const bar = (p, m) => "+".repeat(p) + "-".repeat(m);

// ── 1. the watcher.md Example (mission 021) ─────────────────────────────────
{
  const phases = [
    { number: 1, name: "Phase 1 — Reproduce and locate", done: true, tasks: [{ text: "T1.1", done: true }, { text: "T1.2", done: true }] },
    { number: 2, name: "Phase 2 — Narrow the fingerprint exclusion", done: false, tasks: [{ text: "T2.1", done: false }, { text: "T2.2", done: false }, { text: "T2.3", done: false }] },
    { number: 3, name: "Phase 3 — Regression test and suite green", done: false, tasks: [{ text: "T3.1", done: false }] },
  ];
  const state = {
    mission: "021-fix-backlog-item", phase: "implementing", step: "implement", phaseIndex: 1, attempt: 2,
    planningStartedAt: "2026-09-28T23:38:26+03:00",
    failureBudgets: { "verificationFailureBudget:task:T2.1": 1 },
    planningDetection: { framework: "standalone" },
  };
  const runs = [
    run({ id: "06-implementer-359c6a9c", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", resolvedModel: "claude-muse-spark-1.3", duration: "00:02:42", duration_ms: 162000, snapshot: "2:08/1:04", started_at: "2026-09-29T00:02:45+03:00", usage: { priceWeighted: 41500, turns: 6, peakContext: 22600 } }),
    run({ id: "07-implementer-87e03524", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.2", resolvedModel: "claude-muse-spark-1.3", duration: "00:03:40", duration_ms: 220000, snapshot: "2:10/1:06", started_at: "2026-09-29T00:07:39+03:00", usage: { priceWeighted: 49300, turns: 11, peakContext: 25300 } }),
    run({ id: "08-code_reviewer-6676a8bb", role: "code_reviewer", phase: "1", attempt: "1", taskRef: "T1.1 > T1.2", decision: "PASS", resolvedModel: "claude-opus-5-5", duration: "00:02:30", duration_ms: 150000, snapshot: "2:07/1:01", started_at: "2026-09-29T00:13:56+03:00", usage: { priceWeighted: 28700, turns: 3, peakContext: 21900 } }),
    run({ id: "09-verifier-7e64e556", role: "verifier", phase: "1", attempt: "1", taskRef: "T1.1 > T1.2", decision: "PASS", resolvedModel: "claude-nemotron-3", duration: "00:12:09", duration_ms: 729000, snapshot: "2:09/1:03", started_at: "2026-09-29T00:18:53+03:00", usage: { priceWeighted: 373400, turns: 24, peakContext: 58700 } }),
    run({ id: "10-implementer-7f2a91e0", role: "implementer", phase: "2", attempt: "1", taskRef: "T2.1", resolvedModel: "claude-muse-spark-1.3", duration: "00:02:48", duration_ms: 168000, snapshot: "2:06/1:02", started_at: "2026-09-29T00:33:21+03:00", usage: { priceWeighted: 32500, turns: 5, peakContext: 20400 } }),
    run({ id: "11-implementer-2aa8b5d5", role: "implementer", phase: "2", attempt: "1", taskRef: "T2.2", resolvedModel: "claude-muse-spark-1.3", duration: "00:02:38", duration_ms: 158000, snapshot: "2:04/1:03", started_at: "2026-09-29T00:38:29+03:00", usage: { priceWeighted: 39500, turns: 5, peakContext: 23100 } }),
    run({ id: "12-implementer-2568334a", role: "implementer", phase: "2", attempt: "1", taskRef: "T2.3", status: "capped", cap: { used: 23, limit: 22 }, sessionNumber: 1, resolvedModel: "claude-muse-spark-1.3", duration: "00:21:40", duration_ms: 1300000, snapshot: "2:05/1:04", started_at: "2026-09-29T00:43:24+03:00", usage: { priceWeighted: 338600, turns: 23, peakContext: 61800 } }),
    run({ id: "13-implementer-a1cd16ee", role: "implementer", phase: "2", attempt: "1", taskRef: "T2.3", sessionNumber: 2, resolvedModel: "claude-muse-spark-1.3", duration: "00:07:25", duration_ms: 445000, snapshot: "2:07/1:01", started_at: "2026-09-29T01:10:01+03:00", usage: { priceWeighted: 121500, turns: 15, peakContext: 44500 } }),
    run({ id: "14-code_reviewer-79d5d0d4", role: "code_reviewer", phase: "2", attempt: "1", taskRef: "T2.1 > T2.3", decision: "PASS", resolvedModel: "claude-opus-5-5", duration: "00:02:46", duration_ms: 166000, snapshot: "2:03/1:02", started_at: "2026-09-29T01:20:04+03:00", usage: { priceWeighted: 36500, turns: 2, peakContext: 24000 } }),
    run({ id: "15-verifier-bd5860b5", role: "verifier", phase: "2", attempt: "1", taskRef: "T2.1 > T2.3", decision: "FAIL", resolvedModel: "claude-nemotron-3", duration: "00:08:12", duration_ms: 492000, snapshot: "2:08/1:05", started_at: "2026-09-29T01:25:06+03:00", note: "⚠ read refused /tmp/opencode/…", findings: ["T2.3: timing fixture lacks top-level node_modules/.next/.autopilot", "T2.1: pathspec ':!(.autopilot/**)' excludes nothing"], carriedForwardTasks: ["T2.2"], usage: { priceWeighted: 142000, turns: 14, peakContext: 47200 } }),
    run({ id: "16-implementer-3ebe846e", role: "implementer", phase: "2", attempt: "2", taskRef: "T2.1", resolvedModel: "claude-muse-spark-1.3", duration: "00:03:03", duration_ms: 183000, snapshot: "2:05/1:03", started_at: "2026-09-29T01:36:40+03:00", note: "fixed finding 2", usage: { priceWeighted: 38300, turns: 8, peakContext: 19700 } }),
    run({ id: "17-implementer-db4d1811", role: "implementer", phase: "2", attempt: "2", taskRef: "T2.3", status: "running", sessionNumber: 1, resolvedModel: "claude-muse-spark-1.3", duration: "00:06:35", snapshotBeforeAt: "2026-09-29T01:44:02+03:00", started_at: "2026-09-29T01:41:55+03:00", note: "finding 1", usage: { priceWeighted: 52000, turns: 9, peakContext: 27300 } }),
  ];
  const events = [
    { type: "gate_start", phase: 1, at: "2026-09-29T00:16:00+03:00" },
    { type: "gate_progress", phase: 1, command: "node scripts/test-all.mjs --skip-live", passed: 204, total: 204, failed: 0, durationMs: 135000, at: "2026-09-29T00:16:10+03:00" },
    { type: "gate_result", phase: 1, ok: true, durationMs: 135000, at: "2026-09-29T00:16:30+03:00" },
    { type: "diff_stat", phase: 1, attempt: 1, stat: ` scripts/relay-guards.mjs | 15 ${bar(11, 3)}\n scripts/test-relay-guards.mjs | 31 ${bar(29, 2)}\n 2 files changed, 41 insertions(+), 5 deletions(-)`, at: "2026-09-29T00:16:31+03:00" },
    { type: "gate_start", phase: 2, at: "2026-09-29T01:22:00+03:00" },
    { type: "gate_progress", phase: 2, command: "node scripts/test-all.mjs --skip-live", passed: 204, total: 204, failed: 0, durationMs: 125000, at: "2026-09-29T01:22:10+03:00" },
    { type: "gate_result", phase: 2, ok: true, durationMs: 125000, at: "2026-09-29T01:22:55+03:00" },
    { type: "diff_stat", phase: 2, attempt: 1, stat: ` scripts/relay-guards.mjs | 24 ${bar(18, 6)}\n scripts/fingerprint.mjs | 8 ${bar(7, 1)}\n 2 files changed, 25 insertions(+), 7 deletions(-)`, at: "2026-09-29T01:22:56+03:00" },
    { type: "operator", reason: "stop", scope: "mission", at: "2026-09-29T01:30:12+03:00" },
    { type: "operator", reason: "resume", scope: "mission", at: "2026-09-29T01:34:40+03:00" },
  ];
  const policy = {
    max_plan_revisions: 8, final_review_fix_rounds: 2, continuation_allowance: 5,
    failure_budgets: { implementationFailureBudget: 3, verificationFailureBudget: 3, adapterRetryBudget: 2, infrastructureRetryBudget: 2 },
    caps: { planner: { max_tokens: 750000 }, plan_reviewer: { max_tokens: 300000 }, implementer: { max_tokens: 500000 }, code_reviewer: { max_tokens: 300000 }, verifier: { max_tokens: 500000 } },
  };
  const model = buildReportModel({ state, runs, events, phases, policy, now: "2026-09-29T01:48:30+03:00" });
  const report = renderReport(model, { stamp: "2026-09-29 01:48:30" });
  const stage = renderImplementationStage(model);
  const has = (name, frag) => check(`example: ${name}`, report.includes(frag), frag);

  has("implementation section", "=== IMPLEMENTATION STAGE ===");
  has("phase1 passed header", "  Phase 1/3 — Reproduce and locate  ✓ PASSED · 492.9K · 00:21:01");
  has("phase2 in-progress header", "  Phase 2/3 — Narrow the fingerprint exclusion  ● IN PROGRESS (attempt 2 of 4) · 800.9K so far");
  has("attempt 1 denied header", "    Attempt 1  ✗ DENIED by verifier · 710.6K");
  has("attempt 2 in-progress header", "    Attempt 2  ● IN PROGRESS (after verifier DENIED · verification budget 1/3) · 90.3K so far");
  // Backlog #7: a phase that has not started renders nothing - no header at all.
  check("example: no not-started phase header", !report.includes("○ NOT STARTED"), report.split("\n").find((l) => l.includes("NOT STARTED")));
  check("example: phase 3 absent", !report.includes("Phase 3/3 — Regression test"), report);

  has("implementer row", "06-implementer-359c6a9c    muse-spark-1.3  T1.1         COMPLETED  00:02:42  2:08/1:04  41.5K   22.6K    6      2026-09-29 00:02:45");
  has("phase review row", "08-code_reviewer-6676a8bb  opus-5.5        T1.1 > T1.2  APPROVED   00:02:30  2:07/1:01  28.7K   21.9K    3      2026-09-29 00:13:56  phase review");
  has("gate row", "GATE (orchestrator)        -               T1.1 > T1.2  PASS       00:02:15  -          -       -        -      2026-09-29 00:16:00  full test suite (node scripts/test-all.mjs --skip-live) · 204/204 runs passed");
  has("verifier row", "09-verifier-7e64e556       nemotron-3      T1.1 > T1.2  APPROVED   00:12:09  2:09/1:03  373.4K  58.7K    24     2026-09-29 00:18:53  phase verify · ⚠ high usage (373.4K of 500K cap)");

  has("capped status", "CAPPED (23/22)");
  has("capped session note", "session 1 of 6");
  has("capped second session", "session 2 of 6");
  has("findings line 1", "        findings → 1. T2.3: timing fixture lacks top-level node_modules/.next/.autopilot");
  has("findings line 2 aligned", `${" ".repeat(19)}2. T2.1: pathspec ':!(.autopilot/**)' excludes nothing`);
  has("carried forward annotation", "        carried forward → T2.2 (not named by the findings)");
  check("no carried-forward row", !report.includes("CARRIED FORWARD"));
  has("verifier findings + note", "phase verify · 2 findings · ⚠ read refused /tmp/opencode/…");

  check("no PENDING rows", !report.includes("PENDING"));
  has("running note", "finding 1 · session 1 of 6");

  // running marker `›` in the left margin, no `<- CURRENT` anywhere (rule 9)
  const runningLine = report.split("\n").find((l) => l.includes("17-implementer-db4d1811"));
  check("example: running marker", runningLine && runningLine.startsWith("    › 17-implementer-db4d1811"), runningLine);
  check("example: no <- CURRENT marker", !report.includes("<- CURRENT"));
  check("example: no raw JSON", !/\{\s*"/.test(report), report);
  check("example: no trailing whitespace", report.split("\n").every((l) => l === l.replace(/\s+$/, "")));

  // Backlog #9: one `next:` line under the running phase's table, one blank
  // line before and after it.
  has("next line", "next: phase review → full test suite → phase verify");
  has("next line layout", "\n\n      next: phase review → full test suite → phase verify\n");

  // Backlog #7: FINAL REVIEW renders nothing until it starts (never a
  // `○ NOT STARTED` placeholder, never numbered as a phase).
  check("example: final review absent", !report.includes("=== FINAL REVIEW STAGE ==="), report.split("\n").find((l) => l.includes("FINAL REVIEW")));
  check("example: renderImplementationStage alone", stage.startsWith("=== IMPLEMENTATION STAGE ===") && !stage.includes("PIPELINE STATE"), stage.split("\n")[0]);
  check("example: renderFinalReviewStage alone empty", renderFinalReviewStage(model) === "", renderFinalReviewStage(model));
}

// ── 2. speckit: provider-trouble ⚠ in the NOTE column ───────────────────────
{
  const phases = [
    { number: 1, name: "Phase 1 — Foundation", done: true, tasks: [{ text: "T001", done: true }] },
    { number: 2, name: "Phase 2 — Wiring", done: false, tasks: [{ text: "T002", done: false }] },
  ];
  const state = { mission: "010-speckit", phase: "implementing", step: "implement", phaseIndex: 0, attempt: 1, planningDetection: { framework: "speckit" } };
  const runs = [
    run({ id: "01-implementer-sp01", role: "implementer", phase: "1", attempt: "1", taskRef: "T001", resolvedModel: "claude-sonnet-4-5", duration_ms: 120000, started_at: "2026-09-28T23:00:00+03:00", note: "ProviderHeaderTimeout", usage: { priceWeighted: 10000, turns: 4, peakContext: 9000 } }),
    run({ id: "02-verifier-sp02", role: "verifier", phase: "1", attempt: "1", taskRef: "T001", decision: "PASS", resolvedModel: "claude-sonnet-4-5", duration_ms: 60000, started_at: "2026-09-28T23:02:00+03:00", usage: { priceWeighted: 5000, turns: 2, peakContext: 4000 } }),
  ];
  const model = buildReportModel({ state, runs, events: [], phases, policy: { caps: { implementer: { max_tokens: 500000 }, verifier: { max_tokens: 500000 } } } });
  const report = renderReport(model, { stamp: "2026-09-29 00:10:00" });
  check("speckit: implementation stage", report.includes("=== IMPLEMENTATION STAGE ==="), report);
  check("speckit: phase1 passed", report.includes("  Phase 1/2 — Foundation  ✓ PASSED"), report);
  check("speckit: no not-started phase header", !report.includes("○ NOT STARTED"), report);
  check("speckit: phase2 absent", !report.includes("Phase 2/2 — Wiring"), report);
  check("speckit: provider trouble NOTE mark", report.includes("⚠ ProviderHeaderTimeout"), report);
  check("speckit: final review absent", !report.includes("=== FINAL REVIEW STAGE ==="), report);
  check("speckit: no raw JSON", !/\{\s*"/.test(report));
}

// ── 3. GSD: per-phase blocks, no crash, final review named FINAL REVIEW ─────
{
  const phases = [{ index: 0, name: "01-foundation" }, { index: 1, name: "02-feature" }];
  const state = { mission: "011-gsd", phase: "planning", step: "plan", phaseIndex: 0, attempt: 1, planningDetection: { framework: "gsd" } };
  const model = buildReportModel({ state, runs: [], events: [], phases, policy: {} });
  const report = renderReport(model, { stamp: "2026-09-29 00:00:00" });
  // Backlog #7: while planning, nothing has started - no IMPLEMENTATION or
  // FINAL REVIEW section, no `○ NOT STARTED` phase header.
  check("gsd: no implementation stage", !report.includes("=== IMPLEMENTATION STAGE ==="), report);
  check("gsd: no final review stage", !report.includes("=== FINAL REVIEW STAGE ==="), report);
  check("gsd: no not-started phase header", !report.includes("○ NOT STARTED"), report);
  check("gsd: no phase header", !report.includes("01-foundation"), report);
  check("gsd: only the pipeline state renders", report.startsWith("===") && !report.includes("STAGE ===  ○"), report);
  check("gsd: no raw JSON", !/\{\s*"/.test(report));
}

// ── 4. final review: its own FINAL REVIEW block + Total: entry ──────────────
{
  const phases = [
    { number: 1, name: "Phase 1 — Reproduce and locate", done: true, tasks: [{ text: "T1.1", done: true }] },
    { number: 2, name: "Phase 2 — Narrow the fingerprint exclusion", done: true, tasks: [{ text: "T2.1", done: true }, { text: "T2.2", done: true }, { text: "T2.3", done: true }] },
    { number: 3, name: "Phase 3 — Regression test and suite green", done: true, tasks: [{ text: "T3.1", done: true }, { text: "T3.2", done: true }] },
  ];
  const impl = [
    run({ id: "06-implementer-359c6a9c", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", resolvedModel: "claude-muse-spark-1.3", duration: "00:02:42", duration_ms: 162000, snapshot: "2:08/1:04", started_at: "2026-09-29T00:02:45+03:00", usage: { priceWeighted: 41500, turns: 6, peakContext: 22600 } }),
    run({ id: "20-implementer-359c6a9d", role: "implementer", phase: "3", attempt: "1", taskRef: "T3.2", resolvedModel: "claude-muse-spark-1.3", duration: "00:02:42", duration_ms: 162000, snapshot: "2:08/1:04", started_at: "2026-09-29T00:52:45+03:00", usage: { priceWeighted: 41500, turns: 6, peakContext: 22600 } }),
  ];
  const review = [
    run({ id: "31-code_reviewer-5a1e90c2", role: "code_reviewer", phase: null, attempt: null, taskRef: null, decision: "FAIL", resolvedModel: "claude-opus-5-5", duration: "00:03:12", duration_ms: 192000, snapshot: "2:06/1:02", started_at: "2026-09-29T03:12:35+03:00", findings: ["scripts/relay-guards.mjs — fingerprint exclusion misses refs/notes"], usage: { priceWeighted: 62100, turns: 6, peakContext: 30400 } }),
    run({ id: "32-implementer-0c7d3e19", role: "implementer", phase: null, attempt: null, taskRef: null, resolvedModel: "claude-muse-spark-1.3", duration: "00:04:01", duration_ms: 241000, snapshot: "2:09/1:04", started_at: "2026-09-29T03:16:02+03:00", note: "fixed 1 of 1 finding", usage: { priceWeighted: 88600, turns: 12, peakContext: 31700 } }),
    run({ id: "33-code_reviewer-91b4f6aa", role: "code_reviewer", phase: null, attempt: null, taskRef: null, decision: "PASS", resolvedModel: "claude-opus-5-5", duration: "00:02:47", duration_ms: 167000, snapshot: "2:05/1:01", started_at: "2026-09-29T03:28:53+03:00", usage: { priceWeighted: 117700, turns: 5, peakContext: 33000 } }),
  ];
  const events = [
    { type: "gate_start", phase: null, at: "2026-09-29T03:20:00+03:00" },
    { type: "gate_progress", phase: null, passed: 204, total: 204, failed: 0, durationMs: 140000, at: "2026-09-29T03:20:05+03:00" },
    { type: "gate_result", phase: null, ok: true, durationMs: 140000, at: "2026-09-29T03:20:10+03:00" },
    { type: "diff_stat", phase: null, attempt: null, stat: ` scripts/relay-guards.mjs | 5 ${bar(4, 1)}\n 1 file changed, 4 insertions(+), 1 deletion(-)`, at: "2026-09-29T03:20:11+03:00" },
  ];
  const policy = { final_review_fix_rounds: 2, caps: { implementer: { max_tokens: 500000 }, code_reviewer: { max_tokens: 300000 } } };
  const model = buildReportModel({
    state: { mission: "021-fix-backlog-item", phase: "final_review", step: "final_review", phaseIndex: 2, attempt: 1, planningStartedAt: "2026-09-28T23:38:26+03:00", planningDetection: { framework: "standalone" } },
    runs: [...impl, ...review], events, phases, policy, now: "2026-09-29T03:31:40+03:00",
  });
  const report = renderReport(model, { stamp: "2026-09-29 03:31:40" });
  const has = (name, frag) => check(`final: ${name}`, report.includes(frag), frag);

  has("result line", "=== FINAL REVIEW STAGE ===  ✓ PASSED at 2026-09-29 03:31:40 · 268.4K · 00:19:05 (fix rounds 1 of 2)");
  has("round 1", "  Round 1");
  has("denied review row", "31-code_reviewer-5a1e90c2  opus-5.5  T1.1 > T3.2  DENIED");
  check("finding line hidden after approval", !report.includes("fingerprint exclusion misses refs/notes"), report.includes("fingerprint exclusion misses refs/notes"));
  has("fix round header", "  Fix round 1 of 2");
  has("fix implementer row", "32-implementer-0c7d3e19");
  has("fix implementer note", "fixed 1 of 1 finding");
  has("fix gate row", "GATE (orchestrator)      -               T1.1 > T3.2  PASS       00:02:20  -          -      -        -      2026-09-29 03:20:00  full test suite · 204/204 runs passed");
  has("round 2", "  Round 2");
  has("pass review row", "33-code_reviewer-91b4f6aa  opus-5.5  T1.1 > T3.2  APPROVED");
  has("pass review note", "final review · 0 findings");

  // rule 16: named FINAL REVIEW, never `Phase N`, own `Total:` entry
  check("final: never Phase-numbered", report.includes("=== FINAL REVIEW STAGE ===") && !report.includes("=== Phase 4"));
  check("final: own Total entry", report.includes("final review 268.4K"), report.split("\n").find((l) => l.startsWith("Total:")));
  check("final: stage line FINAL REVIEW", /^Stage:\s+FINAL REVIEW · fix round 1 of 2$/m.test(report), report.split("\n").find((l) => l.startsWith("Stage:")));
  const frIdx = report.indexOf("=== FINAL REVIEW STAGE ===");
  check("final: review runs after the section header", frIdx > 0 && report.indexOf("31-code_reviewer-5a1e90c2") > frIdx, frIdx);
  check("final: no <- CURRENT marker", !report.includes("<- CURRENT"));
}

// ── 5. helpers ──────────────────────────────────────────────────────────────
{
  check("formatCellTokens 24000 -> 24.0K", formatCellTokens(24000) === "24.0K", formatCellTokens(24000));
  check("formatCellTokens 52000 -> 52.0K", formatCellTokens(52000) === "52.0K", formatCellTokens(52000));
  check("formatCellTokens 142000 -> 142.0K", formatCellTokens(142000) === "142.0K", formatCellTokens(142000));
  check("formatCellTokens 373400 -> 373.4K", formatCellTokens(373400) === "373.4K", formatCellTokens(373400));
  check("formatCellTokens small", formatCellTokens(9) === "9", formatCellTokens(9));
  check("formatCellTokens null", formatCellTokens(null) === "-", formatCellTokens(null));
}

if (failures.length) { console.error(`${failures.length} render-impl check(s) failed.`); process.exit(1); }
console.log("All render-impl checks passed.");
