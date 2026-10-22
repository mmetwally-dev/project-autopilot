#!/usr/bin/env node
// TASK-39: a blocked git call in a disposable fixture repo must not end the
// mission. Covers the root-cause finding (fixture repos created inside the
// protected identity are judged "protected" — not a scope bug), the
// blocked.log `target` field, and the shared both-loops classification rule.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {createGitMutationGuard, guardedEnv, readGuardLog, classifyGuardTarget, classifyGitBlocks} from "./relay-guards.mjs";
import {buildTaskPrompt} from "./role-progress-prompt.mjs";
import {renderWatchReport} from "./run-history.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

if (process.platform === "win32") {
  console.log("test-fixture-git-block-classification: SKIP — requires POSIX PATH shim dispatch (same prerequisite as test-git-guard-layer1-scoping.mjs).");
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-fgi-"));
function git(cwd, args, env) {
  return spawnSync("git", args, {cwd, encoding: "utf8", env, shell: false});
}
function makeRepo(name) {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, {recursive: true});
  git(repo, ["init", "-q"], process.env);
  git(repo, ["config", "user.email", "t@example.invalid"], process.env);
  git(repo, ["config", "user.name", "t"], process.env);
  fs.writeFileSync(path.join(repo, "file.txt"), "base\n");
  git(repo, ["add", "-A"], process.env);
  git(repo, ["commit", "-q", "-m", "init"], process.env);
  return repo;
}

const protectedRepo = makeRepo("protected");
const runDir = path.join(root, "run");
const guard = createGitMutationGuard(runDir, protectedRepo);
const env = guardedEnv(guard, {HOME: root, TMPDIR: root});

// =====================================================================
// 1. Root cause: a fixture repo created inside the protected project repo
//    (e.g. .autopilot/test-scratch, as makeScratch prefers) is judged
//    "protected" — correct by containment, not a guard scope bug. A
//    fixture repo under /tmp is judged "outside".
// =====================================================================
{
  const scratch = path.join(protectedRepo, ".autopilot", "test-scratch");
  fs.mkdirSync(scratch, {recursive: true});
  const fx = path.join(scratch, "fx");
  fs.mkdirSync(fx);
  git(fx, ["init", "-q"], process.env);
  check("root cause: repo-local fixture under the protected root is 'protected'",
    classifyGuardTarget(fx, guard.scopeFile, env, guard.realGit) === "protected");
  const outside = path.join(root, "outside-fx");
  fs.mkdirSync(outside);
  git(outside, ["init", "-q"], process.env);
  check("root cause: fixture under os.tmpdir is 'outside'",
    classifyGuardTarget(outside, guard.scopeFile, env, guard.realGit) === "outside");
  fs.rmSync(fx, {recursive: true, force: true});
}

// =====================================================================
// 2. blocked.log carries the reason field.
// =====================================================================
{
  const commitTry = git(protectedRepo, ["commit", "-q", "-m", "x"], env);
  check("protected repo commit is blocked (exit 97)", commitTry.status === 97, commitTry.status);
  const entries = readGuardLog(guard.logFile);
  check("blocked.log entry has target 'protected'", entries.at(-1)?.target === "protected", entries.at(-1));

  fs.rmSync(guard.scopeFile);
  const guard2Env = guardedEnv(guard, {HOME: root, TMPDIR: root});
  const commitTry2 = git(protectedRepo, ["commit", "-q", "-m", "x"], guard2Env);
  check("protected repo commit with missing scope file is blocked", commitTry2.status === 97, commitTry2.status);
  const entries2 = readGuardLog(guard.logFile);
  check("blocked.log entry has target 'unproven'", entries2.at(-1)?.target === "unproven", entries2.at(-1));

  // Restore scope file for any later use.
  const guard3 = createGitMutationGuard(runDir, protectedRepo);
  const env3 = guardedEnv(guard3, {HOME: root, TMPDIR: root});
  const priorEntries = readGuardLog(guard3.logFile).length;
  const outsideRepo = path.join(root, "outside-repo");
  fs.mkdirSync(outsideRepo, {recursive: true});
  git(outsideRepo, ["init", "-q"], process.env);
  git(outsideRepo, ["config", "user.email", "t@example.invalid"], process.env);
  git(outsideRepo, ["config", "user.name", "t"], process.env);
  fs.writeFileSync(path.join(outsideRepo, "a.txt"), "x\n");
  git(outsideRepo, ["add", "-A"], process.env);
  const ok = git(outsideRepo, ["commit", "-q", "-m", "init"], env3);
  check("provably outside repo commit is allowed", ok.status === 0, ok.status);
  const entries3 = readGuardLog(guard3.logFile).slice(priorEntries);
  check("outside commit writes no blocked.log entry for it", entries3.length === 0, entries3);
}

// =====================================================================
// 3. Classification rule (shared by both loops).
// =====================================================================
{
  const snap = {head: "h", refs: "r", indexState: "i"};
  const same = {head: "h", refs: "r", indexState: "i"};
  check("all-unproven + unchanged + completed → not fatal", (() => {
    const r = classifyGitBlocks([{target: "unproven", layer: "path-shim", subcommand: "worktree"}], {commitDetected: false, readOnlyViolation: false, guardLogUnavailable: false, before: snap, after: same});
    return r.policyViolation === null && r.fixtureGitBlocksOnlyUnproven === true;
  })());
  check("one protected block + unchanged repo → warning, not fatal", (() => {
    const r = classifyGitBlocks([{target: "unproven", subcommand: "worktree"}, {target: "protected", subcommand: "worktree"}], {commitDetected: false, readOnlyViolation: false, guardLogUnavailable: false, before: snap, after: same});
    return r.policyViolation === null && r.blockedNoMutation === true && r.fixtureGitBlocksOnlyUnproven === false;
  })());
  check("protected block + full repo change → fatal (real mutation)", (() => {
    const r = classifyGitBlocks([{target: "protected", subcommand: "commit"}], {commitDetected: false, readOnlyViolation: false, guardLogUnavailable: false, before: snap, after: same, repoChanged: true});
    return r.policyViolation === "git_mutation_blocked" && r.blockedNoMutation === false;
  })());
  check("unproven + project HEAD moved → git_commit_detected", (() => {
    const r = classifyGitBlocks([{target: "unproven"}], {commitDetected: true, readOnlyViolation: false, guardLogUnavailable: false, before: snap, after: {head: "h2", refs: "r", indexState: "i"}});
    return r.policyViolation === "git_commit_detected";
  })());
  check("unproven + indexState changed → fatal", (() => {
    const r = classifyGitBlocks([{target: "unproven", subcommand: "reset"}], {commitDetected: false, readOnlyViolation: false, guardLogUnavailable: false, before: snap, after: {head: "h", refs: "r", indexState: "i2"}});
    return r.policyViolation === "git_mutation_blocked";
  })());
  check("unproven + readOnlyViolation → fatal (read-only role unaffected? stays fatal)", (() => {
    const r = classifyGitBlocks([{target: "unproven", subcommand: "commit"}], {commitDetected: false, readOnlyViolation: true, guardLogUnavailable: false, before: snap, after: same});
    return r.policyViolation === "git_mutation_blocked";
  })());
  check("missing subcommand (legacy/hook entry) + unchanged repo → fatal (fail closed)", (() => {
    const r = classifyGitBlocks([{layer: "path-shim"}], {commitDetected: false, readOnlyViolation: false, guardLogUnavailable: false, before: snap, after: same});
    return r.policyViolation === "git_mutation_blocked" && r.blockedNoMutation === false;
  })());
  check("empty guard log + unchanged + no other signals → no violation", (() => {
    const r = classifyGitBlocks([], {commitDetected: false, readOnlyViolation: false, guardLogUnavailable: false, before: snap, after: same});
    return r.policyViolation === null;
  })());
}

// =====================================================================
// 4. Warning lifecycle: shown in brief + WATCH-REPORT while set; the
//    renderers drop it once the flag clears; the orchestrator pins
//    clearing on new mission and at both phase-loop heads.
// =====================================================================
{
  const roleProgressStub = {implementer: {status: "pending", completedTaskIds: [], taskCursor: 0, factsByTask: {}, currentTaskId: "001-x:P1:T0:a"}};
  const briefWithFlag = buildTaskPrompt({framework: "standalone", mission: "001-x", phaseIndex: 0, phaseNumber: 1, phaseName: "P1", phaseTotal: 1, revision: 1, role: "implementer", phaseTaskDigest: "d", deltaDigest: "dd", taskIds: ["001-x:P1:T0:a"], tasks: [{id: "001-x:P1:T0:a", text: "Do it\n\naccept: x ; verify: true", file: "scripts/a.mjs", line: 3}], currentTaskId: "001-x:P1:T0:a", roleProgress: roleProgressStub, fixtureGitBlockWarning: true});
  check("brief shows the fixture-block warning when set", briefWithFlag.ok && briefWithFlag.text.includes("git calls in fixture repos were blocked"), JSON.stringify(briefWithFlag).slice(-300));
  const briefBaseInput = {framework: "standalone", mission: "001-x", phaseIndex: 0, phaseNumber: 1, phaseName: "P1", phaseTotal: 1, revision: 1, role: "implementer", phaseTaskDigest: "d", deltaDigest: "dd", taskIds: ["001-x:P1:T0:a"], tasks: [{id: "001-x:P1:T0:a", text: "Do it\n\naccept: x ; verify: true", file: "scripts/a.mjs", line: 3}], currentTaskId: "001-x:P1:T0:a", roleProgress: roleProgressStub};
  const briefWithout = buildTaskPrompt({...briefBaseInput, fixtureGitBlockWarning: false});
  check("brief omits the fixture-block warning when clear", briefWithout.ok && !briefWithout.text.includes("fixture repos were blocked"));
  check("implementer brief carries the $TMPDIR fixture guidance", briefWithout.ok && briefWithout.text.includes("$TMPDIR"));
  const briefWithGitGuard = buildTaskPrompt({...briefBaseInput, gitGuardWarning: {kind: "git_guard_blocked_no_mutation", count: 1, subcommands: ["worktree"]}});
  check("brief shows the blocked-no-mutation warning when set", briefWithGitGuard.ok && briefWithGitGuard.text.includes("git command was blocked and changed nothing"), JSON.stringify(briefWithGitGuard).slice(-300));
  const reportRepo = path.join(root, "watch-report-repo");
  const reportStateFile = path.join(reportRepo, ".autopilot", "state.json");
  const seedReportState = (state) => { fs.mkdirSync(path.dirname(reportStateFile), {recursive: true}); fs.writeFileSync(reportStateFile, JSON.stringify(state)); };
  seedReportState({phase: "implementing", step: "implementation", mission: "001-x", fixtureGitBlockWarning: true, gitGuardWarning: {kind: "git_guard_blocked_no_mutation", count: 1, subcommands: ["worktree"]}});
  const report = renderWatchReport(reportRepo, null);
  check("WATCH-REPORT shows the fixture warning as a WARN line", report.includes("WARN") && report.includes("git calls in fixture repos were blocked"), report.slice(0, 400));
  check("WATCH-REPORT shows the blocked-no-mutation warning", report.includes("a git command was blocked and changed nothing"), report.slice(0, 400));
  seedReportState({phase: "implementing", step: "implementation", mission: "001-x"});
  const reportClear = renderWatchReport(reportRepo, null);
  check("WATCH-REPORT omits it after clearing", !reportClear.includes("fixture repos were blocked"));

  // Wiring pin: the orchestrator clears the flag at new-mission and at
  // both phase-loop heads (standalone + SpecKit).
  const autoSource = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
  check("orchestrator clears the flag on new mission (scoped keys)", autoSource.includes('"fixtureGitBlockWarning","fixtureGitBlockWarningPhaseIndex"'));
  check("orchestrator clears the flag at the phase-loop heads (both loops)", (autoSource.match(/fixtureGitBlockWarningPhaseIndex!==s\.phaseIndex/g) || []).length >= 2);
}

fs.rmSync(root, {recursive: true, force: true});
console.log(failures ? `${failures} check(s) failed.` : "fixture-git-block-classification tests passed");
process.exit(failures ? 1 : 0);
