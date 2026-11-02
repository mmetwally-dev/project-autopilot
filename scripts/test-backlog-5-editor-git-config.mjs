#!/usr/bin/env node
// Backlog #5 — editor-only .git/config keys must not trip GIT_COMMIT_DETECTED
// (e.g. branch.<name>.vscode-merge-base added by VS Code / Antigravity git extensions).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import {
  gitSnapshot,
  describeGitStateChange
} from "./relay-guards.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
    return true;
  }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  return false;
}

function git(cwd, args, env = withoutOuterGitGuard(process.env)) {
  return spawnSync("git", args, {cwd, encoding: "utf8", env, shell: false});
}

function makeRepo(prefix) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `ap-backlog5-${prefix}-`));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "backlog5-test@example.invalid"]);
  git(repo, ["config", "user.name", "Backlog 5 Test"]);
  fs.writeFileSync(path.join(repo, "initial.txt"), "hello world\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "initial commit"]);
  return repo;
}

const repo = makeRepo("editor-git-config");
try {
  const currentBranch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  check("current branch is non-empty", currentBranch.length > 0, currentBranch);

  // a. snapshot → git config branch.<current>.vscode-merge-base origin/dev → snapshot:
  //    describeGitStateChange(before, after) is [] and JSON.stringify(before.config) === JSON.stringify(after.config).
  const beforeA = gitSnapshot(repo);
  git(repo, ["config", `branch.${currentBranch}.vscode-merge-base`, "origin/dev"]);
  const afterA = gitSnapshot(repo);
  const diffA = describeGitStateChange(beforeA, afterA);
  check("a: describeGitStateChange is [] after editor key added",
    diffA.length === 0, diffA);
  check("a: JSON.stringify(before.config) === JSON.stringify(after.config)",
    JSON.stringify(beforeA.config) === JSON.stringify(afterA.config),
    {before: beforeA.config, after: afterA.config});

  // b. same repo, then git config core.hooksPath /tmp/x → snapshot:
  //    result contains an entry with field === "config" whose added includes a line with core.hookspath.
  const beforeB = afterA;
  git(repo, ["config", "core.hooksPath", "/tmp/x"]);
  const afterB = gitSnapshot(repo);
  const diffB = describeGitStateChange(beforeB, afterB);
  const configEntryB = diffB.find((e) => e.field === "config");
  check("b: result contains config entry whose added includes core.hookspath",
    configEntryB !== undefined && configEntryB.added.some((line) => line.includes("core.hookspath")),
    diffB);

  // c. same repo, git config branch.<current>.remote origin (a normal branch key) →
  //    still detected as a config change (proves the filter is narrow).
  const beforeC = afterB;
  git(repo, ["config", `branch.${currentBranch}.remote`, "origin"]);
  const afterC = gitSnapshot(repo);
  const diffC = describeGitStateChange(beforeC, afterC);
  const configEntryC = diffC.find((e) => e.field === "config");
  check("c: normal branch key still detected as config change",
    configEntryC !== undefined && configEntryC.added.some((line) => line.includes(`branch.${currentBranch}.remote`)),
    diffC);

  // d. a real commit after the editor key was added → head differs (still detected).
  const beforeD = afterC;
  fs.writeFileSync(path.join(repo, "new-file.txt"), "second commit\n");
  git(repo, ["add", "new-file.txt"]);
  git(repo, ["commit", "-q", "-m", "second commit"]);
  const afterD = gitSnapshot(repo);
  const diffD = describeGitStateChange(beforeD, afterD);
  const headEntryD = diffD.find((e) => e.field === "head");
  check("d: head differs after real commit following editor key",
    headEntryD !== undefined && beforeD.head !== afterD.head && headEntryD.added.includes(afterD.head) && headEntryD.removed.includes(beforeD.head),
    {diffD, beforeHead: beforeD.head, afterHead: afterD.head});

  const diffAcrossA = describeGitStateChange(afterA, afterD);
  check("d: head change detected when comparing from snapshot containing editor key",
    diffAcrossA.some((e) => e.field === "head") && afterA.head !== afterD.head,
    diffAcrossA);
} finally {
  fs.rmSync(repo, {recursive: true, force: true});
}

if (failures > 0) {
  console.error(`${failures} backlog-5 check(s) failed.`);
  process.exit(1);
}
console.log("backlog-5 editor git config tests passed");

