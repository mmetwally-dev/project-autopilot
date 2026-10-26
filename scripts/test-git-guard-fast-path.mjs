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
import {createGitMutationGuard, BLOCKED_SUBCOMMANDS, gitGuardFastPathShellFragment, GIT_GUARD_WINDOWS_FAST_SUBCOMMANDS} from "./relay-guards.mjs";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === "win32";
const cleanEnv = withoutOuterGitGuard(process.env);
// The POSIX fast path execs under `env -i` with GUARD_ENV_ALLOWLIST, which
// keeps HOME but drops XDG_CONFIG_HOME and the GIT_CONFIG_GLOBAL/SYSTEM
// overrides. Drop them here too so the baked real git (and the Node wrapper)
// read exactly the same config files as the fast path.
delete cleanEnv.XDG_CONFIG_HOME;
delete cleanEnv.GIT_CONFIG_GLOBAL;
delete cleanEnv.GIT_CONFIG_SYSTEM;

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
  return spawnSync("git", args, {cwd: repo, encoding: "utf8", env: cleanEnv, shell: false, ...opts});
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

// Extra fixture states for the read-only forms: a detached HEAD, an unborn
// HEAD, a branch literally named main, and a hooksPath so `config --path`
// has something to resolve. All of it lives under $TMPDIR.
const detachedRepo = path.join(root, "detached");
fs.mkdirSync(detachedRepo, {recursive: true});
rawGit(["init", "-q"], {cwd: detachedRepo});
rawGit(["config", "user.email", "t@example.invalid"], {cwd: detachedRepo});
rawGit(["config", "user.name", "t"], {cwd: detachedRepo});
fs.writeFileSync(path.join(detachedRepo, "d.txt"), "detached\n");
rawGit(["add", "-A"], {cwd: detachedRepo});
rawGit(["commit", "-q", "-m", "init"], {cwd: detachedRepo});
rawGit(["checkout", "-q", "--detach"], {cwd: detachedRepo});

const unbornRepo = path.join(root, "unborn");
fs.mkdirSync(unbornRepo, {recursive: true});
rawGit(["init", "-q"], {cwd: unbornRepo});

const headBranch = runRealGit(["symbolic-ref", "--short", "HEAD"]).stdout.trim();
if (headBranch !== "main") runRealGit(["branch", "main", "HEAD"]);
runRealGit(["config", "--local", "core.hooksPath", ".githooks"]);
fs.appendFileSync(path.join(repo, specialName), "special-change\n");

function runShim(args, cwd = repo) {
  if (IS_WIN) return spawnSync("cmd.exe", ["/d", "/s", "/c", shim, ...args], {cwd, encoding: "utf8", env: cleanEnv, shell: false});
  return spawnSync(shim, args, {cwd, encoding: "utf8", env: cleanEnv, shell: false});
}
function runNodePath(args, cwd = repo) {
  return spawnSync(process.execPath, [wrapper, ...args], {cwd, encoding: "utf8", env: cleanEnv, shell: false});
}
function runRealGit(args, cwd = repo) {
  return spawnSync(guard.realGit, args, {cwd, encoding: "utf8", env: cleanEnv, shell: false});
}

// =====================================================================
// 0. The strict read-only classifier fragment itself: it must carry the
//    unconditional-read, config and symbolic-ref case labels and operand
//    rules, drop the allowed autocrlf pair, and parse as POSIX sh (POSIX
//    only; cmd.exe cannot check it).
// =====================================================================
{
  const fragment = gitGuardFastPathShellFragment();
  check("fast-path fragment is non-empty", typeof fragment === "string" && fragment.length > 0);
  check("fast-path fragment defines _apg_fast", fragment.includes("_apg_fast()"));
  check("fast-path fragment drops one leading autocrlf pair", fragment.includes('core.autocrlf=input') && fragment.includes("shift 2"));
  for (const label of [
    "status|rev-parse|ls-files|count-objects|for-each-ref",
    "config)",
    "symbolic-ref)",
    "--get|--get-all|--get-regexp|--get-urlmatch|--list|-l",
    "--local|--global|--system|--worktree|--path|--show-origin|--show-scope|--name-only|--null|-z|--includes|--no-includes",
    "?*.?*",
    "--quiet|-q|--short|--no-recurse",
    "HEAD|refs/?*",
    "worktree)",
    '= "list"',
    "cat-file)",
    "-t|-s|-e|-p|--batch|--batch=*|--batch-check|--batch-check=*|--batch-all-objects|--buffer|--unordered|--allow-unknown-type|--follow-symlinks|--use-mailmap",
    "diff|log|show)",
    "--output*|--ext*|--text*",
  ]) {
    check(`fast-path fragment case label: ${label}`, fragment.includes(label), fragment.slice(0, 200));
  }
  if (IS_WIN) {
    console.log("INFO POSIX sh syntax check skipped on Windows");
  } else {
    const parsed = spawnSync("sh", ["-n"], {input: fragment, encoding: "utf8", shell: false});
    check("fast-path fragment is POSIX sh syntax clean", parsed.status === 0,
      {status: parsed.status, stderr: (parsed.stderr || "").slice(0, 200)});
  }
}

// =====================================================================
// 0b. The generated shims: the Unix shim embeds the classifier and parses
//     as POSIX sh; the Windows .cmd fast list is only the five
//     unconditional reads, so argv-checked forms reach the Node wrapper.
// =====================================================================
{
  const expectedFast = ["status", "rev-parse", "ls-files", "count-objects", "for-each-ref"];
  check("windows fast subcommand list is the five unconditional reads",
    JSON.stringify(GIT_GUARD_WINDOWS_FAST_SUBCOMMANDS) === JSON.stringify(expectedFast),
    GIT_GUARD_WINDOWS_FAST_SUBCOMMANDS);
  if (IS_WIN) {
    const cmd = fs.readFileSync(shim, "utf8");
    const labels = [...cmd.matchAll(/if "%~1"=="([^"]+)" goto :apg_fast/g)].map((match) => match[1]);
    check("generated Windows .cmd fast list is the five unconditional reads",
      JSON.stringify(labels) === JSON.stringify(expectedFast), labels);
    for (const slow of ["diff", "log", "show", "cat-file", "config", "symbolic-ref", "worktree"]) {
      check(`generated Windows .cmd fast list excludes ${slow}`, !labels.includes(slow), labels);
    }
  } else {
    const text = fs.readFileSync(shim, "utf8");
    check("generated Unix shim carries the classifier",
      text.includes("_apg_fast()") &&
        text.includes('_apg_fast "$@"') &&
        text.includes("status|rev-parse|ls-files|count-objects|for-each-ref") &&
        text.includes("worktree)") && text.includes("autopilot_guard_exec_git"),
      text.slice(0, 300));
    const parsed = spawnSync("sh", ["-n", shim], {encoding: "utf8", shell: false});
    check("generated Unix shim is POSIX sh syntax clean", parsed.status === 0,
      {status: parsed.status, stderr: (parsed.stderr || "").slice(0, 200)});
  }
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
  const real = spawnSync(guard.realGit, [sub, ...args], {cwd: repo, encoding: "utf8", env: cleanEnv, shell: false});
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
// 2b. Every newly fast read form: the shim's answer must equal the baked
//     real git (and the Node wrapper) and, on POSIX, must never reach the
//     Node wrapper at all (NODE_PATH_HIT marker proof).
// =====================================================================
const readShapes = [
  // config reads (allowlisted actions/scopes/format flags)
  {name: "config --get user.email", args: ["config", "--get", "user.email"]},
  {name: "config --get-all user.email", args: ["config", "--get-all", "user.email"]},
  {name: "config --get-regexp ^user\\.", args: ["config", "--get-regexp", "^user\\."]},
  {name: "config --get-urlmatch (no match)", args: ["config", "--get-urlmatch", "http.proxy", "https://example.invalid"]},
  {name: "config --list", args: ["config", "--list"]},
  {name: "config -l", args: ["config", "-l"]},
  {name: "config --local --list", args: ["config", "--local", "--list"]},
  {name: "config --path core.hooksPath", args: ["config", "--path", "core.hooksPath"]},
  {name: "config plain dotted-key read", args: ["config", "user.email"]},
  {name: "config --get missing key", args: ["config", "--get", "nope.missing"]},
  {name: "config --show-origin --list", args: ["config", "--show-origin", "--list"]},
  {name: "config --show-scope --list", args: ["config", "--show-scope", "--list"]},
  {name: "config --name-only --list", args: ["config", "--name-only", "--list"]},
  {name: "config --list -z", args: ["config", "--list", "-z"]},
  {name: "config --list --null", args: ["config", "--list", "--null"]},
  {name: "config --list --includes", args: ["config", "--list", "--includes"]},
  {name: "config --list --no-includes", args: ["config", "--list", "--no-includes"]},
  {name: "config --global --list", args: ["config", "--global", "--list"]},
  {name: "config --system --list", args: ["config", "--system", "--list"]},
  {name: "config --worktree --list", args: ["config", "--worktree", "--list"]},
  // unconditional reads with argument forms the old shim did not cover
  {name: "for-each-ref --format", args: ["for-each-ref", "--format=%(refname)"]},
  {name: "count-objects -v", args: ["count-objects", "-v"]},
  // symbolic-ref across attached / detached / unborn HEAD
  {name: "symbolic-ref -q HEAD (attached)", args: ["symbolic-ref", "-q", "HEAD"]},
  {name: "symbolic-ref --short HEAD", args: ["symbolic-ref", "--short", "HEAD"]},
  {name: "symbolic-ref -q refs/heads/main", args: ["symbolic-ref", "-q", "refs/heads/main"]},
  {name: "symbolic-ref -q HEAD (detached)", args: ["symbolic-ref", "-q", "HEAD"], cwd: detachedRepo},
  {name: "symbolic-ref -q HEAD (unborn)", args: ["symbolic-ref", "-q", "HEAD"], cwd: unbornRepo},
  {name: "rev-parse -q --verify HEAD (unborn)", args: ["rev-parse", "-q", "--verify", "HEAD"], cwd: unbornRepo},
  // worktree list and cat-file reads
  {name: "worktree list --porcelain", args: ["worktree", "list", "--porcelain"]},
  {name: "cat-file -t HEAD", args: ["cat-file", "-t", "HEAD"]},
  {name: "cat-file -p HEAD:a.txt", args: ["cat-file", "-p", "HEAD:a.txt"]},
  {name: "cat-file -p special path", args: ["cat-file", "-p", "HEAD:" + specialName]},
  // diff/log/show read forms, including the autocrlf-pair drop
  {name: "diff --no-ext-diff", args: ["diff", "--no-ext-diff"]},
  {name: "log --oneline", args: ["log", "--oneline"]},
  {name: "show HEAD", args: ["show", "HEAD"]},
  {name: "diff -- special path", args: ["diff", "--", specialName]},
  {name: "log --oneline -- special path", args: ["log", "--oneline", "--", specialName]},
  {name: "show HEAD -- special path", args: ["show", "HEAD", "--", specialName]},
  {name: "-c core.autocrlf=input diff --no-ext-diff", args: ["-c", "core.autocrlf=input", "diff", "--no-ext-diff"]},
];
let readShapesOk = true;
for (const form of readShapes) {
  const fast = runShim(form.args, form.cwd);
  const real = runRealGit(form.args, form.cwd);
  const node = runNodePath(form.args, form.cwd);
  const matchesReal = fast.status === real.status && (fast.stdout || "") === (real.stdout || "");
  const matchesNode = fast.status === node.status && (fast.stdout || "") === (node.stdout || "");
  if (!matchesReal || !matchesNode) readShapesOk = false;
  check(`read form matches real git and node: ${form.name}`, matchesReal && matchesNode,
    {
      fastStatus: fast.status, realStatus: real.status, nodeStatus: node.status,
      fastOut: (fast.stdout || "").slice(0, 120), realOut: (real.stdout || "").slice(0, 120), nodeOut: (node.stdout || "").slice(0, 120),
      fastErr: (fast.stderr || "").slice(0, 120), realErr: (real.stderr || "").slice(0, 120),
    });
}
check("read forms: all match real git and node", readShapesOk);

if (IS_WIN) {
  console.log("INFO NODE_PATH_HIT marker proof skipped on Windows (cmd.exe cannot express the argv rules)");
} else {
  const expected = readShapes.map((form) => runRealGit(form.args, form.cwd));
  const original = fs.readFileSync(wrapper, "utf8");
  fs.writeFileSync(wrapper, `console.log("NODE_PATH_HIT"); process.exit(42);\n`);
  try {
    readShapes.forEach((form, index) => {
      const want = expected[index];
      const r = runShim(form.args, form.cwd);
      const hitMarker = (r.stdout || "").includes("NODE_PATH_HIT") || (r.stderr || "").includes("NODE_PATH_HIT");
      check(`read form answered without Node: ${form.name}`,
        !hitMarker && r.status === want.status && (r.stdout || "") === (want.stdout || ""),
        {status: r.status, wantStatus: want.status, hitMarker, out: (r.stdout || "").slice(0, 120), err: (r.stderr || "").slice(0, 120)});
    });
  } finally {
    fs.writeFileSync(wrapper, original);
  }
}

// =====================================================================
// 2c. No writing/unsafe form may be answered by the fast path: every one of
//     them must reach the Node wrapper (NODE_PATH_HIT marker proof on POSIX)
//     instead of being exec'd directly as read-only git. The symbolic-ref
//     write forms are additionally blocked today (exit 97) by the real
//     wrapper; that is checked against the real wrapper before stubbing it.
// =====================================================================
const unsafeSlowForms = [
  // config: every mutating action, extra operand, or unknown/unsafe flag
  {name: "config edit", args: ["config", "edit"]},
  {name: "config list", args: ["config", "list"]},
  {name: "config get", args: ["config", "get"]},
  {name: "config key value", args: ["config", "user.email", "x@example.invalid"]},
  {name: "config --global key value", args: ["config", "--global", "user.email", "x@example.invalid"]},
  {name: "config --list extra", args: ["config", "--list", "extra"]},
  {name: "config --get-urlmatch one operand", args: ["config", "--get-urlmatch", "http.proxy"]},
  {name: "config --get-urlmatch three operands", args: ["config", "--get-urlmatch", "http.proxy", "https://example.invalid", "extra"]},
  {name: "config --unset", args: ["config", "--unset", "user.email"]},
  {name: "config --unset-all", args: ["config", "--unset-all", "user.email"]},
  {name: "config --add", args: ["config", "--add", "user.email", "x@example.invalid"]},
  {name: "config --replace-all", args: ["config", "--replace-all", "user.email", "x@example.invalid"]},
  {name: "config --rename-section", args: ["config", "--rename-section", "user", "person"]},
  {name: "config --remove-section", args: ["config", "--remove-section", "user"]},
  {name: "config -e", args: ["config", "-e"]},
  {name: "config --edit", args: ["config", "--edit"]},
  {name: "config --file key value", args: ["config", "--file", path.join(root, "other-config"), "user.email", "x@example.invalid"]},
  {name: "config -f key value", args: ["config", "-f", path.join(root, "other-config"), "user.email", "x@example.invalid"]},
  {name: "config --blob", args: ["config", "--blob", "HEAD:.gitconfig", "user.email"]},
  {name: "config --type", args: ["config", "--type", "bool", "core.autocrlf"]},
  {name: "config --default", args: ["config", "--default", "x", "--get", "nope.missing"]},
  // symbolic-ref writes and deletions (also blocked by the real wrapper today)
  {name: "symbolic-ref HEAD refs/heads/x", args: ["symbolic-ref", "HEAD", "refs/heads/x"]},
  {name: "symbolic-ref -d HEAD", args: ["symbolic-ref", "-d", "HEAD"]},
  {name: "symbolic-ref --delete HEAD", args: ["symbolic-ref", "--delete", "HEAD"]},
  // worktree actions other than list
  {name: "worktree add", args: ["worktree", "add", path.join(root, "wt-add")]},
  {name: "worktree remove", args: ["worktree", "remove", path.join(root, "wt-remove")]},
  {name: "worktree prune", args: ["worktree", "prune"]},
  {name: "worktree move", args: ["worktree", "move", "a", "b"]},
  {name: "worktree lock", args: ["worktree", "lock"]},
  {name: "worktree unlock", args: ["worktree", "unlock"]},
  {name: "worktree repair", args: ["worktree", "repair"]},
  // diff/log/show write or external-process options
  {name: "diff --output", args: ["diff", "--output", path.join(root, "diff.out")]},
  {name: "diff --output=...", args: ["diff", "--output=" + path.join(root, "diff.out")]},
  {name: "log --output", args: ["log", "--output", path.join(root, "log.out")]},
  {name: "show --output", args: ["show", "--output", path.join(root, "show.out")]},
  {name: "diff --ext-diff", args: ["diff", "--ext-diff"]},
  {name: "log --ext-diff", args: ["log", "--ext-diff"]},
  {name: "show --ext-diff", args: ["show", "--ext-diff"]},
  {name: "diff --textconv", args: ["diff", "--textconv"]},
  {name: "log --textconv", args: ["log", "--textconv"]},
  {name: "show --textconv", args: ["show", "--textconv"]},
  // cat-file external filters and prefix-abbreviated unsafe flags
  {name: "cat-file --textconv", args: ["cat-file", "--textconv", "HEAD:a.txt"]},
  {name: "cat-file --filters", args: ["cat-file", "--filters", "HEAD:a.txt"]},
  {name: "cat-file --textc prefix", args: ["cat-file", "--textc", "HEAD:a.txt"]},
  {name: "cat-file --filt prefix", args: ["cat-file", "--filt", "HEAD:a.txt"]},
  // leading global options that change config/repository resolution
  {name: "-c core.hooksPath", args: ["-c", "core.hooksPath=.githooks", "status"]},
  {name: "-c alias.x", args: ["-c", "alias.x=status", "x"]},
  {name: "-c core.sshCommand", args: ["-c", "core.sshCommand=false", "status"]},
  {name: "--config-env", args: ["--config-env", "user.name=other", "status"]},
  {name: "--config-env=...", args: ["--config-env=user.name=other", "status"]},
  {name: "--git-dir", args: ["--git-dir", ".git", "status"]},
  {name: "--git-dir=...", args: ["--git-dir=.git", "status"]},
  {name: "--work-tree", args: ["--work-tree", ".", "status"]},
  {name: "--work-tree=...", args: ["--work-tree=.", "status"]},
];

const wrapperBlockedSlowForms = unsafeSlowForms.filter((form) =>
  form.name.startsWith("symbolic-ref ") &&
  (form.name === "symbolic-ref HEAD refs/heads/x" || form.name === "symbolic-ref -d HEAD" || form.name === "symbolic-ref --delete HEAD"));
for (const form of wrapperBlockedSlowForms) {
  const r = runShim(form.args);
  check(`real wrapper still blocks symbolic-ref write: ${form.name}`,
    r.status === 97 && /forbidden/.test(r.stderr || ""),
    {status: r.status, stderr: (r.stderr || "").slice(0, 120)});
}

if (IS_WIN) {
  console.log("INFO unsafe-form NODE_PATH_HIT marker proof skipped on Windows (fast path is POSIX-only)");
} else {
  const original = fs.readFileSync(wrapper, "utf8");
  fs.writeFileSync(wrapper, `console.log("NODE_PATH_HIT"); process.exit(42);\n`);
  try {
    for (const form of unsafeSlowForms) {
      const r = runShim(form.args);
      const hitMarker = (r.stdout || "").includes("NODE_PATH_HIT") || (r.stderr || "").includes("NODE_PATH_HIT");
      check(`unsafe form reaches Node, not fast path: ${form.name}`,
        hitMarker && r.status === 42,
        {status: r.status, hitMarker, out: (r.stdout || "").slice(0, 80), err: (r.stderr || "").slice(0, 120)});
    }
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
