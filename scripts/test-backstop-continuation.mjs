#!/usr/bin/env node
// Mission 047 Phase 1 task 1.2 — backstop continuation wiring.
//
// autopilot.mjs runs main() on import, so the monitor wiring, the capped
// marker, and both per-task loop rollover branches are static-covered here
// (same pattern as test-cap-breach-wiring.mjs). Decision logic itself
// (evaluateBackstopBreach, the separate firing ledger) is unit-covered in
// test-backstop-raw-tokens.mjs.
// Accept: a past-backstop session records the `orchestrator_fallback` note
// shape and continues, while the `extra_sessions` (continuation) ledger is
// unchanged.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  BACKSTOP_RAW_TOKENS_DEFAULT,
  resolveBackstopRawTokens,
  evaluateBackstopBreach,
  recordBackstopFiring,
  readBackstopFirings,
  clearBackstopFirings,
  evaluateBackstopEscalation,
  consumeContinuation,
} from "./per-task-budget.mjs";

let failures = 0;
const check = (name, condition, evidence) => {
  if (condition) console.log(`PASS ${name}`);
  else {
    failures += 1;
    console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(evidence).slice(0, 300)}` : ""}`);
  }
};
const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
const count = (re) => [...src.matchAll(re)].length;

// ── Monitor: backstop behind the existing cap checks ──
check("monitor: backstop limit resolved per invocation",
  /const backstopLimit=resolveBackstopRawTokens\(c\.policy,roleName\);/.test(src));
check("monitor: backstop evaluated via the unit-tested pure helper",
  /const backstopEval=evaluateBackstopBreach\(\{usage,limit:backstopLimit\}\);/.test(src));
check("monitor: backstop fires only when no cap breach already recorded",
  /if\(!capBreach\)\{\s*\n\s*try\{\s*\n\s*const backstopLimit=resolveBackstopRawTokens/.test(src));
check("monitor: backstop check sits behind the cap checks in evaluateCaps",
  src.indexOf("const breach=checkCapBreach(") !== -1
  && src.indexOf("const backstopLimit=resolveBackstopRawTokens(") > src.indexOf("const breach=checkCapBreach("));
check("monitor: backstop breach stops via wrapUp:true with the backstop marker",
  /capBreach=\{type:"backstop",used:backstopEval\.total,limit:backstopEval\.limit,usage,wrapUp:true,trigger:"backstop",backstop:true\};/.test(src));
check("monitor: backstop uses the raw cumulative measure, never the price-weighted figure",
  /evaluateBackstopBreach, never\s*\n\s*\/\/ the price-weighted figure/.test(src));

// ── Outcome: marker carried so the loop can route the rollover ──
check("outcome: capped marker carries the backstop flag",
  /if\(capBreach\.backstop\) result\.capped\.backstop=true;/.test(src));
check("outcome: orchestrator fallback path reachable for the backstop (wrapUp gate is capEnabled-gated, not role-gated)",
  /if\(capEnabled && !isWrapUp && capBreach\?\.wrapUp && result\.capped\)\{/.test(src)
  && /status:"orchestrator_fallback",reason:"note_missing_or_stale",trigger:capBreach\.trigger\|\|null,note:noteRel,fallbackNote:true/.test(src));

// ── Loops: backstop rollover on the separate ledger (both loops) ──
check("loops: backstop branch in both per-task loops",
  count(/taskImpl\.capped\.backstop===true\|\|taskImpl\.capped\.type==="backstop"/g) === 2);
check("loops: backstop rollover records on the firing ledger (both loops)",
  count(/recordBackstopFiring\(s,contScope,/g) === 2);
check("loops: backstop evidence carries total, turns, and largest single-turn context (both loops)",
  count(/totalRawTokens:taskImpl\.capped\.used,turns:/g) === 2
  && count(/maxSingleTurnContext:Number\.isFinite\(Number\(taskImpl\.usage\?\.maxSingleTurnContext\)\)/g) === 2);
{
  const branches = src.split('taskImpl.capped.backstop===true||taskImpl.capped.type==="backstop"').slice(1);
  check("loops: backstop branch never touches the continuation allowance (no consumeContinuation)",
    branches.length === 2 && branches.every((b) => !b.slice(0, 1500).includes("consumeContinuation(")), branches.length);
  check("loops: backstop branch never touches failure budgets",
    branches.length === 2 && branches.every((b) => !/failureBudget|recordFailureBudget|enforceAttemptFailure/.test(b.slice(0, 1500))), branches.length);
  check("loops: backstop branch records no dead end (the fallback note carries the resume context)",
    branches.length === 2 && branches.every((b) => !b.slice(0, 1500).includes("recordRolloverDeadEnd(")), branches.length);
  check("loops: backstop branch continues the cursor loop",
    branches.length === 2 && branches.every((b) => b.slice(0, 3000).includes("continue;")), branches.length);
}
check("loops: backstop rollover log words the cumulative figure (both loops + 7 review-role sites + planning backstop handler)",
  count(/crossed the cumulative backstop/g) === 10);
// The shared SpecKit/GSD planning handler covers every capped field on the
// planning relays: it logs the cumulative figure, records on the firing
// ledger and resets the consecutive count on a non-backstop generation.
{
  const start = src.indexOf("function handleCappedPlanningResult(");
  const end = src.indexOf("function handleIncompletePlanningResult(");
  const planningBackstop = start !== -1 && end > start ? src.slice(start, end) : "";
  const incompleteStart = end;
  const incompleteEnd = src.indexOf("// TASK-26", incompleteStart);
  const planningIncomplete = incompleteStart !== -1 && incompleteEnd > incompleteStart ? src.slice(incompleteStart, incompleteEnd) : "";
  check("planning: capped handler logs the cumulative figure and continues",
    /crossed the cumulative backstop[\s\S]*?continuing as backstop session/.test(planningBackstop), planningBackstop.includes("crossed the cumulative backstop"));
  check("planning: non-backstop capped generation resets the firing count",
    /clearBackstopFirings\(s,contScope\)[\s\S]*?handlePlanningContinuation\(/.test(planningBackstop));
  check("planning: incomplete generation resets the firing count",
    /clearBackstopFirings\(s,contScope\)[\s\S]*?handlePlanningContinuation\(/.test(planningIncomplete));
}
check("loops: firing ledger cleared on task success AND on non-backstop early exits (converge + carry + status/sentinel breaks, both loops + 4 review-role normal-completed clears)",
  count(/clearBackstopFirings\(s,`task:(standalone|speckit):phase-/g) === 12);
// A generation ending without a backstop firing resets the consecutive
// count (PLAN): the ordinary cap-breach rollover and the voluntary-stop
// rollover clear via the loop contScope (both loops), and the
// non-completed / malformed-sentinel early exits clear via the task scope
// (both loops) — so firing → non-backstop generation → firing never
// escalates as a second consecutive firing.
check("loops: non-backstop rollover paths reset the consecutive count (cap + attempted, both loops + 7 review-role capped sites + planning capped/incomplete/GSD/existing-planning paths)",
  count(/clearBackstopFirings\(s,contScope\)/g) === 17);

// ── Live: backstop firing leaves the extra_sessions ledger unchanged ──
{
  const s = {continuationBudgets: {"continuationAllowance:task:standalone:phase-0:T": 2}};
  const before = JSON.stringify(s.continuationBudgets);
  const firings = recordBackstopFiring(s, "task:standalone:phase-0:T",
    {generation: 1, totalRawTokens: 7_100_000, turns: 200, maxSingleTurnContext: 35000});
  check("accept: firing recorded on the backstop ledger",
    firings.length === 1 && readBackstopFirings(s, "task:standalone:phase-0:T").length === 1, firings);
  check("accept: extra_sessions (continuation) ledger unchanged by the firing",
    JSON.stringify(s.continuationBudgets) === before, s.continuationBudgets);
  check("accept: over-6M usage evaluates breach at the default",
    evaluateBackstopBreach({totalRawTokens: 7_100_000, limit: resolveBackstopRawTokens({})}).breached === true
    && BACKSTOP_RAW_TOKENS_DEFAULT === 6_000_000);
  const c = consumeContinuation(s, {}, "task:standalone:phase-0:T");
  check("accept: continuation allowance still independently consumable (used 3 of default)",
    c.used === 3 && readBackstopFirings(s, "task:standalone:phase-0:T").length === 1, c);
  check("accept: success clears the firing ledger without touching the allowance",
    clearBackstopFirings(s, "task:standalone:phase-0:T") === true
    && readBackstopFirings(s, "task:standalone:phase-0:T").length === 0
    && s.continuationBudgets["continuationAllowance:task:standalone:phase-0:T"] === 3);
}

// ── Live: firing → non-backstop generation → firing does NOT escalate ──
{
  const s = {};
  const scope = "task:standalone:phase-0:U";
  recordBackstopFiring(s, scope,
    {generation: 1, totalRawTokens: 7_100_000, turns: 200, maxSingleTurnContext: 35000});
  // The interleaving generation ended WITHOUT a backstop firing (ordinary
  // cap rollover / voluntary stop / early exit): the loop resets the count.
  check("accept: non-backstop generation end resets the consecutive count",
    clearBackstopFirings(s, scope) === true
    && readBackstopFirings(s, scope).length === 0, readBackstopFirings(s, scope));
  const firings = recordBackstopFiring(s, scope,
    {generation: 1, totalRawTokens: 7_300_000, turns: 210, maxSingleTurnContext: 36000});
  const decision = evaluateBackstopEscalation(firings);
  check("accept: firing → non-backstop rollover → firing does not escalate",
    decision.escalate === false && decision.reason === "first_firing_no_escalation"
    && firings.length === 1, decision);
}

// ── Discovery ──
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const runner = fs.readFileSync(path.join(here, "test-all.mjs"), "utf8");
  check("discovery: test-backstop-continuation.mjs matches the runner discovery regex",
    /^test-.*\.mjs$/.test("test-backstop-continuation.mjs"));
  check("discovery: test-backstop-continuation.mjs absent from both test-all exclusion sets",
    !runner.includes("test-backstop-continuation.mjs"));
}

console.log(`\n${failures === 0 ? "all" : failures} ${failures === 0 ? "checks passed" : "check(s) FAILED"}`);
if (failures) process.exit(1);
