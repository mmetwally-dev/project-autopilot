import assert from "node:assert/strict";
import fs from "node:fs";
import {failedRunDidWork, appendFailureHandoff, stripFailureHandoff} from "./failure-handoff.mjs";
import {buildOrchestratorFallbackNote} from "./per-task-budget.mjs";

const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
const i = src.indexOf("Backlog #116:");
assert.ok(i > 0);
const blk = src.slice(i, i + 2400);
assert.ok(blk.includes("failedRunDidWork") && blk.includes("buildOrchestratorFallbackNote") && blk.includes("handoffNoteExcerptsFor"));
assert.ok(blk.includes("(orchestrator fallback, failed run)"), "header replace anchored");
assert.ok(!/consumeContinuation|extra_sessions/.test(blk), "no continuation consumed");
assert.ok(src.includes("This session FAILED before"));
assert.equal((src.match(/appendFailureHandoff\(task,failureHandoffText,failureHandoffQuotes\)/g) || []).length, 3, "all in-relay relaunches (session retry, escalation-failure re-run, fallback re-run) carry the note");

// Work detection.
const toolEv = {type: "tool_use", part: {type: "tool", tool: "bash", state: {status: "completed", input: {command: "ls"}}}};
const editEv = {type: "tool_use", part: {type: "tool", tool: "edit", state: {status: "completed", input: {filePath: "a.mjs"}}}};
assert.equal(failedRunDidWork({adapterId: "opencode", touchedFiles: ["a.mjs"], events: []}), true, "edits");
assert.equal(failedRunDidWork({adapterId: "opencode", touchedFiles: [], events: []}), false, "nothing done");
assert.equal(failedRunDidWork({adapterId: "opencode", touchedFiles: [], events: [{type: "step_start"}]}), false, "step only");
assert.equal(failedRunDidWork({adapterId: "opencode", touchedFiles: [], events: [{type: "step_start"}, {type: "step_finish"}]}), true, "one completed turn");

// Brief carries the note; early failure leaves brief unchanged; idempotent.
const base = "ORIGINAL BRIEF";
const note = buildOrchestratorFallbackNote("T3.2", [toolEv, editEv], "opencode", "/tmp", " a.mjs | 4 ++++", null)
  .replace("(orchestrator fallback)\n\nThis session was capped before it wrote a fresh hand-off note, so the", "(orchestrator fallback, failed run)\n\nThis session FAILED before it wrote a fresh hand-off note, so the");
assert.ok(note.includes("failed run") && note.includes("This session FAILED"), "header replace matches the real builder output");
assert.ok(note.includes("a.mjs | 4"), note);
const b1 = appendFailureHandoff(base, note, "x.mjs:1: foo");
assert.ok(b1.startsWith(base) && b1.includes("Hand-off note from the previous session") && b1.includes("a.mjs | 4") && b1.includes("Continuation-only quotes"));
const b2 = appendFailureHandoff(b1, note + "\nnewer", "");
assert.equal((b2.match(/Hand-off note from the previous session/g) || []).length, 1, "replaced, not stacked");
assert.ok(!b2.includes("Continuation-only"));
assert.equal(appendFailureHandoff(base, "", ""), base, "no note -> brief unchanged");
assert.equal(stripFailureHandoff(b1), base);
console.log("PASS 116");
