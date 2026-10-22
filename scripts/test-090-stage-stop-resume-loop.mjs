#!/usr/bin/env node
// Mission 090 task 1.5: implement/review/verify stop plus checkpoint and resume
// in runStandaloneImplementation (standalone framework, default fake adapter
// which PASSes every role).
//
// Standalone loop on one fixture: `ap run --stage planning` stops after
// planning; `--stage implement` after that stop now proceeds (replacement for
// the removed 1.3 'not yet supported' refusal) and stops after the
// Implementer with the checkpoint persisted; `--stage review` resumes from
// that checkpoint and stops after the Code Reviewer; `--stage verify`
// resumes and stops after verifier+mark_tasks without entering mission-final
// review; a later plain run resumes and finishes. SpecKit/GSD fixtures allow
// `--stage planning` but refuse `--stage implement|review|verify` with a
// standalone-only usage error.
// Run: node scripts/test-090-stage-stop-resume-loop.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeFixtureRepo, makeFixtureBin, makeGsdPhaseFixture, makeSpecKitPhaseFixture, writeConfig, withoutOuterGitGuard, cleanup, skillRoot, readObservedEvents } from "./test-fixtures/workflow-order-harness.mjs";

let failed = 0;
let ran = 0;
const check = (name, ok, detail = "") => {
  ran++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${detail}`}`);
  if (!ok) failed++;
};

function runCommand(repo, binDir, command, args, { timeoutMs = 180000 } = {}) {
  const delimiter = process.platform === "win32" ? ";" : ":";
  const base = withoutOuterGitGuard(process.env);
  delete base.AUTOPILOT_SPEC;
  const env = { ...base, PATH: `${binDir}${delimiter}${base.PATH || ""}` };
  const result = spawnSync(process.execPath,
    [path.join(skillRoot, "scripts", "autopilot.mjs"), command, ...args, "--repo", repo],
    { cwd: repo, encoding: "utf8", env, timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"], shell: false });
  return { status: result.status, timedOut: Boolean(result.error && result.error.code === "ETIMEDOUT"), stdout: result.stdout || "", stderr: result.stderr || "" };
}

const readState = (repo) => JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
const roleCount = (repo, role) => readObservedEvents(repo).filter((e) => e.role === role).length;
const checkpointOf = (repo) => readState(repo).phaseExecutionCheckpoint ?? null;

// ── Standalone stage loop ────────────────────────────────────────────
{
  const repo = makeFixtureRepo("090-stage-loop");
  const binDir = makeFixtureBin("090-stage-loop");
  try {
    writeConfig(repo, { planningFramework: "standalone" });

    const planning = runCommand(repo, binDir, "run", ["--stage", "planning", "fixture request"]);
    const planningCombined = `${planning.stdout}\n${planning.stderr}`;
    check("[loop-planning] --stage planning exits 0",
      planning.status === 0 && !planning.timedOut, `status=${planning.status} tail=${JSON.stringify(planningCombined.slice(-300))}`);
    check("[loop-planning] no implementer work ran",
      roleCount(repo, "implementer") === 0, `implementer=${roleCount(repo, "implementer")}`);

    // Replacement assertion: implement-after-planning-stop now proceeds.
    const impl = runCommand(repo, binDir, "run", ["--stage", "implement", "fixture request"]);
    const implCombined = `${impl.stdout}\n${impl.stderr}`;
    check("[loop-implement] --stage implement after a planning stop proceeds (no 'not yet supported')",
      impl.status === 0 && !impl.timedOut && !/not yet supported/i.test(implCombined),
      `status=${impl.status} out=${JSON.stringify(implCombined.slice(-500))}`);
    check("[loop-implement] stops after implement with a marker",
      /Stage 'implement' complete/i.test(implCombined), `tail=${JSON.stringify(implCombined.slice(-300))}`);
    check("[loop-implement] implementer ran, reviewer did not",
      roleCount(repo, "implementer") > 0 && roleCount(repo, "code_reviewer") === 0,
      `implementer=${roleCount(repo, "implementer")} reviewer=${roleCount(repo, "code_reviewer")}`);
    check("[loop-implement] checkpoint persisted",
      checkpointOf(repo) !== null && typeof checkpointOf(repo) === "object",
      `checkpoint=${JSON.stringify(checkpointOf(repo))?.slice(0, 200)}`);
    check("[loop-implement] mission not completed",
      !/ALL WORK COMPLETE/.test(implCombined), `tail=${JSON.stringify(implCombined.slice(-300))}`);

    const implCount = roleCount(repo, "implementer");
    const review = runCommand(repo, binDir, "run", ["--stage", "review", "fixture request"]);
    const reviewCombined = `${review.stdout}\n${review.stderr}`;
    check("[loop-review] --stage review resumes and exits 0",
      review.status === 0 && !review.timedOut, `status=${review.status} tail=${JSON.stringify(reviewCombined.slice(-300))}`);
    check("[loop-review] stops after review with a marker",
      /Stage 'review' complete/i.test(reviewCombined), `tail=${JSON.stringify(reviewCombined.slice(-300))}`);
    check("[loop-review] reviewer ran, verifier did not, implementer not re-run",
      roleCount(repo, "code_reviewer") > 0 && roleCount(repo, "verifier") === 0 && roleCount(repo, "implementer") === implCount,
      `reviewer=${roleCount(repo, "code_reviewer")} verifier=${roleCount(repo, "verifier")} implementer=${roleCount(repo, "implementer")}`);
    check("[loop-review] checkpoint persisted",
      checkpointOf(repo) !== null && typeof checkpointOf(repo) === "object",
      `checkpoint=${JSON.stringify(checkpointOf(repo))?.slice(0, 200)}`);

    const reviewerCount = roleCount(repo, "code_reviewer");
    const verify = runCommand(repo, binDir, "run", ["--stage", "verify", "fixture request"]);
    const verifyCombined = `${verify.stdout}\n${verify.stderr}`;
    check("[loop-verify] --stage verify resumes and exits 0",
      verify.status === 0 && !verify.timedOut, `status=${verify.status} tail=${JSON.stringify(verifyCombined.slice(-300))}`);
    check("[loop-verify] stops after verify with a marker",
      /Stage 'verify' complete/i.test(verifyCombined), `tail=${JSON.stringify(verifyCombined.slice(-300))}`);
    check("[loop-verify] verifier ran, no re-run of earlier stages",
      roleCount(repo, "verifier") > 0 && roleCount(repo, "implementer") === implCount && roleCount(repo, "code_reviewer") === reviewerCount,
      `verifier=${roleCount(repo, "verifier")} implementer=${roleCount(repo, "implementer")} reviewer=${roleCount(repo, "code_reviewer")}`);
    check("[loop-verify] verify run never enters mission-final review",
      !/ALL WORK COMPLETE/.test(verifyCombined), `tail=${JSON.stringify(verifyCombined.slice(-300))}`);

    const resume = runCommand(repo, binDir, "run", ["fixture request"]);
    const resumeCombined = `${resume.stdout}\n${resume.stderr}`;
    check("[loop-resume] later plain run resumes from the verify stop and exits 0",
      resume.status === 0 && !resume.timedOut, `status=${resume.status} tail=${JSON.stringify(resumeCombined.slice(-300))}`);
  } finally {
    cleanup(repo, binDir);
  }
}

// ── Two-phase: verify stop advances past the finished phase ──
{
  const repo = makeFixtureRepo("090-stage-loop-twophase");
  const binDir = makeFixtureBin("090-stage-loop-twophase");
  try {
    writeConfig(repo, { planningFramework: "standalone" });

    const planning = runCommand(repo, binDir, "run", ["--stage", "planning", "fixture request"]);
    check("[twophase-planning] --stage planning exits 0",
      planning.status === 0 && !planning.timedOut, `status=${planning.status}`);
    // Second phase appended after the planning stop (planner emits one phase).
    const mission = readState(repo).mission;
    const tasksFile = path.join(repo, ".autopilot", "missions", mission, "TASKS.md");
    fs.appendFileSync(tasksFile, "\n## Phase 2: Second\n\n- [ ] Do the second fixture task — accept: done ; verify: none\n");

    const impl = runCommand(repo, binDir, "run", ["--stage", "implement", "fixture request"]);
    const implCombined = `${impl.stdout}\n${impl.stderr}`;
    check("[twophase-implement] phase-1 implement stops after its stage",
      impl.status === 0 && !impl.timedOut && /Stage 'implement' complete/i.test(implCombined),
      `status=${impl.status} tail=${JSON.stringify(implCombined.slice(-300))}`);

    const review = runCommand(repo, binDir, "run", ["--stage", "review", "fixture request"]);
    check("[twophase-review] phase-1 review stops after its stage",
      review.status === 0 && !review.timedOut, `status=${review.status}`);

    const implCountBeforePhase2 = roleCount(repo, "implementer");
    const verify = runCommand(repo, binDir, "run", ["--stage", "verify", "fixture request"]);
    const verifyCombined = `${verify.stdout}\n${verify.stderr}`;
    check("[twophase-verify] phase-1 verify stops after verify and advances phaseIndex",
      verify.status === 0 && !verify.timedOut && /Stage 'verify' complete/i.test(verifyCombined) && readState(repo).phaseIndex === 1,
      `status=${verify.status} phaseIndex=${readState(repo).phaseIndex} tail=${JSON.stringify(verifyCombined.slice(-300))}`);

    // The required multi-phase resume: implement after a phase-1 verify must
    // run the phase-2 Implementer, not skip the finished phase and stop.
    const impl2 = runCommand(repo, binDir, "run", ["--stage", "implement", "fixture request"]);
    const impl2Combined = `${impl2.stdout}\n${impl2.stderr}`;
    check("[twophase-implement2] --stage implement after a phase-1 verify runs the phase-2 Implementer",
      impl2.status === 0 && !impl2.timedOut && roleCount(repo, "implementer") > implCountBeforePhase2 && /Phase 2\/2/.test(impl2Combined),
      `status=${impl2.status} implementer=${roleCount(repo, "implementer")} before=${implCountBeforePhase2} tail=${JSON.stringify(impl2Combined.slice(-400))}`);
  } finally {
    cleanup(repo, binDir);
  }
}

// ── Non-standalone frameworks: planning allowed, implement/review/verify refused ──
{
  const repo = makeFixtureRepo("090-stage-loop-speckit");
  const binDir = makeFixtureBin("090-stage-loop-speckit");
  try {
    makeSpecKitPhaseFixture(repo);
    writeConfig(repo, { planningFramework: "speckit" });
    const planning = runCommand(repo, binDir, "run", ["--stage", "planning", "fixture request"]);
    check("[speckit-planning] --stage planning exits 0",
      planning.status === 0 && !planning.timedOut, `status=${planning.status}`);
    const impl = runCommand(repo, binDir, "run", ["--stage", "implement", "fixture request"]);
    const implCombined = `${impl.stdout}\n${impl.stderr}`;
    check("[speckit-refuse] --stage implement refused as standalone-only",
      impl.status !== 0 && /only supported with the standalone framework/i.test(implCombined) && /usage error/i.test(implCombined),
      `status=${impl.status} out=${JSON.stringify(implCombined.slice(-500))}`);
    const review = runCommand(repo, binDir, "run", ["--stage", "review", "fixture request"]);
    const reviewCombined = `${review.stdout}\n${review.stderr}`;
    check("[speckit-refuse] --stage review refused as standalone-only or missing-state",
      review.status !== 0 && /usage error/i.test(reviewCombined),
      `status=${review.status} out=${JSON.stringify(reviewCombined.slice(-500))}`);
  } finally {
    cleanup(repo, binDir);
  }
}

{
  const repo = makeFixtureRepo("090-stage-loop-gsd");
  const binDir = makeFixtureBin("090-stage-loop-gsd");
  try {
    makeGsdPhaseFixture(repo);
    writeConfig(repo, { planningFramework: "gsd" });
    const planning = runCommand(repo, binDir, "run", ["--stage", "planning", "fixture request"]);
    check("[gsd-planning] --stage planning exits 0",
      planning.status === 0 && !planning.timedOut, `status=${planning.status}`);
    const impl = runCommand(repo, binDir, "run", ["--stage", "implement", "fixture request"]);
    const implCombined = `${impl.stdout}\n${impl.stderr}`;
    check("[gsd-refuse] --stage implement refused as standalone-only",
      impl.status !== 0 && /only supported with the standalone framework/i.test(implCombined) && /usage error/i.test(implCombined),
      `status=${impl.status} out=${JSON.stringify(implCombined.slice(-500))}`);
  } finally {
    cleanup(repo, binDir);
  }
}

console.log(failed ? `${failed} of ${ran} case(s) failed.` : `all ${ran} case(s) passed.`);
process.exit(failed ? 1 : 0);
