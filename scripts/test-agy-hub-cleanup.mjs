import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import cp from "node:child_process";
import { listAgyHubs, runHubsToStop, stopRunHubs } from "./agy-hub-cleanup.mjs";
import { spawnRelayChild } from "./subprocess-relay.mjs";

let failures = 0;
function check(desc, ok) {
  if (ok) {
    console.log(`PASS ${desc}`);
  } else {
    failures++;
    console.error(`FAIL ${desc}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Part (a): Unit tests on a fake /proc tree
// ─────────────────────────────────────────────────────────────────────────────
console.log("─── Part (a): Unit tests on fake /proc tree ───");

const fakeProcRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ap-fake-proc-"));

function writeFakeProc(pid, { cmdlineArgs, ppid = 1, pgid = pid, startTicks = 1000 }) {
  const pDir = path.join(fakeProcRoot, String(pid));
  fs.mkdirSync(pDir, { recursive: true });
  fs.writeFileSync(path.join(pDir, "cmdline"), cmdlineArgs.join("\0") + "\0");

  const statFields = [
    pid,
    `(${path.basename(cmdlineArgs[0] || "proc")})`,
    "S",
    ppid,
    pgid,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    startTicks,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
  ];
  fs.writeFileSync(path.join(pDir, "stat"), statFields.join(" ") + "\n");
}

try {
  // 1. Initial process tree
  // Pre-existing hub: pid 100
  writeFakeProc(100, {
    cmdlineArgs: ["/usr/local/bin/agy", "--hub", "--hub-port=8000"],
    ppid: 1,
    pgid: 100,
    startTicks: 1000
  });

  // Non-hub process: pid 101
  writeFakeProc(101, {
    cmdlineArgs: ["node", "/path/to/server.js"],
    ppid: 1,
    pgid: 101,
    startTicks: 1010
  });

  // agy but not --hub: pid 102
  writeFakeProc(102, {
    cmdlineArgs: ["agy", "version"],
    ppid: 1,
    pgid: 102,
    startTicks: 1020
  });

  const before = listAgyHubs({ procRoot: fakeProcRoot });
  check("listAgyHubs finds pre-existing hub", before.length === 1 && before[0].pid === 100);

  // 2. Add new processes representing a relay run
  const relayPid = 200;
  writeFakeProc(relayPid, {
    cmdlineArgs: ["agy", "prompt", "hello"],
    ppid: 1,
    pgid: relayPid,
    startTicks: 2000
  });

  // (1) New hub child of relay (ppid === relayPid): pid 201
  writeFakeProc(201, {
    cmdlineArgs: ["/opt/bin/agy", "--hub", "--hub-port=9001"],
    ppid: relayPid,
    pgid: 201,
    startTicks: 2010
  });

  // Non-agy subreaper (systemd --user, etc.): pid 300
  writeFakeProc(300, {
    cmdlineArgs: ["/usr/lib/systemd/systemd", "--user"],
    ppid: 1,
    pgid: 300,
    startTicks: 300
  });

  // (2) Orphaned hub with matching --add-dir (parent is a non-agy subreaper): pid 202
  writeFakeProc(202, {
    cmdlineArgs: ["agy", "--hub", "--hub-port=9002", "--add-dir=/workspace/repo"],
    ppid: 300,
    pgid: 202,
    startTicks: 2020
  });

  // (3) Orphaned hub with other --add-dir: pid 203
  writeFakeProc(203, {
    cmdlineArgs: ["agy", "--hub", "--hub-port=9003", "--add-dir=/other/project"],
    ppid: 300,
    pgid: 203,
    startTicks: 2030
  });

  // Another live agy CLI process (pid !== relayPid): pid 400
  writeFakeProc(400, {
    cmdlineArgs: ["agy", "chat"],
    ppid: 1,
    pgid: 400,
    startTicks: 4000
  });

  // Hub child of another live agy CLI with matching --add-dir: pid 204
  writeFakeProc(204, {
    cmdlineArgs: ["agy", "--hub", "--hub-port=9005", "--add-dir=/workspace/repo"],
    ppid: 400,
    pgid: 204,
    startTicks: 2040
  });

  // (4) Hub under antigravity-ide-server: pid 500 (IDE server), pid 501 (hub child)
  writeFakeProc(500, {
    cmdlineArgs: ["node", "/opt/antigravity-ide-server/dist/server.js"],
    ppid: 1,
    pgid: 500,
    startTicks: 500
  });
  writeFakeProc(501, {
    cmdlineArgs: ["agy", "--hub", "--hub-port=9004", "--add-dir=/workspace/repo"],
    ppid: 500,
    pgid: 501,
    startTicks: 5010
  });

  // (5) Hub grandchild of antigravity-ide-server: pid 502 (intermediate), pid 503 (hub)
  writeFakeProc(502, {
    cmdlineArgs: ["bash", "/opt/ide/launcher.sh"],
    ppid: 500,
    pgid: 500,
    startTicks: 5020
  });
  writeFakeProc(503, {
    cmdlineArgs: ["agy", "--hub", "--add-dir=/workspace/repo"],
    ppid: 502,
    pgid: 503,
    startTicks: 5030
  });

  const after = listAgyHubs({ procRoot: fakeProcRoot });
  check("listAgyHubs finds all hub candidates", after.some((h) => h.pid === 201) && after.some((h) => h.pid === 202) && after.some((h) => h.pid === 203) && after.some((h) => h.pid === 204) && after.some((h) => h.pid === 501) && after.some((h) => h.pid === 503));

  const toStop = runHubsToStop({
    before,
    after,
    relayPid,
    addDirs: ["/workspace/repo"],
    procRoot: fakeProcRoot,
  });

  const stoppedPids = new Set(toStop.map((h) => h.pid));

  check("new hub child of relay -> returned", stoppedPids.has(201));
  check("pre-existing hub -> not", !stoppedPids.has(100));
  check("orphan (parent is a non-agy subreaper) + matching --add-dir -> returned", stoppedPids.has(202));
  check("parent is another live agy CLI + matching --add-dir -> not returned", !stoppedPids.has(204));
  check("other add-dir -> not returned", !stoppedPids.has(203));
  check("hub under antigravity-ide-server -> never", !stoppedPids.has(501));
  check("hub in ancestor chain of antigravity-ide-server -> never", !stoppedPids.has(503));

  // Test stopRunHubs with mock killFn
  const calls = [];
  const mockKillFn = (target, sig) => {
    calls.push({ target, sig });
  };
  const testHubs = [
    { pid: 601, pgid: 601 }, // group leader: pgid === pid -> -601
    { pid: 602, pgid: 500 }, // non-leader: pgid !== pid -> 602
  ];

  const resultPids = stopRunHubs(testHubs, {
    killFn: mockKillFn,
    waitMs: 10,
    isAliveFn: () => false, // simulate died after SIGTERM
  });

  check("stopRunHubs targets -pid when pgid === pid", calls.some((c) => c.target === -601 && c.sig === "SIGTERM"));
  check("stopRunHubs targets pid when pgid !== pid", calls.some((c) => c.target === 602 && c.sig === "SIGTERM"));
  check("stopRunHubs returns stopped pids", resultPids.includes(601) && resultPids.includes(602));

  // Test stopRunHubs SIGKILL escalation for survivors
  const calls2 = [];
  stopRunHubs([{ pid: 701, pgid: 701 }], {
    killFn: (target, sig) => calls2.push({ target, sig }),
    waitMs: 30,
    pollIntervalMs: 10,
    isAliveFn: () => true, // survivor: stays alive past SIGTERM wait
  });
  check("stopRunHubs sends SIGKILL to survivor", calls2.some((c) => c.target === -701 && c.sig === "SIGKILL"));

  // Test stopRunHubs never throws on throwing killFn
  const safePids = stopRunHubs([{ pid: 801, pgid: 801 }], {
    killFn: () => { throw new Error("EPERM mock"); },
    waitMs: 10,
    isAliveFn: () => false,
  });
  check("stopRunHubs never throws", Array.isArray(safePids));

} finally {
  try { fs.rmSync(fakeProcRoot, { recursive: true, force: true }); } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Part (b): Real process test (Linux only, skip elsewhere)
// ─────────────────────────────────────────────────────────────────────────────
console.log("─── Part (b): Real process test ───");

if (process.platform !== "linux") {
  console.log("Skipping Part (b) — Linux only");
} else {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-agy-real-"));
  try {
    const agyBin = path.join(tmpDir, "agy");
    fs.symlinkSync(process.execPath, agyBin);

    const hubPidFile = path.join(tmpDir, "hub.pid");
    const scriptPath = path.join(tmpDir, "test-runner.js");

    // The script handles both:
    // 1) The relay child (when no --hub in argv): spawns detached hub child and exits
    // 2) The hub child (when --hub in argv): writes pid to file and keeps running
    fs.writeFileSync(scriptPath, `
import fs from "node:fs";
import cp from "node:child_process";

const args = process.argv.slice(2);
const isHub = args.includes("--hub");

if (isHub) {
  fs.writeFileSync(${JSON.stringify(hubPidFile)}, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  const agy = ${JSON.stringify(agyBin)};
  const script = ${JSON.stringify(scriptPath)};
  const hubChild = cp.spawn(agy, [script, "--hub", "--hub-port=1", "--add-dir=" + ${JSON.stringify(tmpDir)}], {
    detached: true,
    stdio: "ignore",
  });
  hubChild.unref();

  const deadline = Date.now() + 5000;
  while (!fs.existsSync(${JSON.stringify(hubPidFile)}) && Date.now() < deadline) {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    } catch {}
  }
  process.exit(0);
}
`);

    const before = listAgyHubs();

    const relayResult = await spawnRelayChild({
      binary: agyBin,
      args: [scriptPath],
      cwd: tmpDir,
      env: process.env,
      timeoutMs: 8000,
    });

    check("spawnRelayChild finished successfully", relayResult.status === 0);

    check("hub pid file was written", fs.existsSync(hubPidFile));
    const hubPid = parseInt(fs.readFileSync(hubPidFile, "utf8").trim(), 10);
    check("hub pid is a valid integer", Number.isInteger(hubPid) && hubPid > 0);

    // Verify hub is alive right after relay exit
    let hubAlive = false;
    try {
      process.kill(hubPid, 0);
      hubAlive = true;
    } catch {
      hubAlive = false;
    }
    check("hub process is alive after relay exits", hubAlive);

    // Run cleanup
    const after = listAgyHubs();
    const hubsToStop = runHubsToStop({
      before,
      after,
      relayPid: relayResult.pid,
      addDirs: [tmpDir],
    });

    check("runHubsToStop identified the orphaned hub", hubsToStop.some((h) => h.pid === hubPid));

    const stopped = stopRunHubs(hubsToStop);
    check("stopRunHubs returned stopped hub pid", stopped.includes(hubPid));

    // Poll to confirm process is gone (ESRCH or reaped / zombie state in container)
    let hubGone = false;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        process.kill(hubPid, 0);
        // If reparented to init in a container where PID 1 does not waitpid, check if process died (state Z)
        try {
          const stat = fs.readFileSync(`/proc/${hubPid}/stat`, "utf8");
          const state = stat.split(" ")[2];
          if (state === "Z") {
            hubGone = true;
            break;
          }
        } catch {
          hubGone = true;
          break;
        }
      } catch (e) {
        if (e?.code === "ESRCH") {
          hubGone = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    check("hub pid is gone (process.kill threw ESRCH)", hubGone);

  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

if (failures > 0) {
  console.error(`test-agy-hub-cleanup: ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("test-agy-hub-cleanup: ALL CHECKS PASSED");
}
