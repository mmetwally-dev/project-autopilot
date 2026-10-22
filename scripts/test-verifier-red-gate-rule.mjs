#!/usr/bin/env node
// Mission 065 task 1.2: red-gate verifier rule wiring contract.
//
// formatGateResult (scripts/standalone-handoff.mjs) is shared by the
// standalone PHASE_VERIFY handoff and the SpecKit verifier prompt
// (scripts/autopilot.mjs:8349). Only a failed result swaps the
// cause-analysis sentence for the red-gate rule; all-PASS output keeps
// the original line-196 sentence byte-identical.
import assert from "node:assert/strict";
import fs from "node:fs";
import {formatRedGateVerdictRule} from "./verifier-brief.mjs";
import {buildStandaloneHandoff, formatGateResult} from "./standalone-handoff.mjs";

const CAUSE_SENTENCE = "analyse the provided output and name the cause";
const ORIGINAL_INSTRUCTIONS = "Instructions: the full suite has already run as the phase gate. Do not re-run the whole suite; re-run a single test only if a specific claim is in doubt. On gate FAIL, analyse the provided output and name the cause.";

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

const redResultsArray = {
  ok: false,
  results: [
    {command: "node scripts/test-a.mjs", ok: true, exitCode: 0, durationMs: 10, logFile: null, tail: "ok"},
    {command: "node scripts/test-b.mjs", ok: false, exitCode: 1, durationMs: 20, logFile: null, tail: "FAIL-MARKER"},
  ],
};
const redSingleShape = {command: "node scripts/test-a.mjs", ok: false, exitCode: 1, durationMs: 20, logFile: null, tail: "FAIL-MARKER"};
const greenResultsArray = {
  ok: true,
  results: [
    {command: "node scripts/test-a.mjs", ok: true, exitCode: 0, durationMs: 10, logFile: null, tail: "ok"},
  ],
};
const greenSingleShape = {command: "node scripts/test-a.mjs", ok: true, exitCode: 0, durationMs: 10, logFile: null, tail: "ok"};

const expectedRule = formatRedGateVerdictRule(redResultsArray);
assert.ok(expectedRule.length > 0, "helper must return a non-empty rule for red gates");

// --- formatGateResult: red gates in both shapes carry the rule exactly once, no cause sentence ---
for (const [label, gate] of [["results-array", redResultsArray], ["single-shape", redSingleShape]]) {
  const out = formatGateResult(gate);
  const rule = formatRedGateVerdictRule(gate);
  assert.equal(rule, expectedRule, `red ${label} rule text must match helper output`);
  assert.equal(countOccurrences(out, rule), 1, `red ${label} formatGateResult must carry the rule exactly once`);
  assert.ok(!out.includes(CAUSE_SENTENCE), `red ${label} output must not carry the cause-analysis sentence`);
}
console.log("PASS red-gate formatGateResult carries the rule once with no cause-analysis instruction in both shapes");

// --- formatGateResult: green gates carry no rule and keep the original line-196 sentence ---
for (const [label, gate] of [["results-array", greenResultsArray], ["single-shape", greenSingleShape]]) {
  const out = formatGateResult(gate);
  assert.ok(!out.includes(expectedRule), `green ${label} output must not carry the red-gate rule`);
  assert.ok(out.includes(ORIGINAL_INSTRUCTIONS), `green ${label} output must keep the original line-196 sentence`);
  assert.ok(out.includes(CAUSE_SENTENCE), `green ${label} output must keep the cause-analysis sentence`);
}
console.log("PASS green-gate formatGateResult is rule-free and keeps the original line-196 sentence");

// --- standalone loop assembly: PHASE_VERIFY handoff ---
{
  const phaseTasks = [{file: "/repo/TASKS.md", line: 3, text: "Do the thing"}];
  const base = {kind: "PHASE_VERIFY", phaseName: "Phase 1", phaseIndex: 0, phaseTotal: 1, phaseTasks, attempt: 1, deltaChunks: [{path: "a.js", text: "diff"}], baselineKey: "mission-065-t1.2", declaredPaths: [], implementationSummary: ""};
  const redHandoff = buildStandaloneHandoff({...base, gateResult: redResultsArray});
  assert.equal(countOccurrences(redHandoff.text, expectedRule), 1, "standalone red handoff must carry the rule exactly once");
  assert.ok(!redHandoff.text.includes(CAUSE_SENTENCE), "standalone red handoff must not carry the cause-analysis sentence");
  const greenHandoff = buildStandaloneHandoff({...base, gateResult: greenResultsArray});
  assert.ok(!greenHandoff.text.includes(expectedRule), "standalone green handoff must not carry the red-gate rule");
  assert.ok(greenHandoff.text.includes(ORIGINAL_INSTRUCTIONS), "standalone green handoff must keep the original sentence");
  console.log("PASS standalone PHASE_VERIFY handoff carries the rule once for red gates, unchanged for green");
}

// --- SpecKit loop assembly: verifier prompt composes the shared formatGateResult ---
{
  const autoSrc = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
  assert.ok(autoSrc.includes("formatGateResult(g)"), "SpecKit verifier wiring (formatGateResult(g)) missing in autopilot.mjs");
  // The SpecKit gate section is exactly the shared renderer output.
  const speckitGateSection = formatGateResult(redResultsArray);
  assert.equal(countOccurrences(speckitGateSection, expectedRule), 1, "SpecKit red gate section must carry the rule exactly once");
  assert.ok(!speckitGateSection.includes(CAUSE_SENTENCE), "SpecKit red gate section must not carry the cause-analysis sentence");
  const speckitGreen = formatGateResult(greenResultsArray);
  assert.ok(speckitGreen.includes(ORIGINAL_INSTRUCTIONS), "SpecKit green gate section must keep the original sentence");
  console.log("PASS SpecKit verifier gate section carries the rule once for red gates, unchanged for green");
}

console.log("verifier red-gate rule tests passed");
