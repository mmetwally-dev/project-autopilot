#!/usr/bin/env node
// Test for Backlog #6:
// - noteSaysOnlyGateLeft pure helper:
//   - true for real note fixture
//   - false when Next names a file edit or an open finding
//   - false when Found reports open findings
//   - false on empty/invalid inputs
// - clearContinuationRound clears state.verdictOnlyTurns
// - source checks in autopilot.mjs:
//   - all four branches (code_reviewer + verifier, standalone + SpecKit) call noteSaysOnlyGateLeft
//   - all four branches carry the VERDICT-ONLY line
//   - marker is cleared with clearContinuationRound

import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  noteSaysOnlyGateLeft,
  clearContinuationRound
} from "./per-task-budget.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
    return;
  }
  failures++;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

const VERDICT_ONLY_LINE = "VERDICT-ONLY TURN: the previous sessions found no open findings and only the gate was left. Do not run any tests or the gate. Decide PASS or FAIL now from the hand-off note and the delta; the orchestrator runs the gate.";

// ── 1. noteSaysOnlyGateLeft tests ──
const realNoteText = "Done: Entire supplied delta reviewed. All five prior findings corrected; all 8 phase suites pass (149 tests). Found: No new actionable delta/security issue. Next: collect full root gate — still running. Dead ends: Prior handoff artifacts absent, so checks restarted.";

check("noteSaysOnlyGateLeft true for real note text", noteSaysOnlyGateLeft(realNoteText) === true);

// Next names a file edit -> false
check("noteSaysOnlyGateLeft false when Next names editing a file",
  noteSaysOnlyGateLeft("Done: Reviewed. Found: No findings. Next: edit scripts/autopilot.mjs. Dead ends: none") === false);
check("noteSaysOnlyGateLeft false when Next names modifying a file",
  noteSaysOnlyGateLeft("Done: Delta reviewed. Found: None. Next: modify src/server.js to fix error. Dead ends: none") === false);
check("noteSaysOnlyGateLeft false when Next names file citation",
  noteSaysOnlyGateLeft("Done: Delta reviewed. Found: None. Next: fix auth.ts:42. Dead ends: none") === false);

// Next names an open finding -> false
check("noteSaysOnlyGateLeft false when Next names 1 finding left",
  noteSaysOnlyGateLeft("Done: Reviewed. Found: No findings. Next: 1 finding left to fix. Dead ends: none") === false);
check("noteSaysOnlyGateLeft false when Next names open finding",
  noteSaysOnlyGateLeft("Done: All good. Found: No findings. Next: resolve open finding in auth. Dead ends: none") === false);
check("noteSaysOnlyGateLeft false when Next combines gate with an edit",
  noteSaysOnlyGateLeft("Done: All good. Found: No findings. Next: collect gate and then update tests/api.mjs. Dead ends: none") === false);

// Found reports open finding -> false
check("noteSaysOnlyGateLeft false when Found reports 1 open finding",
  noteSaysOnlyGateLeft("Done: Reviewed. Found: 1 open finding in auth.js. Next: collect full root gate.") === false);
check("noteSaysOnlyGateLeft false when Found reports unresolved issue",
  noteSaysOnlyGateLeft("Done: Reviewed. Found: Unresolved issue in billing. Next: collect gate.") === false);

// Next variations that are only gate -> true
check("noteSaysOnlyGateLeft true for multiline note with collect full root gate",
  noteSaysOnlyGateLeft("## Done\nAll suites pass\n## Found\nNo new actionable findings\n## Next\ncollect full root gate\n## Dead ends\nnone") === true);
check("noteSaysOnlyGateLeft true for running full suite",
  noteSaysOnlyGateLeft("Done: 10 suites pass. Found: None. Next: run full suite. Dead ends: none") === true);
check("noteSaysOnlyGateLeft true for test-all",
  noteSaysOnlyGateLeft("Done: Clean. Found: 0 findings. Next: wait for test-all. Dead ends: none") === true);
check("noteSaysOnlyGateLeft true for waiting for gate",
  noteSaysOnlyGateLeft("Done: all findings corrected. Found: no findings. Next: waiting for gate. Dead ends: none") === true);

// Edge cases
check("noteSaysOnlyGateLeft false for empty string", noteSaysOnlyGateLeft("") === false);
check("noteSaysOnlyGateLeft false for null", noteSaysOnlyGateLeft(null) === false);
check("noteSaysOnlyGateLeft false for undefined", noteSaysOnlyGateLeft(undefined) === false);
check("noteSaysOnlyGateLeft false when Found section missing",
  noteSaysOnlyGateLeft("Done: all good. Next: collect gate.") === false);
check("noteSaysOnlyGateLeft false when Next section missing",
  noteSaysOnlyGateLeft("Done: all good. Found: No findings.") === false);

// ── 2. clearContinuationRound tests for verdictOnlyTurns ──
{
  const state = {
    verdictOnlyTurns: {
      "task:standalone:phase-0:code_reviewer": VERDICT_ONLY_LINE,
      "task:standalone:phase-0:verifier": VERDICT_ONLY_LINE
    }
  };
  const cleared = clearContinuationRound(state, "task:standalone:phase-0:code_reviewer");
  check("clearContinuationRound clears matching verdictOnlyTurns entry",
    cleared === true && !("task:standalone:phase-0:code_reviewer" in state.verdictOnlyTurns));
  check("clearContinuationRound leaves other verdictOnlyTurns untouched",
    "task:standalone:phase-0:verifier" in state.verdictOnlyTurns);
  const clearedAgain = clearContinuationRound(state, "task:standalone:phase-0:code_reviewer");
  check("clearContinuationRound returns false when entry already absent", clearedAgain === false);
}

// ── 3. Source checks in autopilot.mjs ──
const autopilotPath = path.join(here, "autopilot.mjs");
const autopilotSrc = fs.readFileSync(autopilotPath, "utf8");

check("autopilot imports noteSaysOnlyGateLeft",
  /import \{[^}]*noteSaysOnlyGateLeft[^}]*\} from "\.\/per-task-budget\.mjs"/.test(autopilotSrc));

check("MISSION_SCOPED_STATE_KEYS includes verdictOnlyTurns",
  /MISSION_SCOPED_STATE_KEYS=Object\.freeze\(\[[\s\S]*?"verdictOnlyTurns"[\s\S]*?\]\)/.test(autopilotSrc));

// Split into standalone and speckit regions
const standaloneSrc = autopilotSrc.split("async function runImplementation(c){")[0];
const speckitSrc = autopilotSrc.split("async function runImplementation(c){")[1] || "";

// Branch 1: Standalone code_reviewer capped branch
{
  const crCappedMatch = standaloneSrc.match(/const contScope=`task:standalone:phase-\$\{s\.phaseIndex\}:code_reviewer`;[\s\S]*?if\(!cont\.allowed\)\{([\s\S]*?)die\(`Standalone code review did not converge/);
  check("source: standalone code_reviewer capped branch calls noteSaysOnlyGateLeft",
    Boolean(crCappedMatch && /noteSaysOnlyGateLeft\(lastNote\)/.test(crCappedMatch[1])));
  check("source: standalone code_reviewer capped branch carries VERDICT-ONLY line",
    Boolean(crCappedMatch && crCappedMatch[1].includes(VERDICT_ONLY_LINE)));
}

// Branch 2: Standalone verifier capped branch
{
  const vfCappedMatch = standaloneSrc.match(/const contScope=`task:standalone:phase-\$\{s\.phaseIndex\}:verifier`;[\s\S]*?if\(!cont\.allowed\)\{([\s\S]*?)die\(`Standalone verification did not converge/);
  check("source: standalone verifier capped branch calls noteSaysOnlyGateLeft",
    Boolean(vfCappedMatch && /noteSaysOnlyGateLeft\(lastNote\)/.test(vfCappedMatch[1])));
  check("source: standalone verifier capped branch carries VERDICT-ONLY line",
    Boolean(vfCappedMatch && vfCappedMatch[1].includes(VERDICT_ONLY_LINE)));
}

// Branch 3: SpecKit code_reviewer capped branch
{
  const speckitCrMatch = speckitSrc.match(/const contScope=`task:speckit:phase-\$\{s\.phaseIndex\}:code_reviewer`;[\s\S]*?if\(!cont\.allowed\)\{([\s\S]*?)die\(`SpecKit code review did not converge/);
  check("source: speckit code_reviewer capped branch calls noteSaysOnlyGateLeft",
    Boolean(speckitCrMatch && /noteSaysOnlyGateLeft\(lastNote\)/.test(speckitCrMatch[1])));
  check("source: speckit code_reviewer capped branch carries VERDICT-ONLY line",
    Boolean(speckitCrMatch && speckitCrMatch[1].includes(VERDICT_ONLY_LINE)));
}

// Branch 4: SpecKit verifier capped branch
{
  const speckitVfMatch = speckitSrc.match(/const contScope=`task:speckit:phase-\$\{s\.phaseIndex\}:verifier`;[\s\S]*?if\(!cont\.allowed\)\{([\s\S]*?)die\(`SpecKit verification did not converge/);
  check("source: speckit verifier capped branch calls noteSaysOnlyGateLeft",
    Boolean(speckitVfMatch && /noteSaysOnlyGateLeft\(lastNote\)/.test(speckitVfMatch[1])));
  check("source: speckit verifier capped branch carries VERDICT-ONLY line",
    Boolean(speckitVfMatch && speckitVfMatch[1].includes(VERDICT_ONLY_LINE)));
}

// Check clearContinuationRound at all four verdict return sites
check("source: standalone code_reviewer verdict site calls clearContinuationRound",
  /rv\.status==="completed"&&\s*\(rv\.review\?\.decision==="PASS"\|\|rv\.review\?\.decision==="FAIL"\)\)\s*\{[\s\S]{0,100}?clearContinuationRound\(s,`task:standalone:phase-\$\{s\.phaseIndex\}:code_reviewer`\)/.test(standaloneSrc));

check("source: standalone verifier verdict site calls clearContinuationRound",
  /vv\.status==="completed"&&\s*\(vv\.review\?\.decision==="PASS"\|\|vv\.review\?\.decision==="FAIL"\)\)\s*\{[\s\S]{0,100}?clearContinuationRound\(s,`task:standalone:phase-\$\{s\.phaseIndex\}:verifier`\)/.test(standaloneSrc));

check("source: speckit code_reviewer verdict site calls clearContinuationRound",
  /rv\.status==="completed"&&\s*\(rv\.review\?\.decision==="PASS"\|\|rv\.review\?\.decision==="FAIL"\)\)\s*\{[\s\S]{0,100}?clearContinuationRound\(s,`task:speckit:phase-\$\{s\.phaseIndex\}:code_reviewer`\)/.test(speckitSrc));

check("source: speckit verifier verdict site calls clearContinuationRound",
  /vv\.status==="completed"&&\s*\(vv\.review\?\.decision==="PASS"\|\|vv\.review\?\.decision==="FAIL"\)\)\s*\{[\s\S]{0,100}?clearContinuationRound\(s,`task:speckit:phase-\$\{s\.phaseIndex\}:verifier`\)/.test(speckitSrc));

if (failures > 0) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log("All verdict-only turn checks passed.");
