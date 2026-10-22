#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initRun, observe, finalizeRun, localIso, formatDuration, sanitizeSnippet, extractAction } from "./run-observability.mjs";
import { markInterrupted } from "./run-recovery.mjs";

const LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-run-obs-"));
const dir = path.join(root, "run-1");
const read = (p) => fs.readFileSync(path.join(dir, p), "utf8");
const has = (p) => fs.existsSync(path.join(dir, p));
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const init = initRun(dir, { pid: 1234, role: "implementer", phase: "4", task: "T006", attempt: "1", runId: "12345678-9abc-def0-1234-56789abcdef0" });

// status.json initial state.
assert(has("status.json"), "initRun should create status.json");
const st = JSON.parse(read("status.json"));
assert(st.status === "running", "status.json should start running");
assert(st.run_id === "12345678-9abc-def0-1234-56789abcdef0", "status.json should carry run_id");
assert(st.pid === 1234, "status.json should carry pid");
assert(st.role === "implementer", "status.json should carry role");
assert(st.phase === "4", "status.json should carry phase");
assert(st.taskGroup === "T006", "status.json should carry taskGroup");
assert(!("task" in st), "status.json should not carry a task key");
assert(st.attempt === "1", "status.json should carry attempt");
assert(st.taskRef === null, "status.json taskRef is null when the caller passes none");
assert(st.last_action === "started", "status.json last_action should be started");
assert(!!st.started_at && !!st.updated_at, "status.json should have timestamps");
assert(LOCAL_RE.test(st.started_at), `started_at must be local-with-offset (got: ${st.started_at})`);
assert(LOCAL_RE.test(st.updated_at), `updated_at must be local-with-offset (got: ${st.updated_at})`);
assert(st.started_at === init.started_at, "initRun should return the persisted status");

// progress.log START line.
assert(has("progress.log"), "initRun should create progress.log");
const startLine = read("progress.log").split(/\r?\n/).filter(Boolean)[0];
assert(/^.*START \| ROLE=implementer \| PHASE=4 \| TASK=- \| ATTEMPT=1 \| PID=1234$/.test(startLine), `unexpected START line: ${startLine}`);

// taskRef rides through when supplied.
const dirRef = path.join(root, "run-ref");
initRun(dirRef, { role: "implementer", taskRef: "T1.1" });
const stRef = JSON.parse(fs.readFileSync(path.join(dirRef, "status.json"), "utf8"));
assert(stRef.taskRef === "T1.1", "status.json should carry the supplied taskRef");
const refLine = fs.readFileSync(path.join(dirRef, "progress.log"), "utf8").split(/\r?\n/).filter(Boolean)[0];
assert(/TASK=T1\.1/.test(refLine) && !/TASKREF/.test(refLine), `START line should carry TASK=T1.1 with no TASKREF field: ${refLine}`);

// observe() throttling: two rapid calls -> only one ACTIVITY line; status updated.
const before = read("progress.log");
observe(dir, { stream: "stdout", bytes: 1024 });
observe(dir, { stream: "stdout", bytes: 512 });
const after = read("progress.log");
const activityLines = after.split(/\r?\n/).filter((l) => l.includes("ACTIVITY"));
assert(activityLines.length === 1, `observe throttle should collapse rapid calls (got ${activityLines.length})`);
const st2 = JSON.parse(read("status.json"));
assert(st2.last_action === "streaming", "observe should set last_action=streaming");
assert(LOCAL_RE.test(st2.updated_at), `observe updated_at must be local-with-offset (got: ${st2.updated_at})`);

// observe() after throttle window elapses -> second ACTIVITY line with sanitized LAST= snippet.
await new Promise((r) => setTimeout(r, 1100));
observe(dir, { stream: "stderr", bytes: 2048, last: "\x1b[31mANSI\r\ntext\x00" });
const after2 = read("progress.log");
const activityLines2 = after2.split(/\r?\n/).filter((l) => l.includes("ACTIVITY"));
assert(activityLines2.length === 2, `observe should write a new ACTIVITY after throttle window (got ${activityLines2.length})`);
assert(activityLines2[1].includes("LAST=ANSI text"), `ACTIVITY should include sanitized LAST snippet: ${activityLines2[1]}`);
assert(!activityLines2[0].includes("LAST="), "ACTIVITY without last chunk should have no LAST=");

// Backlog #6a: a chunk carrying a real adapter action writes its own ACTION
// line immediately (bypassing the throttle), extracting tool + command/file
// before the snippet is truncated.
observe(dir, { minIntervalMs: 60000, last: JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "bash", state: { input: { command: "git status --porcelain | head -n 50" } } } }) });
observe(dir, { minIntervalMs: 60000, last: JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/repo/src/a.mjs" } }] } }) });
observe(dir, { minIntervalMs: 60000, last: JSON.stringify({ step_update: { step_type: "tool", tool_name: "run_command", tool_info: { parameters: { CommandLine: "ls -la" } } } }) });
// A chunk boundary that cut the event mid-line (invalid JSON) still yields an action.
observe(dir, { minIntervalMs: 60000, last: '{"type":"tool_use","part":{"type":"tool","tool":"edit","state":{"input":{"filePath":"/repo/src/b.mjs"' });
const actionLines = read("progress.log").split(/\r?\n/).filter((l) => l.includes("ACTION |"));
assert(actionLines.length === 4, `expected 4 ACTION lines (got ${actionLines.length}): ${actionLines.join(" / ")}`);
assert(actionLines[0].includes("TOOL=bash | git status --porcelain | head -n 50"), `opencode bash action: ${actionLines[0]}`);
assert(actionLines[1].includes("TOOL=read | /repo/src/a.mjs"), `claude read action: ${actionLines[1]}`);
assert(actionLines[2].includes("TOOL=run_command | ls -la"), `agy command action: ${actionLines[2]}`);
assert(actionLines[3].includes("TOOL=edit | /repo/src/b.mjs"), `boundary-cut action: ${actionLines[3]}`);
assert(extractAction(JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "write", state: { input: { filePath: "/x" } } } })).kind === "write", "extractAction kind");
assert(extractAction("plain text, no action") === null, "extractAction must ignore prose");

// Backlog R2: a `read` tool shows its path:line window (offset..offset+limit-1);
// a read with no window keeps just its path, and other tools are unchanged.
const readRange = extractAction(JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "read", state: { input: { filePath: "scripts/setup.mjs", offset: 1640, limit: 80 } } } }));
assert(readRange.kind === "read" && readRange.text === "scripts/setup.mjs:1640-1719", `read ACTION range: ${JSON.stringify(readRange)}`);
const readWhole = extractAction(JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "Read", state: { input: { file_path: "/repo/src/a.mjs" } } } }));
assert(readWhole.text === "/repo/src/a.mjs", `read without offset keeps its path: ${JSON.stringify(readWhole)}`);
observe(dir, { minIntervalMs: 60000, last: JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "read", state: { input: { filePath: "scripts/setup.mjs", offset: 1640, limit: 80 } } } }) });
const readAction = read("progress.log").split(/\r?\n/).filter((l) => l.includes("ACTION |")).pop();
assert(readAction.includes("TOOL=read | scripts/setup.mjs:1640-1719"), `read ACTION line carries the range: ${readAction}`);

// sanitizeSnippet: strips ANSI/control chars, collapses whitespace, truncates.
assert(sanitizeSnippet("\x1b[31mOK\x1b[0m") === "OK", "sanitizeSnippet should strip ANSI CSI");
assert(sanitizeSnippet("a\r\nb\t c") === "a b c", "sanitizeSnippet should collapse whitespace");
assert(sanitizeSnippet("x\u0000y") === "xy", "sanitizeSnippet should strip control chars");
assert(sanitizeSnippet("").length === 0, "sanitizeSnippet empty should be empty");
const long = "z".repeat(1000);
assert(sanitizeSnippet(long).length <= 600, "sanitizeSnippet should truncate to max");

// finalizeRun: status.json completed + FINISHED line + duration.
const final = finalizeRun(dir, { status: "completed", exitCode: 0, decision: "PASS", startedAt: st.started_at });
const st3 = JSON.parse(read("status.json"));
assert(st3.status === "completed", "finalizeRun should set completed status");
assert(st3.exit_code === 0, "finalizeRun should persist exit_code");
assert(st3.decision === "PASS", "finalizeRun should persist decision");
assert(st3.last_action === "finished", "finalizeRun should set last_action=finished");
assert(st3.duration_ms != null && st3.duration_ms >= 0, "finalizeRun should compute duration_ms");
assert(LOCAL_RE.test(st3.finished_at), `finished_at must be local-with-offset (got: ${st3.finished_at})`);
const finLine = read("progress.log").split(/\r?\n/).filter((l) => l.includes("FINISHED")).pop();
assert(/^.*FINISHED \| STATUS=completed \| EXIT_CODE=0 \| DURATION=\d{2}:\d{2}:\d{2} \| DECISION=PASS$/.test(finLine), `unexpected FINISHED line: ${finLine}`);

// finalizeRun with failure status.
const dir2 = path.join(root, "run-2");
initRun(dir2, { role: "planner" });
finalizeRun(dir2, { status: "failed", exitCode: 2, startedAt: JSON.parse(fs.readFileSync(path.join(dir2, "status.json"), "utf8")).started_at });
const st4 = JSON.parse(fs.readFileSync(path.join(dir2, "status.json"), "utf8"));
assert(st4.status === "failed" && st4.exit_code === 2, "finalizeRun should handle failure status");
const fin2 = fs.readFileSync(path.join(dir2, "progress.log"), "utf8").split(/\r?\n/).filter((l) => l.includes("FINISHED")).pop();
assert(/STATUS=failed \| EXIT_CODE=2/.test(fin2), `unexpected failed FINISHED line: ${fin2}`);

// finalizeRun with a cap-breach status: passed through verbatim (backlog
// 003#15 — a continued run reports "capped", never "failed").
const dir4 = path.join(root, "run-4");
initRun(dir4, { role: "implementer" });
finalizeRun(dir4, { status: "capped", exitCode: null, decision: null, startedAt: JSON.parse(fs.readFileSync(path.join(dir4, "status.json"), "utf8")).started_at });
const st6 = JSON.parse(fs.readFileSync(path.join(dir4, "status.json"), "utf8"));
assert(st6.status === "capped", "finalizeRun should persist a capped status verbatim");
const fin4 = fs.readFileSync(path.join(dir4, "progress.log"), "utf8").split(/\r?\n/).filter((l) => l.includes("FINISHED")).pop();
assert(/STATUS=capped/.test(fin4), `capped FINISHED line should read STATUS=capped (got: ${fin4})`);

// finalizeRun without startedAt -> duration_ms null (represented as "-" in log, null in json).
const dir3 = path.join(root, "run-3");
initRun(dir3, { role: "reviewer" });
finalizeRun(dir3, { status: "completed", exitCode: 0, decision: "FAIL" });
const st5 = JSON.parse(fs.readFileSync(path.join(dir3, "status.json"), "utf8"));
assert(st5.duration_ms === null, "finalizeRun without startedAt should leave duration_ms null");
const fin3 = fs.readFileSync(path.join(dir3, "progress.log"), "utf8").split(/\r?\n/).filter((l) => l.includes("FINISHED")).pop();
assert(/DURATION=- /.test(fin3), `no-startedAt FINISHED line should show DURATION=- (got: ${fin3})`);

// formatDuration edge cases.
assert(formatDuration(null) === "-", "formatDuration(null) should be -");
assert(formatDuration(-5) === "-", "formatDuration(negative) should be -");
assert(formatDuration(3661000) === "01:01:01", "formatDuration should format H:MM:SS");
assert(formatDuration(0) === "00:00:00", "formatDuration(0) should be 00:00:00");

// localIso shape and local offset.
const iso = localIso(new Date("2026-08-18T12:00:00"));
assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(iso), `localIso shape wrong: ${iso}`);

// markInterrupted timestamps are local-with-offset: default `at`, status
// fields, and the AT= value on the INTERRUPTED progress line.
const dirIntr = path.join(root, "run-interrupted");
initRun(dirIntr, { role: "implementer" });
const intr = markInterrupted(dirIntr, {});
assert(intr.marked === true, "markInterrupted should mark a running run");
assert(LOCAL_RE.test(intr.at), `markInterrupted at must be local-with-offset (got: ${intr.at})`);
const stIntr = JSON.parse(fs.readFileSync(path.join(dirIntr, "status.json"), "utf8"));
assert(stIntr.status === "interrupted", "markInterrupted should set interrupted status");
assert(LOCAL_RE.test(stIntr.interrupted_at), `interrupted_at must be local-with-offset (got: ${stIntr.interrupted_at})`);
assert(LOCAL_RE.test(stIntr.updated_at), `interrupted updated_at must be local-with-offset (got: ${stIntr.updated_at})`);
const intrLine = fs.readFileSync(path.join(dirIntr, "progress.log"), "utf8").split(/\r?\n/).filter((l) => l.includes("INTERRUPTED")).pop();
assert(intrLine, "markInterrupted should append an INTERRUPTED progress line");
const atMatch = intrLine.match(/AT=(\S+)/);
assert(atMatch && LOCAL_RE.test(atMatch[1]), `AT= value must be local-with-offset (got: ${intrLine})`);
assert(LOCAL_RE.test(intrLine.slice(0, 25).trim()) || LOCAL_RE.test(intrLine.split("  ")[0]), `INTERRUPTED line leading timestamp must be local-with-offset (got: ${intrLine})`);

fs.rmSync(root, { recursive: true, force: true });
console.log("run-observability: 1/1 PASS");