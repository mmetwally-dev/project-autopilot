#!/usr/bin/env node
// TASK-19 Phase 5 task 15 (PARTIAL) — per-task invocation budget.
//
// IMPLEMENTED AND VERIFIED HERE: the pure limit derivation, the
// orchestrator-side turn count, the redundant-verification detector, and the
// driver-backed `fake-observable-adapter.mjs` (task 14a) decoded through the
// real opencode driver.
//
// Backlog 003#15/003#16/003#17: mid-stream turn + token enforcement IS now
// implemented — runRelay() evaluates checkCapBreach() (unit-covered below)
// once per second against the live stream and kills the child on breach;
// the runRelay wiring itself (interval, kill, settle guard, result.capped,
// continuation hook) is static-covered in test-cap-breach-wiring.mjs because
// autopilot.mjs runs main() on import. Still observe-only, deliberately not
// asserted: mid-stream redundant-verification enforcement, and the
// spinning-role subprocess case with the orchestrator watchdog end to end
// (covered structurally by the tiny-ceiling fixture mission instead).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {
  resolvePerTaskLimits, countTurns, supportsTurnCount, evaluateTaskBudget,
  growingTerm, evaluateTokenCeiling, checkCapBreach,
  resolveContinuationAllowance, consumeContinuation, clearTaskContinuation,
  clearStaleStandaloneContinuations,
  recordRolloverDeadEnd, readRolloverDeadEnds, clearRolloverDeadEnds, deadEndTail,
  resolveHandoffNoteMaxChars, handoffNoteRelPath, continuationBudgetKey,
  resolveHandoffWrapupTokens, checkWrapupTrigger, buildWrapUpPrompt,
  sessionStoreRelDir, sessionStoreSandboxSubpath,
  detectRedundantVerification, PER_TASK_TIMEOUT_DEFAULT_MS, PER_TASK_MAX_TURNS_DEFAULT,
  PER_TASK_MAX_TOKENS_DEFAULT, CONTINUATION_ALLOWANCE_DEFAULT,
  DEAD_ENDS_MAX_ENTRIES, HANDOFF_MAX_CHARS_DEFAULT,
  HANDOFF_NOTE_MAX_CHARS_DEFAULT, HANDOFF_NOTE_MIN_CHARS,
  HANDOFF_WRAPUP_TOKENS_DEFAULT, WRAPUP_MAX_TURNS, WRAPUP_TIMEOUT_MS,
  SESSION_STORE_WARN_BYTES,
  recordGenerationProgress, clearNoProgress, resolveNoProgressGenerations, NO_PROGRESS_GENERATIONS_DEFAULT,
  handoffNoteCitedExcerpts, noteNextSection,
  NOTE_EXCERPT_MAX_RANGES, NOTE_EXCERPT_CONTEXT, NOTE_EXCERPT_MAX_LINES, NOTE_EXCERPT_MAX_CHARS,
  resolvePerRoleLimits, PER_ROLE_CAPS_DEFAULT, PER_ROLE_WRAPUP_TOKENS_DEFAULT,
  resolveContinuationAllowanceForRole,
  buildOrchestratorFallbackNote, FALLBACK_NOTE_DIFF_MAX_CHARS,
  describeCutContext, renderCutContextSection,
  scratchHandoffNotePath, pickFresherHandoffNote,
  SCRATCH_HANDOFF_NOTE_DEFAULT_DIR, CUT_CONTEXT_SECTION_MAX_CHARS,
} from "./per-task-budget.mjs";
import {adapterDriver, accumulateUsage} from "./adapter-drivers.mjs";
import {defaultOpenCodeCacheRoot} from "./opencode-cache.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, evidence) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(evidence)}` : ""}`);
  failed += 1;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "test-fixtures", "fake-observable-adapter.mjs");

// ── Pure: limit derivation ───────────────────────────────────────────────
{
  const defaults = resolvePerTaskLimits({});
  check("limits: defaults are 30m / 40 turns",
    defaults.perTaskTimeoutMs === PER_TASK_TIMEOUT_DEFAULT_MS &&
    defaults.perTaskMaxTurns === PER_TASK_MAX_TURNS_DEFAULT, defaults);
  check("limits: explicit values win",
    JSON.stringify(resolvePerTaskLimits({per_task_timeout_ms: 5000, per_task_max_turns: 7}, 60000)) ===
    JSON.stringify({perTaskTimeoutMs: 5000, perTaskMaxTurns: 7, perTaskMaxTokens: PER_TASK_MAX_TOKENS_DEFAULT, relayTimeoutMs: 60000}));
  check("limits: token ceiling explicit wins, default is 180K and turns default 40 (code defaults, #59b)",
    resolvePerTaskLimits({per_task_max_tokens: 123}).perTaskMaxTokens === 123 &&
    resolvePerTaskLimits({}).perTaskMaxTokens === PER_TASK_MAX_TOKENS_DEFAULT &&
    PER_TASK_MAX_TOKENS_DEFAULT === 180000 &&
    resolvePerTaskLimits({}).perTaskMaxTurns === 40 && PER_TASK_MAX_TURNS_DEFAULT === 40);
  check("limits: low relay timeout degrades instead of failing",
    resolvePerTaskLimits({}, 2000).perTaskTimeoutMs === 1999, resolvePerTaskLimits({}, 2000));
  check("limits: default stays strictly below the relay backstop",
    resolvePerTaskLimits({}).perTaskTimeoutMs < resolvePerTaskLimits({}).relayTimeoutMs);
}

// ── Pure: turn counting ──────────────────────────────────────────────────
{
  const opencode = [
    {type: "step_start"}, {type: "text"}, {type: "step_finish"}, {type: "step_finish"},
  ];
  check("turns: opencode counts each step_finish", countTurns("opencode", opencode) === 2);
  const claude = [{type: "assistant"}, {type: "assistant"}, {type: "result"}];
  check("turns: claude counts each assistant event", countTurns("claude", claude) === 2);
  check("turns: an adapter with no per-turn event returns null, never 0",
    countTurns("codex", [{type: "item.completed"}]) === null);
  check("turns: support is explicit",
    supportsTurnCount("opencode") && supportsTurnCount("claude") && !supportsTurnCount("codex"));
  check("budget: exceeding the cap is flagged", evaluateTaskBudget({adapterId: "opencode", turns: 41, maxTurns: 40}).exceeded === true);
  check("budget: at the cap is not exceeded", evaluateTaskBudget({adapterId: "opencode", turns: 40, maxTurns: 40}).exceeded === false);
  check("budget: unsupported adapter is not enforceable",
    evaluateTaskBudget({adapterId: "codex", turns: 99, maxTurns: 40}).enforceable === false);
}

// Pure: token ceiling (growing term: maxSingleTurnContext, fallback cacheRead + input + cacheCreation)
{
  const usage = {input: 2000000, cacheCreation: 100, cacheRead: 9000000, output: 50000, turns: 10, maxSingleTurnContext: 11000000};
  check("ceiling: growing term prefers maxSingleTurnContext",
    growingTerm(usage) === 11000000, growingTerm(usage));
  check("ceiling: fallback sums cacheRead + input when maxSingleTurnContext is absent",
    growingTerm({cacheRead: 9000000, input: 2000000}) === 11000000, growingTerm({cacheRead: 9000000, input: 2000000}));
  check("ceiling: null usage is never zero", growingTerm(null) === null);
  check("ceiling: breach above the max",
    evaluateTokenCeiling({usage, maxTokens: 10000000}).exceeded === true);
  check("ceiling: at the max is not exceeded",
    evaluateTokenCeiling({usage: {...usage, maxSingleTurnContext: 10000000}, maxTokens: 10000000}).exceeded === false);
  check("ceiling: missing usage is unenforceable, never free",
    evaluateTokenCeiling({usage: null, maxTokens: 10000000}).enforceable === false);
}

// Pure: breach decision (what runRelay's monitor evaluates)
{
  const over = {input: 1, cacheCreation: 0, cacheRead: 1, output: 1, turns: 41};
  const b1 = checkCapBreach({usage: over, perTaskMaxTurns: 40, perTaskMaxTokens: 10000000});
  check("breach: turn breach reports turns with used/limit",
    b1?.type === "turns" && b1.used === 41 && b1.limit === 40, b1);
  const heavy = {input: 2000000, cacheCreation: 0, cacheRead: 9000000, output: 1, turns: 5};
  const b2 = checkCapBreach({usage: heavy, perTaskMaxTurns: 40, perTaskMaxTokens: 10000000});
  check("breach: token breach reports growing used",
    b2?.type === "tokens" && b2.used === 11000000 && b2.limit === 10000000, b2);
  check("breach: turns win when both violated",
    checkCapBreach({usage: {...heavy, turns: 41}, perTaskMaxTurns: 40, perTaskMaxTokens: 10000000})?.type === "turns");
  check("breach: under both is null",
    checkCapBreach({usage: {input: 1, cacheCreation: 0, cacheRead: 1, output: 1, turns: 5}, perTaskMaxTurns: 40, perTaskMaxTokens: 10000000}) === null);
  check("breach: null usage is null, never a breach",
    checkCapBreach({usage: null, perTaskMaxTurns: 40, perTaskMaxTokens: 10000000}) === null);
  // Mission 044 Phase 1 task 1.4: cumulative tokens don't trigger breach; only maxSingleTurnContext matters.
  // Built from 30 opencode step_finish events of 35K through the real accumulator:
  // the session really totals 1.05M cumulative tokens, but the largest single
  // turn is only 35K, so neither the 150K review-role cap nor the 135K wrap-up
  // threshold may fire. Without maxSingleTurnContext the same fixture's
  // cumulative fallback term is 1.05M and WOULD breach — that is what makes
  // this a discriminating case rather than a tautology.
  const stepEvents = Array.from({length: 30}, () => ({
    type: "step_finish",
    part: {type: "step-finish", tokens: {input: 35000, output: 500, reasoning: 0, cache: {read: 0, write: 0}}},
  }));
  const cumulativeHeavy = accumulateUsage("opencode", stepEvents);
  check("breach: 30×35K fixture really is 1.05M cumulative with maxSingleTurnContext 35K",
    cumulativeHeavy?.turns === 30 && cumulativeHeavy.input === 1050000
    && cumulativeHeavy.maxSingleTurnContext === 35000
    && growingTerm({...cumulativeHeavy, maxSingleTurnContext: undefined}) === 1050000, cumulativeHeavy);
  const b3 = checkCapBreach({usage: cumulativeHeavy, perTaskMaxTurns: 40, perTaskMaxTokens: 150000});
  check("breach: 30×35K cumulative (1.05M) but maxSingleTurnContext 35K < 150K → no breach",
    b3 === null, b3);
  const w1 = checkWrapupTrigger({usage: cumulativeHeavy, perTaskMaxTurns: 40, perTaskMaxTokens: 150000, wrapupTokens: 135000});
  check("wrapup: 30×35K cumulative (1.05M) but maxSingleTurnContext 35K < 135K → no wrap-up",
    w1 === null, w1);
}

// Pure: continuation allowance (independent of failure budgets)
{
  check("continuation: default allowance is 5 (6 sessions in total)",
    resolveContinuationAllowance({}) === CONTINUATION_ALLOWANCE_DEFAULT &&
    CONTINUATION_ALLOWANCE_DEFAULT === 5);
  check("continuation: explicit wins",
    resolveContinuationAllowance({continuation_allowance: 1}) === 1);
  const s = {};
  const c1 = consumeContinuation(s, {}, "task:standalone:phase-0:T0");
  check("continuation: first consume allowed at used=1",
    c1.allowed === true && c1.used === 1 && c1.limit === 5, c1);
  for (let i = 0; i < 3; i++) consumeContinuation(s, {}, "task:standalone:phase-0:T0");
  const c5 = consumeContinuation(s, {}, "task:standalone:phase-0:T0");
  check("continuation: fifth consume still allowed (6th session)",
    c5.allowed === true && c5.used === 5, c5);
  const c6 = consumeContinuation(s, {}, "task:standalone:phase-0:T0");
  check("continuation: sixth consume exhausted",
    c6.allowed === false && c6.used === 6, c6);
  check("continuation: lives outside failureBudgets",
    s.failureBudgets === undefined && s.continuationBudgets["continuationAllowance:task:standalone:phase-0:T0"] === 6);
  check("continuation: per-task keys are independent",
    consumeContinuation(s, {}, "task:standalone:phase-0:T1").used === 1);
  check("continuation: clear on task success",
    clearTaskContinuation(s, "task:standalone:phase-0:T1") === true &&
    s.continuationBudgets["continuationAllowance:task:standalone:phase-0:T1"] === undefined);
  check("continuation: stale standalone sweep",
    clearStaleStandaloneContinuations(s) === 1 &&
    s.continuationBudgets["continuationAllowance:task:standalone:phase-0:T0"] === undefined);
}

// Pure: bounded dead-ends list
{
  const s = {};
  recordRolloverDeadEnd(s, "t", {generation: 1, reason: "turns", used: 41, limit: 40, tail: "ok"});
  check("deadends: one entry recorded",
    readRolloverDeadEnds(s, "t").length === 1);
  recordRolloverDeadEnd(s, "t", {generation: 2, reason: "tokens", used: 11, limit: 10, tail: "x".repeat(900)});
  const list = readRolloverDeadEnds(s, "t");
  check("deadends: stored tail bounded (single per-entry handoff backstop)",
    list[1].tail.length <= HANDOFF_MAX_CHARS_DEFAULT && HANDOFF_MAX_CHARS_DEFAULT === 2000);
  for (let i = 0; i < 10; i++) recordRolloverDeadEnd(s, "t", {generation: i, reason: "turns", used: 1, limit: 1, tail: "z"});
  check("deadends: list bounded to 5 entries",
    readRolloverDeadEnds(s, "t").length === DEAD_ENDS_MAX_ENTRIES && DEAD_ENDS_MAX_ENTRIES === 5);
  check("deadends: clear works",
    clearRolloverDeadEnds(s, "t") === true && readRolloverDeadEnds(s, "t").length === 0);
  check("deadends: files lead, summary follows",
    deadEndTail({summary: "created 8-10, 30 remaining", files: ["a.txt", "b.txt"], outputTail: "noise"}) === "files completed this generation: a.txt, b.txt | created 8-10, 30 remaining");
  check("deadends: files without summary",
    deadEndTail({files: ["a.txt"], outputTail: ""}) === "files completed this generation: a.txt");
  check("deadends: summary alone when no files",
    deadEndTail({summary: "stopped early", files: []}) === "stopped early");
  check("deadends: empty without content", deadEndTail({}) === "");
  check("deadends: long file list truncated with count",
    deadEndTail({files: Array.from({length: 25}, (_, i) => `f${i}.txt`)}).includes("(+15 more)"));
  check("deadends: files line survives a full-length output tail (truncation regression)",
    deadEndTail({files: ["a.txt", "b.txt", "c.txt"], outputTail: "z".repeat(2000)}).startsWith("files completed this generation: a.txt, b.txt, c.txt"));
  check("deadends: single per-entry bound from the front (files-first survives)",
    deadEndTail({files: ["a.txt"], outputTail: "z".repeat(5000)}).startsWith("files completed this generation: a.txt")
    && deadEndTail({files: ["a.txt"], outputTail: "z".repeat(5000)}).length <= HANDOFF_MAX_CHARS_DEFAULT);
  check("deadends: operator maxChars shortens the entry",
    deadEndTail({files: ["a.txt"], outputTail: "y".repeat(1500), maxChars: 800}).length <= 800);
}

// ── Backlog #26 Step A: hand-off note path + limit ───────────────────────
{
  check("note: default limit is 4000 with floor 1000",
    HANDOFF_NOTE_MAX_CHARS_DEFAULT === 4000 && HANDOFF_NOTE_MIN_CHARS === 1000
    && resolveHandoffNoteMaxChars({}) === 4000);
  check("note: operator override wins",
    resolveHandoffNoteMaxChars({handoff_note_max_chars: 1500}) === 1500);
  check("note: below-floor and non-integer fall back to the default, never unbounded",
    resolveHandoffNoteMaxChars({handoff_note_max_chars: 999}) === 4000
    && resolveHandoffNoteMaxChars({handoff_note_max_chars: "lots"}) === 4000);
  check("note: one path per task from the display ref",
    handoffNoteRelPath("001-cap", "T2.2") === ".autopilot/missions/001-cap/handoff/T2.2.md");
  check("note: ref made filename-safe",
    handoffNoteRelPath("001-cap", "T 2/2?a") === ".autopilot/missions/001-cap/handoff/T-2-2-a.md");
  check("note: continuation key builder matches the ledger",
    continuationBudgetKey("task:standalone:phase-1:X") === "continuationAllowance:task:standalone:phase-1:X");
}

// ── Backlog #26 Step B: forced wrap-up trigger (fixed 160K, not a turn %) ─
{
  check("wrapup: default is 160000 with ceiling constants",
    HANDOFF_WRAPUP_TOKENS_DEFAULT === 160000
    && WRAPUP_MAX_TURNS === 3 && WRAPUP_TIMEOUT_MS === 180000
    && SESSION_STORE_WARN_BYTES === 50 * 1024 * 1024);
  check("wrapup: default resolves below the 180K cap",
    resolveHandoffWrapupTokens({}, 180000) === 160000
    && resolveHandoffWrapupTokens({}, PER_TASK_MAX_TOKENS_DEFAULT) === 160000);
  check("wrapup: operator override wins when below the ceiling",
    resolveHandoffWrapupTokens({handoff_wrapup_tokens: 100000}, 180000) === 100000);
  check("wrapup: at/above-ceiling and invalid values fall back to the default, never disable",
    resolveHandoffWrapupTokens({handoff_wrapup_tokens: 180000}, 180000) === 160000
    && resolveHandoffWrapupTokens({handoff_wrapup_tokens: 200000}, 180000) === 160000
    && resolveHandoffWrapupTokens({handoff_wrapup_tokens: 0}, 180000) === 160000
    && resolveHandoffWrapupTokens({handoff_wrapup_tokens: "lots"}, 180000) === 160000);
  const below = {input: 50000, cacheCreation: 0, cacheRead: 100000, output: 1, turns: 5, maxSingleTurnContext: 150000};
  check("wrapup: per-turn term below 160K is no trigger",
    checkWrapupTrigger({usage: below, perTaskMaxTurns: 22, perTaskMaxTokens: 180000, wrapupTokens: 160000}) === null);
  const at = {input: 60000, cacheCreation: 0, cacheRead: 100000, output: 1, turns: 5, maxSingleTurnContext: 160000};
  check("wrapup: per-turn term at/above 160K triggers tokens with used/limit",
    (() => { const t = checkWrapupTrigger({usage: at, perTaskMaxTurns: 22, perTaskMaxTokens: 180000, wrapupTokens: 160000});
      return t?.type === "tokens" && t.used === 160000 && t.limit === 160000; })());
  check("wrapup: 180K hard-cap path unchanged (fires at the ceiling, not the threshold)",
    checkCapBreach({usage: at, perTaskMaxTurns: 22, perTaskMaxTokens: 180000}) === null
    && checkCapBreach({usage: {...at, maxSingleTurnContext: 180001}, perTaskMaxTurns: 22, perTaskMaxTokens: 180000})?.type === "tokens");
  check("wrapup: turn-cap breach before 160K triggers turns too",
    (() => { const t = checkWrapupTrigger({usage: {input: 1, cacheCreation: 0, cacheRead: 1, output: 1, turns: 23, maxSingleTurnContext: 2}, perTaskMaxTurns: 22, perTaskMaxTokens: 180000, wrapupTokens: 160000});
      return t?.type === "turns" && t.used === 23 && t.limit === 22; })());
  check("wrapup: turns win when both violated (same order as the cap)",
    checkWrapupTrigger({usage: {...at, turns: 23}, perTaskMaxTurns: 22, perTaskMaxTokens: 180000, wrapupTokens: 160000})?.type === "turns");
  check("wrapup: null usage is null, never a trigger",
    checkWrapupTrigger({usage: null, perTaskMaxTurns: 22, perTaskMaxTokens: 180000, wrapupTokens: 160000}) === null);
  // Mission 044 Phase 1 task 1.4: single turn exceeding review role cap triggers both breach and wrap-up.
  const overCap = {input: 100000, cacheCreation: 0, cacheRead: 100000, output: 1, turns: 1, maxSingleTurnContext: 200000};
  const b4 = checkCapBreach({usage: overCap, perTaskMaxTurns: 22, perTaskMaxTokens: 150000});
  check("breach: single turn 200K > 150K cap → token breach",
    b4?.type === "tokens" && b4.used === 200000 && b4.limit === 150000, b4);
  const w2 = checkWrapupTrigger({usage: overCap, perTaskMaxTurns: 22, perTaskMaxTokens: 150000, wrapupTokens: 135000});
  check("wrapup: single turn 200K > 135K wrap-up threshold → tokens trigger",
    w2?.type === "tokens" && w2.used === 200000 && w2.limit === 135000, w2);
  check("wrapup: prompt carries the exact path, limit, and four sections",
    (() => { const p = buildWrapUpPrompt(".autopilot/missions/001/handoff/T2.2.md", 4000);
      return p.includes("Write your hand-off note NOW to .autopilot/missions/001/handoff/T2.2.md")
        && p.includes("max 4000 characters") && p.includes("do NOT read more files")
        && p.includes("1. Done") && p.includes("2. Found") && p.includes("3. Next") && p.includes("4. Dead ends"); })());
  check("wrapup: session store dir mirrors the note vocabulary",
    sessionStoreRelDir("001-cap", "T2.2") === ".autopilot/missions/001-cap/sessions/T2.2"
    && sessionStoreRelDir("001-cap", "T 2/2?a") === ".autopilot/missions/001-cap/sessions/T-2-2-a");
  check("wrapup: only the adapter data dir is bound, never whole HOME",
    sessionStoreSandboxSubpath("opencode") === ".local/share/opencode"
    && sessionStoreSandboxSubpath("claude") === ".claude"
    && sessionStoreSandboxSubpath("codex") === null);
}

// ── Pure: redundant-verification detector ────────────────────────────────
{
  const attempt = (command) => ({type: "command_attempted", event: {part: {state: {input: {command}}}}});
  const failed = (command) => ({type: "command_failed", event: {part: {state: {input: {command}}}}});
  const writeObs = () => ({type: "write_attempted", event: {part: {state: {input: {filePath: "a.mjs"}}}}});

  const repeated = [attempt("npm test"), attempt("npm test"), attempt("npm test")];
  check("redundant: three identical successful commands are flagged at the second repeat",
    detectRedundantVerification({adapterId: "opencode", observations: repeated}).redundant === true,
    detectRedundantVerification({adapterId: "opencode", observations: repeated}));

  const withWrite = [attempt("npm test"), writeObs(), attempt("npm test"), writeObs(), attempt("npm test")];
  check("redundant: a re-run after a write is legitimate and NOT flagged",
    detectRedundantVerification({adapterId: "opencode", observations: withWrite}).redundant === false);

  // The real observer emits command_attempted and command_failed with the SAME
  // event object for one failed command, so the failed pair shares an event.
  const failedEvent = {part: {state: {input: {command: "npm test"}}}};
  const withFailure = [
    {type: "command_attempted", event: failedEvent},
    {type: "command_failed", event: failedEvent},
    attempt("npm test"), attempt("npm test"),
  ];
  check("redundant: an unproven success is never counted (failure clears the run)",
    detectRedundantVerification({adapterId: "opencode", observations: withFailure}).redundant === false);

  check("redundant: inert on an adapter with no command_failed signal",
    detectRedundantVerification({adapterId: "codex", observations: repeated}).redundant === false);
}

// ── Fixture (task 14a): driver-backed NDJSON through the real opencode driver ─
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-observable-"));
  const scenarioFile = path.join(dir, ".autopilot-test-scenario");
  const runFixture = (sc, args = ["run", "--format", "json"]) => {
    fs.writeFileSync(scenarioFile, sc);
    return spawnSync(process.execPath, [fixture, ...args], {cwd: dir, encoding: "utf8", input: "ROLE=implementer\n", timeout: 10000, shell: false});
  };

  const versionStart = Date.now();
  const version = runFixture("success", ["--version"]);
  check("fixture: --version answers immediately with a fixed string",
    version.status === 0 && /fake-opencode-observable/.test(version.stdout) && Date.now() - versionStart < 1000, version.stdout);

  const cacheRoot = defaultOpenCodeCacheRoot();
  const cacheExisted = fs.existsSync(cacheRoot);

  const driver = adapterDriver("opencode");
  check("fixture: the opencode driver is registered", driver !== null);

  const commandRun = runFixture("command_attempted_once");
  const commandEvents = driver.decodeEvents(commandRun.stdout, commandRun.stderr);
  const commandObs = driver.observe(commandEvents, {readPath: "", productionWritePath: "", outsideWritePath: ""});
  check("fixture: a run yields a non-empty observations array", commandObs.length > 0, commandObs.length);
  check("fixture: observations include command_attempted", commandObs.some((o) => o.type === "command_attempted"), commandObs.map((o) => o.type));

  const spinning = runFixture("spinning_turns");
  const spinningEvents = driver.decodeEvents(spinning.stdout, spinning.stderr);
  check("fixture: emitted step_finish count equals the scenario's turn count",
    countTurns("opencode", spinningEvents) === 45, countTurns("opencode", spinningEvents));

  const redundant = runFixture("redundant_command");
  const redundantObs = driver.observe(driver.decodeEvents(redundant.stdout, redundant.stderr), {readPath: "", productionWritePath: "", outsideWritePath: ""});
  check("fixture: the redundant-command scenario is detected end to end",
    detectRedundantVerification({adapterId: "opencode", observations: redundantObs}).redundant === true);

  if (!cacheExisted) {
    check("fixture: a full run creates nothing under the real OpenCode cache root", !fs.existsSync(cacheRoot), cacheRoot);
  } else {
    check("fixture: real OpenCode cache root already existed (not created by this fixture)", true);
  }
  fs.rmSync(dir, {recursive: true, force: true});
}

// ── Integration: the cache hazard is NOT yet exercised here ──────────────
// Task 14a's accept requires proving the fixture is safe while it actually
// drives ensureOpenCodeCacheSeeded(). That is deliberately NOT asserted here,
// because on native Windows it cannot be driven faithfully: the fixture is
// registered via a PATH shim, and `resolveOpenCodeVersion()` (opencode-cache.mjs)
// calls a raw `spawnSync(binary, ["--version"])` that cannot execute a `.cmd`
// shim without a shell — so the probe silently fails and the run hangs in
// seeding rather than exercising the contained path. The "real cache root
// untouched" check would then pass for the wrong reason, which is exactly the
// false-green shape this task warns against. The containment proof therefore
// belongs to a WSL/Linux or real-opencode-binary run; it is recorded in the
// task file's "Phase 5 remaining work" section rather than faked.

// ── Discovery ────────────────────────────────────────────────────────────
{
  const runner = fs.readFileSync(path.join(here, "test-all.mjs"), "utf8");
  check("discovery: test-per-task-budget.mjs matches the runner discovery regex",
    /^test-.*\.mjs$/.test("test-per-task-budget.mjs"));
  check("discovery: per-task-budget.mjs is not a runner candidate",
    !/^test-.*\.mjs$/.test("per-task-budget.mjs"));
  check("discovery: test-per-task-budget.mjs absent from both test-all exclusion sets",
    !runner.includes("test-per-task-budget.mjs"));
}

// ── Backlog #32: no-progress stop ──
{
  check("no-progress: default is 2 consecutive generations", NO_PROGRESS_GENERATIONS_DEFAULT === 2 && resolveNoProgressGenerations({}) === 2);
  check("no-progress: policy override accepted (integer >= 1), junk ignored",
    resolveNoProgressGenerations({no_progress_generations: 3}) === 3
    && resolveNoProgressGenerations({no_progress_generations: 0}) === 2
    && resolveNoProgressGenerations({no_progress_generations: "x"}) === 2);
  const st = {};
  const a = recordGenerationProgress(st, "task:standalone:phase-1:T", []);
  const b = recordGenerationProgress(st, "task:standalone:phase-1:T", undefined);
  check("no-progress: consecutive no-edit generations count up", a === 1 && b === 2, {a, b});
  const c = recordGenerationProgress(st, "task:standalone:phase-1:T", ["scripts/x.mjs"]);
  check("no-progress: an edit resets the count to 0",
    c === 0 && !(continuationBudgetKey("task:standalone:phase-1:T") in st.noProgressGenerations));
  recordGenerationProgress(st, "task:standalone:phase-1:T", []);
  recordGenerationProgress(st, "task:speckit:phase-1:U", []);
  check("no-progress: scopes are independent",
    st.noProgressGenerations[continuationBudgetKey("task:speckit:phase-1:U")] === 1
    && st.noProgressGenerations[continuationBudgetKey("task:standalone:phase-1:T")] === 1);
  clearTaskContinuation(st, "task:standalone:phase-1:T");
  check("no-progress: cleared with the task's continuation (completion path)",
    !(continuationBudgetKey("task:standalone:phase-1:T") in st.noProgressGenerations));
  check("no-progress: clearNoProgress reports what it removed",
    clearNoProgress(st, "task:speckit:phase-1:U") === true && clearNoProgress(st, "task:speckit:phase-1:U") === false);
  const st2 = {noProgressGenerations: {
    [continuationBudgetKey("task:standalone:phase-1:X")]: 1,
    [continuationBudgetKey("task:speckit:phase-1:Y")]: 1,
  }};
  clearStaleStandaloneContinuations(st2);
  check("no-progress: stale standalone counters dropped with stale continuations, speckit kept",
    Object.keys(st2.noProgressGenerations).length === 1 && Object.keys(st2.noProgressGenerations)[0].includes(":task:speckit:"));
}

// ── Backlog #32: note-cited code excerpts ──
{
  const file = Array.from({length: 60}, (_, i) => `L${i + 1}`).join("\n");
  const files = {"scripts/a.mjs": file, "scripts/b.mjs": "b1\nb2\nb3"};
  const reader = (p) => files[p] ?? null;
  const note = [
    "# T2.3 handoff",
    "## 2. Found",
    "- context at scripts/a.mjs:50",
    "## 3. Next",
    "Edit scripts/a.mjs:10-12 then scripts/b.mjs:2; skip /etc/passwd.txt:1, ../x.mjs:3, missing/c.mjs:4",
    "## 4. Dead ends",
    "- scripts/a.mjs:40 tried",
  ].join("\n");
  const next = noteNextSection(note);
  check("excerpts: the Next section is isolated",
    next.includes("scripts/a.mjs:10-12") && !next.includes(":50") && !next.includes(":40"), next);
  const out = handoffNoteCitedExcerpts(note, reader, {context: 1});
  check("excerpts: cited ranges quoted with context and live line numbers",
    out.includes("scripts/a.mjs:9-13") && out.includes("9: L9") && out.includes("13: L13")
    && out.includes("scripts/b.mjs:1-3") && out.includes("2: b2"), out);
  check("excerpts: Next cites come first, rest of the note fills the remainder",
    out.indexOf("scripts/a.mjs:9-13") < out.indexOf("scripts/b.mjs:1-3")
    && out.indexOf("scripts/b.mjs:1-3") < out.indexOf("scripts/a.mjs:49-51")
    && out.includes("L50") && out.includes("L40"), out);
  check("excerpts: defaults are a ~40-line window (±20) bounded to 5 refs / 210 lines / 15000 chars",
    NOTE_EXCERPT_MAX_RANGES === 5 && NOTE_EXCERPT_CONTEXT === 20
    && NOTE_EXCERPT_MAX_LINES === 210 && NOTE_EXCERPT_MAX_CHARS === 15000,
    {NOTE_EXCERPT_MAX_RANGES, NOTE_EXCERPT_CONTEXT, NOTE_EXCERPT_MAX_LINES, NOTE_EXCERPT_MAX_CHARS});
  const defWindow = handoffNoteCitedExcerpts("## Next\nscripts/a.mjs:30", reader);
  check("excerpts: default window quotes ~40 lines around the cite",
    defWindow.includes("scripts/a.mjs:10-50") && (defWindow.match(/^\d+: /gm) || []).length === 41, defWindow);
  check("excerpts: absolute, parent-escaping and unreadable paths are skipped",
    !out.includes("passwd") && !out.includes("x.mjs") && !out.includes("missing/c.mjs"), out);
  const noNext = handoffNoteCitedExcerpts("Found scripts/b.mjs:3", reader, {context: 0});
  check("excerpts: without a Next section the whole note is scanned", noNext.includes("3: b3"), noNext);
  const many = "## Next\n" + Array.from({length: 20}, (_, i) => `scripts/a.mjs:${i * 3 + 1}`).join(" ");
  const capped = handoffNoteCitedExcerpts(many, reader, {context: 0, maxRanges: 3});
  check("excerpts: bounded by maxRanges", (capped.match(/^scripts\/a\.mjs:/gm) || []).length === 3, capped);
  const big = handoffNoteCitedExcerpts("## Next\nscripts/a.mjs:1-60", reader, {context: 0, maxLines: 10});
  check("excerpts: bounded by maxLines", (big.match(/^\d+: /gm) || []).length === 10, big);
  check("excerpts: empty note / no reader render nothing",
    handoffNoteCitedExcerpts("", reader) === "" && handoffNoteCitedExcerpts(note, null) === "");
  check("excerpts: a throwing reader degrades to nothing",
    handoffNoteCitedExcerpts(note, () => { throw new Error("x"); }) === "");
}

// ── Mission 031 Phase 1 task 1.2: per-role limits and continuation allowance ──
{
  const reviewRoles = ["planner", "plan_reviewer", "code_reviewer", "verifier"];
  const implRole = "implementer";

  // resolvePerRoleLimits returns correct defaults for each role
  // (planner: 200K tokens / 180K wrap-up; other review roles: 150K / 135K)
  for (const role of reviewRoles) {
    const limits = resolvePerRoleLimits(role, {});
    const expTokens = role === "planner" ? 200000 : 150000;
    const expWrapup = role === "planner" ? 180000 : 135000;
    check(`resolvePerRoleLimits: ${role} defaults`, limits.perTaskMaxTurns === ((role === "verifier" || role === "planner" || role === "plan_reviewer") ? 30 : 22) && limits.perTaskMaxTokens === expTokens && limits.continuationAllowance === 2 && limits.wrapUpTokenThreshold === expWrapup, limits);
    check(`resolvePerRoleLimits: ${role} wrapUpTokenThreshold < perTaskMaxTokens`, limits.wrapUpTokenThreshold < limits.perTaskMaxTokens, limits);
  }
  const implLimits = resolvePerRoleLimits(implRole, {});
  check(`resolvePerRoleLimits: ${implRole} defaults`, implLimits.perTaskMaxTurns === PER_TASK_MAX_TURNS_DEFAULT && implLimits.perTaskMaxTokens === PER_TASK_MAX_TOKENS_DEFAULT && implLimits.continuationAllowance === CONTINUATION_ALLOWANCE_DEFAULT && implLimits.wrapUpTokenThreshold === HANDOFF_WRAPUP_TOKENS_DEFAULT, implLimits);
  check(`resolvePerRoleLimits: ${implRole} wrapUpTokenThreshold < perTaskMaxTokens`, implLimits.wrapUpTokenThreshold < implLimits.perTaskMaxTokens, implLimits);

  // Config overrides via policy.caps.<role> (snake_case keys as stored in config.json)
  const overridePolicy = {
    caps: {
      verifier: {max_turns: 15, max_tokens: 300000, extra_sessions: 1, wrap_up_tokens_threshold: 250000},
      planner: {max_turns: 30, max_tokens: 800000, extra_sessions: 3, wrap_up_tokens_threshold: 700000},
    },
  };
  const verifierOverridden = resolvePerRoleLimits("verifier", overridePolicy);
  check("resolvePerRoleLimits: verifier config override wins", verifierOverridden.perTaskMaxTurns === 15 && verifierOverridden.perTaskMaxTokens === 300000 && verifierOverridden.continuationAllowance === 1 && verifierOverridden.wrapUpTokenThreshold === 250000, verifierOverridden);
  const plannerOverridden = resolvePerRoleLimits("planner", overridePolicy);
  check("resolvePerRoleLimits: planner config override wins", plannerOverridden.perTaskMaxTurns === 30 && plannerOverridden.perTaskMaxTokens === 800000 && plannerOverridden.continuationAllowance === 3 && plannerOverridden.wrapUpTokenThreshold === 700000, plannerOverridden);

  // Invalid config values fall back to defaults
  const badPolicy = {caps: {verifier: {max_turns: 0, max_tokens: -1, extra_sessions: "lots", wrap_up_tokens_threshold: 0}}};
  const verifierBad = resolvePerRoleLimits("verifier", badPolicy);
  check("resolvePerRoleLimits: invalid config falls back to defaults", verifierBad.perTaskMaxTurns === 30 && verifierBad.perTaskMaxTokens === 150000 && verifierBad.continuationAllowance === 2 && verifierBad.wrapUpTokenThreshold === 135000, verifierBad);

  // wrapUpTokenThreshold >= maxTokens falls back to default
  const highWrapupPolicy = {caps: {verifier: {wrap_up_tokens_threshold: 600000}}};
  const verifierHighWrapup = resolvePerRoleLimits("verifier", highWrapupPolicy);
  check("resolvePerRoleLimits: wrapUpTokens >= maxTokens falls back", verifierHighWrapup.wrapUpTokenThreshold === 135000, verifierHighWrapup);

  // Implementer honors policy.per_task_max_turns / per_task_max_tokens (operator-facing keys)
  const implPolicy = {per_task_max_turns: 10, per_task_max_tokens: 400000};
  const implOverridden = resolvePerRoleLimits("implementer", implPolicy);
  check("resolvePerRoleLimits: implementer per_task_max_turns honored", implOverridden.perTaskMaxTurns === 10, implOverridden);
  check("resolvePerRoleLimits: implementer per_task_max_tokens honored", implOverridden.perTaskMaxTokens === 400000, implOverridden);
  check("resolvePerRoleLimits: implementer wrapUpTokenThreshold below custom maxTokens", implOverridden.wrapUpTokenThreshold < implOverridden.perTaskMaxTokens, implOverridden);

  // policy.caps.implementer takes precedence over per_task_* when both present
  const bothPolicy = {per_task_max_turns: 10, per_task_max_tokens: 400000, caps: {implementer: {max_turns: 15, max_tokens: 500000}}};
  const implBoth = resolvePerRoleLimits("implementer", bothPolicy);
  check("resolvePerRoleLimits: implementer policy.caps.implementer wins over per_task_*", implBoth.perTaskMaxTurns === 15 && implBoth.perTaskMaxTokens === 500000, implBoth);

  // consumeContinuation with role name uses role-specific allowance (default 2 for review roles)
  const state = {};
  const c1 = consumeContinuation(state, {}, "task:review:1", "verifier");
  check("consumeContinuation: first consume with role allowed (used=1, limit=2)", c1.allowed === true && c1.used === 1 && c1.limit === 2, c1);
  const c2 = consumeContinuation(state, {}, "task:review:1", "verifier");
  check("consumeContinuation: second consume with role allowed (used=2, limit=2)", c2.allowed === true && c2.used === 2 && c2.limit === 2, c2);
  const c3 = consumeContinuation(state, {}, "task:review:1", "verifier");
  check("consumeContinuation: third consume with role REFUSED (used=3 > limit=2)", c3.allowed === false && c3.used === 3 && c3.limit === 2, c3);

  // consumeContinuation with explicit number
  const state2 = {};
  const d1 = consumeContinuation(state2, {}, "task:impl:1", 3);
  check("consumeContinuation: explicit number allowance", d1.allowed === true && d1.used === 1 && d1.limit === 3, d1);

  // consumeContinuation without allowance falls back to resolveContinuationAllowance (implementer default 5)
  const state3 = {};
  for (let i = 0; i < 5; i++) consumeContinuation(state3, {}, "task:impl:2");
  const d6 = consumeContinuation(state3, {}, "task:impl:2");
  check("consumeContinuation: fallback to implementer default (5), 6th refused", d6.allowed === false && d6.used === 6 && d6.limit === 5, d6);

  // consumeContinuation with the implementer role name uses the global default (5)
  const state4 = {};
  for (let i = 0; i < 5; i++) consumeContinuation(state4, {}, "task:impl:3", "implementer");
  const e6 = consumeContinuation(state4, {}, "task:impl:3", "implementer");
  check("consumeContinuation: implementer role name allows 5, 6th refused", e6.allowed === false && e6.used === 6 && e6.limit === 5, e6);

  // An unknown role resolves to the global per-task defaults
  const unknownLimits = resolvePerRoleLimits("unknown_role", {});
  check("resolvePerRoleLimits: unknown role uses global defaults", unknownLimits.perTaskMaxTurns === PER_TASK_MAX_TURNS_DEFAULT && unknownLimits.perTaskMaxTokens === PER_TASK_MAX_TOKENS_DEFAULT && unknownLimits.continuationAllowance === CONTINUATION_ALLOWANCE_DEFAULT && unknownLimits.wrapUpTokenThreshold < unknownLimits.perTaskMaxTokens, unknownLimits);

  // resolveContinuationAllowanceForRole: review roles, implementer, config override
  for (const role of ["planner", "plan_reviewer", "code_reviewer", "verifier"]) {
    check(`resolveContinuationAllowanceForRole: ${role} default`, resolveContinuationAllowanceForRole(role, {}) === PER_ROLE_CAPS_DEFAULT[role].extraSessions);
  }
  check("resolveContinuationAllowanceForRole: implementer default", resolveContinuationAllowanceForRole("implementer", {}) === CONTINUATION_ALLOWANCE_DEFAULT);
  check("resolveContinuationAllowanceForRole: verifier override wins", resolveContinuationAllowanceForRole("verifier", {caps: {verifier: {extra_sessions: 4}}}) === 4);
}

// ── Mission 045 Phase 1 task 1.1: orchestrator fallback note ──
{
  check("fallback note: exported as a pure function",
    typeof buildOrchestratorFallbackNote === "function" && FALLBACK_NOTE_DIFF_MAX_CHARS === 1200);
  const opencodeEvents = [
    {type: "tool_use", part: {type: "tool_use", tool: "write", state: {input: {filePath: "/repo/scripts/per-task-budget.mjs"}, status: "completed"}}},
    {type: "tool_use", part: {type: "tool_use", tool: "bash", state: {input: {command: "node scripts/test-per-task-budget.mjs"}, status: "completed", metadata: {exit: 0}}}},
    {type: "text", part: {type: "text", text: "wired the fallback"}},
  ];
  const note = buildOrchestratorFallbackNote("T2.2", opencodeEvents, "opencode", "/repo",
    " scripts/per-task-budget.mjs | 12 +++++++++---\n 1 file changed, 10 insertions(+), 2 deletions(-)");
  check("fallback note: contains the task ref", note.includes("T2.2"), note.slice(0, 200));
  check("fallback note: contains the provided diffStat",
    note.includes("scripts/per-task-budget.mjs | 12 +++++++++---")
    && note.includes("1 file changed, 10 insertions(+), 2 deletions(-)"), note);
  check("fallback note: contains the sessionWorkDigest output",
    note.includes("edited: scripts/per-task-budget.mjs")
    && note.includes("ran: node scripts/test-per-task-budget.mjs (ok)")
    && note.includes('last: "wired the fallback"'), note);
  check("fallback note: bounded by the handoff note default",
    note.length <= HANDOFF_NOTE_MAX_CHARS_DEFAULT && note.length > 0, note.length);
  check("fallback note: garbage input degrades, never throws",
    typeof buildOrchestratorFallbackNote(null, null, "codex", null, null) === "string"
    && buildOrchestratorFallbackNote(null, null, "codex", null, null).includes("<task-ref>")
    && buildOrchestratorFallbackNote(null, null, "codex", null, null).length <= HANDOFF_NOTE_MAX_CHARS_DEFAULT);
  const hugeDiff = Array.from({length: 400}, (_, i) => ` src/file-${i}.mjs | 100 ++++...`).join("\n");
  const hugeEvents = Array.from({length: 5000}, (_, i) => (
    {type: "tool_use", part: {type: "tool_use", tool: "write", state: {input: {filePath: `/repo/scripts/mod-${i}.mjs`}, status: "completed"}}}
  ));
  const capped = buildOrchestratorFallbackNote("T9", hugeEvents, "opencode", "/repo", hugeDiff);
  check("fallback note: huge diff + huge event stream stay bounded",
    capped.length <= HANDOFF_NOTE_MAX_CHARS_DEFAULT && capped.includes("T9")
    && capped.includes("edited: scripts/mod-0.mjs") && capped.includes("truncated"), capped.length);
  const rel = buildOrchestratorFallbackNote("T3", [
    {type: "tool_use", part: {type: "tool_use", tool: "edit", state: {input: {filePath: "/repo/scripts/a.mjs"}, status: "completed"}}},
  ], "opencode", "/repo", "");
  check("fallback note: repoRoot passed through to the digest",
    rel.includes("edited: scripts/a.mjs") && !rel.includes("/repo/"));
  const emptyDiff = buildOrchestratorFallbackNote("T4", [], "opencode", "", "");
  check("fallback note: no session edits says so explicitly",
    emptyDiff.includes("T4") && emptyDiff.includes("This session changed no files."));
  const noAdapter = buildOrchestratorFallbackNote("T5", opencodeEvents, "cursor", "", "diff line");
  check("fallback note: unknown adapter keeps ref + digest-absent sections",
    noAdapter.includes("T5") && noAdapter.includes("diff line") && noAdapter.includes("(none:"));
}

// ── Mission 049 Phase 1 task 1.1: cut-context helpers + scratch-note helpers ──
{
  const wholeFileRead = (filePath) => (
    {type: "tool_use", part: {type: "tool_use", tool: "read", state: {input: {filePath}, status: "completed"}}}
  );
  const rangeRead = (filePath, offset, limit) => (
    {type: "tool_use", part: {type: "tool_use", tool: "read", state: {input: {filePath, offset, limit}, status: "completed"}}}
  );
  const stepFinish = () => ({type: "step_finish", part: {type: "step-finish"}});
  // Turn-2 token breach after a whole-file read: cause + avoid hint name the path.
  const turn2Events = [wholeFileRead("/repo/scripts/big.mjs"), stepFinish(), stepFinish()];
  const turn2Usage = {input: 100000, cacheCreation: 0, cacheRead: 100000, output: 1, turns: 2, maxSingleTurnContext: 200000};
  const turn2Breach = {type: "tokens", used: 200000, limit: 180000, usage: turn2Usage};
  const turn2 = describeCutContext({adapterId: "opencode", events: turn2Events, capBreach: turn2Breach, repoRoot: "/repo"});
  check("cut-context: turn-2 large-read names the whole-file cause",
    turn2.reasonLine.includes("likely cause: whole-file read of scripts/big.mjs"), turn2.reasonLine);
  check("cut-context: turn-2 large-read avoid hint names the path in full",
    turn2.avoidLine.includes("Avoid: do not re-read scripts/big.mjs in full"), turn2.avoidLine);
  check("cut-context: turn-2 largest read marks the whole file",
    turn2.largestReadLine === "Largest read: scripts/big.mjs (whole file)", turn2.largestReadLine);
  const turn2Section = renderCutContextSection({adapterId: "opencode", events: turn2Events, capBreach: turn2Breach, repoRoot: "/repo"});
  check("cut-context: rendered section carries cause plus avoid hint",
    turn2Section.includes("likely cause: whole-file read of scripts/big.mjs")
    && turn2Section.includes("Avoid: do not re-read scripts/big.mjs in full"), turn2Section);
  // Turn-cap breach shows turn N of limit on both lines.
  const turnCapEvents = [rangeRead("/repo/scripts/a.mjs", 10, 5), ...Array.from({length: 23}, stepFinish)];
  const turnCapBreach = {type: "turns", used: 23, limit: 22, usage: {turns: 23}};
  const turnCap = describeCutContext({adapterId: "opencode", events: turnCapEvents, capBreach: turnCapBreach, repoRoot: "/repo"});
  check("cut-context: turn-cap reason shows turn N of limit",
    turnCap.reasonLine.includes("turn 23 of 22"), turnCap.reasonLine);
  check("cut-context: turn-cap point shows turn N of limit",
    turnCap.pointLine.includes("turn 23 of 22"), turnCap.pointLine);
  check("cut-context: ranged largest read renders path:start-end plus range marker",
    turnCap.largestReadLine === "Largest read: scripts/a.mjs:10-14 (range)", turnCap.largestReadLine);
  // Pure degrade-never-throw: garbage input yields generic lines, never a throw.
  let garbageOk = true;
  let garbageDesc = null;
  let garbageSection = null;
  try {
    garbageDesc = describeCutContext(null);
    garbageSection = renderCutContextSection(undefined);
    describeCutContext("junk");
    renderCutContextSection(42);
    describeCutContext({adapterId: "opencode", events: [{nope: true}], capBreach: {type: "???", used: NaN}, repoRoot: null});
  } catch { garbageOk = false; }
  check("cut-context: garbage input degrades, never throws",
    garbageOk && typeof garbageDesc?.reasonLine === "string" && typeof garbageSection === "string"
    && garbageDesc.reasonLine.startsWith("Cut:") && garbageSection.includes("Cut:"), {garbageDesc, garbageSection});
  check("cut-context: rendered section stays bounded",
    typeof turn2Section === "string" && turn2Section.length <= CUT_CONTEXT_SECTION_MAX_CHARS, turn2Section.length);
  // Scratch-note path helper: shared vocabulary, garbage degrades to the default.
  check("scratch-note: default dir plus filename-safe ref",
    scratchHandoffNotePath(undefined, "T2.2") === `${SCRATCH_HANDOFF_NOTE_DEFAULT_DIR}/T2.2.md`
    && SCRATCH_HANDOFF_NOTE_DEFAULT_DIR === "/workspace/scratch", scratchHandoffNotePath(undefined, "T2.2"));
  check("scratch-note: custom dir plus unsafe ref made safe",
    scratchHandoffNotePath("/tmp/scratch/", "T 2/2?a") === "/tmp/scratch/T-2-2-a.md");
  check("scratch-note: garbage degrades to the default, never throws",
    scratchHandoffNotePath(null, null) === "/workspace/scratch/task.md");
  // Pick-fresher helper: newer wins either way, tie prefers repo, both missing gives none.
  const repoNewer = pickFresherHandoffNote({repoText: "repo note", repoMtimeMs: 2000, scratchText: "scratch note", scratchMtimeMs: 1000});
  check("pick-fresher: newer repo wins", repoNewer.source === "repo" && repoNewer.text === "repo note", repoNewer);
  const scratchNewer = pickFresherHandoffNote({repoText: "repo note", repoMtimeMs: 1000, scratchText: "scratch note", scratchMtimeMs: 2000});
  check("pick-fresher: newer scratch wins", scratchNewer.source === "scratch" && scratchNewer.text === "scratch note", scratchNewer);
  const tie = pickFresherHandoffNote({repoText: "repo note", repoMtimeMs: 1000, scratchText: "scratch note", scratchMtimeMs: 1000});
  check("pick-fresher: tie prefers repo", tie.source === "repo" && tie.text === "repo note", tie);
  const none = pickFresherHandoffNote({repoText: "", repoMtimeMs: null, scratchText: "  ", scratchMtimeMs: null});
  check("pick-fresher: both missing or empty gives none",
    none.source === "none" && none.text === "", none);
  check("pick-fresher: garbage degrades to none, never throws",
    pickFresherHandoffNote(null).source === "none" && pickFresherHandoffNote("junk").source === "none");
}

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
