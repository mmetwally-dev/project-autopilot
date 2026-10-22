#!/usr/bin/env node
// Mission 024 phase 2 task 2.1: pin sandbox git EOL via the guardedEnv
// GIT_CONFIG carrier (core.autocrlf=input) so role git agrees with a
// Windows CRLF checkout instead of reporting phantom whole-file diffs.
//
// - (a) guardedEnv installs core.autocrlf=input with a bumped
//   GIT_CONFIG_COUNT (3 with a repository root, 2 without), keeping
//   core.hooksPath and safe.directory intact.
// - (b) an untouched CRLF worktree reads clean (empty status/diff) under
//   the guarded env, while plain git shows the phantom modification.
// - (c) a CRLF-preserving 20-insert + 2-edit change reports the true
//   22+/2- numstat under the guarded env.
// - (d) a native-Linux LF checkout stays clean under the guarded env
//   (repo-wide justification).
//
// POSIX-only: the CRLF fixture needs `rm` + `git -c core.autocrlf=true
// checkout` and LF/CRLF byte control. Fail closed on win32.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {createGitMutationGuard, guardedEnv} from "./relay-guards.mjs";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";

if (process.platform === "win32") {
  console.error("SKIP test-wsl-crlf-sandbox-clean: POSIX-only fixture (fail closed).");
  process.exit(1);
}

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${detail !== undefined ? ` :: ${detail}` : ""}`); }
};

// Prefer the OS temp dir: fixture repos created inside the project tree
// (e.g. a previous repo-local .autopilot/test-scratch) are judged "protected"
// by the live mission's git guard and their commits are blocked — that was
// the mission-024 failure this test lives through. Only fall back to the
// repo's scratch when the OS temp dir is not writable (read-only envelope).
const makeScratch = (prefix) => {
  try {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  } catch (err) {
    if (!["EROFS", "EACCES", "EPERM"].includes(err?.code)) throw err;
    const repoScratch = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), ".autopilot", "test-scratch");
    fs.mkdirSync(repoScratch, {recursive: true});
    return fs.mkdtempSync(path.join(repoScratch, prefix));
  }
};

const runGit = (gitBin, cwd, args, env) =>
  spawnSync(gitBin, args, {cwd, encoding: "utf8", env, shell: false});

// Plain env: drop any outer mission's git guard (PATH shim + GIT_CONFIG_*
// hooks) so fixture setup uses real git and the phantom baseline is honest
// even when nested inside a live mission.
const strippedEnv = () => withoutOuterGitGuard({...process.env});

const tmp = makeScratch("ap-wsl-crlf-");
try {
  // ---- (a) carrier shape ----
  const repoRoot = path.join(tmp, "carrier-repo");
  fs.mkdirSync(repoRoot, {recursive: true});
  const guardRepo = createGitMutationGuard(path.join(tmp, "guard-repo"), repoRoot);
  const envRepo = guardedEnv(guardRepo);
  check("carrier: repo COUNT=3", envRepo.GIT_CONFIG_COUNT === "3", envRepo.GIT_CONFIG_COUNT);
  check("carrier: repo hooksPath intact",
    envRepo.GIT_CONFIG_KEY_0 === "core.hooksPath" && envRepo.GIT_CONFIG_VALUE_0 === guardRepo.hooksDir,
    `${envRepo.GIT_CONFIG_KEY_0}=${envRepo.GIT_CONFIG_VALUE_0}`);
  check("carrier: repo safe.directory intact",
    envRepo.GIT_CONFIG_KEY_1 === "safe.directory" && envRepo.GIT_CONFIG_VALUE_1 === repoRoot,
    `${envRepo.GIT_CONFIG_KEY_1}=${envRepo.GIT_CONFIG_VALUE_1}`);
  check("carrier: repo autocrlf=input on KEY_2",
    envRepo.GIT_CONFIG_KEY_2 === "core.autocrlf" && envRepo.GIT_CONFIG_VALUE_2 === "input",
    `${envRepo.GIT_CONFIG_KEY_2}=${envRepo.GIT_CONFIG_VALUE_2}`);

  const guardBare = createGitMutationGuard(path.join(tmp, "guard-bare"), null);
  const envBare = guardedEnv(guardBare);
  check("carrier: no-repo COUNT=2", envBare.GIT_CONFIG_COUNT === "2", envBare.GIT_CONFIG_COUNT);
  check("carrier: no-repo hooksPath intact",
    envBare.GIT_CONFIG_KEY_0 === "core.hooksPath" && envBare.GIT_CONFIG_VALUE_0 === guardBare.hooksDir,
    `${envBare.GIT_CONFIG_KEY_0}=${envBare.GIT_CONFIG_VALUE_0}`);
  check("carrier: no-repo autocrlf=input on KEY_1",
    envBare.GIT_CONFIG_KEY_1 === "core.autocrlf" && envBare.GIT_CONFIG_VALUE_1 === "input",
    `${envBare.GIT_CONFIG_KEY_1}=${envBare.GIT_CONFIG_VALUE_1}`);
  check("carrier: no-repo has no KEY_2",
    envBare.GIT_CONFIG_KEY_2 === undefined && envBare.GIT_CONFIG_VALUE_2 === undefined,
    `${envBare.GIT_CONFIG_KEY_2}=${envBare.GIT_CONFIG_VALUE_2}`);

  const lfLines = (n, prefix = "line") =>
    Array.from({length: n}, (_, i) => `${prefix} ${String(i + 1).padStart(3, "0")}`).join("\n") + "\n";

  const initRepo = (dir) => {
    fs.mkdirSync(dir, {recursive: true});
    const env = strippedEnv();
    check(`fixture: git init (${path.basename(dir)})`, runGit("git", dir, ["init", "-q"], env).status === 0);
    check(`fixture: git config email (${path.basename(dir)})`,
      runGit("git", dir, ["config", "user.email", "crlf-test@example.invalid"], env).status === 0);
    check(`fixture: git config name (${path.basename(dir)})`,
      runGit("git", dir, ["config", "user.name", "CRLF Test"], env).status === 0);
  };

  // ---- (b) CRLF fixture, untouched ----
  const fx = path.join(tmp, "crlf-fx");
  initRepo(fx);
  fs.writeFileSync(path.join(fx, "file.txt"), lfLines(100));
  {
    const env = strippedEnv();
    check("crlf: add", runGit("git", fx, ["add", "-A"], env).status === 0);
    check("crlf: commit", runGit("git", fx, ["commit", "-q", "-m", "init"], env).status === 0);
    // rm-then-checkout is required: without rm the checkout is a no-op and
    // the worktree stays LF (w/lf). With autocrlf=true the re-checkout
    // materializes CRLF (i/lf w/crlf), like a Windows checkout.
    fs.rmSync(path.join(fx, "file.txt"));
    const co = runGit("git", fx, ["-c", "core.autocrlf=true", "checkout", "--", "file.txt"], env);
    check("crlf: CRLF checkout", co.status === 0, (co.stderr || "").slice(-200));
    const raw = fs.readFileSync(path.join(fx, "file.txt"));
    check("crlf: worktree is CRLF", raw.includes("\r\n"), `${raw.length} bytes`);
  }
  const plainStatus = runGit("git", fx, ["status", "--porcelain"], strippedEnv());
  check("crlf: plain git shows phantom modification",
    (plainStatus.stdout || "").trim().startsWith("M "), JSON.stringify(plainStatus.stdout));
  const guardFx = createGitMutationGuard(path.join(tmp, "guard-fx"), fx);
  const fxEnv = guardedEnv(guardFx);
  const guardedStatus = runGit(guardFx.realGit, fx, ["status", "--porcelain"], fxEnv);
  check("crlf: guarded status clean when untouched",
    guardedStatus.status === 0 && (guardedStatus.stdout || "") === "", JSON.stringify(guardedStatus.stdout));
  const guardedDiff = runGit(guardFx.realGit, fx, ["diff"], fxEnv);
  check("crlf: guarded diff empty when untouched",
    guardedDiff.status === 0 && (guardedDiff.stdout || "") === "",
    JSON.stringify((guardedDiff.stdout || "").slice(0, 200)));

  // ---- (c) CRLF-preserving edit: 20 inserts + 2 edits => 22+/2- ----
  {
    const raw = fs.readFileSync(path.join(fx, "file.txt"), "utf8");
    const parts = raw.split("\r\n");
    check("crlf-edit: fixture still CRLF before edit", parts.length === 101 && parts[100] === "");
    parts[1] = "line 002 edited";
    parts[49] = "line 050 edited";
    const added = Array.from({length: 20}, (_, i) => `added ${String(i + 1).padStart(3, "0")}`);
    parts.splice(100, 0, ...added); // before the trailing "" (keeps CRLF)
    fs.writeFileSync(path.join(fx, "file.txt"), parts.join("\r\n"));
    const numstat = runGit(guardFx.realGit, fx, ["diff", "--numstat"], fxEnv);
    // stdout only: diff may warn "CRLF will be replaced by LF" on stderr.
    check("crlf-edit: guarded numstat is true 22/2",
      numstat.status === 0 && (numstat.stdout || "").trim() === "22\t2\tfile.txt",
      JSON.stringify(numstat.stdout));
  }

  // ---- (d) native-LF fixture stays clean under the guarded env ----
  const lf = path.join(tmp, "lf-fx");
  initRepo(lf);
  fs.writeFileSync(path.join(lf, "file.txt"), lfLines(100));
  const guardLf = createGitMutationGuard(path.join(tmp, "guard-lf"), lf);
  const lfEnv = guardedEnv(guardLf);
  {
    const env = strippedEnv();
    check("lf: add", runGit("git", lf, ["add", "-A"], env).status === 0);
    check("lf: commit", runGit("git", lf, ["commit", "-q", "-m", "init"], env).status === 0);
    const plain = runGit("git", lf, ["status", "--porcelain"], env);
    check("lf: plain status clean", plain.status === 0 && (plain.stdout || "") === "", JSON.stringify(plain.stdout));
  }
  const lfStatus = runGit(guardLf.realGit, lf, ["status", "--porcelain"], lfEnv);
  check("lf: guarded status clean",
    lfStatus.status === 0 && (lfStatus.stdout || "") === "", JSON.stringify(lfStatus.stdout));
  const lfDiff = runGit(guardLf.realGit, lf, ["diff"], lfEnv);
  check("lf: guarded diff empty",
    lfDiff.status === 0 && (lfDiff.stdout || "") === "", JSON.stringify((lfDiff.stdout || "").slice(0, 200)));
} finally {
  fs.rmSync(tmp, {recursive: true, force: true});
}

if (failures) { console.error(`${failures} wsl-crlf-sandbox-clean check(s) failed.`); process.exit(1); }
console.log("wsl-crlf-sandbox-clean tests passed");
