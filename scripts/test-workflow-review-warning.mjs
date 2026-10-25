#!/usr/bin/env node
// Mission 098 task 1.4 — both-review-switches-off config warning.
//
// `workflow.final_review=false` plus `workflow.code_review_per_phase=false`
// turns every review off. That stays valid, but validateNewConfig must warn
// about it exactly once and stay silent for the default and one-off configs.
import {validateNewConfig} from "./config-validation.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  failed += 1;
}

function reviewWarnings(workflow) {
  const result = validateNewConfig(workflow === undefined ? {} : {workflow});
  return {
    result,
    hits: result.warnings.filter((w) => w.includes("final_review") && w.includes("code_review_per_phase")),
  };
}

// ── default (no workflow section) stays warning-free ──────────────────────
{
  const {result, hits} = reviewWarnings(undefined);
  check("default config is valid", result.valid === true, result);
  check("default config has no both-off warning", hits.length === 0, result.warnings);
}

// ── both switches on stays warning-free ───────────────────────────────────
{
  const {result, hits} = reviewWarnings({final_review: true, code_review_per_phase: true});
  check("both-on config is valid", result.valid === true, result);
  check("both-on config has no both-off warning", hits.length === 0, result.warnings);
}

// ── exactly one switch off stays warning-free ─────────────────────────────
{
  const phaseOff = reviewWarnings({final_review: true, code_review_per_phase: false});
  check("phase-review-only off is valid", phaseOff.result.valid === true, phaseOff.result);
  check("phase-review-only off has no both-off warning", phaseOff.hits.length === 0, phaseOff.result.warnings);

  const finalOff = reviewWarnings({final_review: false, code_review_per_phase: true});
  check("final-review-only off is valid", finalOff.result.valid === true, finalOff.result);
  check("final-review-only off has no both-off warning", finalOff.hits.length === 0, finalOff.result.warnings);
}

// ── both switches off warns exactly once, still valid ─────────────────────
{
  const {result, hits} = reviewWarnings({final_review: false, code_review_per_phase: false});
  check("both-off config is still valid", result.valid === true, result);
  check("both-off config warns exactly once", hits.length === 1, result.warnings);
  check("both-off warning names the no-review consequence",
    hits.length === 1 && /no code review will run/i.test(hits[0]), result.warnings);
  check("both-off config has no errors", result.errors.length === 0, result.errors);
}

console.log(`\n${ok} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
