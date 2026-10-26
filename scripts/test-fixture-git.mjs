#!/usr/bin/env node
// fixtureGit: fast real-git helper for os.tmpdir() practice repos.
// Proves it builds a repo and refuses any target outside os.tmpdir()
// (the project root) before spawning git at all.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {fileURLToPath} from "node:url";
import {fixtureGit, fixtureGitEnv} from "./test-fixtures/fixture-git.mjs";

const failures = [];
function check(name, cond, details) {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures.push(name);
    console.error(`FAIL ${name}${details !== undefined ? ` :: ${JSON.stringify(details)}` : ""}`);
  }
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = new Set();
process.on("exit", () => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* best-effort */ }
  }
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-fixture-git-"));
tempDirs.add(root);

// fixtureGit builds a practice repo in os.tmpdir().
const repo = path.join(root, "repository");
fs.mkdirSync(repo, {recursive: true});
fs.writeFileSync(path.join(repo, "file.txt"), "baseline\n");

const init = fixtureGit(["init", "-q"], {cwd: repo});
check("fixtureGit init succeeds", init.status === 0, {status: init.status, stderr: init.stderr});
const email = fixtureGit(["config", "user.email", "test@test.com"], {cwd: repo});
check("fixtureGit config succeeds", email.status === 0, {status: email.status, stderr: email.stderr});
const name = fixtureGit(["config", "user.name", "Test"], {cwd: repo});
check("fixtureGit config user.name succeeds", name.status === 0, {status: name.status, stderr: name.stderr});
const add = fixtureGit(["add", "."], {cwd: repo});
check("fixtureGit add succeeds", add.status === 0, {status: add.status, stderr: add.stderr});
const commit = fixtureGit(["commit", "-q", "-m", "baseline"], {cwd: repo});
check("fixtureGit commit succeeds", commit.status === 0, {status: commit.status, stderr: commit.stderr});
const head = fixtureGit(["rev-parse", "HEAD"], {cwd: repo});
check("fixtureGit sees the committed HEAD", head.status === 0 && /^[0-9a-f]{40}$/.test((head.stdout || "").trim()),
  {status: head.status, stdout: head.stdout, stderr: head.stderr});

// fixtureGitEnv drops outer guard state.
const guardedEnv = fixtureGitEnv();
check("fixtureGitEnv returns a plain environment", typeof guardedEnv === "object" && guardedEnv !== process.env);

// A target outside os.tmpdir() throws before git runs. A real-git stand-in
// would create the marker if fixtureGit ever spawned it.
const markerScript = path.join(root, "fake-git");
const marker = path.join(root, "git-ran");
fs.writeFileSync(markerScript, `#!${process.execPath}\nimport fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
fs.chmodSync(markerScript, 0o755);

const originalRealGit = process.env.AUTOPILOT_REAL_GIT;
process.env.AUTOPILOT_REAL_GIT = markerScript;
try {
  let threw = false;
  let message = "";
  try {
    fixtureGit(["rev-parse", "--show-toplevel"], {cwd: projectRoot});
  } catch (error) {
    threw = true;
    message = String(error?.message || error);
  }
  check("fixtureGit throws for a cwd outside os.tmpdir()", threw, message);
  check("fixtureGit refusal names the project repository", message.includes("project repository"), message);
  check("fixtureGit did not run git for a refused target", !fs.existsSync(marker));
} finally {
  if (originalRealGit !== undefined) process.env.AUTOPILOT_REAL_GIT = originalRealGit;
  else delete process.env.AUTOPILOT_REAL_GIT;
}

if (failures.length) {
  console.error(`\n${failures.length} fixture-git check(s) failed.`);
  process.exit(1);
}
console.log("\nAll fixture-git checks passed.");
