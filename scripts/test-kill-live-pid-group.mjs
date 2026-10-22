#!/usr/bin/env node
// Task 042-1.3: killLivePid() kills the full process group with fallback.
//
// Static: signalPid() on POSIX signals `-pid` (group) first for both gentle
// and force, falls back to the single PID on ESRCH, and reports "gone" only
// when the single-PID signal is also ESRCH.
//
// Runtime (via `ap stop --yes`, which funnels through killLivePid):
//   G1 group kill: a detached decoy run (group leader, file literally named
//      autopilot.mjs + `run` arg so the real detector trips, cwd=repo) spawns
//      a SIGTERM-ignoring grandchild in its group and ignores SIGTERM itself.
//      `ap stop --yes` must leave BOTH dead (grace expires, group SIGKILL).
//      Single-PID killing would leave the grandchild alive.
//   G2 fallback: a non-detached decoy (NOT a group leader — kill(-pid) is
//      ESRCH) that dies on SIGTERM must really die, and the output must NOT
//      say "exited on its own" (the pre-fix ESRCH-as-gone misreport).
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { makeFixtureRepo, writeConfig, cleanup, skillRoot } from "./test-fixtures/workflow-order-harness.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

const autoSrc = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
const posixSection = autoSrc.slice(autoSrc.indexOf("function signalPid"));
check("group SIGTERM sent to negative pid", /process\.kill\(\s*-pid\s*,\s*sig\)/.test(posixSection) || /process\.kill\(\s*-pid/.test(posixSection));
check("group SIGKILL escalation via same group path", /process\.kill\(\s*-pid/.test(posixSection) && /SIGKILL/.test(posixSection));
check("ESRCH falls back to single-PID signal", /catch\s*\(\s*e2?\s*\)\s*\{\s*return e2\?\.\s*code\s*===\s*"ESRCH"\s*\?\s*"gone"/.test(posixSection) || (/ESRCH/.test(posixSection) && /process\.kill\(\s*pid\s*,\s*sig\)/.test(posixSection)));
check("gone only when single-PID signal is also ESRCH",
  /process\.kill\(\s*pid\s*,\s*sig\)/.test(posixSection) && /e2\?\.\s*code\s*===\s*"ESRCH"\s*\?\s*"gone"/.test(posixSection));

if (process.platform === "win32") {
  console.log("SKIP runtime group-kill test on Windows (taskkill /T covers trees)");
  if (failures) { console.error(`${failures} check(s) failed.`); process.exit(1); }
  console.log("kill-live-pid-group tests passed");
  process.exit(0);
}

const alive = (pid) => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[0];
    if (state === "Z") return false;
  } catch { /* fall through to kill(0) */ }
  try { process.kill(pid, 0); return true; } catch { return false; }
};

function apStopYes(repo) {
  const r = spawnSync(process.execPath,
    [path.join(skillRoot, "bin", "ap.cjs"), "stop", "--yes", "--repo", repo],
    { encoding: "utf8", shell: false, timeout: 90000 });
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}
async function waitForLive(repo, pid, timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    const r = spawnSync(process.execPath,
      [path.join(skillRoot, "bin", "ap.cjs"), "stop", "--dry-run", "--repo", repo],
      { encoding: "utf8", shell: false, timeout: 30000 });
    const out = `${r.stdout || ""}${r.stderr || ""}`;
    if (out.includes("live run:") && out.includes(String(pid))) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((res) => setTimeout(res, 500));
  }
}
const settle = (ms) => new Promise((res) => setTimeout(res, ms));
const created = [];

try {
  // ---- G1: detached group leader + SIGTERM-ignoring tree -----------------
  {
    const repo = makeFixtureRepo("kill-group-"); created.push(repo);
    writeConfig(repo, { planningFramework: "standalone" });
    const fake = path.join(repo, "autopilot.mjs");
    const childPidFile = path.join(repo, "grandchild.pid");
    try { fs.rmSync(childPidFile, { force: true }); } catch {}
    // Decoy ignores SIGTERM itself; its grandchild ignores SIGTERM too. Only
    // a GROUP SIGKILL can reap both.
    fs.writeFileSync(fake, [
      `import fs from "node:fs";`,
      `import { spawn } from "node:child_process";`,
      `process.on("SIGTERM", () => {});`,
      `process.on("SIGINT", () => {});`,
      `const gc = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});setInterval(()=>{},1000);"], { stdio: "ignore" });`,
      `try { fs.writeFileSync(${JSON.stringify(childPidFile)}, String(gc.pid)); } catch {}`,
      `if (gc.unref) gc.unref();`,
      `setInterval(() => {}, 1000);`,
      ``,
    ].join("\n"));
    const decoy = spawn(process.execPath, [fake, "run"],
      { cwd: repo, stdio: "ignore", detached: true });
    decoy.unref?.();
    try {
      check("G1 decoy spawned detached (is group leader)", decoy.pid > 0);
      const visible = await waitForLive(repo, decoy.pid);
      check("G1 decoy visible to ap stop detector", visible);
      if (!visible) { try { process.kill(-decoy.pid, "SIGKILL"); } catch {} }
      else {
        let gcPid = null;
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          try {
            const raw = fs.readFileSync(childPidFile, "utf8").trim();
            const n = Number(raw);
            if (Number.isInteger(n) && n > 0) { gcPid = n; break; }
          } catch {}
          await settle(100);
        }
        check("G1 grandchild pid recorded", gcPid !== null, gcPid);
        check("G1 tree alive before stop", gcPid !== null && alive(decoy.pid) && alive(gcPid),
          { decoy: decoy.pid, gc: gcPid });
        const go = apStopYes(repo);
        await settle(500);
        check("G1 ap stop --yes exits 0", go.status === 0, { status: go.status, tail: go.out.slice(-800) });
        let treeGone = false;
        for (let i = 0; i < 50; i++) {
          const dDead = !(gcPid !== null && alive(decoy.pid));
          const gDead = !(gcPid !== null && alive(gcPid));
          if (dDead && gDead) { treeGone = true; break; }
          await settle(100);
        }
        check("G1 decoy leader dead after stop", !alive(decoy.pid));
        if (gcPid !== null) check("G1 SIGTERM-ignoring grandchild dead after stop (group SIGKILL)", !alive(gcPid), { gc: gcPid });
        check("G1 full tree reaped", treeGone);
      }
    } finally {
      try { if (alive(decoy.pid)) process.kill(-decoy.pid, "SIGKILL"); } catch {}
      try { if (decoy.exitCode === null) decoy.kill("SIGKILL"); } catch {}
    }
  }

  // ---- G2: non-group-leader fallback (single-PID kill, no "own exit") -----
  {
    const repo = makeFixtureRepo("kill-fallback-"); created.push(repo);
    writeConfig(repo, { planningFramework: "standalone" });
    const fake = path.join(repo, "autopilot.mjs");
    fs.writeFileSync(fake, "setTimeout(()=>{}, 120000);\n");
    // NOT detached: shares the test runner's process group, so kill(-pid)
    // is ESRCH and the single-PID fallback must do the kill.
    const decoy = spawn(process.execPath, [fake, "run"], { cwd: repo, stdio: "ignore" });
    try {
      const visible = await waitForLive(repo, decoy.pid);
      check("G2 decoy visible to ap stop detector", visible);
      if (visible) {
        const go = apStopYes(repo);
        await settle(300);
        const dead = decoy.exitCode !== null || decoy.signalCode != null || !alive(decoy.pid);
        check("G2 non-leader decoy really dead after stop (fallback killed it)", go.status === 0 && dead,
          { status: go.status, tail: go.out.slice(-800), exit: decoy.exitCode, sig: decoy.signalCode });
        check("G2 output does not claim it exited on its own", !go.out.includes("exited on its own"), go.out.slice(-800));
      }
    } finally {
      try { if (decoy.exitCode === null) decoy.kill("SIGKILL"); } catch {}
    }
  }
} finally {
  cleanup(...created);
}

if (failures) {
  console.error(`${failures} kill-live-pid-group check(s) failed.`);
  process.exit(1);
}
console.log("kill-live-pid-group tests passed");
