#!/usr/bin/env node
import {spawn as nodeSpawn} from "node:child_process";
import {EventEmitter} from "node:events";
import {
  PLATFORM_KINDS,
  BUBBLEWRAP_STATUS,
  detectPlatformKind,
  detectBubblewrapCapability,
  reviewerModeSummary,
  detectPlatformCapabilities,
  formatExecutionEnvironmentBlock
} from "./platform-capabilities.mjs";

let failures = 0;
function check(name, condition) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL: ${name}`);
  } else {
    console.log(`ok: ${name}`);
  }
}
async function checkAsync(name, promise) {
  check(name, await promise);
}

const REAL_WSL2_MODERN_OSRELEASE = "5.15.90.1-microsoft-standard-WSL2";
const REAL_WSL2_MODERN_VERSION_STRING = "Linux version 5.15.90.1-microsoft-standard-WSL2 (root@f1bbfb02316b) (gcc (GCC) 13.2.0, GNU ld (GNU Binutils) 2.41) #1 SMP";
const OLDER_WSL2_OSRELEASES = [
  "4.19.84-microsoft-standard",
  "4.19.104-microsoft-standard",
  "4.19.128-microsoft-standard",
  "5.4.51-microsoft-standard"
];
const REAL_WSL1_OSRELEASE = "4.4.0-19041-Microsoft";
const REAL_WSL1_VERSION_STRING = "Linux version 4.4.0-19041-Microsoft (Microsoft@Microsoft.com) (gcc version 5.4.0 (GCC) ) #488-Microsoft Wed Sep 23 15:11:00 PST 2020";

// A minimal, EventEmitter-based fake child_process.ChildProcess for unit
// tests that don't need a real OS process — keeps most of the branching
// coverage fast and deterministic, while the SIGTERM-resistance test below
// uses a genuinely real spawned process.
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = [];
  child.kill = signal => { child.killCalls.push(signal); };
  return child;
}

// ---------------------------------------------------------------------
// Defect 1: platform classification, including older WSL2 kernels
// ---------------------------------------------------------------------

// 1. Native Windows classification.
check(
  "classifies win32 as native-windows regardless of kernel evidence",
  detectPlatformKind({platform: "win32", readOsRelease: () => {
    throw new Error("must not be read on win32");
  }, readProcVersion: () => {
    throw new Error("must not be read on win32");
  }}) === PLATFORM_KINDS.nativeWindows
);

// 2. Modern WSL2 classification (explicit WSL2 marker), via osrelease and
// via the /proc/version fallback.
check(
  "classifies a modern WSL2 osrelease string as wsl2",
  detectPlatformKind({platform: "linux", readOsRelease: () => REAL_WSL2_MODERN_OSRELEASE}) === PLATFORM_KINDS.wsl2
);
check(
  "falls back to /proc/version and still classifies modern WSL2 correctly",
  detectPlatformKind({
    platform: "linux",
    readOsRelease: () => { throw new Error("osrelease unavailable"); },
    readProcVersion: () => REAL_WSL2_MODERN_VERSION_STRING
  }) === PLATFORM_KINDS.wsl2
);

// Older WSL2 kernels (no literal "WSL2" marker, just "*-microsoft-standard")
// must still classify as wsl2, not wsl1.
for (const osrelease of OLDER_WSL2_OSRELEASES) {
  check(
    `classifies older WSL2 kernel "${osrelease}" as wsl2, not wsl1`,
    detectPlatformKind({platform: "linux", readOsRelease: () => osrelease}) === PLATFORM_KINDS.wsl2
  );
}
check(
  "an older-style microsoft-standard release embedded in /proc/version is also wsl2",
  detectPlatformKind({
    platform: "linux",
    readOsRelease: () => { throw new Error("osrelease unavailable"); },
    readProcVersion: () => "Linux version 4.19.84-microsoft-standard (oe-user@oe-host) (gcc version 5.4.0)"
  }) === PLATFORM_KINDS.wsl2
);

// WSL1 classification — a bare Microsoft/WSL marker without WSL2 evidence
// (no "microsoft-standard", no explicit "WSL2") must never be reported as
// WSL2.
check(
  "classifies the real WSL1 osrelease string as wsl1, not wsl2",
  detectPlatformKind({platform: "linux", readOsRelease: () => REAL_WSL1_OSRELEASE}) === PLATFORM_KINDS.wsl1
);
check(
  "classifies the real WSL1 /proc/version string as wsl1 via fallback",
  detectPlatformKind({
    platform: "linux",
    readOsRelease: () => { throw new Error("osrelease unavailable"); },
    readProcVersion: () => REAL_WSL1_VERSION_STRING
  }) === PLATFORM_KINDS.wsl1
);
check(
  "a generic 'wsl' marker without microsoft-standard/WSL2 evidence is wsl1, not wsl2",
  detectPlatformKind({platform: "linux", readOsRelease: () => "4.4.0-19041-WSL (generic)"}) === PLATFORM_KINDS.wsl1
);
check(
  "a bare 'Microsoft' marker without microsoft-standard/WSL2 evidence is wsl1, not wsl2",
  detectPlatformKind({platform: "linux", readOsRelease: () => "4.4.0-19041-Microsoft"}) === PLATFORM_KINDS.wsl1
);

// 3. Native Linux classification.
check(
  "classifies linux without microsoft/wsl markers as native-linux",
  detectPlatformKind({platform: "linux", readOsRelease: () => "6.8.0-generic"}) === PLATFORM_KINDS.nativeLinux
);
check(
  "falls back to native-linux (never wsl2) when neither osrelease nor /proc/version is readable",
  detectPlatformKind({
    platform: "linux",
    readOsRelease: () => { throw new Error("ENOENT"); },
    readProcVersion: () => { throw new Error("ENOENT"); }
  }) === PLATFORM_KINDS.nativeLinux
);
check(
  "does not classify an unrecognized platform as windows/wsl/linux",
  detectPlatformKind({platform: "darwin"}) === PLATFORM_KINDS.other
);

// ---------------------------------------------------------------------
// Bubblewrap capability: platform gating (no probe needed)
// ---------------------------------------------------------------------

await checkAsync(
  "bubblewrap is not-applicable for native-windows",
  detectBubblewrapCapability({platformKind: PLATFORM_KINDS.nativeWindows}).then(r => r.status === BUBBLEWRAP_STATUS.notApplicable && r.available === false)
);

{
  let spawnCalled = false;
  const result = await detectBubblewrapCapability({
    platformKind: PLATFORM_KINDS.wsl1,
    spawn: () => { spawnCalled = true; return fakeChild(); }
  });
  check("wsl1 bubblewrap status is unsupported-platform", result.status === BUBBLEWRAP_STATUS.unsupportedPlatform);
  check("wsl1 bubblewrap is reported as unavailable", result.available === false);
  check("wsl1 never spawns a bubblewrap probe", spawnCalled === false);
}

// ---------------------------------------------------------------------
// Defect 2: async, spawn-based, hard-deadline probing
// ---------------------------------------------------------------------

// 4. Working bubblewrap: version probe AND real sandbox probe both
// succeed before reporting available.
{
  const calls = [];
  const result = await detectBubblewrapCapability({
    platformKind: PLATFORM_KINDS.wsl2,
    spawn: (bin, args) => {
      calls.push(args[0]);
      const child = fakeChild();
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(args[0] === "--version" ? "bubblewrap 0.8.0\n" : ""));
        child.emit("close", 0, null);
      });
      return child;
    }
  });
  check("working bubblewrap reports status=available", result.status === BUBBLEWRAP_STATUS.available);
  check("working bubblewrap reports available=true", result.available === true);
  check("working bubblewrap captures version text", result.version === "bubblewrap 0.8.0");
  check("working bubblewrap runs both the version probe and the sandbox probe", calls.length === 2 && calls[0] === "--version");
}

// A binary that answers --version but cannot actually create the sandbox
// must be reported as broken/unusable, not available.
{
  const result = await detectBubblewrapCapability({
    platformKind: PLATFORM_KINDS.nativeLinux,
    spawn: (bin, args) => {
      const child = fakeChild();
      queueMicrotask(() => {
        if (args[0] === "--version") {
          child.stdout.emit("data", Buffer.from("bubblewrap 0.8.0\n"));
          child.emit("close", 0, null);
        } else {
          child.stderr.emit("data", Buffer.from("bwrap: Creating new namespace failed: Operation not permitted"));
          child.emit("close", 1, null);
        }
      });
      return child;
    }
  });
  check("version-only-success bubblewrap is reported broken, not available", result.status === BUBBLEWRAP_STATUS.broken);
  check("version-only-success bubblewrap is reported unavailable", result.available === false);
}

// 5. Missing bubblewrap detection (ENOENT via the 'error' event).
{
  const result = await detectBubblewrapCapability({
    platformKind: PLATFORM_KINDS.wsl2,
    spawn: () => {
      const child = fakeChild();
      queueMicrotask(() => child.emit("error", {code: "ENOENT", message: "spawn bwrap ENOENT"}));
      return child;
    }
  });
  check("missing bubblewrap reports status=missing", result.status === BUBBLEWRAP_STATUS.missing);
  check("missing bubblewrap reports available=false", result.available === false);
}

// 6. Nonfunctional bubblewrap detection (version probe itself fails).
{
  const result = await detectBubblewrapCapability({
    platformKind: PLATFORM_KINDS.wsl2,
    spawn: () => {
      const child = fakeChild();
      queueMicrotask(() => {
        child.stderr.emit("data", Buffer.from("bwrap: setting up uid map: Permission denied"));
        child.emit("close", 1, null);
      });
      return child;
    }
  });
  check("broken bubblewrap reports status=broken", result.status === BUBBLEWRAP_STATUS.broken);
  check("broken bubblewrap reports available=false", result.available === false);
}

// A process terminated by an unrelated signal (not our timeout escalation)
// must be reported as broken, not timeout.
{
  const result = await detectBubblewrapCapability({
    platformKind: PLATFORM_KINDS.wsl2,
    spawn: () => {
      const child = fakeChild();
      queueMicrotask(() => child.emit("close", null, "SIGSEGV"));
      return child;
    }
  });
  check("signal termination without our timeout escalation is reported as broken, not timeout", result.status === BUBBLEWRAP_STATUS.broken);
}

// A synchronous unexpected spawn exception must not be mislabeled as
// "missing" (that label implies a clean, understood ENOENT case).
{
  let threw = false;
  let result = null;
  try {
    result = await detectBubblewrapCapability({
      platformKind: PLATFORM_KINDS.wsl2,
      spawn: () => { throw new Error("boom"); }
    });
  } catch {
    threw = true;
  }
  check("a spawn that throws synchronously does not propagate", threw === false);
  check("a spawn that throws is reported as error, not missing", result?.status === BUBBLEWRAP_STATUS.error);
  check("a spawn that throws is reported as unavailable", result?.available === false);
}

// Deadline already exhausted before the second probe: it must not be
// spawned at all (shared absolute deadline, checked synchronously).
{
  let clock = 1_000_000;
  const now = () => clock;
  let secondProbeCalls = 0;
  const result = await detectBubblewrapCapability({
    platformKind: PLATFORM_KINDS.wsl2,
    timeoutMs: 500,
    now,
    spawn: (bin, args) => {
      const child = fakeChild();
      if (args[0] === "--version") {
        clock += 500; // consumes the entire shared budget
        queueMicrotask(() => {
          child.stdout.emit("data", Buffer.from("bubblewrap 0.8.0\n"));
          child.emit("close", 0, null);
        });
      } else {
        secondProbeCalls += 1;
        queueMicrotask(() => child.emit("close", 0, null));
      }
      return child;
    }
  });
  check("second probe is not spawned once the shared deadline has elapsed", secondProbeCalls === 0);
  check("exhausting the shared deadline after a successful version probe reports timeout", result.status === BUBBLEWRAP_STATUS.timeout);
}

// No double completion: once the first settling event wins, a later,
// contradictory event must not change the result.
{
  const result = await detectBubblewrapCapability({
    platformKind: PLATFORM_KINDS.wsl2,
    spawn: () => {
      const child = fakeChild();
      queueMicrotask(() => {
        child.emit("error", {code: "ENOENT", message: "spawn bwrap ENOENT"});
        // A contradictory close arriving after the probe already settled
        // must be ignored, not flip the result to "ok".
        child.emit("close", 0, null);
      });
      return child;
    }
  });
  check("a close event after an already-settled error does not override the result", result.status === BUBBLEWRAP_STATUS.missing);
}

// Real SIGTERM-resistant child: a genuine subprocess that traps SIGTERM
// and keeps running. Proves the deadline is actually enforced end to end —
// terminated (escalated to SIGKILL), reported as timeout, resolves within
// a generous bound, exactly once, and leaves no leaked process behind.
{
  const ignoreSigtermScript = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
  let capturedPid = null;
  let spawnCallCount = 0;
  const start = Date.now();
  const result = await detectBubblewrapCapability({
    platformKind: PLATFORM_KINDS.wsl2,
    timeoutMs: 400,
    killGraceMs: 200,
    spawn: (bin, args, opts) => {
      spawnCallCount += 1;
      const child = nodeSpawn(process.execPath, ["-e", ignoreSigtermScript], opts);
      capturedPid = child.pid;
      return child;
    }
  });
  const elapsed = Date.now() - start;

  check("SIGTERM-ignoring probe resolves within a generous bound", elapsed < 8000);
  check("SIGTERM-ignoring probe is reported as timeout, not a crash", result.status === BUBBLEWRAP_STATUS.timeout);
  check("SIGTERM-ignoring probe is not left running as a sandbox-available result", result.available === false);
  // Shared deadline: the version probe alone consumes the whole budget,
  // so the sandbox probe must never be spawned.
  check("only one probe is spawned once the first one exhausts the shared deadline", spawnCallCount === 1);

  // Give the OS a brief moment to finish reaping after SIGKILL, then prove
  // no leaked subprocess remains. process.kill(pid, 0) throws ESRCH (or
  // EPERM never — we own this process) once the process is gone.
  await new Promise(r => setTimeout(r, 300));
  let stillRunning = true;
  try {
    process.kill(capturedPid, 0);
  } catch {
    stillRunning = false;
  }
  check("no subprocess is leaked after the deadline forces termination", stillRunning === false);
}

// ---------------------------------------------------------------------
// Reviewer mode summary rules
// ---------------------------------------------------------------------

// Task 15.4B1: SpecKit's Verifier joined Plan Reviewer and Code Reviewer on
// the disposable-copy compatibility path, so the previous "Verifier alone is
// unavailable" assertion below is now stale and is replaced by the current
// truth. The mode itself deliberately stays "partial" -- non-SpecKit
// workflows are still unsupported on Native Windows -- and every original
// anti-overclaim guard (not OS-enforced, never "complete"/"full" support,
// never a false "unavailable" claim about a role that works) is kept, not
// weakened.
check(
  "native windows reviewer mode is always partial regardless of bubblewrap (SpecKit-and-standalone compatibility path, never full support)",
  reviewerModeSummary({platformKind: PLATFORM_KINDS.nativeWindows, bubblewrap: {available: true}}).mode === "partial"
    && reviewerModeSummary({platformKind: PLATFORM_KINDS.nativeWindows, bubblewrap: {available: false}}).mode === "partial"
);
check(
  "native windows reviewer detail says reviewers work on a temporary copy without full protection",
  reviewerModeSummary({platformKind: PLATFORM_KINDS.nativeWindows, bubblewrap: {available: false}}).detail ===
    "Reviewers will work on a temporary copy of your project (no full protection on Windows without WSL2)"
);
check(
  "native windows with a usable WSL2 reports full protection inside WSL",
  reviewerModeSummary({platformKind: PLATFORM_KINDS.nativeWindows, bubblewrap: {available: false}, wsl2Usable: true}).mode === "available"
    && reviewerModeSummary({platformKind: PLATFORM_KINDS.nativeWindows, bubblewrap: {available: false}, wsl2Usable: true}).detail ===
      "Reviewers can run with full protection inside WSL"
);
check(
  "native windows reviewer detail never falsely claims Code Reviewer or Verifier is unavailable",
  !/Code Reviewer: unavailable|Verifier: unavailable|Code Reviewer and Verifier/.test(
    reviewerModeSummary({platformKind: PLATFORM_KINDS.nativeWindows, bubblewrap: {available: false}}).detail
  )
);
check(
  "native windows reviewer detail makes no browser/Playwright readiness claim",
  !/playwright|browser/i.test(
    reviewerModeSummary({platformKind: PLATFORM_KINDS.nativeWindows, bubblewrap: {available: false}}).detail
  )
);
check(
  "native windows reviewer detail never claims complete Windows workflow support",
  !/complete|full workflow|entire workflow/i.test(
    reviewerModeSummary({platformKind: PLATFORM_KINDS.nativeWindows, bubblewrap: {available: false}}).detail
  )
);
check(
  "wsl1 reviewer mode is always unavailable regardless of bubblewrap",
  reviewerModeSummary({platformKind: PLATFORM_KINDS.wsl1, bubblewrap: {available: true}}).mode === "unavailable"
);
check(
  "wsl1 reviewer detail names WSL1 containment as unsupported",
  reviewerModeSummary({platformKind: PLATFORM_KINDS.wsl1, bubblewrap: {available: false}}).detail ===
    "Reviewers cannot run: WSL1 reviewer containment is unsupported"
);
check(
  "wsl2 with working bubblewrap reports full protection",
  reviewerModeSummary({platformKind: PLATFORM_KINDS.wsl2, bubblewrap: {available: true}}).mode === "available"
    && reviewerModeSummary({platformKind: PLATFORM_KINDS.wsl2, bubblewrap: {available: true}}).detail ===
      "Reviewers can run with full protection here"
);
check(
  "linux without bubblewrap tells the reviewer to install it",
  reviewerModeSummary({platformKind: PLATFORM_KINDS.nativeLinux, bubblewrap: {status: BUBBLEWRAP_STATUS.missing, available: false}}).detail ===
    "Reviewers cannot run: bubblewrap is missing (fix: sudo apt install bubblewrap)"
);
check(
  "linux with unusable bubblewrap tells the reviewer to reinstall it",
  reviewerModeSummary({platformKind: PLATFORM_KINDS.nativeLinux, bubblewrap: {status: BUBBLEWRAP_STATUS.broken, available: false}}).detail ===
    "Reviewers cannot run: bubblewrap is installed but not usable (fix: sudo apt install --reinstall bubblewrap)"
);
check(
  "a timed-out bubblewrap probe reports that reviewers cannot run",
  reviewerModeSummary({platformKind: PLATFORM_KINDS.nativeLinux, bubblewrap: {status: BUBBLEWRAP_STATUS.timeout, available: false}}).detail ===
    "Reviewers cannot run: the bubblewrap check timed out"
);
check(
  "a failed bubblewrap probe reports that reviewers cannot run",
  reviewerModeSummary({platformKind: PLATFORM_KINDS.nativeLinux, bubblewrap: {status: BUBBLEWRAP_STATUS.error, available: false}}).detail ===
    "Reviewers cannot run: the bubblewrap check failed unexpectedly"
);
check(
  "an unsupported platform reports that full protection needs WSL2 or Linux",
  reviewerModeSummary({platformKind: PLATFORM_KINDS.other, bubblewrap: {status: BUBBLEWRAP_STATUS.unsupportedPlatform, available: false}}).detail ===
    "Reviewers cannot run: full protection needs WSL2 or Linux with bubblewrap"
);

// ---------------------------------------------------------------------
// Setup output: exact documented example blocks
// ---------------------------------------------------------------------

{
  const windowsBlock = formatExecutionEnvironmentBlock({
    platformKind: PLATFORM_KINDS.nativeWindows,
    bubblewrap: {status: BUBBLEWRAP_STATUS.notApplicable, available: false, version: null, reason: null},
    reviewer: reviewerModeSummary({platformKind: PLATFORM_KINDS.nativeWindows, bubblewrap: {available: false}})
  });
  check(
    "windows block header lines match the documented example exactly",
    windowsBlock === "\nExecution environment:\n✓ Platform: Native Windows\n· Bubblewrap: not applicable\n· Reviewers will work on a temporary copy of your project (no full protection on Windows without WSL2)"
  );

  const windowsWslBlock = formatExecutionEnvironmentBlock({
    platformKind: PLATFORM_KINDS.nativeWindows,
    bubblewrap: {status: BUBBLEWRAP_STATUS.notApplicable, available: false, version: null, reason: null},
    reviewer: reviewerModeSummary({platformKind: PLATFORM_KINDS.nativeWindows, bubblewrap: {available: false}, wsl2Usable: true})
  });
  check(
    "windows with usable WSL2 block reports full protection inside WSL",
    windowsWslBlock === "\nExecution environment:\n✓ Platform: Native Windows\n· Bubblewrap: not applicable\n✓ Reviewers can run with full protection inside WSL"
  );

  const wsl1Block = formatExecutionEnvironmentBlock({
    platformKind: PLATFORM_KINDS.wsl1,
    bubblewrap: {status: BUBBLEWRAP_STATUS.unsupportedPlatform, available: false, version: null, reason: null},
    reviewer: reviewerModeSummary({platformKind: PLATFORM_KINDS.wsl1, bubblewrap: {available: false}})
  });
  check(
    "wsl1 block matches the documented example exactly",
    wsl1Block === "\nExecution environment:\n✓ Platform: WSL1\n· Bubblewrap: unavailable\n✗ Reviewers cannot run: WSL1 reviewer containment is unsupported"
  );

  const wslAvailableBlock = formatExecutionEnvironmentBlock({
    platformKind: PLATFORM_KINDS.wsl2,
    bubblewrap: {status: BUBBLEWRAP_STATUS.available, available: true, version: "bubblewrap 0.8.0", reason: null},
    reviewer: reviewerModeSummary({platformKind: PLATFORM_KINDS.wsl2, bubblewrap: {available: true}})
  });
  check(
    "wsl2-with-bubblewrap block matches the documented example shape",
    wslAvailableBlock === "\nExecution environment:\n✓ Platform: WSL2\n✓ Bubblewrap: available (bubblewrap 0.8.0)\n✓ Reviewers can run with full protection here"
  );

  const nativeLinuxBrokenBlock = formatExecutionEnvironmentBlock({
    platformKind: PLATFORM_KINDS.nativeLinux,
    bubblewrap: {status: BUBBLEWRAP_STATUS.broken, available: false, version: null, reason: "bubblewrap_version_probe_unusable"},
    reviewer: reviewerModeSummary({platformKind: PLATFORM_KINDS.nativeLinux, bubblewrap: {status: BUBBLEWRAP_STATUS.broken, available: false}})
  });
  check(
    "native-linux-unusable-bubblewrap block matches the documented example exactly",
    nativeLinuxBrokenBlock === "\nExecution environment:\n✓ Platform: Native Linux\n· Bubblewrap: detected but not usable\n✗ Reviewers cannot run: bubblewrap is installed but not usable (fix: sudo apt install --reinstall bubblewrap)"
  );

  const nativeLinuxMissingBlock = formatExecutionEnvironmentBlock({
    platformKind: PLATFORM_KINDS.wsl2,
    bubblewrap: {status: BUBBLEWRAP_STATUS.missing, available: false, version: null, reason: "bubblewrap_not_installed"},
    reviewer: reviewerModeSummary({platformKind: PLATFORM_KINDS.wsl2, bubblewrap: {status: BUBBLEWRAP_STATUS.missing, available: false}})
  });
  check(
    "missing bubblewrap block tells the operator to install it",
    nativeLinuxMissingBlock === "\nExecution environment:\n✓ Platform: WSL2\n· Bubblewrap: not detected\n✗ Reviewers cannot run: bubblewrap is missing (fix: sudo apt install bubblewrap)"
  );

  // PLATFORM_KINDS.other (e.g. macOS) is the one case platformKindLabel()
  // cannot resolve to a real platform name — it reports "Unknown". Platform
  // must mark that with "·", exactly like an undetected CLI, not silently
  // stay unmarked.
  const unknownPlatformBlock = formatExecutionEnvironmentBlock({
    platformKind: PLATFORM_KINDS.other,
    bubblewrap: {status: BUBBLEWRAP_STATUS.unsupportedPlatform, available: false, version: null, reason: null},
    reviewer: reviewerModeSummary({platformKind: PLATFORM_KINDS.other, bubblewrap: {status: BUBBLEWRAP_STATUS.unsupportedPlatform, available: false}})
  });
  check(
    "unknown-platform block marks Platform with \"·\", not left unmarked",
    unknownPlatformBlock === "\nExecution environment:\n· Platform: Unknown\n· Bubblewrap: unavailable\n✗ Reviewers cannot run: full protection needs WSL2 or Linux with bubblewrap"
  );
}

// ---------------------------------------------------------------------
// Aggregate detector: cannot crash or hang setup
// ---------------------------------------------------------------------

{
  const capabilities = await detectPlatformCapabilities({
    platform: "linux",
    readOsRelease: () => { throw new Error("no osrelease here"); },
    readProcVersion: () => { throw new Error("no /proc/version here"); },
    spawn: () => { throw new Error("bwrap not spawnable"); }
  });
  check("aggregate detector resolves even when every probe fails", typeof capabilities === "object" && capabilities !== null);
  check("aggregate detector still yields a platformKind", Object.values(PLATFORM_KINDS).includes(capabilities.platformKind));
  check("aggregate detector still yields a reviewer summary", capabilities.reviewer?.mode === "unavailable");
  check("aggregate detector never claims wsl2 on unreadable evidence", capabilities.platformKind !== PLATFORM_KINDS.wsl2);
}

// No runtime behavior or configuration is changed: this module only
// exports pure functions plus a bounded child_process probe — no fs
// writes, no config reads/writes.
{
  const moduleExports = await import("./platform-capabilities.mjs");
  check(
    "module surface is detection/formatting only (no config or role-launch exports)",
    !("saveConfig" in moduleExports) && !("selectRuntime" in moduleExports)
  );
}

if (failures > 0) {
  console.error(`\n${failures} platform-capabilities check(s) failed.`);
  process.exit(1);
}
console.log("\nAll platform-capabilities checks passed.");
