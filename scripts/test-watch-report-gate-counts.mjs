#!/usr/bin/env node
// Backlog #10: gate row counts (vitest + test-all) and count sourcing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildGateEntries, gateRow, parseGateCountsFromLog } from "./watch-report.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = path.join(__dirname, ".tmp-gate-counts");

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
};

// Temp dir under scripts/ (never /tmp), removed at the end.
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
fs.mkdirSync(tmpRoot, { recursive: true });

const vitestPassLog = path.join(tmpRoot, "vitest-pass.log");
const vitestPassText = [
  "Test Files  350 passed | 5 skipped (355)",
  "Tests  3410 passed | 20 skipped (3430)",
].join("\n");
fs.writeFileSync(vitestPassLog, vitestPassText, "utf8");

const vitestFailLog = path.join(tmpRoot, "vitest-fail.log");
const vitestFailText = [
  "Test Files  1 failed | 349 passed (350)",
  "Tests  6 failed | 3404 passed (3410)",
].join("\n");
fs.writeFileSync(vitestFailLog, vitestFailText, "utf8");

const testAllLog = path.join(tmpRoot, "test-all.log");
const testAllText = [
  "PASS foo.mjs [10/20]",
  "TEST FAILED: x.mjs [11/20]",
].join("\n");
fs.writeFileSync(testAllLog, testAllText, "utf8");

// 1. parseGateCountsFromLog direct
{
  const c = parseGateCountsFromLog(vitestPassText);
  check("parse vitest pass style", c?.style === "vitest", c);
  check("parse vitest pass tests passed", c?.tests?.passed === 3410, c);
  check("parse vitest pass tests total", c?.tests?.total === 3430, c);
  check("parse vitest pass files passed", c?.files?.passed === 350, c);
  check("parse vitest pass files total", c?.files?.total === 355, c);

  const cf = parseGateCountsFromLog(vitestFailText);
  check("parse vitest fail tests failed", cf?.tests?.failed === 6, cf);
  check("parse vitest fail files failed", cf?.files?.failed === 1, cf);

  const ca = parseGateCountsFromLog(testAllText);
  check("parse test-all style", ca?.style === "test-all", ca);
  check("parse test-all total", ca?.files?.total === 20, ca);
}

// 2. vitest PASS gate log -> gate row note
{
  const gate = { status: "completed", ok: true, command: "npm test", progress: { total: null, passed: null, failed: null }, counts: null, logFile: vitestPassLog, at: "2026-01-01T00:00:00Z" };
  const row = gateRow(gate, {}, null);
  check("vitest pass note has tests passed", row.note.includes("3410/3430 tests passed"), row.note);
  check("vitest pass note has files", row.note.includes("350/355 files"), row.note);
}

// 3. vitest FAIL gate log -> contains '6 failed', not 'passed' verdict
{
  const gate = { status: "completed", ok: false, command: "npm test", progress: { total: null, passed: null, failed: null }, counts: null, logFile: vitestFailLog, at: "2026-01-01T00:00:00Z" };
  const row = gateRow(gate, {}, null);
  check("vitest fail note has 6 failed", row.note.includes("6 failed"), row.note);
  check("vitest fail note no passed", !row.note.includes("passed"), row.note);
}

// 4. test-all style log -> 'runs'
{
  const gate = { status: "completed", ok: false, command: "node scripts/test-all.mjs", progress: { total: null, passed: null, failed: null }, counts: null, logFile: testAllLog, at: "2026-01-01T00:00:00Z" };
  const row = gateRow(gate, {}, null);
  check("test-all note has runs", row.note.includes("runs"), row.note);
}

// 5. gate_result event WITH counts -> used without reading a log
{
  const events = [
    { type: "gate_start", phase: 1, command: "npm test", at: "2026-01-01T00:00:00Z" },
    { type: "gate_result", phase: 1, command: "npm test", durationMs: 1000, ok: true, at: "2026-01-01T00:01:00Z", counts: { style: "vitest", files: { passed: 350, failed: 0, skipped: 5, total: 355 }, tests: { passed: 3410, failed: 0, skipped: 20, total: 3430 } } },
  ];
  const gates = buildGateEntries(events);
  check("with-counts: one gate", gates.length === 1, gates.length);
  const g = gates[0];
  check("with-counts: counts present", !!g.counts, g);
  check("with-counts: no logFile", g.logFile == null, g.logFile);
  const row = gateRow(g, {}, null);
  check("with-counts: note tests", row.note.includes("3410/3430 tests passed"), row.note);
}

// 6. event WITHOUT counts + existing log file -> counts parsed from file
{
  const events = [
    { type: "gate_start", phase: 1, command: "npm test", at: "2026-01-01T00:00:00Z", logFile: vitestPassLog },
    { type: "gate_result", phase: 1, command: "npm test", durationMs: 1000, ok: true, at: "2026-01-01T00:01:00Z", logFile: vitestPassLog },
  ];
  const gates = buildGateEntries(events);
  check("no-counts+log: one gate", gates.length === 1, gates.length);
  const g = gates[0];
  check("no-counts+log: logFile present", g.logFile === vitestPassLog, g.logFile);
  check("no-counts+log: counts null in entry", g.counts == null, g.counts);
  const row = gateRow(g, {}, null);
  check("no-counts+log: note tests", row.note.includes("3410/3430 tests passed"), row.note);
}

// 7. event without counts and no log -> no -/- and no counts
{
  const events = [
    { type: "gate_start", phase: 1, command: "npm test", at: "2026-01-01T00:00:00Z" },
    { type: "gate_result", phase: 1, command: "npm test", durationMs: 1000, ok: true, at: "2026-01-01T00:01:00Z" },
  ];
  const gates = buildGateEntries(events);
  const g = gates[0];
  const row = gateRow(g, {}, null);
  check("no-counts no-log: no -/-", !row.note.includes("-/-"), row.note);
  check("no-counts no-log: no counts", !/passed|runs|failed/.test(row.note), row.note);
}

// cleanup
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

if (failures.length) {
  console.error(`\n${failures.length} gate-counts check(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll gate-counts watch-report checks passed.");
}
