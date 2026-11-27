#!/usr/bin/env node
// Backlog #9: the final (whole-mission) review is never measured: its kill
// deadline is relay_timeout_ms (or the policy override). Per-phase review
// durations must not set it, and final-review durations must not inflate
// phase deadlines.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {deriveRoleDeadline, deriveFinalReviewDeadline, collectRoleSamples, isFinalReviewRun} from "./role-deadline.mjs";

const RELAY = 200 * 60 * 1000;
const MIN = 60 * 1000;
let failed = 0;
function check(name, cond, evidence) {
  if (cond) { console.log(`PASS ${name}`); return; }
  console.error(`FAIL ${name} :: ${JSON.stringify(evidence)}`); failed += 1;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-final-deadline-"));
let n = 0;
function seed(dir, role, minutes, taskRef) {
  n += 1;
  const name = `${String(n).padStart(2, "0")}-${role}-${n}`;
  fs.mkdirSync(path.join(dir, name), {recursive: true});
  const status = {status: "completed", role, exit_code: 0, duration_ms: minutes * MIN,
    started_at: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString()};
  if (taskRef !== undefined) status.taskRef = taskRef;
  fs.writeFileSync(path.join(dir, name, "status.json"), JSON.stringify(status));
}
const derive = (samples) => deriveRoleDeadline({samplesMs: samples, relayTimeoutMs: RELAY});

try {
  check("isFinalReviewRun: only final-review-* taskRefs",
    isFinalReviewRun({taskRef: "final-review-standalone"}) && isFinalReviewRun({taskRef: "final-review-speckit"})
    && !isFinalReviewRun({taskRef: "T1.1"}) && !isFinalReviewRun({taskRef: "final-fix-standalone"})
    && !isFinalReviewRun({}) && !isFinalReviewRun(null));

  // 1. Short per-phase reviews, no earlier final review -> backstop, not 10 min.
  const a = path.join(root, "a");
  [1, 2, 3, 4].forEach((m, i) => seed(a, "code_reviewer", m, `T${i + 1}`));
  seed(a, "code_reviewer", 1, undefined); // old record without taskRef = phase
  const legacyA = derive(collectRoleSamples(a, "code_reviewer", []));
  check("(contrast) measuring from phase samples would give the 10 min floor",
    legacyA.timeoutMs === 10 * MIN, legacyA);
  const finalA = deriveFinalReviewDeadline({relayTimeoutMs: RELAY});
  check("final review with phase samples only uses relay_timeout_ms",
    finalA.timeoutMs === RELAY && finalA.source === "default", finalA);

  // 2. Earlier final-review samples (short verdict-only turns) do not shrink it.
  const b = path.join(root, "b");
  [1, 2, 3, 4].forEach((m, i) => seed(b, "code_reviewer", m, `T${i + 1}`));
  seed(b, "code_reviewer", 1, "final-review-standalone");
  seed(b, "code_reviewer", 3.7, "final-review-standalone");
  check("final review ignores earlier final-review samples (still relay_timeout_ms)",
    deriveFinalReviewDeadline({relayTimeoutMs: RELAY}).timeoutMs === RELAY);
  check("final review honours a policy override below the backstop",
    deriveFinalReviewDeadline({relayTimeoutMs: RELAY, override: 60 * MIN}).timeoutMs === 60 * MIN
    && deriveFinalReviewDeadline({relayTimeoutMs: RELAY, override: 60 * MIN}).source === "policy");
  check("final review uses a custom relay_timeout_ms",
    deriveFinalReviewDeadline({relayTimeoutMs: 90 * MIN}).timeoutMs === 90 * MIN);

  // 3. Phase deadline ignores final-review samples.
  const phaseB = derive(collectRoleSamples(b, "code_reviewer", [], undefined, "phase"));
  check("phase deadline is unaffected by final-review samples",
    phaseB.sampleCount === 4 && phaseB.longestMs === 4 * MIN && phaseB.timeoutMs === 10 * MIN, phaseB);
  seed(b, "code_reviewer", 30, "final-review-speckit");
  const phaseB2 = derive(collectRoleSamples(b, "code_reviewer", [], undefined, "phase"));
  check("a long final-review sample does not inflate the phase deadline",
    phaseB2.longestMs === 4 * MIN && phaseB2.timeoutMs === 10 * MIN, phaseB2);

  // 4. Verifier samples are role-filtered, so a final review never touches them.
  seed(b, "verifier", 2, "T1");
  const ver = collectRoleSamples(b, "verifier", [], undefined, "phase");
  check("verifier phase samples are unaffected by final-review runs",
    ver.length === 1 && ver[0] === 2 * MIN, ver);

  // 5. Repo-wide fallback is phase-scoped too.
  const empty = path.join(root, "empty");
  const fb = collectRoleSamples(empty, "code_reviewer", [a, b], undefined, "phase");
  check("fallback dirs contribute no final-review samples to phase deadlines",
    fb.length === 9 && fb.every((ms) => ms <= 4 * MIN), fb);

  // 6. Wiring: the final-review call site opts in; per-phase sites do not.
  const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
  const finalSites = src.match(/roleDeadline\(c,s,"code_reviewer",\{final:true\}\)/g) || [];
  const phaseSites = src.match(/roleDeadline\(c,s,"code_reviewer"\)/g) || [];
  check("runFinalReviewSessions (both loops) is the only final site; phase sites unchanged",
    finalSites.length === 1 && phaseSites.length === 2
    && /async function runFinalReviewSessions[\s\S]{0,400}roleDeadline\(c,s,"code_reviewer",\{final:true\}\)/.test(src),
    {finalSites: finalSites.length, phaseSites: phaseSites.length});
  check("no roleDeadline verifier call exists outside the per-phase loops (no final verifier site)",
    (src.match(/roleDeadline\(c,s,"verifier"\)/g) || []).length === 2
    && !/roleDeadline\(c,s,"verifier",\{final/.test(src));
} finally {
  fs.rmSync(root, {recursive: true, force: true});
}
console.log(failed ? `\n${failed} failed.` : "\nall passed.");
process.exit(failed ? 1 : 0);
