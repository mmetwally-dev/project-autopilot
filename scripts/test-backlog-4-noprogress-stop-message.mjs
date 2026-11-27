#!/usr/bin/env node
// Test for Backlog #4: Stop message clarity after no-progress escalation.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  scheduleNoProgressEscalation,
  formatNoProgressStopMessage,
  displayModel,
} from "./escalation-model.mjs";
import { formatNoProgressStopMessage as autopilotFormatNoProgressStopMessage } from "./autopilot.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL ${name}:`, err);
    failed++;
  }
}

const ESC = { adapter: "claude", model: "sonnet[1m]" };
const cfgWithEsc = {
  roles: {
    implementer: {
      adapter: "antigravity",
      model: "gemini-4-hydrogen-medium",
      escalation_model: ESC,
    },
  },
};

// ── (a) No escalation → old text exactly (byte-identical) ──

test("(a) no escalation (null) produces byte-identical old stop message", () => {
  const subject = "SpecKit task T006";
  const consecutive = 2;
  const limit = 2;
  const contScope = "task:speckit:phase-1:T006";

  const expected = `${subject} changed no file in ${consecutive} consecutive sessions (policy.no_progress_generations=${limit}). STOP — human intervention required: read the task hand-off note, then\nResume: ap reset --scope ${contScope} then ap run`;

  const actualNamed = formatNoProgressStopMessage({
    subject,
    consecutive,
    limit,
    contScope,
    escalation: null,
  });
  assert.equal(actualNamed, expected);

  const actualAutopilotExport = autopilotFormatNoProgressStopMessage({
    subject,
    consecutive,
    limit,
    contScope,
    escalation: null,
  });
  assert.equal(actualAutopilotExport, expected);
});

test("(a) no escalation (undefined / omitted) produces byte-identical old stop message", () => {
  const subject = "Standalone task T001";
  const consecutive = 3;
  const limit = 3;
  const contScope = "task:standalone:phase-0:T001";

  const expected = `${subject} changed no file in ${consecutive} consecutive sessions (policy.no_progress_generations=${limit}). STOP — human intervention required: read the task hand-off note, then\nResume: ap reset --scope ${contScope} then ap run`;

  const actual = formatNoProgressStopMessage({
    subject,
    consecutive,
    limit,
    contScope,
  });
  assert.equal(actual, expected);
});

test("(a) old-shape escalation {role, taskId, at} without consecutive/from/to returns original text", () => {
  const subject = "SpecKit task T006";
  const consecutive = 1;
  const limit = 2;
  const contScope = "task:speckit:phase-1:T006";

  const oldShapeEscalation = {
    role: "implementer",
    taskId: "T006",
    at: "2026-11-20T22:00:00.000Z",
  };

  const expected = `${subject} changed no file in ${consecutive} consecutive sessions (policy.no_progress_generations=${limit}). STOP — human intervention required: read the task hand-off note, then\nResume: ap reset --scope ${contScope} then ap run`;

  const actual = formatNoProgressStopMessage({
    subject,
    consecutive,
    limit,
    contScope,
    escalation: oldShapeEscalation,
  });
  assert.equal(actual, expected);
});

// ── (b) Escalation stored with consecutive 2 + from gemini, then 1 more session ──

test("(b) escalation stored with consecutive 2 + from gemini, 1 more session → '3 sessions (2 on gemini, 1 on escalation model claude/sonnet[1m]...'", () => {
  const subject = "SpecKit task T006";
  const consecutive = 1; // 1 session on escalation model
  const limit = 2;
  const contScope = "task:speckit:phase-1:T006";

  const escalation = {
    consecutive: 2,
    from: "gemini",
    to: "claude/sonnet[1m]",
  };

  const expected = "SpecKit task T006 changed no file in 3 sessions (2 on gemini, 1 on escalation model claude/sonnet[1m]; policy.no_progress_generations=2 plus one escalation session). STOP — human intervention required: read the task hand-off note, then\nResume: ap reset --scope task:speckit:phase-1:T006 then ap run";

  const actual = formatNoProgressStopMessage({
    subject,
    consecutive,
    limit,
    contScope,
    escalation,
  });

  assert.equal(actual, expected);
  assert.ok(actual.includes("3 sessions (2 on gemini, 1 on escalation model claude/sonnet[1m]; policy.no_progress_generations=2 plus one escalation session)"));
  assert.ok(actual.endsWith("STOP — human intervention required: read the task hand-off note, then\nResume: ap reset --scope task:speckit:phase-1:T006 then ap run"));
});

test("(b) escalation with full model display strings formats properly", () => {
  const subject = "SpecKit task T006";
  const consecutive = 1;
  const limit = 2;
  const contScope = "task:speckit:phase-1:T006";

  const escalation = {
    consecutive: 2,
    from: "antigravity/gemini-4-hydrogen-medium",
    to: "claude/sonnet[1m]",
  };

  const actual = formatNoProgressStopMessage({
    subject,
    consecutive,
    limit,
    contScope,
    escalation,
  });

  const expected = "SpecKit task T006 changed no file in 3 sessions (2 on antigravity/gemini-4-hydrogen-medium, 1 on escalation model claude/sonnet[1m]; policy.no_progress_generations=2 plus one escalation session). STOP — human intervention required: read the task hand-off note, then\nResume: ap reset --scope task:speckit:phase-1:T006 then ap run";
  assert.equal(actual, expected);
});

// ── (c) scheduleNoProgressEscalation stores consecutive and from ──

test("(c) scheduleNoProgressEscalation stores consecutive and from (display string) alongside existing fields", () => {
  const state = {};
  const scopeKey = "task:speckit:phase-1:T006";
  const res = scheduleNoProgressEscalation(state, cfgWithEsc, {
    role: "implementer",
    scopeKey,
    taskId: "T006",
    consecutive: 2,
    from: { adapter: "antigravity", model: "gemini-4-hydrogen-medium" },
  });

  assert.ok(res, "scheduleNoProgressEscalation returned result");
  assert.equal(res.role, "implementer");
  assert.deepEqual(res.to, ESC);
  assert.deepEqual(res.from, { adapter: "antigravity", model: "gemini-4-hydrogen-medium" });
  assert.equal(res.taskId, "T006");
  assert.equal(res.consecutive, 2);

  const stored = state.noProgressEscalations[scopeKey];
  assert.ok(stored, "stored entry exists");
  assert.equal(stored.role, "implementer");
  assert.equal(stored.taskId, "T006");
  assert.ok(typeof stored.at === "string", "at timestamp is recorded");
  assert.equal(stored.consecutive, 2, "consecutive is recorded");
  assert.equal(stored.from, "antigravity/gemini-4-hydrogen-medium", "from is stored as display string");
  assert.equal(stored.to, "claude/sonnet[1m]", "to is stored as display string");
});

test("(c) scheduleNoProgressEscalation stores string from as display string", () => {
  const state = {};
  const scopeKey = "task:standalone:phase-0:T002";
  const res = scheduleNoProgressEscalation(state, cfgWithEsc, {
    role: "implementer",
    scopeKey,
    taskId: "T002",
    consecutive: 2,
    from: "gemini",
  });

  assert.ok(res);
  const stored = state.noProgressEscalations[scopeKey];
  assert.ok(stored);
  assert.equal(stored.consecutive, 2);
  assert.equal(stored.from, "gemini");
  assert.equal(stored.to, "claude/sonnet[1m]");
});

test("(c) displayModel helper formats strings, objects, and null fallbacks correctly", () => {
  assert.equal(displayModel("gemini"), "gemini");
  assert.equal(displayModel({ adapter: "claude", model: "sonnet[1m]" }), "claude/sonnet[1m]");
  assert.equal(displayModel({ adapter: "antigravity", model: "antigravity/gemini-4" }), "antigravity/gemini-4");
  assert.equal(displayModel(null), "configured model");
  assert.equal(displayModel(undefined), "configured model");
});

// ── Source checks ──

test("source check: stopOnNoProgress calls formatNoProgressStopMessage with clean named options", () => {
  const src = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
  const stopFnIndex = src.indexOf("function stopOnNoProgress(");
  assert.ok(stopFnIndex > 0, "stopOnNoProgress function exists");
  const stopFn = src.slice(stopFnIndex, src.indexOf("\nfunction clearHandoffNote(", stopFnIndex));

  assert.match(stopFn, /formatNoProgressStopMessage\(/, "calls formatNoProgressStopMessage");
  assert.match(stopFn, /s\?\.noProgressEscalations/, "reads noProgressEscalations");
  assert.match(stopFn, /die\(\s*formatNoProgressStopMessage/, "passes formatted message directly to die()");
  assert.equal(stopFn.includes("escTo"), false, "escTo line removed");
  assert.equal(stopFn.includes("to: escTo"), false, "to: argument removed");
});

test("source check: standalone planner does not reach escalated path", () => {
  const src = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
  const stopFnIndex = src.indexOf("function stopOnNoProgress(");
  const stopFn = src.slice(stopFnIndex, src.indexOf("\nfunction clearHandoffNote(", stopFnIndex));

  // Planning stops explicitly pass step: "...planning_no_progress" and taskId: null
  // In stopOnNoProgress: isTaskSite = taskId != null && step === undefined
  // So planning never enters the escalated path
  assert.match(stopFn, /isTaskSite\s*=\s*taskId\s*!=\s*null\s*&&\s*step\s*===\s*undefined/);
  assert.match(stopFn, /if\s*\(\s*step\s*===\s*"standalone_planning_no_progress"\s*\)/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
