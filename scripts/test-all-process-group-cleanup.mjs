#!/usr/bin/env node
// Process-group stop coverage for the parallel runner: helper unit cases
// (injected kill/sleep fns, no real signals) plus a real grandchild test
// proving a helper-driven stop of a detached leader's group also reaps a
// non-detached sleeper that holds the leader's pipes open.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import {
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_TASKKILL_TIMEOUT_MS,
  defaultWindowsKillFn,
  killPosixGroup,
  posixGroupAlive,
  __testables,
} from "./bounded-process-tree.mjs";
import {
  decideGroupKill,
  killGroupNow,
  stopProcessGroup,
} from "./process-group-stop.mjs";

let failures = 0;
function check(name, condition) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
}

function makeKillRecorder({throwOn = null} = {}) {
  const calls = [];
  const fn = (target, signal) => {
    calls.push([target, signal]);
    if (throwOn !== null && signal === throwOn) throw new Error(`boom ${signal}`);
    return true;
  };
  return {calls, fn};
}

function makeSleepRecorder() {
  const calls = [];
  const fn = ms => { calls.push(ms); return Promise.resolve(); };
  return {calls, fn};
}

// ---- helper unit cases (no real signals: every signalling/timing fn is injected) ----
{
  const {calls, fn} = makeKillRecorder();
  const plan = decideGroupKill(1234, {isWindows: false, killGroupFn: fn});
  check("decide: posix group method", plan.method === "posix-group");
  check("decide: posix group target is negated pid", plan.target === -1234);
  check("decide: posix first signal is SIGTERM", plan.signal === "SIGTERM");
  check("decide: echoes injected kill fn", plan.killGroupFn === fn);
  check("decide: pure, injected kill fn never invoked", calls.length === 0);
}

{
  const plan = decideGroupKill(1234, {isWindows: true});
  check("decide: windows taskkill method", plan.method === "windows-taskkill");
  check("decide: windows target is plain pid", plan.target === 1234);
  check("decide: windows carries no posix signal", plan.signal === null);
}

for (const bad of [0, -5, NaN, "abc", null, undefined, 1.5]) {
  const plan = decideGroupKill(bad, {isWindows: false});
  check(`decide: invalid pid ${String(bad)} maps to none`, plan.method === "none" && plan.target === null);
}

{
  const rec = makeKillRecorder();
  const sleep = makeSleepRecorder();
  const result = await stopProcessGroup(4321, {isWindows: false, killGroupFn: rec.fn, sleepFn: sleep.fn, graceMs: 25});
  check("stop: posix SIGTERM first to leader pid", rec.calls.length >= 1 && rec.calls[0][0] === 4321 && rec.calls[0][1] === "SIGTERM");
  check("stop: posix waits the injected grace once", sleep.calls.length === 1 && sleep.calls[0] === 25);
  check("stop: posix SIGKILL after grace", rec.calls.length === 2 && rec.calls[1][0] === 4321 && rec.calls[1][1] === "SIGKILL");
  check("stop: posix reports both signals accepted", result.method === "posix-group" && result.termOk === true && result.killOk === true);
}

{
  const rec = makeKillRecorder();
  const sleep = makeSleepRecorder();
  await stopProcessGroup(4321, {isWindows: false, killGroupFn: rec.fn, sleepFn: sleep.fn});
  check("stop: default grace is DEFAULT_KILL_GRACE_MS (500)", sleep.calls.length === 1 && sleep.calls[0] === DEFAULT_KILL_GRACE_MS && DEFAULT_KILL_GRACE_MS === 500);
}

{
  const rec = makeKillRecorder();
  const sleep = makeSleepRecorder();
  const windowsCalls = [];
  const windowsKillFn = (target, opts) => { windowsCalls.push([target, opts]); return {status: 0}; };
  const result = await stopProcessGroup(4321, {isWindows: true, killGroupFn: rec.fn, sleepFn: sleep.fn, windowsKillFn});
  check("stop: windows single taskkill path", windowsCalls.length === 1 && windowsCalls[0][0] === 4321);
  check("stop: windows never touches posix group kill", rec.calls.length === 0);
  check("stop: windows never waits a grace", sleep.calls.length === 0);
  check("stop: windows reports taskkill success", result.method === "windows-taskkill" && result.termOk === true);
}

{
  const rec = makeKillRecorder();
  const sleep = makeSleepRecorder();
  const result = await stopProcessGroup(0, {isWindows: false, killGroupFn: rec.fn, sleepFn: sleep.fn});
  check("stop: invalid pid signals nothing", rec.calls.length === 0 && sleep.calls.length === 0 && result.method === "none");
}

{
  const rec = makeKillRecorder({throwOn: "SIGTERM"});
  const sleep = makeSleepRecorder();
  let settled = false;
  try {
    await stopProcessGroup(4321, {isWindows: false, killGroupFn: rec.fn, sleepFn: sleep.fn, graceMs: 1});
    settled = true;
  } catch { settled = false; }
  check("stop: throwing kill fn is swallowed, escalation continues", settled && rec.calls.length === 2 && sleep.calls.length === 1);
}

// ---- shared-module surface: named exports exist, frozen testables intact ----
{
  check("bounded tree: posixGroupAlive named export", typeof posixGroupAlive === "function");
  check("bounded tree: killPosixGroup named export", typeof killPosixGroup === "function");
  check("bounded tree: defaultWindowsKillFn named export", typeof defaultWindowsKillFn === "function");
  check("bounded tree: DEFAULT_KILL_GRACE_MS still 500", DEFAULT_KILL_GRACE_MS === 500);
  check("bounded tree: DEFAULT_TASKKILL_TIMEOUT_MS intact", DEFAULT_TASKKILL_TIMEOUT_MS === 3000);
  check("bounded tree: __testables still frozen", Object.isFrozen(__testables));
  const keys = Object.keys(__testables).sort();
  check("bounded tree: __testables keys unchanged", JSON.stringify(keys) === JSON.stringify(["defaultWindowsKillFn", "killPosixGroup", "normalizeTaskkillResult", "posixGroupAlive"]));
  check("bounded tree: named export matches frozen testable", __testables.killPosixGroup === killPosixGroup && __testables.posixGroupAlive === posixGroupAlive && __testables.defaultWindowsKillFn === defaultWindowsKillFn);
  check("helper: killGroupNow rejects invalid pid without signalling", killGroupNow(0) === false);
}

// ---- no exit hooks in the new surface ----
{
  const needle = "process" + "." + "on" + "(";
  for (const file of ["process-group-stop.mjs", "test-all-process-group-cleanup.mjs"]) {
    const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), file), "utf8");
    check(`no exit hook in ${file}`, !src.includes(needle));
  }
}

// ---- real grandchild test: helper-driven stop of -leaderPid reaps the sleeper ----
function procState(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.match(/\)\s+(\S)/)?.[1] ?? null;
  } catch { return null; }
}

function isGone(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error?.code === "ESRCH";
  }
  // Signal 0 succeeded: alive, unless it is an unreaped zombie.
  if (process.platform === "win32") return false;
  const state = procState(pid);
  return state === "Z" || state === "X";
}

async function waitGone(pid, timeoutMs = 10000) {
  const start = Date.now();
  while (!isGone(pid)) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return true;
}

if (process.platform === "win32") {
  console.log("SKIP grandchild group test on Windows (POSIX process groups only)");
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ap-pg-cleanup-"));
  let leader = null;
  try {
    const leaderPath = path.join(tmp, "leader.mjs");
    fs.writeFileSync(leaderPath, [
      `import {spawn} from "node:child_process";`,
      `const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000);"], {stdio: "inherit"});`,
      `console.log("READY " + sleeper.pid);`,
      `setTimeout(() => {}, 120000);`,
      ``,
    ].join("\n"));
    leader = spawn(process.execPath, [leaderPath], {detached: true, stdio: ["ignore", "pipe", "pipe"], shell: false});
    let out = "";
    leader.stdout.on("data", chunk => { out += chunk.toString(); });
    leader.stderr.on("data", () => {});
    leader.on("error", () => {});
    const start = Date.now();
    let sleeperPid = null;
    while (sleeperPid === null) {
      const match = out.match(/READY (\d+)/);
      if (match) sleeperPid = Number(match[1]);
      else if (Date.now() - start > 10000) break;
      else await new Promise(resolve => setTimeout(resolve, 25));
    }
    check("grandchild: sleeper signalled readiness", sleeperPid !== null);
    if (sleeperPid !== null) {
      check("grandchild: sleeper alive before stop", !isGone(sleeperPid));
      const result = await stopProcessGroup(leader.pid, {graceMs: 50});
      check("grandchild: helper stop targeted the posix group", result.method === "posix-group");
      check("grandchild: sleeper pid gone after group stop", await waitGone(sleeperPid));
      check("grandchild: leader pid gone after group stop", await waitGone(leader.pid));
    }
  } catch (error) {
    failures += 1;
    console.error(`ERROR grandchild test: ${error?.stack ?? error}`);
  } finally {
    try { if (leader?.pid) { try { process.kill(-leader.pid, "SIGKILL"); } catch {} } } catch {}
    try { fs.rmSync(tmp, {recursive: true, force: true}); } catch {}
  }
}

// ---- runner wiring: early-stop paths delegate to the helper ----
{
  const repoDir = path.dirname(new URL(import.meta.url).pathname);
  const runnerSrc = fs.readFileSync(path.join(repoDir, "test-all.mjs"), "utf8");
  const killTreeBody = (runnerSrc.match(/async function killTree[\s\S]*?\n\}/) ?? [""])[0];
  const dotKill = "." + "kill" + "(";
  const procKill = "process" + "." + "kill";
  const taskKill = "task" + "kill";
  check("runner: imports the stop helper", runnerSrc.includes("./process-group-stop.mjs"));
  check("runner: killTree delegates to stopProcessGroup", killTreeBody.includes("stopProcessGroup"));
  check("runner: killTree has no inline process.kill", !killTreeBody.includes(procKill));
  check("runner: killTree has no inline taskkill", !killTreeBody.includes(taskKill));
  check("runner: killTree has no inline child kill", !killTreeBody.includes(dotKill));
  check("runner: killTree has no inline SIGKILL", !killTreeBody.includes("SIG" + "KILL"));
  check("runner: killTree has no inline SIGTERM", !killTreeBody.includes("SIG" + "TERM"));
  check("runner: exited-leader early return is Windows-only", killTreeBody.includes("win32") && killTreeBody.includes("exitCode"));
  check("runner: stopping flag gates new launches", runnerSrc.includes("if (stopping) break"));
  check("runner: stopping flag ignores late results", runnerSrc.includes("if (stopping) return"));
  check("runner: stop/exit runs only once", runnerSrc.includes("earlyStopExited"));
  check("runner: early-stop paths await the stop", (runnerSrc.match(/await stopAll\(\)/g) ?? []).length >= 2);
  check("runner: max-failures gate still finishes in-flight runs", runnerSrc.includes("keepGoing && keepGoingFailures.length >= maxFailures"));
  const onExitDq = "on" + "(" + "\"exit\"";
  const onExitSq = "on" + "(" + "'exit'";
  check("runner: exit-event reap hook present", runnerSrc.includes(onExitDq) || runnerSrc.includes(onExitSq));
  check("runner: exit event invokes the helper group-kill", runnerSrc.includes("killGroupNow"));
  check("runner: close handler still resolves status/output", runnerSrc.includes("close") && runnerSrc.includes("resolve({name, status, signal"));
  for (const file of ["test-all-keep-going.mjs", "test-all-skip-live.mjs"]) {
    const src = fs.readFileSync(path.join(repoDir, file), "utf8");
    check(`fixture ${file} copies the stop helper`, src.includes("process-group-stop.mjs"));
    check(`fixture ${file} copies the bounded tree`, src.includes("bounded-process-tree.mjs"));
  }
}

// ---- runner-level early stop: fail-fast kill reaps the piped grandchild ----
if (process.platform === "win32") {
  console.log("SKIP runner early-stop test on Windows (POSIX process groups only)");
} else {
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "ap-pg-earlystop-"));
  try {
    const scriptsDir = path.join(tmp2, "scripts");
    fs.mkdirSync(scriptsDir, {recursive: true});
    const repoDir = path.dirname(new URL(import.meta.url).pathname);
    for (const f of ["test-all.mjs", "suite-schedule.mjs", "process-group-stop.mjs", "bounded-process-tree.mjs", "suite-live-file-guard.mjs"]) {
      fs.copyFileSync(path.join(repoDir, f), path.join(scriptsDir, f));
    }
    fs.writeFileSync(path.join(scriptsDir, "test-aaa-fail-fast.mjs"), `console.log("FAIL early boom");\nsetTimeout(() => process.exit(3), 1500);\n`);
    fs.writeFileSync(path.join(scriptsDir, "test-aab-long.mjs"), [
      `import {spawn} from "node:child_process";`,
      `import fs from "node:fs";`,
      `import path from "node:path";`,
      `const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000);"], {stdio: "inherit"});`,
      `fs.writeFileSync(path.join(process.cwd(), ".grandchild-pid"), String(sleeper.pid));`,
      `console.log("READY " + sleeper.pid);`,
      `setTimeout(() => {}, 120000);`,
      ``,
    ].join("\n"));
    const runner = spawn(process.execPath, [path.join(scriptsDir, "test-all.mjs"), "--jobs", "2"], {
      cwd: tmp2, stdio: ["ignore", "pipe", "pipe"], shell: false, detached: true,
    });
    let runnerOut = "";
    runner.stdout.on("data", chunk => { runnerOut += chunk.toString(); });
    runner.stderr.on("data", chunk => { runnerOut += chunk.toString(); });
    runner.on("error", () => {});
    const exitCode = await new Promise(resolve => {
      const timer = setTimeout(() => {
        try { process.kill(-runner.pid, "SIGKILL"); } catch {}
        resolve(null);
      }, 60000);
      timer.unref?.();
      runner.on("close", code => { clearTimeout(timer); resolve(code); });
    });
    check("early-stop: runner exits with the failing status", exitCode === 3);
    check("early-stop: runner never reports passed after early stop", !runnerOut.toLowerCase().includes("passed"));
    let gcPid = null;
    try { gcPid = Number(fs.readFileSync(path.join(tmp2, ".grandchild-pid"), "utf8").trim()); } catch {}
    check("early-stop: grandchild pid recorded", Number.isInteger(gcPid) && gcPid > 0);
    if (Number.isInteger(gcPid) && gcPid > 0) {
      check("early-stop: grandchild gone after early stop", await waitGone(gcPid));
    }
    try { if (exitCode === null && runner.pid) { try { process.kill(-runner.pid, "SIGKILL"); } catch {} } } catch {}
  } catch (error) {
    failures += 1;
    console.error(`ERROR early-stop test: ${error?.stack ?? error}`);
  } finally {
    try { fs.rmSync(tmp2, {recursive: true, force: true}); } catch {}
  }
}

// ---- runner-level normal completion: exiting fake with a stray piped
// group member leaves nothing behind via the exit-event group kill ----
if (process.platform === "win32") {
  console.log("SKIP runner normal-completion test on Windows (POSIX process groups only)");
} else {
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), "ap-pg-normal-"));
  try {
    const scriptsDir = path.join(tmp3, "scripts");
    fs.mkdirSync(scriptsDir, {recursive: true});
    const repoDir = path.dirname(new URL(import.meta.url).pathname);
    for (const f of ["test-all.mjs", "suite-schedule.mjs", "process-group-stop.mjs", "bounded-process-tree.mjs", "suite-live-file-guard.mjs"]) {
      fs.copyFileSync(path.join(repoDir, f), path.join(scriptsDir, f));
    }
    fs.writeFileSync(path.join(scriptsDir, "test-aaa-pass-stray.mjs"), [
      `import {spawn} from "node:child_process";`,
      `import fs from "node:fs";`,
      `import path from "node:path";`,
      `const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000);"], {stdio: "inherit"});`,
      `fs.writeFileSync(path.join(process.cwd(), ".grandchild-pid"), String(sleeper.pid));`,
      `console.log("READY " + sleeper.pid);`,
      `process.exit(0);`,
      ``,
    ].join("\n"));
    const {spawnSync} = await import("node:child_process");
    const r = spawnSync(process.execPath, [path.join(scriptsDir, "test-all.mjs"), "--jobs", "1"], {
      cwd: tmp3, encoding: "utf8", shell: false, timeout: 60000,
    });
    check("normal-completion: runner exits 0", r.status === 0);
    check("normal-completion: pass reported unchanged", (r.stdout ?? "").includes("PASS"));
    let gcPid = null;
    try { gcPid = Number(fs.readFileSync(path.join(tmp3, ".grandchild-pid"), "utf8").trim()); } catch {}
    check("normal-completion: stray pid recorded", Number.isInteger(gcPid) && gcPid > 0);
    if (Number.isInteger(gcPid) && gcPid > 0) {
      check("normal-completion: stray gone after normal completion", await waitGone(gcPid));
    }
  } catch (error) {
    failures += 1;
    console.error(`ERROR normal-completion test: ${error?.stack ?? error}`);
  } finally {
    try { fs.rmSync(tmp3, {recursive: true, force: true}); } catch {}
  }
}

if (failures) {
  console.error(`${failures} process-group-cleanup check(s) failed.`);
  process.exit(1);
}
console.log("process-group-cleanup tests passed");
