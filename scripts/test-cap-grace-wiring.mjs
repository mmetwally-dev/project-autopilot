#!/usr/bin/env node
import fs from "node:fs";
import {
  evaluateCapGraceWindow,
  checkCapBreach,
  checkWrapupTrigger,
  growingTerm,
  resolvePerRoleLimits,
} from "./per-task-budget.mjs";

// Mission 027 Phase 3 task 3.2 (backlog #34d): end-of-task grace window
// wiring. autopilot.mjs runs main() on import, so the shared runRelay
// monitor grace gate is static-covered here (same pattern as
// test-cap-breach-wiring.mjs). The pure decision
// (evaluateCapGraceWindow) is unit-covered in
// test-cap-grace-window.mjs; both-loops finishing-vs-non-finishing
// behaviour is covered by the task 3.3 extension of this file.
let failures = 0;
const check = (name, condition) => {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
};
const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
const budgetSrc = fs.readFileSync(new URL("./per-task-budget.mjs", import.meta.url), "utf8");
const idx = (s, sub) => s.indexOf(sub);

// ── Grace state + evidence helper (implementer-only scope) ──
check("grace: window state beside cap state",
  /let capGraceWindow=null;/.test(src));
check("grace: finishing-evidence helper scans decoded events",
  /function capGraceFinishingEvidence\(events\)/.test(src)
  && /AUTOPILOT_TASK_RESULT/.test(src)
  && /capGraceFinishingEvidence\(capEvents\)/.test(src));
check("grace: pure helper imported and called with finishing evidence",
  /evaluateCapGraceWindow/.test(src)
  && /evaluateCapGraceWindow\(\{verifyPassed:graceEvidence\.verifyPassed,writingFinalResult:graceEvidence\.writingFinalResult,graceUsed:/.test(src));
check("grace: implementer-only (inside the !capDriver guard, wrap-up exempt untouched)",
  /const capDriver=\(!isWrapUp && capEnabled\)\?adapterDriver\(role\.adapter\):null;/.test(src)
  && /\} else \{\s*\n\s*if\(!capDriver\) return;/.test(src)
  && idx(src, "if(!capDriver) return;") < idx(src, "graceEvidence=capGraceFinishingEvidence")
  && idx(src, "const wrap=checkWrapupTrigger") < idx(src, "const breach=checkCapBreach")
  && idx(src, "const pending=wrap") < idx(src, "graceEvidence=capGraceFinishingEvidence"));

// ── Grace-before-kill order ──
check("grace: both wrap and hard-cap breaches gated on grace before the capped marker",
  /if\(graceDeferred\) return;\s*\n\s*capBreach=\{type:pending\.type,used:pending\.used,limit:pending\.limit,usage,wrapUp:true,trigger:pending\.type\};/.test(src));
{
  const graceAt = idx(src, "capGraceWindow={turnCeiling:graceDecision.turnCeiling");
  const killAt = idx(src, 'process.kill(capPid,"SIGTERM")');
  const markerAt = idx(src, "capBreach={type:pending.type");
  check("grace: window granted before any kill or capped marker",
    graceAt !== -1 && killAt !== -1 && markerAt !== -1 && graceAt < markerAt && markerAt < killAt);
}
check("grace: grace evaluation block precedes the capped marker assignment",
  idx(src, "let graceDeferred=false;") < idx(src, "capBreach={type:pending.type"));
check("grace: deferral skips SIGTERM/SIGKILL and the capped marker (early return)",
  /if\(graceDeferred\) return;/.test(src));
check("grace: window-open ticks re-check both ceilings against live usage",
  /graceTurns<=capGraceWindow\.turnCeiling/.test(src)
  && /graceGrowing<=capGraceWindow\.tokenCeiling/.test(src)
  && /growingTerm\(usage\)/.test(src));
check("grace: exceeded window falls through to the cap exactly as today",
  /if\(withinTurns && withinTokens\)\{/.test(src)
  && /capBreach=\{type:pending\.type,used:pending\.used,limit:pending\.limit,usage,wrapUp:true,trigger:pending\.type\};/.test(src));
check("grace: denial caps exactly as today (no separate kill path)",
  (src.match(/process\.kill\(capPid,"SIGTERM"\)/g) || []).length === 2
  && (src.match(/process\.kill\(capPid,"SIGKILL"\)/g) || []).length === 2);
check("grace: window observed, failures degrade to immediate cap",
  /GRACE_WINDOW \| TYPE=/.test(src)
  && /catch\{\}\s*\n\s*if\(graceDeferred\) return;/.test(src));
check("grace: single window per generation (graceUsed passed, set once on grant)",
  /graceUsed:false/.test(src)
  && /capGraceWindow=\{turnCeiling:graceDecision\.turnCeiling,tokenCeiling:graceDecision\.tokenCeiling\};/.test(src));

// ── Non-finishing breaches cap immediately ──
check("grace: evidence requires verify-passed or final-result lines",
  /verifyPassed !== true && writingFinalResult !== true/.test(budgetSrc)
  && /no_finishing_evidence/.test(budgetSrc));
check("grace: both wrap and hard-cap paths gated on grace (no hard-cap-only gate)",
  idx(src, "const pending=wrap") < idx(src, "graceEvidence=capGraceFinishingEvidence")
  && idx(src, "if(graceDeferred) return;") < idx(src, "capBreach={type:pending.type"));

// ── Task 3.3: both-loops grace behaviour (finishing vs non-finishing) ──
// autopilot.mjs runs main() on import, so the live runRelay monitor cannot
// be invoked here. This section mirrors its grace branch step for step
// (window-open recheck → finishing-evidence grant → early return before the
// capped marker and the SIGTERM/SIGKILL, else cap exactly as today) plus
// the result.capped assembly below it, and drives it with synthetic usage
// ticks for both loops (standalone "3.3" and SpecKit "T001" task refs).

// Event fixtures matching production capGraceFinishingEvidence event shapes.
const assistantTextEvent = (text) => ({type: "text", part: {type: "text", text}});
const assistantMessageEvent = (text) => ({type: "assistant", message: {content: [{type: "text", text}]}});
const resultEvent = (text) => ({type: "result", result: text});
const bashEvent = (exit, output) => ({
  type: "tool_use",
  part: {tool: "bash", state: {metadata: {exit, output}}},
});
const otherToolEvent = (tool, output) => ({
  type: "tool_use",
  part: {tool, state: {metadata: {exit: 0, output}}},
});

// Mirror of production capGraceFinishingEvidence: takes decoded event arrays,
// scans latest assistant text (for AUTOPILOT_TASK_RESULT line) and latest
// bash result (exit 0 + pass line, excluding "0 tests passed").
function capGraceFinishingEvidenceMirror(events) {
  const evs = Array.isArray(events) ? events : [];
  let writingFinalResult = false;
  let latestAssistantText = "";
  for (const event of evs) {
    if (event?.type === "text" && typeof event.part?.text === "string") {
      latestAssistantText = event.part.text;
    } else if (event?.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === "text" && typeof block.text === "string") {
          latestAssistantText = block.text;
        }
      }
    } else if (event?.type === "result" && typeof event.result === "string") {
      latestAssistantText = event.result;
    }
  }
  if (latestAssistantText) {
    for (const line of latestAssistantText.split(/\r?\n/)) {
      const trimmed = line.trimStart();
      if (/^AUTOPILOT_TASK_RESULT\s*[:=]/.test(trimmed)) {
        writingFinalResult = true;
        break;
      }
    }
  }
  let verifyPassed = false;
  let latestBashOutput = "";
  let latestBashExit = null;
  for (const event of evs) {
    if (event?.part?.tool === "bash") {
      const state = event.part.state || {};
      const meta = state.metadata || {};
      const exitValue = Number.isFinite(Number(meta.exit)) ? Number(meta.exit) : null;
      if (exitValue !== null) {
        latestBashExit = exitValue;
        const output = String(meta.output ?? state.output ?? "");
        latestBashOutput = output;
      }
    }
  }
  if (latestBashExit === 0 && latestBashOutput) {
    const passMatch = /(?:\btests?\s+passed\b|\bchecks?\s+passed\b)/i.exec(latestBashOutput);
    const zeroMatch = /\b0\s+tests?\s+passed\b/i.exec(latestBashOutput);
    if (passMatch && !zeroMatch) {
      verifyPassed = true;
    }
  }
  return {verifyPassed, writingFinalResult};
}

// One monitor tick: returns the capped marker the production code would set
// (null while grace defers), whether the kill would fire, and the next
// window. Kill side effects (SIGTERM/SIGKILL) become the killed flag.
function tickGraceUnit({usage, caps, events, graceWindow}) {
  // Follow the real evaluateCaps order: checkWrapupTrigger first, then checkCapBreach
  const wrap = checkWrapupTrigger({usage, perTaskMaxTurns: caps.perTaskMaxTurns, perTaskMaxTokens: caps.perTaskMaxTokens, wrapupTokens: GRACE_WRAPUP_TOKENS});
  const breach = checkCapBreach({usage, perTaskMaxTurns: caps.perTaskMaxTurns, perTaskMaxTokens: caps.perTaskMaxTokens});
  const pending = wrap ?? breach;
  if (!pending) return {capBreach: null, graceDeferred: false, graceWindow, killed: false};
  let graceDeferred = false;
  let nextWindow = graceWindow;
  if (graceWindow) {
    const graceTurns = usage.turns;
    const graceGrowing = growingTerm(usage);
    const withinTurns = Number.isInteger(graceTurns) && Number.isInteger(graceWindow.turnCeiling) && graceTurns <= graceWindow.turnCeiling;
    const withinTokens = Number.isFinite(graceGrowing) && Number.isFinite(graceWindow.tokenCeiling) && graceGrowing <= graceWindow.tokenCeiling;
    if (withinTurns && withinTokens) graceDeferred = true;
  } else {
    const graceEvidence = capGraceFinishingEvidenceMirror(events);
    const graceDecision = evaluateCapGraceWindow({verifyPassed: graceEvidence.verifyPassed, writingFinalResult: graceEvidence.writingFinalResult, graceUsed: graceWindow !== null, turnsUsed: usage.turns, perTaskMaxTurns: caps.perTaskMaxTurns, tokensUsed: growingTerm(usage), perTaskMaxTokens: caps.perTaskMaxTokens});
    if (graceDecision.granted) {
      nextWindow = {turnCeiling: graceDecision.turnCeiling, tokenCeiling: graceDecision.tokenCeiling};
      graceDeferred = true;
    }
  }
  if (graceDeferred) return {capBreach: null, graceDeferred: true, graceWindow: nextWindow, killed: false};
  return {capBreach: {type: pending.type, used: pending.used, limit: pending.limit, usage, wrapUp: true, trigger: pending.type}, graceDeferred: false, graceWindow: nextWindow, killed: true};
}

// Production result.capped assembly (autopilot.mjs below evaluateCaps).
function cappedRecord(capBreach) {
  if (!capBreach) return null;
  const capped = {type: capBreach.type, used: capBreach.used, limit: capBreach.limit};
  if (capBreach.wrapUp) capped.wrapUp = true;
  if (capBreach.trigger) capped.trigger = capBreach.trigger;
  return capped;
}
const GRACE_CAPS = {perTaskMaxTurns: 5, perTaskMaxTokens: 100_000};
const GRACE_WRAPUP_TOKENS = 69_000; // default from per-task-budget.mjs, below the cap
const GRACE_TOKEN_CEILING = Math.ceil(GRACE_CAPS.perTaskMaxTokens * 1.10);
const turnUsage = (turns, growing = 10_000) => ({turns, cacheRead: growing, input: 0});

// Finishing event fixtures
const FINISH_EVENTS_RESULT_LINE = [
  assistantTextEvent("node scripts/test-cap-grace-window.mjs\ntests passed\nAUTOPILOT_TASK_RESULT="),
];
const FINISH_EVENTS_VERIFY_PASSED = [
  assistantTextEvent("working on the task"),
  bashEvent(0, "running tests\n5 tests passed\n"),
];
const FINISH_EVENTS_BOTH = [
  assistantTextEvent("finalizing\nAUTOPILOT_TASK_RESULT={\"status\":\"completed\"}"),
  bashEvent(0, "verify\n3 checks passed\n"),
];

// Non-finishing event fixtures
const PLAIN_EVENTS = [
  assistantTextEvent("working on the task, no verify output yet"),
];

// Negative case fixtures
const AUTOPILOT_IN_TOOL_ONLY = [
  assistantTextEvent("working..."),
  otherToolEvent("write", "AUTOPILOT_TASK_RESULT={\"status\":\"done\"}"),
];
const EARLIER_PASS_LATER_FAIL = [
  assistantTextEvent("first attempt"),
  bashEvent(0, "5 tests passed\n"),
  assistantTextEvent("second attempt"),
  bashEvent(1, "2 tests passed\n3 tests failed\n"),
];
const ZERO_TESTS_PASSED = [
  assistantTextEvent("running verify"),
  bashEvent(0, "0 tests passed\n"),
];
const VERIFY_ONLY_IN_STDERR = [
  assistantTextEvent("working..."),
  {type: "stderr", text: "5 tests passed\n"},
];
const MULTIPLE_BASH_LATEST_FAILS = [
  assistantTextEvent("start"),
  bashEvent(0, "10 tests passed\n"),
  assistantTextEvent("retry"),
  bashEvent(0, "0 tests passed\n"),
];

const LOOPS = [
  {label: "standalone", taskRef: "3.3"},
  {label: "speckit", taskRef: "T001"},
];
check("loops: both loops under test with distinct task refs",
  LOOPS[0].taskRef !== LOOPS[1].taskRef && LOOPS.length === 2);

for (const {label, taskRef} of LOOPS) {
  // ── Breach-while-finishing within bounds: completes, no rollover ──
  {
    let window = null;
    const t1 = tickGraceUnit({usage: turnUsage(GRACE_CAPS.perTaskMaxTurns + 1), caps: GRACE_CAPS, events: FINISH_EVENTS_RESULT_LINE, graceWindow: window});
    window = t1.graceWindow;
    check(`${label} (${taskRef}): finishing breach (result line) defers the kill (no marker, no rollover)`,
      t1.graceDeferred === true && t1.capBreach === null && t1.killed === false && window !== null, t1);
    check(`${label} (${taskRef}): granted window carries +3-turn/+10% ceilings`,
      window?.turnCeiling === GRACE_CAPS.perTaskMaxTurns + 3 && window?.tokenCeiling === GRACE_TOKEN_CEILING, window);
    const t2 = tickGraceUnit({usage: turnUsage(GRACE_CAPS.perTaskMaxTurns + 3), caps: GRACE_CAPS, events: FINISH_EVENTS_RESULT_LINE, graceWindow: window});
    window = t2.graceWindow;
    check(`${label} (${taskRef}): finishing session stays deferred at the window edge`,
      t2.graceDeferred === true && t2.capBreach === null && t2.killed === false, t2);
    // Session finishes inside the window: no breach marker, so the result
    // carries neither capped nor wrapUp and the per-task loop commits
    // instead of rolling over.
    const result = {status: "completed", taskRef};
    const capped = cappedRecord(t2.capBreach);
    if (capped) result.capped = capped;
    check(`${label} (${taskRef}): within-bounds finish completes with result.capped/wrapUp absent`,
      result.capped === undefined && result.wrapUp === undefined && result.status === "completed", result);
  }
  // ── Breach-while-finishing with verify-passed within bounds ──
  {
    let window = null;
    const t1 = tickGraceUnit({usage: turnUsage(GRACE_CAPS.perTaskMaxTurns + 1), caps: GRACE_CAPS, events: FINISH_EVENTS_VERIFY_PASSED, graceWindow: window});
    window = t1.graceWindow;
    check(`${label} (${taskRef}): finishing breach (verify passed) defers the kill`,
      t1.graceDeferred === true && t1.capBreach === null && t1.killed === false && window !== null, t1);
    const t2 = tickGraceUnit({usage: turnUsage(GRACE_CAPS.perTaskMaxTurns + 3), caps: GRACE_CAPS, events: FINISH_EVENTS_VERIFY_PASSED, graceWindow: window});
    window = t2.graceWindow;
    check(`${label} (${taskRef}): verify-passed session stays deferred at the window edge`,
      t2.graceDeferred === true && t2.capBreach === null && t2.killed === false, t2);
    const result = {status: "completed", taskRef};
    const capped = cappedRecord(t2.capBreach);
    if (capped) result.capped = capped;
    check(`${label} (${taskRef}): verify-passed within-bounds finish completes cleanly`,
      result.capped === undefined && result.wrapUp === undefined && result.status === "completed", result);
  }
  // ── Breach-while-finishing with both evidence types within bounds ──
  {
    let window = null;
    const t1 = tickGraceUnit({usage: turnUsage(GRACE_CAPS.perTaskMaxTurns + 1), caps: GRACE_CAPS, events: FINISH_EVENTS_BOTH, graceWindow: window});
    window = t1.graceWindow;
    check(`${label} (${taskRef}): finishing breach (both evidence) defers the kill`,
      t1.graceDeferred === true && t1.capBreach === null && t1.killed === false && window !== null, t1);
    const t2 = tickGraceUnit({usage: turnUsage(GRACE_CAPS.perTaskMaxTurns + 3), caps: GRACE_CAPS, events: FINISH_EVENTS_BOTH, graceWindow: window});
    window = t2.graceWindow;
    check(`${label} (${taskRef}): both-evidence session stays deferred at the window edge`,
      t2.graceDeferred === true && t2.capBreach === null && t2.killed === false, t2);
    const result = {status: "completed", taskRef};
    const capped = cappedRecord(t2.capBreach);
    if (capped) result.capped = capped;
    check(`${label} (${taskRef}): both-evidence within-bounds finish completes cleanly`,
      result.capped === undefined && result.wrapUp === undefined && result.status === "completed", result);
  }
  // ── Breach-past-turn-bounds caps exactly as today ──
  {
    let window = null;
    const t1 = tickGraceUnit({usage: turnUsage(GRACE_CAPS.perTaskMaxTurns + 1), caps: GRACE_CAPS, events: FINISH_EVENTS_RESULT_LINE, graceWindow: window});
    window = t1.graceWindow;
    const t2 = tickGraceUnit({usage: turnUsage(GRACE_CAPS.perTaskMaxTurns + 4), caps: GRACE_CAPS, events: FINISH_EVENTS_RESULT_LINE, graceWindow: window});
    check(`${label} (${taskRef}): finishing session past +3 turns caps (kill fires)`,
      t2.graceDeferred === false && t2.capBreach !== null && t2.killed === true, t2);
    const capped = cappedRecord(t2.capBreach);
    check(`${label} (${taskRef}): past-turns cap keeps the capped shape (wrapUp + trigger)`,
      capped?.type === "turns" && capped?.used === GRACE_CAPS.perTaskMaxTurns + 4 && capped?.limit === GRACE_CAPS.perTaskMaxTurns
      && capped?.wrapUp === true && capped?.trigger === "turns", capped);
    const result = {status: "killed", taskRef, capped, wrapUp: {status: "ok", trigger: capped.trigger, wrapRun: "run-1"}};
    check(`${label} (${taskRef}): past-turns rollover keeps the wrapUp shape (trigger intact)`,
      result.wrapUp?.status === "ok" && result.wrapUp?.trigger === "turns" && typeof result.wrapUp?.wrapRun === "string", result.wrapUp);
  }
  // ── Breach-past-token-bounds caps exactly as today ──
  {
    let window = null;
    const t1 = tickGraceUnit({usage: turnUsage(GRACE_CAPS.perTaskMaxTurns + 1), caps: GRACE_CAPS, events: FINISH_EVENTS_RESULT_LINE, graceWindow: window});
    window = t1.graceWindow;
    const t2 = tickGraceUnit({usage: turnUsage(1, GRACE_TOKEN_CEILING + 1), caps: GRACE_CAPS, events: FINISH_EVENTS_RESULT_LINE, graceWindow: window});
    check(`${label} (${taskRef}): finishing session past +10% tokens caps (kill fires)`,
      t2.graceDeferred === false && t2.capBreach !== null && t2.killed === true, t2);
    const capped = cappedRecord(t2.capBreach);
    check(`${label} (${taskRef}): past-tokens cap keeps the capped shape (wrapUp + trigger)`,
      capped?.type === "tokens" && capped?.wrapUp === true && capped?.trigger === "tokens", capped);
  }
  // ── Breach-while-not-finishing caps immediately ──
  {
    const t1 = tickGraceUnit({usage: turnUsage(GRACE_CAPS.perTaskMaxTurns + 1), caps: GRACE_CAPS, events: PLAIN_EVENTS, graceWindow: null});
    check(`${label} (${taskRef}): non-finishing breach caps on the first tick (no deferral)`,
      t1.graceDeferred === false && t1.capBreach !== null && t1.killed === true && t1.graceWindow === null, t1);
    const capped = cappedRecord(t1.capBreach);
    check(`${label} (${taskRef}): immediate cap keeps the capped shape (wrapUp + trigger)`,
      capped?.type === "turns" && capped?.used === GRACE_CAPS.perTaskMaxTurns + 1 && capped?.limit === GRACE_CAPS.perTaskMaxTurns
      && capped?.wrapUp === true && capped?.trigger === "turns", capped);
    const result = {status: "killed", taskRef, capped, wrapUp: {status: "ok", trigger: capped.trigger, wrapRun: "run-1"}};
    check(`${label} (${taskRef}): immediate-cap rollover keeps the wrapUp shape`,
      result.wrapUp?.trigger === "turns" && result.wrapUp?.status === "ok", result.wrapUp);
  }
  // ── Negative: AUTOPILOT_TASK_RESULT only in tool output (not assistant text) ──
  {
    const t1 = tickGraceUnit({usage: turnUsage(GRACE_CAPS.perTaskMaxTurns + 1), caps: GRACE_CAPS, events: AUTOPILOT_IN_TOOL_ONLY, graceWindow: null});
    check(`${label} (${taskRef}): AUTOPILOT_TASK_RESULT in tool output only → no grace (caps immediately)`,
      t1.graceDeferred === false && t1.capBreach !== null && t1.killed === true && t1.graceWindow === null, t1);
    const capped = cappedRecord(t1.capBreach);
    check(`${label} (${taskRef}): tool-only result line yields immediate cap shape`,
      capped?.wrapUp === true && capped?.trigger === "turns", capped);
  }
  // ── Negative: earlier passing bash followed by later failing one ──
  {
    const t1 = tickGraceUnit({usage: turnUsage(GRACE_CAPS.perTaskMaxTurns + 1), caps: GRACE_CAPS, events: EARLIER_PASS_LATER_FAIL, graceWindow: null});
    check(`${label} (${taskRef}): earlier pass then later fail → no grace (latest bash failed)`,
      t1.graceDeferred === false && t1.capBreach !== null && t1.killed === true && t1.graceWindow === null, t1);
    const capped = cappedRecord(t1.capBreach);
    check(`${label} (${taskRef}): stale pass ignored yields immediate cap shape`,
      capped?.wrapUp === true && capped?.trigger === "turns", capped);
  }
  // ── Negative: "0 tests passed" must be ineligible ──
  {
    const t1 = tickGraceUnit({usage: turnUsage(GRACE_CAPS.perTaskMaxTurns + 1), caps: GRACE_CAPS, events: ZERO_TESTS_PASSED, graceWindow: null});
    check(`${label} (${taskRef}): "0 tests passed" → no grace (caps immediately)`,
      t1.graceDeferred === false && t1.capBreach !== null && t1.killed === true && t1.graceWindow === null, t1);
    const capped = cappedRecord(t1.capBreach);
    check(`${label} (${taskRef}): zero-tests cap shape intact`,
      capped?.wrapUp === true && capped?.trigger === "turns", capped);
  }
  // ── Negative: verify only in stderr (not bash tool result) ──
  {
    const t1 = tickGraceUnit({usage: turnUsage(GRACE_CAPS.perTaskMaxTurns + 1), caps: GRACE_CAPS, events: VERIFY_ONLY_IN_STDERR, graceWindow: null});
    check(`${label} (${taskRef}): pass line only in stderr → no grace (caps immediately)`,
      t1.graceDeferred === false && t1.capBreach !== null && t1.killed === true && t1.graceWindow === null, t1);
    const capped = cappedRecord(t1.capBreach);
    check(`${label} (${taskRef}): stderr-only verify yields immediate cap shape`,
      capped?.wrapUp === true && capped?.trigger === "turns", capped);
  }
  // ── Negative: multiple bash results, latest fails ──
  {
    const t1 = tickGraceUnit({usage: turnUsage(GRACE_CAPS.perTaskMaxTurns + 1), caps: GRACE_CAPS, events: MULTIPLE_BASH_LATEST_FAILS, graceWindow: null});
    check(`${label} (${taskRef}): multiple bash, latest exits 0 but "0 tests passed" → no grace`,
      t1.graceDeferred === false && t1.capBreach !== null && t1.killed === true && t1.graceWindow === null, t1);
    const capped = cappedRecord(t1.capBreach);
    check(`${label} (${taskRef}): latest bash zero-pass yields immediate cap shape`,
      capped?.wrapUp === true && capped?.trigger === "turns", capped);
  }
}

// ── 031 Phase 10.2: review-role grace window (22 turns / 500K / 450K wrap-up) ──
// Every review/planning role resolves the same 22-turn / 500K-token cap with
// a 450K wrap-up threshold, and the shared grace gate (evaluateCaps in
// autopilot.mjs, driven by roleCaps) grants one +3-turn / +10%-token window
// (25 turns / 550K tokens) when finishing evidence is present. Wrap-up and
// hard-cap breaches alike defer inside the window and cap exactly as today
// outside it or without finishing evidence.
function tickRoleGraceUnit({usage, limits, events, graceWindow}) {
  // Mirrors the production evaluateCaps order: wrap-up trigger first, then
  // the hard cap; both gated on the same single grace window.
  const wrap = checkWrapupTrigger({usage, perTaskMaxTurns: limits.perTaskMaxTurns, perTaskMaxTokens: limits.perTaskMaxTokens, wrapupTokens: limits.wrapUpTokenThreshold});
  const breach = checkCapBreach({usage, perTaskMaxTurns: limits.perTaskMaxTurns, perTaskMaxTokens: limits.perTaskMaxTokens});
  const pending = wrap ?? breach;
  if (!pending) return {capBreach: null, graceDeferred: false, graceWindow, killed: false};
  let graceDeferred = false;
  let nextWindow = graceWindow;
  if (graceWindow) {
    const graceTurns = usage.turns;
    const graceGrowing = growingTerm(usage);
    const withinTurns = Number.isInteger(graceTurns) && Number.isInteger(graceWindow.turnCeiling) && graceTurns <= graceWindow.turnCeiling;
    const withinTokens = Number.isFinite(graceGrowing) && Number.isFinite(graceWindow.tokenCeiling) && graceGrowing <= graceWindow.tokenCeiling;
    if (withinTurns && withinTokens) graceDeferred = true;
  } else {
    const graceEvidence = capGraceFinishingEvidenceMirror(events);
    const graceDecision = evaluateCapGraceWindow({verifyPassed: graceEvidence.verifyPassed, writingFinalResult: graceEvidence.writingFinalResult, graceUsed: graceWindow !== null, turnsUsed: usage.turns, perTaskMaxTurns: limits.perTaskMaxTurns, tokensUsed: growingTerm(usage), perTaskMaxTokens: limits.perTaskMaxTokens});
    if (graceDecision.granted) {
      nextWindow = {turnCeiling: graceDecision.turnCeiling, tokenCeiling: graceDecision.tokenCeiling};
      graceDeferred = true;
    }
  }
  if (graceDeferred) return {capBreach: null, graceDeferred: true, graceWindow: nextWindow, killed: false};
  return {capBreach: {type: pending.type, used: pending.used, limit: pending.limit, usage, wrapUp: true, trigger: pending.type}, graceDeferred: false, graceWindow: nextWindow, killed: true};
}

{
  const REVIEW_ROLES_031 = ["code_reviewer", "verifier", "planner", "plan_reviewer"];
  const roleTurnUsage = (turns, growing = 10_000) => ({turns, cacheRead: growing, input: 0});
  for (const role of REVIEW_ROLES_031) {
    const limits = resolvePerRoleLimits(role, {});
    const expTokens = role === "planner" ? 200_000 : role === "plan_reviewer" ? 250_000 : 150_000;
    const expWrapup = role === "planner" ? 180_000 : role === "plan_reviewer" ? 225_000 : 135_000;
    const expTokenCeiling = Math.ceil(expTokens * 1.1);
    const T = (role === "verifier" || role === "planner" || role === "plan_reviewer") ? 30 : 22; // backlog #59(b), #111: verifier/planner/plan_reviewer turn default 30
    check(`grace/${role}: defaults are ${T} turns / ${expTokens} tokens / ${expWrapup} wrap-up`,
      limits.perTaskMaxTurns === T && limits.perTaskMaxTokens === expTokens && limits.wrapUpTokenThreshold === expWrapup, limits);
    // Pure decision: finishing breach at 23 turns grants the single window
    // with +3-turn / +10%-token ceilings (25 turns / 165K tokens, 275K for
    // plan_reviewer, 220K for planner).
    const grant = evaluateCapGraceWindow({verifyPassed: true, writingFinalResult: false, graceUsed: false, turnsUsed: T + 1, perTaskMaxTurns: limits.perTaskMaxTurns, tokensUsed: 10_000, perTaskMaxTokens: limits.perTaskMaxTokens});
    check(`grace/${role}: finishing breach at ${T + 1} turns grants window with ${T + 3}-turn/${expTokenCeiling} ceilings`,
      grant.granted === true && grant.turnCeiling === T + 3 && grant.tokenCeiling === expTokenCeiling, grant);
    // Live tick: grant defers the kill with no marker.
    let window = null;
    const t1 = tickRoleGraceUnit({usage: roleTurnUsage(T + 1), limits, events: FINISH_EVENTS_RESULT_LINE, graceWindow: window});
    window = t1.graceWindow;
    check(`grace/${role}: finishing breach (result line) defers the kill (no marker)`,
      t1.graceDeferred === true && t1.capBreach === null && t1.killed === false && window !== null, t1);
    check(`grace/${role}: granted window carries +3-turn/+10% ceilings`,
      window?.turnCeiling === T + 3 && window?.tokenCeiling === expTokenCeiling, window);
    // Deferred at the window edge (25 turns still inside).
    const t2 = tickRoleGraceUnit({usage: roleTurnUsage(T + 3), limits, events: FINISH_EVENTS_RESULT_LINE, graceWindow: window});
    check(`grace/${role}: finishing session stays deferred at the window edge (${T + 3} turns)`,
      t2.graceDeferred === true && t2.capBreach === null && t2.killed === false, t2);
    // Past the window (26 turns) caps exactly as today.
    const t3 = tickRoleGraceUnit({usage: roleTurnUsage(T + 4), limits, events: FINISH_EVENTS_RESULT_LINE, graceWindow: window});
    check(`grace/${role}: finishing session past +3 turns caps (kill fires)`,
      t3.graceDeferred === false && t3.capBreach !== null && t3.killed === true
      && t3.capBreach.wrapUp === true && t3.capBreach.trigger === "turns", t3);
    // Past the token ceiling caps exactly as today.
    const t4 = tickRoleGraceUnit({usage: roleTurnUsage(1, expTokenCeiling + 1), limits, events: FINISH_EVENTS_RESULT_LINE, graceWindow: window});
    check(`grace/${role}: finishing session past +10% tokens caps (kill fires)`,
      t4.graceDeferred === false && t4.capBreach !== null && t4.killed === true
      && t4.capBreach.wrapUp === true && t4.capBreach.trigger === "tokens", t4);
    // Non-finishing breach caps immediately (no window).
    const t5 = tickRoleGraceUnit({usage: roleTurnUsage(T + 1), limits, events: PLAIN_EVENTS, graceWindow: null});
    check(`grace/${role}: non-finishing breach caps on the first tick (no deferral)`,
      t5.graceDeferred === false && t5.capBreach !== null && t5.killed === true && t5.graceWindow === null, t5);
    // Wrap-up threshold (450K raw, 950K for planner) with finishing evidence defers via grace.
    const t6 = tickRoleGraceUnit({usage: roleTurnUsage(1, expWrapup), limits, events: FINISH_EVENTS_RESULT_LINE, graceWindow: null});
    check(`grace/${role}: wrap-up trigger at ${expWrapup} raw with finishing evidence defers (no marker)`,
      t6.graceDeferred === true && t6.capBreach === null && t6.killed === false && t6.graceWindow !== null, t6);
  }
  // Wiring: the shared grace gate evaluates per-role caps (roleCaps), and the
  // capped review/planning relays run with capEnabled so the gate is active.
  check("grace: evaluation uses per-role caps (roleCaps turn/token ceilings)",
    /perTaskMaxTurns:roleCaps\.perTaskMaxTurns/.test(src)
    && /perTaskMaxTokens:roleCaps\.perTaskMaxTokens/.test(src));
  check("grace: planner relay runs capped (grace gate active)",
    /relayAsync\("planner"[\s\S]*?capEnabled:true/.test(src));
  check("grace: plan_reviewer relay runs capped (grace gate active)",
    /relayAsync\("plan_reviewer"[\s\S]*?capEnabled:true/.test(src));
  check("grace: verifier relay runs capped (grace gate active)",
    /relayAsync\("verifier"[\s\S]*?capEnabled:true/.test(src));
}

if (failures) {
  console.error(`${failures} cap-grace wiring check(s) failed.`);
  process.exit(1);
}
console.log("cap-grace wiring tests passed");