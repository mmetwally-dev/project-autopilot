#!/usr/bin/env node
// Task 042-1.2: SIGTERM/SIGINT handler kills the live adapter process group
// before re-raising. Static asserts (detached group + kill-before-flush
// order + pid wiring) plus a runtime test: the REAL scripts/autopilot.mjs
// orchestrator runs on a fixture repo with a fake cursor-agent that ignores
// SIGTERM/SIGINT and spawns a grandchild that also ignores SIGTERM/SIGINT.
// SIGTERM the orchestrator; its production installInterruptFlush() handler
// must group-kill the adapter tree, and the tree + process group are gone.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (name, condition) => {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const relaySrc = fs.readFileSync(path.join(here, "subprocess-relay.mjs"), "utf8");
const autoSrc = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");

check("spawnRelayChild spawns detached on POSIX", /detached\s*:\s*true/.test(relaySrc));
check("killActiveProcessGroupSync helper exists", /function killActiveProcessGroupSync/.test(autoSrc));
check("flush kills group before markInterrupted",
  autoSrc.indexOf("killActiveProcessGroupSync(activeChildPid)") !== -1 &&
  autoSrc.indexOf("killActiveProcessGroupSync(activeChildPid)") < autoSrc.indexOf("markInterrupted(activeRunDir"));
check("onStart records live child pid", /activeChildPid\s*=\s*\(typeof pid/.test(autoSrc));
check("relay settle clears live child pid", /activeChildPid\s*=\s*null/.test(autoSrc));
check("group SIGTERM sent to negative pid", /process\.kill\(\s*-pid/.test(autoSrc));
check("group SIGKILL escalation present", /process\.kill\(\s*-pid,\s*"SIGKILL"/.test(autoSrc));

if (process.platform === "win32") {
  console.log("SKIP runtime process-group test on Windows");
  if (failures) { console.error(`${failures} check(s) failed.`); process.exit(1); }
  console.log("signal process-group tests passed");
  process.exit(0);
}

// Zombie (defunct) processes still answer kill(pid,0) until reaped; they are
// dead for this test's purposes, so treat state Z as gone (same rule as
// autopilot.mjs pidAlive()).
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[0];
    if (state === "Z") return false;
  } catch { /* no /proc entry: fall through to kill(0) */ }
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const { makeFixtureRepo, writeConfig, withoutOuterGitGuard } =
  await import("./test-fixtures/workflow-order-harness.mjs");

const repo = makeFixtureRepo("signal-group");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ap-signal-group-"));
const leaderFile = path.join(tmp, "leader.pid");
const grandchildFile = path.join(tmp, "grandchild.pid");
let binDir = null;
let orch = null;
try {
  writeConfig(repo, { planningFramework: "standalone" });
  {
    const { execFileSync } = await import("node:child_process");
    fs.mkdirSync(path.join(repo, ".autopilot"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".autopilot", ".autopilot-test-scenario"), "success");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    try { execFileSync("git", ["add", "-f", ".autopilot/.autopilot-test-scenario"], { cwd: repo }); } catch {}
    execFileSync("git", ["commit", "-q", "-m", "test scenario: success"], { cwd: repo });
  }
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-signal-group-bin-"));
  // Fake adapter: fast --version probe; otherwise ignore SIGTERM/SIGINT
  // (trap '' keeps the disposition ignored across the exec of sleep, per
  // POSIX), record the leader pid, spawn a grandchild that also ignores
  // SIGTERM/SIGINT and records its pid, then block. Absolute pid-file
  // paths are embedded literally: the relay launch filters the child env,
  // so no custom env var would reach the adapter.
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  fs.writeFileSync(path.join(binDir, "cursor-agent"),
    `#!/bin/sh\n` +
    `if [ "\${1:-}" = "--version" ]; then echo "fake-cursor-agent 1.0.0"; exit 0; fi\n` +
    `trap '' TERM INT\n` +
    `echo $$ > ${q(leaderFile)}\n` +
    `sh -c 'trap "" TERM INT; echo $$ > ${q(grandchildFile)}; exec sleep 60' &\n` +
    `exec sleep 60\n`);
  fs.chmodSync(path.join(binDir, "cursor-agent"), 0o755);

  const base = withoutOuterGitGuard(process.env);
  const env = { ...base, PATH: `${binDir}:${base.PATH || ""}` };
  orch = spawn(process.execPath, [path.join(here, "autopilot.mjs"), "run", "fixture request", "--repo", repo],
    { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  let orchOut = "";
  orch.stdout?.on("data", (d) => { orchOut += d; });
  orch.stderr?.on("data", (d) => { orchOut += d; });
  const orchExited = new Promise((res) => orch.on("exit", (code, signal) => res({ code, signal })));

  const deadline = Date.now() + 60000;
  while ((!fs.existsSync(leaderFile) || !fs.existsSync(grandchildFile)) && Date.now() < deadline) {
    if (orch.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  check("adapter leader pid file written", fs.existsSync(leaderFile));
  check("adapter grandchild pid file written", fs.existsSync(grandchildFile));
  if (!fs.existsSync(leaderFile) || !fs.existsSync(grandchildFile)) {
    try { orch.kill("SIGKILL"); } catch {}
    console.error(`orchestrator output (tail):\n${orchOut.slice(-2000)}`);
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }

  const leaderPid = Number(fs.readFileSync(leaderFile, "utf8").trim());
  const grandchildPid = Number(fs.readFileSync(grandchildFile, "utf8").trim());
  check("leader pid valid", Number.isInteger(leaderPid) && leaderPid > 0);
  check("grandchild pid valid", Number.isInteger(grandchildPid) && grandchildPid > 0);
  check("adapter tree alive before signal", alive(leaderPid) && alive(grandchildPid));

  // Settle: ensure the relay child has spawned and the flush is armed.
  await new Promise((r) => setTimeout(r, 1000));

  // Send SIGTERM to the REAL orchestrator; its production
  // installInterruptFlush() handler must group-kill the adapter tree.
  try { process.kill(orch.pid, "SIGTERM"); } catch {}
  const exit = await Promise.race([
    orchExited,
    new Promise((res) => setTimeout(() => res(null), 20000)),
  ]);
  check("orchestrator exited after SIGTERM", exit !== null);

  // Bounded wait for the full tree to disappear (group SIGTERM + SIGKILL).
  let treeGone = false;
  for (let i = 0; i < 50; i++) {
    if (!alive(leaderPid) && !alive(grandchildPid)) { treeGone = true; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  check("adapter leader dead after orchestrator SIGTERM", !alive(leaderPid));
  check("adapter grandchild dead after orchestrator SIGTERM", !alive(grandchildPid));
  check("adapter tree fully reaped", treeGone);

  // The detached group itself must be gone (kill(-pgid, 0) => ESRCH).
  let groupGone = false;
  try { process.kill(-leaderPid, 0); groupGone = false; }
  catch (e) { groupGone = e?.code === "ESRCH"; }
  check("adapter process group gone", groupGone);
} finally {
  try { if (orch && orch.exitCode === null) orch.kill("SIGKILL"); } catch {}
  try { if (alive(Number(fs.existsSync(leaderFile) ? fs.readFileSync(leaderFile, "utf8").trim() : NaN))) process.kill(-Number(fs.readFileSync(leaderFile, "utf8").trim()), "SIGKILL"); } catch {}
  try {
    if (fs.existsSync(grandchildFile)) {
      const gp = Number(fs.readFileSync(grandchildFile, "utf8").trim());
      if (alive(gp)) process.kill(gp, "SIGKILL");
    }
  } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  try { if (binDir) fs.rmSync(binDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch {}
}

if (failures) {
  console.error(`${failures} signal-process-group check(s) failed.`);
  process.exit(1);
}
console.log("signal process-group tests passed");
