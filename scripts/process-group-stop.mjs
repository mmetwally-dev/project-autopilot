// Shared process-group stop helper for the parallel test runner.
//
// Kept out of the runner on purpose: it is named without the runner's
// discovery prefix, and it never mentions any runner file name, so the
// runner's disk discovery and the package-contract checks are unaffected.
//
// The contract here mirrors bounded-process-tree.mjs: on POSIX the whole
// group is signalled (SIGTERM, short grace, then SIGKILL); on Windows a
// single best-effort taskkill tree-kill is the whole path. Everything is
// best-effort and never throws — callers use this on early-stop and
// leftover-reap paths where a stale pid (ESRCH) is the normal case.
import {spawnSync as nodeSpawnSync} from "node:child_process";
import {
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_TASKKILL_TIMEOUT_MS,
  defaultWindowsKillFn,
  killPosixGroup,
} from "./bounded-process-tree.mjs";

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function toLeaderPid(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return null;
  return numericPid;
}

/**
 * Pure group-kill decision: describe which signal/target stops the process
 * group led by `pid` without sending anything.
 *
 * `killGroupFn` is accepted (and echoed back in the plan) so unit cases can
 * inject a fake and prove the decision itself performs no signalling; it is
 * never invoked here.
 *
 * Returns one of:
 *   {method: "posix-group", target, signal: "SIGTERM", killGroupFn}
 *     `target` is the negated group id for process.kill(-pid, signal);
 *     `killGroupFn` takes the positive leader pid and negates internally.
 *   {method: "windows-taskkill", target, signal: null, killGroupFn: null}
 *   {method: "none", target: null, signal: null, killGroupFn: null}
 */
export function decideGroupKill(pid, {
  isWindows = (process.platform === "win32"),
  killGroupFn = killPosixGroup,
} = {}) {
  const leaderPid = toLeaderPid(pid);
  if (leaderPid === null) {
    return {method: "none", target: null, signal: null, killGroupFn: null};
  }
  if (isWindows) {
    return {method: "windows-taskkill", target: leaderPid, signal: null, killGroupFn: null};
  }
  return {method: "posix-group", target: -leaderPid, signal: "SIGTERM", killGroupFn};
}

/**
 * Synchronous best-effort group signal (for exit-event reap paths where no
 * waiting is possible). Swallows every failure, including ESRCH for an
 * already-exited group leader. Returns true when the signal was accepted.
 */
export function killGroupNow(pid, signal = "SIGTERM", killGroupFn = killPosixGroup) {
  const leaderPid = toLeaderPid(pid);
  if (leaderPid === null) return false;
  try {
    return killGroupFn(leaderPid, signal) === true;
  } catch {
    return false;
  }
}

/**
 * Async stop routine: SIGTERM to the group, wait `graceMs`, then SIGKILL
 * (POSIX); a single best-effort taskkill tree-kill (Windows). Never throws;
 * ESRCH and every other failure are swallowed. Resolves to
 * {method, termOk, killOk}.
 */
export async function stopProcessGroup(pid, {
  isWindows = (process.platform === "win32"),
  graceMs = DEFAULT_KILL_GRACE_MS,
  killGroupFn = killPosixGroup,
  windowsKillFn = null,
  spawnSyncFn = nodeSpawnSync,
  taskkillTimeoutMs = DEFAULT_TASKKILL_TIMEOUT_MS,
  sleepFn = defaultSleep,
} = {}) {
  const decision = decideGroupKill(pid, {isWindows, killGroupFn});
  if (decision.method === "none") {
    return {method: "none", termOk: false, killOk: false};
  }
  if (decision.method === "windows-taskkill") {
    let termOk = false;
    try {
      const raw = windowsKillFn
        ? windowsKillFn(decision.target, {timeoutMs: taskkillTimeoutMs, spawnSyncFn})
        : defaultWindowsKillFn(decision.target, {timeoutMs: taskkillTimeoutMs, spawnSyncFn});
      termOk = raw === 0 || raw?.status === 0 || raw?.reportedSuccess === true;
    } catch {
      termOk = false;
    }
    return {method: "windows-taskkill", termOk, killOk: false};
  }
  let termOk = false;
  let killOk = false;
  try {
    termOk = killGroupFn(decision.target * -1, "SIGTERM") === true;
  } catch {
    termOk = false;
  }
  try {
    await sleepFn(graceMs);
  } catch {
    /* a wedged test sleep must never block the escalation */
  }
  try {
    killOk = killGroupFn(decision.target * -1, "SIGKILL") === true;
  } catch {
    killOk = false;
  }
  return {method: "posix-group", termOk, killOk};
}
