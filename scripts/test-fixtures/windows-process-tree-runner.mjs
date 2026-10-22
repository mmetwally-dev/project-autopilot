// TEST-ONLY shared helper: bounded, asynchronous Windows process-tree spawn.
//
// Used exclusively by the Windows-only Autopilot behavioral test files
// (test-windows-disposable-plan-reviewer.mjs, test-windows-disposable-
// code-reviewer.mjs) to drive the real `node scripts/autopilot.mjs run`
// subprocess. Never imported by production code — this lives under
// test-fixtures/ specifically because it is test infrastructure, not a
// reviewer-workspace.mjs/execution-envelope.mjs primitive.
//
// Task 15.4A correction: the two Windows test files previously each carried
// their own copy of a "bounded" runner that called `taskkill` on deadline
// but never actually bounded the wait for that termination to take effect —
// if `taskkill` failed, or the child's "close" event never arrived (a real
// possibility for a wedged Windows process tree), the returned Promise could
// stay pending forever.
//
// Task 15.4A final correction closes four remaining holes in that fix:
//   1. `taskkill` itself was unbounded. It runs through `spawnSync`, so a
//      hung `taskkill.exe` blocked the event loop and the backstop timer was
//      never even scheduled. It now has a strict short timeout, AND the
//      backstop timer is armed BEFORE the terminator is invoked, so no
//      synchronous terminator can prevent settlement.
//   2. A backstop that fired without ever seeing "close" reported
//      terminationFailed=false whenever taskkill claimed success. That is a
//      false clean bill of health: without "close" the child was never
//      observed to die. Termination is now only ever reported as successful
//      when "close" actually arrived.
//   3. A nonzero `taskkill` exit was silently ignored. It is now recorded in
//      `killDiagnostics` and, absent a confirming "close", is a termination
//      failure. ("Process not found" is benign only when the child has
//      already closed — which is exactly the close-confirmed case.)
//   4. `maxOutputBytes` was enforced with JavaScript string `.length`, i.e.
//      UTF-16 code units, so multibyte UTF-8 output could exceed the byte
//      cap by up to 3x. Output is now accumulated as Buffers and capped by
//      real byte length, decoded only once at settle time.
//
// Contract:
//  - Always `child_process.spawn` (never `spawnSync`), always `shell:false`.
//  - Exactly one absolute hard deadline (`timeoutMs`, measured from the
//    call).
//  - On deadline: `taskkill /PID <pid> /T /F` is issued to terminate the
//    WHOLE process tree rooted at the child's PID — necessary because a
//    Windows .cmd trampoline can have live cmd.exe/node.exe grandchildren
//    that a plain `child.kill()` never reaches. That call is itself bounded
//    by `taskkillTimeoutMs`.
//  - A short, deterministic backstop timer (`killGraceMs`) is armed BEFORE
//    the termination attempt and force-settles the Promise if "close" still
//    hasn't arrived by the time it fires.
//  - stdout/stderr are each independently bounded at `maxOutputBytes` REAL
//    BYTES; once either stream exceeds that bound, accumulation stops
//    immediately (the retained buffer is never larger than the bound) and
//    `outputLimitExceeded` is set — this ALSO triggers the same termination
//    + backstop path as a deadline, since a runaway/broken child has nothing
//    further useful to report.
//  - Settlement is single and deterministic: whichever of
//    error/close/timeout/output-limit resolves first wins; a `settled`
//    guard makes every later event a no-op, and `terminate()` itself is
//    idempotent (a second trigger — e.g. the deadline firing shortly after
//    an output-limit-triggered termination already started — never issues
//    a second `taskkill` call or a second backstop timer).
//  - Normal completion always settles from the "close" event (fired only
//    after every stdio stream has itself finished draining), never "exit"
//    alone — "exit" is recorded only as a code/signal fallback.
//  - `terminationFailed` is TRUE whenever termination was requested but the
//    child never emitted "close". It is false only when no termination was
//    needed, or when "close" independently confirmed the child died.
//    `killDiagnostics` separately preserves what the terminator itself
//    reported (status / timeout / thrown error) — no termination error is
//    ever swallowed.
//  - Never rejects: a spawn failure (e.g. ENOENT) is reported via the
//    resolved value's `error` field, so callers never need try/catch around
//    a call to this function.
import {spawn as nodeSpawn, spawnSync} from "node:child_process";

export const DEFAULT_KILL_GRACE_MS = 3000;
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
// Deliberately short. `taskkill /F` either works essentially immediately or
// is stuck on something we cannot wait out; the whole point of the backstop
// is that we do not need it to succeed in order to settle.
export const DEFAULT_TASKKILL_TIMEOUT_MS = 2000;

// Byte-accurate bounded capture. Chunks arrive as Buffers (the default when
// no stream encoding is set); anything else is coerced. Nothing larger than
// `maxBytes` is ever retained — an over-long chunk is sliced BEFORE being
// stored, so there is no transient unbounded accumulation.
function createBoundedSink(maxBytes) {
  const chunks = [];
  let bytes = 0;
  let overflowed = false;
  return {
    push(chunk) {
      if (overflowed) return true;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      const remaining = maxBytes - bytes;
      if (buf.length <= remaining) {
        chunks.push(buf);
        bytes += buf.length;
        return false;
      }
      if (remaining > 0) {
        chunks.push(buf.subarray(0, remaining));
        bytes += remaining;
      }
      overflowed = true;
      return true;
    },
    get bytes() { return bytes; },
    get overflowed() { return overflowed; },
    text() { return Buffer.concat(chunks, bytes).toString("utf8"); }
  };
}

// Default `killFn`: synchronous (the termination path is not a hot path, and
// synchronicity keeps injection for tests trivial) but strictly time-bounded
// so it cannot wedge the event loop. Returns a spawnSync-shaped result;
// `error` is set both when spawning `taskkill.exe` fails (e.g. ENOENT) and
// when the timeout fires (ETIMEDOUT).
function defaultKillProcessTree(pid, {timeoutMs = DEFAULT_TASKKILL_TIMEOUT_MS} = {}) {
  return spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    timeout: timeoutMs,
    killSignal: "SIGKILL"
  });
}

// Turns whatever the terminator reported into stable diagnostics. Nothing is
// discarded: a nonzero status, a timeout, and a thrown error are all
// distinguishable afterwards.
function normalizeKillResult(raw) {
  const errorCode = raw?.error?.code || raw?.error?.errno || null;
  const timedOut = errorCode === "ETIMEDOUT";
  const status = typeof raw?.status === "number" ? raw.status : null;
  const error = raw?.error ? String(raw.error.message || raw.error) : null;
  return {
    requested: true,
    invoked: true,
    status,
    signal: raw?.signal ?? null,
    timedOut,
    error,
    // "Reported success" means the terminator itself is not complaining. It
    // is NOT a claim that the process tree is gone — only "close" proves that.
    reportedSuccess: !error && status === 0
  };
}

/**
 * Resolves (never rejects) to:
 *   {status, signal, stdout, stderr, timedOut, outputLimitExceeded,
 *    terminationFailed, killDiagnostics, pid, error}
 *
 * `status`/`signal` are the child's own exit code/signal (both `null` if
 * the process never reached a natural exit — e.g. it was force-terminated
 * and never closed). `error` is set only for a genuine spawn failure.
 * `killDiagnostics` is null when no termination was ever requested.
 */
export function runWindowsProcessTreeBounded(command, args, {
  cwd,
  env,
  timeoutMs,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  taskkillTimeoutMs = DEFAULT_TASKKILL_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  spawnFn = nodeSpawn,
  killFn = defaultKillProcessTree,
  stdin = "ignore",
  onOutput = null,
  maxAnswers = 1000
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("windows-process-tree-runner: timeoutMs must be a positive number");
  }
  return new Promise(resolve => {
    let settled = false;
    let terminationRequested = false;
    let deadlineTimer = null;
    let backstopTimer = null;
    let timedOut = false;
    let outputLimitExceeded = false;
    let killDiagnostics = null;
    const outSink = createBoundedSink(maxOutputBytes);
    const errSink = createBoundedSink(maxOutputBytes);
    let exitInfo = null;
    let answersSent = 0;

    const clearTimers = () => {
      clearTimeout(deadlineTimer);
      clearTimeout(backstopTimer);
    };
    const endStdin = () => {
      try { child?.stdin?.end(); } catch { /* already closed */ }
    };
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimers();
      endStdin();
      resolve({...result, answersSent});
    };
    const writeLine = line => {
      if (answersSent >= maxAnswers) return false;
      try {
        child?.stdin?.write(`${line}\n`);
        answersSent += 1;
        return true;
      } catch {
        return false;
      }
    };
    const maybeInteract = () => {
      if (typeof onOutput !== "function") return;
      try {
        onOutput({stdout: outSink.text(), stderr: errSink.text(), writeLine, answersSent});
      } catch { /* interactive callback must never break the runner */ }
    };
    // Fail-closed tree accounting: once a termination has been requested, a
    // leader `close` alone never clears terminationFailed — the complete
    // tree was addressed only through `taskkill /PID <pid> /T /F`, so a
    // failed taskkill (nonzero exit, throw, timeout, malformed result, or
    // never successfully run) leaves descendants possibly alive even when
    // the direct child later emits `close`. terminationFailed clears only
    // when BOTH hold: `close` was observed AND the terminator reported
    // success. A terminator that merely ran proves nothing either way.
    const terminationConfirmed = closeConfirmed =>
      Boolean(closeConfirmed && killDiagnostics?.reportedSuccess === true);
    const currentResult = ({closeConfirmed = false, ...extra} = {}) => ({
      status: null,
      signal: null,
      stdout: outSink.text(),
      stderr: errSink.text(),
      timedOut,
      outputLimitExceeded,
      terminationFailed: terminationRequested && !terminationConfirmed(closeConfirmed),
      killDiagnostics,
      pid: child?.pid ?? null,
      error: null,
      ...extra
    });
    const spawnFailure = error => ({
      status: null, signal: null, stdout: "", stderr: "", timedOut: false,
      outputLimitExceeded: false, terminationFailed: false, killDiagnostics: null,
      pid: null, error
    });

    let child;
    const wantStdinPipe = stdin === "pipe" || typeof onOutput === "function";
    try {
      child = spawnFn(command, args, {cwd, env, stdio: [wantStdinPipe ? "pipe" : "ignore", "pipe", "pipe"], shell: false});
      try { child?.stdin?.on("error", () => {}); } catch { /* no stdin */ }
    } catch (error) {
      finish(spawnFailure(error));
      return;
    }
    if (!child || typeof child.on !== "function") {
      finish(spawnFailure(new Error("windows-process-tree-runner: spawn returned no child handle")));
      return;
    }

    // Idempotent: a second call (e.g. the deadline firing shortly after an
    // output-limit-triggered termination already began) is a no-op — never
    // a second `taskkill` invocation, never a second backstop timer.
    function terminate() {
      if (terminationRequested) return;
      terminationRequested = true;
      clearTimeout(deadlineTimer);
      // Armed FIRST, deliberately. `killFn` is synchronous by contract; if it
      // blocks (a wedged taskkill.exe, a hostile injected stub) the timer is
      // already registered and fires as soon as the loop is free, so no
      // terminator can leave this Promise pending.
      backstopTimer = setTimeout(() => finish(currentResult()), Math.max(killGraceMs, 200));
      if (!child.pid) {
        killDiagnostics = {
          requested: true, invoked: false, status: null, signal: null,
          timedOut: false, error: "no child pid available to terminate",
          reportedSuccess: false
        };
        return;
      }
      try {
        killDiagnostics = normalizeKillResult(killFn(child.pid, {timeoutMs: taskkillTimeoutMs}));
      } catch (error) {
        killDiagnostics = {
          requested: true, invoked: true, status: null, signal: null,
          timedOut: false, error: String(error?.message || error),
          reportedSuccess: false
        };
      }
    }

    function handleOverflow() {
      if (outputLimitExceeded) return;
      outputLimitExceeded = true;
      try { child.stdout?.destroy(); } catch { /* already closed */ }
      try { child.stderr?.destroy(); } catch { /* already closed */ }
      terminate();
    }

    // Attach every handler before the deadline timer starts, so nothing
    // that happens to the child between spawn and the timer firing is ever
    // missed.
    child.stdout?.on("data", chunk => {
      if (outSink.push(chunk)) handleOverflow();
      maybeInteract();
    });
    child.stderr?.on("data", chunk => {
      if (errSink.push(chunk)) handleOverflow();
      maybeInteract();
    });

    child.on("error", error => {
      finish(currentResult({error}));
    });

    // "exit" can fire before stdout/stderr have finished draining through
    // the pipe — resolving on "exit" risks silently returning incomplete
    // output. "close" fires only after every stdio stream has itself
    // emitted its final event. So "exit" only ever records code/signal as a
    // fallback (for an injected fake child whose "close" might not carry
    // them itself); the actual settle-on-normal-completion decision happens
    // exclusively on "close".
    child.on("exit", (code, signal) => { exitInfo = {code, signal}; });

    child.on("close", (code, signal) => {
      finish(currentResult({
        closeConfirmed: true,
        status: code ?? exitInfo?.code ?? null,
        signal: signal ?? exitInfo?.signal ?? null
      }));
    });

    deadlineTimer = setTimeout(() => {
      timedOut = true;
      try { child.stdout?.destroy(); } catch { /* already closed */ }
      try { child.stderr?.destroy(); } catch { /* already closed */ }
      terminate();
    }, timeoutMs);
  });
}

// Pure/injectable internals exposed only so tests can exercise them
// directly and deterministically. Not used by, and not required by, any
// other production or test caller.
export const __testables = Object.freeze({createBoundedSink, normalizeKillResult, defaultKillProcessTree});
