#!/usr/bin/env node
// Unit tests and source checks for backlog #8:
// Task stuck with no file changes tries the escalation model once instead of stopping.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  scheduleNoProgressEscalation,
  formatNoProgressEscalationLog,
  noProgressDecision,
  endNoProgressRound,
  consumeEscalationFor,
} from "./escalation-model.mjs";

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

const ESC = { adapter: "claude", model: "claude-sonnet-5" };
const cfgWithEsc = {
  roles: {
    implementer: {
      adapter: "opencode",
      model: "free-y",
      escalation_model: ESC,
    },
  },
};
const cfgNoEsc = {
  roles: {
    implementer: {
      adapter: "opencode",
      model: "free-y",
    },
  },
};

// ── 1. Unit cases for scheduleNoProgressEscalation ──

test("no escalation_model → null and state untouched", () => {
  const state = {};
  const res = scheduleNoProgressEscalation(state, cfgNoEsc, {
    role: "implementer",
    scopeKey: "task:standalone:phase-0:T1",
    taskId: "T1",
    consecutive: 2,
    from: { adapter: "opencode", model: "free-y" },
  });
  assert.equal(res, null);
  assert.deepEqual(state, {});
});

test("first call records in noProgressEscalations and sets escalationPending", () => {
  const state = {};
  const res = scheduleNoProgressEscalation(state, cfgWithEsc, {
    role: "implementer",
    scopeKey: "task:standalone:phase-0:T1",
    taskId: "T1",
    consecutive: 2,
    from: { adapter: "opencode", model: "free-y" },
  });
  assert.ok(res);
  assert.equal(res.role, "implementer");
  assert.deepEqual(res.to, ESC);
  assert.deepEqual(res.from, { adapter: "opencode", model: "free-y" });
  assert.equal(res.taskId, "T1");
  assert.equal(res.consecutive, 2);

  assert.ok(state.noProgressEscalations["task:standalone:phase-0:T1"]);
  assert.equal(state.noProgressEscalations["task:standalone:phase-0:T1"].role, "implementer");
  assert.equal(state.noProgressEscalations["task:standalone:phase-0:T1"].taskId, "T1");
  assert.ok(typeof state.noProgressEscalations["task:standalone:phase-0:T1"].at === "string");

  assert.ok(state.escalationPending.implementer);
  assert.equal(state.escalationPending.implementer.scopeKey, "task:standalone:phase-0:T1");
  assert.deepEqual(state.escalationPending.implementer.to, ESC);
  assert.deepEqual(state.escalationPending.implementer.from, { adapter: "opencode", model: "free-y" });
  assert.equal(state.escalationPending.implementer.reason, "no_progress");
});

test("second call for same scopeKey → null and recorded entry kept", () => {
  const state = {};
  const first = scheduleNoProgressEscalation(state, cfgWithEsc, {
    role: "implementer",
    scopeKey: "task:standalone:phase-0:T1",
    taskId: "T1",
    consecutive: 2,
    from: { adapter: "opencode", model: "free-y" },
  });
  assert.ok(first);
  const recordedAt = state.noProgressEscalations["task:standalone:phase-0:T1"].at;

  const second = scheduleNoProgressEscalation(state, cfgWithEsc, {
    role: "implementer",
    scopeKey: "task:standalone:phase-0:T1",
    taskId: "T1",
    consecutive: 2,
    from: { adapter: "opencode", model: "free-y" },
  });
  assert.equal(second, null);
  assert.equal(state.noProgressEscalations["task:standalone:phase-0:T1"].at, recordedAt);
});

test("another scopeKey works after the first scopeKey was escalated", () => {
  const state = {};
  scheduleNoProgressEscalation(state, cfgWithEsc, {
    role: "implementer",
    scopeKey: "task:standalone:phase-0:T1",
    taskId: "T1",
    consecutive: 2,
    from: null,
  });
  const res2 = scheduleNoProgressEscalation(state, cfgWithEsc, {
    role: "implementer",
    scopeKey: "task:standalone:phase-0:T2",
    taskId: "T2",
    consecutive: 2,
    from: { adapter: "opencode", model: "free-y" },
  });
  assert.ok(res2);
  assert.equal(res2.taskId, "T2");
  assert.ok(state.noProgressEscalations["task:standalone:phase-0:T1"]);
  assert.ok(state.noProgressEscalations["task:standalone:phase-0:T2"]);
  assert.equal(state.escalationPending.implementer.scopeKey, "task:standalone:phase-0:T2");
});

// ── 1b. Unit cases for endNoProgressRound ──

test("endNoProgressRound clears all entries, deletes key, and returns scope keys", () => {
  const state = {
    noProgressEscalations: {
      "task:standalone:phase-0:T1": { role: "implementer", taskId: "T1" },
      "task:standalone:phase-0:T2": { role: "implementer", taskId: "T2" },
    },
  };
  const keys = endNoProgressRound(state);
  assert.deepEqual(keys.sort(), ["task:standalone:phase-0:T1", "task:standalone:phase-0:T2"]);
  assert.equal("noProgressEscalations" in state, false);
});

test("endNoProgressRound no-op on empty or absent noProgressEscalations", () => {
  // Absent key
  const state1 = {};
  assert.deepEqual(endNoProgressRound(state1), []);
  assert.deepEqual(state1, {});

  // Empty object
  const state2 = { noProgressEscalations: {} };
  assert.deepEqual(endNoProgressRound(state2), []);
  assert.equal("noProgressEscalations" in state2, false);

  // Null/undefined state
  assert.deepEqual(endNoProgressRound(null), []);
  assert.deepEqual(endNoProgressRound(undefined), []);
});

test("behaviour sequence: schedule → second schedule same scope null → endNoProgressRound → schedule same scope works again", () => {
  const state = {};
  const scopeKey = "task:speckit:phase-10:speckit:P11:T8:135cabc19224";

  // 1. Initial schedule: works
  const first = scheduleNoProgressEscalation(state, cfgWithEsc, {
    role: "implementer",
    scopeKey,
    taskId: "T8",
    consecutive: 2,
    from: { adapter: "opencode", model: "free-y" },
  });
  assert.ok(first, "first schedule must succeed");
  assert.ok(state.noProgressEscalations?.[scopeKey]);

  // 2. Second schedule in same round: null (does not repeat)
  const second = scheduleNoProgressEscalation(state, cfgWithEsc, {
    role: "implementer",
    scopeKey,
    taskId: "T8",
    consecutive: 2,
    from: { adapter: "opencode", model: "free-y" },
  });
  assert.equal(second, null, "second schedule in same round must return null");

  // Reviewer starts: consumeEscalationFor clears pending escalation
  consumeEscalationFor(state, "code_reviewer");
  assert.equal(state.escalationPending, undefined);

  // Reviewer start also triggers endNoProgressRound: clears noProgressEscalations
  const cleared = endNoProgressRound(state);
  assert.deepEqual(cleared, [scopeKey]);
  assert.equal("noProgressEscalations" in state, false);

  // 3. Next fix round gets stuck again: schedule same scope works again!
  const third = scheduleNoProgressEscalation(state, cfgWithEsc, {
    role: "implementer",
    scopeKey,
    taskId: "T8",
    consecutive: 2,
    from: { adapter: "opencode", model: "free-y" },
  });
  assert.ok(third, "schedule same scope in new fix round must succeed");
  assert.equal(third.taskId, "T8");
  assert.ok(state.noProgressEscalations?.[scopeKey]);
});

// ── 2. Log text formatting ──

test("log text with specified from model", () => {
  const line = formatNoProgressEscalationLog({
    role: "implementer",
    from: { adapter: "opencode", model: "free-y" },
    to: ESC,
    taskId: "T028",
    consecutive: 2,
  });
  assert.equal(
    line,
    "escalation: implementer opencode/free-y → claude/claude-sonnet-5 for task T028 (no file changed in 2 sessions)"
  );
});

test("log text with from=null falls back to 'configured model'", () => {
  const line = formatNoProgressEscalationLog({
    role: "implementer",
    from: null,
    to: ESC,
    taskId: "T028",
    consecutive: 3,
  });
  assert.equal(
    line,
    "escalation: implementer configured model → claude/claude-sonnet-5 for task T028 (no file changed in 3 sessions)"
  );
});

// ── 3. Unit cases for noProgressDecision helper ──

test("decision: non-task sites continue below limit and stop at limit", () => {
  assert.equal(
    noProgressDecision({ consecutive: 1, limit: 2, isTaskSite: false, escalatedForScope: false, pendingForScope: false }),
    "continue"
  );
  assert.equal(
    noProgressDecision({ consecutive: 2, limit: 2, isTaskSite: false, escalatedForScope: false, pendingForScope: false }),
    "stop"
  );
});

test("decision: task site before escalation continues below limit and escalates at limit", () => {
  assert.equal(
    noProgressDecision({ consecutive: 0, limit: 2, isTaskSite: true, escalatedForScope: false, pendingForScope: false }),
    "continue"
  );
  assert.equal(
    noProgressDecision({ consecutive: 1, limit: 2, isTaskSite: true, escalatedForScope: false, pendingForScope: false }),
    "continue"
  );
  assert.equal(
    noProgressDecision({ consecutive: 2, limit: 2, isTaskSite: true, escalatedForScope: false, pendingForScope: false }),
    "escalate"
  );
  assert.equal(
    noProgressDecision({ consecutive: 3, limit: 2, isTaskSite: true, escalatedForScope: false, pendingForScope: false }),
    "escalate"
  );
});

test("decision: escalation session with no progress stops immediately (even below limit)", () => {
  // Escalation session made changes (consecutive = 0): continue
  assert.equal(
    noProgressDecision({ consecutive: 0, limit: 2, isTaskSite: true, escalatedForScope: true, pendingForScope: true }),
    "continue"
  );
  // Escalation session made no changes (consecutive = 1 < limit): stop immediately
  assert.equal(
    noProgressDecision({ consecutive: 1, limit: 2, isTaskSite: true, escalatedForScope: true, pendingForScope: true }),
    "stop"
  );
});

test("decision: later session on normal model (pending consumed) follows normal rule up to limit", () => {
  // Below limit: continue (does NOT die below limit)
  assert.equal(
    noProgressDecision({ consecutive: 1, limit: 2, isTaskSite: true, escalatedForScope: true, pendingForScope: false }),
    "continue"
  );
  // At limit: stop (cannot escalate again)
  assert.equal(
    noProgressDecision({ consecutive: 2, limit: 2, isTaskSite: true, escalatedForScope: true, pendingForScope: false }),
    "stop"
  );
});

// ── 4. Source checks in autopilot.mjs ──

test("source check: stopOnNoProgress calls helper before die and only for task sites", () => {
  const src = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
  const stopFnIndex = src.indexOf("function stopOnNoProgress(");
  assert.ok(stopFnIndex > 0, "stopOnNoProgress function exists");
  const stopFn = src.slice(stopFnIndex, src.indexOf("\nfunction clearHandoffNote(", stopFnIndex));

  // Gated on taskId set and step undefined (implementer task sites)
  assert.match(stopFn, /taskId\s*!=\s*null\s*&&\s*step\s*===\s*undefined/);
  // Calls scheduleNoProgressEscalation
  assert.match(stopFn, /scheduleNoProgressEscalation\(s,\s*c,\s*\{/);
  // Logs using formatNoProgressEscalationLog
  assert.match(stopFn, /formatNoProgressEscalationLog\(esc\)/);
  // Clears no-progress and saves state without die()
  assert.match(stopFn, /clearNoProgress\(s,\s*contScope\);\s*saveState\(s\);\s*return;/);

  // scheduleNoProgressEscalation is positioned before any die()
  const helperCallPos = stopFn.indexOf("scheduleNoProgressEscalation(");
  const diePos = stopFn.indexOf("die(");
  assert.ok(helperCallPos > 0 && diePos > 0 && helperCallPos < diePos, "helper called before die()");
});

test("source check: pending-only early stop and noProgressDecision wiring in stopOnNoProgress", () => {
  const src = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
  const stopFnIndex = src.indexOf("function stopOnNoProgress(");
  const stopFn = src.slice(stopFnIndex, src.indexOf("\nfunction clearHandoffNote(", stopFnIndex));

  // Checks pendingForScope specifically for the active escalation session
  assert.match(
    stopFn,
    /s\?\.escalationPending\?\.implementer\?\.reason\s*===\s*"no_progress"\s*&&\s*s\.escalationPending\.implementer\.scopeKey\s*===\s*contScope/
  );
  // Checks escalatedForScope
  assert.match(stopFn, /s\?\.noProgressEscalations\?\.\[contScope\]/);
  // Delegates decision to noProgressDecision
  assert.match(stopFn, /noProgressDecision\(\{consecutive,limit,isTaskSite,escalatedForScope,pendingForScope\}\)/);
  // Respects continue decision
  assert.match(stopFn, /if\s*\(\s*decision\s*===\s*"continue"\s*\)\s*return;/);
  // Respects escalate decision
  assert.match(stopFn, /if\s*\(\s*decision\s*===\s*"escalate"\s*\)/);
});

test("source check: per-task escalation clearing in BOTH loops (Standalone and SpecKit)", () => {
  const src = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");

  // Standalone loop matches
  const standaloneMatches = [
    ...src.matchAll(/if\s*\(\s*s\?\.escalationPending\?\.implementer\?\.reason\s*===\s*"no_progress"\s*&&\s*s\.escalationPending\.implementer\.scopeKey\s*===\s*`task:standalone:phase-\$\{s\.phaseIndex\}:\$\{taskId\}`\s*\)\s*\{\s*delete s\.escalationPending\.implementer;/g),
  ];
  assert.ok(standaloneMatches.length >= 1, `standalone loop must clear pending no_progress escalation (found ${standaloneMatches.length})`);

  // SpecKit loop matches
  const speckitMatches = [
    ...src.matchAll(/if\s*\(\s*s\?\.escalationPending\?\.implementer\?\.reason\s*===\s*"no_progress"\s*&&\s*s\.escalationPending\.implementer\.scopeKey\s*===\s*`task:speckit:phase-\$\{s\.phaseIndex\}:\$\{taskId\}`\s*\)\s*\{\s*delete s\.escalationPending\.implementer;/g),
  ];
  assert.ok(speckitMatches.length >= 1, `speckit loop must clear pending no_progress escalation (found ${speckitMatches.length})`);
});

test("source check: noProgressEscalations in MISSION_SCOPED_STATE_KEYS", () => {
  const src = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
  const keysStart = src.indexOf("MISSION_SCOPED_STATE_KEYS=Object.freeze([");
  const keysBlock = src.slice(keysStart, keysStart + 3000);
  assert.ok(keysBlock.includes('"noProgressEscalations"'), "MISSION_SCOPED_STATE_KEYS must include noProgressEscalations");
});

test("source check: runRelay calls endNoProgressRound next to consumeEscalationFor for reviewer/verifier starts", () => {
  const src = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
  const relayIdx = src.indexOf("async function runRelay(");
  assert.ok(relayIdx > 0, "runRelay function exists");
  const relayBody = src.slice(relayIdx, src.indexOf("\nasync function ", relayIdx + 100));

  assert.match(src, /import\s*\{[^}]*endNoProgressRound[^}]*\}\s*from\s*"\.\/escalation-model\.mjs"/);
  assert.match(relayBody, /consumeEscalationFor\(s,\s*roleName\)/);
  assert.match(relayBody, /roleName\s*===\s*"code_reviewer"\s*\|\|\s*roleName\s*===\s*"verifier"/);
  assert.match(relayBody, /endNoProgressRound\(s\)/);

  const consumePos = relayBody.indexOf("consumeEscalationFor(s,roleName)");
  const endRoundPos = relayBody.indexOf("endNoProgressRound(s)");
  assert.ok(consumePos > 0 && endRoundPos > 0, "both calls exist in runRelay");
  assert.ok(Math.abs(endRoundPos - consumePos) < 300, "endNoProgressRound is called next to consumeEscalationFor");
});

test("source check: resetCommand handles noProgressEscalations in both global and scoped paths", () => {
  const src = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");

  // Global reset path (clearAllSpentCounters)
  const clearCountersIdx = src.indexOf("function clearAllSpentCounters(");
  assert.ok(clearCountersIdx > 0, "clearAllSpentCounters exists");
  const clearCountersBody = src.slice(clearCountersIdx, src.indexOf("\nfunction ", clearCountersIdx + 50));
  assert.match(clearCountersBody, /s\.noProgressEscalations/);
  assert.match(clearCountersBody, /noProgressEscalations:\$\{k\}/);

  // Scoped reset scope resolution
  const scopeFnIdx = src.indexOf("function resetContinuationScope(");
  assert.ok(scopeFnIdx > 0, "resetContinuationScope exists");
  const scopeFnBody = src.slice(scopeFnIdx, src.indexOf("\nfunction ", scopeFnIdx + 50));
  assert.match(scopeFnBody, /s\.noProgressEscalations/);

  // Scoped reset command (resetContinuationCommand)
  const resetContIdx = src.indexOf("function resetContinuationCommand(");
  assert.ok(resetContIdx > 0, "resetContinuationCommand exists");
  const resetContBody = src.slice(resetContIdx, src.indexOf("\nfunction ", resetContIdx + 50));
  assert.match(resetContBody, /s\.noProgressEscalations/);
  assert.match(resetContBody, /noProgressEscalations:\$\{contScope\}/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
