// POSIX-only bounded process-tree runner for tests.
//
// Runs one child with a real wall-clock deadline and deterministic,
// single-settlement lifecycle accounting:
//
//   - asynchronous spawn in its own process group (detached), so the whole
//     tree — including bwrap/Chromium descendants that never call setsid —
//     can be signalled together;
//   - SIGTERM on deadline, SIGKILL escalation after a grace period;
//   - group cleanup on EVERY close (timeout or normal exit): a leader that
//     exits 0 while a background descendant lives on does not settle until
//     the group is terminated (SIGTERM, then SIGKILL) and confirmed dead —
//     the leader's status and timedOut are preserved, terminationFailed is
//     set only when group death cannot be confirmed;
//   - backstop settlement: if `close` is never observed, the call still
//     settles exactly once instead of hanging forever;
//   - stdout/stderr captured up to a byte cap each (outputLimitExceeded is
//     reported, capture is truncated, the child is NOT killed for
//     verbosity alone — the deadline still bounds total time);
//   - terminationFailed is set when the tree cannot be confirmed dead
//     (group kill fails unexpectedly, or the backstop fires with `close`
//     unobserved).
//
// Single settlement is structural: one `settled` flag guards every path
// (error/exit/close/deadline/kill-grace/backstop races), and all timers are
// cleared exactly once on settlement.
//
// `spawnFn` is injectable (defaults to node:child_process.spawn) so the
// backstop/settlement paths are deterministically testable without real
// timing races.
import {spawn as defaultSpawn} from "node:child_process";
import fs from "node:fs";

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return e && e.code !== "ESRCH";
  }
}

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

// Stream capture keeps BOUNDED RAW BYTES per stream and decodes exactly
// once, at settlement. Chunk boundaries are arbitrary OS artifacts: a valid
// UTF-8 sequence split across data events must reassemble from the raw
// bytes, so decoding per-chunk (which corrupts split characters into
// replacement pairs) is never done. All bounding operates on Buffer bytes,
// never on UTF-16 code units.
function makeStreamRecord() {
  return {parts: [], bytes: 0};
}

function appendRawBytes(state, isErr, chunk) {
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const rec = isErr ? state.stderrRec : state.stdoutRec;
  const remaining = state.maxOutputBytes - rec.bytes;
  if (remaining <= 0) {
    state.outputLimitExceeded = true;
    return;
  }
  if (buf.length <= remaining) {
    rec.parts.push(buf);
    rec.bytes += buf.length;
  } else {
    rec.parts.push(buf.subarray(0, remaining));
    rec.bytes += remaining;
    state.outputLimitExceeded = true;
  }
}

// Truncate a decoded string to a UTF-8 byte cap on a character boundary.
// Iterates code points, so the cut never splits a character; deterministic
// for any input.
function truncateStringToByteCap(str, cap) {
  if (Buffer.byteLength(str, "utf8") <= cap) return {str, truncated: false};
  let bytes = 0;
  let end = 0;
  for (const ch of str) {
    const b = Buffer.byteLength(ch, "utf8");
    if (bytes + b > cap) break;
    bytes += b;
    end += ch.length;
  }
  return {str: str.slice(0, end), truncated: true};
}

// Single safe decode of one stream's accumulated raw bytes: valid sequences
// split across chunks reassemble exactly; malformed bytes decode
// deterministically (U+FFFD); and if decoding expands past the cap
// (replacement characters are 3 bytes in UTF-8), the string is truncated
// back within the cap and the overflow is reported honestly.
function decodeStreamRecord(rec, cap) {
  const raw = Buffer.concat(rec.parts, rec.bytes);
  const decoded = raw.toString("utf8");
  const fit = truncateStringToByteCap(decoded, cap);
  return {str: fit.str, truncatedByFit: fit.truncated};
}

export function runPosixBounded(file, args, {
  cwd = undefined,
  env = undefined,
  timeoutMs = 60000,
  killGraceMs = 1000,
  backstopMs = 5000,
  confirmPollMs = 50,
  confirmAttempts = 10,
  maxOutputBytes = 2 * 1024 * 1024,
  spawnFn = defaultSpawn,
  stdin = "ignore",
  onOutput = null,
  maxAnswers = 1000
} = {}) {
  return new Promise((resolve) => {
    const state = newStreamState(maxOutputBytes);
    let settled = false;
    let timedOut = false;
    let terminationFailed = false;
    let status = null;
    let signal = null;
    let spawnError = null;
    let deadlineTimer = null;
    let killTimer = null;
    let backstopTimer = null;
    let cleanupTimer = null;

    let answersSent = 0;
    const clearTimers = () => {
      for (const t of [deadlineTimer, killTimer, backstopTimer, cleanupTimer]) {
        if (t) clearTimeout(t);
      }
      deadlineTimer = killTimer = backstopTimer = cleanupTimer = null;
    };
    const endStdin = () => {
      try { child?.stdin?.end(); } catch { /* already closed */ }
    };
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimers();
      endStdin();
      const streams = finalizeStreams(state);
      resolve({
        status, signal,
        stdout: streams.stdout, stderr: streams.stderr,
        timedOut,
        outputLimitExceeded: streams.overflow,
        terminationFailed, error: spawnError,
        answersSent
      });
    };
    const snapshotText = isErr => {
      try {
        const rec = isErr ? state.stderrRec : state.stdoutRec;
        return Buffer.concat(rec.parts, rec.bytes).toString("utf8");
      } catch {
        return "";
      }
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
        onOutput({stdout: snapshotText(false), stderr: snapshotText(true), writeLine, answersSent});
      } catch { /* interactive callback must never break the runner */ }
    };
    // The runner owns the process group it creates: after the leader closes
    // — on ANY path, timeout or normal exit — confirm the entire group is
    // gone before settling. Lingering descendants are terminated (SIGTERM,
    // then SIGKILL after the grace period) while the leader's original exit
    // status and timedOut value are preserved untouched. If group death
    // cannot be confirmed, terminationFailed is set instead.
    const cleanupGroupThenSettle = (attemptsLeft, phase) => {
      if (settled) return;
      if (!groupAlive(child.pid)) {
        settle();
        return;
      }
      if (phase === "term") {
        killGroup(child.pid, "SIGTERM");
        cleanupTimer = setTimeout(() => cleanupGroupThenSettle(confirmAttempts, "kill"), killGraceMs);
        return;
      }
      if (phase === "kill") {
        killGroup(child.pid, "SIGKILL");
        cleanupTimer = setTimeout(() => cleanupGroupThenSettle(confirmAttempts, "confirm"), confirmPollMs);
        return;
      }
      if (attemptsLeft <= 0) {
        terminationFailed = true;
        settle();
        return;
      }
      cleanupTimer = setTimeout(() => cleanupGroupThenSettle(attemptsLeft - 1, "confirm"), confirmPollMs);
    };

    let child = null;
    const wantStdinPipe = stdin === "pipe" || typeof onOutput === "function";
    try {
      child = spawnFn(file, args, {
        cwd, env, shell: false, detached: true,
        stdio: [wantStdinPipe ? "pipe" : "ignore", "pipe", "pipe"], windowsHide: true
      });
      try { child?.stdin?.on("error", () => {}); } catch { /* no stdin */ }
    } catch (e) {
      spawnError = e;
      terminationFailed = true;
      settle();
      return;
    }
    if (!child || typeof child.pid !== "number") {
      spawnError = new Error("spawn returned no child process");
      terminationFailed = true;
      settle();
      return;
    }

    if (child.stdout && typeof child.stdout.on === "function") {
      child.stdout.on("data", (chunk) => { appendRawBytes(state, false, chunk); maybeInteract(); });
    }
    if (child.stderr && typeof child.stderr.on === "function") {
      child.stderr.on("data", (chunk) => { appendRawBytes(state, true, chunk); maybeInteract(); });
    }
    child.on("error", (e) => {      if (!spawnError) spawnError = e;
      // A spawn failure is terminal for this child; if `close` never
      // follows, the backstop below still settles the call.
      backstopTimer = backstopTimer || setTimeout(() => {
        terminationFailed = true;
        settle();
      }, backstopMs);
    });
    child.on("exit", (code, sig) => {
      if (status === null) {
        status = code;
        signal = sig;
      }
    });
    child.on("close", (code, sig) => {
      if (status === null) {
        status = code;
        signal = sig;
      }
      cleanupGroupThenSettle(confirmAttempts, "term");
    });

    deadlineTimer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => {
        if (groupAlive(child.pid)) killGroup(child.pid, "SIGKILL");
        backstopTimer = setTimeout(() => {
          // `close` was never observed after deadline + escalation:
          // settle rather than hang, marked unconfirmed.
          if (!settled && !groupAlive(child.pid) && status !== null) {
            settle();
            return;
          }
          terminationFailed = true;
          settle();
        }, backstopMs);
      }, killGraceMs);
    }, timeoutMs);
  });
}

// Shared final decode for both runners: single safe decode per stream at
// settlement, with honest overflow when fitting expands past the cap.
function finalizeStreams(state) {
  const out = decodeStreamRecord(state.stdoutRec, state.maxOutputBytes);
  const err = decodeStreamRecord(state.stderrRec, state.maxOutputBytes);
  return {
    stdout: out.str,
    stderr: err.str,
    overflow: state.outputLimitExceeded || out.truncatedByFit || err.truncatedByFit
  };
}

function newStreamState(maxOutputBytes) {
  return {
    maxOutputBytes,
    stdoutRec: makeStreamRecord(),
    stderrRec: makeStreamRecord(),
    outputLimitExceeded: false
  };
}

// Marker-triggered complete tree termination for interruption tests.
//
// Spawns the child (its own process group on POSIX) and polls markerFile:
// the moment the marker exists, the COMPLETE tree is terminated — never
// just the direct child PID, so a sleeping fake-adapter descendant cannot
// survive to write artifacts after the interruption. A hard deadline
// applies when the marker never appears. Either way the tree is confirmed
// dead before settlement, output is byte-bounded, and settlement happens
// exactly once. The leader's observed status/signal are preserved.
//
// Result: {status, signal, stdout, stderr, timedOut, outputLimitExceeded,
// terminationFailed, terminationConfirmed, markerObserved, killed, error}.
// `killed` means this call terminated a confirmed-dead tree (marker or
// deadline trigger); a process that exited on its own reports killed:false.
// On win32 (no process groups) only the direct child is signalled and
// terminationConfirmed reflects the observed close.
export function runTreeUntilMarker(file, args, {
  cwd = undefined,
  env = undefined,
  markerFile,
  pollMs = 50,
  timeoutMs = 30000,
  killGraceMs = 1000,
  backstopMs = 5000,
  confirmPollMs = 50,
  confirmAttempts = 20,
  maxOutputBytes = 2 * 1024 * 1024,
  spawnFn = defaultSpawn,
  existsSyncFn = (p) => fs.existsSync(p)
} = {}) {
  return new Promise((resolve) => {
    const posix = process.platform !== "win32";
    const state = newStreamState(maxOutputBytes);
    let settled = false;
    let terminating = false;
    let terminateReason = null;
    let timedOut = false;
    let terminationFailed = false;
    let terminationConfirmed = false;
    let markerObserved = false;
    let status = null;
    let signal = null;
    let closeObserved = false;
    let spawnError = null;
    let deadlineTimer = null;
    let pollTimer = null;
    let killTimer = null;
    let backstopTimer = null;
    let cleanupTimer = null;

    const clearTimers = () => {
      for (const t of [deadlineTimer, pollTimer, killTimer, backstopTimer, cleanupTimer]) {
        if (t) clearTimeout(t);
      }
      deadlineTimer = pollTimer = killTimer = backstopTimer = cleanupTimer = null;
    };
    const refreshMarkerObserved = () => {
      try {
        if (existsSyncFn(markerFile)) markerObserved = true;
      } catch { /* an unreadable marker path counts as absent */ }
    };
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimers();
      refreshMarkerObserved();
      const streams = finalizeStreams(state);
      resolve({
        status, signal,
        stdout: streams.stdout, stderr: streams.stderr,
        timedOut,
        outputLimitExceeded: streams.overflow,
        terminationFailed, terminationConfirmed, markerObserved,
        killed: terminationConfirmed && (terminateReason === "marker" || terminateReason === "deadline"),
        error: spawnError
      });
    };
    const confirmLoop = (attemptsLeft) => {
      if (settled) return;
      const dead = posix ? !groupAlive(child.pid) : closeObserved;
      if (dead) {
        terminationConfirmed = true;
        settle();
        return;
      }
      if (attemptsLeft <= 0) {
        terminationFailed = true;
        settle();
        return;
      }
      cleanupTimer = setTimeout(() => confirmLoop(attemptsLeft - 1), confirmPollMs);
    };
    const beginTermination = (reason) => {
      if (terminating) return;
      terminating = true;
      if (terminateReason === null) terminateReason = reason;
      if (!posix) {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      } else {
        killGroup(child.pid, "SIGTERM");
      }
      killTimer = setTimeout(() => {
        if (settled) return;
        if (posix && groupAlive(child.pid)) killGroup(child.pid, "SIGKILL");
        confirmLoop(confirmAttempts);
      }, killGraceMs);
    };

    let child = null;
    try {
      child = spawnFn(file, args, {
        cwd, env, shell: false, detached: posix,
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true
      });
    } catch (e) {
      spawnError = e;
      terminationFailed = true;
      settle();
      return;
    }
    if (!child || typeof child.pid !== "number") {
      spawnError = new Error("spawn returned no child process");
      terminationFailed = true;
      settle();
      return;
    }

    if (child.stdout && typeof child.stdout.on === "function") {
      child.stdout.on("data", (chunk) => appendRawBytes(state, false, chunk));
    }
    if (child.stderr && typeof child.stderr.on === "function") {
      child.stderr.on("data", (chunk) => appendRawBytes(state, true, chunk));
    }
    child.on("error", (e) => {
      if (!spawnError) spawnError = e;
      backstopTimer = backstopTimer || setTimeout(() => {
        terminationFailed = true;
        settle();
      }, backstopMs);
    });
    child.on("exit", (code, sig) => {
      if (status === null) {
        status = code;
        signal = sig;
      }
    });
    child.on("close", (code, sig) => {
      if (status === null) {
        status = code;
        signal = sig;
      }
      closeObserved = true;
      beginTermination("exit");
    });

    const pollTick = () => {
      if (settled || terminating) return;
      refreshMarkerObserved();
      if (markerObserved) {
        beginTermination("marker");
        return;
      }
      pollTimer = setTimeout(pollTick, pollMs);
    };
    pollTimer = setTimeout(pollTick, pollMs);

    deadlineTimer = setTimeout(() => {
      timedOut = true;
      beginTermination("deadline");
    }, timeoutMs);

    // Deterministic backstop: absolute ceiling covering deadline + grace +
    // confirmation polling. Settles (marked unconfirmed) rather than ever
    // hanging when neither close nor group death is observable.
    backstopTimer = setTimeout(() => {
      if (settled) return;
      if (!groupAliveSafe() && status !== null) {
        terminationConfirmed = !posix ? closeObserved : true;
        settle();
        return;
      }
      terminationFailed = true;
      settle();
    }, timeoutMs + killGraceMs + backstopMs);

    function groupAliveSafe() {
      if (!posix) return false;
      return groupAlive(child.pid);
    }
  });
}
