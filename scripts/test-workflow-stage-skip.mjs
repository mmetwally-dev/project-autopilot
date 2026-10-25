#!/usr/bin/env node
// Mission 098 task 1.1 — skipCheckpointStage() contract.
//
// A skipped stage is a forward-only advance validated by the same transition
// table as every other edge: it never invents an edge, never consumes or
// grants an approval, and never mutates the input checkpoint or its counters.
import {
  createCheckpoint, deltaDigest, resumeStage, skipCheckpointStage,
  validateTransition, INVALID_CODE,
} from "./phase-stage-checkpoint.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  failed += 1;
}

const baseInput = {
  framework: "standalone",
  mission: "098-example",
  phaseIndex: 0,
  phaseName: "Phase 1",
  tasks: [
    {file: "/repo/TASKS.md", line: 3, text: "Build the widget"},
    {file: "/repo/TASKS.md", line: 4, text: "Ship the widget"},
  ],
  repoRoot: "/repo",
  baselineKey: "mission-098-example-phase-0",
};

function makeCheckpoint(overrides = {}) {
  return {
    ...createCheckpoint({...baseInput, at: "2026-01-01T00:00:00.000Z"}),
    ...overrides,
  };
}

check("exports skipCheckpointStage", typeof skipCheckpointStage === "function");

// ── code_reviewer -> verifier is an allowed skip ──────────────────────────
{
  const attempts = {implementer: 2, code_reviewer: 3, verifier: 4};
  const codeReviewer = {decision: "FAIL", runId: "run-1", findings: [{id: "F1"}]};
  const checkpoint = makeCheckpoint({
    nextStage: "code_reviewer",
    runningStage: null,
    revision: 7,
    deltaDigest: deltaDigest("delta-1"),
    attempts,
    codeReviewer,
  });
  const before = JSON.stringify(checkpoint);
  const transition = skipCheckpointStage(checkpoint, "verifier", "workflow.code_review_per_phase=false");

  check("skip code_reviewer -> verifier allowed",
    transition.ok === true && transition.action === "advance" && transition.nextStage === "verifier", transition);
  check("skip keeps revision unchanged", transition.revision === checkpoint.revision, transition);
  check("skip keeps attempts unchanged",
    JSON.stringify(transition.attempts) === JSON.stringify(attempts), transition.attempts);
  check("skip attempts is a copy, not the checkpoint record",
    transition.attempts !== attempts, transition.attempts);
  check("skip carries no approval fields",
    !("clearApprovals" in transition) && !("findings" in transition) && !("runId" in transition) &&
    !("deltaDigest" in transition), transition);
  check("skip records the supplied reason",
    transition.reason === "workflow.code_review_per_phase=false", transition.reason);
  check("skip does not mutate the input checkpoint", JSON.stringify(checkpoint) === before, before);
  check("skip leaves codeReviewer untouched",
    JSON.stringify(checkpoint.codeReviewer) === JSON.stringify(codeReviewer), checkpoint.codeReviewer);
  check("skip is a normal validated edge",
    validateTransition("code_reviewer", "verifier").ok === true);
  check("skipped checkpoint resumes at verifier",
    resumeStage({...checkpoint, ...transition}) === "verifier", resumeStage({...checkpoint, ...transition}));
}

// ── Backward skips are rejected by the shared transition table ────────────
{
  const checkpoint = makeCheckpoint({
    nextStage: "verifier",
    deltaDigest: deltaDigest("delta-1"),
    attempts: {implementer: 1, code_reviewer: 1, verifier: 1},
  });
  const before = JSON.stringify(checkpoint);
  const transition = skipCheckpointStage(checkpoint, "code_reviewer", "nope");

  check("skip verifier -> code_reviewer rejected",
    transition.ok === false && transition.code === INVALID_CODE, transition);
  check("rejected skip reports the requested edge",
    transition.evidence?.from === "verifier" && transition.evidence?.to === "code_reviewer", transition);
  check("rejected skip does not mutate the checkpoint", JSON.stringify(checkpoint) === before, before);
}

// ── Invalid checkpoints and unknown stages fail closed ────────────────────
{
  const badVersion = {...makeCheckpoint({nextStage: "code_reviewer", deltaDigest: deltaDigest("d")}), version: 99};
  const rv = skipCheckpointStage(badVersion, "verifier", "skip");
  check("skip rejects an invalid checkpoint", rv.ok === false && rv.code === INVALID_CODE, rv);

  const checkpoint = makeCheckpoint({nextStage: "code_reviewer", deltaDigest: deltaDigest("d")});
  const rb = skipCheckpointStage(checkpoint, "bogus", "skip");
  check("skip rejects an unknown destination", rb.ok === false && rb.code === INVALID_CODE, rb);
}

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
