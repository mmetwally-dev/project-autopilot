#!/usr/bin/env node
// Task 042-1.4: `ap stop` post-kill verification scan for surviving adapters.
//
// Static: stopCommand() calls verifyAndKillSurvivors() after killLivePid(),
// which identity-checks each survivor via confirmedSurvivorPid() (/proc
// starttime within started_at -2s..+5s) before SIGKILL, reporting
// "verified killed" per confirmed survivor and "stale PID reused, skipped"
// per unconfirmed PID.
//
// Runtime (via `ap stop --yes`):
//   A: owner decoy (file literally named autopilot.mjs + `run` arg, cwd=repo,
//      detached, dies on SIGTERM) + two detached adapter decoys (one plain,
//      one SIGTERM-ignoring) each with a fresh `running` run dir. `ap stop
//      --yes` must leave BOTH adapters dead and report "verified killed".
//   B: fresh repo, owner decoy + a live sleep proc claimed by a STALE running
//      run (started_at ~60s ago, proc started now). `ap stop --yes` must leave
//      the sleep proc alive and report "stale PID reused, skipped".
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
check("stopCommand runs post-kill survivor verification", autoSrc.includes("verifyAndKillSurvivors(s,pid"));
check("confirmed survivors reported as verified killed", autoSrc.includes("verified killed"));
check("unconfirmed PIDs reported as stale and skipped", autoSrc.includes("stale PID reused, skipped"));
check("survivor identity window is started_at -2s..+5s",
  /runStartMs-2000/.test(autoSrc) && /runStartMs\+5000/.test(autoSrc));

if (process.platform === "win32") {
  console.log("SKIP runtime stop-verification test on Windows (no /proc starttime)");
  if (failures) { console.error(`${failures} check(s) failed.`); process.exit(1); }
  console.log("ap-stop-verification tests passed");
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

function writeRunningRun(repo, dirName, pid, startedAt) {
  const dir = path.join(repo, ".autopilot", "runs", dirName);
  fs.mkdirSync(dir, { recursive: true });
  const at = startedAt || new Date().toISOString();
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
    status: "running", run_id: dirName, started_at: at, updated_at: at,
    pid, role: "implementer", phase: null, task: null, taskRef: null,
    attempt: "1", note: null, last_action: "started",
  }, null, 2));
  return dir;
}

function spawnOwner(repo) {
  const fake = path.join(repo, "autopilot.mjs");
  fs.writeFileSync(fake, "setTimeout(()=>{}, 120000);\n");
  const decoy = spawn(process.execPath, [fake, "run"],
    { cwd: repo, stdio: "ignore", detached: true });
  decoy.unref?.();
  return decoy;
}

const created = [];
try {
  // ---- A: two surviving adapters are verified and killed -----------------
  {
    const repo = makeFixtureRepo("stop-verify-"); created.push(repo);
    writeConfig(repo, { planningFramework: "standalone" });
    const owner = spawnOwner(repo);
    let adapterA = null, adapterB = null;
    try {
      const visible = await waitForLive(repo, owner.pid);
      check("A owner visible to ap stop detector", visible);
      if (!visible) {
        try { process.kill(-owner.pid, "SIGKILL"); } catch {}
      } else {
        // Spawn adapters AFTER waitForLive() returns (which can poll up to
        // 20s): started_at is written immediately after spawn, so the proc
        // start time always falls inside the started_at -2s..+5s identity
        // window. Spawning before the wait risked exceeding the -2s edge
        // under load and flaking as "stale PID reused, skipped".
        adapterA = spawn(process.execPath, ["-e", "setInterval(()=>{},1000);"],
          { stdio: "ignore", detached: true });
        adapterA.unref?.();
        adapterB = spawn(process.execPath,
          ["-e", "process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});setInterval(()=>{},1000);"],
          { stdio: "ignore", detached: true });
        adapterB.unref?.();
        writeRunningRun(repo, "01-implementer-aaaaaaaa", adapterA.pid);
        writeRunningRun(repo, "02-implementer-bbbbbbbb", adapterB.pid);
        check("A adapters alive before stop", alive(adapterA.pid) && alive(adapterB.pid));
        const go = apStopYes(repo);
        await settle(500);
        check("A ap stop --yes exits 0", go.status === 0, { status: go.status, tail: go.out.slice(-800) });
        let bothGone = false;
        for (let i = 0; i < 50; i++) {
          if (!alive(adapterA.pid) && !alive(adapterB.pid)) { bothGone = true; break; }
          await settle(100);
        }
        check("A SIGTERM-compliant adapter dead after stop", !alive(adapterA.pid), { pid: adapterA.pid });
        check("A SIGTERM-ignoring adapter dead after stop", !alive(adapterB.pid), { pid: adapterB.pid });
        check("A full survivor tree reaped", bothGone);
        check("A output reports verified killed", go.out.includes("verified killed"), go.out.slice(-800));
      }
    } finally {
      for (const p of [owner.pid, adapterA?.pid, adapterB?.pid].filter(Number.isInteger)) {
        try { if (alive(p)) process.kill(p, "SIGKILL"); } catch {}
      }
      try { if (alive(owner.pid)) process.kill(-owner.pid, "SIGKILL"); } catch {}
    }
  }

  // ---- B: stale PID reuse is never killed --------------------------------
  {
    const repo = makeFixtureRepo("stop-stale-"); created.push(repo);
    writeConfig(repo, { planningFramework: "standalone" });
    const owner = spawnOwner(repo);
    // Live but unrelated: started NOW, while the stale run claims started_at
    // ~60s ago — far outside the identity window, so it must be skipped.
    const sleeper = spawn(process.execPath, ["-e", "setInterval(()=>{},1000);"],
      { stdio: "ignore" });
    try {
      const visible = await waitForLive(repo, owner.pid);
      check("B owner visible to ap stop detector", visible);
      if (!visible) {
        try { process.kill(-owner.pid, "SIGKILL"); } catch {}
      } else {
        writeRunningRun(repo, "01-implementer-cccccccc", sleeper.pid,
          new Date(Date.now() - 60000).toISOString());
        check("B sleeper alive before stop", alive(sleeper.pid));
        const go = apStopYes(repo);
        await settle(500);
        check("B ap stop --yes exits 0", go.status === 0, { status: go.status, tail: go.out.slice(-800) });
        check("B unrelated process survives untouched", alive(sleeper.pid), { pid: sleeper.pid });
        check("B output reports stale PID reused, skipped",
          go.out.includes("stale PID reused, skipped"), go.out.slice(-800));
      }
    } finally {
      try { if (alive(owner.pid)) process.kill(-owner.pid, "SIGKILL"); } catch {}
      try { if (sleeper.exitCode === null) sleeper.kill("SIGKILL"); } catch {}
      try { if (alive(sleeper.pid)) process.kill(sleeper.pid, "SIGKILL"); } catch {}
    }
  }
} finally {
  cleanup(...created);
}

if (failures) {
  console.error(`${failures} ap-stop-verification check(s) failed.`);
  process.exit(1);
}
console.log("ap-stop-verification tests passed");
