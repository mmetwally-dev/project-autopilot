// Backlog #99: a run left "running" by a dead orchestrator is DISPLAYED as
// interrupted (orchestrator not running); readers never modify run files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { displayStatus, displayStatusLabel, statusCellText, detectCurrentRun, renderWatchReport, annotateOwnerLiveness, staleRunningNote, STALE_RUNNING_LABEL } from "./run-history.mjs";

const dead = () => false, live = () => true;
const run = (extra = {}) => ({ status: "running", pid: 4242, ...extra });

// running + dead pid + dead owner -> interrupted label
assert.equal(displayStatus(run({ ownerAlive: false }), { isAlive: dead }), "interrupted");
assert.equal(displayStatusLabel(run({ ownerAlive: false }), { isAlive: dead }), STALE_RUNNING_LABEL);
// running + live pid -> running
assert.equal(displayStatus(run({ ownerAlive: false }), { isAlive: live }), "running");
// running + dead run pid + live owner (between roles) -> running
assert.equal(displayStatus(run({ ownerAlive: true }), { isAlive: dead }), "running");
// no pid recorded + dead owner -> interrupted; unknown liveness stays running
assert.equal(displayStatus(run({ pid: null, ownerAlive: false }), { isAlive: () => null }), "interrupted");
assert.equal(displayStatus(run({ pid: null }), { isAlive: () => null }), "running");
// never CURRENT
assert.equal(detectCurrentRun([run({ ownerAlive: false, pid: 2147483646 })]), null);
// annotate: injectable owner reader/liveness
const rs = annotateOwnerLiveness("/x", [run()], { readOwner: () => ({ pid: 7 }), isOwnerAlive: dead });
assert.equal(rs[0].ownerAlive, false);
assert.equal(annotateOwnerLiveness("/x", [run()], { readOwner: () => null })[0].ownerAlive, undefined);
// other-platform owner file -> liveness unknown, never labelled interrupted
const otherPlat = process.platform === "win32" ? "linux" : "win32";
const xr = annotateOwnerLiveness("/x", [run()], { readOwner: () => ({ pid: 7, platform: otherPlat }), isOwnerAlive: dead });
assert.equal(xr[0].ownerAlive, undefined);
assert.notEqual(displayStatus(xr[0], { isAlive: () => null }), "interrupted");

// renderer + files unchanged
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "stale-run-"));
const rd = path.join(repo, ".autopilot", "runs", "01-implementer-aaaaaaaa");
fs.mkdirSync(rd, { recursive: true });
const statusFile = path.join(rd, "status.json");
fs.writeFileSync(statusFile, JSON.stringify({ id: "aaaaaaaa", status: "running", role: "implementer", pid: 2147483646, started_at: "2026-08-15T10:00:00+00:00", updated_at: "2026-08-15T10:00:00+00:00" }));
fs.writeFileSync(path.join(repo, ".autopilot", "owner.pid"), JSON.stringify({ pid: 2147483645 }));
const before = fs.readFileSync(statusFile, "utf8");
const mtime = fs.statSync(statusFile).mtimeMs;
const report = renderWatchReport(repo, null, { isOwnerAlive: dead });
const staleRow = report.split("\n").find((l) => l.includes("01-implementer-aaaaaaaa"));
assert.ok(staleRow && /\bINTERRUPTED\b/.test(staleRow) && staleRow.includes("orchestrator not running"), report);
assert.ok(!/aaaaaaaa\s+RUNNING\b/.test(report), "row must not render RUNNING");
assert.ok(!report.includes("=== CURRENT RUN ==="), "a stale run must not be CURRENT");
const liveReport = renderWatchReport(repo, null, { isOwnerAlive: live });
assert.ok(liveReport.includes("=== CURRENT RUN ===") && /status:  RUNNING\b/.test(liveReport), "live owner -> running");
assert.match(staleRunningNote(repo, null, { isOwnerAlive: dead }), /interrupted \(orchestrator not running\)/);
assert.equal(staleRunningNote(repo, null, { isOwnerAlive: live }), null);
assert.equal(fs.readFileSync(statusFile, "utf8"), before);
assert.equal(fs.statSync(statusFile).mtimeMs, mtime);
fs.rmSync(repo, { recursive: true, force: true });
console.log("PASS test-stale-running-display");
