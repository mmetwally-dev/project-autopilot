// TASK 15.5C — shared, production-safe bounded process-tree launcher for a
// real (non-probe) child process whose stdio should pass straight through to
// the parent (e.g. delegating an entire `ap run` invocation into WSL2).
//
// This intentionally does NOT capture stdout/stderr: a delegated mission can
// run for a long time and produce output no one wants buffered in memory —
// the child's stdio is inherited so it streams live to the user's terminal,
// exactly like any other subprocess this CLI already inherits stdio for
// (see bin/ap.cjs's runScript()). What IS shared with the probe-oriented
// runBoundedProbeTree() in runtime-mode-capabilities.mjs is the termination
// lifecycle contract, so this file exists as the one production-safe place
// that contract lives for an inherited-stdio caller:
//   - exactly one absolute deadline (deadlineMs), shared across the whole
//     call; deadlineMs === null means "no bound" — the correct choice for a
//     real mission with no fixed duration, while the SAME termination
//     machinery below stays fully armed for any caller (including tests)
//     that does pass a bound. This is never a weaker/partial timeout: when a
//     bound IS supplied, the complete process tree is terminated and that
//     termination is confirmed before settling, exactly as below.
//   - complete process-tree termination: SIGTERM-then-SIGKILL to the full
//     POSIX process group, or `taskkill /PID <pid> /T /F` on Windows.
//   - termination confirmation (POSIX: poll until the group is actually
//     gone; Windows: only a successful taskkill result counts) before the
//     Promise is allowed to settle as timed-out.
//   - a deterministic backstop timer armed BEFORE the terminator runs, so a
//     wedged/blocking terminator can never leave the caller pending forever.
//   - settle-exactly-once: a `settled` guard makes every later event a
//     no-op once the Promise has resolved.
//   - always `child_process.spawn` (never `spawnSync` for the child being
//     bounded), always `shell:false`. Never falls back to an unsandboxed or
//     unbounded-by-construction invocation.
import {spawn as nodeSpawn, spawnSync as nodeSpawnSync} from "node:child_process";

export const DEFAULT_KILL_GRACE_MS = 500;
export const DEFAULT_TASKKILL_TIMEOUT_MS = 3000;
export const DEFAULT_CONFIRM_POLL_MS = 50;
export const DEFAULT_CONFIRM_ATTEMPTS = 20;
export const DEFAULT_BACKSTOP_SLACK_MS = 1000;

export function posixGroupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error && error.code !== "ESRCH";
  }
}

export function killPosixGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

function normalizeTaskkillResult(raw) {
  if (!raw || typeof raw !== "object") {
    return {requested: true, invoked: true, status: null, signal: null, timedOut: false, error: String(raw ?? "unknown taskkill result"), reportedSuccess: false};
  }
  const err = raw.error;
  const errorCode = err?.code ?? err?.errno ?? raw.code ?? null;
  const msg = err ? String(err.message ?? err) : "";
  const timedOut = errorCode === "ETIMEDOUT" || /ETIMEDOUT|timed out/i.test(msg) || raw.timedOut === true;
  const status = typeof raw.status === "number" ? raw.status : null;
  const signal = raw.signal ?? null;
  const error = err ? String(err.message ?? err) : (typeof raw.error === "string" ? raw.error : null);
  return {requested: true, invoked: true, status, signal, timedOut, error, reportedSuccess: !err && !timedOut && status === 0};
}

export function defaultWindowsKillFn(pid, {timeoutMs, spawnSyncFn}) {
  try {
    return spawnSyncFn("taskkill", ["/PID", String(pid), "/T", "/F"], {stdio: "ignore", timeout: timeoutMs});
  } catch (error) {
    return {error};
  }
}

/**
 * Spawn `binary args` with stdio inherited from the current process (or a
 * caller-supplied stdio spec) and resolve (never reject) once it exits, or
 * once a supplied deadline has been enforced and confirmed.
 *
 * Resolves to:
 *   {status, signal, timedOut, terminationFailed, killDiagnostics, error, pid}
 *
 * `deadlineMs === null` (the default) means no deadline is scheduled at
 * all — the child runs to natural completion. Passing a positive number
 * arms the exact same tree-termination/confirmation/backstop lifecycle
 * documented in runtime-mode-capabilities.mjs's runBoundedProbeTree.
 */
export function runBoundedInheritedProcess(spawnFn, binary, args, {
  cwd,
  env,
  deadlineMs = null,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  taskkillTimeoutMs = DEFAULT_TASKKILL_TIMEOUT_MS,
  isWindows = (process.platform === "win32"),
  spawnSyncFn = nodeSpawnSync,
  killFn = null,
  groupAliveFn = posixGroupAlive,
  killGroupFn = killPosixGroup,
  confirmPollMs = DEFAULT_CONFIRM_POLL_MS,
  confirmAttempts = DEFAULT_CONFIRM_ATTEMPTS,
  backstopSlackMs = DEFAULT_BACKSTOP_SLACK_MS,
  stdio = "inherit"
} = {}) {
  return new Promise(resolve => {
    let settled = false;
    let deadlineTimer = null;
    let killTimer = null;
    let confirmTimer = null;
    let backstopTimer = null;
    let terminationRequested = false;
    let killDiagnostics = null;
    let timedOut = false;
    let exitInfo = null;

    const clearTimers = () => {
      clearTimeout(deadlineTimer);
      clearTimeout(killTimer);
      clearTimeout(confirmTimer);
      clearTimeout(backstopTimer);
    };
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(result);
    };

    let child;
    try {
      child = spawnFn(binary, args, {
        cwd,
        env,
        stdio,
        shell: false,
        windowsHide: false,
        ...(!isWindows ? {detached: true} : {})
      });
    } catch (error) {
      finish({status: null, signal: null, timedOut: false, terminationFailed: false, killDiagnostics: null, error: error?.message || String(error), pid: null});
      return;
    }
    if (!child || typeof child.on !== "function") {
      finish({status: null, signal: null, timedOut: false, terminationFailed: false, killDiagnostics: null, error: "spawn returned no child handle", pid: null});
      return;
    }

    const groupIsAlive = () => {
      const pid = child.pid;
      if (!pid) return false;
      try {
        return groupAliveFn(pid);
      } catch {
        return true;
      }
    };

    const startPosixConfirmation = () => {
      let attemptsLeft = confirmAttempts;
      const poll = () => {
        if (settled) return;
        let alive = false;
        try {
          alive = groupIsAlive();
        } catch {
          alive = true;
        }
        if (!alive) {
          finish({status: null, signal: null, timedOut: true, terminationFailed: false, killDiagnostics, error: null, pid: child.pid ?? null});
          return;
        }
        if (attemptsLeft <= 0) {
          finish({status: null, signal: null, timedOut: true, terminationFailed: true, killDiagnostics, error: null, pid: child.pid ?? null});
          return;
        }
        attemptsLeft -= 1;
        confirmTimer = setTimeout(poll, confirmPollMs);
      };
      poll();
    };

    const terminatePosixTree = () => {
      if (terminationRequested) return;
      terminationRequested = true;
      clearTimeout(deadlineTimer);
      backstopTimer = setTimeout(() => {
        finish({status: null, signal: null, timedOut: true, terminationFailed: true, killDiagnostics, error: null, pid: child.pid ?? null});
      }, killGraceMs + (confirmAttempts * confirmPollMs) + backstopSlackMs);
      try {
        if (child.pid) {
          if (!killGroupFn(child.pid, "SIGTERM")) {
            try { child.kill("SIGTERM"); } catch { /* already dead */ }
          }
        } else {
          try { child.kill("SIGTERM"); } catch { /* already dead */ }
        }
      } catch { /* best-effort */ }
      killTimer = setTimeout(() => {
        if (settled) return;
        try {
          if (child.pid && groupIsAlive()) {
            killGroupFn(child.pid, "SIGKILL");
            try { child.kill("SIGKILL"); } catch { /* already dead */ }
          } else if (!child.pid) {
            try { child.kill("SIGKILL"); } catch { /* already dead */ }
          }
        } catch { /* best-effort */ }
        startPosixConfirmation();
      }, killGraceMs);
    };

    const terminateWindowsTree = () => {
      if (terminationRequested) return;
      terminationRequested = true;
      clearTimeout(deadlineTimer);
      backstopTimer = setTimeout(() => {
        finish({status: null, signal: null, timedOut: true, terminationFailed: true, killDiagnostics, error: null, pid: child.pid ?? null});
      }, killGraceMs + backstopSlackMs);
      let raw;
      if (!child.pid) {
        raw = {error: new Error("no child pid available to terminate")};
      } else if (killFn) {
        try {
          raw = killFn(child.pid, {timeoutMs: taskkillTimeoutMs});
        } catch (error) {
          raw = {error};
        }
      } else {
        raw = defaultWindowsKillFn(child.pid, {timeoutMs: taskkillTimeoutMs, spawnSyncFn});
      }
      killDiagnostics = normalizeTaskkillResult(raw);
      try { child.kill("SIGTERM"); } catch { /* already dead */ }
    };

    const terminateTree = () => {
      if (isWindows) terminateWindowsTree();
      else terminatePosixTree();
    };

    child.on("error", error => {
      if (settled) return;
      if (terminationRequested) return;
      finish({status: null, signal: null, timedOut: false, terminationFailed: false, killDiagnostics: null, error: error?.message || String(error), pid: child.pid ?? null});
    });

    child.on("exit", (code, signal) => {
      exitInfo = {code, signal};
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      if (terminationRequested) {
        if (isWindows) {
          const confirmed = killDiagnostics?.reportedSuccess === true;
          finish({status: null, signal: null, timedOut: true, terminationFailed: !confirmed, killDiagnostics, error: null, pid: child.pid ?? null});
        }
        return; // POSIX: wait for group-death confirmation timers.
      }
      const finalCode = code ?? exitInfo?.code ?? null;
      const finalSignal = signal ?? exitInfo?.signal ?? null;
      if (timedOut) {
        finish({status: null, signal: null, timedOut: true, terminationFailed: false, killDiagnostics: null, error: null, pid: child.pid ?? null});
        return;
      }
      finish({status: finalCode, signal: finalSignal, timedOut: false, terminationFailed: false, killDiagnostics: null, error: null, pid: child.pid ?? null});
    });

    if (deadlineMs != null) {
      deadlineTimer = setTimeout(() => {
        timedOut = true;
        terminateTree();
      }, Math.max(deadlineMs, 0));
    }
  });
}

export const __testables = Object.freeze({normalizeTaskkillResult, defaultWindowsKillFn, posixGroupAlive, killPosixGroup});
