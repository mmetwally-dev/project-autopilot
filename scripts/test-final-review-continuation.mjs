#!/usr/bin/env node
// Backlog #13: mission-final review continuation test.
//
// Covers:
// 1. Pure unit / behaviour tests for finalReviewNextStep({status, decision, capped, incomplete, allowanceLeft, onlyGateLeft}).
// 2. Source checks scoped to each final-review site (SpecKit, standalone, early final, re-review rounds):
//    - cap enabled
//    - INCOMPLETE/capped goes to the continuation path (not runFinalReviewFixRounds)
//    - the targeted-tests line is in the prompt
//    - the "no continuation" log is gone

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { finalReviewNextStep } from "./final-review-fix-rounds.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const autopilotSrc = fs.readFileSync(path.join(HERE, "autopilot.mjs"), "utf8");

let ok = 0;
let failed = 0;
function check(name, condition, evidence) {
  if (condition) {
    console.log(`PASS ${name}`);
    ok += 1;
    return;
  }
  console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(String(evidence).slice(0, 500))}` : ""}`);
  failed += 1;
}

// ── Part 1: Unit / behaviour tests for finalReviewNextStep ──

// continue: allowance available on incomplete / capped / INCOMPLETE decision
check("helper: INCOMPLETE decision with allowance continues",
  finalReviewNextStep({status: "completed", decision: "INCOMPLETE", allowanceLeft: true}) === "continue");
check("helper: capped with allowance continues",
  finalReviewNextStep({status: "completed", decision: null, capped: true, allowanceLeft: true}) === "continue");
check("helper: capped with FAIL verdict and allowance continues",
  finalReviewNextStep({status: "completed", decision: "FAIL", capped: true, allowanceLeft: true}) === "continue");
check("helper: incomplete signal with allowance continues",
  finalReviewNextStep({status: "completed", decision: null, incomplete: true, allowanceLeft: true}) === "continue");

// verdict_only: allowance exhausted but only gate left
check("helper: INCOMPLETE with exhausted allowance and onlyGateLeft gives verdict_only",
  finalReviewNextStep({status: "completed", decision: "INCOMPLETE", allowanceLeft: false, onlyGateLeft: true}) === "verdict_only");
check("helper: capped with exhausted allowance and onlyGateLeft gives verdict_only",
  finalReviewNextStep({status: "completed", decision: null, capped: true, allowanceLeft: false, onlyGateLeft: true}) === "verdict_only");
check("helper: incomplete signal with exhausted allowance and onlyGateLeft gives verdict_only",
  finalReviewNextStep({status: "completed", decision: null, incomplete: true, allowanceLeft: false, onlyGateLeft: true}) === "verdict_only");

// escalate: allowance exhausted and not only gate left
check("helper: INCOMPLETE with exhausted allowance escalates",
  finalReviewNextStep({status: "completed", decision: "INCOMPLETE", allowanceLeft: false, onlyGateLeft: false}) === "escalate");
check("helper: capped with exhausted allowance escalates",
  finalReviewNextStep({status: "completed", decision: null, capped: true, allowanceLeft: false, onlyGateLeft: false}) === "escalate");
check("helper: incomplete signal with exhausted allowance escalates",
  finalReviewNextStep({status: "completed", decision: null, incomplete: true, allowanceLeft: false, onlyGateLeft: false}) === "escalate");

// pass: completed with PASS verdict
check("helper: completed PASS returns pass",
  finalReviewNextStep({status: "completed", decision: "PASS"}) === "pass");
check("helper: completed PASS ignores allowanceLeft",
  finalReviewNextStep({status: "completed", decision: "PASS", allowanceLeft: true}) === "pass");

// fix_rounds: completed with FAIL verdict or failed status (infra failure)
check("helper: completed FAIL goes to fix_rounds",
  finalReviewNextStep({status: "completed", decision: "FAIL"}) === "fix_rounds");
check("helper: failed status (no verdict) goes to fix_rounds (reviewer retry)",
  finalReviewNextStep({status: "failed", decision: null}) === "fix_rounds");
check("helper: completed with non-PASS non-INCOMPLETE decision goes to fix_rounds",
  finalReviewNextStep({status: "completed", decision: "UNKNOWN"}) === "fix_rounds");
check("helper: default invocation never throws and returns fix_rounds",
  finalReviewNextStep() === "fix_rounds");

// ── Part 2: Shared runner (runFinalReviewSessions) wiring checks ──

check("wiring: autopilot imports finalReviewNextStep",
  /import \{[^}]*\bfinalReviewNextStep\b[^}]*\} from "\.\/final-review-fix-rounds\.mjs"/.test(autopilotSrc));

const runFnIdx = autopilotSrc.indexOf("async function runFinalReviewSessions(");
check("wiring: runFinalReviewSessions helper defined", runFnIdx !== -1);

const runFnEnd = autopilotSrc.indexOf("async function runStandaloneFinalReviewFixRounds(", runFnIdx);
const runFnSlice = runFnIdx !== -1 && runFnEnd !== -1
  ? autopilotSrc.slice(runFnIdx, runFnEnd)
  : "";

check("wiring: runFinalReviewSessions enables cap (capEnabled: true)",
  runFnSlice.includes("budget.timeoutMs,true,codeReviewScopeKey("));

check("wiring: runFinalReviewSessions injects CODE_REVIEWER_TARGETED_TESTS_LINE into prompt",
  runFnSlice.includes("CODE_REVIEWER_TARGETED_TESTS_LINE"));

check("wiring: runFinalReviewSessions injects readOnlyHandoffNoteReminder",
  runFnSlice.includes("readOnlyHandoffNoteReminder({mission, ref"));

check("wiring: runFinalReviewSessions injects readOnlyContinuationNote for carried scratch / note",
  runFnSlice.includes("readOnlyContinuationNote(readHandoffNote(mission,ref)"));

check("wiring: runFinalReviewSessions injects readRolloverDeadEnds for dead ends context",
  runFnSlice.includes("readRolloverDeadEnds(s,contScope)"));

check("wiring: runFinalReviewSessions consumes continuation with role code_reviewer allowance",
  runFnSlice.includes("consumeContinuation(s,c.policy,contScope,resolvePerRoleLimits(\"code_reviewer\",c.policy).continuationAllowance)"));

check("wiring: runFinalReviewSessions delegates next step to finalReviewNextStep",
  runFnSlice.includes("finalReviewNextStep({"));

check("wiring: runFinalReviewSessions handles continue step",
  runFnSlice.includes('if(step==="continue")'));

check("wiring: runFinalReviewSessions handles verdict_only turn step",
  runFnSlice.includes('if(step==="verdict_only")') && runFnSlice.includes("VERDICT-ONLY TURN:"));

check("wiring: runFinalReviewSessions handles escalate step with die and ap reset scope",
  runFnSlice.includes('if(step==="escalate")') && runFnSlice.includes("Resume: ap reset --scope"));

check("wiring: runFinalReviewSessions clears continuation and note on PASS/FAIL completion",
  runFnSlice.includes('clearContinuationRound(s,contScope)') && runFnSlice.includes('clearHandoffNote(mission,ref)'));

// ── Part 3: Scoped checks for each final-review site ──

// Site 1: SpecKit mission-final review
{
  const speckitPromptIdx = autopilotSrc.indexOf("const speckitFinalPrompt=");
  check("wiring: SpecKit final prompt builder present", speckitPromptIdx !== -1);
  const speckitCallIdx = autopilotSrc.indexOf("runFinalReviewSessions(c,s,{site:\"speckit\"", speckitPromptIdx);
  check("wiring: SpecKit final review calls runFinalReviewSessions with site speckit", speckitCallIdx !== -1);

  const speckitSlice = autopilotSrc.slice(speckitCallIdx, speckitCallIdx + 1500);
  check("wiring: SpecKit final review INCOMPLETE does not enter fix rounds (routes only on != PASS)",
    !speckitSlice.includes("INCOMPLETE treated as FAIL")
    && speckitSlice.includes("speckit mission-final review continuation chain")
    && speckitSlice.includes("final.review?.decision!==\"PASS\""));
}

// Site 2: Standalone early final review
{
  const earlyIdx = autopilotSrc.indexOf("site:\"standalone\",mission,requirements:missionRequirements,buildPrompt:()=>`${finalHandoff.text}${earlyFinalPassNotes");
  check("wiring: Standalone early final review calls runFinalReviewSessions with site standalone", earlyIdx !== -1);

  const earlySlice = autopilotSrc.slice(earlyIdx, earlyIdx + 1500);
  check("wiring: Standalone early final review INCOMPLETE does not enter fix rounds",
    !earlySlice.includes("INCOMPLETE treated as FAIL")
    && earlySlice.includes("standalone early final review continuation chain")
    && earlySlice.includes("final.review?.decision!==\"PASS\""));
}

// Site 3: Standalone mission-final review
{
  const standaloneIdx = autopilotSrc.indexOf("site:\"standalone\",mission,requirements:missionRequirements,buildPrompt:()=>`${finalHandoff.text}${standaloneFinalPassNotes");
  check("wiring: Standalone mission-final review calls runFinalReviewSessions with site standalone", standaloneIdx !== -1);

  const standaloneSlice = autopilotSrc.slice(standaloneIdx, standaloneIdx + 1500);
  check("wiring: Standalone mission-final review INCOMPLETE does not enter fix rounds",
    !standaloneSlice.includes("INCOMPLETE treated as FAIL")
    && standaloneSlice.includes("standalone mission-final review continuation chain")
    && standaloneSlice.includes("final.review?.decision!==\"PASS\""));
}

// Site 4: Standalone re-review rounds (inside runStandaloneFinalReviewFixRounds)
{
  const rereviewIdx = autopilotSrc.indexOf("async function runStandaloneFinalReviewFixRounds(");
  const rereviewEnd = autopilotSrc.indexOf("async function runStandaloneImplementation(", rereviewIdx);
  const rereviewSlice = rereviewIdx !== -1 && rereviewEnd !== -1
    ? autopilotSrc.slice(rereviewIdx, rereviewEnd)
    : "";

  check("wiring: Standalone fix-round reviewOnce calls runFinalReviewSessions with site standalone",
    rereviewSlice.includes("runFinalReviewSessions(c,s,{site:\"standalone\""));
  check("wiring: Standalone re-review round has no INCOMPLETE treated as FAIL log",
    !rereviewSlice.includes("INCOMPLETE treated as FAIL"));
}

// Site 5: SpecKit re-review rounds (inside speckit runFinalReviewFixRounds)
{
  const speckitFixIdx = autopilotSrc.indexOf("const speckitFinalFix=await runFinalReviewFixRounds({");
  const speckitFixEnd = autopilotSrc.indexOf("finalizeMissionComplete(s);", speckitFixIdx);
  const speckitFixSlice = speckitFixIdx !== -1 && speckitFixEnd !== -1
    ? autopilotSrc.slice(speckitFixIdx, speckitFixEnd)
    : "";

  check("wiring: SpecKit fix-round re-review calls runFinalReviewSessions with site speckit",
    speckitFixSlice.includes("runFinalReviewSessions(c,s,{site:\"speckit\""));
  check("wiring: SpecKit re-review round has no INCOMPLETE treated as FAIL log",
    !speckitFixSlice.includes("INCOMPLETE treated as FAIL"));
}

// ── Part 4: Absence of old "no continuation" logs for these sites ──

check("wiring: old SpecKit final review 'INCOMPLETE treated as FAIL' log is removed",
  !autopilotSrc.includes("SpecKit final review INCOMPLETE treated as FAIL"));
check("wiring: old Standalone early final review 'INCOMPLETE treated as FAIL' log is removed",
  !autopilotSrc.includes("Standalone early final review INCOMPLETE treated as FAIL"));
check("wiring: old Standalone final review 'INCOMPLETE treated as FAIL' log is removed",
  !autopilotSrc.includes("Standalone final review INCOMPLETE treated as FAIL"));
check("wiring: old SpecKit re-review 'INCOMPLETE treated as FAIL' log is removed",
  !autopilotSrc.includes("SpecKit mission-final final re-review round"));
check("wiring: old Standalone re-review 'INCOMPLETE treated as FAIL' log is removed",
  !autopilotSrc.includes("final re-review round") || !autopilotSrc.includes("INCOMPLETE treated as FAIL (no continuation)"));

console.log(`\n${ok} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
console.log("final-review continuation tests passed");
