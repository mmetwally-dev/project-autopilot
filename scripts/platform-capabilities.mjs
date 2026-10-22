// Read-only platform + reviewer-containment capability detection.
//
// Scope: informational only. Nothing here selects a runtime, writes config,
// or changes role-launch behavior — it exists so `ap setup` can truthfully
// report what platform Autopilot is running on and whether read-only
// reviewer filesystem containment (bubblewrap) is currently usable.
//
// Deliberately separate from:
//  - execution-envelope.mjs's executionPlaneName(), which classifies the
//    *repository path* (e.g. a Windows process pointed at a WSL UNC path)
//    for envelope-building purposes, not "which OS is this process on".
//    Not reused/imported here — it is out of scope for this module and
//    must not be modified.
//  - gates.network_isolation / detectNetworkNamespace(), which is about
//    network containment, not filesystem containment.
import fs from "node:fs";
import {spawn as nodeSpawn} from "node:child_process";

export const PLATFORM_KINDS = Object.freeze({
  nativeWindows: "native-windows",
  wsl2: "wsl2",
  wsl1: "wsl1",
  nativeLinux: "native-linux",
  other: "other"
});

export const BUBBLEWRAP_STATUS = Object.freeze({
  notApplicable: "not-applicable",
  unsupportedPlatform: "unsupported-platform",
  available: "available",
  missing: "missing",
  broken: "broken",
  timeout: "timeout",
  error: "error"
});

const DEFAULT_PROBE_TIMEOUT_MS = 2000;
const DEFAULT_KILL_GRACE_MS = 300;
const MAX_DIAGNOSTIC_BYTES = 4096;

// Classifies raw kernel-release evidence (either the bare contents of
// /proc/sys/kernel/osrelease, e.g. "5.15.90.1-microsoft-standard-WSL2", or
// the longer "Linux version ..." line from /proc/version, which embeds the
// same substring). Older WSL2 kernels (pre ~2021) shipped as plain
// "*-microsoft-standard" with no literal "WSL2" suffix, e.g.
// "4.19.84-microsoft-standard" — those are genuine WSL2, not WSL1, so
// "microsoft-standard" alone is treated as sufficient WSL2 evidence. A
// bare "Microsoft" or "wsl" marker *without* "microsoft-standard" (the
// real WSL1 kernel release shape, e.g. "4.4.0-19041-Microsoft") is WSL1
// evidence, not WSL2.
function classifyKernelEvidence(text) {
  if (/microsoft-standard|wsl2/i.test(text)) return PLATFORM_KINDS.wsl2;
  if (/microsoft|\bwsl\b/i.test(text)) return PLATFORM_KINDS.wsl1;
  return PLATFORM_KINDS.nativeLinux;
}

/**
 * Classify the current process's platform. Accepts injectable `platform`,
 * `readOsRelease`, and `readProcVersion` for testing without depending on
 * the host machine or mutating `process.platform`.
 *
 * `/proc/sys/kernel/osrelease` (just the bare kernel release string) is
 * preferred; `/proc/version` (the longer "Linux version ..." line, which
 * embeds the same release string) is used as a fallback if osrelease can't
 * be read. If neither can be read, this fails conservatively to
 * native-linux rather than ever claiming WSL2.
 */
export function detectPlatformKind({
  platform = process.platform,
  readOsRelease = () => fs.readFileSync("/proc/sys/kernel/osrelease", "utf8"),
  readProcVersion = () => fs.readFileSync("/proc/version", "utf8")
} = {}) {
  if (platform === "win32") return PLATFORM_KINDS.nativeWindows;
  if (platform !== "linux") return PLATFORM_KINDS.other;

  let evidence = null;
  try {
    evidence = readOsRelease();
  } catch {
    try {
      evidence = readProcVersion();
    } catch {
      return PLATFORM_KINDS.nativeLinux;
    }
  }
  return classifyKernelEvidence(evidence);
}

function minimalSandboxProbeArgs() {
  const mounts = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"].filter(candidate => fs.existsSync(candidate));
  const args = ["--die-with-parent", "--new-session", "--unshare-all"];
  for (const mount of mounts) args.push("--ro-bind", mount, mount);
  args.push("--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--", "true");
  return args;
}

function appendBounded(buffer, chunk) {
  if (buffer.length >= MAX_DIAGNOSTIC_BYTES) return buffer;
  const combined = buffer + chunk.toString("utf8");
  return combined.length > MAX_DIAGNOSTIC_BYTES ? combined.slice(0, MAX_DIAGNOSTIC_BYTES) : combined;
}

/**
 * Runs one bounded, asynchronous probe against a shared absolute
 * `deadline` (an epoch-ms value from `now`). Uses `child_process.spawn`
 * (never `spawnSync`) so a child that ignores SIGTERM cannot block the
 * caller forever: on deadline this sends SIGTERM, escalates to SIGKILL
 * after `killGraceMs` if the child is still alive, and resolves
 * deterministically instead of waiting indefinitely for `close`.
 *
 * Resolves exactly once — a `settled` guard makes error/exit/close/timeout
 * races idempotent, so whichever event lands first wins and every
 * subsequent event/timer is a no-op.
 */
function runBoundedProbe(spawnFn, binary, args, {deadline, now, killGraceMs}) {
  return new Promise(resolve => {
    let settled = false;
    let deadlineTimer = null;
    let killTimer = null;
    let backstopTimer = null;

    const clearTimers = () => {
      clearTimeout(deadlineTimer);
      clearTimeout(killTimer);
      clearTimeout(backstopTimer);
    };
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(result);
    };

    const remaining = deadline - now();
    if (remaining <= 0) {
      finish({kind: "timeout"});
      return;
    }

    let child;
    try {
      child = spawnFn(binary, args, {stdio: ["ignore", "pipe", "pipe"], shell: false});
    } catch (error) {
      // A synchronous throw from the spawn call itself (as opposed to an
      // async "error" event) is a distinct, unexpected failure mode —
      // never conflate it with "binary not installed".
      finish({kind: "error", detail: error?.message || String(error)});
      return;
    }
    if (!child || typeof child.on !== "function") {
      finish({kind: "error", detail: "spawn returned no child handle"});
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // Attach every handler before the deadline timer starts, so nothing
    // that happens to the child between spawn and the timer firing is
    // ever missed.
    child.stdout?.on("data", chunk => { stdout = appendBounded(stdout, chunk); });
    child.stderr?.on("data", chunk => { stderr = appendBounded(stderr, chunk); });

    child.on("error", error => {
      if (error?.code === "ENOENT") { finish({kind: "missing"}); return; }
      finish({kind: "error", detail: error?.message || String(error)});
    });

    const settleFromTermination = (code, signal) => {
      if (timedOut) { finish({kind: "timeout"}); return; }
      if (signal) { finish({kind: "broken", detail: `terminated by signal ${signal}`}); return; }
      if (code !== 0) { finish({kind: "broken", detail: `exited with status ${code}`}); return; }
      finish({kind: "ok", text: (stdout || stderr).trim() || null});
    };
    child.on("exit", settleFromTermination);
    child.on("close", settleFromTermination);

    deadlineTimer = setTimeout(() => {
      timedOut = true;
      try { child.stdout?.destroy(); } catch { /* already closed */ }
      try { child.stderr?.destroy(); } catch { /* already closed */ }
      try { child.kill("SIGTERM"); } catch { /* already dead */ }
      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
        // Backstop: SIGKILL cannot be caught, so `exit`/`close` should
        // follow almost immediately — but resolve deterministically even
        // in a pathological case where they never arrive, so setup can
        // never hang because of this probe.
        backstopTimer = setTimeout(() => finish({kind: "timeout"}), Math.max(killGraceMs, 200));
      }, killGraceMs);
    }, remaining);
  });
}

/**
 * Probe real bubblewrap usability for the given `platformKind`:
 *  - Native Windows / unknown platforms: bubblewrap is not applicable.
 *  - WSL1: reviewer containment is unsupported outright; no probe is run.
 *  - WSL2 / Native Linux: run a bounded `bwrap --version` probe, and only
 *    if that succeeds, a bounded minimal non-mutating bubblewrap sandbox
 *    probe (namespace unshare + read-only system binds + `true`) —
 *    proving the sandbox can actually be created, not just that the
 *    binary exists. Both probes share one absolute deadline.
 *
 * Async (uses `child_process.spawn` internally, never `spawnSync`) so a
 * hard deadline is enforceable even against a child that ignores SIGTERM.
 * Never throws and never resolves past `timeoutMs` (plus one bounded kill
 * grace period): a missing binary, a nonzero exit, a signal, or a
 * deadline overrun are all reported as a definite, non-crashing result.
 */
export async function detectBubblewrapCapability({platformKind, spawn = nodeSpawn, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, killGraceMs = DEFAULT_KILL_GRACE_MS, now = () => Date.now()} = {}) {
  if (platformKind === PLATFORM_KINDS.wsl1) {
    return {status: BUBBLEWRAP_STATUS.unsupportedPlatform, available: false, version: null, reason: "wsl1_reviewer_containment_unsupported"};
  }
  if (platformKind !== PLATFORM_KINDS.wsl2 && platformKind !== PLATFORM_KINDS.nativeLinux) {
    return {status: BUBBLEWRAP_STATUS.notApplicable, available: false, version: null, reason: "bubblewrap_not_applicable_on_this_platform"};
  }

  const deadline = now() + timeoutMs;
  const probeOpts = {deadline, now, killGraceMs};

  const versionProbe = await runBoundedProbe(spawn, "bwrap", ["--version"], probeOpts);
  if (versionProbe.kind === "missing") return {status: BUBBLEWRAP_STATUS.missing, available: false, version: null, reason: "bubblewrap_not_installed"};
  if (versionProbe.kind === "timeout") return {status: BUBBLEWRAP_STATUS.timeout, available: false, version: null, reason: "bubblewrap_version_probe_timed_out"};
  if (versionProbe.kind === "error") return {status: BUBBLEWRAP_STATUS.error, available: false, version: null, reason: `bubblewrap_version_probe_failed: ${versionProbe.detail}`};
  if (versionProbe.kind === "broken") return {status: BUBBLEWRAP_STATUS.broken, available: false, version: null, reason: `bubblewrap_version_probe_unusable: ${versionProbe.detail}`};

  const version = versionProbe.text;
  const sandboxProbe = await runBoundedProbe(spawn, "bwrap", minimalSandboxProbeArgs(), probeOpts);
  if (sandboxProbe.kind === "missing") return {status: BUBBLEWRAP_STATUS.missing, available: false, version, reason: "bubblewrap_not_installed"};
  if (sandboxProbe.kind === "timeout") return {status: BUBBLEWRAP_STATUS.timeout, available: false, version, reason: "bubblewrap_sandbox_probe_timed_out"};
  if (sandboxProbe.kind === "error") return {status: BUBBLEWRAP_STATUS.error, available: false, version, reason: `bubblewrap_sandbox_probe_failed: ${sandboxProbe.detail}`};
  if (sandboxProbe.kind === "broken") return {status: BUBBLEWRAP_STATUS.broken, available: false, version, reason: `bubblewrap_sandbox_probe_unusable: ${sandboxProbe.detail}`};

  return {status: BUBBLEWRAP_STATUS.available, available: true, version, reason: null};
}

/**
 * Truthful, current-state-only summary of reviewer filesystem containment.
 * Never implies WSL1 containment works, never implies a mode was selected
 * or persisted, and never implies Native Windows is fully supported — task
 * 15.3 gave SpecKit's Plan Reviewer role a disposable-copy compatibility
 * path (scripts/autopilot.mjs's runRelay(),
 * scripts/reviewer-workspace.mjs), task 15.4A extended that same path to
 * SpecKit's Code Reviewer role, and task 15.4B1 extended it to SpecKit's
 * Verifier role. That path is explicitly NOT OS-enforced containment (see
 * its own result.executionPlaneSafety.strength === "compatibility"
 * metadata) — it is a throwaway repository copy that protects against
 * accidental/relative-path writes, not a sandbox.
 *
 * The Native Windows mode stays "partial", never "available": only SpecKit
 * and standalone have this compatibility path. GSD still fails closed
 * with READ_ONLY_CONTAINMENT_UNAVAILABLE on Native
 * Windows. This summary makes no claim at all about browser/Playwright
 * readiness — that is a separate concern and is not provisioned by this
 * path.
 */
export function reviewerModeSummary({platformKind, bubblewrap}) {
  if (platformKind === PLATFORM_KINDS.nativeWindows) {
    return {
      mode: "partial",
      detail: "SpecKit and standalone Plan Reviewer, Code Reviewer, and Verifier: available via disposable-copy compatibility isolation (not OS-enforced containment). GSD workflows: unavailable — WSL/Linux bubblewrap is required for their read-only roles."
    };
  }
  if (platformKind === PLATFORM_KINDS.wsl1) {
    return {mode: "unavailable", detail: "WSL1 reviewer containment is unsupported"};
  }
  if (bubblewrap?.available) {
    return {mode: "available", detail: "filesystem containment available"};
  }
  return {mode: "unavailable", detail: "bubblewrap is required"};
}

export async function detectPlatformCapabilities(overrides = {}) {
  const platformKind = detectPlatformKind(overrides);
  const bubblewrap = await detectBubblewrapCapability({platformKind, ...overrides});
  const reviewer = reviewerModeSummary({platformKind, bubblewrap});
  return {platformKind, bubblewrap, reviewer};
}

export function platformKindLabel(platformKind) {
  switch (platformKind) {
    case PLATFORM_KINDS.nativeWindows: return "Native Windows";
    case PLATFORM_KINDS.wsl2: return "WSL2";
    case PLATFORM_KINDS.wsl1: return "WSL1";
    case PLATFORM_KINDS.nativeLinux: return "Native Linux";
    default: return "Unknown";
  }
}

export function bubblewrapLabel(bubblewrap) {
  switch (bubblewrap?.status) {
    case BUBBLEWRAP_STATUS.notApplicable: return "not applicable";
    case BUBBLEWRAP_STATUS.unsupportedPlatform: return "unavailable";
    case BUBBLEWRAP_STATUS.available: return bubblewrap.version ? `available (${bubblewrap.version})` : "available";
    case BUBBLEWRAP_STATUS.missing: return "not detected";
    case BUBBLEWRAP_STATUS.broken: return "detected but not usable";
    case BUBBLEWRAP_STATUS.timeout: return "detected but did not respond (probe timed out)";
    case BUBBLEWRAP_STATUS.error: return "probe failed unexpectedly";
    default: return "unknown";
  }
}

/**
 * Render the "Execution environment:" block for `ap setup`. Pure formatting
 * (synchronous, no probing) — callers own the actual console.log call and
 * must resolve `capabilities` via `detectPlatformCapabilities()` first.
 *
 * All three lines get the same ✓/· presence marker used by the "CLI
 * availability:" list. Platform is genuinely detectable-or-not too: on any
 * host that is neither Windows nor Linux (PLATFORM_KINDS.other, e.g. macOS),
 * platformKindLabel() reports "Unknown" — so it gets "·" exactly like an
 * undetected CLI, and "✓" once a real platform kind was determined.
 */
export function formatExecutionEnvironmentBlock(capabilities) {
  const platformKnown = capabilities.platformKind !== PLATFORM_KINDS.other;
  const bubblewrapAvailable = capabilities.bubblewrap?.status === BUBBLEWRAP_STATUS.available;
  // "available" and "partial" details are already self-describing (partial
  // spells out exactly which role(s) work and which don't); only the
  // "unavailable" case needs the generic prefix.
  const reviewerAvailable = capabilities.reviewer.mode === "available" || capabilities.reviewer.mode === "partial";
  const reviewerLine = reviewerAvailable
    ? capabilities.reviewer.detail
    : `unavailable — ${capabilities.reviewer.detail}`;
  const lines = [
    "\nExecution environment:",
    `${platformKnown ? "✓" : "·"} Platform: ${platformKindLabel(capabilities.platformKind)}`,
    `${bubblewrapAvailable ? "✓" : "·"} Bubblewrap: ${bubblewrapLabel(capabilities.bubblewrap)}`,
    `${reviewerAvailable ? "✓" : "·"} Current reviewer mode: ${reviewerLine}`
  ];
  return lines.join("\n");
}
