#!/usr/bin/env node
// Mission 051 Phase 1 task 1.2 — final-review fix-round loop.
//
// Shared dependency-injected fix-round loop for the three final-review FAIL
// sites in scripts/autopilot.mjs (standalone early-final, standalone
// mission-final, SpecKit mission-final). A final-review FAIL records its
// findings, runs a bounded number of fix rounds (fix pass from a
// fixPassBriefExcerpts brief, then gate, then a final re-review), and only
// escalates when the budget is exhausted.
//
// Pure-IO split by construction: every side effect (finding record, fix
// brief, fix pass, gate, re-review, evidence check, state persistence) is an
// injected dependency defaulting to the real implementation, so the unit
// test drives the loop with fakes and never touches autopilot.mjs.
//
// Budget: a durable per-mission-run counter in mission state
// (`state[FINAL_REVIEW_FIX_ROUNDS_STATE_KEY]`, integer uses consumed) against
// `resolveFinalReviewFixRounds(policy)` (default 2). The counter is
// incremented and persisted (via the injected `saveState`) once per fix
// round, so it survives crashes and is shared by all three call sites.
//
// Bypass: evidence-refusal (`evidenceRefusal?.refuse === true`) and
// policy-violation (`review?.policyViolation` true or a reason string such as
// "read_only_violation") results never consume
// budget and never enter the loop — they return `{outcome:"bypass"}` so the
// caller keeps its existing escalate path untouched.
//
// Escalation keeps the existing contract: step `final_review`, message
// `Final review failed.` (the exact `die()` text the FAIL sites use today).
import {
  resolveFinalReviewFixRounds,
  FINAL_REVIEW_FIX_ROUNDS_DEFAULT,
} from "./per-task-budget.mjs";
import {
  recordFindingTasks as defaultRecordFindingTasks,
  loadFindingTasks as defaultLoadFindingTasks,
  fixPassBriefExcerpts as defaultFixPassBriefExcerpts,
} from "./finding-task-locality.mjs";

// Durable mission-state key holding the consumed fix-round count (integer).
export const FINAL_REVIEW_FIX_ROUNDS_STATE_KEY = "finalReviewFixRoundsUsed";
// Escalation contract preserved from the current FAIL sites.
export const FINAL_REVIEW_ESCALATION_STEP = "final_review";
export const FINAL_REVIEW_ESCALATION_MESSAGE = "Final review failed.";

export {FINAL_REVIEW_FIX_ROUNDS_DEFAULT};

// Read the consumed-round counter. Missing/malformed state reads as 0
// (fail-open towards allowing fix rounds, never throws).
export function readFinalReviewFixRoundsUsed(state) {
  const raw = Number(state?.[FINAL_REVIEW_FIX_ROUNDS_STATE_KEY]);
  return Number.isInteger(raw) && raw > 0 ? raw : 0;
}

// Rounds still available under the resolved policy budget. Never negative.
export function finalReviewFixRoundsRemaining(state, policy = {}) {
  const limit = resolveFinalReviewFixRounds(policy);
  return Math.max(0, limit - readFinalReviewFixRoundsUsed(state));
}

// Terminal reset: clear the consumed-round counter so the next mission run
// starts with a full budget. Called from finalizeMissionComplete in
// scripts/autopilot.mjs (the ONLY terminal-success transition); never called
// on escalation paths, so failure evidence is preserved.

export function resetFinalReviewFixRoundsUsed(state) {
  if (state != null && typeof state === "object" && !Array.isArray(state)) {
    delete state[FINAL_REVIEW_FIX_ROUNDS_STATE_KEY];
  }
  return state;
}

// Timeout-only INCOMPLETE helpers (mission 062): pure classifier over review
// findings plus gate-log PASS evidence. Gate-green evidence is a Set of
// green test-file basenames (e.g. `test-foo.mjs`); `parseGateGreenFiles`
// builds it and `isTimeoutOnlyCoveredByGateGreen` consumes it unchanged.

// Timeout signal: the reviewer could not finish running a test (its own
// tool timeout / killed / did-not-complete).
const TIMEOUT_SIGNAL_PATTERN = /timed?\s*[-_ ]?out|timeout|killed|did\s*[-_ ]?not\s*[-_ ]?complete|didn'?t\s*complete|not\s*complet/i;
// Named test file inside a finding (basename comparison happens downstream).
const FINDING_FILE_PATTERN = /[\w.-]+\.mjs/i;

function findingBasenameOf(text) {
  const match = String(text).match(FINDING_FILE_PATTERN);
  if (!match) return null;
  return match[0].split(/[\\/]/).pop();
}

function gateBasenameOf(text) {
  return String(text).split(/[\\/]/).pop();
}

// Strict classifier: true only when `findings` is a non-empty array and
// EVERY finding is a timeout/killed/did-not-complete signal on a named
// file. A single non-matching finding (code defect, timeout with no file)
// returns false. Never throws on malformed input.
export function isTimeoutOnlyFindings(findings) {
  if (!Array.isArray(findings) || findings.length === 0) return false;
  return findings.every((finding) =>
    typeof finding === "string"
    && TIMEOUT_SIGNAL_PATTERN.test(finding)
    && FINDING_FILE_PATTERN.test(finding));
}

// Pure gate-log parser: a file counts green only when a PASS line names it
// and no `TEST FAILED: <name>` line names it. PASS lines look like
// `PASS    7.2s  test-foo.mjs  1/10` (scripts/test-all.mjs); fail lines look
// like `TEST FAILED: test-foo.mjs (signal SIGKILL)`. Returns a Set of green
// basenames. Non-string input yields an empty Set (never throws).
export function parseGateGreenFiles(logText) {
  const passed = new Set();
  const failed = new Set();
  if (typeof logText !== "string" || logText === "") return new Set();
  for (const line of logText.split(/\r?\n/)) {
    const failMatch = line.match(/TEST FAILED:\s*(\S+)/);
    if (failMatch) {
      const name = failMatch[1].match(FINDING_FILE_PATTERN);
      if (name) failed.add(gateBasenameOf(name[0]));
      continue;
    }
    if (/^\s*PASS\b/.test(line)) {
      const name = line.match(FINDING_FILE_PATTERN);
      if (name) passed.add(gateBasenameOf(name[0]));
    }
  }
  return new Set([...passed].filter((name) => !failed.has(name)));
}

// Gate-green predicate: true only when every timeout finding names a file
// present in `greenFiles`, a Set of green basenames. Non-Set input (or any
// classifier failure) returns false. Never throws.
export function isTimeoutOnlyCoveredByGateGreen(findings, greenFiles) {
  if (!(greenFiles instanceof Set)) return false;
  if (!isTimeoutOnlyFindings(findings)) return false;
  return findings.every((finding) => greenFiles.has(findingBasenameOf(finding)));
}

// Bypass check: evidence-refusal and policy-violation paths skip the loop
// entirely (no budget consumed, no fix/gate/review calls). Only `true` or a
// non-empty reason string counts — other ambiguous input never bypasses.
export function isFinalReviewBypass({review, evidenceRefusal} = {}) {
  if (review != null && typeof review === "object" && (review.policyViolation === true || (typeof review.policyViolation === "string" && review.policyViolation !== ""))) return true;
  if (evidenceRefusal != null && typeof evidenceRefusal === "object" && evidenceRefusal.refuse === true) return true;
  return false;
}

// No-work classifier: true only when the fix pass completed with an empty
// `touchedFiles` array (`status === "completed"` and
// `Array.isArray(touchedFiles) && touchedFiles.length === 0`). `touchedFiles`
// only — no aliases. Every other or malformed shape returns false. Never
// throws (a throwing `touchedFiles` getter still returns false).
export function isNoWorkPerformed(runResult) {
  try {
    if (runResult == null || typeof runResult !== "object") return false;
    if (runResult.status !== "completed") return false;
    const touchedFiles = runResult.touchedFiles;
    return Array.isArray(touchedFiles) && touchedFiles.length === 0;
  } catch { return false; }
}

// Reviewer-feedback fix-pass classifier (mission 078 task 1.1): true only
// when `taskRetryFindings` is a string whose leading-whitespace-trimmed
// text starts with the reviewer-feedback wording used by the standalone
// task implementer pass (`scripts/autopilot.mjs`: the real briefs start
// with '\n\n' before that wording). Empty first-pass briefs (""), the
// re-verify/carry variants ("This task is being re-run..."), and
// non-strings all return false. Never throws.
export function isReviewerFeedbackFixPass(taskRetryFindings) {
  try {
    if (typeof taskRetryFindings !== "string") return false;
    if (taskRetryFindings === "") return false;
    return taskRetryFindings.trimStart().startsWith("Reviewer feedback from the previous attempt that MUST be addressed");
  } catch { return false; }
}

// No-work answer/rebuttal renderer (mission 078 task 1.1): builds the
// single short labelled section threaded into the re-review handoff when
// a reviewer-feedback round changed zero files. Returns "" when there is
// no non-empty summary string; otherwise returns exactly one section
// labelled "Implementer's answer/rebuttal (no files changed)" with the
// joined summaries bounded to 2000 chars. Never throws.
export function buildNoWorkAnswerSection(summaries) {
  try {
    if (!Array.isArray(summaries)) return "";
    const nonEmpty = summaries.filter((s) => typeof s === "string" && s.trim() !== "");
    if (nonEmpty.length === 0) return "";
    const joined = nonEmpty.join("\n").slice(0, 2000);
    return `\n\nImplementer's answer/rebuttal (no files changed):\n${joined}`;
  } catch { return ""; }
}

// Reviewer-infrastructure classifier (backlog #86): true when `review` is a
// result object that carries no usable verdict — the run did not complete
// (timeout, api_retry, failed status) or completed with no decision. Such a
// result is an infrastructure failure of the REVIEWER, never a code FAIL, so
// it must never reach an implementer fix pass. Null/non-object input is not
// classified (false). Never throws.
export function isReviewerNoVerdict(review) {
  try {
    if (review == null || typeof review !== "object") return false;
    if (typeof review.status === "string" && review.status !== "completed") return true;
    return review.status === "completed" && !review.policyViolation
      && typeof review.review?.decision !== "string";
  } catch { return false; }
}

// Consume one fix round: increment the durable counter and persist it via
// the injected `saveState` (a no-op default for pure unit use). Returns
// `{allowed, used, limit}` — `allowed` is true while the consumed count is
// within the resolved budget.
export function consumeFinalReviewFixRound(state, policy = {}, {saveState = null} = {}) {
  const limit = resolveFinalReviewFixRounds(policy);
  const used = readFinalReviewFixRoundsUsed(state) + 1;
  if (state != null && typeof state === "object" && !Array.isArray(state)) {
    state[FINAL_REVIEW_FIX_ROUNDS_STATE_KEY] = used;
  }
  if (typeof saveState === "function") {
    try { saveState(); } catch { /* persistence is best-effort here; the counter is already in state */ }
  }
  return {allowed: used <= limit, used, limit};
}

// Thin wrapper so call sites import one module for the fix brief. Findings
// are the rendered-finding strings; `readFile` confines excerpt reads.
export function buildFinalReviewFixBrief(findings, readFile, options = {}, {fixPassBriefExcerpts = defaultFixPassBriefExcerpts} = {}) {
  return fixPassBriefExcerpts(findings, readFile, options);
}

// The fix-round loop.
//
// Inputs:
//   - `state`, `policy`: durable mission state + config policy (budget).
//   - `initialReview`: the FAIL review result that triggered the loop.
//   - `initialEvidenceRefusal`: the evidence check for the initial review
//     (`shouldRefusePassForEvidence()` output or compatible `{refuse}`).
//   - `initialFindings`: rendered-finding strings of the FAIL review.
//   - `gateGreenFiles`: Set of green test-file basenames from the latest gate
//     log (see `parseGateGreenFiles`; task 1.3 threads it from `gates()`).
//     Timeout-only initial findings covered by this Set are accepted without
//     entering the fix-round loop (initial-review-only).
//   - `recordArgs`: optional `{key, phaseTaskDigest, taskIds, factsByTask,
//     revision, carryAllowed}` recorded via `recordFindingTasks` before the
//     first round (skipped when `key` is absent).
//   - `readFile`: excerpt reader for the fix brief (may be null).
//   - `saveState`: persistence callback invoked after every counter write.
//   - `deps`: injected collaborators, each defaulting to the real one:
//       `recordFindingTasks`, `loadFindingTasks`, `buildFixBrief`,
//       `runFixPass({brief, findings, round, used, limit})` (returns the
//       fix result with `{status, touchedFiles, finalMessage}`; an empty
//       `touchedFiles` on a completed result is the no-work path),
//       `runGate({round, used, limit})` (gate evidence for the re-review;
//       skipped on the no-work path, where `gate` is null),
//       `runFinalReview({round, used, limit, gate, brief, summary})` (the
//       re-review; `summary` is the threaded implementer string
//       (`typeof finalMessage === "string" ? finalMessage : ""`) on the
//       no-work path and absent on the changed-files path),
//       `checkEvidenceRefusal({review, gate})` (returns `{refuse}` or null),
//       `recordReviewerFailure({review, noVerdict})` (backlog #86: records the
//       reviewer failure against the infrastructure budget and returns
//       `{allowed, step?, message?}`; absent → escalate at once). A review
//       with no verdict, or a FAIL/INCOMPLETE with zero findings, never
//       dispatches a fix pass: the reviewer alone is re-run through
//       `runFinalReview({reviewerRetry:true,...})` while `allowed`, else the
//       loop escalates with the returned `step`/`message`.
//
// Returns (never throws on injected-result shapes):
//   - `{outcome:"bypass", review, evidenceRefusal}` — refusal/policy path.
//   - `{outcome:"passed", review, roundsUsed, limit}` — re-review PASSED
//     with no refusal (a mid-loop refusal still bypasses, never passes), or
//     timeout-only initial findings covered by `gateGreenFiles` (accepted
//     before the loop: no budget consumed, no fix pass, one log line).
//   - `{outcome:"escalate", review, step, message, roundsUsed, limit}` —
//     budget exhausted; `step`/`message` preserve the FAIL-site contract.
//   - Timeout-only re-reviews after a fix pass are NEVER accepted here —
//     only the initial review takes the gate-green path; later timeout-only
//     findings flow through the next round or escalate.
export async function runFinalReviewFixRounds({
  state = null,
  policy = {},
  initialReview = null,
  initialEvidenceRefusal = null,
  initialFindings = [],
  gateGreenFiles = null,
  recordArgs = null,
  readFile = null,
  saveState = null,
  deps = {},
} = {}) {
  const {
    recordFindingTasks = defaultRecordFindingTasks,
    loadFindingTasks = defaultLoadFindingTasks,
    buildFixBrief = (findings, reader, options) => defaultFixPassBriefExcerpts(findings, reader, options),
    runFixPass = null,
    runGate = null,
    runFinalReview = null,
    checkEvidenceRefusal = null,
    recordReviewerFailure = null,
  } = deps || {};

  const limit = resolveFinalReviewFixRounds(policy);

  // Bypass before anything else: no record, no budget, no calls.
  if (isFinalReviewBypass({review: initialReview, evidenceRefusal: initialEvidenceRefusal})) {
    return {outcome: "bypass", review: initialReview, evidenceRefusal: initialEvidenceRefusal, roundsUsed: readFinalReviewFixRoundsUsed(state), limit};
  }

  // Timeout-only INCOMPLETE acceptance (mission 062 task 1.2):
  // initial-review-only. When every initial finding is a timeout on a named
  // file already green in the latest gate log, accept without consuming
  // budget, recording findings, or running a fix pass. Bypass above wins
  // over this path; re-reviews inside the loop below never take it.
  if (isTimeoutOnlyCoveredByGateGreen(Array.isArray(initialFindings) ? initialFindings : [], gateGreenFiles)) {
    const names = [...new Set(
      initialFindings.map((finding) => findingBasenameOf(finding)).filter((name) => name !== null),
    )];
    try { console.log(`Final review timeout-only INCOMPLETE accepted via gate green: ${names.join(", ")}`); } catch { /* logging is best-effort */ }
    return {outcome: "passed", review: initialReview, gate: null, roundsUsed: readFinalReviewFixRoundsUsed(state), limit};
  }

  // Finding record for the retry chain (best-effort: a throwing recorder
  // must not break the loop — the brief still carries the findings text).
  let findingRecord = null;
  if (recordArgs != null && typeof recordArgs === "object" && typeof recordArgs.key === "string" && recordArgs.key) {
    try {
      findingRecord = recordFindingTasks(state, recordArgs.key, {
        phaseTaskDigest: recordArgs.phaseTaskDigest,
        findings: Array.isArray(initialFindings) ? initialFindings : [],
        taskIds: recordArgs.taskIds,
        factsByTask: recordArgs.factsByTask,
        revision: recordArgs.revision,
        carryAllowed: recordArgs.carryAllowed,
      });
    } catch { findingRecord = null; }
    try {
      const loaded = loadFindingTasks(state, recordArgs.key, {phaseTaskDigest: recordArgs.phaseTaskDigest});
      if (loaded !== null) findingRecord = loaded;
    } catch { /* keep the recorded value */ }
  }

  let findings = Array.isArray(initialFindings) ? [...initialFindings] : [];
  let review = initialReview;

  const findingsOf = (candidate, fallback) =>
    Array.isArray(candidate?.review?.findings) ? [...candidate.review.findings]
      : Array.isArray(candidate?.findings) ? [...candidate.findings]
      : fallback;

  for (;;) {
    // Backlog #86 guard (never dispatch an implementer with nothing to fix):
    // a no-verdict review (timeout/api_retry/failed) or a FAIL/INCOMPLETE
    // with zero findings is a reviewer failure. Record it on the
    // infrastructure budget and re-run the reviewer only; escalate when the
    // budget is spent. No fix round is consumed and no fix pass runs.
    const noVerdict = isReviewerNoVerdict(review);
    if (noVerdict || (findings.length === 0 && review != null && typeof review === "object")) {
      let decision = null;
      if (typeof recordReviewerFailure === "function") {
        decision = await recordReviewerFailure({review, noVerdict});
      }
      if (decision?.allowed !== true || typeof runFinalReview !== "function") {
        return {
          outcome: "escalate",
          review,
          step: decision?.step || FINAL_REVIEW_ESCALATION_STEP,
          message: decision?.message || FINAL_REVIEW_ESCALATION_MESSAGE,
          roundsUsed: readFinalReviewFixRoundsUsed(state),
          limit,
        };
      }
      review = await runFinalReview({round: readFinalReviewFixRoundsUsed(state), used: readFinalReviewFixRoundsUsed(state), limit, gate: null, brief: null, reviewerRetry: true});
      let retryRefusal = null;
      if (typeof checkEvidenceRefusal === "function") {
        try { retryRefusal = checkEvidenceRefusal({review, gate: null}); } catch { retryRefusal = null; }
      }
      if (isFinalReviewBypass({review, evidenceRefusal: retryRefusal})) {
        return {outcome: "bypass", review, evidenceRefusal: retryRefusal, gate: null, roundsUsed: readFinalReviewFixRoundsUsed(state), limit};
      }
      if (review != null && typeof review === "object"
        && review.status === "completed" && !review.policyViolation
        && review.review?.decision === "PASS") {
        return {outcome: "passed", review, gate: null, roundsUsed: readFinalReviewFixRoundsUsed(state), limit};
      }
      findings = findingsOf(review, []);
      continue;
    }
    const remaining = finalReviewFixRoundsRemaining(state, policy);
    if (remaining <= 0) {
      return {
        outcome: "escalate",
        review,
        step: FINAL_REVIEW_ESCALATION_STEP,
        message: FINAL_REVIEW_ESCALATION_MESSAGE,
        roundsUsed: readFinalReviewFixRoundsUsed(state),
        limit,
      };
    }
    const {used} = consumeFinalReviewFixRound(state, policy, {saveState});
    const round = used;

    let brief = null;
    try {
      brief = buildFixBrief(findings, readFile, {});
    } catch { brief = null; }

    let fixResult = null;
    if (typeof runFixPass === "function") {
      fixResult = await runFixPass({brief, findings: [...findings], record: findingRecord, round, used, limit});
    }
    // No-work path (mission 071): a completed fix pass that touched no
    // files skips the gate and threads the implementer's summary string
    // into the re-review. Every other or malformed shape falls back to
    // the old path (gate as before, no summary field). The round was
    // already consumed above, so a no-work round still burns budget.
    const noWork = isNoWorkPerformed(fixResult);
    let noWorkSummary = "";
    if (noWork) {
      try {
        const finalMessage = fixResult?.finalMessage;
        noWorkSummary = typeof finalMessage === "string" ? finalMessage : "";
      } catch { noWorkSummary = ""; }
    }
    let gate = null;
    if (!noWork && typeof runGate === "function") {
      gate = await runGate({round, used, limit});
    }
    if (typeof runFinalReview === "function") {
      review = noWork
        ? await runFinalReview({round, used, limit, gate, brief, summary: noWorkSummary})
        : await runFinalReview({round, used, limit, gate, brief});
    } else {
      break;
    }

    // Mid-loop bypass: refusal or policy violation ends the loop without
    // consuming further rounds.
    let refusal = null;
    if (typeof checkEvidenceRefusal === "function") {
      try { refusal = checkEvidenceRefusal({review, gate}); } catch { refusal = null; }
    }
    if (isFinalReviewBypass({review, evidenceRefusal: refusal})) {
      return {outcome: "bypass", review, evidenceRefusal: refusal, gate, roundsUsed: readFinalReviewFixRoundsUsed(state), limit};
    }

    if (review != null && typeof review === "object"
      && review.status === "completed" && !review.policyViolation
      && review.review?.decision === "PASS") {
      return {outcome: "passed", review, gate, roundsUsed: readFinalReviewFixRoundsUsed(state), limit};
    }

    // Next round retries against the latest findings.
    // A re-review without findings arrays clears them, so the zero-findings
    // guard at the loop top (backlog #86) takes over instead of a fix pass.
    findings = findingsOf(review, []);
  }

  return {
    outcome: "escalate",
    review,
    step: FINAL_REVIEW_ESCALATION_STEP,
    message: FINAL_REVIEW_ESCALATION_MESSAGE,
    roundsUsed: readFinalReviewFixRoundsUsed(state),
    limit,
  };
}
