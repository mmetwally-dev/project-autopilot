#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { canReuseFailedReviewOnResume } from "./review-resume-reuse.mjs";
import { saveReviewFeedback, loadReviewFeedback } from "./review-feedback.mjs";
import { recordFindingTasks } from "./finding-task-locality.mjs";
import { ensureBaseline } from "./implementation-baseline.mjs";
import { decideTransition, createCheckpoint } from "./phase-stage-checkpoint.mjs";

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail === undefined ? "" : ` :: ${JSON.stringify(detail)}`}`);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-test-b9-"));
const repo = path.join(tmpDir, "repo");
fs.mkdirSync(repo, { recursive: true });

function git(args) {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

try {
  git(["init", "-b", "master"]);
  git(["config", "user.name", "Tester"]);
  git(["config", "user.email", "test@example.com"]);

  fs.writeFileSync(path.join(repo, "file1.txt"), "hello world\n");
  git(["add", "."]);
  git(["commit", "-m", "initial commit"]);

  const mission = "001-demo";
  const phaseKey = "standalone-phase:0";
  const baselineKey = `${mission}-phase-0`;
  const revision = 1;
  const reviewKey = `${baselineKey}-review-r${revision}`;
  const phaseTaskDigest = "sha256:" + "a".repeat(64);
  const taskIds = ["T1", "T2"];

  // Capture review baseline snapshot
  ensureBaseline(repo, reviewKey, { mission });

  // 1. Initial state without saved feedback or finding tasks -> cannot reuse
  const stateEmpty = { mission };
  const r1 = canReuseFailedReviewOnResume({
    repo, state: stateEmpty, key: phaseKey, revision, reviewKey, mission, phaseTaskDigest,
  });
  check("empty state: cannot reuse review", r1.canReuse === false && r1.reason === "no-saved-findings", r1);

  // 2. Save review feedback, but no finding tasks -> cannot reuse
  const stateWithFeedback = { mission };
  const findings = [{ location: "file1.txt:1", problem: "typo in text", correction: "fix typo" }];
  saveReviewFeedback(stateWithFeedback, phaseKey, findings);
  const r2 = canReuseFailedReviewOnResume({
    repo, state: stateWithFeedback, key: phaseKey, revision, reviewKey, mission, phaseTaskDigest,
  });
  check("feedback only without finding tasks: cannot reuse", r2.canReuse === false && r2.reason === "no-finding-tasks", r2);

  // 3. Save finding tasks, but wrong revision -> cannot reuse
  const stateWrongRev = JSON.parse(JSON.stringify(stateWithFeedback));
  recordFindingTasks(stateWrongRev, phaseKey, {
    phaseTaskDigest,
    findings,
    taskIds,
    revision: 2, // mismatch: expected revision is 1
    carryAllowed: true,
  });
  const r3 = canReuseFailedReviewOnResume({
    repo, state: stateWrongRev, key: phaseKey, revision: 1, reviewKey, mission, phaseTaskDigest,
  });
  check("revision mismatch: cannot reuse", r3.canReuse === false && r3.reason === "revision-mismatch", r3);

  // 4. Fully saved state matching review snapshot with unchanged tree -> can reuse!
  const stateValid = JSON.parse(JSON.stringify(stateWithFeedback));
  recordFindingTasks(stateValid, phaseKey, {
    phaseTaskDigest,
    findings,
    taskIds,
    revision: 1,
    carryAllowed: true,
  });
  const r4 = canReuseFailedReviewOnResume({
    repo, state: stateValid, key: phaseKey, revision: 1, reviewKey, mission, phaseTaskDigest,
  });
  check("valid state + unchanged tree: can reuse review", r4.canReuse === true, r4);
  check("returns saved findings", r4.findings.length === 1 && r4.findings[0].includes("typo in text"), r4.findings);
  check("returns finding record", r4.findingRecord && r4.findingRecord.revision === 1, r4.findingRecord);

  // Test transition from reused review
  const baseCp = createCheckpoint({
    framework: "standalone",
    mission,
    phaseIndex: 0,
    phaseName: "P1",
    tasks: [{ file: "TASKS.md", line: 1, text: "task 1" }],
    repoRoot: repo,
    baselineKey,
    at: "2026-01-01T00:00:00.000Z",
  });
  const checkpoint = {
    ...baseCp,
    nextStage: "code_reviewer",
    runningStage: "code_reviewer",
    deltaDigest: "sha256:" + "b".repeat(64),
    revision: 1,
  };
  const transition = decideTransition(checkpoint, {
    stage: "code_reviewer",
    failure: { domain: "implementation", sourceRole: "code_reviewer", findings: r4.findings },
    budget: { allowed: true },
  });
  check("transition restart to implementer", transition.ok === true && transition.action === "restart" && transition.nextStage === "implementer", transition);
  check("transition increments revision to 2", transition.revision === 2, transition);
  check("transition clears approvals", transition.clearApprovals === true, transition);

  // 5. Tree modified (file edited) -> tree-changed -> cannot reuse (reviews as today)
  fs.writeFileSync(path.join(repo, "file1.txt"), "hello world modified\n");
  const r5 = canReuseFailedReviewOnResume({
    repo, state: stateValid, key: phaseKey, revision: 1, reviewKey, mission, phaseTaskDigest,
  });
  check("tree modified: cannot reuse review", r5.canReuse === false && r5.reason === "tree-changed", r5);

  // Restore file1.txt
  fs.writeFileSync(path.join(repo, "file1.txt"), "hello world\n");
  const r5b = canReuseFailedReviewOnResume({
    repo, state: stateValid, key: phaseKey, revision: 1, reviewKey, mission, phaseTaskDigest,
  });
  check("tree restored: can reuse review again", r5b.canReuse === true, r5b);

  // 6. New untracked file added -> tree-changed -> cannot reuse
  fs.writeFileSync(path.join(repo, "untracked.txt"), "new file\n");
  const r6 = canReuseFailedReviewOnResume({
    repo, state: stateValid, key: phaseKey, revision: 1, reviewKey, mission, phaseTaskDigest,
  });
  check("untracked file added: cannot reuse review", r6.canReuse === false && r6.reason === "tree-changed", r6);

  // Remove untracked file
  fs.unlinkSync(path.join(repo, "untracked.txt"));

  // 7. Missing baseline key -> cannot reuse
  const r7 = canReuseFailedReviewOnResume({
    repo, state: stateValid, key: phaseKey, revision: 1, reviewKey: "nonexistent-review-r1", mission, phaseTaskDigest,
  });
  check("nonexistent baseline: cannot reuse review", r7.canReuse === false && r7.reason === "no-review-baseline", r7);

  // 8. Commit made (HEAD moved) -> cannot reuse
  fs.writeFileSync(path.join(repo, "file2.txt"), "file2\n");
  git(["add", "."]);
  git(["commit", "-m", "second commit"]);
  const r8 = canReuseFailedReviewOnResume({
    repo, state: stateValid, key: phaseKey, revision: 1, reviewKey, mission, phaseTaskDigest,
  });
  check("HEAD moved: cannot reuse review", r8.canReuse === false && r8.reason === "head-moved", r8);

} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
