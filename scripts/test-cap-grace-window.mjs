#!/usr/bin/env node
// Mission 027 Phase 3 task 3.1 — end-of-task grace window unit tests.
//
// Pins the pure evaluateCapGraceWindow() helper in per-task-budget.mjs:
// grace only on positive finishing evidence (verify passed or final
// task-result line being written), bounded to at most 3 extra turns and
// +10% tokens, one window per generation, ineligible on ambiguous input.
import {
  evaluateCapGraceWindow,
  capGraceTokenCeiling,
  CAP_GRACE_MAX_EXTRA_TURNS,
  CAP_GRACE_EXTRA_TOKEN_RATIO,
} from "./per-task-budget.mjs";

let failures = 0;
function check(name, condition, evidence) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(evidence)}` : ""}`); }
}

const MAX_TURNS = 22;
const MAX_TOKENS = 750_000;
const base = (overrides = {}) => ({
  verifyPassed: false,
  writingFinalResult: false,
  graceUsed: false,
  turnsUsed: MAX_TURNS + 1,
  perTaskMaxTurns: MAX_TURNS,
  tokensUsed: MAX_TOKENS + 1,
  perTaskMaxTokens: MAX_TOKENS,
  ...overrides,
});
const granted = (args) => evaluateCapGraceWindow(args)?.granted === true;

// ── Bounds constants ──
check("bounds: at most 3 extra turns and +10% tokens",
  CAP_GRACE_MAX_EXTRA_TURNS === 3 && CAP_GRACE_EXTRA_TOKEN_RATIO === 0.10,
  {CAP_GRACE_MAX_EXTRA_TURNS, CAP_GRACE_EXTRA_TOKEN_RATIO});
check("bounds: token ceiling is ceil(max * 1.10)",
  capGraceTokenCeiling(MAX_TOKENS) === Math.ceil(MAX_TOKENS * 1.10)
  && capGraceTokenCeiling(1000) === 1100
  && capGraceTokenCeiling(null) === null
  && capGraceTokenCeiling(-5) === null,
  {ceiling: capGraceTokenCeiling(MAX_TOKENS)});

// ── Eligibility: positive finishing evidence only ──
{
  const r = evaluateCapGraceWindow(base({verifyPassed: true}));
  check("eligible: verify already passed grants grace",
    r?.granted === true && r?.reason === "finishing_within_grace", r);
}
{
  const r = evaluateCapGraceWindow(base({writingFinalResult: true}));
  check("eligible: final task-result line being written grants grace",
    r?.granted === true && r?.reason === "finishing_within_grace", r);
}
check("ineligible: no finishing evidence grants nothing",
  evaluateCapGraceWindow(base())?.reason === "no_finishing_evidence"
  && granted(base()) === false);
check("ineligible: both evidence flags absent grants nothing",
  evaluateCapGraceWindow(base({verifyPassed: undefined, writingFinalResult: undefined}))?.granted === false);
check("ineligible: explicit false/false is no evidence, not ambiguous",
  evaluateCapGraceWindow(base({verifyPassed: false, writingFinalResult: false}))?.reason === "no_finishing_evidence");

// ── Ambiguous input is ineligible, never throws ──
check("ineligible: truthy non-boolean verify is ambiguous",
  evaluateCapGraceWindow(base({verifyPassed: 1, writingFinalResult: true}))?.reason === "ambiguous_input");
check("ineligible: string evidence is ambiguous",
  evaluateCapGraceWindow(base({verifyPassed: "yes"}))?.reason === "ambiguous_input");
check("ineligible: non-boolean graceUsed is ambiguous",
  evaluateCapGraceWindow(base({verifyPassed: true, graceUsed: "no"}))?.reason === "ambiguous_input");
check("ineligible: missing usage numbers are ambiguous",
  evaluateCapGraceWindow(base({verifyPassed: true, turnsUsed: undefined}))?.reason === "ambiguous_input"
  && evaluateCapGraceWindow(base({verifyPassed: true, tokensUsed: NaN}))?.reason === "ambiguous_input");
check("ineligible: negative usage is ambiguous",
  evaluateCapGraceWindow(base({verifyPassed: true, turnsUsed: -1}))?.reason === "ambiguous_input");
check("ineligible: missing caps are not configured, never granted",
  evaluateCapGraceWindow(base({verifyPassed: true, perTaskMaxTurns: 0}))?.reason === "no_cap_configured"
  && evaluateCapGraceWindow(base({verifyPassed: true, perTaskMaxTokens: null}))?.reason === "no_cap_configured");
check("ineligible: no args at all never throws and never grants",
  (() => { try { return evaluateCapGraceWindow()?.granted === false && evaluateCapGraceWindow(undefined)?.granted === false; } catch { return false; } })());

// ── Bounds: at most 3 extra turns ──
{
  const atEdge = evaluateCapGraceWindow(base({verifyPassed: true, turnsUsed: MAX_TURNS + 3}));
  check("bounds: exactly 3 extra turns is still within grace",
    atEdge?.granted === true && atEdge?.turnCeiling === MAX_TURNS + 3, atEdge);
}
{
  const past = evaluateCapGraceWindow(base({verifyPassed: true, turnsUsed: MAX_TURNS + 4}));
  check("bounds: 4 extra turns exceeds the window",
    past?.granted === false && past?.reason === "grace_turns_exceeded", past);
}

// ── Bounds: +10% tokens ──
{
  const ceiling = capGraceTokenCeiling(MAX_TOKENS);
  const atEdge = evaluateCapGraceWindow(base({verifyPassed: true, turnsUsed: MAX_TURNS, tokensUsed: ceiling}));
  check("bounds: exactly +10% tokens is still within grace",
    atEdge?.granted === true && atEdge?.tokenCeiling === ceiling, atEdge);
}
{
  const ceiling = capGraceTokenCeiling(MAX_TOKENS);
  const past = evaluateCapGraceWindow(base({verifyPassed: true, turnsUsed: MAX_TURNS, tokensUsed: ceiling + 1}));
  check("bounds: tokens past +10% exceed the window",
    past?.granted === false && past?.reason === "grace_tokens_exceeded", past);
}

// ── Single window per generation ──
{
  const second = evaluateCapGraceWindow(base({verifyPassed: true, graceUsed: true}));
  check("single-window: second window in the same generation is ineligible",
    second?.granted === false && second?.reason === "grace_already_used", second);
}
check("single-window: fresh window with finishing evidence grants once",
  granted(base({writingFinalResult: true, graceUsed: false})) === true
  && granted(base({writingFinalResult: true, graceUsed: true})) === false);

// ── Both evidence kinds respect bounds and window together ──
check("combined: writing-result past turn bound still capped",
  evaluateCapGraceWindow(base({writingFinalResult: true, turnsUsed: MAX_TURNS + 4}))?.reason === "grace_turns_exceeded");
check("combined: verify-passed past token bound still capped",
  evaluateCapGraceWindow(base({verifyPassed: true, turnsUsed: MAX_TURNS, tokensUsed: capGraceTokenCeiling(MAX_TOKENS) + 1}))?.reason === "grace_tokens_exceeded");

if (failures) {
  console.error(`${failures} cap-grace-window check(s) failed.`);
  process.exit(1);
}
console.log("cap-grace-window tests passed");
