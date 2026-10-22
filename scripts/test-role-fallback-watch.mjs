#!/usr/bin/env node
// Mission 087 task 2.3: WATCH-REPORT shows the model actually used per run.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readRunMeta,
  modelCellText,
  renderWatchReport,
} from "./run-history.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-role-fallback-watch-"));
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const runsDir = path.join(root, ".autopilot", "runs");

// Primary-model run: status.json carries the model actually used.
const primary = path.join(runsDir, "01-implementer-aaaa0001");
write(path.join(primary, "status.json"), JSON.stringify({
  status: "completed", run_id: "aaaa0001-0000-0000-0000-000000000001",
  started_at: "2026-08-20T10:00:00", updated_at: "2026-08-20T10:05:00",
  role: "implementer", exit_code: 0, duration: "00:05:00", model: "primary-model",
}, null, 2));
write(path.join(primary, "result.json"), JSON.stringify({
  status: "completed", role: "implementer", model: "primary-model",
}, null, 2));

// Fallback-model run: status.json carries the fallback model actually used.
const fallback = path.join(runsDir, "02-implementer-bbbb0002");
write(path.join(fallback, "status.json"), JSON.stringify({
  status: "completed", run_id: "bbbb0002-0000-0000-0000-000000000002",
  started_at: "2026-08-20T11:00:00", updated_at: "2026-08-20T11:05:00",
  role: "implementer", exit_code: 0, duration: "00:05:00", model: "fallback-one",
}, null, 2));
write(path.join(fallback, "result.json"), JSON.stringify({
  status: "completed", role: "implementer", model: "fallback-one",
}, null, 2));

// Result-only fallback run: status.json predates the field, result.json carries it.
const resultOnly = path.join(runsDir, "03-implementer-cccc0003");
write(path.join(resultOnly, "status.json"), JSON.stringify({
  status: "completed", run_id: "cccc0003-0000-0000-0000-000000000003",
  started_at: "2026-08-20T12:00:00", updated_at: "2026-08-20T12:05:00",
  role: "implementer", exit_code: 0, duration: "00:05:00",
}, null, 2));
write(path.join(resultOnly, "result.json"), JSON.stringify({
  status: "completed", role: "implementer", model: "fallback-two",
}, null, 2));

const pm = readRunMeta(primary, "01-implementer-aaaa0001");
assert.equal(pm.model, "primary-model", "readRunMeta must surface model from status.json");
assert.equal(modelCellText(pm), "primary-model", "model cell shows the primary model");

const fm = readRunMeta(fallback, "02-implementer-bbbb0002");
assert.equal(fm.model, "fallback-one", "readRunMeta must surface the fallback model from status.json");
assert.equal(modelCellText(fm), "fallback-one", "model cell shows the fallback model");

const rm = readRunMeta(resultOnly, "03-implementer-cccc0003");
assert.equal(rm.model, "fallback-two", "readRunMeta must fall back to result.json model");
assert.equal(modelCellText(rm), "fallback-two", "model cell shows the result.json fallback model");

assert.equal(modelCellText({}), "-", "runs without a model render -");

// Full watch report (094 layout): every run's actually-used model is visible.
const report = renderWatchReport(root, null);
assert.ok(report.includes("MODEL"), "watch report table must show the MODEL column");
assert.ok(report.includes("primary-model"), "watch shows the model actually used");
assert.ok(report.includes("fallback-one"), "a fallback run shows the fallback model");
assert.ok(report.includes("fallback-two"), "a result.json-fallback run shows its model");

fs.rmSync(root, { recursive: true, force: true });
console.log("test-role-fallback-watch: all cases passed");
