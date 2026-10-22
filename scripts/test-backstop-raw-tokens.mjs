#!/usr/bin/env node
// Mission 047 Phase 1 task 1.1 — cumulative raw-token backstop helpers.
//
// Pure helpers in per-task-budget.mjs: default 6M constant, raw-total sum,
// per-role resolver, breach evaluator, separate per-task firing ledger,
// consecutive-firing escalation decision.
// Accept: 35K-per-turn session under 6M cumulative evaluates no-breach,
// over-6M evaluates breach, ledger never touches continuationBudgets.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  BACKSTOP_RAW_TOKENS_DEFAULT,
  BACKSTOP_FIRING_LEDGER_KEY_PREFIX,
  BACKSTOP_FIRING_LEDGER_MAX_ENTRIES,
  backstopLedgerKey,
  rawTotalTokens,
  cumulativeRawTotal,
  resolveBackstopRawTokens,
  evaluateBackstopBreach,
  recordBackstopFiring,
  readBackstopFirings,
  clearBackstopFirings,
  evaluateBackstopEscalation,
} from "./per-task-budget.mjs";
import {accumulateUsage} from "./adapter-drivers.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, evidence) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(evidence)}` : ""}`);
  failed += 1;
}

// 35K-per-turn fixture through the REAL accumulator: 30 step_finish events
// of 35K input each — 1.05M cumulative, 35K max single turn.
function stepEvents(n, inputPerTurn = 35000, outputPerTurn = 500) {
  return Array.from({length: n}, () => ({
    type: "step_finish",
    part: {type: "step-finish", tokens: {input: inputPerTurn, output: outputPerTurn, reasoning: 0, cache: {read: 0, write: 0}}},
  }));
}

// ── Default constant ─────────────────────────────────────────────────────
check("backstop: default is 6M", BACKSTOP_RAW_TOKENS_DEFAULT === 6_000_000, BACKSTOP_RAW_TOKENS_DEFAULT);

// ── Raw-total sum ────────────────────────────────────────────────────────
{
  check("raw: sums input+cacheRead+cacheCreation+output",
    rawTotalTokens({input: 100, cacheRead: 200, cacheCreation: 50, output: 150}) === 500);
  check("raw: missing cacheCreation counts as 0",
    rawTotalTokens({input: 100, cacheRead: 200, output: 150}) === 450);
  check("raw: null/absent usage is never zero",
    rawTotalTokens(null) === null && rawTotalTokens(undefined) === null && rawTotalTokens("x") === null);
  check("raw: missing input/cacheRead/output is unmeasurable, never free",
    rawTotalTokens({input: 1}) === null && rawTotalTokens({}) === null);
  check("raw: ignores maxSingleTurnContext (cumulative, not per-turn)",
    rawTotalTokens({input: 100, cacheRead: 200, cacheCreation: 0, output: 10, maxSingleTurnContext: 5}) === 310);
  const u30 = accumulateUsage("opencode", stepEvents(30));
  check("raw: 30x35K fixture accumulates 30 turns",
    u30?.turns === 30, u30);
  check("raw: 30x35K fixture raw total is 30*(35000+500)=1.065M",
    rawTotalTokens(u30) === 30 * (35000 + 500), rawTotalTokens(u30));
  check("cumulative: sums across generations",
    cumulativeRawTotal([{input: 10, cacheRead: 0, output: 5}, {input: 20, cacheRead: 0, output: 5}]) === 40);
  check("cumulative: skips unmeasurable entries",
    cumulativeRawTotal([null, {input: 10, cacheRead: 0, output: 5}]) === 15);
  check("cumulative: empty/unmeasured is null, never 0",
    cumulativeRawTotal([]) === null && cumulativeRawTotal([null]) === null && cumulativeRawTotal("x") === null);
}

// ── Per-role resolver ────────────────────────────────────────────────────
{
  check("resolve: default is 6M",
    resolveBackstopRawTokens({}) === 6_000_000 && resolveBackstopRawTokens() === 6_000_000);
  check("resolve: policy-level key wins",
    resolveBackstopRawTokens({backstop_raw_tokens: 1000}) === 1000);
  check("resolve: per-role caps key wins over policy-level (review role)",
    resolveBackstopRawTokens({backstop_raw_tokens: 1000, caps: {planner: {backstop_raw_tokens: 2000}}}, "planner") === 2000);
  check("resolve: implementer ignores caps.implementer — the policy-level key configures it",
    resolveBackstopRawTokens({backstop_raw_tokens: 1000, caps: {implementer: {backstop_raw_tokens: 2000}}}, "implementer") === 1000);
  check("resolve: invalid falls back to default, never unbounded",
    resolveBackstopRawTokens({backstop_raw_tokens: 0}) === 6_000_000
    && resolveBackstopRawTokens({backstop_raw_tokens: -5}) === 6_000_000
    && resolveBackstopRawTokens({backstop_raw_tokens: "lots"}) === 6_000_000);
}

// ── Breach evaluator + accept fixtures ───────────────────────────────────
{
  const under = accumulateUsage("opencode", stepEvents(100)); // 100*35.5K = 3.55M < 6M
  const underRaw = rawTotalTokens(under);
  check("accept: 100x35K fixture really is under 6M",
    underRaw === 3550000 && underRaw < BACKSTOP_RAW_TOKENS_DEFAULT, underRaw);
  const eUnder = evaluateBackstopBreach({usage: under, limit: BACKSTOP_RAW_TOKENS_DEFAULT});
  check("accept: 35K-per-turn session under 6M cumulative evaluates no-breach",
    eUnder.breached === false && eUnder.enforceable === true && eUnder.reason === "within_backstop", eUnder);

  const over = accumulateUsage("opencode", stepEvents(200)); // 200*35.5K = 7.1M > 6M
  const overRaw = rawTotalTokens(over);
  check("accept: 200x35K fixture really is over 6M",
    overRaw === 7100000 && overRaw > BACKSTOP_RAW_TOKENS_DEFAULT, overRaw);
  const eOver = evaluateBackstopBreach({usage: over, limit: BACKSTOP_RAW_TOKENS_DEFAULT});
  check("accept: over-6M evaluates breach",
    eOver.breached === true && eOver.enforceable === true && eOver.reason === "breach"
    && eOver.total === 7100000 && eOver.limit === 6_000_000, eOver);

  check("breach: at the limit is not a breach",
    evaluateBackstopBreach({totalRawTokens: 6000000, limit: 6000000}).breached === false);
  check("breach: precomputed total accepted",
    evaluateBackstopBreach({totalRawTokens: 6000001, limit: 6000000}).breached === true);
  check("breach: null usage is unenforceable, never a breach",
    evaluateBackstopBreach({usage: null, limit: 6000000}).enforceable === false
    && evaluateBackstopBreach({usage: null, limit: 6000000}).breached === false);
  check("breach: invalid limit is unenforceable, never a breach",
    evaluateBackstopBreach({totalRawTokens: 99999999, limit: 0}).enforceable === false
    && evaluateBackstopBreach({totalRawTokens: 99999999}).reason === "no_backstop_configured");
}

// ── Separate per-task firing ledger ──────────────────────────────────────
{
  check("ledger: prefix is not the continuation prefix",
    BACKSTOP_FIRING_LEDGER_KEY_PREFIX !== "continuationAllowance:"
    && backstopLedgerKey("task:standalone:phase-1:T") === "backstopFirings:task:standalone:phase-1:T");
  const s = {};
  const l1 = recordBackstopFiring(s, "task:standalone:phase-1:T", {generation: 1, totalRawTokens: 7100000});
  check("ledger: first firing recorded", l1.length === 1 && readBackstopFirings(s, "task:standalone:phase-1:T").length === 1, l1);
  check("accept: ledger never touches continuationBudgets",
    s.continuationBudgets === undefined && s.failureBudgets === undefined, Object.keys(s));
  recordBackstopFiring(s, "task:standalone:phase-1:T", {generation: 2, totalRawTokens: 7200000});
  check("ledger: second firing recorded, still no continuationBudgets",
    readBackstopFirings(s, "task:standalone:phase-1:T").length === 2 && s.continuationBudgets === undefined);
  check("ledger: scopes are independent",
    readBackstopFirings(s, "task:standalone:phase-1:U").length === 0
    && recordBackstopFiring(s, "task:standalone:phase-1:U", {}).length === 1);
  check("ledger: clear works",
    clearBackstopFirings(s, "task:standalone:phase-1:U") === true
    && readBackstopFirings(s, "task:standalone:phase-1:U").length === 0
    && clearBackstopFirings(s, "task:standalone:phase-1:U") === false);
  const big = {};
  for (let i = 0; i < BACKSTOP_FIRING_LEDGER_MAX_ENTRIES + 5; i++) recordBackstopFiring(big, "t", {generation: i});
  check("ledger: bounded",
    readBackstopFirings(big, "t").length === BACKSTOP_FIRING_LEDGER_MAX_ENTRIES, readBackstopFirings(big, "t").length);
}

// ── Consecutive-firing escalation decision ───────────────────────────────
{
  check("escalation: no firings → no escalation",
    evaluateBackstopEscalation([]).escalate === false
    && evaluateBackstopEscalation([]).reason === "no_firings");
  check("escalation: first firing → no escalation",
    evaluateBackstopEscalation([{}]).escalate === false
    && evaluateBackstopEscalation([{}]).reason === "first_firing_no_escalation");
  const d2 = evaluateBackstopEscalation([{}, {}]);
  check("escalation: two firings in a row escalate",
    d2.escalate === true && d2.reason === "second_consecutive_firing" && d2.consecutiveFirings === 2, d2);
  check("escalation: ambiguous input never escalates",
    evaluateBackstopEscalation(null).escalate === false
    && evaluateBackstopEscalation(undefined).escalate === false
    && evaluateBackstopEscalation("x").reason === "ambiguous_input");
  const s = {};
  recordBackstopFiring(s, "t", {generation: 1});
  check("escalation: ledger with one firing → no escalation",
    evaluateBackstopEscalation(readBackstopFirings(s, "t")).escalate === false);
  recordBackstopFiring(s, "t", {generation: 2});
  check("escalation: ledger with two firings → escalation",
    evaluateBackstopEscalation(readBackstopFirings(s, "t")).escalate === true);
}

// ── Discovery ────────────────────────────────────────────────────────────
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const runner = fs.readFileSync(path.join(here, "test-all.mjs"), "utf8");
  check("discovery: test-backstop-raw-tokens.mjs matches the runner discovery regex",
    /^test-.*\.mjs$/.test("test-backstop-raw-tokens.mjs"));
  check("discovery: test-backstop-raw-tokens.mjs absent from both test-all exclusion sets",
    !runner.includes("test-backstop-raw-tokens.mjs"));
}

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
