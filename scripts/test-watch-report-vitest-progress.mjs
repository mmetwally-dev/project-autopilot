#!/usr/bin/env node
// Backlog #9: live per-file progress for vitest / jest gates in CURRENT RUN.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildReportModel,
  detectCurrent,
  parseVitestGateLog,
  parseGateLogProgress,
  renderCurrentRun,
  renderReport,
} from "./watch-report.mjs";
import {
  findPreviousGateExpected,
  gateLogLabel,
  readGateLogTail,
  renderWatchReport,
} from "./run-history.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures.push(name);
    console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`);
  }
};

const lines = (text) => String(text).split("\n");
const row = (text, needle) => lines(text).find((l) => l.includes(needle)) || "";

// ── 1. parseVitestGateLog: pure parser unit checks with ANSI fixtures ────────
{
  check("null log returns null", parseVitestGateLog(null) === null);
  check("empty log returns null", parseVitestGateLog("") === null);
  check("unrelated text returns null", parseVitestGateLog("Compiling TypeScript...\nBuild finished in 1.2s\n") === null);

  // ANSI colored vitest line with nested per-test lines
  const ansiNestedLog = [
    "\x1b[32m ✓ \x1b[39m\x1b[2mpackages/db/src/shop-orders.restore-sql.test.ts\x1b[22m \x1b[2m(\x1b[22m\x1b[32m3 tests\x1b[39m\x1b[2m)\x1b[22m \x1b[33m18192ms\x1b[39m",
    "   \x1b[32m✓\x1b[39m \x1b[2mrestore shop database\x1b[22m \x1b[33m120ms\x1b[39m",
    "   \x1b[32m✓\x1b[39m \x1b[2mverify schema integrity\x1b[22m \x1b[33m85ms\x1b[39m",
    "   \x1b[32m✓\x1b[39m \x1b[2mseed default records\x1b[22m \x1b[33m200ms\x1b[39m",
    "\x1b[31m × \x1b[39m\x1b[2mpackages/api/src/auth.test.ts\x1b[22m \x1b[2m(\x1b[22m\x1b[31m1 test | 1 failed\x1b[39m\x1b[2m)\x1b[22m \x1b[33m450ms\x1b[39m",
    "   \x1b[31m×\x1b[39m \x1b[2mjwt authentication expired token\x1b[22m",
    "\x1b[33m ↓ \x1b[39m\x1b[2mpackages/legacy/src/old.test.ts\x1b[22m \x1b[2m(\x1b[22m\x1b[33m5 tests\x1b[39m\x1b[2m)\x1b[22m",
  ].join("\n");

  const parsed = parseVitestGateLog(ansiNestedLog);
  check("nested lines not counted: done is 3", parsed?.done === 3, parsed);
  check("passed count is 1", parsed?.passed === 1, parsed);
  check("failed count is 1", parsed?.failed === 1, parsed);
  check("skipped count is 1", parsed?.skipped === 1, parsed);
  check("lastFile is the skipped file", parsed?.lastFile === "packages/legacy/src/old.test.ts", parsed);
  check("lastMark is ↓", parsed?.lastMark === "↓", parsed);
  check("lastTests is 5", parsed?.lastTests === 5, parsed);
  check("failedFiles includes auth.test.ts", parsed?.failedFiles?.length === 1 && parsed.failedFiles[0] === "packages/api/src/auth.test.ts", parsed);
  check("summary is null while running", parsed?.summary === null, parsed);

  // ❯ marker for failures
  const arrowFailLog = " ❯ packages/core/src/fail-arrow.test.ts (2 tests | 1 failed) 300ms";
  const arrowParsed = parseVitestGateLog(arrowFailLog);
  check("arrow failure counted as failed", arrowParsed?.failed === 1 && arrowParsed?.done === 1, arrowParsed);
  check("arrow failure added to failedFiles", arrowParsed?.failedFiles?.includes("packages/core/src/fail-arrow.test.ts"), arrowParsed);
  check("arrow failure mark is ×", arrowParsed?.lastMark === "×", arrowParsed);

  // Jest PASS/FAIL log
  const jestLog = [
    "PASS src/user.test.js (4.2s)",
    "FAIL src/billing.test.js (1.5s)",
    "PASS src/report.test.js (2.1s)",
  ].join("\n");
  const jestParsed = parseVitestGateLog(jestLog);
  check("jest PASS/FAIL: done is 3", jestParsed?.done === 3, jestParsed);
  check("jest PASS/FAIL: passed is 2", jestParsed?.passed === 2, jestParsed);
  check("jest PASS/FAIL: failed is 1", jestParsed?.failed === 1, jestParsed);
  check("jest PASS/FAIL: failedFiles is billing", jestParsed?.failedFiles?.[0] === "src/billing.test.js", jestParsed);
  check("jest PASS/FAIL: lastFile is report.test.js", jestParsed?.lastFile === "src/report.test.js", jestParsed);
  check("jest PASS/FAIL: lastMark is PASS", jestParsed?.lastMark === "PASS", jestParsed);

  // Finished summary
  const summaryLog = [
    ansiNestedLog,
    "",
    "Test Files  183 passed | 5 skipped (188)",
    "Tests  1749 passed | 20 skipped (1769)",
  ].join("\n");
  const finishedParsed = parseVitestGateLog(summaryLog);
  check("summary files total parsed", finishedParsed?.summary?.files?.total === 188, finishedParsed);
  check("summary files passed parsed", finishedParsed?.summary?.files?.passed === 183, finishedParsed);
  check("summary files skipped parsed", finishedParsed?.summary?.files?.skipped === 5, finishedParsed);
  check("summary files failed parsed", finishedParsed?.summary?.files?.failed === 0, finishedParsed);
  check("summary tests total parsed", finishedParsed?.summary?.tests?.total === 1769, finishedParsed);
  check("summary tests passed parsed", finishedParsed?.summary?.tests?.passed === 1749, finishedParsed);
  check("summary tests skipped parsed", finishedParsed?.summary?.tests?.skipped === 20, finishedParsed);

  // Real failing vitest gate log (real app) with ANSI codes
  const realAppFailingLog = [
    "\x1b[31m ❯ \x1b[39m\x1b[2mpackages/db/src/shop-orders.restore-sql.test.ts\x1b[22m \x1b[2m(\x1b[22m\x1b[31m3 tests | 3 failed\x1b[39m\x1b[2m)\x1b[22m \x1b[33m56ms\x1b[39m",
    "\x1b[32m ✓ \x1b[39m\x1b[2mapps/web/src/a.test.tsx\x1b[22m \x1b[2m(\x1b[22m\x1b[32m21 tests\x1b[39m\x1b[2m)\x1b[22m \x1b[33m2733ms\x1b[39m",
    "...",
    "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯",
    " FAIL  packages/db/src/shop-orders.restore-sql.test.ts > restore migration … > NEGATIVE: a deleted line aborts",
    " ❯ withTempSchema packages/db/src/shop-orders.restore-sql.test.ts:193:20",
    " ❯ packages/db/src/shop-orders.restore-sql.test.ts:219:5",
    " FAIL  packages/db/src/shop-orders.restore-sql.test.ts > restore migration … > POSITIVE control",
  ].join("\n");
  const realAppParsed = parseVitestGateLog(realAppFailingLog);
  check("real-app log: done=2", realAppParsed?.done === 2, realAppParsed);
  check("real-app log: failed=1", realAppParsed?.failed === 1, realAppParsed);
  check("real-app log: passed=1", realAppParsed?.passed === 1, realAppParsed);
  check("real-app log: failedFiles has one file", JSON.stringify(realAppParsed?.failedFiles) === JSON.stringify(["packages/db/src/shop-orders.restore-sql.test.ts"]), realAppParsed?.failedFiles);
}

// ── 2. Real renderer: mid-run WITH previous total ────────────────────────────
{
  const logLines = [];
  for (let i = 1; i <= 110; i++) {
    logLines.push(` ✓ packages/pkg/src/test-${i}.test.ts (2 tests) 10ms`);
  }
  logLines.push(" × packages/api/src/auth.test.ts (1 test | 1 failed) 450ms");
  logLines.push(" ↓ packages/legacy/src/skip.test.ts (1 test) 5ms");
  logLines.push(" ✓ packages/db/src/shop-orders.restore-sql.test.ts (12 tests) 18192ms");
  const log = logLines.join("\n");

  const model = buildReportModel({
    state: { phase: "implementing", step: "gate", phaseIndex: 9, attempt: 1 },
    runs: [],
    phases: [{ number: 10, name: "Phase 10", done: false, tasks: [{ text: "T10.1" }] }],
    policy: {},
    events: [{ type: "gate_start", phase: 10, command: "npx vitest run", at: "2026-11-07T10:00:00+00:00" }],
    gateLog: log,
    expectedGateTotal: 188,
    expectedGateLabel: "phase 10 attempt 14",
    now: "2026-11-07T10:05:00+00:00",
  });

  const text = renderCurrentRun(model);
  check("with previous total: progress line", text.includes("progress: 113/~188 test files · 111 passed · 1 failed · 1 skipped"), row(text, "progress:"));
  check("with previous total: note line", text.includes("(~188 = total from the last gate, phase 10 attempt 14)"), text);
  check("with previous total: note line indented", row(text, "(~188").startsWith("          (~188"));
  check("with previous total: last line", text.includes("last: ✓ packages/db/src/shop-orders.restore-sql.test.ts (12 tests)"), row(text, "last:"));
  check("with previous total: last line indented", row(text, "last:").startsWith("          last:"));
  check("with previous total: failed line", text.includes("failed: × packages/api/src/auth.test.ts"), row(text, "failed:"));
  check("with previous total: failed line indented", row(text, "failed:").startsWith("          failed:"));
}

// ── 3. Real renderer: mid-run WITHOUT previous total (first gate) ────────────
{
  const log = [
    " ✓ packages/db/src/first.test.ts (10 tests) 100ms",
    " × packages/api/src/bad.test.ts (1 test | 1 failed) 200ms",
    " ↓ packages/legacy/src/skip.test.ts (1 test)",
  ].join("\n");

  const model = buildReportModel({
    state: { phase: "implementing", step: "gate", phaseIndex: 0, attempt: 1 },
    runs: [],
    phases: [{ number: 1, name: "Phase 1", done: false, tasks: [{ text: "T1.1" }] }],
    policy: {},
    events: [{ type: "gate_start", phase: 1, command: "npx vitest run", at: "2026-11-07T10:00:00+00:00" }],
    gateLog: log,
    now: "2026-11-07T10:02:00+00:00",
  });

  const text = renderCurrentRun(model);
  check("no previous total: progress line", text.includes("progress: 3 test files done · 1 passed · 1 failed · 1 skipped (total unknown yet)"), row(text, "progress:"));
  check("no previous total: no ~ total note", !text.includes("total from the last gate"), text);
  check("no previous total: last line", text.includes("last: ↓ packages/legacy/src/skip.test.ts (1 test)"), row(text, "last:"));
  check("no previous total: failed line", text.includes("failed: × packages/api/src/bad.test.ts"), row(text, "failed:"));
}

// ── 4. Failures cap at 5 ─────────────────────────────────────────────────────
{
  const logLines = [];
  for (let i = 1; i <= 8; i++) {
    logLines.push(` × packages/api/src/bad-${i}.test.ts (1 test) 50ms`);
  }
  const log = logLines.join("\n");

  const model = buildReportModel({
    state: { phase: "implementing", step: "gate", phaseIndex: 0, attempt: 1 },
    runs: [],
    phases: [{ number: 1, name: "Phase 1", done: false, tasks: [{ text: "T1.1" }] }],
    policy: {},
    events: [{ type: "gate_start", phase: 1, command: "npx vitest run", at: "2026-11-07T10:00:00+00:00" }],
    gateLog: log,
    now: "2026-11-07T10:02:00+00:00",
  });

  const text = renderCurrentRun(model);
  const failedRows = lines(text).filter((l) => l.trimStart().startsWith("failed:"));
  check("failed lines capped at 5", failedRows.length === 5, failedRows.length);
  check("first 5 failed files rendered", text.includes("failed: × packages/api/src/bad-1.test.ts") && text.includes("failed: × packages/api/src/bad-5.test.ts"));
  check("6th failed file not rendered", !text.includes("failed: × packages/api/src/bad-6.test.ts"));
}

// ── 5. Finished summary rendering ───────────────────────────────────────────
{
  const log = [
    "Test Files  183 passed | 5 skipped (188)",
    "Tests  1749 passed | 20 skipped (1769)",
  ].join("\n");

  const model = buildReportModel({
    state: { phase: "implementing", step: "gate", phaseIndex: 9, attempt: 1 },
    runs: [],
    phases: [{ number: 10, name: "Phase 10", done: false, tasks: [{ text: "T10.1" }] }],
    policy: {},
    events: [{ type: "gate_start", phase: 10, command: "npx vitest run", at: "2026-11-07T10:00:00+00:00" }],
    gateLog: log,
    now: "2026-11-07T10:05:00+00:00",
  });

  const text = renderCurrentRun(model);
  check("finished summary: progress line", text.includes("progress: 188/188 test files · 183 passed · 0 failed · 5 skipped"), row(text, "progress:"));
  check("finished summary: tests line", text.includes("tests: 1749 passed · 20 skipped (1769)"), row(text, "tests:"));
  check("finished summary: tests line indented", row(text, "tests:").startsWith("          tests:"));
}

// ── 6. Jest PASS/FAIL rendering ─────────────────────────────────────────────
{
  const log = [
    "PASS src/app.test.js",
    "FAIL src/api.test.js",
  ].join("\n");

  const model = buildReportModel({
    state: { phase: "implementing", step: "gate", phaseIndex: 0, attempt: 1 },
    runs: [],
    phases: [{ number: 1, name: "Phase 1", done: false, tasks: [{ text: "T1.1" }] }],
    policy: {},
    events: [{ type: "gate_start", phase: 1, command: "jest", at: "2026-11-07T10:00:00+00:00" }],
    gateLog: log,
    now: "2026-11-07T10:02:00+00:00",
  });

  const text = renderCurrentRun(model);
  check("jest: progress line", text.includes("progress: 2 test files done · 1 passed · 1 failed · 0 skipped (total unknown yet)"), row(text, "progress:"));
  check("jest: failed line", text.includes("failed: × src/api.test.js"), row(text, "failed:"));
  check("jest: last line shows mark", text.includes("last: × src/api.test.js"), row(text, "last:"));
}

// ── 7. Never print 0/0 ──────────────────────────────────────────────────────
{
  // A gate running with no log output yet
  const model = buildReportModel({
    state: { phase: "implementing", step: "gate", phaseIndex: 0, attempt: 1 },
    runs: [],
    phases: [{ number: 1, name: "Phase 1", done: false, tasks: [{ text: "T1.1" }] }],
    policy: {},
    events: [{ type: "gate_start", phase: 1, command: "npx vitest run", at: "2026-11-07T10:00:00+00:00" }],
    gateLog: "",
    now: "2026-11-07T10:01:00+00:00",
  });

  const text = renderCurrentRun(model);
  check("never print 0/0: no 0/0 runs or files", !text.includes("0/0"), text);
}

// ── 8. test-all [n/total] log still renders the old line ────────────────────
{
  const log = [
    "PASS     0.3s  test-a.mjs  [71/365]",
    "PASS     0.4s  test-b.mjs  [72/365]",
    "TEST FAILED: test-broken.mjs  [73/365]",
  ].join("\n");

  const model = buildReportModel({
    state: { phase: "implementing", step: "gate", phaseIndex: 0, attempt: 1 },
    runs: [],
    phases: [{ number: 1, name: "Phase 1", done: false, tasks: [{ text: "T1.1" }] }],
    policy: {},
    events: [{ type: "gate_start", phase: 1, command: "node scripts/test-all.mjs", at: "2026-10-19T10:00:00+00:00" }],
    gateLog: log,
    now: "2026-10-19T10:05:00+00:00",
  });

  const text = renderCurrentRun(model);
  check("test-all [n/total] keeps old progress line", text.includes("progress: 73/365 files · 72 passed · 1 failed"), row(text, "progress:"));
  check("test-all does not render vitest note line", !text.includes("total from the last gate"), text);
}

// ── 9. Temp mission dir with two gate logs for previous-total lookup ────────
{
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-vitest-prev-"));
  const missionDir = path.join(tmpRepo, ".autopilot", "missions", "002");
  const gatesDir = path.join(missionDir, "gates");
  fs.mkdirSync(gatesDir, { recursive: true });

  // Finished previous gate log: phase 10 attempt 14
  const prevLog = [
    " ✓ packages/db/src/a.test.ts (3 tests)",
    "Test Files  183 passed | 5 skipped (188)",
    "Tests  1749 passed | 20 skipped (1769)",
  ].join("\n");
  const prevFile = path.join(gatesDir, "phase-10-attempt-14.log");
  fs.writeFileSync(prevFile, prevLog, "utf8");
  // Set older mtime
  const tOld = new Date("2026-11-07T09:00:00Z");
  fs.utimesSync(prevFile, tOld, tOld);

  // Open gate log: phase 11 attempt 1 (mid-run, newer mtime)
  const openLog = [
    " ✓ packages/db/src/shop-orders.restore-sql.test.ts (12 tests) 18192ms",
    " × packages/api/src/auth.test.ts (1 test | 1 failed) 450ms",
  ].join("\n");
  const openFile = path.join(gatesDir, "phase-11-attempt-1.log");
  fs.writeFileSync(openFile, openLog, "utf8");
  const tNew = new Date("2026-11-07T10:00:00Z");
  fs.utimesSync(openFile, tNew, tNew);

  // Test findPreviousGateExpected helper directly
  const prevExpected = findPreviousGateExpected(tmpRepo, "002", 11);
  check("lookup finds previous total 188", prevExpected?.total === 188, prevExpected);
  check("lookup derives label phase 10 attempt 14", prevExpected?.label === "phase 10 attempt 14", prevExpected);

  // Write state.json and watch-events.jsonl so renderMissionReport can exercise it end-to-end
  fs.writeFileSync(path.join(tmpRepo, ".autopilot", "state.json"), JSON.stringify({
    mission: "002",
    phase: "implementing",
    step: "gate",
    phaseIndex: 10,
    attempt: 1,
  }));
  const events = [
    JSON.stringify({ type: "gate_start", phase: 11, command: "npx vitest run", at: "2026-11-07T10:00:00+00:00" }),
  ].join("\n") + "\n";
  fs.writeFileSync(path.join(missionDir, "watch-events.jsonl"), events);

  const report = renderWatchReport(tmpRepo, "002", { now: "2026-11-07T10:05:00+00:00" });
  check("e2e report carries previous total note", report.includes("(~188 = total from the last gate, phase 10 attempt 14)"), report);
  check("e2e report carries mid-run progress", report.includes("progress: 2/~188 test files · 1 passed · 1 failed · 0 skipped"), report);
  check("e2e report carries last file", report.includes("last: × packages/api/src/auth.test.ts (1 test)"), report);
  check("e2e report carries failed file", report.includes("failed: × packages/api/src/auth.test.ts"), report);

  // Clean up
  fs.rmSync(tmpRepo, { recursive: true, force: true });
}

// ── Final verdict ────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\n${failures.length} vitest progress check(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll vitest progress watch-report checks passed.");
}
