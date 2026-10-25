#!/usr/bin/env node
// TASK-41 Part B: the PATH shim's read-only fast path (status/diff/log/show/
// rev-parse/ls-files as the literal first argument) skips the ~600 ms Node
// startup and execs the baked real git directly, under the same sanitized
// environment (env -i + GUARD_ENV_ALLOWLIST) the Node wrapper receives.
// Verifies: differential equivalence fast-path vs Node path, option-prefix
// arguments route to Node (marker proof), every BLOCKED_SUBCOMMANDS entry is
// still blocked, and the timing improvement. Runs on POSIX and Windows.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {createGitMutationGuard, BLOCKED_SUBCOMMANDS} from "./relay-guards.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === "win32";

const tempDirs = new Set();
process.on("exit", () => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* best-effort */ }
  }
});

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-fgf-"));
tempDirs.add(root);
const repo = path.join(root, "repo");
fs.mkdirSync(repo, {recursive: true});
function rawGit(args, opts = {}) {
  return spawnSync("git", args, {cwd: repo, encoding: "utf8", env: process.env, shell: false, ...opts});
}
rawGit(["init", "-q"]);
rawGit(["config", "user.email", "t@example.invalid"]);
rawGit(["config", "user.name", "t"]);
rawGit(["config", "core.autocrlf", "false"]);
fs.mkdirSync(path.join(repo, "sub"), {recursive: true});
fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
fs.writeFileSync(path.join(repo, "sub", "b.txt"), "b\n");
// Special-character path argument for the differential shapes (Windows
// metacharacters included): forwarded verbatim through the shim. `|` is not
// allowed in Windows filenames, so it is POSIX-only.
const specialName = IS_WIN ? "a & b^c% d.txt" : "a & b|c^d% e.txt";
fs.writeFileSync(path.join(repo, specialName), "special\n");
rawGit(["add", "-A"]);
rawGit(["commit", "-q", "-m", "init"]);
fs.appendFileSync(path.join(repo, "a.txt"), "changed\n");
fs.writeFileSync(path.join(repo, "untracked.txt"), "u\n");

const guard = createGitMutationGuard(path.join(root, "guard"), repo);
const shim = path.join(guard.guardDir, IS_WIN ? "git.cmd" : "git");
const wrapper = path.join(guard.guardDir, "git-guard.mjs");

function runShim(args) {
  if (IS_WIN) return spawnSync("cmd.exe", ["/d", "/s", "/c", shim, ...args], {cwd: repo, encoding: "utf8", env: process.env, shell: false});
  return spawnSync(shim, args, {cwd: repo, encoding: "utf8", env: process.env, shell: false});
}
function runNodePath(args) {
  return spawnSync(process.execPath, [wrapper, ...args], {cwd: repo, encoding: "utf8", env: process.env, shell: false});
}

// =====================================================================
// 1. Differential: fast path (via the shim) vs the Node path (direct
//    wrapper invocation) must give the same exit status and stdout.
// =====================================================================
const shapes = [
  ["status", ["--porcelain"]],
  ["status", ["--porcelain", "--", "a.txt"]],
  ["status", ["--porcelain=v1", "--untracked-files=all"]],
  ["diff", []],
  ["diff", ["--stat"]],
  ["diff", ["--cached"]],
  ["diff", ["--", "a.txt"]],
  ["log", ["--oneline", "-n", "3"]],
  ["log", ["--oneline", "--", "sub/b.txt"]],
  ["show", ["--stat", "HEAD"]],
  ["show", ["--name-only", "--format=full", "HEAD"]],
  ["rev-parse", ["HEAD"]],
  ["rev-parse", ["--show-toplevel"]],
  ["ls-files", []],
  ["ls-files", ["--", specialName]],
  ["ls-files", ["--others", "--exclude-standard"]],
  ["log", ["--oneline", "--", specialName]],
  ["status", ["--porcelain", "--", specialName]],
];
let differentialOk = true;
for (const [sub, args] of shapes) {
  const fast = runShim([sub, ...args]);
  const node = runNodePath([sub, ...args]);
  const same = fast.status === node.status && (fast.stdout || "") === (node.stdout || "");
  if (!same) differentialOk = false;
  check(`differential ${sub} ${args.join(" ")}`, same,
    {fastStatus: fast.status, nodeStatus: node.status, fastOut: (fast.stdout || "").slice(0, 120), nodeOut: (node.stdout || "").slice(0, 120), fastErr: (fast.stderr || "").slice(0, 120), nodeErr: (node.stderr || "").slice(0, 120)});
}
check("differential: all shapes agree", differentialOk);

// The fast path output must also equal a plain real-git run.
for (const [sub, args] of [["status", ["--porcelain"]], ["ls-files", []], ["log", ["--oneline", "-n", "1"]]]) {
  const fast = runShim([sub, ...args]);
  const real = spawnSync(guard.realGit, [sub, ...args], {cwd: repo, encoding: "utf8", env: process.env, shell: false});
  check(`shim fast path matches baked real git: ${sub}`, fast.status === real.status && fast.stdout === real.stdout,
    {fastStatus: fast.status, realStatus: real.status});
}

// =====================================================================
// 2. A leading option forces the Node path (marker proof).
// =====================================================================
{
  const original = fs.readFileSync(wrapper, "utf8");
  fs.writeFileSync(wrapper, `console.log("NODE_PATH_HIT"); process.exit(42);\n`);
  try {
    for (const args of [["-C", repo, "status"], ["-c", "x=y", "status"], ["--git-dir=" + path.join(repo, ".git"), "status"], ["--exec-path", "status"], ["-P", "status"]]) {
      const r = runShim(args);
      check(`node path taken for leading option: ${args.join(" ")}`, r.status === 42 && (r.stdout || "").includes("NODE_PATH_HIT"),
        {status: r.status, out: (r.stdout || "").slice(0, 80)});
    }
    const fast = runShim(["status"]);
    check("fast path taken for bare `status` (no NODE_PATH_HIT)", fast.status === 0 && !(fast.stdout || "").includes("NODE_PATH_HIT"),
      {status: fast.status, out: (fast.stdout || "").slice(0, 80)});
  } finally {
    fs.writeFileSync(wrapper, original);
  }
}

// =====================================================================
// 3. Every BLOCKED_SUBCOMMANDS entry is still blocked exactly as today.
// =====================================================================
const blockedForms = {
  "commit": ["commit", "-m", "x"],
  "commit-tree": ["commit-tree", "HEAD^{tree}", "-m", "x"],
  "push": ["push", "origin", "HEAD"],
  "update-ref": ["update-ref", "refs/heads/x", "HEAD"],
  "symbolic-ref": ["symbolic-ref", "HEAD", "refs/heads/y"],
  "replace": ["replace", "HEAD"],
  "filter-branch": ["filter-branch"],
  "fast-import": ["fast-import"],
  "reset": ["reset", "--hard", "HEAD"],
  "merge": ["merge", "HEAD"],
  "rebase": ["rebase", "HEAD"],
  "cherry-pick": ["cherry-pick", "HEAD"],
  "revert": ["revert", "--no-edit", "HEAD"],
  "tag": ["tag", "x"],
  "branch": ["branch", "-d", "x"],
  "notes": ["notes", "list"],
};
for (const sub of BLOCKED_SUBCOMMANDS) {
  const args = blockedForms[sub];
  const r = runShim(args);
  check(`blocked exactly as today: ${sub}`, r.status === 97 && /forbidden/.test(r.stderr || ""),
    {status: r.status, stderr: (r.stderr || "").slice(0, 120)});
}

// =====================================================================
// 4. Timing: 20x status --porcelain — plain git, through the shim (fast
//    path), and the Node wrapper directly (the old per-call path).
// =====================================================================
function timeIt(label, fn) {
  const t0 = performance.now();
  for (let i = 0; i < 20; i += 1) {
    const r = fn();
    if (r.status !== 0) { check(`timing run failed: ${label}`, false, {status: r.status, stderr: (r.stderr || "").slice(0, 120)}); return Infinity; }
  }
  const ms = performance.now() - t0;
  console.log(`INFO timing ${label}: ${ms.toFixed(0)} ms for 20 calls (${(ms / 20).toFixed(1)} ms/call)`);
  return ms;
}
const plain = timeIt("plain git (no shim)", () => rawGit(["status", "--porcelain"]));
const throughShim = timeIt("through shim (fast path)", () => runShim(["status", "--porcelain"]));
const nodePath = timeIt("node wrapper (pre-fix cost)", () => runNodePath(["status", "--porcelain"]));
if (isFinite(plain) && isFinite(throughShim) && isFinite(nodePath)) {
  // POSIX: the Node startup dominates, so the fast path must be ~10x
  // cheaper. Windows cmd cannot `env -i`; the per-call sanitizer loop
  // dominates there, so the fast path still only ties the Node cost but
  // never pays Node startup — assert it is not slower.
  check("timing: fast path beats the node wrapper", IS_WIN ? throughShim <= nodePath : throughShim * 10 < nodePath,
    {plainMs: plain, throughShimMs: throughShim, nodePathMs: nodePath});
}

console.log(failures === 0 ? "test-git-guard-fast-path: OK" : `test-git-guard-fast-path: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
