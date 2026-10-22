#!/usr/bin/env node
// Mission 078 Phase 1 task 1.1 — isReviewerFeedbackFixPass + buildNoWorkAnswerSection cases.
import fs from "node:fs";
import {isReviewerFeedbackFixPass, buildNoWorkAnswerSection} from "./final-review-fix-rounds.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, evidence) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(String(evidence).slice(0, 500))}` : ""}`);
  failed += 1;
}
function neverThrows(fn, label) {
  try { return fn(); }
  catch (err) { check(`${label} never throws`, false, err?.message); return undefined; }
}

const REVIEWER_PREFIX = "Reviewer feedback from the previous attempt that MUST be addressed";

// ── Classifier: true only for reviewer-feedback wording after trimStart ──
// At least one fake copies the real leading '\n\n' (autopilot.mjs:6417/:6421/:6433).
check("reviewer brief with real leading \\n\\n is a fix pass",
  neverThrows(() => isReviewerFeedbackFixPass(`\n\n${REVIEWER_PREFIX} — fix every finding or rebut it with evidence, do not declare the work complete while any finding stands:\nfeedback body`), "leading-newlines") === true);
check("reviewer brief without leading whitespace is a fix pass",
  neverThrows(() => isReviewerFeedbackFixPass(`${REVIEWER_PREFIX} — fix every finding:\nbody`), "no-leading-ws") === true);
check("reviewer brief with spaces/tabs leading is a fix pass",
  neverThrows(() => isReviewerFeedbackFixPass(`   \t\n ${REVIEWER_PREFIX} — fix every finding`), "spaces-leading") === true);
check("empty first-pass brief is not a fix pass",
  neverThrows(() => isReviewerFeedbackFixPass(""), "empty") === false);
check("whitespace-only brief is not a fix pass",
  neverThrows(() => isReviewerFeedbackFixPass("\n\n   \n"), "ws-only") === false);
check("overlap re-run variant (:6437) is not a fix pass",
  neverThrows(() => isReviewerFeedbackFixPass("\n\nThis task is being re-run because the fix for task(s) T1 changed file(s) it owns: a.js. That fix is already done — do not redo it. Re-verify this task against its acceptance criteria and repair only what the change broke."), "overlap") === false);
check("local-check-failed variant (:6439) is not a fix pass",
  neverThrows(() => isReviewerFeedbackFixPass("\n\nThis task is being re-run because its own local check failed last time. Re-run that check and fix this task until it passes."), "local-check") === false);
check("generic re-verify variant (:6441) is not a fix pass",
  neverThrows(() => isReviewerFeedbackFixPass("\n\nThis task is being re-run. Re-verify it against its acceptance criteria."), "reverify") === false);
check("null is not a fix pass",
  neverThrows(() => isReviewerFeedbackFixPass(null), "null") === false);
check("undefined is not a fix pass",
  neverThrows(() => isReviewerFeedbackFixPass(undefined), "undefined") === false);
check("non-string number is not a fix pass",
  neverThrows(() => isReviewerFeedbackFixPass(123), "number") === false);
check("non-string object is not a fix pass",
  neverThrows(() => isReviewerFeedbackFixPass({}), "object") === false);
check("partial wording is not a fix pass",
  neverThrows(() => isReviewerFeedbackFixPass("\n\nReviewer feedback from the previous attempt"), "partial") === false);
check("throwing toString input never throws and is not a fix pass", (() => {
  const evil = {toString() { throw new Error("boom"); }};
  const out = neverThrows(() => isReviewerFeedbackFixPass(evil), "throwing-tostring");
  return out === false;
})());

// ── Renderer ──
check("renderer: empty array returns empty",
  neverThrows(() => buildNoWorkAnswerSection([]), "empty-arr") === "");
check("renderer: all-empty/whitespace summaries return empty",
  neverThrows(() => buildNoWorkAnswerSection(["", "   ", "\n\t "]), "all-empty") === "");
check("renderer: non-string entries alone return empty",
  neverThrows(() => buildNoWorkAnswerSection([null, 123, {}, undefined]), "non-strings") === "");
check("renderer: non-array returns empty",
  neverThrows(() => buildNoWorkAnswerSection(null), "null-arg") === ""
  && buildNoWorkAnswerSection("summary") === ""
  && buildNoWorkAnswerSection(undefined) === "");
check("renderer: single summary yields one labelled section",
  (() => {
    const out = neverThrows(() => buildNoWorkAnswerSection(["nothing to fix: rebuttal with evidence"]), "single");
    return typeof out === "string"
      && out.includes("Implementer's answer/rebuttal (no files changed)")
      && out.includes("nothing to fix: rebuttal with evidence")
      && (out.match(/Implementer's answer\/rebuttal \(no files changed\)/g) || []).length === 1;
  })());
check("renderer: multiple summaries join into one section",
  (() => {
    const out = neverThrows(() => buildNoWorkAnswerSection(["first reason", "second reason"]), "multi");
    return typeof out === "string"
      && out.includes("first reason") && out.includes("second reason")
      && (out.match(/Implementer's answer\/rebuttal \(no files changed\)/g) || []).length === 1;
  })());
check("renderer: output is short and bounded",
  (() => {
    const out = neverThrows(() => buildNoWorkAnswerSection(["x".repeat(5000)]), "bounded");
    return typeof out === "string"
      && out.includes("Implementer's answer/rebuttal (no files changed)")
      && out.length <= 2500;
  })());
check("renderer: empty entries filtered, non-empty kept",
  (() => {
    const out = neverThrows(() => buildNoWorkAnswerSection(["", "kept summary", "   "]), "filtered");
    return out !== "" && out.includes("kept summary");
  })());

// ── Re-review wiring (mission 078 task 1.3): fake-based stamp crossing ──
// Mirrors the PHASE_REREVIEW decision in scripts/autopilot.mjs: the answer
// section appears only when the round changed zero files (empty fixChunks)
// and >=1 per-task no-work stamp was made in the current revision (carried
// tasks' stale stamps ignored). The source pins below guard drift between
// this fake and the real site.
function fakeNoWorkAnswerSection({fixChunksLength, factsByTask, revision}) {
  const stamped = (factsByTask && typeof factsByTask === "object" && !Array.isArray(factsByTask))
    ? Object.values(factsByTask).filter((f) => f && typeof f === "object" && f.noWorkPerformed && typeof f.noWorkPerformed === "object" && f.noWorkPerformed.revision === revision)
    : [];
  if (fixChunksLength === 0 && stamped.length > 0) {
    return buildNoWorkAnswerSection(stamped.map((f) => (f.noWorkPerformed && typeof f.noWorkPerformed.summary === "string") ? f.noWorkPerformed.summary : (typeof f.summary === "string" ? f.summary : "")));
  }
  return "";
}
check("rereview fake: current stamp + empty chunks yields the labelled section",
  (() => {
    const out = neverThrows(() => fakeNoWorkAnswerSection({fixChunksLength: 0, revision: 3, factsByTask: {t1: {summary: "rebuttal with evidence", noWorkPerformed: {revision: 3, summary: "rebuttal with evidence"}}}}), "current-stamp");
    return typeof out === "string" && out.includes("Implementer's answer/rebuttal (no files changed)") && out.includes("rebuttal with evidence");
  })());
check("rereview fake: carried stale stamp + empty chunks yields no section",
  neverThrows(() => fakeNoWorkAnswerSection({fixChunksLength: 0, revision: 3, factsByTask: {t1: {summary: "old rebuttal", noWorkPerformed: {revision: 2, summary: "old rebuttal"}}}}), "stale-stamp") === "");
check("rereview fake: mixed current + stale keeps only the current summary",
  (() => {
    const out = neverThrows(() => fakeNoWorkAnswerSection({fixChunksLength: 0, revision: 3, factsByTask: {t0: {summary: "stale words", noWorkPerformed: {revision: 2, summary: "stale words"}}, t1: {summary: "fresh rebuttal", noWorkPerformed: {revision: 3, summary: "fresh rebuttal"}}}}), "mixed-stamps");
    return typeof out === "string" && out.includes("fresh rebuttal") && !out.includes("stale words")
      && (out.match(/Implementer's answer\/rebuttal \(no files changed\)/g) || []).length === 1;
  })());
check("rereview fake: current stamp + changed files yields no section",
  neverThrows(() => fakeNoWorkAnswerSection({fixChunksLength: 2, revision: 3, factsByTask: {t1: {summary: "rebuttal", noWorkPerformed: {revision: 3, summary: "rebuttal"}}}}), "changed-files") === "");
check("rereview fake: no stamps + empty chunks yields no section",
  neverThrows(() => fakeNoWorkAnswerSection({fixChunksLength: 0, revision: 3, factsByTask: {t1: {summary: "did work", files: ["a.js"]}}}), "no-stamps") === "");

// ── Source pins ──
{
  const src = fs.readFileSync(new URL("./final-review-fix-rounds.mjs", import.meta.url), "utf8");
  const autoSrc = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
  check("pin: isReviewerFeedbackFixPass exported next to isNoWorkPerformed",
    src.includes("export function isReviewerFeedbackFixPass(taskRetryFindings)") && src.includes("export function isNoWorkPerformed(runResult)"), null);
  check("pin: buildNoWorkAnswerSection exported",
    src.includes("export function buildNoWorkAnswerSection(summaries)"), null);
  check("pin: classifier trims leading whitespace",
    src.includes("trimStart()") && src.includes(REVIEWER_PREFIX), null);
  check("pin: renderer carries the labelled section",
    src.includes("Implementer's answer/rebuttal (no files changed)"), null);
  check("pin: standalone pass imports the no-work helpers",
    autoSrc.includes("isNoWorkPerformed") && autoSrc.includes("isReviewerFeedbackFixPass")
    && autoSrc.includes('from "./final-review-fix-rounds.mjs"'), null);
  check("pin: standalone commit stamps facts.noWorkPerformed with revision and summary",
    autoSrc.includes("noWorkPerformed") && autoSrc.includes("isReviewerFeedbackFixPass(taskRetryFindings)")
    && autoSrc.includes("isNoWorkPerformed(taskImpl)") && autoSrc.includes("revision:checkpoint.revision"), null);
  check("pin: re-review handoff threads the 1.1 renderer section",
    autoSrc.includes("noWorkAnswerSection") && autoSrc.includes("buildNoWorkAnswerSection(stamped.map")
    && autoSrc.includes('kind:"PHASE_REREVIEW"'), null);
  check("pin: re-review answer gated on empty fixChunks and current-revision stamps",
    autoSrc.includes("fixChunks.length===0&&stamped.length>0")
    && autoSrc.includes("f.noWorkPerformed.revision===checkpoint.revision"), null);
  check("pin: re-review answer rides implementationSummary with no approval shortcut",
    autoSrc.includes("implementationSummary:`${checkpoint.implementer?.summary??\"\"}${noWorkAnswerSection}`"), null);
  check("pin: gates() stays after Code Review PASS with no gates() at the re-review handoff",
    (() => {
      const rereviewIdx = autoSrc.indexOf('kind:"PHASE_REREVIEW"');
      const verifierIdx = autoSrc.indexOf('if(stage==="verifier"){', rereviewIdx);
      if (rereviewIdx === -1 || verifierIdx === -1) return false;
      const handoffSlice = autoSrc.slice(rereviewIdx, verifierIdx);
      const gatesAfter = autoSrc.indexOf("g=await gates(c,s)", verifierIdx);
      return !handoffSlice.includes("gates(c,s)") && gatesAfter !== -1
        && autoSrc.includes("// Only after Code Review PASS: run configured gates and the Verifier.");
    })(), null);
  check("pin: standalone pass imports the answer renderer",
    autoSrc.includes("buildNoWorkAnswerSection") && autoSrc.includes('from "./final-review-fix-rounds.mjs"'), null);
}

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("code-review-fix-no-work helper tests passed");
