#!/usr/bin/env node
// Mission 041 Phase 1 task 1.1 — owner PID file lifecycle and live detection.
//
// Unit tests for `scripts/owner-pid.mjs` (wired into `scripts/autopilot.mjs`
// via import + re-export; that module cannot be imported here because it
// executes its CLI `main()` at import). Covers: path helper, atomic
// write/read roundtrip, idempotent removal, cmdline matching with repo path
// normalization (run without --repo, `full` command), cross-platform mismatch
// falling through without stale deletion, stale PID cleanup, and a
// Windows-style cmdline without --repo (injected cmdline/cwd provider) judged
// live and not deleted.
//
// Fixture repos live under $TMPDIR (os.tmpdir), never inside the project repo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn, spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {
  ownerPidPath, writeOwnerPid, readOwnerPid, verifyOwnerPid, removeOwnerPid,
  ownerPidAlive,
} from "./owner-pid.mjs";
import {
  makeFixtureRepo, makeFixtureBin, writeConfig, setScenario, withoutOuterGitGuard,
} from "./test-fixtures/workflow-order-harness.mjs";
import {readResetRequests} from "./reset-request-queue.mjs";
import * as standalone from "../adapters/standalone.mjs";

let ok = 0, failed = 0;
function check(name, condition, detail){
  if(condition){ ok++; console.log(`PASS ${name}`); return; }
  failed++;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

function makeRepo(prefix){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, ".autopilot"), {recursive: true});
  return dir;
}
// POSIX /proc-style cmdline: NUL-separated argv.
function procCmd(...argv){ return argv.join("\0") + "\0"; }
const live = () => true;
const dead = () => false;

const repos = [];
try {
  // ---- 1. path helper -------------------------------------------------------
  {
    const repo = makeRepo("owner-pid-path-"); repos.push(repo);
    check("ownerPidPath returns .autopilot/owner.pid",
      ownerPidPath(repo) === path.join(repo, ".autopilot", "owner.pid"),
      ownerPidPath(repo));
  }

  // ---- 2. write/read roundtrip ----------------------------------------------
  {
    const repo = makeRepo("owner-pid-roundtrip-"); repos.push(repo);
    const savedWsl = process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_DISTRO_NAME;
    try {
      const rec = writeOwnerPid(process.pid, repo);
      check("write returns {pid, platform}", rec.pid === process.pid && rec.platform === process.platform, rec);
      check("write omits wslDistro when unknown", !("wslDistro" in rec), rec);
      const raw = JSON.parse(fs.readFileSync(ownerPidPath(repo), "utf8"));
      check("file holds atomic JSON {pid, platform}", raw.pid === process.pid && raw.platform === process.platform, raw);
      const back = readOwnerPid(repo);
      check("read returns parsed object", back && back.pid === process.pid && back.platform === process.platform, back);
    } finally {
      if(savedWsl === undefined) delete process.env.WSL_DISTRO_NAME;
      else process.env.WSL_DISTRO_NAME = savedWsl;
    }
  }

  // ---- 3. wslDistro recorded when known --------------------------------------
  {
    const repo = makeRepo("owner-pid-distro-"); repos.push(repo);
    const savedWsl = process.env.WSL_DISTRO_NAME;
    process.env.WSL_DISTRO_NAME = "Ubuntu-test";
    try {
      const rec = writeOwnerPid(4242, repo, {platform: process.platform});
      check("write records wslDistro", rec.wslDistro === "Ubuntu-test", rec);
      check("read keeps wslDistro", readOwnerPid(repo)?.wslDistro === "Ubuntu-test");
    } finally {
      if(savedWsl === undefined) delete process.env.WSL_DISTRO_NAME;
      else process.env.WSL_DISTRO_NAME = savedWsl;
    }
  }

  // ---- 4. read/remove edge cases ----------------------------------------------
  {
    const repo = makeRepo("owner-pid-edge-"); repos.push(repo);
    check("read missing file returns null", readOwnerPid(repo) === null);
    fs.writeFileSync(ownerPidPath(repo), "{not json");
    check("read corrupt JSON returns null", readOwnerPid(repo) === null);
    fs.writeFileSync(ownerPidPath(repo), "42");
    check("read non-object JSON returns null", readOwnerPid(repo) === null);
    check("remove missing file is idempotent (no throw)", removeOwnerPid(repo) === true);
    writeOwnerPid(1111, repo);
    check("remove existing file removes it",
      removeOwnerPid(repo) === true && !fs.existsSync(ownerPidPath(repo)));
    check("remove twice is idempotent (no throw)", removeOwnerPid(repo) === true);
    writeOwnerPid(1111, repo);
    check("remove with non-matching ifPid keeps the file",
      removeOwnerPid(repo, {ifPid: 2222}) === false && fs.existsSync(ownerPidPath(repo)));
    check("remove with matching ifPid removes the file",
      removeOwnerPid(repo, {ifPid: 1111}) === true && !fs.existsSync(ownerPidPath(repo)));
  }

  // ---- 5. verify: --repo match + realpath normalization -----------------------
  {
    const repo = makeRepo("owner-pid-repo-"); repos.push(repo);
    const real = fs.realpathSync(repo);
    const cmd = procCmd("/usr/bin/node", "/x/scripts/autopilot.mjs", "run", "--repo", repo);
    check("verify live via --repo in cmdline",
      verifyOwnerPid({pid: 999001, platform: process.platform}, repo,
        {isAlive: live, readCmdline: () => cmd, readCwd: () => { throw new Error("denied"); }}) === true);
    // Symlinked repo path in cmdline vs resolved repo argument (and reverse).
    const linkBase = fs.mkdtempSync(path.join(os.tmpdir(), "owner-pid-linkbase-")); repos.push(linkBase);
    const link = path.join(linkBase, "linkrepo");
    try { fs.symlinkSync(repo, link); } catch { /* Windows without privilege: skip link cases */ }
    if(fs.existsSync(link)){
      const viaLink = procCmd("/usr/bin/node", "/x/scripts/autopilot.mjs", "resume", "--repo", link);
      check("verify live via symlinked --repo (realpath-normalized)",
        verifyOwnerPid({pid: 999002, platform: process.platform}, real,
          {isAlive: live, readCmdline: () => viaLink, readCwd: () => "/elsewhere"}) === true);
      const viaReal = procCmd("/usr/bin/node", "/x/scripts/autopilot.mjs", "implement", "--repo", real);
      check("verify live via real --repo against symlinked repo arg",
        verifyOwnerPid({pid: 999003, platform: process.platform}, link,
          {isAlive: live, readCmdline: () => viaReal, readCwd: () => "/elsewhere"}) === true);
    }
    // Other-repo cmdline + foreign cwd must NOT attribute.
    const foreign = procCmd("/usr/bin/node", "/x/scripts/autopilot.mjs", "run", "--repo", "/some/other/repo");
    check("verify false for another repo's run",
      verifyOwnerPid({pid: 999004, platform: process.platform}, repo,
        {isAlive: live, readCmdline: () => foreign, readCwd: () => "/some/other/repo"}) === false);
  }

  // ---- 6. verify: run without --repo (cwd match), full/resume/implement -------
  {
    const repo = makeRepo("owner-pid-cwd-"); repos.push(repo);
    const real = fs.realpathSync(repo);
    for(const command of ["run", "resume", "implement", "full"]){
      const cmd = procCmd("/usr/bin/node", "/x/scripts/autopilot.mjs", command);
      check(`verify live for '${command}' without --repo via cwd`,
        verifyOwnerPid({pid: 999010, platform: process.platform}, repo,
          {isAlive: live, readCmdline: () => cmd, readCwd: () => real}) === true);
    }
    const fullWithRepo = procCmd("/usr/bin/node", "/x/scripts/autopilot.mjs", "full", "--repo", repo);
    check("verify live for 'full' with --repo",
      verifyOwnerPid({pid: 999011, platform: process.platform}, repo,
        {isAlive: live, readCmdline: () => fullWithRepo, readCwd: () => "/elsewhere"}) === true);
  }

  // ---- 7. verify: mismatches ---------------------------------------------------
  {
    const repo = makeRepo("owner-pid-mismatch-"); repos.push(repo);
    const status = procCmd("/usr/bin/node", "/x/scripts/autopilot.mjs", "status");
    check("verify false for non-owner command (status)",
      verifyOwnerPid({pid: 999020, platform: process.platform}, repo,
        {isAlive: live, readCmdline: () => status, readCwd: () => repo}) === false);
    const other = procCmd("/usr/bin/node", "/x/scripts/other.mjs", "run", "--repo", repo);
    check("verify false for other script",
      verifyOwnerPid({pid: 999021, platform: process.platform}, repo,
        {isAlive: live, readCmdline: () => other, readCwd: () => repo}) === false);
    const runlike = procCmd("/usr/bin/node", "/x/scripts/autopilot.mjs", "--runner", "x");
    check("verify false for run-like flag (no token match)",
      verifyOwnerPid({pid: 999022, platform: process.platform}, repo,
        {isAlive: live, readCmdline: () => runlike, readCwd: () => repo}) === false);
    check("verify false for null/unreadable cmdline",
      verifyOwnerPid({pid: 999023, platform: process.platform}, repo,
        {isAlive: live, readCmdline: () => null, readCwd: () => repo}) === false);
    check("verify false for null pidObj", verifyOwnerPid(null, repo, {isAlive: live}) === false);
    check("verify false for non-integer pid",
      verifyOwnerPid({pid: "999", platform: process.platform}, repo, {isAlive: live}) === false);
  }

  // ---- 8. stale PID cleanup -----------------------------------------------------
  {
    const repo = makeRepo("owner-pid-stale-"); repos.push(repo);
    writeOwnerPid(999030, repo);
    const obj = readOwnerPid(repo);
    const cmd = procCmd("/usr/bin/node", "/x/scripts/autopilot.mjs", "run", "--repo", repo);
    check("verify false for dead PID",
      verifyOwnerPid(obj, repo, {isAlive: dead, readCmdline: () => cmd, readCwd: () => repo}) === false);
    check("stale PID file cleaned up by removeOwnerPid",
      removeOwnerPid(repo) === true && !fs.existsSync(ownerPidPath(repo)));
    // Same-platform cmdline mismatch is also stale-eligible.
    writeOwnerPid(999031, repo);
    const status = procCmd("/usr/bin/node", "/x/scripts/autopilot.mjs", "status");
    check("verify false for recycled PID (cmdline mismatch)",
      verifyOwnerPid(readOwnerPid(repo), repo,
        {isAlive: live, readCmdline: () => status, readCwd: () => repo}) === false);
    check("recycled-PID file cleaned up by removeOwnerPid",
      removeOwnerPid(repo) === true && !fs.existsSync(ownerPidPath(repo)));
  }

  // ---- 9. cross-platform mismatch: false, file kept ------------------------------
  {
    const repo = makeRepo("owner-pid-xplat-"); repos.push(repo);
    const foreign = process.platform === "win32" ? "linux" : "win32";
    writeOwnerPid(999040, repo);
    const cmd = procCmd("/usr/bin/node", "/x/scripts/autopilot.mjs", "run", "--repo", repo);
    check("verify false on platform mismatch",
      verifyOwnerPid({pid: 999040, platform: foreign}, repo,
        {platform: process.platform, isAlive: live, readCmdline: () => cmd, readCwd: () => repo}) === false);
    check("cross-platform file NOT deleted (falls through, no stale deletion)",
      fs.existsSync(ownerPidPath(repo)));
  }

  // ---- 10. Windows-style cmdline without --repo: live, not deleted ----------------
  {
    const repo = makeRepo("owner-pid-win-"); repos.push(repo);
    writeOwnerPid(999050, repo, {platform: "win32"});
    const winCmd = "C:\\Program Files\\nodejs\\node.exe C:\\work\\proj\\scripts\\autopilot.mjs run";
    const unreadableCwd = () => { throw Object.assign(new Error("no /proc on Windows"), {code: "ENOENT"}); };
    check("Windows-style no---repo cmdline judged live (cwd unreadable)",
      verifyOwnerPid(readOwnerPid(repo), repo,
        {platform: "win32", isAlive: live, readCmdline: () => winCmd, readCwd: unreadableCwd}) === true);
    check("Windows-style live file NOT deleted", fs.existsSync(ownerPidPath(repo)));
    const winFull = "\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\work\\proj\\scripts\\autopilot.mjs\" full";
    check("Windows-style 'full' judged live",
      verifyOwnerPid(readOwnerPid(repo), repo,
        {platform: "win32", isAlive: live, readCmdline: () => winFull, readCwd: () => null}) === true);
  }

  // ---- 10b. default readers on win32 with unreadable cmdline: "unknown", kept --
  {
    const repo = makeRepo("owner-pid-win-unknown-"); repos.push(repo);
    // Own pid is alive, so only the cmdline lookup can fail. With NO injected
    // readers the default CIM query fails on non-Windows hosts (null), which
    // is exactly the native-Windows-without-CIM shape: "unknown", never false.
    writeOwnerPid(process.pid, repo, {platform: "win32"});
    const verdict = verifyOwnerPid(readOwnerPid(repo), repo, {platform: "win32"});
    check("default-readers win32 unreadable cmdline is 'unknown', not false",
      verdict === "unknown", verdict);
    check("default-readers win32 'unknown' is not truthy-live and not stale-false",
      verdict !== true && verdict !== false);
    check("'unknown' file NOT deleted (stale branch requires === false)",
      fs.existsSync(ownerPidPath(repo)));
    const staleEligible = verdict === false && readOwnerPid(repo)?.platform === "win32";
    check("'unknown' excluded from stale-deletion branch", staleEligible === false);
    removeOwnerPid(repo);
  }

  // ---- 11. real /proc end-to-end: self pid, foreign cmdline ⇒ false ---------------
  {
    const repo = makeRepo("owner-pid-real-"); repos.push(repo);
    writeOwnerPid(process.pid, repo);
    check("real check: own pid but test cmdline is not live",
      verifyOwnerPid(readOwnerPid(repo), repo) === false);
    check("real check leaves the file alone", fs.existsSync(ownerPidPath(repo)));
    removeOwnerPid(repo);
  }
} finally {
  for(const dir of repos){ try{ fs.rmSync(dir, {recursive: true, force: true}); }catch{ /* best-effort */ } }
}

// ---- 12. integration: live guard/refuse/cleanup via real `ap run` ---------
if(process.platform === "win32"){
  console.log("SKIP live-run integration on win32 (bubblewrap read-only roles unavailable)");
} else {
  const liveHere = path.dirname(fileURLToPath(import.meta.url));
  const liveAutopilot = path.join(liveHere, "autopilot.mjs");
  const liveRequest = "fixture request";
  const liveMission = "001-owner-pid-live";
  const liveDelim = ":";
  const liveFixtures = [];
  const trackLive = (dir) => { liveFixtures.push(dir); };
  const writeLiveMission = (repo, tasksContent) => {
    const planFile = standalone.planPath(repo, liveMission);
    const tasksFile = standalone.tasksPath(repo, liveMission);
    fs.mkdirSync(path.dirname(planFile), {recursive: true});
    fs.writeFileSync(planFile, "# Plan\n\nObjective: fixture task.\n");
    fs.writeFileSync(tasksFile, tasksContent);
  };
  const writeLiveState = (repo) => {
    fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
    fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(
      {version: 1, phase: "tasks_ready", step: "tasks_ready", phaseIndex: 0, attempt: 1, mission: liveMission, planningRequest: liveRequest}, null, 2));
  };
  const liveEnvFor = (binDir) => {
    const base = withoutOuterGitGuard(process.env);
    return {...base, PATH: `${binDir}${liveDelim}${base.PATH || ""}`};
  };
  let hangChild = null;
  try {
    // Hang fixture: planning + implementer lead (~7s), then reviewer sleeps 45s.
    const hangRepo = makeFixtureRepo("owner-pid-live-"); trackLive(hangRepo);
    const hangBin = makeFixtureBin("owner-pid-live-"); trackLive(hangBin);
    writeConfig(hangRepo, {planningFramework: "standalone"});
    setScenario(hangRepo, "standalone_reviewer_hang");
    writeLiveMission(hangRepo, "## Phase 1: General\n\n- [ ] Do the fixture task\n");
    writeLiveState(hangRepo);
    const hangEnv = liveEnvFor(hangBin);
    hangChild = spawn(process.execPath,
      [liveAutopilot, "run", liveRequest, "--repo", hangRepo],
      {cwd: hangRepo, env: hangEnv, stdio: ["ignore", "pipe", "pipe"], shell: false});
    hangChild.stdout.on("data", () => {});
    hangChild.stderr.on("data", () => {});
    const hangPidFile = ownerPidPath(hangRepo);
    let claimed = null;
    const pollDeadline = Date.now() + 60000;
    while(Date.now() < pollDeadline){
      try{
        const raw = fs.readFileSync(hangPidFile, "utf8");
        if(JSON.parse(raw).pid === hangChild.pid){ claimed = raw; break; }
      }catch{ /* not yet written */ }
      if(hangChild.exitCode !== null) break;
      await new Promise(r => setTimeout(r, 250));
    }
    check("live run writes owner.pid with own pid", claimed !== null, claimed ?? hangChild.exitCode);
    if(claimed !== null){
      const before = fs.readFileSync(hangPidFile, "utf8");
      const second = spawnSync(process.execPath,
        [liveAutopilot, "run", liveRequest, "--repo", hangRepo],
        {cwd: hangRepo, encoding: "utf8", env: hangEnv, timeout: 60000, shell: false});
      const secondOut = `${second.stdout || ""}${second.stderr || ""}`;
      check("second run refuses while live",
        second.status !== 0 && secondOut.includes(`mission is live, pid ${hangChild.pid}`),
        {status: second.status, tail: secondOut.slice(-500)});
      let after = null;
      try{ after = fs.readFileSync(hangPidFile, "utf8"); }catch{ after = null; }
      check("refusal leaves first run's PID file unchanged", after === before, {before, after});
      hangChild.kill("SIGTERM");
      // A SIGTERM death reports exit code null + signalCode "SIGTERM", so
      // resolve with both; dead-by-signal is the expected outcome here.
      const hangExit = await new Promise((resolve) => {
        const done = () => resolve({code: hangChild.exitCode, signal: hangChild.signalCode});
        if(hangChild.exitCode !== null || hangChild.signalCode !== null) return done();
        const timer = setTimeout(() => resolve(null), 30000);
        hangChild.once("exit", () => { clearTimeout(timer); done(); });
      });
      // Reap stdio so no dangling pipe keeps the event loop alive.
      try{ hangChild.stdout.destroy(); }catch{}
      try{ hangChild.stderr.destroy(); }catch{}
      check("owner.pid removed on SIGTERM-during-relay",
        hangExit !== null && !fs.existsSync(hangPidFile), {exit: hangExit});
      hangChild = null;
    }
    // Normal-exit fixture: default "success" scenario, sync run.
    const okRepo = makeFixtureRepo("owner-pid-exit-"); trackLive(okRepo);
    const okBin = makeFixtureBin("owner-pid-exit-"); trackLive(okBin);
    writeConfig(okRepo, {planningFramework: "standalone"});
    setScenario(okRepo, "success");
    writeLiveMission(okRepo, "## Phase 1: General\n\n- [ ] Do the fixture task\n");
    writeLiveState(okRepo);
    const okEnv = liveEnvFor(okBin);
    const done = spawnSync(process.execPath,
      [liveAutopilot, "run", liveRequest, "--repo", okRepo],
      {cwd: okRepo, encoding: "utf8", env: okEnv, timeout: 180000, shell: false});
    check("success run exits 0", done.status === 0,
      {status: done.status, tail: `${done.stdout || ""}${done.stderr || ""}`.slice(-500)});
    check("owner.pid removed on normal exit", !fs.existsSync(ownerPidPath(okRepo)));
  } finally {
    try{ if(hangChild && hangChild.exitCode === null) hangChild.kill("SIGKILL"); }catch{}
    for(const dir of liveFixtures){ try{ fs.rmSync(dir, {recursive: true, force: true}); }catch{ /* best-effort */ } }
  }
}

// ---- 13. stopLivePid(): owner PID file first, scans as fallback ---------
if(process.platform === "win32"){
  console.log("SKIP stopLivePid PID-file-first integration on win32");
} else {
  const stopHere = path.dirname(fileURLToPath(import.meta.url));
  const stopAutopilot = path.join(stopHere, "autopilot.mjs");
  const stopRequest = "fixture request";
  const stopMission = "002-owner-pid-stop";
  const stopFixtures = [];
  const stopTrack = (dir) => { stopFixtures.push(dir); };
  const stopWriteMission = (repo) => {
    const planFile = standalone.planPath(repo, stopMission);
    const tasksFile = standalone.tasksPath(repo, stopMission);
    fs.mkdirSync(path.dirname(planFile), {recursive: true});
    fs.writeFileSync(planFile, "# Plan\n\nObjective: fixture task.\n");
    fs.writeFileSync(tasksFile, "## Phase 1: General\n\n- [ ] Do the fixture task\n");
  };
  const stopWriteState = (repo) => {
    fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
    fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(
      {version: 1, phase: "tasks_ready", step: "tasks_ready", phaseIndex: 0, attempt: 1, mission: stopMission, planningRequest: stopRequest}, null, 2));
  };
  const stopEnv = withoutOuterGitGuard(process.env);
  let stopChild = null;
  try {
    // a+b. Live hang run: dry-run names the PID-file pid, stop kills it.
    const stopRepo = makeFixtureRepo("owner-pid-stop-"); stopTrack(stopRepo);
    const stopBin = makeFixtureBin("owner-pid-stop-"); stopTrack(stopBin);
    writeConfig(stopRepo, {planningFramework: "standalone"});
    setScenario(stopRepo, "standalone_reviewer_hang");
    stopWriteMission(stopRepo);
    stopWriteState(stopRepo);
    const stopRunEnv = {...stopEnv, PATH: `${stopBin}:${stopEnv.PATH || ""}`};
    stopChild = spawn(process.execPath,
      [stopAutopilot, "run", stopRequest, "--repo", stopRepo],
      {cwd: stopRepo, env: stopRunEnv, stdio: ["ignore", "pipe", "pipe"], shell: false});
    stopChild.stdout.on("data", () => {});
    stopChild.stderr.on("data", () => {});
    const stopPidFile = ownerPidPath(stopRepo);
    let recordedPid = null;
    const stopDeadline = Date.now() + 60000;
    while(Date.now() < stopDeadline){
      try{
        const raw = fs.readFileSync(stopPidFile, "utf8");
        if(JSON.parse(raw).pid === stopChild.pid){ recordedPid = stopChild.pid; break; }
      }catch{ /* not yet written */ }
      if(stopChild.exitCode !== null) break;
      await new Promise(r => setTimeout(r, 250));
    }
    check("stop dry-run precondition: live run claimed owner.pid", recordedPid !== null, recordedPid ?? stopChild.exitCode);
    if(recordedPid !== null){
      const dry = spawnSync(process.execPath,
        [stopAutopilot, "stop", "--dry-run", "--repo", stopRepo],
        {cwd: stopRepo, encoding: "utf8", env: stopEnv, timeout: 60000, shell: false});
      const dryOut = `${dry.stdout || ""}${dry.stderr || ""}`;
      check("live PID file takes precedence over /proc (dry-run names PID-file pid)",
        dry.status === 0 && dryOut.includes(`live run:     pid ${recordedPid}`),
        {status: dry.status, tail: dryOut.slice(-500)});
      check("dry-run leaves PID file in place", fs.existsSync(stopPidFile));
      const kill = spawnSync(process.execPath,
        [stopAutopilot, "stop", "--yes", "--repo", stopRepo],
        {cwd: stopRepo, encoding: "utf8", env: stopEnv, timeout: 60000, shell: false});
      check("stop --yes via PID file exits 0", kill.status === 0,
        {status: kill.status, tail: `${kill.stdout || ""}${kill.stderr || ""}`.slice(-500)});
      const stopExit = await new Promise((resolve) => {
        if(stopChild.exitCode !== null || stopChild.signalCode !== null)
          return resolve({code: stopChild.exitCode, signal: stopChild.signalCode});
        const timer = setTimeout(() => resolve(null), 30000);
        stopChild.once("exit", () => { clearTimeout(timer); resolve({code: stopChild.exitCode, signal: stopChild.signalCode}); });
      });
      try{ stopChild.stdout.destroy(); }catch{}
      try{ stopChild.stderr.destroy(); }catch{}
      check("stop via PID file killed the run", stopExit !== null, stopExit);
      check("PID file gone after stop kill", !fs.existsSync(stopPidFile));
      stopChild = null;
    }
    // c. Stale PID file: cleaned up, fallback reports nothing running.
    {
      const staleRepo = makeFixtureRepo("owner-pid-stop-stale-"); stopTrack(staleRepo);
      writeConfig(staleRepo, {planningFramework: "standalone"});
      const deadProc = spawnSync(process.execPath, ["-e", "process.exit(0)"],
        {encoding: "utf8", timeout: 60000, shell: false});
      const deadPid = deadProc.pid;
      check("stale precondition: helper pid is dead", !ownerPidAlive(deadPid), deadPid);
      writeOwnerPid(deadPid, staleRepo);
      const dry = spawnSync(process.execPath,
        [stopAutopilot, "stop", "--dry-run", "--repo", staleRepo],
        {cwd: staleRepo, encoding: "utf8", env: stopEnv, timeout: 60000, shell: false});
      const dryOut = `${dry.stdout || ""}${dry.stderr || ""}`;
      check("stale PID file falls back to no live run",
        dry.status === 0 && dryOut.includes("No mission is running."),
        {status: dry.status, tail: dryOut.slice(-500)});
      check("stale PID file cleaned up", !fs.existsSync(ownerPidPath(staleRepo)));
    }
    // d. Cross-platform mismatch: untouched, falls through to no live run.
    {
      const xRepo = makeFixtureRepo("owner-pid-stop-xplat-"); stopTrack(xRepo);
      writeConfig(xRepo, {planningFramework: "standalone"});
      const foreign = process.platform === "win32" ? "linux" : "win32";
      writeOwnerPid(process.pid, xRepo, {platform: foreign});
      const before = fs.readFileSync(ownerPidPath(xRepo), "utf8");
      const dry = spawnSync(process.execPath,
        [stopAutopilot, "stop", "--dry-run", "--repo", xRepo],
        {cwd: xRepo, encoding: "utf8", env: stopEnv, timeout: 60000, shell: false});
      const dryOut = `${dry.stdout || ""}${dry.stderr || ""}`;
      let after = null;
      try{ after = fs.readFileSync(ownerPidPath(xRepo), "utf8"); }catch{ after = null; }
      check("cross-platform PID file falls through to no live run",
        dry.status === 0 && dryOut.includes("No mission is running."),
        {status: dry.status, tail: dryOut.slice(-500)});
      check("cross-platform PID file NOT deleted", after === before, {before, after});
    }
  } finally {
    try{ if(stopChild && stopChild.exitCode === null) stopChild.kill("SIGKILL"); }catch{}
    for(const dir of stopFixtures){ try{ fs.rmSync(dir, {recursive: true, force: true}); }catch{ /* best-effort */ } }
  }
}

// ---- 14. reset queues while owner PID live, applies when stale/gone -----
// No production change: resetFailureCommand/resetContinuationCommand already
// call stopLivePid(), which checks the PID file first (task 1.3). The decoy
// below is named autopilot.mjs but launched with `full` — the /proc scan in
// missionControlLiveRun matches only run|resume|implement, so this process is
// invisible to the scans: queuing (instead of a direct apply) proves the live
// verdict came from the verified owner PID file.
if(process.platform === "win32"){
  console.log("SKIP reset PID-file integration on win32");
} else {
  const rHere = path.dirname(fileURLToPath(import.meta.url));
  const rAutopilot = path.join(rHere, "autopilot.mjs");
  const rEnv = withoutOuterGitGuard(process.env);
  const rFixtures = [];
  const rTrack = (dir) => { rFixtures.push(dir); return dir; };
  const FAIL_KEY = "adapterRetryBudget:adapter:opencode:verifier";
  const FAIL_SCOPE = "adapter:opencode:verifier";
  const CONT_SCOPE = "task:standalone:phase-1:MYTASK";
  const CONT_KEY = `continuationAllowance:${CONT_SCOPE}`;
  const writeRState = (repo, s) => {
    fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
    fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(s, null, 2));
  };
  const readRState = (repo) => JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
  const failState = () => ({
    version: 1, phase: "escalated", step: "adapterRetryBudget_exhausted",
    mission: "999-test-mission", planningRequest: "fixture request",
    lastFailure: {schema: "autopilot-failure.v1", class: "STRUCTURED_OUTPUT_MISSING", domain: "adapter",
      retryable: false, evidence: [], sourceRole: "verifier", adapter: "opencode"},
    lastFailureBudget: {allowed: false, budget: "adapterRetryBudget", used: 1, limit: 2, scope: FAIL_SCOPE},
    failureBudgets: {[FAIL_KEY]: 1},
  });
  const contState = () => ({
    version: 1, phase: "escalated", step: "standalone_task_not_converging",
    mission: "999-test-mission", planningRequest: "fixture request",
    continuationBudgets: {[CONT_KEY]: 6},
    rolloverDeadEnds: {[CONT_KEY]: [{generation: 1, reason: "turns", used: 40, limit: 40, tail: "dead end 1"}]},
    lastContinuation: {key: CONT_KEY, scope: CONT_SCOPE, taskId: "MYTASK",
      mission: "999-test-mission", taskRef: "T9", at: "2026-01-01T00:00:00.000Z"},
  });
  const spawnFullDecoy = (repo) => {
    const fake = path.join(repo, "autopilot.mjs");
    fs.writeFileSync(fake, "setTimeout(()=>{}, 120000);\n");
    return spawn(process.execPath, [fake, "full"], {cwd: repo, stdio: "ignore"});
  };
  const waitLive = async (repo) => {
    const deadline = Date.now() + 15000;
    while(Date.now() < deadline){
      try{ if(verifyOwnerPid(readOwnerPid(repo), repo) === true) return true; }catch{ /* not yet */ }
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  };
  const runReset = (repo, scope) => spawnSync(process.execPath,
    [rAutopilot, "reset", "--scope", scope, "--repo", repo],
    {cwd: repo, encoding: "utf8", env: rEnv, timeout: 60000, shell: false});
  const reap = (child) => new Promise((resolve) => {
    if(!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(resolve, 15000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  try {
    // a. Failure budget: queue while live, apply directly after death.
    {
      const repo = rTrack(makeFixtureRepo("owner-pid-reset-fail-"));
      writeConfig(repo, {planningFramework: "standalone"});
      writeRState(repo, failState());
      let child = spawnFullDecoy(repo);
      try {
        writeOwnerPid(child.pid, repo);
        check("reset/failure precondition: PID file verifies live (`full` invisible to /proc scan)",
          await waitLive(repo));
        const before = JSON.stringify(readRState(repo));
        const q = runReset(repo, FAIL_KEY);
        const qOut = `${q.stdout || ""}${q.stderr || ""}`;
        let queued = [];
        try{ queued = readResetRequests(path.join(repo, ".autopilot", "reset-request.json")); }catch{ queued = []; }
        check("reset --scope failure queues while PID file live (exit 0 + REQUESTED)",
          q.status === 0 && qOut.includes("REQUESTED"), {status: q.status, tail: qOut.slice(-400)});
        check("queued failure request carries budget KEY + scope",
          queued.length === 1 && queued[0]?.key === FAIL_KEY && queued[0]?.scope === FAIL_SCOPE, queued);
        check("live failure queue leaves state.json untouched",
          JSON.stringify(readRState(repo)) === before);
        try{ child.kill("SIGKILL"); }catch{}
        await reap(child);
        child = null;
        const a = runReset(repo, FAIL_KEY);
        const aOut = `${a.stdout || ""}${a.stderr || ""}`;
        const after = readRState(repo);
        check("reset --scope failure applies directly after PID file gone",
          a.status === 0 && !(FAIL_KEY in (after.failureBudgets || {})) && aOut.includes(`Reset '${FAIL_KEY}'`),
          {status: a.status, tail: aOut.slice(-400), budgets: after.failureBudgets});
        check("direct failure apply consumes the queued request",
          !fs.existsSync(path.join(repo, ".autopilot", "reset-request.json")));
        check("stale PID file cleaned up by the direct apply",
          !fs.existsSync(ownerPidPath(repo)));
      } finally {
        try{ if(child && child.exitCode === null) child.kill("SIGKILL"); }catch{}
      }
    }
    // b. Continuation: queue while live, apply directly after death.
    {
      const repo = rTrack(makeFixtureRepo("owner-pid-reset-cont-"));
      writeConfig(repo, {planningFramework: "standalone"});
      writeRState(repo, contState());
      let child = spawnFullDecoy(repo);
      try {
        writeOwnerPid(child.pid, repo);
        check("reset/continuation precondition: PID file verifies live",
          await waitLive(repo));
        const before = readRState(repo);
        const q = runReset(repo, CONT_SCOPE);
        const qOut = `${q.stdout || ""}${q.stderr || ""}`;
        let queued = [];
        try{ queued = readResetRequests(path.join(repo, ".autopilot", "reset-request.json")); }catch{ queued = []; }
        check("reset --scope continuation queues while PID file live (exit 0 + REQUESTED)",
          q.status === 0 && qOut.includes("REQUESTED"), {status: q.status, tail: qOut.slice(-400)});
        check("queued continuation request carries full KEY + scope",
          queued.length === 1 && queued[0]?.key === CONT_KEY && queued[0]?.scope === CONT_SCOPE, queued);
        const mid = readRState(repo);
        check("live continuation queue leaves allowance + dead-ends untouched",
          mid.continuationBudgets?.[CONT_KEY] === before.continuationBudgets[CONT_KEY]
          && (mid.rolloverDeadEnds?.[CONT_KEY] || []).length === 1);
        try{ child.kill("SIGKILL"); }catch{}
        await reap(child);
        child = null;
        const a = runReset(repo, CONT_SCOPE);
        const aOut = `${a.stdout || ""}${a.stderr || ""}`;
        const after = readRState(repo);
        check("reset --scope continuation applies directly after PID file gone",
          a.status === 0 && !(after.continuationBudgets || {})[CONT_KEY]
          && !(after.rolloverDeadEnds || {})[CONT_KEY]
          && aOut.includes(`Reset '${CONT_KEY}'`),
          {status: a.status, tail: aOut.slice(-400)});
        check("direct continuation apply consumes the queued request",
          !fs.existsSync(path.join(repo, ".autopilot", "reset-request.json")));
      } finally {
        try{ if(child && child.exitCode === null) child.kill("SIGKILL"); }catch{}
      }
    }
    // c. Stale PID file never blocks a reset: dead pid applies directly.
    {
      const repo = rTrack(makeFixtureRepo("owner-pid-reset-stale-"));
      writeConfig(repo, {planningFramework: "standalone"});
      writeRState(repo, failState());
      const helper = spawnSync(process.execPath, ["-e", "process.exit(0)"],
        {encoding: "utf8", timeout: 60000, shell: false});
      const deadPid = helper.pid;
      check("reset/stale precondition: helper pid is dead", !ownerPidAlive(deadPid), deadPid);
      writeOwnerPid(deadPid, repo);
      const r = runReset(repo, FAIL_KEY);
      const rOut = `${r.stdout || ""}${r.stderr || ""}`;
      const after = readRState(repo);
      check("stale PID file does not block reset (applies directly)",
        r.status === 0 && !(FAIL_KEY in (after.failureBudgets || {})) && rOut.includes(`Reset '${FAIL_KEY}'`),
        {status: r.status, tail: rOut.slice(-400), budgets: after.failureBudgets});
      check("stale PID file cleaned up by reset",
        !fs.existsSync(ownerPidPath(repo)));
      check("no reset request left behind",
        !fs.existsSync(path.join(repo, ".autopilot", "reset-request.json")));
    }
  } finally {
    for(const dir of rFixtures){ try{ fs.rmSync(dir, {recursive: true, force: true}); }catch{ /* best-effort */ } }
  }
}

console.log(`\n${ok} passed, ${failed} failed`);
if(failed) process.exit(1);
