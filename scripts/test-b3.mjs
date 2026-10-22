#!/usr/bin/env node
// Backlog B3 regression test: task sizing (#13), harmless blocked-git
// warnings (#14b), gate locality for spawned scripts (#25), scratch-file
// lister (#37), and the COMPLETED/CANCELLED Stage line (#43).
import assert from "node:assert/strict";
import fs from "node:fs";
import { taskSizingRuleText, taskSizeReviewText } from "./per-task-budget.mjs";
import { MAX_PHASE_TASKS, phaseTaskCountFindings } from "./verify-denylist.mjs";
import { classifyGitBlocks } from "./relay-guards.mjs";
import { importsDeltaFile } from "./gate-locality-imports.mjs";
import { findUnexpectedScratchFiles, looksLikeScratch, unexpectedNewFilesNote } from "./scratch-file-locality.mjs";
import { stageText } from "./watch-report.mjs";
import { buildTaskPrompt } from "./role-progress-prompt.mjs";

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS: ${name}`);
  } catch (error) {
    console.error(`FAIL: ${name}`);
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}

function planTaskLines(count) {
  const lines = ["## Phase 1: fixture phase"];
  for (let i = 1; i <= count; i += 1) {
    lines.push(`- [ ] **1.${i}** Edit scripts/file-${i}.mjs — accept: works ; verify: node scripts/test-file-${i}.mjs`);
  }
  return lines.join("\n");
}

// #13 — concrete one-action size rule, 10-task phase limit, task size wins.
check("size rule is concrete (one action / one file / exact path)", () => {
  const text = taskSizingRuleText(30);
  assert.match(text, /ONE concrete action/);
  assert.match(text, /about ONE file/);
  assert.match(text, /exact file path/);
  assert.ok(text.includes("more than 3 distinct changes"));
  assert.ok(text.includes("more than 2 files to edit"));
  assert.match(text, /task size wins over phase count/i);
  assert.match(text, /only runs tests is forbidden/i);
});

check("reviewer size rule counts changes/files, never turn estimates", () => {
  const text = taskSizeReviewText(30);
  assert.match(text, /count the distinct changes/);
  assert.match(text, /more than 3 distinct changes/);
  assert.match(text, /more than 2 files to edit/);
  assert.match(text, /never FAIL a task on a turn estimate alone/);
  assert.match(text, /Do not FAIL a task whose line carries the annotation/);
});

// The prompts actually wire the shared helpers (both standalone planner
// branches and both reviewers), so the briefs a planner/reviewer receives
// carry the concrete rule, the limit and "task size wins".
const autopilotSource = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
check("planner/reviewer prompts wire the concrete size rule and 10-task limit", () => {
  assert.ok((autopilotSource.match(/phaseTaskLimitLine,/g) || []).length >= 2);
  assert.match(autopilotSource, /\$\{taskSizingRuleText\(/);
  assert.match(autopilotSource, /taskSizeReviewText\(/);
  assert.ok(autopilotSource.includes("Task size wins over phase count"));
  assert.ok(autopilotSource.includes("FAIL any phase with more than ${MAX_PHASE_TASKS} tasks"));
});

check("phase task limit is ten, eleven fails", () => {
  assert.equal(MAX_PHASE_TASKS, 10);
  assert.equal(phaseTaskCountFindings(planTaskLines(10)).length, 0);
  assert.equal(phaseTaskCountFindings(planTaskLines(11)).length, 1);
});

// #14b — a blocked command that changed nothing is a warning, not fatal.
check("blocked non-mutating git command is a warning", () => {
  const snap = { head: "abc", refs: "r1", indexState: "i1" };
  const result = classifyGitBlocks([{ target: "protected", subcommand: "worktree" }], {
    commitDetected: false, readOnlyViolation: false, guardLogUnavailable: false, before: snap, after: { ...snap },
  });
  assert.equal(result.policyViolation, null);
  assert.equal(result.blockedNoMutation, true);
  assert.equal(result.fixtureGitBlocksOnlyUnproven, false);
});

check("a blocked commit is a violation even when the repo is unchanged", () => {
  const snap = { head: "abc", refs: "r1", indexState: "i1" };
  const result = classifyGitBlocks([{ target: "protected", subcommand: "commit", args: ["commit", "-m", "x"] }], {
    commitDetected: false, readOnlyViolation: false, guardLogUnavailable: false, before: snap, after: { ...snap },
  });
  assert.equal(result.policyViolation, "git_mutation_blocked");
  assert.equal(result.blockedNoMutation, false);
});

check("every history/tree-mutating subcommand stays fatal when blocked", () => {
  const snap = { head: "abc", refs: "r1", indexState: "i1" };
  for (const subcommand of ["push", "reset", "rebase", "merge", "checkout", "restore", "tag", "update-ref", "clean", "gc", "rm", "mv", "add", "apply"]) {
    const result = classifyGitBlocks([{ target: "protected", subcommand }], {
      commitDetected: false, readOnlyViolation: false, guardLogUnavailable: false, before: snap, after: { ...snap },
    });
    assert.equal(result.policyViolation, "git_mutation_blocked", subcommand);
    assert.equal(result.blockedNoMutation, false, subcommand);
  }
});

check("stash list/show warn, stash push/pop/apply/bare stay fatal", () => {
  const snap = { head: "abc", refs: "r1", indexState: "i1" };
  const classify = (args) => classifyGitBlocks([{ target: "protected", subcommand: "stash", args }], {
    commitDetected: false, readOnlyViolation: false, guardLogUnavailable: false, before: snap, after: { ...snap },
  });
  assert.equal(classify(["stash", "list"]).blockedNoMutation, true);
  assert.equal(classify(["stash", "show", "stash@{0}"]).blockedNoMutation, true);
  for (const action of ["push", "save", "pop", "apply", "drop", "clear"]) {
    assert.equal(classify(["stash", action]).policyViolation, "git_mutation_blocked", action);
  }
  assert.equal(classify(["stash"]).policyViolation, "git_mutation_blocked");
});

check("notes add/remove stay fatal, notes list/show and branch queries warn", () => {
  const snap = { head: "abc", refs: "r1", indexState: "i1" };
  const classify = (event) => classifyGitBlocks([{ target: "protected", ...event }], {
    commitDetected: false, readOnlyViolation: false, guardLogUnavailable: false, before: snap, after: { ...snap },
  });
  for (const action of ["add", "remove"]) {
    assert.equal(classify({ subcommand: "notes", args: ["notes", action, "ref"] }).policyViolation, "git_mutation_blocked", action);
  }
  assert.equal(classify({ subcommand: "notes", args: ["notes", "list"] }).blockedNoMutation, true);
  assert.equal(classify({ subcommand: "notes", args: ["notes", "show", "ref"] }).blockedNoMutation, true);
  assert.equal(classify({ subcommand: "branch", args: ["branch", "-d", "tmp"] }).policyViolation, "git_mutation_blocked");
  assert.equal(classify({ subcommand: "branch", args: ["branch", "--list"] }).blockedNoMutation, true);
});

check("a missing subcommand (hook/legacy entry) stays fatal", () => {
  const snap = { head: "abc", refs: "r1", indexState: "i1" };
  const result = classifyGitBlocks([{ target: "protected", hook: "reference-transaction" }], {
    commitDetected: false, readOnlyViolation: false, guardLogUnavailable: false, before: snap, after: { ...snap },
  });
  assert.equal(result.policyViolation, "git_mutation_blocked");
  assert.equal(result.blockedNoMutation, false);
});

check("a real repo change still halts", () => {
  const result = classifyGitBlocks([{ target: "protected", subcommand: "worktree" }], {
    commitDetected: false, readOnlyViolation: false, guardLogUnavailable: false,
    before: { head: "abc", refs: "r1", indexState: "i1" },
    after: { head: "def", refs: "r2", indexState: "i2" },
  });
  assert.equal(result.policyViolation, "git_mutation_blocked");
  assert.equal(result.blockedNoMutation, false);
});

check("a detected commit still halts even with an unchanged snapshot", () => {
  const snap = { head: "abc", refs: "r1", indexState: "i1" };
  const result = classifyGitBlocks([], {
    commitDetected: true, readOnlyViolation: false, guardLogUnavailable: false, before: snap, after: snap,
  });
  assert.equal(result.policyViolation, "git_commit_detected");
});

// #25 — a test that spawns a phase-changed script is inside the phase.
const testPath = "scripts/test-spawn-locality.mjs";
const deltaPath = "scripts/setup.mjs";

check("spawned changed script counts as inside the phase", () => {
  const files = new Map([
    [testPath, `import {spawnSync} from "node:child_process";\nspawnSync(process.execPath, [path.join(here, "setup.mjs")], {cwd: repo});\n`],
  ]);
  const readFile = (p) => { if (!files.has(p)) throw new Error("missing"); return files.get(p); };
  const result = importsDeltaFile({ testPath, deltaPaths: [deltaPath], readFile });
  assert.equal(result.inside, true);
  assert.equal(result.via, deltaPath);
});

check("an unrelated spawn target stays outside the phase", () => {
  const files = new Map([[testPath, `spawnSync(process.execPath, ["setup-other.mjs"]);`]]);
  const readFile = (p) => { if (!files.has(p)) throw new Error("missing"); return files.get(p); };
  const result = importsDeltaFile({ testPath, deltaPaths: [deltaPath], readFile });
  assert.equal(result.inside, false);
});

check("direct import locality still works", () => {
  const files = new Map([[testPath, `import "./setup.mjs";`]]);
  const readFile = (p) => { if (!files.has(p)) throw new Error("missing"); return files.get(p); };
  const result = importsDeltaFile({ testPath, deltaPaths: [deltaPath], readFile });
  assert.equal(result.inside, true);
});

// #37 — the scratch-file lister is pure and only reports unnamed scratch files.
check("scratch names are recognised", () => {
  for (const name of ["debug-x.mjs", "tmp-y.txt", "scratch-z.js", "notes.tmp", ".f1-tmp-abc/out.json", "scripts/debug-repro.mjs"]) {
    assert.equal(looksLikeScratch(name), true, name);
  }
  assert.equal(looksLikeScratch("scripts/real-module.mjs"), false);
});

check("lister reports unnamed scratch files only", () => {
  const files = [
    "debug-leftover.mjs",
    "tmp-output.txt",
    "scratch-run.js",
    "keep.tmp",
    ".f1-tmp-abc/out.json",
    "scripts/real-module.mjs",
    "debug-named-by-task.mjs",
  ];
  const tasks = "- [ ] **1.1** Write debug-named-by-task.mjs — accept: exists";
  assert.deepEqual(findUnexpectedScratchFiles(files, tasks), [
    "debug-leftover.mjs",
    "tmp-output.txt",
    "scratch-run.js",
    "keep.tmp",
    ".f1-tmp-abc/out.json",
  ]);
});

check("orchestrator and implementer brief are wired for stray files", () => {
  assert.ok(autopilotSource.includes("findUnexpectedScratchFiles("));
  assert.ok(autopilotSource.includes("unexpectedNewFilesReviewNote("));
  const brief = buildTaskPrompt({
    framework: "standalone", mission: "001-x", phaseIndex: 0, phaseNumber: 1, phaseName: "P1",
    phaseTotal: 1, revision: 1, role: "implementer", phaseTaskDigest: "d", deltaDigest: "dd",
    taskIds: ["001-x:P1:T0:a"],
    tasks: [{id: "001-x:P1:T0:a", text: "Do it\n\naccept: x ; verify: true", file: "scripts/a.mjs", line: 3}],
    currentTaskId: "001-x:P1:T0:a",
    roleProgress: {implementer: {status: "pending", completedTaskIds: [], taskCursor: 0, factsByTask: {}, currentTaskId: "001-x:P1:T0:a"}},
  });
  assert.equal(brief.ok, true, brief.error);
  assert.match(brief.text, /Put scratch\/debug scripts under the run's scratch dir, never in the project repo/);
});

check("reviewer note lists unexpected files", () => {
  const note = unexpectedNewFilesNote(["debug-leftover.mjs"]);
  assert.match(note, /Unexpected new files/);
  assert.match(note, /debug-leftover\.mjs/);
});

// #43 — a finished mission's PIPELINE STATE Stage line reads done.
check("COMPLETED and CANCELLED show Stage: done", () => {
  assert.equal(stageText({ status: "COMPLETED", stage: "IMPLEMENTATION", attempt: 4 }), "done");
  assert.equal(stageText({ status: "CANCELLED", stage: "PLANNING" }), "done");
});

check("a running mission keeps its stage", () => {
  assert.equal(stageText({ status: "RUNNING", stage: "PLANNING" }), "PLANNING");
});

console.log(`\ntest-b3: ${passed} checks passed`);
