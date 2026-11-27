#!/usr/bin/env node
// Stuck-pager defence (live incident, mission run 212: an Antigravity agent's
// command runner did not pass GIT_PAGER/PAGER to `git diff`, a pager waited on
// a terminal for 24 minutes).
// Part A: the per-run git-guard shim must make a pager impossible no matter
//   what the caller's environment or the repo config says: git runs with
//   --no-pager and GIT_PAGER=PAGER=cat. Proven with a pty on stdout (git only
//   pages on a TTY) and a core.pager that blocks forever.
// Part B: killStuckPagers (idle-hang-watchdog.mjs) kills only pager/viewer
//   descendants of a silent agent, after the idle window, and nothing else.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawn, spawnSync} from "node:child_process";
import {createGitMutationGuard} from "./relay-guards.mjs";
import {killStuckPagers} from "./idle-hang-watchdog.mjs";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
if (process.platform !== "linux") { console.log("test-stuck-pager: SKIP (linux only)"); process.exit(0); }
const hasScript = spawnSync("script", ["--version"], {encoding: "utf8"}).status === 0;

// Scratch dir inside the worktree (not /tmp), removed on exit.
const root = path.join(here, "..", `.scratch-stuck-pager-${process.pid}`);
fs.mkdirSync(root, {recursive: true});
const pids = [];
function cleanup() {
  for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  try { fs.rmSync(root, {recursive: true, force: true}); } catch { /* best-effort */ }
}
process.on("exit", cleanup);

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

// ---------------- Part A: git-guard wrapper ----------------
const env = withoutOuterGitGuard(process.env);
for (const k of ["XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_PAGER", "PAGER"]) delete env[k];
const repo = path.join(root, "repo");
fs.mkdirSync(repo, {recursive: true});
const g = (args) => spawnSync("git", args, {cwd: repo, encoding: "utf8", env, shell: false});
g(["init", "-q"]); g(["config", "user.email", "t@example.invalid"]); g(["config", "user.name", "t"]);
fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
g(["add", "-A"]); g(["commit", "-q", "-m", "init"]);
fs.appendFileSync(path.join(repo, "a.txt"), "changed\n");
// A pager that blocks "forever" and prints nothing: if it ever runs, git hangs.
const blocker = path.join(root, "blocker.sh");
fs.writeFileSync(blocker, "#!/bin/sh\nsleep 60\n", {mode: 0o755});
g(["config", "core.pager", blocker]);

const guard = createGitMutationGuard(path.join(root, "guard"), repo);
const shimText = fs.readFileSync(path.join(guard.guardDir, "git"), "utf8");
const nodeWrapperText = fs.readFileSync(guard.pathShimWrapper, "utf8");
check("shim execs real git with --no-pager", /exec "\$git_bin" --no-pager "\$@"/.test(shimText));
check("node wrapper execs real git with --no-pager", nodeWrapperText.includes('["--no-pager",...sanitizedArgs]'));

function viaPty(cmd, extraEnv = {}) {
  const t0 = Date.now();
  const r = spawnSync("script", ["-qefc", cmd, "/dev/null"], {cwd: repo, encoding: "utf8", input: "", timeout: 15000, killSignal: "SIGKILL",
    env: {...env, TERM: "xterm", PAGER: blocker, GIT_PAGER: blocker, ...extraEnv}});
  return {r, ms: Date.now() - t0};
}
if (!hasScript) {
  console.log("SKIP pty tests (no `script` binary)");
} else {
  // Control: without the shim the same setup really does hang on the pager,
  // so the shim results below prove something.
  const ctl = viaPty("git diff", {PATH: process.env.PATH});
  check("control: unguarded git on a pty hangs on the blocking pager", ctl.r.error?.code === "ETIMEDOUT" || ctl.ms >= 14000, {ms: ctl.ms, status: ctl.r.status});
  const env2 = {PATH: `${guard.guardDir}:${process.env.PATH}`};
  for (const [label, args] of [
    ["fast-path diff", "diff"],
    ["fast-path log", "log --oneline"],
    ["node-path diff (leading -c)", "-c color.ui=never diff"],
    ["node-path log (leading -c)", "-c color.ui=never log --oneline"],
  ]) {
    const {r, ms} = viaPty(`git ${args}`, env2);
    const out = r.stdout || "";
    check(`shim ${label} returns promptly with output on a pty`, r.status === 0 && ms < 10000 && /a\.txt|init/.test(out), {status: r.status, ms, out: out.slice(0, 120), err: r.error?.code});
  }
}
// The real git call gets --no-pager first and cat pagers, whatever the caller exported.
{
  const fakeReal = path.join(root, "fake-git");
  const dumpFile = path.join(root, "env.txt");
  fs.writeFileSync(fakeReal, `#!/bin/sh\necho "args:$*" > ${dumpFile}\necho "GIT_PAGER=$GIT_PAGER PAGER=$PAGER GIT_TERMINAL_PROMPT=$GIT_TERMINAL_PROMPT" >> ${dumpFile}\n`, {mode: 0o755});
  const guard2 = createGitMutationGuard(path.join(root, "guard2"), repo);
  const fakeShim = path.join(guard2.guardDir, "git");
  // Same generated shim, with the baked real-git literal pointed at a recorder.
  fs.writeFileSync(fakeShim, fs.readFileSync(fakeShim, "utf8").split(guard2.realGit).join(fakeReal));
  const r = spawnSync(fakeShim, ["log", "-1"], {cwd: repo, encoding: "utf8", env: {...env, PAGER: "less", GIT_PAGER: "less", GIT_TERMINAL_PROMPT: "1"}});
  const dump = fs.existsSync(dumpFile) ? fs.readFileSync(dumpFile, "utf8") : "";
  check("fast path passes --no-pager first and cat pagers to real git", r.status === 0 && dump.startsWith("args:--no-pager log -1") && dump.includes("GIT_PAGER=cat PAGER=cat GIT_TERMINAL_PROMPT=0"), dump);
}

// ---------------- Part B: killStuckPagers ----------------
const exeDir = path.join(root, "bin");
fs.mkdirSync(exeDir);
// Pager look-alikes: node itself under the names less/pager (sleep is a
// multicall binary here and would refuse an unknown argv0).
fs.symlinkSync(process.execPath, path.join(exeDir, "less"));
fs.symlinkSync(process.execPath, path.join(exeDir, "pager"));
const idleJs = (tag) => `setInterval(()=>{},1000)//${tag}`;
const lessBin = path.join(exeDir, "less");
const agentSrc = `
const {spawn}=require("node:child_process");
spawn(${JSON.stringify(lessBin)},["-e",${JSON.stringify(idleJs("A"))}],{stdio:"ignore"});
spawn(${JSON.stringify(path.join(exeDir, "pager"))},["-e",${JSON.stringify(idleJs("B"))}],{stdio:"ignore"});
spawn("sleep",["300"],{stdio:"ignore"});
spawn("sh",["-c",${JSON.stringify(lessBin + " -e '" + idleJs("C") + "'; sleep 40")}],{stdio:"ignore"});
setInterval(()=>{},1000);`;
const agent = spawn(process.execPath, ["-e", agentSrc], {stdio: "ignore"});
pids.push(agent.pid);
await new Promise(r => setTimeout(r, 1500));
const alive = (pid) => {
  try { return fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1][0] !== "Z"; } catch { return false; }
};
const kidsOf = (pid) => spawnSync("pgrep", ["-a", "-P", String(pid)], {encoding: "utf8"}).stdout.trim().split("\n").filter(Boolean)
  .map(l => ({pid: Number(l.split(" ")[0]), cmd: l.split(" ").slice(1).join(" ")}));
const before = kidsOf(agent.pid);
const lessPid = before.find(k => k.cmd.endsWith("//A"))?.pid;
const pagerPid = before.find(k => k.cmd.endsWith("//B"))?.pid;
const sleepPid = before.find(k => k.cmd === "sleep 300")?.pid;
const shPid = before.find(k => k.cmd.startsWith("sh -c"))?.pid;
const nestedLessPid = shPid ? kidsOf(shPid).find(k => k.cmd.endsWith("//C"))?.pid : undefined;
check("fixture: agent has less, pager, sleep, and a shell with a nested less", [lessPid, pagerPid, sleepPid, shPid, nestedLessPid].every(Boolean), {before, nestedLessPid});
for (const pid of [lessPid, pagerPid, sleepPid, shPid, nestedLessPid]) if (pid) pids.push(pid);

const T0 = 1_000_000_000_000;
const logs = [];
const watch = {pid: agent.pid, lastSilenceResetAt: T0, lastActivityAt: T0, pagerIdleMs: 1000};
const opts = (now, extra = {}) => ({now, platform: "linux", log: (m) => logs.push(m), ...extra});

check("recent output: nothing killed", killStuckPagers(watch, opts(T0 + 500)).length === 0 && alive(lessPid) && alive(pagerPid));
check("non-linux platform: skipped silently", killStuckPagers(watch, opts(T0 + 5000, {platform: "win32"})).length === 0 && alive(lessPid));
check("pagerIdleMs 0 disables", killStuckPagers(watch, opts(T0 + 5000, {pagerIdleMs: 0})).length === 0 && alive(lessPid));
const killed = killStuckPagers(watch, opts(T0 + 5000));
await new Promise(r => setTimeout(r, 500));
check("after idle window: top-level less and pager are killed", !alive(lessPid) && !alive(pagerPid), killed);
check("nested less under a shell is killed, the shell itself is not", !alive(nestedLessPid) && alive(shPid), {killed});
check("non-pager child (sleep) untouched", alive(sleepPid));
check("agent process untouched", alive(agent.pid));
check("three pagers killed, one log line each, naming idle minutes", killed.length === 3 && logs.length === 3 && logs.every(l => /killed stuck pager (less|pager) after \d+ min idle/.test(l)), {killed, logs});
check("second pass kills nothing and logs nothing more", killStuckPagers(watch, opts(T0 + 9000)).length === 0 && logs.length === 3);
const watch2 = {pid: agent.pid, lastSilenceResetAt: T0, lastActivityAt: T0, pagerIdleMs: 1000};
check("with only non-pager children left, nothing is killed", killStuckPagers(watch2, opts(T0 + 600000)).length === 0 && alive(sleepPid) && alive(shPid) && alive(agent.pid));

if (failures) { console.error(`${failures} stuck-pager check(s) failed.`); process.exit(1); }
console.log("test-stuck-pager: ALL CHECKS PASSED");
process.exit(0);
