#!/usr/bin/env node
// Mission 047 Phase 1 task 1.3 — second-consecutive-firing escalation.
//
// autopilot.mjs runs main() on import, so the escalation wiring, the step
// name, and both per-task loop backstop branches are static-covered here
// (same pattern as test-backstop-continuation.mjs). Decision logic itself
// (evaluateBackstopEscalation, the separate firing ledger) is unit-covered
// in test-backstop-raw-tokens.mjs.
// Accept: two firings in a row escalate with total raw tokens, turns,
// largest single-turn context and both firings; no third session starts.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import { importNames } from "./test-fixtures/source-scan.mjs";
import {
  recordBackstopFiring,
  readBackstopFirings,
  evaluateBackstopEscalation,
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

// ── Wiring: escalation decision imported and evaluated in both loops ──
check("wiring: evaluateBackstopEscalation imported",
  ["evaluateBackstopEscalation", "handleRoleBackstopFiring"].every((n) => importNames(src, "./per-task-budget.mjs").includes(n)));
check("wiring: escalation evaluated on the firing list in both loops",
  count(/evaluateBackstopEscalation\(firings\)\.escalate/g) === 2);
check("wiring: escalation step is runaway_session_escalation (both loops + 7 review-role sites + planning backstop handler)",
  count(/s\.step="runaway_session_escalation"/g) === 10);
check("wiring: escalation evidence carries total, turns, largest turn, both firings (both loops + 7 review-role sites + planning backstop handler)",
  count(/evidence:\{taskId,totalRawTokens:/g) === 2
  && count(/maxSingleTurnContext:last\.maxSingleTurnContext/g) === 10
  && count(/firings:\[\.\.\.firings\]/g) === 2
  && count(/firings:\[\.\.\.backstop\.firings\]/g) === 8);
// The shared SpecKit/GSD planning handler must carry the same backstop
// guarantee: two consecutive firings escalate with the same evidence shape.
{
  const start = src.indexOf("function handleCappedPlanningResult(");
  const end = src.indexOf("function handleIncompletePlanningResult(");
  const planningBackstop = start !== -1 && end > start ? src.slice(start, end) : "";
  check("planning: backstop handler escalates with role + both firings evidence",
    planningBackstop.includes('s.step="runaway_session_escalation"')
    && planningBackstop.includes("handleRoleBackstopFiring(s,contScope,result)")
    && /evidence:\{role,totalRawTokens:last\.totalRawTokens\?\?result\.capped\.used,turns:last\.turns\?\?null,maxSingleTurnContext:last\.maxSingleTurnContext\?\?null,firings:\[\.\.\.backstop\.firings\]\}/.test(planningBackstop), planningBackstop.slice(0, 600));
  const esc = planningBackstop.indexOf("runaway_session_escalation");
  const die = esc === -1 ? -1 : planningBackstop.indexOf("die(", esc);
  const cont = esc === -1 ? -1 : planningBackstop.indexOf("handlePlanningContinuation(", esc);
  check("planning: escalation dies before any continuation allowance is consumed",
    esc !== -1 && die !== -1 && (cont === -1 || die < cont), {esc, die, cont});
  check("planning: first firing still continues the planning loop",
    /crossed the cumulative backstop[\s\S]*?return;/.test(planningBackstop));
}

// ── Branches: escalate dies with evidence, first firing still continues ──
{
  const branches = src.split('taskImpl.capped.backstop===true||taskImpl.capped.type==="backstop"').slice(1);
  check("loops: backstop branch present in both per-task loops", branches.length === 2, branches.length);
  const blocks = branches.map((b) => {
    const end = b.indexOf("continue;");
    return end === -1 ? "" : b.slice(0, end + "continue;".length);
  });
  check("loops: escalation block bounded (backstop continue reachable)",
    blocks.every((b) => b.length > 0 && b.includes("continuing as backstop session")), blocks.map((b) => b.length));
  check("loops: second firing escalates the mission (phase escalated)",
    blocks.every((b) => b.includes('s.phase="escalated"')));
  check("loops: escalation dies — no third session starts",
    blocks.every((b) => {
      const esc = b.indexOf("runaway_session_escalation");
      const die = b.indexOf("die(", esc);
      const cont = b.indexOf("continue;", esc);
      return esc !== -1 && die !== -1 && cont !== -1 && die < cont;
    }));
  check("loops: first firing still continues the cursor loop",
    blocks.every((b) => b.includes("continue;")));
  check("loops: escalation path never touches the continuation allowance",
    blocks.every((b) => !b.includes("consumeContinuation(")));
  check("loops: escalation path never touches failure budgets",
    blocks.every((b) => !/failureBudget|recordFailureBudget|enforceAttemptFailure/.test(b)));
}

// ── Live: two firings in a row escalate, one does not ──
{
  const s = {};
  const scope = "task:standalone:phase-0:T";
  const f1 = recordBackstopFiring(s, scope,
    {generation: 1, totalRawTokens: 7_100_000, turns: 200, maxSingleTurnContext: 35000});
  check("accept: first firing does not escalate (second session starts)",
    evaluateBackstopEscalation(f1).escalate === false
    && evaluateBackstopEscalation(f1).reason === "first_firing_no_escalation", evaluateBackstopEscalation(f1));
  const f2 = recordBackstopFiring(s, scope,
    {generation: 2, totalRawTokens: 7_300_000, turns: 210, maxSingleTurnContext: 36000});
  const decision = evaluateBackstopEscalation(f2);
  check("accept: two firings in a row escalate",
    decision.escalate === true && decision.reason === "second_consecutive_firing"
    && decision.consecutiveFirings === 2, decision);
  check("accept: no third session — the ledger holds both firings at escalation time",
    readBackstopFirings(s, scope).length === 2, readBackstopFirings(s, scope).length);
  // Evidence shaped exactly like the autopilot.mjs escalation block builds it.
  const last = f2[f2.length - 1] || {};
  const evidence = {taskId: "T", totalRawTokens: last.totalRawTokens ?? null, turns: last.turns ?? null, maxSingleTurnContext: last.maxSingleTurnContext ?? null, firings: [...f2]};
  check("accept: escalation evidence carries total raw tokens, turns, largest single-turn context and both firings",
    evidence.totalRawTokens === 7_300_000 && evidence.turns === 210
    && evidence.maxSingleTurnContext === 36000 && evidence.firings.length === 2
    && evidence.firings[0].totalRawTokens === 7_100_000, evidence);
  check("accept: escalation leaves the extra_sessions ledger untouched",
    s.continuationBudgets === undefined, Object.keys(s));
}

// ── Discovery ──
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const runner = fs.readFileSync(path.join(here, "test-all.mjs"), "utf8");
  check("discovery: test-backstop-escalation.mjs matches the runner discovery regex",
    /^test-.*\.mjs$/.test("test-backstop-escalation.mjs"));
  check("discovery: test-backstop-escalation.mjs absent from both test-all exclusion sets",
    !runner.includes("test-backstop-escalation.mjs"));
}

console.log(`\n${failures === 0 ? "all" : failures} ${failures === 0 ? "checks passed" : "check(s) FAILED"}`);
if (failures) process.exit(1);
